/**
 * #63 — the karaoke settings popover.
 *
 * The renderer's per-panel `applySetting` contract never went away when the
 * manifest descriptors were retired with the viz picker (#44); it just had no
 * front door. These tests drive that front door end-to-end: the legacy
 * control cluster builds a Settings button, the button opens a popover whose
 * controls fan out to the live renderer(s), shared scoring keys reach every
 * panel and persist through the engine prefs document, voice/rail stay
 * panel-local, a vanished part falls back safely, and the whole surface tears
 * down with the last panel — all without ever touching getUserMedia.
 *
 * No real host: screen.js is loaded against the stubs below with its
 * bootstrap guard pre-set so `init()` never runs.
 *
 * Run with `node tests/karaoke-settings.test.js`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ── Host stubs ──────────────────────────────────────────────────────────

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
        off(name, fn) {
            const arr = listeners.get(name) || [];
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        },
        of(name) { return events.filter((e) => e.name === name); },
        reset() { events.length = 0; },
    };
}

/** A DOM element with the exact surface the settings popover, the control
 *  cluster and the renderer's DOM touches: children, value/checked, text,
 *  attributes and listeners, without a browser. */
function fakeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        id: '',
        type: '',
        className: '',
        title: '',
        disabled: false,
        checked: false,
        min: '',
        max: '',
        step: '',
        style: {},
        children: [],
        parentNode: null,
        listeners: {},
        _attrs: {},
        _value: '',
        _text: '',
        get firstChild() { return this.children[0] || null; },
        get value() { return this._value; },
        set value(v) { this._value = v; },
        get textContent() { return this._text; },
        set textContent(v) { this._text = v; },
        get isConnected() { return this.parentNode !== null; },
        setAttribute(n, v) { this._attrs[n] = v; },
        getAttribute(n) { return this._attrs[n]; },
        removeAttribute(n) { delete this._attrs[n]; },
        addEventListener(n, fn) { this.listeners[n] = fn; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        insertBefore(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parentNode = null;
            return c;
        },
        getContext: () => null,
        getBoundingClientRect: () => ({ width: 800, height: 140 }),
        width: 800,
        height: 140,
    };
    el.style = el.style || {};
    return el;
}

function makeCanvas() {
    const ctx = {
        canvas: null,
        calls: [],
        clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {},
        clip() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {},
        quadraticCurveTo() {}, stroke() {}, fill() {}, closePath() {},
        fillRect() {}, fillText() {},
        measureText: () => ({ width: 0 }),
        createLinearGradient: () => ({ addColorStop() {} }),
    };
    const canvas = { width: 800, height: 140, getContext: (t) => (t === '2d' ? (ctx.canvas = canvas, ctx) : null) };
    return canvas;
}

function makeStorage(seed) {
    const map = new Map(Object.entries(seed || {}));
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
    };
}

// The harness exists once: ensureToggleButton() is idempotent (the button is
// created once per page in production), so a per-test DOM would leave the
// module holding the first test's surface.
const parent = fakeEl('div');
const lyricsBtn = fakeEl('button');
lyricsBtn.id = 'btn-lyrics';
lyricsBtn.parentNode = parent;
parent.appendChild(lyricsBtn);

const storage = makeStorage();
const bus = makeBus();
let fetchImpl = null;
let gumCount = 0;

global.window = {
    __feedBackLyricsKaraokeHooksInstalled: true,
    feedBack: bus,
    addEventListener() {},
    devicePixelRatio: 1,
    localStorage: storage,
};
global.document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById: (id) => (id === 'btn-lyrics' ? lyricsBtn : null),
    createElement: (tag) => fakeEl(tag),
};
global.localStorage = storage;
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
        mediaDevices: {
            getUserMedia: () => { gumCount++; return Promise.reject(new Error('not in tests')); },
            enumerateDevices: () => Promise.resolve([]),
            addEventListener() {},
        },
    },
});
global.fetch = (url, opts) => fetchImpl(url, opts);

const screen = require('../screen.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function payload(voices) {
    return {
        schema_version: 1,
        song: { filename: 'song.sloppak' },
        arrangement: { index: 0, id: 'vocals', name: 'Vocals' },
        voices,
    };
}

function voice(id, name, midi, primary) {
    return { id, name, primary: !!primary, tokens: [{ start: 1, duration: 1, text: 'a', midi: midi === undefined ? 60 : midi }] };
}

function bundle(name) {
    return {
        currentTime: 1.0,
        songInfo: {
            audio_url: `/api/sloppak/${name || 'song.sloppak'}/file/stems/vocals.ogg`,
            arrangement_index: 0,
            arrangement: 'Vocals',
        },
    };
}

async function mount(body, name) {
    fetchImpl = () => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
    });
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = makeCanvas();
    r.init(canvas, bundle(name));
    await flush();
    return r;
}

const ui = screen._vizSettingsUi;
const openSettings = () => { ui.setOpen(true); };
const closeSettings = () => { ui.setOpen(false); };

// Build the control cluster once, before any renderer exists.
screen._lkOverlayUi.ensureToggleButton();

test('the button is hidden until a renderer is live, then exposes every control', async () => {
    const btn = ui.button();
    assert.ok(btn, 'the settings button was built next to the karaoke controls');
    assert.strictEqual(btn.style.display, 'none', 'no renderer → no settings surface');

    const r = await mount(payload([voice('primary', 'Vocals', 60, true)]));
    try {
        assert.strictEqual(btn.style.display, '', 'a live renderer reveals the button');

        openSettings();
        const panel = ui.panel();
        assert.strictEqual(ui.open(), true);
        assert.strictEqual(panel.root.style.display, '', 'opening shows the popover');

        for (const desc of ui.controls) {
            const row = panel.rows[desc.key];
            assert.ok(row, `row for ${desc.key}`);
            assert.strictEqual(row.input.getAttribute('aria-label'), desc.label);
            assert.strictEqual(row.input.listeners.change || row.input.listeners.input ? true : false, true,
                `${desc.key} is wired to a change/input listener`);
        }
        const tolerance = panel.rows.tolerance.input;
        assert.strictEqual(tolerance.min, '0.25', 'tolerance range carries its lower bound');
        assert.strictEqual(tolerance.max, '3', 'tolerance range carries its upper bound');
        assert.strictEqual(panel.rows.leftRailMode.input.children.length, 3, 'rail has three modes');

        closeSettings();
    } finally {
        r.destroy();
    }
    assert.strictEqual(btn.style.display, 'none', 'teardown hides the button again');
});

test('shared pitch controls reach every panel and persist to the engine prefs', async () => {
    const a = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'a.sloppak');
    const b = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'b.sloppak');
    try {
        openSettings();
        const row = ui.panel().rows.tolerance;
        row.input.value = '2.5';
        row.input.listeners.input();

        assert.strictEqual(a.getSetting('tolerance'), 2.5);
        assert.strictEqual(b.getSetting('tolerance'), 2.5, 'shared setting reached the second panel');

        const saved = JSON.parse(storage.getItem('lyrics_karaoke.prefs.v1'));
        assert.strictEqual(saved.tolerance, 2.5, 'the calibration was persisted');
        assert.strictEqual(screen._lkLoadPrefs(storage).prefs.tolerance, 2.5,
            'a reload reads the same value back');

        // A panel mounted afterwards starts from the persisted value.
        const c = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'c.sloppak');
        assert.strictEqual(c.getSetting('tolerance'), 2.5);
        c.destroy();
        closeSettings();
    } finally {
        a.destroy();
        b.destroy();
    }
});

test('voice and rail controls stay panel-local, following the scored panel', async () => {
    const duet = payload([
        voice('primary', 'Lead', 60, true),
        voice('part2', 'Harmony', 64, false),
    ]);
    const a = await mount(duet, 'duet-a.sloppak');
    const b = await mount(duet, 'duet-b.sloppak');
    try {
        openSettings();

        // Default target is the first live/eligible panel.
        assert.strictEqual(ui.target(), a);
        ui.panel().rows.sungPart.input.value = 'part2';
        ui.panel().rows.sungPart.input.listeners.change();
        assert.strictEqual(a.getSetting('sungPart'), 'part2');
        assert.strictEqual(b.getSetting('sungPart'), 'primary', 'part did not leak across panels');

        ui.panel().rows.leftRailMode.input.value = 'off';
        ui.panel().rows.leftRailMode.input.listeners.change();
        assert.strictEqual(a.getSetting('leftRailMode'), 'off');
        assert.strictEqual(b.getSetting('leftRailMode'), 'absolute', 'rail did not leak across panels');

        // Retarget the mic (and therefore the settings) at the second panel.
        await screen._vizSelectMicTarget(b, false);
        ui.refresh();
        assert.strictEqual(ui.target(), b);
        ui.panel().rows.leftRailMode.input.value = 'technique';
        ui.panel().rows.leftRailMode.input.listeners.change();
        assert.strictEqual(b.getSetting('leftRailMode'), 'technique');
        assert.strictEqual(a.getSetting('leftRailMode'), 'off', 'the first panel kept its own value');
        closeSettings();
    } finally {
        a.destroy();
        b.destroy();
    }
});

test('voice options come from the payload and a vanished part falls back safely', async () => {
    const trio = await mount(payload([
        voice('primary', 'Lead', 60, true),
        voice('part2', 'High harmony', 64, false),
        voice('part3', 'Low harmony', 55, false),
    ]), 'trio.sloppak');
    try {
        openSettings();
        const voiceRow = ui.panel().rows.sungPart;
        assert.deepStrictEqual(voiceRow.input.children.map((o) => o.value),
            ['primary', 'part2', 'part3'], 'options mirror the payload voices');
        assert.deepStrictEqual(voiceRow.input.children.map((o) => o.textContent),
            ['Lead', 'High harmony', 'Low harmony'], 'labels prefer the voice name');

        voiceRow.input.value = 'part3';
        voiceRow.input.listeners.change();
        assert.strictEqual(trio.getSetting('sungPart'), 'part3');

        // A single-voice payload has no part3 — sanitized at the door.
        const solo = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'solo.sloppak');
        assert.strictEqual(solo.applySetting('sungPart', 'part3'), true);
        assert.strictEqual(solo.getSetting('sungPart'), 'primary', 'missing part falls back to primary');
        solo.destroy();
        closeSettings();
    } finally {
        trio.destroy();
    }
});

test('Sung part offers only the four parts the scorer resolves', async () => {
    const many = await mount(payload([
        voice('primary', 'Lead', 60, true),
        voice('part2', 'High harmony', 64, false),
        voice('part3', 'Mid harmony', 65, false),
        voice('part4', 'Low harmony', 55, false),
        voice('part5', 'Choir', 50, false),
    ]), 'choir.sloppak');
    try {
        openSettings();
        const voiceRow = ui.panel().rows.sungPart;
        assert.deepStrictEqual(voiceRow.input.children.map((o) => o.value),
            ['primary', 'part2', 'part3', 'part4'],
            'options stop at the highest part the resolver can address');

        voiceRow.input.value = 'part4';
        voiceRow.input.listeners.change();
        assert.strictEqual(many.getSetting('sungPart'), 'part4', 'part4 is a real selection');
        closeSettings();
    } finally {
        many.destroy();
    }
});

test('Live scoring is shared: one toggle pauses every panel and can be turned back on', async () => {
    const a = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'shared-a.sloppak');
    const b = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'shared-b.sloppak');
    try {
        openSettings();
        assert.strictEqual(ui.target(), a);

        const row = ui.panel().rows.micFeedback;
        row.input.checked = false;
        row.input.listeners.change();
        assert.strictEqual(a.getSetting('micFeedback'), false);
        assert.strictEqual(b.getSetting('micFeedback'), false, 'the shared toggle reached the second panel');

        // With no panel able to score, the surface must stay reachable (target
        // falls back to a live panel) and show the true shared value — otherwise
        // the panel that was switched off can never be switched back on.
        assert.strictEqual(ui.button().style.display, '', 'settings stay reachable with scoring off');
        assert.ok([a, b].includes(ui.target()), 'settings still target a live panel');
        assert.strictEqual(ui.panel().rows.micFeedback.input.checked, false);

        // A panel mounted while scoring is off adopts the shared value rather
        // than re-enabling itself at the default.
        const c = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'shared-c.sloppak');
        assert.strictEqual(c.getSetting('micFeedback'), false, 'a later panel inherits the shared value');
        c.destroy();

        row.input.checked = true;
        row.input.listeners.change();
        assert.strictEqual(a.getSetting('micFeedback'), true);
        assert.strictEqual(b.getSetting('micFeedback'), true, 'live scoring can be turned back on');
        closeSettings();
    } finally {
        a.destroy();
        b.destroy();
    }
});

test('opening and driving settings never requests the microphone', async () => {
    const before = gumCount;
    const lyricsOnly = await mount(payload([voice('primary', 'Vocals', null, true)]), 'lyrics.sloppak');
    try {
        assert.strictEqual(lyricsOnly.canScore(), false, 'a lyrics-only part cannot score');
        assert.strictEqual(ui.button().style.display, '', 'settings are still reachable');
        openSettings();
        const panel = ui.panel();
        // Even a lyrics-only payload exposes its voice.
        assert.strictEqual(panel.rows.sungPart.input.children.length, 1);

        panel.rows.micFeedback.input.checked = false;
        panel.rows.micFeedback.input.listeners.change();
        panel.rows.tolerance.input.value = '1.75';
        panel.rows.tolerance.input.listeners.input();
        ui.refresh();

        assert.strictEqual(gumCount, before, 'no getUserMedia from opening or changing settings');
        assert.strictEqual(lyricsOnly.getSetting('micFeedback'), false);
        assert.strictEqual(lyricsOnly.getSetting('tolerance'), 1.75);
        closeSettings();
    } finally {
        lyricsOnly.destroy();
    }
});

test('the last teardown closes the popover and hides the surface', async () => {
    const r = await mount(payload([voice('primary', 'Vocals', 60, true)]), 'teardown.sloppak');
    openSettings();
    assert.strictEqual(ui.open(), true);
    r.destroy();
    assert.strictEqual(ui.button().style.display, 'none');
    assert.strictEqual(ui.panel().root.style.display, 'none');
    assert.strictEqual(ui.open(), false, 'teardown closes the popover');
    // Idempotent: destroying a fresh renderer again is safe.
    r.destroy();
});
