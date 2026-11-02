// Music effects (music-fx.js) end-to-end tests: headless Chromium against a local `wrangler dev`
// (see tests/README.md):
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/music-fx.test.mjs
// The effects are measured on offline renders (OfflineAudioContext): the module's graph builders on
// synthetic signals, and the app's own WAV export and live playback for routing, pump, saving and undo.
// Instruments come from the app's recorded library (assets/instruments); SoundFont requests get a
// synthetic tone and the microphone is faked, so no network is needed.
//   PRINT_LEVELS=1   print the measured level table (compression / drive / glue vs Off)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const DESKTOP = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
let failures = 0, passes = 0;

// ---- Fixtures ----
function wavBytes(samples, rate = 22050) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32000), 44 + i * 2);
  return buf;
}
// MIDI.js SoundFont stand-in (only used if an instrument falls back to the SoundFont).
const SOUNDFONT = (() => {
  const n = Math.round(.4 * 22050), s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 330 * i / 22050) * Math.exp(-6 * i / n) * .37;
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'], tone = `data:audio/wav;base64,${wavBytes(s).toString('base64')}`;
  let body = 'if (typeof(MIDI) === "undefined") var MIDI = {};\nMIDI.Soundfont = MIDI.Soundfont || {};\nMIDI.Soundfont.test = {\n';
  for (let midi = 21; midi <= 108; midi++) body += `"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "${tone}",\n`;
  return body + '}\n';
})();
// A fake microphone: a steady vowel-like tone, so a vocal take has audio.
const FAKE_MIC = join(tmpdir(), `srs-musicfx-mic-${process.pid}.wav`);
{
  const sr = 48000, n = sr * 3, s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = .3 * (Math.sin(2 * Math.PI * 220 * i / sr) + .5 * Math.sin(2 * Math.PI * 440 * i / sr));
  writeFileSync(FAKE_MIC, wavBytes(s, sr));
}

// Page side: audio-graph bookkeeping (nodes that reach a destination), signal generators, renders through
// the module's builders, and analysis.
const PAGE_LIB = `(() => {
  const edges = new Map(), connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (dest, ...rest) { const r = connect.call(this, dest, ...rest); if (dest instanceof AudioNode) { let s = edges.get(this); if (!s) edges.set(this, s = new Set()); s.add(dest); } return r; };
  AudioNode.prototype.disconnect = function (...a) { const r = disconnect.apply(this, a); if (a[0] instanceof AudioNode) edges.get(this)?.delete(a[0]); else if (a[0] === undefined || typeof a[0] === 'number') edges.delete(this); return r; };
  function reachable() {
    const into = new Map(); for (const [from, tos] of edges) for (const to of tos) { let s = into.get(to); if (!s) into.set(to, s = new Set()); s.add(from); }
    const seen = new Set(), stack = [...into.keys()].filter(n => n instanceof AudioDestinationNode && !(n.context instanceof OfflineAudioContext));
    while (stack.length) for (const from of into.get(stack.pop()) || []) if (!seen.has(from)) { seen.add(from); stack.push(from); }
    return seen.size;
  }
  const SR = 48000;
  const db = x => 20 * Math.log10(Math.max(1e-12, x));
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  // Signals (Float32Array, mono): sine, white noise, a click.
  const sig = {
    sine: (f, sec, amp = .3) => { const n = Math.round(sec * SR), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / SR); return x; },
    noise: (sec, amp = .1) => { seed = 777; const n = Math.round(sec * SR), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * rnd(); return x; },
    click: (sec, at = .05, amp = .5) => { const x = new Float32Array(Math.round(sec * SR)); x[Math.round(at * SR)] = amp; return x; },
  };
  // Renders signal x (mono, or [L, R]) through build(ctx, destination) → input node; returns [L, R].
  async function render(x, build, { sec = null, suspend = [] } = {}) {
    const chans = Array.isArray(x) ? x : [x], n = Math.round((sec ?? chans[0].length / SR) * SR);
    const ctx = new OfflineAudioContext(2, n, SR), buf = ctx.createBuffer(chans.length, chans[0].length, SR);
    chans.forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = buf;
    const input = build ? await build(ctx, ctx.destination) : ctx.destination;
    src.connect(input); src.start(0);
    for (const [t, fn] of suspend) ctx.suspend(t).then(() => { fn(); ctx.resume(); });
    const out = await ctx.startRendering();
    return [out.getChannelData(0).slice(), out.getChannelData(1).slice()];
  }
  const MF = () => window.CRPMusicFx;
  // A track (and song) chain with the given settings, built the way Baby DAW builds them.
  function trackChain(fx, { song = null, level, trim = 1, bpm = 120 } = {}) {
    return (ctx, dest) => {
      const s = song ? MF().createSongFx(ctx, dest).set(song, { bpm, immediate: true }) : null;
      const t = MF().createTrackFx(ctx, s ? s.input : dest, s, { level: level ?? MF().LEVELS.chord, trim });
      t.set(fx, { immediate: true });
      return t.input;
    };
  }
  const rms = (x, a = 0, b = x.length) => { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return Math.sqrt(e / Math.max(1, b - a)); };
  // Energy per band (dB) of a signal, from an FFT averaged over 8192-point frames.
  function bands(x, edges) {
    const N = 8192, out = edges.slice(1).map(() => 0);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let s = 0; s + N <= x.length; s += N) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) { const f = k * SR / N, p = re[k] * re[k] + im[k] * im[k]; for (let b = 0; b < out.length; b++) if (f >= edges[b] && f < edges[b + 1]) out[b] += p; }
    }
    return out.map(e => 10 * Math.log10(e + 1e-30));
  }
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
    }
  }
  // Harmonic levels (dB re fundamental) of a steady tone at f0, by correlation over whole periods.
  function harmonics(x, f0, from, count = 5) {
    const per = Math.round(SR / f0), periods = Math.floor((x.length - from) / per) - 1, n = periods * per, out = [];
    for (let h = 1; h <= count; h++) { let c = 0, s = 0; for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * h * f0 * (from + i) / SR; c += x[from + i] * Math.cos(ph); s += x[from + i] * Math.sin(ph); } out.push(Math.hypot(c, s) * 2 / n); }
    return out.map(a => db(a / out[0]));
  }
  // RMS envelope in blocks of \`ms\`.
  function envelope(x, ms = 5, from = 0, to = x.length) { const B = Math.round(ms / 1000 * SR), e = []; for (let s = from; s + B <= to; s += B) e.push(rms(x, s, s + B)); return e; }
  // Dominant period (in blocks) of a series, from its autocorrelation.
  function period(e, minLag = 2) {
    const m = e.reduce((a, b) => a + b, 0) / e.length, d = e.map(v => v - m);
    let best = -Infinity, lag = 0;
    const ac = l => { let s = 0; for (let i = 0; i + l < d.length; i++) s += d[i] * d[i + l]; return s / (d.length - l); };
    const a0 = ac(0);
    // First peak after the autocorrelation drops below zero.
    let l = minLag; while (l < d.length / 2 && ac(l) > 0) l++;
    for (; l < d.length / 2; l++) { const v = ac(l); if (v > best) { best = v; lag = l; } if (best > 0 && v < best * .5) break; }
    return { lag, strength: best / a0 };
  }
  // RT60 from the backward-integrated energy decay (Schroeder), fit between -5 and -25 dB.
  function rt60(x, from) {
    const e = new Float64Array(x.length - from); let acc = 0;
    for (let i = x.length - 1; i >= from; i--) { acc += x[i] * x[i]; e[i - from] = acc; }
    const L = i => 10 * Math.log10(e[i] / e[0] + 1e-30);
    let a = 0; while (a < e.length && L(a) > -5) a++; let b = a; while (b < e.length && L(b) > -25) b++;
    return (b - a) / SR * 3;
  }
  // Largest sample-to-sample jump in the second difference within [a, b).
  function maxJerk(x, a, b) { let m = 0; for (let i = Math.max(2, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2])); return m; }
  window.__fx = { SR, db, sig, render, trackChain, rms, bands, harmonics, envelope, period, rt60, maxJerk, reachable, MF };
})();`;

// ---- Harness ----
let browser;
async function withPage(device, fn, { path = '/?workspace=baby-daw' } = {}) {
  const context = await browser.newContext({ ...device, permissions: ['microphone'] });
  await context.route('https://gleitz.github.io/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SOUNDFONT }));
  await context.addInitScript({ content: PAGE_LIB });
  const page = await context.newPage(), errors = [];
  page.touch = !!device.hasTouch;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CRPCore && window.CRPParts && window.CRPMusicFx);
    await page.waitForTimeout(700); // let the app finish restoring its startup project
    await fn(page);
    assert.deepEqual(errors, [], 'page errors');
  } finally { await context.close(); }
}
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY=<text>: run the tests whose name has it
  try { await fn(); passes++; console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- Module tests (offline renders through music-fx.js) ----
async function allOffIsTransparent(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, x = F.sig.noise(1, .2), y = F.sig.sine(330, 1, .25), stereo = [x, y];
    const out = [];
    for (const input of [x, stereo]) {
      const dry = await F.render(input, null);
      const wet = await F.render(input, F.trackChain(F.MF().TRACK_DEFAULT, { song: F.MF().SONG_DEFAULT }));
      const old = await F.render(input, F.trackChain({}, { song: {} })); // a project saved before music FX: nothing stored
      let d = 0, d2 = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < dry[c].length; i++) { d = Math.max(d, Math.abs(dry[c][i] - wet[c][i])); d2 = Math.max(d2, Math.abs(dry[c][i] - old[c][i])); }
      out.push([d, d2]);
    }
    return { out, isDefault: [F.MF().isDefault(F.MF().TRACK_DEFAULT), F.MF().isDefault(F.MF().SONG_DEFAULT), F.MF().isDefault({ eq: 'warm' }), F.MF().isDefault({ pump: 'subtle' })] };
  });
  for (const [d, d2] of r.out) { assert.ok(d < 1e-6, `all-Off track + song FX must be a null test (max difference ${d})`); assert.ok(d2 < 1e-6, `no stored FX = all Off (max difference ${d2})`); }
  assert.deepEqual(r.isDefault, [true, true, false, false]);
}

async function eqPresetsTilt(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, x = F.sig.noise(2, .1), edges = [40, 150, 250, 700, 2000, 5000, 16000], res = {};
    const base = F.bands((await F.render(x, F.trackChain({})))[0], edges);
    for (const eq of Object.keys(F.MF().EQ_PRESETS)) for (const eqAmount of [100, 50, 0]) {
      const b = F.bands((await F.render(x, F.trackChain({ eq, eqAmount })))[0], edges);
      res[`${eq}${eqAmount}`] = b.map((v, i) => +(v - base[i]).toFixed(2));
    }
    // The song EQ uses the same presets.
    const songWarm = F.bands((await F.render(x, F.trackChain({}, { song: { eq: 'warm' } })))[0], edges).map((v, i) => +(v - base[i]).toFixed(2));
    return { res, songWarm };
  });
  // bands: [40-150 sub/bass, 150-250 low, 250-700 low-mid, 700-2k mid, 2k-5k presence, 5k-16k high]
  const R = r.res, tilt = b => b[5] - (b[0] + b[1]) / 2;
  assert.ok(tilt(R.warm100) < -4, `Warm: darker (high − low ${tilt(R.warm100).toFixed(1)} dB)`);
  assert.ok(tilt(R.bright100) > 4, `Bright: brighter (high − low ${tilt(R.bright100).toFixed(1)} dB)`);
  assert.ok(R.scoop100[0] - R.scoop100[3] > 4 && R.scoop100[5] - R.scoop100[3] > 4, `Scoop: lows and highs above the mids (${R.scoop100})`);
  assert.ok(R.mid100[3] - R.mid100[0] > 4 && R.mid100[3] - R.mid100[5] > 4, `Mid push: mids above lows and highs (${R.mid100})`);
  assert.ok(R.thin100[0] - R.thin100[4] < -12, `Thin: lows cut (${R.thin100})`);
  assert.ok(R.dark100[5] - R.dark100[2] < -15, `Dark: highs cut (${R.dark100})`);
  assert.ok(R.telephone100[3] - R.telephone100[0] > 12 && R.telephone100[3] - R.telephone100[5] > 15, `Telephone: a narrow mid band (${R.telephone100})`);
  for (const eq of ['warm', 'bright', 'scoop', 'mid']) {
    const full = R[`${eq}100`], half = R[`${eq}50`], zero = R[`${eq}0`];
    assert.ok(zero.every(v => Math.abs(v) < .3), `${eq} at Amount 0 is flat (${zero})`);
    const span = b => Math.max(...b) - Math.min(...b);
    assert.ok(near(span(half), span(full) / 2, span(full) * .2), `${eq} at Amount 50 is about half (${span(half).toFixed(1)} vs ${span(full).toFixed(1)} dB)`);
  }
  assert.ok(tilt(r.songWarm) < -4, `song EQ Warm darkens the mix (${r.songWarm})`);
}

async function driveHarmonics(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, level = F.MF().LEVELS.chord, x = F.sig.sine(240, 1, level * 2.5), out = {};
    for (const [drive, driveAmount] of [['off', 50], ['warm', 50], ['crunch', 50], ['fuzz', 50], ['crunch', 0], ['crunch', 100]]) {
      const y = (await F.render(x, F.trackChain({ drive, driveAmount }, { level })))[0];
      const h = F.harmonics(y, 240, 4800, 5);
      out[`${drive}${driveAmount}`] = { h2: h[1], h3: h[2], level: F.db(F.rms(y, 4800) / F.rms(x, 4800)) };
    }
    return out;
  });
  assert.ok(r.off50.h2 < -80 && r.off50.h3 < -80, `Off adds no harmonics (${r.off50.h2.toFixed(0)}, ${r.off50.h3.toFixed(0)} dB)`);
  assert.ok(r.warm50.h2 > -45, `Warm adds even (2nd) harmonics (${r.warm50.h2.toFixed(1)} dB)`);
  assert.ok(r.crunch50.h3 > r.warm50.h3 + 3, `Crunch has more 3rd harmonic than Warm (${r.crunch50.h3.toFixed(1)} vs ${r.warm50.h3.toFixed(1)} dB)`);
  assert.ok(r.fuzz50.h3 > r.crunch50.h3, `Fuzz has more than Crunch (${r.fuzz50.h3.toFixed(1)} vs ${r.crunch50.h3.toFixed(1)} dB)`);
  assert.ok(r.crunch100.h3 > r.crunch0.h3 + 6, `Amount drives harder (${r.crunch0.h3.toFixed(1)} → ${r.crunch100.h3.toFixed(1)} dB)`);
}

// Gated loudness of real material (recorded instruments, drum samples) through a preset, vs Off.
async function levelMatched(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, MF = F.MF(), sr = F.SR;
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], name = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
    function gated(L, R) {
      const blk = Math.round(.4 * sr), hop = Math.round(.1 * sr), blocks = [];
      for (let s = 0; s + blk <= L.length; s += hop) { let e = 0; for (let i = s; i < s + blk; i++) { const x = (L[i] + R[i]) / 2; e += x * x; } blocks.push(e / blk); }
      const abs = blocks.filter(e => e > 1e-9), mean = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length), rel = abs.filter(e => e > mean * .1);
      return 10 * Math.log10(rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length));
    }
    const drumBufs = {};
    async function material(ctx, kind, dest) {
      const beat = 60 / 92;
      if (kind === 'drums') {
        for (const [k, u] of Object.entries({ k: 'assets/drums/kick-1.wav', s: 'assets/drums/snare-1.wav', h: 'assets/drums/closed-hat.wav' })) drumBufs[k] = await ctx.decodeAudioData(await (await fetch(u)).arrayBuffer());
        const g = .5 * .18 * .5; // Beat Maker: volume 50 % × output scale × mix headroom
        for (let i = 0; i < 16; i++) { const at = .1 + i * beat / 2, play = b => { const s = ctx.createBufferSource(), gn = ctx.createGain(); s.buffer = b; gn.gain.value = g; s.connect(gn).connect(dest); s.start(at); }; play(drumBufs.h); if (i % 4 === 0 || i % 8 === 7) play(drumBufs.k); if (i % 4 === 2) play(drumBufs.s); }
        return;
      }
      const sound = kind === 'bass' ? 'electric_bass_finger' : 'acoustic_grand_piano', bus = ctx.createGain();
      bus.connect(dest);
      const inst = await window.CRPCore.loadSoundfontInstrument(ctx, sound, bus);
      bus.gain.value = window.CRPCore.soundOutputGain(sound) * (kind === 'chords' ? .85 : .8 * 1.9); // Baby DAW part volume (× Lead/Bass boost)
      if (kind === 'chords') [[60, 64, 67], [57, 60, 64], [53, 57, 60, 65], [55, 59, 62]].forEach((ch, i) => ch.forEach(m => inst.play(name(m), .1 + i * beat * 2, { duration: beat * 2 * .98, gain: .94 })));
      else if (kind === 'melody') [72, 74, 76, 79, 76, 74, 72, 71, 72, 76, 79, 81, 79, 76].forEach((m, i) => inst.play(name(m), .1 + i * beat / 2, { duration: beat / 2 * .98, gain: .92 }));
      else [40, 43, 45, 47, 48, 47, 45, 43, 40, 38, 40, 43, 45, 40].forEach((m, i) => inst.play(name(m), .1 + i * beat / 2, { duration: beat / 2 * .98, gain: .92 }));
    }
    async function loud(kind, fx, song = null) {
      const ctx = new OfflineAudioContext(2, sr * 6, sr), level = MF.LEVELS[kind === 'drums' ? 'drums' : kind === 'chords' ? 'chord' : 'lead'];
      const s = song ? MF.createSongFx(ctx, ctx.destination, { level: MF.LEVELS.song }).set(song, { immediate: true }) : null;
      const t = MF.createTrackFx(ctx, s ? s.input : ctx.destination, s, { level }); t.set(fx, { immediate: true });
      if (song) { const ch = ctx.createGain(); ch.gain.value = .5; ch.connect(t.input); await material(ctx, 'chords', ch); const b = ctx.createGain(); b.gain.value = .5; b.connect(t.input); await material(ctx, 'bass', b); }
      await material(ctx, song ? 'drums' : kind, t.input);
      const out = await ctx.startRendering();
      return gated(out.getChannelData(0), out.getChannelData(1));
    }
    const table = {};
    for (const kind of ['chords', 'melody', 'bass', 'drums']) {
      const off = await loud(kind, {});
      for (const comp of Object.keys(MF.COMP_PRESETS)) (table[`comp ${comp}`] ||= {})[kind] = +(await loud(kind, { comp }) - off).toFixed(2);
      if (kind !== 'drums') for (const drive of Object.keys(MF.DRIVE_PRESETS)) for (const driveAmount of [0, 50, 100]) (table[`drive ${drive} ${driveAmount}`] ||= {})[kind] = +(await loud(kind, { drive, driveAmount }) - off).toFixed(2);
    }
    const mixOff = await loud('mix', {}, {});
    for (const glue of Object.keys(MF.GLUE_PRESETS)) table[`glue ${glue}`] = { mix: +(await loud('mix', {}, { glue }) - mixOff).toFixed(2) };
    return table;
  });
  if (process.env.PRINT_LEVELS) for (const [k, v] of Object.entries(r)) console.log(`       ${k.padEnd(18)} ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(r)) for (const [m, d] of Object.entries(v)) assert.ok(Math.abs(d) <= 1.5, `${k} on ${m}: ${d} dB from Off (limit ±1.5)`);
}

async function modulationWorks(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, MF = F.MF(), x = F.sig.sine(1000, 4, .2), out = {};
    for (const [mod, modSpeed] of [['off', 50], ['chorus', 60], ['phaser', 60], ['flanger', 60], ['tremolo', 30], ['tremolo', 70], ['autopan', 70]]) {
      const [L, R] = await F.render(x, F.trackChain({ mod, modAmount: 100, modSpeed }));
      const from = Math.round(.3 * F.SR), env = F.envelope(L.map((v, i) => (v + R[i]) / 2), 5, from), envDb = env.map(F.db);
      const swing = Math.max(...envDb) - Math.min(...envDb);
      const balance = F.envelope(L, 5, from).map((l, i) => { const r = F.envelope(R, 5, from)[i]; return (l * l - r * r) / (l * l + r * r + 1e-12); });
      let corr = 0, ll = 0, rr = 0; for (let i = from; i < L.length; i++) { corr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
      out[`${mod}${modSpeed}`] = { swing, rate: MF.modRate(mod, modSpeed), envPeriod: F.period(env).lag * .005, balPeriod: F.period(balance).lag * .005, balSwing: Math.max(...balance) - Math.min(...balance), corr: corr / Math.sqrt(ll * rr) };
    }
    return out;
  });
  assert.ok(r.off50.swing < .05, `Off leaves a steady tone steady (${r.off50.swing.toFixed(3)} dB)`);
  for (const m of ['chorus60', 'phaser60', 'flanger60']) assert.ok(r[m].swing > 3, `${m} modulates a steady tone (level swings ${r[m].swing.toFixed(1)} dB)`);
  assert.ok(r.chorus60.corr < .9, `Chorus widens (left/right correlation ${r.chorus60.corr.toFixed(2)})`);
  for (const m of ['tremolo30', 'tremolo70']) {
    assert.ok(r[m].swing > 12, `${m}: deep amplitude modulation (${r[m].swing.toFixed(1)} dB)`);
    assert.ok(near(r[m].envPeriod, 1 / r[m].rate, .06 / r[m].rate + .006), `${m}: level cycles at the Speed rate (${(1 / r[m].envPeriod).toFixed(2)} Hz, expected ${r[m].rate.toFixed(2)} Hz)`);
  }
  assert.ok(r.autopan70.balSwing > 1.5 && near(r.autopan70.balPeriod, 1 / r.autopan70.rate, .06 / r.autopan70.rate + .006), `Auto-pan sweeps left↔right at the Speed rate (${r.autopan70.balSwing.toFixed(2)}, ${(1 / r.autopan70.balPeriod).toFixed(2)} Hz vs ${r.autopan70.rate.toFixed(2)} Hz)`);
}

async function panIsConstantPower(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, x = F.sig.noise(1, .1), out = [];
    const dry = await F.render(x, null), p0 = F.rms(dry[0]) ** 2 + F.rms(dry[1]) ** 2;
    for (const pan of [-100, -50, -10, 10, 50, 100]) { const [L, R] = await F.render(x, F.trackChain({ pan })); out.push({ pan, power: F.db(Math.sqrt((F.rms(L) ** 2 + F.rms(R) ** 2) / p0)), lr: F.db(F.rms(L) / F.rms(R)) }); }
    return out;
  });
  for (const p of r) assert.ok(Math.abs(p.power) < .1, `pan ${p.pan}: loudness unchanged (${p.power.toFixed(2)} dB)`);
  assert.ok(r[0].lr > 40 && r[5].lr < -40, 'hard left / hard right put the sound in one speaker');
  assert.ok(r[1].lr > 5 && r[4].lr < -5 && r[1].lr < r[0].lr, 'half-way pans lean that way');
}

async function delayEchoes(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, x = F.sig.click(3), out = {};
    for (const [delay, bpm] of [['1/4', 120], ['1/8d', 100], ['1/2', 160]]) {
      const [L] = await F.render(x, F.trackChain({ delay: 100 }, { song: { delay, feedback: 50 }, bpm }), { sec: 3 });
      const T = F.MF().delaySeconds(delay, bpm), peaks = [];
      for (let k = 1; k <= 3; k++) { const c = Math.round((.05 + k * T) * F.SR), w = Math.round(.004 * F.SR); let m = 0, at = 0; for (let i = c - w; i < c + w; i++) if (Math.abs(L[i]) > m) { m = Math.abs(L[i]); at = i; } peaks.push({ at: at / F.SR - .05, amp: m }); }
      let between = 0; for (let i = Math.round((.05 + T * .3) * F.SR); i < Math.round((.05 + T * .7) * F.SR); i++) between = Math.max(between, Math.abs(L[i]));
      out[`${delay}@${bpm}`] = { T, peaks, between };
    }
    return out;
  });
  for (const [k, v] of Object.entries(r)) {
    v.peaks.forEach((p, i) => assert.ok(near(p.at, (i + 1) * v.T, .0006), `${k}: echo ${i + 1} at ${p.at.toFixed(4)} s, expected ${((i + 1) * v.T).toFixed(4)} s`));
    assert.ok(v.peaks[0].amp > .05 && v.peaks[1].amp < v.peaks[0].amp * .8 && v.peaks[2].amp < v.peaks[1].amp, `${k}: repeats decay (${v.peaks.map(p => p.amp.toFixed(3))})`);
    assert.ok(v.between < v.peaks[0].amp * .1, `${k}: nothing between the echoes`);
  }
}

async function reverbRooms(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, x = F.sig.click(4.5), out = {};
    for (const room of Object.keys(F.MF().ROOMS)) {
      const [L, R] = await F.render(x, F.trackChain({ reverb: 100 }, { song: { room, reverb: 100 } }), { sec: 4.5 });
      const wet = L.map((v, i) => i < Math.round(.0515 * F.SR) ? 0 : v); // drop the dry click
      let c = 0, a = 0, b = 0; for (let i = Math.round(.0515 * F.SR); i < L.length; i++) { c += L[i] * R[i]; a += L[i] * L[i]; b += R[i] * R[i]; }
      out[room] = { rt: F.rt60(wet, Math.round(.06 * F.SR)), spec: F.MF().ROOMS[room].rt, corr: c / Math.sqrt(a * b) };
    }
    // Without any send the song reverb is not even built.
    const ctx = new OfflineAudioContext(2, 4800, 48000), s = F.MF().createSongFx(ctx, ctx.destination);
    return { out, idle: s.active };
  });
  for (const [room, v] of Object.entries(r.out)) {
    assert.ok(near(v.rt, v.spec, v.spec * .25), `${room}: reverb tail RT60 ${v.rt.toFixed(2)} s, expected ~${v.spec} s`);
    assert.ok(Math.abs(v.corr) < .5, `${room}: decorrelated stereo (${v.corr.toFixed(2)})`);
  }
  const rts = ['room', 'plate', 'hall', 'large'].map(k => r.out[k].rt);
  assert.ok(rts.every((v, i) => !i || v > rts[i - 1]), `rooms get longer: Room < Plate < Hall < Large Hall (${rts.map(v => v.toFixed(2))})`);
  assert.deepEqual(r.idle, { reverb: false, delay: false }, 'no convolver or delay while nothing sends to them');
}

async function widthMidSide(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, L0 = F.sig.noise(1, .1), R0 = F.sig.sine(500, 1, .1), out = {};
    for (const width of [-100, 0, 100]) {
      const [L, R] = await F.render([L0, R0], F.trackChain({}, { song: { width } }));
      const side = L.map((v, i) => (v - R[i]) / 2), mid = L.map((v, i) => (v + R[i]) / 2);
      out[width] = F.db(F.rms(side) / F.rms(mid));
    }
    const s0 = L0.map((v, i) => (v - R0[i]) / 2), m0 = L0.map((v, i) => (v + R0[i]) / 2);
    return { out, orig: F.db(F.rms(s0) / F.rms(m0)) };
  });
  assert.ok(r.out[-100] < -60, `Width −100: mono (side ${r.out[-100].toFixed(1)} dB)`);
  assert.ok(near(r.out[0], r.orig, .01), 'Width 0: unchanged');
  assert.ok(near(r.out[100] - r.orig, 6.02, .1), `Width +100: sides doubled (+${(r.out[100] - r.orig).toFixed(2)} dB)`);
}

// Switching presets while sound plays crossfades instead of jumping: a click is a spike in the second
// difference of a low tone far above what the effects themselves produce.
async function noClicksWhenSwitching(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, MF = F.MF(), x = F.sig.sine(110, 3.2, .25), switches = [];
    let track = null, song = null;
    const steps = [{ eq: 'warm' }, { eq: 'scoop' }, { drive: 'crunch' }, { drive: 'fuzz', driveAmount: 90 }, { comp: 'heavy' }, { mod: 'chorus' }, { mod: 'tremolo' }, { pan: 70 }, { pan: 0 }, { eq: 'off', drive: 'off', comp: 'off', mod: 'off' }];
    let fx = {};
    const suspend = steps.map((s, i) => [(i + 1) * .28, () => { fx = { ...fx, ...s }; track.set(fx); switches.push(Math.round((i + 1) * .28 * F.SR)); }]);
    suspend.push([3.0, () => song.set({ width: 60, eq: 'bright' })]);
    const [L] = await F.render(x, (ctx, dest) => { song = MF.createSongFx(ctx, dest); track = MF.createTrackFx(ctx, song.input, song); track.set({}, { immediate: true }); return track.input; }, { suspend });
    // The jerk around each switch (switch → +60 ms) against the steady state just before and just after it.
    const W = Math.round(.06 * F.SR), out = [];
    for (const s of [...switches, Math.round(3 * F.SR)]) { const at = F.maxJerk(L, s - 128, s + W), before = F.maxJerk(L, s - 2 * W, s - 128), after = F.maxJerk(L, s + W, s + 2 * W); out.push({ at, ref: Math.max(before, after) }); }
    return out;
  });
  r.forEach((v, i) => assert.ok(v.at <= v.ref * 1.5 + 2e-4, `switch ${i + 1}: no click (jerk ${v.at.toExponential(2)} vs steady ${v.ref.toExponential(2)})`));
}

// Pump on the module: kicks every beat at 120 BPM duck a ducking track by the preset depth and it is
// back to unity before the next beat; a track without Duck to kick never moves.
async function pumpEnvelopes(page) {
  const r = await page.evaluate(async () => {
    const F = window.__fx, MF = F.MF(), bpm = 120, beat = .5, x = F.sig.sine(500, 3, .2), out = {}; // 500 Hz: whole periods in 2 ms blocks
    for (const [pump, duck] of [['subtle', true], ['medium', true], ['heavy', true], ['off', true], ['heavy', false]]) {
      let song = null;
      const [L] = await F.render(x, (ctx, dest) => { song = MF.createSongFx(ctx, dest).set({ pump }, { bpm, immediate: true }); const t = MF.createTrackFx(ctx, song.input, song); t.set({ duck }, { immediate: true }); for (let k = 0; k < 5; k++) song.pump.kick(.5 + k * beat); return t.input; });
      const env = F.envelope(L, 2), ref = F.rms(L, Math.round(.1 * F.SR), Math.round(.45 * F.SR)), dips = [], recovered = [];
      for (let k = 0; k < 5; k++) {
        const t = .5 + k * beat, i0 = Math.round(t / .002);
        dips.push(F.db(Math.min(...env.slice(i0, i0 + 40)) / ref));
        recovered.push(F.db(F.rms(L, Math.round((t + beat - .03) * F.SR), Math.round((t + beat - .004) * F.SR)) / ref));
      }
      out[`${pump}${duck ? '' : ' (no duck)'}`] = { dips, recovered, depth: MF.PUMP_PRESETS[pump]?.depth ?? 0 };
    }
    return out;
  });
  for (const [k, v] of Object.entries(r)) {
    const want = k.includes('no duck') ? 0 : v.depth;
    v.dips.forEach((d, i) => assert.ok(near(d, want, want ? 1 : .05), `${k}: kick ${i + 1} dips ${d.toFixed(2)} dB, expected ${want} dB`));
    v.recovered.forEach((d, i) => assert.ok(Math.abs(d) < .15, `${k}: back to unity before beat ${i + 2} (${d.toFixed(2)} dB)`));
  }
}

// ---- App tests (Baby DAW / Track Master: routing, export, pump, saving, undo, UI) ----
const press = (page, locator) => page.touch ? locator.tap() : locator.click();
const tap = (page, selector) => press(page, page.locator(selector).first());
async function setBpm(page, bpm) {
  await page.evaluate(bpm => { const b = document.getElementById('bpmInput'); b.value = String(bpm); b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('change', { bubbles: true })); }, bpm);
}
// A drum pattern (Beat Maker v3) with hits: {kick1: [steps], chh: [steps]} on bar 1.
const DRUM_PATTERN = `(hits, gain = .5) => { const b = window.CRPBeatMaker.getBeat(); for (const k of Object.keys(b.tracks)) b.tracks[k] = b.tracks[k].map(() => []); for (const [k, steps] of Object.entries(hits)) b.tracks[k][0] = steps; b.bars = 1; b.gain = gain; b.enabled = true; return b; }`;
async function loadSong(page, project, { bpm = 120, drums = null, drumGain = .5 } = {}) {
  await setBpm(page, bpm);
  await page.evaluate(([project, drums, drumGain, mk]) => {
    const make = eval(mk);
    if (drums) {
      const pattern = make(drums.hits, drumGain);
      window.CRPBeatMaker.setBeat(pattern, { persist: false });
      project.drumEvents = drums.regions.map(r => ({ ...r, pattern: make(r.hits || drums.hits, drumGain) }));
    }
    window.CRPParts.loadProject({ parts: project });
  }, [project, drums, drumGain, DRUM_PATTERN]);
  await page.waitForTimeout(150);
}
const chordData = (page, cards) => page.evaluate(cards => { const s = window.CRPCore.snapshot(); s.rows = [cards.map((c, i) => ({ type: 'chord', durationBeats: 4, voxId: `card-${i}`, ...c }))]; return s; }, cards);
// Exports the song through the app's own export dialog; `pick(part)` chooses the parts, `drums` the drums.
async function exportWav(page, { pick = () => true, drums = false } = {}) {
  await page.evaluate(() => window.CRPParts.openAudioExport());
  await page.evaluate(([pickSrc, drums]) => {
    const pick = eval(pickSrc), items = window.CRPParts.capture().items;
    for (const b of document.querySelectorAll('#audioExportModal [data-audio-part]')) b.checked = !!pick(items.find(p => p.id === b.dataset.audioPart));
    const d = document.getElementById('audioExportDrums'); if (d) d.checked = drums;
  }, [pick.toString(), drums]);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), tap(page, '#audioExportGo')]);
  const wav = readFileSync(await download.path()), sr = wav.readUInt32LE(24), frames = (wav.length - 44) / 4, L = new Float64Array(frames), R = new Float64Array(frames);
  for (let i = 0; i < frames; i++) { L[i] = wav.readInt16LE(44 + i * 4) / 32768; R[i] = wav.readInt16LE(46 + i * 4) / 32768; }
  return { L, R, sr };
}
const rmsOf = (x, sr, a, b) => { let e = 0; const i0 = Math.round(a * sr), i1 = Math.round(b * sr); for (let i = i0; i < i1; i++) e += x[i] * x[i]; return Math.sqrt(e / Math.max(1, i1 - i0)); };
const dB = x => 20 * Math.log10(Math.max(1e-12, x));
// Band energy (dB) of x between f0 and f1 Hz over [a, b) s, by DFT on 4096-sample frames.
function bandDb(x, sr, a, b, f0, f1) {
  const N = 4096; let e = 0;
  for (let s = Math.round(a * sr); s + N <= Math.round(b * sr); s += N) for (let k = Math.ceil(f0 * N / sr); k <= Math.floor(f1 * N / sr); k++) {
    let re = 0, im = 0; for (let i = 0; i < N; i += 2) { const w = .5 - .5 * Math.cos(2 * Math.PI * i / N), v = x[s + i] * w, ph = 2 * Math.PI * k * i / N; re += v * Math.cos(ph); im -= v * Math.sin(ph); }
    e += re * re + im * im;
  }
  return 10 * Math.log10(e + 1e-30);
}

// The WAV export has the song's, a track's and a clip's effects: the track is panned right, its second
// chord (own clip FX) left, and the song EQ (Telephone) takes the lows away.
async function exportHasAllLevels(page) {
  const data = await chordData(page, [{ value: 'C' }, { value: 'G', fx: { pan: -100 } }]);
  const song = songFx => ({ items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data, trackFx: { pan: 100 } }], loadedChordPartId: 'chord-1', activePartId: 'chord-1', drumEvents: [], songFx });
  await loadSong(page, song({ eq: 'telephone' }));
  const a = await exportWav(page);
  const lr1 = dB(rmsOf(a.L, a.sr, .1, 1.9) / rmsOf(a.R, a.sr, .1, 1.9)), lr2 = dB(rmsOf(a.L, a.sr, 2.1, 3.9) / rmsOf(a.R, a.sr, 2.1, 3.9));
  assert.ok(lr1 < -30, `track FX (pan right) in the WAV: left/right ${lr1.toFixed(1)} dB`);
  assert.ok(lr2 > 30, `clip FX (pan left) replace the track's for that chord: left/right ${lr2.toFixed(1)} dB`);
  await loadSong(page, song({}));
  const b = await exportWav(page);
  const tilt = w => { const x = w.L.map((v, i) => v + w.R[i]); return bandDb(x, w.sr, .1, 3.9, 60, 250) - bandDb(x, w.sr, .1, 3.9, 700, 2000); };
  assert.ok(tilt(a) < tilt(b) - 12, `song FX (Telephone EQ) in the WAV: lows vs mids ${tilt(a).toFixed(1)} dB, without ${tilt(b).toFixed(1)} dB`);
}

// Drums in the export: the Drums track's FX (pan left) and a region's own FX (pan right).
async function exportDrumsFx(page) {
  await loadSong(page, { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data: await chordData(page, [{ value: 'C' }]) }], loadedChordPartId: 'chord-1', activePartId: 'chord-1', drumsFx: { pan: -100 } }, { drums: { hits: { kick1: [0, 16, 32, 48], chh: [0, 8, 16, 24, 32, 40, 48, 56] }, regions: [{ id: 'r1', startBeat: 0, durationBeats: 4 }, { id: 'r2', startBeat: 4, durationBeats: 4, fx: { pan: 100 } }] } });
  const w = await exportWav(page, { pick: () => false, drums: true });
  const lr1 = dB(rmsOf(w.L, w.sr, .05, 1.95) / rmsOf(w.R, w.sr, .05, 1.95)), lr2 = dB(rmsOf(w.L, w.sr, 2.05, 3.95) / rmsOf(w.R, w.sr, 2.05, 3.95));
  assert.ok(lr1 > 30, `Drums track FX (pan left): left/right ${lr1.toFixed(1)} dB`);
  assert.ok(lr2 < -30, `a drum region's own FX (pan right): left/right ${lr2.toFixed(1)} dB`);
}

// Pump in the export: a held brass note (recorded, so two renders are identical) with a quiet kick on
// every beat. Pump Medium against Off: the ratio is the duck alone.
async function exportPump(page) {
  const lead = (duck = true) => ({ id: 'lead-1', type: 'lead', name: 'Horn', enabled: true, volume: .03, instrument: 'misc', sound: 'trombone', resolution: 16, bars: 4, events: [{ step: 0, midi: 53, durationSteps: 32 }, { step: 32, midi: 56, durationSteps: 32 }], trackFx: { duck } });
  const song = (pump, duck) => ({ items: [lead(duck)], activePartId: 'lead-1', songFx: { pump } });
  const drums = { hits: { kick1: [0, 16, 32, 48] }, regions: [{ id: 'r1', startBeat: 0, durationBeats: 16 }] };
  // The kick is kept ~25 dB under the horn so it hardly shows in the measurement (it still pumps).
  await loadSong(page, song('medium', true), { drums, drumGain: .002 });
  const a = await exportWav(page, { drums: true });
  await loadSong(page, song('off', true), { drums, drumGain: .002 });
  const b = await exportWav(page, { drums: true });
  await loadSong(page, song('heavy', false), { drums, drumGain: .002 });
  const c = await exportWav(page, { drums: true });
  const ratio = (x, y, t0, t1) => dB(rmsOf(x.L, x.sr, t0, t1) / rmsOf(y.L, y.sr, t0, t1));
  for (let k = 1; k < 15; k++) {
    if (k === 8) continue; // the second note starts here
    const t = k * .5; let dip = 0;
    for (let s = t; s < t + .06; s += .005) dip = Math.min(dip, ratio(a, b, s, s + .005));
    assert.ok(near(dip, -6, 1), `export: the kick at beat ${k + 1} ducks the horn by ${dip.toFixed(2)} dB (Medium: −6 dB)`);
    const back = ratio(a, b, t + .45, t + .495);
    assert.ok(Math.abs(back) < .3, `export: back to unity before beat ${k + 2} (${back.toFixed(2)} dB)`);
    const none = ratio(c, b, t, t + .1);
    assert.ok(Math.abs(none) < .1, `a track with Duck to kick off is not pumped (${none.toFixed(2)} dB)`);
  }
}

async function samplePump(page, ms) {
  return page.evaluate(ms => new Promise(resolve => {
    const out = [], t0 = performance.now();
    const tick = () => { const s = window.CRPParts.musicFxState().song; out.push(s.pumpGains.slice()); if (performance.now() - t0 < ms) setTimeout(tick, 4); else resolve(out); };
    tick();
  }), ms);
}
// Live: a kick on every beat ducks the chords by the preset depth and they come back between kicks;
// Pump Off never moves them; Stop leaves nothing ducked.
async function livePump(page) {
  const data = await chordData(page, [{ value: 'C', durationBeats: 16 }]);
  const song = pump => ({ items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data }], loadedChordPartId: 'chord-1', activePartId: 'chord-1', songFx: { pump } });
  const drums = { hits: { kick1: [0, 16, 32, 48], chh: [8, 24, 40, 56] }, regions: [{ id: 'r1', startBeat: 0, durationBeats: 16 }] };
  await page.evaluate(() => { document.getElementById('loopToggle').checked = true; });
  await loadSong(page, song('medium'), { drums });
  await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: 0 }));
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  const on = (await samplePump(page, 2200)).flat();
  assert.ok(on.length > 50, `the chords' duck gain is on the pump (${on.length} samples)`);
  const lo = Math.min(...on), hi = Math.max(...on);
  assert.ok(near(dB(lo), -6, 1), `live: the chords duck to ${dB(lo).toFixed(2)} dB on the kicks (Medium: −6 dB)`);
  assert.ok(hi > .995, `live: and come back to unity between kicks (${hi.toFixed(3)})`);
  // Stop in the middle of a duck: nothing stays ducked.
  await page.waitForFunction(() => window.CRPParts.musicFxState().song.pumpGains.some(g => g < .7));
  await page.evaluate(() => window.CRPParts.stopPlayback());
  assert.deepEqual((await page.evaluate(() => window.CRPParts.musicFxState())).song.pumpGains, [], 'Stop releases every duck gain');
  // From half a beat in (between kicks) the restarted chords start at unity.
  await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: .5 }));
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready && window.CRPParts.musicFxState().song.pumpGains.length);
  const first = await page.evaluate(() => window.CRPParts.musicFxState().song.pumpGains[0]);
  assert.ok(first > .999, `after Stop and Play the chords start undducked (${first})`);
  await page.evaluate(() => window.CRPParts.stopPlayback());
  await loadSong(page, song('off'), { drums });
  await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: 0 }));
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  const off = (await samplePump(page, 1200)).flat();
  await page.evaluate(() => window.CRPParts.stopPlayback());
  assert.ok(off.every(g => g === 1), `Pump Off: no ducking (min ${Math.min(...off)})`);
}

async function addPart(page, type) { await tap(page, '#addPartBtn'); await tap(page, `.part-choice[data-part-type="${type}"]`); await page.waitForTimeout(200); }
async function recordTake(page, ms) {
  await tap(page, '#vocalRecordBtn');
  await page.waitForFunction(() => window.CRPParts.isRecording());
  await page.waitForTimeout(ms);
  await tap(page, '#vocalStopBtn');
  await page.waitForFunction(() => !window.CRPParts.isRecording());
  await page.waitForTimeout(500);
}
// Vocals keep their own effects but go through the song's: they are not ducked unless their track's
// Duck to kick is on.
async function vocalsNotDuckedByDefault(page) {
  const data = await chordData(page, [{ value: 'C', durationBeats: 16 }]);
  await loadSong(page, { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data }], loadedChordPartId: 'chord-1', activePartId: 'chord-1', songFx: { pump: 'heavy' } }, { drums: { hits: { kick1: [0, 16, 32, 48] }, regions: [{ id: 'r1', startBeat: 0, durationBeats: 16 }] } });
  await addPart(page, 'vocal');
  await recordTake(page, 1500);
  const ducking = () => page.evaluate(async () => {
    await window.CRPParts.startPlayback({ fromBeat: 0 });
    await new Promise(r => setTimeout(r, 900));
    const n = window.CRPParts.musicFxState().song.pumpGains.length;
    window.CRPParts.stopPlayback();
    return n;
  });
  assert.equal(await ducking(), 1, 'only the chords duck (a vocal does not by default)');
  assert.equal(await page.isChecked('#vocalFxDuck'), false, 'the vocal’s Duck to kick is off');
  await page.evaluate(() => document.getElementById('vocalFxDuck').click());
  assert.equal(await ducking(), 2, 'with Duck to kick on, the vocal ducks too');
  assert.equal((await page.evaluate(() => window.CRPParts.capture().items.find(p => p.type === 'vocal').fx.duck)), true, 'and it is saved');
}

// Repeated play/stop with every kind of effect on does not grow the audio graph.
async function graphStaysBounded(page) {
  const data = await chordData(page, [{ value: 'C' }, { value: 'F', fx: { drive: 'crunch', reverb: 40 } }, { value: 'G', fx: { mod: 'chorus' } }, { value: 'C', fx: { drive: 'crunch', reverb: 40 } }]);
  await loadSong(page, { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data, trackFx: { eq: 'warm', comp: 'medium', mod: 'phaser', pan: -30, reverb: 30, delay: 25 } }, { id: 'lead-1', type: 'lead', name: 'Lead 1', enabled: true, volume: .8, sound: 'acoustic_grand_piano', resolution: 16, bars: 4, events: [{ step: 20, midi: 60, durationSteps: 4, fx: { eq: 'bright' } }, { step: 8, midi: 64, durationSteps: 4 }], trackFx: { drive: 'warm', delay: 40 } }], loadedChordPartId: 'chord-1', activePartId: 'chord-1', drumsFx: { comp: 'punch', reverb: 20 }, songFx: { pump: 'medium', glue: 'light', width: 30, eq: 'scoop', room: 'plate' } }, { drums: { hits: { kick1: [0, 32], chh: [0, 16, 32, 48] }, regions: [{ id: 'r1', startBeat: 0, durationBeats: 8 }, { id: 'r2', startBeat: 8, durationBeats: 8, fx: { eq: 'telephone' } }] } });
  await page.evaluate(() => { document.getElementById('loopToggle').checked = true; });
  const counts = [], chains = [];
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: 3.5 }));
    await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
    await page.waitForTimeout(2600);
    if (!i) chains.push(await page.evaluate(() => window.CRPParts.musicFxState()));
    await page.evaluate(() => window.CRPParts.stopPlayback());
    await page.waitForTimeout(200);
    counts.push(await page.evaluate(() => window.__fx.reachable()));
  }
  const live = chains[0];
  assert.ok(live.partChains === 2 && live.clipChains >= 2 && live.drumChains === 2, `effects were in the graph while playing (${JSON.stringify(live)})`);
  assert.deepEqual(live.song.active, { reverb: true, delay: true }, 'the shared reverb and delay ran while tracks sent to them');
  assert.ok(counts.every(c => c === counts[0]), `connected nodes after each stop: ${counts}`);
  const after = await page.evaluate(() => window.CRPParts.musicFxState());
  assert.ok(after.partChains === 0 && after.clipChains === 0 && after.drumChains === 0 && !after.song.active.reverb && !after.song.active.delay, `nothing left after Stop (${JSON.stringify(after)})`);
  // Dragging a clip's slider while it plays glides the playing chain: no chain per slider step.
  await page.evaluate(() => window.CRPParts.openTrackMaster());
  await page.waitForSelector('.vox-chord-event');
  await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: 3.5 }));
  // The G chord (its own chorus) is queued once its chain exists.
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready && window.CRPParts.musicFxState().clipFxKeys.includes(JSON.stringify(window.CRPMusicFx.normalizeTrackFx(window.CRPParts.capture().items[0].data.rows.flat()[2].fx, { clip: true }))), null, { timeout: 8000 });
  await page.locator('.vox-chord-event').nth(2).click();
  if (await page.locator('.vox-inspector.is-collapsed').count()) await page.click('#voxInspectorToggleBtn');
  await page.selectOption('#voxFxTarget', 'event');
  const before = await page.evaluate(() => window.CRPParts.musicFxState().clipChains);
  await page.evaluate(async () => {
    const s = document.querySelector('#voxMusicFxBody [data-mfx="modAmount"]');
    for (let v = 10; v <= 100; v += 6) { s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 15)); }
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const during = await page.evaluate(() => { const st = window.CRPParts.musicFxState(), g = window.CRPParts.capture().items[0].data.rows.flat()[2].fx; return { n: st.clipChains, keys: st.clipFxKeys, want: JSON.stringify(window.CRPMusicFx.normalizeTrackFx(g, { clip: true })), amount: g.modAmount }; });
  await page.evaluate(() => window.CRPParts.stopPlayback());
  assert.equal(during.amount, 100);
  assert.equal(during.n, before, `a slider drag on a playing clip reuses its chain (${before} → ${during.n} chains)`);
  assert.ok(during.keys.includes(during.want), 'the playing chain follows the drag (it now has the clip’s new settings)');
}

// Edits in Track Master's inspector and the Song FX panel: saved, undone and redone, and they survive a
// reload of the page.
async function fxSaveUndoReload(page) {
  const data = await chordData(page, [{ value: 'C' }, { value: 'F' }, { value: 'G' }]);
  await loadSong(page, { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data }], loadedChordPartId: 'chord-1', activePartId: 'chord-1' }, { drums: { hits: { kick1: [0, 32] }, regions: [{ id: 'r1', startBeat: 0, durationBeats: 8 }] } });
  await page.evaluate(() => window.CRPParts.openTrackMaster());
  await page.waitForSelector('.vox-chord-event');
  const set = (sel, value) => page.evaluate(([sel, value]) => { const el = document.querySelector(sel); if (el.type === 'checkbox') el.checked = value; else el.value = String(value); if (el.type === 'range') el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, value]);
  const showInspector = async () => { if (await page.locator('.vox-inspector.is-collapsed').count()) await tap(page, '#voxInspectorToggleBtn'); };
  // Track FX of the chord track.
  await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-label strong');
  await showInspector();
  assert.match(await page.textContent('#voxInspectorTitle'), /Track Effects/);
  await set('#voxMusicFxBody [data-mfx="eq"]', 'warm');
  await set('#voxMusicFxBody [data-mfx="reverb"]', 35);
  // A clip's own FX.
  await press(page, page.locator('.vox-chord-event').nth(1));
  await page.selectOption('#voxFxTarget', 'event');
  assert.match(await page.textContent('#voxInspectorTitle'), /Clip Effects/);
  await set('#voxMusicFxBody [data-mfx="drive"]', 'crunch');
  // The Drums track's FX, through one of its regions (Apply to: Track edits the selected clip's track).
  await press(page, page.locator('.vox-drum-event').first());
  await page.selectOption('#voxFxTarget', 'track');
  await page.waitForTimeout(100);
  assert.match(await page.textContent('#voxInspectorTitle'), /Drums Track Effects/);
  await set('#voxMusicFxBody [data-mfx="pan"]', -40);
  // Song FX.
  await tap(page, '#voxSongFxBtn');
  await set('#songFxModal [data-mfx="pump"]', 'heavy');
  await tap(page, '#songFxModal .mfx-modal-actions [data-close]');
  const state = () => page.evaluate(() => { const c = window.CRPParts.capture(), p = c.items.find(x => x.id === 'chord-1'); return { eq: p.trackFx.eq, reverb: p.trackFx.reverb, clip: p.data.rows.flat().map(card => card.fx?.drive || null), drumsPan: c.drumsFx.pan, pump: c.songFx.pump }; });
  const edited = { eq: 'warm', reverb: 35, clip: [null, 'crunch', null], drumsPan: -40, pump: 'heavy' };
  assert.deepEqual(await state(), edited, 'every edit is in the project');
  for (let i = 0; i < 5; i++) await tap(page, '#voxUndoBtn');
  assert.deepEqual(await state(), { eq: 'off', reverb: 0, clip: [null, null, null], drumsPan: 0, pump: 'off' }, 'Undo takes every FX edit back (a slider drag is one step)');
  for (let i = 0; i < 5; i++) await tap(page, '#voxRedoBtn');
  assert.deepEqual(await state(), edited, 'Redo puts them back');
  // Leave Track Master: Chord Rider's copy of the chords keeps the clip FX.
  await tap(page, '#voxBoxCloseBtn');
  await page.evaluate(() => { window.CRPParts.syncActiveChord(); window.CRPCore.flushAutoSaveNow?.(); });
  assert.deepEqual(await state(), edited, 'still there after Track Master closes');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.CRPParts && window.CRPMusicFx);
  await page.waitForTimeout(900);
  assert.deepEqual(await state(), edited, 'and after the page reloads');
}

// Baby DAW: the selected part's Effects section, the Song FX and Drums FX panels; Chord Rider's taps go
// through the loaded chord part's track FX. Nothing overflows on a phone.
async function babyDawPanels(page) {
  const data = await chordData(page, [{ value: 'C' }, { value: 'G' }]);
  await loadSong(page, { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data }], loadedChordPartId: 'chord-1', activePartId: 'chord-1' });
  await page.evaluate(() => { const d = document.getElementById('partFxPanel'); d.open = true; d.scrollIntoView({ block: 'center' }); });
  await page.selectOption('#partFxBody [data-mfx="eq"]', 'bright');
  await page.check('#partFxBody [data-mfx="bypass"]');
  let p = await page.evaluate(() => window.CRPParts.capture().items[0].trackFx);
  assert.equal(p.eq, 'bright'); assert.equal(p.bypass, true); assert.equal(p.duck, true, 'Duck to kick is on by default for a chord track');
  assert.match(await page.textContent('#partFxSummary'), /Bypassed · EQ Bright/);
  await page.uncheck('#partFxBody [data-mfx="bypass"]');
  // Chord Rider's taps: through the loaded chord part's FX.
  await press(page, page.locator('.progression-line:not(.carousel-clone) .chord-card').first());
  await page.waitForFunction(() => window.CRPParts.musicFxState().audition);
  assert.equal((await page.evaluate(() => window.CRPParts.musicFxState().audition)).eq, 'bright', 'Chord Rider taps play through the part’s track FX');
  await page.selectOption('#partFxBody [data-mfx="eq"]', 'dark');
  assert.equal((await page.evaluate(() => window.CRPParts.musicFxState().audition)).eq, 'dark', '…and follow edits');
  await tap(page, '#bdSongFxBtn');
  assert.ok(await page.isVisible('#songFxModal .mfx-modal-card'));
  await page.selectOption('#songFxModal [data-mfx="glue"]', 'medium');
  await tap(page, '#songFxModal .mfx-modal-close');
  await tap(page, '#bdDrumsFxBtn');
  assert.ok(await page.isVisible('#drumsFxModal .mfx-modal-card'));
  assert.ok(!(await page.isVisible('#drumsFxModal [data-mfx-wrap="duck"]')), 'the drums never duck');
  await page.selectOption('#drumsFxModal [data-mfx="comp"]', 'punch');
  const c = await page.evaluate(() => window.CRPParts.capture());
  assert.equal(c.songFx.glue, 'medium'); assert.equal(c.drumsFx.comp, 'punch');
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  assert.ok(sw <= iw + 1, `no horizontal overflow (${sw} > ${iw})`);
  await tap(page, '#drumsFxModal .mfx-modal-close');
}

browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_MIC}`, '--autoplay-policy=no-user-gesture-required'] });
console.log(`Music effects e2e tests against ${BASE}`);
try {
  await test('all Off (and old projects with no FX stored) is a null test', () => withPage(DESKTOP, allOffIsTransparent));
  await test('EQ presets tilt the spectrum as named; Amount scales them; the song EQ works the same', () => withPage(DESKTOP, eqPresetsTilt));
  await test('drive adds harmonics (Warm even, Crunch < Fuzz), more with Amount', () => withPage(DESKTOP, driveHarmonics));
  await test('compression, drive and glue presets stay within ±1.5 dB of Off on real material', () => withPage(DESKTOP, levelMatched));
  await test('chorus / phaser / flanger modulate; tremolo and auto-pan cycle at the Speed rate', () => withPage(DESKTOP, modulationWorks));
  await test('pan is constant-power and transparent at the centre', () => withPage(DESKTOP, panIsConstantPower));
  await test('song delay: echoes at the tempo note value, decaying repeats', () => withPage(DESKTOP, delayEchoes));
  await test('song reverb rooms: tail length per room, wide; idle when unused', () => withPage(DESKTOP, reverbRooms));
  await test('song width: mono ↔ wide (mid/side)', () => withPage(DESKTOP, widthMidSide));
  await test('switching presets while playing does not click', () => withPage(DESKTOP, noClicksWhenSwitching));
  await test('pump ducks by the preset depth at each kick and recovers before the next beat', () => withPage(DESKTOP, pumpEnvelopes));
  await test('desktop: the WAV export has song, track and clip FX', () => withPage(DESKTOP, exportHasAllLevels));
  await test('desktop: the WAV export has the Drums track FX and a drum region’s own FX', () => withPage(DESKTOP, exportDrumsFx));
  await test('desktop: the WAV export pumps like playback (depth, recovery, Duck to kick off)', () => withPage(DESKTOP, exportPump));
  await test('desktop: live pump ducks on the kicks, Off never ducks, Stop leaves nothing ducked', () => withPage(DESKTOP, livePump));
  await test('desktop: vocals are not ducked unless their Duck to kick is on', () => withPage(DESKTOP, vocalsNotDuckedByDefault));
  await test('desktop: repeated play/stop with every effect on does not grow the audio graph', () => withPage(DESKTOP, graphStaysBounded));
  await test('desktop: Track Master FX edits save, undo/redo and survive a reload', () => withPage(DESKTOP, fxSaveUndoReload));
  await test('phone: Track Master FX edits save, undo/redo and survive a reload', () => withPage(PHONE, fxSaveUndoReload));
  await test('phone: Baby DAW Effects, Song FX and Drums FX panels; Chord Rider taps use the track FX', () => withPage(PHONE, babyDawPanels));
  await test('desktop: Baby DAW Effects, Song FX and Drums FX panels; Chord Rider taps use the track FX', () => withPage(DESKTOP, babyDawPanels));
} finally { await browser.close(); }
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
