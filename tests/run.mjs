// Test runner: starts the real Worker locally (wrangler dev with simulated D1 + R2),
// applies migrations to a fresh database, runs every test file, then shuts down.
//   cd tests && npm install && npm test          # everything
//   npm run test:api | npm run test:e2e           # one group
//   BASE_URL=http://127.0.0.1:8787 node e2e/crp.test.mjs   # one file against a running server
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const group = process.argv[2] || 'all';
const port = Number(process.env.TEST_PORT || 8799);
const base = `http://127.0.0.1:${port}`;
const localBin = join(here, 'node_modules', '.bin', 'wrangler');
const wrangler = process.env.WRANGLER || (existsSync(localBin) ? localBin : 'wrangler');
const config = join(here, 'wrangler.test.jsonc');
const persist = mkdtempSync(join(tmpdir(), 'srs-test-'));

const files = [];
if (group === 'all' || group === 'api') files.push(join(here, 'api.test.mjs'));
if (group === 'all' || group === 'e2e') {
  const dir = join(here, 'e2e');
  if (existsSync(dir)) for (const f of readdirSync(dir).sort()) if (f.endsWith('.test.mjs')) files.push(join(dir, f));
}

console.log(`Applying migrations to a fresh local database (${persist})`);
const mig = spawnSync(wrangler, ['d1', 'execute', 'song-rider-suite-test-db', '--local', '--config', config, '--persist-to', persist, '--file', join(root, 'migrations', '0001_init.sql')], { cwd: root, stdio: 'inherit' });
if (mig.status !== 0) process.exit(mig.status || 1);

const server = spawn(wrangler, ['dev', '--config', config, '--persist-to', persist, '--port', String(port), '--ip', '127.0.0.1', '--log-level', 'warn'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { try { server.kill('SIGTERM'); } catch {} try { rmSync(persist, { recursive: true, force: true }); } catch {} };
process.on('exit', stop); process.on('SIGINT', () => process.exit(130));

let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  try { const r = await fetch(`${base}/api/health`); ready = r.ok; } catch {}
  if (!ready) await new Promise(r => setTimeout(r, 1000));
}
if (!ready) { console.error('Local worker did not start'); process.exit(1); }

// The instrument tests run twice: against their small fixtures, then against the real recorded library
// (assets/instruments) so every delivered set is level-checked, pitch-checked and loop-checked.
const runs = files.flatMap(f => f.endsWith('instruments.test.mjs') ? [{ f }, { f, env: { INSTRUMENT_SETS: join(root, 'assets', 'instruments') }, label: ' (recorded library)' }] : [{ f }]);
let failed = 0;
for (const { f, env = {}, label = '' } of runs) {
  console.log(`\n=== ${f.replace(root + '/', '')}${label}`);
  const r = spawnSync(process.execPath, [f], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env, BASE_URL: base } });
  if (r.status !== 0) failed++;
}
console.log(`\n${runs.length - failed}/${runs.length} test runs passed`);
process.exit(failed ? 1 : 0);
