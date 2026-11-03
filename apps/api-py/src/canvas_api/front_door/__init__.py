"""This service as the front door (phase 10, canvas-1bty.14): browsers reach it at the public address, and it
does what the TypeScript API's front door did (tag typescript-api-final):

- serves the built web app (WEB_DIST_DIR) from the same origin: only files that exist at start-up, so nothing
  here shadows an API route; hashed /assets/* cached for a year, everything else (index.html included)
  revalidated; the Brotli/gzip copies made at build time served when the browser accepts them;
- while the environment is paused (CANVAS_PAUSED=true, the database is stopped) answers the paused page to
  browsers and a 503 to API calls, /health excepted;
- allows credentialed cross-origin calls from WEB_ORIGINS only (the Vite dev server; @fastify/cors's rules);
- answers an unknown route with Fastify's 404 body, as before.
"""

from __future__ import annotations

import mimetypes
import os
from email.utils import formatdate
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.middleware.cors import CORSMiddleware

from canvas_api.config import Settings

__all__ = ["install"]

_DEFAULT_PAUSED_PAGE = "<!doctype html><title>Canvas is paused</title><p>Canvas is paused.</p>"
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


# --- wiring ----------------------------------------------------------------------------------------


def _fastify_not_found(request: Request) -> Response:
    """Fastify's own 404 body, which the web app and scripts have always seen for an unknown route."""
    return JSONResponse(
        {"message": f"Route {request.method}:{request.url.path} not found", "error": "Not Found", "statusCode": 404},
        status_code=404,
    )


def install(app: FastAPI, settings: Settings) -> None:
    """Adds the front door's jobs to `app`. Call after every route is registered."""
    web = WebApp(Path(settings.web_dist_dir)) if settings.web_dist_dir else None
    if web is not None and "/" not in web.files:
        web = None
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
