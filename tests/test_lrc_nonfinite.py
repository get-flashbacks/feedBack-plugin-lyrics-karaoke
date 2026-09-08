import json

import pytest

import routes


@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan"), "Infinity", "NaN", "1e999"])
def test_lrc_timestamp_rejects_non_finite_values(value):
    with pytest.raises(ValueError, match="finite"):
        routes._lrc_timestamp(value)


def test_format_lrc_skips_non_finite_segments():
    segments = [
        {"start": "Infinity", "text": "bad-inf"},
        {"start": "NaN", "text": "bad-nan"},
        {"start": "1e999", "text": "bad-overflow"},
        {"start": 1.25, "text": "ok"},
    ]

    assert routes._format_lrc(segments) == "[00:01.25]ok\n"


def test_persist_lyrics_skips_non_finite_segments(tmp_path):
    segments = [
        {"start": "Infinity", "end": 2.0, "text": "bad-start"},
        {"start": 1.0, "end": "NaN", "text": "bad-end"},
        {"start": 2.0, "end": 3.5, "text": "ok"},
    ]

    count = routes._persist_lyrics(
        tmp_path,
        {"lyrics": "lyrics.json"},
        segments,
        tmp_path / "unused.sloppak",
        False,
    )

    assert count == 1
    assert json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8")) == [
        {"t": 2.0, "d": 1.5, "w": "ok"}
    ]
