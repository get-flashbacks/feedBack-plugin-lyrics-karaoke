"""Tests for the `/api/plugins/lyrics_karaoke/export` endpoint's
Content-Disposition header handling (routes.lk_export).

Covers the RFC 5987 `filename*=UTF-8''...` form and the ASCII-sanitized
legacy `filename="..."` fallback, both added to guard against:

* Starlette's Latin-1 header encoding raising ``UnicodeEncodeError`` when
  title/artist contain non-Latin-1 characters.
* Header-value corruption / injection when title/artist contain quote,
  backslash, or control characters (e.g. a literal newline).
"""

import sys
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes

EXPORT_URL = "/api/plugins/lyrics_karaoke/export"
SEGMENTS = [{"start": 0.0, "text": "Hello"}, {"start": 65.5, "text": "World"}]


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    routes.setup(app, {"config_dir": tmp_path, "get_dlc_dir": lambda: tmp_path})
    return TestClient(app)


def _export(client, **payload):
    resp = client.post(EXPORT_URL, json={"segments": SEGMENTS, **payload})
    assert resp.status_code == 200
    return resp


def test_lk_export_missing_segments_returns_400(client):
    """Regression: the new header-construction code sits after this early
    return, so it must never run when the request has no segments."""
    resp = client.post(EXPORT_URL, json={})
    assert resp.status_code == 400
    assert resp.json() == {"error": "No segments provided"}


def test_lk_export_sets_both_legacy_and_utf8_filename_forms(client):
    resp = _export(client, title="Test Song", artist="Test Artist")
    disposition = resp.headers["content-disposition"]
    assert disposition == (
        'attachment; filename="Test Artist - Test Song.lrc"; '
        "filename*=UTF-8''Test%20Artist%20-%20Test%20Song.lrc"
    )
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.text == (
        "[ti:Test Song]\n[ar:Test Artist]\n[by:Slopsmith Lyrics Karaoke]\n"
        "[00:00.00]Hello\n[01:05.50]World\n"
    )


def test_lk_export_defaults_filename_to_lyrics_when_title_and_artist_blank(client):
    resp = _export(client, title="", artist="")
    disposition = resp.headers["content-disposition"]
    assert disposition == (
        "attachment; filename=\"lyrics.lrc\"; filename*=UTF-8''lyrics.lrc"
    )


def test_lk_export_sanitizes_slashes_and_backslashes_in_filename(client):
    resp = _export(client, title="A/B", artist="C\\D")
    disposition = resp.headers["content-disposition"]
    assert disposition == (
        'attachment; filename="C_D - A_B.lrc"; '
        "filename*=UTF-8''C_D%20-%20A_B.lrc"
    )


def test_lk_export_escapes_quotes_in_legacy_filename_fallback(client):
    resp = _export(client, title='Say "Hi"', artist="")
    disposition = resp.headers["content-disposition"]
    assert 'filename="Say \\"Hi\\".lrc"' in disposition
    encoded = quote('Say "Hi".lrc', safe="")
    assert f"filename*=UTF-8''{encoded}" in disposition


def test_lk_export_replaces_non_ascii_in_legacy_form_but_preserves_in_utf8_form(client):
    resp = _export(client, title="café", artist="")
    disposition = resp.headers["content-disposition"]
    assert 'filename="caf_.lrc"' in disposition
    assert "filename*=UTF-8''caf%C3%A9.lrc" in disposition


def test_lk_export_neutralizes_control_characters_preventing_header_injection(client):
    resp = _export(client, title="Line1\nLine2", artist="")
    disposition = resp.headers["content-disposition"]
    # No raw control characters leak into the header value...
    assert "\n" not in disposition
    assert "\r" not in disposition
    assert 'filename="Line1_Line2.lrc"' in disposition
    # ...while the UTF-8 form still carries the real content, percent-encoded.
    assert "filename*=UTF-8''Line1%0ALine2.lrc" in disposition


def test_lk_export_legacy_fallback_is_pure_printable_ascii(client):
    resp = _export(client, title="日本語タイトル", artist="")
    disposition = resp.headers["content-disposition"]
    import re

    legacy = re.search(r'filename="([^"]*)"', disposition).group(1)
    assert all(0x20 <= ord(c) <= 0x7E for c in legacy)