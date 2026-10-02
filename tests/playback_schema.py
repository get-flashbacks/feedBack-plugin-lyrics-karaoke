"""Structural checks for the canonical ``/playback`` payload.

These encode the boundary rules in
``docs/architecture/vocals-playback-contract.md``: fixed key sets, one
primary voice, finite non-negative timings, and an optional integer ``midi``.
Hand-rolled rather than a JSON Schema library so the suite still runs with
only the five packages CI installs.

``playback_schema_problems`` collects every deviation instead of failing on
the first, so one bad payload reports all of its problems.
"""

from __future__ import annotations

import math


# The contract document pins version 1. Deliberately spelled out here rather
# than imported from `routes`, so an accidental bump of the module constant
# fails the route tests instead of silently redefining what "valid" means.
SCHEMA_VERSION = 1

_PAYLOAD_KEYS = frozenset({"schema_version", "song", "arrangement", "voices"})
_SONG_KEYS = frozenset({"filename"})
_ARRANGEMENT_KEYS = frozenset({"index", "id", "name"})
_VOICE_KEYS = frozenset({"id", "name", "primary", "tokens"})
_TOKEN_REQUIRED_KEYS = frozenset({"start", "duration", "text"})
_TOKEN_OPTIONAL_KEYS = frozenset({"midi"})

_MIDI_LOW = 0
_MIDI_HIGH = 127


def playback_schema_problems(payload: object) -> list[str]:
    """Return every way ``payload`` deviates from the contract.

    An empty list means the payload satisfies the schema. The shape is
    checked, not the content — what a fixture's tokens say is that fixture's
    expectation, spelled out next to it.
    """
    if not isinstance(payload, dict):
        return [f"payload is {type(payload).__name__}, expected an object"]
    problems = _missing_and_extra(payload, _PAYLOAD_KEYS, frozenset(), "payload")
    version = payload.get("schema_version")
    # `bool` is an `int` subclass and `1.0 == 1`, so `True` and `1.0` would
    # otherwise both satisfy the version check while breaking the contract's
    # "schema_version is an integer".
    if isinstance(version, bool) or not isinstance(version, int) or version != SCHEMA_VERSION:
        problems.append(
            f"schema_version is {version!r}, expected the integer {SCHEMA_VERSION}"
        )
    problems += _check_song(payload.get("song"))
    problems += _check_arrangement(payload.get("arrangement"))
    problems += _check_voices(payload.get("voices"))
    return problems


def assert_playback_schema(payload: object) -> None:
    """Fail with every contract deviation listed, not just the first."""
    problems = playback_schema_problems(payload)
    assert not problems, "playback payload violates the schema:\n  " + "\n  ".join(problems)


def _missing_and_extra(
    value: dict, required: frozenset[str], optional: frozenset[str], where: str,
) -> list[str]:
    missing = sorted(required - set(value))
    extra = sorted(set(value) - required - optional)
    problems = []
    if missing:
        problems.append(f"{where} is missing {missing}")
    if extra:
        problems.append(f"{where} has unexpected {extra}")
    return problems


def _string_problems(value: object, where: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, str):
        return [f"{where} is {type(value).__name__}, expected a string"]
    if not value and not allow_empty:
        return [f"{where} is empty"]
    return []


def _is_finite_number(value: object) -> bool:
    # `bool` is an `int` subclass, and `True` is not a timestamp or a duration.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an integer too large to convert to a float
        return False


def _check_song(song: object) -> list[str]:
    if not isinstance(song, dict):
        return [f"song is {type(song).__name__}, expected an object"]
    return (
        _missing_and_extra(song, _SONG_KEYS, frozenset(), "song")
        + _string_problems(song.get("filename"), "song.filename")
    )


def _check_arrangement(arrangement: object) -> list[str]:
    if not isinstance(arrangement, dict):
        return [f"arrangement is {type(arrangement).__name__}, expected an object"]
    problems = _missing_and_extra(arrangement, _ARRANGEMENT_KEYS, frozenset(), "arrangement")
    index = arrangement.get("index")
    if index is not None and (isinstance(index, bool) or not isinstance(index, int)):
        problems.append(f"arrangement.index is {index!r}, expected an integer or null")
    for key in ("id", "name"):
        # An unlabelled payload and an unresolved index both null these out.
        value = arrangement.get(key)
        if value is not None:
            problems += _string_problems(value, f"arrangement.{key}")
    return problems


def _check_voices(voices: object) -> list[str]:
    if not isinstance(voices, list):
        return [f"voices is {type(voices).__name__}, expected an array"]
    problems: list[str] = []
    seen_ids: set[str] = set()
    primaries = 0
    for position, voice in enumerate(voices):
        where = f"voices[{position}]"
        if not isinstance(voice, dict):
            problems.append(f"{where} is {type(voice).__name__}, expected an object")
            continue
        problems += _missing_and_extra(voice, _VOICE_KEYS, frozenset(), where)
        problems += _check_voice_id(voice.get("id"), where, seen_ids)
        name = voice.get("name")
        if name is not None:
            problems += _string_problems(name, f"{where}.name")
        primary = voice.get("primary")
        if not isinstance(primary, bool):
            problems.append(f"{where}.primary is {primary!r}, expected a boolean")
        elif primary:
            primaries += 1
        problems += _check_tokens(voice.get("tokens"), f"{where}.tokens")
    if voices and primaries != 1:
        problems.append(f"voices carries {primaries} primary entries, expected exactly 1")
    return problems


def _check_voice_id(voice_id: object, where: str, seen_ids: set[str]) -> list[str]:
    problems = _string_problems(voice_id, f"{where}.id")
    if isinstance(voice_id, str):
        if voice_id in seen_ids:
            problems.append(f"{where}.id {voice_id!r} is duplicated")
        seen_ids.add(voice_id)
    return problems


def _check_tokens(tokens: object, where: str) -> list[str]:
    if not isinstance(tokens, list):
        return [f"{where} is {type(tokens).__name__}, expected an array"]
    problems: list[str] = []
    previous_start = None
    for position, token in enumerate(tokens):
        spot = f"{where}[{position}]"
        if not isinstance(token, dict):
            problems.append(f"{spot} is {type(token).__name__}, expected an object")
            continue
        problems += _missing_and_extra(
            token, _TOKEN_REQUIRED_KEYS, _TOKEN_OPTIONAL_KEYS, spot
        )
        start = token.get("start")
        if not _is_finite_number(start):
            problems.append(f"{spot}.start is {start!r}, expected a finite number")
        else:
            if previous_start is not None and start < previous_start:
                problems.append(f"{spot}.start {start!r} goes back from {previous_start!r}")
            previous_start = start
        duration = token.get("duration")
        if not _is_finite_number(duration):
            problems.append(f"{spot}.duration is {duration!r}, expected a finite number")
        elif duration < 0:
            problems.append(f"{spot}.duration is {duration!r}, expected a non-negative number")
        problems += _string_problems(token.get("text"), f"{spot}.text", allow_empty=True)
        if "midi" in token:
            problems += _check_midi(token["midi"], f"{spot}.midi")
    return problems


def _check_midi(midi: object, where: str) -> list[str]:
    if isinstance(midi, bool) or not isinstance(midi, int):
        return [f"{where} is {midi!r}, expected an integer MIDI note"]
    if not _MIDI_LOW <= midi <= _MIDI_HIGH:
        return [f"{where} is {midi!r}, outside {_MIDI_LOW}-{_MIDI_HIGH}"]
    return []