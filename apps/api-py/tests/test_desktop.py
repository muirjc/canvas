"""The desktop launcher (canvas_api/desktop.py, canvas-xl3a.1): settings, environment, first-run preparation and the
start / status / stop life cycle, the last run as real subprocesses on a data folder of their own."""

from __future__ import annotations

import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from canvas_api import desktop

API_ROOT = Path(__file__).resolve().parents[1]
FIRST_ADMIN = {"email": "owner@example.com", "password": "a-long-first-password"}
#: Environment a Canvas setting could come from; a launched Canvas must get only what the launcher gives it.
LEAKY = ("DATABASE_URL", "DB_CLIENT", "SESSION_SECRET", "AUTH_MODE", "MFA_REQUIRED", "WEB_DIST_DIR", "CANVAS_WEB_DIR")


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


# --- settings --------------------------------------------------------------------------------------


def test_data_dir_prefers_canvas_data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CANVAS_DATA_DIR", str(tmp_path / "mine"))
    assert desktop.data_dir() == tmp_path / "mine"


@pytest.mark.skipif(os.name == "nt", reason="XDG paths are the non-Windows default")
def test_data_dir_follows_xdg_then_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CANVAS_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert desktop.data_dir() == tmp_path / "xdg" / "canvas"
    monkeypatch.delenv("XDG_DATA_HOME")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    assert desktop.data_dir() == tmp_path / "home" / ".local" / "share" / "canvas"


def test_settings_are_created_once_and_stay_the_same(tmp_path: Path) -> None:
    first = desktop.load_settings(tmp_path)
    assert (tmp_path / "settings.json").exists()
    assert first["port"] == 3888
    assert first["env"] == {}
    assert len(first["sessionSecret"]) >= 32
    assert len(base64.b64decode(first["mfaEncryptionKey"], validate=True)) == 32
    assert desktop.load_settings(tmp_path) == first
    assert json.loads((tmp_path / "settings.json").read_text()) == first


def test_missing_settings_are_filled_in_and_the_rest_kept(tmp_path: Path) -> None:
    (tmp_path / "settings.json").write_text(json.dumps({"port": 4123, "sessionSecret": "kept-secret"}))
    settings = desktop.load_settings(tmp_path)
    assert settings["port"] == 4123
    assert settings["sessionSecret"] == "kept-secret"
    assert len(base64.b64decode(settings["mfaEncryptionKey"])) == 32
    assert settings["env"] == {}
    assert json.loads((tmp_path / "settings.json").read_text()) == settings


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_settings_file_is_readable_by_its_owner_only(tmp_path: Path) -> None:
    desktop.load_settings(tmp_path)
    assert (tmp_path / "settings.json").stat().st_mode & 0o777 == 0o600
    desktop.save_settings(tmp_path, {**desktop.load_settings(tmp_path), "port": 4000})
    assert (tmp_path / "settings.json").stat().st_mode & 0o777 == 0o600


# --- environment -----------------------------------------------------------------------------------


def test_app_environment_for_a_local_single_user_install(tmp_path: Path) -> None:
    settings = desktop.load_settings(tmp_path)
    env = desktop.app_environment(tmp_path, settings, 4321)
    assert env["DB_CLIENT"] == "sqlite"
    assert env["DATABASE_URL"] == str(tmp_path / "canvas.db")
    assert env["SESSION_SECRET"] == settings["sessionSecret"]
    assert env["MFA_ENCRYPTION_KEY"] == settings["mfaEncryptionKey"]
    assert env["AUTH_MODE"] == "local"
    assert env["ALLOW_LOCAL_AUTH"] == "true"
    assert env["MFA_REQUIRED"] == "false"
    assert env["WEB_ORIGINS"] == "http://127.0.0.1:4321,http://localhost:4321"


def test_settings_env_overrides_everything_else(tmp_path: Path) -> None:
    settings = {**desktop.load_settings(tmp_path), "env": {"MFA_REQUIRED": "true", "ANTHROPIC_API_KEY": "k", "N": 5}}
    env = desktop.app_environment(tmp_path, settings, 4321)
    assert env["MFA_REQUIRED"] == "true"
    assert env["ANTHROPIC_API_KEY"] == "k"
    assert env["N"] == "5"


def test_web_dist_dir_is_set_only_when_a_built_web_app_is_found(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    settings = desktop.load_settings(tmp_path)
    nowhere = tmp_path / "nowhere"
    monkeypatch.setattr(desktop, "APP_ROOT", nowhere / "app")
    monkeypatch.delenv("CANVAS_WEB_DIR", raising=False)
    assert desktop.web_dir() is None
    assert "WEB_DIST_DIR" not in desktop.app_environment(tmp_path, settings, 3888)

    installed = nowhere / "app" / "web"
    installed.mkdir(parents=True)
    (installed / "index.html").write_text("<html></html>")
    assert desktop.web_dir() == installed
    assert desktop.app_environment(tmp_path, settings, 3888)["WEB_DIST_DIR"] == str(installed)

    explicit = tmp_path / "explicit"
    explicit.mkdir()
    (explicit / "index.html").write_text("<html></html>")
    monkeypatch.setenv("CANVAS_WEB_DIR", str(explicit))
    assert desktop.web_dir() == explicit

    (explicit / "index.html").unlink()  # a folder without index.html doesn't count
    assert desktop.web_dir() == installed


def test_repository_layout_web_dist_is_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    root = tmp_path / "apps" / "api-py"
    (tmp_path / "apps" / "web" / "dist").mkdir(parents=True)
    (tmp_path / "apps" / "web" / "dist" / "index.html").write_text("x")
    monkeypatch.setattr(desktop, "APP_ROOT", root)
    monkeypatch.delenv("CANVAS_WEB_DIR", raising=False)
    assert desktop.web_dir() == tmp_path / "apps" / "web" / "dist"


# --- prepare ---------------------------------------------------------------------------------------


@pytest.fixture(name="prepared")
def prepared_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Path]:
    """A data folder with the environment `start` would set, a version of "1" and a seed that only migrates, counted
    in `prepared / "seed-calls"` (the real catalog seed is covered by the end-to-end test)."""
    import canvas_api.seed as seed
    from canvas_api.migrations import run_migrations

    folder = tmp_path / "data"
    folder.mkdir()
    for name in LEAKY:
        monkeypatch.delenv(name, raising=False)
    for name, value in desktop.app_environment(folder, desktop.load_settings(folder), 3888).items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(desktop, "app_version", lambda: "1")
    calls = folder / "seed-calls"

    def fake_seed(engine: Any, *args: Any, **kwargs: Any) -> None:
        run_migrations(engine)
        calls.write_text(calls.read_text() + "x" if calls.exists() else "x")

    monkeypatch.setattr(seed, "seed_catalog", fake_seed)
    yield folder


def _seed_count(folder: Path) -> int:
    calls = folder / "seed-calls"
    return len(calls.read_text()) if calls.exists() else 0


def _users(folder: Path) -> list[tuple[str, str]]:
    engine = create_engine(f"sqlite:///{folder / 'canvas.db'}")
    try:
        with engine.connect() as conn:
            return [(r.email, r.role) for r in conn.execute(text("SELECT email, role FROM users"))]
    finally:
        engine.dispose()


def test_prepare_seeds_once_then_only_migrates(prepared: Path) -> None:
    desktop.prepare(prepared)
    assert _seed_count(prepared) == 1
    assert (prepared / "catalog-version").read_text() == "1"
    desktop.prepare(prepared)
    assert _seed_count(prepared) == 1


def test_prepare_seeds_again_when_the_version_changes(monkeypatch: pytest.MonkeyPatch, prepared: Path) -> None:
    desktop.prepare(prepared)
    monkeypatch.setattr(desktop, "app_version", lambda: "2")
    desktop.prepare(prepared)
    assert _seed_count(prepared) == 2
    assert (prepared / "catalog-version").read_text() == "2"


def test_prepare_creates_the_first_admin_and_deletes_the_file(prepared: Path) -> None:
    (prepared / "first-admin.json").write_text(json.dumps(FIRST_ADMIN))
    desktop.prepare(prepared)
    assert _users(prepared) == [("owner@example.com", "admin")]
    assert not (prepared / "first-admin.json").exists()


@pytest.mark.parametrize(
    "content",
    [json.dumps({"email": "owner@example.com", "password": "short"}), "{not json", json.dumps({})],
    ids=["password-breaks-policy", "bad-json", "empty-object"],
)
def test_prepare_deletes_first_admin_file_even_when_it_cannot_use_it(
    prepared: Path, content: str, caplog: pytest.LogCaptureFixture
) -> None:
    (prepared / "first-admin.json").write_text(content)
    with caplog.at_level("ERROR", logger="canvas.desktop"):
        desktop.prepare(prepared)
    assert _users(prepared) == []
    assert not (prepared / "first-admin.json").exists()
    assert "The first admin wasn't created" in caplog.text


# --- running it ------------------------------------------------------------------------------------


class Launcher:
    """Runs `python -m canvas_api.desktop` against one data folder."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.servers: list[subprocess.Popen[bytes]] = []
        self.env = {k: v for k, v in os.environ.items() if k not in LEAKY}
        self.env["CANVAS_DATA_DIR"] = str(folder)

    def run(self, *args: str, timeout: float = 60) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - test only
            [sys.executable, "-m", "canvas_api.desktop", *args],
            env=self.env,
            cwd=API_ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def spawn(self) -> subprocess.Popen[bytes]:
        proc = subprocess.Popen(
            [sys.executable, "-m", "canvas_api.desktop", "start", "--no-browser"],
            env=self.env,
            cwd=API_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.servers.append(proc)
        return proc

    def cleanup(self) -> None:
        self.run("stop")
        for proc in self.servers:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=30)


@pytest.fixture(name="launcher")
def launcher_fixture(tmp_path: Path) -> Iterator[Launcher]:
    folder = tmp_path / "canvas-data"
    folder.mkdir()
    launcher = Launcher(folder)
    try:
        yield launcher
    finally:
        launcher.cleanup()


def _get_status(port: int) -> int | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
            return int(response.status)
    except OSError:
        return None


def _wait(condition: Callable[[], bool], what: str, seconds: float = 90) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.25)
    raise AssertionError(f"timed out waiting for {what}")


def _write_settings(folder: Path, port: int) -> None:
    desktop.save_settings(folder, {**desktop.load_settings(folder), "port": port})


def _sign_in(port: int, email: str, password: str) -> dict[str, Any]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/auth/local/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - localhost http
        assert response.status == 200
        body = json.loads(response.read())
    assert isinstance(body, dict)
    return body


def test_start_serves_signs_in_the_first_admin_and_stops(launcher: Launcher) -> None:
    folder = launcher.folder
    port = _free_port()
    _write_settings(folder, port)
    (folder / "first-admin.json").write_text(json.dumps(FIRST_ADMIN))
    assert launcher.run("status").returncode == 1

    server = launcher.spawn()
    _wait(lambda: _get_status(port) == 200, "/health", 120)
    assert json.loads((folder / "canvas.pid").read_text()) == {"pid": server.pid, "port": port}
    assert not (folder / "first-admin.json").exists()
    assert (folder / "canvas.db").exists()
    assert (folder / "catalog-version").read_text() == desktop.app_version()

    body = _sign_in(port, FIRST_ADMIN["email"], FIRST_ADMIN["password"])
    user = body.get("user", body)
    assert user["mustChangePassword"] is True
    assert user["mustEnrollMfa"] is False

    status = launcher.run("status")
    assert status.returncode == 0
    assert str(port) in status.stdout

    # A second start finds the first and leaves it alone.
    started = time.monotonic()
    second = launcher.run("start", "--no-browser", timeout=20)
    assert second.returncode == 0
    assert time.monotonic() - started < 15
    assert server.poll() is None
    assert _get_status(port) == 200
    assert json.loads((folder / "canvas.pid").read_text())["pid"] == server.pid

    stopped = launcher.run("stop")
    assert stopped.returncode == 0
    assert _get_status(port) is None
    assert not (folder / "canvas.pid").exists()
    assert launcher.run("status").returncode == 1
    server.wait(timeout=30)


def test_stop_without_a_pid_file_says_so(launcher: Launcher) -> None:
    result = launcher.run("stop")
    assert result.returncode == 0
    assert "isn't running" in result.stdout


def test_a_stale_pid_file_is_not_a_running_canvas(launcher: Launcher) -> None:
    (launcher.folder / "canvas.pid").write_text(json.dumps({"pid": 999999, "port": _free_port()}))
    assert launcher.run("status").returncode == 1


def test_a_taken_port_is_replaced_and_remembered(launcher: Launcher) -> None:
    taken = _free_port()
    _write_settings(launcher.folder, taken)
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", taken))
        blocker.listen()
        launcher.spawn()
        _wait(lambda: (launcher.folder / "canvas.pid").exists(), "canvas.pid", 120)
        port = json.loads((launcher.folder / "canvas.pid").read_text())["port"]
        assert port != taken
        assert json.loads((launcher.folder / "settings.json").read_text())["port"] == port
        _wait(lambda: _get_status(port) == 200, "/health", 120)
        assert launcher.run("stop").returncode == 0
        assert _get_status(port) is None


# --- reset-admin -------------------------------------------------------------------------------------


def _credentials(folder: Path) -> Any:
    engine = create_engine(f"sqlite:///{folder / 'canvas.db'}")
    try:
        with engine.connect() as conn:
            return conn.execute(
                text(
                    "SELECT c.password_hash, c.password_salt AS salt, c.must_change_password, c.failed_attempts, "
                    "c.locked_at, u.role "
                    "FROM local_credentials c JOIN users u ON u.id = c.user_id"
                )
            ).one()
    finally:
        engine.dispose()


def _answers(*values: str) -> Callable[[str], str]:
    queue = list(values)
    return lambda _prompt: queue.pop(0)


@pytest.fixture
def locked_out(prepared: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The first admin exists, then is locked and demoted, as if they'd lost access."""
    monkeypatch.setenv("CANVAS_DATA_DIR", str(prepared))
    (prepared / "first-admin.json").write_text(json.dumps(FIRST_ADMIN))
    desktop.prepare(prepared)
    engine = create_engine(f"sqlite:///{prepared / 'canvas.db'}")
    with engine.begin() as conn:
        conn.execute(text("UPDATE local_credentials SET failed_attempts = 3, locked_at = '2026-11-01T00:00:00.000Z'"))
        conn.execute(text("UPDATE users SET role = 'viewer'"))
    engine.dispose()
    return prepared


def test_reset_admin_gives_back_admin_with_a_new_temporary_password(
    locked_out: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    from canvas_api.auth.passwords import verify_password

    new = "a-brand-new-temporary-pass"
    code = desktop.reset_admin(ask=_answers(" Owner@Example.com "), ask_secret=_answers(new, new))
    assert code == 0, capsys.readouterr().out
    row = _credentials(locked_out)
    assert verify_password(new, row.password_hash, row.salt)
    assert row.must_change_password
    assert row.failed_attempts == 0 and row.locked_at is None
    assert row.role == "admin"
    assert new not in capsys.readouterr().out


@pytest.mark.parametrize(
    ("email", "passwords", "message"),
    [
        ("owner@example.com", ("short", "short"), "at least 12 characters"),
        ("owner@example.com", ("a-brand-new-temporary-pass", "something-else-entirely"), "don't match"),
        ("nobody@example.com", ("a-brand-new-temporary-pass", "a-brand-new-temporary-pass"), "nothing to reset"),
    ],
    ids=["weak-password", "mismatch", "unknown-email"],
)
def test_reset_admin_refuses_and_changes_nothing(
    locked_out: Path, capsys: pytest.CaptureFixture[str], email: str, passwords: tuple[str, str], message: str
) -> None:
    before = _credentials(locked_out)
    assert desktop.reset_admin(ask=_answers(email), ask_secret=_answers(*passwords)) == 1
    assert message in capsys.readouterr().out
    assert _credentials(locked_out) == before


# --- the health check (Semgrep #181: no urllib, so no URL can choose the scheme or host) --------------


class _Health(http.server.BaseHTTPRequestHandler):
    status = 200

    def do_GET(self) -> None:
        self.send_response(self.status if self.path == "/health" else 404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args: object) -> None:
        pass


def _serve(handler: type[http.server.BaseHTTPRequestHandler]) -> tuple[http.server.HTTPServer, int]:
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, int(server.server_address[1])


def test_healthy_is_a_200_from_health_on_the_loopback() -> None:
    server, port = _serve(_Health)
    try:
        assert desktop.healthy(port)
        _Health.status = 503
        assert not desktop.healthy(port)
    finally:
        _Health.status = 200
        server.shutdown()
        server.server_close()


def test_healthy_is_false_for_nothing_listening_garbage_and_impossible_ports() -> None:
    assert not desktop.healthy(desktop.free_port(), timeout=0.5)

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)

    def garbage() -> None:
        connection, _ = listener.accept()
        with connection:
            connection.recv(1024)
            connection.sendall(b"not http at all\r\n\r\n")

    threading.Thread(target=garbage, daemon=True).start()
    try:
        assert not desktop.healthy(int(listener.getsockname()[1]), timeout=2)
    finally:
        listener.close()

    for port in (0, -1, 65536, 70000):
        assert not desktop.healthy(port)
