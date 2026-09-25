# Lyrics Karaoke

Lyrics Karaoke prepares synced lyrics and vocal pitch for a song, then shows
them in FeedBack's vocals highway during playback. The plugin id remains
`lyrics_karaoke`; existing prepared songs do not need regeneration.

## Install and requirements

Install this plugin in FeedBack's plugin directory and enable it in the host.
The highway visualization requires FeedBack **0.3.0-alpha.1 or later**. Older
hosts continue to use the legacy karaoke overlay. The preparation screen also
needs the host's song library and, for alignment, a configured alignment
server. Pitch generation uses the plugin's Python audio dependencies in
`requirements.txt`.

## Prepare a song

Open **Lyrics Karaoke** from FeedBack's plugin navigation, choose a song with
a vocals stem, and run **Build Karaoke**. The preparation screen can also
align/save lyrics, generate pitch, re-extract, clear, and export LRC
independently. It writes `lyrics.json` and optional `vocal_pitch.json` into
the song pack. A song with synced lyrics and no pitch still plays in
lyrics-only mode. Preparation can involve the configured alignment service;
the playback renderer only reads already-prepared data through `/playback`.

Existing packs prepared by Lyrics Karaoke 1.4.6 or later continue to work.
For a duet, `vocal_tracks` may describe separate voices while the singular
`lyrics` and `vocal_pitch` entries remain aliases for the primary voice.
See the [playback contract](docs/architecture/vocals-playback-contract.md) for
that manifest shape.

## Play and score

Choose a **Vocals** arrangement. FeedBack's Auto visualization selects the
Lyrics Karaoke highway when the host supports it. The canvas shows pitch
lanes, note slabs, timed syllables, and, in a duet, guide bars for the other
part. **Sung part** chooses the part to score for each panel. **Left rail**
switches between absolute pitch, technique feedback, and off.

Microphone access starts only when you click the shared **🎤** control.
Permission can be denied without stopping lyric playback. The device and
channel selectors support a default mic or a multichannel interface; the
scoring-panel selector chooses which vocals panel owns the microphone in
splitscreen. Only one panel can own it at a time. Closing the panel, changing
song or part, or stopping capture releases the stream. Audio is analyzed in
the plugin for pitch; raw audio is not stored or transmitted.

The visualization settings include **Microphone feedback**, **Octave-free
pitch match**, **Pitch tolerance**, **Mic timing offset**, **Sung part**, and
**Left rail**. To calibrate timing, sing a short known note and adjust **Mic
timing offset (ms)** until the sung trace aligns with the note slab. This
changes scoring alignment, not playback. Start with the default 0 ms and
change it only when the trace consistently leads or lags.

## Fallback, migration, and rollback

If the provider is unavailable or disabled, the legacy overlay remains the
compatibility path. Provider and overlay ownership is exclusive, including
microphone capture and scoring. Compatible Karaoke Highway preferences are
imported once; its old microphone-on state is ignored so capture still needs
an explicit click. Removing this plugin version or selecting the legacy path
does not rewrite prepared song data. Keep the same song packs when rolling
back to a compatible Lyrics Karaoke release.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No highway | Use FeedBack 0.3.0-alpha.1 or later, a Vocals arrangement, and Auto or Lyrics Karaoke visualization. |
| Lyrics but no pitch slabs | Generate pitch for that song; lyrics-only playback is supported. |
| No microphone scoring | Enable Microphone feedback, click 🎤, grant browser permission, and select a pitched part. |
| Wrong input or channel | Use the shared device and Mix / Ch 1 / Ch 2 selectors; reconnect a missing device and start capture again. |
| Voice appears late or early | Adjust Mic timing offset in small steps while singing a known note. |
| Pack fails to load | Check that `lyrics.json` and `vocal_pitch.json` referenced by the manifest are valid JSON; the renderer reports malformed packs separately from missing ones. |

## Development and provenance

Install test dependencies with
`python -m pip install pytest fastapi pyyaml httpx`, then run
`python -m pytest -q tests` and
`node --test tests/screen.test.js tests/vocal-engine.test.js` from this
directory. `python tests/fixtures/generate_feedpaks.py OUTPUT_DIR` creates
four packs with synthetic tone audio for route and host smoke tests; the
generator needs `pyyaml`. CI also uploads them as a `vocals-synthetic-packs`
artifact for manual testing.

The visualization adapts work from
[Karaoke Highway](https://github.com/Taynavv/feedback-vocals-viz), licensed
AGPL-3.0. The adapted sections in `screen.js` and `routes.py` retain source
comments; the [integration architecture](docs/architecture/vocals-visualization-integration.md)
records the data and ownership decisions.
