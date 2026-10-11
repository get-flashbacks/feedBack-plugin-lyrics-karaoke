"""Overflowing and malformed numeric pitch records never crash playback (#62).

Python's ``json`` decoder accepts the bare literals ``NaN``/``Infinity``/
``-Infinity`` and turns a JSON exponent overflow like ``1e309`` into a
non-finite float, so a valid-JSON ``vocal_pitch.json`` reached
``int(float('inf'))`` and raised ``OverflowError`` — which the readers caught
only as ``KeyError``/``TypeError``/``ValueError``. Pitch timestamps,
durations, and MIDI values now pass through explicit finite/type/range
validation, and a bad record is dropped per the documented boundary policy
instead of failing the request. The same coercion guards ``/data`` and the
demucs server's ``/pitch`` output before it is persisted.
"""

import json
import logging
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import routes  # noqa: E402


# ── the coercion helpers ─────────────────────────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    (0, 0.0),
    (1.5, 1.5),
    (-2.5, -2.5),
    (True, None),          # bool is an int subclass — rejected
    (False, None),
    ("1.5", None),         # strings are invalid types, not parsed
    ("Infinity", None),
    (None, None),
    ([1], None),
    ({"t": 1}, None),
    (float("nan"), None),
    (float("inf"), None),
    (float("-inf"), None),
    (10 ** 400, None),     # huge int literal: float() raises OverflowError
])
def test_coerce_finite_number(value, expected):
    assert routes._coerce_finite_number(value) == expected


@pytest.mark.parametrize("value,expected", [
    (0, 0),
    (60, 60),
    (127, 127),
    (60.9, 60),            # in-range fraction truncates toward zero
    (-1, None),
    (128, None),
    (200, None),
    (0.5, 0),
    (-0.5, None),          # range is tested before conversion
    (127.9, None),
    (True, None),
    ("60", None),
    (None, None),
    (float("inf"), None),
    (10 ** 400, None),
])
def test_coerce_midi(value, expected):
    assert routes._coerce_midi(value) == expected


# ── _lyrics_tokens: type validation ──────────────────────────────────────────

def test_lyrics_tokens_drops_overflowing_and_non_number_fields(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "ok"},
        {"t": 1e309, "d": 0.5, "w": "overflow-t"},
        {"t": 2.0, "d": 1e309, "w": "overflow-d"},
        {"t": "1.5", "d": 0.5, "w": "string-t"},
        {"t": 3.0, "d": "0.5", "w": "string-d"},
        {"t": None, "d": 0.5, "w": "null-t"},
    ]), encoding="utf-8")
    assert routes._lyrics_tokens(tmp_path, {"lyrics": "lyrics.json"}) == [
        {"t": 1.0, "d": 0.5, "w": "ok"},
    ]


# ── _canonical_voice_tokens: pitch note validation ───────────────────────────
#
# A token whose timestamp matches a valid note keeps its midi; every
# malformed note is dropped and the token stays unpitched.

def _tokens_with_pitch(tmp_path, raw_pitch, lyrics):
    (tmp_path / "lyrics.json").write_text(json.dumps(lyrics), encoding="utf-8")
    (tmp_path / "vocal_pitch.json").write_text(raw_pitch, encoding="utf-8")
    manifest = {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"}
    return routes._canonical_voice_tokens(tmp_path, manifest)


def test_canonical_voice_tokens_survives_json_exponent_overflow(tmp_path):
    # The exact reproduction from the issue: a valid JSON pitch sidecar whose
    # midi is 1e309 decodes to inf; int(inf) used to raise OverflowError.
    tokens = _tokens_with_pitch(
        tmp_path,
        '{"notes":[{"t":1.0,"midi":1e309}]}',
        [{"t": 1.0, "d": 0.5, "w": "a"}],
    )
    assert tokens == [{"start": 1.0, "duration": 0.5, "text": "a"}]
    assert "midi" not in tokens[0]


def test_canonical_voice_tokens_survives_nan_and_infinity_literals(tmp_path):
    tokens = _tokens_with_pitch(
        tmp_path,
        '{"notes":[{"t":1.0,"midi":NaN},{"t":2.0,"midi":Infinity},'
        '{"t":3.0,"midi":-Infinity}]}',
        [
            {"t": 1.0, "d": 0.5, "w": "a"},
            {"t": 2.0, "d": 0.5, "w": "b"},
            {"t": 3.0, "d": 0.5, "w": "c"},
        ],
    )
    assert [t["text"] for t in tokens] == ["a", "b", "c"]
    assert all("midi" not in t for t in tokens)


def test_canonical_voice_tokens_survives_huge_integer_midi(tmp_path):
    # 10**400 is a Python int after decoding; float() raises OverflowError.
    huge = "9" * 400
    tokens = _tokens_with_pitch(
        tmp_path,
        '{"notes":[{"t":1.0,"midi":' + huge + "}]}",
        [{"t": 1.0, "d": 0.5, "w": "a"}],
    )
    assert tokens == [{"start": 1.0, "duration": 0.5, "text": "a"}]


def test_canonical_voice_tokens_drops_string_null_and_wrong_type_pitch(tmp_path):
    tokens = _tokens_with_pitch(
        tmp_path,
        json.dumps({"notes": [
            {"t": "1.0", "midi": 60},   # string timestamp
            {"t": 2.0, "midi": "60"},   # string midi
            {"t": 3.0, "midi": None},   # null midi (unvoiced syllable)
            {"t": 4.0},                 # missing midi
            {"t": [5.0], "midi": 60},   # list timestamp
        ]}),
        [{"t": float(i), "d": 0.5, "w": str(i)} for i in range(1, 6)],
    )
    assert [t["text"] for t in tokens] == ["1", "2", "3", "4", "5"]
    assert all("midi" not in t for t in tokens)


def test_canonical_voice_tokens_rejects_out_of_range_midi(tmp_path):
    tokens = _tokens_with_pitch(
        tmp_path,
        json.dumps({"notes": [
            {"t": 0.0, "midi": -1},
            {"t": 1.0, "midi": 128},
            {"t": 2.0, "midi": 200},
            {"t": 3.0, "midi": 0},
            {"t": 4.0, "midi": 127},
        ]}),
        [{"t": float(i), "d": 0.5, "w": str(i)} for i in range(5)],
    )
    by_text = {t["text"]: t for t in tokens}
    assert "midi" not in by_text["0"]
    assert "midi" not in by_text["1"]
    assert "midi" not in by_text["2"]
    assert by_text["3"]["midi"] == 0
    assert by_text["4"]["midi"] == 127


def test_canonical_voice_tokens_drops_overflowing_lyric_fields(tmp_path):
    tokens = _tokens_with_pitch(
        tmp_path,
        json.dumps({"notes": []}),
        [
            {"t": 1.0, "d": 0.5, "w": "ok"},
            {"t": 1e309, "d": 0.5, "w": "overflow-t"},
            {"t": 2.0, "d": 1e309, "w": "overflow-d"},
            {"t": 3.0, "d": -1.0, "w": "negative-d"},
            {"t": "4.0", "d": 0.5, "w": "string-t"},
        ],
    )
    assert tokens == [{"start": 1.0, "duration": 0.5, "text": "ok"}]


def test_canonical_voice_tokens_valid_partial_pitch_still_merges(tmp_path):
    # A mix of good and bad notes: the good note still joins its token.
    tokens = _tokens_with_pitch(
        tmp_path,
        json.dumps({"notes": [
            {"t": 1.0, "d": 0.5, "midi": 60},
            {"t": 2.0, "d": 0.5, "midi": 1e309},
        ]}),
        [
            {"t": 1.0, "d": 0.5, "w": "good"},
            {"t": 2.0, "d": 0.5, "w": "bad"},
        ],
    )
    assert tokens == [
        {"start": 1.0, "duration": 0.5, "text": "good", "midi": 60},
        {"start": 2.0, "duration": 0.5, "text": "bad"},
    ]


# ── GET routes: end-to-end ───────────────────────────────────────────────────

def _endpoint(tmp_path, monkeypatch, path):
    # setup() assigns module globals directly; snapshot them through
    # monkeypatch FIRST so teardown restores the pre-test values.
    for name in ("_config_dir", "_get_dlc_dir", "SLOPPAK_CACHE_DIR", "_log"):
        monkeypatch.setattr(routes, name, getattr(routes, name))
    app = FastAPI()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: tmp_path,
        "log": logging.getLogger("test.lyrics_karaoke.pitch_validation"),
    })
    for route in app.routes:
        if getattr(route, "path", "") == path:
            return route.endpoint
    raise AssertionError(f"{path} route not registered")


def _wire_pack(tmp_path, monkeypatch, raw_pitch):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "one"},
        {"t": 2.0, "d": 0.5, "w": "two"},
    ]), encoding="utf-8")
    (tmp_path / "vocal_pitch.json").write_text(raw_pitch, encoding="utf-8")
    manifest = {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"}
    monkeypatch.setattr(
        routes, "_resolve_sloppak",
        lambda filename: (tmp_path, manifest, tmp_path, False),
    )


def test_playback_route_never_crashes_on_overflowing_midi(tmp_path, monkeypatch):
    _wire_pack(tmp_path, monkeypatch, '{"notes":[{"t":1.0,"midi":1e309}]}')
    endpoint = _endpoint(tmp_path, monkeypatch, "/api/plugins/lyrics_karaoke/playback")

    payload = endpoint(filename="song.sloppak")

    assert payload["voices"][0]["tokens"] == [
        {"start": 1.0, "duration": 0.5, "text": "one"},
        {"start": 2.0, "duration": 0.5, "text": "two"},
    ]


def test_data_route_never_crashes_on_overflowing_or_null_midi(tmp_path, monkeypatch):
    _wire_pack(tmp_path, monkeypatch, json.dumps({"notes": [
        {"t": 1.0, "midi": 60},
        {"t": 2.0, "midi": None},   # used to 500 with int(None) TypeError
    ]}))
    endpoint = _endpoint(tmp_path, monkeypatch, "/api/plugins/lyrics_karaoke/data")

    response = endpoint(filename="song.sloppak")

    assert response["tokens"] == [
        {"t": 1.0, "d": 0.5, "w": "one", "midi": 60},
        {"t": 2.0, "d": 0.5, "w": "two"},
    ]


def test_data_route_ignores_out_of_range_and_overflowing_midi(tmp_path, monkeypatch):
    _wire_pack(tmp_path, monkeypatch, json.dumps({"notes": [
        {"t": 1.0, "midi": 200},
        {"t": 2.0, "midi": 1e309},
    ]}))
    endpoint = _endpoint(tmp_path, monkeypatch, "/api/plugins/lyrics_karaoke/data")

    response = endpoint(filename="song.sloppak")

    assert response["tokens"] == [
        {"t": 1.0, "d": 0.5, "w": "one"},
        {"t": 2.0, "d": 0.5, "w": "two"},
    ]


# ── _extract_pitch_via_server: validate remote /pitch before persistence ──────

class _FakeResponse:
    def __init__(self, body):
        self._body = body
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


def _fake_requests(monkeypatch, body):
    mod = types.ModuleType("requests")
    mod.post = lambda *args, **kwargs: _FakeResponse(body)
    monkeypatch.setitem(sys.modules, "requests", mod)


def _server_notes(tmp_path, monkeypatch, notes):
    vocals = tmp_path / "vocals.wav"
    vocals.write_bytes(b"RIFF")
    _fake_requests(monkeypatch, {"notes": notes})
    return routes._extract_pitch_via_server(
        "http://server", vocals, [{"t": 1.0, "d": 0.5}],
    )


def test_extract_pitch_via_server_drops_malformed_notes(tmp_path, monkeypatch):
    out = _server_notes(tmp_path, monkeypatch, [
        {"t": 1.0, "d": 0.5, "midi": 60},
        {"t": 1.0, "d": 0.5, "midi": float("inf")},
        {"t": 1.0, "d": 0.5, "midi": 10 ** 400},
        {"t": 1.0, "d": 0.5, "midi": 200},
        {"t": 1.0, "d": 0.5, "midi": -1},
        {"t": 1.0, "d": -0.5, "midi": 60},
        {"t": "1.0", "d": 0.5, "midi": 60},
        {"t": 1.0, "d": "0.5", "midi": 60},
        {"t": 1.0, "d": 0.5, "midi": None},
        {"t": 1.0, "d": 0.5, "midi": "60"},
        "not a dict",
    ])
    assert out == [{"t": 1.0, "d": 0.5, "midi": 60}]


def test_extract_pitch_via_server_keeps_zero_duration_and_bounds(tmp_path, monkeypatch):
    out = _server_notes(tmp_path, monkeypatch, [
        {"t": 1.0, "d": 0.0, "midi": 0},
        {"t": 2.0, "d": 0.5, "midi": 127},
    ])
    assert out == [
        {"t": 1.0, "d": 0.0, "midi": 0},
        {"t": 2.0, "d": 0.5, "midi": 127},
    ]


# ── regression: valid packs still load ───────────────────────────────────────

def test_valid_partially_pitched_pack_still_loads(tmp_path):
    tokens = _tokens_with_pitch(
        tmp_path,
        json.dumps({"notes": [{"t": 1.0, "d": 0.5, "midi": 60}]}),
        [
            {"t": 1.0, "d": 0.5, "w": "pitched"},
            {"t": 2.0, "d": 0.5, "w": "unpitched"},
        ],
    )
    assert tokens == [
        {"start": 1.0, "duration": 0.5, "text": "pitched", "midi": 60},
        {"start": 2.0, "duration": 0.5, "text": "unpitched"},
    ]


def test_valid_lyrics_only_pack_still_loads(tmp_path):
    (tmp_path / "lyrics.json").write_text(json.dumps([
        {"t": 1.0, "d": 0.5, "w": "hi"},
    ]), encoding="utf-8")
    assert routes._canonical_voice_tokens(tmp_path, {"lyrics": "lyrics.json"}) == [
        {"start": 1.0, "duration": 0.5, "text": "hi"},
    ]
