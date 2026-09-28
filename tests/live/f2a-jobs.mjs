// F2a live checks: background jobs, cancellation and session resumption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_SKIP, jobIdIn, liveApi, liveJob, liveSetup, opcLive, report } from './_f2a-helpers.mjs';

const FILES = { 'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('live: --background + status --wait + result', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const bg = await opcLive(ctx, ['ask', '--background', '--json', '--raw-args-stdin'], {
    stdin: 'What does src/math.js export? One sentence.',
  });
  assert.equal(bg.code, 0, bg.stderr);
  const { jobId } = JSON.parse(bg.stdout);
  const waited = await opcLive(ctx, ['status', jobId, '--wait', '--timeout-ms', '600000', '--poll-interval-ms', '2000']);
  assert.equal(waited.code, 0, waited.stdout);
  const result = await opcLive(ctx, ['result', jobId]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /add/);
  report('background + status --wait + result', true, jobId);
});

test('live: cancel of a long turn', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const bg = await opcLive(ctx, ['task', '--background', '--json', '--raw-args-stdin'], {
    stdin: 'Write the numbers from 1 to 500, one per line, each followed by one full sentence about it.',
  });
  assert.equal(bg.code, 0, bg.stderr);
  const { jobId } = JSON.parse(bg.stdout);
  let job = null;
  for (let i = 0; i < 120; i += 1) {
    job = liveJob(ctx, jobId);
    if (job?.status === 'running' && job.sessionID && job.phase !== 'starting') break;
    await sleep(1000);
  }
  assert.ok(job?.sessionID, 'job started');
  const cancel = await opcLive(ctx, ['cancel', jobId, '--json']);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, 'cancelled');
  const status = await liveApi(ctx).sessionStatus();
  const own = status[job.sessionID];
  assert.ok(!own || own.type === 'idle', JSON.stringify(own));
  report('cancel long turn', true, `sessão ${job.sessionID} ociosa`);
});

test('live: --resume keeps the sessionID', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const first = await opcLive(ctx, ['ask', '--raw-args-stdin'], { stdin: 'Where is add defined?' });
  assert.equal(first.code, 0, first.stderr);
  const firstId = jobIdIn(first.stderr);
  const a = liveJob(ctx, firstId);
  const second = await opcLive(ctx, ['ask', '--raw-args-stdin'], {
    stdin: `--resume ${a.id} And what does it return?`,
  });
  assert.equal(second.code, 0, second.stderr);
  const b = liveJob(ctx, jobIdIn(second.stderr));
  assert.equal(b.sessionID, a.sessionID);
  report('resume mantém sessionID', a.sessionID);
});
