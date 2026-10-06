# Vocals visualization integration architecture

Status: **Accepted** — resolves [#10](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/10),
part of epic [#18](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/18).

> **Superseded in part by [#44](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/44)**
> (first sub-issue of [#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)):
> the renderer no longer declares `type: "visualization"`, and every viz list
> built from `/api/plugins` filters on `type`, so it leaves core's viz picker,
> core's Auto mode, and splitscreen's per-panel dropdown on that path. The renderer,
> its lifecycle, ownership model, and payload contract are unchanged —
> `window.feedBackViz_lyrics_karaoke` (plus the legacy
> `window.slopsmithViz_lyrics_karaoke` alias) remains the whole install
> contract, so a consumer that resolves the id by prefix still gets a working
> renderer.
> Sections that described the picker/Auto path are marked below; the rest of
> #32 re-homes selection into the karaoke UI and is where the presentation
> decisions land.

This document defines the boundary between Lyrics Karaoke's existing
preparation pipeline and a new FeedBack visualization provider derived from
[Karaoke Highway](https://github.com/Taynavv/feedback-vocals-viz), before any
of the dependent implementation issues (#11–#17) merge.

## Why this exists

Lyrics Karaoke and Karaoke Highway currently overlap: both parse lyrics +
vocal pitch, both run YIN microphone analysis, both do timing/scoring. Karaoke
Highway's own `CLAUDE.md` states its engine "is adapted from the AGPL-3.0
`feedBack-plugin-lyrics-karaoke` plugin" — the duplication runs in the
direction *this* plugin's code moved outward, not the reverse. Porting the
polished rendering and scoring experience back in wholesale, on top of the
existing overlay, would double the duplication instead of resolving it.
Contributors picking up #11–#17 need one documented target architecture and
data contract before writing code.

## Component ownership

### Lyrics Karaoke backend (`routes.py`) — unchanged responsibilities

- Detects/creates synced lyrics (`/align`, `/save-lyrics`) and per-syllable
  vocal pitch (`/generate-pitch`).
- Owns the preparation screen, `/status`, `/server-status`, and `/export`.
- Serves the canonical playback payload — see [Canonical payload
  schema](#canonical-payload-schema) below. **This route already exists**
  (`GET /api/plugins/lyrics_karaoke/playback`, shipped for #13) and is the
  contract the new provider consumes; it runs no extraction or model
  loading, only reads already-persisted `lyrics.json` / `vocal_pitch.json`.

### Visualization provider (#14 shipped, #15 in progress) — owns playback

- Registers `renderer.create`/`renderer.destroy` under the **existing**
  plugin id `lyrics_karaoke` (see [Manifest scope](#manifest-scope-one-plugin-two-roles)).
  Consumes `/playback`; runs no extraction logic of its own.
- Owns rendering (ported from Karaoke Highway's `screen.js` across #15's
  phases), microphone capture, live scoring, its own settings namespace,
  and end-of-song results.

**#15 phase 1 (shipped): the perspective stage.** The placeholder ribbon is
replaced by the ported stage — note wall, diatonic (piano-key) pitch axis
with natural-lane labels, horizon seam, violet lit-slab notes with gloss,
duet guide bars, playhead, and the lyric band below the seam with
per-syllable sung/active/upcoming colouring. It reads no DOM or shared
module state and is windowed per frame by lower-bound entry plus a
longest-token lookbehind.

**#15 phase 2 cues (shipped):** the lyric band now includes a bouncing
syllable cue and a numeric get-ready countdown during silent lead-ins. Its
beat estimate and smoothed horizontal position are renderer-instance state,
reset on song changes, so splitscreen panels cannot move one another's cue.

**#15 final renderer polish (shipped):** the stage now includes selectable
left-rail modes from the host settings popover: **Absolute tuner** (compact
pitch scale plus the latest sung-pitch cursor), **Voice technique** (pitch
lock/hold/find and current run guidance from the scoring state), and **Off**
for dense/small panels. Finished scored takes draw an in-stage summary card
with score, accuracy, and best streak, while live takes continue to use the
top stats band, accuracy tint, and sung-pitch trace.

Multi-voice is *rendered* here (scored voice as slabs, the rest as
secondary flat guide bars on one shared axis). `/playback` translates
`vocal_tracks[]` into the canonical `voices[]` payload; `screen.js` stays
transport-only and never reads manifest extensions itself.
- **#44 retired the picker/Auto entry.** The renderer is no longer a
  candidate the host selects: the manifest declares no `type`, and the
  factory publishes no `matchesArrangement`. Selection moves into the
  karaoke UI (#32's remaining sub-issues); see [Renderer
  selection](#renderer-selection-retired-in-44).

**As shipped in #14** (`screen.js`, "Visualization provider" section):

- `window.feedBackViz_lyrics_karaoke` — a factory returning a fresh instance
  per call, plus the legacy `window.slopsmithViz_lyrics_karaoke` alias that
  splitscreen's `VIZ_FACTORY_PREFIXES` falls back to. Registration carries
  its own idempotency guard (`__feedBackLyricsKaraokeVizRegistered`),
  separate from the script's `HOOK_KEY` bootstrap guard, and runs at script
  evaluation rather than on `DOMContentLoaded`, because a renderer consumer
  (a splitscreen panel, or #32's karaoke UI) may enumerate `feedBackViz_*`
  before then. Since #44 these two globals are the *entire* install
  contract — nothing in the manifest advertises the renderer.
- Registration is **unconditional**, and that is the safe-degradation path:
  a host below the minimum version simply never reads the global, so it is
  inert and the legacy overlay keeps owning playback. Probing for
  `setRenderer` at load would be worse — `window.highway` need not exist
  yet. An instance handed an unusable canvas fails loudly instead
  (`renderer-failed`, reason `no-canvas` / `no-2d-context`) and claims no
  ownership.
- Instance state is entirely panel-local (closure over the factory call).
  The one module-level structure is the live-instance set, used solely to
  decide playback ownership on the 0↔1 transitions.
- `applySetting`/`getSetting` back every key `VIZ_SETTING_DEFAULTS` declares
  (feedBack#849); whoever renders those controls owns persistence. Until #44
  they were also declared in the manifest, whose ranges
  and labels were Karaoke Highway's verbatim, so a user moving over found
  the same controls — plus `micFeedback`, the one key the legacy overlay
  ever persisted. With the manifest declaration gone no host renders them, so
  an installed renderer runs on `VIZ_SETTING_DEFAULTS` (with the engine
  preferences still supplying `tolerance` / `octaveIndependent` /
  `micOffsetMs`) until #32 re-homes the controls into the karaoke UI.
- Events: `lyrics_karaoke:renderer-ready`
  (`{filename, arrangementIndex, schemaVersion, voiceId, voices, tokens, pitched}`)
  and `lyrics_karaoke:renderer-failed`
  (`{reason, filename, arrangementIndex, status?, message?}`).
- The `/playback` load is fire-and-forget with a sequence token: `draw`
  never awaits it, and a response arriving after a song switch or a
  `destroy()` drops itself. A **failed** load is recorded per
  (song, arrangement) key and not retried until the next `init()` — an
  unprepared song answers 404, which is a normal state, and `draw` notices
  "no data yet" every frame, so retrying there would be a 60 Hz fetch loop.
- The placeholder ribbon is a windowed draw (binary search to the visible
  span, with a song-wide longest-token lookbehind so a held note that
  started before the window still paints) — it must not full-scan the chart
  per frame, whatever #15 replaces it with.

### The ribbon absorbs the stage's capabilities inline (#45)

The overlay is now the main player's only route to karaoke (#44 retired the
picker entry), so #45 — the second sub-issue of
[#32](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/32)
— grows the highway's features **into the existing ribbon** rather than
swapping in the stage. Same chart, same playhead, same toggle: it must read as
the ribbon getting better, not as a different-looking mode.

What moved, and where it came from:

- **Accuracy tint** — already present, but on its own two-channel red/green
  lerp. It now uses the stage's `_vizAccuracyRgb` ramp, so the same accuracy
  reads as the same colour in both renderers.
- **Duet guides** — the ribbon scores and draws the primary voice from
  `/data`, unchanged. The other voices come from a second, best-effort
  `/playback` fetch (`_ribbonGuidesFromPayload`) and draw as thin flat bars on
  the *scored voice's axis*, so a harmony part an octave up stays on the strip
  instead of drawing off it. `computeSongPitchRange(data, extraMidis)` widens
  the song-wide range to cover them, percentile-trimming the guides against
  their own population before unioning the two ranges — pooling every midi
  into one sort would let a short lead part push the guide range outside the
  5%/95% window.
- **Bouncing cue and get-ready countdown** — the same beat estimate
  (`_vizComputeCueBeat`), the same 0.18 x-smoothing, the same lead-in rule as
  the stage's lyric band, drawn in the ribbon's text band. Its input is the
  overlay's existing start-sorted row array, so it is a binary search per
  frame like the stage's line lookup.

What deliberately did **not** change: mic/note_detect ownership, the
per-panel splitscreen instance model, and `sungPart` selection — presentation
only. Nothing here is a mode: guides are additive (empty for a solo pack, a
lyrics-only song, or a host that can't reach `/playback`), and the cue draws
from lyric timing alone, so a song with no pitch data still gets the same
ribbon rather than a visibly different one. Cue state is overlay-local and
reset per song, so no two panels can move one another's ball.

**#44 removed `visualization` again**, along with `type: "visualization"` —
see [Manifest scope](#manifest-scope-one-plugin-one-role-since-44). The
renderer still exists and still runs wherever a consumer installs it; what is
gone is the manifest's advertisement of it as a host-selectable provider,
which also takes its `settings` descriptors with it.

**Capabilities declared in #14: `visualization` only** (no longer declared as
of #44; the plugin currently declares `audio-input` and `player-identity`).
#14's scope also
listed `note-detection` and `audio-input` "where supported", and Karaoke
Highway declares both — but this plugin services neither pipeline yet. Its
YIN detector and `getUserMedia` live in the legacy overlay rather than
behind a capability, and it never touches the audio-input control plane (no
`list-sources`). Declaring them now would advertise participation the host
could act on and we would not honour, so they belong with #11's microphone
consolidation. The mic *ownership* handshake, being lifecycle, did land here
— see below.

**#11 added `audio-input`** (roles: `provider`; `register-source` /
`unregister-source`), because the plugin now does honour it: while the
microphone is listening it registers `lyrics_karaoke:mic` as an advisory
managed input source and unregisters it on teardown. `note-detection` is
still **not** declared — see [the engine decisions](#vocal-pitch-engine-11).

### Legacy overlay — temporary compatibility fallback

- Remains available for hosts below the minimum supported version (see
  [Minimum FeedBack version](#minimum-feedback-version)) or while the
  provider capability is explicitly disabled.
- Must never hold the microphone or score at the same time as the provider
  — see [Microphone and settings ownership](#microphone-and-settings-ownership).
- Removed only after a separately tracked, documented migration decision;
  this document does not set that date.

## Minimum FeedBack version

**`0.3.0-alpha.1`**, declared as `minHost` in `plugin.json` (#14). This is
the value Karaoke Highway's own `plugin.json` carries — but under its
non-spec key `feedback_target`; the plugin-spec's key for "minimum Host
version this plugin requires" is `minHost` (plugin-spec §4.1, advisory in
the current Host), so that is what this plugin declares. It matches the
earliest core version
carrying every contract the ported renderer needs: the `setRenderer`
lifecycle, per-instance visualization settings (`applySetting`/`getSetting`,
feedBack#849), and the `highway:visibility` event. (`matchesArrangement`
Auto-mode was part of this list when the renderer was picker-visible; #44
retired it, and the rest of #32 re-homes selection into the karaoke UI.)
Hosts older than this get the legacy overlay
unconditionally — there is no partial-feature degradation path, since the
renderer cannot register at all without `setRenderer`.

### The backend floor is a different, later commit (#35)

`minHost` describes the *renderer* contract. The backend has one extra
dependency that `minHost` does not cover: `routes._resolve_sloppak` resolves a
request-supplied `filename` inside `DLC_DIR`, so it has to use core's shared
containment helper rather than a bare `dlc / filename` join — that path is
also the re-zip **write** target (`_rezip_sloppak`), so an unguarded join would
be an arbitrary-file-overwrite primitive, not just a read.

Core's shared helper lives in `lib/dlc_paths.py`
([`0dcc913`](https://github.com/got-feedBack/feedBack/commit/0dcc913), extracted
from `server.py` — the commit states the function moved "verbatim", so it was
byte-identical to the parent), and that commit landed after the
`v0.3.0-alpha.1` tag. So `routes.py` does not raise the floor; it delegates to
whichever helper the host ships, in this order:

1. `dlc_paths._resolve_dlc_path` — current core. Containment is *lexical*, so
   it does not follow a symlinked song entry out of the library.
2. `safepath.safe_join` — the pre-`0dcc913` host, where `server._resolve_dlc_path`
   was literally `return safe_join(dlc, filename)`. It resolves the candidate
   before testing containment. Both resolve the *root* first, so a library
   reached through a directory junction or symlink resolves either way.
3. Neither importable → refuse (return "song not found"). There is deliberately
   no third fallback; a host that lost both core helpers degrades to the 404 the
   caller already handles rather than to an unchecked join.

**The two helpers are not ordered by strictness**, and the plugin does not
paper over the difference. Neither can be handed a filename that names a path
outside the library, which is the property the call site depends on. They
differ only on names that stay inside it:

| | `dlc_paths` (current) | `safe_join` (pre-`0dcc913`) |
| --- | --- | --- |
| `..` traversal, absolute POSIX path | refuse | refuse |
| `C:/x` drive-absolute | refuse (`PureWindowsPath(...).drive`) | contained path under `dlc` on POSIX; refused on Windows |
| embedded NUL | refuse explicitly | refused only insofar as `resolve()` raises |
| song entry that is a symlink pointing out of the library | allowed (core picked lexical containment deliberately, so a symlinked pack stays reachable) | refused (it resolves the link first) |

So the last row is the one behavioural difference of the fallback: a host in
the window between the alpha.1 tag and `0dcc913` already had the *lexical*
helper — in `server.py`, before the extraction — and there the plugin's
fallback refuses a symlinked song pack that the current helper would resolve.
That direction is the safe one — a refusal, not a path outside the root — and
it does not touch the common setup of a library mounted through a junction or
symlink, which both helpers resolve.

The plugin never re-implements containment, so the check cannot drift from the
one core applies to its own filename-bound routes. `tests/test_host_compat.py`
simulates all three host shapes.

Because no core *release* represents `0dcc913`, `plugin.json` pins the commit
under `host_requirements.backend` (an additive extension key; hosts ignore keys
they do not recognise) and `minHost` stays at `0.3.0-alpha.1`.

### Preparation/playback vs. per-player identity

Two different support questions, deliberately not merged:

- **Preparation and playback** — every route that resolves a song goes through
  the one `_resolve_sloppak` seam, so the adapter covers all of them:
  `/status`, `/data`, `/playback`, `/align`, `/save-lyrics`,
  `/generate-pitch`, plus the renderer that reads `/playback`. They work from
  `minHost` upward on both host shapes. (`/export` never touches the library —
  it formats the segments it is handed — and `/server-status` only reads
  `config.json`.)
- **Per-player identity** is *optional* and arrived after `minHost`.
  `updateKaraokePlayerContext` scopes a practice mode to
  `window.feedBack.playerContexts`, published by the host's
  `player-identity` capability (`static/capabilities/player-identity.js`, which
  is not in the `v0.3.0-alpha.1` tree). The call already no-ops when the host
  API is missing, so an older host keeps preparation, rendering, and microphone
  scoring; only the voice role attached to the active player is skipped.
  Recorded as `host_requirements.player_identity.optional` in `plugin.json`.

Per-player identity is a *core capability*, not a peer plugin, so it does not
belong in `peer_requirements` (which is about Note Detect).

### Still open

- #17 owns the runtime matrix: exercising the status/data/playback and
  save/generate routes against a real host at the declared minimum. The tests
  here simulate both host shapes at the seam; they are not a substitute for
  that run — in particular no test here drives a real alignment or pitch
  extraction, so it cannot speak to those. The known multi-voice save bugs are
  plugin defects, and no host version resolves them.
- Microphone/browser support and the local-vs-remote pitch and alignment
  prerequisites are listed in the README separately from core compatibility —
  they are runtime prerequisites, not host-version facts.

## Manifest scope: one plugin, one role (since #44)

Until #44 the manifest carried two roles: A single `plugin.json` **may**
declare both a `nav`/`screen` entry (the
existing preparation UI) and `type: "visualization"` + a `capabilities`
block (the new renderer) — nothing in the plugin contract (see
`feedBack/CLAUDE.md`) restricts a manifest to one role. We keep plugin id
**`lyrics_karaoke`**, not `vocals_highway`:

- Existing installs, settings exports, and generated song data key off
  `lyrics_karaoke` already; adopting a second id would mean a second
  manifest, a second settings namespace, and a real migration for zero
  benefit.
- The preparation screen and the playback renderer are two facets of the
  same feature (encode vocals, then play them back), not two products.

**#44 removed the second role from the manifest.** `type: "visualization"`
and the `visualization` capability block are gone, so the host's viz picker
no longer lists this plugin and Auto no longer selects it — which is exactly
what #32 asks for (one karaoke toggle instead of a separate pickable entry).
`type` also gates core's `ui.player-overlays` registration for the picker
region, so that contribution is withdrawn with it. Per core's contract, `type`
only ever controlled discovery: nothing about it was load-bearing for the
renderer itself, and the plugin never called `highway.setRenderer()` itself —
core's picker/Auto pass and splitscreen's `enterVizMode` were the call sites.
Splitscreen builds its own per-panel dropdown from the same `type` filter
(`vizPlugins = plugins.filter(p => p?.type === 'visualization')`), so its
*discovery* of this plugin goes too. Its `VIZ_FACTORY_PREFIXES` probe is
resolution, not discovery, and two routes still reach the factory: a panel
that already persisted `__viz__:lyrics_karaoke:<arrangement name>` in
`splitscreenPanelPrefs` (`panelToPrefs().arrName`), and the
`_rescanVizPluginsFromWindow()` fallback that runs when the plugin registry
fetch fails — that scan looks at `window` only and carries no `type`, so a
host that cannot reach `/api/plugins` will still offer the plugin. Until the
rest of #32 lands, a saved panel preference is the only route that does not
depend on a fetch failure.

## Canonical payload schema

One versioned shape, served today by `GET
/api/plugins/lyrics_karaoke/playback` (`routes.py`,
`PLAYBACK_SCHEMA_VERSION = 1`), consumed by the provider instead of two
independent lyrics/pitch parsers:

```jsonc
{
  "schema_version": 1,
  "song": { "filename": "example.sloppak" },
  "arrangement": { "index": 0, "id": "vocals", "name": "Vocals" },
  "voices": [
    {
      "id": "primary",
      "name": "Vocals",
      "primary": true,
      "tokens": [
        { "start": 1.0, "duration": 0.5, "text": "hel", "midi": 60 },
        { "start": 1.5, "duration": 0.5, "text": "lo" }
      ]
    }
  ]
}
```

**Token contract** (already implemented and unit-tested in
`tests/test_playback_payload.py`, safe for #14/#15 to rely on without
re-deriving it):

- `start` finite, `duration` finite and `>= 0` (zero is a valid cue marker);
  a token failing either check is dropped, not fatal to the request.
- `midi` is present only when a `vocal_pitch.json` note's `t` matches the
  token's `start` exactly; absence means "unpitched syllable," which is a
  normal, expected state (lyrics-only content), not an error.
- Tokens are sorted by `start` regardless of source-file order.
- **404** ("Not a sloppak" / "No lyrics data") vs **422** ("Malformed
  lyrics.json" / "Malformed vocal\_pitch.json") is a deliberate split: an
  unprepared song is expected and quiet; a present-but-corrupt side file is
  a real error and must not masquerade as "just not prepared yet."
- The route never runs pYIN/CREPE or loads a model — it is a pure read+merge
  path safe to call on every renderer init.

**Arrangement identity** (#13). `/playback` takes an OPTIONAL `arrangement=N`
query param — the zero-based index the caller is mounted for, which core
hands the renderer as `songInfo.arrangement_index`. It is echoed back
resolved against the manifest's `arrangements[]` as `{index, id, name}`
(`name` falling back to `id`, per feedpak-spec §5.2). It **labels** the
response only: lyrics are song-level in feedpak v1, so the token set is
identical whatever index is passed, and omitting the param keeps the
pre-existing unlabelled `{index: null, id: null, name: null}` shape. An
index that doesn't resolve (out of range, malformed manifest entry) echoes
the index with a null identity rather than failing — the tokens are still
correct. A negative index is a 422, since no arrangement list can satisfy
it. Adding `id`/`name` is additive, so `schema_version` stays `1`.

### Multi-voice (duet) — additive extension

feedpak-spec (`spec/feedpak-v1.md` §5.5 `lyric_tracks[]`, §7.1 `lyrics.json`,
§7.2 `vocal_pitch.json` — the token contract above lives in §7.1/§7.2, not
§7.3, which is the separate `vocal_pitch_contour.json` shape) has **no**
multi-singer key as of the current spec version (1.19.0, checked at the
time of writing — re-verify against whatever tag is current when reading
this). `lyric_tracks[]` exists but models language variants of one
performance (original/transliteration/translation) and the spec explicitly
states "Per-track vocal pitch is out of scope for this version" — still
true as of 1.19.0. The additive manifest extension used by Karaoke
Highway/feedpakr supports duets:

```yaml
vocal_tracks:
  - id: v1
    name: Lead
    primary: true
    lyrics: lyrics.json
    vocal_pitch: vocal_pitch.json
  - id: v2
    name: Harmony
    lyrics: lyrics_v2.json
    vocal_pitch: vocal_pitch_v2.json
```

This remains an extension rather than a normative feedpak field. It follows
the specification's additive-extension rule: the singular keys MUST alias
the primary part so older readers remain functional, while aware readers
may consume all tracks. `/playback` now translates the extension into its
existing `voices[]` transport shape without a schema-version bump. The
renderer draws every voice on one scale and its per-panel `sungPart` setting
selects which voice receives the primary slab/lyric treatment.

## Renderer selection (retired in #44)

**This section records how selection worked while the renderer was a
picker-visible provider, and why #44 removed that path. It is kept because
the analysis behind feedBack#84 is still live upstream.** Current state: the
host neither lists nor auto-selects this plugin, and the remaining
sub-issues of #32 put selection in the karaoke UI.

Auto mode picks the first registered `matchesArrangement(songInfo)` match,
in plugin registration order. The provider used to declare:

```js
window.feedBackViz_lyrics_karaoke.matchesArrangement = function (songInfo) {
    return /vocal/i.test((songInfo && songInfo.arrangement) || '');
};
```

**Naming constraint carried over from Karaoke Highway's `CLAUDE.md`:** the
picker sorts candidate factories by plugin **display name**, and Auto takes
the first arrangement-matching entry — Karaoke Highway's display name was
chosen specifically to sort ahead of "Keys Highway 3D," whose predicate also
matches vocals-shaped charts via a bare `has_notation` check. Whatever
display name the provider ships under must be re-verified against every
other viz plugin's `matchesArrangement` for the same collision risk.

**Re-verified in #14** against every `matchesArrangement` in the ecosystem —
**including core's bundled `plugins/`, which is where the real conflict
lives.** Core sorts viz candidates by DISPLAY NAME (`static/js/plugin-loader.js`:
`a.name || a.id`, id only as a tiebreak) and Auto installs the first match, so
for a **notated** `Vocals` arrangement the candidates resolve in this order:

| Order | Plugin (display name) | Predicate | Claims notated "Vocals"? |
|---|---|---|---|
| 1 | `drum_highway_3d` ("3D Drum Highway") | requires `has_drum_tab` | No |
| 2 | `highway_3d` ("3D Highway") | `lead\|rhythm\|bass\|combo\|guitar` | No |
| 3 | `keys_highway_3d` ("Keys Highway 3D") | bare `has_notation` | **Yes — takes it from us** |
| 4 | `lyrics_karaoke` ("Lyrics Karaoke") | `/vocal/i` | never reached |
| 5 | `piano` ("Piano Highway") | keys/piano/synth name | — |
| 6 | `staffview` ("Staff View") | bare `has_notation` | — |

So the name that matters is not Staff View's or Piano Highway's — both sort
after us — but **"Keys Highway 3D"**, a keyboard highway whose bare
`has_notation` claims every notated arrangement there is. This is exactly why
Karaoke Highway is *called* "Karaoke Highway": its source comments say the
name was picked to sort before "Keys Highway 3D", and warn against renaming
it without re-checking that sort.

**Decision: fix the predicate, not our name.** A keyboard highway has no
business rendering a sung line, and naming this plugin around another
plugin's over-broad predicate would leave the same trap set for the next
vocals viz. Filed as
[feedBack#84](https://github.com/get-flashbacks/feedBack/issues/84) with the
proposed patch; the plugin keeps the display name **"Lyrics Karaoke"**.

**Until #84 lands**, Auto resolution was therefore split, and #14's
"Vocals arrangements auto-select the provider" criterion held only in part:

- **Non-notated vocals arrangements** → this provider won Auto. Nothing else
  claimed them (`keys_highway_3d`/`staffview` both require notation,
  `highway_3d`/`piano` require other names, `drum_highway_3d` requires a
  drum tab).
- **Notated vocals arrangements** → `keys_highway_3d` won Auto; reaching
  this provider needed an explicit pick from the viz picker. No workaround
  was attempted on this side.

`staffview`'s identical bare `has_notation` was deliberately **not** included
in #84: a staff view of a vocal line is legitimate output, unlike a piano
roll, and it sorts after us anyway.

The load-bearing constraint on **our** side was that the predicate stayed
keyed on the arrangement name and never widened to `has_notation` — widening
would have claimed every notated chart rather than notated *vocals*, making
this plugin the very thing #84 is about.

**#44 removed the whole mechanism** rather than fixing the predicate: with no
`type: "visualization"` the plugin is not in the picker's option list at all,
which is also the list core's Auto pass walks, and with no predicate
published there is nothing for Auto to match even if another route surfaced
the id. That disposes of the collision *for this plugin* — `keys_highway_3d`
still claims notated vocals for everyone else, so feedBack#84 remains the fix
worth landing upstream.

Lyrics-only content (no `vocal_pitch.json`, `midi` absent from every token)
is a valid response shape from `/playback`, not an error — the renderer
falls back to a flat lyric ribbon, matching Karaoke Highway's documented
behavior for pitch-less songs.

## Microphone and settings ownership

- **Exactly one owner at a time** — and that means one owner *in the app*,
  not just within this plugin. The provider, the legacy overlay, **and
  note_detect** must never hold `getUserMedia` or run scoring
  simultaneously. The provider becomes the owner whenever it is the active
  renderer for a Vocals arrangement on a host meeting the minimum version;
  the overlay is the fallback everywhere else.

- **The handshake, as shipped in #14, and the reverse direction closed in
  review.** Ownership is claimed on the 0→1 live-instance transition and
  released on 1→0, so a second splitscreen panel joining an owned session
  stands nothing else down and the last panel out restores everything.
  Claiming ownership was covered from the start; re-*enabling* the legacy
  overlay while a viz instance still owned playback was not — nothing
  stopped a user from clicking the Karaoke button afterward, which would
  flip `karaokeMode` true and could auto-start the mic even though the
  overlay itself would still no-op, leaving a real path to a second
  `getUserMedia()` and the legacy scorer running concurrently with the
  provider. `setKaraokeMode(true)` — the single function that both mounts
  the overlay and auto-starts the mic — now refuses while
  `_vizOwnsPlayback()` is true, closing every downstream path (including
  the mic button's own eligibility, which already required `karaokeMode`)
  at the one place ownership is actually granted, rather than patching
  each symptom separately.
  - *Legacy overlay* — `setKaraokeMode(false)` (which already stops the
    mic, resets results and restores the highway's own lyrics) when karaoke
    was on, remembering that we did so; otherwise just `teardownOverlay()`.
    On release, karaoke is switched back on if we were the reason it went
    off and the player screen is still active.
  - *note_detect* — `window.createNoteDetector.setDefaultSuppressed(true)`,
    which is the handshake note_detect ships for precisely this and which
    silently tears down a running session (silent, so no end-of-song
    summary modal pops). Per its own documentation the taking-over host
    captures `wantsDetect()` first, because suppression only blocks
    *future* auto-enables: a detector the user had ON is re-armed with
    noteDetect.enable()` on release. Entirely feature-detected, and a
    throwing peer cannot break renderer init.

  - **The coexistence floor (#36).** "No note_detect installed" and "an
    older note_detect installed" are *not* equivalent, and treating them as
    equivalent is the bug this closes. The floor is **Note Detect 1.15.2**
    (`got-feedBack/feedBack-plugin-notedetect`): its first auditable
    snapshot already carries `setDefaultSuppressed`, `wantsDetect()` and
    `isEnabled()`, and every later commit keeps all three. The host exposes
    no peer version global and no loaded-plugin registry, so the runtime
    cannot compare versions and the gate is **capability-based**, not
    version-based: `_lkNoteDetectState()` classifies the peer into three
    states — `null` (absent, never blocks; Note Detect stays optional),
    `{supported: true}` (handshake present, today's behavior unchanged), or
    `{supported: false, active}` (legacy build). For the legacy state the
    probes decide, and they are read **independently, not
    short-circuited**: the peer is idle only when *every* probe it
    exposes returns `false`. `isEnabled()` alone cannot establish that,
    because in note_detect it is the live toggle while `wantsDetect()` is
    the persisted *intent* (`detectPreference` defaults to `true`), and
    the peer resolves that intent itself at the next song boundary — it
    calls `enable()` whenever `wantsDetect() && !isEnabled()`. Reading
    `isEnabled()` first would therefore hand the mic to a default-install
    legacy peer and be ambushed one song later. Any probe returning
    `true`, no probe at all, or a throwing probe all mean *may own the
    microphone*, and `_lkMicCoexistenceBlock()` refuses the claim. This
    is the same signal `_vizSuppressNoteDetect()` reads, and only ever
    makes the gate stricter. The state is evaluated lazily on every
    start attempt, never cached, so upgrading the peer unblocks scoring
    without a reload. `setDefaultSuppressed` is the load-bearing half of
    the handshake, so a *partial* handshake is treated as supported.
  - **Blocking is scoped to the mic, never to playback.** `requestMic()` and
    the overlay's `startMic()` return false; `canScore()` is left alone,
    because a false `canScore()` would empty `_vizMicCandidates()` and the
    🎤 would disappear instead of explaining itself. The control stays
    visible, styled disabled but *not* natively disabled, with the full
    reason in its `title`/`aria-label` and a short `Note Detect too old`
    label in the 11px inline status span. Leaving it clickable is
    load-bearing rather than cosmetic: a natively disabled button dispatches
    no click, so nothing would re-read the peer and the control would latch
    after the one event that could have recovered it. Every attempt is
    therefore re-evaluated against the live peer — matching how the guards
    are documented — and the disabled styling plus `aria-disabled` keep it
    honest for hover and assistive tech. Playback and lyrics are untouched.

  Without both halves — no handshake *and* no floor to block on it — a
  karaoke panel and note_detect would both hold a microphone, both score,
  and note_detect's HUD would draw over the ribbon.

- **Deeper note_detect integration is a #11 decision, not a #14 one.**
  Beyond ownership, two further integrations are worth evaluating there
  rather than duplicating this plugin's YIN engine indefinitely:
  1. *Publishing vocal judgments* through core's note-state provider
     (`highway.setNoteStateProvider`, feedBack#254) so whichever renderer
     is active lights the note itself, instead of the provider owning all
     hit feedback privately. This is the contract note_detect already feeds.
  2. *Reusing note_detect's detector* via `window.createNoteDetector`
     instead of a second YIN implementation. This is the less certain half:
     note_detect's matcher is guitar-shaped — it keys judgments by
     `` `${time}_${string}_${fret}` `` — whereas vocal scoring compares a
     monophonic pitch against a syllable's MIDI target. Reuse therefore
     needs a vocals mode in note_detect, not a drop-in, and the tradeoff
     against keeping a small purpose-built vocal detector is #11's call.

  Recommendation for #11: take (1), which is cheap and immediately makes
  vocals feedback renderer-agnostic, and treat (2) as a genuine
  build-vs-reuse decision with note_detect's maintainers rather than an
  assumed win.
- **Settings namespace:** `lyrics_karaoke.*` (not Karaoke Highway's
  `vocals_highway.*`) — keeps the existing plugin id's `localStorage`
  convention. **The legacy overlay's actual persisted surface is much
  smaller than Karaoke Highway's:** `screen.js` persists exactly one key,
  `lyrics_karaoke.micFeedback` (an on/off boolean), and hard-codes
  `_LK_MATCH_TOLERANCE = 1.0` as a constant — there is no
  octave-independent-matching or mic-timing-offset setting anywhere in the
  overlay to migrate. So on first load under the new provider, only
  `micFeedback` carries forward; `tolerance`, `octaveIndependent`, and
  `micOffsetMs` all fall into "no legacy equivalent" and take Karaoke
  Highway's safe defaults (`tolerance: 1` semitone, `octaveIndependent:
  false`, `micOffsetMs: 0`) fresh. #11 should not scope a migration path
  for settings the overlay never had.
- Device/channel selection, tolerance, octave-free matching, mic timing
  offset, sung part, and left-rail mode are the renderer's
  `applySetting`/`getSetting` surface (feedBack#849) — the same mechanism
  Karaoke Highway's `plugin.json` declares, and the one splitscreen's
  per-panel popover renders without host-side plugin-specific code. **Since
  #44 the manifest no longer declares them**, and since the plugin is no
  longer a discovered provider at all there is no Viz ⚙ popover to hang them
  on; the values still resolve through `VIZ_SETTING_DEFAULTS` (with the engine
  preferences supplying the three scoring keys), and #32's remaining
  sub-issues re-home them into the karaoke UI.

## Vocal pitch engine (#11)

One engine in `screen.js`, used by both the provider and the legacy overlay —
there is no second YIN implementation, microphone path, or scorer.

- **Single microphone, exclusive owner.** `_lkCreateMicController()` is a
  page singleton (parked on `window` so a plugin reload can't create a
  second one). `start(owner)` refuses while a *different* owner holds it,
  so exclusivity is structural: the overlay cannot open a stream while a
  provider panel holds the mic, and vice versa. Operations: `start`,
  `stop`, `release(owner)`, `suspend` / `resume` (device kept open, frame
  pump stopped — used when a panel's canvas is hidden via
  `highway:visibility`), `destroy`, `setDevice`, `setChannel`.
- **Explicit action only.** `getUserMedia` is reached only from a click:
  the provider's shared 🎤 control (v3 plugin slot, else
  `#player-controls`) or the overlay's existing 🎤 button. Nothing starts
  the mic on load, song change, or from a restored setting. A song or part
  change releases it; the next song needs a new click.
- **Privacy / teardown.** Only the detected pitch leaves the frame pump.
  No audio is stored or transmitted. Stop, destroy, and device loss (a
  track's `ended`) stop every `MediaStream` track, disconnect the graph,
  close the `AudioContext`, and clear the timer. Permission and device
  errors are surfaced once (control tooltip/readout); there is no retry
  loop — a missing saved device falls back to the default input exactly
  once.
- **Timing.** Frames are dated at the capture buffer's **midpoint** on the
  owning panel's clock (splitscreen panels run their own), converted by the
  playback rate. The **only** other correction is the user's
  `micOffsetMs`, applied by the scorer — it shifts scoring and the sung
  trace, never playback. Live offset changes move the seek gate's
  reference so calibrating mid-take doesn't wipe it.
- **Scoring** (`_lkCreateVocalScorer()`, one per panel / overlay): a
  syllable is judged once the scoring clock passes its end — `perfect`
  (≥ 90% of its frames in tune), `good` (≥ 50%), else `miss`. Score and
  streak follow Karaoke Highway's formula (hit: `100·acc·(1 + 0.1·min(30,
  streak))`; miss: `50·acc`, streak reset). Accuracy is sample-weighted.
  A backward jump > 0.25 s wipes the take (no resurrected scores); smaller
  backsteps and a frozen clock are dropped; a forward jump > 1.5 s leaves
  the skipped syllables unjudged instead of counting them as misses.
  Lyric-only syllables are never judged.
- **Device and channel** are properties of the one microphone, so they
  live in the shared control rather than per-panel settings. In splitscreen
  that control also shows a scoring-panel selector labelled with each local
  song and selected voice. Changing the selector during capture releases the
  old stream completely before requesting the new owner, so two panels can
  never capture concurrently. Closing a selected panel falls back to the next
  eligible panel but leaves the microphone off; song and part changes likewise
  require another explicit click. The device picker (labels appear after
  permission; re-listed on `devicechange`) and a Mix / Ch 1 / Ch 2 channel
  picker support interfaces presenting one stereo
  device. Both apply without reloading — a channel change on the next
  buffer, a device change by restarting the stream for the same owner.
- **Settings namespace.** Engine preferences are one versioned document,
  `lyrics_karaoke.prefs.v1` =
  `{v, deviceId, channel, tolerance, octaveIndependent, micOffsetMs}`. The
  three scoring keys remain per-panel viz settings (host-persisted,
  feedBack#849); the document holds the default new panels and the overlay
  start from, and panel changes write through to it. On first load, if the
  document is absent, Karaoke Highway's compatible `vocals_highway.*`
  values (tolerance, octaveIndependent, micOffsetMs, micChannel,
  micDeviceId) are migrated; its `micOn` bit is deliberately not, since
  the mic only starts on a click. The overlay's own
  `lyrics_karaoke.micFeedback` on/off bit is unchanged.
- **Decisions on the two note_detect integrations above.** (2) *Reuse
  note_detect's detector*: not taken — its matcher is guitar-keyed and a
  vocals mode doesn't exist; the purpose-built monophonic YIN stays. (1)
  *Publish judgments through `setNoteStateProvider`*: deferred to #15 —
  today the provider is the only renderer that draws vocals arrangements,
  so there is no second renderer to light, and #15's score/trace UI is
  where per-syllable results become visible. The scorer already exposes
  per-syllable `quality`/`accuracy` (`getScoreResult(i)`), which is what a
  note-state provider would return.
- **Not in #11:** the end-of-song summary (#15 — the renderer exposes
  `getScoreStats()` / `getScoreResult(i)` / `getSungTrace()` for it).

## Compatibility and migration policy

### Upgrade notes for users

- Keep using the same plugin id, **`lyrics_karaoke`**. There is no rename to
  `vocals_highway`, no second plugin to install, and no generated song data
  rewrite.
- Existing packs prepared by Lyrics Karaoke 1.4.6 and later continue to open
  without regeneration when they contain the same `lyrics.json` and optional
  `vocal_pitch.json` files the plugin has always written.
- The preparation screen remains the owner of generate, re-extract, clear,
  save, and export workflows. The visualization provider only reads the
  already-prepared `/playback` payload during playback.
- Microphone preferences migrate once into `lyrics_karaoke.prefs.v1` when
  compatible Karaoke Highway keys exist. The old `micOn` intent is ignored
  deliberately: microphone capture still requires an explicit click.
- The old `lyrics_karaoke.micFeedback` toggle remains honored for the legacy
  overlay, and provider scoring settings write compatible defaults back to
  the same preferences document for new panels.
- **Note Detect older than 1.15.2 installed alongside Lyrics Karaoke:** no
  upgrade of this plugin is required, and nothing about song preparation or
  playback changes. What changes is that microphone feedback is withheld
  rather than running in parallel with a peer that cannot hand off
  ownership. The 🎤 control stays visible and carries the reason, and stays
  clickable, so upgrading Note Detect restores scoring on the next click,
  with no reload. Disabling the peer is deliberately **not** advertised as
  an equivalent remedy: note_detect clears its persisted intent only from
  the branch of its toggle that needs it enabled, so a peer it cannot keep
  enabled re-arms that intent on every click, and a live intent is exactly
  what this gate refuses to read as idle. The floor is also recorded in
  `plugin.json` under the additive, ignore-if-unknown `peer_requirements`
  key — a documentation-grade extension, not a ratified spec key, and a
  test pins it to the constant in `screen.js` so the two cannot drift.

### Fallback and rollback

- Hosts older than `0.3.0-alpha.1` ignore the visualization provider fields
  and continue to use the legacy overlay path.
- On supported hosts, nothing in the manifest offers the provider any more
  (#44), so the karaoke toggle and the legacy overlay own playback unless a
  consumer installs the factory itself. Either way the provider does not
  write chart data, so rollback does not require deleting or regenerating
  song files.
- The provider and overlay never render/scoring controls simultaneously: a
  live provider instance claims playback ownership, suppresses the overlay
  and note_detect, and releases ownership on teardown.
- With a legacy note_detect peer (below 1.15.2, or with the handshake
  missing/partial) the fallback is deliberately **not** "both run anyway": we
  never suppressed that peer and cannot, so the karaoke side stops scoring
  and says so. The residual limitation is honest — the legacy peer's
  HUD can still draw over the ribbon, because that build exposes no
  suppression API.
- Duet packs may keep singular `lyrics` / `vocal_pitch` aliases pointing at
  the primary voice for older readers. If an alias drifts away from the
  primary `vocal_tracks[]` entry, `/playback` warns at route time so authors
  can fix the pack before legacy and duet-aware readers disagree.

## Provenance and licensing

Both directions of this port stay AGPL-3.0:

- Karaoke Highway's YIN/mic/ribbon engine was adapted **from** this
  plugin — its `CLAUDE.md` and `routes.py` already carry provenance
  comments crediting `feedBack-plugin-lyrics-karaoke`.
- Code adapted **back** from Karaoke Highway into this plugin (the ported
  renderer visuals in #15, the multi-voice merge shape in
  `_canonical_voices`) carries the reciprocal provenance
  comment crediting `Taynavv/feedback-vocals-viz`, per this epic's stated
  requirement to "preserve AGPL attribution and provenance for adapted
  code."

## Testing strategy

Everything below ships. Two suites run from a clean checkout with no
copyrighted media: **130 pytest cases and 215 `node --test` cases**, both
green at the commit this section was written for (`python -m pytest -q
tests`, `npm test`). Re-measure rather than trusting the numbers — they
move with every follow-up PR.

The pattern is content-free, synthesized fixtures (no real song or lyric
content committed), established by `tests/test_playback_payload.py` and
extended everywhere else:

- **Route and payload contract (Python).** `tests/test_playback_payload.py`
  pins the canonical `/playback` shape — token sanitization, the pitch join,
  arrangement identity, HTTP status mapping — by grabbing the route's raw
  callable instead of standing up a server. `tests/test_generated_feedpaks.py`
  drives the same routes over the four packs that
  `tests/fixtures/generate_feedpaks.py` generates (single voice, duet,
  incomplete pitch, lyrics-only), which is also the only sanctioned way to
  get real `.sloppak` fixtures. `tests/test_helpers.py` covers the manifest,
  lyric-token, pitch-file, job-lock and LRC helpers, `tests/test_host_compat.py`
  the host-compat branches (simulated `dlc_paths` / `safepath` modules injected
  into `sys.modules`, covering both host shapes and a host that ships neither),
  `tests/test_lrc_nonfinite.py` the LRC timestamp edge. `tests/playback_schema.py`
  is the shared schema assertion, not a test module.
- **Provider registration and lifecycle (JavaScript).** `tests/screen.test.js`
  stubs the host globals and drives factory registration, repeated init,
  destroy, song and arrangement switches, failed payload loads (404, 422 and
  network error), hostile host shapes (no event bus, a canvas locked to
  another context type), two instances rendering independently from their own
  payloads, plugin re-execution, and the note_detect coexistence gate — no
  real FeedBack host required, mirroring how Karaoke Highway's own `tests/`
  stub FastAPI rather than spin up a server. It also pins the stage and
  ribbon draw output itself (lanes, slabs, duet guides, cue and countdown,
  accuracy ramp) against a recording fake context.
- **Microphone and scoring (JavaScript).** `tests/vocal-engine.test.js` covers
  the YIN helpers, octave-free distance, tolerance boundaries, timing offsets,
  seek-back reset, scoring aggregation and prefs migration, plus the mic
  controller against a fake media environment (exclusivity, permission
  denial, device fallback/loss, suspend/resume, live device/channel switch,
  full teardown) and the provider↔mic wiring. No live microphone needed.
- **Host seam (JavaScript).** `tests/host-contract.test.js` pins registration
  through `highway.setRenderer()`, the host's own revert paths, re-executing
  `screen.js` on plugin reload keeping one factory and one ownership ledger,
  per-panel visibility listeners, payloads that arrive after teardown being
  dropped, and teardown that leaves no scheduled frame and no live track.
- **CI.** `.github/workflows/ci.yml` calls the org's shared reusable workflow
  for the suites themselves, and adds a repo-local `vocals-release-gate` job
  (`compileall`, `ruff`, `node --check`, `npm ci`, `eslint`, `npm test`) plus
  a `vocals-synthetic-packs` artifact for manual testing. The local job is
  deliberately duplicate coverage: the shared workflow is pinned to a mutable
  `@main` ref, so this repo's own gate is what protects the plugin.

The manual matrix — two host versions, microphone states, transport,
splitscreen layouts, display scales and rollback — lives in
[docs/release-manual-matrix.md](../release-manual-matrix.md) and in #17's
Definition of Done; this document does not duplicate that checklist.

## Related issues

- Epic: [#18](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/18)
- [#11](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/11) — Audio: consolidate microphone pitch detection and scoring
- [#12](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/12) — Compatibility: preserve workflows and migrate the legacy overlay
- [#13](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/13) — Backend: canonical multi-voice playback payload
- [#14](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/14) — Integration: register as a visualization provider
- [#15](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/15) — Renderer: port the Karaoke Highway visual experience
- [#16](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/16) — Playback: duet and splitscreen support
- [#17](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/17) — Release: integration tests, documentation, quality gates

## Reference implementation

[Taynavv/feedback-vocals-viz](https://github.com/Taynavv/feedback-vocals-viz) — Karaoke Highway
