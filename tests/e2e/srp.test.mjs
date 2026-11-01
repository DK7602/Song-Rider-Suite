// Song Rider Pro end-to-end checks in a real browser against a local `wrangler dev`:
//   wrangler d1 execute song-rider-suite-test-db --local --config tests/wrangler.test.jsonc --file migrations/0001_init.sql
//   wrangler dev --config tests/wrangler.test.jsonc --port 8787 &
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/srp.test.mjs      (ONLY=<part of a test name> runs a subset)
// Uses the test invite code (INVITE_CODE, default "test-invite"). Prints ok/FAIL per check and exits
// non-zero if any check fails. Workers AI is not available locally, so dictation is stubbed in-page.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = await (async () => {
  try { return require('playwright'); } catch { return import('playwright'); }
})();

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const INVITE = process.env.INVITE_CODE || 'test-invite';
const SRP = `${BASE}/song-rider/index.html?crpMode=1`;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => Math.random().toString(36).slice(2, 10);
let passes = 0, failures = 0;

async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // e.g. ONLY=dictation
  try { await fn(); passes++; console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e && e.message || e).split('\n').join('\n       ')}`); }
}

async function newUser() {
  const email = `srp-${uniq()}@example.com`, password = 'correct-horse';
  const r = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, inviteCode: INVITE }) });
  assert.equal(r.status, 201, 'register failed');
  return { email, password };
}

// A "device": its own browser context (own storage), optionally signed in.
async function device(browser, user, opts = {}) {
  const ctx = await browser.newContext({ ...(opts.phone ? PHONE : DESKTOP), serviceWorkers: 'block', ...(opts.ctx || {}) });
  if (user) {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: user });
    assert.equal(r.status(), 200, 'login failed');
    // The session cookie is Secure; the browser sends it to 127.0.0.1, Playwright's request client does not.
  }
  if (opts.init) await ctx.addInitScript(opts.init, opts.initArg);
  const page = await ctx.newPage();
  page.errors = [];
  page.dialogs = [];
  page.on('pageerror', (e) => page.errors.push(String(e && e.stack || e)));
  page.on('console', (m) => {
    const t = m.text();
    // Expected locally: 401 before sign-in, 409 conflicts, 502 from stubbed dictation, and the
    // shared suite-compact.css which is created on the CRP side.
    if (m.type() === 'error' && !/status of (401|404|409|502)|suite-compact\.css/.test(t)) page.errors.push(t);
  });
  page.on('dialog', (d) => { page.dialogs.push(d.message()); return (page.onDialog ? page.onDialog(d) : d.accept()); });
  return { ctx, page };
}

async function open(page, url = SRP) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SRP_INIT_DONE === true, null, { timeout: 20000 });
  await sleep(300);
}
const noErrors = (...pages) => { for (const p of pages) assert.deepEqual(p.errors, [], 'page errors'); };

async function typeFull(page, text, i = 0) {
  await page.locator('textarea.fullSectionText').nth(i).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text, { delay: 10 });
}
const fullText = (page, i = 0) => page.evaluate((i) => document.querySelectorAll('textarea.fullSectionText')[i]?.value ?? null, i);
const names = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#projectSelect option')).map((o) => o.textContent));
const server = (page) => page.evaluate(async () => (await (await fetch('/api/srp/projects', { cache: 'no-store' })).json()).projects || []);
const stored = (page) => page.evaluate(() => {
  const k = Object.keys(localStorage).find((k) => k.startsWith('songrider_v25_projects::'));
  return k ? JSON.parse(localStorage.getItem(k)) : [];
});
const page1Cards = async (page) => (await stored(page))[0].sections['PAGE 1'].map((l) => [l.lyrics, l.notes.filter(Boolean).join(' ')]);
const selectSong = (page, name) => page.evaluate((n) => {
  const s = document.getElementById('projectSelect');
  s.value = Array.from(s.options).find((o) => o.textContent === n).value;
  s.dispatchEvent(new Event('change'));
}, name);
const blur = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
// Calls the API from a signed-in page (the session cookie is Secure: only the browser sends it here).
const api = (page, path, body) => page.evaluate(async ({ path, body }) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, data: await r.json().catch(() => null) };
}, { path, body });
const crpRows = (...lines) => lines.map((l) => l.split(' ').map((value) => ({ type: 'chord', value })));
// What a user does on a phone: open Chord Rider (signed in, it pulls the account's projects),
// then go to Song Rider through the suite navigation.
async function chordRiderThenSongRider(page) {
  await page.goto(`${BASE}/index.html?workspace=chord-rider`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.CRPCore, null, { timeout: 20000 });
  await sleep(2500);
  await page.tap('#songRiderModeBtn');
  await page.waitForURL(/song-rider/);
  await page.waitForFunction(() => window.__SRP_INIT_DONE === true, null, { timeout: 20000 });
  await sleep(1500);
}
const linkNotice = (page) => page.evaluate(() => { const b = document.getElementById('srpLinkNotice'); return b && !b.hidden ? b.innerText : ''; });
const chooserRows = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#srpLinkChooser .srpLinkChoice')).map((r) => r.innerText.replace(/\s+/g, ' ').trim()));

console.log(`SRP e2e tests against ${BASE}`);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

await test('loads on phone and desktop without errors; pdf.js / lame are not loaded up front', async () => {
  for (const phone of [true, false]) {
    const { ctx, page } = await device(browser, null, { phone });
    const libs = [];
    page.on('request', (r) => { if (/pdf\.mjs|pdf\.worker|lame\.min\.js/.test(r.url())) libs.push(r.url()); });
    await open(page);
    await typeFull(page, 'hello');
    await sleep(500);
    assert.deepEqual(libs, []);
    noErrors(page);
    await ctx.close();
  }
});

await test('opening /song-rider/index.html directly uses the suite layout (crpMode=1)', async () => {
  const { ctx, page } = await device(browser, null, { phone: true });
  await open(page, `${BASE}/song-rider/index.html`);
  assert.match(page.url(), /crpMode=1/);
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('crp-integrated')));
  const wordmarkHeight = await page.evaluate(() => Math.round(document.querySelector('.panelTop')?.getBoundingClientRect().height || 0));
  assert.ok(wordmarkHeight > 0 && wordmarkHeight < 200, `panel header is ${wordmarkHeight}px tall`);
  noErrors(page);
  await ctx.close();
});

await test('stale device: newer cloud work is never overwritten (conflict copy + notice)', async () => {
  const user = await newUser();
  const A = await device(browser, user), B = await device(browser, user);
  await open(A.page);
  await typeFull(A.page, 'line one from A');
  await sleep(3500);
  await open(B.page);
  await typeFull(A.page, '\nA second line');
  await sleep(3500);
  // B never pulled since A's edit; its user types straight away
  await typeFull(B.page, '\nB line');
  await sleep(4500);
  const rows = (await server(A.page)).filter((r) => !r.deleted);
  const texts = rows.map((r) => r.data.fullText).join('\n');
  assert.ok(texts.includes('A second line'), "A's edit was overwritten");
  assert.ok(texts.includes('B line'), "B's edit was lost");
  assert.ok(rows.some((r) => /\(conflict copy /.test(r.name)), 'no conflict copy');
  assert.match(await B.page.evaluate(() => document.getElementById('srpNotice')?.innerText || ''), /changed on another device/);
  noErrors(A.page, B.page);
  await A.ctx.close(); await B.ctx.close();
});

await test('a device pulls newer cloud work when it becomes visible / focused', async () => {
  const user = await newUser();
  const A = await device(browser, user), B = await device(browser, user);
  await open(A.page);
  await typeFull(A.page, 'one');
  await sleep(3500);
  await open(B.page);
  await typeFull(A.page, ' two');
  await sleep(3500);
  await B.page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await sleep(2500);
  assert.match(await fullText(B.page), /one two/);
  await typeFull(B.page, ' three');
  await sleep(4500);
  const row = (await server(A.page)).find((r) => !r.deleted);
  assert.match(row.data.fullText, /one two three/);
  assert.equal((await server(A.page)).filter((r) => !r.deleted).length, 1, 'unexpected extra songs');
  noErrors(A.page, B.page);
  await A.ctx.close(); await B.ctx.close();
});

await test('a song deleted offline stays deleted after reconnecting', async () => {
  const user = await newUser();
  const A = await device(browser, user);
  A.page.onDialog = (d) => (d.type() === 'prompt' ? d.accept('Doomed') : d.accept());
  await open(A.page);
  await typeFull(A.page, 'keep me');
  await A.page.click('#newProjectBtn'); await sleep(300);
  await typeFull(A.page, 'delete me');
  await sleep(3500);
  await A.ctx.setOffline(true);
  await A.page.click('#deleteProjectBtn'); await sleep(800);
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(4000);
  await open(A.page);
  await sleep(2500);
  assert.ok(!(await names(A.page)).includes('Doomed'), 'deleted song came back');
  assert.ok((await server(A.page)).some((r) => r.name === 'Doomed' && r.deleted), 'server still has it as a live song');
  await A.ctx.close();
});

await test('deleting a song that was edited on another device restores it instead', async () => {
  const user = await newUser();
  const A = await device(browser, user), B = await device(browser, user);
  A.page.onDialog = (d) => (d.type() === 'prompt' ? d.accept('Second') : d.accept());
  await open(A.page);
  await typeFull(A.page, 'contested');
  await A.page.click('#newProjectBtn'); await sleep(300);
  await typeFull(A.page, 'other');
  await sleep(3500);
  await open(B.page);
  await sleep(1500);
  await selectSong(B.page, 'New Song'); await sleep(300);
  await typeFull(B.page, ' edited-on-B');
  await sleep(4000);
  await selectSong(A.page, 'New Song'); await sleep(300); // A has not pulled B's edit
  await A.page.click('#deleteProjectBtn');
  await sleep(4500);
  const row = (await server(A.page)).find((r) => r.name === 'New Song' && String(r.data.fullText).includes('edited-on-B'));
  assert.ok(row && !row.deleted, 'edited song was deleted');
  assert.match(await A.page.evaluate(() => document.getElementById('srpNotice')?.innerText || ''), /not deleted/);
  await A.ctx.close(); await B.ctx.close();
});

function wav() {
  const rate = 8000, n = rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return buf;
}

await test('card edits typed during a recording upload are kept', async () => {
  const user = await newUser();
  const { ctx, page } = await device(browser, user);
  await open(page);
  await typeFull(page, 'first card');
  await sleep(3500);
  await blur(page);
  await page.keyboard.press('ArrowRight'); await sleep(300);
  await page.route('**/api/srp/media**', async (route) => { if (route.request().method() === 'PUT') await sleep(3000); await route.continue(); });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#uploadAudioBtn');
  await (await chooser).setFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: wav() });
  await sleep(600);
  await page.locator('textarea.lyrics').first().click(); await page.keyboard.press('End');
  await page.keyboard.type(' during', { delay: 20 });
  await sleep(5000);
  await page.locator('textarea.lyrics').first().click(); await page.keyboard.press('End');
  await page.keyboard.type(' after', { delay: 20 });
  await sleep(1500);
  await open(page);
  await page.keyboard.press('ArrowRight'); await sleep(300);
  assert.equal(await page.locator('textarea.lyrics').first().inputValue(), 'first card during after');
  noErrors(page);
  await ctx.close();
});

await test('CRP link merges chords into PAGE 1, keeps every card and lyric, and is undoable', async () => {
  const rows = [[...'C D E F G A B C D E'.split(' ')].map((value) => ({ type: 'chord', value })), [{ type: 'chord', value: 'Am' }]];
  const { ctx, page } = await device(browser, null, {
    init: (rows) => {
      if (localStorage.getItem('crp-projects')) return;
      localStorage.setItem('crp-projects', JSON.stringify([{ id: 'crp-1', name: 'CRP Song', bpm: 100, beats: 4, key: 'G', capo: 0, octave: 0, rows, updatedAt: 1000 }]));
      localStorage.setItem('crp-active-project-id', 'crp-1');
    }, initArg: rows
  });
  // The hidden CRP playback engine (root app.js) is not under test here.
  await page.route('**/index.html?playbackBridge=1', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await open(page);
  await typeFull(page, 'one\n\ntwo\n\nthree\n\nfour');
  await sleep(600);
  await blur(page);
  await page.click('#crpSrpLinkBtn'); await sleep(1000);
  let cards = await page1Cards(page);
  assert.deepEqual(cards, [['one', 'C D E F G A B C'], ['two', 'D E'], ['three', 'Am'], ['four', '']]);
  assert.match(await page.textContent('#crpSrpLinkBtn'), /Unlink SRP/);
  // focus / visibility do not re-import or touch the song
  const before = (await stored(page))[0].updatedAt;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(600);
  assert.equal((await stored(page))[0].updatedAt, before);
  // the Full text follows the cards, so a Full edit keeps the chords
  await typeFull(page, ' more'); await sleep(700);
  cards = await page1Cards(page);
  assert.equal(cards[0][1], 'C D E F G A B C');
  assert.equal(cards[3][0], 'four more');
  // SRP does not bump CRP's own timestamp
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('crp-projects'))[0].updatedAt), 1000);
  // undo the Full edit and the link import
  await blur(page);
  await page.click('#undoBtn'); await sleep(300);
  for (let i = 0; i < 6 && (await page1Cards(page)).some((c) => c[1]); i++) { await page.click('#undoBtn'); await sleep(300); }
  assert.ok((await page1Cards(page)).every((c) => !c[1]), 'link import could not be undone');
  noErrors(page);
  await ctx.close();
});

await test('Link SRP signed in on a phone, coming from an empty Chord Rider: explains, lists the projects, links, follows into CRP, unlinks', async () => {
  const user = await newUser();
  const songId = `song-${uniq()}`;
  const song = {
    id: songId, name: '1) Don 2026 (Dec 15)', createdAt: 1000, updatedAt: 1000, notesUpdatedAt: 1000,
    fullText: '__________\n\nverse one\n\nverse two\n', enabledSections: ['PAGE 1'],
    sections: { 'PAGE 1': [{ id: 'c1', notes: Array(8).fill(''), lyrics: 'verse one', beats: ['', '', '', ''] }, { id: 'c2', notes: Array(8).fill(''), lyrics: 'verse two', beats: ['', '', '', ''] }] }
  };
  const A = await device(browser, user);
  await A.page.goto(`${BASE}/song-rider/manifest.webmanifest`);
  assert.equal((await api(A.page, '/api/srp/projects', { project: { project_id: songId, name: song.name, data: song, updated_at: 1000 }, baseRev: 0 })).status, 200);

  const P = await device(browser, user, { phone: true });
  await P.page.route('**/index.html?playbackBridge=1', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  // 1. No Chord Rider projects at all: the tap explains what to do and offers Chord Rider.
  await chordRiderThenSongRider(P.page);
  assert.deepEqual(await names(P.page), [song.name], 'songs did not come down from the cloud');
  await P.page.tap('#crpSrpLinkBtn'); await sleep(600);
  assert.ok(await P.page.isVisible('#srpLinkChooser'), 'Link SRP did nothing (no CRP projects)');
  assert.match(await P.page.innerText('#srpLinkChooser'), /no Chord Rider \/ Baby DAW projects on this device yet/);
  assert.ok(await P.page.isVisible('#srpLinkChooser button:has-text("Open Chord Rider")'));
  await P.page.tap('#srpLinkChooser button:has-text("Cancel")'); await sleep(300);
  assert.ok(!(await P.page.isVisible('#srpLinkChooser')));
  assert.match(await P.page.textContent('#crpSrpLinkBtn'), /^Link SRP/);

  // 2. Projects in the account, none open in Chord Rider: the tap lists them; picking one links.
  const beatId = `crp-beat-${uniq()}`; // project ids are unique across accounts
  for (const [id, name, rows, t] of [[`crp-old-${uniq()}`, 'Old Beat', crpRows('C F'), 2000], [beatId, 'Beat One', crpRows('G D Em C', 'Am'), 3000]]) {
    assert.equal((await api(A.page, '/api/projects', { project: { id, name, rows, bpm: 100, beats: 4, key: 'G', updatedAt: t }, baseRev: 0 })).status, 200);
  }
  await chordRiderThenSongRider(P.page);
  assert.equal(await P.page.evaluate(() => localStorage.getItem('crp-active-project-id')), null, 'Chord Rider should have nothing open');
  await P.page.tap('#crpSrpLinkBtn'); await sleep(600);
  assert.ok(await P.page.isVisible('#srpLinkChooser'), 'Link SRP did nothing (CRP projects exist, none open)');
  const rows = await chooserRows(P.page);
  assert.deepEqual(rows.map((r) => r.split(' ').slice(0, 2).join(' ')), ['Beat One', 'Old Beat'], JSON.stringify(rows));
  await P.page.locator('#srpLinkChooser .srpLinkChoice', { hasText: 'Beat One' }).tap(); await sleep(800);
  assert.ok(!(await P.page.isVisible('#srpLinkChooser')));
  assert.match(await P.page.textContent('#crpSrpLinkBtn'), /Unlink SRP.*Beat One/);
  assert.match(await linkNotice(P.page), /linked to the Chord Rider \/ Baby DAW project “Beat One”/);
  assert.deepEqual(await page1Cards(P.page), [['verse one', 'G D Em C'], ['verse two', 'Am']]);
  assert.equal(await P.page.evaluate((id) => JSON.parse(localStorage.getItem('crp-srp-links-v1'))[id].srpProjectId, beatId), songId);

  // 3. Chord Rider / Baby DAW now opens the linked project, and the pair stays linked on return.
  await P.page.tap('a.workspace-mode-btn[href*="workspace=chord-rider"]');
  await P.page.waitForURL(/workspace=chord-rider/);
  await P.page.waitForFunction(() => !!window.CRPCore, null, { timeout: 20000 });
  await sleep(1500);
  assert.equal(await P.page.inputValue('#projectName'), 'Beat One', 'Chord Rider did not open the linked project');
  await P.page.tap('#songRiderModeBtn');
  await P.page.waitForURL(/song-rider/);
  await P.page.waitForFunction(() => window.__SRP_INIT_DONE === true, null, { timeout: 20000 });
  await sleep(1500);
  assert.match(await P.page.textContent('#crpSrpLinkBtn'), /Unlink SRP.*Beat One/);

  // 4. Tapping again unlinks, with feedback; the chords stay.
  await P.page.tap('#crpSrpLinkBtn'); await sleep(600);
  assert.match(await P.page.textContent('#crpSrpLinkBtn'), /^Link SRP/);
  assert.match(await linkNotice(P.page), /no longer linked to “Beat One”/);
  assert.deepEqual(await P.page.evaluate(() => localStorage.getItem('crp-srp-links-v1')), '{}');
  assert.deepEqual((await page1Cards(P.page))[0], ['verse one', 'G D Em C']);
  await sleep(3500);
  const row = (await server(P.page)).find((r) => r.project_id === songId);
  assert.match(row.data.fullText, /verse one/);
  noErrors(A.page, P.page);
  await A.ctx.close(); await P.ctx.close();
});

await test('Link SRP asks before moving a link: the CRP project open now belongs to another song', async () => {
  const card = (id, lyrics) => ({ id, notes: Array(8).fill(''), lyrics, beats: ['', '', '', ''] });
  const songs = [
    { id: 'song-a', name: 'Song A', createdAt: 1, updatedAt: 1, fullText: '__________\n\na lyric\n', sections: { 'PAGE 1': [card('a1', 'a lyric')] }, enabledSections: ['PAGE 1'], linkedCrpProjectId: 'crp-x' },
    { id: 'song-b', name: 'Song B', createdAt: 2, updatedAt: 2, fullText: '__________\n\nb lyric\n', sections: { 'PAGE 1': [card('b1', 'b lyric')] }, enabledSections: ['PAGE 1'] }
  ];
  const { ctx, page } = await device(browser, null, {
    init: ({ songs, rows }) => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.setItem('songrider_v25_projects::guest', JSON.stringify(songs));
      localStorage.setItem('songrider_v25_currentProjectId::guest', 'song-b');
      localStorage.setItem('crp-projects', JSON.stringify([{ id: 'crp-x', name: 'Beat X', bpm: 90, beats: 4, key: 'C', rows, updatedAt: 5 }]));
      localStorage.setItem('crp-active-project-id', 'crp-x');
      localStorage.setItem('crp-srp-links-v1', JSON.stringify({ 'crp-x': { srpProjectId: 'song-a', srpName: 'Song A', linkedAt: 1 } }));
    }, initArg: { songs, rows: crpRows('C G') }
  });
  await page.route('**/index.html?playbackBridge=1', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await open(page);
  assert.match(await page.textContent('#crpSrpLinkBtn'), /^Link SRP/);
  await page.click('#crpSrpLinkBtn'); await sleep(500);
  assert.ok(await page.isVisible('#srpLinkChooser'), 'the link was moved without asking');
  assert.deepEqual(await chooserRows(page), ['Beat X Open in Chord Rider · Linked to “Song A”']);
  assert.match(await page.innerText('#srpLinkChooser'), /“Beat X”, open in Chord Rider, is linked to “Song A”; picking it moves the link/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('crp-srp-links-v1'))['crp-x'].srpProjectId), 'song-a');
  await page.click('#srpLinkChooser .srpLinkChoice'); await sleep(600);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('crp-srp-links-v1'))['crp-x'].srpProjectId), 'song-b');
  assert.match(await linkNotice(page), /“Song A” is no longer linked to it/);
  assert.equal((await stored(page)).find((p) => p.id === 'song-a').linkedCrpProjectId, '');
  noErrors(page);
  await ctx.close();
});

await test('a full localStorage shows a banner and the edit still reaches the cloud', async () => {
  const user = await newUser();
  const { ctx, page } = await device(browser, user);
  await open(page);
  await typeFull(page, 'before full');
  await sleep(3500);
  await page.evaluate(() => { let n = 0; for (let size = 512 * 1024; size >= 1; size = Math.floor(size / 2)) { const v = 'x'.repeat(size); for (;;) { try { localStorage.setItem('junk' + (n++), v); } catch { break; } } } });
  await typeFull(page, ' after-full');
  await sleep(4500);
  assert.match(await page.evaluate(() => { const b = document.getElementById('srpStorageBanner'); return b && !b.hidden ? b.textContent : ''; }), /storage is full/);
  assert.ok((await server(page)).some((r) => String(r.data.fullText).includes('after-full')), 'edit did not reach the cloud');
  assert.deepEqual(page.errors.filter((e) => !/QuotaExceeded|Saving songs on this device failed/.test(e)), []);
  await ctx.close();
});

await test('the same song in two tabs: both edits survive', async () => {
  const { ctx, page } = await device(browser, null);
  await open(page);
  await typeFull(page, 'start');
  await sleep(600);
  const p2 = await ctx.newPage(); p2.errors = []; p2.on('pageerror', (e) => p2.errors.push(String(e)));
  await open(p2);
  await typeFull(page, ' AAA'); await sleep(1000);
  await typeFull(p2, ' BBB'); await sleep(1000);
  const text = (await stored(page))[0].fullText;
  assert.ok(text.includes('AAA') && text.includes('BBB'), `stored: ${text}`);
  noErrors(page, p2);
  await ctx.close();
});

await test('pasting outside an editor asks before replacing the song', async () => {
  const { ctx, page } = await device(browser, null);
  page.onDialog = (d) => d.dismiss();
  await open(page);
  await typeFull(page, 'my precious song');
  await sleep(500);
  await blur(page);
  await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'PASTED'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(500);
  assert.equal(page.dialogs.length, 1, 'no confirmation');
  assert.match(await fullText(page), /my precious song/);
  noErrors(page);
  await ctx.close();
});

await test('notes HTML cannot run script; checklists and photos survive sanitizing', async () => {
  const doc = '<div class="notesTodoLine"><span class="notesTodoBox" data-notes-checkbox="1" contenteditable="false"></span><span class="notesTodoText">todo</span></div>'
    + '<img/src="x"/onerror="window.__xss=1"><svg onload="window.__xss=2"></svg><a href="javascript:window.__xss=3">x</a><script>window.__xss=4</script>';
  const { ctx, page } = await device(browser, null, {
    init: (doc) => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.setItem('songrider_v25_projects::guest', JSON.stringify([{ id: 'x', name: 'X', createdAt: 1, updatedAt: 1, fullText: '__________\n\nhi\n', sections: {}, enabledSections: ['PAGE 1'], notesDoc: doc, notesUpdatedAt: 5 }]));
      localStorage.setItem('songrider_v25_currentProjectId::guest', 'x');
    }, initArg: doc
  });
  await open(page);
  await page.click('#notesBtn'); await sleep(800);
  assert.equal(await page.evaluate(() => window.__xss || 0), 0, 'script ran');
  const html = await page.evaluate(() => document.getElementById('notesEditor').innerHTML);
  assert.ok(html.includes('notesTodoLine') && html.includes('todo'));
  assert.ok(!/\son\w+=|javascript:|<svg|<script/i.test(html), html);
  await ctx.close();
});

await test('dictation: ordered insert with retry, stop (not cancel) on hide, style header, AudioContext in the tap', async () => {
  const { ctx, page } = await device(browser, null, {
    init: () => {
      window.__speak = (on) => { if (window.__micGain) window.__micGain.gain.value = on ? 0.5 : 0; };
      const OrigAC = window.AudioContext;
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new OrigAC(), osc = c.createOscillator(), g = c.createGain(), dest = c.createMediaStreamDestination();
        g.gain.value = 0; osc.connect(g); g.connect(dest); osc.start(); window.__micGain = g; return dest.stream;
      };
      window.AudioContext = function (...a) { (window.__ctxEvents = window.__ctxEvents || []).push(window.event ? window.event.type : 'none'); return new OrigAC(...a); };
      window.__calls = []; window.__answers = [];
      const of = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (!String(url).includes('/api/lyrics-dictation')) return of(url, opts);
        if ((opts.method || 'GET').toUpperCase() === 'GET') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
        window.__calls.push(new Headers(opts.headers || {}).get('X-Dictation-Style'));
        const a = window.__answers.shift() || { text: 'extra' };
        if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
        if (a.fail) return new Response('{"ok":false,"error":"failed"}', { status: 502, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true, text: a.text }), { headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  await open(page);
  await page.locator('select.fullLyricsStyle').first().selectOption('country');
  const say = async (ms) => { await page.evaluate(() => window.__speak(true)); await sleep(ms); await page.evaluate(() => window.__speak(false)); };
  await page.evaluate(() => { window.__answers = [{ text: 'alpha' }, { fail: true, delay: 2500 }, { text: 'charlie' }]; });
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(700);
  assert.deepEqual(await page.evaluate(() => window.__ctxEvents), ['click']);
  await say(2300); await sleep(1700);
  await say(2300); await sleep(1600);
  await say(1200); await sleep(3000);
  assert.equal(await fullText(page), 'alpha', 'later phrase was inserted ahead of the failed one');
  await page.evaluate(() => { window.__answers = [{ text: 'bravo' }, { text: 'charlie' }]; });
  await page.getByText('Retry transcription').click();
  await sleep(1500);
  assert.equal(await fullText(page), 'alpha bravo charlie');
  await page.evaluate(() => { window.__answers = [{ text: 'delta', delay: 500 }]; });
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(600);
  await say(1500);
  await page.evaluate(() => { window.__speak(true); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(1500);
  assert.equal(await fullText(page), 'alpha bravo charlie delta', 'phrase was discarded on hide');
  assert.ok((await page.evaluate(() => window.__calls)).every((s) => s === 'country'));
  assert.equal(await page.evaluate(() => localStorage.getItem('srp-dictation-style-v1')), 'country');
  noErrors(page);
  await ctx.close();
});

await test('dictation signed in on a phone: survives the permission prompt (blur / hidden / focus) and cloud pulls that replace the song', async () => {
  const user = await newUser();
  const A = await device(browser, user); // the user's other device
  await open(A.page);
  await typeFull(A.page, 'cloud line');
  await sleep(3500);
  // Real sign-in and cloud sync; only the microphone and Workers AI are stubbed.
  const P = await device(browser, user, {
    phone: true,
    init: () => {
      window.__speak = (on) => { if (window.__micGain) window.__micGain.gain.value = on ? 0.5 : 0; };
      const OrigAC = window.AudioContext;
      navigator.mediaDevices.getUserMedia = async () => {
        if (window.__permissionPrompt) await window.__permissionPrompt();
        const c = new OrigAC(), osc = c.createOscillator(), g = c.createGain(), dest = c.createMediaStreamDestination();
        g.gain.value = 0; osc.connect(g); g.connect(dest); osc.start(); window.__micGain = g; return dest.stream;
      };
      window.__answers = [];
      const of = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (!String(url).includes('/api/lyrics-dictation')) return of(url, opts);
        if ((opts.method || 'GET').toUpperCase() === 'GET') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true, text: window.__answers.shift() || '' }), { headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  await open(P.page);
  await sleep(1000);
  assert.equal(await fullText(P.page), 'cloud line');
  // The floating R button must not cover the mic on a 390 px phone.
  const [mic, r] = await P.page.evaluate(() => [document.querySelector('button.fullLyricsMic'), document.getElementById('rBtn')].map((e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right }; }));
  assert.ok(mic.right <= r.left, `the R button covers the mic (mic ${mic.left}-${mic.right}, R from ${r.left})`);

  // The other device edits the song; the phone pulls it when the permission prompt closes.
  await typeFull(A.page, ' + desk one');
  await sleep(3500);
  await P.page.evaluate(() => {
    const hide = (on) => {
      for (const [k, v] of [['hidden', true], ['visibilityState', 'hidden']]) {
        if (on) Object.defineProperty(document, k, { configurable: true, get: () => v }); else delete document[k];
      }
      document.dispatchEvent(new Event('visibilitychange'));
    };
    window.__permissionPrompt = async () => {
      window.dispatchEvent(new Event('blur'));
      hide(true); // some Android phones show the prompt as its own screen
      await new Promise((res) => setTimeout(res, 400));
      hide(false);
      window.dispatchEvent(new Event('focus'));
      await new Promise((res) => setTimeout(res, 1500));
    };
  });
  const say = async (ms) => { await P.page.evaluate(() => window.__speak(true)); await sleep(ms); await P.page.evaluate(() => window.__speak(false)); };
  await P.page.locator('button.fullLyricsMic').first().tap();
  await sleep(2600);
  assert.equal(await fullText(P.page), 'cloud line + desk one', 'the focus pull did not run');
  assert.equal(await P.page.locator('button.fullLyricsMic').first().textContent(), '⏹', 'dictation stopped during the permission prompt');
  await P.page.evaluate(() => { window.__answers.push('alpha'); });
  await say(2300); await sleep(3000);
  assert.equal(await fullText(P.page), 'cloud line + desk one alpha');

  // Mid-session: the other device pulls, edits again, and the phone pulls the newer copy.
  await sleep(2500); // the phone's upload of "alpha"
  await A.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(2000);
  await typeFull(A.page, ' + desk two');
  await sleep(3500);
  await P.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(2000);
  assert.equal(await fullText(P.page), 'cloud line + desk one alpha + desk two', 'the pull did not bring the other device\'s edit');
  assert.equal(await P.page.locator('button.fullLyricsMic').first().textContent(), '⏹', 'dictation stopped when the pull replaced the song');
  await P.page.evaluate(() => { window.__answers.push('bravo'); });
  await say(2300); await sleep(3000);
  await P.page.locator('button.fullLyricsMic').first().tap(); await sleep(1500);
  assert.equal(await P.page.locator('button.fullLyricsMic').first().textContent(), '🎤');
  assert.equal(await fullText(P.page), 'cloud line + desk one alpha + desk two bravo');
  await sleep(3500);
  const rows = (await server(P.page)).filter((x) => !x.deleted);
  assert.equal(rows.length, 1, rows.map((x) => x.name).join(', '));
  assert.match(rows[0].data.fullText, /cloud line \+ desk one alpha \+ desk two bravo/);
  noErrors(A.page, P.page);
  await A.ctx.close(); await P.ctx.close();
});

await test('typing cost does not grow with the library; few cloud requests while typing', async () => {
  const user = await newUser();
  const songs = Array.from({ length: 60 }, (_, i) => ({
    id: `seed-${i}`, name: `Seed ${String(i).padStart(2, '0')}`, createdAt: 1000 + i, updatedAt: 1000 + i, notesUpdatedAt: 1000 + i,
    fullText: '__________Verse\n\n' + Array.from({ length: 24 }, (_, l) => `song ${i} line ${l} with some lyric words`).join('\n\n') + '\n',
    sections: { 'PAGE 1': Array.from({ length: 24 }, (_, l) => ({ id: `l-${i}-${l}`, notes: ['G', '', 'D', '', 'Em', '', 'C', ''], lyrics: `song ${i} line ${l} with some lyric words`, beats: ['', '', '', ''] })) },
    enabledSections: ['PAGE 1'], notesDoc: '<div>' + 'notes '.repeat(200) + '</div>', notesColor: '#151515'
  }));
  const { ctx, page } = await device(browser, user);
  await page.goto(`${BASE}/song-rider/manifest.webmanifest`);
  const uid = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id);
  const seed = (list) => page.evaluate(({ uid, list }) => {
    localStorage.setItem('songrider_v25_projects::' + uid, JSON.stringify(list));
    localStorage.setItem('songrider_v25_currentProjectId::' + uid, 'seed-0');
  }, { uid, list });
  const keystrokeMedian = () => page.evaluate(async () => {
    const ta = document.querySelector('textarea.fullSectionText'), t = [];
    ta.focus();
    for (let i = 0; i < 40; i++) { ta.value += 'x'; const t0 = performance.now(); ta.dispatchEvent(new Event('input', { bubbles: true })); t.push(performance.now() - t0); await new Promise((r) => setTimeout(r, 15)); }
    return t.sort((a, b) => a - b)[20];
  });
  // one song: the per-keystroke cost of the song itself
  await seed(songs.slice(0, 1));
  await open(page);
  await sleep(3000);
  const one = await keystrokeMedian();
  // sixty songs
  await seed(songs);
  await open(page);
  await sleep(6000); // first sync pushes the local songs
  const sixty = await keystrokeMedian();
  await sleep(2500);
  let requests = 0;
  page.on('request', (r) => { if (r.url().includes('/api/srp/projects')) requests++; });
  await page.locator('textarea.fullSectionText').first().click();
  for (let b = 0; b < 4; b++) { await page.keyboard.type(' abcdefghi', { delay: 50 }); await sleep(900); }
  await sleep(2500);
  console.log(`       (keystroke handler median: 1 song ${one.toFixed(1)} ms, 60 songs ${sixty.toFixed(1)} ms; ${requests} project API requests for 40 keystrokes)`);
  assert.ok(sixty < one * 1.5 + 4, `keystrokes got slower with a bigger library (${one.toFixed(1)} -> ${sixty.toFixed(1)} ms)`);
  assert.ok(requests <= 20, `${requests} project API requests while typing`);
  noErrors(page);
  await ctx.close();
});

await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
