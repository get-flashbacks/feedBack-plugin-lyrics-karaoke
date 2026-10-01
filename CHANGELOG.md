# Changelog

All notable changes to Lyrics Karaoke are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 1.12.9, the version this section describes. Earlier
releases are recorded in [docs/release-notes-v1.12.0.md](docs/release-notes-v1.12.0.md)
and the repository's tagged history.

## [Unreleased]

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
