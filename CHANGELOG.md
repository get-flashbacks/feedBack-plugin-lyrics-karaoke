# Changelog

All notable changes to Lyrics Karaoke are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 1.12.9, the version this section describes. Earlier
releases are recorded in [docs/release-notes-v1.12.0.md](docs/release-notes-v1.12.0.md)
and the repository's tagged history.

## [Unreleased]

### Fixed

- A pitch sidecar whose numbers overflow or are malformed can no longer crash
  playback ([#62](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/62)).
  Python's JSON decoder accepts the `NaN`/`Infinity` literals and turns `1e309`
  into infinity, so a valid-JSON `vocal_pitch.json` reached
  `int(float('inf'))` — an `OverflowError`, which the readers caught only as
  `KeyError`/`TypeError`/`ValueError`, so `GET /playback` returned an uncaught
  server error instead of the documented boundary response. Pitch timestamps,
  durations, and MIDI values now pass through explicit finite/type/range
  validation before conversion: a non-numeric, non-finite, overflowing, or
  out-of-range record is dropped per the boundary policy, leaving its token
  unpitched. MIDI is range-checked to `0–127` before conversion. The same
  coercion guards the legacy `/data` merge — which also stopped 500ing on a
  `midi: null` record — and the demucs server's
  `/pitch` output, now validated before it is persisted.
  `tests/test_pitch_validation.py` covers JSON exponent overflow,
  `NaN`/`Infinity`, strings, null, negative duration, and out-of-range MIDI
  across `/playback`, `/data`, and the remote extractor.
- A malformed alignment result can no longer erase existing lyrics
  ([#59](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/59)).
  `POST /save-lyrics` sanitizes incoming segments one at a time, so a result
  whose every entry was unusable (missing or non-finite `start`/`end`, or
  `end <= start`) was written as `[]` and still reported `{"ok": true}` —
  destroying valid lyrics, and with no archive backup at all for a
  directory-form pack. The route now validates the sanitized result before it
  touches the sidecar, manifest, or archive: an entirely unusable result
  returns a 422 saying the existing lyrics were left untouched, and the pack
  is byte-for-byte unchanged. A partial-invalid result is still accepted —
  the usable segments are written and `dropped_count` reports how many were
  discarded — so one bad row from the aligner does not block a good save.
  `tests/test_save_lyrics_validation.py` pins the rejected-save bytes for
  both directory- and zip-form packs plus the partial and valid paths.
- Corrected stale comments claiming `lyrics_sync` was superseded/absorbed or a redirect stub. `lyrics_sync` is a separately-maintained plugin with its own manual tap-to-time / waveform-editing surface; this plugin duplicates the alignment/save flow and adds pitch extraction + karaoke overlay. Consolidating the duplicated code is an open follow-up.

### Added

- The renderer now exposes its scoring and voice settings through a
  **Settings** popover
  ([#63](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/63)),
  replacing the manifest descriptors retired in #44 with an in-app control
  surface. A **Settings** button is built next to **Fullscreen** while a
  renderer instance is live and opens a popover over six controls: **Pitch
  tolerance**, **Ignore octave**, **Mic delay**, **Live scoring (mic)**,
  **Sung part**, and **Left rail**. The three pitch controls are shared — they
  fan out to every live panel and the legacy overlay and write through to
  `lyrics_karaoke.prefs.v1`; **Live scoring** is shared too, so one switch
  pauses every panel and no panel can be stranded unscored, while **Sung part**
  and **Left rail** apply to the panel the microphone is scoring (or the first
  live panel when none can score). **Sung part** options come from the loaded
  song, primary first, and a part a later song no longer carries falls back to
  the primary instead of scoring an empty take. Opening, refreshing, or changing
  the popover never starts the microphone — turning live scoring off only
  releases an already-running stream, and capture still starts only from the 🎤
  click. `tests/karaoke-settings.test.js` covers the wiring, shared-vs-panel
  scope, reload persistence, safe fallback, lyrics-only operation, and
  teardown.
- The **Karaoke** button's pitch ribbon now draws the highway's features
  directly ([#45](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/45),
  second step of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)).
  In a duet pack the other parts are marked with thin guide bars on the same
  chart, and a bouncing cue under the syllable you are on turns into a
  get-ready countdown across a silent lead-in. It is the same ribbon with more
  on it, not a second visual mode: a solo pack, a lyrics-only song, or a host
  that can't reach `/playback` draws exactly what it drew before, and a song
  switch clears the cue. Scored and guide pitches now share one song-wide axis,
  so a harmony part an octave above the lead stays on the strip.
- The ribbon's accuracy tint now uses the same red→amber→green ramp as the
  highway renderer, so one accuracy reads as one colour in both.
- Two cue edge cases found in review, fixed here rather than in a follow-up:
  the countdown and ball were drawn at the upcoming syllable's own x, which
  is off the right edge for most of a 2–20s lead-in, so both are now clamped to
  the strip (the stage renderer clamps its target to the rail for the same
  reason); and the cue's lookup binary-searched on `start + duration` while
  the rows are sorted by `start` alone, so a held note overlapping the
  syllables after it made the search skip the note being sung. The lookup now
  searches the monotonic `start`, then walks back over the window the longest
  note can reach.
- **The #32 steps left the version at 1.13.0.** `version-bumped-on-change`
  will read those diffs as functional code (`screen.js`) without a `plugin.json`
  bump. That check is intentionally allowed to remain red for those PRs because
  the combined release of #44 and #45 has not shipped yet — the version bump
  belongs with the release, not with each intermediate sub-issue. The fullscreen
  fix ([#47](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/47))
  is another step of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)
  and rides that same deferral. (`plugin.json` was also left at 1.13.0 in
  commit `41163a3` for #44.) A later fix in the same unreleased window does
  bump: the save-validation fix for
  [#59](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/59)
  ships `plugin.json` at 1.13.1.

### Changed

- The release gate now checks the JavaScript it already shipped, not just its
  syntax ([#41](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/41),
  fourth step of [#17](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/17)).
  `vocals-release-gate` runs `npm ci`, `eslint .` and the full `node --test`
  suite alongside the existing `node --check`, so a lint error or a failing
  host-contract test fails CI on the PR that causes it instead of surfacing
  in the next release. `eslint.config.mjs` is the whole rule set —
  `js.configs.recommended` across `screen.js`, the test suites and the config
  itself, with two rules new in ESLint 10 exempted for `screen.js` alone until
  its three pre-existing sites are cleaned up in a functional PR. Nothing is
  added to the plugin's runtime: `package.json` is `private`, `node_modules/`
  is ignored, and nothing in it is published or loaded by the host.
- A new `tests/host-contract.test.js` covers the seam between this plugin and
  a live host: registration through `highway.setRenderer()`, two panels
  sharing one event bus and one microphone, re-executing `screen.js` on plugin
  reload without splitting the playback-ownership ledger, an unloadable
  payload that must never throw out of `draw()` (core reverts to the default
  highway after three throwing draws, overwriting the user's saved viz), and
  teardown that leaves no scheduled animation frame, no live track and no
  panel still subscribed to `highway:visibility`.
- Lyrics Karaoke is no longer a separate visualization-picker entry
  ([#44](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/44),
  first step of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)).
  `plugin.json` drops `type: "visualization"` and the whole
  `capabilities.visualization` block, and `screen.js` no longer publishes a
  `matchesArrangement` static on the renderer factory. Every viz list built
  from `/api/plugins` filters on `type`, so on that path this plugin leaves
  core's viz picker, core's Auto mode, and splitscreen's per-panel
  visualization dropdown at once. Dropping `type` also stops core registering
  the picker-region UI contribution. Auto had a second reason to skip it: the
  `matchesArrangement` predicate its candidate walk consults is gone.
- **This release removes the main player's way into the highway renderer.** The
  **Karaoke** button still drives the legacy pitch ribbon, and Auto used to be
  what selected the highway renderer. Resolution by factory is untouched, so
  two routes still work: a splitscreen panel that already persisted
  `__viz__:lyrics_karaoke:<arrangement name>` in `splitscreenPanelPrefs`, and
  splitscreen's registry-fetch-failure fallback, which re-scans `window` for
  the `feedBackViz_` / `slopsmithViz_` prefixes. Either way it builds the same
  renderer from `window.feedBackViz_lyrics_karaoke` (legacy
  `window.slopsmithViz_lyrics_karaoke` alias retained). The rest of #32
  re-homes it behind the Karaoke button.
- **Not for a standalone release.** 1.13.0 on its own is the step that removes
  the highway renderer from the main player, so ship it with the rest of
  [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)
  or mark it pre-release.
- The renderer is otherwise unchanged: same lifecycle, ownership handshake,
  and `/playback` contract. Per core's plugin contract `type` only ever
  controlled discovery, so nothing else had to move.
- Because the settings descriptors lived in the removed capability block, the
  host no longer declares **Microphone feedback**, **Octave-free pitch match**,
  **Pitch tolerance**, **Mic timing offset**, **Sung part**, or **Left rail**,
  so it renders no controls for them and splitscreen shows no Viz ⚙ popover.
  Where a renderer is installed it keeps running on `VIZ_SETTING_DEFAULTS`,
  with **Pitch tolerance**, **Octave-free pitch match**, and **Mic timing
  offset** still taking the engine preferences. Splitscreen both reads and
  writes a panel's overrides only for controls the manifest declares, so it
  stops re-applying what it saved before this change; those
  `splitscreenVizSetting:lyrics_karaoke:…` keys stay in `localStorage` unread,
  and take effect again only if a later release re-declares these controls.

### Fixed

- Song resolution no longer fails on hosts predating core commit `0dcc913`.
  `routes._resolve_dlc_path` delegates to core's shared containment helper —
  `dlc_paths._resolve_dlc_path` when present, otherwise
  `safepath.safe_join`, which is what the host's own `_resolve_dlc_path` was
  before that commit. Preparation routes and `/playback` now work from the
  declared `minHost` (`0.3.0-alpha.1`) upward, and a host shipping neither
  helper refuses the filename instead of joining it onto the library directory
  unchecked.
- Leaving fullscreen karaoke restores the visualization that was active when
  it started ([#47](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/47),
  fourth step of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)),
  instead of dropping back to the default 2D highway. The host's highway api
  exposes no renderer getter, so fullscreen enter records the picker's
  persisted selection (`localStorage.vizSelection`, falling back to the
  picker's own value when storage is blocked) and exit re-installs it through
  `window.setViz`, which rebuilds from `window['feedBackViz_' + id]` and
  falls back to the default highway when that id no longer resolves. Five
  `tests/host-contract.test.js` cases cover it: two named renderers (3D
  Highway, Keys Highway), an unresolvable id, nothing persisted, and blocked
  storage.

### Added

- `host_requirements` in `plugin.json`, an additive extension key that pins
  the backend helper floor to feedBack commit `0dcc913` (no core release
  represents it yet) and records per-player identity as an optional capability
  rather than part of the minimum.
- `tests/test_host_compat.py`, which simulates a pre-`0dcc913` host, a current
  host, and a host with no containment helper.
- README sections separating core compatibility from the microphone, browser,
  and local/remote pitch/alignment prerequisites.
