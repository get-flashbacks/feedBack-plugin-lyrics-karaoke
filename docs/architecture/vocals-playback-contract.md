# Canonical vocal playback contract

This document is the implementation-facing contract for
`GET /api/plugins/lyrics_karaoke/playback`, tracked by
[#13](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/13)
in the Lyrics Karaoke integration epic
[#18](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/18).

## Response

A successful response has this shape:

```json
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

The provider must be able to render the response when every token is
unpitched. Missing `midi` means “lyrics only”; it is not an error.

## Boundary rules

- `schema_version` is an integer. Version 1 is the current supported
  contract. Consumers must check it before interpreting the payload and
  emit a renderer-failed event with actionable context if they cannot
  support the received version.
- `song.filename` is the requested filename, not a server filesystem path.
- `arrangement.index` is the optional zero-based query parameter. When it
  is omitted, `index`, `id`, and `name` are null. Negative indexes return
  HTTP 422. An unresolved non-negative index is echoed with null identity
  fields.
- Each voice has a stable `id`, a display `name`, and exactly one
  `primary: true` voice when voice data is present.
- Tokens are sorted by finite `start`. `duration` is finite and
  non-negative; zero-duration tokens are valid cue markers.
- `midi`, when present, is an integer in the MIDI `0–127` range; an in-range
  fraction truncates toward zero, an out-of-range one is invalid. Every
  numeric field is validated for type, finiteness, and range before
  conversion: a timestamp or duration that is non-numeric, non-finite, or
  overflowing — including a JSON exponent overflow or the `NaN`/`Infinity`
  literals Python's decoder accepts — and a MIDI value outside `0–127` is an
  invalid token record, dropped so its lyric token stays unpitched.
- Invalid token records are dropped at the boundary. A malformed present
  sidecar file is different: return HTTP 422 rather than silently treating
  it as an unprepared song.
- An absent song or a pack with no usable lyric tokens is handled as
  HTTP 404 where the route currently defines that condition. An absent
  pitch sidecar by itself is valid and returns a 200 lyrics-only payload.
- The route only reads prepared files. It must never run pitch extraction,
  load an audio model, or touch microphone state.

## Voice sources

Solo packs use the standard singular `lyrics` and optional `vocal_pitch`
manifest keys. Duet packs may additionally use the additive `vocal_tracks`
extension shared with Karaoke Highway/feedpakr:

```yaml
lyrics: lyrics_lead.json                 # backward-compatible primary alias
vocal_pitch: vocal_pitch_lead.json
vocal_tracks:
  - id: lead
    name: Lead
    primary: true
    lyrics: lyrics_lead.json
    vocal_pitch: vocal_pitch_lead.json
  - id: harmony
    name: Harmony
    lyrics: lyrics_harmony.json
    vocal_pitch: vocal_pitch_harmony.json
```

The extension follows feedpak v1's additive-extension rule: older readers
ignore `vocal_tracks` and continue through the singular aliases. This route
uses the tracks when at least one has usable lyrics, guarantees exactly one
primary voice, and rejects duplicate voice ids. If no usable track exists,
it falls back to the singular keys.

## Preparation target resolution

The preparation routes (`POST /align`, `POST /save-lyrics`,
`POST /generate-pitch`) and `GET /status` accept an optional `voice` id — a
`vocal_tracks` entry `id` — and all four resolve it through the same helper so
they agree on which track the wizard is working on.

- **Default.** No `voice` (or an empty string) resolves to the effective
  primary: the first entry flagged `primary`, else the first addressable entry.
  For a solo pack, and for a `vocal_tracks` list with no primary flag, this is
  the synthetic `primary` voice that owns the legacy singular sidecars.
- **Writes target the track's own files.** The sidecar a save or pitch job
  writes is the resolved entry's own `lyrics`/`vocal_pitch` pointer, never a
  shared hardcoded name — so a secondary voice cannot clobber the primary's
  files. When the pointer is absent, unsafe, or would escape the pack, the
  track falls back to a per-voice default: the primary inherits the singular
  alias (or `lyrics.json`/`vocal_pitch.json`), a secondary uses
  `<id>.lyrics.json`/`<id>.vocal_pitch.json`.
- **The primary keeps the aliases in sync.** After a primary write the singular
  `lyrics`/`vocal_pitch` keys are re-pointed at the primary's files, preserving
  the additive-extension guarantee that older readers see the primary through
  the singular keys. A secondary write never touches them.
- **Validation is up front.** Duplicate voice ids are rejected for every pack
  (422), and an unknown requested id is a 422 that leaves the pack untouched.
  `/status` returns 422 too, rather than reporting mixed readiness for a pack it
  cannot address.
- **`/status` describes the resolved voice.** Its `has_lyrics`/`has_pitch`/
  `pitch_count` come from the resolved track's own files, and it echoes both
  the resolved `voice` and the full `voices` summary so the UI can build a
  picker. `/align` and `/save-lyrics` echo the resolved `voice` in their
  response.

A solo pack is unchanged: with no `vocal_tracks` and no `voice`, every route
takes the legacy singular path and the status summary reports the single
`primary` voice.

## Consumer obligations

The visualization provider:

1. treats missing pitch as a supported lyrics-only mode;
2. does not re-parse `lyrics.json` or `vocal_pitch.json`;
3. keeps all renderer state local to its instance;
4. treats 404 as an expected unprepared-song state;
5. surfaces 422 and network failures through `renderer-failed`;
6. never retries a failed load every frame; and
7. surfaces a `song_info` it cannot resolve to a pack filename (no
   `audio_url` pack segment, no `filename`, and no core `currentSong`
   fallback either — in practice only this renderer's very first
   `song_info` of the browser session, before any highway anywhere on
   the page has loaded a song and set `currentSong`, since afterward
   that fallback resolves almost any subsequent ambiguous source)
   through `renderer-failed` with `reason: 'unresolvable-filename'`,
   once per unresolvable streak, and clears any previously loaded
   song's data rather than leaving it on screen.

Fixtures and route tests live in `tests/test_playback_payload.py`. The
boundary rules above are enforced structurally by `tests/playback_schema.py`,
driven against generated, copyright-free packs in
`tests/test_generated_feedpaks.py`.
