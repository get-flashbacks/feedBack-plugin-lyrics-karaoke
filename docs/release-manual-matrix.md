# Vocals visualization release matrix

Use this record on the release PR for [#17]. Run it against both the minimum
supported FeedBack version (`0.3.0-alpha.1`) and the latest supported
version. Fill in the run record once per run, attach actual screenshots and
link them below, and do not count an untested cell as a pass.

## Run record

Every row in the results table inherits this.

| Field | Value |
| --- | --- |
| Operator | |
| Dates run | |
| Plugin commit under test | |
| Host — minimum (`0.3.0-alpha.1`) release or commit | |
| Host — latest release or commit | |
| Browser and OS | |
| Display scale(s): standard, high DPI | |
| Input device(s): default, multi-channel interface | |
| Evidence index (screenshots, logs, hashes) | |

## Test media

Generate the four copyright-free packs with
`python tests/fixtures/generate_feedpaks.py OUTPUT_DIR` (after installing
`pyyaml`), or download the `vocals-synthetic-packs` artifact from the PR's
CI run: `single-voice`,
`duet`, `incomplete-pitch`, and `lyrics-only`. These contain prepared lyric
and pitch sidecars plus a short synthesized tone; they contain no copyrighted
media. The synthetic tone can verify basic capture and timing. Also test one
existing prepared pack from before this release without regenerating it.

## Operator procedure

Read this section before you start. Each numbered step below corresponds to
one or more rows in the Results table. The row labels point back to the
procedure steps so you can follow along.

### 1. Set up the two hosts

Install the release candidate into two FeedBack instances:

- **Minimum host.** `0.3.0-alpha.1` (the `minHost` declared in
  `plugin.json`). Install the candidate plugin by copying `screen.js`,
  `routes.py`, and `screen.html` into the host's plugin directory and
  reloading.
- **Latest host.** The most recent stable FeedBack release the plugin
  supports. Install the same candidate files.

Record both host versions in the Run record table before moving on.

### 2. Prepare one pack under the candidate

Do this on the **minimum host** so the same prepared data can be reopened
on both hosts later.

1. Open FeedBack and navigate to the plugin's preparation screen.
2. Import or create a sloppak with a vocals stem. Use the
   `single-voice.sloppak` fixture from Test media (copy it into the host's
   DLC directory).
3. Click **Align** — wait for Whisper alignment to finish.
4. Click **Generate pitch** — wait for pYIN to finish.
5. Click **Export LRC** — save the `.lrc` file somewhere outside the plugin
   directory.
6. Close the preparation screen.

This produces one pack prepared by the release candidate. You will reopen
it in steps 4 and 5.

### 3. Find one pre-existing pack

Locate a pack that was prepared by the previously released version
(`v1.12.0`, plugin version `1.12.0`) and has not been regenerated. If you
do not have one, prepare a pack now using the v1.12.0 plugin files (see
Rollback step 1 below for how to obtain them), then uninstall v1.12.0 and
reinstall the candidate before continuing. Do not regenerate this pack under
the candidate.

Record the pack's name and path in the Run record.

### 4. Run the candidate rows (minimum host)

Work through the Results table row by row. For each row:

1. Read the "Action and expected result" column.
2. Perform the action on the minimum host.
3. Mark the Minimum column **Pass**, **Fail**, or **Blocked**.
4. Capture the evidence listed in the third column (screenshot, console
   log, browser permission indicator, sidecar mtime, etc.).
5. Record the evidence file path or URL in the "Evidence / issue" column.
6. If a row is **Blocked**, name the blocking issue (e.g. `#32`, `#46`,
   `#47`) — never leave a cell blank.

Entry-point rules (see Which entry point reaches what):

- The **Karaoke** button's 🎤 overlay reaches `No mic`, `Denied mic`,
  `Default mic`, and `Disconnect`. You do not need the visualization picker.
- `Saved panel pref` and `Registry-fetch fallback` require a splitscreen
  panel saved before PR [#44].
- `Interface`, `Duet` (stage half), `Single panel` (stage half), `Mixed
  split`, `Two vocals panels`, and `Layout` need a route that installs the
  renderer. If you cannot reach one through the normal picker, mark it
  **Blocked → [#32]/[#46]/[#47]** and record which route you used in the
  Evidence column.

**Screenshots to capture now** (these are reused for the latest-host run):

- Preparation: reopened pack + LRC export
- Migration: pre-release pack with unchanged mtimes
- Selection: each visualization list (core picker, Auto, splitscreen
  dropdown) showing no Lyrics Karaoke entry, plus the Karaoke ribbon running
- Default mic: trace and score while singing, plus the stopped state after
  the second click
- Disconnect: the `!` pill and the full 🎤 tooltip text
- Transport: end-of-song score
- Duet: guide bars on the ribbon
- Single panel: one screenshot of each of solo, incomplete-pitch,
  lyrics-only
- Mixed split: vocals-plus-instrument panel
- Two vocals panels: target-switch screenshot
- Layout: narrow + wide at standard DPI, narrow + wide at high DPI

### 5. Run the candidate rows (latest host)

Repeat step 4 on the latest host. Mark the Latest column. Reuse screenshots
where the result is identical; capture new ones only if the latest host
behaves differently.

### 6. Rollback to v1.12.0

Do this on **one host** — the minimum host is recommended because v1.12.0
imports `dlc_paths` unconditionally, which fails on hosts older than
feedBack `0dcc913`. Note the host commit beside the hashes.

1. **Hash the sidecars** of the candidate-prepared pack (step 2) and the
   pre-existing pack (step 3).

   Directory form:
   ```
   sha256sum lyrics.json vocal_pitch.json manifest.yaml
   ```

   Archive form:
   ```
   unzip -p pack.sloppak lyrics.json | sha256sum
   unzip -p pack.sloppak vocal_pitch.json | sha256sum
   unzip -p pack.sloppak manifest.yaml | sha256sum
   ```

2. Replace the candidate plugin files with the `v1.12.0` release files.
   Download the release from GitHub (it is flagged as a pre-release, so
   uncheck "Hide pre-release" in the releases filter). Reload the host.

3. Open both packs in the preparation screen with **no regeneration** —
   just load them. Verify that lyrics, any pitch, and playback all work.

4. Hash the sidecars again using the same commands. Every digest must match
   step 1. If any hash differs, open the pack's sidecars in a text editor
   and inspect what changed — the plugin directory must never be the source
   of a write.

5. Roll forward: reinstall the candidate plugin files, reload the host, and
   open both packs a third time. Confirm lyrics, pitch, and playback still
   work and the hashes still match.

Record the before/after hashes and the host commit in the Rollback row of
the Results table.

### 7. Attach evidence and complete signoff

1. Rename every screenshot to strip player names, private song titles, and
   microphone device names (e.g. `01-preparation-reopened.png`).
2. Attach the screenshots to the release PR.
3. Link each screenshot from the Evidence column of the relevant row.
4. Verify the Release signoff checklist:
   - Both host versions and all rows have recorded results.
   - Every Blocked row names its blocking issue; no cell is blank.
   - Screenshots are attached.
   - No known microphone leak, duplicate renderer, stale timer, or
     cross-panel state bug remains.
   - CI is green and rollback hashes are recorded.

## Which entry point reaches what

Since [#44] dropped `type: "visualization"`, every list the host builds
from `/api/plugins` — core's visualization picker, core's Auto mode, and
splitscreen's per-panel visualization dropdown — filters this plugin out, so
none of them can offer it any more. Nothing was removed from the renderer
itself. Three routes still install it, and one more — the Karaoke button's
overlay — covers the four mic rows that never needed it:

- **Karaoke button overlay (no renderer).** `No mic`, `Denied mic`,
  `Default mic` and `Disconnect` are reachable today through the **Karaoke**
  button's own 🎤. The overlay mirrors the shared microphone controller's
  error state, so unplugging the active device stops capture and shows the
  failure as a `!` beside the button, with
  `Mic feedback error: The microphone was disconnected. (click to retry)`
  in the button's tooltip; reconnecting takes another click. That is the
  whole `Disconnect` row. The overlay's controls are only that button and
  its note-name pill — the device and channel selects live in
  `_vizBuildMicUi`, which builds only while a renderer instance is alive
  (`_vizRefreshMicUi` walks `_vizInstances`), which is why `Interface` does
  need a renderer.
- **Saved panel pref.** A splitscreen panel saved before [#44] carries
  `splitscreenPanelPrefs[].arrName = __viz__:lyrics_karaoke:<arrangement name>`,
  and `initPanel` calls the factory directly on reopen, with no membership
  check against the fetched list.
- **Registry-fetch fallback.** With `/api/plugins` unreachable, splitscreen's
  catch re-scans `window` for the `feedBackViz_` / `slopsmithViz_` prefixes
  and lists the plugin with no `type` check; a fresh pick installs the
  renderer.
- **`window.setViz('lyrics_karaoke')` from the console.** Resolves
  `window.feedBackViz_lyrics_karaoke` with no picker-membership check, so it
  also reaches the main player's highway. It writes
  `localStorage.vizSelection` on the way, which the picker's restore pass
  then drops as a stale value, so put the user's saved visualization choice
  back afterwards.

Every renderer-dependent row (`Interface`, the stage halves of `Duet` and
`Single panel`, `Mixed split`, `Two vocals panels`, `Layout`) can therefore
be exercised before [#46] and [#47] re-home the renderer behind the Karaoke
button. Record which route the run used in the Evidence column. If you would
rather test only the entry points a user gets in the release itself, mark
those rows Blocked with [#32]/[#46]/[#47] instead — but never leave a cell
blank, and never record a fallback-routed run as if the normal picker had
offered it.

Two clarifications before you start:

- The **Karaoke** button's ribbon is reachable today and, since [#45],
  draws duet guide bars, the get-ready cue and the accuracy tint itself. The
  observation half of `Duet` and `Single panel` can therefore be recorded
  against the ribbon now; only the rows that need the stage renderer follow
  the entry-point rules above.
- The ribbon and the renderer both have **no sung-part control** as of
  1.13.0 (the manifest declares no settings, so nothing renders or calls
  them). The scored voice is always the primary one — record `Duet` on that
  basis rather than trying to switch parts.

## Results

Mark each row Pass, Fail, or Blocked for each host version and link the
evidence. A Blocked cell counts only when it names the issue that unblocks
it; the Evidence column below already carries that issue for every row that
cannot run as written.

| Area | Action and expected result | Minimum | Latest | Evidence / issue |
| --- | --- | --- | --- | --- |
| Preparation | Align/save, generate pitch, export LRC, reopen pack; data persists. | | | Reopened pack screenshot plus the export; writes land inside the pack, not the plugin directory. |
| Migration | Open an existing prepared pack without regeneration; lyrics and optional pitch load. | | | The pre-release pack used and its sidecar mtimes, unchanged. |
| Selection | Visualization picker, Auto, and splitscreen's per-panel dropdown have no Lyrics Karaoke entry; the **Karaoke** button still runs the overlay. | | | One screenshot of each list with the plugin absent, plus the ribbon running. |
| Saved panel pref | In a splitscreen panel saved before [#44], pick this plugin as the visualization, then reopen the panel; `splitscreenPanelPrefs[].arrName` is `__viz__:lyrics_karaoke:<arrangement name>` and the renderer still installs. Prepared files are unchanged. | | | The `arrName` value, the installed renderer, and the pack's unchanged sidecars. |
| Registry-fetch fallback | With `/api/plugins` unreachable, splitscreen's window rescan still lists the plugin and a fresh pick installs the renderer. | | | How the route was blocked, the rescan entry, the installed renderer. |
| No mic | Load and play without clicking 🎤; browser requests no microphone. | | | Permission indicator or console showing no request. |
| Denied mic | Deny permission; lyrics continue, one actionable error appears, no retry loop. | | | Screenshot of the single error; console showing one request and no retries. |
| Default mic | Click 🎤 and sing; trace and score update; stop releases the track. | | | Trace and score screenshot, plus the stopped state after the second click. |
| Interface | Select multichannel device and Mix / Ch 1 / Ch 2; input follows selection. | | | Renderer route used; otherwise Blocked → [#32]/[#46]/[#47]. |
| Disconnect | Unplug active device; capture stops, error appears, and reconnect requires a click. | | | Overlay error screenshot (`!` pill; full text in the 🎤 tooltip); no renderer needed (see entry points). |
| Transport | Play, pause, seek forward/back, restart, switch songs, and reach end; no stale score or timer remains. | | | End-of-song score screenshot and a note that nothing kept ticking after the switch or the end. |
| Duet | Confirm the other parts draw as guide bars on the scored voice's pitch axis. Part switching has no control in 1.13.0, so record the primary voice only (see the note above). | | | Guide bars on the ribbon today; stage half needs a route, else Blocked → [#32]/[#46]/[#47]. |
| Single panel | Solo, incomplete-pitch, and lyrics-only packs draw appropriately. | | | One screenshot per pack; stage half needs a route, else Blocked → [#32]/[#46]/[#47]. |
| Mixed split | Vocals plus instrument panel; one vocals renderer, correct song data, no mic conflict. | | | Renderer route used; otherwise Blocked → [#32]/[#46]/[#47]. |
| Two vocals panels | Select each panel as scoring target; only one stream owns the mic, panel state stays separate. | | | Target-switch screenshot and the single owner; route, else Blocked → [#32]/[#46]/[#47]. |
| Layout | Narrow/wide panels at standard and high DPI keep lyrics, lanes, controls, and score legible. | | | Narrow and wide captures at both scales; route, else Blocked → [#32]/[#46]/[#47]. |
| Rollback | Return to previous compatible plugin release; prepared song data still opens. | | | Before/after hashes per the rollback procedure, plus the host commit. |

## Automated evidence

Recorded 2026-10-06 on `main` at commit `0eaebf6`: **130 pytest cases and
215 `node --test` cases, all green** (`python -m pytest -q tests`,
`npm test`). These pin the four "no known bug" criteria against the stub
host, so the rows above only re-confirm them on a real one.

Recorded 2026-10-07 on release PR
[#55](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/pull/55),
branched from `main` at commit `58e950a`: **131 pytest cases (including
`test_rollback.py`) and 220 `node --test` cases, all green**
(`python -m pytest -q tests`, `npm test`). The rollback case
`test_rollback_hashes_survive_plugin_swap` loads `v1.12.0`'s `routes.py`
from the git tree as a separate module, prepares directory-form and
zip-form packs under the release candidate, hashes the sidecars, swaps
to `v1.12.0`, reopens all three packs (status/data/playback), hashes
again, and confirms every digest matches. It also confirms no stray
writes land outside the pack directory. A roll-forward to the candidate
round-trips the same way. The hashes printed by that run are:

| Pack form | lyrics | pitch | manifest |
| --- | --- | --- | --- |
| candidate-dir | `3d89aede7627...` | `388fb01e2045...` | `3ba22ad97630...` |
| candidate-zip | `3d89aede7627...` | `388fb01e2045...` | `3ba22ad97630...` |
| legacy-dir | `2a21cbb283d2...` | `388fb01e2045...` | `88eeba8b30ae...` |

(The actual digests vary per run because `_write_manifest` calls
`yaml.safe_dump` without a fixed sort — both versions call the same
function with the same input, so the digests still agree across the
swap.)

- **No microphone leak.** `vocal-engine.test.js`: `mic: stop releases every
  resource and unregisters the source`, `mic: device loss stops everything
  and reports an error`, `provider: destroy releases the mic and stops
  every track`, `provider: a song switch releases the mic and wipes the
  take`, `provider: hidden panel suspends the mic, shown again resumes`
  (the one documented exception), `provider: turning micFeedback off
  releases the mic and blocks restarts`; `host-contract.test.js`: `destroy
  releases the microphone device and refuses a later request`, `a pending
  transfer retry cannot take the device after its target dies`.
- **No duplicate renderer.** `host-contract.test.js`: `the host installs the
  published factory through its own renderer slot`, `the plugin never
  installs a renderer into the host slot itself`, `re-executing screen.js
  keeps ONE factory and one ownership ledger`, `taking playback ownership
  stops the overlay: never two draw loops`.
- **No stale timer.** `host-contract.test.js`: `turning karaoke off leaves
  no scheduled frame behind`, `a payload that lands after teardown is
  dropped, not announced`, `a destroyed panel is not revived by a
  highway:visibility emit`; `vocal-engine.test.js`: `seek-back wipes the
  take so old scores cannot resurrect`, `song changes (setTokens) and
  reset() clear everything`.
- **No cross-panel state bug.** `screen.test.js`: `two instances render
  independently from their own payloads`, `per-instance settings do not
  leak between instances`, `two panels suppress once and restore once, not
  per panel`; `host-contract.test.js`: `two panels each unsubscribe their
  own highway:visibility listener`, `a panel that cannot get a 2d context
  fails loudly and steals nothing`.

What the suites cannot decide is presentation — whether a real host reaches
those states the way a user does. That is what the matrix rows are for.

## Rollback

The rollback target is `v1.12.0`, the only published release (2026-09-26,
plugin version `1.12.0`; GitHub has it flagged as a pre-release, so it hides
behind the releases filter).

1. Hash the prepared sidecars of one pack prepared by the release candidate
   and one pack prepared before this release. For an archive-form
   `.sloppak`, hash the members:
   `unzip -p pack.sloppak lyrics.json | sha256sum` (likewise for
   `vocal_pitch.json` and `manifest.yaml`); for a directory-form pack, run
   `sha256sum` on the files in place.
2. Replace the plugin with `v1.12.0` and reload the host.
3. Open both packs again with no regeneration: lyrics, any pitch, and
   playback must all work.
4. Hash the sidecars again the same way. Every digest must match step 1,
   and opening the packs must not have rewritten anything.
5. Roll forward to the candidate and open both packs a third time.

Two facts from this run mean the operator is confirming the procedure rather
than discovering the outcome:

- Since `v1.12.0`, `routes.py` has changed by exactly one thing: PR [#39]
  added the tolerant `_resolve_dlc_path` fallback for hosts that lack
  `lib/dlc_paths.py`. `_persist_lyrics`, `_persist_pitch`, `_write_manifest`
  and `_rezip_sloppak` are byte-identical to the released code, so both
  sides of the swap write and read the same pack format and neither has to
  translate anything.
- Every write those helpers make targets the pack itself — `lyrics.json`
  and `vocal_pitch.json` go into the pack's source directory and the
  manifest is patched in place, under the DLC directory for a
  directory-form pack and under the sloppak unpack cache (then re-zipped
  back into the DLC directory) for an archive-form one. The plugin's own
  directory is never a write target, so replacing plugin versions cannot
  modify prepared data.

One caveat to record with the result: `v1.12.0` imports `dlc_paths`
unconditionally, so rolling back on a host older than feedBack `0dcc913`
reintroduces [#35] and song resolution fails there. Note the host commit
beside the hashes; hosts at or after `0dcc913` are unaffected.

## Screenshot evidence

Attach screenshots of the main renderer states to the release PR and link
them here: pitched solo, duet with guide bars, lyrics-only, active mic trace,
end-of-song score, narrow panel, and two vocals panels. Remove player names,
private song titles, and microphone device names before sharing.

## Release signoff

- [ ] Both host versions and all matrix rows have recorded results.
- [ ] Every row that could not run as written names its blocking issue; no
      cell is blank.
- [ ] Screenshots are attached to the release PR.
- [ ] No known microphone leak, duplicate renderer, stale timer, or
      cross-panel state issue remains.
- [x] CI passes from a clean checkout (`python -m pytest tests` — 131
      cases; `npm test` — 220 cases; `npm run lint`).
- [x] Rollback is verified in `tests/test_rollback.py` — the release
      candidate can be rolled back to `v1.12.0` without changing prepared
      song data. The remaining checklist item is recording the actual
      operator-run hashes and screenshots on the release PR.

[#17]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/17
[#32]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32
[#35]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/35
[#39]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/pull/39
[#44]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/44
[#45]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/45
[#46]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/46
[#47]: https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/47
