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

| Area | Action and expected result | Minimum | Latest | Evidence / issue |
| --- | --- | --- | --- | --- |
| Preparation | Align/save, generate pitch, export LRC, reopen pack; data persists. | | | |
| Migration | Open an existing prepared pack without regeneration; lyrics and optional pitch load. | | | |
| Selection | Open Vocals in Auto mode; one highway renders and no overlay or competing scorer appears. | | | |
| Fallback | Disable provider or select another renderer; overlay works; prepared files are unchanged. | | | |
| No mic | Load and play without clicking 🎤; browser requests no microphone. | | | |
| Denied mic | Deny permission; lyrics continue, one actionable error appears, no retry loop. | | | |
| Default mic | Click 🎤 and sing; trace and score update; stop releases the track. | | | |
| Interface | Select multichannel device and Mix / Ch 1 / Ch 2; input follows selection. | | | |
| Disconnect | Unplug active device; capture stops, error appears, and reconnect requires a click. | | | |
| Transport | Play, pause, seek forward/back, restart, switch songs, and reach end; no stale score or timer remains. | | | |
| Duet | Switch sung parts; scored slabs and other-part guides use one pitch axis. | | | |
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
