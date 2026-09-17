# Vocals visualization integration architecture

Status: **Accepted** — resolves [#10](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/10),
part of epic [#18](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/18).

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

### Visualization provider (#14 shipped, #15 pending) — owns playback

- Registers `renderer.create`/`renderer.destroy` under the **existing**
  plugin id `lyrics_karaoke` (see [Manifest scope](#manifest-scope-one-plugin-two-roles)).
  Consumes `/playback`; runs no extraction logic of its own.
- Owns rendering (to be ported from Karaoke Highway's `screen.js` in #15),
  microphone capture, live scoring, its own settings namespace, and
  end-of-song results.
- Auto-selects for Vocals arrangements (see [Renderer
  selection](#renderer-selection)).

**As shipped in #14** (`screen.js`, "Visualization provider" section):

- `window.feedBackViz_lyrics_karaoke` — a factory returning a fresh instance
  per call, plus the legacy `window.slopsmithViz_lyrics_karaoke` alias that
  splitscreen's `VIZ_FACTORY_PREFIXES` falls back to. Registration carries
  its own idempotency guard (`__feedBackLyricsKaraokeVizRegistered`),
  separate from the script's `HOOK_KEY` bootstrap guard, and runs at script
  evaluation rather than on `DOMContentLoaded` because the picker may
  enumerate `feedBackViz_*` before then.
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
- `applySetting`/`getSetting` back every key the manifest declares
  (feedBack#849); the host owns persistence. The manifest's ranges and
  labels are Karaoke Highway's verbatim, so a user moving over finds the
  same controls — plus `micFeedback`, the one key the legacy overlay ever
  persisted.
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

**Capabilities declared in #14: `visualization` only.** #14's scope also
listed `note-detection` and `audio-input` "where supported", and Karaoke
Highway declares both — but this plugin services neither pipeline yet. Its
YIN detector and `getUserMedia` live in the legacy overlay rather than
behind a capability, and it never touches the audio-input control plane (no
`list-sources`). Declaring them now would advertise participation the host
could act on and we would not honour, so they belong with #11's microphone
consolidation. The mic *ownership* handshake, being lifecycle, did land here
— see below.

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
lifecycle, `matchesArrangement` Auto-mode, per-instance visualization
settings (`applySetting`/`getSetting`, feedBack#849), and the
`highway:visibility` event. Hosts older than this get the legacy overlay
unconditionally — there is no partial-feature degradation path, since the
renderer cannot register at all without `setRenderer`.

## Manifest scope: one plugin, two roles

A single `plugin.json` **may** declare both a `nav`/`screen` entry (the
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

### Multi-voice (duet) — deferred to a spec change, not silently adopted

feedpak-spec (`spec/feedpak-v1.md` §5.5 `lyric_tracks[]`, §7.1 `lyrics.json`,
§7.2 `vocal_pitch.json` — the token contract above lives in §7.1/§7.2, not
§7.3, which is the separate `vocal_pitch_contour.json` shape) has **no**
multi-singer key as of the current spec version (1.19.0, checked at the
time of writing — re-verify against whatever tag is current when reading
this). `lyric_tracks[]` exists but models language variants of one
performance (original/transliteration/translation) and the spec explicitly
states "Per-track vocal pitch is out of scope for this version" — still
true as of 1.19.0. Karaoke Highway's `routes.py` already reads a non-spec
manifest extension to support duets:

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

This is exactly the drift `feedBack/CLAUDE.md`'s feedpak-spec-gate section
warns against ("a change is not part of the format until it lands [in the
spec]" — see the `original_audio` / #933 cautionary tale). **Decision:**
`vocal_tracks[]` (or a renamed/adjusted form, e.g. aligned with the
`lyric_tracks[]` naming already in the spec) must go through the
[feedpak-spec FEP process](https://github.com/got-feedback/feedpak-spec/blob/main/CONTRIBUTING.md)
— proposal issue, then a spec PR — before `/playback` reads it. Until that
FEP lands:

- `/playback` keeps surfacing exactly one `primary` voice, built from the
  existing singular `lyrics`/`vocal_pitch` manifest keys, exactly as it
  does today.
- Issue #13's "two vocal parts" fixture, and #16 (duet/splitscreen
  playback), stay blocked on the FEP landing — not on any code in this
  repo. That dependency is recorded here explicitly instead of living only
  as a comment in `routes.py`.
- When the FEP lands, `_build_playback_payload` extends to read the new key
  the same way Karaoke Highway's `_build_voices` does, producing multiple
  `voices[]` entries; the schema above already has room for this without a
  `schema_version` bump (`voices` is already a list).

## Renderer selection

Auto mode picks the first registered `matchesArrangement(songInfo)` match,
in plugin registration order. The provider declares:

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

**Until #84 lands**, Auto resolution is therefore split, and #14's
"Vocals arrangements auto-select the provider" criterion holds only in part:

- **Non-notated vocals arrangements** → this provider wins Auto today.
  Nothing else claims them (`keys_highway_3d`/`staffview` both require
  notation, `highway_3d`/`piano` require other names, `drum_highway_3d`
  requires a drum tab).
- **Notated vocals arrangements** → `keys_highway_3d` wins Auto; reaching
  this provider needs an explicit pick from the viz picker. No workaround is
  attempted on this side.

`staffview`'s identical bare `has_notation` is deliberately **not** included
in #84: a staff view of a vocal line is legitimate output, unlike a piano
roll, and it sorts after us anyway.

The load-bearing constraint on **our** side is that the predicate stays keyed
on the arrangement name and never widens to `has_notation` — widening would
claim every notated chart rather than notated *vocals*, making this plugin
the very thing #84 is about. `tests/screen.test.js` pins that.

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

- **The handshake, as shipped in #14.** Ownership is claimed on the 0→1
  live-instance transition and released on 1→0, so a second splitscreen
  panel joining an owned session stands nothing else down and the last
  panel out restores everything:
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
    `noteDetect.enable()` on release. Entirely feature-detected — no
    note_detect, or an older build without the handshake, is a clean no-op,
    and a throwing peer cannot break renderer init.

  Without the note_detect half, a karaoke panel and note_detect would both
  hold a microphone, both score, and note_detect's HUD would draw over the
  ribbon.

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
- Device/channel selection, tolerance, octave-free matching, and mic timing
  offset are exposed as visualization `settings` (feedBack#849) so
  splitscreen's per-panel popover renders them without host-side
  plugin-specific code — the same mechanism Karaoke Highway's `plugin.json`
  already declares.

## Compatibility and migration policy

- A pack prepared by the current plugin (`lyrics.json` + `vocal_pitch.json`
  referenced from the manifest) plays back through the new provider with
  **no regeneration** — `/playback` already reads those exact keys.
- The preparation screen's generate/re-extract/clear/export routes are
  untouched by this integration.
- **Rollback:** disabling the provider's visualization capability (or
  running on a host below the minimum version) restores the legacy overlay
  automatically — no data migration to reverse, since the provider never
  writes anything the overlay doesn't already understand.
- Old hosts (pre-`0.3.0-alpha.1`) get the overlay; there is no crash or
  blank screen, since the manifest's `type: "visualization"` /
  `capabilities` fields are additive and ignored by hosts that predate
  them (same rule as every other optional manifest field per
  `feedBack/CLAUDE.md`).

## Provenance and licensing

Both directions of this port stay AGPL-3.0:

- Karaoke Highway's YIN/mic/ribbon engine was adapted **from** this
  plugin — its `CLAUDE.md` and `routes.py` already carry provenance
  comments crediting `feedBack-plugin-lyrics-karaoke`.
- Code adapted **back** from Karaoke Highway into this plugin (the ported
  renderer visuals in #15, the multi-voice merge shape in
  `_build_voices` once the FEP lands) must carry the reciprocal provenance
  comment crediting `Taynavv/feedback-vocals-viz`, per this epic's stated
  requirement to "preserve AGPL attribution and provenance for adapted
  code."

## Testing strategy

`tests/test_playback_payload.py` already establishes the pattern to extend:
content-free, synthesized fixtures (no real song/lyric content committed),
covering one-singer-complete-pitch, lyrics-only, invalid numeric values,
malformed manifest paths, missing side files, and legacy-shaped files.
Dependent issues should follow the same style:

- #14 (provider registration): stub-host tests for create, repeated
  create, destroy, song switch, failed data load, unsupported host, two
  simultaneous instances — no real FeedBack host required, mirroring how
  Karaoke Highway's own `tests/` stub FastAPI rather than spin up a server.
- #11 (mic/scoring consolidation): pure unit tests for YIN helpers,
  octave-free distance, tolerance boundaries, timing offsets, seek-back
  reset — no live microphone needed.
- #16 (duet/splitscreen), once unblocked by the FEP: two-vocal-part
  fixtures using the eventual spec'd multi-voice key.
- Full CI/manual-matrix gate lives in #17's Definition of Done; this
  document does not duplicate that checklist.

## Related issues

- Epic: [#18](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/18)
- [#11](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/11) — Audio: consolidate microphone pitch detection and scoring
- [#12](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/12) — Compatibility: preserve workflows and migrate the legacy overlay
- [#13](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/13) — Backend: canonical multi-voice playback payload (single-voice shape shipped; multi-voice blocked on the FEP above)
- [#14](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/14) — Integration: register as a visualization provider
- [#15](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/15) — Renderer: port the Karaoke Highway visual experience
- [#16](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/16) — Playback: duet and splitscreen support
- [#17](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/17) — Release: integration tests, documentation, quality gates

## Reference implementation

[Taynavv/feedback-vocals-viz](https://github.com/Taynavv/feedback-vocals-viz) — Karaoke Highway
