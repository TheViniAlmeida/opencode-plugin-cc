import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { appendSafeOutput, assertModelRouting, assertEndpointCoverage, compareShapes, assertIntervalsOverlap } from '../live/_f3-lib.mjs';

test('F3 live report writer masks token patterns and registered secrets before writing', (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-f3-report-'));
  const file = join(dir, 'report.md');
  const token = ['sk', 'proj', '1234567890abcdefghijklmnopqrstuvwxyz'].join('-'); // built at runtime: no token literal in the repo
  const secret = 'registered-f3-secret-123';
  registerSecret(secret);
  appendSafeOutput(file, `token=${token} secret=${secret} paths=${dir} home=${homedir()}`, dir);
  const written = readFileSync(file, 'utf8');
  assert.ok(!written.includes(token));
  assert.ok(!written.includes(secret));
  assert.match(written, /<tmp>/);
  assert.match(written, /~/);
});

test('F3 model routing validates three distinct models or reports the actual distinct count', () => {
  const routed = (models) => models.map((model, i) => ({ model, index: i }));
  assert.equal(assertModelRouting(routed(['p/a', 'p/b', 'p/c']), ['p/a', 'p/b', 'p/c']), 'rotas distintas: 3 (três modelos PASSOU)');
  assert.equal(assertModelRouting(routed(['p/a', 'p/b', 'p/a']), ['p/a', 'p/b', 'p/a']), 'rotas distintas: 2 (três modelos NÃO VALIDADO)');
  assert.throws(() => assertModelRouting(routed(['p/a', 'p/a', 'p/c']), ['p/a', 'p/b', 'p/c']), /member.*model/i);
});

test('F3 shape comparison covers every endpoint and explains unavailable todos', () => {
  const endpoints = ['session', 'fork', 'reverted', 'unreverted', 'message', 'diff', 'todo', 'command', 'summarized'];
  const real = Object.fromEntries(endpoints.map((key) => [key, { id: key }]));
  const fake = Object.fromEntries(endpoints.map((key) => [key, { id: key }]));
  real.todo = null;
  const result = compareShapes(real, fake, Object.fromEntries(endpoints.map((key) => [key, ['id']])));
  assertEndpointCoverage(result, endpoints);
  assert.ok(result.notApplicable.some((entry) => entry.endpoint === 'todo' && /real.*no todos/i.test(entry.reason)));
  const missing = { ...result, compared: result.compared.filter((key) => key !== 'command') };
  assert.throws(() => assertEndpointCoverage(missing, endpoints), /coverage/i);
});

test('F3 overlap helper requires actual interval intersection', () => {
  assert.equal(assertIntervalsOverlap([
    { startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:10.000Z' },
    { startedAt: '2026-01-01T00:00:05.000Z', completedAt: '2026-01-01T00:00:15.000Z' },
  ]), 2);
  assert.throws(() => assertIntervalsOverlap([
    { startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:04.000Z' },
    { startedAt: '2026-01-01T00:00:05.000Z', completedAt: '2026-01-01T00:00:15.000Z' },
  ]), /overlap/i);
});
