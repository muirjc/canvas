"""This service as the front door (phase 10, canvas-1bty.14): browsers reach it at the public address, and it
does what apps/api did there (apps/api/src/app.ts, web/web-app.ts, python/front-door.ts):

- serves the built web app (WEB_DIST_DIR) from the same origin: only files that exist at start-up, so nothing
  here shadows an API route; hashed /assets/* cached for a year, everything else (index.html included)
  revalidated; the Brotli/gzip copies made at build time served when the browser accepts them;
- while the environment is paused (CANVAS_PAUSED=true, the database is stopped) answers the paused page to
  browsers and a 503 to API calls, /health excepted;
- allows credentialed cross-origin calls from WEB_ORIGINS only (the Vite dev server; @fastify/cors's rules);
- sends a route group named in TYPESCRIPT_ROUTE_GROUPS -- the one-release fallback -- and /docs to the
  internal TypeScript service (TYPESCRIPT_API_URL), body and Set-Cookie headers passed through unchanged;
- answers an unknown route with Fastify's 404 body, as before.
"""

from __future__ import annotations

import mimetypes
import os
import re
from collections.abc import AsyncIterator
from email.utils import formatdate
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

from canvas_api.audit import client_ip
from canvas_api.config import Settings
from canvas_api.front_door.route_groups import ROUTE_GROUPS

__all__ = ["install", "match_route"]

_DEFAULT_PAUSED_PAGE = "<!doctype html><title>Canvas is paused</title><p>Canvas is paused.</p>"
#: Headers that describe one connection, not the request (RFC 9110 §7.6.1), plus Host.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
}
#: Prefixes sent to TypeScript whole whenever it's configured: the OpenAPI page (ENABLE_API_DOCS there).
_TYPESCRIPT_PREFIXES = ("/docs",)


# --- which route a request is ----------------------------------------------------------------------


def _compile(pattern: str) -> tuple[re.Pattern[str], tuple[int, ...]]:
    """A Fastify route pattern ("/projects/:id") as a regex, and its specificity: per segment, 0 when static
    and 1 for a parameter (find-my-way prefers a static segment where two routes differ)."""
    segments = pattern.strip("/").split("/") if pattern != "/" else []
    regex = "^/" + "/".join("[^/]+" if s.startswith(":") else re.escape(s) for s in segments) + "$"
    return re.compile(regex), tuple(1 if s.startswith(":") else 0 for s in segments)


_ROUTES = [
    (group, method, *_compile(path))
    for group, routes in ROUTE_GROUPS.items()
    for method, path in (route.split(" ", 1) for route in routes)
]


def match_route(method: str, path: str) -> str | None:
    """The group of the route a request is, as Fastify would match it; None for none."""
    method = "GET" if method == "HEAD" else method
    matches = [(rank, group) for group, m, regex, rank in _ROUTES if m == method and regex.match(path)]
    return min(matches)[1] if matches else None


# --- the web app ---------------------------------------------------------------------------------


class WebApp:
    """The built web app's files, found once at start-up."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.files: dict[str, Path] = {}
        for path in self.root.rglob("*"):
            relative = path.relative_to(self.root)
            # Only a hidden name INSIDE the dist is refused (the dist itself may sit under ~/.cache or the like).
            if not path.is_file() or path.suffix in (".br", ".gz") or any(p.startswith(".") for p in relative.parts):
                continue
            url = "/" + path.relative_to(self.root).as_posix()
            self.files[url] = path
        if "/index.html" in self.files:
            self.files["/"] = self.files["/index.html"]

    def response(self, request: Request) -> Response | None:
        path = self.files.get(request.url.path)
        if path is None:
            return None
        immutable = path.is_relative_to(self.root / "assets")
        stat = path.stat()
        etag = f'W/"{stat.st_size:x}-{int(stat.st_mtime * 1000):x}"'
        headers = {
            "Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache",
            "ETag": etag,
            "Last-Modified": formatdate(stat.st_mtime, usegmt=True),
            "Vary": "Accept-Encoding",
        }
        if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
            return Response(status_code=304, headers=headers)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "image/svg+xml"):
            content_type += "; charset=utf-8"
        accepted = request.headers.get("accept-encoding", "")
        body_path = path
        for encoding, suffix in (("br", ".br"), ("gzip", ".gz")):
            candidate = path.with_name(path.name + suffix)
            if encoding in accepted and candidate.is_file():
                headers["Content-Encoding"] = encoding
                body_path = candidate
                break
        body = b"" if request.method == "HEAD" else body_path.read_bytes()
        headers["Content-Length"] = str(body_path.stat().st_size)
        return Response(body, headers=headers, media_type=content_type)


# --- forwarding to TypeScript ----------------------------------------------------------------------


class TypeScriptForwarder:
    def __init__(self, base_url: str, groups: list[str], transport: httpx.AsyncBaseTransport | None) -> None:
        self.groups = set(groups)
        self.client = httpx.AsyncClient(base_url=base_url, transport=transport, timeout=120, follow_redirects=False)

    def wants(self, request: Request) -> bool:
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in _TYPESCRIPT_PREFIXES):
            return True
        group = match_route(request.method, path)
        return group is not None and group in self.groups

    async def forward(self, request: Request) -> Response:
        headers = [(k, v) for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP]
        headers = [
            (k, v)
            for k, v in headers
            if k.lower() not in ("x-forwarded-host", "x-forwarded-proto", "x-canvas-client-ip")
        ]
        headers += [
            ("x-forwarded-host", request.headers.get("host", "")),
            ("x-forwarded-proto", request.headers.get("x-forwarded-proto", request.url.scheme)),
            # The address worked out here; the TypeScript service behind reads it (TRUST_CLIENT_IP_HEADER).
            ("x-canvas-client-ip", client_ip(request)),
        ]
        body = await request.body()
        upstream = self.client.build_request(
            request.method, request.url.path, params=request.url.query or None, headers=headers, content=body
        )
        response = await self.client.send(upstream, stream=True)

        async def stream() -> AsyncIterator[bytes]:
            try:
                if response.is_stream_consumed:  # an in-process test transport has read it already
                    yield response.content
                else:
                    async for chunk in response.aiter_raw():
                        yield chunk
            finally:
                await response.aclose()

        out = StreamingResponse(stream(), status_code=response.status_code)
        out.raw_headers = [
            (k.encode("latin-1"), v.encode("latin-1"))
            for k, v in response.headers.multi_items()
            if k.lower() not in _HOP_BY_HOP
        ]
        return out

    async def close(self) -> None:
        await self.client.aclose()


# --- wiring ----------------------------------------------------------------------------------------


def _fastify_not_found(request: Request) -> Response:
    """Fastify's own 404 body, which the web app and scripts have always seen for an unknown route."""
    return JSONResponse(
        {"message": f"Route {request.method}:{request.url.path} not found", "error": "Not Found", "statusCode": 404},
        status_code=404,
    )


def install(app: FastAPI, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
    """Adds the front door's jobs to `app`. Call after every route is registered."""
    web = WebApp(Path(settings.web_dist_dir)) if settings.web_dist_dir else None
    if web is not None and "/" not in web.files:
        web = None
    forwarder = (
        TypeScriptForwarder(settings.typescript_api_url, settings.typescript_route_groups, transport)
        if settings.typescript_api_url
        else None
    )
    app.state.typescript_forwarder = forwarder
    paused_page = _DEFAULT_PAUSED_PAGE
    if settings.paused_page_path and os.path.isfile(settings.paused_page_path):
        # PAUSED_PAGE_PATH is operator configuration (the image sets it), read once at start-up: nothing
        # from a request reaches this path.
        # bearer:disable python_lang_path_traversal
        paused_page = Path(settings.paused_page_path).read_text(encoding="utf-8")

    class FrontDoor(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
            if settings.paused and request.url.path != "/health":
                headers = {"Cache-Control": "no-store", "Retry-After": "3600"}
                if request.method == "GET" and "text/html" in request.headers.get("accept", ""):
                    return Response(
                        paused_page, status_code=503, headers=headers, media_type="text/html; charset=utf-8"
                    )
                return JSONResponse(
                    {"error": "Canvas is paused. Ask your admin to resume it."}, status_code=503, headers=headers
                )
            if forwarder is not None and forwarder.wants(request):
                return await forwarder.forward(request)
            response = await call_next(request)
            if response.status_code in (404, 405) and request.method in ("GET", "HEAD"):
                served = web.response(request) if web is not None else None
                if served is not None:
                    return served
            if response.status_code == 405 or (response.status_code == 404 and _is_unmatched(request)):
                return _fastify_not_found(request)
            return response

    def _is_unmatched(request: Request) -> bool:
        """A 404 because no route matched (not one a route returned, e.g. "No project with id ...")."""
        return request.scope.get("endpoint") is None

    app.add_middleware(FrontDoor)
    # Outermost, so preflights and error responses carry the CORS headers too.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.web_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
        allow_headers=["*"],
    )
