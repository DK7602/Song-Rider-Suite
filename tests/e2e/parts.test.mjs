// Baby DAW / Track Master end-to-end tests: headless Chromium with a fake
// microphone, against a local `wrangler dev` (see tests/README.md):
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/parts.test.mjs
// SoundFont requests are answered with a small synthetic instrument, so the
// tests do not need the network.
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
function toneWavBase64(seconds = 0.4, rate = 22050) {
  const n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * Math.exp(-6 * i / n) * 12000), 44 + i * 2);
  return buf.toString('base64');
}
// MIDI.js soundfont: every note gets the same short tone (pitch does not matter here).
const SOUNDFONT = (() => {
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'], tone = `data:audio/wav;base64,${toneWavBase64()}`;
  let body = 'if (typeof(MIDI) === "undefined") var MIDI = {};\nMIDI.Soundfont = MIDI.Soundfont || {};\nMIDI.Soundfont.test = {\n';
  for (let midi = 21; midi <= 108; midi++) body += `"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "${tone}",\n`;
  return body + '}\n';
})();
// Records which buffers are started, and the audio graph's connections, so a
// test can count the nodes that currently reach an AudioContext's destination.
const INSTRUMENT = `(() => {
  const edges = new Map(), connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (dest, ...rest) { const r = connect.call(this, dest, ...rest); if (dest instanceof AudioNode) { let s = edges.get(this); if (!s) edges.set(this, s = new Set()); s.add(dest); } return r; };
  AudioNode.prototype.disconnect = function (...a) { const r = disconnect.apply(this, a); if (a[0] instanceof AudioNode) edges.get(this)?.delete(a[0]); else if (a[0] === undefined || typeof a[0] === 'number') edges.delete(this); return r; };
  const start = AudioBufferSourceNode.prototype.start; window.__started = [];
  AudioBufferSourceNode.prototype.start = function (...a) { if (this.buffer) window.__started.push(this.buffer.duration); return start.apply(this, a); };
  let autotune = 0; const Worklet = window.AudioWorkletNode;
  if (Worklet) window.AudioWorkletNode = class extends Worklet { constructor(...a) { super(...a); if (a[1] === 'crp-vocal-autotune') autotune++; } };
  window.__graph = {
    autotuneNodes: () => autotune,
    reachable() {
      const into = new Map(); for (const [from, tos] of edges) for (const to of tos) { let s = into.get(to); if (!s) into.set(to, s = new Set()); s.add(from); }
      const seen = new Set(), stack = [...into.keys()].filter(n => n instanceof AudioDestinationNode);
      while (stack.length) for (const from of into.get(stack.pop()) || []) if (!seen.has(from)) { seen.add(from); stack.push(from); }
      return seen.size;
    },
  };
})();`;

// ---- Harness ----
let browser;
async function withPage(device, fn) {
  const context = await browser.newContext({ ...device, permissions: ['microphone'] });
  await context.route('https://gleitz.github.io/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SOUNDFONT }));
  await context.addInitScript({ content: INSTRUMENT });
  const page = await context.newPage(), errors = [];
  page.touch = !!device.hasTouch;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  try {
    await page.goto(`${BASE}/?workspace=baby-daw`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CRPCore && window.CRPParts);
    await page.waitForTimeout(700); // let the app finish restoring its startup project
    await fn(page);
    assert.deepEqual(errors, [], 'page errors');
  } finally { await context.close(); }
}
async function test(name, fn) {
  try { await fn(); passes++; console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); }
}

// ---- Page helpers ----
// Phones get real touch taps, desktops mouse clicks.
const press = (page, locator) => page.touch ? locator.tap() : locator.click();
const tap = (page, selector) => press(page, page.locator(selector).first());
async function addPart(page, type) { await tap(page, '#addPartBtn'); await tap(page, `.part-choice[data-part-type="${type}"]`); await page.waitForTimeout(200); }
async function recordTake(page, ms) {
  await tap(page, '#vocalRecordBtn');
  await page.waitForFunction(() => window.CRPParts.isRecording());
  await page.waitForTimeout(ms);
  await tap(page, '#vocalStopBtn');
  await page.waitForFunction(() => !window.CRPParts.isRecording());
  await page.waitForTimeout(500);
}
const vocalParts = page => page.evaluate(() => window.CRPParts.capture().items.filter(p => p.type === 'vocal'));
async function setChords(page, chords, beats = 4) {
  await page.evaluate(([chords, beats]) => {
    const snap = window.CRPCore.snapshot(); snap.rows = [chords.map(value => ({ type: 'chord', value, durationBeats: beats }))];
    window.CRPCore.apply(snap); window.CRPParts.syncActiveChord();
  }, [chords, beats]);
}
// Plays for `ms` and returns the durations of the buffers started meanwhile.
async function playFor(page, ms, start = () => window.CRPParts.startPlayback({ fromBeat: 0 })) {
  await page.evaluate(() => { window.__started.length = 0; });
  await page.evaluate(start);
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  await page.waitForTimeout(ms);
  await page.evaluate(() => window.CRPParts.stopPlayback());
  return page.evaluate(() => window.__started);
}
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
// Drags with a mouse, or on touch with Track Master's long-press (synthetic touch pointer events).
async function drag(page, from, to, touch) {
  const grabbed = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.className || '', from);
  assert.match(grabbed, /vox-instrument-event/, `drag must start on a clip, found "${grabbed}"`);
  if (!touch) {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y, { steps: 3 }); await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
    return;
  }
  const fire = (type, p) => page.evaluate(([type, p]) => {
    const target = type === 'pointerdown' ? document.elementFromPoint(p.x, p.y) : window;
    target.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  }, [type, p]);
  await fire('pointerdown', from); await page.waitForTimeout(520);
  for (let i = 1; i <= 10; i++) await fire('pointermove', { x: from.x + (to.x - from.x) * i / 10, y: from.y + (to.y - from.y) * i / 10 });
  await fire('pointerup', to);
}
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

// ---- Tests ----
async function takeTwoPlays(page) {
  await addPart(page, 'vocal');
  const mixBefore = await page.evaluate(() => JSON.stringify({ parts: window.CRPParts.capture().items.map(p => [p.enabled, p.volume]), drums: document.getElementById('crpDrumsToggle')?.checked }));
  await recordTake(page, 2600);
  await tap(page, '#vocalRecordBtn'); await page.waitForTimeout(700);
  const mixDuring = await page.evaluate(() => JSON.stringify({ parts: window.CRPParts.capture().items.map(p => [p.enabled, p.volume]), drums: document.getElementById('crpDrumsToggle')?.checked }));
  assert.equal(mixDuring, mixBefore, 'recording must not change the saved mix');
  await page.waitForTimeout(600); await tap(page, '#vocalStopBtn'); await page.waitForFunction(() => !window.CRPParts.isRecording()); await page.waitForTimeout(500);
  let [v] = await vocalParts(page);
  const [take1, take2] = v.recordings;
  assert.equal(v.recordings.length, 2);
  assert.ok(take1.duration > take2.duration + 0.5, `take 2 (${take2.duration}) should be shorter than take 1 (${take1.duration})`);
  assert.equal(v.activeTakeId, take2.id);
  assert.deepEqual(v.voxEvents.map(e => [e.takeId, e.startBeat]), [[take2.id, 0]], 'take 2 replaces take 1 on the timeline');
  const labels = await page.$$eval('#vocalTakes .vocal-take', rows => rows.map(r => r.querySelector('.take-use').textContent));
  assert.deepEqual(labels, ['Using', 'Use']);
  let started = await playFor(page, 700, () => document.getElementById('vocalMasterPlayBtn').click());
  assert.ok(started.some(d => near(d, take2.duration)), `take 2 should play (started: ${started.map(d => d.toFixed(2))})`);
  assert.ok(!started.some(d => near(d, take1.duration)), 'take 1 must not play');
  // "Use" on take 1 makes it the clip that plays.
  await press(page, page.locator('#vocalTakes .vocal-take').nth(1).locator('.take-use'));
  [v] = await vocalParts(page);
  assert.equal(v.activeTakeId, take1.id);
  assert.deepEqual(v.voxEvents.map(e => e.takeId), [take1.id]);
  started = await playFor(page, 700, () => document.getElementById('vocalMasterPlayBtn').click());
  assert.ok(started.some(d => near(d, take1.duration)), `take 1 should play after Use (started: ${started.map(d => d.toFixed(2))})`);
}

async function takeMetadataSurvivesReload(page) {
  await addPart(page, 'vocal');
  await recordTake(page, 1500);
  const [v] = await vocalParts(page), take = v.recordings[0];
  const meta = await page.evaluate(id => new Promise((resolve, reject) => {
    const req = indexedDB.open('crp-vocal-audio-v1'); req.onerror = () => reject(req.error);
    req.onsuccess = () => { const get = req.result.transaction('takes').objectStore('takes').get('meta:' + id); get.onsuccess = () => resolve(get.result); };
  }), take.id);
  assert.equal(meta?.name, take.name); assert.ok(near(meta.duration, take.duration, 1e-6)); assert.equal(meta.partId, v.id); assert.equal(meta.projectId, null);
  // The project was never saved. After a reload the take must come back:
  // restored with the project (draft autosave) or through Recover takes.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.CRPParts);
  await page.waitForFunction(id => window.CRPParts.capture().items.some(p => p.type === 'vocal' && p.recordings.some(r => r.id === id)) || document.querySelector('#vocalRecoverBanner [data-recover]'), take.id, { timeout: 8000 });
  if (await page.locator('#vocalRecoverBanner [data-recover]').count()) {
    await tap(page, '#vocalRecoverBanner [data-recover]');
    await tap(page, '#vocalRecoverDialog [data-attach]');
    await page.waitForTimeout(300);
  }
  const restored = (await vocalParts(page)).flatMap(p => p.recordings).find(r => r.id === take.id);
  assert.ok(restored, 'take is attached again');
  assert.equal(restored.name, take.name); assert.ok(near(restored.duration, take.duration, 1e-6)); assert.equal(restored.createdAt, take.createdAt);
  const started = await playFor(page, 600);
  assert.ok(started.some(d => near(d, take.duration)), 'the recovered take plays');
}

async function duplicatedChordSurvivesMove(page, touch) {
  // A reopened project: its cards already carry Track Master identities.
  await page.evaluate(() => {
    const snap = window.CRPCore.snapshot(); snap.rows = [['C', 'F', 'G'].map((value, i) => ({ type: 'chord', value, durationBeats: 4, voxId: `card-${i}` }))];
    window.CRPParts.loadProject({ parts: { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data: snap }], loadedChordPartId: 'chord-1', activePartId: 'chord-1', drumEvents: [] } });
  });
  await page.evaluate(() => window.CRPParts.openTrackMaster());
  await page.waitForSelector('.vox-chord-event');
  await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-menu-btn');
  await press(page, page.locator('#voxTrackContextMenu button', { hasText: 'Duplicate Track' }));
  await page.waitForTimeout(200);
  // Select the destination track first, as a user would (on a phone this also
  // folds the Track Effects panel away from the lanes).
  await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-label strong');
  const rows = page.locator('.vox-instrument-track[data-vox-kind="chord"]');
  const card = await rows.nth(1).locator('.vox-chord-event').first().boundingBox(), lane = await rows.nth(0).locator('.vox-track-lane').boundingBox();
  const ppb = await page.evaluate(() => window.innerWidth <= 600 ? 44 : 56);
  await drag(page, center(card), { x: card.x + card.width / 2 + 2 * ppb, y: lane.y + lane.height / 2 }, touch);
  await page.waitForTimeout(300);
  await playFor(page, 600); // renders and plays through the hot paths
  const chords = (await page.evaluate(() => window.CRPParts.capture().items)).filter(p => p.type === 'chord').map(p => p.data.rows.flat());
  assert.deepEqual(chords.map(c => c.length), [4, 2], 'the moved chord joins the original track; none disappear');
  for (const cards of chords) assert.equal(new Set(cards.map(c => c.voxId)).size, cards.length, 'card identities are unique');
  assert.equal(await rows.nth(0).locator('.vox-chord-event').count(), 4);
}

async function playStopDoesNotGrowGraph(page) {
  await setChords(page, ['C', 'G'], 2);
  await addPart(page, 'vocal');
  await recordTake(page, 1500);
  await page.evaluate(() => { document.getElementById('loopToggle').checked = true; });
  const counts = [];
  for (let i = 0; i < 5; i++) { await playFor(page, 900); await page.waitForTimeout(150); counts.push(await page.evaluate(() => window.__graph.reachable())); }
  assert.ok(counts.every(c => c === counts[0]), `connected nodes after each stop: ${counts}`);
  // While looping (4-beat song) the graph stays the same size from loop to loop.
  await page.evaluate(() => window.CRPParts.startPlayback({ fromBeat: 0 }));
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  const loopMs = 4 * 60000 / (await page.evaluate(() => window.CRPCore.bpm)), during = [];
  for (let i = 0; i < 4; i++) { await page.waitForTimeout(loopMs); during.push(await page.evaluate(() => window.__graph.reachable())); }
  await page.evaluate(() => window.CRPParts.stopPlayback());
  assert.ok(during.every(c => c === during[0]), `connected nodes across loops: ${during}`);
  assert.equal(await page.evaluate(() => window.__graph.autotuneNodes()), 0, 'no Auto-Tune worklet at 0%');
}

async function offlineExportLength(page) {
  await page.evaluate(() => {
    const snap = window.CRPCore.snapshot(); snap.rows = [['C', 'F', 'G'].map(value => ({ type: 'chord', value, durationBeats: 4 }))];
    const lead = { id: 'lead-1', type: 'lead', name: 'Lead 1', enabled: true, volume: .8, sound: 'acoustic_grand_piano', resolution: 16, bars: 4, events: [{ step: 0, midi: 60, durationSteps: 4 }, { step: 32, midi: 64, durationSteps: 4 }] };
    window.CRPParts.loadProject({ parts: { items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data: snap }, lead], loadedChordPartId: 'chord-1', activePartId: 'chord-1', songStartBeat: 2, songEndBeat: 10, drumEvents: [] } });
  });
  await page.evaluate(() => window.CRPParts.openAudioExport());
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), tap(page, '#audioExportGo')]);
  const wav = readFileSync(await download.path());
  const bpm = await page.evaluate(() => window.CRPCore.bpm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 48000); assert.equal(wav.readUInt16LE(22), 2);
  const frames = wav.readUInt32LE(40) / 4, expected = Math.ceil(((10 - 2) * 60 / bpm + 0.08) * 48000);
  assert.equal(frames, expected, 'song start→end markers plus the 80 ms tail');
  let peak = 0; for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  assert.ok(peak > 30, 'the mix is not silent');
}

// The fake microphone "sings" a vowel 40 cents sharp of A3 (A3 = 220 Hz), so Auto-Tune has something to correct.
const FAKE_MIC = join(tmpdir(), `srs-offkey-vowel-${process.pid}.wav`);
{
  const sr = 48000, n = sr * 3, f0 = 220 * 2 ** (40 / 1200), pcm = Buffer.alloc(44 + n * 2);
  const formant = f => [[730, 90, 1], [1090, 110, .5], [2440, 160, .25]].reduce((a, [fc, bw, g]) => a + g / (1 + ((f - fc) / bw) ** 2), .02);
  const amps = []; for (let k = 1; k * f0 < 9000; k++) amps.push(formant(k * f0) / k);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  const norm = amps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < amps.length; k++) v += amps[k] * Math.sin(2 * Math.PI * (k + 1) * f0 * i / sr); pcm.writeInt16LE(Math.round(v / norm * .5 * 32767), 44 + i * 2); }
  writeFileSync(FAKE_MIC, pcm);
}
// Records the (off-key) fake mic into a vocal part, exports only that part at the given Auto-Tune amount and
// returns the pitch of the exported vocal in cents relative to A3.
async function exportedVocalCents(page, amount) {
  const wav = await (async () => {
    await page.evaluate(([amount]) => { const s = document.getElementById('vocalFxAutotune'); s.value = String(amount); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, [amount]);
    await page.evaluate(() => window.CRPParts.openAudioExport());
    await page.evaluate(() => { for (const b of document.querySelectorAll('#audioExportModal [data-audio-part]')) { const vocal = window.CRPParts.capture().items.find(p => p.id === b.dataset.audioPart)?.type === 'vocal'; b.checked = vocal; } const d = document.getElementById('audioExportDrums'); if (d) d.checked = false; });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), tap(page, '#audioExportGo')]);
    return readFileSync(await download.path());
  })();
  // Loudest 0.4 s of the left channel, then autocorrelation pitch (parabolic refined).
  const sr = wav.readUInt32LE(24), ch = wav.readUInt16LE(22), frames = (wav.length - 44) / (2 * ch), x = new Float64Array(frames);
  for (let i = 0; i < frames; i++) x[i] = wav.readInt16LE(44 + i * 2 * ch) / 32768;
  const W = Math.round(.4 * sr); let best = 0, at = 0;
  for (let s = 0; s + W < frames; s += Math.round(sr / 20)) { let e = 0; for (let i = s; i < s + W; i += 4) e += x[i] * x[i]; if (e > best) { best = e; at = s; } }
  const seg = x.subarray(at, at + W), lo = Math.floor(sr / 260), hi = Math.ceil(sr / 190), r = t => { let v = 0; for (let i = 0; i + t < seg.length; i++) v += seg[i] * seg[i + t]; return v; };
  let bt = lo, bv = -Infinity; for (let t = lo; t <= hi; t++) { const v = r(t); if (v > bv) { bv = v; bt = t; } }
  const a = r(bt - 1), b = r(bt), c = r(bt + 1), shift = (a - c) / (2 * (a - 2 * b + c));
  return 1200 * Math.log2(sr / (bt + shift) / 220);
}
async function autotuneInExport(page) {
  await setChords(page, ['C', 'F', 'G']); // key: C major (A is in the scale)
  await addPart(page, 'vocal');
  await recordTake(page, 1500);
  const raw = await exportedVocalCents(page, 0), tuned = await exportedVocalCents(page, 100);
  assert.ok(raw > 25 && raw < 55, `the recorded vocal should be about 40 cents sharp, measured ${raw.toFixed(1)}`);
  assert.ok(Math.abs(tuned) < 10, `with Auto-Tune at 100% the exported vocal should be on A3, measured ${tuned.toFixed(1)} cents`);
}

browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_MIC}`, '--autoplay-policy=no-user-gesture-required'] });
console.log(`Baby DAW / Track Master e2e tests against ${BASE}`);
try {
  await test('desktop: take 2 becomes the clip that plays; Use switches it', () => withPage(DESKTOP, takeTwoPlays));
  await test('phone: take 2 becomes the clip that plays; Use switches it', () => withPage(PHONE, takeTwoPlays));
  await test('desktop: take metadata survives reload of a never-saved project', () => withPage(DESKTOP, takeMetadataSurvivesReload));
  await test('desktop: a duplicated track\'s chord survives a cross-track move', () => withPage(DESKTOP, page => duplicatedChordSurvivesMove(page, false)));
  await test('phone: a duplicated track\'s chord survives a long-press move', () => withPage(PHONE, page => duplicatedChordSurvivesMove(page, true)));
  await test('desktop: repeated play/stop and looping do not grow the audio graph', () => withPage(DESKTOP, playStopDoesNotGrowGraph));
  await test('desktop: offline WAV export has the song-range length', () => withPage(DESKTOP, offlineExportLength));
  await test('phone: offline WAV export has the song-range length', () => withPage(PHONE, offlineExportLength));
  await test('desktop: Auto-Tune is applied in the exported WAV (a sharp vocal lands on the note)', () => withPage(DESKTOP, autotuneInExport));
} finally { await browser.close(); }
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
