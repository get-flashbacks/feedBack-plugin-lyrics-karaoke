import json

import pytest

import routes


@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan"), "Infinity", "NaN", "1e999"])
def test_lrc_timestamp_rejects_non_finite_values(value):
    with pytest.raises(ValueError, match="finite"):
        routes._lrc_timestamp(value)


def test_lrc_timestamp_rejects_a_finite_value_that_overflows_when_scaled():
    # 1e307 passes math.isfinite() (it's a real, finite double), but
    # 1e307 * 100 = 1e309 exceeds the max representable double and becomes
    # inf -- round(inf) then raises OverflowError, the exact unhelpful
    # error this function exists to turn into a clean ValueError.
    with pytest.raises(ValueError, match="finite"):
        routes._lrc_timestamp(1e307)


def test_format_lrc_skips_a_finite_value_that_overflows_when_scaled():
    # _format_lrc's own guard only checks math.isfinite(t), which 1e307
    # passes -- it must also catch the ValueError _lrc_timestamp raises
    # for the scaled-overflow case, or /export still 500s on this input
    # (just with a different exception type than before).
    segments = [
        {"start": 1.0, "text": "kept"},
        {"start": 1e307, "text": "overflows-when-scaled dropped"},
    ]
    assert routes._format_lrc(segments) == "[00:01.00]kept\n"


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
