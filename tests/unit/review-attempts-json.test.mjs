import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { createJob, readJob, runJobTurn, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { run as resultCommand } from '../../plugins/opc/scripts/commands/result.mjs';
import * as reviewCommand from '../../plugins/opc/scripts/commands/review.mjs';

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
