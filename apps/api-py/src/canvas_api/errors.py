"""Errors in the TypeScript service's JSON shape: {"error": message, "code"?: code}."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, error: str, code: str | None = None, details: Any = None) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.code = code
        #: Extra data some errors carry: a parse error list, a save conflict's current version.
        self.details = details


def _describe(error: Mapping[str, Any]) -> str:
    """One validation error, worded like Fastify's ("body/name must ...")."""
    # Fastify names the query string "querystring".
    loc = ["querystring" if part == "query" else str(part) for part in error.get("loc", ())]
    where = "/".join(loc) if loc else "body"
    return f"{where} {error.get('msg', 'is invalid')}"


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        body: dict[str, Any] = {"error": exc.error}
        if exc.code:
            body["code"] = exc.code
        if exc.details is not None:
            body["details"] = exc.details
        return JSONResponse(body, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Fastify answers a request that fails its schema with 400 (FastAPI's default is 422).
        errors = exc.errors()
        message = _describe(errors[0]) if errors else "Invalid request"
        return JSONResponse({"error": message}, status_code=400)
