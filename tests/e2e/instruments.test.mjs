// Instrument engine (instruments.js) end-to-end tests: headless Chromium against a local
// `wrangler dev` (see tests/README.md):
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/instruments.test.mjs
// The engine is pointed at /__fixtures__/instruments/, answered from tests/fixtures/instruments
// (a small Salamander piano subset) plus sets generated here (plucked clean guitar, trumpet,
// trombone, horn). SoundFont requests get a synthetic instrument. No network is needed.
//   INSTRUMENT_SETS=<dir>  serve extra real sets from <dir> first (for re-measuring levels)
//   PRINT_LEVELS=1         print the level table
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures', 'instruments');
const EXTRA = process.env.INSTRUMENT_SETS || '';
let failures = 0, passes = 0;

// ---- Generated sample sets (16-bit mono WAV) ----
function wav(samples, rate = 44100) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32000), 44 + i * 2);
  return buf;
}
const hz = m => 440 * 2 ** ((m - 69) / 12);
// Plucked string: harmonics with decay rising with order, a short pick transient.
function pluck(midi, seconds = 2.6, rate = 44100) {
  const f = hz(midi), n = Math.round(seconds * rate), out = new Float32Array(n);
  let seed = midi * 7919;
  for (let k = 1; k * f < rate * .45 && k <= 24; k++) {
    const a = .5 / k ** 1.15, d = 1.1 + .55 * k, ph = k * 1.7;
    for (let i = 0; i < n; i++) { const t = i / rate; out[i] += a * Math.exp(-d * t) * Math.sin(2 * Math.PI * k * f * t + ph); }
  }
  for (let i = 0; i < Math.round(.004 * rate); i++) { seed = (seed * 16807) % 2147483647; out[i] += (seed / 2147483647 - .5) * .3 * (1 - i / (.004 * rate)); }
  return out;
}
// Sustained brass-like tone: bright harmonic series, 40 ms swell, steady body.
function horn(midi, seconds = 2.2, rate = 44100, bright = 1) {
  const f = hz(midi), n = Math.round(seconds * rate), out = new Float32Array(n);
  for (let k = 1; k * f < rate * .45 && k <= 18; k++) {
    const a = .35 * Math.exp(-k / (3.5 * bright));
    for (let i = 0; i < n; i++) { const t = i / rate; out[i] += a * Math.sin(2 * Math.PI * k * f * t); }
  }
  for (let i = 0; i < n; i++) { const t = i / rate; out[i] *= Math.min(1, t / .04) * Math.min(1, (seconds - t) / .15); }
  return out;
}
const GENERATED = {
  electric_guitar_clean: { make: pluck, notes: [40, 45, 50, 55, 59, 64, 69, 74], release: .35, sustained: false },
  // Looped: whole periods from 0.6 s, so a note held past the recording keeps sounding.
  trumpet: { make: (m, s, r) => horn(m, s, r, 1.3), notes: [55, 60, 65, 70, 75, 80], release: .25, sustained: true, loop: m => [.6, .6 + Math.round(1.2 * hz(m)) / hz(m)] },
  trombone: { make: (m, s, r) => horn(m, s, r, .9), notes: [40, 45, 50, 55, 60, 65], release: .25, sustained: true },
  french_horn: { make: (m, s, r) => horn(m, s, r, .6), notes: [45, 50, 55, 60, 65, 70], release: .3, sustained: true },
};
const generatedFiles = new Map();
for (const [id, g] of Object.entries(GENERATED)) {
  generatedFiles.set(`${id}/manifest.json`, Buffer.from(JSON.stringify({ id, name: `${id} (generated test set)`, license: 'test data', samples: g.notes.map(m => ({ midi: m, file: `n${m}.wav`, vel: 100, loopStart: g.loop ? g.loop(m)[0] : null, loopEnd: g.loop ? g.loop(m)[1] : null })), release: g.release, sustained: g.sustained, gain: 1 })));
  for (const m of g.notes) generatedFiles.set(`${id}/n${m}.wav`, wav(g.make(m)));
}
// marimba is listed but its files are broken: the engine must fall back to the SoundFont.
generatedFiles.set('marimba/manifest.json', Buffer.from(JSON.stringify({ id: 'marimba', samples: [{ midi: 60, file: 'missing.mp3' }], release: .3 })));
const fixtureIds = ['acoustic_grand_piano', ...Object.keys(GENERATED), 'marimba'];
function serveFixture(rel) {
  if (rel === 'index.json') {
    const ids = new Set(fixtureIds);
    if (EXTRA && existsSync(join(EXTRA, 'index.json'))) for (const id of JSON.parse(readFileSync(join(EXTRA, 'index.json'), 'utf8')).instruments || []) ids.add(id);
    return { type: 'application/json', body: Buffer.from(JSON.stringify({ instruments: [...ids] })) };
  }
  for (const dir of [EXTRA, FIXTURES].filter(Boolean)) {
    const f = join(dir, rel);
    if (existsSync(f) && !rel.includes('..')) return { type: extname(f) === '.json' ? 'application/json' : 'audio/mpeg', body: readFileSync(f) };
  }
  if (generatedFiles.has(rel)) return { type: rel.endsWith('.json') ? 'application/json' : 'audio/wav', body: generatedFiles.get(rel) };
  return null;
}

// SoundFont stand-in: every note is the same short 330 Hz tone (only used for the fallback path).
function toneWavBase64(seconds = .4, rate = 22050) {
  const n = Math.round(seconds * rate), s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 330 * i / rate) * Math.exp(-6 * i / n) * .37;
  return wav(s, rate).toString('base64');
}
const SOUNDFONT = (() => {
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'], tone = `data:audio/wav;base64,${toneWavBase64()}`;
  let body = 'if (typeof(MIDI) === "undefined") var MIDI = {};\nMIDI.Soundfont = MIDI.Soundfont || {};\nMIDI.Soundfont.test = {\n';
  for (let midi = 21; midi <= 108; midi++) body += `"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "${tone}",\n`;
  return body + '}\n';
})();

// Page-side helpers: oscillator counting, graph reachability, offline renders and analysis.
const PAGE_LIB = `(() => {
  window.CRP_INSTRUMENTS_CONFIG = { basePath: '/__fixtures__/instruments/' };
  const edges = new Map(), connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (dest, ...rest) { const r = connect.call(this, dest, ...rest); if (dest instanceof AudioNode) { let s = edges.get(this); if (!s) edges.set(this, s = new Set()); s.add(dest); } return r; };
  AudioNode.prototype.disconnect = function (...a) { const r = disconnect.apply(this, a); if (a[0] instanceof AudioNode) edges.get(this)?.delete(a[0]); else if (a[0] === undefined || typeof a[0] === 'number') edges.delete(this); return r; };
  let oscillators = 0; const createOsc = BaseAudioContext.prototype.createOscillator;
  BaseAudioContext.prototype.createOscillator = function () { oscillators++; return createOsc.call(this); };
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const name = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const db = x => 20 * Math.log10(Math.max(1e-12, x));
  function reachable() {
    const into = new Map(); for (const [from, tos] of edges) for (const to of tos) { let s = into.get(to); if (!s) into.set(to, s = new Set()); s.add(from); }
    const seen = new Set(), stack = [...into.keys()].filter(n => n instanceof AudioDestinationNode);
    while (stack.length) for (const from of into.get(stack.pop()) || []) if (!seen.has(from)) { seen.add(from); stack.push(from); }
    return seen.size;
  }
  // Renders the reference phrase (chord + melody) through the suite's real chain: bus at
  // soundOutputGain, then createInstrumentFxChain (wah / worm), measured before the master.
  async function phrase(id, { master = false } = {}) {
    const sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(sr * 5.6), sr);
    const cap = ctx.createGain(); cap.connect(master ? window.CRPAudio.buildMaster(ctx) : ctx.destination);
    const fx = window.CRPCore.createInstrumentFxChain(ctx, cap); fx.setSound(id);
    const bus = ctx.createGain(); bus.connect(fx.input);
    const inst = await window.CRPCore.loadSoundfontInstrument(ctx, id, bus);
    bus.gain.value = window.CRPCore.soundOutputGain(id);
    const bass = window.CRPCore.isBassSound(id), chord = bass ? [48, 52, 55] : [60, 64, 67], mel = bass ? [52, 55, 57, 60, 55, 52, 50, 48] : [64, 67, 69, 72, 67, 64, 62, 60];
    for (const m of chord) inst.play(name(m), .3, { duration: 1.6, gain: .95 });
    mel.forEach((m, i) => inst.play(name(m), 2.5 + i * .3, { duration: .28, gain: .92 }));
    const buf = await ctx.startRendering();
    return { buf, provider: window.CRPCore.instrumentProvider(id), kind: inst.kind || (inst.buffers ? 'soundfont' : '?') };
  }
  function levels(buf) {
    const L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0), n = L.length, sr = buf.sampleRate, mono = new Float32Array(n);
    let sum = 0, peak = 0, nan = 0;
    for (let i = 0; i < n; i++) { const a = L[i], b = R[i]; if (!Number.isFinite(a) || !Number.isFinite(b)) { nan++; continue; } const x = (a + b) / 2; mono[i] = x; sum += x * x; peak = Math.max(peak, Math.abs(a), Math.abs(b)); }
    // Gated RMS (BS.1770-style gating, no K filter): 400 ms blocks, 100 ms hop, -70 dBFS absolute and -10 dB relative gates.
    const blk = Math.round(.4 * sr), hop = Math.round(.1 * sr), blocks = [];
    for (let s = 0; s + blk <= n; s += hop) { let e = 0; for (let i = s; i < s + blk; i++) e += mono[i] * mono[i]; blocks.push(e / blk); }
    const abs = blocks.filter(e => e > 1e-7), mean = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length), rel = abs.filter(e => e > mean * .1);
    return { rmsDb: db(Math.sqrt(sum / n)), gatedDb: db(Math.sqrt(rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length))), peakDb: db(peak), nan };
  }
  // YIN f0 estimate on a mono segment.
  function yin(x, sr, start, fmin = 40, fmax = 2500) {
    const W = 2048, maxTau = Math.min(Math.floor(sr / fmin), x.length - start - W - 1), minTau = Math.floor(sr / fmax);
    const d = new Float64Array(maxTau + 1);
    for (let tau = 1; tau <= maxTau; tau++) { let s = 0; for (let i = start; i < start + W; i++) { const q = x[i] - x[i + tau]; s += q * q; } d[tau] = s; }
    let run = 0; const c = new Float64Array(maxTau + 1); c[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) { run += d[tau]; c[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = Math.max(2, minTau); t < maxTau; t++) if (c[t] < .15) { while (t + 1 < maxTau && c[t + 1] < c[t]) t++; tau = t; break; }
    if (tau < 0) { let best = Infinity; for (let t = Math.max(2, minTau); t < maxTau; t++) if (c[t] < best) { best = c[t]; tau = t; } }
    const a = c[tau - 1], b = c[tau], e = c[tau + 1], den = a - 2 * b + e, shift = den ? (a - e) / (2 * den) : 0;
    return sr / (tau + shift);
  }
  // One note, offline, straight from the player (no fx); returns f0 vs expected in cents.
  async function pitch(id, midi, at = .25) {
    const sr = 48000, ctx = new OfflineAudioContext(1, sr * 2, sr);
    const inst = await window.CRPCore.loadSoundfontInstrument(ctx, id, ctx.destination);
    inst.play(name(midi), 0, { duration: 1.6, gain: .95 });
    const x = (await ctx.startRendering()).getChannelData(0);
    const f = yin(x, sr, Math.round(at * sr)), want = 440 * 2 ** ((midi - 69) / 12);
    return { f, want, cents: 1200 * Math.log2(f / want) };
  }
  // Renders notes with one voice tapped onto its own channel; checks how that voice ends.
  async function voiceEnd(id, plan) {
    const sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(sr * plan.seconds), sr), merge = ctx.createChannelMerger(2);
    merge.connect(ctx.destination);
    const mix = ctx.createGain(); mix.connect(merge, 0, 0);
    const inst = await window.CRPCore.loadSoundfontInstrument(ctx, id, mix);
    let tapped = null;
    plan.notes.forEach(([m, at, dur], i) => { const v = inst.play(name(m), at, dur ? { duration: dur, gain: .95 } : { gain: .95 }); if (i === (plan.tap || 0)) tapped = v; });
    if (plan.stopAt != null) tapped.stop(plan.stopAt);
    tapped.connect(merge, 0, 1);
    const buf = await ctx.startRendering(), y = buf.getChannelData(1), m = buf.getChannelData(0);
    let peak = 0, last = -1;
    for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > peak) peak = a; if (a > 0) last = i; }
    let lastMs = 0; for (let i = Math.max(0, last - Math.round(.002 * sr)); i <= last; i++) lastMs = Math.max(lastMs, Math.abs(y[i]));
    // Largest step in the last 30 ms of the voice, relative to its peak.
    let jump = 0; for (let i = Math.max(1, last - Math.round(.03 * sr)); i <= last + 1 && i < y.length; i++) jump = Math.max(jump, Math.abs(y[i] - y[i - 1]));
    let nan = 0; for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i]) || !Number.isFinite(y[i])) nan++;
    return { peak, endSec: last / sr, tailRel: lastMs / Math.max(1e-9, peak), jumpRel: jump / Math.max(1e-9, peak), nan };
  }
  window.__inst = { phrase, levels, pitch, voiceEnd, reachable, name, oscillators: () => oscillators };
})();`;

let browser;
async function withPage(fn, { path = '/index.html', routes } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('https://gleitz.github.io/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SOUNDFONT }));
  await context.route('**/__fixtures__/instruments/**', route => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/__fixtures__\/instruments\//, ''));
    const hit = serveFixture(rel);
    return hit ? route.fulfill({ status: 200, contentType: hit.type, body: hit.body }) : route.fulfill({ status: 404, body: '' });
  });
  if (routes) await routes(context);
  await context.addInitScript({ content: PAGE_LIB });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CRPCore && window.CRPInstruments && window.CRPParts);
    await fn(page);
    assert.deepEqual(errors, [], 'page errors');
  } finally { await context.close(); }
}
async function test(name, fn) {
  try { await fn(); passes++; console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); }
}

const PIANO = ['acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'electric_piano_1', 'electric_piano_2', 'synth_strings_1', 'pad_2_warm', 'pad_3_polysynth', 'lead_2_sawtooth', 'electric_bass_finger'];
const GUITAR = ['acoustic_guitar_steel', 'acoustic_guitar_nylon', 'electric_guitar_clean', 'electric_guitar_jazz', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'wah_wah_guitar'];
const MISC = ['tenor_sax', 'alto_sax', 'french_horn', 'brass_section', 'trumpet', 'trombone', 'tuba', 'flute', 'clavinet', 'funky_worm', 'drawbar_organ', 'vibraphone', 'marimba', 'whistle', 'synth_brass_1'];
const ALL = [...new Set([...PIANO, ...GUITAR, ...MISC])];
const SYNTH = ['electric_piano_1', 'electric_piano_2', 'synth_strings_1', 'pad_2_warm', 'pad_3_polysynth', 'lead_2_sawtooth', 'clavinet', 'funky_worm', 'drawbar_organ', 'whistle', 'synth_brass_1'];
// Served by the engine with this test's sets; the rest fall back to the SoundFont.
const EXPECT_KIND = {
  acoustic_grand_piano: 'sample', bright_acoustic_piano: 'derived', electric_grand_piano: 'derived',
  electric_guitar_clean: 'sample', electric_guitar_jazz: 'derived', electric_guitar_muted: 'derived', overdriven_guitar: 'derived', distortion_guitar: 'derived', wah_wah_guitar: 'derived',
  trumpet: 'sample', trombone: 'sample', french_horn: 'sample', brass_section: 'layered',
  ...Object.fromEntries(SYNTH.map(id => [id, 'synth'])),
};
// Levels are held to +-1.5 dB of the piano for voices made from real recordings or synthesized;
// voices built on this test's generated sets only get a coarse check (their trims were measured on real sets).
const GENERATED_BASED = new Set(['electric_guitar_clean', 'electric_guitar_jazz', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'wah_wah_guitar', 'trumpet', 'trombone', 'french_horn', 'brass_section']);

browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`Instrument engine e2e tests against ${BASE}`);
try {
  await test('every sound loads, renders offline (chord + melody) and is level-matched to the piano', () => withPage(async page => {
    const rows = [];
    for (const id of ALL) {
      const r = await page.evaluate(async id => { const { buf, provider, kind } = await window.__inst.phrase(id); return { id, provider, kind, ...window.__inst.levels(buf) }; }, id);
      rows.push(r);
    }
    const piano = rows.find(r => r.id === 'acoustic_grand_piano'), problems = [];
    if (process.env.PRINT_LEVELS) for (const r of rows) console.log(`       ${r.id.padEnd(22)} ${r.kind.padEnd(9)} gated ${r.gatedDb.toFixed(1)} dBFS (${(r.gatedDb - piano.gatedDb >= 0 ? '+' : '') + (r.gatedDb - piano.gatedDb).toFixed(1)})  rms ${(r.rmsDb - piano.rmsDb >= 0 ? '+' : '') + (r.rmsDb - piano.rmsDb).toFixed(1)}  peak ${r.peakDb.toFixed(1)}`);
    for (const r of rows) {
      const want = EXPECT_KIND[r.id] || 'soundfont';
      if (r.kind !== want) problems.push(`${r.id}: served as ${r.kind}, expected ${want}`);
      if (r.nan) problems.push(`${r.id}: ${r.nan} non-finite samples`);
      if (!(r.gatedDb > -60)) problems.push(`${r.id}: silent (${r.gatedDb.toFixed(1)} dBFS)`);
      if (want === 'soundfont') continue;
      const d = r.gatedDb - piano.gatedDb, tol = GENERATED_BASED.has(r.id) && !EXTRA ? 4 : 1.5;
      if (Math.abs(d) > tol) problems.push(`${r.id}: ${d.toFixed(1)} dB from the piano (allowed +-${tol})`);
    }
    assert.ok(Math.abs(piano.gatedDb - -27.9) < 1, `piano reference level ${piano.gatedDb.toFixed(1)} dBFS (expected -27.9)`);
    assert.deepEqual(problems, []);
  }));

  await test('peaks after the suite master stay at or below about -3 dBFS', () => withPage(async page => {
    const over = [];
    for (const id of ALL) {
      const p = await page.evaluate(async id => window.__inst.levels((await window.__inst.phrase(id, { master: true })).buf).peakDb, id);
      if (p > -2.5) over.push(`${id}: ${p.toFixed(1)} dBFS`);
    }
    assert.deepEqual(over, []);
  }));

  await test('synthesized voices and samples play at the right pitch (incl. shifting between samples)', () => withPage(async page => {
    const bad = [];
    const cases = [
      ...SYNTH.flatMap(id => [[id, 57], [id, 69]]),
      ['acoustic_grand_piano', 60], ['acoustic_grand_piano', 62], ['acoustic_grand_piano', 58], ['acoustic_grand_piano', 76], ['acoustic_grand_piano', 43],
      ['bright_acoustic_piano', 65], ['electric_grand_piano', 61],
      ['electric_guitar_clean', 52], ['overdriven_guitar', 47], ['distortion_guitar', 52], ['electric_guitar_jazz', 57], ['electric_guitar_muted', 50],
      ['brass_section', 58], ['trumpet', 67],
    ];
    for (const [id, midi] of cases) {
      // Worm and whistle have a delayed vibrato: measure before it starts. The organ's 16' drawbar
      // sounds an octave below the key, so its waveform repeats at half the key's frequency.
      const at = (id === 'funky_worm' || id === 'whistle') ? .06 : (id === 'synth_strings_1' || id === 'pad_2_warm') ? .7 : .25;
      const r = await page.evaluate(([id, midi, at]) => window.__inst.pitch(id, midi, at), [id, midi, at]);
      const cents = id === 'drawbar_organ' ? r.cents + 1200 : r.cents;
      if (!(Math.abs(cents) < 20)) bad.push(`${id} midi ${midi}: ${r.f.toFixed(1)} Hz vs ${r.want.toFixed(1)} Hz (${cents.toFixed(0)} cents)`);
    }
    assert.deepEqual(bad, []);
  }));

  await test('note ends, stops, retriggers and steals fade to true silence without a click', () => withPage(async page => {
    const bad = [];
    const plans = {
      release: { seconds: 4, notes: [[60, .1, .5]] },
      stop: { seconds: 4, notes: [[60, .1, null]], stopAt: .45 },
      retrigger: { seconds: 4, notes: [[60, .1, 2], [60, .6, .5]] },
      // More notes at once than the polyphony cap: the first voice is stolen.
      steal: { seconds: 4, notes: [[48, .1, 2.5], ...Array.from({ length: 31 }, (_, i) => [50 + i, .2 + i * .01, 1.5])] },
      // Held past the end of the recording (the fixture's C4 is ~16 s): faded out before its last sample.
      longerThanSample: { seconds: 22, notes: [[60, .1, 60]] },
      // Held for 5 s on a 2.2 s looped recording: it must sustain to the note-off, then end cleanly.
      looped: { seconds: 7, notes: [[67, .1, 5]] },
    };
    const ids = [...SYNTH, 'acoustic_grand_piano', 'electric_guitar_muted', 'overdriven_guitar', 'brass_section', 'trumpet'];
    for (const id of ids) for (const [kind, plan] of Object.entries(plans)) {
      if (kind === 'longerThanSample' && !['acoustic_grand_piano', 'overdriven_guitar'].includes(id)) continue;
      if (kind === 'looped' && !['trumpet', 'brass_section'].includes(id)) continue;
      const r = await page.evaluate(([id, plan]) => window.__inst.voiceEnd(id, plan), [id, plan]);
      if (r.nan) bad.push(`${id} ${kind}: non-finite output`);
      if (!(r.peak > 1e-4)) { bad.push(`${id} ${kind}: tapped voice silent`); continue; }
      if (r.tailRel > .0005) bad.push(`${id} ${kind}: last 2 ms at ${(r.tailRel * 100).toFixed(3)}% of peak (not silent before stopping)`);
      if (r.jumpRel > .25) bad.push(`${id} ${kind}: ${(r.jumpRel * 100).toFixed(1)}% step at the end`);
      if (r.endSec > plan.seconds - .05) bad.push(`${id} ${kind}: still sounding at the end of the render`);
      if (kind === 'stop' && r.endSec > .45 + 3) bad.push(`${id} stop: ended ${r.endSec.toFixed(2)} s`);
      if (kind === 'looped' && !(r.endSec > 5.1 && r.endSec < 5.6)) bad.push(`${id} looped: ended at ${r.endSec.toFixed(2)} s instead of after the 5.1 s note-off`);
    }
    assert.deepEqual(bad, []);
  }));

  await test('realtime: chords and melodies play, voices end and the graph returns to its size', () => withPage(async page => {
    const r = await page.evaluate(async () => {
      const ctx = new AudioContext(); await ctx.resume();
      const an = ctx.createAnalyser(); an.fftSize = 2048; an.connect(ctx.destination);
      const out = [], before = window.__inst.reachable();
      for (const id of ['acoustic_grand_piano', 'pad_2_warm', 'drawbar_organ', 'funky_worm', 'overdriven_guitar', 'electric_piano_2']) {
        const bus = ctx.createGain(); bus.connect(an);
        const p = await window.CRPCore.loadSoundfontInstrument(ctx, id, bus);
        const t = ctx.currentTime + .05; let loud = 0;
        for (const m of [60, 64, 67, 71]) p.play(window.__inst.name(m), t, { duration: .35, gain: .95 });
        [72, 74, 76].forEach((m, i) => p.play(window.__inst.name(m), t + .4 + i * .12, { duration: .1, gain: .9 }));
        const data = new Float32Array(an.fftSize), until = performance.now() + 900;
        while (performance.now() < until) { an.getFloatTimeDomainData(data); let s = 0; for (const x of data) s += x * x; loud = Math.max(loud, Math.sqrt(s / data.length)); await new Promise(r => setTimeout(r, 15)); }
        await new Promise(r => setTimeout(r, 1900));
        out.push({ id, loud, voices: p.voiceCount() });
        p.disconnect(); bus.disconnect();
      }
      await new Promise(r => setTimeout(r, 300));
      const after = window.__inst.reachable(); await ctx.close();
      return { out, before, after };
    });
    for (const x of r.out) { assert.ok(x.loud > 1e-3, `${x.id} silent in realtime (${x.loud})`); assert.equal(x.voices, 0, `${x.id} voices left after the notes ended`); }
    assert.equal(r.after, r.before, `nodes reaching the speakers: ${r.before} before, ${r.after} after`);
  }));

  await test('phone budget: a 4-note chord uses at most 12 oscillators per synth voice', () => withPage(async page => {
    // The first chord may also start the player's one shared chorus/rotary LFO (it runs only while the
    // player sounds); every chord after that costs only its notes.
    const counts = await page.evaluate(async ids => {
      const out = {};
      for (const id of ids) {
        const ctx = new OfflineAudioContext(1, 48000, 48000), p = await window.CRPCore.loadSoundfontInstrument(ctx, id, ctx.destination);
        let before = window.__inst.oscillators();
        for (const m of [60, 64, 67, 71]) p.play(window.__inst.name(m), .1, { duration: .5, gain: .95 });
        const first = window.__inst.oscillators() - before;
        before = window.__inst.oscillators();
        for (const m of [62, 65, 69, 72]) p.play(window.__inst.name(m), .3, { duration: .5, gain: .95 });
        out[id] = { first, next: window.__inst.oscillators() - before };
      }
      return out;
    }, SYNTH);
    for (const [id, n] of Object.entries(counts)) {
      assert.ok(n.next <= 12, `${id}: ${n.next} oscillators for a 4-note chord`);
      assert.ok(n.first - n.next <= 1, `${id}: ${n.first - n.next} shared oscillators started by the first chord`);
    }
  }));

  await test('a missing or broken sample set falls back to the SoundFont', () => withPage(async page => {
    const r = await page.evaluate(async () => {
      const out = {};
      for (const id of ['tenor_sax', 'marimba', 'vibraphone']) {
        const ctx = new OfflineAudioContext(1, 48000, 48000), p = await window.CRPCore.loadSoundfontInstrument(ctx, id, ctx.destination);
        p.play('C4', 0, { duration: .3, gain: .9 });
        const x = (await ctx.startRendering()).getChannelData(0); let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
        out[id] = { soundfont: !!p.buffers && !p.engine, provider: window.CRPCore.instrumentProvider(id), peak };
      }
      // Offline at load time: the engine has nothing, the SoundFont still plays (stubbed here).
      return out;
    });
    for (const [id, x] of Object.entries(r)) { assert.ok(x.soundfont, `${id} should come from the SoundFont`); assert.equal(x.provider, 'soundfont'); assert.ok(x.peak > .01, `${id} silent`); }
  }));

  await test('Baby DAW: engine sounds play live without growing the graph and export to WAV', () => withPage(async page => {
    await page.evaluate(() => {
      const snap = window.CRPCore.snapshot(); snap.instrument = 'misc'; snap.sound = 'drawbar_organ'; snap.rows = [['C', 'G'].map(value => ({ type: 'chord', value, durationBeats: 2 }))];
      const lead = { id: 'lead-1', type: 'lead', name: 'Lead 1', enabled: true, volume: .8, sound: 'funky_worm', resolution: 16, bars: 1, events: [{ step: 0, midi: 72, durationSteps: 4 }, { step: 4, midi: 74, durationSteps: 4 }, { step: 8, midi: 76, durationSteps: 8 }] };
      window.CRPParts.loadProject({ parts: { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data: snap }, lead], loadedChordPartId: 'chord-1', activePartId: 'chord-1', drumEvents: [] } });
      document.getElementById('loopToggle').checked = true;
    });
    const counts = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: 0 }));
      await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
      await page.waitForTimeout(1400);
      await page.evaluate(() => window.CRPParts.stopPlayback());
      await page.waitForTimeout(400);
      counts.push(await page.evaluate(() => window.__inst.reachable()));
    }
    assert.ok(counts.every(c => c === counts[0]), `connected nodes after each stop: ${counts}`);
    assert.equal(await page.evaluate(() => window.CRPCore.instrumentProvider('drawbar_organ')), 'engine');
    await page.evaluate(() => window.CRPParts.openAudioExport());
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#audioExportGo').click()]);
    const wavFile = readFileSync(await download.path());
    let peak = 0; for (let i = 44; i < wavFile.length; i += 2) peak = Math.max(peak, Math.abs(wavFile.readInt16LE(i)));
    assert.ok(peak > 300, `the exported mix is silent (peak ${peak})`);
    assert.ok(peak < 32767 * .9, `the exported mix peaks at ${(20 * Math.log10(peak / 32767)).toFixed(1)} dBFS`);
  }, { path: '/?workspace=baby-daw' }));

  await test('Chord Rider: switching to an engine sound auditions through the shared bus', () => withPage(async page => {
    const r = await page.evaluate(async () => {
      const snap = window.CRPCore.snapshot(); snap.instrument = 'misc'; snap.sound = 'whistle'; window.CRPCore.apply(snap);
      const before = window.__inst.oscillators();
      window.CRPCore.auditionProgression(['C', 'F']);
      await new Promise(r => setTimeout(r, 900));
      return { made: window.__inst.oscillators() - before, provider: window.CRPCore.instrumentProvider('whistle'), gain: window.CRPCore.soundOutputGain('whistle') };
    });
    assert.ok(r.made > 0, 'no voices were created');
    assert.equal(r.provider, 'engine');
    assert.equal(r.gain, 1);
  }));
} finally { await browser.close(); }
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
