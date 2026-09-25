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
        _lkOverlaySyncTokens();
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
            if (micWantOnForSong && status && status.has_pitch && songHasMidi() && overlayMicState() !== 'listening'
                && overlayMicState() !== 'requesting' && overlayMicState() !== 'suspended') {
                startMic();
            }
        } else {
            hideOverlay();
            // Tear the mic stream down with the overlay — there's nothing
            // to render to. keepFlag preserves the on/off intent so the
            // next karaoke toggle on the same song restores the mic.
            if (overlayMicState() !== 'off') stopMic({ keepFlag: true });
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
        if (_lkOverlayScorer.hasResults() || overlayMicState() === 'listening') {
            for (const { tok, midi } of visible) {
                if (midi == null) continue;
                const idx = tokenIndexMap.get(tok);
                if (idx === undefined) continue;
                const entry = _lkOverlayResultFor(idx);
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
            const last = _lkOverlayScorer.lastSample();
            const fresh = !!last && (_wallNow() - last.wallAt) <= _LK_SAMPLE_FRESH_MS;
            if (fresh) {
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

    // ── Vocal pitch engine: YIN, scoring, microphone (#11) ─────────────
    //
    // ONE engine, shared by the legacy overlay and the visualization
    // provider, so there are never two microphone paths or two scorers:
    //
    //  - Pure helpers (YIN, pitch distance, frame dating, channel pick,
    //    settings normalization) — unit-tested without a microphone.
    //  - `_lkCreateVocalScorer()` — per-owner scoring state (per-syllable
    //    hit quality, score, streak, best streak, accuracy, sung trace).
    //    Each overlay/provider instance holds its own; nothing is shared.
    //  - `_lkCreateMicController()` — the single microphone. Exactly one
    //    owner at a time: `start()` refuses while someone else holds it,
    //    which is what makes "only one scoring subsystem" structural rather
    //    than a convention each caller has to remember.
    //
    // YIN + getUserMedia + the ScriptProcessor ring buffer were adapted
    // from the slopsmith note_detect plugin; the octave-free distance,
    // stereo channel pick, mic timing offset, seek gate and the score /
    // streak formula are adapted from Karaoke Highway
    // (https://github.com/Taynavv/feedback-vocals-viz, AGPL-3.0), which in
    // turn adapted its engine from this file. Vocals are monophonic, so YIN
    // alone is sufficient — no CREPE/HPS/WASM.
    const _LK_YIN_FRAME_SIZE = 2048;
    const _LK_YIN_MIN_SAMPLES = 4096;
    const _LK_YIN_MIN_HZ = 50;        // human vocal floor — drops sub-bass artefacts
    const _LK_YIN_MAX_HZ = 1100;      // upper end of soprano range
    const _LK_YIN_CONFIDENCE = 0.5;   // YIN clarity score; below = unvoiced
    const _LK_FRAME_INTERVAL_MS = 50;
    const _LK_SAMPLE_FRESH_MS = 200;  // stale samples don't draw the user line
    const _LK_TRACE_CAP = 256;        // ~12 s at 50 ms cadence
    // Transfer settle: after a release, Firefox may not hand the device
    // driver back synchronously, so the retry (see _vizRequestMicWithSettle)
    // waits this long before re-requesting the just-freed mic.
    const _LK_MIC_TRANSFER_SETTLE_MS = 150;
    // Transport gate. The highway clock's AV-drift resync steps backward by
    // a few ms mid-song, so only a sizeable backward jump is a rewind (and
    // wipes the take); smaller backsteps are dropped like a pause. A large
    // forward jump is a skip: the syllables jumped over are left unjudged
    // rather than counted as misses the singer never had a chance at.
    const _LK_SEEK_BACK_S = 0.25;
    const _LK_SEEK_FORWARD_S = 1.5;
    const _LK_HIT_ACCURACY = 0.5;     // syllable is a hit at >= 50% matched frames
    const _LK_PERFECT_ACCURACY = 0.9;
    const _LK_STORAGE_KEY = 'lyrics_karaoke.micFeedback';   // legacy overlay on/off bit
    const _LK_PREFS_KEY = 'lyrics_karaoke.prefs.v1';        // engine settings (see _lkLoadPrefs)
    const _LK_MIC_CHANNELS = ['mix', '1', '2'];
    const _LK_MANAGED_SOURCE_ID = 'lyrics_karaoke:mic';
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

    /** YIN result → a sung MIDI pitch, or null for an unvoiced / out-of-range
     *  frame. Unvoiced frames still matter to the scorer (they advance the
     *  transport), so the caller forwards null rather than dropping them. */
    function _lkDetectMidi(buffer, sampleRate) {
        const r = yinDetect(buffer, sampleRate, _LK_YIN_MIN_HZ);
        if (!r || r.freq <= 0 || r.confidence < _LK_YIN_CONFIDENCE) return null;
        if (r.freq < _LK_YIN_MIN_HZ || r.freq > _LK_YIN_MAX_HZ) return null;
        const midi = freqToMidi(r.freq);
        return isFinite(midi) ? { midi, confidence: r.confidence } : null;
    }

    /** Semitone distance between a sung and a target pitch. Octave-free
     *  matching folds it onto [0, 6] so singing the melody an octave (or
     *  two) away from the chart still counts. */
    function _lkPitchDistance(sung, target, octaveIndependent) {
        let d = Math.abs(sung - target);
        if (octaveIndependent) {
            d %= 12;
            if (d > 6) d = 12 - d;
        }
        return d;
    }

    /** Tolerance is inclusive; the epsilon keeps a sung pitch exactly on the
     *  boundary from failing on float noise (e.g. 60.5 - 60 vs 0.5). */
    function _lkPitchMatches(sung, target, tolerance, octaveIndependent) {
        return _lkPitchDistance(sung, target, octaveIndependent) <= tolerance + 0.000000001;
    }

    /** Song time a captured buffer represents. The ring spans the most
     *  recent `ringSize` samples, i.e. [clock - window, clock] in wall time,
     *  so its representative time is the MIDPOINT — scoring lands on the
     *  syllable actually being sung, not the one under the cursor when the
     *  timer woke. Wall seconds convert to song seconds via the playback
     *  rate (read per frame: the speed slider can move mid-song). */
    function _lkFrameMidpointTime(clockNow, ringSize, sampleRate, rate) {
        return clockNow - ((ringSize / 2) / sampleRate) * rate;
    }

    /** The ONE calibration applied on top of midpoint dating: the user's mic
     *  timing offset (signed wall ms; positive = attribute singing earlier).
     *  It moves scoring and the sung trace — never playback. */
    function _lkApplyMicOffset(t, micOffsetMs, rate) {
        return t - (micOffsetMs / 1000) * rate;
    }

    function _lkClampNumber(value, lo, hi, dflt) {
        const n = typeof value === 'number' ? value : parseFloat(value);
        if (!isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    /** Scoring settings, clamped. The manifest's ranges are narrower (the
     *  host's slider bounds); these bounds only reject garbage from storage
     *  or a peer without silently rewriting a legal value. */
    function _lkNormalizeScoringSettings(raw) {
        const r = raw || {};
        return {
            tolerance: _lkClampNumber(r.tolerance, 0.25, 3, 1),
            octaveIndependent: r.octaveIndependent === true || r.octaveIndependent === '1'
                || r.octaveIndependent === 'true',
            micOffsetMs: _lkClampNumber(r.micOffsetMs, -1000, 1000, 0),
        };
    }

    function _lkNormalizeChannel(ch) {
        const s = String(ch == null ? '' : ch);
        return _LK_MIC_CHANNELS.indexOf(s) >= 0 ? s : 'mix';
    }

    /** Pick the capture channel from an AudioBuffer-like input. 'mix'
     *  averages the first two channels into the caller's preallocated
     *  `mixBuf` (no per-frame allocation); a mono device ignores the
     *  channel choice rather than going silent. */
    function _lkSelectChannel(inputBuffer, channel, mixBuf) {
        const nCh = inputBuffer.numberOfChannels || 1;
        if (nCh < 2) return inputBuffer.getChannelData(0);
        if (channel === '1') return inputBuffer.getChannelData(0);
        if (channel === '2') return inputBuffer.getChannelData(1);
        const a = inputBuffer.getChannelData(0);
        const b = inputBuffer.getChannelData(1);
        const out = (mixBuf && mixBuf.length >= a.length) ? mixBuf : new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
        return out.length === a.length ? out : out.subarray(0, a.length);
    }

    /** Engine preferences, persisted as ONE versioned JSON document under the
     *  `lyrics_karaoke.*` namespace (#10):
     *    { v: 1, deviceId, channel, tolerance, octaveIndependent, micOffsetMs }
     *  Device and channel are properties of the single microphone, so they
     *  live here only. The three scoring keys are also per-panel viz
     *  settings (host-persisted, feedBack#849); the copy here is the default
     *  a new panel and the legacy overlay start from.
     *
     *  Migration, run once when the document is absent: the legacy overlay
     *  persisted only `lyrics_karaoke.micFeedback` — an on/off bit it keeps
     *  owning, unchanged, so there is nothing of ours to migrate (#10). The
     *  compatible legacy values are Karaoke Highway's `vocals_highway.*`
     *  keys, whose meanings are identical, so a user moving over keeps their
     *  calibration and input choice. Its `micOn` bit is deliberately NOT
     *  carried: the microphone only starts on an explicit click. */
    function _lkLoadPrefs(storage) {
        const get = (k) => {
            try { return storage ? storage.getItem(k) : null; } catch (_) { return null; }
        };
        let doc = null;
        const raw = get(_LK_PREFS_KEY);
        if (raw) {
            try { doc = JSON.parse(raw); } catch (_) { doc = null; }
        }
        let migrated = false;
        if (!doc || typeof doc !== 'object') {
            doc = {};
            const kh = (k) => get('vocals_highway.' + k);
            if (kh('tolerance') !== null) { doc.tolerance = kh('tolerance'); migrated = true; }
            if (kh('octaveIndependent') !== null) { doc.octaveIndependent = kh('octaveIndependent'); migrated = true; }
            if (kh('micOffsetMs') !== null) { doc.micOffsetMs = kh('micOffsetMs'); migrated = true; }
            if (kh('micChannel') !== null) { doc.channel = kh('micChannel'); migrated = true; }
            if (kh('micDeviceId') !== null) { doc.deviceId = kh('micDeviceId'); migrated = true; }
        }
        const prefs = Object.assign(
            { v: 1, deviceId: typeof doc.deviceId === 'string' ? doc.deviceId : '' },
            { channel: _lkNormalizeChannel(doc.channel) },
            _lkNormalizeScoringSettings(doc),
        );
        return { prefs, migrated };
    }

    function _lkSavePrefs(storage, prefs) {
        try { if (storage) storage.setItem(_LK_PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* noop */ }
    }

    /** Per-owner scoring state. Tokens are the canonical playback shape
     *  (`{start, duration, midi}`, start-sorted, index-aligned with the
     *  caller's list); a syllable with `midi === null` is lyric-only and is
     *  never judged.
     *
     *  Everything is driven by `ingest(frame)`, called once per 50 ms mic
     *  frame — voiced or not — in one time domain: the frame's midpoint
     *  time shifted by the mic offset. Syllables are finalized from that
     *  same clock, so a positive calibration can't finalize a syllable
     *  before its late-arriving frames land. */
    function _lkCreateVocalScorer(initialSettings) {
        const settings = _lkNormalizeScoringSettings(initialSettings);
        let tokens = [];
        let maxDuration = 0;
        const results = new Map();   // tokenIndex → {samplesIn, samplesMatched, accuracy, quality}
        const trace = [];            // [{t, midi}] offset-shifted sung pitch history
        let lastT = -Infinity;       // last ingested (offset-shifted) frame time
        let lastRate = 1;
        let activeSince = -Infinity; // syllables starting earlier are unjudged
        let cursor = 0;              // finalize cursor into start-sorted tokens
        let lastSample = null;       // {t, midi, wallAt}
        let score = 0;
        let streak = 0;
        let bestStreak = 0;
        let hits = 0;
        let misses = 0;
        let samplesIn = 0;
        let samplesMatched = 0;

        function reset() {
            results.clear();
            trace.length = 0;
            lastT = -Infinity;
            activeSince = -Infinity;
            cursor = 0;
            lastSample = null;
            score = 0;
            streak = 0;
            bestStreak = 0;
            hits = 0;
            misses = 0;
            samplesIn = 0;
            samplesMatched = 0;
        }

        function activeIndex(t) {
            // Latest-starting pitched syllable whose [start, end) contains t,
            // so an overlapping next syllable beats the previous one's tail.
            // Binary search to the first token starting after t, then walk
            // back no further than the song's longest syllable.
            let lo = 0;
            let hi = tokens.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (tokens[mid].start <= t) lo = mid + 1;
                else hi = mid;
            }
            for (let i = lo - 1; i >= 0; i--) {
                const tok = tokens[i];
                if (tok.start < t - maxDuration) break;
                if (tok.midi === null) continue;
                if (t < tok.start + tok.duration) return i;
            }
            return -1;
        }

        function judge(i) {
            let entry = results.get(i);
            if (!entry) {
                entry = { samplesIn: 0, samplesMatched: 0, accuracy: 0, quality: null };
                results.set(i, entry);
            }
            const acc = entry.accuracy;
            const hit = entry.samplesIn > 0 && acc >= _LK_HIT_ACCURACY;
            if (hit) {
                entry.quality = acc >= _LK_PERFECT_ACCURACY ? 'perfect' : 'good';
                hits += 1;
                streak += 1;
                if (streak > bestStreak) bestStreak = streak;
                const mult = 1 + Math.min(30, streak) * 0.1;
                score += Math.round(100 * acc * mult);
            } else {
                entry.quality = 'miss';
                misses += 1;
                streak = 0;
                score += Math.round(50 * acc);
            }
        }

        function finalizeUpTo(t) {
            while (cursor < tokens.length) {
                const tok = tokens[cursor];
                if (tok.start + tok.duration > t) break;
                const i = cursor++;
                if (tok.midi === null || tok.start < activeSince) continue;
                judge(i);
            }
        }

        return {
            reset,
            setTokens(list) {
                tokens = Array.isArray(list) ? list : [];
                maxDuration = 0;
                for (const tok of tokens) {
                    if (tok.duration > maxDuration) maxDuration = tok.duration;
                }
                reset();
            },
            setSettings(next) {
                const n = _lkNormalizeScoringSettings(Object.assign({}, settings, next));
                // A live offset change shifts the next frame's time by the
                // same amount; move the gate's reference in step so a big
                // backward nudge can't read as a rewind and wipe the take.
                if (n.micOffsetMs !== settings.micOffsetMs && lastT > -Infinity) {
                    const shift = ((n.micOffsetMs - settings.micOffsetMs) / 1000) * lastRate;
                    lastT -= shift;
                }
                Object.assign(settings, n);
            },
            getSettings() { return Object.assign({}, settings); },
            /** @returns {boolean} whether the frame advanced the transport. */
            ingest(frame) {
                if (!frame || typeof frame.t !== 'number' || !isFinite(frame.t)) return false;
                const rate = (typeof frame.rate === 'number' && frame.rate > 0) ? frame.rate : 1;
                lastRate = rate;
                const t = _lkApplyMicOffset(frame.t, settings.micOffsetMs, rate);
                if (lastT > -Infinity) {
                    const delta = t - lastT;
                    if (delta < -_LK_SEEK_BACK_S) reset();
                    else if (delta < 0.001) return false;   // paused / micro-backstep
                    else if (delta > _LK_SEEK_FORWARD_S) {
                        // Skip forward: leave the jumped-over syllables unjudged.
                        activeSince = t;
                        finalizeUpTo(t);
                    }
                }
                if (lastT === -Infinity) activeSince = t;
                lastT = t;
                finalizeUpTo(t);

                const midi = frame.midi;
                if (typeof midi !== 'number' || !isFinite(midi)) return true;
                trace.push({ t, midi });
                if (trace.length > _LK_TRACE_CAP) trace.shift();
                lastSample = { t, midi, wallAt: frame.wallAt };

                const idx = activeIndex(t);
                if (idx < 0) return true;
                let entry = results.get(idx);
                if (!entry) {
                    entry = { samplesIn: 0, samplesMatched: 0, accuracy: 0, quality: null };
                    results.set(idx, entry);
                }
                if (entry.quality !== null) return true;   // already judged
                const matched = _lkPitchMatches(midi, tokens[idx].midi,
                    settings.tolerance, settings.octaveIndependent);
                entry.samplesIn += 1;
                samplesIn += 1;
                if (matched) {
                    entry.samplesMatched += 1;
                    samplesMatched += 1;
                }
                entry.accuracy = entry.samplesMatched / entry.samplesIn;
                return true;
            },
            /** Judge everything that ended by `t` (song end: no more frames). */
            finalizeUpTo(t) {
                if (typeof t === 'number' && !Number.isNaN(t)) finalizeUpTo(t);
            },
            resultFor(i) { return results.get(i) || null; },
            hasResults() { return results.size > 0; },
            trace() { return trace; },
            lastSample() { return lastSample; },
            stats() {
                return {
                    score,
                    streak,
                    bestStreak,
                    hits,
                    misses,
                    judged: hits + misses,
                    accuracy: samplesIn > 0 ? samplesMatched / samplesIn : null,
                };
            },
        };
    }

    function _lkMicErrorMessage(e) {
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission was denied.';
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
        if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is in use or unavailable.';
        return (e && e.message) || 'Microphone unavailable';
    }

    /** The single microphone. `env` is injectable so tests can drive the
     *  whole lifecycle — permission, device loss, teardown — against fakes.
     *
     *  Owner: `{ id, getClock() → song seconds, onFrame(frame) }`.
     *  Frame: `{ t, midi|null, confidence, rate, wallAt }`, `t` dated at the
     *  buffer midpoint on the OWNER's clock (splitscreen panels run their
     *  own). The mic offset is the scorer's business, not the mic's.
     *
     *  Privacy: getUserMedia runs only inside `start()`, which callers wire
     *  to an explicit click; audio stays in the tab — only the detected
     *  pitch leaves the frame pump, and nothing is stored or sent. Every
     *  track is stopped on stop/destroy/device loss, and a failure is
     *  surfaced once — never retried in a loop. */
    function _lkCreateMicController(env) {
        let state = 'off';           // off | requesting | listening | suspended | error
        let errorMsg = '';
        let owner = null;
        let session = 0;
        let stream = null;
        let ctx = null;
        let sourceNode = null;
        let processor = null;
        let sink = null;
        let timer = null;
        let managedSource = false;
        let deviceId = env.prefs.get().deviceId || '';
        let channel = _lkNormalizeChannel(env.prefs.get().channel);
        const listeners = new Set();

        // Frame pump buffers, sized at start (depends on the sample rate).
        let ring = null;
        let pending = null;
        let mixBuf = null;
        let ringCount = 0;
        let pendingReady = false;
        let pendingAt = -Infinity;
        let pendingRate = 1;
        let sampleRate = 0;

        function snapshot() {
            return { state, error: errorMsg, ownerId: owner ? owner.id : null, deviceId, channel };
        }

        function notify() {
            const snap = snapshot();
            listeners.forEach((fn) => {
                try { fn(snap); } catch (_) { /* a listener never breaks the mic */ }
            });
        }

        function caps() {
            try { return env.caps ? env.caps() : null; } catch (_) { return null; }
        }

        function capsCommand(command, payload) {
            const c = caps();
            if (!c) return;
            try {
                Promise.resolve(c.command('audio-input', command, {
                    requester: 'lyrics_karaoke',
                    source: 'lyrics_karaoke',
                    origin: 'system',
                    reason: 'Lyrics Karaoke microphone ' + command,
                    payload,
                })).catch(() => {});
            } catch (_) { /* degrade to a no-op on hosts without the domain */ }
        }

        function registerManagedSource() {
            // Advisory: makes the mic a visible managed input on hosts with
            // the audio-input domain. We still capture frames ourselves.
            managedSource = true;
            capsCommand('register-source', {
                version: 1,
                providerId: 'lyrics_karaoke',
                ownerPluginId: 'lyrics_karaoke',
                sourceId: _LK_MANAGED_SOURCE_ID,
                logicalSourceKey: _LK_MANAGED_SOURCE_ID,
                label: 'Karaoke microphone',
                labelSafe: true,
                kind: 'microphone',
                channelShape: 'mono',
                availability: 'available',
            });
        }

        function unregisterManagedSource() {
            if (!managedSource) return;
            managedSource = false;
            capsCommand('unregister-source', {
                providerId: 'lyrics_karaoke',
                sourceId: _LK_MANAGED_SOURCE_ID,
            });
        }

        function stopTracks(s) {
            if (!s) return;
            try { s.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* noop */ } }); } catch (_) { /* noop */ }
        }

        function closeCtx(c) {
            if (!c) return;
            try { const p = c.close(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* noop */ }
        }

        function stopTimer() {
            if (timer !== null) { env.clearInterval(timer); timer = null; }
        }

        function startTimer(s) {
            stopTimer();
            timer = env.setInterval(() => {
                if (!pendingReady || s !== session || state !== 'listening') return;
                pendingReady = false;
                const det = _lkDetectMidi(pending, sampleRate);
                const frame = {
                    t: pendingAt,
                    midi: det ? det.midi : null,
                    confidence: det ? det.confidence : 0,
                    rate: pendingRate,
                    wallAt: env.now(),
                };
                if (owner) {
                    try { owner.onFrame(frame); } catch (_) { /* owner bug must not kill the pump */ }
                }
            }, _LK_FRAME_INTERVAL_MS);
        }

        /** Release every resource. Leaves state/owner to the caller. */
        function teardown() {
            session += 1;   // any in-flight permission prompt / frame is stale
            stopTimer();
            if (processor) {
                try { processor.disconnect(); } catch (_) { /* noop */ }
                processor.onaudioprocess = null;
                processor = null;
            }
            if (sourceNode) {
                try { sourceNode.disconnect(); } catch (_) { /* noop */ }
                sourceNode = null;
            }
            if (sink) {
                try { sink.disconnect(); } catch (_) { /* noop */ }
                sink = null;
            }
            stopTracks(stream);
            stream = null;
            closeCtx(ctx);
            ctx = null;
            ring = null;
            pending = null;
            mixBuf = null;
            ringCount = 0;
            pendingReady = false;
            pendingAt = -Infinity;
            unregisterManagedSource();
        }

        function isActive() {
            return state === 'requesting' || state === 'listening' || state === 'suspended';
        }

        async function start(nextOwner) {
            if (!nextOwner || typeof nextOwner.onFrame !== 'function') return false;
            if (isActive()) {
                // Exclusive: a different owner never shares or steals the mic.
                return owner === nextOwner;
            }
            owner = nextOwner;
            state = 'requesting';
            errorMsg = '';
            notify();

            const s = ++session;
            let pendingStream = null;
            let pendingCtx = null;
            try {
                const nav = env.navigator();
                if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
                    throw new Error(env.insecureContext()
                        ? 'Microphone access requires HTTPS (or localhost).'
                        : 'Microphone access is not available in this browser.');
                }
                // Create + resume the AudioContext BEFORE awaiting
                // getUserMedia so the click's user activation is still valid
                // when Safari/iOS evaluates resume().
                pendingCtx = env.createAudioContext();
                if (!pendingCtx) throw new Error('Web Audio is not available in this browser.');
                if (pendingCtx.state === 'suspended') {
                    try { await pendingCtx.resume(); } catch (_) {
                        throw new Error('Audio could not start. Click 🎤 again.');
                    }
                    if (pendingCtx.state === 'suspended') {
                        throw new Error('Audio is suspended. Click 🎤 again.');
                    }
                }
                // Ask for stereo so an interface presenting one stereo device
                // (ch1 guitar / ch2 mic) can be channel-addressed; mono
                // devices still work.
                const audio = {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: { ideal: 2 },
                };
                const wanted = deviceId;
                if (wanted) audio.deviceId = { exact: wanted };
                try {
                    pendingStream = await nav.mediaDevices.getUserMedia({ audio });
                } catch (e) {
                    // The saved device was unplugged or renumbered: fall back
                    // to the default input ONCE rather than failing outright.
                    const gone = e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError');
                    if (!wanted || !gone || s !== session) throw e;
                    delete audio.deviceId;
                    pendingStream = await nav.mediaDevices.getUserMedia({ audio });
                }
                if (s !== session) {
                    // Stopped while the permission prompt was open.
                    stopTracks(pendingStream);
                    closeCtx(pendingCtx);
                    return false;
                }
                stream = pendingStream;
                ctx = pendingCtx;
                pendingStream = null;
                pendingCtx = null;
                sampleRate = ctx.sampleRate;
                // The ring must cover 2*tauMax samples so YIN can search down
                // to the vocal floor at any sample rate (192 kHz needs 7680).
                const ringSize = Math.max(_LK_YIN_MIN_SAMPLES, 2 * Math.ceil(sampleRate / _LK_YIN_MIN_HZ));
                ring = new Float32Array(ringSize);
                pending = new Float32Array(ringSize);
                mixBuf = new Float32Array(_LK_YIN_FRAME_SIZE);
                ringCount = 0;
                pendingReady = false;

                sourceNode = ctx.createMediaStreamSource(stream);
                processor = ctx.createScriptProcessor(_LK_YIN_FRAME_SIZE, 2, 1);
                processor.onaudioprocess = (e) => {
                    if (s !== session || state !== 'listening') return;
                    const input = _lkSelectChannel(e.inputBuffer, channel, mixBuf);
                    const n = input.length;
                    ring.copyWithin(0, n);           // slide left in place
                    ring.set(input, ringSize - n);   // new frame fills the tail
                    ringCount += n;
                    if (ringCount >= ringSize && owner) {
                        pending.set(ring);
                        pendingRate = env.getPlaybackRate();
                        pendingAt = _lkFrameMidpointTime(owner.getClock(), ringSize, sampleRate, pendingRate);
                        pendingReady = true;
                    }
                };
                sourceNode.connect(processor);
                // ScriptProcessor needs a sink to pump; a zero-gain node
                // avoids feeding the mic back to the speakers.
                sink = ctx.createGain();
                sink.gain.value = 0;
                processor.connect(sink);
                sink.connect(ctx.destination);

                // Device loss: surface it once and release everything.
                stream.getTracks().forEach((track) => {
                    if (track && typeof track.addEventListener === 'function') {
                        track.addEventListener('ended', () => {
                            if (s !== session) return;
                            teardown();
                            state = 'error';
                            errorMsg = 'The microphone was disconnected.';
                            notify();
                        });
                    }
                });

                state = 'listening';
                startTimer(s);
                registerManagedSource();
                notify();
                return true;
            } catch (e) {
                stopTracks(pendingStream);
                closeCtx(pendingCtx);
                if (s !== session) return false;   // superseded — not an error
                teardown();
                state = 'error';
                errorMsg = _lkMicErrorMessage(e);
                notify();
                return false;
            }
        }

        function stop() {
            const had = state !== 'off' || owner !== null;
            teardown();
            owner = null;
            state = 'off';
            errorMsg = '';
            if (had) notify();
        }

        return {
            start,
            stop,
            /** Stop only if `who` holds the mic; returns whether it did. */
            release(who) {
                if (!who || owner !== who) return false;
                stop();
                return true;
            },
            /** Pause frame processing, keeping the device open (screen hidden). */
            suspend() {
                if (state !== 'listening') return false;
                stopTimer();
                pendingReady = false;
                if (ctx && typeof ctx.suspend === 'function') {
                    try { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* noop */ }
                }
                state = 'suspended';
                notify();
                return true;
            },
            resume() {
                if (state !== 'suspended') return false;
                if (ctx && typeof ctx.resume === 'function') {
                    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* noop */ }
                }
                state = 'listening';
                startTimer(session);
                notify();
                return true;
            },
            destroy() {
                stop();
                listeners.clear();
            },
            /** Switch input device; restarts a live stream on the new device
             *  (callers wire this to the picker's change — a user action). */
            async setDevice(id) {
                const next = typeof id === 'string' ? id : '';
                if (next === deviceId) return true;
                deviceId = next;
                env.prefs.set({ deviceId: next });
                if (!isActive() || !owner) { notify(); return true; }
                const o = owner;
                teardown();
                state = 'off';
                owner = null;
                return start(o);
            },
            /** Switch capture channel; applied to the very next buffer. */
            setChannel(ch) {
                channel = _lkNormalizeChannel(ch);
                env.prefs.set({ channel });
                notify();
            },
            async listDevices() {
                const nav = env.navigator();
                if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.enumerateDevices !== 'function') return [];
                let devices = [];
                try { devices = await nav.mediaDevices.enumerateDevices(); } catch (_) { return []; }
                return devices
                    .filter((d) => d && d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
                    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || ('Microphone ' + (i + 1)) }));
            },
            getState: snapshot,
            isOwnedBy(who) { return !!who && owner === who && state !== 'off'; },
            subscribe(fn) {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
        };
    }

    // Module-level engine singletons. Screen.js may be re-executed on plugin
    // reload; the mic is parked on window so a second evaluation reuses the
    // live controller instead of creating a second one that could open a
    // second stream (the first run's controller would otherwise be orphaned
    // still holding the device).
    const _lkPrefsState = _lkLoadPrefs(typeof localStorage !== 'undefined' ? localStorage : null);
    const _lkPrefs = _lkPrefsState.prefs;
    if (_lkPrefsState.migrated) _lkSavePrefs(typeof localStorage !== 'undefined' ? localStorage : null, _lkPrefs);

    function _lkUpdatePrefs(patch) {
        let changed = false;
        for (const k of Object.keys(patch)) {
            if (_lkPrefs[k] !== patch[k]) { _lkPrefs[k] = patch[k]; changed = true; }
        }
        if (!changed) return;
        _lkSavePrefs(typeof localStorage !== 'undefined' ? localStorage : null, _lkPrefs);
        // The overlay has no settings surface of its own; it scores with
        // the engine defaults, so it follows them live.
        _lkOverlayScorer.setSettings(_lkPrefs);
    }

    function _lkDefaultMicEnv() {
        return {
            navigator: () => (typeof navigator !== 'undefined' ? navigator : null),
            insecureContext: () => typeof location !== 'undefined'
                && location.protocol === 'http:'
                && location.hostname !== 'localhost'
                && location.hostname !== '127.0.0.1',
            createAudioContext: () => {
                const AC = window.AudioContext || window.webkitAudioContext;
                return AC ? new AC() : null;
            },
            setInterval: (fn, ms) => setInterval(fn, ms),
            clearInterval: (id) => clearInterval(id),
            now: () => _wallNow(),
            getPlaybackRate: () => getPlaybackRate(),
            prefs: { get: () => _lkPrefs, set: (patch) => _lkUpdatePrefs(patch) },
            caps: () => {
                const c = window.feedBack && window.feedBack.capabilities;
                return (c && c.version === 1 && typeof c.command === 'function') ? c : null;
            },
        };
    }

    const _LK_MIC_KEY = '__feedBackLyricsKaraokeMic';
    const _lkMic = window[_LK_MIC_KEY] || (window[_LK_MIC_KEY] = _lkCreateMicController(_lkDefaultMicEnv()));

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

    // ── Legacy overlay: mic feedback over the shared engine ────────────

    let micBtn = null;
    let micPill = null;
    let micPillLastText = '';            // last text written to micPill; avoids per-frame DOM writes
    // Session-scoped intent: "the user enabled mic for THIS song." Used
    // to auto-restore the mic when karaoke is toggled off and back on
    // for the same song without spilling that intent across songs (a
    // resetForNewSong clears it). The persisted localStorage flag is
    // separate and serves a future "remember on reload" surface.
    let micWantOnForSong = false;

    // The overlay's scorer and its microphone-owner identity. Tokens are
    // index-aligned with pitchData.tokens (see _lkOverlaySyncTokens) so the
    // overlay can look results up by its own token index.
    const _lkOverlayScorer = _lkCreateVocalScorer(_lkPrefs);
    let userDisplayMidi = null;       // smoothed value used for the pitch line + pill
    const _lkOverlayOwner = {
        id: 'overlay',
        getClock: () => getNow(),
        onFrame: (frame) => { _lkOverlayScorer.ingest(frame); },
    };

    /** Overlay view of the shared mic: 'off' unless the OVERLAY owns it. */
    function overlayMicState() {
        const s = _lkMic.getState();
        return s.ownerId === _lkOverlayOwner.id ? s.state : 'off';
    }

    // pitchData.tokens index → scorer index. The scorer needs start-sorted
    // tokens and /data doesn't promise an order, so it gets a sorted copy.
    let _lkOverlayIndex = [];

    function _lkOverlaySyncTokens() {
        const src = (pitchData && Array.isArray(pitchData.tokens)) ? pitchData.tokens : [];
        const rows = src.map((tok, i) => ({
            i,
            start: (tok && typeof tok.t === 'number' && isFinite(tok.t)) ? tok.t : Infinity,
            duration: (tok && typeof tok.d === 'number' && tok.d > 0) ? tok.d : 0,
            midi: (tok && typeof tok.midi === 'number' && isFinite(tok.midi)) ? tok.midi : null,
        }));
        rows.sort((a, b) => (a.start - b.start) || (a.i - b.i));
        _lkOverlayIndex = new Array(rows.length);
        rows.forEach((row, sortedIdx) => { _lkOverlayIndex[row.i] = sortedIdx; });
        _lkOverlayScorer.setTokens(rows);
        userDisplayMidi = null;
    }

    function _lkOverlayResultFor(tokenIdx) {
        const i = _lkOverlayIndex[tokenIdx];
        return i === undefined ? null : _lkOverlayScorer.resultFor(i);
    }

    function songHasMidi() {
        if (!pitchData || !Array.isArray(pitchData.tokens)) return false;
        for (const t of pitchData.tokens) {
            if (t && typeof t.midi === 'number') return true;
        }
        return false;
    }

    function resetUserResults() {
        _lkOverlayScorer.reset();
        userDisplayMidi = null;
    }

    async function startMic() {
        // The provider owns playback: the shared controller would refuse
        // anyway (it is held by a viz panel or about to be), but bail early
        // so the overlay never even requests permission behind its back.
        if (_vizOwnsPlayback()) return;
        const ok = await _lkMic.start(_lkOverlayOwner);
        if (ok) {
            micWantOnForSong = true;
            try { localStorage.setItem(_LK_STORAGE_KEY, '1'); } catch (_) { /* noop */ }
        } else if (overlayMicState() === 'error') {
            // Clear both the persisted flag and the per-song intent on
            // failure. Otherwise a revoked permission or unplugged input
            // would re-trigger the prompt on every karaoke toggle. The user
            // re-clicks 🎤 to retry; a successful start re-sets both flags.
            micWantOnForSong = false;
            try { localStorage.setItem(_LK_STORAGE_KEY, '0'); } catch (_) { /* noop */ }
        }
        refreshMicUi();
    }

    function stopMic(opts) {
        const keepFlag = !!(opts && opts.keepFlag);
        _lkMic.release(_lkOverlayOwner);
        if (!keepFlag) {
            try { localStorage.setItem(_LK_STORAGE_KEY, '0'); } catch (_) { /* noop */ }
        }
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
        // Mirror the shared controller's transitions (requesting, device
        // loss, errors) into the overlay's button. Subscribed once — the
        // button itself is created once per page.
        _lkMic.subscribe(() => refreshMicUi());
    }

    async function onMicClick() {
        if (micBtn && micBtn.disabled) return;
        const st = overlayMicState();
        if (st === 'listening' || st === 'suspended') {
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

        const shared = _lkMic.getState();
        // Held by a provider panel — not ours to toggle.
        const busy = shared.ownerId !== null && shared.ownerId !== _lkOverlayOwner.id
            && (shared.state === 'requesting' || shared.state === 'listening' || shared.state === 'suspended');
        const st = busy ? 'busy' : overlayMicState();
        const lastError = st === 'error' ? shared.error : '';
        switch (st) {
            case 'requesting':
                micBtn.disabled = true;
                micBtn.className = BTN_CLASS_DISABLED;
                micBtn.title = 'Requesting microphone…';
                micBtn.setAttribute('aria-label', 'Requesting microphone…');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = '…'; micPillLastText = '…'; }
                break;
            case 'listening':
            case 'suspended':
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_ACTIVE;
                micBtn.title = 'Stop live mic feedback';
                micBtn.setAttribute('aria-label', 'Stop live mic feedback');
                micBtn.setAttribute('aria-pressed', 'true');
                micPillLastText = '';
                // Pill text is set by updateMicPill() each render frame.
                break;
            case 'busy':
                micBtn.disabled = true;
                micBtn.className = BTN_CLASS_DISABLED;
                micBtn.title = 'The microphone is in use by the karaoke visualization';
                micBtn.setAttribute('aria-label', 'Microphone in use');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = ''; micPillLastText = ''; }
                break;
            default:
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_PROMPT;
                micBtn.setAttribute('aria-pressed', 'false');
                if (lastError) {
                    micBtn.title = 'Mic feedback error: ' + lastError + ' (click to retry)';
                    micBtn.setAttribute('aria-label', 'Mic error — click to retry');
                    if (micPill) { micPill.textContent = '!'; micPillLastText = '!'; }
                } else {
                    micBtn.title = 'Toggle live mic feedback';
                    micBtn.setAttribute('aria-label', 'Toggle live mic feedback');
                    if (micPill) { micPill.textContent = ''; micPillLastText = ''; }
                }
                break;
        }
    }

    function updateMicPill() {
        if (!micPill || overlayMicState() !== 'listening') return;
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
        _lkOverlaySyncTokens();
        songPitchRange = null;
        // Tear the overlay all the way down so a previous song's bars
        // don't briefly flash for the new song before its data arrives.
        teardownOverlay();
        // Drop mic state with the song. keepFlag preserves the
        // localStorage on/off bit (a future "remember on reload"
        // surface), but micWantOnForSong is per-song so a one-time
        // opt-in on song A doesn't auto-prompt on song B.
        if (overlayMicState() !== 'off') stopMic({ keepFlag: true });
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
            _lkOverlaySyncTokens();
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
                    if (overlayMicState() !== 'off') { stopMic({ keepFlag: true }); resetUserResults(); }
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
    // The flat ribbon remains the lyrics-only fallback. Pitched songs use
    // the Karaoke Highway stage port below (#15), built incrementally over
    // this registration/lifecycle foundation.

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
        sungPart: 'primary',
        leftRailMode: 'absolute',
    });

    // Live renderer instances support provider playback ownership and the
    // shared microphone's eligible-panel selector. Every
    // piece of actual renderer state is panel-local, held in
    // `_createVizRenderer`'s closure — a shared module global would make
    // two splitscreen panels overwrite each other.
    const _vizInstances = new Set();

    let _vizOwnerSeq = 0;             // unique mic-owner ids per renderer instance

    function _vizEngineScoringDefaults() {
        return {
            tolerance: _lkPrefs.tolerance,
            octaveIndependent: _lkPrefs.octaveIndependent,
            micOffsetMs: _lkPrefs.micOffsetMs,
        };
    }

    // ── Shared microphone control (#11) ─────────────────────────────────
    //
    // ONE control for the ONE microphone, however many panels are live:
    // 🎤 toggle + input device + capture channel + a live status readout.
    // Mounted in v3's always-reachable plugin slot (docs/plugin-v3-ui.md),
    // falling back to #player-controls. Built only while a provider
    // instance is live and at least one wants mic feedback.
    //
    // The 🎤 click is the ONLY path to getUserMedia on the provider side —
    // nothing requests the microphone on load, on song change, or from a
    // restored setting. In splitscreen the user explicitly chooses which
    // eligible panel is scored; the selection never opens the microphone
    // unless capture is already active and the user changes that selector.
    let _vizMicUi = null;
    let _vizPreferredMicTarget = null;

    function _vizMicCandidates() {
        const out = [];
        for (const inst of _vizInstances) {
            if (inst.canScore()) out.push(inst);
        }
        return out;
    }

    function _vizMicTarget() {
        const candidates = _vizMicCandidates();
        if (_vizPreferredMicTarget && candidates.includes(_vizPreferredMicTarget)) {
            return _vizPreferredMicTarget;
        }
        _vizPreferredMicTarget = candidates.length ? candidates[0] : null;
        return _vizPreferredMicTarget;
    }

    function _vizMicOwnerInstance() {
        for (const inst of _vizInstances) {
            if (inst.ownsMic()) return inst;
        }
        return null;
    }

    function _vizMicSlot() {
        const ui = window.feedBack && window.feedBack.ui;
        if (ui && typeof ui.playerControlSlot === 'function') {
            try {
                const slot = ui.playerControlSlot();
                if (slot) return slot;
            } catch (_) { /* fall through to the legacy bar */ }
        }
        return (typeof document !== 'undefined' && document.getElementById)
            ? document.getElementById('player-controls')
            : null;
    }

    function _vizRemoveMicUi() {
        if (!_vizMicUi) return;
        if (_vizMicUi.unsubscribe) _vizMicUi.unsubscribe();
        const root = _vizMicUi.root;
        if (root && root.parentNode) root.parentNode.removeChild(root);
        _vizMicUi = null;
    }

    function _vizBuildMicUi(slot) {
        const root = document.createElement('span');
        root.id = 'lk-viz-mic';
        root.style.display = 'inline-flex';
        root.style.alignItems = 'center';
        root.style.gap = '4px';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '🎤';
        btn.addEventListener('click', _vizOnMicClick);

        const selectStyle = 'font-size:11px;max-width:9rem;background:#1f2937;color:#e5e7eb;'
            + 'border:1px solid #374151;border-radius:4px;padding:1px 2px;';
        const target = document.createElement('select');
        target.setAttribute('aria-label', 'Karaoke scoring panel');
        target.title = 'Which vocals panel the microphone scores';
        target.setAttribute('style', selectStyle);
        target.addEventListener('change', () => {
            const next = _vizMicCandidates().find((inst) => inst.micTargetId() === target.value);
            if (next) _vizSelectMicTarget(next, true);
        });

        const device = document.createElement('select');
        device.setAttribute('aria-label', 'Karaoke microphone input');
        device.title = 'Microphone input';
        device.setAttribute('style', selectStyle);
        device.addEventListener('change', () => {
            _lkMic.setDevice(device.value).then(() => _vizRefreshMicUi());
        });

        const channel = document.createElement('select');
        channel.setAttribute('aria-label', 'Karaoke microphone channel');
        channel.title = 'Which capture channel carries the mic on a multi-input interface';
        channel.setAttribute('style', selectStyle);
        [['mix', 'Mix'], ['1', 'Ch 1'], ['2', 'Ch 2']].forEach(([v, label]) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = label;
            channel.appendChild(opt);
        });
        channel.addEventListener('change', () => _lkMic.setChannel(channel.value));

        const statusEl = document.createElement('span');
        statusEl.className = 'fb-selectable';
        statusEl.setAttribute('aria-live', 'polite');
        statusEl.style.fontSize = '11px';
        statusEl.style.minWidth = '5rem';

        root.appendChild(btn);
        root.appendChild(target);
        root.appendChild(device);
        root.appendChild(channel);
        root.appendChild(statusEl);
        slot.appendChild(root);

        _vizMicUi = {
            root, btn, target, device, channel, statusEl,
            lastStatus: '',
            devicesKey: '',
            targetsKey: '',
            unsubscribe: _lkMic.subscribe(() => _vizRefreshMicUi()),
        };
        // Device labels only appear once permission is granted; re-list on
        // hot-plug. One page-lifetime listener, guarded against re-execution.
        const md = (typeof navigator !== 'undefined') ? navigator.mediaDevices : null;
        if (md && typeof md.addEventListener === 'function' && !window.__feedBackLyricsKaraokeDeviceWatch) {
            window.__feedBackLyricsKaraokeDeviceWatch = true;
            md.addEventListener('devicechange', () => _vizPopulateDevices());
        }
        _vizPopulateDevices();
    }

    function _vizPopulateDevices() {
        if (!_vizMicUi) return;
        const ui = _vizMicUi;
        _lkMic.listDevices().then((devices) => {
            if (_vizMicUi !== ui) return;
            const saved = _lkMic.getState().deviceId;
            const key = saved + '|' + devices.map((d) => d.deviceId + ':' + d.label).join('|');
            if (key === ui.devicesKey) return;
            ui.devicesKey = key;
            while (ui.device.firstChild) ui.device.removeChild(ui.device.firstChild);
            const def = document.createElement('option');
            def.value = '';
            def.textContent = 'Default mic';
            ui.device.appendChild(def);
            devices.forEach((d) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label;
                ui.device.appendChild(opt);
            });
            ui.device.value = saved;
            if (ui.device.value !== saved) ui.device.value = '';
        });
    }

    function _vizSetMicStatus(text) {
        if (!_vizMicUi || text === _vizMicUi.lastStatus) return;
        _vizMicUi.lastStatus = text;
        _vizMicUi.statusEl.textContent = text;
    }

    function _vizPopulateMicTargets() {
        if (!_vizMicUi) return;
        const ui = _vizMicUi;
        const candidates = _vizMicCandidates();
        const selected = _vizMicTarget();
        const key = candidates.map((inst) => inst.micTargetId() + ':' + inst.micTargetLabel()).join('|');
        if (key !== ui.targetsKey) {
            ui.targetsKey = key;
            while (ui.target.firstChild) ui.target.removeChild(ui.target.firstChild);
            candidates.forEach((inst) => {
                const opt = document.createElement('option');
                opt.value = inst.micTargetId();
                opt.textContent = inst.micTargetLabel();
                ui.target.appendChild(opt);
            });
        }
        ui.target.style.display = candidates.length > 1 ? '' : 'none';
        ui.target.disabled = candidates.length < 2;
        ui.target.value = selected ? selected.micTargetId() : '';
    }

    /** Choose the panel scored by the shared microphone. A user changing
     *  the selector while capture is live explicitly transfers capture:
     *  the old stream is fully released before the new owner may start. */
    function _vizSelectMicTarget(next, transferActive) {
        if (!_vizInstances.has(next) || !next.canScore()) return Promise.resolve(false);
        const owner = _vizMicOwnerInstance();
        _vizPreferredMicTarget = next;
        if (transferActive && owner && owner !== next) {
            owner.releaseMic();
            return _vizRequestMicWithSettle(next);
        }
        _vizRefreshMicUi();
        return Promise.resolve(true);
    }

    /** Request the mic for a transfer target. A release→re-grab inside the
     *  same tick can land a `NotReadableError` on Firefox — the device
     *  driver hasn't handed the mic back yet — and the old stream is already
     *  stopped, so without a retry the transfer would strand the panel at
     *  `error` with only a manual 🎤 re-click as recovery. Retry ONCE after a
     *  short settle; any other failure (permission, hardware) surfaces as-is. */
    function _vizRequestMicWithSettle(next) {
        return next.requestMic().then((ok) => {
            if (ok) return ok;
            const snap = _lkMic.getState();
            if (snap.state !== 'error' || !/in use or unavailable/i.test(snap.error)) return ok;
            return new Promise((resolve) => {
                setTimeout(() => resolve(next.requestMic()), _LK_MIC_TRANSFER_SETTLE_MS);
            });
        });
    }

    /** Per-frame from the owning panel's draw — a text diff, so the DOM is
     *  written only when the readout actually changes. */
    function _vizUpdateMicStatus(scorer) {
        if (!_vizMicUi) return;
        const snap = _lkMic.getState();
        if (snap.state !== 'listening') return;
        const last = scorer.lastSample();
        const fresh = !!last && (_wallNow() - last.wallAt) <= _LK_SAMPLE_FRESH_MS;
        const st = scorer.stats();
        const note = fresh ? midiToName(last.midi) : '—';
        const acc = st.accuracy === null ? '' : ' · ' + Math.round(st.accuracy * 100) + '%';
        const streak = st.streak > 1 ? ' · ×' + st.streak : '';
        _vizSetMicStatus(note + acc + streak);
    }

    function _vizSetMicButtonState(ui, disabled, className, title, status) {
        ui.btn.disabled = disabled;
        ui.btn.className = className;
        ui.btn.title = title;
        if (status !== undefined) _vizSetMicStatus(status);
    }

    function _vizApplyMicUiState(ui, snap, ours, busy, target) {
        ui.channel.value = snap.channel;
        ui.btn.setAttribute('aria-pressed', ours && snap.state !== 'error' ? 'true' : 'false');

        if (busy) {
            _vizSetMicButtonState(ui, true, BTN_CLASS_DISABLED,
                'The microphone is in use elsewhere', '');
            return;
        }
        if (ours && snap.state === 'requesting') {
            _vizSetMicButtonState(ui, true, BTN_CLASS_DISABLED,
                'Requesting microphone…', '…');
            return;
        }
        if (ours && (snap.state === 'listening' || snap.state === 'suspended')) {
            _vizSetMicButtonState(ui, false, BTN_CLASS_ACTIVE,
                'Stop microphone feedback',
                snap.state === 'suspended' ? 'paused' : undefined);
            _vizPopulateDevices();
            return;
        }
        if (snap.state === 'error' && snap.error) {
            _vizSetMicButtonState(ui, !target, BTN_CLASS_PROMPT,
                'Microphone error: ' + snap.error + ' (click to retry)', snap.error);
            return;
        }
        _vizSetMicButtonState(ui, !target, target ? BTN_CLASS_PROMPT : BTN_CLASS_DISABLED,
            target
                ? 'Sing along: start microphone pitch feedback (asks for permission)'
                : 'This part has no pitch to sing against',
            '');
    }

    function _vizRefreshMicUi() {
        let wanted = false;
        for (const inst of _vizInstances) {
            if (inst.getSetting('micFeedback') !== false) { wanted = true; break; }
        }
        if (!wanted || typeof document === 'undefined') { _vizRemoveMicUi(); return; }
        if (!_vizMicUi || !_vizMicUi.root.isConnected) {
            _vizRemoveMicUi();
            const slot = _vizMicSlot();
            if (!slot || typeof document.createElement !== 'function') return;
            _vizBuildMicUi(slot);
            if (!_vizMicUi) return;
        }
        const ui = _vizMicUi;
        const snap = _lkMic.getState();
        const ours = _vizMicOwnerInstance() !== null;
        const busy = !ours && snap.ownerId !== null
            && (snap.state === 'requesting' || snap.state === 'listening' || snap.state === 'suspended');
        const target = _vizMicTarget();
        _vizPopulateMicTargets();
        _vizApplyMicUiState(ui, snap, ours, busy, target);
        ui.btn.setAttribute('aria-label', ui.btn.title);
    }

    /** The 🎤 click: stop if a panel holds the mic, otherwise start it for
     *  the first panel that can score. Exported for tests. */
    function _vizOnMicClick() {
        const owner = _vizMicOwnerInstance();
        if (owner) {
            owner.releaseMic();
            _vizRefreshMicUi();
            return Promise.resolve(false);
        }
        const target = _vizMicTarget();
        if (!target) return Promise.resolve(false);
        return target.requestMic();
    }

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
        // Belt and braces: whatever state the overlay's toggle is in, its
        // microphone session ends here — the shared controller would refuse
        // a provider start while the overlay still held it.
        if (_lkMic.release(_lkOverlayOwner)) resetUserResults();
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

    /** The host's song_info payload provides the pack name in audio_url,
     *  not filename. Prefer the panel's own URL over the page-global song
     *  so panels with playable audio resolve their own lyrics. Adapted from the
     *  filename resolution proposed in #31 (2026-09-25). */
    function _vizResolveFilename(songInfo) {
        const audioUrl = songInfo && songInfo.audio_url;
        const match = typeof audioUrl === 'string'
            ? /(?:^|\/)api\/sloppak\/([^/]+)\/file\//.exec(audioUrl)
            : null;
        if (match) {
            try { return decodeURIComponent(match[1]); } catch (_) { /* try other identifiers */ }
        }
        if (songInfo && typeof songInfo.filename === 'string' && songInfo.filename) {
            return songInfo.filename;
        }
        const current = window.feedBack && window.feedBack.currentSong;
        return current && typeof current.filename === 'string' ? current.filename : null;
    }

    /** Identity of the (song, arrangement) pair a payload was loaded for.
     *  Used to notice a song switch or an in-place arrangement change
     *  without re-fetching on every frame. */
    function _vizSongKey(songInfo) {
        const filename = _vizResolveFilename(songInfo);
        if (!filename) return null;
        const idx = _vizArrangementIndex(songInfo);
        return `${filename}#${idx === null ? '' : idx}`;
    }

    /** Every voice in a `/playback` payload, normalized, dropping any that
     *  carry no usable tokens. The route owns manifest compatibility and
     *  translates the additive `vocal_tracks` extension into this canonical
     *  shape; the renderer deliberately consumes only `voices[]`. */
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

    /** The `primary` voice, or the first voice if none is flagged. This is
     *  the default a panel scores/draws before any explicit part selection;
     *  `_vizSelectedVoiceIndex` below layers the panel-local `sungPart`
     *  setting on top of it. */
    function _vizScoredIndex(voices) {
        if (!voices || !voices.length) return -1;
        const p = voices.findIndex((v) => v.primary);
        return p >= 0 ? p : 0;
    }

    /** Resolve the panel-local sung-part setting. Parts are ordered primary
     *  first, followed by the remaining payload order, so "Part 2" means
     *  the first harmony even when the primary track wasn't listed first. */
    function _vizSelectedVoiceIndex(voices, selected) {
        const primary = _vizScoredIndex(voices);
        if (primary < 0) return -1;
        const match = /^part([2-4])$/.exec(String(selected || ''));
        if (!match) return primary;
        const ordered = [primary];
        for (let i = 0; i < voices.length; i++) {
            if (i !== primary) ordered.push(i);
        }
        return ordered[Number(match[1]) - 1] ?? primary;
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

    function _vizSongEndAcrossVoices(voices) {
        let end = 0;
        for (const v of (voices || [])) {
            for (const tok of (v.tokens || [])) {
                const tokEnd = tok.start + (tok.duration || 0);
                if (tokEnd > end) end = tokEnd;
            }
        }
        return end;
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
    // portion, the sung-pitch trace, the top stats band) arrived with the
    // microphone consolidation in #11 and draw only while this panel is
    // scoring (`view.score`), in the band #15 reserved for them.

    // Violet note ramp — the lit-slab look. Deliberately outside the
    // red/amber/green accuracy family and the cool duet-guide hues.
    const STAGE_NOTE_TOP = '#f0e7ff';
    const STAGE_NOTE_MID = '#c084fc';
    const STAGE_NOTE_DEEP = '#7c3aed';
    const STAGE_NOTE_LOW = '#5b21b6';
    // Accuracy family (#11) — Karaoke Highway's COL_GREEN/AMBER/RED.
    const STAGE_ACC_GREEN = '#34d399';
    const STAGE_ACC_AMBER = '#e8c040';
    const STAGE_ACC_RED = '#f87171';
    const STAGE_STAT_TEXT = '#f4f4ff';
    const STAGE_STAT_LABEL = 'rgba(200,205,225,0.62)';
    const STAGE_TRACE_GAP_S = 0.2;   // break the sung trace across rests
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

    /** Continuous diatonic position, for a sung pitch that sits between
     *  semitones (the trace glides; the slabs snap). */
    function _vizDiaPosF(midi) {
        const lo = Math.floor(midi);
        const lp = _vizDiaPos(lo);
        return lp + (_vizDiaPos(lo + 1) - lp) * (midi - lo);
    }

    /** Red → amber → green by syllable accuracy (Karaoke Highway's ramp). */
    function _vizAccuracyRgb(acc) {
        if (acc < 0.5) {
            const k = acc / 0.5;
            return [248 - 16 * k, 113 + 79 * k, 113 - 49 * k];
        }
        const k = (acc - 0.5) / 0.5;
        return [232 - 180 * k, 192 + 19 * k, 64 + 89 * k];
    }

    /** Score / streak / accuracy across the reserved top band. */
    function _vizDrawStats(ctx2d, W, railW, top, bandH, u, score) {
        const st = score.stats;
        const live = score.live;
        const acc = st.accuracy;
        const accColor = acc === null ? STAGE_STAT_TEXT
            : acc >= 0.8 ? STAGE_ACC_GREEN : acc >= 0.5 ? STAGE_ACC_AMBER : STAGE_ACC_RED;
        const cells = [
            { label: 'SCORE', val: String(st.score), color: STAGE_STAT_TEXT },
            { label: 'STREAK', val: live ? String(st.streak) : 'best ' + st.bestStreak, color: STAGE_ACC_AMBER },
            { label: 'ACCURACY', val: acc === null ? '—' : Math.round(acc * 100) + '%', color: accColor },
        ];
        const cellW = 70 * u;
        const gap = 26 * u;
        const totalW = cells.length * cellW + (cells.length - 1) * gap;
        // Right-aligned so the duet "SING:" label on the left keeps its room.
        let x = Math.max(railW, W - totalW - 12 * u);
        const labelFont = Math.max(8, Math.round(9 * u)) + 'px sans-serif';
        const valFont = 'bold ' + Math.max(12, Math.round(17 * u)) + 'px sans-serif';
        ctx2d.textAlign = 'center';
        for (const c of cells) {
            const mid = x + cellW / 2;
            ctx2d.fillStyle = STAGE_STAT_LABEL;
            ctx2d.font = labelFont;
            ctx2d.textBaseline = 'top';
            ctx2d.fillText(c.label, mid, top + 3 * u);
            ctx2d.fillStyle = c.color;
            ctx2d.font = valFont;
            ctx2d.textBaseline = 'bottom';
            ctx2d.fillText(c.val, mid, top + bandH - 3 * u);
            x += cellW + gap;
        }
    }

    /** The sung-pitch history, left of the playhead, broken across rests. */
    function _vizDrawTrace(ctx2d, trace, now, xFor, yForF, railW, playheadX, noteTop, noteBottom, u) {
        const clampY = (v) => Math.max(noteTop + 3, Math.min(noteBottom - 3, v));
        ctx2d.strokeStyle = 'rgba(240,246,255,0.95)';
        ctx2d.lineWidth = Math.max(1.5, 3 * u);
        ctx2d.lineJoin = 'round';
        ctx2d.beginPath();
        let prevT = -Infinity;
        let drew = false;
        for (let i = 0; i < trace.length; i++) {
            const p = trace[i];
            if (p.t > now) break;
            const x = xFor(p.t);
            if (x < railW) { prevT = -Infinity; continue; }
            const y = clampY(yForF(p.midi));
            if (p.t - prevT > STAGE_TRACE_GAP_S) ctx2d.moveTo(Math.min(playheadX, x), y);
            else ctx2d.lineTo(Math.min(playheadX, x), y);
            prevT = p.t;
            drew = true;
        }
        if (drew) ctx2d.stroke();
    }

    function _vizDrawSummaryCard(ctx2d, W, H, railW, seamY, u, score) {
        if (!score || !score.finished || !score.stats || !score.stats.judged) return;
        const st = score.stats;
        const w = Math.min(260 * u, Math.max(170 * u, (W - railW) * 0.36));
        const h = 92 * u;
        const x = railW + (W - railW - w) / 2;
        const y = Math.max(56 * u, seamY - h - 22 * u);
        ctx2d.fillStyle = 'rgba(15,23,42,0.88)';
        _vizRoundRect(ctx2d, x, y, w, h, Math.max(8, 10 * u));
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.font = 'bold ' + Math.max(9, Math.round(11 * u)) + 'px sans-serif';
        ctx2d.fillStyle = STAGE_STAT_LABEL;
        ctx2d.fillText('SUMMARY', x + w / 2, y + 16 * u);
        ctx2d.font = 'bold ' + Math.max(18, Math.round(26 * u)) + 'px sans-serif';
        ctx2d.fillStyle = STAGE_STAT_TEXT;
        ctx2d.fillText(String(st.score), x + w / 2, y + 44 * u);
        ctx2d.font = 'bold ' + Math.max(8, Math.round(10 * u)) + 'px sans-serif';
        const acc = st.accuracy === null ? '--' : Math.round(st.accuracy * 100) + '%';
        ctx2d.fillStyle = st.accuracy !== null && st.accuracy >= 0.8 ? STAGE_ACC_GREEN
            : st.accuracy !== null && st.accuracy >= 0.5 ? STAGE_ACC_AMBER : STAGE_ACC_RED;
        ctx2d.fillText(acc + ' ACC / BEST ' + st.bestStreak, x + w / 2, y + 70 * u);
    }

    function _vizDrawAbsoluteRail(ctx2d, railW, noteTop, noteBottom, yFor, range, barH, u, score) {
        const pad = Math.max(3, 4 * u);
        const x = pad;
        const w = Math.max(16 * u, railW - pad * 2);
        ctx2d.fillStyle = 'rgba(15,23,42,0.74)';
        _vizRoundRect(ctx2d, x, noteTop, w, noteBottom - noteTop, Math.max(5, 7 * u));
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.font = 'bold ' + Math.max(8, Math.round(9 * u)) + 'px sans-serif';
        for (let m = range.midiLo; m <= range.midiHi; m++) {
            const natural = _vizIsNatural(m);
            const y = yFor(m) + barH / 2;
            ctx2d.strokeStyle = natural ? 'rgba(226,232,240,0.25)' : 'rgba(148,163,184,0.14)';
            ctx2d.beginPath();
            ctx2d.moveTo(x + (natural ? 2 : w * 0.36), y);
            ctx2d.lineTo(x + w - 2, y);
            ctx2d.stroke();
            if (natural) {
                ctx2d.fillStyle = 'rgba(226,232,240,0.78)';
                ctx2d.fillText(_vizMidiToName(m), x + w / 2, y);
            }
        }
        const trace = score && Array.isArray(score.trace) ? score.trace : [];
        if (trace.length) {
            const p = trace[trace.length - 1];
            const y = yFor(p.midi) + barH / 2;
            ctx2d.fillStyle = '#f8fafc';
            ctx2d.beginPath();
            ctx2d.arc(x + w / 2, Math.max(noteTop + 4, Math.min(noteBottom - 4, y)), Math.max(3, 4 * u), 0, Math.PI * 2);
            ctx2d.fill();
        }
    }

    function _vizDrawTechniqueRail(ctx2d, railW, noteTop, topStatsH, u, score) {
        const st = score && score.stats ? score.stats : null;
        const accuracy = st && st.accuracy !== null ? st.accuracy : 0;
        const streak = st ? st.streak : 0;
        const x = Math.max(3, 4 * u);
        const w = Math.max(18 * u, railW - x * 2);
        const h = Math.max(72 * u, topStatsH * 2.2);
        const y = noteTop + 8 * u;
        ctx2d.fillStyle = 'rgba(15,23,42,0.78)';
        _vizRoundRect(ctx2d, x, y, w, h, Math.max(5, 7 * u));
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.font = 'bold ' + Math.max(7, Math.round(8 * u)) + 'px sans-serif';
        const labelX = x + w / 2;
        const cells = [
            ['PITCH', accuracy >= 0.8 ? 'LOCK' : accuracy >= 0.5 ? 'HOLD' : 'FIND',
                accuracy >= 0.8 ? STAGE_ACC_GREEN : accuracy >= 0.5 ? STAGE_ACC_AMBER : STAGE_ACC_RED],
            ['RUN', streak ? String(streak) : '-', STAGE_STAT_TEXT],
        ];
        for (let i = 0; i < cells.length; i++) {
            const cy = y + (i + 0.5) * h / cells.length;
            ctx2d.fillStyle = STAGE_STAT_LABEL;
            ctx2d.fillText(cells[i][0], labelX, cy - 8 * u);
            ctx2d.fillStyle = cells[i][2];
            ctx2d.fillText(cells[i][1], labelX, cy + 7 * u);
        }
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

    function _vizLyricFillStyle(primary, tok, now) {
        if (!primary) return STAGE_LYRIC_SECONDARY;
        if (tok.start + (tok.duration || 0) <= now) return BAR_COLOR_FILL;
        if (tok.start <= now) return '#ffffff';
        return TEXT_COLOR_PAST;
    }

    function _vizTrackLyricPosition(state, primary, tok, now, center) {
        if (!primary || !tok) return;
        if (tok.start <= now) state.lastX = center;
        if (tok.start <= now && now < tok.start + (tok.duration || 0)) {
            state.activeX = center;
        }
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
        const x0 = areaX + (areaW - total) / 2;
        let x = x0;
        const position = { activeX: null, lastX: null };
        for (let p = 0; p < line.parts.length; p++) {
            const part = line.parts[p];
            const tok = tokens[part.idx];
            const text = piece(part, p);
            ctx2d.fillStyle = _vizLyricFillStyle(primary, tok, now);
            ctx2d.fillText(text, x, y);
            const w = ctx2d.measureText(text).width;
            _vizTrackLyricPosition(position, primary, tok, now, x + w / 2);
            x += w;
        }
        if (position.activeX === null) position.activeX = position.lastX;
        return { x0, x1: x, activeX: position.activeX };
    }

    /** Median syllable spacing folded into a beat-like range. The playback
     *  contract carries no BPM, so the cue uses this stable song-level
     *  estimate instead of changing tempo with each lyric line. */
    function _vizComputeCueBeat(tokens) {
        const diffs = [];
        for (let i = 1; i < tokens.length; i++) {
            const d = tokens[i].start - tokens[i - 1].start;
            if (d > 0.08 && d < 3) diffs.push(d);
        }
        let beat = 0.5;
        if (diffs.length) {
            diffs.sort((a, b) => a - b);
            beat = diffs[Math.floor(diffs.length / 2)];
        }
        while (beat < 0.4) beat *= 2;
        while (beat > 0.9) beat /= 2;
        return beat;
    }

    /** Karaoke Highway phase-2 cue: bounce beneath the active syllable, or
     *  beneath a numeric get-ready countdown during a real silent lead-in. */
    function _vizDrawLyricCue(ctx2d, line, li, lines, now, info, fontPx, cy, railW, u, cue) {
        if (!cue) return;
        const gapStart = li > 0 ? lines[li - 1].t1 : 0;
        const remain = line.t0 - now;
        let target = null;
        let countdown = false;
        if (now < line.t0 && line.t0 - gapStart >= 2 && remain > 0 && remain <= 20) {
            target = Math.max(railW + fontPx * 0.8, info.x0 - fontPx * 1.3);
            countdown = true;
        } else if (info.activeX !== null) {
            target = info.activeX;
        }
        if (target === null) {
            cue.ballX = null;
            return;
        }
        cue.ballX = cue.ballX === null ? target : cue.ballX + (target - cue.ballX) * 0.18;
        if (countdown) {
            ctx2d.fillStyle = 'rgba(120,210,255,0.95)';
            ctx2d.font = 'bold ' + Math.round(fontPx * 1.1) + 'px sans-serif';
            ctx2d.textAlign = 'center';
            ctx2d.textBaseline = 'middle';
            ctx2d.fillText(remain.toFixed(1), target, cy);
        }
        const beat = cue.beat || 0.5;
        const bounce = Math.abs(Math.sin(Math.PI * (now - line.t0) / beat));
        const ballY = cy + fontPx * 0.8 - fontPx * 0.28 * bounce;
        const radius = Math.max(3, fontPx * 0.16);
        ctx2d.save();
        ctx2d.shadowColor = 'rgba(150,210,255,0.85)';
        ctx2d.shadowBlur = 6 * u;
        ctx2d.fillStyle = '#eaf4ff';
        ctx2d.beginPath();
        ctx2d.arc(cue.ballX, ballY, radius, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.restore();
    }

    /** The lyric band below the seam: current line, dim next-line preview,
     *  bouncing syllable cue, and silent-lead-in countdown (#15 phase 2). */
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

    function _vizDrawLyricBand(ctx2d, tokens, lines, now, railW, W, H, seamY, u, cue) {
        if (!lines || !lines.length) return;
        const li = _vizActiveLyricLineIndex(lines, now);
        if (li >= lines.length) return;
        const cy = seamY + (H - seamY) * 0.20;
        const fontPx = Math.max(16, Math.round(Math.min(36 * u, 44)));
        const areaX = railW;
        const areaW = W - railW;
        const info = _vizDrawLyricLine(ctx2d, tokens, lines[li], now,
            areaX, areaW, fontPx, cy, true);
        if (li + 1 < lines.length) {
            _vizDrawLyricLine(ctx2d, tokens, lines[li + 1], now, areaX, areaW,
                Math.max(12, Math.round(fontPx * 0.55)), cy + fontPx * 1.4, false);
        }
        _vizDrawLyricCue(ctx2d, lines[li], li, lines, now, info,
            fontPx, cy, railW, u, cue);
    }

    function _vizDrawSelectedVoiceLabel(ctx2d, voices, scoredIdx, railW, wallTop, topStatsH, u) {
        if (voices.length <= 1 || !voices[scoredIdx]) return;
        const selected = voices[scoredIdx];
        ctx2d.fillStyle = 'rgba(216,180,254,0.9)';
        ctx2d.font = 'bold ' + Math.max(9, Math.round(11 * u)) + 'px sans-serif';
        ctx2d.textAlign = 'left';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText('SING: ' + String(selected.name || selected.id).toUpperCase(),
            railW + 8 * u, wallTop + topStatsH / 2);
    }

    function _vizStageLayout(W, H, view, now) {
        const u = H / STAGE_REF_HEIGHT;
        const wallTop = 8 * u;
        // Reserved for the score / streak / accuracy band (#11). Kept at the
        // reference's height so adding it later doesn't move the notes.
        const topStatsH = 42 * u;
        const seamY = Math.round(H * STAGE_SEAM_FRAC);
        const railMode = view.leftRailMode || 'absolute';
        const railW = railMode === 'off' ? Math.round(10 * u) : Math.round(74 * u);
        const noteTop = wallTop + topStatsH;
        const noteBottom = seamY;
        const dHi = view.range.dHi;
        const dSpan = Math.max(1, dHi - view.range.dLo);
        const usable = noteBottom - noteTop;
        const barH = Math.max(8, Math.min((usable / dSpan) * 0.86, 40 * u));
        const pxPerSec = W / VISIBLE_SECONDS;
        const playheadX = railW + (W - railW) * STAGE_PLAYHEAD_FRAC;
        const lookbehind = view.maxDuration > 0 ? view.maxDuration : 0;
        const tMin = now - STAGE_PLAYHEAD_FRAC * VISIBLE_SECONDS - 1;
        const tMax = now + (1 - STAGE_PLAYHEAD_FRAC) * VISIBLE_SECONDS + 1;
        return {
            u,
            wallTop,
            topStatsH,
            seamY,
            railMode,
            railW,
            noteTop,
            noteBottom,
            dHi,
            dSpan,
            usable,
            barH,
            playheadX,
            tMin,
            tMax,
            windowStart: tMin - lookbehind,
            pad: 2 * u,
            radius: 6 * u,
            xFor: (t) => playheadX + (t - now) * pxPerSec,
            yFor: (m) => noteTop + ((dHi - _vizDiaPos(m)) / dSpan) * (usable - barH),
        };
    }

    function _vizDrawStageBackdrop(ctx2d, W, view, layout, score) {
        const wg = ctx2d.createLinearGradient(0, 0, 0, layout.seamY);
        wg.addColorStop(0, STAGE_WALL_TOP);
        wg.addColorStop(1, STAGE_WALL_BOTTOM);
        ctx2d.fillStyle = wg;
        ctx2d.fillRect(0, 0, W, layout.seamY);
        _vizDrawSelectedVoiceLabel(ctx2d, view.voices, view.scoredIdx,
            layout.railW, layout.wallTop, layout.topStatsH, layout.u);
        if (score) _vizDrawStats(ctx2d, W, layout.railW, layout.wallTop, layout.topStatsH, layout.u, score);
    }

    function _vizDrawStageLanes(ctx2d, W, range, layout) {
        ctx2d.lineWidth = 1;
        ctx2d.font = Math.max(8, Math.round(9 * layout.u)) + 'px sans-serif';
        ctx2d.textAlign = 'left';
        ctx2d.textBaseline = 'middle';
        for (let m = range.midiLo; m <= range.midiHi; m++) {
            if (!_vizIsNatural(m)) continue;
            const y = layout.yFor(m) + layout.barH / 2;
            ctx2d.strokeStyle = STAGE_LANE;
            ctx2d.beginPath();
            ctx2d.moveTo(layout.railW, y);
            ctx2d.lineTo(W, y);
            ctx2d.stroke();
            if (layout.railMode !== 'off' && layout.railMode !== 'absolute') {
                ctx2d.fillStyle = STAGE_LANE_LABEL;
                ctx2d.fillText(_vizMidiToName(m), layout.railW + 5 * layout.u, y);
            }
        }
    }

    function _vizDrawStageRail(ctx2d, range, layout, score) {
        if (layout.railMode === 'absolute') {
            _vizDrawAbsoluteRail(ctx2d, layout.railW, layout.noteTop, layout.noteBottom,
                layout.yFor, range, layout.barH, layout.u, score);
            return;
        }
        if (layout.railMode === 'technique') {
            _vizDrawTechniqueRail(ctx2d, layout.railW, layout.noteTop,
                layout.topStatsH, layout.u, score);
        }
    }

    function _vizDrawGuideVoice(ctx2d, voice, colorIndex, layout) {
        const guideH = Math.max(3, layout.barH * 0.4);
        const guideR = Math.min(layout.radius, guideH / 2);
        ctx2d.fillStyle = STAGE_VOICE_COLORS[colorIndex];
        let gi = _vizLowerBound(voice.tokens, layout.windowStart);
        for (; gi < voice.tokens.length; gi++) {
            const gt = voice.tokens[gi];
            if (gt.start > layout.tMax) break;
            if (gt.midi === null) continue;
            if (gt.start + gt.duration < layout.tMin) continue;
            const gx0 = layout.xFor(gt.start);
            const gw = Math.max(2, layout.xFor(gt.start + gt.duration) - gx0 - 2 * layout.pad);
            const gy = layout.yFor(gt.midi) + (layout.barH - guideH) / 2;
            _vizRoundRect(ctx2d, gx0 + layout.pad, gy, gw, guideH, guideR);
        }
    }

    function _vizDrawGuideVoices(ctx2d, voices, scoredIdx, layout) {
        if (voices.length <= 1) return;
        // ── Duet guides: every voice EXCEPT the scored one ──
        for (let vi = 0; vi < voices.length; vi++) {
            if (vi === scoredIdx) continue;
            // Index the palette by position among the GUIDES, so the first
            // guide is always teal whichever voice is scored.
            const ci = (vi > scoredIdx ? vi - 1 : vi) % STAGE_VOICE_COLORS.length;
            _vizDrawGuideVoice(ctx2d, voices[vi], ci, layout);
        }
    }

    function _vizApplyScoredSlabGradient(ctx2d, y, isActive, isPast, barH, u) {
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
    }

    function _vizDrawScoredSlabTint(ctx2d, slab, entry, layout) {
        const tintRight = Math.max(slab.x, Math.min(slab.x + slab.w, layout.playheadX));
        if (!entry || entry.samplesIn <= 0 || tintRight <= slab.x) return;
        const [cr, cg, cb] = _vizAccuracyRgb(entry.accuracy);
        const lift = (v) => Math.round(v + (255 - v) * 0.5);
        const ag = ctx2d.createLinearGradient(0, slab.y, 0, slab.y + layout.barH);
        ag.addColorStop(0, `rgb(${lift(cr)}, ${lift(cg)}, ${lift(cb)})`);
        ag.addColorStop(1, `rgb(${Math.round(cr * 0.8)}, ${Math.round(cg * 0.8)}, ${Math.round(cb * 0.8)})`);
        ctx2d.fillStyle = ag;
        _vizRoundRect(ctx2d, slab.x, slab.y, tintRight - slab.x, layout.barH, layout.radius);
    }

    function _vizDrawScoredSlab(ctx2d, tok, index, now, layout, score) {
        const end = tok.start + tok.duration;
        const x0 = layout.xFor(tok.start);
        const slab = {
            x: x0 + layout.pad,
            y: layout.yFor(tok.midi),
            w: Math.max(2, layout.xFor(end) - x0 - 2 * layout.pad),
        };
        const isPast = end <= now;
        const isActive = tok.start <= now && now < end;

        _vizApplyScoredSlabGradient(ctx2d, slab.y, isActive, isPast, layout.barH, layout.u);
        _vizRoundRect(ctx2d, slab.x, slab.y, slab.w, layout.barH, layout.radius);
        ctx2d.shadowBlur = 0;

        // Accuracy tint over the sung portion (left of the playhead), between
        // the slab and the gloss so it reads lit, not flat — and opaque, so
        // the violet can't muddy red/amber to purple.
        if (score && (isPast || isActive)) {
            _vizDrawScoredSlabTint(ctx2d, slab, score.resultFor(index), layout);
        }

        ctx2d.fillStyle = isActive ? 'rgba(255,255,255,0.85)' : 'rgba(235,230,255,0.30)';
        _vizRoundRect(ctx2d, slab.x + 2 * layout.u, slab.y + 1.5 * layout.u,
            Math.max(1, slab.w - 4 * layout.u), 2.5 * layout.u, 1.5 * layout.u);
    }

    function _vizDrawScoredSlabs(ctx2d, tokens, now, layout, score) {
        // ── Scored voice: violet lit slabs ──
        let i = _vizLowerBound(tokens, layout.windowStart);
        for (; i < tokens.length; i++) {
            const tok = tokens[i];
            if (tok.start > layout.tMax) break;
            if (tok.midi === null) continue;
            if (tok.start + tok.duration < layout.tMin) continue;
            _vizDrawScoredSlab(ctx2d, tok, i, now, layout, score);
        }
    }

    function _vizDrawStageTrace(ctx2d, score, now, layout) {
        if (!score || !score.trace.length) return;
        const yForF = (m) => layout.noteTop
            + ((layout.dHi - _vizDiaPosF(m)) / layout.dSpan) * (layout.usable - layout.barH)
            + layout.barH / 2;
        _vizDrawTrace(ctx2d, score.trace, now, layout.xFor, yForF, layout.railW,
            layout.playheadX, layout.noteTop, layout.noteBottom, layout.u);
    }

    function _vizDrawStagePlayhead(ctx2d, layout) {
        ctx2d.strokeStyle = STAGE_PLAYHEAD;
        ctx2d.lineWidth = Math.max(1.5, 2 * layout.u);
        ctx2d.beginPath();
        ctx2d.moveTo(layout.playheadX, layout.noteTop - 6 * layout.u);
        ctx2d.lineTo(layout.playheadX, layout.seamY);
        ctx2d.stroke();
    }

    /** The perspective stage: note wall, diatonic lanes, horizon seam,
     *  duet guide bars, violet note slabs, playhead, lyric band.
     *
     *  No DOM reads or shared module state: the only animation state is the
     *  panel-local `view.cue`. The draw stays unit-testable and windowed per
     *  frame — `tokens` is
     *  start-sorted, so each voice is entered at a lower bound and left on
     *  the first token past the right edge. `lookbehind` is the song's
     *  longest token so a note held across the window's left edge still
     *  draws. */
    function _vizDrawStage(ctx2d, W, H, view, now) {
        const layout = _vizStageLayout(W, H, view, now);
        const score = view.score || null;

        ctx2d.clearRect(0, 0, W, H);
        ctx2d.save();
        ctx2d.beginPath();
        ctx2d.rect(0, 0, W, H);
        ctx2d.clip();

        _vizDrawStageBackdrop(ctx2d, W, view, layout, score);
        _vizDrawStageLanes(ctx2d, W, view.range, layout);
        _vizDrawStageRail(ctx2d, view.range, layout, score);
        _vizDrawSeam(ctx2d, W, layout.seamY, layout.u);
        _vizDrawGuideVoices(ctx2d, view.voices, view.scoredIdx, layout);
        _vizDrawScoredSlabs(ctx2d, view.tokens, now, layout, score);
        _vizDrawStageTrace(ctx2d, score, now, layout);
        _vizDrawStagePlayhead(ctx2d, layout);
        _vizDrawLyricBand(ctx2d, view.tokens, view.lines, now,
            layout.railW, W, H, layout.seamY, layout.u, view.cue);
        if (score) _vizDrawSummaryCard(ctx2d, W, H, layout.railW, layout.seamY, layout.u, score);

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
        let songEnd = 0;
        const cue = { beat: 0.5, ballX: null }; // panel-local animation state
        const panelNumber = ++_vizOwnerSeq;
        let micSongLabel = 'Vocals';
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
        // Scoring keys start from the engine preferences (which carry any
        // migrated Karaoke Highway calibration); the host's persisted
        // per-panel values arrive through applySetting and win.
        const settings = Object.assign({}, VIZ_SETTING_DEFAULTS, _vizEngineScoringDefaults());

        // ── Microphone scoring (#11) — all panel-local ──
        const scorer = _lkCreateVocalScorer(settings);
        // Panel clock: splitscreen panels run their own highways, so mic
        // frames are dated against THIS panel's last drawn time, advanced
        // by wall time (capped: a hidden panel stops drawing, its clock
        // freezes, and the scorer's stall gate then drops the frames).
        // The wall anchor only moves when song time does, so a paused
        // song reads as a frozen clock rather than jittering forward.
        let clockT = 0;
        let clockWallAt = 0;
        let canvasRef = null;
        let visibilityHandler = null;
        const micOwner = {
            id: 'viz-' + panelNumber,
            getClock() {
                if (!clockWallAt) return clockT;
                const elapsed = Math.min(0.2, Math.max(0, (_wallNow() - clockWallAt) / 1000));
                return clockT + elapsed * getPlaybackRate();
            },
            onFrame(frame) { scorer.ingest(frame); },
        };

        function releaseMic() {
            if (_lkMic.release(micOwner)) _vizRefreshMicUi();
        }

        function selectVoice() {
            scoredIdx = _vizSelectedVoiceIndex(voices, settings.sungPart);
            tokens = scoredIdx >= 0 ? voices[scoredIdx].tokens : [];
            // A different part is a different take: results never carry over.
            scorer.setTokens(tokens);
            stageRange = voices.length > 1
                ? _vizSharedDiatonicRange(voices)
                : _vizDiatonicRange(tokens);
            lines = _vizBuildLines(tokens);
            maxDuration = _vizMaxDurationAcrossVoices(voices);
            songEnd = _vizSongEndAcrossVoices(voices);
            cue.beat = _vizComputeCueBeat(tokens);
            cue.ballX = null;
        }

        function abortInflight() {
            if (abortCtl) {
                try { abortCtl.abort(); } catch (_) { /* noop */ }
                abortCtl = null;
            }
            requestedKey = null;
        }

        function clearData() {
            // A song or arrangement change must never resurrect old scores,
            // and the microphone needs a fresh explicit start per song.
            releaseMic();
            scorer.setTokens([]);
            clockT = 0;
            clockWallAt = 0;
            tokens = [];
            voices = [];
            scoredIdx = -1;
            stageRange = null;
            lines = null;
            maxDuration = 0;
            songEnd = 0;
            cue.beat = 0.5;
            cue.ballX = null;
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
            const filename = _vizResolveFilename(songInfo);
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
                const name = String(filename || '').split(/[\\/]/).pop();
                micSongLabel = name
                    ? name.replace(/\.(?:feedpak|sloppak)$/i, '')
                    : 'Vocals';
                selectVoice();
                loadedKey = key;
                _vizRefreshMicUi();   // the 🎤 target may only now exist
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

        function syncSong(bundle) {
            // Song/arrangement switch: notice it here (core hands the live
            // songInfo every frame) and kick a non-blocking load.
            const key = _vizSongKey(bundle.songInfo);
            if (!key || key === loadedKey) return;
            if (loadedKey !== null) clearData();
            load(bundle.songInfo);
        }

        function syncClock(now) {
            if (now === clockT) return;
            clockT = now;
            clockWallAt = _wallNow();
        }

        function scoringView(live, now) {
            // Scoring layers only while this panel is (or was) scoring — a
            // panel that never sang stays clean.
            if (!live && !scorer.hasResults()) return null;
            return {
                live,
                finished: songEnd > 0 && now >= songEnd,
                stats: scorer.stats(),
                resultFor: scorer.resultFor,
                trace: scorer.trace(),
            };
        }

        function drawStageFrame(W, H, now) {
            const live = _lkMic.isOwnedBy(micOwner);
            _vizDrawStage(ctx2d, W, H, {
                range: stageRange,
                voices,
                scoredIdx,
                tokens,
                lines,
                maxDuration,
                cue,
                leftRailMode: settings.leftRailMode,
                score: scoringView(live, now),
            }, now);
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

                // May be a fresh element after a context-type swap.
                canvasRef = canvas;
                const bus = window.feedBack;
                if (!visibilityHandler && bus && typeof bus.on === 'function') {
                    // Hidden panel → stop processing frames but keep the
                    // device (suspend); shown again → resume. Filtered by
                    // canvas so splitscreen panels don't toggle each other.
                    visibilityHandler = (e) => {
                        const d = e && e.detail;
                        if (!d || d.canvas !== canvasRef || !_lkMic.isOwnedBy(micOwner)) return;
                        if (d.visible) _lkMic.resume();
                        else _lkMic.suspend();
                    };
                    bus.on('highway:visibility', visibilityHandler);
                }
                _vizRefreshMicUi();

                if (bundle && bundle.songInfo) load(bundle.songInfo);
            },

            draw(bundle) {
                if (destroyed || !ctx2d || !bundle) return;
                syncSong(bundle);
                const now = (typeof bundle.currentTime === 'number') ? bundle.currentTime : 0;
                syncClock(now);
                if (_lkMic.isOwnedBy(micOwner)) _vizUpdateMicStatus(scorer);

                const W = ctx2d.canvas ? ctx2d.canvas.width : 0;
                const H = ctx2d.canvas ? ctx2d.canvas.height : 0;
                if (!W || !H) return;

                if (stageRange) {
                    drawStageFrame(W, H, now);
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
                resetLoadState();   // also releases the mic via clearData()
                releaseMic();       // …and again, in case no data was ever loaded
                scorer.reset();
                ctx2d = null;
                canvasRef = null;
                if (visibilityHandler) {
                    const bus = window.feedBack;
                    if (bus && typeof bus.off === 'function') bus.off('highway:visibility', visibilityHandler);
                    visibilityHandler = null;
                }
                _vizInstances.delete(this);
                _vizRefreshMicUi();
                // Last one out hands playback back to whoever we displaced.
                if (wasInitialized) _vizReleasePlaybackOwnership();
            },

            // Per-instance settings (feedBack#849). The host renders these
            // from the manifest and owns persistence; `applySetting` is
            // REQUIRED of any provider that declares a settings list.
            applySetting(key, value) {
                if (!Object.prototype.hasOwnProperty.call(VIZ_SETTING_DEFAULTS, key)) return false;
                settings[key] = value;
                if (key === 'sungPart' && voices.length) {
                    // New part, new take: stop scoring the old one's mic too.
                    releaseMic();
                    selectVoice();
                    _vizRefreshMicUi();
                }
                if (key === 'tolerance' || key === 'octaveIndependent' || key === 'micOffsetMs') {
                    // Live, no reset: calibrating mid-take is the point.
                    scorer.setSettings({ [key]: value });
                    // Also the default for new panels and the legacy overlay.
                    _lkUpdatePrefs({ [key]: scorer.getSettings()[key] });
                }
                if (key === 'micFeedback') {
                    if (value === false) releaseMic();
                    _vizRefreshMicUi();
                }
                if (key === 'leftRailMode') {
                    if (value !== 'absolute' && value !== 'technique' && value !== 'off') {
                        settings[key] = VIZ_SETTING_DEFAULTS.leftRailMode;
                    }
                }
                return true;
            },

            getSetting(key) {
                return Object.prototype.hasOwnProperty.call(settings, key)
                    ? settings[key]
                    : undefined;
            },

            // ── Not part of the setRenderer contract (#11) ──
            // Read by the shared mic control and by #15's score UI.
            getScoreStats() { return scorer.stats(); },
            getScoreResult(i) { return scorer.resultFor(i); },
            getSungTrace() { return scorer.trace(); },
            /** Whether this panel can score: mic feedback on and a pitched part. */
            canScore() {
                if (settings.micFeedback === false || destroyed || !initialized) return false;
                for (const tok of tokens) if (tok.midi !== null) return true;
                return false;
            },
            /** Explicit-action entry point: callers wire this to a click. */
            requestMic() {
                if (!this.canScore()) return Promise.resolve(false);
                const p = _lkMic.start(micOwner);
                _vizRefreshMicUi();
                return p.then((ok) => { _vizRefreshMicUi(); return ok; });
            },
            releaseMic() { releaseMic(); },
            ownsMic() { return _lkMic.isOwnedBy(micOwner); },
            micTargetId() { return micOwner.id; },
            micTargetLabel() {
                const voice = scoredIdx >= 0 && voices[scoredIdx]
                    ? (voices[scoredIdx].name || voices[scoredIdx].id || 'Vocals')
                    : 'Vocals';
                return micSongLabel + ' — ' + voice + ' · Panel ' + panelNumber;
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
            _vizResolveFilename,
            _vizNormalizeVoices,
            _vizScoredIndex,
            _vizSelectedVoiceIndex,
            _vizNormalizeTokens,
            _vizDiaPos,
            _vizIsNatural,
            _vizMidiToName,
            _vizDiatonicRange,
            _vizSharedDiatonicRange,
            _vizBuildLines,
            _vizActiveLyricLineIndex,
            _vizComputeCueBeat,
            _vizDrawStage,
            _vizDrawSummaryCard,
            _vizDrawAbsoluteRail,
            _vizDrawTechniqueRail,
            stripSyllableMarker,
            _vizPitchRange,
            _vizMaxDuration,
            _vizMaxDurationAcrossVoices,
            _vizSongEndAcrossVoices,
            _vizLowerBound,
            _percentilePitchRange,
            computeSongPitchRange,
            _vizOwnsPlayback,
            _vizDrawFrame,
            setKaraokeMode,
            _karaokeModeForTest: () => karaokeMode,
            // #11 vocal pitch engine
            yinDetect,
            freqToMidi,
            midiToName,
            _lkDetectMidi,
            _lkPitchDistance,
            _lkPitchMatches,
            _lkFrameMidpointTime,
            _lkApplyMicOffset,
            _lkNormalizeScoringSettings,
            _lkNormalizeChannel,
            _lkSelectChannel,
            _lkLoadPrefs,
            _lkCreateVocalScorer,
            _lkCreateMicController,
            _lkMic,
            _lkOverlayOwner,
            _vizOnMicClick,
            _vizMicTarget,
            _vizSelectMicTarget,
        };
    }
})();
