# Lyrics Karaoke

Lyrics Karaoke prepares synced lyrics and vocal pitch for a song, then shows
them in FeedBack's vocals highway during playback. The plugin id remains
`lyrics_karaoke`; existing prepared songs do not need regeneration.

New users: start with the [user guide](docs/user-guide.md) — it covers
installation, preparing and playing songs, microphone privacy and
calibration, duets and splitscreen, fallback, and troubleshooting. This
README stays focused on fork differences and development.

## Why choose the get-flashbacks edition?

Choose this edition if you want singing to run on FeedBack's own highway.
The vocals renderer renders timed syllables, note slabs, and guide bars for
duets, scores a chosen voice from an explicitly started microphone, and works
in splitscreen alongside an instrument or another vocals panel. The
preparation tools and the legacy pitch-ribbon overlay are also here, so
existing prepared packs do not need to be rebuilt.

The [official got-feedBack plugin](https://github.com/got-feedBack/feedBack-plugin-lyrics-karaoke)
already prepares lyrics and pitch and offers an overlay with microphone
feedback. As of 2026-09-25, its `main` branch is version 1.4.1; this edition
adds the host-managed visualization and multi-voice playback contract. It is
a community-maintained fork, not an official got-feedBack release.

## Install and requirements

Install this plugin in FeedBack's plugin directory and enable it in the host.
The highway renderer requires FeedBack **0.3.0-alpha.1 or later**. Older
hosts, and hosts on 1.13.0 with no consumer for the factory, use the legacy
karaoke overlay.

As of 2026-10-02 this edition is mid-migration. Since 1.13.0
([#44](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/44))
it no longer appears in FeedBack's visualization picker, in Auto mode, or in
splitscreen's per-panel dropdown, and the **Karaoke** button still drives the
legacy pitch ribbon rather than the highway renderer. The renderer itself is
unchanged and still builds from the plugin factory, so a splitscreen panel
that already had Lyrics Karaoke saved as its visualization keeps loading it.
The rest of
[#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)
wires it behind the Karaoke button.

### Core compatibility

`plugin.json` declares `minHost: 0.3.0-alpha.1`, the release whose
`setRenderer` lifecycle this plugin's renderer is built on. The backend needs
one core helper beyond that: the shared DLC containment helper in
`lib/dlc_paths.py`, first shipped in feedBack commit
[`0dcc913`](https://github.com/got-feedBack/feedBack/commit/0dcc913). No core
release represents that commit yet, so `plugin.json` pins the commit under
`host_requirements.backend` until one does.

Hosts older than `0dcc913` are supported rather than blocked: `routes.py` falls
back to `lib/safepath.py` `safe_join`, which is exactly what the host's own
`_resolve_dlc_path` was before the extraction. Preparation routes and
`/playback` therefore work from `minHost` upward. Both helpers refuse anything
resolving outside the song library, and the plugin never joins a requested
filename onto the library directory unchecked — if a host somehow ships
neither helper, song resolution refuses rather than guessing. The two differ
on names that stay *inside* the library: the newer helper also refuses
drive-absolute and NUL-containing names outright, and it deliberately keeps a
song entry that is a symlink pointing out of the library, which the older one
follows and then refuses. Both resolve the library root itself first, so a
library mounted through a symlink or junction resolves on either host.

Per-player identity is a separate, optional capability. Scoping karaoke to the
active player needs the host's `player-identity` capability
(`window.feedBack.playerContexts`), which arrived after `0.3.0-alpha.1`. Hosts
without it still prepare lyrics and pitch, render the highway, and score the
microphone; only the voice role attached to the active player is skipped.

### Prerequisites that are not core compatibility

These are separate from the host version above — a fully current host still
needs them:

- **Microphone and browser.** Scoring needs a browser that supports
  `getUserMedia`, plus permission for the selected device or channel. Playback
  without scoring needs no microphone at all.
- **Alignment.** Building lyrics needs a configured alignment service (see the
  host's Stems / Lyrics Sync settings). Alignment is optional if a pack already
  carries `lyrics.json`.
- **Pitch.** Generating pitch uses the plugin's own Python audio dependencies in
  `requirements.txt`. It prefers a configured CREPE-backed `/pitch` server and
  falls back to local pYIN, so a song can be prepared with no remote service.
  Packs that already carry `vocal_pitch.json` need neither.

**Note Detect 1.15.2 or newer is required to run the two together.** Note
Detect remains optional: Lyrics Karaoke works fully on its own. That floor is
the first Note Detect release whose ownership handshake lets the karaoke
visualization take the microphone and hand it back cleanly. With an older Note
Detect installed, lyrics playback is unaffected but microphone feedback is
withheld and the 🎤 control explains why — updating Note Detect restores it on
your next click, with no reload. The plugin cannot read a peer's version number
(the host exposes no version global or plugin registry), so the check is
capability-based: the floor is enforced by looking for the handshake itself.

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

Choose a **Vocals** arrangement and turn on the **Karaoke** button to get the
pitch ribbon with its 🎤 control. The ribbon draws pitch bars, timed syllables,
and — with the microphone on — an accuracy tint on what you have sung. In a
duet pack it also marks the other parts with thin guide bars on the same
chart, and a bouncing cue under the syllable you are on becomes a get-ready
countdown across a silent lead-in. The highway renderer draws pitch lanes,
note slabs, timed syllables, and guide bars for the other part — but since
1.13.0 no host control selects it; see
[migration status](#why-choose-the-get-flashbacks-edition). A splitscreen panel
that already had Lyrics Karaoke selected as its visualization still loads it.

Microphone access starts only when you click the shared **🎤** control.
Permission can be denied without stopping lyric playback. The device and
channel selectors support a default mic or a multichannel interface; the
scoring-panel selector chooses which vocals panel owns the microphone in
splitscreen. Only one panel can own it at a time. If an older Note Detect that
cannot hand off ownership is installed, the mic is not started at all and the
control stays visible but disabled with the upgrade reason. Closing the panel, changing
song or part, or stopping capture releases the stream. Audio is analyzed in
the plugin for pitch; raw audio is not stored or transmitted.

**Microphone feedback**, **Octave-free pitch match**, **Pitch tolerance**,
**Mic timing offset**, **Sung part**, and **Left rail** are renderer settings
whose descriptors used to live in `plugin.json`. That block is gone as of
1.13.0, so no host renders controls for them: **Pitch tolerance**,
**Octave-free pitch match**, and **Mic timing offset** take the engine
preferences, and the rest run on their defaults. Re-homing them into the
karaoke UI is the next part of
[#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32).

## Fallback, migration, and rollback

If the renderer is unavailable or disabled, the legacy overlay remains the
compatibility path. Provider and overlay ownership is exclusive, including
microphone capture and scoring. Compatible Karaoke Highway preferences are
imported once; its old microphone-on state is ignored so capture still needs
an explicit click. Removing this plugin version or selecting the legacy path
does not rewrite prepared song data. Keep the same song packs when rolling
back to a compatible Lyrics Karaoke release.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No highway | Lyrics Karaoke is not in the visualization picker, Auto, or splitscreen's dropdown since 1.13.0. The **Karaoke** button gives you the pitch ribbon; the highway returns with the rest of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32). |
| Song does not resolve on an old host | A song pack that is a symlink pointing outside the library is refused by the pre-`0dcc913` fallback; update the host. |
| Lyrics but no pitch slabs | Generate pitch for that song; lyrics-only playback is supported. |
| No microphone scoring | Click 🎤, grant browser permission, and sing a pitched part. |
| Wrong input or channel | Use the shared device and Mix / Ch 1 / Ch 2 selectors; reconnect a missing device and start capture again. |
| Voice appears late or early | Scoring runs on the engine's mic offset; a control for it returns with the rest of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32). |
| Pack fails to load | Check that `lyrics.json` and `vocal_pitch.json` referenced by the manifest are valid JSON; the renderer reports malformed packs separately from missing ones. |

## Development and provenance

Install test dependencies with
`python -m pip install pytest fastapi pyyaml httpx` and `npm ci`, then run
`python -m pytest -q tests`, `npm test` and `npm run lint` from this
directory. ESLint 10 needs Node 20.19+, 22.13+ or 24+, which is what
`actions/setup-node` with `node-version: '22'` resolves to in CI. `npm test` is `node --test tests/*.test.js` — the renderer and
overlay suites, the microphone engine, and `tests/host-contract.test.js`,
which exercises the seam against a stubbed host: registration through
`highway.setRenderer()`, two panels sharing one bus and one microphone,
re-executing `screen.js` on plugin reload, payloads that fail or arrive late,
and teardown that leaves no scheduled frame and no live track. `npm run lint`
is ESLint over `screen.js` and those suites; nothing in `node_modules/` ships
with the plugin. `python tests/fixtures/generate_feedpaks.py OUTPUT_DIR` creates
four packs with synthetic tone audio for route and host smoke tests; the
generator needs `pyyaml`. CI also uploads them as a `vocals-synthetic-packs`
artifact for manual testing.

This plugin is distributed under [AGPL-3.0](LICENSE). The visualization adapts work from
[Karaoke Highway](https://github.com/Taynavv/feedback-vocals-viz), licensed
AGPL-3.0. The adapted sections in `screen.js` and `routes.py` retain source
comments. [NOTICE.md](NOTICE.md) records the adaptation dates, and the
[integration architecture](docs/architecture/vocals-visualization-integration.md)
records the data and ownership decisions.
