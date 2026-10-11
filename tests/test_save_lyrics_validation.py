"""`POST /save-lyrics` must not overwrite existing lyrics with an unusable
alignment result (issue #59).

The sanitizer drops bad segments one at a time, so a result where *every*
entry is unusable used to be written as ``[]`` and reported ``ok: true`` —
erasing valid lyrics, and with no archive backup at all for directory-form
packs. The route now validates the sanitized result before touching the
sidecar, manifest, or archive, and partial-invalid input is accepted only
with the dropped count surfaced.
"""

import json
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import routes  # noqa: E402
from tests.test_rollback import _sha256, _wire_host  # noqa: E402

BASE = "/api/plugins/lyrics_karaoke"
ORIGINAL = [{"t": 0.5, "d": 0.4, "w": "keep"}]


def _write_pack_dir(path: Path, lyrics_name: str = "lyrics.json") -> None:
    """Minimal directory-form pack whose manifest points at ``lyrics_name``."""
    path.mkdir(parents=True, exist_ok=True)
    manifest = {
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": lyrics_name,
    }
    (path / lyrics_name).write_text(json.dumps(ORIGINAL), encoding="utf-8")
    (path / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8"
    )
    (path / "vocals.wav").write_bytes(b"RIFF" + b"\x00" * 40)


def _make_zip_pack(path: Path, lyrics_name: str = "lyrics.json") -> None:
    src = path.with_suffix("")
    _write_pack_dir(src, lyrics_name)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(src).as_posix())


def _save(client, segments, filename="song.sloppak"):
    return client.post(
        f"{BASE}/save-lyrics",
        json={"filename": filename, "segments": segments},
    )


# ── unit: raise before any write ─────────────────────────────────────────────

def test_persist_lyrics_all_invalid_raises_without_writing(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")

    with pytest.raises(routes.LyricsPersistenceError) as excinfo:
        routes._persist_lyrics(
            tmp_path, {"schema": 1},
            [{"start": "bad", "end": 2, "text": "x"}],
            tmp_path / "song.sloppak", False,
        )

    assert excinfo.value.status == 422
    assert not (tmp_path / "lyrics.json").exists()


def test_persist_lyrics_empty_segments_raises(tmp_path):
    with pytest.raises(routes.LyricsPersistenceError):
        routes._persist_lyrics(
            tmp_path, {}, [], tmp_path / "song.sloppak", False,
        )


def test_persist_lyrics_partial_reports_dropped(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    count, dropped = routes._persist_lyrics(
        tmp_path, {"schema": 1},
        [
            {"start": 1.0, "end": 1.5, "text": "ok"},
            {"start": "bad", "end": 2, "text": "x"},
            {"start": 3.0, "end": 2.0, "text": "reversed"},
        ],
        tmp_path / "song.sloppak", False,
    )
    assert (count, dropped) == (1, 2)
    assert json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8")) == [
        {"t": 1.0, "d": 0.5, "w": "ok"}
    ]


def test_persist_lyrics_drops_a_finite_pair_whose_duration_overflows(tmp_path):
    # Finite endpoints can still differ by more than a double can hold
    # (-1e308 and 1e308 are both finite, but their difference is inf), so the
    # duration needs its own finiteness check or json.dumps emits bare
    # ``Infinity`` — which the read side then drops.
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    count, dropped = routes._persist_lyrics(
        tmp_path, {"schema": 1},
        [
            {"start": 1.0, "end": 1.5, "text": "ok"},
            {"start": -1e308, "end": 1e308, "text": "overflows"},
        ],
        tmp_path / "song.sloppak", False,
    )
    assert (count, dropped) == (1, 1)
    assert json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8")) == [
        {"t": 1.0, "d": 0.5, "w": "ok"}
    ]


# ── route: rejected saves leave directory-form packs untouched ───────────────

def test_all_invalid_save_rejected_dir_pack_unchanged(tmp_path):
    library = tmp_path / "library"
    # A non-default sidecar name makes a manifest rewrite detectable too.
    pack = library / "song.sloppak"
    _write_pack_dir(pack, lyrics_name="custom_lyrics.json")
    client = _wire_host(routes, tmp_path, library, "test.save_lyrics.dir")

    lyrics_path = pack / "custom_lyrics.json"
    manifest_path = pack / "manifest.yaml"
    before = (_sha256(lyrics_path), _sha256(manifest_path))

    resp = _save(client, [{"start": "bad", "end": 2, "text": "replacement"}])

    assert resp.status_code == 422, resp.text
    assert "error" in resp.json()
    assert (_sha256(lyrics_path), _sha256(manifest_path)) == before
    assert not (pack / "lyrics.json").exists()
    assert json.loads(lyrics_path.read_text(encoding="utf-8")) == ORIGINAL


# ── route: rejected saves leave zip-form packs untouched ─────────────────────

def test_all_invalid_save_rejected_zip_pack_unchanged(tmp_path):
    library = tmp_path / "library"
    pack = library / "song.sloppak"
    _make_zip_pack(pack, lyrics_name="custom_lyrics.json")
    client = _wire_host(routes, tmp_path, library, "test.save_lyrics.zip")

    before = pack.read_bytes()

    resp = _save(client, [{"start": "bad", "end": 2, "text": "replacement"}])

    assert resp.status_code == 422, resp.text
    assert pack.read_bytes() == before
    assert not pack.with_suffix(".sloppak.bak").exists(), "rejected save made a backup"
    with zipfile.ZipFile(pack) as zf:
        assert json.loads(zf.read("custom_lyrics.json")) == ORIGINAL


# ── route: valid and partial-invalid saves still succeed ─────────────────────

def test_valid_save_succeeds_without_dropped_key(tmp_path):
    library = tmp_path / "library"
    pack = library / "song.sloppak"
    _write_pack_dir(pack)
    client = _wire_host(routes, tmp_path, library, "test.save_lyrics.valid")

    resp = _save(client, [
        {"start": 0.0, "end": 0.5, "text": "la"},
        {"start": 0.5, "end": 1.0, "text": "la"},
    ])

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "lyrics_count": 2}
    assert json.loads((pack / "lyrics.json").read_text(encoding="utf-8")) == [
        {"t": 0.0, "d": 0.5, "w": "la"},
        {"t": 0.5, "d": 0.5, "w": "la"},
    ]


def test_partial_invalid_save_writes_valid_entries_and_reports_dropped(tmp_path):
    library = tmp_path / "library"
    pack = library / "song.sloppak"
    _write_pack_dir(pack)
    client = _wire_host(routes, tmp_path, library, "test.save_lyrics.partial")

    resp = _save(client, [
        {"start": 1.0, "end": 1.5, "text": "ok"},
        {"start": "bad", "end": 2, "text": "replacement"},
    ])

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "lyrics_count": 1, "dropped_count": 1}
    assert json.loads((pack / "lyrics.json").read_text(encoding="utf-8")) == [
        {"t": 1.0, "d": 0.5, "w": "ok"}
    ]
