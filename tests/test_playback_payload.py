"""Canonical multi-voice playback payload: `_build_playback_payload` /
`_canonical_voice_tokens` / `_read_json_strict` (issue #13).

Covers the fixtures called out in the issue: one singer with complete
pitch, lyrics-only content, invalid numeric values, malformed paths,
missing side files, and legacy files produced by the current plugin.
"""

import json
import logging

import pytest
from fastapi import FastAPI

import routes


# ── _read_json_strict ───────────────────────────────────────────────────────

def test_read_json_strict_none_when_path_is_none():
    assert routes._read_json_strict(None, what="x") is None


def test_read_json_strict_none_when_missing(tmp_path):
    assert routes._read_json_strict(tmp_path / "missing.json", what="x") is None


def test_read_json_strict_raises_422_on_corrupt_json(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(routes.PlaybackPayloadError) as exc_info:
        routes._read_json_strict(p, what="thing.json")
    assert exc_info.value.status == 422
    assert "thing.json" in exc_info.value.message


# ── _canonical_voice_tokens ─────────────────────────────────────────────────

def test_canonical_voice_tokens_one_singer_complete_pitch(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "hel"},
        {"t": 1.5, "d": 0.5, "w": "lo"},
    ]), encoding="utf-8")
    (tmp_path / "vocal_pitch.json").write_text(json.dumps({
        "version": 1,
        "notes": [{"t": 1.0, "d": 0.5, "midi": 60}, {"t": 1.5, "d": 0.5, "midi": 62}],
    }), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"}

    tokens = routes._canonical_voice_tokens(tmp_path, manifest)

    assert tokens == [
        {"start": 1.0, "duration": 0.5, "text": "hel", "midi": 60},
        {"start": 1.5, "duration": 0.5, "text": "lo", "midi": 62},
    ]


def test_canonical_voice_tokens_lyrics_only_no_pitch_file(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 2.0, "d": 0.5, "w": "hey"},
    ]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}  # no vocal_pitch key at all

    tokens = routes._canonical_voice_tokens(tmp_path, manifest)

    assert tokens == [{"start": 2.0, "duration": 0.5, "text": "hey"}]
    assert "midi" not in tokens[0]


def test_canonical_voice_tokens_sorts_out_of_order_input(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 3.0, "d": 0.5, "w": "second"},
        {"t": 1.0, "d": 0.5, "w": "first"},
    ]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}

    tokens = routes._canonical_voice_tokens(tmp_path, manifest)

    assert [t["text"] for t in tokens] == ["first", "second"]


def test_canonical_voice_tokens_drops_invalid_numeric_values(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "ok"},
        {"t": "Infinity", "d": 0.5, "w": "bad-t"},
        {"t": 2.0, "d": -1.0, "w": "bad-negative-d"},
        {"t": "not-a-number", "d": 0.5, "w": "bad-nonnumeric-t"},
        "not a dict",
    ]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}

    tokens = routes._canonical_voice_tokens(tmp_path, manifest)

    assert tokens == [{"start": 1.0, "duration": 0.5, "text": "ok"}]


def test_canonical_voice_tokens_keeps_zero_duration_token(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.0, "w": "cue"},
    ]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}

    tokens = routes._canonical_voice_tokens(tmp_path, manifest)

    assert tokens == [{"start": 1.0, "duration": 0.0, "text": "cue"}]


def test_canonical_voice_tokens_malformed_manifest_path_treated_as_absent(tmp_path):
    # Path traversal / absolute-path manifest values resolve to None via
    # _safe_source_path — treated the same as "file missing", not an error.
    manifest = {"lyrics": "../../etc/passwd"}
    assert routes._canonical_voice_tokens(tmp_path, manifest) == []


def test_canonical_voice_tokens_missing_side_files_yield_empty(tmp_path):
    manifest = {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"}
    assert routes._canonical_voice_tokens(tmp_path, manifest) == []


def test_canonical_voice_tokens_raises_422_on_corrupt_lyrics_json(tmp_path):
    (tmp_path / "lyrics.json").write_text("{not json", encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}
    with pytest.raises(routes.PlaybackPayloadError) as exc_info:
        routes._canonical_voice_tokens(tmp_path, manifest)
    assert exc_info.value.status == 422


def test_canonical_voice_tokens_raises_422_when_lyrics_json_not_a_list(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps({"not": "a list"}), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}
    with pytest.raises(routes.PlaybackPayloadError):
        routes._canonical_voice_tokens(tmp_path, manifest)


def test_canonical_voice_tokens_raises_422_when_vocal_pitch_not_a_dict(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([{"t": 1.0, "d": 0.5, "w": "x"}]), encoding="utf-8")
    (tmp_path / "vocal_pitch.json").write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"}
    with pytest.raises(routes.PlaybackPayloadError):
        routes._canonical_voice_tokens(tmp_path, manifest)


def test_canonical_voice_tokens_legacy_pack_files_still_parse(tmp_path):
    # Shape produced by _persist_lyrics / _persist_pitch today.
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 0.0, "d": 0.5, "w": "hel"},
        {"t": 0.5, "d": 0.5, "w": "lo"},
    ]), encoding="utf-8")
    (tmp_path / "vocal_pitch.json").write_text(json.dumps({
        "version": 1,
        "notes": [{"t": 0.0, "d": 0.5, "midi": 60}],
    }), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"}

    tokens = routes._canonical_voice_tokens(tmp_path, manifest)

    assert tokens[0] == {"start": 0.0, "duration": 0.5, "text": "hel", "midi": 60}
    assert tokens[1] == {"start": 0.5, "duration": 0.5, "text": "lo"}


# ── _build_playback_payload ─────────────────────────────────────────────────

def test_build_playback_payload_shape_with_tokens(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([{"t": 0.0, "d": 0.5, "w": "hi"}]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}

    payload = routes._build_playback_payload("song.sloppak", tmp_path, manifest)

    assert payload["schema_version"] == routes.PLAYBACK_SCHEMA_VERSION
    assert payload["song"] == {"filename": "song.sloppak"}
    assert payload["arrangement"] == {"index": None}
    assert len(payload["voices"]) == 1
    voice = payload["voices"][0]
    assert voice["id"] == "primary"
    assert voice["primary"] is True
    assert voice["tokens"] == [{"start": 0.0, "duration": 0.5, "text": "hi"}]


def test_build_playback_payload_empty_voices_when_no_lyrics(tmp_path):
    payload = routes._build_playback_payload("song.sloppak", tmp_path, {})
    assert payload["voices"] == []


def test_build_playback_payload_is_deterministic(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 2.0, "d": 0.5, "w": "b"},
        {"t": 1.0, "d": 0.5, "w": "a"},
    ]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}

    first = routes._build_playback_payload("song.sloppak", tmp_path, manifest)
    second = routes._build_playback_payload("song.sloppak", tmp_path, manifest)

    assert first == second


# ── GET /playback route (HTTP mapping) ──────────────────────────────────────
#
# No fastapi.testclient/httpx dependency in this plugin's requirements, so
# these call the registered endpoint function directly (FastAPI keeps the
# plain callable on `route.endpoint`) rather than spinning up an ASGI
# client — enough to pin the status-code mapping the review asked for
# without adding test-only runtime dependencies.

def _playback_endpoint(tmp_path):
    app = FastAPI()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: tmp_path,
        "log": logging.getLogger("test.lyrics_karaoke.playback"),
    })
    for route in app.routes:
        if getattr(route, "path", "") == "/api/plugins/lyrics_karaoke/playback":
            return route.endpoint
    raise AssertionError("playback route not registered")


def test_playback_route_404_when_not_a_sloppak(tmp_path, monkeypatch):
    endpoint = _playback_endpoint(tmp_path)
    monkeypatch.setattr(routes, "_resolve_sloppak", lambda filename: None)

    response = endpoint(filename="missing.sloppak")

    assert response.status_code == 404


def test_playback_route_404_when_no_lyrics(tmp_path, monkeypatch):
    endpoint = _playback_endpoint(tmp_path)
    monkeypatch.setattr(routes, "_resolve_sloppak", lambda filename: (tmp_path, {}, tmp_path, False))

    response = endpoint(filename="song.sloppak")

    assert response.status_code == 404


def test_playback_route_422_on_corrupt_side_file(tmp_path, monkeypatch):
    (tmp_path / "lyrics.json").write_text("{not json", encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}
    endpoint = _playback_endpoint(tmp_path)
    monkeypatch.setattr(routes, "_resolve_sloppak", lambda filename: (tmp_path, manifest, tmp_path, False))

    response = endpoint(filename="song.sloppak")

    assert response.status_code == 422


def test_playback_route_200_with_payload(tmp_path, monkeypatch):
    (tmp_path / "lyrics.json").write_text(json.dumps([{"t": 0.0, "d": 0.5, "w": "hi"}]), encoding="utf-8")
    manifest = {"lyrics": "lyrics.json"}
    endpoint = _playback_endpoint(tmp_path)
    monkeypatch.setattr(routes, "_resolve_sloppak", lambda filename: (tmp_path, manifest, tmp_path, False))

    payload = endpoint(filename="song.sloppak")

    assert payload["schema_version"] == routes.PLAYBACK_SCHEMA_VERSION
    assert payload["voices"][0]["tokens"] == [{"start": 0.0, "duration": 0.5, "text": "hi"}]
