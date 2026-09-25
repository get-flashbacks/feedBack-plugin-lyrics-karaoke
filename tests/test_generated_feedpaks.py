"""Exercise the canonical route against generated, zip-shaped vocal data."""

import json
import logging
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes
from tests.fixtures.generate_feedpaks import generate


@pytest.mark.parametrize("kind,voice_count,token_count,pitched_count", [
    ("single-voice", 1, 2, 2),
    ("duet", 2, 3, 3),
    ("incomplete-pitch", 1, 2, 1),
    ("lyrics-only", 1, 2, 0),
])
def test_generated_pack_playback_route(
    tmp_path, monkeypatch, kind, voice_count, token_count, pitched_count,
):
    pack = generate(tmp_path / "packs")[kind]
    source = tmp_path / "extracted"
    source.mkdir()
    with zipfile.ZipFile(pack) as archive:
        archive.extractall(source)
    manifest = routes._read_manifest(source)
    assert manifest["feedpak_version"] == "1.0.0"
    assert [stem["default"] for stem in manifest["stems"]] == [False, True]

    app = FastAPI()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: tmp_path,
        "log": logging.getLogger("test.generated_feedpaks"),
    })
    monkeypatch.setattr(routes, "_resolve_sloppak",
                        lambda filename: (source, manifest, pack, True))

    response = TestClient(app).get(
        "/api/plugins/lyrics_karaoke/playback",
        params={"filename": pack.name, "arrangement": 0},
    )
    assert response.status_code == 200
    payload = response.json()

    assert payload["schema_version"] == 1
    assert payload["song"]["filename"] == pack.name
    assert payload["arrangement"] == {"index": 0, "id": "vocals", "name": "Vocals"}
    assert len(payload["voices"]) == voice_count
    assert sum(len(voice["tokens"]) for voice in payload["voices"]) == token_count
    assert sum("midi" in token for voice in payload["voices"]
               for token in voice["tokens"]) == pitched_count
    assert sum(voice["primary"] for voice in payload["voices"]) == 1
    assert json.loads(json.dumps(payload)) == payload
