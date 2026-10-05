/**
 * Stub-host tests for the visualization provider (#14).
 *
 * Covers the cases the issue asks for: create, repeated create, destroy,
 * song switch, failed data load, unsupported host, and two simultaneous
 * instances — plus Auto-mode selection and the payload-shaping helpers.
 * The tail covers #45, the capabilities the Karaoke button's ribbon absorbs
 * from the highway renderer (duet guides, the get-ready cue, the shared
 * accuracy ramp), driven through the real draw with a canvas handed in
 * directly in place of showOverlay()'s host DOM.
 *
 * No real FeedBack host and no DOM: screen.js is loaded against the stubs
 * below, with its bootstrap guard pre-set so `init()` (which wants a real
 * document) never runs. Run with `node tests/screen.test.js`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ── Host stubs ──────────────────────────────────────────────────────────

/** Minimal `window.feedBack` event bus: emit/on, recording every event so
 *  tests can assert on renderer-ready / renderer-failed payloads. */
function makeBus() {
    const events = [];
    const listeners = new Map();
    return {
        events,
        emit(name, detail) {
            events.push({ name, detail });
            for (const fn of listeners.get(name) || []) fn({ detail });
        },
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
        of(name) {
            return events.filter((e) => e.name === name);
        },
        reset() {
            events.length = 0;
        },
    };
}

function makeCanvas(opts) {
    const o = opts || {};
    const ctx = {
        canvas: null,
        calls: [],
        // Recorded per-draw geometry, so tests can assert WHERE things
        // landed (lane/guide/slab placement) rather than only that some
        // drawing happened.
        rects: [],
        texts: [],
        gradients: [],
        fills: [],
        arcs: [],
        clearRect() { this.calls.push('clearRect'); },
        fillRect(x, y, w, h) {
            this.calls.push('fillRect');
            this.rects.push({ x, y, w, h, fill: this._fill });
        },
        fillText(t, x, y) {
            this.calls.push('fillText');
            this.texts.push({ t: String(t), x, y, fill: this._fill });
        },
        measureText(t) { return { width: String(t).length * 6 }; },
        save() { this.calls.push('save'); },
        restore() { this.calls.push('restore'); },
        beginPath() {},
        closePath() {},
        rect() {},
        clip() {},
        moveTo() {},
        lineTo() {},
        arc(x, y, r) { this.calls.push('arc'); this.arcs.push({ x, y, r }); },
        arcTo() {},
        quadraticCurveTo() {},
        stroke() { this.calls.push('stroke'); },
        fill() { this.calls.push('fill'); this.fills.push(this._fill); },
        createLinearGradient() {
            const g = { stops: [], addColorStop(o2, c) { this.stops.push([o2, c]); } };
            ctx.gradients.push(g);
            return g;
        },
        // Captured so tests can assert the per-syllable / per-slab colour
        // state, not merely that something was painted.
        _fill: null,
        set fillStyle(v) { this._fill = v; },
        get fillStyle() { return this._fill; },
    };
    const canvas = {
        width: o.width === undefined ? 800 : o.width,
        height: o.height === undefined ? 140 : o.height,
        getContext(type) {
            if (o.contextFails) return null;
            if (type !== '2d') return null;
            ctx.canvas = canvas;
            return ctx;
        },
    };
    canvas._ctx = ctx;
    return canvas;
}

const bus = makeBus();
let fetchImpl = null;   // set per-test

global.window = {
    // Pre-set so the IIFE's DOMContentLoaded/init() bootstrap is skipped.
    __feedBackLyricsKaraokeHooksInstalled: true,
    feedBack: bus,
    addEventListener() {},
    devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
global.document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {} }),
};
global.localStorage = global.window.localStorage;
global.fetch = (url, opts) => fetchImpl(url, opts);

const screen = require('../screen.js');

// Node's require() natively loads and parses a .json file (Module._extensions
// caches the result), so this needs no fs.readFileSync/JSON.parse pair at
// all — and, like the screen.js require above, a literal relative path here
// resolves against THIS file's directory regardless of cwd, sidestepping the
// portability trap a bare fs.readFileSync(...) literal would hit (tests run
// as `node tests/screen.test.js` from the repo root, so fs.* — unlike
// require() — would resolve a literal against that cwd, not this file's
// location).
const PLUGIN_MANIFEST = require('../plugin.json');

/** Flush the fire-and-forget load chain (fetch -> .then -> emit). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function okPayload(tokens, extra) {
    return Object.assign({
        schema_version: 1,
        song: { filename: 'song.sloppak' },
        arrangement: { index: 0, id: 'vocals', name: 'Vocals' },
        voices: [{ id: 'primary', name: 'Vocals', primary: true, tokens: tokens }],
    }, extra || {});
}

function jsonFetch(body, status) {
    return () => Promise.resolve({
        text: () => Promise.resolve(JSON.stringify(body)),
        ok: status === undefined ? true : status < 400,
        status: status === undefined ? 200 : status,
    });
}

function bundle(over) {
    return Object.assign({
        currentTime: 1.0,
        // Shaped like the `song_info` message ws_highway.py actually sends:
        // `audio_url` and NO `filename`, so the default fixture exercises the
        // branch that runs in production rather than one that can't occur.
        songInfo: {
            audio_url: '/api/sloppak/song.sloppak/file/stems/vocals.ogg',
            arrangement_index: 0,
            arrangement: 'Vocals',
        },
    }, over || {});
}

// ── Registration ────────────────────────────────────────────────────────

test('registers the factory on both the feedBack and legacy globals', () => {
    assert.strictEqual(typeof window.feedBackViz_lyrics_karaoke, 'function');
    assert.strictEqual(window.slopsmithViz_lyrics_karaoke, window.feedBackViz_lyrics_karaoke);
    assert.strictEqual(window.feedBackViz_lyrics_karaoke.contextType, '2d');
});

test('registration is idempotent across a plugin reload', () => {
    const first = window.feedBackViz_lyrics_karaoke;
    assert.strictEqual(screen._registerVizProvider(), false);
    assert.strictEqual(window.feedBackViz_lyrics_karaoke, first);
});

test('the factory returns a fresh instance per call', () => {
    const a = window.feedBackViz_lyrics_karaoke();
    const b = window.feedBackViz_lyrics_karaoke();
    assert.notStrictEqual(a, b);
});

// ── Picker visibility retired (#44) ─────────────────────────────────────
//
// Core builds its viz picker's candidate list from `/api/plugins`
// filtered on `type === 'visualization'`, and its Auto pass walks that
// same list looking for a `matchesArrangement` predicate. Retiring the
// picker entry therefore means BOTH halves are gone: the manifest no
// longer declares `type`, and the factory publishes no predicate, so
// Auto has nothing left to match. Splitscreen's per-panel dropdown
// filters that same `type` field, so discovery goes there too on the
// normal path — its `feedBackViz_` / `slopsmithViz_` prefixes are how it
// RESOLVES an already-known id, not how it finds one. (Its registry-fetch
// failure fallback re-scans `window` for those prefixes instead, which is
// the one route by which it can still list this plugin.)

test('the manifest declares no viz type and no visualization capability', () => {
    assert.strictEqual(PLUGIN_MANIFEST.type, undefined);
    assert.strictEqual(
        (PLUGIN_MANIFEST.capabilities || {}).visualization, undefined,
        'capabilities.visualization still declares provider roles/settings',
    );
    // Everything else the host reads off the manifest is untouched.
    assert.strictEqual(PLUGIN_MANIFEST.id, 'lyrics_karaoke');
    assert.strictEqual(PLUGIN_MANIFEST.minHost, '0.3.0-alpha.1');
});

test('the factory publishes no Auto-mode predicate', () => {
    assert.strictEqual(
        typeof window.feedBackViz_lyrics_karaoke.matchesArrangement, 'undefined',
    );
    assert.strictEqual(
        typeof window.slopsmithViz_lyrics_karaoke.matchesArrangement, 'undefined',
    );
    assert.strictEqual(screen._vizMatchesArrangement, undefined);
});

test('either factory prefix still yields a setRenderer-shaped renderer', () => {
    // Dropping the picker entry must not disturb the install contract.
    // Splitscreen turns a viz id into a factory by probing these two
    // prefixes in order — the path a panel with a saved viz preference
    // (`splitscreenPanelPrefs[].arrName` == `__viz__:lyrics_karaoke:<arr
    // name>`) still takes — and hands whatever it gets to
    // `panel.hw.setRenderer()`, which rejects a factory that lacks the
    // lifecycle surface.
    const PREFIXES = ['feedBackViz_', 'slopsmithViz_'];
    for (const prefix of PREFIXES) {
        const factory = window[prefix + 'lyrics_karaoke'];
        assert.strictEqual(typeof factory, 'function', prefix);
        const r = factory();
        for (const method of ['init', 'draw', 'destroy', 'applySetting', 'getSetting']) {
            assert.strictEqual(typeof r[method], 'function', `${prefix}.${method}`);
        }
        assert.strictEqual(r.getSetting('micFeedback'), true, prefix);
    }
});

// ── Payload helpers ─────────────────────────────────────────────────────

test('normalizes tokens and preserves unpitched syllables', () => {
    const toks = screen._vizNormalizeTokens({
        tokens: [
            { start: 1, duration: 0.5, text: 'hel', midi: 60 },
            { start: 1.5, duration: 0.5, text: 'lo' },          // lyrics-only
            { start: 'nope', duration: 1, text: 'x' },           // dropped
            { start: 2, duration: -1, text: 'neg' },             // duration clamped
        ],
    });
    assert.strictEqual(toks.length, 3);
    assert.strictEqual(toks[0].midi, 60);
    assert.strictEqual(toks[1].midi, null);
    assert.strictEqual(toks[2].duration, 0);
});

test('pitch range is null for lyrics-only content', () => {
    assert.strictEqual(screen._vizPitchRange([{ start: 0, duration: 1, text: 'a', midi: null }]), null);
    const r = screen._vizPitchRange([
        { start: 0, duration: 1, text: 'a', midi: 60 },
        { start: 1, duration: 1, text: 'b', midi: 62 },
    ]);
    assert.ok(r.hi - r.lo >= 7, 'never collapses flatter than a fifth');
});

// ── Lifecycle: create / repeated create / destroy ───────────────────────

test('create loads the canonical payload and emits renderer-ready', async () => {
    bus.reset();
    const urls = [];
    fetchImpl = (url) => { urls.push(url); return jsonFetch(okPayload([
        { start: 1, duration: 0.5, text: 'hel', midi: 60 },
    ]))(); };

    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();

    assert.match(urls[0], /\/api\/plugins\/lyrics_karaoke\/playback\?filename=song\.sloppak&arrangement=0$/);
    const ready = bus.of('lyrics_karaoke:renderer-ready');
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].detail.pluginId, 'lyrics_karaoke');
    assert.strictEqual(ready[0].detail.tokens, 1);
    assert.strictEqual(ready[0].detail.pitched, true);
    r.destroy();
});

test('resolves the host song_info audio URL without a filename', async () => {
    bus.reset();
    const urls = [];
    fetchImpl = (url) => {
        urls.push(url);
        return jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'hi', midi: 60 }]))();
    };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle({ songInfo: {
        audio_url: '/api/sloppak/My%20Song.feedpak/file/stems/full.wav',
        arrangement_index: 0, arrangement: 'Vocals',
    } }));
    await flush();
    assert.match(urls[0], /playback\?filename=My%20Song\.feedpak&arrangement=0$/);
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 1);
    r.destroy();
});

test('a /file/ inside the stem path does not end the pack name', () => {
    // The pack segment is quoted with safe="" (never a raw '/'); the stem
    // path keeps its slashes, so it can itself contain '/file/'.
    assert.strictEqual(
        screen._vizResolveFilename({ audio_url: '/api/sloppak/x.feedpak/file/stems/file/Lead.wav' }),
        'x.feedpak',
    );
});

test('a non-sloppak audio_url names no pack', () => {
    // Loose-folder / archive sources serve a cache artifact that is not the
    // pack name, so it must not resolve to one.
    assert.strictEqual(
        screen._vizResolveFilename({ audio_url: '/audio/audio_Song_abc123.mp3' }),
        null,
    );
});

test('an unresolvable song keys null and never fetches from a cold panel', async () => {
    // The real, narrow trigger: this renderer's very FIRST song_info, before
    // any highway anywhere on the page (main or another panel) has ever set
    // window.feedBack.currentSong. Once anything has loaded once, currentSong
    // is a live host's fallback for almost any source (see the "the fallback
    // covers a warm panel" test below), so pin that precondition explicitly
    // rather than relying on the stub's ambient default.
    bus.reset();
    assert.strictEqual(window.feedBack.currentSong, undefined);
    const urls = [];
    fetchImpl = (url) => { urls.push(url); return jsonFetch(okPayload([]))(); };
    const unresolvable = { audio_url: '/audio/audio_Song_abc123.mp3', arrangement: 'Vocals' };

    assert.strictEqual(screen._vizSongKey(unresolvable), null);

    const r = window.feedBackViz_lyrics_karaoke();
    try {
        r.init(makeCanvas(), bundle({ songInfo: unresolvable }));
        r.draw(bundle({ songInfo: unresolvable }));
        await flush();

        assert.deepStrictEqual(urls, []);
        const failed = bus.of('lyrics_karaoke:renderer-failed');
        assert.strictEqual(failed.length, 1);
        assert.strictEqual(failed[0].detail.reason, 'unresolvable-filename');
        // Matches the documented renderer-failed shape (docs/architecture/
        // vocals-visualization-integration.md): {reason, filename,
        // arrangementIndex, status?, message?} — a consumer written to that
        // shape must not read undefined for a reason it's never seen before.
        assert.strictEqual(failed[0].detail.filename, null);
        assert.strictEqual(failed[0].detail.arrangementIndex, null);
        assert.strictEqual(typeof failed[0].detail.message, 'string');

        // Repeated draws with the same unresolvable songInfo must not re-fire —
        // this is a "don't spin" gate, same reasoning as failedKey for a real 404.
        r.draw(bundle({ songInfo: unresolvable }));
        r.draw(bundle({ songInfo: unresolvable }));
        await flush();
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 1);

        // But a NEW unresolvable streak (a resolvable song loaded and cleared
        // the gate in between) must re-fire — otherwise a user's second
        // unresolvable song of the session goes silent for the rest of it,
        // the exact failure this signal exists to prevent.
        fetchImpl = () => jsonFetch(okPayload([
            { start: 1, duration: 0.5, text: 'hi', midi: 60 },
        ]))();
        const resolvable = { audio_url: '/api/sloppak/song.sloppak/file/stems/full.wav' };
        r.draw(bundle({ songInfo: resolvable }));
        await flush();
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 1,
            'a resolvable song must not itself emit renderer-failed');

        r.draw(bundle({ songInfo: unresolvable }));
        await flush();
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 2,
            'a second, later unresolvable streak must re-fire, not stay silent');
    } finally {
        r.destroy();
    }
});

test('the currentSong fallback keeps a warm panel resolving once anything has loaded', async () => {
    // A previously-loaded song sets currentSong the way a real host would
    // (main highway, or another panel — never this renderer itself). Once
    // that's set, an ambiguous audio_url does NOT go null: it resolves via
    // currentSong and reloads normally. The null-key clear path in syncSong
    // is therefore NOT what protects a warm panel — this fallback is. A
    // fixture that leaves currentSong unset here would be the same
    // wire-impossible shape flagged in review.
    bus.reset();
    const previousCurrentSong = window.feedBack.currentSong;
    window.feedBack.currentSong = { filename: 'song.sloppak' };
    const urls = [];
    fetchImpl = (url) => { urls.push(url); return jsonFetch(okPayload([
        { start: 1, duration: 0.5, text: 'staleword', midi: 60 },
    ]))(); };
    const canvas = makeCanvas();
    const r = window.feedBackViz_lyrics_karaoke();
    try {
        r.init(canvas, bundle());
        await flush();
        r.draw(bundle());
        const drew = () => canvas._ctx.texts.some((t) => t.t.includes('staleword'));
        assert.ok(drew(), 'the loaded song draws its lyrics');

        const ambiguous = { audio_url: '/audio/audio_Song_abc123.mp3', arrangement: 'Vocals' };
        assert.notStrictEqual(screen._vizSongKey(ambiguous), null,
            'currentSong fallback must resolve this, not go null');
        canvas._ctx.texts.length = 0;
        r.draw(bundle({ songInfo: ambiguous }));
        await flush();

        // A reload through the fallback, not the null-key clear path: a
        // second /playback fetch for the SAME resolved filename.
        assert.strictEqual(urls.length, 2, 'the fallback triggers an ordinary reload, not a null-key clear');
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 0);
    } finally {
        window.feedBack.currentSong = previousCurrentSong;
        r.destroy();
    }
});

test('a null key aborts an in-flight load so its stale response cannot land', async () => {
    // Pins the one line review flagged as uncovered: abortInflight() inside
    // the null-key branch. Precondition matches the real trigger above —
    // currentSong unset, so this is this renderer's very first song_info.
    bus.reset();
    assert.strictEqual(window.feedBack.currentSong, undefined);
    let resolveFetch = null;
    fetchImpl = () => new Promise((res) => { resolveFetch = res; });

    const r = window.feedBackViz_lyrics_karaoke();
    try {
        r.init(makeCanvas(), bundle());   // starts a load; fetch is now in flight
        await flush();
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 0, 'load has not resolved yet');

        const unresolvable = { audio_url: '/audio/audio_Song_abc123.mp3', arrangement: 'Vocals' };
        r.draw(bundle({ songInfo: unresolvable }));

        // The stale fetch resolves after the abort. Without abortInflight()
        // (or without the loadSeq/destroyed guard it relies on), this would
        // still land as a renderer-ready with the dropped song's tokens.
        resolveFetch({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify(okPayload([
                { start: 1, duration: 0.5, text: 'stale', midi: 60 },
            ]))),
        });
        await flush();

        assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 0,
            'the aborted load must not resolve into a ready event');
    } finally {
        r.destroy();
    }
});

test('each panel resolves its own filename ahead of the global song', () => {
    const previous = window.feedBack.currentSong;
    window.feedBack.currentSong = { filename: 'global.feedpak' };
    try {
        assert.strictEqual(screen._vizResolveFilename({
            audio_url: '/api/sloppak/panel.feedpak/file/stems/full.wav',
            arrangement_index: 1,
        }), 'panel.feedpak');
        assert.strictEqual(screen._vizResolveFilename({ filename: 'explicit.feedpak' }), 'explicit.feedpak');
        assert.strictEqual(screen._vizResolveFilename({}), 'global.feedpak');
    } finally {
        window.feedBack.currentSong = previous;
    }
});

test('repeated init on one instance does not stack state or refetch per frame', async () => {
    bus.reset();
    let calls = 0;
    fetchImpl = () => { calls++; return jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'a', midi: 60 }]))(); };

    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    r.init(makeCanvas(), bundle());   // re-init without an intervening destroy
    await flush();

    assert.strictEqual(calls, 2, 'each init loads once');
    // Drawing many frames must not trigger further loads.
    for (let i = 0; i < 20; i++) r.draw(bundle({ currentTime: i * 0.1 }));
    await flush();
    assert.strictEqual(calls, 2);
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 0);
    r.destroy();
});

test('an instance survives destroy -> init (playSong reuses the canvas)', async () => {
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'a', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    r.destroy();
    r.init(makeCanvas(), bundle());
    await flush();
    const canvas = makeCanvas();
    r.init(canvas, bundle());
    await flush();
    r.draw(bundle());
    assert.ok(canvas._ctx.calls.includes('clearRect'), 'draws after re-init');
    r.destroy();
});

test('draw after destroy is a no-op', async () => {
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'a', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas();
    r.init(canvas, bundle());
    await flush();
    r.destroy();
    canvas._ctx.calls.length = 0;
    r.draw(bundle());
    assert.deepStrictEqual(canvas._ctx.calls, []);
});

test('a load resolving after destroy paints nothing and emits nothing', async () => {
    bus.reset();
    let resolveFetch = null;
    fetchImpl = () => new Promise((res) => { resolveFetch = res; });

    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    r.destroy();
    resolveFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]))),
    });
    await flush();

    assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 0);
});

// ── Song switch ─────────────────────────────────────────────────────────

test('a song switch reloads and does not keep the previous song tokens', async () => {
    bus.reset();
    const urls = [];
    fetchImpl = (url) => {
        urls.push(url);
        return jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'a', midi: 60 }]))();
    };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();

    r.draw(bundle({ songInfo: { audio_url: '/api/sloppak/other.sloppak/file/stems/vocals.ogg', arrangement_index: 0, arrangement: 'Vocals' } }));
    await flush();

    assert.strictEqual(urls.length, 2);
    assert.match(urls[1], /filename=other\.sloppak/);
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 2);
    r.destroy();
});

test('an arrangement switch on the same song reloads with the new index', async () => {
    const urls = [];
    fetchImpl = (url) => { urls.push(url); return jsonFetch(okPayload([]))(); };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    r.draw(bundle({ songInfo: { audio_url: '/api/sloppak/song.sloppak/file/stems/vocals.ogg', arrangement_index: 2, arrangement: 'Vocals' } }));
    await flush();
    assert.strictEqual(urls.length, 2);
    assert.match(urls[1], /&arrangement=2$/);
    r.destroy();
});

test('a song with no arrangement index omits the query param', async () => {
    const urls = [];
    fetchImpl = (url) => { urls.push(url); return jsonFetch(okPayload([]))(); };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle({ songInfo: { audio_url: '/api/sloppak/song.sloppak/file/stems/vocals.ogg', arrangement: 'Vocals' } }));
    await flush();
    assert.ok(!urls[0].includes('arrangement='), urls[0]);
    r.destroy();
});

// ── Failed data load ────────────────────────────────────────────────────

test('a 404 payload emits renderer-failed with actionable context', async () => {
    bus.reset();
    fetchImpl = jsonFetch({ error: 'No lyrics data' }, 404);
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();

    const failed = bus.of('lyrics_karaoke:renderer-failed');
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].detail.reason, 'playback-unavailable');
    assert.strictEqual(failed[0].detail.status, 404);
    assert.strictEqual(failed[0].detail.message, 'No lyrics data');
    assert.strictEqual(failed[0].detail.filename, 'song.sloppak');
    r.destroy();
});

test('a network error emits renderer-failed and keeps drawing safe', async () => {
    bus.reset();
    fetchImpl = () => Promise.reject(new Error('offline'));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas();
    r.init(canvas, bundle());
    await flush();

    const failed = bus.of('lyrics_karaoke:renderer-failed');
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].detail.reason, 'playback-fetch-error');
    assert.doesNotThrow(() => r.draw(bundle()));
    r.destroy();
});

test('a 422 corrupt-pack payload is reported, not swallowed', async () => {
    bus.reset();
    fetchImpl = jsonFetch({ error: 'Malformed lyrics.json' }, 422);
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed')[0].detail.status, 422);
    r.destroy();
});

// ── Unsupported host ────────────────────────────────────────────────────

test('init without a usable canvas fails loudly instead of throwing', async () => {
    bus.reset();
    fetchImpl = jsonFetch(okPayload([]));
    const r = window.feedBackViz_lyrics_karaoke();
    assert.doesNotThrow(() => r.init(null, bundle()));
    const failed = bus.of('lyrics_karaoke:renderer-failed');
    assert.strictEqual(failed[0].detail.reason, 'no-canvas');
    assert.match(failed[0].detail.message, /legacy karaoke overlay/);
    // A failed init must not claim playback ownership.
    assert.strictEqual(screen._vizOwnsPlayback(), false);
    assert.doesNotThrow(() => r.draw(bundle()));
    assert.doesNotThrow(() => r.destroy());
});

test('a canvas locked to another context type fails cleanly', () => {
    bus.reset();
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas({ contextFails: true }), bundle());
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed')[0].detail.reason, 'no-2d-context');
    assert.strictEqual(screen._vizOwnsPlayback(), false);
    r.destroy();
});

test('a host with no event bus still initializes', async () => {
    const saved = window.feedBack;
    delete window.feedBack;
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 0, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        const canvas = makeCanvas();
        assert.doesNotThrow(() => r.init(canvas, bundle()));
        await flush();
        assert.doesNotThrow(() => r.draw(bundle()));
        r.destroy();
    } finally {
        window.feedBack = saved;
    }
});

// ── Two simultaneous instances (splitscreen) ────────────────────────────

test('two instances render independently from their own payloads', async () => {
    bus.reset();
    fetchImpl = (url) => jsonFetch(url.includes('other.sloppak')
        ? okPayload([{ start: 1, duration: 1, text: 'b', midi: 72 }])
        : okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]))();

    const a = window.feedBackViz_lyrics_karaoke();
    const b = window.feedBackViz_lyrics_karaoke();
    const ca = makeCanvas();
    const cb = makeCanvas();
    a.init(ca, bundle());
    b.init(cb, bundle({ songInfo: { audio_url: '/api/sloppak/other.sloppak/file/stems/vocals.ogg', arrangement_index: 1, arrangement: 'Vocals' } }));
    await flush();

    assert.strictEqual(screen._vizOwnsPlayback(), true);
    a.draw(bundle());
    b.draw(bundle({ songInfo: { audio_url: '/api/sloppak/other.sloppak/file/stems/vocals.ogg', arrangement_index: 1, arrangement: 'Vocals' } }));
    assert.ok(ca._ctx.calls.includes('fillText'));
    assert.ok(cb._ctx.calls.includes('fillText'));

    // Destroying one leaves the other live and still owning playback.
    a.destroy();
    assert.strictEqual(screen._vizOwnsPlayback(), true);
    cb._ctx.calls.length = 0;
    b.draw(bundle({ songInfo: { audio_url: '/api/sloppak/other.sloppak/file/stems/vocals.ogg', arrangement_index: 1, arrangement: 'Vocals' } }));
    assert.ok(cb._ctx.calls.length > 0, 'surviving instance still draws');

    b.destroy();
    assert.strictEqual(screen._vizOwnsPlayback(), false);
});

test('per-instance settings do not leak between instances', () => {
    const a = window.feedBackViz_lyrics_karaoke();
    const b = window.feedBackViz_lyrics_karaoke();
    assert.strictEqual(a.getSetting('tolerance'), screen.VIZ_SETTING_DEFAULTS.tolerance);
    assert.strictEqual(a.applySetting('tolerance', 3), true);
    assert.strictEqual(a.getSetting('tolerance'), 3);
    assert.strictEqual(b.getSetting('tolerance'), screen.VIZ_SETTING_DEFAULTS.tolerance);
});

test('applySetting rejects keys the manifest does not declare', () => {
    const r = window.feedBackViz_lyrics_karaoke();
    assert.strictEqual(r.applySetting('__proto__', 'nope'), false);
    assert.strictEqual(r.applySetting('unknownKey', 1), false);
    assert.strictEqual(r.getSetting('unknownKey'), undefined);
});

test('leftRailMode falls back on unknown values', () => {
    const r = window.feedBackViz_lyrics_karaoke();
    assert.strictEqual(r.applySetting('leftRailMode', 'technique'), true);
    assert.strictEqual(r.getSetting('leftRailMode'), 'technique');
    assert.strictEqual(r.applySetting('leftRailMode', 'mystery'), true);
    assert.strictEqual(r.getSetting('leftRailMode'), 'absolute');
});

// ── Rendering ───────────────────────────────────────────────────────────

test('lyrics-only content still renders text with no pitch bars', () => {
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    screen._vizDrawFrame(ctx, 800, 140, [
        { start: 1, duration: 0.5, text: 'lo', midi: null },
    ], 1.0, null);
    assert.ok(ctx.calls.includes('fillText'), 'lyrics still drawn');
});

test('draw skips a zero-sized canvas', async () => {
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas({ width: 0, height: 0 });
    r.init(canvas, bundle());
    await flush();
    canvas._ctx.calls.length = 0;
    r.draw(bundle());
    assert.deepStrictEqual(canvas._ctx.calls, []);
    r.destroy();
});

// ── Manifest / renderer agreement ───────────────────────────────────────

test('applySetting backs every key the renderer defaults', () => {
    // The manifest no longer declares a settings list (#44), so nothing
    // drives applySetting from the host's picker UI any more — but the
    // renderer still honours the contract (feedBack#849), because
    // splitscreen persists per-panel values and calls it directly, and
    // #32's later sub-issues re-home these controls into the karaoke UI.
    const r = window.feedBackViz_lyrics_karaoke();
    const keys = Object.keys(screen.VIZ_SETTING_DEFAULTS);
    assert.ok(keys.length > 0);
    for (const key of keys) {
        const def = screen.VIZ_SETTING_DEFAULTS[key];
        assert.strictEqual(
            r.applySetting(key, def), true,
            `applySetting rejected defaulted key ${key}`,
        );
        assert.strictEqual(r.getSetting(key), def, `default drifted for ${key}`);
    }
});

test('the preparation surface survives retiring the viz picker entry', () => {
    // #44 took away the second role's picker visibility, not the plugin.
    assert.strictEqual(PLUGIN_MANIFEST.screen, 'screen.html');
    assert.ok(PLUGIN_MANIFEST.nav && PLUGIN_MANIFEST.nav.label);
    assert.strictEqual(PLUGIN_MANIFEST.routes, 'routes.py');
    assert.strictEqual(PLUGIN_MANIFEST.script, 'screen.js');
});

// ── Regression: a failed load must not refetch on every frame ───────────

test('a 404 is not refetched once per frame while the user sits on the song', async () => {
    bus.reset();
    let calls = 0;
    fetchImpl = () => { calls++; return jsonFetch({ error: 'No lyrics data' }, 404)(); };

    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    assert.strictEqual(calls, 1);

    // An unprepared song is the NORMAL state, and `draw` sees "no data for
    // this key" every frame — it must not turn that into a fetch storm.
    for (let i = 0; i < 120; i++) r.draw(bundle({ currentTime: i / 60 }));
    await flush();

    assert.strictEqual(calls, 1, 'refetched after a failure');
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 1);
    r.destroy();
});

test('a failure on one song does not block loading the next', async () => {
    let calls = 0;
    fetchImpl = (url) => {
        calls++;
        return url.includes('good.sloppak')
            ? jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]))()
            : jsonFetch({ error: 'No lyrics data' }, 404)();
    };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    r.draw(bundle({ songInfo: { audio_url: '/api/sloppak/good.sloppak/file/stems/vocals.ogg', arrangement_index: 0, arrangement: 'Vocals' } }));
    await flush();
    assert.strictEqual(calls, 2);
    bus.reset();
    r.draw(bundle({ songInfo: { audio_url: '/api/sloppak/good.sloppak/file/stems/vocals.ogg', arrangement_index: 0, arrangement: 'Vocals' } }));
    assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 0);
    r.destroy();
});

test('re-init retries a song whose load previously failed', async () => {
    let calls = 0;
    fetchImpl = () => { calls++; return jsonFetch({ error: 'No lyrics data' }, 404)(); };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    r.destroy();
    r.init(makeCanvas(), bundle());
    await flush();
    assert.strictEqual(calls, 2, 're-init should retry, not inherit the failure');
    r.destroy();
});

// ── Regression: windowed draw must not drop long held notes ─────────────

test('lowerBound finds the first token at or after a time', () => {
    const toks = [0, 1, 2, 3, 4].map((s) => ({ start: s, duration: 0.1, text: 's', midi: 60 }));
    assert.strictEqual(screen._vizLowerBound(toks, -1), 0);
    assert.strictEqual(screen._vizLowerBound(toks, 2), 2);
    assert.strictEqual(screen._vizLowerBound(toks, 2.5), 3);
    assert.strictEqual(screen._vizLowerBound(toks, 99), toks.length);
    assert.strictEqual(screen._vizLowerBound([], 1), 0);
});

test('maxDuration spans the whole song', () => {
    assert.strictEqual(screen._vizMaxDuration([]), 0);
    assert.strictEqual(screen._vizMaxDuration([
        { start: 0, duration: 0.2 }, { start: 1, duration: 9.5 }, { start: 2, duration: 0.3 },
    ]), 9.5);
});

test('a held note that started before the window is still drawn', () => {
    // The whole point of the lookbehind: this token starts 8s before `now`
    // but sustains across the playhead. A naive lower-bound cull at the
    // window edge would skip it.
    const tokens = [
        { start: 0, duration: 20, text: 'aaah', midi: 60 },
        { start: 30, duration: 0.2, text: 'later', midi: 62 },
    ];
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    screen._vizDrawFrame(ctx, 800, 140, tokens, 8.0, { lo: 57, hi: 64 }, 20);
    assert.ok(ctx.calls.includes('fillText'), 'held note culled by the window');
});

test('the lookbehind still applies on lyrics-only songs (null pitch range)', () => {
    const tokens = [{ start: 0, duration: 20, text: 'aaah', midi: null }];
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    screen._vizDrawFrame(ctx, 800, 140, tokens, 8.0, null, 20);
    assert.ok(ctx.calls.includes('fillText'), 'lyrics-only held note culled');
});

test('the windowed loop stops early instead of walking the whole song', () => {
    // 20k tokens, all far past the window: a full scan would touch every
    // one. Assert the visible-window work is bounded by counting draws.
    const tokens = [];
    for (let i = 0; i < 20000; i++) {
        tokens.push({ start: 100 + i, duration: 0.2, text: 't', midi: 60 });
    }
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    screen._vizDrawFrame(ctx, 800, 140, tokens, 0, { lo: 57, hi: 64 }, 0.2);
    // clearRect + background fillRect + playhead fillRect, and nothing else.
    assert.deepStrictEqual(ctx.calls, ['clearRect', 'fillRect', 'fillRect']);
});

// ── Auto-mode collision surface (#10 asked for this to be re-verified) ──
//
// Retiring the Auto predicate (#44) settles the collision this section was
// written to guard: Staff View's predicate is a bare
// `!!songInfo.has_notation`, so with no predicate of our own there is
// nothing for it to win or lose against, on any arrangement.

test('a notation-only vocals chart still renders (lyrics are song-level)', async () => {
    // Unlike Piano Highway, this provider decodes nothing from guitar-wire
    // notes, so it has no reason to yield on a notation-only arrangement:
    // /playback serves song-level lyrics either way.
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'ah', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas();
    r.init(canvas, bundle({
        songInfo: {
            audio_url: '/api/sloppak/song.sloppak/file/stems/vocals.ogg', arrangement_index: 0,
            arrangement: 'Vocals', has_notation: true,
        },
    }));
    await flush();
    r.draw(bundle({
        songInfo: {
            audio_url: '/api/sloppak/song.sloppak/file/stems/vocals.ogg', arrangement_index: 0,
            arrangement: 'Vocals', has_notation: true,
        },
    }));
    assert.ok(canvas._ctx.calls.includes('fillText'));
    r.destroy();
});

// ── note_detect ownership handshake ─────────────────────────────────────

/** Stub note_detect's public surface: the singleton plus the factory's
 *  setDefaultSuppressed handshake.
 *
 *  `omitHandshake` models a legacy build (no setDefaultSuppressed, i.e.
 *  below the 1.15.2 coexistence floor); `probes: false` models a legacy
 *  build that exposes neither isEnabled() nor wantsDetect(), so idleness
 *  cannot be proven; `throwOnProbe` models one whose probe throws. */
function installNoteDetect(opts) {
    const o = opts || {};
    const log = { suppressed: [], enabled: 0, disabled: 0 };
    window.noteDetect = {
        enable() { log.enabled++; return Promise.resolve(); },
        disable() { log.disabled++; },
    };
    if (o.probes !== false) {
        window.noteDetect.wantsDetect = () => !!o.wantsDetect;
        window.noteDetect.isEnabled = () => {
            if (o.throwOnProbe) throw new Error('probe boom');
            return !!o.isEnabled;
        };
    }
    window.createNoteDetector = function () { return {}; };
    if (!o.omitHandshake) {
        window.createNoteDetector.setDefaultSuppressed = (v) => {
            if (o.throwOnSuppress) throw new Error('boom');
            log.suppressed.push(!!v);
        };
    }
    return log;
}

function removeNoteDetect() {
    delete window.noteDetect;
    delete window.createNoteDetector;
}

test('taking over playback suppresses note_detect\'s default singleton', async () => {
    const log = installNoteDetect({ wantsDetect: false });
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        r.init(makeCanvas(), bundle());
        await flush();
        assert.deepStrictEqual(log.suppressed, [true], 'must suppress on claim');
        r.destroy();
        assert.deepStrictEqual(log.suppressed, [true, false], 'must un-suppress on release');
        assert.strictEqual(log.enabled, 0, 'must not enable a detector the user had off');
    } finally {
        removeNoteDetect();
    }
});

test('a detector the user had ON is handed back on release', async () => {
    const log = installNoteDetect({ wantsDetect: true, isEnabled: true });
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        r.init(makeCanvas(), bundle());
        await flush();
        r.destroy();
        await flush();
        assert.deepStrictEqual(log.suppressed, [true, false]);
        assert.strictEqual(log.enabled, 1, 'suppression only blocks future auto-enables');
    } finally {
        removeNoteDetect();
    }
});

test('two panels suppress once and restore once, not per panel', async () => {
    const log = installNoteDetect({ wantsDetect: true });
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const a = window.feedBackViz_lyrics_karaoke();
        const b = window.feedBackViz_lyrics_karaoke();
        a.init(makeCanvas(), bundle());
        b.init(makeCanvas(), bundle());
        await flush();
        assert.deepStrictEqual(log.suppressed, [true], 'second panel must not re-suppress');

        a.destroy();
        assert.deepStrictEqual(log.suppressed, [true], 'must not restore while a panel is live');
        assert.strictEqual(log.enabled, 0);

        b.destroy();
        await flush();
        assert.deepStrictEqual(log.suppressed, [true, false], 'last one out restores');
        assert.strictEqual(log.enabled, 1);
    } finally {
        removeNoteDetect();
    }
});

test('re-init keeps playback ownership while replacing an in-flight load', async () => {
    bus.reset();
    const log = installNoteDetect({ wantsDetect: true });
    let finishFirst;
    const requests = [];
    fetchImpl = (url, opts) => {
        requests.push({ url, signal: opts && opts.signal });
        if (requests.length === 1) {
            return new Promise((resolve) => { finishFirst = resolve; });
        }
        return jsonFetch(okPayload([{ start: 1, duration: 1, text: 'new', midi: 60 }]))();
    };
    const r = window.feedBackViz_lyrics_karaoke();
    try {
        const oldCanvas = makeCanvas();
        const newCanvas = makeCanvas();
        r.init(oldCanvas, bundle());
        r.init(newCanvas, bundle({ songInfo: {
            audio_url: '/api/sloppak/new.sloppak/file/stems/vocals.ogg', arrangement_index: 0, arrangement: 'Vocals',
        } }));
        assert.strictEqual(requests[0].signal.aborted, true, 'old load must be cancelled');
        assert.deepStrictEqual(log.suppressed, [true], 're-init must not release and re-claim');
        assert.strictEqual(log.enabled, 0, 'old microphone owner must stay off');

        finishFirst({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(okPayload([]))) });
        await flush();
        assert.deepStrictEqual(bus.of('lyrics_karaoke:renderer-ready').map((e) => e.detail.filename),
            ['new.sloppak'], 'stale first load must not emit ready');
        r.draw(bundle({ songInfo: { audio_url: '/api/sloppak/new.sloppak/file/stems/vocals.ogg', arrangement_index: 0, arrangement: 'Vocals' } }));
        assert.ok(newCanvas._ctx.calls.includes('fillText'));
        assert.deepStrictEqual(oldCanvas._ctx.calls, [], 'old panel canvas must not be reused');
    } finally {
        r.destroy();
        removeNoteDetect();
    }
    assert.deepStrictEqual(log.suppressed, [true, false]);
    assert.strictEqual(log.enabled, 1, 'original microphone owner restored only on final destroy');
});

test('a failed re-init releases ownership and cannot keep drawing on the old canvas', async () => {
    bus.reset();
    const log = installNoteDetect({ wantsDetect: true });
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'old', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    try {
        const canvas = makeCanvas();
        r.init(canvas, bundle());
        await flush();
        r.init(makeCanvas({ contextFails: true }), bundle());
        assert.strictEqual(screen._vizOwnsPlayback(), false);
        assert.deepStrictEqual(log.suppressed, [true, false]);
        assert.strictEqual(log.enabled, 1);
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').at(-1).detail.reason, 'no-2d-context');
        canvas._ctx.calls.length = 0;
        r.draw(bundle());
        assert.deepStrictEqual(canvas._ctx.calls, []);
    } finally {
        r.destroy();
        removeNoteDetect();
    }
    assert.deepStrictEqual(log.suppressed, [true, false], 'extra destroy must not re-release');
});

test('a failed init claims nothing, so note_detect keeps the mic', () => {
    const log = installNoteDetect({ wantsDetect: true });
    try {
        const r = window.feedBackViz_lyrics_karaoke();
        r.init(null, bundle());          // no usable canvas
        assert.deepStrictEqual(log.suppressed, [], 'must not suppress on a failed init');
        r.destroy();
        assert.strictEqual(log.enabled, 0);
    } finally {
        removeNoteDetect();
    }
});

test('no note_detect installed is a clean no-op', async () => {
    removeNoteDetect();
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    assert.doesNotThrow(() => r.init(makeCanvas(), bundle()));
    await flush();
    assert.doesNotThrow(() => r.destroy());
});

// ── #36: the Note Detect coexistence floor ──────────────────────────────
// The runtime cannot read a peer's version number (the host exposes no
// version global and no plugin registry), so the floor is enforced as a
// capability: setDefaultSuppressed is the load-bearing half of the
// handshake, and a legacy build is tolerated only while it can prove
// it is not holding the microphone.

test('coexistence: no note_detect is never blocked and stays optional', () => {
    removeNoteDetect();
    assert.strictEqual(screen._lkNoteDetectState(), null);
    assert.strictEqual(screen._lkMicCoexistenceBlock(), null);
});

test('coexistence: a full handshake (>=1.15.2) is supported and never blocks', () => {
    const log = installNoteDetect({ wantsDetect: true, isEnabled: true });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: true });
        assert.strictEqual(screen._lkMicCoexistenceBlock(), null);
    } finally {
        removeNoteDetect();
    }
    void log;
});

test('coexistence: a partial handshake is supported — suppression is load-bearing', () => {
    // A modern factory whose singleton lost the restore probes.
    installNoteDetect({ wantsDetect: false, isEnabled: false });
    try {
        delete window.noteDetect.isEnabled;
        delete window.noteDetect.wantsDetect;
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: true });
        assert.strictEqual(screen._lkMicCoexistenceBlock(), null);
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a legacy peer that is active blocks the mic with the floor named', () => {
    installNoteDetect({ omitHandshake: true, isEnabled: true, wantsDetect: true });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: false, active: true });
        const msg = screen._lkMicCoexistenceBlock();
        assert.ok(msg, 'an active legacy peer must block');
        assert.ok(msg.includes(screen._LK_NOTE_DETECT_MIN),
            'the message must name the floor so the fix is actionable: ' + msg);
        assert.match(msg, /update note detect/i,
            'and name the upgrade, the one remedy that reliably clears the gate');
        assert.doesNotMatch(msg, /turn it off/i,
            'note_detect re-arms its persisted intent while it is disabled, so "turn it off" is not a route out');
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a legacy peer that is provably idle does not block', () => {
    installNoteDetect({ omitHandshake: true, isEnabled: false, wantsDetect: false });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: false, active: false });
        assert.strictEqual(screen._lkMicCoexistenceBlock(), null);
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a legacy peer armed to auto-enable blocks even while its toggle is off', () => {
    // The default-install shape: wantsDetect() is the persisted intent and
    // defaults to true, isEnabled() is only the live toggle. note_detect
    // calls enable() itself at the next song boundary whenever
    // wantsDetect() && !isEnabled(), so isEnabled() === false is the
    // pre-auto-enable state, not proof of idleness. Probing isEnabled()
    // first would hand over the mic and be ambushed one song later.
    installNoteDetect({ omitHandshake: true, isEnabled: false, wantsDetect: true });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: false, active: true },
            'a live intent must not be shadowed by an off toggle');
        assert.ok(screen._lkMicCoexistenceBlock());
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a legacy peer with no probe at all is blocked', () => {
    installNoteDetect({ omitHandshake: true, probes: false });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: false, active: undefined });
        assert.ok(screen._lkMicCoexistenceBlock(), 'unprovable idleness must not be assumed');
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a throwing legacy probe counts as unprovable, so it blocks', () => {
    installNoteDetect({ omitHandshake: true, throwOnProbe: true });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: false, active: undefined });
        assert.ok(screen._lkMicCoexistenceBlock());
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a peer that throws on suppress still counts as supported', () => {
    // The classifier only reads `typeof factory.setDefaultSuppressed`, so a
    // peer that throws when *called* is still a modern build: the gate must
    // not misclassify it as legacy and withhold the mic. The throw itself is
    // absorbed by _vizSuppressNoteDetect's own try/catch.
    installNoteDetect({ wantsDetect: true, throwOnSuppress: true });
    try {
        assert.deepStrictEqual(screen._lkNoteDetectState(), { supported: true });
        assert.strictEqual(screen._lkMicCoexistenceBlock(), null);
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: the gate is evaluated per attempt, so an upgrade unblocks without a reload', () => {
    installNoteDetect({ omitHandshake: true, probes: false });
    try {
        assert.ok(screen._lkMicCoexistenceBlock(), 'legacy first');
        const log = installNoteDetect({ wantsDetect: false, isEnabled: false });
        assert.strictEqual(screen._lkMicCoexistenceBlock(), null, 'upgraded peer unblocks');
        assert.deepStrictEqual(log.suppressed, [], 'and can be suppressed again');
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: a detector already enabled before takeover is stood down and handed back', async () => {
    const log = installNoteDetect({ wantsDetect: true, isEnabled: true });
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        r.init(makeCanvas(), bundle());
        await flush();
        assert.deepStrictEqual(log.suppressed, [true], 'claim suppresses the running singleton');
        assert.strictEqual(screen._lkMicCoexistenceBlock(), null, 'a modern peer never blocks the mic');
        r.destroy();
        await flush();
        assert.deepStrictEqual(log.suppressed, [true, false]);
        assert.strictEqual(log.enabled, 1, 'a detector the user had ON comes back');
    } finally {
        removeNoteDetect();
    }
});

test('coexistence: the manifest floor matches the runtime constant', () => {
    const manifest = require('../plugin.json');
    assert.strictEqual(manifest.peer_requirements.note_detect.min, screen._LK_NOTE_DETECT_MIN,
        'plugin.json and screen.js drift otherwise');
    assert.strictEqual(manifest.peer_requirements.note_detect.optional, true,
        'Note Detect stays optional for solo Lyrics Karaoke use');
});

test('an older note_detect without the handshake does not break renderer init', async () => {
    // Not a "clean no-op" — since #36 an unprovable legacy peer withholds
    // the mic. `probes: false` is what makes this fixture that peer. Note a
    // single default `false` no longer proves idleness on its own; both
    // stubs report `false` here, so this fixture is idle either way — it is
    // the missing-probe *shape*, not the value, that makes the gate block.
    // What must still hold either way is that
    // owning/handing back playback and the draw loop are untouched by a peer
    // we cannot suppress.
    installNoteDetect({ omitHandshake: true, probes: false });
    try {
        assert.ok(screen._lkMicCoexistenceBlock(), 'the fixture really is a blocking legacy peer');
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        const canvas = makeCanvas();
        assert.doesNotThrow(() => r.init(canvas, bundle()));
        await flush();
        assert.doesNotThrow(() => r.draw(bundle()));
        assert.ok(canvas._ctx.calls.includes('fillText'), 'the renderer still draws');
        assert.doesNotThrow(() => r.destroy());
        assert.strictEqual(screen._vizOwnsPlayback(), false);
    } finally {
        removeNoteDetect();
    }
});

test('a throwing peer plugin does not break renderer init', async () => {
    installNoteDetect({ wantsDetect: true, throwOnSuppress: true });
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        const canvas = makeCanvas();
        assert.doesNotThrow(() => r.init(canvas, bundle()));
        await flush();
        r.draw(bundle());
        assert.ok(canvas._ctx.calls.includes('fillText'), 'renderer still works');
        assert.doesNotThrow(() => r.destroy());
    } finally {
        removeNoteDetect();
    }
});

// ── Phase 1: diatonic pitch axis ────────────────────────────────────────

test('diatonic axis spaces naturals evenly and sharps halfway', () => {
    const d = screen._vizDiaPos;
    // C4..C5 is 7 diatonic steps (one row per white key).
    assert.strictEqual(d(72) - d(60), 7);
    // E->F and B->C are adjacent white keys: one step, no black key between.
    assert.strictEqual(d(65) - d(64), 1);   // E4 -> F4
    assert.strictEqual(d(72) - d(71), 1);   // B4 -> C5
    // C->D spans a black key, so C#4 sits halfway.
    assert.strictEqual(d(62) - d(60), 1);
    assert.strictEqual(d(61) - d(60), 0.5);
});

test('naturals are identified by pitch class, octave-independent', () => {
    const nat = screen._vizIsNatural;
    for (const m of [60, 62, 64, 65, 67, 69, 71, 72, 48, 84]) {
        assert.strictEqual(nat(m), true, `midi ${m}`);
    }
    for (const m of [61, 63, 66, 68, 70, 49, 85]) {
        assert.strictEqual(nat(m), false, `midi ${m}`);
    }
});

test('midi names use scientific pitch notation', () => {
    assert.strictEqual(screen._vizMidiToName(60), 'C4');
    assert.strictEqual(screen._vizMidiToName(69), 'A4');
    assert.strictEqual(screen._vizMidiToName(61), 'C#4');
    assert.strictEqual(screen._vizMidiToName(21), 'A0');
});

test('diatonic range is null for lyrics-only content', () => {
    // This null is the signal that selects the flat-ribbon fallback.
    assert.strictEqual(screen._vizDiatonicRange([
        { start: 0, duration: 1, text: 'a', midi: null },
    ]), null);
    assert.strictEqual(screen._vizDiatonicRange([]), null);
    assert.strictEqual(screen._vizDiatonicRange(null), null);
});

test('diatonic range widens a narrow melody to fill the wall', () => {
    const r = screen._vizDiatonicRange([
        { start: 0, duration: 1, text: 'a', midi: 60 },
        { start: 1, duration: 1, text: 'b', midi: 62 },
    ]);
    assert.ok(r.dHi - r.dLo >= 5, 'must widen to at least 5 diatonic steps');
    assert.ok(r.midiLo <= 60 && r.midiHi >= 62, 'must still contain the melody');
});

test('diatonic range terminates on a single-note melody', () => {
    // The widen loop is guarded; a one-note song must not hang it.
    const r = screen._vizDiatonicRange([{ start: 0, duration: 1, text: 'a', midi: 60 }]);
    assert.ok(r && r.dHi - r.dLo >= 5);
});

test('the shared axis spans every voice, not just the scored one', () => {
    const solo = screen._vizDiatonicRange([{ start: 0, duration: 1, text: 'a', midi: 60 }]);
    const shared = screen._vizSharedDiatonicRange([
        { tokens: [{ start: 0, duration: 1, text: 'a', midi: 60 }] },
        { tokens: [{ start: 0, duration: 1, text: 'b', midi: 79 }] },
    ]);
    assert.ok(shared.midiHi >= 79, 'must reach the highest voice');
    assert.ok(shared.midiLo <= 60, 'must reach the lowest voice');
    assert.ok(shared.dHi - shared.dLo > solo.dHi - solo.dLo, 'wider than solo');
});

// ── Phase 1: voice normalization (no non-spec content path) ─────────────

test('normalizes every voice and defaults a primary', () => {
    const voices = screen._vizNormalizeVoices({
        voices: [
            { id: 'lead', name: 'Lead', tokens: [{ start: 0, duration: 1, text: 'a', midi: 60 }] },
            { id: 'harm', name: 'Harmony', tokens: [{ start: 0, duration: 1, text: 'b', midi: 64 }] },
        ],
    });
    assert.strictEqual(voices.length, 2);
    assert.strictEqual(voices[0].primary, true, 'first voice becomes primary');
    assert.strictEqual(voices[1].primary, false);
    assert.strictEqual(voices[1].name, 'Harmony');
});

test('honours an explicit primary and synthesizes missing ids', () => {
    const voices = screen._vizNormalizeVoices({
        voices: [
            { tokens: [{ start: 0, duration: 1, text: 'a', midi: 60 }] },
            { primary: true, tokens: [{ start: 0, duration: 1, text: 'b', midi: 64 }] },
        ],
    });
    assert.deepStrictEqual(voices.map((v) => v.id), ['v1', 'v2']);
    assert.strictEqual(screen._vizScoredIndex(voices), 1);
});

test('drops voices with no usable tokens', () => {
    const voices = screen._vizNormalizeVoices({
        voices: [
            { id: 'a', tokens: [{ start: 0, duration: 1, text: 'x', midi: 60 }] },
            { id: 'empty', tokens: [] },
            { id: 'junk', tokens: [{ start: 'nope' }] },
        ],
    });
    assert.deepStrictEqual(voices.map((v) => v.id), ['a']);
});

test('reads ONLY voices[] — never a non-spec content path', () => {
    // The backend translates the additive manifest extension. Rendering
    // stays transport-only and must never inspect `vocal_tracks` itself.
    const voices = screen._vizNormalizeVoices({
        vocal_tracks: [
            { id: 'v1', lyrics: 'lyrics.json' },
            { id: 'v2', lyrics: 'lyrics_v2.json' },
        ],
        tokens: [{ start: 0, duration: 1, text: 'legacy', midi: 60 }],
    });
    assert.deepStrictEqual(voices, [], 'only voices[] is a content source');
    const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'screen.js'), 'utf8',
    );
    // Allowed in prose (the boundary comment); never as a property read.
    assert.ok(!/\.vocal_tracks|\['vocal_tracks'\]|\["vocal_tracks"\]/.test(src),
        'screen.js must not read vocal_tracks');
});

test('scored index is -1 when there are no voices', () => {
    assert.strictEqual(screen._vizScoredIndex([]), -1);
    assert.strictEqual(screen._vizScoredIndex(null), -1);
});

test('panel sung-part selection orders the primary voice first', () => {
    const voices = [
        { id: 'harmony', primary: false },
        { id: 'lead', primary: true },
        { id: 'counter', primary: false },
    ];
    assert.strictEqual(screen._vizSelectedVoiceIndex(voices, 'primary'), 1);
    assert.strictEqual(screen._vizSelectedVoiceIndex(voices, 'part2'), 0);
    assert.strictEqual(screen._vizSelectedVoiceIndex(voices, 'part3'), 2);
    assert.strictEqual(screen._vizSelectedVoiceIndex(voices, 'part4'), 1,
        'an unavailable part falls back to primary');
});

// ── Phase 1: lyric line grouping ────────────────────────────────────────

test('a + suffix breaks the lyric line', () => {
    const lines = screen._vizBuildLines([
        { start: 0, duration: 0.5, text: 'hel' },
        { start: 0.5, duration: 0.5, text: 'lo+' },
        { start: 1, duration: 0.5, text: 'there' },
    ]);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[0].parts.map((p) => p.text), ['hel', 'lo']);
    assert.strictEqual(lines[1].parts[0].text, 'there');
});

test('a - suffix joins a syllable to the next with no space', () => {
    const lines = screen._vizBuildLines([
        { start: 0, duration: 0.5, text: 'hel-' },
        { start: 0.5, duration: 0.5, text: 'lo' },
    ]);
    assert.strictEqual(lines[0].parts[0].join, true);
    assert.strictEqual(lines[0].parts[0].text, 'hel', 'marker stripped from display');
});

test('with no explicit breaks, a long gap starts a new line', () => {
    const lines = screen._vizBuildLines([
        { start: 0, duration: 0.5, text: 'one' },
        { start: 5, duration: 0.5, text: 'two' },   // >1.2s gap
    ]);
    assert.strictEqual(lines.length, 2);
});

test('line bounds span first onset to last offset', () => {
    const lines = screen._vizBuildLines([
        { start: 1, duration: 0.5, text: 'a' },
        { start: 2, duration: 0.25, text: 'b' },
    ]);
    assert.strictEqual(lines[0].t0, 1);
    assert.strictEqual(lines[0].t1, 2.25);
});

test('cue beat uses median syllable spacing and folds subdivisions', () => {
    assert.strictEqual(screen._vizComputeCueBeat([]), 0.5);
    assert.strictEqual(screen._vizComputeCueBeat([
        { start: 0 }, { start: 0.2 }, { start: 0.4 }, { start: 0.6 },
    ]), 0.4, 'a 0.2s subdivision folds to a 0.4s beat');
    assert.strictEqual(screen._vizComputeCueBeat([
        { start: 0 }, { start: 0.6 }, { start: 1.2 },
    ]), 0.6);
});

// ── Phase 1: the stage ──────────────────────────────────────────────────

function stageView(over) {
    const tokens = (over && over.tokens) || [
        { start: 1, duration: 0.5, text: 'hel', midi: 60 },
        { start: 1.5, duration: 0.5, text: 'lo', midi: 64 },
    ];
    const voices = (over && over.voices) || [
        { id: 'primary', name: 'Vocals', primary: true, tokens },
    ];
    const scoredIdx = over && over.scoredIdx !== undefined ? over.scoredIdx : 0;
    return Object.assign({
        range: screen._vizSharedDiatonicRange(voices),
        voices,
        scoredIdx,
        tokens: voices[scoredIdx] ? voices[scoredIdx].tokens : tokens,
        lines: screen._vizBuildLines(voices[scoredIdx] ? voices[scoredIdx].tokens : tokens),
        maxDuration: screen._vizMaxDuration(tokens),
    }, over || {});
}

test('the stage draws lanes, a seam, slabs and the playhead', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView(), 1.2);

    assert.ok(ctx.calls.includes('clearRect'));
    assert.ok(ctx.calls.includes('save') && ctx.calls.includes('restore'),
        'stage must clip and restore');
    assert.ok(ctx.calls.includes('stroke'), 'lanes/seam/playhead stroke');
    assert.ok(ctx.calls.filter((c) => c === 'fill').length > 0, 'slabs are filled paths');
    assert.ok(ctx.gradients.length > 0, 'wall + slabs use gradients');
});

test('the stage labels natural pitch lanes only', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView(), 1.2);

    const labels = ctx.texts.map((t) => t.t).filter((t) => /^[A-G]#?-?\d+$/.test(t));
    assert.ok(labels.length > 0, 'expected pitch-lane labels');
    assert.ok(labels.every((l) => !l.includes('#')), `no sharp lanes: ${labels}`);
});

test('the stage keeps lyrics below the horizon seam', () => {
    const H = 480;
    const canvas = makeCanvas({ width: 960, height: H });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, H, stageView(), 1.2);

    const seamY = Math.round(H * 0.82);
    const words = ctx.texts.filter((t) => t.t.trim() === 'hel' || t.t.trim() === 'lo');
    assert.ok(words.length > 0, 'lyrics must render');
    assert.ok(words.every((w) => w.y > seamY), 'lyrics belong below the seam');

    const lanes = ctx.texts.filter((t) => /^[A-G]-?\d+$/.test(t.t));
    assert.ok(lanes.every((l) => l.y < seamY), 'pitch lanes belong above the seam');
});

test('the active syllable, sung syllables and upcoming ones differ', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    // now = 1.6 -> "hel" (1.0-1.5) sung, "lo" (1.5-2.0) active.
    screen._vizDrawStage(ctx, 960, 480, stageView(), 1.6);
    const byText = {};
    for (const t of ctx.texts) byText[t.t.trim()] = t.fill;
    assert.strictEqual(byText.lo, '#ffffff', 'active syllable is white');
    assert.notStrictEqual(byText.hel, byText.lo, 'sung syllable differs from active');
});

test('the absolute left rail draws a compact tuner scale', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({ leftRailMode: 'absolute' }), 1.2);
    const railLabels = ctx.texts.filter((t) => /^[A-G]-?\d+$/.test(t.t) && t.x < 74);
    assert.ok(railLabels.length > 0, 'absolute rail labels pitches inside the left rail');
});

test('the voice-technique left rail draws coaching state from score results', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480,
        stageView({ leftRailMode: 'technique', score: scoreView() }), 1.2);
    const texts = ctx.texts.map((t) => t.t);
    for (const want of ['PITCH', 'LOCK', 'RUN', '2']) {
        assert.ok(texts.includes(want), `missing technique rail text ${want}`);
    }
});

test('the left rail can be turned off', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({ leftRailMode: 'off' }), 1.2);
    assert.ok(!ctx.texts.some((t) => t.t === 'PITCH' || t.t === 'LOCK'),
        'technique rail text is absent when the rail is off');
    assert.ok(!ctx.texts.some((t) => /^[A-G]-?\d+$/.test(t.t) && t.x < 30),
        'absolute rail labels are absent when the rail is off');
});

test('the stage shows a countdown and bouncing ball during a silent lead-in', () => {
    const tokens = [{ start: 4, duration: 0.5, text: 'ready', midi: 60 }];
    const canvas = makeCanvas({ width: 960, height: 480 });
    const view = stageView({
        tokens,
        voices: [{ id: 'p', primary: true, tokens }],
        cue: { beat: 0.5, ballX: null },
    });
    screen._vizDrawStage(canvas._ctx, 960, 480, view, 2.5);

    assert.ok(canvas._ctx.texts.some((t) => t.t === '1.5'),
        'countdown reports seconds until the first lyric');
    assert.strictEqual(canvas._ctx.arcs.length, 1, 'one bouncing-ball cue is drawn');
});

test('the bouncing ball follows the active syllable without a countdown', () => {
    const canvas = makeCanvas({ width: 960, height: 480 });
    const view = stageView({ cue: { beat: 0.5, ballX: null } });
    screen._vizDrawStage(canvas._ctx, 960, 480, view, 1.2);

    assert.strictEqual(canvas._ctx.arcs.length, 1);
    assert.ok(!canvas._ctx.texts.some((t) => /^\d+\.\d$/.test(t.t)),
        'numeric countdown disappears once singing begins');
});

test('a duet renders guide bars for the unscored voice on shared lanes', () => {
    const lead = [{ start: 1, duration: 0.5, text: 'a', midi: 60 }];
    const harm = [{ start: 1, duration: 0.5, text: 'b', midi: 67 }];
    const voices = [
        { id: 'lead', name: 'Lead', primary: true, tokens: lead },
        { id: 'harm', name: 'Harmony', primary: false, tokens: harm },
    ];
    const solo = makeCanvas({ width: 960, height: 480 });
    const duet = makeCanvas({ width: 960, height: 480 });
    screen._vizDrawStage(solo.getContext('2d'), 960, 480,
        stageView({ voices: [voices[0]], scoredIdx: 0 }), 1.2);
    screen._vizDrawStage(duet.getContext('2d'), 960, 480,
        stageView({ voices, scoredIdx: 0 }), 1.2);

    assert.ok(duet._ctx.calls.filter((c) => c === 'fill').length
        > solo._ctx.calls.filter((c) => c === 'fill').length,
        'the duet draws extra bars for the guide voice');
});

test('the first guide bar is teal whichever voice is scored', () => {
    // Guides are coloured by position among the GUIDES, not by voice index,
    // so the first guide reads the same whichever part the user sings.
    const voices = [
        { id: 'a', primary: false, tokens: [{ start: 1, duration: 0.5, text: 'a', midi: 60 }] },
        { id: 'b', primary: false, tokens: [{ start: 1, duration: 0.5, text: 'b', midi: 67 }] },
    ];
    const TEAL = 'rgba(34,211,238,0.34)';
    for (const scoredIdx of [0, 1]) {
        const canvas = makeCanvas({ width: 960, height: 480 });
        const ctx = canvas.getContext('2d');
        screen._vizDrawStage(ctx, 960, 480, stageView({ voices, scoredIdx }), 1.2);
        assert.ok(ctx.fills.includes(TEAL),
            `scored ${scoredIdx}: expected a teal guide bar, got ${JSON.stringify(ctx.fills)}`);
    }
});

test('guide bars are flat colours, never the scored voice gradient', () => {
    // The whole point of the guide treatment: no gradient, gloss or glow —
    // those are reserved for the voice being scored.
    const voices = [
        { id: 'lead', primary: true, tokens: [{ start: 1, duration: 0.5, text: 'a', midi: 60 }] },
        { id: 'harm', primary: false, tokens: [{ start: 1, duration: 0.5, text: 'b', midi: 67 }] },
    ];
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({ voices, scoredIdx: 0 }), 1.2);

    const guideFills = ctx.fills.filter((f) => typeof f === 'string' && f.startsWith('rgba(34,211,238'));
    assert.strictEqual(guideFills.length, 1, 'one guide bar for one guide token');
    // The scored voice's slab is a gradient object, not a colour string.
    assert.ok(ctx.fills.some((f) => f && typeof f === 'object' && Array.isArray(f.stops)),
        'the scored voice draws a gradient slab');
});

test('the stage falls back to nothing drawn on a zero-span canvas', () => {
    // Guards the divide-by-zero paths in the axis mapping.
    const canvas = makeCanvas({ width: 10, height: 10 });
    const ctx = canvas.getContext('2d');
    assert.doesNotThrow(() => screen._vizDrawStage(ctx, 10, 10, stageView(), 1.2));
});

test('the stage culls to the visible window on a long song', () => {
    const tokens = [];
    for (let i = 0; i < 20000; i++) {
        tokens.push({ start: 100 + i, duration: 0.2, text: 't', midi: 60 + (i % 12) });
    }
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({
        voices: [{ id: 'p', primary: true, tokens }],
        scoredIdx: 0,
    }), 0);
    // Nothing is in view at t=0, so no slab should be filled. Lane strokes
    // and the wall still draw; what must NOT happen is 20k slab fills.
    assert.ok(ctx.calls.filter((c) => c === 'fill').length < 50,
        'must not walk the whole song per frame');
});

// ── Phase 1: stage vs flat-ribbon dispatch through the renderer ─────────

test('a pitched song renders through the stage', async () => {
    fetchImpl = jsonFetch(okPayload([
        { start: 1, duration: 0.5, text: 'hel', midi: 60 },
        { start: 1.5, duration: 0.5, text: 'lo', midi: 64 },
    ]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas({ width: 960, height: 480 });
    r.init(canvas, bundle());
    await flush();
    r.draw(bundle({ currentTime: 1.2 }));
    assert.ok(canvas._ctx.calls.includes('save'), 'stage clips; the flat ribbon does not');
    assert.ok(canvas._ctx.texts.some((t) => /^[A-G]-?\d+$/.test(t.t)),
        'stage draws pitch lanes');
    r.destroy();
});

test('a lyrics-only song silently keeps the flat-ribbon path', async () => {
    // The constraint from #10: lyrics-only is a valid /playback shape and
    // stays in the provider, on the flat ribbon — NOT handed to the legacy
    // overlay, and not a user-facing mode toggle.
    fetchImpl = jsonFetch(okPayload([
        { start: 1, duration: 0.5, text: 'hel' },
        { start: 1.5, duration: 0.5, text: 'lo' },
    ]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas({ width: 960, height: 480 });
    r.init(canvas, bundle());
    await flush();
    r.draw(bundle({ currentTime: 1.2 }));

    assert.ok(canvas._ctx.calls.includes('clearRect'), 'still renders');
    assert.ok(!canvas._ctx.calls.includes('save'), 'must not take the stage path');
    assert.ok(canvas._ctx.texts.some((t) => t.t.trim() === 'hel'), 'lyrics still drawn');
    assert.ok(!canvas._ctx.texts.some((t) => /^[A-G]-?\d+$/.test(t.t)),
        'no pitch lanes without a pitch axis');
    r.destroy();
});

test('a song switch from pitched to lyrics-only swaps the path', async () => {
    fetchImpl = (url) => jsonFetch(url.includes('plain.sloppak')
        ? okPayload([{ start: 1, duration: 0.5, text: 'x' }])
        : okPayload([{ start: 1, duration: 0.5, text: 'a', midi: 60 }]))();
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas({ width: 960, height: 480 });
    r.init(canvas, bundle());
    await flush();
    r.draw(bundle({ currentTime: 1.2 }));
    assert.ok(canvas._ctx.calls.includes('save'), 'pitched song uses the stage');

    const plain = bundle({
        songInfo: { audio_url: '/api/sloppak/plain.sloppak/file/stems/vocals.ogg', arrangement_index: 0, arrangement: 'Vocals' },
    });
    r.draw(plain);
    await flush();
    canvas._ctx.calls.length = 0;
    r.draw(plain);
    assert.ok(!canvas._ctx.calls.includes('save'),
        'stage state must not leak across a song switch');
    r.destroy();
});

test('renderer-ready reports the scored voice id', async () => {
    bus.reset();
    fetchImpl = jsonFetch({
        schema_version: 1,
        song: { filename: 'song.sloppak' },
        arrangement: { index: 0, id: 'vocals', name: 'Vocals' },
        voices: [
            { id: 'lead', name: 'Lead', tokens: [{ start: 1, duration: 1, text: 'a', midi: 60 }] },
            { id: 'harm', name: 'Harmony', primary: true, tokens: [{ start: 1, duration: 1, text: 'b', midi: 67 }] },
        ],
    });
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas({ width: 960, height: 480 }), bundle());
    await flush();
    const ready = bus.of('lyrics_karaoke:renderer-ready')[0].detail;
    assert.strictEqual(ready.voiceId, 'harm', 'scores the explicit primary');
    assert.strictEqual(ready.voices, 2);
    r.destroy();
});

test('each renderer panel can select a different duet part', async () => {
    const payload = {
        schema_version: 1,
        song: { filename: 'duet.sloppak' },
        arrangement: { index: 0, id: 'vocals', name: 'Vocals' },
        voices: [
            { id: 'lead', name: 'Lead', primary: true,
              tokens: [{ start: 1, duration: 1, text: 'lead+', midi: 60 }] },
            { id: 'harmony', name: 'Harmony', primary: false,
              tokens: [{ start: 1, duration: 1, text: 'harmony+', midi: 67 }] },
        ],
    };
    fetchImpl = jsonFetch(payload);
    const lead = window.feedBackViz_lyrics_karaoke();
    const harmony = window.feedBackViz_lyrics_karaoke();
    const leadCanvas = makeCanvas({ width: 960, height: 480 });
    const harmonyCanvas = makeCanvas({ width: 960, height: 480 });
    assert.strictEqual(harmony.applySetting('sungPart', 'part2'), true);
    lead.init(leadCanvas, bundle());
    harmony.init(harmonyCanvas, bundle());
    await flush();

    lead.draw(bundle({ currentTime: 1.2 }));
    harmony.draw(bundle({ currentTime: 1.2 }));
    assert.ok(leadCanvas._ctx.texts.some((t) => t.t.trim() === 'lead'));
    assert.ok(leadCanvas._ctx.texts.some((t) => t.t === 'SING: LEAD'));
    assert.ok(!leadCanvas._ctx.texts.some((t) => t.t.trim() === 'harmony'));
    assert.ok(harmonyCanvas._ctx.texts.some((t) => t.t.trim() === 'harmony'));
    assert.ok(harmonyCanvas._ctx.texts.some((t) => t.t === 'SING: HARMONY'));
    assert.ok(!harmonyCanvas._ctx.texts.some((t) => t.t.trim() === 'lead'));

    // Switching an already-loaded panel rebuilds only that panel's lyric
    // lines; the other instance keeps its own selected voice.
    harmonyCanvas._ctx.texts.length = 0;
    harmony.applySetting('sungPart', 'primary');
    harmony.draw(bundle({ currentTime: 1.2 }));
    assert.ok(harmonyCanvas._ctx.texts.some((t) => t.t.trim() === 'lead'));
    lead.destroy();
    harmony.destroy();
});

// ── The shared syllable-marker helper (one impl, two token shapes) ──────

test('stripSyllableMarker strips a single trailing layout marker', () => {
    const s = screen.stripSyllableMarker;
    assert.strictEqual(s('hel-'), 'hel');
    assert.strictEqual(s('lo+'), 'lo');
    assert.strictEqual(s('plain'), 'plain');
    assert.strictEqual(s(''), '');
    assert.strictEqual(s(null), '');
    assert.strictEqual(s(undefined), '');
    // Only ONE marker is ever stripped — a hyphen inside a word survives.
    assert.strictEqual(s('well-known'), 'well-known');
    assert.strictEqual(s('a--'), 'a-');
});

// ── Review fixes (Codacy/Codex on PR #24) ───────────────────────────────

test('maxDurationAcrossVoices spans every voice, not just the first', () => {
    assert.strictEqual(screen._vizMaxDurationAcrossVoices([]), 0);
    assert.strictEqual(screen._vizMaxDurationAcrossVoices(null), 0);
    assert.strictEqual(screen._vizMaxDurationAcrossVoices([
        { tokens: [{ start: 0, duration: 0.5 }] },
        { tokens: [{ start: 0, duration: 9.0 }] },  // longer, in the 2nd voice
    ]), 9.0);
    assert.strictEqual(screen._vizMaxDurationAcrossVoices([
        { tokens: [{ start: 0, duration: 3 }] },
        { tokens: [] },
    ]), 3);
});

test('a duet guide note held longer than anything in the scored voice still renders', () => {
    // Regression for the lookbehind bug: computing maxDuration from the
    // scored voice alone meant a longer-held GUIDE note fell outside the
    // lower-bound search window and silently vanished mid-sustain.
    const scored = [{ start: 30, duration: 0.2, text: 'hi', midi: 60 }];
    const guideHeldNote = { start: 0, duration: 20, text: 'aaah', midi: 67 };  // starts far back
    const voices = [
        { id: 'lead', primary: true, tokens: scored },
        { id: 'harm', primary: false, tokens: [guideHeldNote] },
    ];
    const view = {
        range: screen._vizSharedDiatonicRange(voices),
        voices,
        scoredIdx: 0,
        tokens: scored,
        lines: screen._vizBuildLines(scored),
        // now=10 sits inside the guide note's sustain (0-20) but its `start`
        // is far before the window — only a lookbehind covering the guide
        // voice's own duration keeps it in view.
        maxDuration: screen._vizMaxDurationAcrossVoices(voices),
    };
    const canvas = makeCanvas({ width: 960, height: 480 });
    const ctx = canvas.getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, view, 10);

    const teal = ctx.fills.filter((f) => f === 'rgba(34,211,238,0.34)');
    assert.strictEqual(teal.length, 1, 'the held guide note must still draw a bar');
});

test('a throwing wantsDetect() on the note_detect peer does not break renderer init', async () => {
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
    window.noteDetect = {
        wantsDetect() { throw new Error('peer is broken'); },
        isEnabled: () => false,
        enable() { return Promise.resolve(); },
        disable() {},
    };
    window.createNoteDetector = function () { return {}; };
    const suppressed = [];
    window.createNoteDetector.setDefaultSuppressed = (v) => suppressed.push(!!v);
    try {
        const r = window.feedBackViz_lyrics_karaoke();
        const canvas = makeCanvas();
        assert.doesNotThrow(() => r.init(canvas, bundle()));
        await flush();
        r.draw(bundle());
        assert.ok(canvas._ctx.calls.includes('fillText'), 'renderer still works');
        // Ownership was still claimed (suppression still happened) — the
        // throwing probe only affects whether we later try to re-enable it.
        assert.deepStrictEqual(suppressed, [true]);
        assert.doesNotThrow(() => r.destroy());
        assert.deepStrictEqual(suppressed, [true, false], 'release still runs');
    } finally {
        delete window.noteDetect;
        delete window.createNoteDetector;
    }
});

test('pitch-range percentile math agrees between the overlay and the provider', () => {
    // Pins the consolidation: both callers share _percentilePitchRange and
    // must produce identical numeric ranges for the same pitch content —
    // they differ only in null/default behavior at the edges.
    const midis = [60, 62, 64, 65, 67, 69, 71];
    const overlayRange = screen.computeSongPitchRange({
        tokens: midis.map((m) => ({ midi: m })),
    });
    const vizRange = screen._vizPitchRange(midis.map((m) => ({ start: 0, duration: 1, midi: m })));
    assert.strictEqual(overlayRange.lo, vizRange.lo);
    assert.strictEqual(overlayRange.hi, vizRange.hi);
});

test('the shared percentile helper returns null on no pitched content', () => {
    assert.strictEqual(screen._percentilePitchRange([]), null);
});

test('the overlay pitch range defaults sanely with no pitched tokens (null->default)', () => {
    // computeSongPitchRange's contract: unlike _vizPitchRange, it never
    // signals "lyrics-only" via null — the legacy overlay always draws a
    // strip, so it substitutes the same default band the old inline code did.
    const r = screen.computeSongPitchRange({ tokens: [] });
    assert.strictEqual(r.lo, 60);
    assert.ok(r.hi - r.lo >= 7);
});

test('the provider pitch range keeps signalling null on no pitched tokens', () => {
    // The opposite contract: this null IS the flat-ribbon-fallback signal.
    assert.strictEqual(screen._vizPitchRange([{ start: 0, duration: 1, text: 'a', midi: null }]), null);
});

// ── Ownership invariant, the reverse direction (altitude finding on PR #24) ──
//
// _vizClaimPlaybackOwnership() already stood the legacy overlay down when a
// viz instance takes over. Nothing previously stopped the user from
// re-enabling karaoke from the button WHILE that instance still owned
// playback — setKaraokeMode(true) would flip karaokeMode true and could
// auto-start the mic (if the user had it on for this song), racing a second
// getUserMedia + the legacy scorer against the live viz-provider instance.
// setKaraokeMode is the single choke point (only caller of showOverlay() and
// the only place that auto-starts the mic), so gating it there closes every
// downstream path at once — including the mic button's eligibility, which
// requires karaokeMode to be true and can now never see that while a viz
// instance owns playback.

test('setKaraokeMode(true) is refused while a viz instance owns playback', async () => {
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    try {
        assert.strictEqual(screen._vizOwnsPlayback(), true);
        screen.setKaraokeMode(true);
        assert.strictEqual(screen._karaokeModeForTest(), false, 'must not activate while the provider owns playback');
    } finally {
        r.destroy();
    }
});

test('setKaraokeMode(true) works normally once ownership is released', async () => {
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    r.destroy();
    assert.strictEqual(screen._vizOwnsPlayback(), false);
    screen.setKaraokeMode(true);
    assert.strictEqual(screen._karaokeModeForTest(), true);
    screen.setKaraokeMode(false);  // leave state clean for later tests
});

test('setKaraokeMode(false) always works, even while a viz instance owns playback', async () => {
    // The refusal is one-directional — turning karaoke OFF must never be
    // blocked, only turning it ON while something else owns playback.
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
    screen.setKaraokeMode(true);
    assert.strictEqual(screen._karaokeModeForTest(), true);
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle());
    await flush();
    try {
        assert.doesNotThrow(() => screen.setKaraokeMode(false));
        assert.strictEqual(screen._karaokeModeForTest(), false);
    } finally {
        r.destroy();
    }
});

// ── Efficiency: lyric-line lookup is a binary search, not a per-frame ────
// ── linear rescan from 0 (PR #24 review) ─────────────────────────────────

test('active lyric line index matches the original 0.3s-hold semantics', () => {
    const lines = [
        { t0: 0, t1: 1 },
        { t0: 1, t1: 2 },
        { t0: 2, t1: 3 },
    ];
    // Still inside line 0's hold window (t1=1, +0.3 grace).
    assert.strictEqual(screen._vizActiveLyricLineIndex(lines, 1.2), 0);
    // The original loop advances on `>=`, so a tie goes to advancing, not
    // staying — matches the linear scan's own boundary behavior exactly.
    assert.strictEqual(screen._vizActiveLyricLineIndex(lines, 1.3), 1);
    assert.strictEqual(screen._vizActiveLyricLineIndex(lines, 1.30001), 1);
    // Past the whole song.
    assert.strictEqual(screen._vizActiveLyricLineIndex(lines, 99), 3);
    // Before the song starts.
    assert.strictEqual(screen._vizActiveLyricLineIndex(lines, -5), 0);
    assert.strictEqual(screen._vizActiveLyricLineIndex([], 5), 0);
});

test('the lyric band does not walk the whole song per frame', () => {
    const tokens = [];
    const lineTokens = [];
    for (let i = 0; i < 5000; i++) {
        lineTokens.push([{ start: i, duration: 0.5, text: `w${i}+`, midi: 60 }]);
        tokens.push({ start: i, duration: 0.5, text: `w${i}+`, midi: 60 });
    }
    const lines = screen._vizBuildLines(tokens);
    assert.strictEqual(lines.length, 5000, 'one line per word, since every token force-breaks');
    // now sits near the END of a 5000-line song; a linear scan from 0 would
    // touch thousands of entries, a binary search touches ~13 (log2 5000).
    const li = screen._vizActiveLyricLineIndex(lines, 4990);
    assert.ok(li > 4900 && li <= 5000, `expected an index near the end, got ${li}`);
});

// ── Scoring layers on the stage (#11) ───────────────────────────────────

function scoreView(over) {
    return Object.assign({
        live: true,
        stats: { score: 230, streak: 2, bestStreak: 2, hits: 2, misses: 0, judged: 2, accuracy: 0.9 },
        resultFor: (i) => (i === 0 ? { samplesIn: 10, samplesMatched: 10, accuracy: 1, quality: 'perfect' } : null),
        trace: [{ t: 1.0, midi: 60 }, { t: 1.05, midi: 60.3 }, { t: 1.1, midi: 60.1 }],
    }, over || {});
}

test('the stage draws no scoring layers for a panel that is not scoring', () => {
    const ctx = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView(), 1.2);
    assert.ok(!ctx.texts.some((t) => t.t === 'SCORE'));
    assert.ok(!ctx.gradients.some((g) => g.stops.some(([, c]) => /^rgb\(/.test(c))),
        'no accuracy tint');
});

test('the stage draws the stats band, accuracy tint and sung trace while scoring', () => {
    const plain = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(plain, 960, 480, stageView(), 1.2);
    const ctx = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({ score: scoreView() }), 1.2);

    const texts = ctx.texts.map((t) => t.t);
    for (const want of ['SCORE', 'STREAK', 'ACCURACY', '230', '2', '90%']) {
        assert.ok(texts.includes(want), `missing stats text ${want}`);
    }
    // Stats band sits in the reserved top band, above the notes.
    const scoreLabel = ctx.texts.find((t) => t.t === 'SCORE');
    assert.ok(scoreLabel.y < 50 * (480 / 480) + 8);
    // A perfect syllable gets the green end of the ramp.
    const tint = ctx.gradients.find((g) => g.stops.some(([, c]) => /^rgb\(/.test(c)));
    assert.ok(tint, 'sung portion tinted');
    assert.match(tint.stops[1][1], /^rgb\(42, 169, 122\)$/);
    // One extra stroke: the sung trace.
    const strokes = (c) => c.calls.filter((k) => k === 'stroke').length;
    assert.strictEqual(strokes(ctx), strokes(plain) + 1);
});

test('a finished (not live) take shows best streak and no trace past now', () => {
    const ctx = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({
        score: scoreView({ live: false, finished: true, trace: [{ t: 5, midi: 60 }], stats: {
            score: 0, streak: 0, bestStreak: 7, hits: 0, misses: 1, judged: 1, accuracy: null,
        } }),
    }), 1.2);
    const texts = ctx.texts.map((t) => t.t);
    assert.ok(texts.includes('best 7'));
    assert.ok(texts.includes('SUMMARY'), 'finished takes show the end-of-song summary card');
    assert.ok(texts.includes('-- ACC / BEST 7'), 'summary reports accuracy and best streak');
    assert.ok(texts.includes('—'), 'no accuracy yet');
    const plain = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(plain, 960, 480, stageView(), 1.2);
    const strokes = (c) => c.calls.filter((k) => k === 'stroke').length;
    assert.strictEqual(strokes(ctx), strokes(plain), 'future trace points are not drawn');
});

test('the summary card waits for song completion, not mic release', () => {
    const ctx = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({
        score: scoreView({ live: false, finished: false }),
    }), 1.2);
    assert.ok(!ctx.texts.some((t) => t.t === 'SUMMARY'),
        'mid-song mic release must not show the finished-take card');
});

test('the summary card can appear at song end while the mic is still live', () => {
    const ctx = makeCanvas({ width: 960, height: 480 }).getContext('2d');
    screen._vizDrawStage(ctx, 960, 480, stageView({
        score: scoreView({ live: true, finished: true }),
    }), 2.1);
    assert.ok(ctx.texts.some((t) => t.t === 'SUMMARY'),
        'natural song end should show the finished-take card');
});

// ── The ribbon absorbs the highway's features inline (#45) ────────────────
//
// #32's shape item 2: the EXISTING overlay ribbon grows accuracy tinting,
// duet guide voices and the bouncing-ball / countdown cue directly, so the
// Karaoke toggle reads as one thing getting better rather than a swap to a
// different-looking stage. Nothing here is a mode: the guide list is
// additive (empty for a solo pack) and the cue draws from the same
// start-sorted rows the bars do.

test('duet guides are every voice except the scored one, unpitched tokens dropped', () => {
    const guides = screen._ribbonGuidesFromPayload({
        schema_version: 1,
        voices: [
            { id: 'v1', name: 'Lead', primary: true, tokens: [
                { start: 1, duration: 0.5, text: 'a', midi: 60 },
            ] },
            { id: 'v2', name: 'Harmony', tokens: [
                { start: 1, duration: 0.5, text: 'a', midi: 72 },
                { start: 2, duration: 0.5, text: 'b' },          // unpitched: nothing to place
            ] },
            { id: 'v3', name: 'Third', tokens: [
                { start: 1, duration: 0.5, text: 'a', midi: 55 },
            ] },
        ],
    });
    assert.strictEqual(guides.length, 2);
    assert.deepStrictEqual(guides.map((g) => g.name), ['Harmony', 'Third']);
    assert.deepStrictEqual(guides.map((g) => g.colorIndex), [0, 1]);
    assert.deepStrictEqual(guides[0].tokens, [{ start: 1, duration: 0.5, midi: 72 }]);
});

test('a solo pack yields no guides at all, rather than a guide for the lead', () => {
    const solo = screen._ribbonGuidesFromPayload({
        voices: [{ id: 'primary', primary: true, tokens: [{ start: 1, duration: 1, text: 'a', midi: 60 }] }],
    });
    assert.deepStrictEqual(solo, []);
    assert.deepStrictEqual(screen._ribbonGuidesFromPayload({ voices: [] }), []);
    assert.deepStrictEqual(screen._ribbonGuidesFromPayload(null), []);
});

test('guide pitches widen the shared song axis instead of drawing off the strip', () => {
    const data = { tokens: [
        { midi: 60 }, { midi: 62 }, { midi: 64 },
    ] };
    const leadOnly = screen.computeSongPitchRange(data);
    const withGuide = screen.computeSongPitchRange(data, [79]);
    assert.ok(withGuide.hi > leadOnly.hi,
        `guide must raise the ceiling: ${leadOnly.hi} -> ${withGuide.hi}`);
    assert.ok(withGuide.lo <= 79 && withGuide.hi >= 79,
        `the guide pitch must sit inside the strip: ${JSON.stringify(withGuide)}`);
    // The lead-only contract is unchanged when no guides exist.
    assert.strictEqual(leadOnly.lo, screen.computeSongPitchRange(data).lo);
    // Non-numeric / non-finite extras are ignored, not drawn as NaN rows.
    assert.deepStrictEqual(
        screen.computeSongPitchRange(data, [null, 'x', NaN, Infinity]),
        leadOnly,
    );
});

// The cue's input is the same start-sorted row array the scorer gets, so
// these cases are about timing only: which syllable the cue points at.
const cueRows = [
    { start: 1.0, duration: 0.5 },
    { start: 1.5, duration: 0.5 },
    { start: 2.0, duration: 0.5 },
    { start: 6.0, duration: 0.5 },   // 3.5s of silence before it
    { start: 6.5, duration: 0.5 },
];
// A phrasing gap: 0.4s between syllables, which must NOT read as a lead-in.
const shortGapRows = [
    { start: 1.0, duration: 0.5 },
    { start: 1.9, duration: 0.5 },
    { start: 2.4, duration: 0.5 },
];

test('the cue bounces under the syllable being sung', () => {
    assert.deepStrictEqual(screen._ribbonCueTarget(cueRows, 1.2), { kind: 'bounce', index: 0 });
    assert.deepStrictEqual(screen._ribbonCueTarget(cueRows, 1.6), { kind: 'bounce', index: 1 });
    assert.deepStrictEqual(screen._ribbonCueTarget(cueRows, 6.2), { kind: 'bounce', index: 3 });
});

test('a phrasing gap rests under the last syllable rather than vanishing', () => {
    // 1.7s is mid-gap: the ball belongs to the syllable just finished, which
    // is what the stage renderer's `activeX ?? lastX` fallback does.
    assert.deepStrictEqual(screen._ribbonCueTarget(shortGapRows, 1.7), { kind: 'bounce', index: 0 });
});

test('the cue vanishes before the song and after the last syllable', () => {
    assert.strictEqual(screen._ribbonCueTarget(cueRows, -1), null);
    assert.strictEqual(screen._ribbonCueTarget([], 1.2), null);
    assert.strictEqual(screen._ribbonCueTarget(cueRows, 99), null, 'past the last syllable');
});

test('the cue counts down only over a real silent lead-in', () => {
    // 3.5s of silence qualifies, and the number counts the seconds left.
    const cue = screen._ribbonCueTarget(cueRows, 4.0);
    assert.strictEqual(cue.kind, 'countdown');
    assert.strictEqual(cue.index, 3);
    assert.ok(Math.abs(cue.remain - 2.0) < 1e-9);
    // A 0.4s gap is ordinary phrasing: the ball rests on the previous
    // syllable instead of counting down.
    assert.deepStrictEqual(screen._ribbonCueTarget(shortGapRows, 1.7), { kind: 'bounce', index: 0 });
    // Far too early to count: a long instrumental break shows nothing rather
    // than a stale number parked on screen. The syllable has to be far enough
    // ahead to be rejected by the cap ALONE, not by the pre-song fallback.
    assert.strictEqual(screen._ribbonCueTarget([{ start: 30, duration: 0.5 }], 1.0), null,
        '29s out is past RIBBON_CUE_COUNTDOWN_MAX_S');
});

// The cue's search predicate reads `start + duration` while the rows are
// sorted by `start` alone, so ends are NOT monotonic: a held note starting
// first runs past several short syllables that follow it. A binary search on
// an end-time predicate walks straight past the note being sung.
test('the cue finds a held note that overlaps the syllables after it', () => {
    const overlapping = [
        { start: 1.0, duration: 8.0 },   // one long note...
        { start: 2.0, duration: 0.2 },
        { start: 2.2, duration: 0.2 },
        { start: 2.4, duration: 0.2 },
    ];
    // The linear answer at 2.3s is the long note; an end-time binary search
    // returned row 2 and cued the wrong syllable.
    assert.deepStrictEqual(screen._ribbonCueTarget(overlapping, 2.3), { kind: 'bounce', index: 0 });
    // ...and it stays correct as the short syllables come and go beneath it.
    assert.deepStrictEqual(screen._ribbonCueTarget(overlapping, 2.1), { kind: 'bounce', index: 0 });
    assert.deepStrictEqual(screen._ribbonCueTarget(overlapping, 2.45), { kind: 'bounce', index: 0 });
    // Once it releases and nothing else sounds, there is no cue at all.
    assert.strictEqual(screen._ribbonCueTarget(overlapping, 9.1), null,
        'the held note ended at 9.0 and no later syllable is due');
    // With a syllable 9.4s later, that gap is a real lead-in, so the cue
    // switches to counting down to it rather than resting on the tail.
    const withTail = overlapping.concat([{ start: 12.0, duration: 0.5 }]);
    const tail = screen._ribbonCueTarget(withTail, 9.1);
    assert.strictEqual(tail.kind, 'countdown');
    assert.strictEqual(tail.index, 4);
    assert.ok(Math.abs(tail.remain - 2.9) < 1e-9, `counts down to 2.9, got ${tail.remain}`);
});

test('the cue target matches a linear scan across a whole song, overlaps included', () => {
    // Property check rather than a hand-picked case: build a song with long
    // held notes overlapping later short ones, then compare the cue against a
    // brute-force "first row still sounding" scan at every timestep.
    const rows = [];
    let t = 0.5;
    for (let i = 0; i < 60; i++) {
        // Every 7th syllable is held for 3s, so it overlaps what follows.
        const duration = (i % 7 === 0) ? 3.0 : 0.3;
        rows.push({ start: t, duration });
        t += 0.35;
    }
    const maxDuration = screen._ribbonMaxDuration(rows);
    for (let now = 0.1; now < t + 4; now += 0.1) {
        const expected = rows.findIndex((r) => now >= r.start && now < r.start + r.duration);
        const got = screen._ribbonCueTarget(rows, now, maxDuration);
        if (expected >= 0) {
            assert.ok(got, `no cue at ${now} but row ${expected} sounds`);
            assert.strictEqual(got.kind, 'bounce', `wrong kind at ${now}`);
            assert.strictEqual(got.index, expected, `wrong row at ${now}`);
        }
    }
});

test('the cue never walks more than the reachable window back', () => {
    // The lookbehind is what keeps the cue O(notes within the longest hold)
    // rather than O(song). Assert the helper it derives that from.
    const rows = [{ start: 0, duration: 2 }, { start: 1, duration: 2 }, { start: 5, duration: 1 }];
    assert.strictEqual(screen._ribbonMaxDuration(rows), 2);
    assert.strictEqual(screen._ribbonMaxDuration([]), 0);
    // A note starting long before `now` but still sounding is still found,
    // because the walk is backed up by exactly that much.
    const long = [{ start: 0, duration: 10 }, { start: 9.5, duration: 0.2 }];
    assert.strictEqual(screen._ribbonMaxDuration(long), 10);
    assert.deepStrictEqual(screen._ribbonCueTarget(long, 9.8), { kind: 'bounce', index: 0 });
});

test('the guide lower bound matches a linear scan over the visible window', () => {
    const tokens = [];
    for (let i = 0; i < 500; i++) tokens.push({ start: i * 0.5, duration: 0.5, midi: 60 });
    for (const t of [0, 0.25, 3.5, 100, 249.5]) {
        const expected = tokens.findIndex((tok) => tok.start >= t);
        assert.strictEqual(screen._lowerBoundByStart(tokens, t), expected === -1 ? tokens.length : expected,
            `lower bound at ${t}`);
    }
});

// ── The ribbon frame itself ──────────────────────────────────────────────
//
// Drives the real drawFrame() with a canvas handed in directly (showOverlay
// needs host DOM), over song data loaded through the real /status + /data +
// /playback fetches, so what these assert is what the Karaoke toggle renders.

let ribbonClock = 0;

// Order matters: the canvas is attached AFTER the song loads, because a song
// change tears the overlay down (resetForNewSong -> teardownOverlay), which
// is exactly the host-DOM path these tests stand in for.
function attachRibbon(canvas) {
    window.highway = {
        getTime: () => ribbonClock,
        getLyricsVisible: () => true,
        setLyricsVisible() {},
    };
    const ctx = canvas.getContext('2d');
    ctx.rects.length = 0;
    ctx.fills.length = 0;
    ctx.texts.length = 0;
    ctx.arcs.length = 0;
    screen._lkOverlayRender.attachCanvas(canvas, ctx);
    return ctx;
}

async function loadRibbonSong(voices) {
    fetchImpl = (url) => {
        if (url.includes('/status')) {
            return jsonFetch({ has_lyrics: true, has_vocals: true, has_pitch: true })();
        }
        if (url.includes('/playback')) return jsonFetch({ voices: voices })();
        // /data — the scored voice, in its own `{t, d, w, midi}` shape.
        return jsonFetch({
            filename: 'song.sloppak',
            tokens: voices[0].tokens.map((tok) => ({
                t: tok.start, d: tok.duration, w: tok.text,
                ...(tok.midi === undefined ? {} : { midi: tok.midi }),
            })),
        })();
    };
    await screen._lkOverlayUi.onSongLoaded({ filename: 'song.sloppak', format: 'sloppak' });
}

const LEAD_VOICES = [
    { id: 'v1', name: 'Lead', primary: true, tokens: [
        { start: 1.0, duration: 0.5, text: 'hel', midi: 60 },
        { start: 1.5, duration: 0.5, text: 'lo', midi: 62 },
    ] },
    { id: 'v2', name: 'Harmony', tokens: [
        { start: 1.0, duration: 0.5, text: 'hel', midi: 72 },
        { start: 1.5, duration: 0.5, text: 'lo', midi: 74 },
    ] },
];

test('the ribbon draws duet guides under the scored bars on the same axis', async () => {
    await loadRibbonSong(LEAD_VOICES);
    assert.strictEqual(screen._lkOverlayRender.voices().length, 1, 'one guide voice');
    const ctx = attachRibbon(makeCanvas({ width: 800, height: 140 }));
    ribbonClock = 1.2;
    screen._lkOverlayRender.drawFrame();

    const guideFills = ctx.fills.filter((f) => f === screen.STAGE_VOICE_COLORS[0]);
    assert.ok(guideFills.length >= 2, 'both harmony syllables are marked');
    // The scored bars are there too, in their own colours — guides are added
    // to the same ribbon, never a replacement for it.
    assert.ok(ctx.fills.includes('#ffe080'), 'the active scored bar is still amber');
    screen._lkOverlayRender.detachCanvas();
});

test('a solo pack draws the same ribbon with no guides and no guide-only colour', async () => {
    await loadRibbonSong([LEAD_VOICES[0]]);
    assert.deepStrictEqual(screen._lkOverlayRender.voices(), []);
    const ctx = attachRibbon(makeCanvas({ width: 800, height: 140 }));
    ribbonClock = 1.2;
    screen._lkOverlayRender.drawFrame();
    for (const color of screen.STAGE_VOICE_COLORS) {
        assert.ok(!ctx.fills.includes(color), `no ${color} guide fill without a duet`);
    }
    // Scored bars and lyrics unchanged — the acceptance criterion that no
    // visible mode switch appears depending on the song's data.
    assert.ok(ctx.fills.includes('rgba(120, 80, 230, 0.55)'), 'dim scored bars');
    assert.ok(ctx.texts.some((t) => t.t === 'hel'));
    assert.ok(ctx.fills.includes('#ffe080'));
    screen._lkOverlayRender.detachCanvas();
});

test('the ribbon shows the countdown during a silent lead-in and the ball once singing', async () => {
    // The cue reads the SCORED voice's syllables — the same rows the bars do —
    // so the lead-in is a gap in the lead part, with a harmony line over it.
    await loadRibbonSong([
        { id: 'v1', primary: true, tokens: [
            { start: 1.0, duration: 0.5, text: 'a', midi: 60 },
            { start: 6.0, duration: 0.5, text: 'b', midi: 60 },
        ] },
        { id: 'v2', tokens: [{ start: 6.0, duration: 0.5, text: 'b', midi: 72 }] },
    ]);
    const ctx = attachRibbon(makeCanvas({ width: 800, height: 140 }));
    // Mid lead-in: a number counting the seconds to the next syllable.
    ribbonClock = 4.0;
    screen._lkOverlayRender.drawFrame();
    const number = ctx.texts.find((t) => /^\d+\.\d$/.test(t.t));
    assert.ok(number, 'numeric get-ready countdown: ' + JSON.stringify(ctx.texts.map((t) => t.t)));
    assert.ok(Math.abs(Number(number.t) - 2.0) < 0.06, `counts down to 2.0, got ${number.t}`);
    // And the duet guide still draws through the lead-in — one ribbon.
    assert.ok(ctx.fills.includes(screen.STAGE_VOICE_COLORS[0]), 'guides draw during the lead-in too');
    // Singing: the ball, and no number.
    ribbonClock = 6.2;
    ctx.texts.length = 0;
    ctx.arcs.length = 0;
    screen._lkOverlayRender.drawFrame();
    assert.strictEqual(ctx.arcs.length, 1, 'the bounce ball is drawn once');
    assert.ok(!ctx.texts.some((t) => /^\d+\.\d$/.test(t.t)), 'no countdown while singing');
    screen._lkOverlayRender.detachCanvas();
});

test('the countdown stays on the strip through a long lead-in', async () => {
    // 18s of silence: the next syllable is far off the right edge for most of
    // it, so an unclamped cue would draw its number and ball off-canvas.
    await loadRibbonSong([
        { id: 'v1', primary: true, tokens: [
            { start: 1.0, duration: 0.5, text: 'a', midi: 60 },
            { start: 19.0, duration: 0.5, text: 'b', midi: 60 },
        ] },
    ]);
    const W = 800;
    const ctx = attachRibbon(makeCanvas({ width: W, height: 140 }));
    for (const now of [3.0, 8.0, 14.0, 18.5]) {
        ribbonClock = now;
        ctx.texts.length = 0;
        ctx.arcs.length = 0;
        screen._lkOverlayRender.drawFrame();
        const number = ctx.texts.find((t) => /^\d+\.\d$/.test(t.t));
        assert.ok(number, `a countdown is expected at ${now}s`);
        assert.ok(number.x >= 0 && number.x <= W,
            `countdown drawn off-canvas at ${now}s: x=${number.x}`);
        assert.strictEqual(ctx.arcs.length, 1, `one ball at ${now}s`);
        assert.ok(ctx.arcs[0].x >= 0 && ctx.arcs[0].x <= W,
            `ball drawn off-canvas at ${now}s: x=${ctx.arcs[0].x}`);
    }
    screen._lkOverlayRender.detachCanvas();
});

test('the cue ball eases toward its target rather than snapping across the strip', async () => {
    await loadRibbonSong([
        { id: 'v1', primary: true, tokens: [
            { start: 1.0, duration: 0.5, text: 'a', midi: 60 },
            { start: 1.5, duration: 0.5, text: 'b', midi: 60 },
            { start: 2.0, duration: 0.5, text: 'c', midi: 60 },
        ] },
    ]);
    const ctx = attachRibbon(makeCanvas({ width: 800, height: 140 }));
    ribbonClock = 1.2;
    screen._lkOverlayRender.drawFrame();
    const first = ctx.arcs[0].x;
    // Same clock, so the target is unchanged and the ball must hold still —
    // the smoothing has to be a function of the TARGET's movement, not of
    // time passing.
    ctx.arcs.length = 0;
    screen._lkOverlayRender.drawFrame();
    assert.strictEqual(ctx.arcs[0].x, first, 'a settled ball does not drift');
    // The next syllable's text scrolls left past the playhead, so the target
    // moves with it — and the ball only eases toward that.
    ribbonClock = 1.95;
    ctx.arcs.length = 0;
    screen._lkOverlayRender.drawFrame();
    const eased = ctx.arcs[0].x;
    assert.ok(eased < first, 'it moves toward the new syllable, leftward');
    // Let the same clock settle: that x IS the target the ball was easing
    // toward, and the eased value must sit short of it rather than on it.
    for (let i = 0; i < 60; i++) screen._lkOverlayRender.drawFrame();
    const settled = ctx.arcs[ctx.arcs.length - 1].x;
    assert.ok(settled < first, 'the target did move');
    assert.ok(eased > settled, `one frame must not arrive already: ${eased} vs ${settled}`);
    screen._lkOverlayRender.detachCanvas();
});

test('the ribbon tints sung syllables with the shared accuracy ramp', async () => {
    await loadRibbonSong([
        { id: 'v1', primary: true, tokens: [{ start: 1.0, duration: 0.5, text: 'a', midi: 60 }] },
    ]);
    // Feed the overlay's own scorer a perfect take so the tint layer is live.
    const frames = [];
    for (let k = 0; k < 8; k++) frames.push({ t: 1.0 + k * 0.05, midi: 60, rate: 1 });
    frames.push({ t: 1.6, midi: 60, rate: 1 });   // finalize the syllable
    for (const frame of frames) screen._lkOverlayOwner.onFrame(frame);

    const ctx = attachRibbon(makeCanvas({ width: 800, height: 140 }));
    ribbonClock = 1.2;
    screen._lkOverlayRender.drawFrame();
    const [r, g, b] = screen._vizAccuracyRgb(1);
    const expected = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0.55)`;
    assert.ok(ctx.fills.includes(expected),
        `expected the shared green end of the ramp (${expected}), got ${JSON.stringify(ctx.fills)}`);
    // A song change is what clears results in production (resetForNewSong);
    // the tint must not survive into the next song's ribbon. Draw a frame at
    // a clock inside the syllable that was just scored — without the reset the
    // scorer still holds that result and the tint reappears, so the guard has
    // to look at a drawn frame, not just at the song change.
    screen._lkOverlayRender.detachCanvas();
    await screen._lkOverlayUi.onSongLoaded({ filename: 'other.sloppak', format: 'sloppak' });
    const after = attachRibbon(makeCanvas({ width: 800, height: 140 }));
    ribbonClock = 1.2;
    screen._lkOverlayRender.drawFrame();
    assert.ok(!after.fills.includes(expected),
        `the tint survived the song change: ${JSON.stringify(after.fills)}`);
    screen._lkOverlayRender.detachCanvas();
});
