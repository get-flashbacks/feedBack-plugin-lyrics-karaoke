/**
 * Lyrics Karaoke plugin — front-end.
 *
 * Two responsibilities, one IIFE:
 *
 *  1. **Setup screen** ("Lyrics Karaoke" in the nav). A wizard that
 *     picks a song, shows what's missing (vocals stem / synced lyrics /
 *     pitch contour), and runs whatever stages are needed to make the
 *     song karaoke-ready. The setup-screen entry points are exposed on
 *     `window.lk*` because screen.html uses inline `onclick=` handlers.
 *
 *  2. **In-player overlay**. When the user opens a sloppak song with
 *     pitch data and toggles "Karaoke" in the player controls, we draw
 *     a horizontal pitch ribbon (one bar per syllable, vertically
 *     positioned by MIDI pitch, with syllable text below and a sweeping
 *     playhead) on a fixed-position canvas above the highway.
 *
 * The merge consumes the previous standalone "Lyrics Sync" plugin —
 * its alignment + save endpoints now live on this plugin. The old
 * lyrics_sync directory remains as a redirect stub for users with
 * bookmarks pointing at it.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // ── Per-song state ─────────────────────────────────────────────────
    let currentSong = null;          // {filename, format, ...} from window.slopsmith
    let status = null;               // last /status payload
    let pitchData = null;            // {tokens: [{t, d, w, midi?}, ...]}
    let tokenIndexMap = new Map();   // tok → index into pitchData.tokens; rebuilt on each load
    let songPitchRange = null;       // {lo, hi} fixed across the song so bars don't shift vertically as the window scrolls
    let karaokeMode = false;         // user toggle
    // Tracks whether the player screen is the currently-active screen.
    // onToggleClick() awaits network calls before flipping karaokeMode on;
    // if the user navigates away during one of those awaits, the showScreen
    // cleanup below runs while karaokeMode is still false (so it no-ops),
    // and the pending continuation would otherwise reactivate the karaoke
    // player context after the user is already on another screen. Default
    // true since the plugin only ever runs while the player screen is up.
    let _playerScreenActive = true;
    let savedShowLyrics = true;      // restore on toggle off
    let generating = false;          // suppress double-clicks during /generate
    let inflightFetch = 0;           // monotonic token; stale fetches drop their result
    let karaokePreviousContext = null;

    // ── DOM refs ───────────────────────────────────────────────────────
    let toggleBtn = null;
    let overlayEl = null;            // wrapper div that hosts the canvas
    let canvas = null;
    let ctx = null;
    let rafHandle = null;
    let resizeObserver = null;

    // ── Constants ──────────────────────────────────────────────────────
    const VISIBLE_SECONDS = 6.0;     // window of upcoming syllables shown
    const PLAYHEAD_FRAC = 0.18;      // playhead x as fraction of canvas width
    const RIBBON_BG = 'rgba(8, 8, 14, 0.78)';
    const BAR_COLOR_DIM = 'rgba(120, 80, 230, 0.55)';
    const BAR_COLOR_FILL = '#e8c040';
    const BAR_COLOR_ACTIVE = '#ffe080';
    const PLAYHEAD_COLOR = 'rgba(255, 255, 255, 0.85)';
    const TEXT_COLOR = '#f4f4ff';
    const TEXT_COLOR_PAST = 'rgba(160,170,200,0.9)';
    const MIN_PITCH_SPAN_SEMITONES = 7;  // never collapse the strip flatter than a 5th
    const RIBBON_HEIGHT_PX = 140;
    const BAR_PAD_PX = 2;
    const BAR_RADIUS = 4;

    // Centralized class strings — every render path picks one of these so
    // the disabled/enabled visual state always matches the .disabled flag.
    // Spelled out as plain `opacity-*` / `cursor-not-allowed` rather than
    // Tailwind's `disabled:` modifier prefix because the modifier only
    // takes effect when the rule is in the class list AND the disabled
    // attribute is set; rebuilding the class string per render is more
    // predictable than relying on conditional Tailwind variants.
    const BTN_CLASS_DISABLED =
        'px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-500 transition ' +
        'opacity-40 cursor-not-allowed';
    const BTN_CLASS_PROMPT =
        'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    const BTN_CLASS_ACTIVE =
        'px-3 py-1.5 bg-yellow-900/40 hover:bg-yellow-900/60 rounded-lg text-xs text-yellow-200 transition';

    // ── Utilities ──────────────────────────────────────────────────────

    function safeFetch(url, opts) {
        // Wrap fetch with a uniform error shape so callers don't have to
        // remember "did fetch reject or was it a 4xx?"
        return fetch(url, opts).then(async (r) => {
            const text = await r.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (_) { body = { error: text }; }
            return { ok: r.ok, status: r.status, body };
        });
    }

    // A syllable's trailing marker is layout, not text: `-` joins to the
    // next syllable, `+` ends the line (the WebSocket lyrics contract).
    // Shared by the legacy overlay, whose tokens are `{w}`, and the
    // visualization provider, whose canonical /playback tokens are
    // `{text}` — one implementation, two call shapes.
    function stripSyllableMarker(t) {
        const s = String(t == null ? '' : t);
        return (s.endsWith('+') || s.endsWith('-')) ? s.slice(0, -1) : s;
    }

    function syllableText(s) {
        return stripSyllableMarker(s && s.w);
    }

    function isSloppakSong(song) {
        if (!song || !song.filename) return false;
        // The server emits format='sloppak' on song_info; fall back to
        // the filename suffix in case format isn't populated yet (the
        // first song:loaded fires while song_info is still arriving).
        if (song.format === 'sloppak') return true;
        return /\.sloppak(\/)?$/i.test(String(song.filename));
    }

    // ── Status / data fetch ────────────────────────────────────────────

    async function fetchStatus(filename) {
        const token = ++inflightFetch;
        const url = `/api/plugins/lyrics_karaoke/status?filename=${encodeURIComponent(filename)}`;
        const res = await safeFetch(url);
        if (token !== inflightFetch) return null;  // a newer song took over
        if (!res.ok) return null;
        status = res.body;
        return status;
    }

    async function fetchPitchData(filename) {
        const token = ++inflightFetch;
        const url = `/api/plugins/lyrics_karaoke/data?filename=${encodeURIComponent(filename)}`;
        const res = await safeFetch(url);
        if (token !== inflightFetch) return null;
        if (!res.ok) return null;
        pitchData = res.body;
        songPitchRange = computeSongPitchRange(pitchData);
        tokenIndexMap = new Map();
        if (pitchData && Array.isArray(pitchData.tokens)) {
            pitchData.tokens.forEach((tok, i) => { if (tok) tokenIndexMap.set(tok, i); });
        }
        return pitchData;
    }

    // Shared 5th/95th-percentile pitch-range math (screen.js's own two
    // renderers — the legacy overlay and the visualization provider — both
    // need "a fixed range for the whole song, widened to a floor". One
    // implementation over a plain midi array; each caller adapts its own
    // token shape and null contract on top. Percentiles trim outliers (a
    // single octave-error midi shouldn't squash the rest of the song flat);
    // the widen floor keeps a narrow melody from filling the whole strip.
    function _percentilePitchRange(midis) {
        if (!midis.length) return null;
        const sorted = midis.slice().sort((a, b) => a - b);
        const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
        let lo = pct(0.05);
        let hi = pct(0.95);
        if (hi - lo < MIN_PITCH_SPAN_SEMITONES) {
            const center = (hi + lo) / 2;
            const half = MIN_PITCH_SPAN_SEMITONES / 2;
            lo = center - half;
            hi = center + half;
        }
        return { lo, hi };
    }

    // Compute a fixed pitch range for the whole song so a syllable's
    // vertical position stays put as the playhead scrolls. The previous
    // code recomputed lo/hi from the visible window every frame, which
    // made stable bars appear to jump (a bar at the centre of the strip
    // would suddenly snap to the top when a lower-pitched syllable
    // entered the window). We trim 5%/95% percentiles so a single
    // octave-error outlier doesn't squash the rest of the song flat.
    function computeSongPitchRange(data) {
        const tokens = (data && Array.isArray(data.tokens)) ? data.tokens : [];
        const midis = [];
        for (const t of tokens) {
            if (t && typeof t.midi === 'number') midis.push(t.midi);
        }
        // Unlike the provider's _vizPitchRange, this caller never signals
        // "lyrics-only" via null — the legacy overlay always has a strip to
        // draw, so an unpitched song still gets a sane default band.
        return _percentilePitchRange(midis) || { lo: 60, hi: 60 + MIN_PITCH_SPAN_SEMITONES };
    }

    // ── Button wiring ──────────────────────────────────────────────────

    function ensureToggleButton() {
        if (toggleBtn) return;
        const lyricsBtn = document.getElementById('btn-lyrics');
        if (!lyricsBtn || !lyricsBtn.parentNode) return;
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'btn-karaoke';
        toggleBtn.type = 'button';
        // Disabled styling on creation; refreshButtonState() rewrites
        // className on every state transition so the visual stays in
        // sync with the .disabled flag.
        toggleBtn.disabled = true;
        toggleBtn.className = BTN_CLASS_DISABLED;
        toggleBtn.textContent = 'Karaoke';
        toggleBtn.title = 'Karaoke pitch view (sloppak only)';
        toggleBtn.addEventListener('click', onToggleClick);
        lyricsBtn.parentNode.insertBefore(toggleBtn, lyricsBtn.nextSibling);
        // Hidden until song:loaded tells us whether to show it.
        toggleBtn.style.display = 'none';
        // The mic-feedback button rides next to the karaoke toggle and
        // only surfaces while karaoke mode is active. Inject it now so
        // the button order is stable; refreshMicUi() handles visibility.
        ensureMicButton();
    }

    function refreshButtonState() {
        refreshKaraokeToggle();
        // Mic UI tracks the karaoke toggle's eligibility — keep them
        // updated together so toggling/hiding can't desync.
        refreshMicUi();
    }

    function refreshKaraokeToggle() {
        if (!toggleBtn) return;
        const sloppak = isSloppakSong(currentSong);
        if (!sloppak) {
            toggleBtn.style.display = 'none';
            return;
        }
        toggleBtn.style.display = '';

        if (generating) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Generating…';
            toggleBtn.title = 'Extracting vocal pitch — this can take a minute.';
            return;
        }

        if (!status) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Checking…';
            return;
        }

        if (!status.has_lyrics) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Karaoke needs synced lyrics. Run Lyrics Sync first.';
            return;
        }

        if (!status.has_vocals) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Karaoke needs an isolated vocals stem. Split stems with Demucs first.';
            return;
        }

        if (_vizOwnsPlayback()) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'The visualization provider owns playback for this song.';
            return;
        }

        if (!status.has_pitch) {
            toggleBtn.disabled = false;
            toggleBtn.className = BTN_CLASS_PROMPT;
            toggleBtn.textContent = 'Generate Karaoke';
            toggleBtn.title = 'Extract per-syllable pitch from the vocals stem.';
            return;
        }

        // Karaoke ready — toggle between text and karaoke modes.
        toggleBtn.disabled = false;
        toggleBtn.className = karaokeMode ? BTN_CLASS_ACTIVE : BTN_CLASS_PROMPT;
        toggleBtn.textContent = karaokeMode ? 'Karaoke ✓' : 'Karaoke';
        toggleBtn.title = 'Switch between text lyrics and karaoke pitch ribbon.';
    }

    async function onToggleClick() {
        if (!currentSong || !status || generating) return;
        if (!status.has_lyrics || !status.has_vocals) return;

        // Pin the filename at click time. If the user changes songs
        // mid-generation, we don't want to apply the result to a
        // different song's state.
        const clickFilename = currentSong.filename;

        if (!status.has_pitch) {
            // Generate path
            generating = true;
            refreshButtonState();
            try {
                const res = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: clickFilename }),
                });
                if (currentSong && currentSong.filename !== clickFilename) {
                    // Song changed while we were waiting — let the
                    // caller's resetForNewSong path own state. The new
                    // song's onSongLoaded already kicked off its own
                    // status fetch; we'd just clobber it otherwise.
                    return;
                }
                if (!res.ok) {
                    const msg = (res.body && res.body.error) || `Failed (${res.status})`;
                    alert('Karaoke generation failed: ' + msg);
                } else {
                    // Refresh status, then auto-enable karaoke mode
                    await fetchStatus(clickFilename);
                    if (currentSong && currentSong.filename !== clickFilename) return;
                    if (status && status.has_pitch) {
                        await fetchPitchData(clickFilename);
                        if (currentSong && currentSong.filename !== clickFilename) return;
                        if (!_playerScreenActive) return;
                        setKaraokeMode(true);
                    }
                }
            } finally {
                generating = false;
                if (currentSong && currentSong.filename === clickFilename) {
                    refreshButtonState();
                }
            }
            return;
        }

        // Toggle path
        if (karaokeMode) {
            setKaraokeMode(false);
        } else {
            if (!pitchData) {
                await fetchPitchData(clickFilename);
                if (currentSong && currentSong.filename !== clickFilename) return;
                if (!_playerScreenActive) return;
            }
            setKaraokeMode(!!pitchData);
        }
    }

    function updateKaraokePlayerContext(on) {
        const api = window.feedBack && window.feedBack.playerContexts;
        if (!api || typeof api.getActive !== 'function' || typeof api.updateActive !== 'function') return;
        const active = api.getActive('main');
        if (!active) return;
        if (on) {
            karaokePreviousContext = active;
            api.updateActive('main', {
                role: 'karaoke',
                instrument: 'voice',
                skill: 'vocal-pitch',
            });
        } else if (karaokePreviousContext) {
            // A new song may already have replaced main while this plugin handles
            // its song-loaded event. Never restore the previous song over it.
            if (active.song_id === karaokePreviousContext.song_id) {
                api.updateActive('main', {
                    arrangement_id: karaokePreviousContext.arrangement_id,
                    role: karaokePreviousContext.role,
                    instrument: karaokePreviousContext.instrument,
                    skill: karaokePreviousContext.skill,
                });
            }
            karaokePreviousContext = null;
        }
    }

    function setKaraokeMode(on) {
        // Exactly one owner of playback at a time (#10) — the OTHER
        // direction from _vizClaimPlaybackOwnership()'s takeover. That
        // function turns the legacy overlay off and suppresses note_detect
        // when a viz-provider instance claims ownership; without a
        // symmetric check here, nothing stopped the user from re-enabling
        // karaoke from the button afterward, which would flip karaokeMode
        // true and (via the `on` branch below) auto-start the mic even
        // though showOverlay() would still no-op — leaving karaokeMode
        // true, the mic button eligible, and a real path to acquiring a
        // second mic stream and running the legacy scorer concurrently
        // with the viz provider. Refusing here, at the single place that
        // both mounts the overlay and auto-starts the mic, closes the gap
        // at its source rather than patching each downstream symptom.
        if (on && _vizOwnsPlayback()) return;
        if (on === karaokeMode) {
            refreshButtonState();
            return;
        }
        karaokeMode = on;
        updateKaraokePlayerContext(on);
        if (on) {
            // Stash the current text-lyrics visibility so we can restore
            // it when the user toggles back. Don't blow away their pref.
            if (window.highway && typeof window.highway.getLyricsVisible === 'function') {
                savedShowLyrics = window.highway.getLyricsVisible();
                if (typeof window.highway.setLyricsVisible === 'function') {
                    window.highway.setLyricsVisible(false);
                }
            }
            showOverlay();
            // Restore the mic-on intent if the user had it on for the
            // current song's session. Scoped per-song deliberately —
            // resetForNewSong clears micWantOnForSong, so a one-time
            // opt-in on song A doesn't auto-prompt on song B.
            // Fire-and-forget; refreshMicUi reflects the requesting/
            // listening/error transitions as the promise progresses.
            if (micWantOnForSong && status && status.has_pitch && songHasMidi() && micState === 'off') {
                startMic();
            }
        } else {
            hideOverlay();
            // Tear the mic stream down with the overlay — there's nothing
            // to render to. keepFlag preserves the on/off intent so the
            // next karaoke toggle on the same song restores the mic.
            if (micState !== 'off') stopMic({ keepFlag: true });
            resetUserResults();
            if (window.highway && typeof window.highway.setLyricsVisible === 'function') {
                window.highway.setLyricsVisible(savedShowLyrics);
            }
        }
        refreshButtonState();
    }

    // ── Overlay canvas lifecycle ───────────────────────────────────────

    function showOverlay() {
        // Exactly one owner of playback at a time (#10). While a
        // visualization-provider instance is live it renders the ribbon
        // itself, so the overlay must not also mount a canvas and run a
        // second rAF loop over the same song.
        if (_vizOwnsPlayback()) return;
        const player = document.getElementById('player');
        const highway = document.getElementById('highway');
        if (!player || !highway) return;

        if (!overlayEl) {
            overlayEl = document.createElement('div');
            overlayEl.id = 'lyrics-karaoke-overlay';
            overlayEl.style.position = 'absolute';
            overlayEl.style.left = '0';
            overlayEl.style.right = '0';
            overlayEl.style.top = '60px';   // sit just below the HUD row
            overlayEl.style.height = `${RIBBON_HEIGHT_PX}px`;
            overlayEl.style.pointerEvents = 'none';
            overlayEl.style.zIndex = '5';   // above highway, below HUD/controls

            canvas = document.createElement('canvas');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            overlayEl.appendChild(canvas);
            player.appendChild(overlayEl);

            ctx = canvas.getContext('2d');
            sizeCanvas();
        } else {
            overlayEl.style.display = '';
        }

        if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(sizeCanvas);
            resizeObserver.observe(overlayEl);
        }
        startRaf();
    }

    function hideOverlay() {
        stopRaf();
        if (overlayEl) overlayEl.style.display = 'none';
    }

    function teardownOverlay() {
        // Full teardown — used on song change so a stale canvas doesn't
        // linger across reloads.
        stopRaf();
        if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch (_) { /* noop */ }
            resizeObserver = null;
        }
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        overlayEl = null;
        canvas = null;
        ctx = null;
    }

    function sizeCanvas() {
        if (!canvas || !overlayEl) return;
        const rect = overlayEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
    }

    // ── Render loop ────────────────────────────────────────────────────

    function startRaf() {
        if (rafHandle) return;
        const tick = () => {
            rafHandle = requestAnimationFrame(tick);
            try { drawFrame(); } catch (e) {
                // Don't kill the rAF loop on a one-off render bug; log and continue.
                console.warn('lyrics_karaoke draw error', e);
            }
        };
        rafHandle = requestAnimationFrame(tick);
    }

    function stopRaf() {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
        }
    }

    function getNow() {
        if (window.highway && typeof window.highway.getTime === 'function') {
            return window.highway.getTime();
        }
        return 0;
    }

    function visibleBars(now) {
        // Use the absolute window [now - playhead-frac * VISIBLE_SECONDS,
        // now + (1-frac) * VISIBLE_SECONDS]. A small overscan on either
        // side keeps bars from popping at the edges.
        if (!pitchData || !Array.isArray(pitchData.tokens)) return [];
        const winLeft = now - PLAYHEAD_FRAC * VISIBLE_SECONDS - 0.5;
        const winRight = now + (1 - PLAYHEAD_FRAC) * VISIBLE_SECONDS + 0.5;
        const out = [];
        for (const tok of pitchData.tokens) {
            if (!tok || typeof tok.t !== 'number') continue;
            const t1 = tok.t + (tok.d || 0);
            if (t1 < winLeft || tok.t > winRight) continue;
            // Tokens without midi still get rendered as text-only so a
            // whole phrase that pYIN couldn't voice (e.g. quiet/whispered
            // sections) doesn't vanish from the chart.
            const hasMidi = typeof tok.midi === 'number';
            out.push({ tok, midi: hasMidi ? tok.midi : null });
        }
        return out;
    }

    function pitchRange(visible) {
        // Auto-fit the strip to the local vocal range, but never collapse
        // tighter than MIN_PITCH_SPAN_SEMITONES so a held single note still
        // sits in the middle of the strip rather than filling it.
        if (!visible.length) return { lo: 60, hi: 60 + MIN_PITCH_SPAN_SEMITONES };
        let lo = Infinity, hi = -Infinity;
        for (const v of visible) {
            if (v.midi < lo) lo = v.midi;
            if (v.midi > hi) hi = v.midi;
        }
        if (hi - lo < MIN_PITCH_SPAN_SEMITONES) {
            const center = (hi + lo) / 2;
            const half = MIN_PITCH_SPAN_SEMITONES / 2;
            lo = center - half;
            hi = center + half;
        }
        return { lo, hi };
    }

    function drawFrame() {
        if (!canvas || !ctx) return;
        if (!pitchData) return;

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Background — soft band so the ribbon reads against any highway.
        ctx.fillStyle = RIBBON_BG;
        roundFillRect(ctx, 4, 4, W - 8, H - 8, 10);

        const now = getNow();
        const pxPerSec = W / VISIBLE_SECONDS;
        const playheadX = W * PLAYHEAD_FRAC;

        // Compute screen-X from absolute time.
        const xFor = (t) => playheadX + (t - now) * pxPerSec;

        const visible = visibleBars(now);
        // Use the song-wide pitch range so a bar's vertical position
        // doesn't shift as new syllables enter/leave the visible window.
        // Fall back to a per-frame range only when the song-wide range
        // hasn't been computed yet (data still loading).
        const { lo, hi } = songPitchRange || pitchRange(visible);

        // Reserve the bottom ~36px for syllable text; the bars live above.
        const dpr = window.devicePixelRatio || 1;
        const TEXT_BAND_CSS = 36;
        const textBandPx = TEXT_BAND_CSS * dpr;
        const barTop = 12 * dpr;
        const barBand = H - textBandPx - barTop - 4 * dpr;
        const barHeight = Math.max(8 * dpr, Math.min(22 * dpr, barBand / 8));

        const yFor = (midi) => {
            const span = Math.max(1, hi - lo);
            const frac = (hi - midi) / span;       // 0 = top, 1 = bottom
            return barTop + frac * Math.max(0, barBand - barHeight);
        };

        ctx.font = `${Math.round(14 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (const { tok, midi } of visible) {
            const x0 = xFor(tok.t);
            const x1 = xFor(tok.t + (tok.d || 0));
            const w = Math.max(2 * dpr, x1 - x0 - 2 * BAR_PAD_PX * dpr);
            const x = x0 + BAR_PAD_PX * dpr;

            const isPast = (tok.t + (tok.d || 0)) <= now;
            const isActive = tok.t <= now && now < tok.t + (tok.d || 0);

            if (midi !== null) {
                const y = yFor(midi);

                // Draw the dim "future" / "past unreached" bar in full.
                ctx.fillStyle = BAR_COLOR_DIM;
                roundFillRect(ctx, x, y, w, barHeight, BAR_RADIUS * dpr);

                // Fill the portion to the left of the playhead in bright color.
                const fillRight = Math.max(x, Math.min(x + w, playheadX));
                const fillW = fillRight - x;
                if (fillW > 0 && (isPast || isActive)) {
                    ctx.fillStyle = isActive ? BAR_COLOR_ACTIVE : BAR_COLOR_FILL;
                    roundFillRect(ctx, x, y, fillW, barHeight, BAR_RADIUS * dpr);
                }
            }

            // Syllable text below the bar, centered on its midpoint.
            // Render even when midi is missing so phrases pYIN couldn't
            // voice still appear in the lyric stream.
            const text = syllableText(tok);
            if (text) {
                ctx.fillStyle = isPast ? TEXT_COLOR_PAST : TEXT_COLOR;
                const cx = (x0 + x1) / 2;
                const ty = barTop + barBand + 4 * dpr;
                ctx.fillText(text, cx, ty);
            }
        }

        // Mic-feedback overlays — only when the user has been singing.
        if (userResults.size > 0 || micState === 'listening') {
            for (const { tok, midi } of visible) {
                if (midi == null) continue;
                const idx = tokenIndexMap.get(tok);
                if (idx === undefined) continue;
                const entry = userResults.get(idx);
                if (!entry || entry.samplesIn === 0) continue;
                const acc = entry.accuracy;
                const x0 = xFor(tok.t);
                const x1 = xFor(tok.t + (tok.d || 0));
                const w = Math.max(2 * dpr, x1 - x0 - 2 * BAR_PAD_PX * dpr);
                const x = x0 + BAR_PAD_PX * dpr;
                const y = yFor(midi);
                ctx.fillStyle = `rgba(${Math.round(255 * (1 - acc))}, ${Math.round(255 * acc)}, 64, 0.55)`;
                roundFillRect(ctx, x, y, w, barHeight, BAR_RADIUS * dpr);
            }

            // Freshness uses wall-clock ms, not song time — when playback
            // is paused getNow() stops advancing but the user has stopped
            // singing live too, so the line/pill should still age out.
            const fresh = (_wallNow() - userLastSampleWallAt) <= _LK_SAMPLE_FRESH_MS;
            if (fresh && userPitchSamples.length) {
                const last = userPitchSamples[userPitchSamples.length - 1];
                if (userDisplayMidi == null) {
                    userDisplayMidi = last.midi;
                } else {
                    // Simple low-pass (α=0.4) keeps the line from snapping
                    // jaggedly between adjacent semitones without lagging.
                    userDisplayMidi += 0.4 * (last.midi - userDisplayMidi);
                }
                const drawMidi = Math.round(userDisplayMidi);
                const yLine = yFor(drawMidi);
                const yMin = barTop;
                const yMax = barTop + Math.max(0, barBand - barHeight);
                const yClipped = Math.max(yMin, Math.min(yMax, yLine));
                ctx.fillStyle = _LK_PITCH_LINE_COLOR;
                const lineX = playheadX - 30 * dpr;
                const lineW = 34 * dpr;
                const lineY = yClipped + barHeight / 2 - 1.5 * dpr;
                ctx.fillRect(lineX, lineY, lineW, 3 * dpr);
            } else {
                // Discard the smoothed value so re-acquire snaps cleanly
                // rather than drifting from the last fresh pitch.
                userDisplayMidi = null;
            }
            updateMicPill();
        }

        // Playhead.
        ctx.strokeStyle = PLAYHEAD_COLOR;
        ctx.lineWidth = Math.max(1, 1.5 * dpr);
        ctx.beginPath();
        ctx.moveTo(playheadX, 6 * dpr);
        ctx.lineTo(playheadX, H - 6 * dpr);
        ctx.stroke();
    }

    function roundFillRect(c, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        c.beginPath();
        c.moveTo(x + rr, y);
        c.lineTo(x + w - rr, y);
        c.quadraticCurveTo(x + w, y, x + w, y + rr);
        c.lineTo(x + w, y + h - rr);
        c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        c.lineTo(x + rr, y + h);
        c.quadraticCurveTo(x, y + h, x, y + h - rr);
        c.lineTo(x, y + rr);
        c.quadraticCurveTo(x, y, x + rr, y);
        c.closePath();
        c.fill();
    }

    // ── Mic pitch feedback (live) ──────────────────────────────────────
    //
    // YIN + getUserMedia + ScriptProcessor accumulator are adapted from
    // the slopsmith note_detect plugin. Vocals are monophonic so YIN alone
    // is sufficient — no CREPE/HPS/WASM. Once a third consumer of this
    // pattern arrives, factor into a shared module (tracked as issue #5).
    const _LK_YIN_FRAME_SIZE = 2048;
    const _LK_YIN_MIN_SAMPLES = 4096;
    const _LK_YIN_MIN_HZ = 50;        // human vocal floor — drops sub-bass artefacts
    const _LK_YIN_MAX_HZ = 1100;      // upper end of soprano range
    const _LK_YIN_CONFIDENCE = 0.5;   // YIN clarity score; below = unvoiced
    const _LK_MATCH_TOLERANCE = 1.0;  // semitones; locked for v1
    const _LK_SAMPLE_FRESH_MS = 200;  // stale samples don't draw the user line
    const _LK_SAMPLE_RING_CAP = 256;  // ~12 s at 50 ms cadence
    const _LK_STORAGE_KEY = 'lyrics_karaoke.micFeedback';
    const _LK_PITCH_LINE_COLOR = '#22d3ee';
    const _LK_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    // Preallocated YIN working buffer reused across every 50ms detection
    // frame to avoid per-frame Float32Array allocation / GC churn.
    // Sized to cover tauMax at 96 kHz / 50 Hz (⌈96000/50⌉ + 1 = 1921 samples); grows
    // lazily if an even higher sample rate is ever encountered.
    let _yinWorkBuffer = new Float32Array(2048);

    function midiToName(midi) {
        const r = Math.round(midi);
        const pc = ((r % 12) + 12) % 12;
        const oct = Math.floor(r / 12) - 1;
        return _LK_PITCH_NAMES[pc] + oct;
    }

    function freqToMidi(freq) {
        return 12 * Math.log2(freq / 440) + 69;
    }

    function yinDetect(buffer, sampleRate, minFreqHz) {
        const threshold = 0.15;
        // tauMax is the lag that corresponds to the lowest pitch we search
        // for (minFreqHz). Capping halfLen here keeps the outer tau loop and
        // the inner difference-function loop both bounded by tauMax+1 instead
        // of buffer.length/2, reducing total work from O(N²) with N=2048 to
        // O(tauMax²) ≈ 882² at 44100 Hz / 50 Hz min — a ~5.4× speedup.
        const tauMax = Math.ceil(sampleRate / minFreqHz);
        const halfLen = Math.min(Math.floor(buffer.length / 2), tauMax + 1);
        if (halfLen < tauMax) return { freq: -1, confidence: 0 };
        // Reuse preallocated working buffer; grow only when a higher sample
        // rate demands more capacity (extremely rare in practice).
        if (_yinWorkBuffer.length < halfLen) _yinWorkBuffer = new Float32Array(halfLen);
        const yinBuffer = _yinWorkBuffer;
        let runningSum = 0;
        yinBuffer[0] = 1;
        for (let tau = 1; tau < halfLen; tau++) {
            let sum = 0;
            for (let i = 0; i < halfLen; i++) {
                const delta = buffer[i] - buffer[i + tau];
                sum += delta * delta;
            }
            yinBuffer[tau] = sum;
            runningSum += sum;
            yinBuffer[tau] = runningSum === 0 ? 1 : yinBuffer[tau] * (tau / runningSum);
        }
        let tau = 2;
        while (tau < halfLen) {
            if (yinBuffer[tau] < threshold) {
                while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
                break;
            }
            tau++;
        }
        if (tau === halfLen) return { freq: -1, confidence: 0 };
        const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
        const s1 = yinBuffer[tau];
        const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
        const parabDenom = 2 * (s0 - 2 * s1 + s2);
        const betterTau = parabDenom !== 0 ? tau + (s0 - s2) / parabDenom : tau;
        return {
            freq: sampleRate / betterTau,
            confidence: Math.max(0, 1 - yinBuffer[tau]),
        };
    }

    // Mic state — implicit-flag style mirroring note_detect's pattern.
    let micState = 'off';            // 'off' | 'requesting' | 'listening' | 'error'
    let micBtn = null;
    let micPill = null;
    let micStream = null;
    let micCtx = null;
    let micSourceNode = null;
    let micProcessor = null;
    let micTimer = null;
    let micSessionGen = 0;            // bumped on stop to invalidate stale frames
    let micRingBuffer = null;         // preallocated sliding window (Float32Array, _LK_YIN_MIN_SAMPLES)
    let micRingCount = 0;             // total samples written into ring since mic start
    let micPendingBuffer = null;      // preallocated snapshot buffer (Float32Array, same size)
    let micPendingReady = false;      // true when pending buffer has a fresh snapshot
    let micPendingBufferAt = -Infinity;  // song-time at the buffer's midpoint
    let micPendingSession = 0;           // micSessionGen at the time the snapshot was taken
    let micLastCapturedAt = -Infinity;   // previous frame's song-time, for stall/seek detection
    let micErrorMsg = '';
    let micPillLastText = '';            // last text written to micPill; avoids per-frame DOM writes
    // Session-scoped intent: "the user enabled mic for THIS song." Used
    // to auto-restore the mic when karaoke is toggled off and back on
    // for the same song without spilling that intent across songs (a
    // resetForNewSong clears it). The persisted localStorage flag is
    // separate and serves a future "remember on reload" surface.
    let micWantOnForSong = false;

    // Per-song bookkeeping for the live overlay.
    const userPitchSamples = [];      // ring of {t, midi, confidence}
    const userResults = new Map();    // tokenIndex → {samplesIn, samplesMatched, accuracy}
    let userDisplayMidi = null;       // smoothed value used for the pitch line + pill
    let userLastSampleWallAt = -Infinity; // wall-clock ms of latest sample (used for staleness)

    function _wallNow() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }

    function getPlaybackRate() {
        // The player's <audio> element drives song time; its playbackRate
        // is the song-seconds-per-wall-second ratio. Plugins access it
        // through the DOM rather than a window global because app.js
        // keeps the reference module-scoped.
        const a = (typeof document !== 'undefined') ? document.getElementById('audio') : null;
        if (a && typeof a.playbackRate === 'number' && a.playbackRate > 0) {
            return a.playbackRate;
        }
        return 1.0;
    }

    function songHasMidi() {
        if (!pitchData || !Array.isArray(pitchData.tokens)) return false;
        for (const t of pitchData.tokens) {
            if (t && typeof t.midi === 'number') return true;
        }
        return false;
    }

    function resetUserResults() {
        userPitchSamples.length = 0;
        userResults.clear();
        userDisplayMidi = null;
        userLastSampleWallAt = -Infinity;
        // Also drop the transport-tracking cursor so the next frame
        // doesn't compare against a stale previous time.
        micLastCapturedAt = -Infinity;
    }

    function findActiveTokenIndex(time) {
        // Latest-starting token whose [t, t+d) contains `time` wins, so an
        // overlapping next-syllable claim takes priority over the trailing
        // tail of the previous one. Linear scan is fine — token counts
        // are typically a few hundred per song.
        if (!pitchData || !Array.isArray(pitchData.tokens)) return -1;
        let bestIdx = -1;
        let bestStart = -Infinity;
        for (let i = 0; i < pitchData.tokens.length; i++) {
            const tok = pitchData.tokens[i];
            if (!tok || typeof tok.t !== 'number' || typeof tok.midi !== 'number') continue;
            const t0 = tok.t;
            const t1 = t0 + (tok.d || 0);
            if (time < t0 || time >= t1) continue;
            if (t0 > bestStart) { bestStart = t0; bestIdx = i; }
        }
        return bestIdx;
    }

    function processYinFrame(buffer, sampleRate, capturedAt, sessionAtCapture) {
        if (sessionAtCapture !== micSessionGen) return;  // stop happened mid-frame

        // Transport awareness. If the playhead jumped backward (replay,
        // seek-back), wipe the bookkeeping so old scores don't resurrect
        // on the new pass. If the playhead didn't advance at all
        // (paused), drop the sample — otherwise samplesIn for whatever
        // token sits under the cursor would inflate forever, dragging
        // accuracy toward 0/1 with no real input.
        if (micLastCapturedAt > -Infinity) {
            const delta = capturedAt - micLastCapturedAt;
            if (delta < 0) {
                resetUserResults();
            } else if (delta < 1e-3) {
                return;
            }
        }
        micLastCapturedAt = capturedAt;

        const r = yinDetect(buffer, sampleRate, _LK_YIN_MIN_HZ);
        if (!r || r.freq <= 0 || r.confidence < _LK_YIN_CONFIDENCE) return;
        if (r.freq < _LK_YIN_MIN_HZ || r.freq > _LK_YIN_MAX_HZ) return;
        const midi = freqToMidi(r.freq);
        if (!isFinite(midi)) return;

        userPitchSamples.push({ t: capturedAt, midi, confidence: r.confidence });
        if (userPitchSamples.length > _LK_SAMPLE_RING_CAP) userPitchSamples.shift();
        userLastSampleWallAt = _wallNow();

        const idx = findActiveTokenIndex(capturedAt);
        if (idx < 0) return;
        const tok = pitchData.tokens[idx];
        let entry = userResults.get(idx);
        if (!entry) {
            entry = { samplesIn: 0, samplesMatched: 0, accuracy: 0 };
            userResults.set(idx, entry);
        }
        entry.samplesIn += 1;
        if (Math.abs(midi - tok.midi) <= _LK_MATCH_TOLERANCE) entry.samplesMatched += 1;
        entry.accuracy = entry.samplesMatched / entry.samplesIn;
    }

    async function startMic() {
        if (micState === 'listening' || micState === 'requesting') return;
        micState = 'requesting';
        micErrorMsg = '';
        refreshMicUi();

        const session = ++micSessionGen;
        let pendingStream = null;
        let pendingCtx = null;
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                const isHttp = location.protocol === 'http:'
                    && location.hostname !== 'localhost'
                    && location.hostname !== '127.0.0.1';
                throw new Error(isHttp
                    ? 'Microphone access requires HTTPS (or localhost).'
                    : 'Microphone access is not available in this browser. Try Chrome or Edge.');
            }
            // Create + resume the AudioContext BEFORE awaiting
            // getUserMedia so the original user activation is still
            // valid when Safari/iOS evaluates resume(). After the
            // await, activation can be consumed and resume() would
            // refuse, leaving us silently in 'listening' with no audio.
            pendingCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (pendingCtx.state === 'suspended') {
                try { await pendingCtx.resume(); } catch (e) {
                    throw new Error('Audio context could not resume. Click 🎤 again.');
                }
                if (pendingCtx.state === 'suspended') {
                    throw new Error('Audio context is suspended. Click 🎤 again.');
                }
            }
            pendingStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 1,
                },
            });
            if (session !== micSessionGen) {
                // Stop happened while the permission prompt was open.
                pendingStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* noop */ } });
                try { pendingCtx.close(); } catch (_) { /* noop */ }
                return;
            }
            micStream = pendingStream;
            micCtx = pendingCtx;
            micSourceNode = micCtx.createMediaStreamSource(micStream);
            micProcessor = micCtx.createScriptProcessor(_LK_YIN_FRAME_SIZE, 1, 1);
            // Preallocate fixed-size buffers to avoid per-frame Float32Array
            // allocation / GC pressure in the hot onaudioprocess path.
            // ringSize must cover 2*tauMax samples so yinDetect can search
            // down to _LK_YIN_MIN_HZ at any sample rate (e.g. 192 kHz needs
            // 2*⌈192000/50⌉ = 7680 samples, well above _LK_YIN_MIN_SAMPLES).
            const sampleRate = micCtx.sampleRate;
            const ringSize = Math.max(_LK_YIN_MIN_SAMPLES,
                2 * Math.ceil(sampleRate / _LK_YIN_MIN_HZ));
            micRingBuffer = new Float32Array(ringSize);
            micPendingBuffer = new Float32Array(ringSize);
            micRingCount = 0;
            micPendingReady = false;

            // The captured audio represents the most recent
            // ringSize frames of mic input — i.e. it spans
            // [now - bufferDurationWall, now] in wall-clock seconds.
            // Tag the *midpoint* of that window as the buffer's
            // representative song time so findActiveTokenIndex scores
            // against the syllable actually being sung, not the one
            // under the cursor when the 50 ms timer wakes. Convert
            // wall-clock to song-time via the current playback rate so
            // slow/fast practice still maps frames to the correct
            // syllable (read fresh per frame — the user can scrub the
            // speed slider mid-song).
            const midpointWallSec = (ringSize / 2) / sampleRate;

            micProcessor.onaudioprocess = (e) => {
                if (micState !== 'listening') return;
                const input = e.inputBuffer.getChannelData(0);
                const n = input.length;
                // Slide the ring buffer left by n samples (in-place, no allocation):
                // copies bytes [n .. ringSize-1] to [0 .. ringSize-n-1],
                // then the new frame fills the vacated tail.
                micRingBuffer.copyWithin(0, n);
                micRingBuffer.set(input, ringSize - n);
                micRingCount += n;
                // Only expose a pending snapshot once we have a full window.
                // After that, every ScriptProcessor callback (~46 ms at
                // 44100 Hz) produces a fresh snapshot — well within the
                // 50 ms timer cadence.
                if (micRingCount >= ringSize) {
                    micPendingBuffer.set(micRingBuffer);
                    micPendingBufferAt = getNow() - midpointWallSec * getPlaybackRate();
                    micPendingSession = session;
                    micPendingReady = true;
                }
            };

            micSourceNode.connect(micProcessor);
            // ScriptProcessor needs a sink to actually pump audio. Routing
            // to destination would feed the mic to the speakers; route to
            // a muted gain node instead so we get callbacks without
            // creating a feedback loop.
            const muteSink = micCtx.createGain();
            muteSink.gain.value = 0;
            micProcessor.connect(muteSink);
            muteSink.connect(micCtx.destination);

            micTimer = setInterval(() => {
                if (!micPendingReady) return;
                const at = micPendingBufferAt;
                const sessionAtCapture = micPendingSession;
                micPendingReady = false;
                processYinFrame(micPendingBuffer, sampleRate, at, sessionAtCapture);
            }, 50);

            micState = 'listening';
            micWantOnForSong = true;
            try { localStorage.setItem(_LK_STORAGE_KEY, '1'); } catch (_) { /* noop */ }
            refreshMicUi();
        } catch (e) {
            console.warn('lyrics_karaoke mic start failed', e);
            micErrorMsg = (e && e.message) || 'Microphone unavailable';
            // Clean up partial state — we may have created the context
            // and/or stream before the throw, but they aren't yet
            // assigned to micCtx/micStream that stopMic operates on.
            if (pendingStream && pendingStream !== micStream) {
                try { pendingStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
            }
            if (pendingCtx && pendingCtx !== micCtx) {
                try { pendingCtx.close(); } catch (_) { /* noop */ }
            }
            // Clear both the persisted flag and the per-song intent on
            // failure. Otherwise a revoked permission or unplugged
            // input would re-trigger the prompt on every karaoke
            // toggle (persisted flag) or every karaoke off/on for the
            // current song (in-memory intent). The user re-clicks 🎤
            // to retry; a successful start re-sets both flags.
            micWantOnForSong = false;
            stopMic({ keepFlag: false });
            // stopMic resets to 'off'; re-flag as 'error' so the pill/title
            // surface why the start failed.
            micState = 'error';
            refreshMicUi();
        }
    }

    function stopMic(opts) {
        const keepFlag = !!(opts && opts.keepFlag);
        micSessionGen += 1;  // any in-flight YIN frame becomes stale
        if (micTimer) { clearInterval(micTimer); micTimer = null; }
        if (micProcessor) {
            try { micProcessor.disconnect(); } catch (_) { /* noop */ }
            micProcessor.onaudioprocess = null;
            micProcessor = null;
        }
        if (micSourceNode) {
            try { micSourceNode.disconnect(); } catch (_) { /* noop */ }
            micSourceNode = null;
        }
        if (micStream) {
            try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
            micStream = null;
        }
        if (micCtx) {
            try { micCtx.close(); } catch (_) { /* noop */ }
            micCtx = null;
        }
        micRingBuffer = null;
        micRingCount = 0;
        micPendingBuffer = null;
        micPendingReady = false;
        micPendingBufferAt = -Infinity;
        micLastCapturedAt = -Infinity;
        if (!keepFlag) {
            try { localStorage.setItem(_LK_STORAGE_KEY, '0'); } catch (_) { /* noop */ }
        }
        micState = 'off';
        refreshMicUi();
    }

    function ensureMicButton() {
        if (micBtn) return;
        if (!toggleBtn || !toggleBtn.parentNode) return;
        micBtn = document.createElement('button');
        micBtn.id = 'btn-karaoke-mic';
        micBtn.type = 'button';
        micBtn.disabled = true;
        micBtn.className = BTN_CLASS_DISABLED;
        micBtn.textContent = '🎤';
        micBtn.title = 'Toggle live mic feedback';
        micBtn.setAttribute('aria-label', 'Toggle live mic feedback');
        micBtn.setAttribute('aria-pressed', 'false');
        micBtn.addEventListener('click', onMicClick);
        toggleBtn.parentNode.insertBefore(micBtn, toggleBtn.nextSibling);

        micPill = document.createElement('span');
        micPill.id = 'btn-karaoke-mic-pill';
        micPill.className = 'text-xs text-gray-500 ml-1 inline-block min-w-8 text-center';
        micPill.textContent = '';
        toggleBtn.parentNode.insertBefore(micPill, micBtn.nextSibling);

        micBtn.style.display = 'none';
        micPill.style.display = 'none';
    }

    async function onMicClick() {
        if (micBtn && micBtn.disabled) return;
        if (micState === 'listening') {
            // User-initiated stop — clear the per-song intent so karaoke
            // off/on for this song doesn't auto-resume a mic the user
            // explicitly turned off.
            micWantOnForSong = false;
            stopMic({ keepFlag: false });
            resetUserResults();
            return;
        }
        // 'off' or 'error' — request (or retry) mic acquisition.
        await startMic();
    }

    function refreshMicUi() {
        if (!micBtn) return;
        const sloppak = isSloppakSong(currentSong);
        const eligible = sloppak && karaokeMode && !!status && status.has_pitch && songHasMidi();
        if (!eligible) {
            micBtn.style.display = 'none';
            if (micPill) micPill.style.display = 'none';
            return;
        }
        micBtn.style.display = '';
        if (micPill) micPill.style.display = '';

        switch (micState) {
            case 'requesting':
                micBtn.disabled = true;
                micBtn.className = BTN_CLASS_DISABLED;
                micBtn.title = 'Requesting microphone…';
                micBtn.setAttribute('aria-label', 'Requesting microphone…');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = '…'; micPillLastText = '…'; }
                break;
            case 'listening':
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_ACTIVE;
                micBtn.title = 'Stop live mic feedback';
                micBtn.setAttribute('aria-label', 'Stop live mic feedback');
                micBtn.setAttribute('aria-pressed', 'true');
                micPillLastText = '';
                // Pill text is set by updateMicPill() each render frame.
                break;
            case 'error':
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_PROMPT;
                micBtn.title = 'Mic feedback error: ' + (micErrorMsg || 'unknown') + ' (click to retry)';
                micBtn.setAttribute('aria-label', 'Mic error — click to retry');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = '!'; micPillLastText = '!'; }
                break;
            default:  // 'off'
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_PROMPT;
                micBtn.title = 'Toggle live mic feedback';
                micBtn.setAttribute('aria-label', 'Toggle live mic feedback');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = ''; micPillLastText = ''; }
                break;
        }
    }

    function updateMicPill() {
        if (!micPill || micState !== 'listening') return;
        const text = (userDisplayMidi == null || !isFinite(userDisplayMidi))
            ? '—'
            : midiToName(userDisplayMidi);
        if (text === micPillLastText) return;
        micPillLastText = text;
        micPill.textContent = text;
    }

    // ── Song lifecycle wiring ──────────────────────────────────────────

    function resetForNewSong(song) {
        // If the previous song had karaoke mode on, the highway's
        // showLyrics flag is currently forced to false. Restore the
        // user's saved preference BEFORE we lose track of it — the
        // highway carries showLyrics across songs (it lives in factory
        // closure state and is only reset by toggleLyrics()), so
        // forgetting to restore here would leave text lyrics hidden on
        // the next song that doesn't support karaoke.
        if (karaokeMode) {
            if (window.highway && typeof window.highway.setLyricsVisible === 'function') {
                window.highway.setLyricsVisible(savedShowLyrics);
            }
            karaokeMode = false;
            updateKaraokePlayerContext(false);
        }
        currentSong = song || null;
        status = null;
        pitchData = null;
        tokenIndexMap = new Map();
        songPitchRange = null;
        // Tear the overlay all the way down so a previous song's bars
        // don't briefly flash for the new song before its data arrives.
        teardownOverlay();
        // Drop mic state with the song. keepFlag preserves the
        // localStorage on/off bit (a future "remember on reload"
        // surface), but micWantOnForSong is per-song so a one-time
        // opt-in on song A doesn't auto-prompt on song B.
        if (micState !== 'off') stopMic({ keepFlag: true });
        micWantOnForSong = false;
        resetUserResults();
        refreshButtonState();
    }

    async function onSongLoaded(song) {
        resetForNewSong(song);
        ensureToggleButton();
        refreshButtonState();
        if (!isSloppakSong(song)) return;
        await fetchStatus(song.filename);
        // Pre-fetch pitch data so the first toggle is instant.
        if (status && status.has_pitch) {
            await fetchPitchData(song.filename);
        }
        refreshButtonState();
    }

    // ══════════════════════════════════════════════════════════════════
    // SETUP SCREEN — wizard for "Add karaoke to this song"
    // ══════════════════════════════════════════════════════════════════
    //
    // The setup screen DOM is in screen.html. The functions below are
    // exposed on window.lk* because screen.html uses inline onclick=
    // attributes (innerHTML-injected screens can't hydrate via
    // addEventListener at parse time — that's a Slopsmith convention,
    // not a personal preference).

    const setup = {
        selectedFilename: null,
        selectedTitle: '',
        selectedArtist: '',
        // Last alignment result (returned by /align). Held in memory
        // until the build pipeline auto-saves or the user discards.
        alignmentResult: null,
        // Last status fetch for the SETUP screen — kept separate from
        // the player overlay's `status` so a song change in the player
        // doesn't blow away setup state mid-build.
        status: null,
    };

    function setupEl(id) { return document.getElementById(id); }

    async function refreshServerStatus() {
        const el = setupEl('lk-server-status');
        if (!el) return;
        try {
            const res = await safeFetch('/api/plugins/lyrics_karaoke/server-status');
            const ok = res.ok && res.body && res.body.available;
            if (ok) {
                el.innerHTML =
                    '<div class="bg-green-900/20 border border-green-800/30 rounded-xl p-3 text-sm">' +
                    '<span class="text-green-400">Alignment server ready</span>' +
                    '</div>';
            } else {
                const reason = (res.body && res.body.reason) || 'Unknown error';
                el.innerHTML =
                    '<div class="bg-yellow-900/20 border border-yellow-800/30 rounded-xl p-4 text-sm">' +
                    '<p class="text-yellow-400 font-semibold mb-1">Alignment server unavailable</p>' +
                    '<p class="text-gray-400">' + escHtml(reason) + '</p>' +
                    '<p class="text-gray-500 mt-1">Set <code>demucs_server_url</code> in Stems / Sloppak Converter settings.</p>' +
                    '</div>';
            }
        } catch (_) {
            el.innerHTML =
                '<div class="bg-red-900/20 border border-red-800/30 rounded-xl p-3 text-sm">' +
                '<span class="text-red-400">Failed to check alignment server</span>' +
                '</div>';
        }
    }

    function escHtml(s) {
        // Local minimal HTML escape — keeps the plugin's setup-screen
        // markup safe even if app.js's global esc() helper is missing.
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function lkSearchSongs() {
        const input = setupEl('lk-search');
        const q = (input && input.value || '').trim();
        const container = setupEl('lk-search-results');
        if (!container) return;
        if (!q) {
            container.innerHTML = '';
            return;
        }
        const url = `/api/library?q=${encodeURIComponent(q)}&page=0&size=20&sort=artist&format=sloppak`;
        const res = await safeFetch(url);
        if (!res.ok) {
            container.innerHTML = '<p class="text-gray-500 text-xs py-2">Search failed.</p>';
            return;
        }
        const songs = (res.body && res.body.songs) || [];
        // Karaoke needs split stems (vocals.ogg). The library returns
        // stem_count; >1 means Demucs has run on this song. Songs with
        // only `full.ogg` aren't useful here — surface a hint instead
        // of silently dropping them.
        const withStems = songs.filter((s) => (s.stem_count || 0) > 1);
        const withoutStems = songs.length - withStems.length;
        if (!withStems.length) {
            container.innerHTML =
                '<p class="text-gray-500 text-xs py-2">' +
                'No sloppak songs with split stems matched. ' +
                'Run Demucs split (Stems plugin / Sloppak Converter) on a song first.' +
                (withoutStems > 0 ? ` (${withoutStems} matched without stems.)` : '') +
                '</p>';
            return;
        }
        container.innerHTML = withStems.map((s) => {
            const fn = encodeURIComponent(s.filename);
            const title = escHtml(s.title);
            const artist = escHtml(s.artist);
            // Stash the raw values on data attributes so the click
            // handler can read them without the brittle inline-string
            // escape dance the old lyrics_sync plugin used.
            return (
                '<div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition cursor-pointer" ' +
                'data-fn="' + fn + '" data-title="' + title + '" data-artist="' + artist + '" ' +
                'onclick="lkSelectFromResult(this)">' +
                '  <div class="flex-1 min-w-0">' +
                '    <span class="text-sm text-white">' + title + '</span> ' +
                '    <span class="text-xs text-gray-500 ml-2">' + artist + '</span>' +
                '  </div>' +
                '  <span class="text-xs text-gray-600">' + (s.stem_count | 0) + ' stems</span>' +
                '</div>'
            );
        }).join('');
    }

    function lkSelectFromResult(div) {
        if (!div) return;
        const fn = decodeURIComponent(div.getAttribute('data-fn') || '');
        const title = div.getAttribute('data-title') || '';
        const artist = div.getAttribute('data-artist') || '';
        lkSelectSong(fn, title, artist);
    }

    async function lkSelectSong(filename, title, artist) {
        setup.selectedFilename = filename;
        setup.selectedTitle = title;
        setup.selectedArtist = artist;
        setup.alignmentResult = null;
        const results = setupEl('lk-search-results');
        if (results) results.innerHTML = '';
        const search = setupEl('lk-search');
        if (search) search.value = '';
        const sel = setupEl('lk-selected-song');
        const lbl = setupEl('lk-selected-label');
        if (sel) sel.classList.remove('hidden');
        if (lbl) lbl.textContent = `${title} — ${artist}`;
        await refreshSetupStatus();
    }

    function lkClearSong() {
        setup.selectedFilename = null;
        setup.selectedTitle = '';
        setup.selectedArtist = '';
        setup.alignmentResult = null;
        setup.status = null;
        const sel = setupEl('lk-selected-song');
        const lbl = setupEl('lk-selected-label');
        if (sel) sel.classList.add('hidden');
        if (lbl) lbl.textContent = '';
        // Hide all the per-song sections.
        for (const id of ['lk-checklist-section', 'lk-lyrics-section', 'lk-build-section', 'lk-done', 'lk-progress', 'lk-error']) {
            const el = setupEl(id);
            if (el) el.classList.add('hidden');
        }
    }

    async function refreshSetupStatus() {
        if (!setup.selectedFilename) return;
        const url = `/api/plugins/lyrics_karaoke/status?filename=${encodeURIComponent(setup.selectedFilename)}`;
        const res = await safeFetch(url);
        if (!res.ok) return;
        // Pinned to selectedFilename — refreshSetupStatus is called from
        // synchronous flows (selectSong, post-build), so a song-change
        // race would manifest as a stale status. Cheap to guard.
        if (!res.body || res.body.filename !== setup.selectedFilename) return;
        setup.status = res.body;
        renderSetupStatus();
    }

    function renderSetupStatus() {
        const s = setup.status;
        if (!s) return;
        const checklist = setupEl('lk-checklist');
        const checklistSection = setupEl('lk-checklist-section');
        if (checklistSection) checklistSection.classList.remove('hidden');

        // Update the three checklist rows by data-key.
        function setRow(key, mark, klass, detail) {
            if (!checklist) return;
            const row = checklist.querySelector(`li[data-key="${key}"]`);
            if (!row) return;
            const check = row.querySelector('.lk-check');
            const det = row.querySelector('.lk-detail');
            if (check) {
                check.textContent = mark;
                check.className = 'lk-check w-5 ' + klass;
            }
            if (det) det.textContent = detail || '';
        }

        if (s.has_vocals) {
            setRow('vocals', '✓', 'text-green-400', 'stems/vocals.ogg');
        } else {
            setRow('vocals', '✗', 'text-red-400', 'Run Demucs split first');
        }

        if (s.has_lyrics) {
            setRow('lyrics', '✓', 'text-green-400', 'lyrics.json present');
        } else {
            setRow('lyrics', '✗', 'text-yellow-400', 'Paste plain text below');
        }

        if (s.has_pitch) {
            setRow('pitch', '✓', 'text-green-400', `${s.pitch_count} voiced syllables`);
        } else if (!s.has_lyrics) {
            setRow('pitch', '⏸', 'text-gray-500', 'Waiting for synced lyrics');
        } else {
            setRow('pitch', '✗', 'text-yellow-400', 'Will extract on Build');
        }

        // Lyrics input section — show only when synced lyrics are missing
        // AND vocals exist (no point pasting text without a stem to align).
        const lyricsSection = setupEl('lk-lyrics-section');
        if (lyricsSection) {
            if (!s.has_lyrics && s.has_vocals) {
                lyricsSection.classList.remove('hidden');
            } else {
                lyricsSection.classList.add('hidden');
            }
        }

        // Build section — visible if vocals exist and either lyrics need
        // aligning or pitch needs extracting. Hidden when there's
        // genuinely nothing to do (everything ready) — that surface goes
        // to the done state instead.
        const buildSection = setupEl('lk-build-section');
        const doneSection = setupEl('lk-done');
        if (s.has_vocals && (!s.has_lyrics || !s.has_pitch)) {
            if (buildSection) buildSection.classList.remove('hidden');
            if (doneSection) doneSection.classList.add('hidden');
        } else if (s.has_vocals && s.has_lyrics && s.has_pitch) {
            if (buildSection) buildSection.classList.add('hidden');
            renderDoneState(s);
        } else {
            // No vocals — neither section is actionable.
            if (buildSection) buildSection.classList.add('hidden');
            if (doneSection) doneSection.classList.add('hidden');
        }

        updateBuildBtn();
    }

    function renderDoneState(s) {
        const doneSection = setupEl('lk-done');
        const detail = setupEl('lk-done-detail');
        if (doneSection) doneSection.classList.remove('hidden');
        if (detail) {
            detail.textContent =
                `${setup.selectedArtist} — ${setup.selectedTitle} has lyrics + pitch persisted` +
                ` (${s.pitch_count || 0} voiced syllables). Open in the player and toggle Karaoke.`;
        }
        // Only offer the .lrc download if we have a fresh alignment
        // result in memory — re-loading from disk would lose word/line
        // boundaries that the export format expects.
        const exportBtn = setupEl('lk-export-btn');
        if (exportBtn) {
            if (setup.alignmentResult && setup.alignmentResult.length) {
                exportBtn.classList.remove('hidden');
            } else {
                exportBtn.classList.add('hidden');
            }
        }
    }

    function updateBuildBtn() {
        const btn = setupEl('lk-build-btn');
        if (!btn) return;
        const s = setup.status;
        if (!s || !setup.selectedFilename || !s.has_vocals) {
            btn.disabled = true;
            return;
        }
        // If lyrics are missing, we need pasted text to align. If lyrics
        // are present (only pitch missing), we can build with no input.
        if (!s.has_lyrics) {
            const ta = setupEl('lk-lyrics');
            const has = ta && ta.value.trim().length > 0;
            btn.disabled = !has;
            btn.textContent = 'Build Karaoke';
        } else if (!s.has_pitch) {
            btn.disabled = false;
            btn.textContent = 'Extract pitch';
        } else {
            btn.disabled = true;
            btn.textContent = 'Karaoke ready';
        }
    }

    function lkFileUpload(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const ta = setupEl('lk-lyrics');
            if (ta) ta.value = String(reader.result || '');
            lkUpdateLineCount();
            updateBuildBtn();
        };
        reader.readAsText(file);
        input.value = '';
    }

    function lkUpdateLineCount() {
        const ta = setupEl('lk-lyrics');
        const out = setupEl('lk-lyrics-count');
        const text = ta ? ta.value.trim() : '';
        const count = text ? text.split('\n').filter((l) => l.trim()).length : 0;
        if (out) out.textContent = `${count} line${count !== 1 ? 's' : ''}`;
    }

    function setupGranularity() {
        const checked = document.querySelector('input[name="lk-granularity"]:checked');
        return checked ? checked.value : 'syllable';
    }

    function showProgress(label, detail) {
        const p = setupEl('lk-progress');
        const lbl = setupEl('lk-progress-label');
        const det = setupEl('lk-progress-detail');
        if (p) p.classList.remove('hidden');
        if (lbl) lbl.textContent = label || 'Working…';
        if (det) det.textContent = detail || '';
        const err = setupEl('lk-error');
        if (err) err.classList.add('hidden');
    }

    function hideProgress() {
        const p = setupEl('lk-progress');
        if (p) p.classList.add('hidden');
    }

    function showError(msg) {
        hideProgress();
        const err = setupEl('lk-error');
        const det = setupEl('lk-error-detail');
        if (err) err.classList.remove('hidden');
        if (det) det.textContent = msg || 'Unknown error';
    }

    async function lkBuild() {
        if (!setup.selectedFilename || !setup.status) return;
        const filename = setup.selectedFilename;
        const btn = setupEl('lk-build-btn');
        if (btn) btn.disabled = true;

        try {
            // Step 1 — align lyrics if missing.
            if (!setup.status.has_lyrics) {
                const ta = setupEl('lk-lyrics');
                const text = ta ? ta.value.trim() : '';
                if (!text) { showError('Paste lyrics text first.'); return; }
                showProgress('Aligning lyrics with Whisper…', 'This can take a minute on the alignment server.');
                const lang = (setupEl('lk-language') || {}).value || '';
                const granularity = setupGranularity();
                const alignRes = await safeFetch('/api/plugins/lyrics_karaoke/align', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename,
                        lyrics_text: text,
                        language: lang || undefined,
                        granularity,
                    }),
                });
                if (filename !== setup.selectedFilename) return;
                if (!alignRes.ok || !alignRes.body || !Array.isArray(alignRes.body.segments)) {
                    showError((alignRes.body && alignRes.body.error) || `Alignment failed (${alignRes.status})`);
                    return;
                }
                setup.alignmentResult = alignRes.body.segments;

                showProgress('Saving aligned lyrics…');
                const saveRes = await safeFetch('/api/plugins/lyrics_karaoke/save-lyrics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, segments: setup.alignmentResult }),
                });
                if (filename !== setup.selectedFilename) return;
                if (!saveRes.ok) {
                    showError((saveRes.body && saveRes.body.error) || `Save failed (${saveRes.status})`);
                    return;
                }
            }

            // Step 2 — extract pitch (always do this; status flag may be
            // stale after step 1 wrote new lyrics).
            showProgress('Extracting per-syllable pitch with pYIN…', 'Reading the vocals stem; ~30s for a 4-min song.');
            const pitchRes = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename }),
            });
            if (filename !== setup.selectedFilename) return;
            if (!pitchRes.ok) {
                showError((pitchRes.body && pitchRes.body.error) || `Pitch extraction failed (${pitchRes.status})`);
                return;
            }

            // Refresh status and render the done state.
            hideProgress();
            await refreshSetupStatus();
            // Also refresh the player overlay's cached status for this
            // song so the in-player toggle picks up the new pitch data
            // immediately if the user navigates straight to playback.
            if (currentSong && currentSong.filename === filename) {
                await fetchStatus(filename);
                refreshButtonState();
            }
        } catch (e) {
            showError(e && e.message ? e.message : String(e));
        } finally {
            if (btn) btn.disabled = false;
            updateBuildBtn();
        }
    }

    async function lkRedoPitch() {
        if (!setup.selectedFilename) return;
        const filename = setup.selectedFilename;
        showProgress('Re-extracting per-syllable pitch…');
        const res = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });
        if (filename !== setup.selectedFilename) return;
        if (!res.ok) {
            showError((res.body && res.body.error) || `Pitch extraction failed (${res.status})`);
            return;
        }
        hideProgress();
        await refreshSetupStatus();
        if (currentSong && currentSong.filename === filename) {
            pitchData = null;  // force the player overlay to refetch on toggle
            tokenIndexMap = new Map();
            await fetchStatus(filename);
            refreshButtonState();
        }
    }

    async function lkExport() {
        if (!setup.alignmentResult || !setup.alignmentResult.length) return;
        const res = await fetch('/api/plugins/lyrics_karaoke/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                segments: setup.alignmentResult,
                title: setup.selectedTitle,
                artist: setup.selectedArtist,
            }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const disposition = res.headers.get('Content-Disposition') || '';
        const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const legacyMatch = disposition.match(/filename="([^"]*(?:\\.[^"]*)*)"/i);
        let downloadName = 'lyrics.lrc';
        if (utf8Match) {
            try {
                downloadName = decodeURIComponent(utf8Match[1]);
            } catch {
                // Keep the default filename for a malformed header value.
            }
        } else if (legacyMatch) {
            downloadName = legacyMatch[1].replace(/\\(["\\])/g, '$1');
        }
        a.download = downloadName;
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function lkOpenInPlayer() {
        if (!setup.selectedFilename) return;
        if (typeof window.playSong === 'function') {
            window.playSong(setup.selectedFilename);
        } else if (typeof window.showScreen === 'function') {
            window.showScreen('player');
        }
    }

    // Bind input listeners after the screen is injected. The setup
    // screen's <textarea> isn't in the DOM at script-load time (it's
    // added when loadPlugins() injects the screen HTML), so attach
    // lazily on first showScreen('plugin-lyrics_karaoke').
    let setupHydrated = false;
    function hydrateSetupScreen() {
        if (setupHydrated) return;
        const ta = setupEl('lk-lyrics');
        if (!ta) return;  // screen not in DOM yet
        ta.addEventListener('input', () => { lkUpdateLineCount(); updateBuildBtn(); });
        setupHydrated = true;
    }

    function onSetupScreenShown() {
        hydrateSetupScreen();
        refreshServerStatus();
        // Don't auto-clear selection — users who drilled into a song
        // and back-buttoned to the screen expect their selection to
        // persist.
        if (setup.selectedFilename) {
            refreshSetupStatus();
        }
    }

    // Expose setup-screen API for inline onclick= handlers.
    window.lkSearchSongs = lkSearchSongs;
    window.lkSelectFromResult = lkSelectFromResult;
    window.lkClearSong = lkClearSong;
    window.lkBuild = lkBuild;
    window.lkRedoPitch = lkRedoPitch;
    window.lkExport = lkExport;
    window.lkOpenInPlayer = lkOpenInPlayer;
    window.lkFileUpload = lkFileUpload;

    // ══════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════

    function init() {
        ensureToggleButton();
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            // window.slopsmith is an EventTarget; .on() forwards to
            // addEventListener, so the handler receives a CustomEvent
            // whose `.detail` is the actual payload (the song info).
            window.slopsmith.on('song:loaded', (e) => onSongLoaded(e && e.detail));
            // Catch-up: plugin scripts load after app.js, so the very
            // first `song:loaded` may have already fired by the time
            // this listener attaches. Read the cached currentSong as a
            // fallback. Subsequent songs go through the listener.
            if (window.slopsmith.currentSong) {
                onSongLoaded(window.slopsmith.currentSong);
            }
        }
        // showScreen wrapper — clean up overlays when leaving the player,
        // and hydrate the setup screen when entering it. Keep the
        // wrapper minimal so we play nice with other plugins that also
        // hook showScreen (load order isn't deterministic).
        // Core navigates via its own imported showScreen() (session.js) and
        // never calls window.showScreen — that global is dead as far as the
        // real host's ✕/Esc exit and playSong()/navigate() paths are
        // concerned (feedBack#923/#924; see section_map's CLAUDE.md for the
        // same lesson). Track _playerScreenActive off screen:changing, not
        // screen:changed: session.js emits screen:changing synchronously at
        // the very top of showScreen ("I am leaving `from`, cancel/teardown
        // here"), while screen:changed only fires at the end, after
        // teardown awaits (e.g. desktop/JUCE's jucePlayer.stop() on exit,
        // or loadLibraryProviders() when navigating home) — late enough
        // that a generate-fetch resolving during that tail would still see
        // the flag true and reactivate karaoke after the user already left.
        const fbBus = window.feedBack || window.slopsmith;
        if (fbBus && typeof fbBus.on === 'function') {
            fbBus.on('screen:changing', (e) => {
                _playerScreenActive = !!(e && e.detail && e.detail.id === 'player');
            });
        }
        const origShowScreen = window.showScreen;
        if (typeof origShowScreen === 'function') {
            window.showScreen = function (name) {
                const ret = origShowScreen.apply(this, arguments);
                _playerScreenActive = name === 'player';
                if (name !== 'player') {
                    if (karaokeMode) setKaraokeMode(false);
                    teardownOverlay();
                    // setKaraokeMode(false) already stops the mic when
                    // karaoke was on; this catches the rare case where
                    // we leave the player while karaoke was already off
                    // but the mic somehow lingered.
                    if (micState !== 'off') { stopMic({ keepFlag: true }); resetUserResults(); }
                }
                if (name === 'plugin-lyrics_karaoke') {
                    onSetupScreenShown();
                }
                return ret;
            };
        }
    }

    // ── Visualization provider (#14) ────────────────────────────────────
    //
    // Registers this plugin as a first-class FeedBack visualization
    // provider (core's setRenderer contract), consuming the canonical
    // `/playback` payload (#13) instead of re-deriving lyrics/pitch the
    // way the legacy overlay above does. Boundaries, the minimum host
    // version, and the settings namespace are fixed by
    // docs/architecture/vocals-visualization-integration.md (#10).
    //
    // Scope note: this is the REGISTRATION + LIFECYCLE half. The ribbon
    // drawn below is deliberately the overlay's own visual language, so a
    // selected panel renders something correct today; porting Karaoke
    // Highway's visual experience (Taynavv/feedback-vocals-viz) onto it is
    // #15's job and replaces `_vizDrawFrame` wholesale.

    const VIZ_PLUGIN_ID = 'lyrics_karaoke';

    // Per-instance settings. Mirrors the manifest's
    // capabilities.visualization.settings block — the HOST owns
    // persistence (feedBack#849), we only hold the live value and the
    // declared default. Defaults come from #10's "Microphone and settings
    // ownership": the legacy overlay only ever persisted `micFeedback`, so
    // the other three start at Karaoke Highway's safe defaults rather than
    // migrating settings that never existed.
    const VIZ_SETTING_DEFAULTS = Object.freeze({
        micFeedback: true,
        tolerance: 1,
        octaveIndependent: false,
        micOffsetMs: 0,
    });

    // Live renderer instances, for ONE purpose: deciding whether the
    // provider currently owns playback (see `_vizOwnsPlayback`). Every
    // piece of actual renderer state is panel-local, held in
    // `_createVizRenderer`'s closure — a shared module global would make
    // two splitscreen panels overwrite each other.
    const _vizInstances = new Set();

    // Set when a provider instance turned the legacy overlay off, so the
    // last instance to be destroyed can hand playback back rather than
    // leaving the user's toggle stuck off.
    let _vizSuppressedKaraoke = false;

    function _vizOwnsPlayback() {
        return _vizInstances.size > 0;
    }

    // Whether note_detect's default singleton was running when we took
    // playback over, so the last instance out can hand it back.
    let _vizRestoreNoteDetect = false;

    /** Stand note_detect's default singleton down while the provider owns
     *  playback. note_detect ships the handshake for exactly this
     *  (`createNoteDetector.setDefaultSuppressed`, which also silently tears
     *  down a running session — silent so no end-of-song summary modal pops)
     *  and documents that the taking-over host captures `wantsDetect()` /
     *  `isEnabled()` first if it wants to restore later.
     *
     *  Without this, a karaoke panel and note_detect would both hold a
     *  microphone and both score, and note_detect's HUD would draw over the
     *  ribbon — the "no competing scorers" rule in
     *  docs/architecture/vocals-visualization-integration.md is a rule about
     *  the whole app, not just about this plugin's own legacy overlay.
     *
     *  Entirely feature-detected: no note_detect installed → no-op. */
    function _vizSuppressNoteDetect() {
        const factory = window.createNoteDetector;
        if (!factory || typeof factory.setDefaultSuppressed !== 'function') return;
        const singleton = window.noteDetect;
        // Own try/catch, separate from the setDefaultSuppressed() call below:
        // this probe runs AFTER this instance is already in _vizInstances and
        // the overlay/karaoke may already be disabled (_vizClaimPlaybackOwnership
        // calls this last), so a throw here must not escape init() and leave
        // ownership half-claimed with nothing to tear it back down. Default to
        // "wasn't on" on a throw — the safer failure than assuming it was.
        let wantedDetect = false;
        try {
            wantedDetect = !!(singleton
                && typeof singleton.wantsDetect === 'function'
                && singleton.wantsDetect());
        } catch (_) { /* never let a peer plugin break renderer init */ }
        _vizRestoreNoteDetect = wantedDetect;
        try {
            factory.setDefaultSuppressed(true);
        } catch (_) { /* never let a peer plugin break renderer init */ }
    }

    function _vizRestoreNoteDetectOwnership() {
        const factory = window.createNoteDetector;
        if (!factory || typeof factory.setDefaultSuppressed !== 'function') return;
        try {
            factory.setDefaultSuppressed(false);
        } catch (_) { /* noop */ }
        // Suppression only blocks future auto-enables, so a singleton the
        // user had ON has to be re-armed explicitly. Fire-and-forget:
        // enable() is async and its result isn't ours to wait on.
        if (_vizRestoreNoteDetect) {
            _vizRestoreNoteDetect = false;
            const singleton = window.noteDetect;
            if (singleton && typeof singleton.enable === 'function') {
                try { Promise.resolve(singleton.enable()).catch(() => {}); } catch (_) { /* noop */ }
            }
        }
    }

    /** Claim sole ownership of playback. Only acts on the 0 -> 1 instance
     *  transition: a second splitscreen panel joining an already-owned
     *  session has nothing left to stand down. */
    function _vizClaimPlaybackOwnership() {
        if (_vizInstances.size !== 1) return;
        if (karaokeMode) {
            _vizSuppressedKaraoke = true;
            setKaraokeMode(false);
        } else {
            teardownOverlay();
        }
        _vizSuppressNoteDetect();
    }

    /** Hand playback back once the LAST instance is gone. */
    function _vizReleasePlaybackOwnership() {
        if (_vizOwnsPlayback()) return;
        _vizRestoreNoteDetectOwnership();
        if (_vizSuppressedKaraoke) {
            _vizSuppressedKaraoke = false;
            if (_playerScreenActive) setKaraokeMode(true);
        }
    }

    /** Auto-mode predicate. Declared as a static on the factory (not the
     *  instance) so core can evaluate it without constructing a throwaway
     *  renderer. Kept deliberately narrow — core takes the FIRST matching
     *  factory in picker order, so a loose predicate steals songs from
     *  more specialized viz. */
    function _vizMatchesArrangement(songInfo) {
        const name = (songInfo && songInfo.arrangement) || '';
        return /vocal/i.test(String(name));
    }

    /** core hands non-integer arrangement_index as `null`/absent for
     *  arrangement-agnostic content; anything else is coerced to null too
     *  rather than trusted verbatim. Shared by `_vizSongKey` (song-switch
     *  detection) and `load()` (the `/playback?arrangement=` query param). */
    function _vizArrangementIndex(songInfo) {
        return (songInfo && Number.isInteger(songInfo.arrangement_index))
            ? songInfo.arrangement_index
            : null;
    }

    /** Identity of the (song, arrangement) pair a payload was loaded for.
     *  Used to notice a song switch or an in-place arrangement change
     *  without re-fetching on every frame. */
    function _vizSongKey(songInfo) {
        if (!songInfo || !songInfo.filename) return null;
        const idx = _vizArrangementIndex(songInfo);
        return `${songInfo.filename}#${idx === null ? '' : idx}`;
    }

/** Every voice in a `/playback` payload, normalized, dropping any that
     *  carry no usable tokens. Multi-voice payloads are RENDERED here (the
     *  scored voice as slabs, the rest as guide bars) — but nothing on this
     *  path invents them: `/playback` builds `voices[]` from the singular
     *  spec'd `lyrics`/`vocal_pitch` keys and today always returns exactly
     *  one. Duet INGESTION stays FEP-gated (#13/#16); this deliberately
     *  does not read `vocal_tracks` or any other non-spec content path.
     *  Exercised by synthetic multi-voice payloads in the tests. */
    function _vizNormalizeVoices(payload) {
        const raw = (payload && Array.isArray(payload.voices)) ? payload.voices : [];
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const v = raw[i];
            const tokens = _vizNormalizeTokens(v);
            if (!tokens.length) continue;
            out.push({
                id: String((v && v.id) || ('v' + (i + 1))),
                name: (v && typeof v.name === 'string' && v.name) ? v.name : null,
                primary: !!(v && v.primary),
                tokens,
            });
        }
        if (out.length && !out.some((v) => v.primary)) out[0].primary = true;
        return out;
    }

    /** Which voice this panel scores and draws as slabs. Prefers the
     *  `primary` one; per-panel singer selection is #16. */
    function _vizScoredIndex(voices) {
        if (!voices || !voices.length) return -1;
        const p = voices.findIndex((v) => v.primary);
        return p >= 0 ? p : 0;
    }

    /** Normalize a voice's tokens into the shape the renderers want.
     *  The route already sorts and sanitizes (#13), so this only drops
     *  anything structurally unusable and coerces `midi` to a number or
     *  null — it must never re-implement the token contract. */
    function _vizNormalizeTokens(voice) {
        const raw = (voice && Array.isArray(voice.tokens)) ? voice.tokens : [];
        const out = [];
        for (const tok of raw) {
            if (!tok || typeof tok.start !== 'number' || !isFinite(tok.start)) continue;
            const dur = (typeof tok.duration === 'number' && isFinite(tok.duration) && tok.duration >= 0)
                ? tok.duration
                : 0;
            out.push({
                start: tok.start,
                duration: dur,
                text: typeof tok.text === 'string' ? tok.text : '',
                midi: (typeof tok.midi === 'number' && isFinite(tok.midi)) ? tok.midi : null,
            });
        }
        return out;
    }

    /** Song-wide pitch window, computed ONCE per load so bars don't drift
     *  vertically as the visible window scrolls. Shares its percentile math
     *  with `computeSongPitchRange` via `_percentilePitchRange`; unlike that
     *  legacy caller, a null return here IS load-bearing — it's the signal
     *  `draw` uses to fall back to the flat ribbon (#10). */
    function _vizPitchRange(tokens) {
        const midis = [];
        for (const tok of tokens) {
            if (tok.midi !== null) midis.push(tok.midi);
        }
        return _percentilePitchRange(midis);
    }

    /** Lower bound on `start` over a start-sorted token array — the index
     *  of the first token with `start >= t`. Core exposes `bundle.lowerBoundT`
     *  for its own `.t`-keyed chart arrays; the canonical payload keys on
     *  `.start`, so the provider carries its own. Used to cull to the
     *  visible window instead of full-scanning the song every frame (see
     *  feedBack's CLAUDE.md performance rules). */
    function _vizLowerBound(tokens, t) {
        let lo = 0;
        let hi = tokens.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tokens[mid].start < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** Longest token duration in the song, computed ONCE per load. The
     *  draw loop needs it as a lookbehind so a held note that started
     *  before the visible window still gets drawn. */
    function _vizMaxDuration(tokens) {
        let max = 0;
        for (const tok of tokens) {
            if (tok.duration > max) max = tok.duration;
        }
        return max;
    }

    /** Longest token duration across EVERY voice, not just the scored one.
     *  The stage shares one lookbehind between the scored voice's slabs and
     *  every guide voice's bars — computing it from the scored voice alone
     *  would let a longer-held guide note fall outside the lower-bound
     *  search window and vanish mid-sustain. */
    function _vizMaxDurationAcrossVoices(voices) {
        let max = 0;
        for (const v of (voices || [])) {
            const d = _vizMaxDuration(v.tokens || []);
            if (d > max) max = d;
        }
        return max;
    }

    function _vizEmit(name, detail) {
        const bus = window.feedBack || window.slopsmith;
        if (!bus || typeof bus.emit !== 'function') return;
        try {
            bus.emit(name, Object.assign({ pluginId: VIZ_PLUGIN_ID }, detail));
        } catch (_) { /* a listener throwing must not break the renderer */ }
    }

    /** Placeholder visual — #15 replaces this with the ported Karaoke
     *  Highway renderer. Pure function of its arguments so it stays
     *  panel-local and unit-testable, and does NO DOM work: it runs on
     *  core's per-frame path (see the performance rules in feedBack's
     *  CLAUDE.md). */
    function _vizDrawFrame(ctx2d, W, H, tokens, now, range, maxDuration) {
        ctx2d.clearRect(0, 0, W, H);
        ctx2d.fillStyle = RIBBON_BG;
        ctx2d.fillRect(0, 0, W, H);

        const winLeft = now - PLAYHEAD_FRAC * VISIBLE_SECONDS;
        const winRight = now + (1 - PLAYHEAD_FRAC) * VISIBLE_SECONDS;
        const span = winRight - winLeft;
        const xOf = (t) => ((t - winLeft) / span) * W;

        const lo = range ? range.lo : 60;
        const hi = range ? range.hi : 60 + MIN_PITCH_SPAN_SEMITONES;
        const yOf = (midi) => H - ((midi - lo) / Math.max(1, hi - lo)) * (H * 0.7) - H * 0.15;

        // Windowed iteration: cull to the visible span rather than walking
        // the whole song every frame. Sustains can start before the window,
        // so back the cursor up by the longest token seen so far — a fixed
        // lookbehind would silently drop a long held note whose `start` sits
        // further back than the guess.
        const lookbehind = (typeof maxDuration === 'number' && maxDuration > 0) ? maxDuration : 0;
        let i = _vizLowerBound(tokens, winLeft - lookbehind - 0.5);
        for (; i < tokens.length; i++) {
            const tok = tokens[i];
            // Sorted by `start`, so nothing past the right edge can match.
            if (tok.start > winRight + 0.5) break;
            const t1 = tok.start + tok.duration;
            if (t1 < winLeft - 0.5) continue;
            const x0 = xOf(tok.start);
            const x1 = Math.max(x0 + 2, xOf(t1));
            const active = now >= tok.start && now <= t1;
            if (tok.midi !== null) {
                const y = yOf(tok.midi);
                ctx2d.fillStyle = active ? BAR_COLOR_ACTIVE
                    : (now > t1 ? BAR_COLOR_FILL : BAR_COLOR_DIM);
                ctx2d.fillRect(x0, y - BAR_PAD_PX, x1 - x0, Math.max(3, H * 0.04));
            }
            if (tok.text) {
                ctx2d.fillStyle = now > t1 ? TEXT_COLOR_PAST : TEXT_COLOR;
                ctx2d.fillText(tok.text, x0, H - 6);
            }
        }

        ctx2d.fillStyle = PLAYHEAD_COLOR;
        ctx2d.fillRect(Math.round(W * PLAYHEAD_FRAC), 0, 2, H);
    }

    // ── Perspective highway renderer (#15 phase 1) ──────────────────────
    //
    // PROVENANCE: the stage geometry, diatonic (piano-key) pitch axis,
    // violet note-slab ramp, horizon seam, duet guide-bar treatment and
    // lyric-band layout below are adapted from Karaoke Highway
    // (https://github.com/Taynavv/feedback-vocals-viz, `screen.js`,
    // AGPL-3.0) — the reference implementation this epic absorbs (#18).
    // That plugin in turn adapted its ribbon geometry, pitch-range logic
    // and palette from THIS plugin's overlay, so both directions of the
    // port stay AGPL-3.0; see the epic and
    // docs/architecture/vocals-visualization-integration.md.
    //
    // Adapted rather than copied: the reference reads its own
    // `{t, d, w, midi}` route shape, while this consumes the canonical
    // `/playback` `{start, duration, text, midi}` tokens (#13), and the
    // scoring-dependent layers it interleaves (accuracy tint on the sung
    // portion, the sung-pitch trace, the top stats band) are deliberately
    // NOT ported here — they belong with the microphone consolidation in
    // #11. The band they occupy is still reserved so #11 drops in without
    // re-tuning the stage.

    // Violet note ramp — the lit-slab look. Deliberately outside the
    // red/amber/green accuracy family and the cool duet-guide hues.
    const STAGE_NOTE_TOP = '#f0e7ff';
    const STAGE_NOTE_MID = '#c084fc';
    const STAGE_NOTE_DEEP = '#7c3aed';
    const STAGE_NOTE_LOW = '#5b21b6';
    const STAGE_WALL_TOP = '#0a0b14';
    const STAGE_WALL_BOTTOM = '#0d1120';
    const STAGE_LANE = 'rgba(255,255,255,0.05)';
    const STAGE_LANE_LABEL = 'rgba(160,170,200,0.4)';
    const STAGE_PLAYHEAD = 'rgba(56,189,248,0.95)';
    const STAGE_LYRIC_SECONDARY = 'rgba(150,160,190,0.55)';

    // Duet guide colours. Guides are SECONDARY by construction: flat, thin,
    // cool, dim, no gradient/gloss/glow — those are reserved for the scored
    // voice. They mark where another part goes for timing, and must never
    // compete for attention.
    const STAGE_VOICE_COLORS = [
        'rgba(34,211,238,0.34)',   // teal — 2nd voice
        'rgba(244,114,182,0.34)',  // pink — 3rd
        'rgba(163,230,53,0.34)',   // lime — 4th
    ];

    const STAGE_SEAM_FRAC = 0.82;      // wall base / horizon; lyrics below
    const STAGE_PLAYHEAD_FRAC = 0.30;  // further right than the flat ribbon
    const STAGE_REF_HEIGHT = 480;      // `u` scale unit reference height

    // Diatonic axis: naturals evenly spaced (one row per white key), sharps
    // halfway between, so the pitch axis reads like piano keys rather than
    // raw semitone spacing.
    const SEMI_TO_DIA = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
    const NATURAL_PCS = [0, 2, 4, 5, 7, 9, 11];
    function _vizIsNatural(midi) {
        return NATURAL_PCS.indexOf((((Math.round(midi)) % 12) + 12) % 12) >= 0;
    }

    function _vizDiaPos(midi) {
        const r = Math.round(midi);
        return Math.floor(r / 12) * 7 + SEMI_TO_DIA[((r % 12) + 12) % 12];
    }

    // Delegates to the legacy overlay's midiToName/_LK_PITCH_NAMES — same
    // round -> pitch-class -> octave math, one pitch-name table to keep in
    // sync rather than two.
    function _vizMidiToName(midi) {
        return midiToName(midi);
    }

    /** Diatonic range over every pitched token, widened so the wall fills
     *  its height. Returns null for lyrics-only content — which is the
     *  signal `draw` uses to fall back to the flat ribbon, exactly as the
     *  reference does (its `_range` check). */
    function _vizDiatonicRange(tokens) {
        if (!Array.isArray(tokens)) return null;
        let lo = Infinity;
        let hi = -Infinity;
        for (const tok of tokens) {
            if (tok && typeof tok.midi === 'number') {
                if (tok.midi < lo) lo = tok.midi;
                if (tok.midi > hi) hi = tok.midi;
            }
        }
        if (!isFinite(lo)) return null;
        lo = Math.round(lo);
        hi = Math.round(hi);
        // Widen to at least 5 diatonic steps so a one-note melody still
        // sits mid-wall. Guarded against a pathological non-terminating
        // widen the same way the reference guards it.
        let guard = 0;
        while (_vizDiaPos(hi) - _vizDiaPos(lo) < 5 && guard++ < 24) {
            hi += 1;
            if (_vizDiaPos(hi) - _vizDiaPos(lo) < 5) lo -= 1;
        }
        return {
            midiLo: lo,
            midiHi: hi,
            dLo: _vizDiaPos(lo),
            dHi: _vizDiaPos(hi),
        };
    }

    /** One axis spanning EVERY voice, so a duet's guide bars land on the
     *  same lanes as the scored voice instead of each voice being
     *  auto-ranged independently. Equals `_vizDiatonicRange` for a solo. */
    function _vizSharedDiatonicRange(voices) {
        let all = [];
        for (const v of (voices || [])) all = all.concat(v.tokens || []);
        return _vizDiatonicRange(all);
    }

    // Delegates to the legacy overlay's roundFillRect — same rounded-rect
    // fill primitive (roundFillRect also floors the radius at 0, a shade
    // more defensive than this file's own prior arcTo-based version).
    function _vizRoundRect(ctx2d, x, y, w, h, r) {
        roundFillRect(ctx2d, x, y, w, h, r);
    }

    /** The horizon seam where the note wall meets its base. The reference
     *  retired a receding floor grid in favour of this seam to reclaim
     *  vertical space; keeping the seam keeps the depth read without
     *  reprojecting notes. */
    function _vizDrawSeam(ctx2d, w, seamY, u) {
        const hg = ctx2d.createLinearGradient(0, seamY - 14 * u, 0, seamY + 14 * u);
        hg.addColorStop(0, 'rgba(150,180,255,0)');
        hg.addColorStop(0.5, 'rgba(150,180,255,0.30)');
        hg.addColorStop(1, 'rgba(150,180,255,0)');
        ctx2d.fillStyle = hg;
        ctx2d.fillRect(0, seamY - 14 * u, w, 28 * u);
        const lip = ctx2d.createLinearGradient(0, seamY, 0, seamY + 44 * u);
        lip.addColorStop(0, 'rgba(40,60,140,0.10)');
        lip.addColorStop(1, 'rgba(5,6,12,0)');
        ctx2d.fillStyle = lip;
        ctx2d.fillRect(0, seamY, w, 44 * u);
        ctx2d.strokeStyle = 'rgba(200,220,255,0.6)';
        ctx2d.lineWidth = Math.max(1, 1.5 * u);
        ctx2d.beginPath();
        ctx2d.moveTo(0, seamY);
        ctx2d.lineTo(w, seamY);
        ctx2d.stroke();
    }

    /** Group tokens into lyric lines. A `+` suffix on a syllable is an
     *  explicit line break (the WebSocket lyrics contract); charts without
     *  any breaks fall back to splitting on a >1.2s gap. */
    function _vizBuildLines(tokens) {
        const hasBreaks = tokens.some((tok) => String(tok.text || '').endsWith('+'));
        const groups = [];
        let cur = [];
        let lastEnd = -Infinity;
        for (let i = 0; i < tokens.length; i++) {
            const raw = String(tokens[i].text || '');
            if (cur.length && !hasBreaks && tokens[i].start - lastEnd > 1.2) {
                groups.push(cur);
                cur = [];
            }
            cur.push(i);
            lastEnd = tokens[i].start + (tokens[i].duration || 0);
            if (raw.endsWith('+')) {
                groups.push(cur);
                cur = [];
            }
        }
        if (cur.length) groups.push(cur);
        return groups.map((idxs) => {
            const last = tokens[idxs[idxs.length - 1]];
            return {
                t0: tokens[idxs[0]].start,
                t1: last.start + (last.duration || 0),
                parts: idxs.map((i) => {
                    const raw = String(tokens[i].text || '');
                    return { idx: i, text: stripSyllableMarker(raw), join: raw.endsWith('-') };
                }),
            };
        });
    }

    /** One centred lyric line, per-syllable coloured against `now`:
     *  sung = gold, active = white, upcoming = dim. Shrinks to fit rather
     *  than overflowing the stage. */
    function _vizDrawLyricLine(ctx2d, tokens, line, now, areaX, areaW, fontPx, y, primary) {
        const maxW = areaW * 0.96;
        const weight = primary ? 'bold ' : '';
        let font = fontPx;
        const piece = (part, p) => part.text
            + (part.join || p === line.parts.length - 1 ? '' : ' ');
        const measure = () => {
            let total = 0;
            for (let p = 0; p < line.parts.length; p++) {
                total += ctx2d.measureText(piece(line.parts[p], p)).width;
            }
            return total;
        };
        ctx2d.font = weight + font + 'px sans-serif';
        let total = measure();
        if (total > maxW && total > 0) {
            font = Math.max(11, Math.floor(font * (maxW / total)));
            ctx2d.font = weight + font + 'px sans-serif';
            total = measure();
        }
        ctx2d.textAlign = 'left';
        ctx2d.textBaseline = 'middle';
        let x = areaX + (areaW - total) / 2;
        for (let p = 0; p < line.parts.length; p++) {
            const part = line.parts[p];
            const tok = tokens[part.idx];
            const text = piece(part, p);
            if (!primary) {
                ctx2d.fillStyle = STAGE_LYRIC_SECONDARY;
            } else if (tok.start + (tok.duration || 0) <= now) {
                ctx2d.fillStyle = BAR_COLOR_FILL;      // sung
            } else if (tok.start <= now) {
                ctx2d.fillStyle = '#ffffff';           // active syllable
            } else {
                ctx2d.fillStyle = TEXT_COLOR_PAST;     // upcoming
            }
            ctx2d.fillText(text, x, y);
            x += ctx2d.measureText(text).width;
        }
    }

    /** The lyric band below the seam: the current line plus a dim preview
     *  of the next. The bouncing ball and the silent-lead-in countdown that
     *  ride under these words are #15 phase 2. */
    // First line index NOT yet finished (plus a 0.3s hold so the last
    // syllable doesn't vanish the instant it's sung) — i.e. the first
    // `lines[i].t1 > now - 0.3`. `lines` is sorted by t1 (built sequentially
    // from time-sorted tokens), so this is a binary search rather than the
    // linear rescan-from-0 a naive port of the reference would run every
    // frame for the whole song.
    function _vizActiveLyricLineIndex(lines, now) {
        // Same comparison FORM as the linear scan it replaces (`now >=
        // t1 + 0.3`, not an algebraically-equivalent `now - 0.3 >= t1`) so
        // this is bit-identical at floating-point boundaries, not merely
        // equivalent in exact arithmetic.
        let lo = 0;
        let hi = lines.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (now >= lines[mid].t1 + 0.3) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function _vizDrawLyricBand(ctx2d, tokens, lines, now, railW, W, H, seamY, u) {
        if (!lines || !lines.length) return;
        const li = _vizActiveLyricLineIndex(lines, now);
        if (li >= lines.length) return;
        const cy = seamY + (H - seamY) * 0.20;
        const fontPx = Math.max(16, Math.round(Math.min(36 * u, 44)));
        const areaX = railW;
        const areaW = W - railW;
        _vizDrawLyricLine(ctx2d, tokens, lines[li], now, areaX, areaW, fontPx, cy, true);
        if (li + 1 < lines.length) {
            _vizDrawLyricLine(ctx2d, tokens, lines[li + 1], now, areaX, areaW,
                Math.max(12, Math.round(fontPx * 0.55)), cy + fontPx * 1.4, false);
        }
    }

    /** The perspective stage: note wall, diatonic lanes, horizon seam,
     *  duet guide bars, violet note slabs, playhead, lyric band.
     *
     *  Pure in its inputs (no DOM reads, no module state) so it stays
     *  per-panel and unit-testable, and windowed per frame — `tokens` is
     *  start-sorted, so each voice is entered at a lower bound and left on
     *  the first token past the right edge. `lookbehind` is the song's
     *  longest token so a note held across the window's left edge still
     *  draws. */
    function _vizDrawStage(ctx2d, W, H, view, now) {
        const range = view.range;
        const voices = view.voices;
        const tokens = view.tokens;
        const u = H / STAGE_REF_HEIGHT;

        const wallTop = 8 * u;
        // Reserved for the score / streak / accuracy band (#11). Kept at the
        // reference's height so adding it later doesn't move the notes.
        const topStatsH = 42 * u;
        const seamY = Math.round(H * STAGE_SEAM_FRAC);
        // Narrow rail: the key-rail gauge and voice-technique panel that
        // widen this are #15 phase 3.
        const railW = Math.round(10 * u);
        const noteTop = wallTop + topStatsH;
        const noteBottom = seamY;

        const dLo = range.dLo;
        const dHi = range.dHi;
        const dSpan = Math.max(1, dHi - dLo);
        const usable = noteBottom - noteTop;
        const barH = Math.max(8, Math.min((usable / dSpan) * 0.86, 40 * u));
        const pxPerSec = W / VISIBLE_SECONDS;
        const playheadX = railW + (W - railW) * STAGE_PLAYHEAD_FRAC;
        const xFor = (t) => playheadX + (t - now) * pxPerSec;
        const yFor = (m) => noteTop + ((dHi - _vizDiaPos(m)) / dSpan) * (usable - barH);
        const lookbehind = view.maxDuration > 0 ? view.maxDuration : 0;
        const tMin = now - STAGE_PLAYHEAD_FRAC * VISIBLE_SECONDS - 1;
        const tMax = now + (1 - STAGE_PLAYHEAD_FRAC) * VISIBLE_SECONDS + 1;
        const windowStart = tMin - lookbehind;

        ctx2d.clearRect(0, 0, W, H);
        ctx2d.save();
        ctx2d.beginPath();
        ctx2d.rect(0, 0, W, H);
        ctx2d.clip();

        // ── Wall backdrop + natural pitch lanes ──
        const wg = ctx2d.createLinearGradient(0, 0, 0, seamY);
        wg.addColorStop(0, STAGE_WALL_TOP);
        wg.addColorStop(1, STAGE_WALL_BOTTOM);
        ctx2d.fillStyle = wg;
        ctx2d.fillRect(0, 0, W, seamY);
        ctx2d.lineWidth = 1;
        ctx2d.font = Math.max(8, Math.round(9 * u)) + 'px sans-serif';
        ctx2d.textAlign = 'left';
        ctx2d.textBaseline = 'middle';
        for (let m = range.midiLo; m <= range.midiHi; m++) {
            if (!_vizIsNatural(m)) continue;
            const y = yFor(m) + barH / 2;
            ctx2d.strokeStyle = STAGE_LANE;
            ctx2d.beginPath();
            ctx2d.moveTo(railW, y);
            ctx2d.lineTo(W, y);
            ctx2d.stroke();
            ctx2d.fillStyle = STAGE_LANE_LABEL;
            ctx2d.fillText(_vizMidiToName(m), railW + 5 * u, y);
        }

        _vizDrawSeam(ctx2d, W, seamY, u);

        const pad = 2 * u;
        const radius = 6 * u;

        // ── Duet guides: every voice EXCEPT the scored one ──
        if (voices.length > 1) {
            const guideH = Math.max(3, barH * 0.4);
            const guideR = Math.min(radius, guideH / 2);
            for (let vi = 0; vi < voices.length; vi++) {
                if (vi === view.scoredIdx) continue;
                const vt = voices[vi].tokens;
                // Index the palette by position among the GUIDES, so the
                // first guide is always teal whichever voice is scored.
                const ci = (vi > view.scoredIdx ? vi - 1 : vi) % STAGE_VOICE_COLORS.length;
                ctx2d.fillStyle = STAGE_VOICE_COLORS[ci];
                let gi = _vizLowerBound(vt, windowStart);
                for (; gi < vt.length; gi++) {
                    const gt = vt[gi];
                    if (gt.start > tMax) break;
                    if (gt.midi === null) continue;
                    if (gt.start + gt.duration < tMin) continue;
                    const gx0 = xFor(gt.start);
                    const gw = Math.max(2, xFor(gt.start + gt.duration) - gx0 - 2 * pad);
                    const gy = yFor(gt.midi) + (barH - guideH) / 2;
                    _vizRoundRect(ctx2d, gx0 + pad, gy, gw, guideH, guideR);
                }
            }
        }

        // ── Scored voice: violet lit slabs ──
        let i = _vizLowerBound(tokens, windowStart);
        for (; i < tokens.length; i++) {
            const tok = tokens[i];
            if (tok.start > tMax) break;
            if (tok.midi === null) continue;
            const end = tok.start + tok.duration;
            if (end < tMin) continue;

            const x0 = xFor(tok.start);
            const x = x0 + pad;
            const w = Math.max(2, xFor(end) - x0 - 2 * pad);
            const y = yFor(tok.midi);
            const isPast = end <= now;
            const isActive = tok.start <= now && now < end;

            const g = ctx2d.createLinearGradient(0, y, 0, y + barH);
            if (isActive) {
                g.addColorStop(0, STAGE_NOTE_TOP);
                g.addColorStop(1, STAGE_NOTE_DEEP);
                ctx2d.shadowColor = STAGE_NOTE_MID;
                ctx2d.shadowBlur = 22 * u;
            } else if (isPast) {
                g.addColorStop(0, STAGE_NOTE_MID);
                g.addColorStop(1, STAGE_NOTE_LOW);
            } else {
                g.addColorStop(0, 'rgba(168,85,247,0.6)');
                g.addColorStop(1, 'rgba(109,40,217,0.5)');
            }
            ctx2d.fillStyle = g;
            _vizRoundRect(ctx2d, x, y, w, barH, radius);
            ctx2d.shadowBlur = 0;

            // The accuracy tint over the sung portion of the slab is #11's —
            // it needs scored results, and it draws between the slab and
            // this gloss so the sung part reads lit rather than flat.

            ctx2d.fillStyle = isActive ? 'rgba(255,255,255,0.85)' : 'rgba(235,230,255,0.30)';
            _vizRoundRect(ctx2d, x + 2 * u, y + 1.5 * u,
                Math.max(1, w - 4 * u), 2.5 * u, 1.5 * u);
        }

        // The sung-pitch history trace belongs here, under the playhead (#11).

        ctx2d.strokeStyle = STAGE_PLAYHEAD;
        ctx2d.lineWidth = Math.max(1.5, 2 * u);
        ctx2d.beginPath();
        ctx2d.moveTo(playheadX, noteTop - 6 * u);
        ctx2d.lineTo(playheadX, seamY);
        ctx2d.stroke();

        _vizDrawLyricBand(ctx2d, tokens, view.lines, now, railW, W, H, seamY, u);

        ctx2d.restore();
    }

    /** One renderer instance. A FRESH object per factory call — splitscreen
     *  mounts one per panel and each must be independent (core's
     *  setRenderer contract). Every mutable field lives in this closure. */
    function _createVizRenderer() {
        let ctx2d = null;
        let initialized = false;
        let destroyed = false;
        let tokens = [];          // the SCORED voice's tokens
        let voices = [];          // every voice, for duet guide bars
        let scoredIdx = -1;
        let stageRange = null;    // diatonic axis, shared across voices
        let lines = null;         // lyric lines, built once per load
        let maxDuration = 0;
        let loadedKey = null;      // key we have data for
        let requestedKey = null;   // key a load is in flight for
        // Key whose load already failed. Without this, `draw` — which
        // notices "no data for this song yet" every frame — would re-fire
        // the fetch 60x/s for the whole time a user sits on a song with no
        // lyrics (a 404 is the NORMAL state for an unprepared song, not an
        // exception). One attempt per key per init: a transient failure is
        // retried when the renderer is re-init'd (song switch, panel
        // re-mount, re-selecting the viz), not by spinning.
        let failedKey = null;
        let loadSeq = 0;           // monotonic; stale responses drop themselves
        let abortCtl = null;
        const settings = Object.assign({}, VIZ_SETTING_DEFAULTS);

        function abortInflight() {
            if (abortCtl) {
                try { abortCtl.abort(); } catch (_) { /* noop */ }
                abortCtl = null;
            }
            requestedKey = null;
        }

        function clearData() {
            tokens = [];
            voices = [];
            scoredIdx = -1;
            stageRange = null;
            lines = null;
            maxDuration = 0;
            loadedKey = null;
        }

        function resetLoadState() {
            clearData();
            failedKey = null;
        }

        /** Fire-and-forget load. Deliberately NOT awaited by `draw` — a
         *  per-frame path must never block on a fetch, and a continuation
         *  that resolves after a song switch (or after destroy) has to drop
         *  its own result rather than paint stale data. Both are handled by
         *  the `loadSeq` token plus the `destroyed` check. */
        function load(songInfo) {
            const key = _vizSongKey(songInfo);
            if (!key) return;
            if (key === loadedKey || key === requestedKey || key === failedKey) return;
            abortInflight();
            const seq = ++loadSeq;
            requestedKey = key;
            const filename = songInfo.filename;
            const arrIndex = _vizArrangementIndex(songInfo);
            let url = `/api/plugins/${VIZ_PLUGIN_ID}/playback?filename=${encodeURIComponent(filename)}`;
            if (arrIndex !== null) url += `&arrangement=${arrIndex}`;
            abortCtl = (typeof AbortController === 'function') ? new AbortController() : null;
            const opts = abortCtl ? { signal: abortCtl.signal } : undefined;

            safeFetch(url, opts).then((res) => {
                if (destroyed || seq !== loadSeq) return;
                abortCtl = null;
                requestedKey = null;
                if (!res.ok) {
                    clearData();
                    failedKey = key;
                    _vizEmit('lyrics_karaoke:renderer-failed', {
                        reason: 'playback-unavailable',
                        filename,
                        arrangementIndex: arrIndex,
                        status: res.status,
                        message: (res.body && res.body.error) || `HTTP ${res.status}`,
                    });
                    return;
                }
                voices = _vizNormalizeVoices(res.body);
                scoredIdx = _vizScoredIndex(voices);
                tokens = scoredIdx >= 0 ? voices[scoredIdx].tokens : [];
                // One axis across every voice so a duet's guides share lanes
                // with the scored voice instead of each being auto-ranged.
                stageRange = voices.length > 1
                    ? _vizSharedDiatonicRange(voices)
                    : _vizDiatonicRange(tokens);
                lines = _vizBuildLines(tokens);
                maxDuration = _vizMaxDurationAcrossVoices(voices);
                loadedKey = key;
                _vizEmit('lyrics_karaoke:renderer-ready', {
                    filename,
                    arrangementIndex: arrIndex,
                    schemaVersion: (res.body && res.body.schema_version) || null,
                    voiceId: scoredIdx >= 0 ? voices[scoredIdx].id : null,
                    voices: (res.body && Array.isArray(res.body.voices)) ? res.body.voices.length : 0,
                    tokens: tokens.length,
                    pitched: stageRange !== null,
                });
            }).catch((err) => {
                if (destroyed || seq !== loadSeq) return;
                abortCtl = null;
                requestedKey = null;
                // An abort is our own teardown/song-switch, not a failure.
                if (err && err.name === 'AbortError') return;
                clearData();
                failedKey = key;
                _vizEmit('lyrics_karaoke:renderer-failed', {
                    reason: 'playback-fetch-error',
                    filename,
                    arrangementIndex: arrIndex,
                    message: (err && err.message) || String(err),
                });
            });
        }

        return {
            // Read by core BEFORE init() so it can swap the underlying
            // <canvas> when the previous renderer held a different type.
            contextType: '2d',

            init(canvas, bundle) {
                // Re-init resets this panel's load, but must NOT release and
                // re-claim shared playback ownership while it stays live:
                // that would momentarily restore the legacy overlay and
                // note_detect (and could start a second microphone session).
                abortInflight();
                loadSeq++;
                destroyed = false;
                ctx2d = null;
                resetLoadState();

                if (!canvas || typeof canvas.getContext !== 'function') {
                    this.destroy();
                    _vizEmit('lyrics_karaoke:renderer-failed', {
                        reason: 'no-canvas',
                        message: 'Host provided no usable canvas element; '
                            + 'falling back to the legacy karaoke overlay.',
                    });
                    return;
                }
                try {
                    ctx2d = canvas.getContext('2d');
                } catch (_) {
                    // A canvas already locked to another context type
                    // (webgl2) throws or returns null here.
                    ctx2d = null;
                }
                if (!ctx2d) {
                    this.destroy();
                    _vizEmit('lyrics_karaoke:renderer-failed', {
                        reason: 'no-2d-context',
                        message: 'Could not acquire a 2d context on the highway canvas.',
                    });
                    return;
                }

                if (!initialized) {
                    initialized = true;
                    _vizInstances.add(this);
                    // Exactly one owner of playback at a time (#10) —
                    // covering the legacy overlay and note_detect.
                    _vizClaimPlaybackOwnership();
                }

                if (bundle && bundle.songInfo) load(bundle.songInfo);
            },

            draw(bundle) {
                if (destroyed || !ctx2d || !bundle) return;
                // Song/arrangement switch: notice it here (core hands the
                // live songInfo every frame) and kick a non-blocking load.
                const key = _vizSongKey(bundle.songInfo);
                if (key && key !== loadedKey) {
                    if (loadedKey !== null) clearData();
                    load(bundle.songInfo);
                }
                const now = (typeof bundle.currentTime === 'number') ? bundle.currentTime : 0;
                const W = ctx2d.canvas ? ctx2d.canvas.width : 0;
                const H = ctx2d.canvas ? ctx2d.canvas.height : 0;
                if (!W || !H) return;
                // The stage is the only offered look; a lyrics-only song has
                // no pitch axis to place notes on, so it falls back to the
                // flat ribbon silently — not a user-facing mode toggle.
                // Mirrors the reference's `this._range` check.
                if (stageRange) {
                    _vizDrawStage(ctx2d, W, H, {
                        range: stageRange,
                        voices,
                        scoredIdx,
                        tokens,
                        lines,
                        maxDuration,
                    }, now);
                    return;
                }
                // _vizDrawFrame's `range` param is null here by construction —
                // this branch only runs when stageRange is falsy, and for every
                // voices[] shape /playback can produce today that means the
                // scored voice has no pitch either (see the comment on
                // stageRange's computation above). _vizDrawFrame itself keeps
                // its general range parameter — it's a real, independently
                // tested contract, just never fed a non-null value from here.
                _vizDrawFrame(ctx2d, W, H, tokens, now, null, maxDuration);
            },

            resize(_w, _h) {
                // Core has already applied the backing-store dimensions and
                // `draw` reads them off the canvas each frame, so there is
                // nothing cached to invalidate. Declared so the contract is
                // explicit rather than relying on the optional-method path.
            },

            destroy() {
                // Flip `destroyed` FIRST: an in-flight fetch continuation or
                // a stray draw must see a torn-down instance even if the
                // abort below is unavailable (no AbortController).
                const wasInitialized = initialized;
                destroyed = true;
                initialized = false;
                abortInflight();
                loadSeq++;
                resetLoadState();
                ctx2d = null;
                _vizInstances.delete(this);
                // Last one out hands playback back to whoever we displaced.
                if (wasInitialized) _vizReleasePlaybackOwnership();
            },

            // Per-instance settings (feedBack#849). The host renders these
            // from the manifest and owns persistence; `applySetting` is
            // REQUIRED of any provider that declares a settings list.
            applySetting(key, value) {
                if (!Object.prototype.hasOwnProperty.call(VIZ_SETTING_DEFAULTS, key)) return false;
                settings[key] = value;
                return true;
            },

            getSetting(key) {
                return Object.prototype.hasOwnProperty.call(settings, key)
                    ? settings[key]
                    : undefined;
            },
        };
    }

    /** Publish the factory. Idempotent: the Host may re-execute screen.js
     *  on plugin reload, and a second registration would hand core a
     *  factory closing over a different `_vizInstances`, splitting the
     *  playback-ownership bookkeeping in two.
     *
     *  Registration is unconditional by design — that IS the safe
     *  degradation path for a host below the minimum version (#10:
     *  0.3.0-alpha.1). An older host simply never reads
     *  `window.feedBackViz_*`, so the global is inert and the legacy
     *  overlay keeps owning playback; probing for `setRenderer` here would
     *  be worse, since `window.highway` need not exist yet at script-load
     *  time. An instance that is nonetheless handed an unusable canvas
     *  fails loudly via `renderer-failed` instead of throwing. */
    function _registerVizProvider() {
        const KEY = '__feedBackLyricsKaraokeVizRegistered';
        if (window[KEY]) return false;
        window[KEY] = true;
        const factory = function () { return _createVizRenderer(); };
        factory.matchesArrangement = _vizMatchesArrangement;
        // Also exposed as a static so core can read it before constructing
        // a renderer (used by Auto-mode evaluation).
        factory.contextType = '2d';
        window.feedBackViz_lyrics_karaoke = factory;
        // Legacy alias: splitscreen's VIZ_FACTORY_PREFIXES checks
        // `feedBackViz_` first and falls back to `slopsmithViz_`. Keep both
        // in sync if this is ever renamed.
        window.slopsmithViz_lyrics_karaoke = factory;
        return true;
    }

    // The Host may re-execute screen.js on plugin reload, which re-runs this
    // IIFE and would call init() a second time — adding a second
    // 'song:loaded' subscription (so onSongLoaded fires twice per song) and
    // wrapping window.showScreen around the already-wrapped version. Guard
    // the whole bootstrap: on a second evaluation the first run's hooks are
    // still bound to live closures, so leaving them in place is correct.
    // The flag lives on window because it has to outlive the re-execution
    // that resets module state. Same shape as section_map's
    // __slopsmithSectionMapHooksInstalled guard.
    const HOOK_KEY = '__feedBackLyricsKaraokeHooksInstalled';
    if (!window[HOOK_KEY]) {
        window[HOOK_KEY] = true;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // Registration only assigns globals — no DOM, no listeners — so it
    // runs at script evaluation rather than waiting for DOMContentLoaded:
    // core's viz picker may enumerate `window.feedBackViz_*` before then.
    // It carries its own idempotency guard, independent of HOOK_KEY.
    _registerVizProvider();

    // Node-only test hook. Mirrors the piano plugin's pattern: the browser
    // globals above are the real entry point, and this export exists so the
    // pure helpers and the renderer factory are reachable from
    // tests/screen.test.js without a DOM.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            VIZ_SETTING_DEFAULTS,
            _createVizRenderer,
            _registerVizProvider,
            _vizMatchesArrangement,
            _vizSongKey,
            _vizNormalizeVoices,
            _vizScoredIndex,
            _vizNormalizeTokens,
            _vizDiaPos,
            _vizIsNatural,
            _vizMidiToName,
            _vizDiatonicRange,
            _vizSharedDiatonicRange,
            _vizBuildLines,
            _vizActiveLyricLineIndex,
            _vizDrawStage,
            stripSyllableMarker,
            _vizPitchRange,
            _vizMaxDuration,
            _vizMaxDurationAcrossVoices,
            _vizLowerBound,
            _percentilePitchRange,
            computeSongPitchRange,
            _vizOwnsPlayback,
            _vizDrawFrame,
            setKaraokeMode,
            _karaokeModeForTest: () => karaokeMode,
        };
    }
})();
