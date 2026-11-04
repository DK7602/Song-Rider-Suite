// Song Rider Pro end-to-end checks in a real browser against a local `wrangler dev`:
//   wrangler d1 execute song-rider-suite-test-db --local --config tests/wrangler.test.jsonc --file migrations/0001_init.sql
//   wrangler dev --config tests/wrangler.test.jsonc --port 8787 &
//   BASE_URL=http://127.0.0.1:8787 node tests/e2e/srp.test.mjs      (ONLY=<part of a test name> runs a subset)
// Uses the test invite code (INVITE_CODE, default "test-invite"). Prints ok/FAIL per check and exits
// non-zero if any check fails. Workers AI is not available locally, so dictation is stubbed in-page.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

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

await test('capo moves slash-chord bass notes too; BPM up to 240 survives a reload; export says what it downloads', async () => {
  const { ctx, page } = await device(browser, null, {});
  await open(page);
  await typeFull(page, 'D/F#  Am7/G\nI was made for more');
  await sleep(500);
  // Capo 2: every chord moves up 2 semitones, bass notes included (D/F# -> E/G#, Am7/G -> Bm7/A).
  await page.fill('#capoInput', '2'); await page.dispatchEvent('#capoInput', 'change'); await sleep(600);
  const shown = await fullText(page);
  assert.match(shown, /E\/G#/, `capo 2 shows: ${shown}`);
  assert.match(shown, /Bm7\/A/, `capo 2 shows: ${shown}`);
  assert.doesNotMatch(shown, /E\/F#|Bm7\/G\b/, 'a bass note was left behind');
  // Back to capo 0: the chords as written.
  await page.fill('#capoInput', '0'); await page.dispatchEvent('#capoInput', 'change'); await sleep(600);
  assert.match(await fullText(page), /^D\/F#\s+Am7\/G/);
  // BPM 240 (the box allows 40-240) is kept when the song is opened again.
  await page.fill('#bpmInput', '240'); await page.dispatchEvent('#bpmInput', 'change'); await page.dispatchEvent('#bpmInput', 'blur'); await sleep(800);
  await open(page);
  assert.equal(await page.inputValue('#bpmInput'), '240');
  // The export button describes what it downloads: a printable page.
  assert.match(await page.getAttribute('#exportBtn', 'title'), /printable page/i);
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

// Every section of the song with its cards that hold something: [title, [[lyrics, chords], …]].
const songSections = async (page) => {
  const p = (await stored(page))[0];
  const order = Object.keys(p.sections || {}).filter((k) => /^PAGE \d+$/.test(k)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  return order.map((sec) => [p.sectionTitles?.[sec] || sec, p.sections[sec].filter((l) => String(l.lyrics || '').trim() || (l.notes || []).some(Boolean)).map((l) => [l.lyrics, l.notes.filter(Boolean).join(' ')])]).filter(([, cards]) => cards.length);
};
const crpSeed = (rows) => {
  if (localStorage.getItem('crp-projects')) return;
  localStorage.setItem('crp-projects', JSON.stringify([{ id: 'crp-1', name: 'CRP Song', bpm: 100, beats: 4, key: 'Am', capo: 0, octave: 0, rows, updatedAt: 1000 }]));
  localStorage.setItem('crp-active-project-id', 'crp-1');
};
const setCrpRows = (page, rows) => page.evaluate((rows) => {
  const all = JSON.parse(localStorage.getItem('crp-projects')); all[0].rows = rows; all[0].updatedAt = Date.now();
  localStorage.setItem('crp-projects', JSON.stringify(all));
  window.dispatchEvent(new StorageEvent('storage', { key: 'crp-projects' })); window.dispatchEvent(new Event('focus'));
}, rows);

await test('Link SRP puts Chord Rider’s lines on the lyric lines of every section in order and keeps them in sync', async () => {
  const { ctx, page } = await device(browser, null, { init: crpSeed, initArg: crpRows('Am7 Fmaj7', 'Dm7 E7', 'C G', 'F C', 'Am7 Fmaj7', 'Dm7 E7', 'G') });
  await page.route('**/index.html?playbackBridge=1', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await open(page);
  await typeFull(page, 'v1 a\n\nv1 b\n\n_Chorus 1\nc1 a\n\nc1 b\n\n_Verse 2\nv2 a\n\nv2 b');
  await sleep(600); await blur(page); await sleep(400);
  await page.click('#crpSrpLinkBtn'); await sleep(1000);
  assert.deepEqual(await songSections(page), [
    ['PAGE 1', [['v1 a', 'Am7 Fmaj7'], ['v1 b', 'Dm7 E7']]],
    ['Chorus 1', [['c1 a', 'C G'], ['c1 b', 'F C']]],
    ['Verse 2', [['v2 a', 'Am7 Fmaj7'], ['v2 b', 'Dm7 E7'], ['', 'G']]]
  ], 'one Chord Rider line per lyric line, through every section; the extra line goes after the last lyric');
  assert.match(await linkNotice(page), /on your lyric lines in order, through every section/);
  // Chord Rider changes: a chord in the chorus, and the last two lines removed.
  await setCrpRows(page, crpRows('Am7 Fmaj7', 'Dm7 E7', 'C Em', 'F C', 'Am7 Fmaj7'));
  await sleep(1200);
  assert.deepEqual(await songSections(page), [
    ['PAGE 1', [['v1 a', 'Am7 Fmaj7'], ['v1 b', 'Dm7 E7']]],
    ['Chorus 1', [['c1 a', 'C Em'], ['c1 b', 'F C']]],
    ['Verse 2', [['v2 a', 'Am7 Fmaj7'], ['v2 b', 'Dm7 E7']]]
  ], 'the change reaches the chorus; the extra card made for the removed line is gone; lyric lines keep their chords');
  await blur(page);
  await page.click('#undoBtn'); await sleep(400);
  assert.deepEqual((await songSections(page))[2], ['Verse 2', [['v2 a', 'Am7 Fmaj7'], ['v2 b', 'Dm7 E7'], ['', 'G']]], 'Undo puts the previous chords back');
  noErrors(page);
  await ctx.close();
});

await test('A song linked with the old first-section layout is laid out across the song once (Undo restores it)', async () => {
  const rows = crpRows('Am7 Fmaj7', 'Dm7 E7', 'C G', 'F C');
  const slots = (a, b) => [a, '', '', '', b, '', '', ''];
  const card = (id, lyrics, notes = Array(8).fill('')) => ({ id, notes, lyrics, beats: ['', '', '', ''] });
  const song = {
    id: 'song-1', name: 'Old Link', createdAt: 1, updatedAt: 1, linkedCrpProjectId: 'crp-1', crpRowsSig: 'old', crpChordRows: rows,
    fullText: '__________\n\n   Am7          Fmaj7\nv1 a\n\n   Dm7          E7\nv1 b\n\nC G\n\nF C\n\n__________Chorus 1\n\nc1 a\n\nc1 b\n',
    sections: {
      'PAGE 1': [card('a', 'v1 a', slots('Am7', 'Fmaj7')), card('b', 'v1 b', slots('Dm7', 'E7')), card('c', '', slots('C', 'G')), card('d', '', slots('F', 'C'))],
      'PAGE 2': [card('e', 'c1 a'), card('f', 'c1 b')]
    },
    sectionTitles: { 'PAGE 2': 'Chorus 1' }, enabledSections: ['PAGE 1']
  };
  const { ctx, page } = await device(browser, null, {
    init: ({ song, rows }) => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.setItem('songrider_v25_projects::guest', JSON.stringify([song]));
      localStorage.setItem('songrider_v25_currentProjectId::guest', 'song-1');
      localStorage.setItem('crp-projects', JSON.stringify([{ id: 'crp-1', name: 'CRP Song', bpm: 100, beats: 4, key: 'Am', rows, updatedAt: 5 }]));
      localStorage.setItem('crp-active-project-id', 'crp-1');
      localStorage.setItem('crp-srp-links-v1', JSON.stringify({ 'crp-1': { srpProjectId: 'song-1', srpName: 'Old Link', linkedAt: 1 } }));
    }, initArg: { song, rows }
  });
  await page.route('**/index.html?playbackBridge=1', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await open(page); await sleep(800);
  assert.deepEqual(await songSections(page), [
    ['PAGE 1', [['v1 a', 'Am7 Fmaj7'], ['v1 b', 'Dm7 E7']]],
    ['Chorus 1', [['c1 a', 'C G'], ['c1 b', 'F C']]]
  ], 'the chords left on the first section move to the chorus');
  assert.equal((await stored(page))[0].crpChordLayout, 2);
  await blur(page);
  await page.click('#undoBtn'); await sleep(400);
  assert.deepEqual(await songSections(page), [
    ['PAGE 1', [['v1 a', 'Am7 Fmaj7'], ['v1 b', 'Dm7 E7'], ['', 'C G'], ['', 'F C']]],
    ['Chorus 1', [['c1 a', ''], ['c1 b', '']]]
  ], 'Undo gives the old layout back');
  noErrors(page);
  await ctx.close();
});

// ---- Importing chord sheets (paste, ChordPro, PDF) and printing them ----
const UG_SHEET = [
  'Amazing Grace', 'John Newton', '', '[Intro]', 'G  D  G', '', '[Verse 1]',
  'G                G7         C        G', 'Amazing grace, how sweet the sound',
  '                     Em      D', 'That saved a wretch like me',
  'G               G7        C       G', 'I once was lost, but now am found',
  '        Em        D       G', 'Was blind, but now I see', '', '[Chorus]',
  'C          G           Em      D', 'Through many dangers, toils and snares',
  'G      D/F#   Em7       Cmaj7', 'I have already come'
].join('\n');
// Paste the way a copy from a website arrives: not into an editor.
const pasteSong = (page, text) => page.evaluate((text) => {
  document.activeElement?.blur?.();
  const dt = new DataTransfer(); dt.setData('text/plain', text);
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);
const partTitles = async (page) => {
  const p = (await stored(page))[0];
  const order = Object.keys(p.sections).filter((k) => /^PAGE \d+$/.test(k)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  return order.filter((sec) => p.sections[sec].some((l) => String(l.lyrics || '').trim() || (l.notes || []).some(Boolean)) || p.sectionTitles?.[sec]).map((sec) => p.sectionTitles?.[sec] || '');
};
const fullViewText = (page) => page.evaluate(() => Array.from(document.querySelectorAll('textarea.fullSectionText')).map((t) => t.value).join('\n'));
// The word under each chord of every chord row + lyric pair in plain text: [[lyric, [[chord, word]…]]…].
const CHORDISH = /^[A-G][#b]?(?:maj|min|m|M|dim|aug|sus|add|\d|#|b|\(|\))*(?:\/[A-G][#b]?)?$/;
const isChordRowText = (l) => l.trim() && l.trim().split(/\s+/).every((t) => CHORDISH.test(t));
const wordAt = (ly, i) => { if (i >= ly.length) return '(end)'; let a = i, b = i; while (a > 0 && ly[a - 1] !== ' ') a--; while (b < ly.length && ly[b] !== ' ') b++; return ly.slice(a, b) || '(space)'; };
function chordWords(text) {
  const lines = text.replace(/ /g, ' ').split('\n'), out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
    if (!isChordRowText(lines[i]) || !lines[j] || !lines[j].trim() || isChordRowText(lines[j]) || /^\s*\[/.test(lines[j])) continue;
    const ly = lines[j]; const re = /\S+/g; let m; const cw = [];
    while ((m = re.exec(lines[i]))) cw.push([m[0], wordAt(ly, m.index)]);
    out.push([ly.replace(/\s+/g, ' ').trim(), cw]); i = j;
  }
  return out;
}
async function exportPage(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  return readFileSync(await dl.path(), 'utf8');
}
// The same, read from where things are drawn in the exported page at a given width.
async function exportedChordWords(html, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  await p.setContent(html);
  const r = await p.evaluate(() => {
    const out = [];
    for (const t of document.querySelectorAll('table')) {
      const rows = t.querySelectorAll(':scope > tbody > tr');
      if (rows.length !== 2 || t.querySelector('table')) continue;
      const nodes = [...rows[1].children].map((td) => [...td.childNodes].find((n) => n.nodeType === 3)).filter(Boolean);
      const boxes = [], chars = [];
      for (const tn of nodes) for (let i = 0; i < tn.length; i++) { const rg = document.createRange(); rg.setStart(tn, i); rg.setEnd(tn, i + 1); const b = rg.getBoundingClientRect(); boxes.push([b.left, b.right]); chars.push(tn.data[i] === ' ' ? ' ' : tn.data[i]); }
      const ly = chars.join('');
      const cw = [...rows[0].children].filter((td) => td.textContent.trim()).map((td) => {
        const x = td.getBoundingClientRect().left + 0.5;
        const i = boxes.findIndex(([a, b]) => x >= a && x < b);
        let w = '(end)';
        if (i >= 0 && i < ly.trimEnd().length) { let a = i, b = i; while (a > 0 && ly[a - 1] !== ' ') a--; while (b < ly.length && ly[b] !== ' ') b++; w = ly.slice(a, b) || '(space)'; }
        return [td.textContent.trim(), w];
      });
      out.push([ly.replace(/\s+/g, ' ').trim(), cw]);
    }
    return out;
  });
  await ctx.close();
  return r;
}

await test('A chord sheet copied from a website keeps every chord on its word: Full view, card edits and the printed page at any width', async () => {
  const { ctx, page } = await device(browser, null);
  await open(page);
  // A web copy: no-break spaces in the chord rows and Windows line ends.
  await pasteSong(page, UG_SHEET.replace(/  /g, '  ').replace(/\n/g, '\r\n'));
  await sleep(1200);
  assert.deepEqual(await partTitles(page), ['', 'Intro', 'Verse 1', 'Chorus']);
  const want = chordWords(UG_SHEET);
  assert.equal(want.length, 6);
  assert.deepEqual(chordWords(await fullViewText(page)), want, 'Full view: every chord on its word');
  let html = await exportPage(page);
  for (const w of [390, 1280]) assert.deepEqual(await exportedChordWords(html, w), want, `printed page at ${w}px: every chord on its word`);
  assert.doesNotMatch(html, /c00000[^>]*>Amazing/, 'the title line is not printed as chords');
  // Change one chord on the Chorus card: only that line changes, and its other chords stay put.
  for (let i = 0; i < 4; i++) { await blur(page); await page.keyboard.press("ArrowRight"); await sleep(300); }
  const cell = page.locator('input.noteCell').first();
  await cell.click(); await cell.fill('Am'); await page.keyboard.press('Tab'); await sleep(700);
  for (let i = 0; i < 6 && !(await page.locator('.fullSectionCard').count()); i++) { await blur(page); await page.keyboard.press('ArrowLeft'); await sleep(250); }
  const after = want.map(([ly, cw]) => [ly, ly.startsWith('Through') ? [['Am', 'Through'], ...cw.slice(1)] : cw]);
  assert.deepEqual(chordWords(await fullViewText(page)), after, 'a card edit moves no other chord');
  html = await exportPage(page);
  assert.deepEqual(await exportedChordWords(html, 820), after);
  noErrors(page);
  await ctx.close();
});

await test('ChordPro and [G]inline chord sheets become song parts with each chord over its syllable', async () => {
  const { ctx, page } = await device(browser, null);
  await open(page);
  await pasteSong(page, '{title: River Song}\n{artist: Example Writer}\n{key: G}\n\n{start_of_verse: Verse 1}\n[G]Low in the [C]valley the [G]river runs\n{end_of_verse}\n\n{start_of_chorus}\n[G]Sing it [D]loud, sing it [Em]free to[C]night\n{end_of_chorus}\n\n{comment: Bridge}\n[Am]All the roads lead [C]back to [D]you');
  await sleep(1200);
  assert.deepEqual(await partTitles(page), ['Verse 1', 'Chorus', 'Bridge']);
  const song = (await stored(page))[0];
  assert.equal(song.name, 'River Song', 'the {title} names a new song');
  assert.equal(song.sections['PAGE 2'][0].lyrics, 'Sing it loud, sing it free tonight', 'a chord inside a word does not split it');
  const want = [
    ['Low in the valley the river runs', [['G', 'Low'], ['C', 'valley'], ['G', 'river']]],
    ['Sing it loud, sing it free tonight', [['G', 'Sing'], ['D', 'loud,'], ['Em', 'free'], ['C', 'tonight']]],
    ['All the roads lead back to you', [['Am', 'All'], ['C', 'back'], ['D', 'you']]]
  ];
  assert.deepEqual(chordWords(await fullViewText(page)), want);
  assert.deepEqual(await exportedChordWords(await exportPage(page), 390), want);
  // [G]inline lines without ChordPro, and a chord row of lowercase chords.
  await pasteSong(page, '[Verse 1]\n[G]Low in the [C]valley\n\n[Chorus]\ng          em\nSing it loud tonight\n\n[Bridge]\nc1 a\nlyric words');
  await sleep(1200);
  const cards = (await stored(page))[0].sections;
  assert.deepEqual([cards['PAGE 1'][0].notes.filter(Boolean), cards['PAGE 2'][0].notes.filter(Boolean)], [['G', 'C'], ['G', 'Em']]);
  assert.deepEqual(cards['PAGE 3'].map((l) => [l.lyrics, l.notes.filter(Boolean).length]), [['c1 a', 0], ['lyric words', 0]], 'words that only look a little like chords stay lyrics');
  noErrors(page);
  await ctx.close();
});

await test('Song-part headings from chord and lyric sites, chord names and lyrics that look like chords', async () => {
  const { ctx, page } = await device(browser, null);
  await open(page);
  await pasteSong(page, ['Verse 1:', 'Low in the valley', '', 'Pre-Chorus 2', 'Hold on', '', 'Chorus x2', 'Sing it loud', '', 'Bridge 2', 'All the roads', '', '[Hook]', 'We ride all night', '', '[Verse 2: MC Example]', 'Back on the block', '', 'Refrain', 'Carry me home', '', 'Instrumental', '| G | D | Em | C |', '', 'Repeat Chorus', '', 'Outro', 'Low in the valley'].join('\n'));
  await sleep(1200);
  assert.deepEqual(await partTitles(page), ['Verse 1', 'Pre-Chorus 2', 'Chorus x2', 'Bridge 2', 'Hook', 'Verse 2: MC Example', 'Refrain', 'Instrumental', 'Repeat Chorus', 'Outro']);
  await pasteSong(page, ['[Verse 1]', 'Bm7(b5)        E7#9         Am(maj7)', 'Shadows fall but the air is still', 'G6/9           Csus4(add9)  N.C.', 'Hold the line and wait for me', 'A♭maj7         B♭/D         E♭', 'Every song has a melody', 'G                  D', 'A man who walks alone tonight', 'Em                C', 'Am I the only one awake'].join('\n'));
  await sleep(1200);
  const cards = (await stored(page))[0].sections['PAGE 1'].map((l) => [l.lyrics, l.notes.filter(Boolean).join(' ')]);
  assert.deepEqual(cards, [
    ['Shadows fall but the air is still', 'Bm7(b5) E7#9 Am(maj7)'],
    ['Hold the line and wait for me', 'G6/9 Csus4(add9) N.C.'],
    ['Every song has a melody', 'Abmaj7 Bb/D Eb'],
    ['A man who walks alone tonight', 'G D'],
    ['Am I the only one awake', 'Em C']
  ]);
  noErrors(page);
  await ctx.close();
});

await test('PDF chord charts (typeset two-column with a CCLI footer, and monospace) import with every chord over its syllable', async () => {
  // Make the PDFs the way chord sites and word processors do: a typeset chart with each chord placed
  // over its syllable in two columns, and a plain monospace chart.
  const maker = await browser.newPage();
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const src = UG_SHEET.split('\n'); let typeset = '';
  for (let i = 0; i < src.length; i++) {
    const l = src[i], n = src[i + 1] || '';
    if (isChordRowText(l) && n.trim() && !isChordRowText(n) && !/^\[/.test(n)) {
      const re = /\S+/g; let m, last = 0, html = '';
      while ((m = re.exec(l))) { const at = Math.min(m.index, n.length); html += esc(n.slice(last, at)) + `<span class="a" data-c="${m[0]}"></span>`; last = at; }
      typeset += `<div class="p">${html}${esc(n.slice(last))}</div>`; i++;
    } else typeset += `<div class="${/^\[/.test(l) ? 'h' : 'l'}">${esc(l.replace(/^\[|\]$/g, '')) || '&nbsp;'}</div>`;
  }
  const second = typeset.replace(/Verse 1/, 'Verse 2').replace(/>Intro</, '>Tag<').replace(/<div class="l">Amazing Grace<\/div><div class="l">John Newton<\/div>/, '');
  await maker.setContent(`<style>body{font:11pt Arial,sans-serif;margin:0}.cols{display:flex;gap:.6in}.cols>div{flex:1}.p{white-space:pre;margin-top:1.25em}.a{position:relative}.a::before{content:attr(data-c);position:absolute;bottom:1.05em;left:0;font-weight:bold}.h{font-weight:bold;margin-top:.8em}.l{white-space:pre}.f{position:fixed;bottom:0;font-size:7pt}</style><div class="cols"><div>${typeset}</div><div>${second}</div></div><div class="f">CCLI Song # 1234567 © 2026 Example Music. For use solely with the SongSelect Terms of Use. All rights reserved.</div>`);
  const twoCol = await maker.pdf({ format: 'Letter', margin: { top: '0.5in', left: '0.6in', right: '0.6in', bottom: '0.6in' } });
  await maker.setContent(`<pre style="font:12pt 'Courier New',monospace;margin:0">${esc(UG_SHEET)}</pre>`);
  const mono = await maker.pdf({ format: 'Letter', margin: { top: '0.6in', left: '0.7in' } });
  await maker.close();
  const want = chordWords(UG_SHEET);
  for (const [name, buffer, parts, pairs] of [['chart.pdf', twoCol, ['', 'Intro', 'Verse 1', 'Chorus', 'Tag', 'Verse 2', 'Chorus'], [...want, ...want]], ['mono.pdf', mono, ['', 'Intro', 'Verse 1', 'Chorus'], want]]) {
    const { ctx, page } = await device(browser, null);
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await page.click('#uploadAudioBtn');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await sleep(2500);
    assert.deepEqual(await partTitles(page), parts, `${name}: song parts in reading order`);
    for (let i = 0; i < 6 && !(await page.locator('.fullSectionCard').count()); i++) { await blur(page); await page.keyboard.press('ArrowLeft'); await sleep(250); }
    const text = await fullViewText(page);
    assert.doesNotMatch(text, /CCLI|SongSelect/, `${name}: the copyright footer is left out`);
    assert.deepEqual(chordWords(text), pairs, `${name}: every chord over its syllable`);
    assert.deepEqual(await exportedChordWords(await exportPage(page), 820), pairs, `${name}: and on the printed page`);
    noErrors(page);
    await ctx.close();
  }
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
  // The first audio engine is created inside the tap (iOS only allows audio started there); a
  // second one is made after the mic opens (Android can leave the tap's engine silent).
  const ctxEvents = await page.evaluate(() => window.__ctxEvents);
  assert.equal(ctxEvents[0], 'click', 'the first audio engine must be created inside the tap');
  assert.ok(ctxEvents.length <= 2, `too many audio engines created: ${ctxEvents.join(',')}`);
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

await test('dictation sends phrases at each pause even with steady background noise (phone auto-gain)', async () => {
  const { ctx, page } = await device(browser, null, {
    init: () => {
      window.__speak = (on) => { if (window.__micGain) window.__micGain.gain.value = on ? 0.5 : 0; };
      const OrigAC = window.AudioContext;
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new OrigAC(), dest = c.createMediaStreamDestination();
        const osc = c.createOscillator(), g = c.createGain(); g.gain.value = 0; osc.connect(g); g.connect(dest); osc.start(); window.__micGain = g;
        // Constant hiss around -34 dBFS: above the old fixed speech threshold, so the old code never heard a pause.
        const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.035;
        const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.connect(dest); noise.start();
        return dest.stream;
      };
      window.__posts = 0;
      const of = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (!String(url).includes('/api/lyrics-dictation')) return of(url, opts);
        if ((opts.method || 'GET').toUpperCase() === 'GET') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
        window.__posts++;
        return new Response(JSON.stringify({ ok: true, text: 'line' + window.__posts }), { headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  await open(page);
  const say = async (ms) => { await page.evaluate(() => window.__speak(true)); await sleep(ms); await page.evaluate(() => window.__speak(false)); };
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(1200);
  await say(1600); await sleep(2000);
  await say(1600); await sleep(2000);
  const before = await page.evaluate(() => window.__posts);
  assert.ok(before >= 2, `only ${before} phrase(s) were sent while talking in a noisy room`);
  assert.match(await page.locator('.fullLyricsVoiceInfo').first().textContent(), /Listening [▮▯]{5}/);
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(1500);
  assert.match(await fullText(page), /^line1 line2/);
  noErrors(page);
  await ctx.close();
});

await test('dictation shows its voice meter at once and keeps the first words when you talk straight away', async () => {
  // Talking from the very first moment set the noise floor with the voice itself, so nothing counted as
  // speech until a pause, and the audio before it was thrown away: the opening words were lost.
  const { ctx, page } = await device(browser, null, {
    init: () => {
      window.__speak = (on) => { if (window.__micGain) window.__micGain.gain.value = on ? 0.5 : 0; };
      const OrigAC = window.AudioContext;
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new OrigAC(), dest = c.createMediaStreamDestination();
        // "Voice" from the moment the microphone opens, over quiet room noise.
        const osc = c.createOscillator(), g = c.createGain(); g.gain.value = 0.5; osc.connect(g); g.connect(dest); osc.start(); window.__micGain = g;
        const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.01;
        const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.connect(dest); noise.start();
        window.__micOpenedAt = performance.now();
        return dest.stream;
      };
      window.__phrases = [];
      const of = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (!String(url).includes('/api/lyrics-dictation')) return of(url, opts);
        if ((opts.method || 'GET').toUpperCase() === 'GET') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
        const bytes = (await opts.body.arrayBuffer()).byteLength;
        window.__phrases.push((bytes - 44) / 2 / 16000);
        return new Response(JSON.stringify({ ok: true, text: 'phrase' + window.__phrases.length }), { headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  await open(page);
  await page.locator('button.fullLyricsMic').first().click();
  // The meter is on screen straight away, before any sound.
  await sleep(150);
  assert.match(await page.locator('.fullLyricsVoiceInfo').first().textContent(), /(Getting the microphone ready|Listening) [▮▯]{5}/);
  // Talk for about 1.8 s from the moment the microphone opens, then pause.
  await page.waitForFunction(() => window.__micOpenedAt, null, { timeout: 5000 });
  const talked = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 1800)); window.__speak(false); return (performance.now() - window.__micOpenedAt) / 1000; });
  await sleep(2600);
  const phrases = await page.evaluate(() => window.__phrases);
  assert.ok(phrases.length >= 1, 'the opening words were never sent');
  assert.ok(phrases[0] >= talked - 0.5, `the first phrase holds ${phrases[0].toFixed(2)} s of audio but the voice ran ${talked.toFixed(2)} s from the start`);
  // Talking straight away and stopping without a pause still sends what was said.
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(1500);
  await page.evaluate(() => { window.__phrases = []; });
  await page.locator('button.fullLyricsMic').first().click();
  await page.waitForFunction(() => window.__micOpenedAt && window.__micGain && window.__micGain.gain.value > 0, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => window.__speak(true));
  await sleep(2200);
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(1500);
  assert.ok((await page.evaluate(() => window.__phrases.length)) >= 1, 'talking from the start and stopping without a pause sent nothing');
  noErrors(page);
  await ctx.close();
});

await test('dictation still shows its status line on later sessions after the view re-rendered mid-session', async () => {
  const { ctx, page } = await device(browser, null, {
    init: () => {
      window.__speak = (on) => { if (window.__micGain) window.__micGain.gain.value = on ? 0.5 : 0; };
      const OrigAC = window.AudioContext;
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new OrigAC(), osc = c.createOscillator(), g = c.createGain(), dest = c.createMediaStreamDestination();
        g.gain.value = 0; osc.connect(g); g.connect(dest); osc.start(); window.__micGain = g; return dest.stream;
      };
      window.__posts = 0;
      const of = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (!String(url).includes('/api/lyrics-dictation')) return of(url, opts);
        if ((opts.method || 'GET').toUpperCase() === 'GET') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
        window.__posts++;
        return new Response(JSON.stringify({ ok: true, text: 'take' + window.__posts }), { headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  await open(page);
  const mic = () => page.locator('button.fullLyricsMic').first();
  const statusVisible = () => page.locator('.fullLyricsVoiceInfo').first().isVisible();
  const say = async (ms) => { await page.evaluate(() => window.__speak(true)); await sleep(ms); await page.evaluate(() => window.__speak(false)); };
  await mic().click(); await sleep(800);
  await say(1600); await sleep(1800);
  // Another tab saves the song while the session runs: this tab re-renders the Full view.
  const p2 = await ctx.newPage(); p2.errors = []; p2.on('pageerror', (e) => p2.errors.push(String(e)));
  await open(p2); await typeFull(p2, ' other'); await sleep(1500); await p2.close();
  await mic().click(); await sleep(1500);
  for (let round = 2; round <= 3; round++) {
    await mic().click(); await sleep(800);
    assert.ok(await statusVisible(), `session ${round}: no status line (it went to a detached element)`);
    await say(1600); await sleep(1800);
    await mic().click(); await sleep(1500);
  }
  assert.match(await fullText(page), /take1.*take2.*take3/s);
  noErrors(page);
  await ctx.close();
});

await test('dictation hears the mic even when the audio engine made in the tap is stuck (Android)', async () => {
  const { ctx, page } = await device(browser, null, {
    init: () => {
      window.__speak = (on) => { if (window.__micGain) window.__micGain.gain.value = on ? 0.5 : 0; };
      const OrigAC = window.AudioContext;
      // Android: opening the mic can leave an engine created earlier "running" but silent.
      window.AudioContext = function (...a) {
        const c = new OrigAC(...a);
        if (window.event && window.event.type === 'click') {
          c.suspend(); Object.defineProperty(c, 'state', { get: () => 'running' }); c.resume = () => new Promise(() => {});
        }
        return c;
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new OrigAC(), osc = c.createOscillator(), g = c.createGain(), dest = c.createMediaStreamDestination();
        g.gain.value = 0; osc.connect(g); g.connect(dest); osc.start(); window.__micGain = g; return dest.stream;
      };
      window.__posts = 0;
      const of = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (!String(url).includes('/api/lyrics-dictation')) return of(url, opts);
        if ((opts.method || 'GET').toUpperCase() === 'GET') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
        window.__posts++;
        return new Response(JSON.stringify({ ok: true, text: 'heard' + window.__posts }), { headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  await open(page);
  const say = async (ms) => { await page.evaluate(() => window.__speak(true)); await sleep(ms); await page.evaluate(() => window.__speak(false)); };
  await page.locator('button.fullLyricsMic').first().click();
  await sleep(2000);
  await say(1600); await sleep(2000);
  const status = await page.locator('.fullLyricsVoiceInfo').first().textContent();
  assert.doesNotMatch(status, /No sound is reaching/, 'the mic was never heard');
  assert.ok(await page.evaluate(() => window.__posts) >= 1, 'no phrase was sent');
  await page.locator('button.fullLyricsMic').first().click(); await sleep(1500);
  assert.match(await fullText(page), /heard1/);
  noErrors(page);
  await ctx.close();
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
