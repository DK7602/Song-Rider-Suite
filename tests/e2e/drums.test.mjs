// Drum playback end-to-end tests: Beat Maker drums under the Track Master /
// Baby DAW transport and Chord Rider's Play, in headless Chromium:
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/drums.test.mjs
// Every drum hit and note the app schedules is recorded with its AudioContext
// start time, so a test can check that the drums keep playing, on the song's
// beat (against the chord onsets), for as long as the song plays.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
// Tags each decoded buffer with the URL it was fetched from, then records every
// buffer source started on a live AudioContext: drum samples by file name,
// everything else (SoundFont notes) as "note"; `when` is its start time, `now`
// the time it was scheduled. A source stopped before it starts is "cancelled".
const INSTRUMENT = `(() => {
  const urlOf = new WeakMap(), arrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function () { const r = await arrayBuffer.call(this); try { urlOf.set(r, this.url); } catch {} return r; };
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (data, ...rest) {
    const url = urlOf.get(data) || '';
    return decode.call(this, data, ...rest).then(b => { try { b.__url = url; } catch {} return b; });
  };
  window.__hits = [];
  const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...a) {
    if (this.context instanceof AudioContext) {
      const m = /assets\\/drums\\/([\\w-]+)\\.wav/.exec(this.buffer?.__url || '');
      window.__hits.push(this.__hit = { id: m ? m[1] : 'note', when, now: this.context.currentTime });
    }
    return start.call(this, when, ...a);
  };
  AudioBufferSourceNode.prototype.stop = function (when = 0, ...a) {
    if (this.__hit && Math.max(when, this.context.currentTime) <= this.__hit.when) this.__hit.cancelled = true;
    return stop.call(this, when, ...a);
  };
})();`;

// ---- Harness ----
let browser;
async function withPage(device, fn, { path = '/?workspace=baby-daw', drumDelayMs = 0 } = {}) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await context.route('https://gleitz.github.io/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SOUNDFONT }));
  if (drumDelayMs) await context.route('**/assets/drums/**', async route => { await new Promise(r => setTimeout(r, drumDelayMs)); await route.continue(); });
  await context.addInitScript({ content: INSTRUMENT });
  const page = await context.newPage(), errors = [];
  page.touch = !!device.hasTouch;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CRPCore && window.CRPParts && window.CRPBeatMaker);
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
const press = (page, locator) => page.touch ? locator.tap() : locator.click();
const tap = (page, selector) => press(page, page.locator(selector).first());
const audioNow = page => page.evaluate(() => window.CRPAudio.context().currentTime);
const hits = page => page.evaluate(() => window.__hits.filter(h => !h.cancelled));
// A song of four 4-beat chords with one Track Master drum region [0,16) that
// plays a kick on every beat. Options: bpm, song end marker, an extra disabled
// Lead part that is longer than the song.
async function loadSong(page, { bpm = 120, endBeat = null, longDisabledLead = false } = {}) {
  await page.evaluate(({ bpm, endBeat, longDisabledLead }) => {
    const box = document.getElementById('bpmInput'); box.value = String(bpm); box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('loopToggle').checked = true;
    const snap = window.CRPCore.snapshot(); snap.rows = [['C', 'F', 'G', 'C'].map(value => ({ type: 'chord', value, durationBeats: 4 }))];
    const beat = window.CRPBeatMaker.getBeat(); beat.enabled = true; beat.muted = false; beat.solo = false; beat.bars = 1;
    for (const id of Object.keys(beat.tracks)) beat.tracks[id] = beat.tracks[id].map(() => []);
    beat.tracks.kick1[0] = [0, 16, 32, 48];
    window.CRPBeatMaker.setBeat(beat, { persist: false });
    const items = [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data: snap }];
    if (longDisabledLead) items.push({ id: 'lead-1', type: 'lead', name: 'Lead 1', enabled: false, volume: .8, sound: 'acoustic_grand_piano', resolution: 16, bars: 5, barsMode: 'fixed', events: [] });
    window.CRPParts.loadProject({ parts: { items, loadedChordPartId: 'chord-1', activePartId: 'chord-1', songEndBeat: endBeat, drumEvents: [{ id: 'drums-1', startBeat: 0, durationBeats: 16, patternOffsetBeats: 0, pattern: beat }] } });
    window.CRPBeatMaker.setBeat(beat, { persist: false });
  }, { bpm, endBeat, longDisabledLead });
  await page.waitForTimeout(200);
}
async function openTrackMaster(page) {
  await page.evaluate(() => window.CRPParts.openTrackMaster());
  await page.waitForSelector('.vox-drum-event');
}
async function playTrackMaster(page) {
  await page.evaluate(() => { window.__hits.length = 0; });
  await tap(page, '#voxPlayTransportBtn');
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
}
// Chord onsets: note starts more than 50 ms apart begin a new chord. `since`:
// only notes scheduled from then on (this playback, not one stopped before).
function chordOnsets(all, since = -Infinity) {
  const times = all.filter(h => h.id === 'note' && h.now >= since).map(h => h.when).sort((a, b) => a - b), out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > 0.05) out.push(t);
  return out;
}
// Kicks between `from` and `to` (AudioContext seconds) must land on the song's
// beats, measured from the chord that was sounding (or, before the first chord
// of this playback, the next one), with none missing. `since`: when this
// playback started (chords from before a pause or Stop do not count).
function assertKicksOnBeat(all, from, to, beatSec, label, { tolerance = 0.003, since = -Infinity } = {}) {
  const onsets = chordOnsets(all, since);
  assert.ok(onsets.length, `${label}: no chords played`);
  const kicks = all.filter(h => h.id === 'kick-1' && h.when >= from && h.when < to).map(h => h.when).sort((a, b) => a - b);
  const expected = Math.round((to - from) / beatSec);
  assert.ok(kicks.length >= expected - 1 && kicks.length <= expected + 1, `${label}: ${kicks.length} kicks between ${from.toFixed(2)}s and ${to.toFixed(2)}s, expected ~${expected} (one per beat)`);
  for (const k of kicks) {
    const chord = onsets.filter(o => o <= k + tolerance).pop() ?? onsets[0];
    const beats = (k - chord) / beatSec, off = Math.abs(beats - Math.round(beats)) * beatSec;
    assert.ok(off <= tolerance, `${label}: kick at ${k.toFixed(3)}s is ${(off * 1000).toFixed(1)} ms off the beat (${beats.toFixed(3)} beats after the chord at ${chord.toFixed(3)}s)`);
  }
}
async function playWindow(page, ms) {
  const from = await audioNow(page);
  await page.waitForTimeout(ms);
  return { from, to: await audioNow(page) };
}
async function doubleTapDrumRegion(page) {
  const box = await page.locator('.vox-drum-event').first().boundingBox();
  const x = box.x + Math.min(40, box.width / 3), y = box.y + box.height / 2;
  if (page.touch) { await page.touchscreen.tap(x, y); await page.waitForTimeout(80); await page.touchscreen.tap(x, y); }
  else await page.mouse.dblclick(x, y);
  await page.waitForSelector('#crpBeatModal.open');
}

// ---- Tests ----
// The reported bug: drums stop during Track Master playback and do not come
// back. Editing a drum region (or previewing in Beat Maker) stopped the song's
// drums, and nothing restarted them once the editor closed.
async function drumsSurviveRegionEditing(page) {
  await loadSong(page, { bpm: 120 });
  await openTrackMaster(page);
  await playTrackMaster(page);
  await page.waitForTimeout(1000);
  await doubleTapDrumRegion(page);
  let w = await playWindow(page, 2100);
  assertKicksOnBeat(await hits(page), w.from + 0.6, w.to, 0.5, 'while the drum region editor is open');
  // An edit made in the editor is heard in the playing song.
  const snareAt = await audioNow(page);
  await tap(page, '#crpBeatGrid .crp-step[data-drum="snare1"][data-canonical="32"]');
  await page.waitForTimeout(2600);
  assert.ok((await hits(page)).some(h => h.id === 'snare-1' && h.when > snareAt + 0.1), 'the edited pattern plays in the song');
  // Preview silences the song's drums; stopping it brings them back on the beat.
  await tap(page, '#crpPreview'); await page.waitForTimeout(1200); await tap(page, '#crpPreview');
  w = await playWindow(page, 2100);
  assertKicksOnBeat(await hits(page), w.from + 0.6, w.to, 0.5, 'after Preview stops');
  await tap(page, '#crpBeatSave');
  await page.waitForFunction(() => !document.getElementById('crpBeatModal').classList.contains('open'));
  w = await playWindow(page, 2600);
  assertKicksOnBeat(await hits(page), w.from + 0.6, w.to, 0.5, 'after the editor closes');
  assert.ok(await page.evaluate(() => window.CRPParts.isPlaying()), 'the song is still playing');
  // Pause/resume from between two beats and Stop -> Play stay on the beat.
  await page.waitForTimeout(370);
  await tap(page, '#voxPauseTransportBtn');
  const pausedAt = await audioNow(page); await page.waitForTimeout(500);
  let since = await audioNow(page);
  assert.ok(!(await hits(page)).some(h => h.id !== 'note' && h.when > pausedAt + 0.05 && h.when < since), 'no drums while paused');
  await tap(page, '#voxPlayTransportBtn');
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  w = await playWindow(page, 2600);
  assertKicksOnBeat(await hits(page), w.from + 0.3, w.to, 0.5, 'after pause/resume', { since });
  await tap(page, '#voxStopTransportBtn'); await page.waitForTimeout(400);
  since = await audioNow(page);
  await tap(page, '#voxPlayTransportBtn');
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  w = await playWindow(page, 2600);
  assertKicksOnBeat(await hits(page), w.from + 0.3, w.to, 0.5, 'after Stop -> Play', { since });
  await tap(page, '#voxStopTransportBtn');
  const stoppedAt = await audioNow(page); await page.waitForTimeout(900);
  assert.ok(!(await hits(page)).some(h => h.id !== 'note' && h.when > stoppedAt + 0.05), 'no drums after Stop');
}

// A song whose end is not on the drum grid (a vocal clip or a dragged end
// marker) repeated with the drums a little later on every pass.
async function drumsStayOnBeatAcrossRepeats(page) {
  await loadSong(page, { bpm: 240, endBeat: 13.97 });
  await openTrackMaster(page);
  await playTrackMaster(page);
  const start = await audioNow(page);
  await page.waitForTimeout(14500); // four passes through the 3.5 s song
  assertKicksOnBeat(await hits(page), start + 0.3, await audioNow(page), 0.25, 'over four repeats');
  await tap(page, '#voxStopTransportBtn');
}

// A live edit handed Beat Maker a repeat point that counted a disabled part,
// while the transport repeats at the end of what is playing.
async function drumsRepeatWithTheTransportAfterEdits(page) {
  await loadSong(page, { bpm: 240, longDisabledLead: true });
  await openTrackMaster(page);
  await playTrackMaster(page);
  await page.waitForTimeout(800);
  await page.evaluate(() => { const v = document.querySelector('.vox-track-volume-input[data-drum-track]'); v.value = '55'; v.dispatchEvent(new Event('input', { bubbles: true })); v.dispatchEvent(new Event('change', { bubbles: true })); });
  const w = await playWindow(page, 9000); // more than two passes through the 4 s song
  assertKicksOnBeat(await hits(page), w.from + 0.6, w.to, 0.25, 'after a live edit');
  await tap(page, '#voxStopTransportBtn');
}

// Drums switched off when Play was pressed never started when switched back on.
async function drumsSwitchedOnDuringPlaybackJoin(page) {
  await loadSong(page, { bpm: 120 });
  await openTrackMaster(page);
  const drumsBox = '.vox-drum-region-row .vox-track-label input[type=checkbox]';
  await tap(page, drumsBox);
  assert.equal(await page.evaluate(() => window.CRPBeatMaker.getBeat().enabled), false, 'drums are off');
  await playTrackMaster(page);
  await page.waitForTimeout(1000);
  assert.ok(!(await hits(page)).some(h => h.id === 'kick-1'), 'no drums while they are off');
  await tap(page, drumsBox);
  await page.waitForTimeout(300);
  const w = await playWindow(page, 3000);
  assertKicksOnBeat(await hits(page), w.from, w.to, 0.5, 'after switching the drums on');
  await tap(page, '#voxStopTransportBtn');
}

// Stop pressed while the drum samples were still loading left the drums
// playing on their own.
async function stopWhileDrumsLoad(page) {
  await loadSong(page, { bpm: 120 });
  await openTrackMaster(page);
  await page.evaluate(() => { window.__hits.length = 0; });
  await tap(page, '#voxPlayTransportBtn');
  await page.waitForTimeout(300);
  await tap(page, '#voxStopTransportBtn');
  await page.waitForTimeout(3000);
  assert.equal(await page.evaluate(() => window.CRPParts.isPlaying()), false);
  assert.deepEqual((await hits(page)).filter(h => h.id !== 'note').length, 0, 'no drums after Stop');
  assert.equal(await page.evaluate(() => window.CRPBeatMaker.isMainPlaying()), false, 'Beat Maker is not playing');
  await playTrackMaster(page);
  const w = await playWindow(page, 2000);
  assertKicksOnBeat(await hits(page), w.from + 0.3, w.to, 0.5, 'Play after that');
  await tap(page, '#voxStopTransportBtn');
}

// Chord Rider's own Play button drives the same transport and drums.
async function chordRiderPlayDrums(page) {
  await page.evaluate(() => {
    const box = document.getElementById('bpmInput'); box.value = '120'; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('loopToggle').checked = true;
    const snap = window.CRPCore.snapshot(); snap.rows = [['C', 'F', 'G', 'C'].map(value => ({ type: 'chord', value, durationBeats: 4 }))];
    window.CRPCore.apply(snap); window.CRPParts.syncActiveChord();
    const beat = window.CRPBeatMaker.getBeat(); beat.enabled = true; beat.bars = 1;
    for (const id of Object.keys(beat.tracks)) beat.tracks[id] = beat.tracks[id].map(() => []);
    beat.tracks.kick1[0] = [0, 16, 32, 48];
    window.CRPBeatMaker.setBeat(beat, { persist: true });
    window.__hits.length = 0;
  });
  await page.waitForTimeout(300);
  await tap(page, '#playAllBtn');
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
  const w = await playWindow(page, 9000); // past the 8 s repeat
  assertKicksOnBeat(await hits(page), w.from + 0.3, w.to, 0.5, 'Chord Rider Play');
  await tap(page, '#playAllBtn');
  const stoppedAt = await audioNow(page); await page.waitForTimeout(900);
  assert.ok(!(await hits(page)).some(h => h.id !== 'note' && h.when > stoppedAt + 0.05), 'no drums after Stop');
}

browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`Drum playback e2e tests against ${BASE}`);
try {
  await test('desktop: Track Master drums keep playing through drum-region editing, Preview, pause and Stop -> Play', () => withPage(DESKTOP, drumsSurviveRegionEditing));
  await test('phone: Track Master drums keep playing through drum-region editing, Preview, pause and Stop -> Play', () => withPage(PHONE, drumsSurviveRegionEditing));
  await test('desktop: drums stay on the beat across repeats when the song end is between drum steps', () => withPage(DESKTOP, drumsStayOnBeatAcrossRepeats));
  await test('phone: drums stay on the beat across repeats when the song end is between drum steps', () => withPage(PHONE, drumsStayOnBeatAcrossRepeats));
  await test('desktop: drums repeat with the transport after a live edit (longer disabled part)', () => withPage(DESKTOP, drumsRepeatWithTheTransportAfterEdits));
  await test('desktop: drums switched on during playback join on the beat', () => withPage(DESKTOP, drumsSwitchedOnDuringPlaybackJoin));
  await test('phone: drums switched on during playback join on the beat', () => withPage(PHONE, drumsSwitchedOnDuringPlaybackJoin));
  await test('desktop: Stop while the drum samples load leaves no drums playing', () => withPage(DESKTOP, stopWhileDrumsLoad, { drumDelayMs: 1500 }));
  await test('desktop: Chord Rider Play plays the drums on the beat and Stop stops them', () => withPage(DESKTOP, chordRiderPlayDrums, { path: '/' }));
  await test('phone: Chord Rider Play plays the drums on the beat and Stop stops them', () => withPage(PHONE, chordRiderPlayDrums, { path: '/' }));
} finally { await browser.close(); }
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
