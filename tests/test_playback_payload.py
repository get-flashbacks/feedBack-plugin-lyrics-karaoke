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
    # `id`/`name` joined `index` when the route learned to label a payload
    # with the arrangement it was requested for; an unlabelled payload (no
    # index passed) keeps all three null.
    assert payload["arrangement"] == {"index": None, "id": None, "name": None}
    assert len(payload["voices"]) == 1
    voice = payload["voices"][0]
    assert voice["id"] == "primary"
    assert voice["primary"] is True
    assert voice["tokens"] == [{"start": 0.0, "duration": 0.5, "text": "hi"}]


def test_build_playback_payload_empty_voices_when_no_lyrics(tmp_path):
    payload = routes._build_playback_payload("song.sloppak", tmp_path, {})
    assert payload["voices"] == []


def test_build_playback_payload_reads_duet_vocal_tracks(tmp_path):
    (tmp_path / "lead_lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "lead"},
    ]), encoding="utf-8")
    (tmp_path / "lead_pitch.json").write_text(json.dumps({
        "version": 1, "notes": [{"t": 1.0, "d": 0.5, "midi": 60}],
    }), encoding="utf-8")
    (tmp_path / "harmony_lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "harm"},
    ]), encoding="utf-8")
    (tmp_path / "harmony_pitch.json").write_text(json.dumps({
        "version": 1, "notes": [{"t": 1.0, "d": 0.5, "midi": 67}],
    }), encoding="utf-8")
    manifest = {
        # Back-compat aliases remain valid for older readers but must not be
        # duplicated into the canonical multi-voice response.
        "lyrics": "lead_lyrics.json",
        "vocal_pitch": "lead_pitch.json",
        "vocal_tracks": [
            {"id": "lead", "name": "Lead", "primary": True,
             "lyrics": "lead_lyrics.json", "vocal_pitch": "lead_pitch.json"},
            {"id": "harmony", "name": "Harmony",
             "lyrics": "harmony_lyrics.json", "vocal_pitch": "harmony_pitch.json"},
        ],
    }

    payload = routes._build_playback_payload("duet.feedpak", tmp_path, manifest)

    assert [v["id"] for v in payload["voices"]] == ["lead", "harmony"]
    assert [v["primary"] for v in payload["voices"]] == [True, False]
    assert payload["voices"][0]["tokens"][0]["midi"] == 60
    assert payload["voices"][1]["tokens"][0]["midi"] == 67


def _write_lyrics_only_tracks(tmp_path, names):
    """Write a minimal single-syllable lyrics.json for each name in
    ``names`` (used as both the filename stem and the sung word) — shared
    setup for the ``vocal_tracks`` primary/dedup tests below, which only
    care about track identity, not token content."""
    for name in names:
        (tmp_path / f"{name}.json").write_text(json.dumps([
            {"t": 0.0, "d": 1.0, "w": name},
        ]), encoding="utf-8")


def test_duet_first_usable_voice_becomes_primary_and_extra_flags_are_cleared(tmp_path):
    _write_lyrics_only_tracks(tmp_path, ("a", "b"))
    manifest = {"vocal_tracks": [
        {"id": "a", "primary": True, "lyrics": "a.json"},
        {"id": "b", "primary": True, "lyrics": "b.json"},
    ]}

    voices = routes._canonical_voices(tmp_path, manifest)

    assert [v["primary"] for v in voices] == [True, False]


def test_duet_rejects_duplicate_voice_ids(tmp_path):
    _write_lyrics_only_tracks(tmp_path, ("a", "b"))
    manifest = {"vocal_tracks": [
        {"id": "same", "lyrics": "a.json"},
        {"id": "same", "lyrics": "b.json"},
    ]}

    with pytest.raises(routes.PlaybackPayloadError) as exc_info:
        routes._canonical_voices(tmp_path, manifest)
    assert exc_info.value.status == 422
    assert "Duplicate vocal track id" in exc_info.value.message


def test_empty_vocal_tracks_fall_back_to_singular_aliases(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 0.0, "d": 1.0, "w": "solo"},
    ]), encoding="utf-8")
    manifest = {
        "lyrics": "lyrics.json",
        "vocal_tracks": [{"id": "empty", "lyrics": "missing.json"}],
    }

    voices = routes._canonical_voices(tmp_path, manifest)

    assert len(voices) == 1
    assert voices[0]["id"] == "primary"
    assert voices[0]["tokens"][0]["text"] == "solo"


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


# ── _arrangement_identity (#13: "arrangement identity") ─────────────────────

_ARRS = [
    {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
    {"id": "vocals", "name": "Vocals", "file": "arrangements/vocals.json"},
]


def test_arrangement_identity_none_index_is_unlabelled():
    assert routes._arrangement_identity({"arrangements": _ARRS}, None) == {
        "index": None, "id": None, "name": None,
    }


def test_arrangement_identity_resolves_index_to_id_and_name():
    assert routes._arrangement_identity({"arrangements": _ARRS}, 1) == {
        "index": 1, "id": "vocals", "name": "Vocals",
    }


def test_arrangement_identity_name_defaults_to_id_per_spec():
    # feedpak-spec §5.2: `name` defaults to `id` when absent.
    manifest = {"arrangements": [{"id": "lead", "file": "a.json"}]}
    assert routes._arrangement_identity(manifest, 0) == {
        "index": 0, "id": "lead", "name": "lead",
    }


def test_arrangement_identity_out_of_range_echoes_index_only():
    assert routes._arrangement_identity({"arrangements": _ARRS}, 7) == {
        "index": 7, "id": None, "name": None,
    }


@pytest.mark.parametrize("manifest", [
    {},                                  # no arrangements key at all
    {"arrangements": "not-a-list"},      # malformed type
    {"arrangements": ["not-a-dict"]},    # malformed entry
    {"arrangements": [{"name": "No id"}]},  # entry without an id
])
def test_arrangement_identity_tolerates_malformed_manifests(manifest):
    ident = routes._arrangement_identity(manifest, 0)
    assert ident["index"] == 0
    assert ident["id"] is None


def test_arrangement_identity_rejects_bool_index_shaped_values():
    # `True` is an int subclass in Python; an id of `True` must not stringify
    # into "True" and masquerade as a real arrangement id.
    manifest = {"arrangements": [{"id": True, "name": False}]}
    assert routes._arrangement_identity(manifest, 0) == {
        "index": 0, "id": None, "name": None,
    }


def test_build_playback_payload_carries_arrangement_identity(tmp_path):
    (tmp_path / "lyrics.json").write_text(
        json.dumps([{"t": 0.0, "d": 0.5, "w": "hi"}]), encoding="utf-8",
    )
    manifest = {"lyrics": "lyrics.json", "arrangements": _ARRS}

    payload = routes._build_playback_payload(
        "song.sloppak", tmp_path, manifest, arrangement_index=1,
    )

    assert payload["arrangement"] == {"index": 1, "id": "vocals", "name": "Vocals"}


def test_build_playback_payload_arrangement_defaults_to_unlabelled(tmp_path):
    # Pre-existing callers pass no index; the field stays null-shaped.
    (tmp_path / "lyrics.json").write_text(
        json.dumps([{"t": 0.0, "d": 0.5, "w": "hi"}]), encoding="utf-8",
    )
    payload = routes._build_playback_payload(
        "song.sloppak", tmp_path, {"lyrics": "lyrics.json", "arrangements": _ARRS},
    )
    assert payload["arrangement"]["index"] is None


def test_build_playback_payload_tokens_ignore_arrangement_index(tmp_path):
    # Lyrics are song-level in feedpak v1 — the index labels the response,
    # it must not change the token set.
    (tmp_path / "lyrics.json").write_text(
        json.dumps([{"t": 1.0, "d": 0.5, "w": "a"}]), encoding="utf-8",
    )
    manifest = {"lyrics": "lyrics.json", "arrangements": _ARRS}
    a = routes._build_playback_payload("s.sloppak", tmp_path, manifest, arrangement_index=0)
    b = routes._build_playback_payload("s.sloppak", tmp_path, manifest, arrangement_index=1)
    assert a["voices"] == b["voices"]


def test_playback_route_passes_arrangement_through(tmp_path, monkeypatch):
    (tmp_path / "lyrics.json").write_text(
        json.dumps([{"t": 0.0, "d": 0.5, "w": "hi"}]), encoding="utf-8",
    )
    manifest = {"lyrics": "lyrics.json", "arrangements": _ARRS}
    endpoint = _playback_endpoint(tmp_path)
    monkeypatch.setattr(routes, "_resolve_sloppak", lambda filename: (tmp_path, manifest, tmp_path, False))

    payload = endpoint(filename="song.sloppak", arrangement=1)

    assert payload["arrangement"] == {"index": 1, "id": "vocals", "name": "Vocals"}


def test_playback_route_422_on_negative_arrangement(tmp_path, monkeypatch):
    endpoint = _playback_endpoint(tmp_path)
    monkeypatch.setattr(routes, "_resolve_sloppak", lambda filename: (tmp_path, {}, tmp_path, False))

    response = endpoint(filename="song.sloppak", arrangement=-1)

    assert response.status_code == 422


# ── _coerce_stringlike (factored out of _arrangement_identity) ──────────────

def test_coerce_stringlike_accepts_str_and_int():
    assert routes._coerce_stringlike("vocals") == "vocals"
    assert routes._coerce_stringlike(7) == "7"


def test_coerce_stringlike_rejects_bool_despite_being_an_int_subclass():
    assert routes._coerce_stringlike(True) is None
    assert routes._coerce_stringlike(False) is None


def test_coerce_stringlike_rejects_other_types():
    assert routes._coerce_stringlike(None) is None
    assert routes._coerce_stringlike([1, 2]) is None
    assert routes._coerce_stringlike({"a": 1}) is None
