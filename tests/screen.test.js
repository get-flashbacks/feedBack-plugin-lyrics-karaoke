/**
 * Stub-host tests for the visualization provider (#14).
 *
 * Covers the cases the issue asks for: create, repeated create, destroy,
 * song switch, failed data load, unsupported host, and two simultaneous
 * instances — plus Auto-mode selection and the payload-shaping helpers.
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
        clearRect() { this.calls.push('clearRect'); },
        fillRect() { this.calls.push('fillRect'); },
        fillText() { this.calls.push('fillText'); },
        set fillStyle(_v) { /* recorded via calls only */ },
        get fillStyle() { return '#000'; },
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

const screen = require(path.join(__dirname, '..', 'screen.js'));

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
        songInfo: { filename: 'song.sloppak', arrangement_index: 0, arrangement: 'Vocals' },
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

// ── Auto-mode selection ─────────────────────────────────────────────────

test('matchesArrangement selects vocals arrangements', () => {
    const m = screen._vizMatchesArrangement;
    assert.ok(m({ arrangement: 'Vocals' }));
    assert.ok(m({ arrangement: 'lead vocal' }));
    assert.ok(m({ arrangement: 'VOCALS (harmony)' }));
});

test('matchesArrangement leaves non-vocals arrangements alone', () => {
    const m = screen._vizMatchesArrangement;
    for (const arr of ['Lead', 'Rhythm', 'Bass', 'Drums', 'Keys', '']) {
        assert.strictEqual(m({ arrangement: arr }), false, arr);
    }
    assert.strictEqual(m(null), false);
    assert.strictEqual(m({}), false);
});

// ── Payload helpers ─────────────────────────────────────────────────────

test('picks the primary voice, else the first', () => {
    const primary = { id: 'p', primary: true };
    assert.strictEqual(screen._vizPickVoice({ voices: [{ id: 'a' }, primary] }), primary);
    assert.strictEqual(screen._vizPickVoice({ voices: [{ id: 'a' }] }).id, 'a');
    assert.strictEqual(screen._vizPickVoice({ voices: [] }), null);
    assert.strictEqual(screen._vizPickVoice(null), null);
});

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

    r.draw(bundle({ songInfo: { filename: 'other.sloppak', arrangement_index: 0, arrangement: 'Vocals' } }));
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
    r.draw(bundle({ songInfo: { filename: 'song.sloppak', arrangement_index: 2, arrangement: 'Vocals' } }));
    await flush();
    assert.strictEqual(urls.length, 2);
    assert.match(urls[1], /&arrangement=2$/);
    r.destroy();
});

test('a song with no arrangement index omits the query param', async () => {
    const urls = [];
    fetchImpl = (url) => { urls.push(url); return jsonFetch(okPayload([]))(); };
    const r = window.feedBackViz_lyrics_karaoke();
    r.init(makeCanvas(), bundle({ songInfo: { filename: 'song.sloppak', arrangement: 'Vocals' } }));
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
    b.init(cb, bundle({ songInfo: { filename: 'other.sloppak', arrangement_index: 1, arrangement: 'Vocals' } }));
    await flush();

    assert.strictEqual(screen._vizOwnsPlayback(), true);
    a.draw(bundle());
    b.draw(bundle({ songInfo: { filename: 'other.sloppak', arrangement_index: 1, arrangement: 'Vocals' } }));
    assert.ok(ca._ctx.calls.includes('fillText'));
    assert.ok(cb._ctx.calls.includes('fillText'));

    // Destroying one leaves the other live and still owning playback.
    a.destroy();
    assert.strictEqual(screen._vizOwnsPlayback(), true);
    cb._ctx.calls.length = 0;
    b.draw(bundle({ songInfo: { filename: 'other.sloppak', arrangement_index: 1, arrangement: 'Vocals' } }));
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

test('every manifest-declared setting is backed by applySetting', () => {
    const fs = require('node:fs');
    const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'),
    );
    const declared = manifest.capabilities.visualization.settings;
    assert.ok(Array.isArray(declared) && declared.length > 0);

    const r = window.feedBackViz_lyrics_karaoke();
    for (const decl of declared) {
        // A provider that declares `settings` MUST implement applySetting
        // for each key (feedBack#849) — the host calls it per panel.
        assert.strictEqual(
            r.applySetting(decl.key, decl.default), true,
            `applySetting rejected declared key ${decl.key}`,
        );
        assert.strictEqual(
            r.getSetting(decl.key), decl.default,
            `default drifted for ${decl.key}`,
        );
        assert.deepStrictEqual(
            screen.VIZ_SETTING_DEFAULTS[decl.key], decl.default,
            `manifest default for ${decl.key} disagrees with the renderer's`,
        );
    }
    // And nothing the renderer defaults is missing from the manifest.
    const keys = declared.map((d) => d.key).sort();
    assert.deepStrictEqual(Object.keys(screen.VIZ_SETTING_DEFAULTS).sort(), keys);
});

test('manifest declares the visualization type and a minimum host', () => {
    const fs = require('node:fs');
    const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'),
    );
    assert.strictEqual(manifest.type, 'visualization');
    assert.strictEqual(manifest.minHost, '0.3.0-alpha.1');
    // The preparation surface must survive taking on the second role (#14).
    assert.strictEqual(manifest.screen, 'screen.html');
    assert.ok(manifest.nav && manifest.nav.label);
    assert.strictEqual(manifest.routes, 'routes.py');
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
    r.draw(bundle({ songInfo: { filename: 'good.sloppak', arrangement_index: 0, arrangement: 'Vocals' } }));
    await flush();
    assert.strictEqual(calls, 2);
    bus.reset();
    r.draw(bundle({ songInfo: { filename: 'good.sloppak', arrangement_index: 0, arrangement: 'Vocals' } }));
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

test('the predicate claims nothing on arrangement name alone being notated', () => {
    // Staff View's Auto predicate is a bare `!!songInfo.has_notation` with
    // no instrument filter, so it claims EVERY notated arrangement. Ours
    // must stay keyed on the arrangement name only — never widen to
    // has_notation — or the two would collide on every notated chart
    // instead of just notated *vocals*.
    const m = screen._vizMatchesArrangement;
    assert.strictEqual(m({ arrangement: 'Lead', has_notation: true }), false);
    assert.strictEqual(m({ arrangement: 'Keys', has_notation: true }), false);
    assert.strictEqual(m({ arrangement: 'Drums', has_notation: true }), false);
    // A notated *vocals* chart is a genuine overlap, resolved by order:
    // `lyrics_karaoke` < `staffview` as both an id and a display name.
    assert.strictEqual(m({ arrangement: 'Vocals', has_notation: true }), true);
});

test('a notation-only vocals chart still renders (lyrics are song-level)', async () => {
    // Unlike Piano Highway, this provider decodes nothing from guitar-wire
    // notes, so it has no reason to yield on a notation-only arrangement:
    // /playback serves song-level lyrics either way.
    fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 0.5, text: 'ah', midi: 60 }]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas();
    r.init(canvas, bundle({
        songInfo: {
            filename: 'song.sloppak', arrangement_index: 0,
            arrangement: 'Vocals', has_notation: true,
        },
    }));
    await flush();
    r.draw(bundle({
        songInfo: {
            filename: 'song.sloppak', arrangement_index: 0,
            arrangement: 'Vocals', has_notation: true,
        },
    }));
    assert.ok(canvas._ctx.calls.includes('fillText'));
    r.destroy();
});

// ── note_detect ownership handshake ─────────────────────────────────────

/** Stub note_detect's public surface: the singleton plus the factory's
 *  setDefaultSuppressed handshake. */
function installNoteDetect(opts) {
    const o = opts || {};
    const log = { suppressed: [], enabled: 0 };
    window.noteDetect = {
        wantsDetect: () => !!o.wantsDetect,
        isEnabled: () => !!o.isEnabled,
        enable() { log.enabled++; return Promise.resolve(); },
        disable() {},
    };
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

test('an older note_detect without the handshake is a clean no-op', async () => {
    installNoteDetect({ wantsDetect: true, omitHandshake: true });
    try {
        fetchImpl = jsonFetch(okPayload([{ start: 1, duration: 1, text: 'a', midi: 60 }]));
        const r = window.feedBackViz_lyrics_karaoke();
        assert.doesNotThrow(() => r.init(makeCanvas(), bundle()));
        await flush();
        assert.doesNotThrow(() => r.destroy());
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
