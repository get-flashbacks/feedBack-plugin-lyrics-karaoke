# Vocals visualization release matrix

Use this record on the release PR for [#17](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/17).
Run it against both the minimum supported FeedBack version
(`0.3.0-alpha.1`) and the latest supported version. Record host commit or
release, plugin commit, browser/OS, display scale, input device, operator,
and date. Attach actual screenshots and link them below; do not count an
untested cell as a pass.

## Test media

Generate the four copyright-free packs with
`python tests/fixtures/generate_feedpaks.py OUTPUT_DIR` (after installing
`pyyaml`), or download the `vocals-synthetic-packs` artifact from the PR's
CI run: `single-voice`,
`duet`, `incomplete-pitch`, and `lyrics-only`. These contain prepared lyric
and pitch sidecars plus a short synthesized tone; they contain no copyrighted
media. The synthetic tone can verify basic capture and timing. Also test one
existing prepared pack from before this release without regenerating it.

## Results

Mark each row Pass, Fail, or Blocked for each host version and link evidence.

Rows below that exercise the **highway renderer** — `Interface`, `Disconnect`,
`Duet`, `Single panel`, `Mixed split`, `Two vocals panels`, `Layout` — have no
reachable entry point since
[#44](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/44)
dropped `type: "visualization"`. Core's viz picker, core's Auto mode, and
splitscreen's per-panel dropdown all filter `/api/plugins` candidates on that
field, so none of them can offer it any more. (`Default mic`, `No mic`, and
`Denied mic` stay reachable — the Karaoke button's overlay has its own 🎤.)
Mark the rest Blocked with the #44 reference until the remainder of
[#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)
re-homes the renderer behind the Karaoke button. The two rows below are the
only routes left into the renderer, and they both go through splitscreen's
`feedBackViz_` / `slopsmithViz_` prefix probe rather than discovery.

Two clarifications before you start:

- The **Karaoke** button's ribbon is reachable today and, since
  [#45](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/45),
  draws duet guide bars, the get-ready cue and the accuracy tint itself. The
  observation half of `Duet` and `Single panel` can therefore be recorded
  against the ribbon now; only the rows that need the stage renderer stay
  Blocked.
- The ribbon and the renderer both have **no sung-part control** as of
  1.13.0 (the manifest declares no settings, so nothing renders or calls
  them). The scored voice is always the primary one — record `Duet` on that
  basis rather than trying to switch parts.

| Area | Action and expected result | Minimum | Latest | Evidence / issue |
| --- | --- | --- | --- | --- |
| Preparation | Align/save, generate pitch, export LRC, reopen pack; data persists. | | | |
| Migration | Open an existing prepared pack without regeneration; lyrics and optional pitch load. | | | |
| Selection | Visualization picker, Auto, and splitscreen's per-panel dropdown have no Lyrics Karaoke entry; the **Karaoke** button still runs the overlay. | | | |
| Saved panel pref | In a splitscreen panel saved before #44, pick this plugin as the visualization, then reopen the panel; `splitscreenPanelPrefs[].arrName` is `__viz__:lyrics_karaoke:<arrangement name>` and the renderer still installs. Prepared files are unchanged. | | | |
| Registry-fetch fallback | With `/api/plugins` unreachable, splitscreen's window rescan still lists the plugin and a fresh pick installs the renderer. | | | |
| No mic | Load and play without clicking 🎤; browser requests no microphone. | | | |
| Denied mic | Deny permission; lyrics continue, one actionable error appears, no retry loop. | | | |
| Default mic | Click 🎤 and sing; trace and score update; stop releases the track. | | | |
| Interface | Select multichannel device and Mix / Ch 1 / Ch 2; input follows selection. | | | |
| Disconnect | Unplug active device; capture stops, error appears, and reconnect requires a click. | | | |
| Transport | Play, pause, seek forward/back, restart, switch songs, and reach end; no stale score or timer remains. | | | |
| Duet | Confirm the other parts draw as guide bars on the scored voice's pitch axis. Part switching has no control in 1.13.0, so record the primary voice only (see the note above). | | | |
| Single panel | Solo, incomplete-pitch, and lyrics-only packs draw appropriately. | | | |
| Mixed split | Vocals plus instrument panel; one vocals renderer, correct song data, no mic conflict. | | | |
| Two vocals panels | Select each panel as scoring target; only one stream owns the mic, panel state stays separate. | | | |
| Layout | Narrow/wide panels at standard and high DPI keep lyrics, lanes, controls, and score legible. | | | |
| Rollback | Return to previous compatible plugin release; prepared song data still opens. | | | |

## Screenshot evidence

Attach screenshots of the main renderer states to the release PR and link
them here: pitched solo, duet with guide bars, lyrics-only, active mic trace,
end-of-song score, narrow panel, and two vocals panels. Remove player names,
private song titles, and microphone device names before sharing.

## Release signoff

- [ ] Both host versions and all matrix rows have recorded results.
- [ ] Screenshots are attached to the release PR.
- [ ] No known microphone leak, duplicate renderer, stale timer, or
      cross-panel state issue remains.
- [ ] CI passes from a clean checkout and rollback was verified.
