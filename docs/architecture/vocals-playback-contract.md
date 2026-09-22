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

- `schema_version` is an integer. Consumers must reject unsupported
  versions and emit a renderer-failed event with actionable context.
- `song.filename` is the requested filename, not a server filesystem path.
- `arrangement.index` is the optional zero-based query parameter. When it
  is omitted, `index`, `id`, and `name` are null. An unresolved
  non-negative index is echoed with null identity fields.
- Each voice has a stable `id`, a display `name`, and exactly one
  `primary: true` voice when voice data is present.
- Tokens are sorted by finite `start). `duration` is finite and
  non-negative; zero-duration tokens are valid cue markers.
- Invalid token records are dropped at the boundary. A malformed present
  sidecar file is different: return HTTP 422 rather than silently treating
  it as an unprepared song.
- An absent song, absent lyrics, or absent pitch sidecar is handled as
  HTTP 404 where the route currently defines that condition.
- The route only reads prepared files. It must never run pitch extraction,
  load an audio model, or touch microphone state.

## Current and future voice sources

The current feedpak contract supplies one voice through the singular
`lyrics` and optional `vocal_pitch` manifest keys. The response is still
a list so a future feedpak specification can add multiple voices without
changing the top-level shape.

Do not read an undocumented `vocal_tracks` manifest extension. Duet
ingestion is blocked on a feedpak-spec change; until that change lands,
the route must remain compatible with existing prepared songs and return
one primary voice.

## Consumer obligations

The visualization provider:

1. treats missing pitch as a supported lyrics-only mode;
2. does not re-parse `lyrics.json` or `vocal_pitch.json`;
3. keeps all renderer state local to its instance;
4. treats 404 as an expected unprepared-song state;
5. surfaces 422 and network failures through `renderer-failed`; and
6. never retries a failed load every frame.

Fixtures and route tests live in `tests/test_playback_payload.py`.
