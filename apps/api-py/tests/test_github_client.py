"""The App JWT, the installation-token cache, conditional requests, back-off and error mapping, with the HTTP
transport as the only fake. Port of apps/api/tests/unit/github-client.test.ts."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from canvas_api.config import GitHubAppConfig
from canvas_api.github.client import (
    GitHubAccessError,
    GitHubApiError,
    GitHubClient,
    GitHubRateLimitError,
    GitHubUnavailableError,
    PullRequest,
    RepoRef,
)

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
CONFIG = GitHubAppConfig("12345", PRIVATE_KEY, "https://github.test")
START_MS = int(datetime(2026, 10, 24, 12, 0, 0, tzinfo=UTC).timestamp() * 1000)
REPO = RepoRef("o", "r")


def utc_ms(*args: int) -> int:
    return int(datetime(*args, tzinfo=UTC).timestamp() * 1000)


@dataclass
class Call:
    url: str
    method: str
    headers: dict[str, str]
    body: Any


Responder = Callable[[Call, int], httpx.Response | Exception]


def respond(status: int, body: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


@dataclass
class Clock:
    now: int


@dataclass
class Harness:
    client: GitHubClient
    calls: list[Call] = field(default_factory=list)
    clock: Clock = field(default_factory=lambda: Clock(START_MS))


def harness(responder: Responder, start_ms: int = START_MS) -> Harness:
    calls: list[Call] = []
    clock = Clock(start_ms)

    def handler(request: httpx.Request) -> httpx.Response:
        call = Call(
            str(request.url),
            request.method,
            {k.lower(): v for k, v in request.headers.items()},
            json.loads(request.content) if request.content else None,
        )
        calls.append(call)
        result = responder(call, len(calls))
        if isinstance(result, Exception):
            raise result
        return result

    return Harness(GitHubClient(CONFIG, httpx.MockTransport(handler), lambda: clock.now), calls, clock)


def b64url_decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def verifies(jwt: str, public_key: rsa.RSAPublicKey) -> bool:
    header, payload, signature = jwt.split(".")
    try:
        public_key.verify(b64url_decode(signature), f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        return False
    return True


def decode(jwt: str) -> tuple[dict[str, Any], dict[str, Any]]:
    header, payload, _ = jwt.split(".")
    return json.loads(b64url_decode(header)), json.loads(b64url_decode(payload))


# --- appJwt -------------------------------------------------------------------------------------------


def test_app_jwt_is_an_rs256_jwt_signed_with_the_app_key_issuer_is_the_app_id() -> None:
    jwt = harness(lambda c, n: respond(200, {})).client.app_jwt()
    header, payload = decode(jwt)
    assert header == {"alg": "RS256", "typ": "JWT"}
    assert payload["iss"] == "12345"
    assert verifies(jwt, PRIVATE_KEY.public_key())


def test_app_jwt_backdates_iat_for_clock_skew_and_expires_within_githubs_ten_minute_limit() -> None:
    h = harness(lambda c, n: respond(200, {}))
    _, payload = decode(h.client.app_jwt())
    now_seconds = h.clock.now // 1000
    assert payload["iat"] < now_seconds
    assert now_seconds - payload["iat"] <= 60
    assert payload["exp"] > now_seconds
    # GitHub measures the ten minutes from the moment it receives the token.
    assert payload["exp"] - now_seconds <= 10 * 60
    assert payload["exp"] - payload["iat"] <= 10 * 60


def test_app_jwt_is_signed_fresh_from_the_clock_each_time_and_a_token_from_another_key_does_not_verify() -> None:
    h = harness(lambda c, n: respond(200, {}))
    first = h.client.app_jwt()
    h.clock.now += 5000
    assert h.client.app_jwt() != first
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert verifies(first, other.public_key()) is False


def test_sends_the_app_jwt_not_an_installation_token_to_app_installations() -> None:
    installation = {
        "id": 1,
        "account": {"login": "acme"},
        "repository_selection": "selected",
        "permissions": {"contents": "write"},
    }
    h = harness(lambda c, n: respond(200, [installation]))
    assert h.client.list_installations() == [
        {"id": 1, "account": "acme", "repositorySelection": "selected", "permissions": {"contents": "write"}}
    ]
    import re

    assert re.fullmatch(r"Bearer [\w-]+\.[\w-]+\.[\w-]+", h.calls[0].headers["authorization"])
    assert h.calls[0].url == "https://github.test/app/installations?per_page=100"
    assert h.calls[0].headers["x-github-api-version"] == "2022-11-28"


# --- installationToken --------------------------------------------------------------------------------


def token_responder(counter: dict[str, int] | None = None) -> Responder:
    counter = counter if counter is not None else {"n": 0}

    def responder(call: Call, n: int) -> httpx.Response:
        if call.url.endswith("/access_tokens"):
            counter["n"] += 1
            return respond(201, {"token": f"ghs_token{counter['n']}", "expires_at": "2026-10-24T13:00:00.000Z"})
        return respond(200, {})

    return responder


def test_asks_for_the_narrowed_repositories_and_permissions_and_sends_nothing_extra_when_unnarrowed() -> None:
    h = harness(token_responder())
    h.client.installation_token(9, [42], {"contents": "write", "metadata": "read"})
    h.client.installation_token(9)
    assert h.calls[0].url == "https://github.test/app/installations/9/access_tokens"
    assert h.calls[0].method == "POST"
    assert h.calls[0].body == {"repository_ids": [42], "permissions": {"contents": "write", "metadata": "read"}}
    assert h.calls[1].body == {}


def test_reuses_a_cached_token_until_five_minutes_before_it_expires_then_fetches_a_new_one() -> None:
    counter = {"n": 0}
    h = harness(token_responder(counter))
    first = h.client.installation_token(9, [42])
    h.clock.now += 30 * 60_000  # 12:30, token valid to 13:00
    assert h.client.installation_token(9, [42]) == first
    assert counter["n"] == 1
    h.clock.now = utc_ms(2026, 10, 24, 12, 54, 59)
    assert h.client.installation_token(9, [42]) == first
    h.clock.now = utc_ms(2026, 10, 24, 12, 55, 1)
    assert h.client.installation_token(9, [42]) != first
    assert counter["n"] == 2
    assert len([c for c in h.calls if c.url.endswith("/access_tokens")]) == 2


def test_caches_per_installation_repositories_and_permissions() -> None:
    """A narrowed token is never reused for a broader ask."""
    counter = {"n": 0}
    h = harness(token_responder(counter))
    h.client.installation_token(9, [42])
    h.client.installation_token(9, [43])
    h.client.installation_token(9)
    h.client.installation_token(10, [42])
    h.client.installation_token(9, [42], {"contents": "read"})
    assert counter["n"] == 5
    h.client.installation_token(9, [42])
    assert counter["n"] == 5


def test_a_rejected_installation_is_github_access_error_not_cached_a_rate_limit_is_not_turned_into_one() -> None:
    status = {"v": 404}
    h = harness(lambda c, n: respond(status["v"], {"message": "Not Found"}))
    with pytest.raises(GitHubAccessError):
        h.client.installation_token(9, [42])
    status["v"] = 422
    with pytest.raises(GitHubAccessError):
        h.client.installation_token(9, [42])
    status["v"] = 429
    with pytest.raises(GitHubRateLimitError) as caught:
        h.client.installation_token(9, [42])
    assert not isinstance(caught.value, GitHubAccessError)


def test_a_401_on_an_installation_call_drops_cached_tokens_so_the_next_call_fetches_a_fresh_one() -> None:
    counter = {"n": 0}
    reject = {"v": True}
    tokens = token_responder(counter)

    def responder(call: Call, n: int) -> httpx.Response:
        if call.url.endswith("/access_tokens"):
            return tokens(call, n)
        if reject["v"]:
            return respond(401, {"message": "Bad credentials"})
        return respond(200, {"object": {"sha": "abc"}})

    h = harness(responder)
    token = h.client.installation_token(9, [42])
    with pytest.raises(GitHubAccessError):
        h.client.get_branch_sha(token, REPO, "main")
    reject["v"] = False
    h.client.installation_token(9, [42])
    assert counter["n"] == 2


# --- requests and errors ------------------------------------------------------------------------------


def test_never_includes_the_token_or_key_in_an_error_message() -> None:
    h = harness(lambda c, n: respond(500, {"message": "boom"}))
    with pytest.raises(GitHubApiError) as caught:
        h.client.get_branch_sha("ghs_secrettoken", REPO, "main")
    import re

    assert not re.search(r"ghs_secrettoken|Bearer|BEGIN", f"{caught.value} {vars(caught.value)}")


def test_get_branch_sha_404_means_no_branch_slashes_in_a_branch_name_stay_path_separators() -> None:
    def responder(call: Call, n: int) -> httpx.Response:
        return (
            respond(404, {"message": "Not Found"})
            if "missing" in call.url
            else respond(200, {"object": {"sha": "abc123"}})
        )

    h = harness(responder)
    assert h.client.get_branch_sha("t", REPO, "missing") is None
    assert h.client.get_branch_sha("t", REPO, "canvas/ab12 cd-x") == "abc123"
    assert h.calls[1].url == "https://github.test/repos/o/r/git/ref/heads/canvas/ab12%20cd-x"
    assert h.calls[1].headers["authorization"] == "token t"


def test_create_branch_true_on_success_false_on_422_throws_on_anything_else() -> None:
    status = {"v": 201}
    h = harness(lambda c, n: respond(status["v"], {}))
    assert h.client.create_branch("t", REPO, "b", "sha") is True
    status["v"] = 422
    assert h.client.create_branch("t", REPO, "b", "sha") is False
    status["v"] = 403
    with pytest.raises(GitHubApiError):
        h.client.create_branch("t", REPO, "b", "sha")


def test_fast_forward_branch_is_never_forced() -> None:
    h = harness(lambda c, n: respond(200, {}))
    h.client.fast_forward_branch("t", REPO, "canvas/x-r1", "sha1")
    assert h.calls[0].method == "PATCH"
    assert h.calls[0].body == {"sha": "sha1", "force": False}
    assert h.calls[0].url == "https://github.test/repos/o/r/git/refs/heads/canvas/x-r1"


def test_create_tree_sends_base_tree_and_inline_content_entries() -> None:
    h = harness(lambda c, n: respond(201, {"sha": "tree1"}))
    assert h.client.create_tree("t", REPO, "base", [{"path": "a/b.md", "content": "hi"}]) == "tree1"
    assert h.calls[0].body == {
        "base_tree": "base",
        "tree": [{"path": "a/b.md", "mode": "100644", "type": "blob", "content": "hi"}],
    }


def test_maps_a_pull_request_deriving_merged_from_merged_at_when_github_omits_the_flag() -> None:
    raw = {
        "number": 7,
        "html_url": "https://github.test/o/r/pull/7",
        "state": "closed",
        "merged_at": "2026-10-24T00:00:00Z",
        "merged_by": {"login": "rev"},
        "merge_commit_sha": "mc",
        "closed_at": "2026-10-24T00:00:00Z",
        "head": {"sha": "h"},
    }
    h = harness(lambda c, n: respond(200, raw))
    assert h.client.get_pull_request("t", REPO, 7) == PullRequest(
        number=7,
        url=raw["html_url"],
        state="closed",
        merged=True,
        head_sha="h",
        merged_at=raw["merged_at"],
        merged_by="rev",
        merge_commit_sha="mc",
        closed_at=raw["closed_at"],
        requested_reviewers=[],
    )


def test_retries_a_get_once_on_a_5xx_or_a_network_error_but_never_a_post() -> None:
    get = harness(
        lambda c, n: respond(502, {"message": "bad gateway"}) if n == 1 else respond(200, {"object": {"sha": "ok"}})
    )
    assert get.client.get_branch_sha("t", REPO, "main") == "ok"
    assert len(get.calls) == 2

    net = harness(
        lambda c, n: httpx.ConnectError("fetch failed") if n == 1 else respond(200, {"object": {"sha": "ok"}})
    )
    assert net.client.get_branch_sha("t", REPO, "main") == "ok"

    post = harness(lambda c, n: respond(502, {"message": "bad gateway"}))
    with pytest.raises(GitHubApiError):
        post.client.create_commit("t", REPO, "m", "tree", "parent")
    assert len(post.calls) == 1

    down = harness(lambda c, n: httpx.ConnectError("fetch failed"))
    with pytest.raises(GitHubUnavailableError):
        down.client.get_branch_sha("t", REPO, "main")
    assert len(down.calls) == 2
    post_down = harness(lambda c, n: httpx.ConnectError("fetch failed"))
    with pytest.raises(GitHubUnavailableError):
        post_down.client.create_commit("t", REPO, "m", "tree", "parent")
    assert len(post_down.calls) == 1


def test_recognises_a_rate_limit_by_429_or_403_with_no_requests_remaining_a_plain_403_is_an_ordinary_error() -> None:
    for status, body, headers in [
        (429, {"message": "slow down"}, {}),
        (403, {"message": "limit"}, {"x-ratelimit-remaining": "0"}),
    ]:
        h = harness(lambda c, n, s=status, b=body, hd=headers: respond(s, b, hd))  # type: ignore[misc]
        with pytest.raises(GitHubRateLimitError):
            h.client.get_pull_request("t", REPO, 1)
    plain = harness(
        lambda c, n: respond(
            403, {"message": "Resource not accessible by integration"}, {"x-ratelimit-remaining": "4000"}
        )
    )
    with pytest.raises(GitHubApiError) as caught:
        plain.client.get_pull_request("t", REPO, 1)
    assert not isinstance(caught.value, GitHubRateLimitError)
    assert caught.value.status == 403
    assert caught.value.message == "Resource not accessible by integration"


def test_a_non_json_body_an_html_error_page_from_a_proxy_is_a_github_error_not_a_crash() -> None:
    html = harness(
        lambda c, n: httpx.Response(
            502, content="<html><body>502 Bad Gateway</body></html>", headers={"content-type": "text/html"}
        )
    )
    with pytest.raises(GitHubApiError):
        html.client.create_commit("t", REPO, "m", "tree", "parent")
    ok = harness(lambda c, n: httpx.Response(200, content="<html>captive portal</html>"))
    with pytest.raises(GitHubApiError):
        ok.client.get_pull_request("t", REPO, 1)


def test_lists_repositories_across_pages_until_the_total_is_reached() -> None:
    def raw(i: int) -> dict[str, Any]:
        return {
            "id": i,
            "name": f"r{i}",
            "full_name": f"o/r{i}",
            "owner": {"login": "o"},
            "default_branch": "main",
            "private": True,
        }

    def responder(call: Call, n: int) -> httpx.Response:
        if call.url.endswith("/access_tokens"):
            return respond(201, {"token": "t", "expires_at": "2099-01-01T00:00:00Z"})
        page = int(httpx.URL(call.url).params["page"])
        ids = list(range(1, 101)) if page == 1 else [101, 102]
        return respond(200, {"total_count": 102, "repositories": [raw(i) for i in ids]})

    h = harness(responder)
    repos = h.client.list_installation_repositories(9)
    assert len(repos) == 102
    assert len([c for c in h.calls if "/installation/repositories" in c.url]) == 2
    assert repos[0] == {
        "id": 1,
        "owner": "o",
        "name": "r1",
        "fullName": "o/r1",
        "defaultBranch": "main",
        "private": True,
    }


# --- sync calls (canvas-3s5.2) ------------------------------------------------------------------------

ARCH = RepoRef("acme", "arch")


def run(name: str, status: str, conclusion: str | None) -> dict[str, Any]:
    return {"name": name, "status": status, "conclusion": conclusion, "html_url": f"https://ci/{name}"}


def checks_for(runs: list[dict[str, Any]], statuses: list[dict[str, Any]] | None = None) -> tuple[Any, Harness]:
    h = harness(
        lambda c, n: (
            respond(200, {"check_runs": runs}) if "/check-runs" in c.url else respond(200, {"statuses": statuses or []})
        )
    )
    return h.client.list_checks("t", ARCH, "abc123"), h


def test_list_checks_asks_for_check_runs_and_the_combined_status_of_the_commit_and_merges_them() -> None:
    checks, h = checks_for(
        [run("build", "completed", "success")], [{"context": "legacy", "state": "success", "target_url": None}]
    )
    assert [c.url for c in h.calls] == [
        "https://github.test/repos/acme/arch/commits/abc123/check-runs?per_page=100",
        "https://github.test/repos/acme/arch/commits/abc123/status",
    ]
    assert checks == [
        {"name": "build", "state": "success", "url": "https://ci/build"},
        {"name": "legacy", "state": "success", "url": None},
    ]


def test_check_run_conclusions_failures_running_and_the_not_failures() -> None:
    checks, _ = checks_for(
        [
            run("a", "completed", "failure"),
            run("b", "completed", "timed_out"),
            run("c", "completed", "cancelled"),
            run("d", "completed", "action_required"),
            run("e", "in_progress", None),
            run("f", "queued", None),
            run("g", "completed", "skipped"),
            run("h", "completed", "neutral"),
            run("i", "completed", "success"),
        ]
    )
    assert {c["name"]: c["state"] for c in checks} == {
        "a": "failure",
        "b": "failure",
        "c": "failure",
        "d": "failure",
        "e": "pending",
        "f": "pending",
        "g": "skipped",
        "h": "neutral",
        "i": "success",
    }


def test_a_commit_status_in_error_is_a_failure_pending_and_failure_keep_their_meaning() -> None:
    checks, _ = checks_for(
        [],
        [
            {"context": "x", "state": "error", "target_url": "https://ci/x"},
            {"context": "y", "state": "failure", "target_url": None},
            {"context": "z", "state": "pending", "target_url": None},
        ],
    )
    assert [(c["name"], c["state"]) for c in checks] == [("x", "failure"), ("y", "failure"), ("z", "pending")]


def test_list_checks_surfaces_a_403_as_a_github_api_error_carrying_the_status() -> None:
    h = harness(lambda c, n: respond(403, {"message": "Resource not accessible by integration"}))
    with pytest.raises(GitHubApiError) as caught:
        h.client.list_checks("t", ARCH, "abc")
    assert caught.value.status == 403


def test_get_pull_request_reads_requested_reviewers_and_teams() -> None:
    raw = {
        "number": 4,
        "html_url": "u",
        "state": "open",
        "merged_at": None,
        "merge_commit_sha": None,
        "closed_at": None,
        "head": {"sha": "s"},
        "requested_reviewers": [{"login": "ann"}],
        "requested_teams": [{"slug": "arch"}],
    }
    h = harness(lambda c, n: respond(200, raw))
    assert h.client.get_pull_request("t", ARCH, 4).requested_reviewers == ["ann", "team:arch"]


def test_list_reviews_pages_by_100_maps_a_deleted_user_to_ghost_and_stops_on_a_short_page() -> None:
    def page(n: int) -> list[dict[str, Any]]:
        return [
            {
                "user": None if i == 0 else {"login": f"u{i}"},
                "state": "COMMENTED",
                "submitted_at": "2026-01-01T00:00:00Z",
            }
            for i in range(n)
        ]

    h = harness(lambda c, n: respond(200, page(100) if httpx.URL(c.url).params["page"] == "1" else page(3)))
    reviews = h.client.list_reviews("t", ARCH, 7)
    assert len(reviews) == 103
    assert reviews[0].login == "ghost"
    assert [c.url for c in h.calls] == [
        "https://github.test/repos/acme/arch/pulls/7/reviews?per_page=100&page=1",
        "https://github.test/repos/acme/arch/pulls/7/reviews?per_page=100&page=2",
    ]


def test_add_pull_request_comment_posts_to_the_issues_endpoint_closing_patches_state_closed() -> None:
    closed = {
        "number": 7,
        "html_url": "u",
        "state": "closed",
        "merged_at": None,
        "merge_commit_sha": None,
        "closed_at": "x",
        "head": {"sha": "s"},
    }
    h = harness(lambda c, n: respond(200, closed))
    h.client.add_pull_request_comment("t", ARCH, 7, "hello")
    h.client.update_pull_request("t", ARCH, 7, {"state": "closed"})
    assert (h.calls[0].method, h.calls[0].url, h.calls[0].body) == (
        "POST",
        "https://github.test/repos/acme/arch/issues/7/comments",
        {"body": "hello"},
    )
    assert (h.calls[1].method, h.calls[1].url, h.calls[1].body) == (
        "PATCH",
        "https://github.test/repos/acme/arch/pulls/7",
        {"state": "closed"},
    )


# --- conditional requests and backoff (canvas-3s5.4) --------------------------------------------------

ARCHITECTURE = RepoRef("acme", "architecture")


def pull(sha: str) -> dict[str, Any]:
    return {
        "number": 1,
        "html_url": "u",
        "state": "open",
        "merged": False,
        "merged_at": None,
        "merge_commit_sha": None,
        "closed_at": None,
        "head": {"sha": sha},
    }


def test_sends_if_none_match_with_the_last_etag_for_a_get_and_a_304_returns_the_remembered_body() -> None:
    h = harness(lambda c, n: respond(200, pull("abc"), {"etag": '"v1"'}) if n == 1 else httpx.Response(304))
    assert h.client.get_pull_request("t", ARCHITECTURE, 1).head_sha == "abc"
    assert "if-none-match" not in h.calls[0].headers
    assert h.client.get_pull_request("t", ARCHITECTURE, 1).head_sha == "abc"
    assert h.calls[1].headers["if-none-match"] == '"v1"'


def test_a_changed_resource_200_with_a_new_etag_replaces_what_is_remembered() -> None:
    def responder(c: Call, n: int) -> httpx.Response:
        if n == 1:
            return respond(200, pull("abc"), {"etag": '"v1"'})
        if n == 2:
            return respond(200, pull("def"), {"etag": '"v2"'})
        return httpx.Response(304)

    h = harness(responder)
    h.client.get_pull_request("t", ARCHITECTURE, 1)
    assert h.client.get_pull_request("t", ARCHITECTURE, 1).head_sha == "def"
    assert h.client.get_pull_request("t", ARCHITECTURE, 1).head_sha == "def"
    assert h.calls[2].headers["if-none-match"] == '"v2"'


def test_never_sends_if_none_match_on_a_write() -> None:
    h = harness(lambda c, n: respond(200, pull("abc"), {"etag": '"v1"'}))
    h.client.get_pull_request("t", ARCHITECTURE, 1)
    h.client.update_pull_request("t", ARCHITECTURE, 1, {"title": "x"})
    assert h.calls[1].method == "PATCH"
    assert "if-none-match" not in h.calls[1].headers


def test_after_a_rate_limit_with_retry_after_calls_fail_fast_without_reaching_github_until_it_passes() -> None:
    limited = {"v": True}
    h = harness(
        lambda c, n: (
            respond(429, {"message": "slow down"}, {"retry-after": "120"})
            if limited["v"]
            else respond(200, pull("abc"))
        )
    )
    with pytest.raises(GitHubRateLimitError) as first:
        h.client.get_pull_request("t", ARCHITECTURE, 1)
    import re

    assert re.search(r"try again after \d\d:\d\d UTC", first.value.message)
    assert h.client.rate_limited_until == h.clock.now + 120_000
    limited["v"] = False
    with pytest.raises(GitHubRateLimitError):
        h.client.get_pull_request("t", ARCHITECTURE, 2)
    assert len(h.calls) == 1
    h.clock.now += 121_000
    assert h.client.get_pull_request("t", ARCHITECTURE, 3).head_sha == "abc"
    assert h.client.rate_limited_until == 0


def test_uses_x_ratelimit_reset_for_the_primary_limit_and_recognises_the_secondary_limit_by_its_message() -> None:
    reset_ms = utc_ms(2026, 10, 24, 12, 30)
    primary = harness(
        lambda c, n: respond(
            403,
            {"message": "API rate limit exceeded"},
            {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(reset_ms // 1000)},
        )
    )
    with pytest.raises(GitHubRateLimitError):
        primary.client.get_pull_request("t", ARCHITECTURE, 1)
    assert primary.client.rate_limited_until == reset_ms

    secondary = harness(
        lambda c, n: respond(403, {"message": "You have exceeded a secondary rate limit. Please wait a few minutes."})
    )
    with pytest.raises(GitHubRateLimitError):
        secondary.client.create_commit("t", ARCHITECTURE, "m", "tree", "parent")
    assert secondary.client.rate_limited_until == secondary.clock.now + 60_000
