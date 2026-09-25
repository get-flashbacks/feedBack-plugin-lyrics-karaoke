# Lyrics Karaoke 1.12.0 — first get-flashbacks release

## Why choose this edition?

If you practice vocals inside FeedBack, this edition brings prepared lyrics
and pitch into the same visualization picker used by other instruments. Select
a Vocals arrangement with **Auto** enabled and sing against a timed pitch
highway. Duets show the other voice as guide bars; in splitscreen, each panel
keeps its own song and scoring state. One shared microphone stream can score
only the selected vocals panel, and capture starts only after you click 🎤.

The [official got-feedBack Lyrics Karaoke plugin](https://github.com/got-feedBack/feedBack-plugin-lyrics-karaoke)
already has lyric and pitch preparation, an overlay, and microphone feedback.
This community-maintained get-flashbacks edition adds the host-managed vocals
visualization, a canonical multi-voice playback payload, duet controls, and
splitscreen microphone ownership. This comparison reflects the official
plugin's [`main` commit 14585eb](https://github.com/got-feedBack/feedBack-plugin-lyrics-karaoke/tree/14585eb6a091f66ed4531bd7cdee9c76c3420076)
(version 1.4.1) on 2026-09-25.

## What is included

- A perspective pitch highway with timed syllables, pitch lanes, note slabs,
  lyric cues, duet guides, and an end-of-song score summary.
- Per-panel sung-part selection, pitch tolerance, octave-free matching, mic
  timing adjustment, and selectable left-rail feedback.
- Compatibility with existing Lyrics Karaoke prepared packs, including packs
  with lyrics but no pitch. The preparation screen, LRC export, and legacy
  overlay remain available.
- A release test gate with generated, copyright-free single-voice, duet,
  incomplete-pitch, and lyrics-only packs.

## Requirements and privacy

The visualization needs FeedBack 0.3.0-alpha.1 or later. Preparation still
needs a song with a vocals stem and a configured alignment service; pitch
generation uses the Python dependencies in `requirements.txt`. Microphone
access is optional and starts with an explicit click. Raw microphone audio is
analyzed locally for scoring and is not stored or transmitted by this plugin.

No user song packs or recordings are included in this release. The source is
licensed under [AGPL-3.0](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/blob/main/LICENSE),
with adaptation credits in
[NOTICE.md](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/blob/main/NOTICE.md), including work from
[Taynavv's Karaoke Highway](https://github.com/Taynavv/feedback-vocals-viz).
