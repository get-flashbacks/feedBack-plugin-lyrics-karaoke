"""Exercise the canonical route against generated, zip-shaped vocal data."""

import json
import logging
import zipfile

import pytest
from fastapi import FastAPI

import routes
from tests.fixtures.generate_feedpaks import generate


@pytest.mark.parametrize("kind,voice_count,pitched_count", [
    ("single-voice", 1, 2),
    ("duet", 2, 3),
    ("incomplete-pitch", 1, 1),
    ("lyrics-only", 1, 0),
])
def test_generated_pack_playback_route(
    tmp_path, monkeypatch, kind, voice_count, pitched_count,
):
    pack = generate(tmp_path / "packs")[kind]
    source = tmp_path / "extracted"
    source.mkdir()
    with zipfile.ZipFile(pack) as archive:
        archive.extractall(source)
    manifest = routes._read_manifest(source)

    app = FastAPI()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: tmp_path,
        "log": logging.getLogger("test.generated_feedpaks"),
    })
    endpoint = next(route.endpoint for route in app.routes
                    if getattr(route, "path", "") == "/api/plugins/lyrics_karaoke/playback")
    monkeypatch.setattr(routes, "_resolve_sloppak",
                        lambda filename: (source, manifest, pack, True))

    payload = endpoint(filename=pack.name, arrangement=0)

    assert payload["schema_version"] == 1
    assert payload["song"]["filename"] == pack.name
    assert payload["arrangement"] == {"index": 0, "id": "vocals", "name": "Vocals"}
    assert len(payload["voices"]) == voice_count
    assert sum("midi" in token for voice in payload["voices"]
               for token in voice["tokens"]) == pitched_count
    assert sum(voice["primary"] for voice in payload["voices"]) == 1
    assert json.loads(json.dumps(payload)) == payload
