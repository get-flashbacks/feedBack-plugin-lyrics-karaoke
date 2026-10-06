/**
 * Host-contract tests (#41) — the seam between this plugin and a live
 * FeedBack host.
 *
 * screen.test.js drives the renderer directly and vocal-engine.test.js
 * drives the microphone against an injected env. This file goes through the
 * HOST's surfaces instead, because that is where a user-visible regression
 * actually shows up:
 *
 *   - registration: what core — or a splitscreen panel carrying a saved viz
 *     preference — does with the factory this plugin publishes, and what
 *     happens when the host re-executes screen.js;
 *   - multiple instances: two panels on one page, sharing one event bus, one
 *     microphone and one playback-ownership claim;
 *   - failure events: what the host is told when a payload will not load, and
 *     why a draw() that throws is the worst outcome there (core reverts to
 *     the default highway after three failures and overwrites the saved viz);
 *   - teardown: no stale animation frame, no stale timer, no live track, and
 *     no panel still subscribed to the shared bus.
 *
 * The host stubs below are file-level globals, as in the other suites, but
 * each test resets what it touched and every panel it mounted is destroyed
 * in a `finally` — an instance left alive would own playback for the rest of
 * the file. Run with `node --test tests/host-contract.test.js`.
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Host stubs ───────────────────────────────────────────────────────────

/** `window.feedBack` — the host's event bus, plus the listener accounting a
 *  bus-leak assertion needs: a panel that forgets to unsubscribe is invisible
 *  to an emit-only stub. */
function makeBus() {
    const events = [];
    const listeners = new Map();
    return {
        events,
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
        off(name, fn) {
            const list = listeners.get(name) || [];
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        },
        emit(name, detail) {
            events.push({ name, detail });
            for (const fn of (listeners.get(name) || []).slice()) fn({ detail });
        },
        listenerCount(name) { return (listeners.get(name) || []).length; },
        of(name) { return events.filter((e) => e.name === name); },
        reset() { events.length = 0; },
    };
}

/** A highway canvas whose 2d context records what it was asked to do. Only
 *  the call list matters here — geometry is screen.test.js's job — but every
 *  method the real draw paths touch is present, so a missing method fails a
 *  test as a plugin bug rather than as a fake's. */
function makeCanvas(opts) {
    const o = opts || {};
    const ctx = {
        calls: [],
        fillStyle: null,
        record(name) { this.calls.push(name); },
        clearRect() { this.record('clearRect'); },
        fillRect() { this.record('fillRect'); },
        fillText() { this.record('fillText'); },
        measureText(t) { return { width: String(t).length * 6 }; },
        save() { this.record('save'); },
        restore() { this.record('restore'); },
        beginPath() { this.record('beginPath'); },
        closePath() {},
        rect() {},
        clip() {},
        moveTo() {},
        lineTo() {},
        arc() { this.record('arc'); },
        arcTo() {},
        quadraticCurveTo() {},
        stroke() { this.record('stroke'); },
        fill() { this.record('fill'); },
        createLinearGradient() { return { addColorStop() {} }; },
    };
    const canvas = {
        width: o.width === undefined ? 800 : o.width,
        height: o.height === undefined ? 140 : o.height,
        // showOverlay() sizes the ribbon canvas through .style, so the fake
        // needs it even though nothing here reads the result.
        style: {},
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

/** A host element. Only what the legacy overlay and the mic-slot lookup read:
 *  `style`, children and a box to size the canvas from. `#player-controls` is
 *  deliberately absent — the provider's microphone UI is unreachable without
 *  it, which is what keeps this file's DOM fake from having to model <select>. */
function fakeEl(tag) {
    return {
        tagName: tag,
        id: '',
        style: {},
        className: '',
        disabled: false,
        textContent: '',
        children: [],
        parentNode: null,
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
            child.parentNode = null;
            return child;
        },
        get firstChild() { return this.children[0] || null; },
        get isConnected() { return !!this.parentNode; },
        getBoundingClientRect() { return { width: 800, height: 140, left: 0, top: 0 }; },
        setAttribute() {},
        getAttribute() { return null; },
        addEventListener() {},
        removeEventListener() {},
    };
}

/** A stand-in for one panel's `window.highway`, modelling the renderer slot
 *  core exposes at `minHost`: a renderer must have `draw`, a swap destroys the
 *  outgoing renderer before initialising the incoming one, and repeated
 *  throwing draws eventually revert to the default highway with `viz:reverted`.
 *
 *  The revert threshold and its reset-on-success are this stub's model of that
 *  rule — core itself is not readable from here, and the suite never claims
 *  otherwise. What it does claim is the part this plugin controls: no
 *  `draw()` throws out of the panel, ever. `drawThrows` records every throw
 *  for the whole run rather than counting consecutive ones, so a single bad
 *  frame cannot be hidden by the seven good frames after it.
 *
 *  Each splitscreen panel has its own `hw`, so this is built per panel. */
function makeHighway(canvas, bundle) {
    return {
        current: null,
        installs: [],
        drawFailures: 0,
        drawThrows: [],
        reverted: null,
        time: 0,
        getTime() { return this.time; },
        isVisible() { return true; },
        setVisible() {},
        getLyricsVisible() { return true; },
        setLyricsVisible() {},
        setRenderer(r) {
            this.installs.push(r);
            if (r == null || typeof r.draw !== 'function') {
                this.reverted = { reason: 'no-draw' };
                this.current = null;
                return false;
            }
            if (this.current && typeof this.current.destroy === 'function') this.current.destroy();
            this.current = r;
            this.drawFailures = 0;
            if (typeof r.init === 'function') r.init(canvas, bundle);
            if (typeof r.resize === 'function') r.resize(canvas.width, canvas.height);
            bus.emit('viz:renderer:ready', {});
            return true;
        },
        /** One host frame. A throw is recorded and counted against the revert
         *  rule rather than propagated, so a panel that throws looks like what
         *  the host would do about it. */
        frame(time) {
            const r = this.current;
            if (!r) return;
            this.time = time;
            try {
                r.draw(bundle);
                this.drawFailures = 0;
            } catch (e) {
                this.drawThrows.push(e);
                this.drawFailures += 1;
                if (this.drawFailures >= 3) {
                    r.destroy();
                    this.current = null;
                    this.reverted = { reason: 'draw-failure', error: e };
                    bus.emit('viz:reverted', { reason: 'draw-failure' });
                }
            }
        },
    };
}

/** Web Audio, as far as the microphone controller touches it. The frame pump
 *  itself is vocal-engine.test.js's subject; here the context only has to
 *  exist so a panel can genuinely take and release the device. */
function FakeAudioContext() {
    return {
        state: 'running',
        sampleRate: 44100,
        closed: false,
        destination: {},
        resume() { return Promise.resolve(); },
        close() { this.closed = true; return Promise.resolve(); },
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
        createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; },
        createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; },
    };
}

const bus = makeBus();
const pageHighway = makeHighway(null, null);
const media = { gum: 0, tracks: [] };
const fetches = [];            // every URL the plugin asked for, in order
let fetchImpl = null;          // set per test
let gumFailNext = false;

global.window = {
    // Pre-set so the IIFE's DOMContentLoaded/init() bootstrap is skipped, as
    // in the other suites: init() wants a real document and a real screen.
    __feedBackLyricsKaraokeHooksInstalled: true,
    feedBack: bus,
    highway: pageHighway,
    addEventListener() {},
    devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AudioContext: FakeAudioContext,
};
global.document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById: (id) => HOST_DOM[id] || null,
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : fakeEl(tag)),
};
global.localStorage = global.window.localStorage;
global.fetch = (url, opts) => {
    fetches.push(url);
    return fetchImpl(url, opts);
};

/** The host's animation frame queue, recorded. The legacy overlay's rAF loop
 *  is the one timer this plugin owns outside the microphone, and it is only
 *  observable here — a live frame reschedules itself, so a loop that was
 *  never cancelled keeps reappearing in `pending` forever. */
const frames = { pending: new Map(), cancelled: [], nextId: 1 };
/** Run the queued frame the way a browser does — remove it, then invoke it,
 *  so a loop that reschedules leaves exactly one entry. */
function runFrame() {
    const entry = frames.pending.entries().next().value;
    if (!entry) return false;
    frames.pending.delete(entry[0]);
    entry[1]();
    return true;
}
global.requestAnimationFrame = (fn) => {
    const id = frames.nextId++;
    frames.pending.set(id, fn);
    return id;
};
global.cancelAnimationFrame = (id) => {
    frames.cancelled.push(id);
    frames.pending.delete(id);
};

// Node ships a read-only `navigator`, so the microphone stub is attached to
// the existing object — which is also exactly how the plugin reads it (its
// env calls `navigator()` on every start).
global.navigator.mediaDevices = {
    getUserMedia() {
        media.gum += 1;
        if (gumFailNext) {
            gumFailNext = false;
            return Promise.reject(Object.assign(new Error('in use'), { name: 'NotReadableError' }));
        }
        const track = {
            stopped: false,
            stop() { this.stopped = true; },
            addEventListener() {},
        };
        media.tracks.push(track);
        return Promise.resolve({ getTracks: () => [track] });
    },
    enumerateDevices: () => Promise.resolve([]),
};

const HOST_DOM = { player: fakeEl('div'), highway: fakeEl('div') };

const screen = require('../screen.js');
const PLUGIN_MANIFEST = require('../plugin.json');

/** Flush the fire-and-forget load chain (fetch -> then -> emit). */
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Put the overlay back the way a song change leaves it: no element in the
 *  DOM, no canvas bound, no rAF loop, `karaokeMode` false. `onSongLoaded(null)`
 *  is the module's own reset path (it runs resetForNewSong() before the
 *  sloppak check) and is the only handle a test has on the overlay's internal
 *  element reference — `setKaraokeMode(false)` alone only hides it, leaving
 *  the element parented for the next test to trip over. */
async function resetOverlay() {
    screen.setKaraokeMode(false);
    await screen._lkOverlayUi.onSongLoaded(null);
    screen._lkOverlayRender.detachCanvas();
}

// Every test starts from zeroed shared state: an empty event log, no queued
// frames, no microphone history, no overlay element. This is what makes the
// exact-count assertions meaningful — "one frame scheduled" means one, and
// "announced once" counts this test's events. Note it is a floor, not a leak
// detector: it also erases anything a previous test failed to clean up, so a
// test that cares about a count asserts it immediately after its own mount or
// teardown rather than trusting the reset.
beforeEach(async () => {
    bus.reset();
    fetches.length = 0;
    frames.pending.clear();
    frames.cancelled.length = 0;
    media.gum = 0;
    media.tracks.length = 0;
    HOST_DOM.player.children.length = 0;
    HOST_DOM.highway.children.length = 0;
    await resetOverlay();
});

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A canonical `/playback` response, the shape the route guarantees. */
function okPayload(tokens) {
    return {
        schema_version: 1,
        song: { filename: 'song.sloppak' },
        arrangement: { index: 0, id: 'vocals', name: 'Vocals' },
        voices: [{
            id: 'primary',
            name: 'Vocals',
            primary: true,
            tokens: tokens || [{ start: 1, duration: 1, text: 'la', midi: 69 }],
        }],
    };
}

function jsonFetch(body, status) {
    return () => Promise.resolve({
        text: () => Promise.resolve(JSON.stringify(body)),
        ok: status === undefined ? true : status < 400,
        status: status === undefined ? 200 : status,
    });
}

/** The renderer bundle. Shaped like the `song_info` message the host really
 *  sends: `audio_url`, no `filename`. */
function bundle(name, arrangementIndex) {
    return {
        currentTime: 1.0,
        songInfo: {
            audio_url: `/api/sloppak/${name || 'song.sloppak'}/file/stems/vocals.ogg`,
            arrangement_index: arrangementIndex === undefined ? 0 : arrangementIndex,
            arrangement: 'Vocals',
        },
    };
}

/** A Note Detect peer at the supported floor, so the ownership handshake is
 *  observable: every suppression change is recorded in order. `wantsDetect()`
 *  answers true — a user who was mid-detection before the panel opened — so
 *  the handshake includes the re-arm, which is the half that is easy to drop. */
function installPeer() {
    const handshake = [];
    // A callable factory with the handshake hung off it — note_detect's shape,
    // so a future `typeof factory === 'function'` check in screen.js cannot
    // break against this fake without a test noticing.
    window.createNoteDetector = function () { return {}; };
    window.createNoteDetector.setDefaultSuppressed = (v) => { handshake.push(v); };
    window.noteDetect = {
        wantsDetect() { return true; },
        isEnabled() { return false; },
        enable() { handshake.push('enable'); return Promise.resolve(); },
    };
    return handshake;
}

function uninstallPeer() {
    delete window.createNoteDetector;
    delete window.noteDetect;
}

/** Mount a panel through its OWN host highway, the way core's picker/Auto pass
 *  or a splitscreen panel with a saved viz preference does. `window.highway`
 *  stays the page's main highway — the only one the plugin itself ever reads —
 *  so a self-install attempt shows up there rather than here. */
function installPanel(opts) {
    const o = opts || {};
    // Always set, never inherit: a leftover fetch from a previous test would
    // decide what this panel loads.
    fetchImpl = o.fetch || jsonFetch(o.body || okPayload(), o.status);
    const canvas = makeCanvas(o);
    const b = bundle(o.name, o.arrangement);
    const hw = makeHighway(canvas, b);
    const renderer = window.feedBackViz_lyrics_karaoke();
    hw.setRenderer(renderer);
    return { renderer, canvas, hw, bundle: b };
}

/** Feed the legacy overlay from `/status`, `/data` and `/playback` so its
 *  draw path has real tokens, the way `song:loaded` would. */
function seedOverlaySong() {
    fetchImpl = (url) => {
        if (url.includes('/status')) {
            return jsonFetch({ has_pitch: true, filename: 'song.sloppak' })();
        }
        if (url.includes('/data')) {
            return jsonFetch({ tokens: [{ t: 1, d: 1, w: 'la', midi: 69 }, { t: 2, d: 1, w: 'la', midi: 71 }] })();
        }
        return jsonFetch(okPayload())();
    };
    return screen._lkOverlayUi.onSongLoaded({ filename: 'song.sloppak', format: 'sloppak' });
}

// ── Registration ─────────────────────────────────────────────────────────

test('the host installs the published factory through its own renderer slot', () => {
    const { renderer, hw } = installPanel({});
    try {
        assert.strictEqual(hw.current, renderer, 'core keeps what it installed');
        assert.strictEqual(renderer.contextType, '2d', 'read by core before init()');
        assert.strictEqual(hw.installs.length, 1);
        // The host stub's own announcement — distinct from the plugin's
        // `lyrics_karaoke:renderer-ready`, which means "the payload loaded".
        assert.strictEqual(bus.of('viz:renderer:ready').length, 1);
        // Everything core may call is optional except draw; the plugin
        // declares the whole set, so a host that honours any subset works.
        for (const method of ['init', 'draw', 'resize', 'destroy']) {
            assert.strictEqual(typeof renderer[method], 'function', method);
        }
    } finally {
        renderer.destroy();
    }
});

test('a host with no draw() on the renderer reverts to the default highway', () => {
    // The contract core enforces: anything without draw is refused. Our
    // factory must never hand it such an object, and this pins the host half
    // of that rule so the plugin-side half (contextType/init/draw all present)
    // cannot rot unnoticed.
    const hw = makeHighway(makeCanvas({}), bundle());
    assert.strictEqual(hw.setRenderer({ init() {} }), false);
    assert.strictEqual(hw.current, null);
    assert.strictEqual(hw.reverted.reason, 'no-draw');
});

test('the plugin never installs a renderer into the host slot itself', async () => {
    // Since #44 the manifest declares no visualization type, so this plugin is
    // not in core's picker or Auto walk: the host installs the renderer, not
    // the plugin. Calling setRenderer here would fight the host for one
    // canvas — two renderers, one highway, and a viz key that flips on every
    // re-install.
    const handshake = installPeer();
    const { renderer, canvas, hw } = installPanel({});
    try {
        await flush();
        // applySetting is what used to write the viz key and re-install; it
        // must not touch the host's renderer slot.
        renderer.applySetting('sungPart', 'part2');
        hw.frame(1.0);
        assert.strictEqual(hw.installs.length, 1, 'only the host installed it');
        assert.deepStrictEqual(pageHighway.installs, [],
            'the plugin must never call highway.setRenderer itself');
        assert.strictEqual(pageHighway.current, null, 'the page highway is untouched');
        assert.ok(canvas._ctx.calls.length > 0, 'the host drew it');
        assert.strictEqual(hw.reverted, null);
        assert.deepStrictEqual(handshake, [true], 'ownership claimed, peer suppressed once');
    } finally {
        renderer.destroy();
        uninstallPeer();
    }
});

test('re-executing screen.js keeps ONE factory and one ownership ledger', async () => {
    // The host may re-execute screen.js on plugin reload. Module state resets;
    // the window-level registration flag does not. If registration ran twice,
    // the second factory would close over a second `_vizInstances`, and the
    // panel built from it would hand playback back while the first panel is
    // still rendering — a duplicate renderer wearing one plugin's name.
    const handshake = installPeer();
    const first = installPanel({});
    const modulePath = require.resolve('../screen.js');
    const cached = require.cache[modulePath];
    let second;
    try {
        await flush();
        assert.strictEqual(first.renderer.ownsMic(), false);
        assert.strictEqual(screen._vizOwnsPlayback(), true);
        assert.deepStrictEqual(handshake, [true], 'the first panel claimed playback');

        const factoryBefore = window.feedBackViz_lyrics_karaoke;
        delete require.cache[modulePath];
        require('../screen.js');   // the host's re-execution

        // The registration guard, checked the only way that can fail: if the
        // re-execution republished, this would be module 2's factory, closing
        // over a second `_vizInstances`. Comparing the two globals to each
        // other would prove nothing — they are always assigned together.
        const factory = window.feedBackViz_lyrics_karaoke;
        assert.strictEqual(typeof factory, 'function');
        assert.strictEqual(factory, factoryBefore, 're-execution did not republish');
        assert.strictEqual(factory, window.slopsmithViz_lyrics_karaoke,
            'both globals still name one factory');
        second = factory();
        const canvas = makeCanvas({});
        second.init(canvas, bundle('song.sloppak', 0));
        await flush();

        second.destroy();
        assert.deepStrictEqual(handshake, [true],
            'a second panel leaving must not re-arm the peer while the first lives');
        assert.strictEqual(screen._vizOwnsPlayback(), true, 'the first panel still owns playback');

        first.renderer.destroy();
        assert.deepStrictEqual(handshake, [true, false, 'enable'],
            'released once, by the last panel, and the peer re-armed');
        assert.strictEqual(screen._vizOwnsPlayback(), false);
    } finally {
        if (second) second.destroy();
        first.renderer.destroy();
        require.cache[modulePath] = cached;
        uninstallPeer();
        delete window.feedBackViz_lyrics_karaoke;
        delete window.slopsmithViz_lyrics_karaoke;
        delete window.__feedBackLyricsKaraokeVizRegistered;
        // Re-arm the globals from the restored copy: the cache entry is back,
        // so require() would no-op and leave the factory unpublished.
        cached.exports._registerVizProvider();
    }
});

// ── Multiple instances ───────────────────────────────────────────────────

test('two panels each unsubscribe their own highway:visibility listener', async () => {
    const before = bus.listenerCount('highway:visibility');
    const a = installPanel({});
    const b = installPanel({});
    try {
        assert.strictEqual(bus.listenerCount('highway:visibility'), before + 2,
            'one shared-bus subscription per panel');
        a.renderer.destroy();
        assert.strictEqual(bus.listenerCount('highway:visibility'), before + 1,
            'the torn-down panel is off the bus');
        b.renderer.destroy();
        assert.strictEqual(bus.listenerCount('highway:visibility'), before);
    } finally {
        a.renderer.destroy();
        b.renderer.destroy();
    }
    assert.strictEqual(screen._vizOwnsPlayback(), false, 'no panel left holding playback');
});

test('a destroyed panel is not revived by a highway:visibility emit', async () => {
    // Teardown end to end, not the unsubscription pin — test 'two panels each
    // unsubscribe...' proves the listener is gone. Here the handler is inert
    // three times over (destroyed flag, released mic owner, nulled canvasRef),
    // and this asserts none of them can be talked out of it by a late emit.
    const a = installPanel({});
    const canvas = makeCanvas({});
    try {
        await flush();
        assert.strictEqual(a.renderer.canScore(), true);
        assert.strictEqual(await a.renderer.requestMic(), true, 'panel A holds the device');
        a.renderer.destroy();
        bus.emit('highway:visibility', { visible: false, canvas });
        bus.emit('highway:visibility', { visible: true, canvas: a.canvas });
        assert.strictEqual(a.renderer.ownsMic(), false);
        assert.strictEqual(screen._lkMic.getState().ownerId, null,
            'a stale handler cannot re-arm the microphone for a dead panel');
        assert.strictEqual(media.tracks.length, 1);
        assert.ok(media.tracks[0].stopped, 'its track is still stopped');
    } finally {
        a.renderer.destroy();
    }
    assert.strictEqual(screen._lkMic.getState().ownerId, null);
});

// ── Failure events ───────────────────────────────────────────────────────

test('the host stub reverts a renderer that keeps throwing, as core would', () => {
    // The negative control for the test below. Without it, "the panel never
    // reverted" could mean the stub never reverts anything — which would make
    // that assertion true of any plugin, broken or not.
    const hw = makeHighway(makeCanvas({}), bundle());
    hw.setRenderer({ draw() { throw new Error('boom'); }, destroy() {} });
    hw.frame(1.0);
    hw.frame(2.0);
    assert.strictEqual(hw.current, hw.current, 'two strikes is not a revert');
    hw.frame(3.0);
    assert.strictEqual(hw.reverted.reason, 'draw-failure');
    assert.strictEqual(hw.current, null, 'and the host dropped the renderer');
    assert.strictEqual(bus.of('viz:reverted').length, 1);
    assert.strictEqual(hw.drawThrows.length, 3, 'every throw was recorded, not just the last');
});

test('an unloadable payload never throws out of draw, so the host never reverts', async () => {
    // core reverts to the default highway after three throwing draws and
    // overwrites the user's saved viz choice on the way out. A 404 is the
    // NORMAL state for an unprepared song, so the panel has to keep drawing
    // through it — silently, and without a second fetch per frame.
    const { renderer, hw } = installPanel({ status: 404, body: { error: 'No lyrics data' } });
    try {
        await flush();
        await flush();
        const failed = bus.of('lyrics_karaoke:renderer-failed');
        assert.strictEqual(failed.length, 1, 'announced once, not once per frame');
        assert.strictEqual(failed[0].detail.reason, 'playback-unavailable');
        assert.strictEqual(failed[0].detail.status, 404);
        assert.strictEqual(failed[0].detail.pluginId, PLUGIN_MANIFEST.id);
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 0,
            'a failed load never claims to be ready');

        for (let t = 0; t < 8; t += 0.5) hw.frame(t);
        assert.deepStrictEqual(hw.drawThrows, [],
            'no frame of an unprepared song may throw, or core reverts and drops the saved viz');
        assert.strictEqual(hw.reverted, null, 'the host kept this renderer installed');
        // Each of those frames can only start a fetch; the announcement lands
        // in the continuation, so drain the microtasks before counting. Without
        // this the assertion below would run before a single retry existed.
        await flush();
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 1,
            'still no second announcement after 8 frames');
        assert.strictEqual(fetches.length, 1, 'and no retry fetch either');
    } finally {
        renderer.destroy();
    }
});

test('a payload that lands after teardown is dropped, not announced', async () => {
    // init() fires the load without awaiting it, so a response can arrive after
    // the panel is gone — a slow /playback on a song the user skipped. A dead
    // panel announcing readiness is how a second renderer starts drawing on a
    // canvas nobody is watching, so teardown has to invalidate the load it
    // started rather than let the response through.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { renderer, hw, canvas } = installPanel({ fetch: () => gate.then(() => jsonFetch(okPayload())()) });
    try {
        assert.strictEqual(fetches.length, 1, 'the load is in flight');
        renderer.destroy();

        release();
        await flush();
        await flush();
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-ready').length, 0,
            'a destroyed panel never announces readiness');
        assert.strictEqual(bus.of('lyrics_karaoke:renderer-failed').length, 0,
            'nor failure — the panel is simply gone');
        assert.strictEqual(renderer.canScore(), false, 'and it kept no scoring data');

        // The host keeps drawing until it drops the reference; that must not
        // throw, revert, resurrect anything, or reach the canvas at all.
        const painted = canvas._ctx.calls.length;
        hw.frame(1.0);
        assert.strictEqual(canvas._ctx.calls.length, painted, 'a dead panel paints nothing');
        assert.strictEqual(hw.reverted, null);
    } finally {
        renderer.destroy();
    }
});

test('a panel that cannot get a 2d context fails loudly and steals nothing', async () => {
    const handshake = installPeer();
    const healthy = installPanel({});
    const broken = installPanel({ contextFails: true });
    try {
        await flush();
        assert.strictEqual(broken.renderer.canScore(), false);
        const failed = bus.of('lyrics_karaoke:renderer-failed');
        assert.strictEqual(failed.length, 1);
        assert.strictEqual(failed[0].detail.reason, 'no-2d-context');
        assert.strictEqual(screen._vizOwnsPlayback(), true, 'the healthy panel keeps playback');
        assert.deepStrictEqual(handshake, [true], 'the peer stays suppressed');
        healthy.hw.frame(1.0);
        assert.strictEqual(healthy.hw.reverted, null);
    } finally {
        broken.renderer.destroy();
        healthy.renderer.destroy();
        uninstallPeer();
    }
    assert.deepStrictEqual(handshake, [true, false, 'enable'],
        'handed back once, and the peer re-armed');
});

// ── Teardown ─────────────────────────────────────────────────────────────

test('taking playback ownership stops the overlay: never two draw loops', async () => {
    // The legacy ribbon runs its own requestAnimationFrame loop. Exactly one
    // of it and the renderer may draw the same song, and the claim path is
    // what enforces it — a leftover frame here is a duplicate renderer that
    // survives a panel teardown and repaints a canvas nobody is watching.
    await seedOverlaySong();
    screen.setKaraokeMode(true);
    assert.strictEqual(frames.pending.size, 1, 'the overlay loop is running');

    const { renderer } = installPanel({});
    try {
        assert.strictEqual(frames.pending.size, 0, 'the overlay loop was cancelled by the claim');
        assert.ok(frames.cancelled.length > 0, 'by cancelAnimationFrame, not by accident');
        renderer.destroy();
        // Ownership went back to the overlay, which the claim stood down:
        // one loop again, not two.
        assert.strictEqual(frames.pending.size, 1, 'the overlay loop is back, exactly once');
    } finally {
        renderer.destroy();
        await resetOverlay();
    }
    assert.strictEqual(frames.pending.size, 0, 'and none once the test is over');
});

test('turning karaoke off leaves no scheduled frame behind', async () => {
    await seedOverlaySong();
    assert.strictEqual(HOST_DOM.player.children.length, 0, 'no overlay mounted yet');

    screen.setKaraokeMode(true);
    assert.strictEqual(frames.pending.size, 1);

    // Drive one real frame through the recorded queue, so "nothing is painted
    // after teardown" is a claim about a loop that demonstrably paints.
    assert.strictEqual(runFrame(), true);
    const overlayCanvas = HOST_DOM.player.children[0].children[0];
    assert.ok(overlayCanvas._ctx.calls.length > 0, 'the overlay paints while it is up');

    screen.setKaraokeMode(false);
    assert.strictEqual(frames.pending.size, 0, 'no frame is still scheduled');

    const callsAtTeardown = overlayCanvas._ctx.calls.length;
    assert.strictEqual(runFrame(), false, 'nothing is left to run');
    assert.strictEqual(overlayCanvas._ctx.calls.length, callsAtTeardown,
        'a captured frame callback draws nothing after teardown');
    assert.strictEqual(frames.pending.size, 0, 'and schedules no successor');
    await resetOverlay();
});

test('destroy releases the microphone device and refuses a later request', async () => {
    const before = media.gum;
    const { renderer } = installPanel({});
    try {
        await flush();
        assert.strictEqual(renderer.canScore(), true);
        assert.strictEqual(await renderer.requestMic(), true);
        assert.strictEqual(media.gum, before + 1);
        assert.strictEqual(renderer.ownsMic(), true);
        assert.strictEqual(media.tracks.filter((t) => !t.stopped).length, 1);

        renderer.destroy();
        assert.strictEqual(renderer.ownsMic(), false);
        assert.strictEqual(screen._lkMic.getState().ownerId, null);
        assert.strictEqual(media.tracks.filter((t) => !t.stopped).length, 0,
            'every track stopped — no leaked microphone');

        // A late click (or a stale timer) must not reopen the device.
        assert.strictEqual(await renderer.requestMic(), false);
        assert.strictEqual(media.gum, before + 1, 'no second getUserMedia after teardown');
    } finally {
        renderer.destroy();
    }
});

test('a pending transfer retry cannot take the device after its target dies', async () => {
    // A release-then-re-grab inside one tick can land a NotReadableError, so
    // the transfer retries once after a 150ms settle. A panel destroyed inside
    // that window must not come back from the dead holding the microphone.
    const before = media.gum;
    const a = installPanel({ name: 'a.sloppak' });
    const b = installPanel({ name: 'b.sloppak' });
    try {
        await flush();
        assert.strictEqual(await screen._vizSelectMicTarget(a.renderer, false), true);
        assert.strictEqual(await a.renderer.requestMic(), true);
        assert.strictEqual(a.renderer.ownsMic(), true);

        // The transfer's first grab fails transiently, so the retry is armed.
        gumFailNext = true;
        const transfer = screen._vizSelectMicTarget(b.renderer, true);
        await sleep(20);
        b.renderer.destroy();

        assert.strictEqual(await transfer, false);
        assert.strictEqual(media.gum, before + 2, 'click + one failed re-grab, and no third');
        assert.strictEqual(b.renderer.ownsMic(), false);
        assert.strictEqual(screen._lkMic.getState().ownerId, null,
            'nobody holds the device after the target panel was destroyed');
    } finally {
        a.renderer.destroy();
        b.renderer.destroy();
    }
    assert.strictEqual(screen._lkMic.getState().ownerId, null);
    assert.strictEqual(media.tracks.filter((t) => !t.stopped).length, 0);
});