// F2a live checks: ask and plan run with read-only permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_SKIP, jobIdIn, liveApi, liveJob, liveSetup, opcLive, report } from './_f2a-helpers.mjs';

const FILES = { 'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n' };

test('live: /opc:ask answers read-only with file:line', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const r = await opcLive(ctx, ['ask', '--raw-args-stdin'], { stdin: 'Where is the function add defined? Answer with file:line.' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /src\/math\.js/);
  const job = liveJob(ctx, jobIdIn(r.stderr));
  assert.ok(job?.sessionID, 'job has a session id');
  const session = await liveApi(ctx).getSession(job.sessionID);
  assert.deepEqual(session.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.ok(session.permissions.some((x) => x.action === 'grep' && x.resource === '*' && x.effect === 'deny'));
  assert.ok(session.permissions.some((x) => x.action === 'external_directory' && x.resource === '*' && x.effect === 'deny'));
  report('ask somente leitura', true, `sessão ${job.sessionID}`);
});

test('live: /opc:plan returns a plan read-only', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const r = await opcLive(ctx, ['plan', '--raw-args-stdin'], { stdin: 'Plan adding a sub(a, b) function to src/math.js with tests.' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /src\/math\.js/);
  const job = liveJob(ctx, jobIdIn(r.stderr));
  assert.equal(job.permissionProfile, 'read-only');
  assert.deepEqual(job.result.touchedFiles, []);
  report('plan somente leitura', true);
});
