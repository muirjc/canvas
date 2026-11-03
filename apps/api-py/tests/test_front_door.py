"""This service as the front door (phase 10 part 2, canvas-1bty.14): the web app, paused mode, CORS, security
headers, the API docs page, the settings behind them, and the audit client address. The behaviours are those
of the TypeScript API's front door (tag typescript-api-final).

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

from canvas_api.app import create_app
from canvas_api.config import Settings
from tests.api import Api

FRONT_DOOR_ENV = (
    "WEB_DIST_DIR",
    "PAUSED_PAGE_PATH",
    "CANVAS_PAUSED",
    "ENABLE_API_DOCS",
    "WEB_ORIGINS",
)
BLANK: dict[str, Any] = {
    "web_dist_dir": None,
    "paused_page_path": None,
    "paused_setting": None,
    "enable_api_docs_setting": None,
    "web_origins": "http://localhost:5173",
}
SECURITY = {"x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin"}
GZ_BODY = gzip.compress(b"console.log(1)")


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in FRONT_DOOR_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture()
def make_app(settings: Settings, engine: Engine) -> Iterator[Callable[..., TestClient]]:
    """`make_app(web_dist_dir=..., paused_setting="true")`: an app over the clean
    database with these front-door settings (field names of Settings) and nothing else set."""
    from tests.api import reset

    reset(engine)
    opened: list[TestClient] = []

    def make(**changes: Any) -> TestClient:
        app_settings = settings.model_copy(update={**BLANK, **changes})
        client = TestClient(create_app(app_settings, engine))
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


# --- the API docs page ------------------------------------------------------------------------------


def test_there_is_no_docs_page_or_openapi_document_by_default(make_app: Callable[..., TestClient]) -> None:
    client = make_app()
    for path in ("/docs", "/openapi.json", "/redoc"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json() == fastify_404("GET", path)


def test_enable_api_docs_serves_fastapis_page_and_document(make_app: Callable[..., TestClient]) -> None:
    client = make_app(enable_api_docs_setting="true")
    page = client.get("/docs")
    assert page.status_code == 200
    assert "swagger-ui" in page.text
    assert_secured(page)
    document = client.get("/openapi.json").json()
    assert document["info"]["title"] == "Canvas API"
    assert "/health" in document["paths"]
    assert client.get("/redoc").status_code == 404


# --- settings ----------------------------------------------------------------------------------------


def test_the_settings_are_read_from_the_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DATABASE_URL", ":memory:")
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)  # gitleaks:allow
    monkeypatch.setenv("DB_CLIENT", "sqlite")
    monkeypatch.setenv("WEB_DIST_DIR", str(tmp_path))
    monkeypatch.setenv("PAUSED_PAGE_PATH", str(tmp_path / "p.html"))
    monkeypatch.setenv("CANVAS_PAUSED", "true")
    monkeypatch.setenv("ENABLE_API_DOCS", "true")
    read = Settings()  # type: ignore[call-arg]
    assert read.web_dist_dir == str(tmp_path)
    assert read.paused_page_path == str(tmp_path / "p.html")
    assert read.paused is True
    assert read.enable_api_docs is True


@pytest.mark.parametrize("value", [None, "", "false", "TRUE", "True", "1", "yes"])
def test_paused_and_api_docs_are_only_the_word_true(settings: Settings, value: str | None) -> None:
    changed = settings.model_copy(update={**BLANK, "paused_setting": value, "enable_api_docs_setting": value})
    assert changed.paused is False
    assert changed.enable_api_docs is False
    on = settings.model_copy(update={**BLANK, "paused_setting": "true", "enable_api_docs_setting": "true"})
    assert on.paused is True
    assert on.enable_api_docs is True


# --- the client address for the audit log ------------------------------------------------------------


@pytest.fixture()
def address(make_app: Callable[..., TestClient]) -> Callable[..., str]:
    """The `ip` audit.client_ip works out for a request, via a probe route on a scratch app."""
    from canvas_api.audit import client_ip

    def probe(headers: dict[str, str]) -> str:
        client = make_app()

        @client.app.get("/_probe_ip")  # type: ignore[attr-defined]
        def _probe(request: Request) -> dict[str, str]:
            return {"ip": client_ip(request)}

        return str(client.get("/_probe_ip", headers=headers).json()["ip"])

    return probe


def test_client_ip_ignores_a_client_sent_address_header(address: Callable[..., str]) -> None:
    """X-Canvas-Client-IP came from the TypeScript front door; a client sending it changes nothing."""
    assert address({"x-canvas-client-ip": "6.6.6.6", "x-forwarded-for": "5.5.5.5, 203.0.113.9"}) == "203.0.113.9"
    assert address({"x-canvas-client-ip": "6.6.6.6"}) == "testclient"


def test_client_ip_is_the_last_forwarded_for_entry_else_the_connection(address: Callable[..., str]) -> None:
    assert address({"x-forwarded-for": "1.1.1.1, 2.2.2.2 ,  3.3.3.3  "}) == "3.3.3.3"
    assert address({"x-forwarded-for": "9.9.9.9"}) == "9.9.9.9"
    assert address({"x-forwarded-for": " , "}) == "testclient"
    assert address({}) == "testclient"


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
