"""The Windows build's SBOM generator (packaging/windows/sbom.py, canvas-xl3a.5), run on a made-up stage folder
against the repository's real manifest, licenses/packages.json and uv.lock, and checked against the CycloneDX 1.6
JSON schema (tests/data/cyclonedx-1.6, from CycloneDX/specification tag 1.6.2, Apache-2.0)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
from pathlib import Path
from types import ModuleType
from typing import Any

import jsonschema
import pytest
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[3]
SCHEMAS = Path(__file__).resolve().parent / "data" / "cyclonedx-1.6"
PYTHON_URL = "https://example.test/cpython-3.15.2+20261026-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
PYTHON_SHA256 = "ab" * 32


def _load_sbom() -> ModuleType:
    spec = importlib.util.spec_from_file_location("canvas_sbom", ROOT / "packaging" / "windows" / "sbom.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sbom = _load_sbom()


def _validator() -> jsonschema.Draft7Validator:
    resources = []
    for file in SCHEMAS.glob("*.schema.json"):
        contents = json.loads(file.read_text(encoding="utf-8"))
        resources.append((contents["$id"], Resource.from_contents(contents)))
    schema = json.loads((SCHEMAS / "bom-1.6.schema.json").read_text(encoding="utf-8"))
    return jsonschema.Draft7Validator(schema, registry=Registry().with_resources(resources))


def _python_version(name: str) -> str:
    packages = json.loads((ROOT / "licenses" / "packages.json").read_text(encoding="utf-8"))
    return next(p["version"] for p in packages["python"] if p["name"] == name)


def _dist_info(site_packages: Path, name: str, version: str, tags: list[str]) -> None:
    folder = site_packages / f"{name.replace('-', '_')}-{version}.dist-info"
    folder.mkdir(parents=True)
    (folder / "METADATA").write_text(
        f"Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n\nLong description: not a header\n",
        encoding="utf-8",
    )
    (folder / "WHEEL").write_text("Wheel-Version: 1.0\n" + "".join(f"Tag: {t}\n" for t in tags), encoding="utf-8")


@pytest.fixture
def stage(tmp_path: Path) -> Path:
    """The files the runtime manifest lists, plus a pure-Python package and one with a Windows wheel."""
    manifest = json.loads((ROOT / "licenses" / "windows-python" / "manifest.json").read_text(encoding="utf-8"))
    for library in manifest["libraries"]:
        for file in library["files"]:
            path = tmp_path / "python" / file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"{library['name']} {file}".encode())
    site_packages = tmp_path / "python" / "Lib" / "site-packages"
    _dist_info(site_packages, "fastapi", _python_version("fastapi"), ["py3-none-any"])
    _dist_info(site_packages, "cryptography", _python_version("cryptography"), ["cp311-abi3-win_amd64"])
    # Built from its source package on the build machine: no locked wheel has this tag.
    _dist_info(site_packages, "PyYAML", _python_version("pyyaml"), ["cp315-cp315-win_amd64"])
    return tmp_path


def _build(stage: Path) -> dict[str, Any]:
    document: dict[str, Any] = sbom.build(stage, ROOT, "1.2.3", PYTHON_URL, PYTHON_SHA256)
    return document


def _component(document: dict[str, Any], ref: str) -> dict[str, Any]:
    component: dict[str, Any] = next(c for c in document["components"] if c["bom-ref"] == ref)
    return component


def test_the_sbom_is_valid_cyclonedx_1_6(stage: Path) -> None:
    document = _build(stage)
    errors = [f"{list(e.absolute_path)}: {e.message}" for e in _validator().iter_errors(document)]
    assert errors == []
    assert document["metadata"]["component"]["name"] == "Canvas"
    assert document["metadata"]["component"]["version"] == "1.2.3"


def test_every_component_is_a_dependency_of_canvas_and_refs_are_unique(stage: Path) -> None:
    document = _build(stage)
    refs = [c["bom-ref"] for c in document["components"]]
    assert len(refs) == len(set(refs))
    assert document["dependencies"] == [{"ref": "canvas", "dependsOn": refs}]


def test_the_runtime_libraries_carry_the_hashes_of_their_installed_files(stage: Path) -> None:
    openssl = _component(_build(stage), "windows-python:openssl@3.5.9")
    assert openssl["licenses"] == [{"expression": "Apache-2.0"}]
    files = {f["name"]: f["hashes"][0]["content"] for f in openssl["components"]}
    expected = hashlib.sha256(b"OpenSSL DLLs/libssl-3-x64.dll").hexdigest()
    assert files["python/DLLs/libssl-3-x64.dll"] == expected


def test_cpython_names_the_download_it_came_from(stage: Path) -> None:
    cpython = _component(_build(stage), "windows-python:cpython@3.15.2")
    distribution = next(r for r in cpython["externalReferences"] if r["type"] == "distribution")
    assert distribution == {
        "type": "distribution",
        "url": PYTHON_URL,
        "hashes": [{"alg": "SHA-256", "content": PYTHON_SHA256}],
    }


def test_a_licence_that_isnt_an_spdx_expression_is_given_by_name(stage: Path) -> None:
    runtime = _component(_build(stage), "windows-python:microsoft-visual-c++-runtime@14.51.36247")
    assert runtime["licenses"] == [{"license": {"name": "Microsoft Distributable Code (see PYTHON-LICENSE.txt)"}}]


def test_python_packages_carry_the_hash_of_the_wheel_that_was_installed(stage: Path) -> None:
    document = _build(stage)
    version = _python_version("cryptography")
    cryptography = _component(document, f"pypi:cryptography@{version}")
    url = next(r["url"] for r in cryptography["externalReferences"] if r["type"] == "distribution")
    assert url.endswith("-cp311-abi3-win_amd64.whl")
    assert cryptography["purl"] == f"pkg:pypi/cryptography@{version}"
    assert cryptography["hashes"][0]["alg"] == "SHA-256"
    fastapi = _component(document, f"pypi:fastapi@{_python_version('fastapi')}")
    assert next(r["url"] for r in fastapi["externalReferences"] if r["type"] == "distribution").endswith("none-any.whl")


def test_npm_packages_are_the_web_apps_with_their_integrity_as_sha512(stage: Path) -> None:
    document = _build(stage)
    npm = [c for c in document["components"] if c["bom-ref"].startswith("npm:")]
    packages = json.loads((ROOT / "licenses" / "packages.json").read_text(encoding="utf-8"))["npm"]
    assert len(npm) == len([p for p in packages if p["webApp"]])
    dagre = _component(
        document, f"npm:@dagrejs/dagre@{next(p['version'] for p in packages if p['name'] == '@dagrejs/dagre')}"
    )
    assert (dagre["group"], dagre["name"]) == ("@dagrejs", "dagre")
    assert dagre["purl"].startswith("pkg:npm/%40dagrejs/dagre@")
    assert len(dagre["hashes"][0]["content"]) == 128  # SHA-512, hex


def test_a_package_missing_from_packages_json_stops_the_build(stage: Path) -> None:
    _dist_info(stage / "python" / "Lib" / "site-packages", "not-a-real-package", "9.9.9", ["py3-none-any"])
    missing = re.escape("not-a-real-package 9.9.9 is installed but isn't in licenses/packages.json")
    with pytest.raises(SystemExit, match=missing):
        _build(stage)


def test_wheel_tags_expand_compressed_tag_sets() -> None:
    assert sbom.wheel_tags("x-1.0-cp313.cp314-abi3-win_amd64.whl") == {"cp313-abi3-win_amd64", "cp314-abi3-win_amd64"}
    assert sbom.wheel_tags("x-1.0-1build-py3-none-any.whl") == {"py3-none-any"}


def test_a_package_built_from_source_carries_the_hash_of_its_source_package(stage: Path) -> None:
    document = _build(stage)
    version = _python_version("pyyaml")
    pyyaml = _component(document, f"pypi:pyyaml@{version}")
    url = next(r["url"] for r in pyyaml["externalReferences"] if r["type"] == "distribution")
    assert url.endswith(f"pyyaml-{version}.tar.gz")
    assert pyyaml["hashes"][0]["alg"] == "SHA-256"
    assert re.fullmatch(r"[0-9a-f]{64}", pyyaml["hashes"][0]["content"])
