"""The plugin's routes and payload schema over generated vocal packs.

``tests/fixtures/generate_feedpaks.py`` emits one archive per fixture kind —
single voice, duet, incomplete pitch, lyrics only — so this suite runs from a
clean checkout with no song media in the repository. Each kind is driven
through every route that reads prepared data (``/status``, ``/data``,
``/playback``) and checked against the contract in
``docs/architecture/vocals-playback-contract.md``.

Song resolution itself is stubbed: containment across a filename that escapes
the library is ``_resolve_dlc_path``'s job and is covered in
``test_host_compat.py``. What these tests pin is what the routes do with a
pack a real host would have handed them — the manifest is still read off
disk through ``routes._read_manifest``, and the sidecars through the same
containment-checked resolution the routes use internally.
"""

import logging
import shutil
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes
from tests.fixtures.generate_feedpaks import generate, unpack
from tests.playback_schema import (
    SCHEMA_VERSION, assert_playback_schema, playback_schema_problems,
)


KINDS = ("single-voice", "duet", "incomplete-pitch", "lyrics-only")


# ── expected route output per fixture kind ───────────────────────────────────
#
# The generator's syllables, spelled out here so a fixture change is a visible
# diff rather than a silently moved expectation. `_token`/`_voice` mirror the
# payload shape: `midi` is present only on pitched syllables, and exactly one
# voice is primary.

def _token(start, duration, text, midi=None):
    token = {"start": start, "duration": duration, "text": text}
    if midi is not None:
        token["midi"] = midi
    return token


def _voice(voice_id, name, *tokens, primary=False):
    return {"id": voice_id, "name": name, "primary": primary, "tokens": list(tokens)}


_LA = _token(0.5, 0.4, "la-", 60)
_LA_PLUS = _token(0.9, 0.5, "la+", 62)
_UNPITCHED_LA_PLUS = _token(0.9, 0.5, "la+")
_OH = _token(0.5, 0.9, "oh+", 55)

PLAYBACK_VOICES = {
    "single-voice": [_voice("primary", "Vocals", _LA, _LA_PLUS, primary=True)],
    "duet": [
        _voice("lead", "Lead", _LA, _LA_PLUS, primary=True),
        _voice("harmony", "Harmony", _OH),
    ],
    # A pitch sidecar that covers only some syllables leaves the rest unpitched,
    # which is a supported response, never an error.
    "incomplete-pitch": [
        _voice("primary", "Vocals", _LA, _UNPITCHED_LA_PLUS, primary=True),
    ],
    "lyrics-only": [
        _voice("primary", "Vocals", _token(0.5, 0.4, "la-"), _UNPITCHED_LA_PLUS,
               primary=True),
    ],
}

# `/data` keeps its legacy merged shape and stays singular-key-only, so a duet
# reports the primary voice's own pair and never the harmony track. `None`
# tokens key the error body: a pack with no pitch sidecar at all has nothing
# to merge, and keying on the tokens rather than on a status literal keeps a
# regression to some other status from reading as a body mismatch.
_DATA_LEAD = [{"t": 0.5, "d": 0.4, "w": "la-", "midi": 60},
              {"t": 0.9, "d": 0.5, "w": "la+", "midi": 62}]

DATA_EXPECTATIONS = {
    "single-voice": (200, _DATA_LEAD),
    "duet": (200, _DATA_LEAD),
    "incomplete-pitch": (200, [_DATA_LEAD[0], {"t": 0.9, "d": 0.5, "w": "la+"}]),
    "lyrics-only": (404, None),
}

# `/status` readiness flags, all of them sourced from the singular manifest
# keys — so a duet reports the primary voice's two pitch notes, not the
# track list's three.
STATUS_FLAGS = {
    "single-voice": {"is_sloppak": True, "has_vocals": True, "has_lyrics": True,
                     "has_pitch": True, "pitch_count": 2},
    "duet": {"is_sloppak": True, "has_vocals": True, "has_lyrics": True,
             "has_pitch": True, "pitch_count": 2},
    "incomplete-pitch": {"is_sloppak": True, "has_vocals": True, "has_lyrics": True,
                         "has_pitch": True, "pitch_count": 1},
    "lyrics-only": {"is_sloppak": True, "has_vocals": True, "has_lyrics": True,
                    "has_pitch": False, "pitch_count": 0},
}


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def library(tmp_path_factory):
    """One library root holding the unpacked form of every generated pack."""
    root = tmp_path_factory.mktemp("generated-packs")
    library_dir = root / "library"
    for pack in generate(root / "archives").values():
        unpack(pack, library_dir / pack.name)
    return library_dir


def _resolve_from_library(library_dir):
    """Stand in for song resolution by mapping a filename to its pack dir."""
    def _resolve(filename):
        source = library_dir / filename
        if not source.is_dir():
            return None
        return source, routes._read_manifest(source), library_dir / filename, False
    return _resolve


def _client(tmp_path, monkeypatch, library_dir):
    """A ``TestClient`` over ``routes.setup``, pointed at ``library_dir``.

    ``setup()`` assigns the module globals directly, so they are snapshotted
    through monkeypatch BEFORE the call: that records the pre-call value and
    reverts ``setup()``'s write on teardown. Without it the globals keep
    pointing at a ``tmp_path`` pytest deletes.
    """
    for name in ("_config_dir", "_get_dlc_dir", "SLOPPAK_CACHE_DIR", "_log"):
        monkeypatch.setattr(routes, name, getattr(routes, name))
    app = FastAPI()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: library_dir,
        "log": logging.getLogger("test.generated_feedpaks"),
    })
    monkeypatch.setattr(routes, "_resolve_sloppak", _resolve_from_library(library_dir))
    return TestClient(app)


@pytest.fixture
def client(tmp_path, monkeypatch, library):
    return _client(tmp_path, monkeypatch, library)


def _playback(client, kind, **params):
    return client.get("/api/plugins/lyrics_karaoke/playback",
                      params={"filename": f"{kind}.sloppak", **params})


# ── the generated packs themselves ────────────────────────────────────────────

def test_generator_emits_one_archive_per_fixture_kind(tmp_path):
    # The four kinds are the fixture contract, and CI builds the manual-test
    # artifact from whatever this returns.
    packs = generate(tmp_path)

    assert sorted(packs) == sorted(KINDS)
    assert all(zipfile.is_zipfile(path) for path in packs.values())


@pytest.mark.parametrize("kind", KINDS)
def test_generated_pack_holds_only_the_files_its_manifest_declares(library, kind):
    source = library / f"{kind}.sloppak"
    manifest = routes._read_manifest(source)

    assert manifest["feedpak_version"] == "1.0.0"
    # feedpak §5.3: a pack that ships per-instrument stems must not mark the
    # full mixdown as the default.
    assert [(stem["id"], stem["default"]) for stem in manifest["stems"]] == [
        ("full", False), ("vocals", True),
    ]
    assert routes._vocals_rel_path(manifest) == "stems/vocals.wav"

    declared = [manifest[key] for key in ("lyrics", "vocal_pitch") if key in manifest]
    declared += [entry["file"] for entry in manifest["arrangements"]]
    declared += [stem["file"] for stem in manifest["stems"]]
    for track in manifest.get("vocal_tracks", []):
        declared += [track[key] for key in ("lyrics", "vocal_pitch") if key in track]

    shipped = {"manifest.yaml"} | set(declared)
    present = {path.relative_to(source).as_posix() for path in source.rglob("*")
               if path.is_file()}
    assert present == shipped


# ── GET /status ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", KINDS)
def test_status_route_reports_generated_readiness(client, kind):
    status = client.get("/api/plugins/lyrics_karaoke/status",
                        params={"filename": f"{kind}.sloppak"}).json()

    assert status == {"filename": f"{kind}.sloppak"} | STATUS_FLAGS[kind]


# ── GET /data ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", KINDS)
def test_data_route_merges_generated_lyrics_and_pitch(client, kind):
    expected_status, tokens = DATA_EXPECTATIONS[kind]
    filename = f"{kind}.sloppak"

    response = client.get("/api/plugins/lyrics_karaoke/data",
                          params={"filename": filename})

    assert response.status_code == expected_status
    expected = {"error": "No vocal_pitch.json"} if tokens is None else {
        "filename": filename, "tokens": tokens,
    }
    assert response.json() == expected


# ── GET /playback ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", KINDS)
def test_playback_route_serves_the_generated_payload(client, kind):
    response = _playback(client, kind, arrangement=0)

    assert response.status_code == 200
    payload = response.json()
    assert_playback_schema(payload)
    assert payload["song"] == {"filename": f"{kind}.sloppak"}
    assert payload["arrangement"] == {"index": 0, "id": "vocals", "name": "Vocals"}
    assert payload["voices"] == PLAYBACK_VOICES[kind]


def test_playback_route_omits_arrangement_label_when_not_asked(client):
    response = _playback(client, "single-voice")

    assert response.status_code == 200
    assert response.json()["arrangement"] == {"index": None, "id": None, "name": None}


def test_playback_route_echoes_an_arrangement_the_generated_pack_lacks(client):
    # Every generated pack declares one arrangement, so index 1 resolves to
    # nothing: echoed with a null identity rather than invented, and still a
    # 200 — lyrics are song-level, so the tokens remain correct.
    response = _playback(client, "single-voice", arrangement=1)

    assert response.status_code == 200
    assert response.json()["arrangement"] == {"index": 1, "id": None, "name": None}


def test_playback_route_rejects_a_negative_arrangement_index(client):
    response = _playback(client, "single-voice", arrangement=-1)

    assert response.status_code == 422
    assert response.json() == {"error": "Invalid arrangement index"}


# ── unprepared songs ─────────────────────────────────────────────────────────

def test_routes_report_an_unresolvable_pack_as_unprepared(client):
    missing = {"filename": "not-a-generated-pack.sloppak"}

    status = client.get("/api/plugins/lyrics_karaoke/status", params=missing).json()
    assert status == {
        "filename": "not-a-generated-pack.sloppak", "is_sloppak": False,
        "has_vocals": False, "has_lyrics": False, "has_pitch": False,
        "pitch_count": 0,
    }
    for route in ("data", "playback"):
        response = client.get(f"/api/plugins/lyrics_karaoke/{route}", params=missing)
        assert response.status_code == 404
        assert response.json() == {"error": "Not a sloppak"}


def test_generated_pack_with_its_lyrics_removed_is_unprepared_not_broken(
    tmp_path, monkeypatch, library,
):
    # Take a private copy so the shared library keeps its sidecars.
    own_library = tmp_path / "library"
    copy = own_library / "lyrics-only.sloppak"
    shutil.copytree(library / "lyrics-only.sloppak", copy)
    (copy / "lyrics.json").unlink()
    client = _client(tmp_path, monkeypatch, own_library)

    status = client.get("/api/plugins/lyrics_karaoke/status",
                        params={"filename": copy.name}).json()
    response = client.get("/api/plugins/lyrics_karaoke/playback",
                          params={"filename": copy.name})

    assert status["has_lyrics"] is False
    assert status["has_vocals"] is True
    assert response.status_code == 404
    assert response.json() == {"error": "No lyrics data"}


# ── the payload schema check ─────────────────────────────────────────────────

def test_playback_schema_version_is_the_one_the_contract_documents():
    assert routes.PLAYBACK_SCHEMA_VERSION == SCHEMA_VERSION == 1


@pytest.mark.parametrize("payload,expected", [
    ({"schema_version": 2, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": None, "id": None, "name": None},
      "voices": [_voice("primary", "Vocals", _LA, primary=True)]},
     ["schema_version is 2, expected the integer 1"]),
    # `True == 1` in Python, so the version check has to reject the bool itself.
    ({"schema_version": True, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": None, "id": None, "name": None},
      "voices": [_voice("primary", "Vocals", _LA, primary=True)]},
     ["schema_version is True, expected the integer 1"]),
    # Two primaries: the guarantee the duet path exists to keep.
    ({"schema_version": 1, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": 0, "id": "vocals", "name": "Vocals"},
      "voices": [_voice("a", "A", _LA, primary=True),
                 _voice("b", "B", _LA, primary=True)]},
     ["voices carries 2 primary entries, expected exactly 1"]),
    # Two tracks sharing an id: the other thing `/playback` rejects with a 422,
    # so the checker must not drift into accepting it.
    ({"schema_version": 1, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": None, "id": None, "name": None},
      "voices": [_voice("lead", "Lead", _LA, primary=True),
                 _voice("lead", "Lead again", _LA)]},
     ["voices[1].id 'lead' is duplicated"]),
    # Unpitched must stay a missing key, not a null one.
    ({"schema_version": 1, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": None, "id": None, "name": None},
      "voices": [_voice("primary", "Vocals",
                        {"start": 0.5, "duration": 0.4, "text": "la-", "midi": None},
                        primary=True)]},
     ["voices[0].tokens[0].midi is None, expected an integer MIDI note"]),
    ({"schema_version": 1, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": None, "id": None, "name": None},
      "voices": [_voice("primary", "Vocals", _token(0.5, 0.4, "la-", 200),
                        primary=True)]},
     ["voices[0].tokens[0].midi is 200, outside 0-127"]),
    # Out-of-order tokens are a contract violation, not a harmless reorder.
    ({"schema_version": 1, "song": {"filename": "s.sloppak"},
      "arrangement": {"index": None, "id": None, "name": None},
      "voices": [_voice("primary", "Vocals", _LA_PLUS, _LA, primary=True)]},
     ["voices[0].tokens[1].start 0.5 goes back from 0.9"]),
])
def test_playback_schema_reports_contract_violations(payload, expected):
    # Without this the schema assertions above would pass vacuously if the
    # checker ever started returning no problems.
    assert playback_schema_problems(payload) == expected


def test_playback_schema_reports_an_oversized_integer_without_raising():
    # `math.isfinite` overflows on an integer too large to become a float, and
    # the checker reports deviations rather than raising on them.
    oversized = 10 ** 400
    problems = playback_schema_problems({
        "schema_version": 1,
        "song": {"filename": "s.sloppak"},
        "arrangement": {"index": None, "id": None, "name": None},
        "voices": [_voice("primary", "Vocals",
                          {"start": oversized, "duration": 0.4, "text": "la-"},
                          primary=True)],
    })

    assert problems == [
        f"voices[0].tokens[0].start is {oversized}, expected a finite number",
    ]
