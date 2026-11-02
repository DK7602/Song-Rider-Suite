// Smoke tests: both apps load cleanly in every skin at phone and desktop sizes,
// navigation between them works, nothing overflows sideways, and page weight stays in budget.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const SKINS = ['rider-original', 'rider-og', 'rider-blood', 'studio-pastel', 'black-label', 'black-label-plain', 'black-label-light', 'sapphire-paisley', 'sapphire-paisley-light', 'royal-wave', 'candy-pop', 'rider-light', 'rider-light-og', 'rider-blood-light', 'rider-blood-light-og'];
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 } },
};
const BUDGET_MB = { crp: 3.5, srp: 4.5 };
let passes = 0, failures = 0;
async function test(name, fn) {
  try { await fn(); passes++; console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 4).join('\n       ')}`); }
}

const browser = await chromium.launch();
async function open(vpName, path, { skin } = {}) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vpName], serviceWorkers: 'block' });
  if (skin) await ctx.addInitScript(s => { try { localStorage.setItem('srs-skin-v1', s); } catch {} }, skin);
  const page = await ctx.newPage();
  const errors = [];
  let bytes = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', async r => { try { if (!r.url().includes('/api/')) bytes += (await r.body()).length; } catch {} });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  return { ctx, page, errors, bytes: () => bytes };
}
async function noOverflow(page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  assert.ok(sw <= iw + 1, `horizontal overflow: scrollWidth ${sw} > ${iw}`);
}

console.log(`Smoke tests against ${BASE}`);

for (const vp of Object.keys(VIEWPORTS)) {
  await test(`${vp}: Chord Rider loads without errors and within budget`, async () => {
    const { ctx, page, errors, bytes } = await open(vp, '/index.html');
    assert.deepEqual(errors, []);
    await noOverflow(page);
    const mb = bytes() / 1e6;
    assert.ok(mb < BUDGET_MB.crp, `first load ${mb.toFixed(1)} MB exceeds ${BUDGET_MB.crp} MB`);
    await ctx.close();
  });
  await test(`${vp}: Song Rider loads without errors and within budget`, async () => {
    const { ctx, page, errors, bytes } = await open(vp, '/song-rider/index.html?crpMode=1');
    assert.deepEqual(errors, []);
    await noOverflow(page);
    const mb = bytes() / 1e6;
    assert.ok(mb < BUDGET_MB.srp, `first load ${mb.toFixed(1)} MB exceeds ${BUDGET_MB.srp} MB`);
    await ctx.close();
  });
  await test(`${vp}: suite navigation Chord Rider -> Song Rider -> Chord Rider`, async () => {
    const { ctx, page, errors } = await open(vp, '/index.html');
    await Promise.all([page.waitForNavigation(), page.click('#songRiderModeBtn')]);
    await page.waitForTimeout(1200);
    assert.match(page.url(), /song-rider/);
    const back = page.locator('[data-workspace-mode="chord-rider"], #chordRiderModeBtn, a:has-text("Chord Rider"), button:has-text("Chord Rider")').first();
    await Promise.all([page.waitForNavigation(), back.click()]);
    await page.waitForTimeout(800);
    assert.doesNotMatch(page.url(), /song-rider/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

await test('every skin renders both apps without errors or overflow (phone + desktop)', async () => {
  const problems = [];
  for (const skin of SKINS) for (const vp of Object.keys(VIEWPORTS)) for (const path of ['/index.html', '/song-rider/index.html?crpMode=1']) {
    const { ctx, page, errors } = await open(vp, path, { skin });
    const applied = await page.evaluate(() => document.documentElement.dataset.skinChoice || document.body?.dataset?.skinChoice || '');
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    if (errors.length) problems.push(`${skin} ${vp} ${path}: ${errors[0]}`);
    if (sw > iw + 1) problems.push(`${skin} ${vp} ${path}: overflow ${sw}>${iw}`);
    if (applied && applied !== skin) problems.push(`${skin} ${vp} ${path}: skin not applied (${applied})`);
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});

await test('the manual opens from the banner on both apps and reads well on phone and desktop', async () => {
  for (const path of ['/index.html', '/song-rider/index.html?crpMode=1']) {
    const { ctx, page } = await open('phone', path);
    const href = await page.locator('.suite-master-header a.srs-manual-link').getAttribute('href');
    assert.ok(href && new URL(href, BASE).pathname === '/manual.html', `${path}: banner link points to ${href}`);
    await ctx.close();
  }
  for (const vp of Object.keys(VIEWPORTS)) {
    const { ctx, page, errors } = await open(vp, '/manual.html');
    assert.deepEqual(errors, []);
    await noOverflow(page);
    assert.match(await page.title(), /Manual/);
    // Every contents link and in-page link lands on a section that exists.
    const missing = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).filter(h => h.length > 1 && !document.getElementById(h.slice(1))));
    assert.deepEqual(missing, []);
    await ctx.close();
  }
});

await test('after one online visit, both apps open offline (service worker)', async () => {
  const ctx = await browser.newContext({ ...VIEWPORTS.phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Wait until the install step has precached Song Rider's page.
  await page.waitForFunction(async () => {
    for (const k of await caches.keys()) if (await (await caches.open(k)).match('/song-rider/index.html')) return true;
    return false;
  }, null, { timeout: 30000 });
  await ctx.setOffline(true);
  await page.reload();
  assert.ok(await page.locator('#songRiderModeBtn').isVisible(), 'Chord Rider did not render offline');
  // The suite navigates to /song-rider/index.html, which the server answers with a redirect.
  await page.goto(BASE + '/song-rider/index.html?crpMode=1');
  assert.match(await page.title(), /Song Rider Pro/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
