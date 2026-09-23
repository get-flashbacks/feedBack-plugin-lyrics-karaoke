/**
 * Vocal pitch engine tests (#11): YIN helpers, octave-free distance,
 * tolerance boundaries, timing offsets, seek-back reset, scoring
 * aggregation, preferences migration, and microphone resource teardown.
 *
 * No live microphone: the mic controller is driven through an injected fake
 * environment, and the provider wiring through fake `navigator` /
 * `AudioContext` globals. Run with `node tests/vocal-engine.test.js`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ── Host stubs (screen.js needs a window to evaluate) ───────────────────

const busListeners = new Map();
const bus = {
    emit(name, detail) { for (const fn of busListeners.get(name) || []) fn({ detail }); },
    on(name, fn) {
        if (!busListeners.has(name)) busListeners.set(name, []);
        busListeners.get(name).push(fn);
    },
    off(name, fn) {
        const list = busListeners.get(name) || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    },
};

let fetchImpl = null;
global.window = {
    __feedBackLyricsKaraokeHooksInstalled: true,   // skip DOM bootstrap
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

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sine(freq, sampleRate, n, phase0) {
    const out = new Float32Array(n);
    const p0 = phase0 || 0;
    for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin(2 * Math.PI * freq * (p0 + i) / sampleRate);
    return out;
}

function createWebAudioMocks(ctx) {
    // Shared factory for Web Audio API mocks (createMediaStreamSource, createScriptProcessor, createGain).
    // Mocks are attached directly to ctx to support both makeMicEnv (options-driven) and global AudioContext.
    ctx.createMediaStreamSource = function () { return { connect() {}, disconnect() {} }; };
    ctx.createScriptProcessor = function () {
        ctx.processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        return ctx.processor;
    };
    ctx.createGain = function () { return { gain: { value: 1 }, connect() {}, disconnect() {} }; };
}

// ── YIN helpers ─────────────────────────────────────────────────────────

test('yinDetect finds the fundamental of a clean sine', () => {
    for (const f of [110, 220, 440, 880]) {
        const r = screen.yinDetect(sine(f, 44100, 4096), 44100, 50);
        assert.ok(Math.abs(r.freq - f) / f < 0.01, `${f} Hz detected as ${r.freq}`);
        assert.ok(r.confidence > 0.9);
    }
});

test('_lkDetectMidi returns a MIDI pitch for voice and null for silence', () => {
    const voiced = screen._lkDetectMidi(sine(440, 44100, 4096), 44100);
    assert.ok(voiced && Math.abs(voiced.midi - 69) < 0.1);
    assert.strictEqual(screen._lkDetectMidi(new Float32Array(4096), 44100), null);
    // Below the vocal floor the ring can't hold two periods → unvoiced.
    assert.strictEqual(screen._lkDetectMidi(sine(30, 44100, 4096), 44100), null);
});

test('freqToMidi / midiToName', () => {
    assert.strictEqual(screen.freqToMidi(440), 69);
    assert.ok(Math.abs(screen.freqToMidi(261.6256) - 60) < 0.001);
    assert.strictEqual(screen.midiToName(60), 'C4');
    assert.strictEqual(screen.midiToName(69.4), 'A4');
    assert.strictEqual(screen.midiToName(-1), 'B-2');
});

// ── Pitch matching ──────────────────────────────────────────────────────

test('octave-free distance folds onto [0, 6]', () => {
    assert.strictEqual(screen._lkPitchDistance(72, 60, false), 12);
    assert.strictEqual(screen._lkPitchDistance(72, 60, true), 0);
    assert.strictEqual(screen._lkPitchDistance(48, 60, true), 0);
    assert.strictEqual(screen._lkPitchDistance(67, 60, true), 5);    // a fifth up = a fourth down
    assert.strictEqual(screen._lkPitchDistance(66, 60, true), 6);    // tritone is the max
    assert.ok(Math.abs(screen._lkPitchDistance(71.5, 60, true) - 0.5) < 0.000000001);
});

test('tolerance boundary is inclusive and float-safe', () => {
    assert.strictEqual(screen._lkPitchMatches(60.5, 60, 0.5, false), true);
    assert.strictEqual(screen._lkPitchMatches(59.5, 60, 0.5, false), true);
    assert.strictEqual(screen._lkPitchMatches(60.51, 60, 0.5, false), false);
    assert.strictEqual(screen._lkPitchMatches(60 + 0.1 + 0.2, 60, 0.3, false), true);
    assert.strictEqual(screen._lkPitchMatches(73, 60, 1, false), false);
    assert.strictEqual(screen._lkPitchMatches(73, 60, 1, true), true);
});

// ── Timing ──────────────────────────────────────────────────────────────

test('frames are dated at the buffer midpoint, scaled by playback rate', () => {
    // 4410 samples @ 44.1 kHz = 100 ms window → midpoint 50 ms back.
    assert.ok(Math.abs(screen._lkFrameMidpointTime(10, 4410, 44100, 1) - 9.95) < 0.000000001);
    assert.ok(Math.abs(screen._lkFrameMidpointTime(10, 4410, 44100, 0.5) - 9.975) < 0.000000001);
    assert.ok(Math.abs(screen._lkFrameMidpointTime(10, 4410, 44100, 2) - 9.9) < 0.000000001);
});

test('mic offset is the only calibration and is rate-aware', () => {
    assert.strictEqual(screen._lkApplyMicOffset(10, 0, 1), 10);
    assert.ok(Math.abs(screen._lkApplyMicOffset(10, 100, 1) - 9.9) < 0.000000001);    // earlier
    assert.ok(Math.abs(screen._lkApplyMicOffset(10, -100, 1) - 10.1) < 0.000000001);  // later
    assert.ok(Math.abs(screen._lkApplyMicOffset(10, 100, 0.5) - 9.95) < 0.000000001);
});

// ── Settings / preferences ──────────────────────────────────────────────

test('scoring settings are normalized and clamped', () => {
    assert.deepStrictEqual(screen._lkNormalizeScoringSettings({}),
        { tolerance: 1, octaveIndependent: false, micOffsetMs: 0 });
    assert.deepStrictEqual(
        screen._lkNormalizeScoringSettings({ tolerance: '0.75', octaveIndependent: '1', micOffsetMs: '-40' }),
        { tolerance: 0.75, octaveIndependent: true, micOffsetMs: -40 });
    assert.deepStrictEqual(
        screen._lkNormalizeScoringSettings({ tolerance: 99, octaveIndependent: 'no', micOffsetMs: 1000000 }),
        { tolerance: 3, octaveIndependent: false, micOffsetMs: 1000 });
    assert.strictEqual(screen._lkNormalizeScoringSettings({ tolerance: 'nan' }).tolerance, 1);
    assert.strictEqual(screen._lkNormalizeChannel('2'), '2');
    assert.strictEqual(screen._lkNormalizeChannel('3'), 'mix');
    assert.strictEqual(screen._lkNormalizeChannel(null), 'mix');
});

function memStorage(init) {
    const m = new Map(Object.entries(init || {}));
    return {
        m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
    };
}

test('prefs migrate compatible Karaoke Highway values once, never micOn', () => {
    const st = memStorage({
        'vocals_highway.tolerance': '1.5',
        'vocals_highway.octaveIndependent': '1',
        'vocals_highway.micOffsetMs': '120',
        'vocals_highway.micChannel': '2',
        'vocals_highway.micDeviceId': 'dev-42',
        'vocals_highway.micOn': '1',
    });
    const { prefs, migrated } = screen._lkLoadPrefs(st);
    assert.strictEqual(migrated, true);
    assert.deepStrictEqual(prefs, {
        v: 1, deviceId: 'dev-42', channel: '2',
        tolerance: 1.5, octaveIndependent: true, micOffsetMs: 120,
    });
    assert.ok(!('micOn' in prefs));
});

test('an existing prefs document wins over legacy keys', () => {
    const st = memStorage({
        'lyrics_karaoke.prefs.v1': JSON.stringify({ v: 1, tolerance: 0.5, channel: '1' }),
        'vocals_highway.tolerance': '2',
    });
    const { prefs, migrated } = screen._lkLoadPrefs(st);
    assert.strictEqual(migrated, false);
    assert.strictEqual(prefs.tolerance, 0.5);
    assert.strictEqual(prefs.channel, '1');
    assert.strictEqual(prefs.micOffsetMs, 0);
});

test('prefs survive missing, broken, or throwing storage', () => {
    const defaults = { v: 1, deviceId: '', channel: 'mix', tolerance: 1, octaveIndependent: false, micOffsetMs: 0 };
    assert.deepStrictEqual(screen._lkLoadPrefs(null).prefs, defaults);
    assert.deepStrictEqual(screen._lkLoadPrefs(memStorage({ 'lyrics_karaoke.prefs.v1': '{nope' })).prefs, defaults);
    const throwing = { getItem() { throw new Error('denied'); } };
    assert.deepStrictEqual(screen._lkLoadPrefs(throwing).prefs, defaults);
});

// ── Channel selection ───────────────────────────────────────────────────

test('channel selection picks, mixes, or falls back to mono', () => {
    const a = Float32Array.from([1, 1, 1, 1]);
    const b = Float32Array.from([0, 0, 0, 0]);
    const stereo = { numberOfChannels: 2, getChannelData: (i) => (i === 0 ? a : b) };
    const mono = { numberOfChannels: 1, getChannelData: () => a };
    const mix = new Float32Array(4);
    assert.strictEqual(screen._lkSelectChannel(stereo, '1', mix), a);
    assert.strictEqual(screen._lkSelectChannel(stereo, '2', mix), b);
    assert.deepStrictEqual(Array.from(screen._lkSelectChannel(stereo, 'mix', mix)), [0.5, 0.5, 0.5, 0.5]);
    assert.strictEqual(screen._lkSelectChannel(stereo, 'mix', mix), mix, 'reuses the preallocated buffer');
    assert.strictEqual(screen._lkSelectChannel(mono, '2', mix), a, 'mono ignores the channel choice');
});

// ── Scorer ──────────────────────────────────────────────────────────────

/** Feed frames every `step` s from t0 to t1, singing `midiAt(t)`. */
function sing(scorer, t0, t1, midiAt, step, rate) {
    const dt = step || 0.05;
    for (let t = t0; t <= t1 + 0.000000001; t += dt) {
        scorer.ingest({ t, midi: midiAt(t), rate: rate || 1, wallAt: 0 });
    }
}

const TOKENS = [
    { start: 1, duration: 1, midi: 60 },
    { start: 2, duration: 1, midi: 62 },
    { start: 3, duration: 1, midi: null },     // lyric-only: never judged
    { start: 4, duration: 1, midi: 64 },
];

test('scoring aggregation: hits, misses, streak, best streak, score, quality', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens(TOKENS);
    // Perfect on 60, perfect on 62, silence over the lyric, wrong on 64.
    sing(s, 0.9, 5.2, (t) => (t < 2 ? 60 : t < 3 ? 62 : t < 4 ? null : 70));
    const st = s.stats();
    assert.strictEqual(st.hits, 2);
    assert.strictEqual(st.misses, 1);
    assert.strictEqual(st.judged, 3);
    assert.strictEqual(st.streak, 0, 'the miss broke the streak');
    assert.strictEqual(st.bestStreak, 2);
    // 100·1.0·1.1 + 100·1.0·1.2 + 50·0
    assert.strictEqual(st.score, 110 + 120);
    assert.strictEqual(s.resultFor(0).quality, 'perfect');
    assert.strictEqual(s.resultFor(1).quality, 'perfect');
    assert.strictEqual(s.resultFor(2), null, 'lyric-only syllable is never judged');
    assert.strictEqual(s.resultFor(3).quality, 'miss');
    assert.ok(st.accuracy > 0.6 && st.accuracy < 0.7, `sample accuracy ${st.accuracy}`);
});

test('partial accuracy grades as good (hit) vs miss around 50%', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens([{ start: 1, duration: 1, midi: 60 }, { start: 2, duration: 1, midi: 60 }]);
    // First syllable: in tune for the first ~60% only. Second: ~30%.
    sing(s, 1, 3.1, (t) => {
        if (t < 2) return (t - 1) < 0.6 ? 60 : 65;
        return (t - 2) < 0.3 ? 60 : 65;
    });
    assert.strictEqual(s.resultFor(0).quality, 'good');
    assert.strictEqual(s.resultFor(1).quality, 'miss');
    assert.strictEqual(s.stats().bestStreak, 1);
});

test('an unsung pitched syllable is a miss while the mic is listening', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens(TOKENS.slice(0, 2));
    sing(s, 0.9, 3.1, () => null);   // listening, silent
    assert.strictEqual(s.stats().misses, 2);
    assert.strictEqual(s.stats().accuracy, null, 'no voiced samples → no accuracy yet');
});

test('tolerance and octave-free settings apply to matching', () => {
    const run = (settings, sungMidi) => {
        const s = screen._lkCreateVocalScorer(settings);
        s.setTokens([{ start: 1, duration: 1, midi: 60 }]);
        sing(s, 1, 2.1, () => sungMidi);
        return s.resultFor(0).quality;
    };
    assert.strictEqual(run({ tolerance: 1 }, 61), 'perfect');
    assert.strictEqual(run({ tolerance: 0.5 }, 61), 'miss');
    assert.strictEqual(run({ octaveIndependent: false }, 72), 'miss');
    assert.strictEqual(run({ octaveIndependent: true }, 72), 'perfect');
});

test('mic offset shifts scoring and the sung trace, not the input clock', () => {
    // Singer is 200 ms late: frames at t sing the note due at t - 0.2.
    const late = (t) => (t - 0.2 < 2 ? 60 : 62);
    const plain = screen._lkCreateVocalScorer();
    plain.setTokens(TOKENS.slice(0, 2));
    sing(plain, 1.0, 3.3, late);
    const calibrated = screen._lkCreateVocalScorer({ micOffsetMs: 200 });
    calibrated.setTokens(TOKENS.slice(0, 2));
    sing(calibrated, 1.0, 3.3, late);
    assert.ok(calibrated.stats().accuracy > plain.stats().accuracy,
        `${calibrated.stats().accuracy} vs ${plain.stats().accuracy}`);
    assert.strictEqual(calibrated.resultFor(1).quality, 'perfect');
    // The trace carries the shifted time.
    assert.ok(Math.abs(calibrated.trace()[0].t - 0.8) < 0.000000001);
    assert.ok(Math.abs(plain.trace()[0].t - 1.0) < 0.000000001);
});

test('a live offset change does not read as a rewind', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens(TOKENS.slice(0, 2));
    sing(s, 1, 1.5, () => 60);
    const before = s.resultFor(0).samplesIn;
    s.setSettings({ micOffsetMs: 800 });   // shifts subsequent frames 0.8 s earlier
    s.ingest({ t: 1.55, midi: 60, rate: 1 });
    assert.ok(s.resultFor(0) && s.resultFor(0).samplesIn >= before, 'take survived the calibration nudge');
    assert.strictEqual(s.getSettings().micOffsetMs, 800);
});

test('seek-back wipes the take so old scores cannot resurrect', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens(TOKENS);
    sing(s, 0.9, 3.2, (t) => (t < 2 ? 60 : 62));
    assert.strictEqual(s.stats().hits, 2);
    s.ingest({ t: 1.2, midi: 55, rate: 1 });   // rewound ~2 s
    assert.strictEqual(s.stats().hits, 0);
    assert.strictEqual(s.stats().score, 0);
    assert.strictEqual(s.resultFor(1), null);
    assert.strictEqual(s.trace().length, 1);
});

test('small backsteps and pauses are dropped, not scored or reset', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens([{ start: 1, duration: 2, midi: 60 }]);
    sing(s, 1, 1.5, () => 60);
    const n = s.resultFor(0).samplesIn;
    assert.strictEqual(s.ingest({ t: 1.5, midi: 60, rate: 1 }), false, 'paused (no advance)');
    assert.strictEqual(s.ingest({ t: 1.4, midi: 60, rate: 1 }), false, 'AV-resync micro backstep');
    assert.strictEqual(s.resultFor(0).samplesIn, n);
});

test('a forward skip leaves the jumped-over syllables unjudged', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens(TOKENS);
    sing(s, 0.9, 1.2, () => 60);
    sing(s, 4.2, 5.2, () => 64);   // skipped from 1.2 to 4.2
    const st = s.stats();
    assert.strictEqual(st.judged, 0, 'syllables 0/1 skipped, 3 started before the jump landed');
    assert.strictEqual(s.resultFor(1), null);
});

test('song changes (setTokens) and reset() clear everything', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens(TOKENS);
    sing(s, 0.9, 3.2, () => 60);
    assert.ok(s.hasResults());
    s.setTokens([{ start: 0, duration: 1, midi: 50 }]);
    assert.strictEqual(s.hasResults(), false);
    assert.deepStrictEqual(s.stats(), { score: 0, streak: 0, bestStreak: 0, hits: 0, misses: 0, judged: 0, accuracy: null });
    assert.strictEqual(s.lastSample(), null);
});

test('overlapping syllables: the later-starting one claims the frame', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens([{ start: 1, duration: 2, midi: 60 }, { start: 2, duration: 1, midi: 67 }]);
    s.ingest({ t: 2.5, midi: 67, rate: 1 });
    assert.strictEqual(s.resultFor(1).samplesIn, 1);
    assert.strictEqual(s.resultFor(0), null);
});

test('finalizeUpTo judges the tail when frames stop at song end', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens([{ start: 1, duration: 1, midi: 60 }]);
    sing(s, 1, 1.9, () => 60);
    assert.strictEqual(s.stats().judged, 0);
    s.finalizeUpTo(Infinity);
    assert.strictEqual(s.stats().hits, 1);
});

test('the trace is bounded', () => {
    const s = screen._lkCreateVocalScorer();
    s.setTokens([]);
    sing(s, 0, 60, () => 60, 0.05);
    assert.strictEqual(s.trace().length, 256);
});

// ── Microphone controller (fake environment) ────────────────────────────

function makeMicEnv(opts) {
    const o = opts || {};
    const log = { gum: [], tracks: [], contexts: [], intervals: new Map(), caps: [], nextId: 1 };
    const prefs = Object.assign({ deviceId: '', channel: 'mix' }, o.prefs || {});
    function makeTrack() {
        const tr = {
            stopped: false,
            listeners: {},
            stop() { this.stopped = true; },
            addEventListener(n, fn) { this.listeners[n] = fn; },
        };
        log.tracks.push(tr);
        return tr;
    }
    const nav = {
        mediaDevices: {
            getUserMedia(c) {
                log.gum.push(JSON.parse(JSON.stringify(c)));
                if (o.gum) return o.gum(c, log, makeTrack);
                const tr = makeTrack();
                return Promise.resolve({ getTracks: () => [tr] });
            },
            enumerateDevices: () => Promise.resolve(o.devices || []),
        },
    };
    function createAudioContext() {
        const ctx = {
            state: o.ctxState || 'running',
            sampleRate: 44100,
            closed: false,
            destination: {},
            close() { this.closed = true; return Promise.resolve(); },
            suspend() { this.state = 'suspended'; return Promise.resolve(); },
            resume() { if (!o.resumeFails) this.state = 'running'; return Promise.resolve(); },
        };
        createWebAudioMocks(ctx);
        log.contexts.push(ctx);
        return ctx;
    }
    const caps = {
        version: 1,
        command(domain, cmd, ctx) { log.caps.push({ domain, cmd, payload: ctx.payload }); return Promise.resolve({ outcome: 'handled' }); },
    };
    const env = {
        navigator: () => (o.noMedia ? {} : nav),
        insecureContext: () => false,
        createAudioContext,
        setInterval: (fn) => { const id = log.nextId++; log.intervals.set(id, fn); return id; },
        clearInterval: (id) => log.intervals.delete(id),
        now: () => 1000,
        getPlaybackRate: () => 1,
        prefs: { get: () => prefs, set: (p) => Object.assign(prefs, p) },
        caps: () => caps,
    };
    return { env, log, prefs };
}

function makeOwner(id, clock) {
    const frames = [];
    return { id, frames, getClock: () => (clock ? clock() : 5), onFrame: (f) => frames.push(f) };
}

/** Push enough sine audio through the fake processor to fill the ring,
 *  then fire the frame timer once. */
function pump(log, freq, channels) {
    const ctx = log.contexts[log.contexts.length - 1];
    const nCh = channels || 1;
    for (let k = 0; k < 3; k++) {
        const data = sine(freq, 44100, 2048, k * 2048);
        const silent = new Float32Array(2048);
        ctx.processor.onaudioprocess({
            inputBuffer: { numberOfChannels: nCh, getChannelData: (i) => (i === 0 ? data : silent) },
        });
    }
    for (const fn of log.intervals.values()) fn();
}

test('mic: start requests audio once, pumps midpoint-dated frames to the owner', async () => {
    const { env, log } = makeMicEnv({ prefs: { channel: '1' } });
    const mic = screen._lkCreateMicController(env);
    const owner = makeOwner('a', () => 5);
    assert.strictEqual(await mic.start(owner), true);
    assert.strictEqual(log.gum.length, 1);
    const audio = log.gum[0].audio;
    assert.strictEqual(audio.echoCancellation, false);
    assert.strictEqual(audio.autoGainControl, false);
    assert.deepStrictEqual(audio.channelCount, { ideal: 2 });
    assert.strictEqual(mic.getState().state, 'listening');
    assert.strictEqual(mic.isOwnedBy(owner), true);
    pump(log, 440);
    assert.strictEqual(owner.frames.length, 1);
    const f = owner.frames[0];
    assert.ok(Math.abs(f.midi - 69) < 0.1, `midi ${f.midi}`);
    assert.ok(Math.abs(f.t - (5 - 2048 / 44100)) < 0.000000001, 'ring of 4096 → 2048-sample midpoint');
    assert.strictEqual(f.rate, 1);
    // Managed audio-input source registered on the host.
    assert.ok(log.caps.some((c) => c.domain === 'audio-input' && c.cmd === 'register-source'
        && c.payload.sourceId === 'lyrics_karaoke:mic' && c.payload.kind === 'microphone'));
    mic.destroy();
});

test('mic: stop releases every resource and unregisters the source', async () => {
    const { env, log } = makeMicEnv();
    const mic = screen._lkCreateMicController(env);
    await mic.start(makeOwner('a'));
    mic.stop();
    assert.ok(log.tracks.length > 0 && log.tracks.every((t) => t.stopped), 'all tracks stopped');
    assert.ok(log.contexts.every((c) => c.closed), 'context closed');
    assert.strictEqual(log.intervals.size, 0, 'frame timer cleared');
    assert.strictEqual(log.contexts[0].processor.onaudioprocess, null);
    assert.strictEqual(mic.getState().state, 'off');
    assert.strictEqual(mic.getState().ownerId, null);
    assert.ok(log.caps.some((c) => c.cmd === 'unregister-source'));
});

test('mic: ownership is exclusive', async () => {
    const { env, log } = makeMicEnv();
    const mic = screen._lkCreateMicController(env);
    const a = makeOwner('a');
    const b = makeOwner('b');
    assert.strictEqual(await mic.start(a), true);
    assert.strictEqual(await mic.start(b), false, 'second owner refused');
    assert.strictEqual(log.gum.length, 1, 'no second stream opened');
    assert.strictEqual(mic.release(b), false, 'a non-owner cannot release');
    assert.strictEqual(mic.isOwnedBy(a), true);
    assert.strictEqual(mic.release(a), true);
    assert.strictEqual(await mic.start(b), true);
    mic.destroy();
});

test('mic: permission denial surfaces once, with no retry loop', async () => {
    const { env, log } = makeMicEnv({
        gum: () => Promise.reject(Object.assign(new Error('nope'), { name: 'NotAllowedError' })),
    });
    const mic = screen._lkCreateMicController(env);
    const states = [];
    mic.subscribe((s) => states.push(s.state));
    assert.strictEqual(await mic.start(makeOwner('a')), false);
    await sleep(5);
    assert.strictEqual(log.gum.length, 1);
    assert.strictEqual(mic.getState().state, 'error');
    assert.match(mic.getState().error, /permission/i);
    assert.deepStrictEqual(states, ['requesting', 'error']);
    assert.ok(log.contexts.every((c) => c.closed), 'pending context closed on failure');
    assert.strictEqual(log.intervals.size, 0);
});

test('mic: unavailable getUserMedia is an error, not a crash', async () => {
    const { env } = makeMicEnv({ noMedia: true });
    const mic = screen._lkCreateMicController(env);
    assert.strictEqual(await mic.start(makeOwner('a')), false);
    assert.strictEqual(mic.getState().state, 'error');
});

test('mic: a missing saved device falls back to the default input once', async () => {
    const { env, log } = makeMicEnv({
        prefs: { deviceId: 'gone' },
        gum: (c, lg, makeTrack) => {
            if (c.audio.deviceId) {
                return Promise.reject(Object.assign(new Error('x'), { name: 'OverconstrainedError' }));
            }
            const tr = makeTrack();
            return Promise.resolve({ getTracks: () => [tr] });
        },
    });
    const mic = screen._lkCreateMicController(env);
    assert.strictEqual(await mic.start(makeOwner('a')), true);
    assert.strictEqual(log.gum.length, 2);
    assert.deepStrictEqual(log.gum[0].audio.deviceId, { exact: 'gone' });
    assert.strictEqual(log.gum[1].audio.deviceId, undefined);
    mic.destroy();
});

test('mic: device loss stops everything and reports an error', async () => {
    const { env, log } = makeMicEnv();
    const mic = screen._lkCreateMicController(env);
    const owner = makeOwner('a');
    await mic.start(owner);
    log.tracks[0].listeners.ended();
    assert.strictEqual(mic.getState().state, 'error');
    assert.match(mic.getState().error, /disconnected/);
    assert.ok(log.tracks[0].stopped);
    assert.ok(log.contexts[0].closed);
    assert.strictEqual(log.intervals.size, 0);
    assert.strictEqual(log.gum.length, 1, 'no automatic reacquire');
    // A later explicit start works.
    assert.strictEqual(await mic.start(owner), true);
    mic.destroy();
});

test('mic: stopping while the permission prompt is open discards the late stream', async () => {
    let resolveGum;
    const { env, log } = makeMicEnv({
        gum: (c, lg, makeTrack) => new Promise((resolve) => {
            resolveGum = () => { const tr = makeTrack(); resolve({ getTracks: () => [tr] }); };
        }),
    });
    const mic = screen._lkCreateMicController(env);
    const p = mic.start(makeOwner('a'));
    await flush();
    mic.stop();
    resolveGum();
    assert.strictEqual(await p, false);
    assert.ok(log.tracks[0].stopped, 'late stream stopped');
    assert.ok(log.contexts[0].closed);
    assert.strictEqual(mic.getState().state, 'off');
});

test('mic: suspend/resume pause the frame pump without releasing the device', async () => {
    const { env, log } = makeMicEnv();
    const mic = screen._lkCreateMicController(env);
    const owner = makeOwner('a');
    await mic.start(owner);
    assert.strictEqual(mic.suspend(), true);
    assert.strictEqual(mic.getState().state, 'suspended');
    assert.strictEqual(log.intervals.size, 0);
    assert.strictEqual(log.tracks[0].stopped, false);
    assert.strictEqual(mic.resume(), true);
    assert.strictEqual(mic.getState().state, 'listening');
    pump(log, 220);
    assert.strictEqual(owner.frames.length, 1);
    mic.destroy();
    assert.ok(log.tracks[0].stopped);
});

test('mic: device and channel switch live, without a reload', async () => {
    const { env, log, prefs } = makeMicEnv();
    const mic = screen._lkCreateMicController(env);
    const owner = makeOwner('a');
    await mic.start(owner);
    // Channel: the next buffer reads channel 2 (silent here) → unvoiced.
    mic.setChannel('2');
    assert.strictEqual(prefs.channel, '2');
    pump(log, 440, 2);
    assert.strictEqual(owner.frames[0].midi, null);
    mic.setChannel('1');
    pump(log, 440, 2);
    assert.ok(Math.abs(owner.frames[1].midi - 69) < 0.1);
    // Device: restarts the stream on the new device, same owner.
    assert.strictEqual(await mic.setDevice('usb-mic'), true);
    assert.strictEqual(prefs.deviceId, 'usb-mic');
    assert.ok(log.tracks[0].stopped, 'old device released');
    assert.deepStrictEqual(log.gum[1].audio.deviceId, { exact: 'usb-mic' });
    assert.strictEqual(mic.isOwnedBy(owner), true);
    mic.destroy();
});

test('mic: listDevices hides the default alias and labels unnamed inputs', async () => {
    const { env } = makeMicEnv({
        devices: [
            { kind: 'audioinput', deviceId: 'default', label: 'Default' },
            { kind: 'audioinput', deviceId: 'x1', label: '' },
            { kind: 'audiooutput', deviceId: 'o1', label: 'Speakers' },
            { kind: 'audioinput', deviceId: 'x2', label: 'USB' },
        ],
    });
    const mic = screen._lkCreateMicController(env);
    const list = await mic.listDevices();
    assert.deepStrictEqual(list.map((d) => d.deviceId), ['x1', 'x2']);
    assert.strictEqual(list[1].label, 'USB');
    assert.match(list[0].label, /^Microphone /);
});

// ── Provider ↔ microphone wiring (shared singleton, fake browser) ───────

const media = { gum: 0, tracks: [], contexts: [] };
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
        mediaDevices: {
            getUserMedia() {
                media.gum += 1;
                const tr = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
                media.tracks.push(tr);
                return Promise.resolve({ getTracks: () => [tr] });
            },
            enumerateDevices: () => Promise.resolve([]),
        },
    },
});
window.AudioContext = function FakeAudioContext() {
    const ctx = {
        state: 'running',
        sampleRate: 44100,
        closed: false,
        destination: {},
        close() { this.closed = true; return Promise.resolve(); },
    };
    createWebAudioMocks(ctx);
    media.contexts.push(ctx);
    return ctx;
};

function payload(tokens) {
    return {
        schema_version: 1,
        voices: [{ id: 'primary', name: 'Vocals', primary: true, tokens }],
    };
}

function jsonFetch(body) {
    return () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

const zeroCanvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ canvas: { width: 0, height: 0 } }),
});

function songInfo(name) {
    return { filename: name || 'song.sloppak', arrangement_index: 0, arrangement: 'Vocals' };
}

async function mountPanel(tokens) {
    fetchImpl = jsonFetch(payload(tokens || [
        { start: 1, duration: 1, text: 'la', midi: 69 },
        { start: 2, duration: 1, text: 'la', midi: 69 },
    ]));
    const r = window.feedBackViz_lyrics_karaoke();
    const canvas = zeroCanvas();
    r.init(canvas, { currentTime: 0, songInfo: songInfo() });
    await flush();
    await flush();
    return { r, canvas };
}

test('provider: mic starts only from the explicit click and targets a pitched panel', async () => {
    const before = media.gum;
    const { r } = await mountPanel();
    assert.strictEqual(media.gum, before, 'mounting never requests the microphone');
    assert.strictEqual(r.canScore(), true);
    assert.strictEqual(screen._vizMicTarget(), r);
    assert.strictEqual(await screen._vizOnMicClick(), true);
    assert.strictEqual(media.gum, before + 1);
    assert.strictEqual(r.ownsMic(), true);
    // Clicking again stops it.
    await screen._vizOnMicClick();
    assert.strictEqual(r.ownsMic(), false);
    assert.ok(media.tracks[media.tracks.length - 1].stopped);
    r.destroy();
});

test('provider: the legacy overlay cannot take the mic while a panel holds it', async () => {
    const { r } = await mountPanel();
    await r.requestMic();
    assert.strictEqual(await screen._lkMic.start(screen._lkOverlayOwner), false);
    assert.strictEqual(r.ownsMic(), true);
    r.destroy();
});

test('provider: destroy releases the mic and stops every track', async () => {
    const { r } = await mountPanel();
    await r.requestMic();
    const ctx = media.contexts[media.contexts.length - 1];
    r.destroy();
    assert.strictEqual(screen._lkMic.getState().state, 'off');
    assert.ok(media.tracks.every((t) => t.stopped));
    assert.ok(ctx.closed);
});

test('provider: a song switch releases the mic and wipes the take', async () => {
    const { r } = await mountPanel();
    await r.requestMic();
    r.draw({ currentTime: 1.5, songInfo: songInfo() });
    r.draw({ currentTime: 0, songInfo: songInfo('other.sloppak') });
    assert.strictEqual(r.ownsMic(), false);
    assert.strictEqual(screen._lkMic.getState().state, 'off');
    assert.deepStrictEqual(r.getScoreStats().judged, 0);
    r.destroy();
});

test('provider: turning micFeedback off releases the mic and blocks restarts', async () => {
    const { r } = await mountPanel();
    await r.requestMic();
    r.applySetting('micFeedback', false);
    assert.strictEqual(r.ownsMic(), false);
    assert.strictEqual(r.canScore(), false);
    assert.strictEqual(await r.requestMic(), false);
    r.destroy();
});

test('provider: a lyrics-only part cannot score', async () => {
    const { r } = await mountPanel([{ start: 1, duration: 1, text: 'la', midi: null }]);
    assert.strictEqual(r.canScore(), false);
    assert.strictEqual(await screen._vizOnMicClick(), false);
    r.destroy();
});

test('provider: frames are dated on the panel clock and scored per panel', async () => {
    const { r } = await mountPanel();
    await r.requestMic();
    r.draw({ currentTime: 1.5, songInfo: songInfo() });
    const ctx = media.contexts[media.contexts.length - 1];
    for (let k = 0; k < 3; k++) {
        const data = sine(440, 44100, 2048, k * 2048);
        ctx.processor.onaudioprocess({ inputBuffer: { numberOfChannels: 1, getChannelData: () => data } });
    }
    await sleep(80);   // the real 50 ms frame timer
    const trace = r.getSungTrace();
    assert.ok(trace.length >= 1, 'a frame reached this panel');
    assert.ok(trace[0].t > 1.3 && trace[0].t < 1.7, `trace time ${trace[0].t}`);
    assert.ok(Math.abs(trace[0].midi - 69) < 0.1);
    r.destroy();
});

test('provider: scoring settings apply live to the panel scorer', async () => {
    const { r } = await mountPanel();
    r.applySetting('tolerance', 0.5);
    r.applySetting('octaveIndependent', true);
    r.applySetting('micOffsetMs', 40);
    assert.strictEqual(r.getSetting('tolerance'), 0.5);
    assert.strictEqual(r.getSetting('octaveIndependent'), true);
    assert.strictEqual(r.getSetting('micOffsetMs'), 40);
    r.destroy();
});

test('provider: hidden panel suspends the mic, shown again resumes', async () => {
    const { r, canvas } = await mountPanel();
    await r.requestMic();
    bus.emit('highway:visibility', { visible: false, canvas: {} });
    assert.strictEqual(screen._lkMic.getState().state, 'listening', 'other canvases are ignored');
    bus.emit('highway:visibility', { visible: false, canvas });
    assert.strictEqual(screen._lkMic.getState().state, 'suspended');
    bus.emit('highway:visibility', { visible: true, canvas });
    assert.strictEqual(screen._lkMic.getState().state, 'listening');
    r.destroy();
    assert.strictEqual((busListeners.get('highway:visibility') || []).length, 0, 'listener removed');
});
