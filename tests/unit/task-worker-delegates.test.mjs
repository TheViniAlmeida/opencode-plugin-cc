import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { delegateWorker } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { createGroup, readJob, listGroupMembers } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { runWorker } from '../../plugins/opc/scripts/commands/subagent.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

function state(t) {
  const dir = trackTempDir(t, makeTempDir('opc-delegate-'));
  ensurePrivateDir(dir);
  return dir;
}

test('delegated workers consume private group input and pass it as the third runWorker argument', async (t) => {
  const stateDir = state(t);
  const request = { prompt: 'private prompt', members: [{ agent: 'general' }] };
  const { group } = await createGroup(stateDir, { kind: 'sub', request }, [{ title: 'member' }]);
  let received;
  await delegateWorker({ stateDir }, group, {
    loadDelegate: async () => ({ runWorker: async (...args) => { received = args; return 0; } }),
  });
  assert.deepEqual(received, [{ stateDir }, group, request]);
  assert.deepEqual(readdirSync(join(stateDir, 'jobs')).filter((name) => name.endsWith('.input.json')), []);
});

test('missing delegated input fails the group and active members with a masked error', async (t) => {
  const stateDir = state(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub' }, [{ title: 'member' }]);
  const code = await delegateWorker({ stateDir }, group, { loadDelegate: async () => ({ runWorker: async () => 0 }) });
  assert.notEqual(code, 0);
  assert.equal(readJob(stateDir, group.id).status, 'failed');
  assert.equal(listGroupMembers(stateDir, group.id)[0].status, 'failed');
  assert.ok(readJob(stateDir, members[0].id).completedAt);
  assert.match(readJob(stateDir, group.id).errorMessage, /entrada privada/);
});

test('coordinator bridge setup rejection fails and logs the member lane', async (t) => {
  const stateDir = state(t);
  const spec = { agent: 'general', full: 'provider/model', model: { providerID: 'provider', modelID: 'model' } };
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'group' }, [{ title: 'member' }]);
  const ctx = { stateDir, config: { policy: {} } };
  const code = await runWorker(ctx, group, { prompt: 'p', members: [spec], maxParallel: 1, profile: 'read-only', rules: [], mechanism: 'child-session' }, {
    openApi: async () => ({ api: { createSession: async () => ({ id: 'ses_parent' }) }, hub: {}, close() {} }),
    createBridge: () => { throw new Error('bridge setup failed Bearer abcdefghijklmnop'); },
  });
  assert.equal(code, 7);
  const member = readJob(stateDir, members[0].id);
  assert.equal(member.status, 'failed');
  assert.ok(member.completedAt);
  const log = readFileSync(join(stateDir, 'jobs', `${group.id}.log`), 'utf8');
  assert.match(log, /bridge setup failed/);
  assert.match(log, /failed \*\*\*/);
  assert.doesNotMatch(log, /abcdefghijklmnop/);
  assert.match(member.errorMessage, /failed \*\*\*/);
});
