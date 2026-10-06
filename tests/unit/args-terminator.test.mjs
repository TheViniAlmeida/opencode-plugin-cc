import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { parseArgs, RAW_ARGS_FLAG, readRawArgs, resolveArgv } from '../../plugins/opc/scripts/lib/args.mjs';
import { normalizeResumeFlag } from '../../plugins/opc/scripts/commands/task.mjs';

const SPEC = { flags: { json: { type: 'boolean' }, write: { type: 'boolean' }, model: { type: 'string' } }, allowPositionals: true };
const PROMPT_FLAGS = { write: { type: 'boolean' }, model: { type: 'string', alias: 'm' } };

function untouchedStdin() {
  const probe = { touched: false };
  probe.stream = { isTTY: false, [Symbol.asyncIterator]() { probe.touched = true; throw new Error('stdin must not be read'); } };
  return probe;
}

test('"--" ends option parsing and keeps the tail verbatim', () => {
  const { flags, positionals } = parseArgs(['--json', '--model', 'a/b', '--', '--write', 'line1\nline2 $(x) `y` ç'], SPEC);
  assert.equal(flags.json, true);
  assert.equal(flags.model, 'a/b');
  assert.notEqual(flags.write, true);
  assert.deepEqual(positionals, ['--write', 'line1\nline2 $(x) `y` ç']);
});

test('positionals before "--" keep their order ahead of the tail', () => {
  const { positionals } = parseArgs(['reply', 'per_1', 'reject', '--json', '--', '--no thanks'], SPEC);
  assert.deepEqual(positionals, ['reply', 'per_1', 'reject', '--no thanks']);
});

test('"--" followed by nothing is accepted', () => {
  assert.deepEqual(parseArgs(['--json', '--'], SPEC).positionals, []);
});

test('a tail after "--" is still refused when the command takes no positionals', () => {
  assert.throws(() => parseArgs(['--', 'x'], { flags: { json: { type: 'boolean' } } }), (e) => e.exitCode === 2);
});

test('normalizeResumeFlag preserves --resume after -- as literal prompt text', () => {
  assert.deepEqual(normalizeResumeFlag(['--', '--resume']), ['--', '--resume']);
});

test('resolveArgv ignores --args-stdin that appears after "--"', async () => {
  const probe = untouchedStdin();
  assert.deepEqual(await resolveArgv(['task', '--', '--args-stdin'], { stdin: probe.stream }), ['task', '--', '--args-stdin']);
  assert.equal(probe.touched, false);
});

test('resolveArgv still expands --args-stdin before "--" and keeps the tail last', async () => {
  assert.deepEqual(await resolveArgv(['task', '--args-stdin'], { stdin: Readable.from(['--model "a/b" hello']) }), ['task', '--model', 'a/b', 'hello']);
  assert.deepEqual(await resolveArgv(['task', '--args-stdin', '--', '--write'], { stdin: Readable.from(['--model a/b']) }), ['task', '--model', 'a/b', '--', '--write']);
});

test('readRawArgs ignores --raw-args-stdin that appears after "--"', async () => {
  const probe = untouchedStdin();
  assert.deepEqual(await readRawArgs(['--json', '--', RAW_ARGS_FLAG], PROMPT_FLAGS, { stdin: probe.stream }), { argv: ['--json', '--', RAW_ARGS_FLAG], text: null });
  assert.equal(probe.touched, false);
});

test('readRawArgs before "--" keeps the F2a behavior and inserts the stdin flags ahead of the tail', async () => {
  const plain = await readRawArgs(['--json', RAW_ARGS_FLAG], PROMPT_FLAGS, { stdin: Readable.from(["--write don't split\n"]) });
  assert.deepEqual(plain, { argv: ['--json', RAW_ARGS_FLAG, '--write'], text: "don't split" });
  const withTail = await readRawArgs([RAW_ARGS_FLAG, '--', 'x'], PROMPT_FLAGS, { stdin: Readable.from(['-m fast y']) });
  assert.deepEqual(withTail.argv, [RAW_ARGS_FLAG, '-m', 'fast', '--', 'x']);
});
