import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { main } from '../../plugins/opc/scripts/opc-companion.mjs';
import { createJob, consumeJobInput, readJob, updateJob, appendJobLog, readJobProgress } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { run as status } from '../../plugins/opc/scripts/commands/status.mjs';
import { run as result } from '../../plugins/opc/scripts/commands/result.mjs';
import { buildReviewPrompt, runReviewCommand } from '../../plugins/opc/scripts/commands/review.mjs';
import { renderReview, validateReviewOutput } from '../../plugins/opc/scripts/lib/render.mjs';
import { makeTempDir, trackTempDir, scriptedTTY, COMPANION } from '../helpers.mjs';

const valid = { verdict: 'approve', summary: 'Tudo certo.', findings: [], next_steps: [] };
const token = () => ['ghp', 'x'.repeat(32)].join('_');
const temp = (t) => trackTempDir(t, makeTempDir('opc-gate-fix-'));

for (const hook of ['hook-session-start', 'hook-session-end', 'hook-stop']) {
  test(`${hook} allows invalid workspace config during preparation`, async (t) => {
    const cwd = temp(t);
    fs.writeFileSync(path.join(cwd, '.opc.json'), '{invalid');
    let stdout = '', stderr = '';
    const code = await main([hook], { cwd, env: { ...process.env, OPC_DATA_DIR: cwd }, stdin: Readable.from(['{}']),
      stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } });
    assert.equal(code, 0);
    if (hook === 'hook-stop') {
      const { systemMessage } = JSON.parse(stdout);
      assert.match(systemMessage, /permit|ignorado/);
      assert.match(systemMessage, /\((CONFIG_INVALID|INVALID_JSON)[^)]*\)/, 'the preparation failure names its cause');
      assert.match(stderr, /CONFIG_INVALID|INVALID_JSON/);
    }
    else assert.equal(stdout, '');
    if (hook === 'hook-session-start') assert.equal(stderr.trim().split('\n').length, 1);
  });
}

test('job record and status contain metadata only; worker input stays private', async (t) => {
  const stateDir = temp(t);
  const diff = `diff --git a/app.js b/app.js\n+const value = "${token()}";`;
  const request = { kind: 'review', profileKind: 'read-only', title: 'OPC: review', model: { providerID: 'p', modelID: 'm' },
    parts: [{ type: 'text', text: diff }], review: { focus: diff }, format: { type: 'json_schema', schema: { description: diff } } };
  const job = await createJob(stateDir, { kind: 'review', summary: `${token()} ${'x'.repeat(250)}`, request });
  const record = fs.readFileSync(path.join(stateDir, 'jobs', `${job.id}.json`), 'utf8');
  assert.equal(record.includes(diff), false);
  assert.equal(record.includes(token()), false);
  assert.equal(JSON.stringify(job).includes(diff), false);
  assert.equal(readJob(stateDir, job.id).request.parts, undefined);
  assert.equal(readJob(stateDir, job.id).request.format.schema, undefined);
  assert.ok(readJob(stateDir, job.id).summary.length <= 200);
  let output;
  await status({ stateDir, json: (value) => { output = JSON.stringify(value); } }, [job.id, '--json']);
  assert.equal(output.includes(token()), false);
  assert.equal(output.includes('diff --git'), false);
  assert.deepEqual(consumeJobInput(stateDir, job.id), request);
});

test('review prompt masks patterns from a changed ordinary file', (t) => {
  const cwd = temp(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
  fs.writeFileSync(path.join(cwd, 'app.js'), `const value = '${token()}';\n`);
  return import('../../plugins/opc/scripts/lib/git.mjs').then(({ collectReviewContext }) => {
    const context = collectReviewContext(cwd, { mode: 'working-tree' });
    assert.ok(context.content.includes(token()));
    const prompt = buildReviewPrompt({ variant: 'review', target: { label: 'alterações' }, context });
    assert.equal(prompt.includes(token()), false);
    assert.ok(prompt.includes('***'));
  });
});

test('final text and structured strings are masked in records, logs and rendering', async (t) => {
  const stateDir = temp(t);
  const job = await createJob(stateDir, { kind: 'review' });
  await updateJob(stateDir, job.id, { status: 'completed', result: { finalText: token(), structured: { ...valid, summary: token() } } });
  appendJobLog(stateDir, job.id, token(), { modelDerived: true });
  assert.equal(JSON.stringify(readJob(stateDir, job.id)).includes(token()), false);
  assert.equal(JSON.stringify(readJobProgress(stateDir, job.id)).includes(token()), false);
  let output;
  await result({ stateDir, json: (value) => { output = JSON.stringify(value); } }, [job.id, '--json']);
  assert.equal(output.includes(token()), false);
  assert.equal(renderReview({ status: 'completed', structured: { ...valid, summary: token() } }).includes(token()), false);
});

test('review rejects focus above 16 KB before collection or connection', async () => {
  await assert.rejects(runReviewCommand({ stdin: Readable.from([]), cwd: '/missing' }, ['é'.repeat(8193)], { variant: 'adversarial' }),
    (err) => err.exitCode === 2 && /16.*KB/.test(err.message));
});

test('complete review prompt budget includes project, focus and template', async (t) => {
  const cwd = temp(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
  // Keep each untracked file below the independent 24 KiB read limit.
  for (let i = 0; i < 19; i += 1) fs.writeFileSync(path.join(cwd, `file-${i}.txt`), 'changed line\n'.repeat(1600));
  const { collectReviewContext } = await import('../../plugins/opc/scripts/lib/git.mjs');
  const initial = collectReviewContext(cwd, { mode: 'working-tree' });
  assert.equal(initial.truncated, false, 'the repository context alone fits');
  const { collectReviewPrompt } = await import('../../plugins/opc/scripts/commands/review.mjs');
  const { prompt, context } = collectReviewPrompt(cwd, { variant: 'adversarial', target: { mode: 'working-tree', label: 'alterações' }, focus: 'é'.repeat(8000), project: { goal: 'x'.repeat(20000) } });
  assert.ok(Buffer.byteLength(prompt) <= 400 * 1024);
  assert.ok(context.truncated);
  assert.match(prompt, /Arquivos omitidos/);
  assert.ok(prompt.includes('é'.repeat(8000)));
  assert.ok(prompt.includes('x'.repeat(20000)));
});

test('unknown review severity is invalid and degrades rendering', () => {
  const structured = { ...valid, findings: [{ severity: 'blocker', title: 'Falha', body: 'Detalhe', file: 'a.js', line_start: 1, line_end: 1, confidence: 1, recommendation: '' }] };
  assert.match(validateReviewOutput(structured), /severity/);
  assert.match(renderReview({ status: 'completed', structured }), /não retornou uma saída estruturada válida/);
});

test('SessionEnd bounds git even before its watchdog', (t) => {
  const cwd = temp(t);
  fs.writeFileSync(path.join(cwd, 'git'), '#!/bin/sh\nexec /bin/sleep 3\n', { mode: 0o700 });
  const start = performance.now();
  const res = spawnSync(process.execPath, [COMPANION, 'hook-session-end'], { cwd, env: { ...process.env, PATH: cwd, OPC_DATA_DIR: cwd }, input: '{}', encoding: 'utf8', timeout: 2000 });
  assert.equal(res.status, 0);
  assert.ok(performance.now() - start < 1000);
});

test('ported files keep literal attribution and PT-BR instructions', () => {
  for (const name of ['agents/opc-rescue.md', 'skills/opc-runtime/SKILL.md', 'skills/opc-result-handling/SKILL.md', 'commands/review.md', 'commands/adversarial-review.md', 'commands/rescue.md']) {
    const text = fs.readFileSync(new URL(`../../plugins/opc/${name}`, import.meta.url), 'utf8');
    assert.ok(text.includes('Adapted from openai/codex-plugin-cc (Apache-2.0); modified'), name);
    assert.doesNotMatch(text, /If the arguments|only when the user|<optional runtime|<task text exactly/);
  }
});

test('review estimate failure never delegates git with user base to Bash', () => {
  for (const name of ['review', 'adversarial-review']) {
    const text = fs.readFileSync(new URL(`../../plugins/opc/commands/${name}.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /git diff --shortstat <base>/);
    assert.match(text, /Se a estimativa falhar[^\n]*companion/);
  }
});

test('complete prompt budget shrinks collector allowance by actual template overhead', async () => {
  const { collectReviewPrompt } = await import('../../plugins/opc/scripts/commands/review.mjs');
  const allowances = [];
  const { prompt, context } = collectReviewPrompt('/unused', { variant: 'adversarial', target: { label: 'alterações' }, focus: 'é'.repeat(8000), project: { goal: 'g'.repeat(20000) } }, {
    collectContext: (_cwd, _target, { maxInlineBytes }) => {
      allowances.push(maxInlineBytes);
      return { summary: 'resumo', guidance: 'instrução', content: 'd'.repeat(maxInlineBytes), truncated: false };
    },
  });
  assert.equal(allowances.length, 2);
  assert.equal(context.truncated, true);
  assert.ok(allowances[1] < allowances[0] - 36000);
  assert.ok(Buffer.byteLength(prompt) <= 400 * 1024);
  assert.ok(prompt.includes('g'.repeat(20000)));
  assert.ok(prompt.includes('é'.repeat(8000)));
});

test('review prompt masks registered and pattern secrets before any request', async () => {
  const { registerSecret } = await import('../../plugins/opc/scripts/lib/redact.mjs');
  registerSecret('fake-registered-review-value');
  const prompt = buildReviewPrompt({ variant: 'review', target: { label: 'alterações' }, context: {
    summary: 'resumo', guidance: 'instrução', content: `+const value = '${token()}';\n+const other = 'fake-registered-review-value';`,
  } });
  assert.equal(prompt.includes(token()), false);
  assert.equal(prompt.includes('fake-registered-review-value'), false);
});

test('SessionEnd bounds both workspace resolutions and preserves time to spawn reaper', async (t) => {
  const { run: end } = await import('../../plugins/opc/scripts/commands/hook-session-end.mjs');
  const cwd = temp(t);
  const other = path.join(cwd, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(cwd, 'git'), '#!/bin/sh\nexec /bin/sleep 3\n', { mode: 0o700 });
  let spawned = false;
  const start = performance.now();
  const code = await main(['hook-session-end'], { cwd, env: { ...process.env, PATH: cwd, OPC_DATA_DIR: cwd },
    stdin: Readable.from([JSON.stringify({ session_id: 'session-test', cwd: other })]), stdout: { write() {} }, stderr: { write() {} },
    commandLoader: async () => ({ run: (ctx, argv) => end(ctx, argv, { spawnDetachedFn: async () => { spawned = true; } }) }),
  });
  assert.equal(code, 0);
  assert.ok(spawned, 'slow git falls back to hook cwd rather than abandoning cleanup');
  assert.ok(performance.now() - start < 1000);
});


test('job persistence and logs preserve opc messages while masking model fields', async (t) => {
  const stateDir = temp(t);
  const message = `Exemplo de configuração: ${token()}`;
  // F3 gate (C2): error fields can carry provider text, so token-like values are masked there;
  // opc's own wording without token-like values stays verbatim (F2b ruling on over-broad masking).
  const opcMessage = 'LOCKED_KEY: --tty-confirm exige um terminal; UNKNOWN_KEY: chave desconhecida';
  const job = await createJob(stateDir, { kind: 'review' });
  await updateJob(stateDir, job.id, { status: 'failed', errorMessage: opcMessage,
    result: { errorMessage: message, finalText: token(), structured: { ...valid, summary: token() } } });
  const record = readJob(stateDir, job.id);
  assert.equal(record.errorMessage, opcMessage);
  assert.equal(record.result.errorMessage, 'Exemplo de configuração: ***');
  assert.equal(record.result.finalText, '***');
  assert.equal(record.result.structured.summary, '***');
  appendJobLog(stateDir, job.id, message);
  assert.ok(JSON.stringify(readJobProgress(stateDir, job.id)).includes(message));
});

test('complete prompt marks an unchanged context as not truncated', async () => {
  const { collectReviewPrompt } = await import('../../plugins/opc/scripts/commands/review.mjs');
  let calls = 0;
  const { prompt, context } = collectReviewPrompt('/unused', { variant: 'review', target: { label: 'alterações' } }, {
    collectContext: () => { calls += 1; return { summary: 'resumo', content: 'diff pequeno', guidance: 'instrução', truncated: false }; },
  });
  assert.equal(calls, 1);
  assert.equal(context.truncated, false);
  assert.ok(Buffer.byteLength(prompt) <= 400 * 1024);
});

for (const [name, args, expectedCode, expectedText, answers] of [
  ['locked key without a TTY', ['set', 'policy.approver', 'claude', '--tty-confirm'], 4, /LOCKED_KEY: --tty-confirm exige um terminal interativo/],
  ['locked key with mismatched confirmation', ['set', 'policy.approver', 'claude', '--tty-confirm'], 4, /LOCKED_KEY: a confirmação não correspondeu; nada foi alterado/, ['policy.aprover']],
  ['unknown config key', ['get', 'unknown.setting'], 2, /UNKNOWN_KEY: chave de configuração desconhecida/],
  ['config usage', [], 2, /uso: opc config/],
]) {
  test(`config diagnostics preserve opc prose: ${name}`, async (t) => {
    const cwd = temp(t);
    const dataDir = path.join(cwd, 'data');
    let stdout = '', stderr = '';
    const code = await main(['config', ...args], { cwd, env: { ...process.env, OPC_DATA_DIR: dataDir },
      stdin: answers ? scriptedTTY(answers) : Readable.from([]),
      stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } });
    assert.equal(code, expectedCode);
    assert.match(stderr, expectedText);
    assert.equal(stdout, '');
    assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.opc.json')), false);
  });
}
