# Third-party provenance and modification notice

This plugin is distributed under the GNU Affero General Public License,
version 3. See [LICENSE](LICENSE) for the full terms.

Portions of the vocals visualization and voice handling were adapted from
[Karaoke Highway](https://github.com/Taynavv/feedback-vocals-viz) by Taynavv
and its contributors, also licensed under AGPL-3.0. The source project credits
earlier work from this plugin for parts of its microphone and ribbon engine.

The get-flashbacks contributors modified and integrated the adapted work into
this plugin on these dates:

- 2026-09-17: adapted the perspective highway stage in `screen.js` to this
  plugin's renderer and playback interfaces.
- 2026-09-22: adapted the voice merge model from Karaoke Highway's `routes.py`
  to this plugin's canonical vocal streams.
- 2026-09-23: adapted scoring and microphone interaction behavior in
  `screen.js` to this plugin's playback and microphone interfaces.

The corresponding source files retain comments identifying the adapted
sections and their origin. The complete source for this version is available
in the [get-flashbacks repository](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke).
