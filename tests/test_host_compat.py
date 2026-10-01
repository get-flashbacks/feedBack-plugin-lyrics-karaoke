"""Core-compatibility seam: the DLC containment helper (issue #35).

`routes._resolve_dlc_path` delegates to whichever containment helper the host
ships — `dlc_paths` (added in feedBack commit ``0dcc913``, the version this
plugin is developed against) or `safepath.safe_join`, which is exactly what
`server._resolve_dlc_path` itself was on `0.3.0-alpha.1`, this manifest's
declared `minHost`. These tests simulate both host shapes, plus a host that
ships neither, and pin that the plugin never falls back to an unguarded join.
"""

import json
import logging
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import routes  # noqa: E402


# ── simulated host modules ───────────────────────────────────────────────────

def _legacy_safe_join(root: Path, name: str):
    """`lib/safepath.safe_join` as it stands at feedBack v0.3.0-alpha.1.

    Copied from the host (raw.githubusercontent.com/got-feedBack/feedBack/
    v0.3.0-alpha.1/lib/safepath.py) so the simulated old host applies the same
    containment core applied then — not a stub written to agree with whatever
    the plugin happens to do.
    """
    if not name:
        return None
    safe = name.replace("\\", "/")
    try:
        root_resolved = root.resolve()
        candidate = (root_resolved / safe).resolve()
        if not candidate.is_relative_to(root_resolved):
            return None
    except (ValueError, OSError):
        return None
    return candidate


def _simulate_legacy_host(monkeypatch):
    """A pre-`0dcc913` host: no `dlc_paths`, but core's `safe_join` present."""
    monkeypatch.setitem(sys.modules, "dlc_paths", None)  # `import dlc_paths` raises
    safepath = types.ModuleType("safepath")
    safepath.safe_join = _legacy_safe_join
    monkeypatch.setitem(sys.modules, "safepath", safepath)


def _simulate_current_host(monkeypatch, resolver):
    """A `0dcc913`+ host: `dlc_paths._resolve_dlc_path` is the helper."""
    dlc_paths = types.ModuleType("dlc_paths")
    dlc_paths._resolve_dlc_path = resolver
    monkeypatch.setitem(sys.modules, "dlc_paths", dlc_paths)


def _simulate_sloppak(monkeypatch):
    """Minimal stand-in for the host's `lib/sloppak`, directory form only.

    `is_sloppak` and `resolve_source_dir` are the only two names `routes.py`
    touches, and both exist in the host at `0.3.0-alpha.1` and today.
    """
    sloppak = types.ModuleType("sloppak")
    sloppak.is_sloppak = lambda path: path.is_dir() and (path / "manifest.yaml").is_file()
    sloppak.resolve_source_dir = lambda filename, dlc_root, unpack_cache_root: dlc_root / filename
    monkeypatch.setitem(sys.modules, "sloppak", sloppak)


def _write_pack(root: Path, name: str) -> Path:
    pack = root / name
    pack.mkdir()
    (pack / "manifest.yaml").write_text(
        "stems:\n  - id: Vocals\n    file: vocals.wav\nlyrics: lyrics.json\n"
        "vocal_pitch: vocal_pitch.json\n", encoding="utf-8")
    (pack / "lyrics.json").write_text(json.dumps(
        [{"t": 1.0, "d": 0.5, "w": "hel"}, {"t": 1.5, "d": 0.5, "w": "lo"}],
    ), encoding="utf-8")
    (pack / "vocal_pitch.json").write_text(json.dumps(
        {"version": 1, "notes": [{"t": 1.0, "d": 0.5, "midi": 60}, {"t": 1.5, "d": 0.5, "midi": 62}]},
    ), encoding="utf-8")
    (pack / "vocals.wav").write_bytes(b"RIFF")
    return pack


def _wire_host(monkeypatch, tmp_path, log_name="test.host_compat"):
    _simulate_sloppak(monkeypatch)
    # setup() assigns the module globals directly, so snapshot them through
    # monkeypatch FIRST — otherwise they keep pointing at a tmp_path pytest
    # deletes, and every later test inherits a dangling library root.
    for name in ("_config_dir", "_get_dlc_dir", "SLOPPAK_CACHE_DIR", "_log"):
        monkeypatch.setattr(routes, name, getattr(routes, name))
    app = FastAPI()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: tmp_path,
        "log": logging.getLogger(log_name),
    })
    return TestClient(app)


# ── which core helper gets used ──────────────────────────────────────────────

def test_current_host_uses_dlc_paths_helper(tmp_path, monkeypatch):
    calls = []

    def core_resolve(dlc, filename):
        calls.append((dlc, filename))
        return tmp_path / "song.sloppak"

    _simulate_current_host(monkeypatch, core_resolve)

    assert routes._resolve_dlc_path(tmp_path, "song.sloppak") == tmp_path / "song.sloppak"
    assert calls == [(tmp_path, "song.sloppak")]


def test_current_host_verdict_is_taken_as_is(tmp_path, monkeypatch):
    # The new helper's containment is LEXICAL, so a junction-mounted library
    # still resolves; the plugin must not second-guess a refusal it does not
    # understand.
    _simulate_current_host(monkeypatch, lambda dlc, filename: None)
    assert routes._resolve_dlc_path(tmp_path, "song.sloppak") is None


def test_legacy_host_falls_back_to_core_safe_join(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    # `safe_join` resolves, so compare resolved — a symlinked tmp root (macOS
    # `/var` -> `/private/var`) would otherwise fail this on a dev machine.
    assert routes._resolve_dlc_path(tmp_path, "song.sloppak") == (tmp_path / "song.sloppak").resolve()


@pytest.mark.parametrize("filename", [
    "../outside.sloppak",
    "..\\..\\outside.sloppak",   # Windows-style, rejected identically on POSIX
    "/etc/passwd",
    "",
])
def test_legacy_host_still_refuses_escapes(tmp_path, monkeypatch, filename):
    _simulate_legacy_host(monkeypatch)
    assert routes._resolve_dlc_path(tmp_path, filename) is None


@pytest.mark.parametrize("filename", ["C:/song.sloppak", "C:\\song.sloppak", "a\x00b.sloppak"])
def test_legacy_host_never_resolves_outside_the_library_root(tmp_path, monkeypatch, filename):
    """Containment is the property the two core helpers share; the rest is not.

    `dlc_paths` refuses drive-absolute and NUL-containing names outright;
    the pre-`0dcc913` `safe_join` only refuses them insofar as `resolve()`
    does, so on POSIX `C:/song.sloppak` comes back as a contained path under
    the library. Asserting "inside the root or nothing" is therefore the
    honest contract — asserting identical verdicts would pin core, not us.
    """
    _simulate_legacy_host(monkeypatch)
    resolved = routes._resolve_dlc_path(tmp_path, filename)
    assert resolved is None or resolved.is_relative_to(tmp_path.resolve())


def test_refuses_when_the_host_ships_no_containment_helper(tmp_path, monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "dlc_paths", None)
    monkeypatch.setitem(sys.modules, "safepath", None)
    monkeypatch.setattr(routes, "_log", logging.getLogger("test.host_compat.no_core"))

    with caplog.at_level(logging.WARNING):
        assert routes._resolve_dlc_path(tmp_path, "song.sloppak") is None

    assert "containment helper" in caplog.text


# ── end-to-end on the declared minimum ───────────────────────────────────────

def test_resolve_sloppak_works_on_the_declared_minimum(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    _simulate_sloppak(monkeypatch)
    pack = _write_pack(tmp_path, "song.sloppak")
    monkeypatch.setattr(routes, "_get_dlc_dir", lambda: tmp_path)
    monkeypatch.setattr(routes, "SLOPPAK_CACHE_DIR", tmp_path / "cache")

    source_dir, manifest, dlc_path, is_zip = routes._resolve_sloppak("song.sloppak")

    assert source_dir == pack
    assert manifest["lyrics"] == "lyrics.json"
    assert dlc_path == pack.resolve()   # safe_join resolves before returning
    assert is_zip is False


def test_resolve_sloppak_refuses_traversal_on_the_declared_minimum(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    _simulate_sloppak(monkeypatch)
    _write_pack(tmp_path, "song.sloppak")
    _write_pack(tmp_path.parent, f"{tmp_path.name}.sloppak")  # sibling, outside the library
    monkeypatch.setattr(routes, "_get_dlc_dir", lambda: tmp_path)
    monkeypatch.setattr(routes, "SLOPPAK_CACHE_DIR", tmp_path / "cache")

    assert routes._resolve_sloppak(f"../{tmp_path.name}.sloppak") is None


def test_status_route_reports_prepared_data_on_the_minimum_host(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    _write_pack(tmp_path, "song.sloppak")
    client = _wire_host(monkeypatch, tmp_path)

    status = client.get("/api/plugins/lyrics_karaoke/status",
                        params={"filename": "song.sloppak"}).json()

    assert status == {
        "filename": "song.sloppak", "is_sloppak": True, "has_vocals": True,
        "has_lyrics": True, "has_pitch": True, "pitch_count": 2,
    }


def test_playback_route_serves_the_minimum_host(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    _write_pack(tmp_path, "song.sloppak")
    client = _wire_host(monkeypatch, tmp_path)

    response = client.get("/api/plugins/lyrics_karaoke/playback",
                          params={"filename": "song.sloppak"})

    assert response.status_code == 200
    assert response.json()["voices"][0]["tokens"] == [
        {"start": 1.0, "duration": 0.5, "text": "hel", "midi": 60},
        {"start": 1.5, "duration": 0.5, "text": "lo", "midi": 62},
    ]


def test_data_route_merges_lyrics_and_pitch_on_the_minimum_host(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    _write_pack(tmp_path, "song.sloppak")
    client = _wire_host(monkeypatch, tmp_path)

    response = client.get("/api/plugins/lyrics_karaoke/data",
                          params={"filename": "song.sloppak"})

    assert response.status_code == 200
    assert response.json() == {
        "filename": "song.sloppak",
        "tokens": [
            {"t": 1.0, "d": 0.5, "w": "hel", "midi": 60},
            {"t": 1.5, "d": 0.5, "w": "lo", "midi": 62},
        ],
    }


def test_playback_route_404s_for_a_traversal_filename(tmp_path, monkeypatch):
    _simulate_legacy_host(monkeypatch)
    _write_pack(tmp_path, "song.sloppak")
    client = _wire_host(monkeypatch, tmp_path)

    response = client.get("/api/plugins/lyrics_karaoke/playback",
                          params={"filename": "../song.sloppak"})

    assert response.status_code == 404
