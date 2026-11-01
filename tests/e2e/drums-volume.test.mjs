// Drum data-loss regression tests: changing the drums' volume, mute, solo or
// on/off must never change the drum pattern, and a song saved by an older build
// keeps its drums. Run against a local `wrangler dev`:
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/drums-volume.test.mjs
// The reported bug: on a phone, dragging the Drums volume in Track Master while
// the song played erased the song's drums, and the erased song was uploaded.
// Songs saved by older builds can hold their drums in the Track Master region
// while the song's Beat Maker copy (project.beatMaker) is blank, missing or a
// different beat; every volume change rewrote the region from that copy.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const INVITE = process.env.INVITE_CODE || 'test-invite';
const DESKTOP = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
let failures = 0, passes = 0;

// ---- Fixtures ----
function toneWavBase64(seconds = 0.3, rate = 22050) {
  const n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * Math.exp(-6 * i / n) * 12000), 44 + i * 2);
  return buf.toString('base64');
}
const SOUNDFONT = (() => {
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'], tone = `data:audio/wav;base64,${toneWavBase64()}`;
  let body = 'if (typeof(MIDI) === "undefined") var MIDI = {};\nMIDI.Soundfont = MIDI.Soundfont || {};\nMIDI.Soundfont.test = {\n';
  for (let midi = 21; midi <= 108; midi++) body += `"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "${tone}",\n`;
  return body + '}\n';
})();
// Records every drum sample started on a live AudioContext (by file name).
const INSTRUMENT = `(() => {
  const urlOf = new WeakMap(), arrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function () { const r = await arrayBuffer.call(this); try { urlOf.set(r, this.url); } catch {} return r; };
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (data, ...rest) {
    const url = urlOf.get(data) || '';
    return decode.call(this, data, ...rest).then(b => { try { b.__url = url; } catch {} return b; });
  };
  window.__hits = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...a) {
    if (this.context instanceof AudioContext) {
      const m = /assets\\/drums\\/([\\w-]+)\\.wav/.exec(this.buffer?.__url || '');
      if (m) window.__hits.push({ id: m[1], when });
    }
    return start.call(this, when, ...a);
  };
})();`;
// The song's drums: kick on every beat and two snares (6 hits).
const KICKS = { kick1: [0, 16, 32, 48], snare1: [16, 48] };

// ---- Harness ----
let browser;
async function test(name, fn) {
  try { await fn(); passes++; console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); }
}
// A fresh device (empty storage, like a new web address) signed in to `email`.
async function withDevice(device, email, fn, { path = '/index.html' } = {}) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await context.route('https://gleitz.github.io/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SOUNDFONT }));
  await context.addInitScript({ content: INSTRUMENT });
  const page = await context.newPage(), errors = [];
  page.touch = !!device.hasTouch;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    await ready(page);
    if (email) {
      const status = await page.evaluate(async ([email, inviteCode]) => {
        let r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', inviteCode }) });
        if (r.status === 409 || r.status === 400) r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
        return r.status;
      }, [email, INVITE]);
      assert.ok(status < 300, `sign in status ${status}`);
      await page.reload({ waitUntil: 'load' }); await ready(page);
      await page.waitForFunction(() => /Synced/.test(document.getElementById('accountSummaryBtn')?.textContent || ''), null, { timeout: 15000 });
    }
    await page.waitForTimeout(500);
    await fn(page, context);
    assert.deepEqual(errors, [], 'page errors');
  } finally { await context.close(); }
}
const ready = page => page.waitForFunction(() => window.CRPCore && window.CRPParts && window.CRPBeatMaker);
const uniq = () => Math.random().toString(36).slice(2, 8);
const press = (page, locator) => page.touch ? locator.tap() : locator.click();
const tap = (page, selector) => press(page, page.locator(selector).first());
function hitCount(pattern) { let n = 0; for (const bars of Object.values(pattern?.tracks || {})) for (const a of bars || []) n += (a || []).length; return n; }
const regionHits = song => (song?.parts?.drumEvents || []).map(e => hitCount(e.pattern));

// Upload a song the way an older build left it in the cloud: its drums in one
// Track Master region [0,16), and its Beat Maker copy `beatMaker` as given
// ('blank', 'missing' or 'drums'). regions: 'drums', 'empty' ([]) or 'blank'
// (one region with no hits).
async function uploadOldSong(page, { name, beatMaker = 'blank', regions = 'drums' }) {
  return page.evaluate(async ({ name, beatMaker, regions, KICKS }) => {
    const snap = window.CRPCore.snapshot(); snap.rows = [['C', 'F', 'G', 'C'].map(value => ({ type: 'chord', value, durationBeats: 4 }))];
    const blank = window.CRPBeatMaker.getBeat(); blank.bars = 1; for (const id of Object.keys(blank.tracks)) blank.tracks[id] = blank.tracks[id].map(() => []);
    const drums = JSON.parse(JSON.stringify(blank)); for (const [id, steps] of Object.entries(KICKS)) drums.tracks[id][0] = steps;
    const project = { id: crypto.randomUUID(), name, updatedAt: Date.now(), instrument: 'piano', mode: 'chord', rows: snap.rows, bpm: 120, beats: 4, loop: true, notes: '', key: 'C',
      parts: { version: 6, activePartId: 'chord-1', loadedChordPartId: 'chord-1', songStartBeat: 0, songEndBeat: null, updatedAt: Date.now(),
        drumEvents: regions === 'empty' ? [] : [{ id: 'drums-1', startBeat: 0, durationBeats: 16, patternOffsetBeats: 0, pattern: regions === 'blank' ? blank : drums }],
        items: [{ id: 'chord-1', type: 'chord', name: 'Chords 1', enabled: true, volume: .85, data: snap }] } };
    if (beatMaker === 'blank') project.beatMaker = blank;
    if (beatMaker === 'drums') project.beatMaker = drums;
    // Older builds upload without a base revision.
    const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
    if (!r.ok) throw new Error(`upload ${r.status}`);
    return project.id;
  }, { name, beatMaker, regions, KICKS });
}
async function pullAndOpen(page, name) {
  await page.evaluate(() => document.getElementById('syncNowBtn').click()); // ↻ Sync Now
  const item = page.locator('#projectList .project-item', { hasText: name }).first();
  await item.waitFor({ timeout: 10000 });
  await press(page, item.locator('.open'));
  await page.waitForFunction(n => document.getElementById('projectName')?.value === n, name);
  await page.waitForTimeout(300);
}
async function openTrackMaster(page) {
  await tap(page, '[data-workspace-mode="baby-daw"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.CRPParts.openTrackMaster());
  await page.waitForSelector('.vox-drum-region-row .vox-track-volume-input');
  await page.waitForTimeout(200);
}
async function play(page) {
  await tap(page, '#voxPlayTransportBtn');
  await page.waitForFunction(() => window.CRPParts.getPlaybackTiming().ready);
}
// Drag the Drums volume slider in Track Master with a finger or the mouse.
async function dragDrumVolume(page, context, toFraction) {
  const slider = page.locator('.vox-drum-region-row .vox-track-volume-input').first();
  const b = await slider.boundingBox(), y = b.y + b.height / 2, x0 = b.x + b.width * 0.5, x1 = b.x + b.width * toFraction;
  if (page.touch) {
    const cdp = await context.newCDPSession(page);
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', x0);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', x0 + (x1 - x0) * i / 8); await page.waitForTimeout(30); }
    await touch('touchEnd');
  } else {
    await page.mouse.move(x0, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 8, y); await page.waitForTimeout(30); }
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
  return Number(await slider.inputValue());
}
const live = page => page.evaluate(() => ({ beat: window.CRPBeatMaker.getBeat(), regions: window.CRPParts.capture().drumEvents }));
const stored = (page, id) => page.evaluate(id => JSON.parse(localStorage.getItem('crp-projects') || '[]').find(p => p.id === id), id);
const onServer = (page, id) => page.evaluate(async id => ((await (await fetch('/api/projects')).json()).projects || []).find(p => p.id === id), id);
// Waits for the autosave and its upload.
async function settle(page, id) {
  await page.waitForFunction(id => !document.querySelector('.project-item.current .meta')?.textContent.includes('not uploaded'), id, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1600);
}
async function assertDrumsKept(page, id, label) {
  const l = await live(page);
  assert.deepEqual(l.regions.map(e => hitCount(e.pattern)), [6], `${label}: the Track Master drum region still has its 6 hits (live)`);
  assert.deepEqual(l.regions[0].pattern.tracks.kick1[0], KICKS.kick1, `${label}: the kicks are the song's kicks`);
  assert.equal(hitCount(l.beat), 6, `${label}: Beat Maker holds the song's drums`);
  const local = await stored(page, id);
  assert.deepEqual(regionHits(local), [6], `${label}: the saved song still has its drums`);
  const server = await onServer(page, id);
  assert.deepEqual(regionHits(server), [6], `${label}: the cloud copy still has its drums`);
}

// ---- Tests ----
// The reported bug, as the owner did it: an older song pulled from the cloud on
// a new device, Baby DAW -> Track Master -> Play -> drag the Drums volume.
async function volumeDragDuringPlaybackKeepsOldSongDrums(device, beatMaker) {
  const email = `drums-${uniq()}@example.com`;
  await withDevice(device, email, async (page, context) => {
    const name = `Old Song ${uniq()}`, id = await uploadOldSong(page, { name, beatMaker });
    await pullAndOpen(page, name);
    await openTrackMaster(page);
    await play(page);
    await page.waitForTimeout(800);
    const pct = await dragDrumVolume(page, context, 0.9);
    assert.ok(pct >= 80, `the slider moved (${pct}%)`);
    await page.waitForTimeout(1500);
    // The drums keep playing at the new volume.
    const since = await page.evaluate(() => window.CRPAudio.context().currentTime);
    await page.waitForTimeout(1500);
    assert.ok((await page.evaluate(t => window.__hits.filter(h => h.id === 'kick-1' && h.when > t).length, since)) >= 2, 'the kicks keep playing after the volume change');
    const l = await live(page);
    assert.ok(l.regions.every(e => Math.abs(e.pattern.gain - pct / 100) < 1e-9), 'the region plays at the new volume');
    assert.ok(Math.abs(l.beat.gain - pct / 100) < 1e-9, 'the Drums track volume is the new volume');
    await tap(page, '#voxStopTransportBtn');
    await settle(page, id);
    await assertDrumsKept(page, id, 'after the volume drag');
    assert.ok(Math.abs((await onServer(page, id)).beatMaker.gain - pct / 100) < 1e-9, 'the new volume is saved to the cloud');
  });
}

// Mute, Solo and Drums on/off in Track Master, and Chord Rider's drum volume and
// Drums box, change only the mix (and keep it through other edits).
async function mixControlsKeepOldSongDrums(device) {
  const email = `mix-${uniq()}@example.com`;
  await withDevice(device, email, async page => {
    const name = `Mix Song ${uniq()}`, id = await uploadOldSong(page, { name, beatMaker: 'blank' });
    await pullAndOpen(page, name);
    // Chord Rider: drum volume and Drums on/off.
    await page.evaluate(() => { const v = document.getElementById('crpDrumVolume'); v.value = '30'; v.dispatchEvent(new Event('input', { bubbles: true })); v.dispatchEvent(new Event('change', { bubbles: true })); });
    await tap(page, '#crpDrumsToggle'); await tap(page, '#crpDrumsToggle');
    await page.waitForTimeout(300);
    assert.deepEqual((await live(page)).regions.map(e => hitCount(e.pattern)), [6], 'Chord Rider drum volume and Drums box keep the drums');
    await openTrackMaster(page);
    await play(page);
    await tap(page, '.vox-drum-region-row .vox-track-ms button:nth-child(2)'); // Solo
    await tap(page, '.vox-drum-region-row .vox-track-ms button:nth-child(1)'); // Mute
    await tap(page, '.vox-drum-region-row .vox-track-label input[type=checkbox]'); // Drums off
    await tap(page, '.vox-drum-region-row .vox-track-label input[type=checkbox]'); // Drums on
    await page.waitForTimeout(300);
    let l = await live(page);
    assert.deepEqual(l.regions.map(e => hitCount(e.pattern)), [6], 'Mute, Solo and Drums on/off keep the drums');
    assert.equal(l.beat.muted, true, 'the drums are muted');
    assert.equal(l.beat.enabled, true, 'the drums are on');
    assert.ok(Math.abs(l.beat.gain - 0.3) < 1e-9, 'the drum volume is 30%');
    // An unrelated Track Master edit (switch the chord track off and on) keeps the mix.
    await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-label input[type=checkbox]');
    await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-label input[type=checkbox]');
    await page.waitForTimeout(300);
    l = await live(page);
    assert.equal(l.beat.muted, true, 'the drums stay muted after another Track Master edit');
    assert.ok(Math.abs(l.beat.gain - 0.3) < 1e-9, 'the drum volume stays 30% after another Track Master edit');
    await tap(page, '#voxStopTransportBtn');
    await settle(page, id);
    await assertDrumsKept(page, id, 'after the mix changes');
    assert.equal((await onServer(page, id)).beatMaker.muted, true, 'the mute is saved');
  });
}

// An older song whose drums are only in its Beat Maker beat (no Track Master
// region, or only an empty one) lost them on the next Track Master edit.
async function beatOnlySongKeepsDrums(device, regions = 'empty') {
  const email = `beat-${uniq()}@example.com`;
  await withDevice(device, email, async page => {
    const name = `Beat Song ${uniq()}`, id = await uploadOldSong(page, { name, beatMaker: 'drums', regions });
    await pullAndOpen(page, name);
    await openTrackMaster(page);
    await page.waitForSelector('.vox-drum-event');
    await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-label input[type=checkbox]');
    await tap(page, '.vox-instrument-track[data-vox-kind="chord"] .vox-track-label input[type=checkbox]');
    await page.waitForTimeout(400);
    await play(page);
    await page.waitForTimeout(1500);
    assert.ok((await page.evaluate(() => window.__hits.filter(h => h.id === 'kick-1').length)) >= 2, 'the drums play');
    await tap(page, '#voxStopTransportBtn');
    await settle(page, id);
    await assertDrumsKept(page, id, 'a song with drums only in its Beat Maker beat');
  });
}

// Chord Rider's Beat Maker opened on such a song edits the song's drums (the
// Track Master region), not a blank copy.
async function beatMakerEditsTheSongsDrums(device) {
  const email = `edit-${uniq()}@example.com`;
  await withDevice(device, email, async page => {
    const name = `Edit Song ${uniq()}`, id = await uploadOldSong(page, { name, beatMaker: 'missing' });
    await pullAndOpen(page, name);
    await tap(page, '[data-workspace-mode="chord-rider"]');
    await tap(page, '#crpBeatBtn');
    await page.waitForSelector('#crpBeatModal.open');
    assert.equal(await page.locator('#crpBeatGrid .crp-step.active').count(), 6, 'Beat Maker shows the song\'s 6 hits');
    await tap(page, '#crpBeatGrid .crp-step[data-drum="chh"][data-canonical="8"]');
    await tap(page, '#crpBeatSave');
    await page.waitForTimeout(300);
    const l = await live(page);
    assert.deepEqual(l.regions.map(e => hitCount(e.pattern)), [7], 'the region has the song\'s drums plus the new hat');
    assert.deepEqual(l.regions[0].pattern.tracks.kick1[0], KICKS.kick1, 'the kicks are kept');
  });
}

// Chord Rider Undo of a chord edit kept a copy of the beat from before the
// drums were made in Track Master, and put that blank beat over the drums.
async function chordUndoKeepsTrackMasterDrums(device) {
  await withDevice(device, null, async page => {
    await page.fill('#chordInput', 'C F G C'); await tap(page, '#buildBtn');
    await page.fill('#projectName', `Undo Song ${uniq()}`); await tap(page, '#saveProjectBtn');
    await page.waitForTimeout(600);
    await page.fill('#chordInput', 'C F G Am'); await tap(page, '#buildBtn'); // the edit to undo
    await openTrackMaster(page);
    // A drum region made in Track Master (double-tap the lane, then edit it).
    await page.evaluate(({ KICKS }) => {
      const b = window.CRPBeatMaker.getBeat(); for (const id of Object.keys(b.tracks)) b.tracks[id] = b.tracks[id].map(() => []);
      for (const [id, steps] of Object.entries(KICKS)) b.tracks[id][0] = steps;
      window.CRPBeatMaker.setBeat(b, { persist: true });
    }, { KICKS });
    await page.waitForTimeout(300);
    assert.deepEqual((await live(page)).regions.map(e => hitCount(e.pattern)), [6]);
    await tap(page, '#voxBoxCloseBtn');
    await tap(page, '[data-workspace-mode="chord-rider"]');
    await tap(page, '#undoBtn');
    await page.waitForTimeout(1500);
    const chords = await page.$$eval('#progression .progression-line:not(.carousel-clone) .chord-name', els => els.map(e => e.textContent));
    assert.deepEqual(chords, ['C', 'F', 'G', 'C'], 'Undo undid the chord edit');
    const l = await live(page);
    assert.deepEqual(l.regions.map(e => hitCount(e.pattern)), [6], 'Undo of a chord edit keeps the drums');
    assert.equal(hitCount(l.beat), 6);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('crp-projects'))[0]);
    assert.deepEqual(regionHits(saved), [6], 'the saved song keeps its drums');
    // Undo of a Beat Maker change still restores the beat from before it.
    await tap(page, '#crpBeatBtn'); await page.waitForSelector('#crpBeatModal.open');
    await tap(page, '#crpRandomizeBeat');
    await page.waitForTimeout(200);
    await tap(page, '#crpBeatUndo');
    await page.waitForTimeout(400);
    assert.deepEqual((await live(page)).regions[0].pattern.tracks.kick1[0], KICKS.kick1, 'Undo of Randomize Beat brings the drums back');
    await tap(page, '#crpBeatSave');
  }, { path: '/index.html?workspace=chord-rider' });
}

browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`Drum volume / data-loss e2e tests against ${BASE}`);
try {
  await test('phone: dragging the Drums volume during playback keeps an older song\'s drums (blank Beat Maker copy)', () => volumeDragDuringPlaybackKeepsOldSongDrums(PHONE, 'blank'));
  await test('phone: dragging the Drums volume during playback keeps an older song\'s drums (no Beat Maker copy)', () => volumeDragDuringPlaybackKeepsOldSongDrums(PHONE, 'missing'));
  await test('desktop: dragging the Drums volume during playback keeps an older song\'s drums (blank Beat Maker copy)', () => volumeDragDuringPlaybackKeepsOldSongDrums(DESKTOP, 'blank'));
  await test('desktop: dragging the Drums volume keeps a song\'s drums when its Beat Maker copy matches', () => volumeDragDuringPlaybackKeepsOldSongDrums(DESKTOP, 'drums'));
  await test('phone: Mute, Solo, Drums on/off and Chord Rider\'s drum volume keep the drums, and the mix survives other edits', () => mixControlsKeepOldSongDrums(PHONE));
  await test('desktop: Mute, Solo, Drums on/off and Chord Rider\'s drum volume keep the drums, and the mix survives other edits', () => mixControlsKeepOldSongDrums(DESKTOP));
  await test('phone: an older song with drums only in its Beat Maker beat keeps them through Track Master edits', () => beatOnlySongKeepsDrums(PHONE));
  await test('desktop: an older song with an empty drum region and drums in its Beat Maker beat keeps them', () => beatOnlySongKeepsDrums(DESKTOP, 'blank'));
  await test('desktop: Chord Rider\'s Beat Maker edits the song\'s drums, not a blank copy', () => beatMakerEditsTheSongsDrums(DESKTOP));
  await test('desktop: Chord Rider Undo of a chord edit keeps drums made in Track Master', () => chordUndoKeepsTrackMasterDrums(DESKTOP));
  await test('phone: Chord Rider Undo of a chord edit keeps drums made in Track Master', () => chordUndoKeepsTrackMasterDrums(PHONE));
} finally { await browser.close(); }
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
