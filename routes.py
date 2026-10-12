"""Lyrics Karaoke plugin — end-to-end karaoke setup for sloppak songs.

Two stages, one workflow:

1. **Sync lyrics** — send a sloppak's vocals stem + plain lyric text to a
   Whisper alignment service (the demucs server's ``/align`` endpoint) and
   write the syllable-level result to ``lyrics.json`` inside the sloppak.
2. **Extract pitch** — run ``librosa.pyin`` over the same vocals stem,
   median per syllable, and write ``vocal_pitch.json`` next to it.

Both artifacts are persisted inside the sloppak (manifest is patched, zip
form is re-zipped with a one-time ``.bak``). The frontend can run them
in sequence as a single "Build Karaoke" action, or independently when
one of the two artifacts already exists.

Duet packs carry multiple ``vocal_tracks``. The preparation routes take an
optional ``voice`` id selecting which track to prepare: the write targets that
track's own sidecars and, for the primary voice only, keeps the singular
``lyrics``/``vocal_pitch`` aliases in sync so ``/playback`` and older readers
agree. Omitted, ``voice`` resolves to the primary (or the synthetic ``primary``
of a solo pack), preserving the legacy behavior.

Endpoints
---------

* ``GET  /status?filename=…[&voice=…]``     — per-song readiness flags + voice list
* ``GET  /server-status``         — alignment server reachable?
* ``GET  /data?filename=…``       — merged ``[{t, d, w, midi?}]`` for the player overlay
* ``GET  /playback?filename=…[&arrangement=N]`` — canonical versioned multi-voice payload (see below)
* ``POST /align``                 — run Whisper alignment, return segments (echoes ``voice``)
* ``POST /save-lyrics``           — persist alignment segments to the resolved voice's lyrics
* ``POST /generate-pitch``        — extract per-syllable pitch into the resolved voice's pitch
* ``POST /export``                — download alignment as a standard ``.lrc`` file
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import shutil
import tempfile
import threading
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import quote

import yaml
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response


_config_dir: Path | None = None
_get_dlc_dir = None
SLOPPAK_CACHE_DIR: Path | None = None
# Set from context["log"] in setup() — a stdlib logging.Logger namespaced to
# feedBack.plugin.lyrics_karaoke, pre-configured with the app-wide level,
# format, and correlation IDs. Defaults to the plain stdlib logger of the
# same name so call sites never need a None-check, even though nothing
# actually logs before setup() runs today.
_log: logging.Logger = logging.getLogger("feedBack.plugin.lyrics_karaoke")

# Per-canonical-pack lock so two simultaneous preparation writes on the same
# song serialize instead of racing on the same files. Keyed on the *resolved
# on-disk path* (see `_job_lock_for`), not the request filename, so two aliases
# of one sloppak can't each take a different lock and clobber the other's
# manifest pointer.
_job_locks: dict[str, threading.Lock] = {}
_job_locks_guard = threading.Lock()


# ── Demucs / alignment server config ──────────────────────────────────────────

def _get_demucs_server_url() -> str | None:
    """Read the configured alignment server URL from the shared config.json.

    The Stems / Lyrics Sync settings page persists this; the merged plugin
    keeps the same key so existing setups keep working without migration.
    """
    if _config_dir is None:
        return None
    config_file = _config_dir / "config.json"
    if not config_file.exists():
        return None
    try:
        cfg = json.loads(config_file.read_text())
    except Exception:
        return None
    url = cfg.get("demucs_server_url", "")
    if not isinstance(url, str) or not url.strip():
        return None
    return url.rstrip("/")


# ── Manifest helpers ──────────────────────────────────────────────────────────

def _manifest_path(source_dir: Path) -> Path:
    p = source_dir / "manifest.yaml"
    if not p.exists():
        alt = source_dir / "manifest.yml"
        if alt.exists():
            return alt
    return p


def _read_manifest(source_dir: Path) -> dict:
    mp = _manifest_path(source_dir)
    return yaml.safe_load(mp.read_text(encoding="utf-8")) or {}


def _write_manifest(source_dir: Path, manifest: dict) -> None:
    """Replace the pack manifest atomically (temp file + rename).

    A direct ``write_text`` can leave a half-written manifest if the process
    dies mid-write, which strands the pack with an unparseable pointer table.
    Writing to a sibling ``.tmp`` and renaming makes the swap atomic under the
    pack lock that every caller holds.
    """
    mp = _manifest_path(source_dir)
    tmp = mp.with_suffix(mp.suffix + ".tmp")
    tmp.write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    tmp.replace(mp)


def _reload_manifest_for_merge(source_dir: Path, fallback: dict) -> dict:
    """Reload the on-disk manifest to merge a pointer into, or ``fallback``.

    Preparation writes reload the manifest *inside* the pack lock so a
    concurrent write's pointer is merged rather than clobbered (issue #60).
    A pack with no manifest on disk yet — a direct unit call, or a pack still
    being authored — has nothing to merge into, so the caller's snapshot is
    used as the base instead of failing the write.
    """
    mp = _manifest_path(source_dir)
    if not mp.exists():
        return dict(fallback)
    return _read_manifest(source_dir)


def _safe_source_path(source_dir: Path, rel: str) -> Path | None:
    """Resolve a manifest-declared relative path under ``source_dir``,
    refusing anything that escapes it.

    Manifest content (``stems[].file``, ``lyrics``, ``vocal_pitch``) is
    untrusted — it comes from inside a `.sloppak`/`.feedpak` package that
    may have been authored or shared by someone other than the library
    owner. Without this check, ``source_dir / rel`` has two failure modes:
    an absolute ``rel`` (e.g. ``/etc/passwd``) silently discards
    ``source_dir`` entirely (a pathlib quirk), and a ``rel`` containing
    ``..`` walks out of the pack directory. Either lets a crafted pack
    make this plugin read an arbitrary local file and — for the vocals
    stem — upload its bytes to the configured alignment/demucs server.
    """
    if not rel:
        return None
    safe = str(rel).replace("\\", "/")
    if "\x00" in safe:
        return None
    if (PurePosixPath(safe).is_absolute()
            or PureWindowsPath(safe).is_absolute()
            or PureWindowsPath(safe).drive):
        return None
    try:
        root = source_dir.resolve()
        candidate = Path(os.path.normpath(root / safe))
        if not candidate.is_relative_to(root):
            return None
    except (ValueError, OSError):
        return None
    return candidate


def _vocals_rel_path(manifest: dict) -> str | None:
    for s in manifest.get("stems", []) or []:
        if not isinstance(s, dict):
            continue
        if str(s.get("id", "")).lower() == "vocals":
            sfile = str(s.get("file", "")).strip()
            if sfile:
                return sfile
    return None


# ── Numeric coercion ──────────────────────────────────────────────────────────
#
# Sidecar JSON and a demucs server's /pitch response are both untrusted input.
# Python's json decoder accepts the bare literals NaN/Infinity/-Infinity and
# turns a JSON exponent overflow like 1e309 into a non-finite float, so
# ``float()`` succeeds but ``int()`` then raises OverflowError on the
# infinity. A huge integer literal decodes to an arbitrary-precision ``int``
# whose ``float()`` raises OverflowError outright. Both used to escape the
# readers' TypeError/ValueError guards and take down /playback or /data.

# MIDI 1.0 note numbers run 0–127; anything outside is a malformed record,
# not a pitch to draw.
MIDI_MIN = 0
MIDI_MAX = 127


def _coerce_finite_number(value: object) -> float | None:
    """Return ``float(value)`` when it's a finite JSON number, else ``None``.

    ``bool`` is rejected because it is an ``int`` subclass and would
    otherwise coerce to ``0.0``/``1.0``; strings are rejected rather than
    parsed so a stray ``"1.5"`` counts as an invalid type, matching
    ``_coerce_stringlike``'s treatment of ids.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _coerce_midi(value: object) -> int | None:
    """Return an integer MIDI note in ``[0, 127]``, or ``None`` when the
    record is malformed — non-numeric, non-finite, overflowing, or out of
    range. Follows the per-token drop policy: a bad pitch note is skipped
    and its lyric token stays unpitched rather than failing the request.

    The range is tested on the pre-conversion number, so a negative or
    above-127 fraction (``-0.5``, ``127.9``) is rejected rather than
    truncated into range; an in-range fraction (``60.9``) truncates toward
    zero, as the old ``int()`` call did.
    """
    number = _coerce_finite_number(value)
    if number is None:
        return None
    if not MIDI_MIN <= number <= MIDI_MAX:
        return None
    return int(number)


def _read_lyrics_tokens(source_dir: Path, rel: object) -> list[dict]:
    """Parse the lyrics sidecar at manifest-relative ``rel``.

    Returns an empty list when the pointer is missing, the file is absent or
    unparseable, or the payload isn't a list — callers gate on
    ``len(...) > 0`` so karaoke generation requires synced lyrics.
    """
    if not rel:
        return []
    p = _safe_source_path(source_dir, str(rel))
    if p is None or not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        t = _coerce_finite_number(item.get("t", 0.0))
        d = _coerce_finite_number(item.get("d", 0.0))
        if t is None or d is None or d <= 0:
            continue
        w = str(item.get("w", ""))
        out.append({"t": t, "d": d, "w": w})
    return out


def _lyrics_tokens(source_dir: Path, manifest: dict) -> list[dict]:
    """Return the primary voice's syllable list as ``[{t, d, w}, ...]``.

    Reads the singular ``lyrics`` manifest key — the compatibility alias the
    primary voice keeps in sync. Voice-targeted preparation reads a track's
    own pointer through `VoiceTarget` instead.
    """
    return _read_lyrics_tokens(source_dir, manifest.get("lyrics"))


# ── Canonical multi-voice playback payload ────────────────────────────────────
#
# One versioned shape for the player renderer to consume, covering today's
# single-singer sloppaks, lyrics-only sloppaks (no vocal_pitch.json), and —
# multi-voice/duet packs authored with the additive ``vocal_tracks``
# extension used by Karaoke Highway/feedpakr. The feedpak v1 spec requires
# Readers to ignore unknown additive keys, so older readers keep using the
# singular ``lyrics``/``vocal_pitch`` aliases while this endpoint can expose
# every singer. Packs without the extension retain the exact solo behavior.
#
# Unlike `_lyrics_tokens`/`_read_pitch_file` (tolerant — used by `/status`
# and the legacy `/data` overlay, which must keep degrading quietly), this
# path distinguishes "no side file at all" — absent manifest key, or a
# declared path that doesn't resolve to anything on disk; tolerated the
# same as `/status`/`/data`, since lyrics-only is a valid response shape
# here — from "side file present but unparseable" (a real error, reported
# as 422 rather than silently swallowed) so a *corrupt* pack doesn't
# masquerade as a merely unprepared/lyrics-only one.

PLAYBACK_SCHEMA_VERSION = 1


class PlaybackPayloadError(Exception):
    """Raised for malformed pack content; carries the HTTP status to return."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _read_json_strict(path: Path | None, *, what: str) -> object | None:
    """Read+parse ``path`` as JSON, or ``None`` if it doesn't exist.

    Raises ``PlaybackPayloadError(422, ...)`` on unparseable content — the
    file is present but not valid JSON, which is a broken pack, not an
    absent one. Never includes the filesystem path in the error message
    (packs may be shared/inspected; see `_safe_source_path`'s docstring).
    """
    if path is None or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise PlaybackPayloadError(422, f"Malformed {what}") from exc


def _canonical_voice_tokens(source_dir: Path, manifest: dict) -> list[dict]:
    """Build sorted, sanitized ``[{start, duration, text, midi?}]`` tokens
    for the primary voice from the ``lyrics``/``vocal_pitch`` manifest keys.

    Per-token sanitization mirrors `_lyrics_tokens`: a token with a
    non-finite or missing start time, or a non-finite/negative duration, is
    dropped rather than failing the whole request — one bad token shouldn't
    blank a whole song. Zero duration is kept (a beat/cue marker is valid).
    A malformed *file* (present but not valid JSON, or not shaped as
    expected) is a `PlaybackPayloadError`, not a silent drop.
    """
    lyrics_rel = manifest.get("lyrics")
    lyrics_path = _safe_source_path(source_dir, str(lyrics_rel)) if lyrics_rel else None
    raw_lyrics = _read_json_strict(lyrics_path, what="lyrics.json")
    if raw_lyrics is not None and not isinstance(raw_lyrics, list):
        raise PlaybackPayloadError(422, "Malformed lyrics.json")

    pitch_rel = manifest.get("vocal_pitch")
    pitch_path = _safe_source_path(source_dir, str(pitch_rel)) if pitch_rel else None
    raw_pitch = _read_json_strict(pitch_path, what="vocal_pitch.json")
    if raw_pitch is not None and (
        not isinstance(raw_pitch, dict) or not isinstance(raw_pitch.get("notes"), list)
    ):
        raise PlaybackPayloadError(422, "Malformed vocal_pitch.json")

    pitch_notes = raw_pitch.get("notes", []) if raw_pitch else []
    pitch_by_t: dict[str, int] = {}
    for note in pitch_notes:
        if not isinstance(note, dict):
            continue
        t = _coerce_finite_number(note.get("t"))
        midi = _coerce_midi(note.get("midi"))
        if t is None or midi is None:
            continue
        pitch_by_t[repr(t)] = midi

    tokens: list[dict] = []
    for item in raw_lyrics or []:
        if not isinstance(item, dict):
            continue
        start = _coerce_finite_number(item.get("t", 0.0))
        duration = _coerce_finite_number(item.get("d", 0.0))
        if start is None or duration is None or duration < 0:
            continue
        token = {"start": start, "duration": duration, "text": str(item.get("w", ""))}
        midi = pitch_by_t.get(repr(start))
        if midi is not None:
            token["midi"] = midi
        tokens.append(token)

    tokens.sort(key=lambda tok: tok["start"])
    return tokens


def _canonical_voices(source_dir: Path, manifest: dict) -> list[dict]:
    """Build canonical voice streams from ``vocal_tracks`` or solo aliases.

    PROVENANCE: the ``vocal_tracks`` merge shape (per-entry ``id``/``name``/
    ``primary``/``lyrics``/``vocal_pitch``, exactly-one-primary guarantee) is
    adapted from Karaoke Highway's ``_build_voices``
    (https://github.com/Taynavv/feedback-vocals-viz, `routes.py`,
    AGPL-3.0) — the reference implementation this epic absorbs (#18). See
    docs/architecture/vocals-visualization-integration.md's Provenance
    section for the reciprocal direction (this plugin's overlay geometry,
    ported the other way into that repo).

    ``vocal_tracks`` is an additive manifest extension shared with that
    reference implementation. Each entry carries ``id``, optional
    ``name``/``primary``, and its own ``lyrics``/``vocal_pitch`` pointers.
    Invalid non-mapping/empty entries are ignored like unusable token rows;
    duplicate ids are rejected because panel-local selection requires
    stable, unambiguous identity. Exactly one returned voice is primary
    (first flagged, otherwise first usable voice).
    """
    voices: list[dict] = []
    voice_sources: list[dict] = []
    tracks = manifest.get("vocal_tracks")
    if isinstance(tracks, list) and tracks:
        seen_ids: set[str] = set()
        primary_seen = False
        for entry in tracks:
            if not isinstance(entry, dict):
                continue
            tokens = _canonical_voice_tokens(source_dir, entry)
            if not tokens:
                continue
            raw_id = _coerce_stringlike(entry.get("id"))
            voice_id = raw_id.strip() if raw_id is not None else f"v{len(voices) + 1}"
            if not voice_id:
                voice_id = f"v{len(voices) + 1}"
            if voice_id in seen_ids:
                raise PlaybackPayloadError(422, f"Duplicate vocal track id: {voice_id}")
            seen_ids.add(voice_id)
            raw_name = _coerce_stringlike(entry.get("name"))
            is_primary = bool(entry.get("primary")) and not primary_seen
            if is_primary:
                primary_seen = True
            voices.append({
                "id": voice_id,
                "name": raw_name.strip() if raw_name and raw_name.strip() else None,
                "primary": is_primary,
                "tokens": tokens,
            })
            voice_sources.append(entry)
        if voices:
            if not primary_seen:
                voices[0]["primary"] = True
            primary_index = next(i for i, voice in enumerate(voices) if voice["primary"])
            primary_source = voice_sources[primary_index]
            drifted = []
            for key in ("lyrics", "vocal_pitch"):
                alias = _coerce_stringlike(manifest.get(key))
                target = _coerce_stringlike(primary_source.get(key))
                if alias is not None and alias != target:
                    drifted.append(key)
            if drifted:
                _log.warning(
                    "Legacy vocal alias(es) %s do not match primary vocal track %r in %s",
                    ", ".join(drifted), voices[primary_index]["id"], source_dir,
                )
            return voices

    tokens = _canonical_voice_tokens(source_dir, manifest)
    if not tokens:
        return []
    return [{
        "id": "primary",
        "name": "Vocals",
        "primary": True,
        "tokens": tokens,
    }]


def _coerce_stringlike(value: object) -> str | None:
    """``str(value)`` for a value that's genuinely string-or-int-shaped,
    else ``None``. Excludes ``bool`` — a Python ``bool`` is an ``int``
    subclass, so without this an id/name of ``True`` would stringify to
    the literal text "True" and masquerade as a real value.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (str, int)):
        return str(value)
    return None


def _arrangement_identity(manifest: dict, index: int | None) -> dict:
    """Resolve a requested arrangement index to a stable identity.

    The renderer knows which arrangement it was mounted for (core hands it
    ``songInfo.arrangement_index``) but not the pack's own ids, so echo the
    index back alongside the manifest's ``id``/``name`` for that entry —
    that is what makes a cached payload attributable to one arrangement
    rather than to a filename alone.

    ``index=None`` means the caller didn't say (every pre-existing caller,
    and the reason the field was a bare ``None`` placeholder before). An
    index that doesn't resolve against ``arrangements[]`` — out of range,
    or a malformed manifest entry — echoes the index with a null identity
    rather than inventing one or failing the request: the lyrics are
    song-level, so the tokens are still correct and still worth serving.
    """
    ident: dict = {"index": index, "id": None, "name": None}
    if index is None:
        return ident
    arrangements = manifest.get("arrangements")
    if not isinstance(arrangements, list) or not 0 <= index < len(arrangements):
        return ident
    entry = arrangements[index]
    if not isinstance(entry, dict):
        return ident
    arr_id = _coerce_stringlike(entry.get("id"))
    name = _coerce_stringlike(entry.get("name"))
    ident["id"] = arr_id
    # Per feedpak-spec §5.2 `name` defaults to `id` when absent.
    ident["name"] = name if name is not None else arr_id
    return ident


def _build_playback_payload(
    filename: str,
    source_dir: Path,
    manifest: dict,
    arrangement_index: int | None = None,
) -> dict:
    """Assemble the canonical playback payload for one resolved sloppak.

    Raises ``PlaybackPayloadError`` for malformed pack content. Returns a
    payload with an empty ``voices`` list when the pack has no usable
    lyrics tokens at all — callers treat that as "not found" (404), not a
    server error, since an unprepared song is a normal, expected state.
    """
    voices = _canonical_voices(source_dir, manifest)
    return {
        "schema_version": PLAYBACK_SCHEMA_VERSION,
        "song": {"filename": filename},
        "arrangement": _arrangement_identity(manifest, arrangement_index),
        "voices": voices,
    }


# ── Format / location helpers ─────────────────────────────────────────────────

def _job_lock_for(filename: str | Path) -> threading.Lock:
    """Per-canonical-pack lock, shared by every preparation write.

    Keyed on the *real* on-disk path so two filename aliases that resolve to
    one sloppak (a hardlink, a symlink, two library entries pointing at one
    archive) serialize against each other. Keying on the raw request filename
    would let each alias capture its own manifest snapshot and then clobber
    the other's pointer on commit (issue #60). Callers pass the resolved
    ``dlc_path``; a plain filename string still works (resolved against the
    cwd), so direct unit callers keep working.
    """
    key = os.path.realpath(str(filename))
    with _job_locks_guard:
        lock = _job_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _job_locks[key] = lock
        return lock


def _resolve_dlc_path(dlc: Path, filename: str) -> Path | None:
    """Contain ``filename`` under DLC_DIR using whichever core helper exists.

    Two core shapes matter here, and both helpers live in the host's ``lib/``
    directory (already on the plugin's import path, alongside ``sloppak``):

    * Current core ships ``dlc_paths._resolve_dlc_path`` — the shared
      containment helper, added in feedBack commit ``0dcc913`` and extracted
      from ``server.py``. It normalizes ``.``/``..`` LEXICALLY, so it does not
      follow a song entry that is a symlink pointing out of the library.
    * Core ``0.3.0-alpha.1`` (this manifest's ``minHost``) has no
      ``dlc_paths``; back then ``server._resolve_dlc_path`` was literally
      ``return safe_join(dlc, filename)``, and ``lib/safepath.safe_join``
      was already present. So the fallback delegates to ``safe_join`` — the
      same containment that host applied to its own filename-bound routes.

    Both resolve the ROOT before testing containment, so a library reached
    through a directory junction or symlink resolves on either shape. Neither
    can be handed a filename that names a path outside the library, which is
    the property this call site depends on — but the two are NOT otherwise
    ordered by strictness. They differ only on names that stay inside it:
    ``dlc_paths`` also refuses drive-absolute (``C:/x``) and NUL-containing
    names outright, which ``safe_join`` refuses only insofar as ``resolve()``
    rejects them; and it normalizes purely lexically, so it keeps a song entry
    that is a symlink pointing out of the library, where ``safe_join`` follows
    the link and refuses. That last case is the only one the fallback is
    stricter on, and it errs towards refusing, never towards a path outside the
    library. See
    ``docs/architecture/vocals-visualization-integration.md`` ("Minimum
    FeedBack version") for the full matrix and for how this floor stays
    separate from the optional per-player identity capability.

    The plugin deliberately does not re-implement containment: it delegates to
    core on both host shapes, so the check can never drift from the one core
    applies to its own filename-bound routes.

    Returns ``None`` — never an unguarded join — when neither helper is
    importable, so a host that lost both degrades to "song not found"
    (the 404 the caller already handles) rather than to an
    arbitrary-file read, and, since ``dlc_path`` is also the re-zip WRITE
    target (``_rezip_sloppak``), an arbitrary-file overwrite.
    """
    try:
        from dlc_paths import _resolve_dlc_path as core_resolve
    except ImportError:
        # No ``dlc_paths``: the pre-``0dcc913`` host, or a partial install
        # whose ``dlc_paths`` failed on its own ``appstate`` import. Both land
        # on ``safe_join``, core's containment helper in that release. Debug,
        # not warning: this runs per request, and the only user-visible
        # difference is the fallback's extra refusal of an out-of-library
        # symlinked song entry, which the caller reports as a 404 it already
        # handles.
        try:
            from safepath import safe_join
        except ImportError:
            _log.warning(
                "No core DLC containment helper available "
                "(neither dlc_paths nor safepath); refusing to resolve %r",
                filename,
            )
            return None
        _log.debug("No dlc_paths on this host; containing DLC paths with safepath.safe_join")
        return safe_join(dlc, filename)
    return core_resolve(dlc, filename)


def _resolve_sloppak(filename: str):
    """Resolve a sloppak filename to its source dir, manifest, and zip flag.

    Returns ``(source_dir, manifest, dlc_path, is_zip)`` or ``None`` when the
    target is missing or isn't a sloppak.
    """
    import sloppak as sloppak_mod

    if not filename:
        return None
    dlc = _get_dlc_dir() if _get_dlc_dir else None
    if not dlc:
        return None
    # `filename` arrives straight from the request (query param / JSON
    # body). Use core's shared containment helper rather than a bare
    # `dlc / filename` join — that would let a `../` (or similar) filename
    # resolve outside DLC_DIR, and downstream this path is also used as
    # the re-zip WRITE target (`_rezip_sloppak`), so an unguarded join
    # here is an arbitrary-file-overwrite primitive, not just a read.
    dlc_path = _resolve_dlc_path(dlc, filename)
    if dlc_path is None or not dlc_path.exists():
        return None
    if not sloppak_mod.is_sloppak(dlc_path):
        return None
    source_dir = sloppak_mod.resolve_source_dir(filename, dlc, SLOPPAK_CACHE_DIR)
    manifest = _read_manifest(source_dir)
    return source_dir, manifest, dlc_path, dlc_path.is_file()


def _read_pitch_file_rel(source_dir: Path, rel: object) -> dict | None:
    if not rel:
        return None
    p = _safe_source_path(source_dir, str(rel))
    if p is None or not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _read_pitch_file(source_dir: Path, manifest: dict) -> dict | None:
    return _read_pitch_file_rel(source_dir, manifest.get("vocal_pitch"))


# ── Pitch extraction ──────────────────────────────────────────────────────────

def _extract_pitch_per_syllable(vocals_path: Path, lyrics: list[dict]) -> list[dict]:
    """Run pYIN on the vocals stem and return one ``{t, d, midi}`` per
    syllable. The pipeline:

    1. Scan once with a wide fmin/fmax (C2-C6) to discover the singer's
       actual pitch centre — pYIN's octave error rate goes down a lot
       when the search range is narrowed to ~one octave around the
       singer's median.
    2. Re-scan with the narrowed range and use voiced_prob to weight
       per-frame pitches rather than treating voiced_flag as a binary
       gate (recovers pitched-but-quiet tails of held notes).
    3. Per syllable, take the **mode of semitone-rounded f0** instead of
       the median Hz — robust to a few wrong frames mid-syllable that
       would otherwise pull a Hz median off by a semitone.
    4. Apply per-token octave-error correction against the song-wide
       median midi. pYIN frequently misplaces a syllable an octave up
       or down on quiet/breathy notes; if shifting by ±12 brings the
       token closer to the median, do it.
    5. Neighbour-borrow midi for any token that still has none so whole
       phrases don't vanish from the chart.
    """
    import numpy as np  # noqa: WPS433 — local import keeps cold start cheap
    import librosa

    sr = 22050
    y, sr = librosa.load(str(vocals_path), sr=sr, mono=True)
    if y.size == 0:
        return []

    hop_length = 256
    frame_length = 2048
    wide_fmin = librosa.note_to_hz("C2")  # ~65.4 Hz — low male
    wide_fmax = librosa.note_to_hz("C6")  # ~1046 Hz — high female / falsetto

    def _run_pyin(fmin, fmax):
        return librosa.pyin(
            y,
            fmin=fmin,
            fmax=fmax,
            sr=sr,
            frame_length=frame_length,
            hop_length=hop_length,
        )

    # Pass 1: wide search to find the singer's actual range centre.
    f0_wide, _voiced_wide, prob_wide = _run_pyin(wide_fmin, wide_fmax)
    if f0_wide is None or len(f0_wide) == 0:
        return []

    f0_wide = np.asarray(f0_wide)
    prob_wide = np.asarray(prob_wide)
    confident_mask = (prob_wide > 0.5) & ~np.isnan(f0_wide) & (f0_wide > 0)
    if int(confident_mask.sum()) >= 32:
        midis_wide = 69 + 12 * np.log2(f0_wide[confident_mask] / 440.0)
        median_midi = float(np.median(midis_wide))
        # Narrow ±12 semitones around the median, clamped to the wide
        # range so an outlier-skewed median can't push us out of bounds.
        narrow_fmin = max(wide_fmin, 440.0 * (2 ** ((median_midi - 12 - 69) / 12)))
        narrow_fmax = min(wide_fmax, 440.0 * (2 ** ((median_midi + 12 - 69) / 12)))
        f0, _voiced, voiced_prob = _run_pyin(narrow_fmin, narrow_fmax)
        if f0 is None or len(f0) == 0:
            f0, voiced_prob = f0_wide, prob_wide
    else:
        # Not enough voiced material to narrow confidently — keep the
        # wide-range result rather than risk centering on noise.
        f0, voiced_prob = f0_wide, prob_wide

    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)
    f0 = np.asarray(f0)
    voiced_prob = np.asarray(voiced_prob)
    n_frames = len(times)

    # Per-syllable: weighted mode of semitone-rounded pitches. Frames
    # with low voicing probability still contribute (just less), which
    # rescues quiet held tails the binary voiced_flag would discard.
    raw: list[dict] = []
    for tok in lyrics:
        t0 = tok["t"]
        t1 = t0 + tok["d"]
        i0 = int(np.searchsorted(times, t0, side="left"))
        i1 = int(np.searchsorted(times, t1, side="right"))
        midi: int | None = None
        if i1 > i0 and i0 < n_frames:
            seg_hz = f0[i0:i1]
            seg_w = voiced_prob[i0:i1]
            mask = (~np.isnan(seg_hz)) & (seg_hz > 0) & (seg_w > 0.2)
            if mask.any():
                hz = seg_hz[mask]
                w = seg_w[mask]
                semitones = np.rint(69 + 12 * np.log2(hz / 440.0)).astype(int)
                # Weighted histogram across unique semitones — pick the
                # one with the highest summed voicing probability.
                unique = np.unique(semitones)
                weights = np.array(
                    [float(w[semitones == u].sum()) for u in unique],
                    dtype=float,
                )
                midi = int(unique[int(np.argmax(weights))])
        raw.append({"t": t0, "d": tok["d"], "midi": midi})

    # Octave-error correction against LOCAL neighbours, not the song-
    # wide median. Comparing to the median folded any note ≥12
    # semitones above median down by an octave — every typical chorus
    # high note ended up below the surrounding melody on the chart.
    # Real pYIN octave errors are localised: a single quiet syllable
    # jumps off its neighbours, while genuine high notes are
    # accompanied by other high notes. Snap only if a ±12 shift moves
    # the note meaningfully closer (≥3 semitones margin) to its
    # immediate neighbour median, so legitimate octave leaps stay put.
    raw_midis = [r["midi"] for r in raw]
    NEIGHBOUR_RADIUS = 3
    NEIGHBOUR_TIME_WINDOW_S = 5.0  # ignore neighbours across instrumental gaps
    MIN_NEIGHBOURS = 2  # never snap based on a single companion
    # Snap only when the original is *more than* a perfect octave from
    # the neighbour median. Notes within an octave cover every
    # legitimate intra-melody jump (sixths, sevenths, the perfect
    # octave leap itself) — touching them produces musically wrong
    # data. Only beyond an octave is the "this is an octave error"
    # interpretation more plausible than "this is a real leap".
    SNAP_OUTER_BAND = 12
    # And require the candidate to be meaningfully closer than the
    # original — at least a tritone of improvement — so we don't snap
    # on noise.
    SNAP_IMPROVEMENT = 6
    for i, r in enumerate(raw):
        if r["midi"] is None:
            continue
        t_centre = float(r["t"])
        neighbours = []
        # Walk outward up to NEIGHBOUR_RADIUS in each direction, filtering
        # by index distance and time distance — register changes after
        # an instrumental break are legitimate, not octave errors.
        for j in range(max(0, i - NEIGHBOUR_RADIUS), i):
            m = raw_midis[j]
            if m is None:
                continue
            if abs(float(raw[j]["t"]) - t_centre) > NEIGHBOUR_TIME_WINDOW_S:
                continue
            neighbours.append(int(m))
        for j in range(i + 1, min(len(raw), i + 1 + NEIGHBOUR_RADIUS)):
            m = raw_midis[j]
            if m is None:
                continue
            if abs(float(raw[j]["t"]) - t_centre) > NEIGHBOUR_TIME_WINDOW_S:
                continue
            neighbours.append(int(m))
        # Need at least two neighbours: with a single companion, every
        # ±12-semitone gap looks like an "error" and the two notes snap
        # onto each other (e.g. a [60, 72] pair would become [72, 60]).
        if len(neighbours) < MIN_NEIGHBOURS:
            continue
        local_centre = float(np.median(neighbours))
        base = int(r["midi"])
        base_dist = abs(base - local_centre)
        if base_dist <= SNAP_OUTER_BAND:
            # Within an octave of neighbours — leave alone, this is a
            # legitimate intra-melody interval (sixth, seventh, octave
            # leap) not an octave error.
            continue
        best = base
        best_dist = base_dist
        for shift in (-12, 12):
            cand = base + shift
            d = abs(cand - local_centre)
            if d + SNAP_IMPROVEMENT < best_dist:
                best, best_dist = cand, d
        r["midi"] = best

    # Neighbour-borrow for tokens that still have no midi (short
    # consonant-only syllables, fully unvoiced phrases). Skip if the
    # whole song has no confident pitch — nothing to borrow from.
    indexed_confident = [(i, r["midi"]) for i, r in enumerate(raw) if r["midi"] is not None]
    if indexed_confident:
        for i, r in enumerate(raw):
            if r["midi"] is not None:
                continue
            nearest = min(indexed_confident, key=lambda c: abs(c[0] - i))
            r["midi"] = nearest[1]

    return [r for r in raw if r["midi"] is not None]


def _extract_pitch_via_server(server_url: str, vocals_path: Path, lyrics: list[dict]) -> list[dict]:
    """Ask the demucs server's CREPE-backed /pitch endpoint for per-syllable
    midis. Raises on transport failure / non-2xx so the caller can fall
    back to the local extractor. Returns the same shape as
    ``_extract_pitch_per_syllable`` so callers are interchangeable.
    """
    import requests  # noqa: WPS433 — matches /align's local import style

    payload_lyrics = json.dumps(
        [{"t": float(t["t"]), "d": float(t["d"])} for t in lyrics]
    )
    with open(vocals_path, "rb") as f:
        resp = requests.post(
            f"{server_url}/pitch",
            files={"file": (vocals_path.name, f, "audio/ogg")},
            data={"lyrics": payload_lyrics},
            timeout=600,  # CREPE on CPU on a long song can take a few minutes
        )
    if resp.status_code == 404 or resp.status_code == 501:
        # /pitch isn't available on this server (older build or torchcrepe
        # not installed). Signal the caller to fall back.
        raise NotImplementedError(f"server has no /pitch endpoint (HTTP {resp.status_code})")
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, dict) and "error" in body:
        raise RuntimeError(f"server /pitch error: {body['error']}")
    notes = body.get("notes") if isinstance(body, dict) else None
    if not isinstance(notes, list):
        raise RuntimeError("server /pitch response missing 'notes' list")
    # Coerce to the local shape: int midi, float t/d. Remote output is
    # untrusted — a malformed record is dropped here, before it can reach
    # _persist_pitch, rather than being written into vocal_pitch.json.
    out: list[dict] = []
    for n in notes:
        if not isinstance(n, dict):
            continue
        t = _coerce_finite_number(n.get("t"))
        d = _coerce_finite_number(n.get("d"))
        midi = _coerce_midi(n.get("midi"))
        if t is None or d is None or d < 0 or midi is None:
            continue
        out.append({"t": t, "d": d, "midi": midi})
    return out


# ── Voice targeting (preparation) ─────────────────────────────────────────────
#
# The preparation routes (/status, /align, /save-lyrics, /generate-pitch) can
# target ONE voice of a duet pack authored with the additive ``vocal_tracks``
# extension. A target resolves to the sidecar paths that voice owns, so a save
# writes that track's own ``lyrics``/``vocal_pitch`` pointers instead of the
# shared hardcoded ``lyrics.json``/``vocal_pitch.json`` filenames — the bug
# where a duet save reported success while ``/playback`` kept serving the
# primary's stale ``lead.json``. The primary voice also keeps the singular
# compatibility aliases in sync, because older readers rely on them; a
# secondary voice never touches the aliases or another track's files. Solo
# packs (no ``vocal_tracks``) keep the legacy singular pointers: the solo
# voice IS the singular aliases, so reads and writes honor whatever file they
# name.

_DEFAULT_LYRICS_REL = "lyrics.json"
_DEFAULT_PITCH_REL = "vocal_pitch.json"


class VoiceTargetError(Exception):
    """Raised when a requested voice can't be resolved. Carries the HTTP
    status the route should return, matching `LyricsPersistenceError`."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class VoiceTarget:
    """One preparable voice: the sidecar pointers it owns plus manifest
    aliases. ``entry`` is the ``vocal_tracks`` mapping for a duet voice, or
    ``None`` for a solo pack (whose singular aliases ARE the pointers)."""

    __slots__ = ("id", "name", "primary", "solo", "entry", "lyrics_rel", "pitch_rel")

    def __init__(self, *, voice_id, name, primary, solo, entry, lyrics_rel, pitch_rel):
        self.id = voice_id
        self.name = name
        self.primary = primary
        self.solo = solo
        self.entry = entry
        self.lyrics_rel = lyrics_rel
        self.pitch_rel = pitch_rel


def _track_usable(source_dir: Path, entry: dict) -> bool:
    """Whether an entry is renderable right now — it has synced lyrics.

    Matches `_canonical_voices`'s inclusion rule: a track with no usable
    tokens doesn't appear in `/playback`, so it doesn't consume the blank-id
    numbers below. An unusable track is still addressable (it is precisely the
    part awaiting preparation), just never miscounted as someone else's id.
    """
    return bool(_read_lyrics_tokens(source_dir, entry.get("lyrics")))


def _voice_entries(source_dir: Path, manifest: dict) -> list[tuple[str, dict, bool]]:
    """Return ``[(id, entry, usable), ...]`` for the manifest's voices.

    Returns ``[]`` for a solo pack (no ``vocal_tracks``). Renderable entries
    come first, in manifest order, so a blank id gets ``v{n}`` exactly as
    `_canonical_voices` numbers it (the renderable voices seen so far, plus
    one) — an id `/playback` serves is never re-used for a different track
    here. Tracks that aren't renderable yet stay addressable and continue the
    sequence after them. Duplicate ids raise `VoiceTargetError` (even when
    one copy isn't renderable yet — an ambiguous id is a pack error, and
    preparing the other copy would silently flip it into `/playback`'s view).
    Non-mapping entries can't carry pointers or be addressed, so they are
    skipped.
    """
    tracks = manifest.get("vocal_tracks")
    if not isinstance(tracks, list) or not tracks:
        return []
    usable: list[tuple[dict, str]] = []
    unusable: list[tuple[dict, str]] = []
    for entry in tracks:
        if not isinstance(entry, dict):
            continue
        raw_id = _coerce_stringlike(entry.get("id"))
        voice_id = raw_id.strip() if raw_id is not None else ""
        if _track_usable(source_dir, entry):
            usable.append((entry, voice_id))
        else:
            unusable.append((entry, voice_id))

    entries: list[tuple[str, dict, bool]] = []
    seen: set[str] = set()
    usable_seen = 0
    for entry, voice_id in usable:
        if not voice_id:
            voice_id = f"v{usable_seen + 1}"
        if voice_id in seen:
            raise VoiceTargetError(422, f"Duplicate vocal track id: {voice_id}")
        seen.add(voice_id)
        usable_seen += 1
        entries.append((voice_id, entry, True))

    next_id = usable_seen + 1
    for entry, voice_id in unusable:
        if not voice_id:
            voice_id = f"v{next_id}"
            while voice_id in seen:
                next_id += 1
                voice_id = f"v{next_id}"
            next_id += 1
        if voice_id in seen:
            raise VoiceTargetError(422, f"Duplicate vocal track id: {voice_id}")
        seen.add(voice_id)
        entries.append((voice_id, entry, False))
    return entries


def _voice_name(entry: dict) -> str | None:
    raw_name = _coerce_stringlike(entry.get("name"))
    return raw_name.strip() if raw_name and raw_name.strip() else None


def _voice_primary_id(entries: list[tuple[str, dict, bool]]) -> str:
    """The id `/playback` renders as primary: the first flagged *renderable*
    entry, else the first renderable entry — mirroring `_canonical_voices`,
    which only indexes tracks with usable tokens — so a default build targets
    the same track the player shows as the lead. For a pack with nothing
    renderable yet, falls back to the first flagged entry, then the first
    addressable one, so a fresh duet still has a default target.
    """
    for voice_id, entry, usable in entries:
        if usable and bool(entry.get("primary")):
            return voice_id
    for voice_id, _entry, usable in entries:
        if usable:
            return voice_id
    for voice_id, entry, _usable in entries:
        if bool(entry.get("primary")):
            return voice_id
    return entries[0][0]


def _safe_voice_rel(source_dir: Path, rel: object) -> str | None:
    """Return a manifest pointer that stays inside ``source_dir``, else ``None``.

    A crafted pack can declare an absolute or ``..`` pointer; ignoring it and
    falling back to a generated filename keeps preparation from writing outside
    the pack. `_safe_source_path` also rejects NUL/drive-absolute names.
    """
    text = _coerce_stringlike(rel)
    if text is None:
        return None
    text = text.strip()
    if not text:
        return None
    if _safe_source_path(source_dir, text) is None:
        return None
    return text


def _voice_slug(voice_id: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", str(voice_id)).strip("._-")
    return slug or "voice"


def _unique_voice_slug(voice_id: str, entries: list[tuple[str, dict, bool]]) -> str:
    """A filesystem-safe slug for ``voice_id`` that no other voice shares.

    Distinct ids can slug to the same text (``a/b`` and ``a_b`` both map to
    ``a_b``), so the first occurrence keeps the bare slug and later ones get a
    ``-2``/``-3`` suffix by addressable position. Position-based, so
    re-preparing a voice deterministically writes the same file.
    """
    base = _voice_slug(voice_id)
    n = 1
    for vid, _entry, _usable in entries:
        if vid == voice_id:
            break
        if _voice_slug(vid) == base:
            n += 1
    return base if n == 1 else f"{base}-{n}"


def _default_voice_sidecars(
    source_dir: Path, manifest: dict, voice_id: str, primary: bool,
    entries: list[tuple[str, dict, bool]],
) -> tuple[str, str]:
    """Filenames for a voice with no declared sidecar pointer.

    The primary voice inherits the singular aliases (so a solo-era pack keeps
    reading its existing files) or the legacy default names. A secondary voice
    gets an id-slugged name, disambiguated against its siblings, so two voices
    can never be given the same file.
    """
    if primary:
        return (
            _safe_voice_rel(source_dir, manifest.get("lyrics")) or _DEFAULT_LYRICS_REL,
            _safe_voice_rel(source_dir, manifest.get("vocal_pitch")) or _DEFAULT_PITCH_REL,
        )
    slug = _unique_voice_slug(voice_id, entries)
    return f"{slug}.lyrics.json", f"{slug}.vocal_pitch.json"


def _resolve_voice_target(
    source_dir: Path, manifest: dict, voice_id: str | None = None
) -> VoiceTarget:
    """Resolve ``voice_id`` to a `VoiceTarget`, or the default voice when None.

    Raises `VoiceTargetError(422)` for an unknown id, and for a pack whose
    ``vocal_tracks`` carry duplicate ids. The default is the voice `/playback`
    renders as primary — the first flagged renderable track, else the first
    renderable one, else (for a pack with nothing prepared yet) the first
    flagged or first addressable track — or the solo voice of a pack without
    ``vocal_tracks``.
    """
    requested = _coerce_stringlike(voice_id)
    requested = requested.strip() if requested is not None else ""

    entries = _voice_entries(source_dir, manifest)
    if not entries:
        if requested and requested != "primary":
            raise VoiceTargetError(422, f"Unknown vocal track id: {voice_id}")
        return VoiceTarget(
            voice_id="primary", name="Vocals", primary=True, solo=True, entry=None,
            lyrics_rel=_safe_voice_rel(source_dir, manifest.get("lyrics")) or _DEFAULT_LYRICS_REL,
            pitch_rel=_safe_voice_rel(source_dir, manifest.get("vocal_pitch")) or _DEFAULT_PITCH_REL,
        )

    primary_id = _voice_primary_id(entries)
    if requested:
        for vid, entry, _usable in entries:
            if vid == requested:
                chosen_id, chosen = vid, entry
                break
        else:
            raise VoiceTargetError(422, f"Unknown vocal track id: {voice_id}")
    else:
        chosen_id = primary_id
        chosen = next(entry for vid, entry, _usable in entries if vid == chosen_id)

    primary = chosen_id == primary_id
    lyrics_rel = _safe_voice_rel(source_dir, chosen.get("lyrics"))
    pitch_rel = _safe_voice_rel(source_dir, chosen.get("vocal_pitch"))
    if lyrics_rel is None or pitch_rel is None:
        default_lyrics, default_pitch = _default_voice_sidecars(
            source_dir, manifest, chosen_id, primary, entries
        )
        if lyrics_rel is None:
            lyrics_rel = default_lyrics
        if pitch_rel is None:
            pitch_rel = default_pitch
    return VoiceTarget(
        voice_id=chosen_id, name=_voice_name(chosen), primary=primary, solo=False,
        entry=chosen, lyrics_rel=lyrics_rel, pitch_rel=pitch_rel,
    )


def _apply_voice_pointer(manifest: dict, target: VoiceTarget, key: str, rel: str) -> bool:
    """Point the manifest at ``rel`` for ``key`` (``lyrics``/``vocal_pitch``).

    A solo target, or the primary voice of a duet, also updates the singular
    compatibility alias; a secondary voice writes only its own track pointer,
    so it can never clobber the primary's alias. Returns True if anything
    changed, so the caller only rewrites the manifest when it must.
    """
    changed = False
    if target.solo or target.entry is None:
        if manifest.get(key) != rel:
            manifest[key] = rel
            changed = True
        return changed
    if target.entry.get(key) != rel:
        target.entry[key] = rel
        changed = True
    if target.primary and manifest.get(key) != rel:
        manifest[key] = rel
        changed = True
    return changed


def _voice_summaries(source_dir: Path, manifest: dict) -> list[dict]:
    """``[{id, name, primary}]`` for the setup screen's voice selector.

    Includes every addressable voice, prepared or not, so the UI can offer a
    part whose sidecars don't exist yet. Raises `VoiceTargetError` on duplicate
    ids, like `/playback` does.
    """
    entries = _voice_entries(source_dir, manifest)
    if not entries:
        return [{"id": "primary", "name": "Vocals", "primary": True}]
    primary_id = _voice_primary_id(entries)
    return [
        {"id": voice_id, "name": _voice_name(entry), "primary": voice_id == primary_id}
        for voice_id, entry, _usable in entries
    ]


# ── Persistence: write JSON + patch manifest + re-zip ─────────────────────────

def _rezip_sloppak(source_dir: Path, output_path: Path) -> None:
    """Replace the zip-form sloppak with the contents of source_dir.

    Keeps a one-time ``.bak`` of the original next to it so a botched run
    is recoverable. Writes via ``.tmp`` + atomic replace so a crash mid-zip
    doesn't leave a half-written archive.
    """
    if output_path.exists() and output_path.is_file():
        backup = output_path.with_suffix(output_path.suffix + ".bak")
        if not backup.exists():
            shutil.copy2(output_path, backup)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_zip = output_path.with_suffix(output_path.suffix + ".tmp")
    if tmp_zip.exists():
        tmp_zip.unlink()
    with zipfile.ZipFile(str(tmp_zip), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in source_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(source_dir).as_posix())
    tmp_zip.replace(output_path)


def _atomic_write_json(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


class LyricsPersistenceError(Exception):
    """Raised when alignment segments can't yield a usable ``lyrics.json``.

    Carries the HTTP status the route should return. Raised BEFORE any
    sidecar, manifest, or archive write, so a malformed request can never
    overwrite an existing lyrics sidecar with an empty one.
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _lyrics_content_hash(source_dir: Path, rel: object) -> str | None:
    """SHA-256 of the raw bytes of the lyrics sidecar at manifest-relative
    ``rel``, or ``None`` when the pointer is unsafe or the file is absent.

    Pitch extraction runs outside the pack lock (pYIN/CREPE is minutes-long),
    so a concurrent save-lyrics can replace the lyrics while it runs. Hashing
    the exact bytes the extraction was driven by lets the commit detect that
    and refuse to attach pitches to a different lyric set.
    """
    p = _safe_source_path(source_dir, str(rel)) if rel else None
    if p is None or not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


class StalePitchError(Exception):
    """Raised when the lyrics that drove pitch extraction changed before commit.

    Carries the HTTP status the route should return. Raised inside the write
    lock, AFTER the pitches are computed, so a stale result never gets written
    — the caller re-runs generate-pitch against the fresh lyrics instead.
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _persist_lyrics(
    source_dir: Path,
    manifest: dict,
    segments: list[dict],
    dlc_path: Path,
    is_zip: bool,
    target: VoiceTarget | None = None,
) -> tuple[int, int]:
    """Convert alignment segments to the sloppak lyrics format and persist.

    Returns ``(written, dropped)``.

    ``target`` selects the voice whose sidecar and manifest pointers are
    written (see `_resolve_voice_target`); ``None`` resolves the default
    voice — the primary of a duet pack, or the solo voice — preserving the
    legacy single-voice behavior.

    Unusable segments are dropped rather than failing the whole request,
    mirroring the tolerant per-token reads in `_lyrics_tokens` — one bad row
    from the aligner shouldn't blank a song. A *partial* result is therefore
    accepted, with the ``dropped`` count surfaced to the caller, but a result
    where every entry is unusable (empty, wrong shape, non-finite times, or
    non-positive duration) raises `LyricsPersistenceError` instead of writing
    ``[]`` over the existing sidecar. The check runs before the sidecar,
    manifest, or archive is touched, so a rejected save is a true no-op.

    The sidecar write, manifest patch, and re-zip all run under the canonical
    pack lock, and the manifest is *reloaded from disk inside that lock* so a
    concurrent write's pointer is merged instead of clobbered — patching a
    stale snapshot is what dropped the other write's pointer (issue #60). The
    target is re-resolved against the reloaded manifest so the sidecar path
    and pointers reflect what is on disk now.
    """
    lyrics_data = []
    dropped = 0
    for seg in segments:
        if not isinstance(seg, dict):
            dropped += 1
            continue
        try:
            start = float(seg["start"])
            end = float(seg["end"])
        except (KeyError, TypeError, ValueError):
            dropped += 1
            continue
        if not math.isfinite(start) or not math.isfinite(end):
            dropped += 1
            continue
        d = end - start
        if not math.isfinite(d) or d <= 0:
            dropped += 1
            continue
        lyrics_data.append({
            "t": round(start, 3),
            "d": round(d, 3),
            "w": str(seg.get("text", "")),
        })

    if not lyrics_data:
        raise LyricsPersistenceError(
            422,
            f"No usable lyric segments: all {len(segments)} entries were "
            "invalid (need finite start < end); existing lyrics left untouched",
        )

    if target is None:
        target = _resolve_voice_target(source_dir, manifest)

    with _job_lock_for(dlc_path):
        current = _reload_manifest_for_merge(source_dir, manifest)
        current_target = _resolve_voice_target(source_dir, current, target.id)
        lyrics_path = _safe_source_path(source_dir, current_target.lyrics_rel)
        if lyrics_path is None:
            raise VoiceTargetError(422, f"Unsafe lyrics path: {current_target.lyrics_rel}")

        _atomic_write_json(lyrics_path, lyrics_data)

        if _apply_voice_pointer(current, current_target, "lyrics", current_target.lyrics_rel):
            _write_manifest(source_dir, current)

        # Reflect the committed (merged) manifest back into the caller's
        # snapshot so it no longer describes a stale on-disk state.
        manifest.clear()
        manifest.update(current)

        if is_zip:
            _rezip_sloppak(source_dir, dlc_path)
    return len(lyrics_data), dropped


def _persist_pitch(
    source_dir: Path,
    manifest: dict,
    notes: list[dict],
    dlc_path: Path,
    is_zip: bool,
    target: VoiceTarget | None = None,
    expected_lyrics_hash: str | None = None,
) -> None:
    """Persist per-syllable pitch, merged into the live manifest under the lock.

    ``expected_lyrics_hash`` is the content hash of the lyrics the pitches were
    extracted against (see `_lyrics_content_hash`). Extraction runs outside the
    lock, so a concurrent save-lyrics can replace the lyrics while it runs;
    when that hash no longer matches the current lyrics this raises
    `StalePitchError` rather than attaching pitches to changed lyrics.

    The manifest is reloaded inside the lock and the target re-resolved against
    it, so a concurrent write's pointer is merged rather than clobbered
    (issue #60).
    """
    if target is None:
        target = _resolve_voice_target(source_dir, manifest)

    with _job_lock_for(dlc_path):
        current = _reload_manifest_for_merge(source_dir, manifest)
        current_target = _resolve_voice_target(source_dir, current, target.id)

        if expected_lyrics_hash is not None:
            live_hash = _lyrics_content_hash(source_dir, current_target.lyrics_rel)
            if live_hash != expected_lyrics_hash:
                raise StalePitchError(
                    409,
                    "Lyrics changed during pitch extraction; re-run "
                    "generate-pitch against the current lyrics",
                )

        pitch_path = _safe_source_path(source_dir, current_target.pitch_rel)
        if pitch_path is None:
            raise VoiceTargetError(422, f"Unsafe pitch path: {current_target.pitch_rel}")

        pitch_payload = {"version": 1, "notes": notes}
        _atomic_write_json(pitch_path, pitch_payload)

        if _apply_voice_pointer(current, current_target, "vocal_pitch", current_target.pitch_rel):
            _write_manifest(source_dir, current)

        manifest.clear()
        manifest.update(current)

        if is_zip:
            _rezip_sloppak(source_dir, dlc_path)

# ── LRC formatter (export only) ───────────────────────────────────────────────

def _lrc_timestamp(t: float) -> str:
    """Format a time in seconds as an LRC "mm:ss.xx" timestamp.

    Computing minutes/seconds independently with `int(t // 60)` /
    `f"{t % 60:05.2f}"` looks right but isn't: `:05.2f` rounds its operand,
    so a seconds remainder like 59.996 prints as "60.00" instead of rolling
    into the next minute — e.g. t=119.999 produced the invalid "[01:60.00]"
    rather than "[02:00.00]". Round to whole centiseconds FIRST, then split
    into minutes/seconds, so the carry happens before formatting.
    """
    seconds = float(t)
    if not math.isfinite(seconds):
        raise ValueError("LRC timestamp must be finite")
    # A value can pass isfinite() above yet still overflow to inf once
    # scaled to centiseconds (e.g. 1e307 * 100 exceeds the max double),
    # which round() below would turn into the same unhelpful
    # OverflowError this function exists to guard against.
    scaled = max(0.0, seconds) * 100
    if not math.isfinite(scaled):
        raise ValueError("LRC timestamp must be finite")
    total_centis = round(scaled)
    minutes, centis = divmod(total_centis, 6000)
    return f"{minutes:02d}:{centis / 100:05.2f}"


def _format_lrc(segments: list[dict]) -> str:
    """Convert alignment segments to the standard LRC line format."""
    lines = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        try:
            t = float(seg["start"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(t):
            continue
        try:
            timestamp = _lrc_timestamp(t)
        except ValueError:
            continue
        lines.append(f"[{timestamp}]{seg.get('text', '')}")
    return "\n".join(lines) + "\n"


# ── HTTP routes ───────────────────────────────────────────────────────────────

def setup(app: FastAPI, context: dict):
    global _config_dir, _get_dlc_dir, SLOPPAK_CACHE_DIR, _log

    _config_dir = context["config_dir"]
    _get_dlc_dir = context["get_dlc_dir"]
    _log = context.get("log") or _log
    get_cache = context.get("get_sloppak_cache_dir", lambda: None)
    SLOPPAK_CACHE_DIR = get_cache()
    if SLOPPAK_CACHE_DIR is None:
        static_dir = Path(os.environ.get("STATIC_DIR", "/app/static"))
        SLOPPAK_CACHE_DIR = static_dir / "sloppak_cache"

    # ── Per-song readiness ────────────────────────────────────────────────

    @app.get("/api/plugins/lyrics_karaoke/status")
    def lk_status(filename: str = "", voice: str = ""):
        """Per-song readiness check.

        Returns the flag set the setup screen and the in-player toggle
        both consume. archive songs have ``is_sloppak=False`` and the rest
        of the flags are meaningless.

        ``voice`` selects which part the flags describe (a duet pack's
        ``vocal_tracks`` id); omitted, it defaults to the primary voice.
        ``voices`` always lists every addressable part so the setup screen
        can offer them, and the per-voice flags are what the build pipeline
        gates on — so the selector, the checklist, and the write routes all
        agree on the selected voice. An unknown or duplicated id is a 422.
        """
        result = {
            "filename": filename,
            "is_sloppak": False,
            "has_vocals": False,
            "has_lyrics": False,
            "has_pitch": False,
            "pitch_count": 0,
        }
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return result
        source_dir, manifest, _dlc_path, _is_zip = resolved
        result["is_sloppak"] = True
        try:
            target = _resolve_voice_target(source_dir, manifest, voice or None)
            result["voice"] = target.id
            result["voices"] = _voice_summaries(source_dir, manifest)
        except VoiceTargetError as exc:
            return JSONResponse({"error": exc.message}, exc.status)
        vocals_rel = _vocals_rel_path(manifest)
        vocals_path = _safe_source_path(source_dir, vocals_rel) if vocals_rel else None
        if vocals_path and vocals_path.exists():
            result["has_vocals"] = True
        if _read_lyrics_tokens(source_dir, target.lyrics_rel):
            result["has_lyrics"] = True
        pitch = _read_pitch_file_rel(source_dir, target.pitch_rel)
        if pitch and isinstance(pitch.get("notes"), list):
            result["has_pitch"] = True
            result["pitch_count"] = len(pitch["notes"])
        return result

    @app.get("/api/plugins/lyrics_karaoke/server-status")
    def lk_server_status():
        """Health-check the configured alignment / demucs server.

        The setup screen polls this once per visit so the user gets a
        clear "alignment server unavailable" banner if their config is
        stale, instead of a cryptic timeout when they hit Build.
        """
        url = _get_demucs_server_url()
        if not url:
            return {"available": False, "reason": "No demucs server configured"}
        try:
            import requests
            resp = requests.get(f"{url}/health", timeout=5)
            if resp.status_code == 200:
                return {"available": True, "server_url": url}
            return {"available": False, "reason": f"Server returned {resp.status_code}"}
        except Exception as e:  # noqa: BLE001 — surface to UI
            return {"available": False, "reason": str(e)}

    # ── Player overlay data ──────────────────────────────────────────────

    @app.get("/api/plugins/lyrics_karaoke/data")
    def lk_data(filename: str = ""):
        """Bundle lyrics + pitch into a single per-syllable list.

        Pre-merged so the renderer doesn't need to match floats across
        a Python/JS rounding boundary. ``midi`` is present only on
        syllables that produced a confidently-voiced pitch.
        """
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 404)
        source_dir, manifest, _dlc_path, _is_zip = resolved
        pitch = _read_pitch_file(source_dir, manifest)
        if not pitch:
            return JSONResponse({"error": "No vocal_pitch.json"}, 404)
        notes = pitch.get("notes") if isinstance(pitch, dict) else None
        if not isinstance(notes, list):
            return JSONResponse({"error": "Malformed vocal_pitch.json"}, 500)

        pitch_by_t: dict[str, int] = {}
        for n in notes:
            if not isinstance(n, dict):
                continue
            t = _coerce_finite_number(n.get("t"))
            midi = _coerce_midi(n.get("midi"))
            if t is None or midi is None:
                continue
            pitch_by_t[repr(t)] = midi

        merged = []
        for tok in _lyrics_tokens(source_dir, manifest):
            entry = {"t": tok["t"], "d": tok["d"], "w": tok["w"]}
            mid = pitch_by_t.get(repr(float(tok["t"])))
            if mid is not None:
                entry["midi"] = mid
            merged.append(entry)
        return {"filename": filename, "tokens": merged}

    @app.get("/api/plugins/lyrics_karaoke/playback")
    def lk_playback(filename: str = "", arrangement: int | None = None):
        """Canonical multi-voice playback payload (see module docstring).

        Superset of ``/data`` shaped for the integrated visualization
        provider: ``{schema_version, song, arrangement, voices: [{id,
        name, primary, tokens: [{start, duration, text, midi?}]}]}``.
        ``/data`` is unaffected and keeps serving its existing shape.

        ``arrangement`` is the OPTIONAL zero-based index the caller is
        mounted for (core hands the renderer ``songInfo.arrangement_index``);
        it only labels the response — lyrics are song-level in feedpak v1, so
        the tokens are identical whatever is passed, and omitting it is the
        pre-existing behaviour. A negative index is rejected outright rather
        than echoed, since no arrangement list can ever satisfy it.
        """
        if arrangement is not None and arrangement < 0:
            return JSONResponse({"error": "Invalid arrangement index"}, 422)
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 404)
        source_dir, manifest, _dlc_path, _is_zip = resolved
        try:
            payload = _build_playback_payload(
                filename, source_dir, manifest, arrangement_index=arrangement
            )
        except PlaybackPayloadError as exc:
            return JSONResponse({"error": exc.message}, exc.status)
        if not payload["voices"]:
            return JSONResponse({"error": "No lyrics data"}, 404)
        return payload

    # ── Stage 1: align lyrics text with Whisper ───────────────────────────

    @app.post("/api/plugins/lyrics_karaoke/align")
    def lk_align(data: dict):
        """Send vocals + plain lyric text to the alignment server.

        Returns ``{segments: [{start, end, text, ...}]}`` on success.
        The caller previews this and then POSTs to ``/save-lyrics`` to
        commit the result to the sloppak.

        ``voice`` names the duet part this alignment is for; it is validated
        (and echoed back) so a stale or unknown selector fails here rather
        than silently saving the result to the wrong track. Alignment itself
        always runs on the song's vocals stem — the ``vocal_tracks`` extension
        carries per-voice lyric/pitch pointers, not a per-voice stem.
        """
        filename = (data or {}).get("filename", "")
        lyrics_text = ((data or {}).get("lyrics_text") or "").strip()
        language = (data or {}).get("language", "")
        granularity = (data or {}).get("granularity", "syllable")
        voice = (data or {}).get("voice", "")

        if not filename:
            return JSONResponse({"error": "filename required"}, 400)
        if not lyrics_text:
            return JSONResponse({"error": "lyrics_text required"}, 400)

        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, _dlc_path, _is_zip = resolved
        try:
            target = _resolve_voice_target(source_dir, manifest, voice or None)
        except VoiceTargetError as exc:
            return JSONResponse({"error": exc.message}, exc.status)

        vocals_rel = _vocals_rel_path(manifest)
        if not vocals_rel:
            return JSONResponse(
                {"error": "No vocals stem — split stems with Demucs first."},
                400,
            )
        vocals_path = _safe_source_path(source_dir, vocals_rel)
        if vocals_path is None or not vocals_path.exists():
            return JSONResponse(
                {"error": f"Vocals stem missing on disk: {vocals_rel}"},
                400,
            )

        server_url = _get_demucs_server_url()
        if not server_url:
            return JSONResponse({"error": "No demucs server configured"}, 400)

        import requests
        try:
            with open(vocals_path, "rb") as f:
                resp = requests.post(
                    f"{server_url}/align",
                    files={"file": (vocals_path.name, f, "audio/ogg")},
                    data={
                        "text": lyrics_text,
                        "language": language,
                        "granularity": granularity,
                    },
                    timeout=300,
                )
        except requests.Timeout:
            return JSONResponse({"error": "Alignment request timed out"}, 504)
        except requests.ConnectionError:
            return JSONResponse({"error": "Cannot connect to alignment server"}, 502)

        if resp.status_code != 200:
            return JSONResponse(
                {"error": f"Alignment server error: {resp.text[:500]}"},
                502,
            )

        result = resp.json()
        if isinstance(result, dict) and "error" in result:
            return JSONResponse(
                {"error": f"Alignment failed: {result['error']}"},
                502,
            )
        if isinstance(result, dict):
            # Echo the validated voice so the caller passes the same target to
            # /save-lyrics, even when it was resolved from the default.
            result.setdefault("voice", target.id)
        return result

    @app.post("/api/plugins/lyrics_karaoke/save-lyrics")
    def lk_save_lyrics(data: dict):
        """Persist alignment segments as the selected voice's lyrics sidecar.

        Partial-invalid input is accepted: segments the sanitizer can use are
        written and the count of dropped entries comes back as
        ``dropped_count`` (also a warning in the log). A result with *no*
        usable segment is rejected with 422 before any write, so a malformed
        alignment can never erase existing lyrics — the response body says
        so and the pack is left byte-for-byte unchanged.

        ``voice`` selects the duet part to write (``vocal_tracks`` id); the
        primary voice also updates the singular ``lyrics`` alias, a secondary
        voice writes only its own pointer. Omitted, it defaults to the
        primary/solo voice, which is exactly the legacy behavior.
        """
        filename = (data or {}).get("filename", "")
        segments = (data or {}).get("segments", []) or []
        voice = (data or {}).get("voice", "")
        if not filename:
            return JSONResponse({"error": "filename required"}, 400)
        if not isinstance(segments, list) or not segments:
            return JSONResponse({"error": "segments required"}, 400)

        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, dlc_path, is_zip = resolved
        try:
            target = _resolve_voice_target(source_dir, manifest, voice or None)
        except VoiceTargetError as exc:
            return JSONResponse({"error": exc.message}, exc.status)

        try:
            count, dropped = _persist_lyrics(
                source_dir, manifest, segments, dlc_path, is_zip, target=target
            )
        except LyricsPersistenceError as exc:
            return JSONResponse({"error": exc.message}, exc.status)
        except VoiceTargetError as exc:
            return JSONResponse({"error": exc.message}, exc.status)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"Persist failed: {exc}"}, 500)
        payload = {"ok": True, "lyrics_count": count, "voice": target.id}
        if dropped:
            _log.warning(
                "save-lyrics: dropped %d unusable segment(s) of %d for %r",
                dropped, len(segments), filename,
            )
            payload["dropped_count"] = dropped
        return payload

    # ── Stage 2: extract per-syllable pitch ───────────────────────────────

    @app.post("/api/plugins/lyrics_karaoke/generate-pitch")
    async def lk_generate_pitch(data: dict):
        """Run pYIN on the vocals stem and persist the selected voice's pitch.

        The target and the lyrics that drive extraction are captured under the
        pack lock, so the snapshot is consistent; the lock is then released
        while the heavy extraction runs, because holding it would block every
        other preparation write on the song for the duration. `_persist_pitch`
        re-acquires the lock and re-checks that the lyrics are unchanged before
        committing, rejecting a stale result instead of attaching pitches to
        changed lyrics (issue #60).

        ``voice`` selects the duet part: its own synced lyrics drive the
        per-syllable boundaries and its own ``vocal_pitch`` pointer is
        written, while the primary voice also updates the singular alias.
        Omitted, it defaults to the primary/solo voice.
        """
        filename = (data or {}).get("filename", "")
        voice = (data or {}).get("voice", "")
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse(
                {"error": "Not a sloppak song"},
                400,
            )
        source_dir, manifest, dlc_path, is_zip = resolved

        # Capture the target + lyrics snapshot under the pack lock so the
        # manifest pointer and the sidecar it names are read as one state.
        lock = _job_lock_for(dlc_path)
        tmp_dir = None
        with lock:
            manifest = _read_manifest(source_dir)
            try:
                target = _resolve_voice_target(source_dir, manifest, voice or None)
            except VoiceTargetError as exc:
                return JSONResponse({"error": exc.message}, exc.status)

            vocals_rel = _vocals_rel_path(manifest)
            if not vocals_rel:
                return JSONResponse(
                    {"error": "No vocals stem — split stems with Demucs first."},
                    400,
                )
            vocals_path = _safe_source_path(source_dir, vocals_rel)
            if vocals_path is None or not vocals_path.exists():
                return JSONResponse(
                    {"error": f"Vocals stem missing on disk: {vocals_rel}"},
                    400,
                )

            lyrics = _read_lyrics_tokens(source_dir, target.lyrics_rel)
            lyrics_hash = _lyrics_content_hash(source_dir, target.lyrics_rel)
            if not lyrics or lyrics_hash is None:
                return JSONResponse(
                    {"error": "No synced lyrics — align lyrics first."},
                    400,
                )

            # Read the vocals stem from a temp copy so concurrent writes to
            # the unpack cache (re-zip etc.) don't churn the working file.
            tmp_dir = Path(tempfile.mkdtemp(prefix="lk-pitch-"))
            tmp_vocals = tmp_dir / vocals_path.name
            shutil.copy2(vocals_path, tmp_vocals)

        server_url = _get_demucs_server_url()

        def _worker() -> tuple[bool, dict]:
            # Extraction only — no lock and no writes. A save-lyrics may land
            # here; `_persist_pitch` detects that and refuses the stale result.
            notes: list[dict] | None = None
            used_server = False
            # Try the demucs server's /pitch endpoint first when configured —
            # CREPE on the GPU is dramatically more accurate than pYIN here.
            # Fall through to the local extractor on any transport /
            # availability failure so users without the server (or on an older
            # build without /pitch) keep working.
            if server_url:
                try:
                    notes = _extract_pitch_via_server(server_url, tmp_vocals, lyrics)
                    used_server = True
                except NotImplementedError:
                    _log.info("/pitch not available on demucs server, using local pYIN")
                except Exception as exc:  # noqa: BLE001
                    _log.warning("demucs /pitch failed (%s); falling back to local pYIN", exc)
            if notes is None:
                try:
                    notes = _extract_pitch_per_syllable(tmp_vocals, lyrics)
                except Exception as exc:  # noqa: BLE001
                    return False, {"error": f"Pitch extraction failed: {exc}"}
            if not notes:
                return False, {
                    "error": (
                        "Pitch extraction produced no voiced syllables — "
                        "the vocals stem may be silent or noise-only."
                    ),
                }
            return True, {
                "notes": notes,
                "used_server": used_server,
                "syllables_total": len(lyrics),
            }

        try:
            # get_running_loop(), not get_event_loop(): this coroutine only
            # ever runs inside a live event loop (it's an async route
            # handler), so there's no "create one if none exists" case to
            # fall back on — get_event_loop()'s deprecated implicit-loop
            # behavior for a no-running-loop caller doesn't apply here, but
            # get_running_loop() is still the more correct, self-documenting
            # call for "the loop I'm already running in".
            ok, extracted = await asyncio.get_running_loop().run_in_executor(None, _worker)
            if not ok:
                status = extracted.pop("_status", 500)
                return JSONResponse(extracted, status)

            notes = extracted["notes"]
            try:
                _persist_pitch(
                    source_dir, manifest, notes, dlc_path, is_zip,
                    target=target, expected_lyrics_hash=lyrics_hash,
                )
            except StalePitchError as exc:
                return JSONResponse({"error": exc.message}, exc.status)
            except VoiceTargetError as exc:
                return JSONResponse({"error": exc.message}, exc.status)
            except Exception as exc:  # noqa: BLE001
                return JSONResponse({"error": f"Persist failed: {exc}"}, 500)
            return {
                "ok": True,
                "notes_count": len(notes),
                "syllables_total": extracted["syllables_total"],
                "extractor": "server-crepe" if extracted["used_server"] else "local-pyin",
                "voice": target.id,
            }
        finally:
            if tmp_dir is not None:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    # ── Optional export ───────────────────────────────────────────────────

    @app.post("/api/plugins/lyrics_karaoke/export")
    def lk_export(data: dict):
        """Produce a downloadable ``.lrc`` file from alignment segments.

        Independent of save-to-song — useful for sharing the synced
        lyrics outside the sloppak (e.g. submitting to lyric DBs).
        """
        segments = (data or {}).get("segments", []) or []
        if not isinstance(segments, list) or not segments:
            return JSONResponse({"error": "No segments provided"}, 400)

        title = str((data or {}).get("title", "") or "")
        artist = str((data or {}).get("artist", "") or "")

        header_lines = []
        if title:
            header_lines.append(f"[ti:{title}]")
        if artist:
            header_lines.append(f"[ar:{artist}]")
        header_lines.append("[by:Slopsmith Lyrics Karaoke]")
        header = "\n".join(header_lines) + "\n"

        lrc = header + _format_lrc(segments)

        safe_name = f"{artist} - {title}".strip(" -") or "lyrics"
        safe_name = safe_name.replace("/", "_").replace("\\", "_")

        # Quote-escape for the legacy `filename=` fallback, and provide an
        # RFC 5987 `filename*=` form so non-ASCII / quote characters in
        # title-artist can't corrupt or break out of the header value.
        # The `\` escape is a no-op today (safe_name already stripped `\`
        # above) but guards this line if that stripping ever changes.
        # Starlette encodes headers as Latin-1, so non-Latin-1 / control
        # characters in the legacy fallback would raise UnicodeEncodeError —
        # fold anything outside printable ASCII to `_` there; filename*
        # carries the real UTF-8 name via percent-encoding regardless.
        ascii_safe_name = re.sub(r"[^\x20-\x7e]", "_", safe_name)
        ascii_name = ascii_safe_name.replace("\\", "\\\\").replace('"', '\\"')
        encoded_name = quote(f"{safe_name}.lrc", safe="")

        return Response(
            content=lrc,
            media_type="text/plain",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{ascii_name}.lrc"; '
                    f"filename*=UTF-8''{encoded_name}"
                ),
            },
        )
