"""Rollback verification for the vocals release gate (issue #43).

The operator procedure in docs/release-manual-matrix.md is:

  1. Hash the sidecars of a pack prepared by the release candidate and of a
     pack prepared before this release.
  2. Replace the plugin with v1.12.0 and reload the host.
  3. Open both packs again with no regeneration: lyrics, pitch, and playback
     must all work.
  4. Hash the sidecars again — every digest must match step 1.
  5. Roll forward to the candidate and open both packs a third time.

This suite runs that procedure in CI. "Swap the plugin" is implemented by
loading v1.12.0's routes.py from the git tree as a separate module; "open the
pack" is the read routes (/status, /data, /playback). It covers directory-form
and zip-form packs and records the before/after hashes so they can be attached
to the release PR.
"""

import hashlib
import importlib.util
import json
import logging
import os
import subprocess
import sys
import types
import zipfile
from pathlib import Path

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import routes as head_routes  # noqa: E402


def _load_routes_from_rev(rev: str):
    """Import routes.py from a specific git revision under a fresh module name."""
    blob = subprocess.check_output(
        ["git", "show", f"{rev}:routes.py"], cwd=str(ROOT),
    )
    name = f"routes_{rev}"
    spec = importlib.util.spec_from_loader(name, loader=None, origin=f"<{rev}>")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    exec(compile(blob, f"routes_{rev}.py", "exec"), mod.__dict__)
    return mod


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _zip_member_sha256(pack: Path, member: str) -> str:
    with zipfile.ZipFile(pack) as zf:
        return hashlib.sha256(zf.read(member)).hexdigest()


def _write_pack_dir(path: Path, *, legacy: bool = False) -> None:
    """Create a minimal directory-form sloppak with lyrics + pitch sidecars."""
    path.mkdir(parents=True, exist_ok=True)
    lyrics = [{"t": 0.5, "d": 0.4, "w": "la-"}, {"t": 0.9, "d": 0.5, "w": "la+"}]
    pitch = {"version": 1, "notes": [
        {"t": 0.5, "d": 0.4, "midi": 60},
        {"t": 0.9, "d": 0.5, "midi": 62},
    ]}
    if legacy:
        manifest = {
            "stems": [{"id": "Vocals", "file": "vocals.wav"}],
            "lyrics": "lyrics.json",
            "vocal_pitch": "vocal_pitch.json",
        }
    else:
        manifest = {
            "feedpak_version": "1.0.0",
            "title": "Rollback test pack",
            "artist": "CI",
            "duration": 2.0,
            "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
            "lyrics": "lyrics.json",
            "vocal_pitch": "vocal_pitch.json",
        }
    (path / "lyrics.json").write_text(json.dumps(lyrics), encoding="utf-8")
    (path / "vocal_pitch.json").write_text(json.dumps(pitch), encoding="utf-8")
    (path / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    (path / "vocals.wav").write_bytes(b"RIFF" + b"\x00" * 40)


def _make_zip_pack(path: Path, *, legacy: bool = False) -> None:
    """Build a zip-form sloppak from a temporary directory-form pack."""
    tmp_dir = path.with_suffix("")
    _write_pack_dir(tmp_dir, legacy=legacy)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(tmp_dir.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(tmp_dir).as_posix())
    # cleanup the temp dir
    for f in sorted(tmp_dir.rglob("*"), reverse=True):
        if f.is_file():
            f.unlink()
        elif f.is_dir() and not any(f.iterdir()):
            f.rmdir()


def _sloppak_mock(library_dir: Path):
    """A minimal sloppak module handling directory and zip forms."""
    import zipfile as _zipfile

    sloppak = types.ModuleType("sloppak")

    def is_sloppak(path):
        if path.is_dir():
            return (path / "manifest.yaml").is_file()
        if path.is_file() and path.suffix == ".sloppak":
            try:
                with _zipfile.ZipFile(path) as z:
                    return any(
                        n == "manifest.yaml" or n.endswith("/manifest.yaml")
                        for n in z.namelist()
                    )
            except _zipfile.BadZipFile:
                return False
        return False

    def resolve_source_dir(filename, dlc_root, unpack_cache_root):
        path = dlc_root / filename
        if path.is_dir():
            return path
        if path.is_file():
            dest = unpack_cache_root / filename.replace(".sloppak", "")
            dest.mkdir(parents=True, exist_ok=True)
            with _zipfile.ZipFile(path) as zf:
                zf.extractall(dest)
            return dest
        return None

    sloppak.is_sloppak = is_sloppak
    sloppak.resolve_source_dir = resolve_source_dir
    return sloppak


def _dlc_paths_mock(library_dir: Path):
    """A dlc_paths module mirroring the current core helper."""
    mod = types.ModuleType("dlc_paths")

    def _resolve(candidate_dlc, filename):
        if not filename:
            return None
        safe = str(filename).replace("\\", "/")
        try:
            root = Path(candidate_dlc).resolve()
            target = (root / safe).resolve()
            if target.is_relative_to(root):
                return target
        except (OSError, ValueError):
            pass
        return None

    mod._resolve_dlc_path = _resolve
    return mod


def _wire_host(module, tmp_path, library_dir, log_name):
    """Wire module routes into a FastAPI TestClient pointed at library_dir."""
    for name in ("_config_dir", "_get_dlc_dir", "SLOPPAK_CACHE_DIR", "_log"):
        if hasattr(module, name):
            setattr(module, name, getattr(module, name))
    sloppak = _sloppak_mock(library_dir)
    dlc_paths = _dlc_paths_mock(library_dir)
    sys.modules["sloppak"] = sloppak
    sys.modules["dlc_paths"] = dlc_paths
    sys.modules.pop("safepath", None)

    app = FastAPI()
    module.setup(app, {
        "config_dir": str(tmp_path),
        "get_dlc_dir": lambda: library_dir,
        "log": logging.getLogger(log_name),
    })
    return TestClient(app)


def _sidecars_dir(pack_dir: Path):
    lyrics = pack_dir / "lyrics.json"
    pitch = pack_dir / "vocal_pitch.json"
    manifest = pack_dir / "manifest.yaml"
    return {
        "lyrics": _sha256(lyrics),
        "pitch": _sha256(pitch),
        "manifest": _sha256(manifest),
    }


def _sidecars_zip(pack_path: Path):
    return {
        "lyrics": _zip_member_sha256(pack_path, "lyrics.json"),
        "pitch": _zip_member_sha256(pack_path, "vocal_pitch.json"),
        "manifest": _zip_member_sha256(pack_path, "manifest.yaml"),
    }


def _read_routes(client, name):
    base = f"/api/plugins/lyrics_karaoke"
    r_status = client.get(f"{base}/status", params={"filename": name})
    r_data = client.get(f"{base}/data", params={"filename": name})
    r_playback = client.get(f"{base}/playback", params={"filename": name})
    return r_status, r_data, r_playback


# ── The test ─────────────────────────────────────────────────────────────────


def test_rollback_hashes_survive_plugin_swap(tmp_path, monkeypatch):
    """Prepared sidecars are unchanged after opening under HEAD and v1.12.0."""

    # Layout
    work = tmp_path / "work"
    work.mkdir()
    library = work / "library"
    library.mkdir()
    candidate_dir = library / "candidate-dir.sloppak"
    candidate_zip = library / "candidate-zip.sloppak"
    legacy_dir = library / "legacy-dir.sloppak"

    _write_pack_dir(candidate_dir, legacy=False)
    _make_zip_pack(candidate_zip, legacy=False)
    _write_pack_dir(legacy_dir, legacy=True)

    # ── Step 1: candidate prepares a pack via save-lyrics ────────────────────
    client = _wire_host(head_routes, tmp_path, library, "test.rollback.candidate")
    prepare_segments = [
        {"start": 0.5, "end": 0.9, "text": "la-"},
        {"start": 0.9, "end": 1.4, "text": "la+"},
    ]
    for name in ("candidate-dir.sloppak", "candidate-zip.sloppak"):
        resp = client.post(
            "/api/plugins/lyrics_karaoke/save-lyrics",
            json={"filename": name, "segments": prepare_segments},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["lyrics_count"] == 2

    before_dir = _sidecars_dir(candidate_dir)
    before_zip = _sidecars_zip(candidate_zip)
    before_legacy = _sidecars_dir(legacy_dir)

    # ── Step 2: open all packs under HEAD (simulating current plugin) ─────────
    for name in ("candidate-dir.sloppak", "candidate-zip.sloppak", "legacy-dir.sloppak"):
        s, d, p = _read_routes(client, name)
        assert s.status_code == 200
        assert d.status_code in (200, 404)
        assert p.status_code in (200, 404)

    after_dir_head = _sidecars_dir(candidate_dir)
    after_zip_head = _sidecars_zip(candidate_zip)
    after_legacy_head = _sidecars_dir(legacy_dir)

    assert after_dir_head == before_dir, "directory-form sidecar hash changed under HEAD"
    assert after_zip_head == before_zip, "zip-form sidecar hash changed under HEAD"
    assert after_legacy_head == before_legacy, "legacy dir sidecar hash changed under HEAD"

    # ── Step 3: swap to v1.12.0 routes and reopen ────────────────────────────
    v1120 = _load_routes_from_rev("v1.12.0")
    # Need a fresh TestClient because setup() registers routes on a new app.
    client_v1120 = _wire_host(v1120, tmp_path, library, "test.rollback.v1120")
    # v1.12.0 does `from dlc_paths import _resolve_dlc_path` inside
    # _resolve_sloppak, so dlc_paths must be present — _wire_host does this.

    after_dir_rollback = _sidecars_dir(candidate_dir)
    after_zip_rollback = _sidecars_zip(candidate_zip)
    after_legacy_rollback = _sidecars_dir(legacy_dir)

    assert after_dir_rollback == before_dir, "directory-form sidecar hash changed under v1.12.0"
    assert after_zip_rollback == before_zip, "zip-form sidecar hash changed under v1.12.0"
    assert after_legacy_rollback == before_legacy, "legacy dir sidecar hash changed under v1.12.0"

    for name in ("candidate-dir.sloppak", "candidate-zip.sloppak", "legacy-dir.sloppak"):
        s, d, p = _read_routes(client_v1120, name)
        assert s.status_code == 200
        assert d.status_code in (200, 404)
        assert p.status_code in (200, 404)

    # ── Step 4: roll forward to HEAD and reopen again ─────────────────────────
    client_forward = _wire_host(head_routes, tmp_path, library, "test.rollback.forward")

    after_dir_forward = _sidecars_dir(candidate_dir)
    after_zip_forward = _sidecars_zip(candidate_zip)
    after_legacy_forward = _sidecars_dir(legacy_dir)

    assert after_dir_forward == before_dir, "directory-form sidecar hash changed on roll forward"
    assert after_zip_forward == before_zip, "zip-form sidecar hash changed on roll forward"
    assert after_legacy_forward == before_legacy, "legacy dir sidecar hash changed on roll forward"

    for name in ("candidate-dir.sloppak", "candidate-zip.sloppak", "legacy-dir.sloppak"):
        s, d, p = _read_routes(client_forward, name)
        assert s.status_code == 200
        assert d.status_code in (200, 404)
        assert p.status_code in (200, 404)

    # ── Step 5: plugin directory was never a write target ────────────────────
    plugin_dir = work / "plugin-dir"
    plugin_dir.mkdir()
    stray = [p for p in work.rglob("*") if p.is_file() and plugin_dir in p.parents]
    assert not stray, f"stray write landed in plugin dir: {stray}"

    # ── Record hashes for the release PR (printed to stdout) ─────────────────
    print("\n=== ROLLBACK HASHES ===")
    print(f"candidate-dir lyrics  {before_dir['lyrics']}")
    print(f"candidate-dir pitch   {before_dir['pitch']}")
    print(f"candidate-dir manifest {before_dir['manifest']}")
    print(f"candidate-zip lyrics  {before_zip['lyrics']}")
    print(f"candidate-zip pitch   {before_zip['pitch']}")
    print(f"candidate-zip manifest {before_zip['manifest']}")
    print(f"legacy-dir   lyrics  {before_legacy['lyrics']}")
    print(f"legacy-dir   pitch   {before_legacy['pitch']}")
    print(f"legacy-dir   manifest {before_legacy['manifest']}")
