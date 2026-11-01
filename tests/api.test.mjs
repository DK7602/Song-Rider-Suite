// API contract tests. Run against a local `wrangler dev` (see tests/README.md):
//   BASE_URL=http://127.0.0.1:8787 node tests/api.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const INVITE = process.env.INVITE_CODE || 'test-invite';
let failures = 0, passes = 0;

class Client {
  constructor() { this.cookie = ''; }
  async req(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) { const m = set.match(/crp_session=([^;]*)/); if (m) this.cookie = m[1] ? `crp_session=${m[1]}` : ''; }
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
}

async function test(name, fn) {
  try { await fn(); passes++; console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const uniq = () => Math.random().toString(36).slice(2, 10);
async function newUser() {
  const c = new Client(), email = `user-${uniq()}@example.com`;
  const r = await c.req('/api/auth/register', { method: 'POST', body: { email, password: 'correct-horse', inviteCode: INVITE } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.email = email;
  return c;
}

console.log(`API tests against ${BASE}`);

await test('health', async () => {
  const r = await new Client().req('/api/health');
  assert.equal(r.status, 200); assert.equal(r.data.ok, true);
});

await test('register requires invite code', async () => {
  const r = await new Client().req('/api/auth/register', { method: 'POST', body: { email: `x-${uniq()}@example.com`, password: 'correct-horse', inviteCode: 'nope' } });
  assert.equal(r.status, 403);
});

await test('login works and wrong password is rejected', async () => {
  const a = await newUser(), c = new Client();
  assert.equal((await c.req('/api/auth/login', { method: 'POST', body: { email: a.email, password: 'wrong-pass' } })).status, 401);
  const ok = await c.req('/api/auth/login', { method: 'POST', body: { email: a.email, password: 'correct-horse' } });
  assert.equal(ok.status, 200); assert.equal((await c.req('/api/auth/me')).data.user.email, a.email);
});

await test('login is throttled after repeated failures', async () => {
  const a = await newUser(), c = new Client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.req('/api/auth/login', { method: 'POST', body: { email: a.email, password: 'bad-password' } });
  assert.equal(last.status, 429, `expected 429, got ${last.status}`);
  const stillBlocked = await c.req('/api/auth/login', { method: 'POST', body: { email: a.email, password: 'correct-horse' } });
  assert.equal(stillBlocked.status, 429, 'correct password must also wait out the lockout');
});

await test('unauthenticated project access is refused', async () => {
  assert.equal((await new Client().req('/api/projects')).status, 401);
});

await test('CRP save returns a rev and GET reports it', async () => {
  const a = await newUser(), id = `p-${uniq()}`;
  const s = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'Song A', rows: [] }, baseRev: 0 } });
  assert.equal(s.status, 200, JSON.stringify(s.data)); assert.ok(s.data.rev > 0); assert.equal(s.data.project.rev, s.data.rev);
  const g = await a.req('/api/projects');
  const p = g.data.projects.find(x => x.id === id); assert.ok(p); assert.equal(p.rev, s.data.rev); assert.ok(Array.isArray(g.data.deleted));
});

await test('CRP stale save gets 409 conflict with the server copy', async () => {
  const a = await newUser(), id = `p-${uniq()}`;
  const first = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'v1' }, baseRev: 0 } });
  const second = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'v2 (phone)' }, baseRev: first.data.rev } });
  assert.equal(second.status, 200);
  const stale = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'v2 (old tablet)' }, baseRev: first.data.rev } });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'conflict'); assert.equal(stale.data.project.name, 'v2 (phone)'); assert.equal(stale.data.project.rev, second.data.rev);
  const forced = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'kept mine' }, baseRev: first.data.rev, force: true } });
  assert.equal(forced.status, 200); assert.ok(forced.data.rev > second.data.rev);
});

await test('CRP revs are strictly increasing even within the same millisecond', async () => {
  const a = await newUser(), id = `p-${uniq()}`;
  let rev = 0;
  for (let i = 0; i < 5; i++) { const r = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: `n${i}` }, baseRev: rev } }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.rev > rev); rev = r.data.rev; }
});

await test('CRP legacy save without baseRev still works (old cached builds)', async () => {
  const a = await newUser(), id = `p-${uniq()}`;
  assert.equal((await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'one' } } })).status, 200);
  assert.equal((await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'two' } } })).status, 200);
});

await test('CRP id owned by another account is a 409, never a silent "ok"', async () => {
  const a = await newUser(), b = await newUser(), id = `p-${uniq()}`;
  assert.equal((await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'A song' } } })).status, 200);
  const r = await b.req('/api/projects', { method: 'POST', body: { project: { id, name: 'B overwrite attempt' } } });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'id_taken');
  const still = (await a.req('/api/projects')).data.projects.find(x => x.id === id);
  assert.equal(still.name, 'A song');
  assert.equal((await b.req('/api/projects')).data.projects.length, 0);
});

await test('CRP delete leaves a tombstone and stale re-uploads are refused', async () => {
  const a = await newUser(), id = `p-${uniq()}`;
  const s = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'doomed' }, baseRev: 0 } });
  const d = await a.req(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(d.status, 200); assert.ok(d.data.deletedAt > 0);
  const g = await a.req('/api/projects');
  assert.ok(!g.data.projects.some(x => x.id === id)); assert.ok(g.data.deleted.some(x => x.id === id));
  const zombie = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'zombie' }, baseRev: s.data.rev } });
  assert.equal(zombie.status, 409); assert.equal(zombie.data.code, 'deleted');
  const restored = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'restored on purpose' }, baseRev: s.data.rev, force: true } });
  assert.equal(restored.status, 200);
  assert.ok(!(await a.req('/api/projects')).data.deleted.some(x => x.id === id), 'tombstone cleared after deliberate restore');
});

await test('CRP rename honours baseRev', async () => {
  const a = await newUser(), id = `p-${uniq()}`;
  const s = await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'old' }, baseRev: 0 } });
  const r1 = await a.req(`/api/projects/${id}`, { method: 'PATCH', body: { name: 'new', baseRev: s.data.rev } });
  assert.equal(r1.status, 200); assert.ok(r1.data.rev > s.data.rev);
  const r2 = await a.req(`/api/projects/${id}`, { method: 'PATCH', body: { name: 'stale', baseRev: s.data.rev } });
  assert.equal(r2.status, 409);
});

await test('SRP save returns rev; stale save gets 409 with server copy', async () => {
  const a = await newUser(), id = `s-${uniq()}`;
  const s1 = await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'Lyrics', data: { id, name: 'Lyrics', sections: { 'PAGE 1': [] } } }, baseRev: 0 } });
  assert.equal(s1.status, 200, JSON.stringify(s1.data)); assert.ok(s1.data.rev > 0);
  const s2 = await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'Lyrics v2', data: { id, name: 'Lyrics v2' } }, baseRev: s1.data.rev } });
  assert.equal(s2.status, 200); assert.ok(s2.data.rev > s1.data.rev);
  const stale = await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'stale', data: { id, name: 'stale' } }, base_rev: s1.data.rev } });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'conflict'); assert.equal(stale.data.project.name, 'Lyrics v2'); assert.equal(stale.data.project.rev, s2.data.rev);
  const list = await a.req('/api/srp/projects');
  assert.equal(list.data.projects.find(p => p.project_id === id).rev, s2.data.rev);
});

await test('SRP delete bumps rev; stale edit cannot resurrect it', async () => {
  const a = await newUser(), id = `s-${uniq()}`;
  const s1 = await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'Gone', data: { id } }, baseRev: 0 } });
  const del = await a.req(`/api/srp/projects/${id}?baseRev=${s1.data.rev}`, { method: 'DELETE' });
  assert.equal(del.status, 200); assert.ok(del.data.rev > s1.data.rev);
  const zombie = await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'zombie', data: { id } }, baseRev: s1.data.rev } });
  assert.equal(zombie.status, 409); assert.equal(zombie.data.code, 'deleted');
  const row = (await a.req('/api/srp/projects')).data.projects.find(p => p.project_id === id);
  assert.equal(row.deleted, true);
});

await test('SRP delete of a song edited elsewhere is refused unless forced', async () => {
  const a = await newUser(), id = `s-${uniq()}`;
  const s1 = await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'A', data: { id } }, baseRev: 0 } });
  await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'B', data: { id } }, baseRev: s1.data.rev } });
  assert.equal((await a.req(`/api/srp/projects/${id}?baseRev=${s1.data.rev}`, { method: 'DELETE' })).status, 409);
  assert.equal((await a.req(`/api/srp/projects/${id}?baseRev=${s1.data.rev}&force=1`, { method: 'DELETE' })).status, 200);
});

await test('SRP legacy save without baseRev still works', async () => {
  const a = await newUser(), id = `s-${uniq()}`;
  assert.equal((await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'x', data: { id } } } })).status, 200);
  assert.equal((await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'y', data: { id } } } })).status, 200);
});

await test('SRP media is scoped to the owner and rejects traversal', async () => {
  const a = await newUser(), b = await newUser(), id = `s-${uniq()}`;
  await a.req('/api/srp/projects', { method: 'POST', body: { project: { project_id: id, name: 'm', data: { id } } } });
  const me = (await a.req('/api/auth/me')).data.user.id;
  const key = `${me}/${id}/take.mp3`;
  const put = await fetch(`${BASE}/api/srp/media?projectId=${id}&path=${encodeURIComponent(key)}`, { method: 'PUT', headers: { Cookie: a.cookie, 'Content-Type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3]) });
  assert.equal(put.status, 200);
  const get = await fetch(`${BASE}/api/srp/media?projectId=${id}&path=${encodeURIComponent(key)}`, { headers: { Cookie: a.cookie } });
  assert.equal(get.status, 200); assert.equal((await get.arrayBuffer()).byteLength, 3);
  const other = await fetch(`${BASE}/api/srp/media?projectId=${id}&path=${encodeURIComponent(key)}`, { headers: { Cookie: b.cookie } });
  assert.equal(other.status, 404);
  const trav = await fetch(`${BASE}/api/srp/media?projectId=${id}&path=${encodeURIComponent(`${me}/${id}/../x/take.mp3`)}`, { headers: { Cookie: a.cookie } });
  assert.equal(trav.status, 403);
});

await test('vocal audio requires owning the CRP project', async () => {
  const a = await newUser(), b = await newUser(), id = `p-${uniq()}`;
  await a.req('/api/projects', { method: 'POST', body: { project: { id, name: 'vox' } } });
  const put = await fetch(`${BASE}/api/audio/take1?projectId=${id}`, { method: 'PUT', headers: { Cookie: a.cookie, 'Content-Type': 'audio/wav' }, body: new Uint8Array(64) });
  assert.equal(put.status, 200);
  const steal = await fetch(`${BASE}/api/audio/take1?projectId=${id}`, { headers: { Cookie: b.cookie } });
  assert.equal(steal.status, 404);
});

await test('logout ends the session', async () => {
  const a = await newUser();
  assert.equal((await a.req('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await a.req('/api/projects')).status, 401);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
