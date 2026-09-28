import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROMPTS_DIR,
  fillTemplate,
  loadPrompt,
  loadSchema,
  projectContextBlock,
  sessionTitle,
  summarize,
} from '../../plugins/opc/scripts/lib/prompts.mjs';

test('loadPrompt strips the leading attribution comment and accepts the name with or without .md', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-prompts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'x.md'), '<!-- Adapted from somewhere -->\n<task>\nHi {{NAME}}\n</task>\n');
  assert.equal(loadPrompt('x', { dir }), '<task>\nHi {{NAME}}\n</task>\n');
  assert.equal(loadPrompt('x.md', { dir }), '<task>\nHi {{NAME}}\n</task>\n');
  assert.match(loadPrompt('ask.md'), /\{\{USER_REQUEST\}\}/);
});

test('fillTemplate replaces in a single pass and never re-expands values', () => {
  assert.equal(fillTemplate('A={{A}} B={{B}} C={{MISSING}}', { A: '{{B}} $& $1', B: 'bee' }), 'A={{B}} $& $1 B=bee C=');
});

test('fillTemplate strict mode refuses placeholders without a value', () => {
  assert.equal(fillTemplate('A={{A}} E={{E}}', { A: 'x', E: '' }, { strict: true }), 'A=x E=');
  assert.throws(
    () => fillTemplate('A={{A}} B={{B}} C={{C}} again {{B}}', { A: 'x', C: null }, { strict: true }),
    (err) => err.code === 'TEMPLATE_UNFILLED' && err.exitCode === 7 && /B, C/.test(err.message),
  );
});

test('projectContextBlock renders only configured fields, in the F2a format', () => {
  assert.equal(projectContextBlock(null), '');
  assert.equal(projectContextBlock({ goal: '', scope: [], taskTypes: [] }), '');
  assert.equal(projectContextBlock({ goal: 'Ship it', scope: ['src/', 'tests/'], taskTypes: ['review'] }), '<project_context>\ngoal: Ship it\nscope: src/, tests/\ntask types: review\n</project_context>');
});

test('summarize and sessionTitle keep the F2a behavior', () => {
  assert.equal(summarize('  fix\n the   bug  '), 'fix the bug');
  assert.equal(summarize('x'.repeat(80)).length, 56);
  assert.equal(summarize('abcdef', 4), 'abc…');
  assert.equal(sessionTitle('review', 'working tree diff'), 'OPC: review: working tree diff');
});

test('review prompts carry every placeholder the companion fills', () => {
  const review = loadPrompt('review');
  const adversarial = loadPrompt('adversarial-review');
  for (const key of ['TARGET_LABEL', 'REVIEW_COLLECTION_GUIDANCE', 'REVIEW_INPUT', 'PROJECT_CONTEXT']) {
    assert.ok(review.includes(`{{${key}}}`), `review.md has {{${key}}}`);
    assert.ok(adversarial.includes(`{{${key}}}`), `adversarial-review.md has {{${key}}}`);
  }
  assert.ok(adversarial.includes('{{USER_FOCUS}}'));
  assert.match(adversarial, /revisão adversarial de software/);
  assert.match(review, /esquema de saída estruturada/);
  assert.match(adversarial, /esquema de saída estruturada/);
  assert.match(review, /não pode executar comandos/);
  assert.match(adversarial, /não pode executar comandos/);
});

test('stop-review-gate.md keeps the ALLOW/BLOCK first-line contract', () => {
  const gate = loadPrompt('stop-review-gate');
  for (const key of ['CLAUDE_RESPONSE_BLOCK', 'REPOSITORY_CONTEXT', 'PROJECT_CONTEXT']) assert.ok(gate.includes(`{{${key}}}`));
  assert.match(gate, /^- ALLOW: <motivo breve>$/m);
  assert.match(gate, /^- BLOCK: <motivo breve>$/m);
  assert.match(gate, /diff pode incluir alterações não commitadas anteriores e não inclui alterações já commitadas/);
  assert.match(gate, /Se não tiver certeza de que uma alteração pertence à resposta anterior, não bloqueie por ela/);
  assert.match(gate, /devem ser entregues/);
  assert.match(gate, /Não coloque nada antes dessa primeira linha\./);
  assert.match(gate, /\/opc:setup/);
});

test('prompt files never mention Codex and ported ones carry the attribution header', () => {
  for (const name of ['review', 'adversarial-review', 'stop-review-gate']) {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
    assert.doesNotMatch(loadPrompt(name), /codex/i, `${name}.md body mentions codex`);
    if (name !== 'review') assert.match(raw, /^<!-- Adapted from openai\/codex-plugin-cc \(Apache-2\.0\); modified -->/);
  }
});

test('loadSchema returns the review schema without meta keywords', () => {
  const schema = loadSchema('review-output');
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$comment, undefined);
  assert.deepEqual(schema.required, ['verdict', 'summary', 'findings', 'next_steps']);
  assert.deepEqual(schema.properties.verdict.enum, ['approve', 'needs-attention']);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, ['critical', 'high', 'medium', 'low']);
  assert.equal(schema.additionalProperties, false);
});

test('read-only prompts only advertise tools the read-only profile allows (no grep, no bash)', () => {
  for (const name of ['review.md', 'adversarial-review.md', 'stop-review-gate.md']) {
    const text = loadPrompt(name);
    const toolLine = text.split('\n').find((line) => /ferramentas read/.test(line));
    assert.ok(toolLine, `${name}: tool line`);
    assert.doesNotMatch(toolLine.replace(/\([^)]*não está disponível[^)]*\)/, ''), /\bgrep\b|\bbash\b/, name);
  }
});
