"""This service as the front door (phase 10 part 2, canvas-1bty.14): the web app, paused mode, CORS, security
headers, the fallback to the TypeScript service, the settings behind them, and the audit client address.
The behaviours are those of apps/api (app.ts, web/web-app.ts, python/front-door.ts).

Settings are built explicitly from the session's test settings: every front-door field is reset first, so a
stray environment variable (the pydantic settings read the process environment) can't leak in.
"""

from __future__ import annotations

import gzip
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from canvas_api import front_door
from canvas_api.app import create_app
from canvas_api.config import Settings
from canvas_api.front_door import match_route
from tests.api import Api

FRONT_DOOR_ENV = (
    "WEB_DIST_DIR",
    "PAUSED_PAGE_PATH",
    "CANVAS_PAUSED",
    "TYPESCRIPT_API_URL",
    "TYPESCRIPT_ROUTE_GROUPS",
    "TRUST_CLIENT_IP_HEADER",
    "WEB_ORIGINS",
)
BLANK: dict[str, Any] = {
    "web_dist_dir": None,
    "paused_page_path": None,
    "paused_setting": None,
    "typescript_api_url_setting": None,
    "typescript_route_groups_setting": None,
    "trust_client_ip_header_setting": None,
    "web_origins": "http://localhost:5173",
}
SECURITY = {"x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin"}
TS_URL = "http://ts.internal:3000"
GZ_BODY = gzip.compress(b"console.log(1)")


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in FRONT_DOOR_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture()
def make_app(settings: Settings, engine: Engine) -> Iterator[Callable[..., TestClient]]:
    """`make_app(web_dist_dir=..., paused_setting="true", typescript_transport=...)`: an app over the clean
    database with these front-door settings (field names of Settings) and nothing else set."""
    from tests.api import reset

    reset(engine)
    opened: list[TestClient] = []

    def make(typescript_transport: httpx.AsyncBaseTransport | None = None, **changes: Any) -> TestClient:
        app_settings = settings.model_copy(update={**BLANK, **changes})
        client = TestClient(create_app(app_settings, engine, typescript_transport=typescript_transport))
        client.__enter__()
        opened.append(client)
        return client

    yield make
    for client in opened:
        client.__exit__(None, None, None)


def raw(client: TestClient, url: str, **headers: str) -> tuple[httpx.Response, bytes]:
    """The response and its body exactly as sent (no decoding of Content-Encoding)."""
    with client.stream("GET", url, headers=headers) as response:
        return response, b"".join(response.iter_raw())


def fastify_404(method: str, path: str) -> dict[str, Any]:
    return {"message": f"Route {method}:{path} not found", "error": "Not Found", "statusCode": 404}


def assert_secured(response: httpx.Response) -> None:
    for name, value in SECURITY.items():
        assert response.headers[name] == value, name


# --- the web app ------------------------------------------------------------------------------------


@pytest.fixture()
def dist(tmp_path: Path) -> Path:
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><p>index</p>", encoding="utf-8")
    (root / "assets" / "x.js").write_text("console.log(1)", encoding="utf-8")
    (root / "assets" / "x.js.gz").write_bytes(GZ_BODY)
    (root / "assets" / "x.js.br").write_bytes(b"not-really-brotli")
    (root / "assets" / "only.css").write_text("a{}", encoding="utf-8")
    (root / "robots.txt").write_text("User-agent: *", encoding="utf-8")
    (root / ".env").write_text("SECRET=1", encoding="utf-8")  # gitleaks:allow
    (root / ".hidden").mkdir()
    (root / ".hidden" / "a.txt").write_text("hidden", encoding="utf-8")
    return root


@pytest.fixture()
def web(make_app: Callable[..., TestClient], dist: Path) -> TestClient:
    return make_app(web_dist_dir=str(dist))


@pytest.mark.parametrize("path", ["/", "/index.html", "/?projectId=abc"])
def test_serves_the_index_revalidated(web: TestClient, path: str) -> None:
    response = web.get(path)
    assert response.status_code == 200
    assert response.text == "<!doctype html><p>index</p>"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    assert response.headers["etag"]
    assert response.headers["last-modified"]
    # (CORS adds Origin to it for a request that has one.)
    assert "Accept-Encoding" in response.headers["vary"]


def test_hashed_assets_are_cached_for_a_year_and_other_files_are_revalidated(web: TestClient) -> None:
    asset = web.get("/assets/only.css")
    assert asset.status_code == 200
    assert asset.text == "a{}"
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert asset.headers["content-type"] == "text/css; charset=utf-8"
    other = web.get("/robots.txt")
    assert other.text == "User-agent: *"
    assert other.headers["cache-control"] == "no-cache"
    assert (
        web.get("/assets/x.js", headers={"accept-encoding": "identity"})
        .headers["content-type"]
        .startswith(("text/javascript", "application/javascript"))
    )


def test_serves_the_brotli_copy_before_the_gzip_one_when_the_browser_accepts_it(web: TestClient) -> None:
    response, body = raw(web, "/assets/x.js", **{"accept-encoding": "gzip, deflate, br"})
    assert response.headers["content-encoding"] == "br"
    assert body == b"not-really-brotli"
    assert response.headers["content-length"] == str(len(b"not-really-brotli"))
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_serves_gzip_when_only_gzip_is_accepted(web: TestClient) -> None:
    response, body = raw(web, "/assets/x.js", **{"accept-encoding": "gzip"})
    assert response.headers["content-encoding"] == "gzip"
    assert body == GZ_BODY
    assert gzip.decompress(body) == b"console.log(1)"


def test_serves_the_plain_file_without_an_accepted_encoding_or_a_compressed_copy(web: TestClient) -> None:
    response, body = raw(web, "/assets/x.js", **{"accept-encoding": "identity"})
    assert "content-encoding" not in response.headers
    assert body == b"console.log(1)"
    # No .br/.gz copy exists for this one, whatever the browser accepts.
    response, body = raw(web, "/assets/only.css", **{"accept-encoding": "gzip, br"})
    assert "content-encoding" not in response.headers
    assert body == b"a{}"


def test_answers_a_conditional_request_with_304(web: TestClient) -> None:
    first = web.get("/assets/only.css")
    etag = first.headers["etag"]
    cached = web.get("/assets/only.css", headers={"if-none-match": etag})
    assert cached.status_code == 304
    assert cached.content == b""
    assert cached.headers["etag"] == etag
    assert cached.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert web.get("/assets/only.css", headers={"if-none-match": f'"other", {etag}'}).status_code == 304
    assert web.get("/assets/only.css", headers={"if-none-match": '"other"'}).status_code == 200


def test_the_etag_differs_for_a_changed_file(web: TestClient, dist: Path) -> None:
    before = web.get("/robots.txt").headers["etag"]
    (dist / "robots.txt").write_text("changed, longer", encoding="utf-8")
    # Files are found at start-up, but their validators are read per request.
    assert web.get("/robots.txt").headers["etag"] != before


def test_head_has_the_headers_and_no_body(web: TestClient) -> None:
    response = web.head("/assets/only.css")
    assert response.status_code == 200
    assert response.content == b""
    assert response.headers["content-length"] == "3"
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    index = web.head("/")
    assert index.status_code == 200
    assert index.content == b""
    assert index.headers["content-length"] == str(len("<!doctype html><p>index</p>"))


@pytest.mark.parametrize("path", ["/.env", "/.hidden/a.txt", "/nope", "/assets/nope.js", "/assets/", "/assets"])
def test_a_dotfile_or_an_unknown_path_gets_fastifys_404(web: TestClient, path: str) -> None:
    response = web.get(path)
    assert response.status_code == 404
    assert response.json() == fastify_404("GET", path)


def test_the_compressed_copies_are_not_served_as_files_themselves(web: TestClient) -> None:
    assert web.get("/assets/x.js.gz").status_code == 404
    assert web.get("/assets/x.js.br").status_code == 404


def test_only_get_and_head_serve_files(web: TestClient) -> None:
    for method in ("POST", "PUT", "DELETE", "PATCH"):
        response = web.request(method, "/index.html")
        assert response.status_code == 404
        assert response.json() == fastify_404(method, "/index.html")


def test_a_file_never_shadows_an_api_route(make_app: Callable[..., TestClient], dist: Path) -> None:
    (dist / "health").write_text("shadow", encoding="utf-8")
    (dist / "projects").write_text("shadow", encoding="utf-8")
    client = make_app(web_dist_dir=str(dist))
    assert client.get("/health").json() == {"status": "ok"}
    # Signed out, so the API's own 401, not the file.
    assert client.get("/projects").status_code == 401
    assert client.get("/projects").json() != "shadow"


def test_files_are_served_from_a_dist_directory_under_a_hidden_directory(
    make_app: Callable[..., TestClient], dist: Path, tmp_path: Path
) -> None:
    hidden = tmp_path / ".cache" / "web"
    hidden.parent.mkdir()
    dist.rename(hidden)
    client = make_app(web_dist_dir=str(hidden))
    assert client.get("/").status_code == 200
    assert client.get("/assets/only.css").text == "a{}"
    # Only a hidden path INSIDE the dist is refused.
    assert client.get("/.env").status_code == 404


def test_there_is_no_web_app_without_a_dist_directory_or_an_index(
    make_app: Callable[..., TestClient], tmp_path: Path, dist: Path
) -> None:
    unset = make_app()
    assert unset.get("/").json() == fastify_404("GET", "/")
    (dist / "index.html").unlink()
    no_index = make_app(web_dist_dir=str(dist))
    assert no_index.get("/").json() == fastify_404("GET", "/")
    assert no_index.get("/assets/only.css").status_code == 404
    empty = tmp_path / "empty"
    empty.mkdir()
    assert make_app(web_dist_dir=str(empty)).get("/").status_code == 404
    assert make_app(web_dist_dir=str(tmp_path / "missing")).get("/").status_code == 404


# --- unknown routes ----------------------------------------------------------------------------------


@pytest.mark.parametrize("method", ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
def test_an_unknown_route_gets_fastifys_404_body_for_any_method(
    make_app: Callable[..., TestClient], method: str
) -> None:
    response = make_app().request(method, "/no/such/route")
    assert response.status_code == 404
    if method != "HEAD":
        assert response.json() == fastify_404(method, "/no/such/route")
    assert_secured(response)


def test_a_wrong_method_gets_the_same_404(make_app: Callable[..., TestClient]) -> None:
    client = make_app()
    for method in ("DELETE", "POST", "PATCH"):
        response = client.request(method, "/health")
        assert response.status_code == 404
        assert response.json() == fastify_404(method, "/health")


def test_a_404_a_route_raises_keeps_its_own_body(make_app: Callable[..., TestClient], engine: Engine) -> None:
    client = make_app()
    api = Api(client, engine)
    missing = uuid4()
    response = api.call("GET", f"/projects/{missing}", api.user("architect@example.com"))
    assert response.status_code == 404
    assert response.json() == {"error": f"No project with id {missing}"}
    assert_secured(response)


# --- paused ------------------------------------------------------------------------------------------


@pytest.fixture()
def paused(make_app: Callable[..., TestClient], dist: Path) -> TestClient:
    return make_app(web_dist_dir=str(dist), paused_setting="true")


def test_paused_browsers_get_the_paused_page(paused: TestClient) -> None:
    response = paused.get("/", headers={"accept": "text/html,application/xhtml+xml"})
    assert response.status_code == 503
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    assert "Canvas is paused" in response.text
    assert "index" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["retry-after"] == "3600"
    assert_secured(response)


def test_paused_api_calls_get_a_503_json_error(paused: TestClient) -> None:
    expected = {"error": "Canvas is paused. Ask your admin to resume it."}
    for response in (
        paused.get("/projects", headers={"accept": "application/json"}),
        paused.get("/projects"),
        paused.get("/assets/only.css"),
        paused.post("/projects", json={"name": "x"}, headers={"accept": "text/html"}),
        paused.request("DELETE", "/nope"),
    ):
        assert response.status_code == 503
        assert response.json() == expected
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["retry-after"] == "3600"
        assert_secured(response)


def test_paused_still_answers_health(paused: TestClient) -> None:
    response = paused.get("/health", headers={"accept": "text/html"})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_the_paused_page_comes_from_a_file_when_one_is_configured(
    make_app: Callable[..., TestClient], tmp_path: Path
) -> None:
    page = tmp_path / "paused.html"
    page.write_text("<p>Back at nine</p>", encoding="utf-8")
    client = make_app(paused_setting="true", paused_page_path=str(page))
    assert client.get("/", headers={"accept": "text/html"}).text == "<p>Back at nine</p>"
    missing = make_app(paused_setting="true", paused_page_path=str(tmp_path / "gone.html"))
    assert "Canvas is paused" in missing.get("/", headers={"accept": "text/html"}).text


@pytest.mark.parametrize("value", [None, "", "false", "TRUE", "1", "yes"])
def test_only_the_word_true_pauses(make_app: Callable[..., TestClient], value: str | None) -> None:
    assert make_app(paused_setting=value).get("/projects").status_code == 401


def test_pausing_wins_over_forwarding_to_typescript(make_app: Callable[..., TestClient]) -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200)

    client = make_app(
        httpx.MockTransport(handler),
        paused_setting="true",
        typescript_api_url_setting=TS_URL,
        typescript_route_groups_setting="projects",
    )
    assert client.get("/projects").status_code == 503
    assert calls == []


# --- CORS --------------------------------------------------------------------------------------------

ORIGIN = "https://canvas.example"


@pytest.fixture()
def cors(make_app: Callable[..., TestClient]) -> TestClient:
    return make_app(web_origins=f"http://localhost:5173, {ORIGIN}")


def test_a_preflight_from_an_allowed_origin_is_answered_with_the_allowed_methods(cors: TestClient) -> None:
    response = cors.options(
        "/projects",
        headers={
            "origin": ORIGIN,
            "access-control-request-method": "PATCH",
            "access-control-request-headers": "content-type, x-custom",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"
    allowed = {m.strip() for m in response.headers["access-control-allow-methods"].split(",")}
    assert allowed == {"GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"}
    assert response.headers["access-control-allow-headers"].lower() == "content-type, x-custom"
    assert_secured(response)


def test_the_first_of_several_origins_works_too(cors: TestClient) -> None:
    response = cors.options(
        "/projects", headers={"origin": "http://localhost:5173", "access-control-request-method": "GET"}
    )
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_a_preflight_from_another_origin_gets_no_allow_origin(cors: TestClient) -> None:
    response = cors.options(
        "/projects", headers={"origin": "https://evil.example", "access-control-request-method": "POST"}
    )
    assert "access-control-allow-origin" not in response.headers
    assert response.status_code != 200
    assert_secured(response)


def test_simple_requests_from_the_allowed_origin_carry_the_headers(cors: TestClient) -> None:
    response = cors.get("/health", headers={"origin": ORIGIN})
    assert response.json() == {"status": "ok"}
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"
    # An error response carries them too.
    assert cors.get("/projects", headers={"origin": ORIGIN}).headers["access-control-allow-origin"] == ORIGIN
    assert cors.get("/nope", headers={"origin": ORIGIN}).headers["access-control-allow-origin"] == ORIGIN


def test_simple_requests_from_another_origin_or_without_one_carry_none(cors: TestClient) -> None:
    assert "access-control-allow-origin" not in cors.get("/health", headers={"origin": "https://evil.example"}).headers
    assert "access-control-allow-origin" not in cors.get("/health").headers


def test_the_default_allowed_origin_is_the_vite_dev_server(make_app: Callable[..., TestClient]) -> None:
    client = make_app()
    assert (
        client.get("/health", headers={"origin": "http://localhost:5173"}).headers["access-control-allow-origin"]
        == "http://localhost:5173"
    )
    assert "access-control-allow-origin" not in client.get("/health", headers={"origin": ORIGIN}).headers


# --- security headers --------------------------------------------------------------------------------


def test_security_headers_are_on_every_kind_of_response(
    make_app: Callable[..., TestClient], dist: Path, tmp_path: Path
) -> None:
    client = make_app(web_dist_dir=str(dist), web_origins=ORIGIN)
    for response in (
        client.get("/health"),
        client.get("/projects"),
        client.get("/"),
        client.get("/assets/only.css"),
        client.get("/assets/only.css", headers={"if-none-match": client.get("/assets/only.css").headers["etag"]}),
        client.head("/"),
        client.get("/.env"),
        client.get("/no/such"),
        client.delete("/health"),
        client.options("/projects", headers={"origin": ORIGIN, "access-control-request-method": "GET"}),
        client.options("/projects", headers={"origin": "https://evil.example", "access-control-request-method": "GET"}),
    ):
        assert_secured(response)
    assert_secured(make_app(paused_setting="true").get("/", headers={"accept": "text/html"}))
    assert_secured(make_app(paused_setting="true").get("/projects"))


# --- the fallback to the TypeScript service ----------------------------------------------------------


class Upstream:
    """A stand-in TypeScript service: records every request, answers with `respond`."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.respond: Callable[[httpx.Request], httpx.Response] = lambda r: httpx.Response(204)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


@pytest.fixture()
def upstream() -> Upstream:
    return Upstream()


def forwarding(make_app: Callable[..., TestClient], upstream: Upstream, groups: str | None = "projects") -> TestClient:
    return make_app(upstream.transport, typescript_api_url_setting=TS_URL, typescript_route_groups_setting=groups)


def test_a_route_in_a_named_group_is_forwarded_with_its_method_path_query_body_and_cookies(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    upstream.respond = lambda r: httpx.Response(201, json={"project": {"id": "p1"}})
    client = forwarding(make_app, upstream)
    response = client.post(
        "/projects",
        content=b'{"name":"A"}\x00\xff',
        headers={"cookie": "cid=abc; other=2", "content-type": "application/octet-stream", "x-custom": "kept"},
    )
    assert response.status_code == 201
    assert response.json() == {"project": {"id": "p1"}}
    sent = upstream.last
    assert sent.method == "POST"
    assert str(sent.url) == f"{TS_URL}/projects"
    assert sent.content == b'{"name":"A"}\x00\xff'
    assert sent.headers["cookie"] == "cid=abc; other=2"
    assert sent.headers["content-type"] == "application/octet-stream"
    assert sent.headers["x-custom"] == "kept"
    assert sent.headers["x-forwarded-host"] == "testserver"
    assert sent.headers["x-forwarded-proto"] == "http"


def test_the_query_string_and_path_parameters_are_forwarded(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    client = forwarding(make_app, upstream)
    client.get("/projects/9f0/tree?depth=2&q=a%20b&q=c")
    assert upstream.last.method == "GET"
    assert upstream.last.url.path == "/projects/9f0/tree"
    assert upstream.last.url.params.multi_items() == [("depth", "2"), ("q", "a b"), ("q", "c")]
    assert upstream.last.content == b""


def test_forwarding_tells_typescript_the_original_host_and_scheme(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    client = forwarding(make_app, upstream)
    client.get(
        "/projects",
        headers={
            "host": "canvas.example",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "spoofed.example",
        },
    )
    assert upstream.last.headers["x-forwarded-host"] == "canvas.example"
    assert upstream.last.headers["x-forwarded-proto"] == "https"
    # Host itself is the upstream's, not the browser's.
    assert upstream.last.headers["host"] == "ts.internal:3000"


def test_the_client_address_is_the_last_forwarded_for_entry_and_a_client_sent_one_is_overwritten(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    client = forwarding(make_app, upstream)
    client.get(
        "/projects",
        headers={"x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-canvas-client-ip": "6.6.6.6"},
    )
    assert upstream.last.headers.get_list("x-canvas-client-ip") == ["203.0.113.9"]
    assert upstream.last.headers["x-forwarded-for"] == "6.6.6.6, 203.0.113.9"
    # No X-Forwarded-For: the connection's address, still not the client's own header.
    client.get("/projects", headers={"x-canvas-client-ip": "6.6.6.6"})
    assert upstream.last.headers.get_list("x-canvas-client-ip") == ["testclient"]


def test_a_trusted_address_header_is_the_address_passed_on(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    client = make_app(
        upstream.transport,
        typescript_api_url_setting=TS_URL,
        typescript_route_groups_setting="projects",
        trust_client_ip_header_setting="true",
    )
    client.get("/projects", headers={"x-canvas-client-ip": "10.1.1.1", "x-forwarded-for": "203.0.113.9"})
    # Trusted means this service believes ITS front door; the header is then the address it worked out.
    assert upstream.last.headers.get_list("x-canvas-client-ip") == ["10.1.1.1"]


def test_status_body_and_every_set_cookie_come_back_unchanged(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    upstream.respond = lambda r: httpx.Response(
        418,
        content=b"\x00binary\xff",
        headers=[
            ("content-type", "application/x-weird"),
            ("set-cookie", "cid=abc; Path=/; HttpOnly; SameSite=Lax"),
            ("set-cookie", "csrf=def; Path=/; Max-Age=60"),
            ("x-upstream", "yes"),
        ],
    )
    response = forwarding(make_app, upstream).get("/projects")
    assert response.status_code == 418
    assert response.content == b"\x00binary\xff"
    assert response.headers["content-type"] == "application/x-weird"
    assert response.headers["x-upstream"] == "yes"
    assert response.headers.get_list("set-cookie") == [
        "cid=abc; Path=/; HttpOnly; SameSite=Lax",
        "csrf=def; Path=/; Max-Age=60",
    ]
    assert_secured(response)


def test_an_upstream_404_or_redirect_is_passed_on_as_it_is(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    client = forwarding(make_app, upstream)
    upstream.respond = lambda r: httpx.Response(404, json={"error": "No project with id x"})
    missing = client.get("/projects/x")
    assert missing.status_code == 404
    assert missing.json() == {"error": "No project with id x"}
    upstream.respond = lambda r: httpx.Response(302, headers={"location": "https://login.example/start"})
    redirected = client.get("/projects", follow_redirects=False)
    assert redirected.status_code == 302
    assert redirected.headers["location"] == "https://login.example/start"


def test_a_route_in_another_group_is_answered_by_python(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    client = forwarding(make_app, upstream, "projects")
    # diagram-types is a Python route; signed out, its own 401.
    assert client.get("/diagram-types").status_code == 401
    assert client.get("/health").json() == {"status": "ok"}
    assert upstream.requests == []


def test_several_groups_are_forwarded(make_app: Callable[..., TestClient], upstream: Upstream) -> None:
    client = forwarding(make_app, upstream, " projects , diagram-types ")
    client.get("/projects")
    client.get("/diagram-types")
    client.get("/libraries")
    assert [r.url.path for r in upstream.requests] == ["/projects", "/diagram-types"]


def test_head_is_forwarded_like_get(make_app: Callable[..., TestClient], upstream: Upstream) -> None:
    forwarding(make_app, upstream).head("/projects")
    assert upstream.last.method == "HEAD"


def test_a_method_the_group_does_not_have_is_not_forwarded(
    make_app: Callable[..., TestClient], upstream: Upstream
) -> None:
    forwarding(make_app, upstream).request("PUT", "/projects")
    assert upstream.requests == []


@pytest.mark.parametrize("path", ["/docs", "/docs/", "/docs/json", "/docs/static/index.css"])
def test_the_api_docs_are_always_forwarded_when_typescript_is_configured(
    make_app: Callable[..., TestClient], upstream: Upstream, path: str
) -> None:
    upstream.respond = lambda r: httpx.Response(200, text="docs")
    for groups in (None, "none", "projects"):
        upstream.requests.clear()
        response = forwarding(make_app, upstream, groups).get(path)
        assert response.text == "docs"
        assert upstream.last.url.path == path


def test_only_the_docs_prefix_is_forwarded(make_app: Callable[..., TestClient], upstream: Upstream) -> None:
    client = forwarding(make_app, upstream, None)
    assert client.get("/documents").status_code == 404
    assert client.get("/docsx").status_code == 404
    assert upstream.requests == []


def test_nothing_is_forwarded_without_a_typescript_url(make_app: Callable[..., TestClient], upstream: Upstream) -> None:
    client = make_app(upstream.transport)
    assert client.app.state.typescript_forwarder is None  # type: ignore[attr-defined]
    client.get("/docs")
    client.get("/projects")
    assert upstream.requests == []
    assert client.get("/docs").json() == fastify_404("GET", "/docs")


def test_the_web_app_never_hides_a_forwarded_route(
    make_app: Callable[..., TestClient], upstream: Upstream, dist: Path
) -> None:
    (dist / "projects").write_text("shadow", encoding="utf-8")
    upstream.respond = lambda r: httpx.Response(200, text="from typescript")
    client = make_app(
        upstream.transport,
        web_dist_dir=str(dist),
        typescript_api_url_setting=TS_URL,
        typescript_route_groups_setting="projects",
    )
    assert client.get("/projects").text == "from typescript"
    assert client.get("/").text == "<!doctype html><p>index</p>"


# --- match_route -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "group"),
    [
        ("GET", "/projects", "projects"),
        ("POST", "/projects", "projects"),
        ("GET", "/projects/abc", "projects"),
        ("GET", "/projects/abc/tree", "projects"),
        ("GET", "/projects/abc/members", "sharing"),
        ("POST", "/projects/abc/restore", "projects"),
        ("GET", "/admin/libraries/generic/1/icons", "library-admin"),
        ("POST", "/admin/libraries/import-svg", "library-admin"),
        ("PUT", "/admin/libraries/generic/diagram-types", "library-admin"),
        ("POST", "/libraries", "library-admin"),
        ("GET", "/libraries", "libraries"),
        ("GET", "/auth/me", "auth"),
        ("DELETE", "/admin/users/u1", "admin-users"),
    ],
)
def test_match_route_finds_the_routes_group(method: str, path: str, group: str) -> None:
    assert match_route(method, path) == group


def test_match_route_treats_head_as_get() -> None:
    assert match_route("HEAD", "/projects") == "projects"
    assert match_route("HEAD", "/admin/users") == match_route("GET", "/admin/users")
    # Only GET routes: a HEAD of a POST-only route isn't one.
    assert match_route("HEAD", "/admin/libraries/import-svg") is None


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/nope"),
        ("GET", "/"),
        ("GET", "/projects/a/b/c/d"),
        ("DELETE", "/projects"),
        ("PUT", "/health"),
        ("GET", "/projects/"),
        ("get", "/projects"),
    ],
)
def test_match_route_is_none_for_an_unknown_route(method: str, path: str) -> None:
    assert match_route(method, path) is None


def test_match_route_prefers_a_static_segment_to_a_parameter(monkeypatch: pytest.MonkeyPatch) -> None:
    """No two real routes of one method overlap today, so overlapping ones are added to see the rule: where
    find-my-way would take the static segment, so does this."""
    compile_ = front_door._compile
    extra = [
        (group, "GET", *compile_(pattern)) for group, pattern in (("a", "/x/:id"), ("b", "/x/new"), ("c", "/:a/new"))
    ]
    monkeypatch.setattr(front_door, "_ROUTES", [*front_door._ROUTES, *extra])
    assert match_route("GET", "/x/new") == "b"
    assert match_route("GET", "/x/other") == "a"
    assert match_route("GET", "/y/new") == "c"


def test_every_route_group_route_matches_itself() -> None:
    import re

    from canvas_api.front_door.route_groups import ROUTE_GROUPS

    for group, routes in ROUTE_GROUPS.items():
        for route in routes:
            method, pattern = route.split(" ", 1)
            found = match_route(method, re.sub(r":\w+", "abc", pattern))
            assert found is not None, route
            # A route another group also has (POST /libraries is library-admin's, GET /libraries is libraries')
            # never matches the wrong one.
            assert found == group, route


# --- settings ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "  ", "none"])
def test_no_route_groups_when_unset_empty_or_none(settings: Settings, value: str | None) -> None:
    changed = settings.model_copy(update={**BLANK, "typescript_route_groups_setting": value})
    assert changed.typescript_route_groups == []


def test_route_groups_are_a_trimmed_comma_list(settings: Settings) -> None:
    changed = settings.model_copy(
        update={**BLANK, "typescript_api_url_setting": TS_URL, "typescript_route_groups_setting": "auth, ai,,comments "}
    )
    assert changed.typescript_route_groups == ["auth", "ai", "comments"]


def test_an_unknown_group_stops_start_up(settings: Settings, engine: Engine) -> None:
    bad = settings.model_copy(
        update={**BLANK, "typescript_api_url_setting": TS_URL, "typescript_route_groups_setting": "projects,nonsense"}
    )
    with pytest.raises(ValueError, match='unknown group "nonsense"'):
        create_app(bad, engine)


def test_groups_without_a_typescript_url_stop_start_up(settings: Settings, engine: Engine) -> None:
    bad = settings.model_copy(update={**BLANK, "typescript_route_groups_setting": "projects"})
    with pytest.raises(ValueError, match="needs TYPESCRIPT_API_URL"):
        create_app(bad, engine)


@pytest.mark.parametrize("url", ["ts.internal:3000", "ftp://ts.internal", "//ts.internal", "localhost"])
def test_a_typescript_url_that_is_not_http_stops_start_up(settings: Settings, engine: Engine, url: str) -> None:
    bad = settings.model_copy(
        update={**BLANK, "typescript_api_url_setting": url, "typescript_route_groups_setting": "none"}
    )
    with pytest.raises(ValueError, match="must be http:// or https://"):
        create_app(bad, engine)


def test_the_typescript_url_loses_a_trailing_slash_and_blank_means_none(settings: Settings) -> None:
    with_slash = settings.model_copy(update={**BLANK, "typescript_api_url_setting": " http://ts:3000/ "})
    assert with_slash.typescript_api_url == "http://ts:3000"
    assert settings.model_copy(update={**BLANK, "typescript_api_url_setting": "  "}).typescript_api_url is None


def test_the_settings_are_read_from_the_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DATABASE_URL", ":memory:")
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)  # gitleaks:allow
    monkeypatch.setenv("DB_CLIENT", "sqlite")
    monkeypatch.setenv("WEB_DIST_DIR", str(tmp_path))
    monkeypatch.setenv("PAUSED_PAGE_PATH", str(tmp_path / "p.html"))
    monkeypatch.setenv("CANVAS_PAUSED", "true")
    monkeypatch.setenv("TYPESCRIPT_API_URL", TS_URL)
    monkeypatch.setenv("TYPESCRIPT_ROUTE_GROUPS", "auth")
    monkeypatch.setenv("TRUST_CLIENT_IP_HEADER", "true")
    read = Settings()  # type: ignore[call-arg]
    assert read.web_dist_dir == str(tmp_path)
    assert read.paused_page_path == str(tmp_path / "p.html")
    assert read.paused is True
    assert read.typescript_api_url == TS_URL
    assert read.typescript_route_groups == ["auth"]
    assert read.trust_client_ip_header is True


@pytest.mark.parametrize("value", [None, "", "false", "TRUE", "True", "1", "yes"])
def test_paused_and_trust_are_only_the_word_true(settings: Settings, value: str | None) -> None:
    changed = settings.model_copy(update={**BLANK, "paused_setting": value, "trust_client_ip_header_setting": value})
    assert changed.paused is False
    assert changed.trust_client_ip_header is False
    on = settings.model_copy(update={**BLANK, "paused_setting": "true", "trust_client_ip_header_setting": "true"})
    assert on.paused is True
    assert on.trust_client_ip_header is True


# --- the client address for the audit log ------------------------------------------------------------


@pytest.fixture()
def address(make_app: Callable[..., TestClient]) -> Callable[..., str]:
    """The `ip` audit.client_ip works out for a request, via a probe route on a scratch app."""
    from canvas_api.audit import client_ip

    def probe(trust: bool, headers: dict[str, str]) -> str:
        client = make_app(trust_client_ip_header_setting="true" if trust else None)

        @client.app.get("/_probe_ip")  # type: ignore[attr-defined]
        def _probe(request: Request) -> dict[str, str]:
            return {"ip": client_ip(request)}

        return str(client.get("/_probe_ip", headers=headers).json()["ip"])

    return probe


def test_client_ip_ignores_the_front_door_header_unless_trusted(address: Callable[..., str]) -> None:
    headers = {"x-canvas-client-ip": "6.6.6.6", "x-forwarded-for": "5.5.5.5, 203.0.113.9"}
    assert address(False, headers) == "203.0.113.9"
    assert address(False, {"x-canvas-client-ip": "6.6.6.6"}) == "testclient"
    assert address(True, headers) == "6.6.6.6"


def test_client_ip_trusting_the_header_falls_back_when_it_is_missing_or_empty(address: Callable[..., str]) -> None:
    assert address(True, {"x-forwarded-for": "5.5.5.5, 203.0.113.9"}) == "203.0.113.9"
    assert address(True, {"x-canvas-client-ip": "", "x-forwarded-for": "203.0.113.9"}) == "203.0.113.9"
    assert address(True, {}) == "testclient"


def test_client_ip_is_the_last_forwarded_for_entry_else_the_connection(address: Callable[..., str]) -> None:
    assert address(False, {"x-forwarded-for": "1.1.1.1, 2.2.2.2 ,  3.3.3.3  "}) == "3.3.3.3"
    assert address(False, {"x-forwarded-for": "9.9.9.9"}) == "9.9.9.9"
    assert address(False, {"x-forwarded-for": " , "}) == "testclient"
    assert address(False, {}) == "testclient"


def test_client_ip_reaches_the_audit_log(make_app: Callable[..., TestClient], engine: Engine) -> None:
    """The route-level effect: an admin action's audit row carries the forwarded address."""
    api = Api(make_app(), engine)
    admin = api.user("admin@example.com", role="admin")
    response = api.call(
        "PATCH",
        "/admin/app-settings",
        admin,
        json={"sharingEnabled": True},
        headers={"x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-canvas-client-ip": "7.7.7.7"},
    )
    assert response.status_code == 200
    assert api.scalar("SELECT ip FROM audit_events WHERE event = 'app_setting_changed'") == "203.0.113.9"
