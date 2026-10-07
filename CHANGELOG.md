# Changelog

All notable changes to Lyrics Karaoke are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 1.12.9, the version this section describes. Earlier
releases are recorded in [docs/release-notes-v1.12.0.md](docs/release-notes-v1.12.0.md)
and the repository's tagged history.

## [Unreleased]

### Added

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
- **Version stays 1.13.0.** `version-bumped-on-change` will read this as a
  diff that touches functional code (`screen.js`) without bumping
  `plugin.json`. That check is intentionally allowed to remain red for this
  PR because the combined release of #44 and #45 has not shipped yet — the
  version bump belongs with the release, not with each intermediate
  sub-issue. The fullscreen fix ([#47](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/47))
  is another step of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)
  and rides that same deferral. (`plugin.json` was also left at 1.13.0 in
  commit `41163a3` for #44.)

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
