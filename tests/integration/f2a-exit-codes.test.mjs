import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_POLICY, jobIn, jobsIn, opc, setupF2a, waitFor } from '../helpers.mjs';

test('exit codes (spec §4.1): 0, 2, 3, 4, 5, 6, 7, 130', async (t) => {
  const ok = setupF2a(t, { scenario: 'ok' });
  assert.equal((await opc(ok, ['task', 'fine'])).code, 0);
  assert.equal((await opc(ok, ['task', '--bogus-flag', 'x'])).code, 2);

  const perm = setupF2a(t, { scenario: 'permission-ask' });
  assert.equal((await opc(perm, ['task', '--write', 'clean'])).code, 3);

  const denied = setupF2a(t, { scenario: 'ok', config: { policy: { ...F2A_POLICY, models: { allow: [], deny: ['omniroute-personal/*'] } } } });
  assert.equal((await opc(denied, ['task', 'x'])).code, 4);

  const auth = setupF2a(t, { scenario: 'auth-401' });
  assert.equal((await opc(auth, ['task', 'x'])).code, 5);

  const slow = setupF2a(t, { scenario: 'slow' });
  const waited = await opc(slow, ['task', '--wait-timeout', '1', 'slow']);
  assert.equal(waited.code, 6);
  assert.match(waited.stdout, /A tarefa continua \S+ após o tempo limite de espera\. Acompanhe com: \/opc:status \S+ --wait/);

  const failed = setupF2a(t, { scenario: 'session-error-event' });
  assert.equal((await opc(failed, ['task', 'x'])).code, 7);

  const cancelled = setupF2a(t, { scenario: 'slow' });
  const foreground = opc(cancelled, ['task', 'long'], { timeoutMs: 90000 });
  const job = await waitFor(() => jobsIn(cancelled.env, cancelled.cwd).find((j) => j.status === 'running' && j.sessionID), { timeoutMs: 20000, intervalMs: 100, message: 'running job' });
  assert.equal((await opc(cancelled, ['cancel', job.id])).code, 0);
  assert.equal((await foreground).code, 130);
  assert.equal(jobIn(cancelled.env, cancelled.cwd, job.id).status, 'cancelled');
});
