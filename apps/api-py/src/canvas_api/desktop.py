"""Canvas as a desktop app for one person on their own PC (canvas-xl3a; the Windows installer's Start-menu entries).

    python -m canvas_api.desktop start [--no-browser]   # or `open`: start if needed, then open the browser
    python -m canvas_api.desktop stop
    python -m canvas_api.desktop status
    python -m canvas_api.desktop reset-admin             # locked out: an admin again, with a new temporary password

Everything lives in one per-user data folder (CANVAS_DATA_DIR, else %LOCALAPPDATA%\\Canvas on Windows,
$XDG_DATA_HOME/canvas elsewhere), kept across upgrades: `settings.json` (secrets and the port, generated once),
the SQLite database, `logs/canvas.log` and, while running, `canvas.pid`. Canvas listens on 127.0.0.1 only and
serves the built web app itself (WEB_DIST_DIR), with Canvas-managed accounts (AUTH_MODE=local).

First run: the installer leaves `first-admin.json` ({"email", "password"}) in the data folder; `start` creates
that admin with the password as a one-time password (changed at first sign-in, bootstrap_admin) and deletes the
file. The diagram catalog is seeded on first run and whenever the installed version changes (upgrades bring new
diagram types); otherwise `start` only applies pending migrations.

Optional features (an AI provider key, ...) go in settings.json's "env" object, as environment variables.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import getpass
import json
import logging
import os
import secrets
import signal
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from collections.abc import Callable
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

#: The installed app's folder: src/canvas_api/desktop.py -> the folder holding src/ and migrations/.
APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 3888
SETTINGS_FILE = "settings.json"
PID_FILE = "canvas.pid"
FIRST_ADMIN_FILE = "first-admin.json"
CATALOG_MARKER = "catalog-version"

log = logging.getLogger("canvas.desktop")


def data_dir() -> Path:
    """The per-user data folder."""
    if os.environ.get("CANVAS_DATA_DIR"):
        return Path(os.environ["CANVAS_DATA_DIR"])
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Canvas"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "canvas"


def app_version() -> str:
    """The installed build's version (the installer writes VERSION next to src/), else "dev"."""
    path = APP_ROOT / "VERSION"
    return path.read_text(encoding="utf-8").strip() if path.exists() else "dev"


def web_dir() -> Path | None:
    """The built web app: CANVAS_WEB_DIR, the installed layout (web/ next to src/) or the repository's apps/web/dist."""
    candidates = [Path(os.environ["CANVAS_WEB_DIR"])] if os.environ.get("CANVAS_WEB_DIR") else []
    candidates += [APP_ROOT / "web", APP_ROOT.parent / "web" / "dist"]
    return next((path for path in candidates if (path / "index.html").exists()), None)


def _write_private(path: Path, text: str) -> None:
    """Writes a file only its owner can read (POSIX; on Windows the per-user folder already is)."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    if os.name != "nt":
        temporary.chmod(0o600)
    temporary.replace(path)


def load_settings(folder: Path) -> dict[str, Any]:
    """settings.json, created with fresh secrets on first use; missing keys are filled in and saved."""
    path = folder / SETTINGS_FILE
    settings: dict[str, Any] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    changed = not path.exists()
    defaults: dict[str, Any] = {
        "sessionSecret": lambda: secrets.token_urlsafe(48),
        "mfaEncryptionKey": lambda: base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
        "port": lambda: DEFAULT_PORT,
        "env": lambda: {},
    }
    for key, make in defaults.items():
        if key not in settings:
            settings[key] = make()
            changed = True
    if changed:
        save_settings(folder, settings)
    return settings


def save_settings(folder: Path, settings: dict[str, Any]) -> None:
    _write_private(folder / SETTINGS_FILE, json.dumps(settings, indent=2) + "\n")


def app_environment(folder: Path, settings: dict[str, Any], port: int) -> dict[str, str]:
    """The API's settings (environment variables) for this data folder."""
    env = {
        "DB_CLIENT": "sqlite",
        "DATABASE_URL": str(folder / "canvas.db"),
        "SESSION_SECRET": settings["sessionSecret"],
        "MFA_ENCRYPTION_KEY": settings["mfaEncryptionKey"],
        "AUTH_MODE": "local",
        "ALLOW_LOCAL_AUTH": "true",
        # One person on their own PC, reachable from it only: two-step verification is offered, not demanded
        # (local mode demands it by default). "env": {"MFA_REQUIRED": "true"} in settings.json turns it back on.
        "MFA_REQUIRED": "false",
        "WEB_ORIGINS": f"http://127.0.0.1:{port},http://localhost:{port}",
        "COOKIE_SECURE": "false",
    }
    web = web_dir()
    if web is not None:
        env["WEB_DIST_DIR"] = str(web)
    env.update({str(key): str(value) for key, value in (settings.get("env") or {}).items()})
    return env


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def healthy(port: int, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as response:
            return bool(response.status == 200)
    except OSError:
        return False


def running_port(folder: Path) -> int | None:
    """The port of the Canvas running for this data folder, or None (a stale pid file doesn't count)."""
    path = folder / PID_FILE
    if not path.exists():
        return None
    try:
        port = int(json.loads(path.read_text(encoding="utf-8"))["port"])
    except ValueError, KeyError, TypeError:
        return None
    return port if healthy(port) else None


def prepare(folder: Path) -> None:
    """Migrates, seeds the catalog when needed and creates the first admin. Uses the environment app_environment set."""
    # Imported here: the environment (app_environment) must be set first.
    from canvas_api.config import Settings
    from canvas_api.db import create_db_engine
    from canvas_api.jobs.bootstrap_admin import BootstrapError, bootstrap_admin
    from canvas_api.migrations import run_migrations
    from canvas_api.seed import seed_catalog

    engine = create_db_engine(Settings())  # type: ignore[call-arg]
    try:
        marker = folder / CATALOG_MARKER
        version = app_version()
        if not marker.exists() or marker.read_text(encoding="utf-8").strip() != version:
            log.info("Seeding the diagram catalog (version %s)", version)
            seed_catalog(engine)
            marker.write_text(version, encoding="utf-8")
        else:
            run_migrations(engine)
        first_admin = folder / FIRST_ADMIN_FILE
        if first_admin.exists():
            try:
                details = json.loads(first_admin.read_text(encoding="utf-8"))
                result = bootstrap_admin(
                    engine,
                    {
                        "BOOTSTRAP_ADMIN_EMAIL": str(details.get("email", "")),
                        "BOOTSTRAP_ADMIN_PASSWORD": str(details.get("password", "")),
                    },
                )
                log.info("%s", result)
            except (BootstrapError, ValueError) as error:
                log.error("The first admin wasn't created: %s", error)
            finally:
                # Never keep the password around, whatever happened.
                first_admin.unlink(missing_ok=True)
    finally:
        engine.dispose()


def _configure_logging(folder: Path) -> None:
    logs = folder / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(logs / "canvas.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)


def _open_when_ready(port: int) -> None:
    for _ in range(600):
        if healthy(port, timeout=0.5):
            webbrowser.open(f"http://localhost:{port}/")
            return
        time.sleep(0.25)
    log.error("Canvas didn't start answering on port %s", port)


def start(open_browser: bool = True) -> int:
    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    _configure_logging(folder)
    port = running_port(folder)
    if port is not None:
        log.info("Canvas is already running on port %s", port)
        if open_browser:
            webbrowser.open(f"http://localhost:{port}/")
        return 0

    settings = load_settings(folder)
    port = int(settings["port"])
    if not port_is_free(port):
        port = free_port()
        log.info("Port %s is taken; using %s from now on", settings["port"], port)
        settings["port"] = port
        save_settings(folder, settings)
    os.environ.update(app_environment(folder, settings, port))
    prepare(folder)

    import uvicorn

    from canvas_api.app import create_app

    pid_path = folder / PID_FILE
    _write_private(pid_path, json.dumps({"pid": os.getpid(), "port": port}))
    if open_browser:
        threading.Thread(target=_open_when_ready, args=(port,), daemon=True).start()
    log.info("Canvas %s on http://localhost:%s (data: %s)", app_version(), port, folder)
    try:
        uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_config=None)).run()
    finally:
        pid_path.unlink(missing_ok=True)
    return 0


def stop() -> int:
    folder = data_dir()
    path = folder / PID_FILE
    if not path.exists():
        print("Canvas isn't running.")
        return 0
    try:
        details = json.loads(path.read_text(encoding="utf-8"))
        pid, port = int(details["pid"]), int(details["port"])
    except ValueError, KeyError, TypeError:
        path.unlink(missing_ok=True)
        return 0
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        # On Windows this ends the process (TerminateProcess); SQLite's transactions keep the database intact.
        os.kill(pid, signal.SIGTERM)
    for _ in range(40):
        if not healthy(port, timeout=0.25):
            break
        time.sleep(0.25)
    path.unlink(missing_ok=True)
    print("Canvas stopped.")
    return 0


def status() -> int:
    port = running_port(data_dir())
    print(f"Canvas is running on http://localhost:{port}/" if port else "Canvas isn't running.")
    return 0 if port else 1


def reset_admin(ask: Callable[[str], str] = input, ask_secret: Callable[[str], str] = getpass.getpass) -> int:
    """Recovery when nobody can sign in (one person, one PC: no other admin to reset them): makes an existing account
    an active, unlocked admin again with a new temporary password and no two-step verification, signed out
    everywhere (bootstrap_admin's reset mode). Works whether or not Canvas is running."""
    from canvas_api.auth.passwords import check_password_policy

    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    settings = load_settings(folder)
    os.environ.update(app_environment(folder, settings, int(settings["port"])))
    email = ask("Email address of your Canvas account: ").strip()
    password = ask_secret("New temporary password (at least 12 characters): ")
    problem = check_password_policy(password, email)
    if problem is None and ask_secret("The same password again: ") != password:
        problem = "The two passwords don't match."
    if problem is not None:
        print(problem)
        return 1

    from canvas_api.config import Settings
    from canvas_api.db import create_db_engine
    from canvas_api.jobs.bootstrap_admin import BootstrapError, bootstrap_admin

    engine = create_db_engine(Settings())  # type: ignore[call-arg]
    try:
        bootstrap_admin(
            engine, {"BOOTSTRAP_ADMIN_EMAIL": email, "BOOTSTRAP_ADMIN_PASSWORD": password, "BOOTSTRAP_MODE": "reset"}
        )
    except BootstrapError as error:
        print(error)
        return 1
    finally:
        engine.dispose()
    print(f"Done. Sign in as {email} with the temporary password; Canvas asks you to choose a new one.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="canvas", description="Run Canvas on this PC.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "open"):
        command = commands.add_parser(name, help="start Canvas (if it isn't running) and open it in the browser")
        command.add_argument("--no-browser", action="store_true", help="don't open the browser")
    commands.add_parser("stop", help="stop Canvas")
    commands.add_parser("status", help="say whether Canvas is running")
    commands.add_parser("reset-admin", help="make an account an admin again with a new temporary password")
    args = parser.parse_args(argv)
    if args.command in ("start", "open"):
        return start(open_browser=not args.no_browser)
    if args.command == "reset-admin":
        return reset_admin()
    return stop() if args.command == "stop" else status()


if __name__ == "__main__":
    sys.exit(main())
