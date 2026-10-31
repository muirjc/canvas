"""Errors in the TypeScript service's JSON shape: {"error": message, "code"?: code}."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, error: str, code: str | None = None) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.code = code


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        body: dict[str, str] = {"error": exc.error}
        if exc.code:
            body["code"] = exc.code
        return JSONResponse(body, status_code=exc.status)
