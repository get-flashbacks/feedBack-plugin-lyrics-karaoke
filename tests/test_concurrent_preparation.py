"""Concurrent preparation writes serialize and merge (issue #60).

`/save-lyrics` and `/generate-pitch` used to resolve and capture the manifest
(and, for pitch, the lyrics) *before* taking any lock and then persist that
snapshot. Two overlapping writes therefore each patched a stale manifest, and
one pointer was lost: persist lyrics, then pitch, and the on-disk manifest kept
`vocal_pitch` while dropping `lyrics`. Concurrent writes also shared fixed
`.tmp` filenames.

Preparation writes now take one lock keyed on the *canonical* pack path
(filenames aliasing the same sloppak share it), reload the manifest inside the
lock and merge their own pointer into the live copy, and pitch verifies the
lyrics that drove extraction are still current before committing. These tests
drive overlapping requests through a barrier and pin those guarantees: save vs
pitch, duplicate saves/generations, zip archive integrity, preserved unrelated
metadata, and no leftover temp files.
"""

import asyncio
import json
import sys
import threading
import zipfile
from pathlib import Path

import httpx
import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import routes  # noqa: E402
from tests.test_rollback import _wire_host  # noqa: E402

BASE = "/api/plugins/lyrics_karaoke"

LEAD_LYRICS = [{"t": 0.5, "d": 0.4, "w": "la-"}, {"t": 0.9, "d": 0.5, "w": "la+"}]
PITCH_NOTES = [{"t": 0.5, "d": 0.4, "midi": 64}]


# ── pack builders ────────────────────────────────────────────────────────────


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _read_manifest(pack_dir: Path) -> dict:
    return yaml.safe_load((pack_dir / "manifest.yaml").read_text(encoding="utf-8"))


def _duet_manifest(*, extra: dict | None = None) -> dict:
    """Duet pack with a lead owned lyrics pointer and no pitch pointers at all.

    No ``vocal_pitch`` anywhere means the first pitch write has to *add* a
    pointer rather than overwrite one, so a stale-snapshot clobber is visible.
    """
    manifest = {
        "feedpak_version": "1.0.0",
        "title": "Duet",
        "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": "lead.json",
        "vocal_tracks": [
            {"id": "lead", "name": "Lead", "primary": True, "lyrics": "lead.json"},
            {"id": "harmony", "name": "Harmony"},
        ],
    }
    if extra:
        manifest.update(extra)
    return manifest


def _write_duet_dir(pack_dir: Path, *, extra: dict | None = None) -> None:
    pack_dir.mkdir(parents=True, exist_ok=True)
    _write_json(pack_dir / "lead.json", LEAD_LYRICS)
    (pack_dir / "vocals.wav").write_bytes(b"RIFF" + b"\x00" * 40)
    (pack_dir / "manifest.yaml").write_text(
        yaml.safe_dump(_duet_manifest(extra=extra), sort_keys=False), encoding="utf-8",
    )


def _make_duet_zip(pack_path: Path, *, extra: dict | None = None) -> None:
    src = pack_path.with_suffix("")
    _write_duet_dir(src, extra=extra)
    with zipfile.ZipFile(pack_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(src).as_posix())


def _app(tmp_path: Path, library: Path, name: str):
    """Wire routes into a FastAPI app and return it for in-process HTTP."""
    client = _wire_host(routes, tmp_path, library, name)
    # test_rollback's _wire_host stores config_dir as a str; routes.py treats it
    # as a Path (config.json lookup), so hand it a real Path.
    routes._config_dir = tmp_path
    return client.app


async def _post(ac: httpx.AsyncClient, path: str, body: dict):
    return await ac.post(path, json=body)


# ── canonical identity lock ──────────────────────────────────────────────────


def test_job_lock_for_keys_aliases_to_one_lock(tmp_path):
    real = tmp_path / "song.sloppak"
    real.mkdir()
    alias = tmp_path / "alias.sloppak"
    try:
        alias.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")
    # A filename alias of the same pack must not get its own lock, or the two
    # could each capture a snapshot and clobber the other's manifest pointer.
    assert routes._job_lock_for(real) is routes._job_lock_for(alias)


def test_job_lock_for_distinct_packs_get_distinct_locks(tmp_path):
    one = tmp_path / "one.sloppak"
    two = tmp_path / "two.sloppak"
    one.mkdir()
    two.mkdir()
    assert routes._job_lock_for(one) is not routes._job_lock_for(two)


# ── save vs pitch ────────────────────────────────────────────────────────────


def test_concurrent_save_and_pitch_merge_both_pointers(tmp_path, monkeypatch):
    """The issue's reproduction: a pitch commit using a snapshot taken before a
    save landed must still keep the save's pointer."""
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_dir(pack)
    app = _app(tmp_path, library, "test.concurrent.merge")

    started = threading.Event()
    release = threading.Event()

    def slow_extract(vocals_path, lyrics):
        started.set()
        assert release.wait(timeout=10), "pitch extraction was never released"
        return PITCH_NOTES

    monkeypatch.setattr(routes, "_extract_pitch_per_syllable", slow_extract)
    monkeypatch.setattr(routes, "_get_demucs_server_url", lambda: None)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            pitch = asyncio.create_task(_post(
                ac, f"{BASE}/generate-pitch",
                {"filename": "duet.sloppak", "voice": "lead"},
            ))
            assert await asyncio.to_thread(started.wait, 10)
            save = await _post(
                ac, f"{BASE}/save-lyrics",
                {"filename": "duet.sloppak", "voice": "harmony",
                 "segments": [{"start": 0.0, "end": 0.5, "text": "oh"}]},
            )
            release.set()
            return save, await pitch

    save_resp, pitch_resp = asyncio.run(scenario())
    assert save_resp.status_code == 200, save_resp.text
    assert pitch_resp.status_code == 200, pitch_resp.text
    assert pitch_resp.json()["voice"] == "lead"

    manifest = _read_manifest(pack)
    tracks = {t["id"]: t for t in manifest["vocal_tracks"]}
    # Neither write dropped the other's pointer.
    assert manifest["vocal_pitch"] == "vocal_pitch.json"
    assert tracks["lead"]["vocal_pitch"] == "vocal_pitch.json"
    assert tracks["harmony"]["lyrics"] == "harmony.lyrics.json"
    assert manifest["lyrics"] == "lead.json"
    assert _read_json(pack / "harmony.lyrics.json") == [
        {"t": 0.0, "d": 0.5, "w": "oh"}
    ]
    assert _read_json(pack / "vocal_pitch.json")["notes"] == PITCH_NOTES
    assert not list(pack.glob("*.tmp"))


def test_pitch_rejects_when_lyrics_change_during_extraction(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_dir(pack)
    app = _app(tmp_path, library, "test.concurrent.stale")

    started = threading.Event()
    release = threading.Event()

    def slow_extract(vocals_path, lyrics):
        started.set()
        assert release.wait(timeout=10), "pitch extraction was never released"
        return PITCH_NOTES

    monkeypatch.setattr(routes, "_extract_pitch_per_syllable", slow_extract)
    monkeypatch.setattr(routes, "_get_demucs_server_url", lambda: None)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            pitch = asyncio.create_task(_post(
                ac, f"{BASE}/generate-pitch",
                {"filename": "duet.sloppak", "voice": "lead"},
            ))
            assert await asyncio.to_thread(started.wait, 10)
            save = await _post(
                ac, f"{BASE}/save-lyrics",
                {"filename": "duet.sloppak", "voice": "lead",
                 "segments": [{"start": 0.0, "end": 0.5, "text": "changed"}]},
            )
            release.set()
            return save, await pitch

    save_resp, pitch_resp = asyncio.run(scenario())
    assert save_resp.status_code == 200, save_resp.text
    assert pitch_resp.status_code == 409, pitch_resp.text
    assert "Lyrics changed" in pitch_resp.json()["error"]

    # The new lyrics stand, and the stale pitches were never attached.
    assert _read_json(pack / "lead.json") == [{"t": 0.0, "d": 0.5, "w": "changed"}]
    assert not (pack / "vocal_pitch.json").exists()


# ── duplicate writes ─────────────────────────────────────────────────────────


def test_duplicate_concurrent_saves_serialize(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_dir(pack)
    app = _app(tmp_path, library, "test.concurrent.dupesave")
    monkeypatch.setattr(routes, "_get_demucs_server_url", lambda: None)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            bodies = [
                {"filename": "duet.sloppak", "voice": "harmony",
                 "segments": [{"start": 0.0, "end": 0.5, "text": f"take-{i}"}]}
                for i in range(2)
            ]
            return await asyncio.gather(*(_post(ac, f"{BASE}/save-lyrics", b) for b in bodies))

    responses = asyncio.run(scenario())
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]

    content = _read_json(pack / "harmony.lyrics.json")
    assert content in (
        [{"t": 0.0, "d": 0.5, "w": "take-0"}],
        [{"t": 0.0, "d": 0.5, "w": "take-1"}],
    )
    manifest = _read_manifest(pack)
    tracks = {t["id"]: t for t in manifest["vocal_tracks"]}
    assert tracks["harmony"]["lyrics"] == "harmony.lyrics.json"
    assert not list(pack.glob("*.tmp"))


def test_duplicate_concurrent_generations_serialize(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_dir(pack)
    app = _app(tmp_path, library, "test.concurrent.dupegen")
    monkeypatch.setattr(routes, "_get_demucs_server_url", lambda: None)

    # Both extractions run together (barrier), then both commits serialize.
    barrier = threading.Barrier(2, timeout=10)

    def extract(vocals_path, lyrics):
        barrier.wait()
        return PITCH_NOTES

    monkeypatch.setattr(routes, "_extract_pitch_per_syllable", extract)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            body = {"filename": "duet.sloppak", "voice": "lead"}
            return await asyncio.gather(
                _post(ac, f"{BASE}/generate-pitch", body),
                _post(ac, f"{BASE}/generate-pitch", body),
            )

    responses = asyncio.run(scenario())
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    assert _read_json(pack / "vocal_pitch.json")["notes"] == PITCH_NOTES
    assert not list(pack.glob("*.tmp"))


# ── archive integrity + preserved metadata ───────────────────────────────────


def test_concurrent_writes_keep_zip_archive_intact(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _make_duet_zip(pack)
    app = _app(tmp_path, library, "test.concurrent.zip")

    started = threading.Event()
    release = threading.Event()

    def slow_extract(vocals_path, lyrics):
        started.set()
        assert release.wait(timeout=10), "pitch extraction was never released"
        return PITCH_NOTES

    monkeypatch.setattr(routes, "_extract_pitch_per_syllable", slow_extract)
    monkeypatch.setattr(routes, "_get_demucs_server_url", lambda: None)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            pitch = asyncio.create_task(_post(
                ac, f"{BASE}/generate-pitch",
                {"filename": "duet.sloppak", "voice": "lead"},
            ))
            assert await asyncio.to_thread(started.wait, 10)
            save = await _post(
                ac, f"{BASE}/save-lyrics",
                {"filename": "duet.sloppak", "voice": "harmony",
                 "segments": [{"start": 0.0, "end": 0.5, "text": "oh"}]},
            )
            release.set()
            return save, await pitch

    save_resp, pitch_resp = asyncio.run(scenario())
    assert save_resp.status_code == 200, save_resp.text
    assert pitch_resp.status_code == 200, pitch_resp.text

    with zipfile.ZipFile(pack) as zf:
        assert zf.testzip() is None, "re-zipped archive is corrupt"
        names = set(zf.namelist())
        assert {"manifest.yaml", "lead.json", "vocals.wav"} <= names
        assert "harmony.lyrics.json" in names
        assert "vocal_pitch.json" in names
        manifest = yaml.safe_load(zf.read("manifest.yaml"))
    tracks = {t["id"]: t for t in manifest["vocal_tracks"]}
    assert manifest["vocal_pitch"] == "vocal_pitch.json"
    assert tracks["harmony"]["lyrics"] == "harmony.lyrics.json"
    # The one-time backup of the original archive is itself a valid zip.
    backup = pack.with_suffix(pack.suffix + ".bak")
    assert backup.exists()
    with zipfile.ZipFile(backup) as zf:
        assert zf.testzip() is None


def test_concurrent_writes_preserve_unrelated_metadata(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_dir(pack, extra={"custom": {"keep": [1, 2, 3]}, "duration": 12.5})
    app = _app(tmp_path, library, "test.concurrent.meta")
    monkeypatch.setattr(routes, "_get_demucs_server_url", lambda: None)
    monkeypatch.setattr(
        routes, "_extract_pitch_per_syllable",
        lambda vocals_path, lyrics: PITCH_NOTES,
    )

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            return await asyncio.gather(
                _post(ac, f"{BASE}/save-lyrics",
                      {"filename": "duet.sloppak", "voice": "harmony",
                       "segments": [{"start": 0.0, "end": 0.5, "text": "oh"}]}),
                _post(ac, f"{BASE}/generate-pitch",
                      {"filename": "duet.sloppak", "voice": "lead"}),
            )

    responses = asyncio.run(scenario())
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]

    manifest = _read_manifest(pack)
    assert manifest["custom"] == {"keep": [1, 2, 3]}
    assert manifest["duration"] == 12.5
    assert manifest["vocal_pitch"] == "vocal_pitch.json"
    tracks = {t["id"]: t for t in manifest["vocal_tracks"]}
    assert tracks["harmony"]["lyrics"] == "harmony.lyrics.json"


# ── unit: reload-merge and stale-pitch rejection ─────────────────────────────


def test_persist_lyrics_reloads_and_merges_live_manifest(tmp_path):
    # A concurrent write added a pitch pointer to the on-disk manifest after the
    # caller captured its snapshot; this save must merge, not clobber it.
    (tmp_path / "manifest.yaml").write_text(
        yaml.safe_dump({"schema": 1, "vocal_pitch": "vocal_pitch.json"}, sort_keys=False),
        encoding="utf-8",
    )
    stale_snapshot = {"schema": 1}

    routes._persist_lyrics(
        tmp_path, stale_snapshot,
        [{"start": 0.0, "end": 0.5, "text": "la"}],
        tmp_path / "song.sloppak", False,
    )

    on_disk = routes._read_manifest(tmp_path)
    assert on_disk["vocal_pitch"] == "vocal_pitch.json"  # preserved, not lost
    assert on_disk["lyrics"] == "lyrics.json"
    # The caller's snapshot is refreshed to the committed state.
    assert stale_snapshot["vocal_pitch"] == "vocal_pitch.json"


def test_persist_pitch_rejects_stale_lyrics_snapshot(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    manifest = {"schema": 1, "lyrics": "lyrics.json"}
    _write_json(tmp_path / "lyrics.json", [{"t": 0.5, "d": 0.4, "w": "old"}])
    target = routes._resolve_voice_target(tmp_path, manifest)
    stale_hash = routes._lyrics_content_hash(tmp_path, target.lyrics_rel)
    assert stale_hash is not None

    # A save replaces the lyrics after the snapshot was taken.
    _write_json(tmp_path / "lyrics.json", [{"t": 0.0, "d": 0.5, "w": "new"}])

    with pytest.raises(routes.StalePitchError) as excinfo:
        routes._persist_pitch(
            tmp_path, manifest, PITCH_NOTES,
            tmp_path / "song.sloppak", False, target=target,
            expected_lyrics_hash=stale_hash,
        )
    assert excinfo.value.status == 409
    assert not (tmp_path / "vocal_pitch.json").exists()


def test_persist_pitch_commits_when_lyrics_still_current(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    manifest = {"schema": 1, "lyrics": "lyrics.json"}
    _write_json(tmp_path / "lyrics.json", [{"t": 0.5, "d": 0.4, "w": "la"}])
    target = routes._resolve_voice_target(tmp_path, manifest)
    live_hash = routes._lyrics_content_hash(tmp_path, target.lyrics_rel)

    routes._persist_pitch(
        tmp_path, manifest, PITCH_NOTES,
        tmp_path / "song.sloppak", False, target=target,
        expected_lyrics_hash=live_hash,
    )
    assert _read_json(tmp_path / "vocal_pitch.json")["notes"] == PITCH_NOTES
