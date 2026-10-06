# Lyrics Karaoke user guide

This guide is for people using the plugin to sing, not for people modifying
it. It explains everything the plugin does, from preparing a song to scoring
your voice during playback, and a new user can install and use the plugin
from this document alone. Architecture decisions and the playback data
contract live in [docs/architecture/](architecture/) instead.

Part of the release documentation for
[#17](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/17)
([#42](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/42)).

## What this plugin does

Lyrics Karaoke has two halves with separate responsibilities:

**Preparation** happens in the plugin's own screen (open **Lyrics Karaoke**
from FeedBack's plugin navigation). It takes a song with an isolated vocals
stem, aligns plain lyric text against that stem (Whisper), and extracts
per-syllable pitch (CREPE/pYIN). The results — `lyrics.json` plus optional
`vocal_pitch.json` — are written into the song pack once, ahead of playback.
Preparation can use a remote alignment service and the Python audio stack,
so it is the heavier half. Songs can also be prepared once and used forever;
existing packs do not need regeneration.

**Playback** happens inside FeedBack's player, on the plugin's pitch ribbon.
It only ever reads the prepared data — through
`GET /api/plugins/lyrics_karaoke/playback`, which never runs pitch
extraction, loads no audio model, and touches no microphone state by itself.
So a song you prepared keeps playing with no alignment service, no Python
dependencies, and no microphone connected.

## Installation and host requirements

Install the plugin in FeedBack's plugin directory (a release zip extracted
there, or a git clone FeedBack can update in place) and enable it. Then:

- **FeedBack 0.3.0-alpha.1 or later** (`plugin.json` `minHost`). The
  renderer is built on the host's `setRenderer` lifecycle.
- One backend helper beyond that: the shared DLC containment helper
  `lib/dlc_paths.py`, first shipped in feedBack commit
  [`0dcc913`](https://github.com/got-feedBack/feedBack/commit/0dcc913). Hosts
  older than that commit stay **supported**: the plugin falls back to its own
  `safe_join`, and only song packs that are symlinks pointing *outside* the
  library are refused on such hosts.
- **Karaoke Highway preferences carry over.** Compatible stored scoring
  values (tolerance, octave-free matching, mic timing, mic device and
  channel) are imported once from its `vocals_highway.*` settings — nothing
  extra to install. See [Settings](#settings).
- **Note Detect, if you have it, must be 1.15.2 or newer** to run the two
  plugins together. Note Detect is optional; below that floor, lyrics
  playback is unaffected but microphone feedback is withheld and the 🎤
  control explains why. Updating Note Detect is enough: click 🎤 again —
  no reload, nothing re-prepared.
- **Scoring needs a browser** supporting `getUserMedia` plus permission for
  the chosen device. Playback without scoring needs no microphone at all.
- **Alignment** (for preparing lyrics) needs the host's Stems / Lyrics Sync
  settings pointed at an alignment service — optional for packs that already
  carry `lyrics.json`.
- **Pitch generation** uses the Python dependencies in `requirements.txt`
  and prefers a configured CREPE-backed `/pitch` server, falling back to
  local pYIN. Packs that already carry `vocal_pitch.json` need neither.

Scoping karaoke to the active player additionally uses the host's
`player-identity` capability, which arrived after `0.3.0-alpha.1`. Hosts
without it still prepare, render, and score; only the per-player voice role
is skipped.

## Prepare a song

1. Open **Lyrics Karaoke** from FeedBack's plugin navigation.
2. **Pick a song** — search lists songs with an isolated vocals stem.
3. The **prerequisites checklist** shows whether the pack already has
   synced lyrics and per-syllable pitch.
4. If lyrics are missing, paste plain lyric text (one line per line), or a
   `.txt`/`.lrc` file, choose a language hint (or `auto`) and a granularity
   (syllable / word / line), then **Build Karaoke**.
5. When the pack is ready you can **Open in player**, **Download .lrc**,
   and **Re-extract pitch** independently at any time.

Everything is per-song and re-runnable: align lyrics, generate pitch,
re-extract, clear, export LRC. A song with synced lyrics and no pitch still
plays — in **lyrics-only mode**, without pitch slabs or scoring.

## Play and score

In the player, choose a **Vocals** arrangement and turn on the **Karaoke**
button. The ribbon draws pitch lanes, note slabs, timed syllables, and a
lyric line with a bouncing cue under the syllable you are on — across a
silent lead-in that cue becomes a get-ready countdown. Scored pitches and
guide bars share one song-wide pitch axis, so a harmony an octave above the
lead still sits on the strip.

Click the shared **🎤** control only when you want to be scored. With the
microphone listening you get a live trace of the pitch you sang at the
playhead, a red→amber→green accuracy tint on what you have sung, and a
status readout showing the current note, accuracy, and streak
(`F4 · 92% · ×5`-style). The **Karaoke** button and the ribbon work with no
microphone whatsoever.

Microphone scoring has one state machine you can see in the control:

| State | What you see |
| --- | --- |
| Off | 🎤 idle; lyrics and ribbon keep running |
| Requesting | The browser asks for permission once |
| Listening | Live trace, tint, and note/accuracy/streak readout |
| Suspended | Audio context needs a click: an inline "Click 🎤 again" message |
| Blocked | Disabled with the reason inline (denied permission, device busy, older Note Detect) |
| Device lost | Capture stops, error appears; reconnect and click 🎤 again |

## Settings

Karaoke is deliberately low-control. What you control directly:

- **🎤** — starts and stops capture. The only path to the microphone.
- **Microphone input** — a default-mic or multichannel picker; the saved
  device is re-selected when present and otherwise falls back safely.
- **Capture channel** — **Mix**, **Ch 1**, or **Ch 2** for stereo interfaces.
- **Scoring panel** (splitscreen only) — which vocals panel the microphone
  scores; only one panel can own it at a time.

What the renderer runs on internally (you normally do not touch these):
**Microphone feedback** (on),
**Octave-free pitch match** (off), **Pitch tolerance** (1 semitone),
**Mic timing offset** (0 ms), **Sung part** (`primary` voice),
**Left rail** (`absolute` scale). These descriptors are not declared in the
manifest as of 1.13.0, so no host renders controls for them, and
tolerance/octave-free/timing follow this plugin's own stored engine
preferences — a calibrated value from before 1.13.0 keeps applying with no
control.
Re-homing them into the karaoke UI is the remainder of
[#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32).

## Microphone privacy and calibration

**Privacy.** Microphone access starts only when you click **🎤** — nothing
requests it on load, on song change, or from a restored setting, and
permission can be denied without stopping lyric playback. Audio is captured,
analyzed for pitch in the plugin's own code, then dropped: raw audio is
never stored or transmitted. Closing the panel, changing song or sung part,
or stopping capture releases the browser stream. In splitscreen only one
panel owns the microphone at a time, and the shared 🎤 control is the only
way in or out.

**Calibration.** Scoring compares the pitch you sing with the target at the
playhead. Two knobs adjust for round-trip delay and your voice:

- **Mic timing offset** (±1000 ms) calibrates the hear → sing → capture
  loop. Raise it if you register consistently late — Bluetooth audio and
  wireless mics add delay the plugin cannot measure. It re-dates incoming
  mic frames only; playback and drawing are untouched. Sing along on time
  and adjust until your trace sits on the note bars. Currently a stored
  value with no control (see [Settings](#settings)).
- **Pitch tolerance** (semitones) and **Octave-free pitch match** loosen
  matching: tolerance widens the accepted band around the target note,
  octave-free accepts your own convenient octave. Same story — engine
  preference while #32 is unfinished.

## Duets and splitscreen

**Duets.** A pack with `vocal_tracks` carries separate voices. All parts
draw on one ribbon — the sung part as note slabs, the others as thin guide
bars. Switching sung part switches what you are scored on and re-anchors
state locally; results never carry over between parts.

**Splitscreen.** Every panel owns its renderer and its state; nothing is
shared through module globals, so two vocals panels cannot overwrite each
other. The microphone is the one shared resource: the **Scoring panel**
selector chooses the owner, ownership is exclusive, and per-panel state
(score, streak, sung trace, part selection) stays separate. A vocals panel
alongside an instrument panel is supported the same way.

## Fallback behavior and troubleshooting

**Fallback.** When the highway renderer is unavailable — an older host with
no renderer consumer, a failed install, or renderer failure — the legacy
pitch-ribbon overlay remains the compatibility path. Overlay and renderer
ownership are exclusive, including microphone capture and scoring.
Compatible Karaoke Highway preferences are imported once; its old
microphone-on state is ignored, so capture still needs an explicit click.
Removing or downgrading the plugin never rewrites prepared song data: keep
the same song packs when rolling back.

**Troubleshooting.**

| Symptom | Check |
| --- | --- |
| The highway renderer isn't offered in the picker / Auto / splitscreen dropdown | Since 1.13.0 it is no longer listed there (migration in progress). The **Karaoke** button gives the ribbon; a saved splitscreen panel still loads the renderer. |
| Song does not resolve on an old host | A song pack that is a symlink pointing outside the library is refused by the pre-`0dcc913` fallback; update the host. |
| Lyrics but no pitch slabs | Generate pitch for that song; lyrics-only playback is supported. |
| No microphone scoring | Click 🎤, grant browser permission, and sing a pitched part. |
| Wrong input or channel | Use the shared device and Mix / Ch 1 / Ch 2 selectors; reconnect a missing device and start capture again. |
| Microphone says busy or unavailable | Another application or panel holds the device. Release it, then click 🎤 again. |
| The 🎤 control is disabled | An older Note Detect (< 1.15.2) is installed; update Note Detect and click 🎤 again. |
| Voice appears late or early | Calibrate with the mic timing offset (see above); the control returns with the rest of #32. |
| Pack fails to load | Check that `lyrics.json` and `vocal_pitch.json` referenced by the manifest are valid JSON; malformed packs are reported separately from missing ones. |
| Session score looks stale | Play/pause/seek/song-switch are all pinned; if anything survives a transport change, report it. |

## Screenshots

Actual screenshots must come from a running FeedBack host with
[#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)'s
presentation landed, so the states below are **provisional** until then:
this documents the shot list, not final captures. Generate copyright-free
test media with
`python tests/fixtures/generate_feedpaks.py OUTPUT_DIR` (or grab the
`vocals-synthetic-packs` CI artifact) so no private songs appear, then
capture and attach to `docs/screenshots/`:

| State | Show |
| --- | --- |
| Pitched solo | Ribbon lanes, note slabs, syllables, lyric line |
| Duet with guide bars | Sung part plus the other voice's guide bars on one axis |
| Lyrics only | Lyric ribbon without pitch data |
| Lead-in countdown | Cue across a silent lead-in |
| Active mic trace | Live sung trace and accuracy tint while listening |
| End-of-song score | Score / streak / accuracy summary |
| Narrow panel | Same states at a narrow splitscreen width |
| Two vocals panels | Separate per-panel state, mic owned by one |

The same states, with privacy notes (strip player names, private song
titles, and microphone device names before sharing), are the screenshot
evidence rows in
[docs/release-manual-matrix.md](release-manual-matrix.md).

## License and source credit

This plugin is distributed under
[AGPL-3.0](../LICENSE); the visualization adapts work from
[Karaoke Highway](https://github.com/Taynavv/feedback-vocals-viz) by
Taynavv and its contributors, which is itself AGPL-3.0 (and credits this
plugin for parts of its microphone and ribbon engine — a shared lineage,
not a conflict). Adapted sections retain provenance comments in `screen.js`
and `routes.py`, [NOTICE.md](../NOTICE.md) records the adaptation dates, and
the [integration architecture](architecture/vocals-visualization-integration.md)
records the data and ownership decisions. The complete source for this
version is in the
[get-flashbacks repository](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke).
The plugin is a community-maintained fork, not an official got-feedBack
release; the official plugin lives at
[got-feedBack/feedBack-plugin-lyrics-karaoke](https://github.com/got-feedback/feedBack-plugin-lyrics-karaoke).
