import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import {
  isJobLive,
  requirePersistedJob,
  serverLockPath,
  serverLockTimeoutMs,
  turnJobRequest,
  withServerLock,
} from '../../plugins/opc/scripts/lib/jobs.mjs';
import { UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { stopServer } from '../../plugins/opc/scripts/lib/server.mjs';

const FORMAT = { type: 'json_schema', schema: { type: 'object' } };
const minimal = (fields = {}) =>
  turnJobRequest({ kind: 'stop-gate', profile: 'read-only', prompt: 'P', model: { providerID: 'p', modelID: 'm' }, modelFull: 'p/m', timeoutMs: 5, title: 'T', ...fields });

test('turnJobRequest builds the F2a request shape (D4.2) for a read-only review', () => {
  const request = turnJobRequest({
    kind: 'review', profile: 'read-only', prompt: 'PROMPT',
    model: { providerID: 'prov', modelID: 'family/model', full: 'prov/family/model' },
    modelFull: 'prov/family/model', variant: 'high', format: FORMAT, timeoutMs: 1000,
    title: 'OPC: review: x', config: { policy: { permissionTimeoutSec: 30 }, routing: { fallback: { enabled: false } } },
    extra: { review: { variant: 'review' } },
  });
  assert.equal(request.kind, 'review');
  assert.equal(request.profile, 'read-only');
  assert.equal(request.profileKind, 'read-only');
  assert.equal(request.title, 'OPC: review: x');
  assert.equal(request.sessionID, undefined);
  assert.equal(request.newSession.title, 'OPC: review: x');
  assert.deepEqual(request.newSession.permission[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.equal(request.newSession.permission.some((rule) => rule.permission === 'bash' && rule.action === 'allow'), false);
  assert.equal(request.childPermission, null);
  assert.deepEqual(request.parts, [{ type: 'text', text: 'PROMPT' }]);
  assert.deepEqual(request.model, { providerID: 'prov', modelID: 'family/model' });
  assert.equal(request.modelFull, 'prov/family/model');
  assert.equal(request.variant, 'high');
  assert.equal(request.agent, null);
  assert.deepEqual(request.format, FORMAT);
  assert.match(request.messageID, /^msg/);
  assert.equal(request.timeoutMs, 1000);
  assert.deepEqual(request.fallbackCfg, { enabled: false });
  assert.equal(request.permissionTimeoutMs, 30000);
  assert.deepEqual(request.review, { variant: 'review' });
});

test('turnJobRequest defaults optional fields and config-derived values', () => {
  const request = minimal();
  assert.equal(request.variant, null);
  assert.equal(request.agent, null);
  assert.equal(request.format, null);
  assert.deepEqual(request.fallbackCfg, {});
  assert.equal(request.permissionTimeoutMs, 600000);
  assert.notEqual(minimal().messageID, request.messageID);
});

test('turnJobRequest resumes a session and keeps rules for children of a write profile', () => {
  const request = minimal({ profile: 'write', sessionID: 'ses_abc', config: {} });
  assert.equal(request.sessionID, 'ses_abc');
  assert.equal(request.newSession, undefined);
  assert.equal(request.profileKind, 'write');
  assert.ok(Array.isArray(request.childPermission) && request.childPermission.length > 0);
  assert.equal(request.childPermission.some((rule) => rule.permission === '*' && rule.action === 'deny'), false);
});

test('turnJobRequest rejects every adapter-controlled extension key', () => {
  for (const key of ['profileKind', 'newSession', 'childPermission', 'permission', 'kind', 'profile', 'title', 'sessionID', 'parts', 'model', 'modelFull', 'variant', 'agent', 'format', 'messageID', 'timeoutMs', 'fallbackCfg', 'permissionTimeoutMs']) {
    assert.throws(() => minimal({ extra: { [key]: null } }), (err) => err instanceof UsageError && err.code === 'INTERNAL_FIELD_COLLISION' && err.exitCode === 2 && err.message.includes(key), key);
  }
  const loose = [{ permission: '*', pattern: '*', action: 'allow' }];
  assert.throws(() => minimal({ extra: { newSession: { permission: loose } } }), (err) => err.code === 'INTERNAL_FIELD_COLLISION' && err.message.includes('newSession'));
});

test('submitTurnJob rejects adapter-owned job fields', async () => {
  for (const key of ['kind', 'request', 'id']) {
    await assert.rejects(() => import('../../plugins/opc/scripts/lib/jobs.mjs').then(({ submitTurnJob }) => submitTurnJob({ stateDir: '/unused', config: {} }, { kind: 'review', request: {}, fields: { [key]: 'override' } })), (err) => err instanceof UsageError && err.code === 'INTERNAL_FIELD_COLLISION' && err.exitCode === 2 && err.message.includes(key), key);
  }
});

test('missing persisted job record is an exit 5 error with the job id', (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-missing-job-'));
  assert.throws(() => requirePersistedJob(stateDir, 'review-dead-beef01'), (err) => err.code === 'JOB_RECORD_MISSING' && err.exitCode === 5 && err.message.includes('review-dead-beef01'));
});

test('stopServer force confirmation is enforced through lock-held and regular entry paths', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-force-check-'));
  for (const lockHeld of [false, true]) {
    await assert.rejects(() => stopServer({ stateDir, config: {} }, { force: true, lockHeld }), (err) => err instanceof UsageError && err.code === 'CONFIRMATION_REQUIRED');
  }
});

test('isJobLive checks active status and worker loss', () => {
  const now = Date.now();
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  assert.equal(isJobLive({ id: 'review-a', status: 'queued', createdAt: at(1000) }, { now }), true);
  assert.equal(isJobLive({ id: 'review-e', status: 'queued', createdAt: at(90 * 1000) }, { now }), false);
  assert.equal(isJobLive({ id: 'review-b', status: 'queued', createdAt: at(10 * 60 * 1000) }, { now }), false);
  assert.equal(isJobLive({ id: 'review-c', status: 'completed', createdAt: at(0) }, { now }), false);
  const me = getProcessIdentity(process.pid);
  assert.equal(isJobLive({ id: 'review-d', status: 'running', pid: process.pid, pidStartTime: me.startTime, createdAt: at(0) }, { now }), false);
});

test('serverLockPath and serverLockTimeoutMs follow the spec', () => {
  assert.equal(serverLockPath('/x/state'), path.join('/x/state', 'server.lock'));
  assert.equal(serverLockTimeoutMs({ server: { bootTimeoutSec: 60 } }), 240000);
  assert.equal(serverLockTimeoutMs({}), 240000);
});

test('withServerLock waits while another owner holds server.lock', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-lock-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const ctx = { stateDir, config: { server: { bootTimeoutSec: 2 } } };
  const release = await acquireLock(serverLockPath(stateDir), { timeoutMs: 1000, purpose: 'test-holder' });
  let ran = false;
  const pending = withServerLock(ctx, async () => { ran = true; return 'done'; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(ran, false, 'fn must not run while the lock is held');
  release();
  assert.equal(await pending, 'done');
  assert.equal(ran, true);
});
