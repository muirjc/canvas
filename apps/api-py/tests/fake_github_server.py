"""The in-memory fake GitHub (tests/fake_github.py) as a standalone HTTP server, for the Playwright suite
(apps/web/tests/e2e/github-approval.spec.ts), which runs the real web app and API against it. A port of
apps/api/tests/helpers/fake-github-server.ts. Test code: it lives under tests/, so it never ships in the
canvas_api package or the image.

    cd apps/api-py && uv run python -m tests.fake_github_server [keyFile]

Env: FAKE_GITHUB_PORT (default 3999; 0 = any free port), FAKE_GITHUB_KEY_FILE (or the first argument; default
./fake-github.key) -- where the App's private key is written, base64 of the PEM on one line, ready to be the
API's GITHUB_APP_PRIVATE_KEY. Start the API with GITHUB_APP_ID=12345, GITHUB_APP_PRIVATE_KEY=$(cat <keyFile>),
GITHUB_APP_API_URL=http://127.0.0.1:<port>. Listens on 127.0.0.1 only.

Seeds one installation (account canvas-e2e, allowed to read checks and statuses) with one repository,
canvas-e2e/architecture (default branch main). Test control, all under /_fake/ (never part of GitHub's API;
answered before any auth or recording; 200 with JSON, or 400 {message}):
  GET  /_fake/pulls                  -> {pulls: [{number, state, merged, head, reviews: [{login, state}]}]}
  GET  /_fake/files?branch=<name>    -> {files: {path: content}} on that branch (default: the default branch)
  POST /_fake/pulls/:n/reviews       {login, state}
  POST /_fake/pulls/:n/check-runs    {name, status?, conclusion?}  (set on the PR's current head)
  POST /_fake/pulls/:n/merge         {by?}
  POST /_fake/pulls/:n/close
"""

from __future__ import annotations

import base64
import json
import os
import re
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

from tests.fake_github import FakeGitHub, FakeRepo

_CONTROL_POST = re.compile(r"/_fake/pulls/(\d+)/(reviews|check-runs|merge|close)")


class ControlError(Exception):
    pass


def control(fake: FakeGitHub, repo: FakeRepo, method: str, target: str, body: Any) -> Any:
    """One /_fake/ request: the answer, or ControlError (400)."""
    parts = urlsplit(target)
    path = parts.path
    b: dict[str, Any] = body if isinstance(body, dict) else {}
    if method == "GET" and path == "/_fake/pulls":
        return {
            "pulls": [
                {
                    "number": p.number,
                    "state": p.state,
                    "merged": p.merged,
                    "head": p.head,
                    "reviews": [{"login": r.login, "state": r.state} for r in p.reviews],
                }
                for p in repo.pulls.values()
            ]
        }
    if method == "GET" and path == "/_fake/files":
        branch = parse_qs(parts.query).get("branch", [repo.default_branch])[0]
        files = fake.files(repo, branch)
        if files is None:
            raise ControlError("no such branch")
        return {"files": dict(files)}
    if method == "POST" and (m := _CONTROL_POST.fullmatch(path)):
        number, action = int(m[1]), m[2]
        try:
            pull = fake.pull(repo, number)
        except KeyError as error:
            raise ControlError(str(error.args[0])) from error
        if action == "reviews":
            fake.add_review(repo, number, str(b.get("login")), str(b.get("state")))
        elif action == "check-runs":
            head = fake.head_of(repo, pull.head)
            run = {
                "name": str(b.get("name")),
                "status": b.get("status") or "completed",
                "conclusion": b.get("conclusion") or "success",
            }
            others = [r for r in repo.check_runs.get(head, []) if r["name"] != run["name"]]
            fake.set_check_runs(repo, head, [*others, run])
        elif action == "merge":
            by = b.get("by")
            if isinstance(by, str):
                fake.merge_pull(repo, number, by=by)
            else:
                fake.merge_pull(repo, number)
        else:
            fake.close_pull(repo, number)
        return {"ok": True}
    raise ControlError(f"no control route for {method} {path}")


def make_server(fake: FakeGitHub, repo: FakeRepo, port: int) -> ThreadingHTTPServer:
    """The HTTP server in front of `fake`, bound to 127.0.0.1:<port>; sets fake.url to its address."""
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, content: bytes, headers: dict[str, str]) -> None:
            self.send_response(status)
            for name, value in headers.items():
                if name.lower() not in ("content-length", "transfer-encoding", "connection"):
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if self.path.startswith("/_fake/"):
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                try:
                    with lock:
                        out = control(fake, repo, self.command, self.path, body)
                    status, payload = 200, out if out is not None else {}
                except Exception as error:  # ControlError, or a bad request the fake couldn't follow
                    status, payload = 400, {"message": str(error)}
                self._send(status, json.dumps(payload).encode(), {"Content-Type": "application/json"})
                return
            request = httpx.Request(
                self.command,
                fake.url + self.path,
                headers=[(k, v) for k, v in self.headers.items() if k.lower() != "host"],
                content=raw,
            )
            with lock:
                response = fake.handle(request)
            self._send(response.status_code, response.content, dict(response.headers))

        do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _handle

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write(f"fake-github: {format % args}\n")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    return server


def seeded() -> tuple[FakeGitHub, FakeRepo]:
    """The fake with the e2e suite's installation and repository."""
    fake = FakeGitHub()
    installation = fake.add_installation(account="canvas-e2e")
    fake.grant_checks(installation.id)
    repo = fake.add_repo(installation.id, name="architecture", default_branch="main")
    return fake, repo


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    port = int(os.environ.get("FAKE_GITHUB_PORT", "3999"))
    key_file = Path(args[0] if args else os.environ.get("FAKE_GITHUB_KEY_FILE", "./fake-github.key"))
    fake, repo = seeded()
    server = make_server(fake, repo, port)
    key_file.write_text(base64.b64encode(fake.private_key_pem().encode()).decode())
    print(f"fake-github ready on {fake.url} (app id {fake.app_id}, key in {key_file})", flush=True)

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
