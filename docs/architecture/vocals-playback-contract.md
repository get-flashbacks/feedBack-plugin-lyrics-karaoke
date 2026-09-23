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

## Consumer obligations

The visualization provider:

1. treats missing pitch as a supported lyrics-only mode;
2. does not re-parse `lyrics.json` or `vocal_pitch.json`;
3. keeps all renderer state local to its instance;
4. treats 404 as an expected unprepared-song state;
5. surfaces 422 and network failures through `renderer-failed`; and
6. never retries a failed load every frame.

Fixtures and route tests live in `tests/test_playback_payload.py`.
