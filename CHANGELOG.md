# Changelog

All notable changes to Lyrics Karaoke are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 1.12.9, the version this section describes. Earlier
releases are recorded in [docs/release-notes-v1.12.0.md](docs/release-notes-v1.12.0.md)
and the repository's tagged history.

## [Unreleased]

### Changed

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

### Added

- `host_requirements` in `plugin.json`, an additive extension key that pins
  the backend helper floor to feedBack commit `0dcc913` (no core release
  represents it yet) and records per-player identity as an optional capability
  rather than part of the minimum.
- `tests/test_host_compat.py`, which simulates a pre-`0dcc913` host, a current
  host, and a host with no containment helper.
- README sections separating core compatibility from the microphone, browser,
  and local/remote pitch/alignment prerequisites.
