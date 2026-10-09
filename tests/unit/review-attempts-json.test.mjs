import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { createJob, readJob, runJobTurn, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { run as resultCommand } from '../../plugins/opc/scripts/commands/result.mjs';
import * as reviewCommand from '../../plugins/opc/scripts/commands/review.mjs';
import { ExitCode } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const validReview = { verdict: 'approve', summary: 'Looks good.', findings: [], next_steps: [] };

test('reviewExitCode rejects completed reviews without valid JSON and preserves other statuses', () => {
  for (const structured of [null, { verdict: 'approve' }, validReview]) {
    const job = { status: 'completed', result: { structured, finalText: 'prose' } };
    const expected = structured === validReview ? ExitCode.OK : ExitCode.JOB_FAILED;
    assert.equal(reviewCommand.reviewExitCode(job), expected);
    assert.equal(reviewCommand.emitReviewResult({ out: () => {}, json: () => {} }, job, { json: true }), expected);
  }
  for (const [status, expected] of [
    ['waiting_permission', ExitCode.WAITING], ['failed', ExitCode.JOB_FAILED],
    ['cancelled', ExitCode.CANCELLED], ['running', ExitCode.OK],
  ]) assert.equal(reviewCommand.reviewExitCode({ status, result: { structured: validReview } }), expected);
});

for (const variant of ['review', 'adversarial']) {
  for (const [label, structured, expected] of [
    ['missing JSON', null, ExitCode.JOB_FAILED], ['invalid JSON', { verdict: 'approve' }, ExitCode.JOB_FAILED],
    ['valid JSON', validReview, ExitCode.OK],
  ]) {
    test(`result of ${variant} with ${label} exits like the foreground`, async (t) => {
      const stateDir = trackTempDir(t, makeTempDir('opc-review-contract-'));
      const job = await createJob(stateDir, { kind: 'review', request: { variant } });
      const terminal = await updateJob(stateDir, job.id, { status: 'completed', result: { structured, finalText: 'prose' } });
      for (const argv of [[job.id], [job.id, '--json']]) {
        const ctx = { stateDir, out: () => {}, json: () => {} };
        assert.equal(await resultCommand(ctx, argv), expected);
        assert.equal(reviewCommand.emitReviewResult(ctx, terminal, { json: argv.includes('--json') }), expected);
      }
    });
  }
}

for (const command of ['result', 'review']) {
  test(`F4a I3: ${command} JSON includes masked review fallback attempts`, async (t) => {
    const stateDir = trackTempDir(t, makeTempDir('opc-review-attempts-'));
    const candidates = ['first', 'second'].map((modelID) => ({ providerID: 'p', modelID, full: `p/${modelID}` }));
    const job = await createJob(stateDir, { kind: 'review', request: { candidates, fallbackEligible: true } });
    const secretLike = ['sk', 'proj', 'a'.repeat(24)].join('-');
    await runJobTurn({ stateDir, job, baseTurnRequest: { model: candidates[0] }, backoffMs: [0],
      runTurnImpl: async ({ request }) => request.model.modelID === 'first'
        ? { status: 'failed', errorClass: 'recoverable', errorType: `APIError ${secretLike}`, sessionID: 'ses_first' }
        : { status: 'completed', sessionID: 'ses_second' },
    });
    await updateJob(stateDir, job.id, { status: 'completed', result: { structured: null } });
    let payload;
    const ctx = { stateDir, json: (value) => { payload = value; } };
    if (command === 'result') await resultCommand(ctx, [job.id, '--json']);
    else reviewCommand.emitReviewResult(ctx, readJob(stateDir, job.id), { json: true });
    assert.equal(payload.attempts?.length, 2);
    assert.deepEqual(payload.attempts, readJob(stateDir, job.id).attempts);
    assert.equal(JSON.stringify(payload).includes(secretLike), false);
  });
}
