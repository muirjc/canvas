"""Helpers for the sign-in tests (canvas-1bty.13): an app per set of sign-in settings, requests that carry one
session cookie at a time, and seeded accounts with real passwords. Every response is held to the API contract."""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from canvas_api.app import create_app
from canvas_api.auth.passwords import hash_password
from canvas_api.config import Settings
from tests.api import Api, check_contract


def seed_user(engine: Engine, email: str, password: str, role: str = "architect", name: str | None = None) -> str:
    """A user with a Canvas password (apps/api tests/helpers/setup.ts seedUser)."""
    user_id = str(uuid4())
    password_hash, salt = hash_password(password)
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO users (id, name, email, role) VALUES (:id, :name, :email, :role)"),
            {"id": user_id, "name": name or email, "email": email, "role": role},
        )
        conn.execute(
            text("INSERT INTO local_credentials (user_id, password_hash, password_salt) VALUES (:id, :h, :s)"),
            {"id": user_id, "h": password_hash, "s": salt},
        )
    return user_id


def session_cookie(response: httpx.Response) -> str | None:
    """The `cid=...` pair a response sets, ready to send back; None when it sets none."""
    for header in response.headers.get_list("set-cookie"):
        if header.startswith("cid="):
            return header.split(";")[0]
    return None


def set_cookie_header(response: httpx.Response) -> str | None:
    return next((h for h in response.headers.get_list("set-cookie") if h.startswith("cid=")), None)


class Site:
    """One app (create_app) and a client for it; requests are explicit about the cookie they carry."""

    def __init__(self, settings: Settings, engine: Engine, oidc_transport: httpx.BaseTransport | None = None) -> None:
        self.settings = settings
        self.engine = engine
        self.app = create_app(settings, engine, oidc_transport=oidc_transport)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.api = Api(self.client, engine)

    def close(self) -> None:
        self.client.__exit__(None, None, None)

    def request(
        self,
        method: str,
        url: str,
        cookie: str | None = None,
        json: Any = None,
        headers: dict[str, str] | None = None,
        *,
        absent: bool = False,
    ) -> httpx.Response:
        """One request carrying `cookie` ("cid=...", as login() returns it) or none; checked against the contract.
        `absent`: the route isn't registered in this configuration (TypeScript: Fastify's own 404, which the
        contract can't describe), so the answer must be a plain 404 instead."""
        self.client.cookies.clear()
        merged = dict(headers or {})
        if cookie:
            merged["cookie"] = cookie
        kwargs: dict[str, Any] = {"headers": merged, "follow_redirects": False}
        if json is not None:
            kwargs["json"] = json
        response = self.client.request(method, url, **kwargs)
        if absent:
            assert response.status_code == 404, f"{method} {url} should not exist here: {response.status_code}"
        else:
            check_contract(response)
        return response

    def get(
        self, url: str, cookie: str | None = None, headers: dict[str, str] | None = None, *, absent: bool = False
    ) -> httpx.Response:
        return self.request("GET", url, cookie, headers=headers, absent=absent)

    def post(self, url: str, json: Any = None, cookie: str | None = None, *, absent: bool = False) -> httpx.Response:
        return self.request("POST", url, cookie, json, absent=absent)

    def login(
        self,
        email: str,
        password: str,
        headers: dict[str, str] | None = None,
        cookie: str | None = None,
        *,
        absent: bool = False,
    ) -> tuple[httpx.Response, str]:
        """POST /auth/local/login; the response and the session cookie it set ("" when none)."""
        response = self.request(
            "POST", "/auth/local/login", cookie, {"email": email, "password": password}, headers=headers, absent=absent
        )
        return response, session_cookie(response) or ""

    def user_id(self, email: str) -> str:
        return str(self.api.scalar("SELECT id FROM users WHERE email = :e", e=email))

    def audit(self, admin_cookie: str, query: str = "") -> list[dict[str, Any]]:
        response = self.get(f"/admin/audit{query}", admin_cookie)
        assert response.status_code == 200, response.text
        events: list[dict[str, Any]] = response.json()["events"]
        return events


OTP_FORMAT = re.compile(r"^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$")
