// Chord Rider Pro browser tests (Playwright + Chromium). Run against a local `wrangler dev`:
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/crp.test.mjs
// Each test uses fresh browser contexts (separate storage and cookies = separate devices).
// Uncaught page errors fail the test that produced them.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // resolved through NODE_PATH / global installs

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const INVITE = process.env.INVITE_CODE || 'test-invite';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uniq = () => Math.random().toString(36).slice(2, 8);
let browser, passes = 0, failures = 0;

async function device(opts = DESKTOP) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  return { ctx, page };
}
async function test(name, fn) {
  const opened = [];
  const open = async opts => { const d = await device(opts); opened.push(d); return d.page; };
  try {
    await fn(open);
    const errors = opened.flatMap(d => d.page.errors);
    assert.deepEqual(errors, [], 'page errors');
    passes++; console.log(`  ok  ${name}`);
  } catch (e) {
    failures++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  } finally {
    for (const d of opened) await d.ctx.close().catch(() => {});
  }
}

const cards = page => page.$$eval('#progression .progression-line:not(.carousel-clone) .chord-name', els => els.map(e => e.textContent));
const chips = page => page.$$eval('#compatibleChords .chip', els => els.map(e => e.textContent));
async function build(page, chords) { await page.fill('#chordInput', chords); await page.click('#buildBtn'); }
async function addLine(page, chords) { await page.click('#addLineBtn'); await build(page, chords); }
async function save(page, name) {
  await page.fill('#projectName', name); await page.click('#saveProjectBtn'); await sleep(1200);
  return page.evaluate(() => localStorage.getItem('crp-active-project-id'));
}
async function register(page) {
  const email = `e2e-${uniq()}@example.com`;
  const status = await page.evaluate(async ([email, inviteCode]) => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', inviteCode }) })).status, [email, INVITE]);
  assert.ok(status === 200 || status === 201, `register status ${status}`);
  await page.reload({ waitUntil: 'networkidle' }); await sleep(800);
  return email;
}
async function signIn(page, email) {
  await page.evaluate(async email => { await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) }); }, email);
  await page.reload({ waitUntil: 'networkidle' }); await sleep(800);
}
const serverProjects = page => page.evaluate(() => fetch('/api/projects').then(r => r.json()));
const localProjects = page => page.evaluate(() => JSON.parse(localStorage.getItem('crp-projects') || '[]'));
const chordText = p => (p?.rows || []).flat().map(c => c.value).join(' ');

async function main() {
  browser = await chromium.launch();

  await test('unsaved song survives a reload (draft slot)', async open => {
    const page = await open(PHONE);
    await build(page, 'Em C G D'); await sleep(900);
    await page.reload({ waitUntil: 'networkidle' }); await sleep(300);
    assert.deepEqual(await cards(page), ['Em', 'C', 'G', 'D']);
    assert.match(await page.$eval('#syncNotice', e => e.textContent), /Restored the unsaved song/);
  });

  await test('flat input gives a flat key and flat suggestions', async open => {
    const page = await open();
    await build(page, 'Bb Eb F Bb');
    assert.equal(await page.inputValue('#keyInput'), 'Bb');
    assert.deepEqual(await cards(page), ['Bb', 'Eb', 'F', 'Bb'], 'typed chords keep their spelling');
    const bb = await chips(page);
    assert.ok(bb.includes('Bb') && bb.includes('Eb') && !bb.some(c => c.includes('#')), `Bb major chips: ${bb.join(' ')}`);
    await page.fill('#keyInput', 'F'); await page.dispatchEvent('#keyInput', 'input');
    const f = await chips(page);
    assert.ok(f.includes('Bb') && !f.includes('A#'), `F major chips: ${f.join(' ')}`);
  });

  await test('chords typed in capitals (phone keyboard, Caps Lock) are read as meant', async open => {
    const page = await open();
    // The chord and key boxes no longer ask phone keyboards for all capitals.
    assert.equal(await page.getAttribute('#chordInput', 'autocapitalize'), 'off');
    assert.equal(await page.getAttribute('#keyInput', 'autocapitalize'), 'off');
    await build(page, 'EM AM7 BB CMAJ7 F#M7B5 D/F#');
    assert.deepEqual(await cards(page), ['Em', 'Am7', 'Bb', 'Cmaj7', 'F#m7b5', 'D/F#']);
    // A line with any lowercase keeps the usual reading: CM7 is C major 7.
    await addLine(page, 'Am CM7 F');
    assert.deepEqual((await cards(page)).slice(-3), ['Am', 'Cmaj7', 'F']);
    // The Key box too: BBM is B flat minor.
    await page.fill('#keyInput', 'BBM'); await page.dispatchEvent('#keyInput', 'input'); await page.dispatchEvent('#keyInput', 'change'); await sleep(300);
    assert.match(await page.textContent('#keyHint'), /Bb minor/);
  });

  await test('slash chords are accepted, shown and voiced with the bass note', async open => {
    const page = await open();
    await build(page, 'G G/B C D/F#');
    assert.equal(await page.textContent('#status'), '');
    assert.deepEqual(await cards(page), ['G', 'G/B', 'C', 'D/F#']);
    const notes = await page.evaluate(() => window.CRPCore.notesFor({ type: 'chord', value: 'G/B' }, window.CRPCore.snapshot()));
    assert.equal(notes[0], 'B3', `G/B voicing ${notes.join(' ')}`);
  });

  await test('Scale Rider plays major progressions in the relative major of a minor key', async open => {
    const page = await open();
    await page.fill('#keyInput', 'Am'); await page.dispatchEvent('#keyInput', 'input');
    await page.click('#scaleRiderBtn'); await page.click('[data-g="Pop"]'); await page.click('[data-s="Contemporary"]');
    const first = await page.$eval('.sr-prog .sr-prog-chords', e => e.textContent);
    assert.equal(first, 'C • G • Am • F');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.sr-layer'), null, 'Escape closes Scale Rider');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'scaleRiderBtn', 'focus returns to the trigger');
  });

  await test('undo and redo cover builds and deletes', async open => {
    const page = await open();
    await build(page, 'C F G');
    await build(page, 'C F G Am');
    await page.click('#progression .progression-line:not(.carousel-clone) .chord-card .remove');
    assert.deepEqual(await cards(page), ['F', 'G', 'Am']);
    await page.click('#undoBtn');
    assert.deepEqual(await cards(page), ['C', 'F', 'G', 'Am']);
    await page.click('#undoBtn');
    assert.deepEqual(await cards(page), ['C', 'F', 'G']);
    await page.click('#redoBtn');
    assert.deepEqual(await cards(page), ['C', 'F', 'G', 'Am']);
  });

  await test('stale device edit becomes a conflict copy instead of overwriting', async open => {
    const pc = await open(), phone = await open();
    const email = await register(pc);
    await build(pc, 'C F G C'); const id = await save(pc, `Clash ${uniq()}`);
    await signIn(phone, email);
    await phone.evaluate(id => window.CRPCore.loadProjectById(id), id); await sleep(300);
    await phone.context().setOffline(true);
    await addLine(phone, 'Bb Eb F Bb'); await sleep(1200);          // edit on the phone while offline
    await addLine(pc, 'Am Dm E7 Am'); await sleep(1500);             // edit on the PC (saved to cloud)
    await phone.context().setOffline(false);
    await phone.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(3000);
    const { projects } = await serverProjects(pc);
    const original = projects.find(p => p.id === id), copy = projects.find(p => / \(conflict copy /.test(p.name));
    assert.match(chordText(original), /Am Dm E7 Am/, 'the PC edit is kept on the original song');
    assert.ok(copy, 'a conflict copy was uploaded');
    assert.match(chordText(copy), /Bb Eb F Bb/, 'the phone edit is kept in the conflict copy');
    assert.match(await phone.$eval('#syncNotice', e => e.textContent), /Both versions are kept/);
  });

  await test('a song deleted on one device stays deleted on the other', async open => {
    const a = await open(), b = await open();
    const email = await register(a);
    await build(a, 'D G A D'); const id = await save(a, `Doomed ${uniq()}`);
    await signIn(b, email);
    assert.ok((await localProjects(b)).some(p => p.id === id), 'device B has the song');
    await a.click('#projectList .project-item.current .delete'); await sleep(1500);
    await b.reload({ waitUntil: 'networkidle' }); await sleep(1500);
    await b.reload({ waitUntil: 'networkidle' }); await sleep(1500);
    assert.ok(!(await localProjects(b)).some(p => p.id === id), 'device B dropped the song');
    assert.ok(!(await serverProjects(a)).projects.some(p => p.id === id), 'device B did not re-upload it');
  });

  await test('line Duplicate/Delete buttons have separated 44px targets', async open => {
    const page = await open(PHONE);
    await build(page, 'C G');
    const r = await page.evaluate(() => {
      const line = document.querySelector('#progression .progression-line:not(.carousel-clone)');
      const box = s => { const b = line.querySelector(s).getBoundingClientRect(), a = getComputedStyle(line.querySelector(s), '::after'); return { cx: b.left + b.width / 2, w: parseFloat(a.width), h: parseFloat(a.height) }; };
      return { dup: box('.duplicate-line'), del: box('.delete-line') };
    });
    assert.ok(r.dup.w >= 44 && r.dup.h >= 44 && r.del.w >= 44 && r.del.h >= 44, JSON.stringify(r));
    assert.ok((r.del.cx - r.del.w / 2) - (r.dup.cx + r.dup.w / 2) >= 8, 'hit areas do not touch');
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
