"""Build copyright-free vocal packs for route and manual smoke tests.

Run ``python tests/fixtures/generate_feedpaks.py OUTPUT_DIR``. The archives
contain only invented syllables and metadata; no audio or copyrighted media.
They exercise prepared-data playback, not the preparation pipeline.
"""

from __future__ import annotations

import io
import json
import math
import struct
import sys
import wave
import zipfile
from pathlib import Path

import yaml


def _synthetic_vocals_wav():
    """A short original two-note tone with silence around it (PCM WAV)."""
    sample_rate = 22050
    samples = []
    for index in range(sample_rate * 3):
        second = index / sample_rate
        frequency = 261.63 if second < 0.9 else 293.66
        amplitude = 0.12 if 0.5 <= second < 1.4 else 0.0
        samples.append(struct.pack("<h", round(
            32767 * amplitude * math.sin(2 * math.pi * frequency * second),
        )))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(b"".join(samples))
    return buffer.getvalue()


def _lyrics(*items):
    return [{"t": start, "d": duration, "w": word} for start, duration, word in items]


def _pitch(*items):
    return {"version": 1, "notes": [
        {"t": start, "d": duration, "midi": midi}
        for start, duration, midi in items
    ]}


def fixture_specs():
    """Return independent manifests and sidecars for each playback mode."""
    lead = _lyrics((0.5, 0.4, "la-"), (0.9, 0.5, "la+"))
    complete = _pitch((0.5, 0.4, 60), (0.9, 0.5, 62))
    return {
        "single-voice": (
            {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"},
            {"lyrics.json": lead, "vocal_pitch.json": complete},
        ),
        "duet": (
            {
                "lyrics": "lead.json", "vocal_pitch": "lead_pitch.json",
                "vocal_tracks": [
                    {"id": "lead", "name": "Lead", "primary": True,
                     "lyrics": "lead.json", "vocal_pitch": "lead_pitch.json"},
                    {"id": "harmony", "name": "Harmony",
                     "lyrics": "harmony.json", "vocal_pitch": "harmony_pitch.json"},
                ],
            },
            {
                "lead.json": lead, "lead_pitch.json": complete,
                "harmony.json": _lyrics((0.5, 0.9, "oh+")),
                "harmony_pitch.json": _pitch((0.5, 0.9, 55)),
            },
        ),
        "incomplete-pitch": (
            {"lyrics": "lyrics.json", "vocal_pitch": "vocal_pitch.json"},
            {"lyrics.json": lead,
             "vocal_pitch.json": _pitch((0.5, 0.4, 60))},
        ),
        "lyrics-only": (
            {"lyrics": "lyrics.json"},
            {"lyrics.json": lead},
        ),
    }


def generate(output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)
    audio = _synthetic_vocals_wav()
    paths = {}
    for name, (fields, sidecars) in fixture_specs().items():
        manifest = {
            "format_version": 1,
            "title": f"Synthetic {name}",
            "artist": "Lyrics Karaoke test fixture",
            "duration": 3.0,
            "arrangements": [{"id": "vocals", "name": "Vocals",
                              "file": "arrangements/vocals.json"}],
            "stems": [{"id": "full", "file": "stems/full.wav", "default": True},
                      {"id": "vocals", "file": "stems/vocals.wav"}],
            **fields,
        }
        path = output_dir / f"{name}.sloppak"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as pack:
            pack.writestr("manifest.yaml", yaml.safe_dump(manifest, sort_keys=False))
            pack.writestr("arrangements/vocals.json", json.dumps({
                "name": "Vocals", "notes": [], "chords": [], "anchors": [],
                "handshapes": [], "templates": [], "beats": [], "sections": [],
            }))
            pack.writestr("stems/full.wav", audio)
            pack.writestr("stems/vocals.wav", audio)
            for filename, content in sidecars.items():
                pack.writestr(filename, json.dumps(content, sort_keys=True))
        paths[name] = path
    return paths


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate_feedpaks.py OUTPUT_DIR")
    for path in generate(Path(sys.argv[1])).values():
        print(path)
