"""A small GitHub REST client for the GitHub App Canvas submits diagrams with (apps/api/src/github/github-client.ts).

Plain httpx, no SDK. Authenticates as the App (a short-lived RS256 JWT) to find its installations, and as
an installation (a one-hour token, cached, narrowed to one repository) for everything else. Tokens are
never logged or included in an error message.

Shared by every request thread (FastAPI runs sync routes in a thread pool), so its caches are guarded by
one lock.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypedDict, cast
from urllib.parse import quote

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from canvas_api.config import GitHubAppConfig


class GitHubApiError(Exception):
    def __init__(self, status: int, message: str, path: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.path = path


class GitHubRateLimitError(GitHubApiError):
    """GitHub's rate limit was hit; try again later."""


class GitHubAccessError(GitHubApiError):
    """The App can't reach the repository any more (uninstalled, repo removed from the installation, ...)."""


class GitHubUnavailableError(Exception):
    """GitHub didn't answer (network, timeout)."""


TIMEOUT_SECONDS = 15.0
#: canvas-3s5.4: GET responses remembered for conditional requests (a 304 is free against the rate limit).
ETAG_CACHE_SIZE = 500
#: When GitHub says to back off but not for how long.
DEFAULT_BACKOFF_MS = 60_000
TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

#: Permissions a submission asks for -- no more than it uses.
SUBMIT_PERMISSIONS = {"contents": "write", "pull_requests": "write", "metadata": "read"}

_SECONDARY_LIMIT = re.compile(r"secondary rate limit|abuse", re.IGNORECASE)
_FAILED_CONCLUSIONS = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"}


class Installation(TypedDict):
    id: int
    account: str
    repositorySelection: str
    permissions: dict[str, str]


class Repository(TypedDict):
    id: int
    owner: str
    name: str
    fullName: str
    defaultBranch: str
    private: bool


@dataclass(frozen=True)
class RepoRef:
    owner: str
    name: str


@dataclass(frozen=True)
class PullRequest:
    number: int
    url: str
    state: str  # open | closed
    merged: bool
    head_sha: str
    merged_at: str | None
    merged_by: str | None
    merge_commit_sha: str | None
    closed_at: str | None
    #: Logins (and team slugs) still asked to review.
    requested_reviewers: list[str]


@dataclass(frozen=True)
class OpenPullRequest:
    """An open pull request as listed by GitHub (canvas-3s5.5: finding one Canvas opened but didn't record)."""

    number: int
    url: str
    head_ref: str
    head_sha: str
    #: owner/name of the repository the head branch is in (differs for a fork).
    head_repo: str | None
    body: str
    author: str


@dataclass(frozen=True)
class Review:
    login: str
    state: str  # APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
    submitted_at: str | None


class Check(TypedDict):
    name: str
    #: success | failure | pending | neutral | skipped
    state: str
    url: str | None


@dataclass(frozen=True)
class TreeFile:
    path: str
    sha: str
    size: int


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _segment(value: str) -> str:
    """encodeURIComponent."""
    return quote(value, safe="!*'()")


def _branch_path(branch: str) -> str:
    return "/".join(_segment(part) for part in branch.split("/"))


def _to_repo(raw: dict[str, Any]) -> Repository:
    return {
        "id": raw["id"],
        "owner": raw["owner"]["login"],
        "name": raw["name"],
        "fullName": raw["full_name"],
        "defaultBranch": raw["default_branch"],
        "private": raw["private"],
    }


def _to_installation(raw: dict[str, Any]) -> Installation:
    account = raw.get("account")
    return {
        "id": raw["id"],
        "account": account["login"] if account else "",
        "repositorySelection": raw["repository_selection"],
        "permissions": raw.get("permissions") or {},
    }


def _to_pull(raw: dict[str, Any]) -> PullRequest:
    merged = raw.get("merged")
    merged_by = raw.get("merged_by")
    return PullRequest(
        number=raw["number"],
        url=raw["html_url"],
        state=raw["state"],
        merged=bool(merged if merged is not None else raw.get("merged_at")),
        head_sha=raw["head"]["sha"],
        merged_at=raw.get("merged_at"),
        merged_by=merged_by["login"] if merged_by else None,
        merge_commit_sha=raw.get("merge_commit_sha"),
        closed_at=raw.get("closed_at"),
        requested_reviewers=[r["login"] for r in raw.get("requested_reviewers") or []]
        + [f"team:{t['slug']}" for t in raw.get("requested_teams") or []],
    )


def _check_run_state(run: dict[str, Any]) -> str:
    if run["status"] != "completed":
        return "pending"
    conclusion = run.get("conclusion")
    if conclusion and conclusion in _FAILED_CONCLUSIONS:
        return "failure"
    if conclusion == "success":
        return "success"
    return str(conclusion) if conclusion else "neutral"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


class GitHubClient:
    def __init__(
        self,
        config: GitHubAppConfig,
        transport: httpx.BaseTransport | None = None,
        now: Callable[[], int] = _now_ms,
    ) -> None:
        self._config = config
        self._http = httpx.Client(transport=transport, timeout=TIMEOUT_SECONDS)
        self._now = now
        self._lock = threading.Lock()
        self._tokens: dict[str, tuple[str, int]] = {}
        #: canvas-3s5.4: ETag + body per GET path, for If-None-Match.
        self._etags: OrderedDict[str, tuple[str, Any]] = OrderedDict()
        #: canvas-3s5.4: after a rate-limit answer, no request with the same credentials is sent before this
        #: time (ms). Per credential: GitHub limits each installation and the App separately.
        self._blocked_until: dict[str, int] = {}

    def close(self) -> None:
        self._http.close()

    @property
    def app_id(self) -> str:
        return self._config.app_id

    @property
    def api_url(self) -> str:
        return self._config.api_url

    def app_jwt(self) -> str:
        """The App's own JWT: valid ten minutes at most (GitHub's limit), backdated for clock skew."""
        issued_at = self._now() // 1000 - 60
        header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64url(
            json.dumps(
                {"iat": issued_at, "exp": issued_at + 9 * 60, "iss": self._config.app_id}, separators=(",", ":")
            ).encode()
        )
        signing_input = f"{header}.{payload}".encode()
        signature = self._config.private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        return f"{header}.{payload}.{_b64url(signature)}"

    @property
    def rate_limited_until(self) -> int:
        """The latest time (ms) any credential is blocked until after a rate limit (0 = none)."""
        with self._lock:
            latest = max([0, *self._blocked_until.values()])
        return latest if latest > self._now() else 0

    def _rate_limited(
        self, status: int, path: str, key: str, response: httpx.Response | None = None
    ) -> GitHubRateLimitError:
        with self._lock:
            if response is not None:
                retry_after = _number(response.headers.get("retry-after"))
                reset = _number(response.headers.get("x-ratelimit-reset"))
                if retry_after > 0:
                    until = self._now() + int(retry_after * 1000)
                elif reset > 0 and response.headers.get("x-ratelimit-remaining") == "0":
                    until = int(reset * 1000)
                else:
                    until = self._now() + DEFAULT_BACKOFF_MS
                self._blocked_until[key] = max(self._blocked_until.get(key, 0), until)
            at_ms = self._blocked_until.get(key, self._now())
        at = datetime.fromtimestamp(at_ms / 1000, UTC).strftime("%H:%M")
        return GitHubRateLimitError(status, f"GitHub rate limit reached; Canvas will try again after {at} UTC.", path)

    def _request(self, method: str, path: str, auth: str, body: Any = None) -> Any:
        # Don't keep calling while GitHub has asked us to wait (that can get the App blocked). The App JWT
        # changes every call, so it shares one key; installation tokens are their own keys.
        limit_key = "app" if auth.startswith("Bearer ") else auth
        with self._lock:
            blocked = self._blocked_until.get(limit_key, 0) > self._now()
            cached = self._etags.get(path) if method == "GET" else None
        if blocked:
            raise self._rate_limited(429, path, limit_key)
        attempts = 2 if method == "GET" else 1
        headers = {
            "accept": "application/vnd.github+json",
            "authorization": auth,
            "x-github-api-version": "2022-11-28",
            "user-agent": "canvas-diagrams",
        }
        if cached:
            headers["if-none-match"] = cached[0]
        content: bytes | None = None
        if body is not None:
            headers["content-type"] = "application/json"
            # ASCII-escaped: identical JSON, and a lone surrogate (a name cut mid-emoji) stays sendable.
            content = json.dumps(body, separators=(",", ":")).encode()
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = self._http.request(method, f"{self._config.api_url}{path}", headers=headers, content=content)
            except httpx.HTTPError as error:
                # The names fetch() gives these failures, so the message reads the same from both services.
                kind = "TimeoutError" if isinstance(error, httpx.TimeoutException) else "TypeError"
                last_error = GitHubUnavailableError(f"GitHub could not be reached ({kind}).")
                continue
            status = response.status_code
            if status >= 500 and attempt < attempts:
                last_error = GitHubApiError(status, f"GitHub returned {status}.", path)
                continue
            if status == 304 and cached:
                return cached[1]
            if status == 204:
                return None
            text = response.text
            # An error from a proxy in front of GitHub can be HTML, not JSON: a GitHub failure (502),
            # never an unhandled error (500).
            parsed = True
            data: Any = None
            try:
                data = json.loads(text) if text else None
            except ValueError:
                parsed = False
            if response.is_success:
                if not parsed:
                    raise GitHubApiError(status, "GitHub returned an unreadable response.", path)
                etag = response.headers.get("etag")
                if method == "GET" and etag:
                    with self._lock:
                        self._etags.pop(path, None)
                        self._etags[path] = (etag, data)
                        if len(self._etags) > ETAG_CACHE_SIZE:
                            self._etags.popitem(last=False)
                return data
            message = data.get("message") if isinstance(data, dict) else None
            if not isinstance(message, str):
                message = f"GitHub returned {status}."
            # Primary limit (429, or 403 with nothing remaining) and the secondary "abuse" limit (403/429
            # with retry-after, or its message).
            secondary = bool(_SECONDARY_LIMIT.search(message)) or "retry-after" in response.headers
            if status == 429 or (status == 403 and (response.headers.get("x-ratelimit-remaining") == "0" or secondary)):
                raise self._rate_limited(status, path, limit_key, response)
            raise GitHubApiError(status, message, path)
        raise last_error or GitHubUnavailableError("GitHub could not be reached.")

    def _as_app(self, method: str, path: str, body: Any = None) -> Any:
        return self._request(method, path, f"Bearer {self.app_jwt()}", body)

    def forget_tokens(self) -> None:
        """Drops cached installation tokens, so the next call picks up permission changes at once."""
        with self._lock:
            self._tokens.clear()

    def installation_token(
        self, installation_id: int, repository_ids: list[int] | None = None, permissions: dict[str, str] | None = None
    ) -> str:
        """A token for one installation, optionally narrowed to some repositories and permissions."""
        key = json.dumps([installation_id, repository_ids, permissions], separators=(",", ":"))
        with self._lock:
            cached = self._tokens.get(key)
        if cached and cached[1] - TOKEN_REFRESH_MARGIN_MS > self._now():
            return cached[0]
        body: dict[str, Any] = {}
        if repository_ids is not None:
            body["repository_ids"] = repository_ids
        if permissions is not None:
            body["permissions"] = permissions
        try:
            result = self._as_app("POST", f"/app/installations/{installation_id}/access_tokens", body)
        except GitHubRateLimitError:
            raise
        except GitHubApiError as error:
            if error.status in (401, 403, 404, 422):
                raise GitHubAccessError(
                    error.status,
                    "The Canvas GitHub App no longer has access to this repository (check the installation).",
                    error.path,
                ) from error
            raise
        token = str(result["token"])
        with self._lock:
            self._tokens[key] = (token, _iso_ms(result["expires_at"]))
        return token

    def _as_installation(self, token: str, method: str, path: str, body: Any = None) -> Any:
        try:
            return self._request(method, path, f"token {token}", body)
        except GitHubApiError as error:
            if error.status == 401 and not isinstance(error, GitHubRateLimitError):
                self.forget_tokens()
                raise GitHubAccessError(401, "GitHub rejected the Canvas App token.", error.path) from error
            raise

    def list_installations(self) -> list[Installation]:
        raw = self._as_app("GET", "/app/installations?per_page=100")
        return [_to_installation(i) for i in raw]

    def get_installation(self, installation_id: int) -> Installation:
        return _to_installation(self._as_app("GET", f"/app/installations/{installation_id}"))

    def list_installation_repositories(self, installation_id: int) -> list[Repository]:
        """Every repository an installation can reach (up to 1,000)."""
        token = self.installation_token(installation_id)
        repos: list[Repository] = []
        for page in range(1, 11):
            result = self._as_installation(token, "GET", f"/installation/repositories?per_page=100&page={page}")
            repos.extend(_to_repo(r) for r in result["repositories"])
            if len(result["repositories"]) < 100 or len(repos) >= result["total_count"]:
                break
        return repos

    def get_repository(self, token: str, repo_id: int) -> Repository:
        """By id, so a renamed or transferred repository is still found."""
        return _to_repo(self._as_installation(token, "GET", f"/repositories/{repo_id}"))

    @staticmethod
    def _repo_path(repo: RepoRef) -> str:
        return f"/repos/{_segment(repo.owner)}/{_segment(repo.name)}"

    def get_branch_sha(self, token: str, repo: RepoRef, branch: str) -> str | None:
        """The commit a branch points at, or None if there's no such branch."""
        try:
            ref = self._as_installation(token, "GET", f"{self._repo_path(repo)}/git/ref/heads/{_branch_path(branch)}")
        except GitHubApiError as error:
            if error.status == 404 and not isinstance(error, GitHubAccessError):
                return None
            raise
        return str(ref["object"]["sha"])

    def get_commit_tree_sha(self, token: str, repo: RepoRef, commit_sha: str) -> str:
        commit = self._as_installation(token, "GET", f"{self._repo_path(repo)}/git/commits/{commit_sha}")
        return str(commit["tree"]["sha"])

    def list_tree_files(self, token: str, repo: RepoRef, tree_sha: str) -> tuple[list[TreeFile], bool]:
        """canvas-finl: every file under a tree, and whether GitHub cut the listing short."""
        tree = self._as_installation(token, "GET", f"{self._repo_path(repo)}/git/trees/{tree_sha}?recursive=1")
        files = [TreeFile(e["path"], e["sha"], e.get("size") or 0) for e in tree["tree"] if e["type"] == "blob"]
        return files, bool(tree.get("truncated"))

    def get_blob_text(self, token: str, repo: RepoRef, blob_sha: str) -> str:
        """canvas-finl: a file's content as UTF-8 text."""
        blob = self._as_installation(token, "GET", f"{self._repo_path(repo)}/git/blobs/{blob_sha}")
        if blob["encoding"] == "base64":
            return base64.b64decode(blob["content"]).decode("utf-8", errors="replace")
        return str(blob["content"])

    def create_tree(self, token: str, repo: RepoRef, base_tree: str, files: list[dict[str, str]]) -> str:
        """A tree that is `base_tree` with these files written (text content; GitHub creates the blobs)."""
        tree = self._as_installation(
            token,
            "POST",
            f"{self._repo_path(repo)}/git/trees",
            {
                "base_tree": base_tree,
                "tree": [{"path": f["path"], "mode": "100644", "type": "blob", "content": f["content"]} for f in files],
            },
        )
        return str(tree["sha"])

    def create_commit(self, token: str, repo: RepoRef, message: str, tree: str, parent: str) -> str:
        commit = self._as_installation(
            token,
            "POST",
            f"{self._repo_path(repo)}/git/commits",
            {"message": message, "tree": tree, "parents": [parent]},
        )
        return str(commit["sha"])

    def create_branch(self, token: str, repo: RepoRef, branch: str, sha: str) -> bool:
        """Creates a branch; False if it already exists."""
        try:
            self._as_installation(
                token, "POST", f"{self._repo_path(repo)}/git/refs", {"ref": f"refs/heads/{branch}", "sha": sha}
            )
        except GitHubApiError as error:
            if error.status == 422:
                return False
            raise
        return True

    def fast_forward_branch(self, token: str, repo: RepoRef, branch: str, sha: str) -> None:
        """Moves a branch forward to `sha`. Never forced: fails (422) if `sha` doesn't follow from it."""
        self._as_installation(
            token,
            "PATCH",
            f"{self._repo_path(repo)}/git/refs/heads/{_branch_path(branch)}",
            {"sha": sha, "force": False},
        )

    def create_pull_request(
        self, token: str, repo: RepoRef, *, title: str, head: str, base: str, body: str
    ) -> PullRequest:
        return _to_pull(
            self._as_installation(
                token,
                "POST",
                f"{self._repo_path(repo)}/pulls",
                {"title": title, "head": head, "base": base, "body": body, "maintainer_can_modify": False},
            )
        )

    def update_pull_request(self, token: str, repo: RepoRef, number: int, patch: dict[str, str]) -> PullRequest:
        return _to_pull(self._as_installation(token, "PATCH", f"{self._repo_path(repo)}/pulls/{number}", patch))

    def get_pull_request(self, token: str, repo: RepoRef, number: int) -> PullRequest:
        return _to_pull(self._as_installation(token, "GET", f"{self._repo_path(repo)}/pulls/{number}"))

    def list_reviews(self, token: str, repo: RepoRef, number: int) -> list[Review]:
        """Every review on a pull request, oldest first."""
        reviews: list[Review] = []
        for page in range(1, 6):
            raw = self._as_installation(
                token, "GET", f"{self._repo_path(repo)}/pulls/{number}/reviews?per_page=100&page={page}"
            )
            reviews.extend(
                Review((r.get("user") or {}).get("login", "ghost"), r["state"], r.get("submitted_at")) for r in raw
            )
            if len(raw) < 100:
                break
        return reviews

    def list_checks(self, token: str, repo: RepoRef, sha: str) -> list[Check]:
        """Check runs (GitHub Actions, apps) and commit statuses (older CI integrations) on a commit."""
        runs = self._as_installation(token, "GET", f"{self._repo_path(repo)}/commits/{sha}/check-runs?per_page=100")
        status = self._as_installation(token, "GET", f"{self._repo_path(repo)}/commits/{sha}/status")
        checks: list[Check] = [
            {"name": r["name"], "state": _check_run_state(r), "url": r.get("html_url")} for r in runs["check_runs"]
        ]
        checks.extend(
            {
                "name": st["context"],
                "state": "failure" if st["state"] == "error" else st["state"],
                "url": st.get("target_url"),
            }
            for st in status["statuses"]
        )
        return checks

    def add_pull_request_comment(self, token: str, repo: RepoRef, number: int, body: str) -> None:
        self._as_installation(token, "POST", f"{self._repo_path(repo)}/issues/{number}/comments", {"body": body})

    def list_open_pull_requests(self, token: str, repo: RepoRef, base: str) -> list[OpenPullRequest]:
        """Open pull requests into `base` (up to 500, newest first)."""
        pulls: list[OpenPullRequest] = []
        for page in range(1, 6):
            raw = self._as_installation(
                token,
                "GET",
                f"{self._repo_path(repo)}/pulls?state=open&base={_segment(base)}&per_page=100&page={page}",
            )
            for p in cast(list[dict[str, Any]], raw):
                head_repo = p["head"].get("repo")
                pulls.append(
                    OpenPullRequest(
                        number=p["number"],
                        url=p["html_url"],
                        head_ref=p["head"]["ref"],
                        head_sha=p["head"]["sha"],
                        head_repo=head_repo["full_name"] if head_repo else None,
                        body=p.get("body") or "",
                        author=(p.get("user") or {}).get("login", ""),
                    )
                )
            if len(raw) < 100:
                break
        return pulls


def _number(value: str | None) -> float:
    """JavaScript's Number(header): 0 for a missing or unreadable value."""
    if value is None:
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0
