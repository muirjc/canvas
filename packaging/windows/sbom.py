"""The Windows build's software bill of materials (canvas-xl3a.5): a CycloneDX 1.6 JSON document of what the
installer ships, made by build.ps1 from the staged files, not written by hand.

    python -I sbom.py --stage <stage> --root <repository> --version <version>
                      --python-url <url> --python-sha256 <hex> --output <file.cdx.json>

Components (each with its licence):
- the private Python (python-build-standalone's CPython) and every library it bundles, from
  licenses/windows-python/manifest.json, each with the SHA-256 of its files as installed;
- every Python package installed in the stage (from its .dist-info), with the SHA-256 of the exact wheel installed
  (from apps/api-py/uv.lock, matched by the wheel's tags), licences from licenses/packages.json;
- every npm package the web app is built from (licenses/packages.json, from package-lock.json), with the lockfile's
  integrity hash.
Canvas itself is the document's subject (metadata.component). Standard library only: it runs on the staged Python.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import tomllib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

SPDX_EXPRESSION = re.compile(r"^[A-Za-z0-9.+-]+( (OR|AND|WITH) [A-Za-z0-9.+-]+)*$")
REPOSITORY = "https://github.com/muirjc/canvas"


def normalize(name: str) -> str:
    """A Python package name as PEP 503 compares them."""
    return re.sub(r"[-_.]+", "-", name).lower()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def licenses(value: str | None) -> list[dict[str, Any]]:
    """CycloneDX licences: an SPDX expression when it is one, else the licence's name."""
    if not value or value == "UNKNOWN":
        return []
    if SPDX_EXPRESSION.match(value):
        return [{"expression": value}]
    return [{"license": {"name": value}}]


def wheel_tags(filename: str) -> set[str]:
    """Every tag a wheel's file name stands for (`py3-none-any`, and each one of `cp313.cp314-...` compressed sets)."""
    parts = filename[: -len(".whl")].split("-")
    python, abi, platform = parts[-3:]
    return {f"{p}-{a}-{t}" for p in python.split(".") for a in abi.split(".") for t in platform.split(".")}


def locked_wheels(uv_lock: Path) -> dict[tuple[str, str], list[dict[str, Any]]]:
    """(normalized name, version) -> the lockfile's wheels for it (url, hash)."""
    lock = tomllib.loads(uv_lock.read_text(encoding="utf-8"))
    return {
        (normalize(package["name"]), str(package["version"])): list(package.get("wheels", []))
        for package in lock.get("package", [])
        if "version" in package
    }


def installed_wheel(dist_info: Path, wheels: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The locked wheel that was installed: the one whose tags include a tag in the .dist-info's WHEEL file."""
    wheel_file = dist_info / "WHEEL"
    if not wheel_file.exists():
        return None
    tags = {
        line.split(":", 1)[1].strip()
        for line in wheel_file.read_text(encoding="utf-8").splitlines()
        if line.startswith("Tag:")
    }
    for wheel in wheels:
        if tags & wheel_tags(wheel["url"].rsplit("/", 1)[-1]):
            return wheel
    return None


def python_packages(site_packages: Path, root: Path, known: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    wheels = locked_wheels(root / "apps" / "api-py" / "uv.lock")
    components = []
    for dist_info in sorted(site_packages.glob("*.dist-info")):
        metadata: dict[str, str] = {}
        for line in (dist_info / "METADATA").read_text(encoding="utf-8").splitlines():
            if not line:
                break  # the headers end at the first blank line
            key, _, value = line.partition(":")
            metadata.setdefault(key.strip(), value.strip())
        name, version = metadata["Name"], metadata["Version"]
        entry = known.get(f"{normalize(name)}@{version}")
        if entry is None:
            raise SystemExit(
                f"{name} {version} is installed but isn't in licenses/packages.json (run npm run licenses)."
            )
        component: dict[str, Any] = {
            "type": "library",
            "bom-ref": f"pypi:{normalize(name)}@{version}",
            "name": name,
            "version": version,
            "purl": f"pkg:pypi/{normalize(name)}@{version}",
            "licenses": licenses(entry["license"]),
        }
        wheel = installed_wheel(dist_info, wheels.get((normalize(name), version), []))
        if wheel is not None:
            algorithm, _, content = wheel["hash"].partition(":")
            if algorithm == "sha256":
                component["hashes"] = [{"alg": "SHA-256", "content": content}]
            component["externalReferences"] = [{"type": "distribution", "url": wheel["url"]}]
        if entry.get("repository"):
            component.setdefault("externalReferences", []).append({"type": "vcs", "url": entry["repository"]})
        components.append(component)
    return components


def npm_packages(npm: list[dict[str, Any]]) -> list[dict[str, Any]]:
    components = []
    for package in npm:
        if not package.get("webApp"):
            continue
        name, version = package["name"], package["version"]
        component: dict[str, Any] = {
            "type": "library",
            "bom-ref": f"npm:{name}@{version}",
            "name": name.rsplit("/", 1)[-1],
            "version": version,
            "purl": f"pkg:npm/{quote(name, safe='/')}@{version}",
            "licenses": licenses(package["license"]),
        }
        if "/" in name:
            component["group"] = name.rsplit("/", 1)[0]
        integrity = package.get("integrity", "")
        if integrity.startswith("sha512-"):
            content = base64.b64decode(integrity[len("sha512-") :]).hex()
            component["hashes"] = [{"alg": "SHA-512", "content": content}]
        if package.get("repository"):
            component["externalReferences"] = [{"type": "vcs", "url": package["repository"]}]
        components.append(component)
    return components


def python_runtime(stage: Path, root: Path, python_url: str, python_sha256: str) -> list[dict[str, Any]]:
    manifest = json.loads((root / "licenses" / "windows-python" / "manifest.json").read_text(encoding="utf-8"))
    components = []
    for library in manifest["libraries"]:
        slug = normalize(library["name"].split(" (")[0].replace(" ", "-"))
        component: dict[str, Any] = {
            "type": "library",
            "bom-ref": f"windows-python:{slug}@{library['version']}",
            "name": library["name"],
            "version": library["version"],
            "licenses": licenses(library["licence"]),
            "externalReferences": [{"type": "website", "url": library["source"]}],
            "components": [
                {
                    "type": "file",
                    "bom-ref": f"file:python/{file}",
                    "name": f"python/{file}",
                    "hashes": [{"alg": "SHA-256", "content": sha256_file(stage / "python" / file)}],
                }
                for file in library["files"]
            ],
        }
        if library["name"] == "CPython":
            component["purl"] = f"pkg:generic/cpython@{library['version']}"
            component["supplier"] = {
                "name": "python-build-standalone",
                "url": ["https://github.com/astral-sh/python-build-standalone"],
            }
            component["externalReferences"].append(
                {"type": "distribution", "url": python_url, "hashes": [{"alg": "SHA-256", "content": python_sha256}]}
            )
            component["properties"] = [
                {"name": "canvas:python-build-standalone-release", "value": manifest["pythonBuildStandalone"]}
            ]
        components.append(component)
    return components


def build(stage: Path, root: Path, version: str, python_url: str, python_sha256: str) -> dict[str, Any]:
    packages = json.loads((root / "licenses" / "packages.json").read_text(encoding="utf-8"))
    known = {f"{normalize(p['name'])}@{p['version']}": p for p in packages["python"]}
    components = [
        *python_runtime(stage, root, python_url, python_sha256),
        *python_packages(stage / "python" / "Lib" / "site-packages", root, known),
        *npm_packages(packages["npm"]),
    ]
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tools": {"components": [{"type": "application", "name": "canvas packaging/windows/sbom.py"}]},
            "component": {
                "type": "application",
                "bom-ref": "canvas",
                "name": "Canvas",
                "version": version,
                "licenses": [{"license": {"id": "Apache-2.0"}}],
                "externalReferences": [{"type": "vcs", "url": REPOSITORY}],
            },
        },
        "components": components,
        "dependencies": [{"ref": "canvas", "dependsOn": [c["bom-ref"] for c in components]}],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    for name in ("stage", "root", "version", "python-url", "python-sha256", "output"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    document = build(Path(args.stage), Path(args.root), args.version, args.python_url, args.python_sha256)
    Path(args.output).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"SBOM: {len(document['components'])} components -> {args.output}")


if __name__ == "__main__":
    main()
