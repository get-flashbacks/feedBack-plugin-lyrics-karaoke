"""Voice-targeted preparation for duet (``vocal_tracks``) packs (#61).

The bug this pins: `_persist_lyrics`/`_persist_pitch` wrote the hardcoded
``lyrics.json``/``vocal_pitch.json`` and patched only the singular manifest
alias, so a duet save reported success while `/playback` — which reads each
track's own ``lyrics``/``vocal_pitch`` pointer — kept serving the primary's
stale sidecar. The fix resolves an explicit, validated voice target and writes
that track's own files, keeping the singular aliases in sync for the primary
voice only.

Route-level coverage uses `_wire_host`/`_sha256` from `tests/test_rollback.py`
against directory-form duet packs.
"""

import json
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import routes  # noqa: E402
from tests.test_rollback import _sha256, _wire_host  # noqa: E402

BASE = "/api/plugins/lyrics_karaoke"

LEAD_LYRICS = [{"t": 0.5, "d": 0.4, "w": "la-"}, {"t": 0.9, "d": 0.5, "w": "la+"}]
LEAD_PITCH = {"version": 1, "notes": [
    {"t": 0.5, "d": 0.4, "midi": 60},
    {"t": 0.9, "d": 0.5, "midi": 62},
]}
HARMONY_LYRICS = [{"t": 0.5, "d": 0.9, "w": "oh+"}]
HARMONY_PITCH = {"version": 1, "notes": [{"t": 0.5, "d": 0.9, "midi": 55}]}
NEW_SEGMENTS = [{"start": 0.0, "end": 0.5, "text": "new"}]


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _read_manifest(pack_dir: Path) -> dict:
    return yaml.safe_load((pack_dir / "manifest.yaml").read_text(encoding="utf-8"))


def _client(tmp_path: Path, library: Path, name: str):
    client = _wire_host(routes, tmp_path, library, name)
    # test_rollback's _wire_host wires config_dir as a str, but routes.py types
    # it as a Path (_get_demucs_server_url does `config_dir / "config.json"`).
    routes._config_dir = tmp_path
    return client


def _write_duet_pack(pack_dir: Path, *, singular_lyrics="lead.json", singular_pitch="lead_pitch.json",
                     harmony_files=True) -> None:
    pack_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "feedpak_version": "1.0.0",
        "title": "Duet",
        "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": singular_lyrics,
        "vocal_pitch": singular_pitch,
        "vocal_tracks": [
            {"id": "lead", "name": "Lead", "primary": True,
             "lyrics": "lead.json", "vocal_pitch": "lead_pitch.json"},
            {"id": "harmony", "name": "Harmony",
             "lyrics": "harmony.json", "vocal_pitch": "harmony_pitch.json"},
        ],
    }
    _write_json(pack_dir / "lead.json", LEAD_LYRICS)
    _write_json(pack_dir / "lead_pitch.json", LEAD_PITCH)
    if harmony_files:
        _write_json(pack_dir / "harmony.json", HARMONY_LYRICS)
        _write_json(pack_dir / "harmony_pitch.json", HARMONY_PITCH)
    (pack_dir / "vocals.wav").write_bytes(b"RIFF" + b"\x00" * 40)
    (pack_dir / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8",
    )


def _write_solo_pack(pack_dir: Path) -> None:
    pack_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "feedpak_version": "1.0.0",
        "title": "Solo",
        "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": "lyrics.json",
        "vocal_pitch": "vocal_pitch.json",
    }
    _write_json(pack_dir / "lyrics.json", LEAD_LYRICS)
    _write_json(pack_dir / "vocal_pitch.json", LEAD_PITCH)
    (pack_dir / "vocals.wav").write_bytes(b"RIFF" + b"\x00" * 40)
    (pack_dir / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8",
    )


def _write_scaffold(pack_dir: Path, manifest: dict, files: dict) -> None:
    """Directory-form pack from a manifest dict plus ``{name: json_payload}``."""
    pack_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        _write_json(pack_dir / name, payload)
    (pack_dir / "vocals.wav").write_bytes(b"RIFF" + b"\x00" * 40)
    (pack_dir / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8",
    )


# ── /save-lyrics ─────────────────────────────────────────────────────────────


def test_save_lyrics_secondary_writes_only_its_own_sidecar(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack)
    client = _client(tmp_path, library, "test.voice.secondary")

    manifest_before = _sha256(pack / "manifest.yaml")
    lead_before = _sha256(pack / "lead.json")

    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "duet.sloppak", "segments": NEW_SEGMENTS, "voice": "harmony"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["voice"] == "harmony"

    # The selected track's own sidecar is the one written.
    assert _read_json(pack / "harmony.json") == [{"t": 0.0, "d": 0.5, "w": "new"}]
    # The primary's sidecar and the singular aliases are untouched.
    assert _sha256(pack / "lead.json") == lead_before
    assert _read_manifest(pack)["lyrics"] == "lead.json"
    assert _sha256(pack / "manifest.yaml") == manifest_before
    # The old hardcoded filename is never created for a duet voice.
    assert not (pack / "lyrics.json").exists()

    # /playback now serves the replacement for the harmony voice.
    playback = client.get(f"{BASE}/playback", params={"filename": "duet.sloppak"})
    assert playback.status_code == 200, playback.text
    voices = {v["id"]: v for v in playback.json()["voices"]}
    assert [t["text"] for t in voices["harmony"]["tokens"]] == ["new"]
    assert [t["text"] for t in voices["lead"]["tokens"]] == ["la-", "la+"]


def test_save_lyrics_primary_uses_track_file_not_hardcoded_name(tmp_path):
    # The issue's exact reproduction: singular alias and the primary track both
    # point at lead.json, and the old code still wrote lyrics.json.
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack, singular_lyrics="lead.json")
    client = _client(tmp_path, library, "test.voice.primary")

    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "duet.sloppak", "segments": NEW_SEGMENTS, "voice": "lead"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["voice"] == "lead"

    assert _read_json(pack / "lead.json") == [{"t": 0.0, "d": 0.5, "w": "new"}]
    assert not (pack / "lyrics.json").exists()
    assert _read_manifest(pack)["lyrics"] == "lead.json"


def test_save_lyrics_primary_syncs_singular_alias(tmp_path):
    # A drifted alias (singular points somewhere other than the primary track)
    # is corrected when the primary is prepared.
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack, singular_lyrics="stale.json")
    _write_json(pack / "stale.json", [{"t": 0.0, "d": 1.0, "w": "stale"}])
    client = _client(tmp_path, library, "test.voice.alias")

    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "duet.sloppak", "segments": NEW_SEGMENTS, "voice": "lead"},
    )
    assert resp.status_code == 200, resp.text
    manifest = _read_manifest(pack)
    assert manifest["lyrics"] == "lead.json"
    # The stale file the alias pointed at is left alone — the pointer moved,
    # the old bytes were never the primary's.
    assert _read_json(pack / "stale.json") == [{"t": 0.0, "d": 1.0, "w": "stale"}]


def test_save_lyrics_unknown_voice_is_rejected_without_writing(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack)
    client = _client(tmp_path, library, "test.voice.unknown")

    before = {(p.name): _sha256(p) for p in pack.iterdir() if p.is_file()}
    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "duet.sloppak", "segments": NEW_SEGMENTS, "voice": "ghost"},
    )
    assert resp.status_code == 422, resp.text
    assert "ghost" in resp.json()["error"]
    after = {(p.name): _sha256(p) for p in pack.iterdir() if p.is_file()}
    assert after == before


def test_save_lyrics_duplicate_ids_are_rejected(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "dupes.sloppak"
    _write_duet_pack(pack)
    manifest = _read_manifest(pack)
    manifest["vocal_tracks"][1]["id"] = "lead"
    (pack / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8",
    )
    client = _client(tmp_path, library, "test.voice.dupes")

    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "dupes.sloppak", "segments": NEW_SEGMENTS},
    )
    assert resp.status_code == 422, resp.text
    assert "Duplicate" in resp.json()["error"]

    status = client.get(f"{BASE}/status", params={"filename": "dupes.sloppak"})
    assert status.status_code == 422, status.text


# ── /status ──────────────────────────────────────────────────────────────────


def test_status_reports_voices_and_per_voice_flags(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack, harmony_files=False)
    client = _client(tmp_path, library, "test.voice.status")

    lead = client.get(f"{BASE}/status", params={"filename": "duet.sloppak"}).json()
    assert lead["voice"] == "lead"
    assert lead["has_lyrics"] and lead["has_pitch"]
    assert [v["id"] for v in lead["voices"]] == ["lead", "harmony"]
    assert lead["voices"][0]["primary"] is True
    assert lead["voices"][1]["primary"] is False

    harmony = client.get(
        f"{BASE}/status", params={"filename": "duet.sloppak", "voice": "harmony"},
    ).json()
    assert harmony["voice"] == "harmony"
    # The harmony voice has no sidecars yet, so its flags differ from lead's.
    assert harmony["has_lyrics"] is False
    assert harmony["has_pitch"] is False


def test_status_unknown_voice_is_rejected(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack)
    client = _client(tmp_path, library, "test.voice.status.unknown")

    resp = client.get(f"{BASE}/status", params={"filename": "duet.sloppak", "voice": "nope"})
    assert resp.status_code == 422, resp.text


# ── /generate-pitch ──────────────────────────────────────────────────────────


def test_generate_pitch_targets_secondary(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack)
    client = _client(tmp_path, library, "test.voice.pitch")

    # Swap the heavy extractor for a deterministic stub; the harmony voice's
    # own lyrics drive the syllable count, and its own pointer is written.
    monkeypatch.setattr(
        routes, "_extract_pitch_per_syllable",
        lambda vocab_path, lyrics: [{"t": 0.5, "d": 0.9, "midi": 57}],
    )
    lead_before = _sha256(pack / "lead_pitch.json")

    resp = client.post(
        f"{BASE}/generate-pitch",
        json={"filename": "duet.sloppak", "voice": "harmony"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["voice"] == "harmony"
    assert resp.json()["notes_count"] == 1

    assert _read_json(pack / "harmony_pitch.json")["notes"] == [
        {"t": 0.5, "d": 0.9, "midi": 57},
    ]
    assert _sha256(pack / "lead_pitch.json") == lead_before
    assert not (pack / "vocal_pitch.json").exists()

    playback = client.get(f"{BASE}/playback", params={"filename": "duet.sloppak"}).json()
    harmony = next(v for v in playback["voices"] if v["id"] == "harmony")
    assert harmony["tokens"][0]["midi"] == 57


def test_generate_pitch_unknown_voice_is_rejected(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_duet_pack(pack)
    client = _client(tmp_path, library, "test.voice.pitch.unknown")

    resp = client.post(
        f"{BASE}/generate-pitch",
        json={"filename": "duet.sloppak", "voice": "ghost"},
    )
    assert resp.status_code == 422, resp.text


# ── Solo compatibility ───────────────────────────────────────────────────────


def test_solo_pack_keeps_legacy_filenames_and_voice(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "solo.sloppak"
    _write_solo_pack(pack)
    client = _client(tmp_path, library, "test.voice.solo")

    status = client.get(f"{BASE}/status", params={"filename": "solo.sloppak"}).json()
    assert status["voice"] == "primary"
    assert status["voices"] == [{"id": "primary", "name": "Vocals", "primary": True}]

    # No voice param → the legacy hardcoded sidecar and alias are used.
    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "solo.sloppak", "segments": NEW_SEGMENTS},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["voice"] == "primary"
    assert _read_json(pack / "lyrics.json") == [{"t": 0.0, "d": 0.5, "w": "new"}]
    assert _read_manifest(pack)["lyrics"] == "lyrics.json"


# ── Unit: target resolution ──────────────────────────────────────────────────


def test_resolve_voice_target_defaults_to_primary(tmp_path):
    manifest = {
        "vocal_tracks": [
            {"id": "harmony", "lyrics": "harmony.json"},
            {"id": "lead", "primary": True, "lyrics": "lead.json"},
        ],
    }
    target = routes._resolve_voice_target(tmp_path, manifest)
    assert target.id == "lead"
    assert target.primary is True
    assert target.solo is False


def test_resolve_voice_target_rejects_unknown_and_duplicate(tmp_path):
    with pytest.raises(routes.VoiceTargetError) as exc:
        routes._resolve_voice_target(tmp_path, {"vocal_tracks": [{"id": "lead"}]}, "ghost")
    assert exc.value.status == 422

    dupes = {"vocal_tracks": [{"id": "lead"}, {"id": "lead"}]}
    with pytest.raises(routes.VoiceTargetError):
        routes._resolve_voice_target(tmp_path, dupes)


def test_resolve_voice_target_ignores_unsafe_pointer(tmp_path):
    manifest = {
        "vocal_tracks": [
            {"id": "lead", "primary": True},
            {"id": "harmony", "lyrics": "../escape.json", "vocal_pitch": "/etc/passwd"},
        ],
    }
    target = routes._resolve_voice_target(tmp_path, manifest, "harmony")
    assert target.lyrics_rel == "harmony.lyrics.json"
    assert target.pitch_rel == "harmony.vocal_pitch.json"


# ── Review-driven coverage: blank-id parity, slug collisions, solo aliases ───


def test_status_blank_id_default_mirrors_playback_when_first_track_unprepared(tmp_path):
    # The first track has no lyrics yet, so /playback can only serve the
    # second — which gets the fallback id v1. /status must number it the same
    # way and default to that renderable track, not the unprepared first entry.
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_scaffold(pack, {
        "feedpak_version": "1.0.0", "title": "Duet", "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": "lead.json", "vocal_pitch": "lead_pitch.json",
        "vocal_tracks": [
            {"id": "", "name": "New", "lyrics": "missing.json"},
            {"id": "", "name": "Lead", "lyrics": "lead.json",
             "vocal_pitch": "lead_pitch.json"},
        ],
    }, {
        "lead.json": LEAD_LYRICS,
        "lead_pitch.json": LEAD_PITCH,
    })
    client = _client(tmp_path, library, "test.voice.blank.primary")

    status = client.get(f"{BASE}/status", params={"filename": "duet.sloppak"})
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["voice"] == "v1"
    assert [v["id"] for v in body["voices"]] == ["v1", "v2"]
    assert body["has_lyrics"] is True and body["has_pitch"] is True


def test_status_blank_unprepared_track_does_not_collide_with_explicit_id(tmp_path):
    # Regression: the old fallback numbered the unprepared blank-id track v1,
    # clashing with the second track's explicit v1 and 422ing every prep route
    # even though /playback serves the pack fine.
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "duet.sloppak"
    _write_scaffold(pack, {
        "feedpak_version": "1.0.0", "title": "Duet", "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": "lead.json", "vocal_pitch": "lead_pitch.json",
        "vocal_tracks": [
            {"id": "", "name": "New", "lyrics": "missing.json"},
            {"id": "v1", "name": "Lead", "lyrics": "lead.json",
             "vocal_pitch": "lead_pitch.json"},
        ],
    }, {
        "lead.json": LEAD_LYRICS,
        "lead_pitch.json": LEAD_PITCH,
    })
    client = _client(tmp_path, library, "test.voice.blank.v1")

    status = client.get(f"{BASE}/status", params={"filename": "duet.sloppak"})
    assert status.status_code == 200, status.text
    body = status.json()
    assert body["voice"] == "v1"
    assert [v["id"] for v in body["voices"]] == ["v1", "v2"]


def test_resolve_voice_target_uniquifies_colliding_default_sidecars(tmp_path):
    # Distinct ids that slug to the same text (a/b and a_b) must not share a
    # default sidecar, or preparing one secondary would overwrite the other.
    manifest = {
        "vocal_tracks": [
            {"id": "lead", "primary": True,
             "lyrics": "lead.json", "vocal_pitch": "lead_pitch.json"},
            {"id": "a/b"},
            {"id": "a_b"},
        ],
    }
    first = routes._resolve_voice_target(tmp_path, manifest, "a/b")
    second = routes._resolve_voice_target(tmp_path, manifest, "a_b")
    assert first.lyrics_rel != second.lyrics_rel
    assert first.lyrics_rel == "a_b.lyrics.json"
    assert first.pitch_rel == "a_b.vocal_pitch.json"
    assert second.lyrics_rel == "a_b-2.lyrics.json"
    assert second.pitch_rel == "a_b-2.vocal_pitch.json"


def test_solo_pack_status_and_save_honor_custom_manifest_alias(tmp_path):
    # A solo pack whose legacy singular pointers name custom files: /status
    # and /save-lyrics must use the declared pointer (the pre-PR read path
    # honored the alias), not the hardcoded lyrics.json.
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "solo.sloppak"
    _write_scaffold(pack, {
        "feedpak_version": "1.0.0", "title": "Solo", "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": "custom.json", "vocal_pitch": "custom_pitch.json",
    }, {
        "custom.json": LEAD_LYRICS,
        "custom_pitch.json": LEAD_PITCH,
    })
    client = _client(tmp_path, library, "test.voice.solo.alias")

    status = client.get(f"{BASE}/status", params={"filename": "solo.sloppak"}).json()
    assert status["voice"] == "primary"
    assert status["has_lyrics"] is True
    assert status["has_pitch"] is True
    assert status["pitch_count"] == 2

    resp = client.post(
        f"{BASE}/save-lyrics",
        json={"filename": "solo.sloppak", "segments": NEW_SEGMENTS},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["voice"] == "primary"
    assert _read_json(pack / "custom.json") == [{"t": 0.0, "d": 0.5, "w": "new"}]
    assert not (pack / "lyrics.json").exists()
    assert _read_manifest(pack)["lyrics"] == "custom.json"


def test_generate_pitch_solo_honors_custom_manifest_alias(tmp_path, monkeypatch):
    # The pitch gate reads the resolved target's lyrics; for a solo pack that
    # must be the declared alias, or this regresses to "No synced lyrics".
    library = tmp_path / "library"
    library.mkdir()
    pack = library / "solo.sloppak"
    _write_scaffold(pack, {
        "feedpak_version": "1.0.0", "title": "Solo", "artist": "CI",
        "stems": [{"id": "vocals", "file": "vocals.wav", "default": True}],
        "lyrics": "custom.json", "vocal_pitch": "custom_pitch.json",
    }, {
        "custom.json": LEAD_LYRICS,
    })
    monkeypatch.setattr(
        routes, "_extract_pitch_per_syllable",
        lambda vocab_path, lyrics: [{"t": 0.5, "d": 0.4, "midi": 60}],
    )
    client = _client(tmp_path, library, "test.voice.solo.alias.pitch")

    resp = client.post(
        f"{BASE}/generate-pitch",
        json={"filename": "solo.sloppak"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["voice"] == "primary"
    assert _read_json(pack / "custom_pitch.json")["notes"] == [
        {"t": 0.5, "d": 0.4, "midi": 60},
    ]
    assert not (pack / "vocal_pitch.json").exists()
