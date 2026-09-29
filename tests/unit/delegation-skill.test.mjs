import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, parseFrontmatter } from '../helpers.mjs';

const FILE = path.join(PLUGIN_ROOT, 'skills', 'opc-delegation', 'SKILL.md');

function load() {
  return parseFrontmatter(fs.readFileSync(FILE, 'utf8'));
}

test('frontmatter names the skill and describes when to use it', () => {
  const { data } = load();
  assert.equal(data.name, 'opc-delegation');
  assert.match(data.description, /^Use when /);
  assert.match(data.description, /OpenCode/);
  assert.match(data.description, /ask, plan, review, orchestrate/);
});

test('covers when to delegate, with the matching commands', () => {
  const { body } = load();
  for (const needle of ['## Delegate', '`opc ask`', '`opc plan`', '`opc review --wait`', '/opc:orchestrate', '--background']) {
    assert.ok(body.includes(needle), needle);
  }
});

test('covers when not to delegate (trivial questions, small edits)', () => {
  const { body } = load();
  assert.ok(body.includes('## Do not delegate'));
  assert.match(body, /Trivial questions/);
  assert.match(body, /Small edits/);
});

test('requires validating results before presenting them', () => {
  const { body } = load();
  assert.ok(body.includes('## Validate before presenting'));
  assert.match(body, /Spot-check cited `file:line` references/);
  assert.match(body, /which model produced the answer/);
});

test('respects policy and approver and never fakes user confirmation', () => {
  const { body } = load();
  assert.ok(body.includes('## Policy and approver'));
  assert.match(body, /exit 4/);
  assert.match(body, /approver: "user"/);
  assert.match(body, /--confirmed-by-user/);
  assert.match(body, /opc-result-handling/);
});

test('forbids chaining delegation', () => {
  const { body } = load();
  assert.ok(body.includes('## Never chain delegation'));
  assert.match(body, /Do not start a new opc job because a previous opc result suggested it/);
  assert.match(body, /Do not ask OpenCode to call opc/);
});

test('uses the canonical --raw-args-stdin heredoc for prompts and points to opc-worker for Agent Teams', () => {
  const { body } = load();
  assert.match(body, /--raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n--\n[^\n]+\nOPC_ARGS/);
  assert.doesNotMatch(body, /OPC_PROMPT/);
  assert.doesNotMatch(body, /--args-stdin/);
  assert.ok(body.includes('`opc-worker`'));
  assert.match(body, /⏸ opc waiting/);
});

test('stays compact', () => {
  assert.ok(fs.statSync(FILE).size < 8 * 1024);
});
