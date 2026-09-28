import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { extractCwd, parseArgs, parsePromptArgs, readStdin, resolveArgv, splitArgString } from '../../plugins/opc/scripts/lib/args.mjs';
import { UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const stdinOf = (text) => Readable.from([Buffer.from(text, 'utf8')]);

test('splitArgString splits like a shell without any expansion', () => {
  assert.deepEqual(splitArgString('a b  c'), ['a', 'b', 'c']);
  assert.deepEqual(splitArgString(`--model "prov/x y" 'single $HOME' \`ls\` $(touch pwned)`), [
    '--model', 'prov/x y', 'single $HOME', '`ls`', '$(touch', 'pwned)',
  ]);
  assert.deepEqual(splitArgString('"a \\" b" \'c\\d\' e\\ f'), ['a " b', 'c\\d', 'e f']);
  assert.deepEqual(splitArgString("'' \"\""), ['', '']);
  assert.deepEqual(splitArgString(''), []);
});

test('prompt-roundtrip: quotes, backticks, $(), newlines and unicode survive intact', () => {
  const prompt = 'Corrija "isso" com `crases`, $(rm -rf ~) e $HOME\nsegunda linha: ação ✓ 🚀 日本\n--write and --model fast stay literal';
  const quoted = `'${prompt.replace(/'/g, `'\\''`)}'`;
  assert.deepEqual(splitArgString(`--json ${quoted}`), ['--json', prompt]);
  assert.deepEqual(splitArgString(`"${prompt.replace(/(["\\$`])/g, '\\$1')}"`), [prompt]);
  assert.deepEqual(parsePromptArgs(`--write ${prompt}\n`, { write: { type: 'boolean' } }), { argv: ['--write'], prompt });
});

test('unterminated quotes are treated as literal characters (apostrophes in prose)', () => {
  assert.deepEqual(splitArgString("fix the user's code"), ['fix', 'the', "user's", 'code']);
  assert.deepEqual(splitArgString('say "hi'), ['say', '"hi']);
  assert.deepEqual(splitArgString(`it's "quoted text" ok`), ["it's", 'quoted text', 'ok']);
});

test('an apostrophe between letters/digits is literal and never opens a quote', () => {
  assert.deepEqual(splitArgString("don't and can't stop"), ["don't", 'and', "can't", 'stop']);
  assert.deepEqual(splitArgString("--goal 'it is' rock'n'roll"), ['--goal', 'it is', "rock'n'roll"]);
  assert.deepEqual(splitArgString("l'été 2'3 'a'\\''b'"), ["l'été", "2'3", "a'b"]);
});

test('newlines outside quotes separate tokens; backslash-newline joins lines', () => {
  assert.deepEqual(splitArgString('a\nb\\\nc'), ['a', 'bc']);
});

test('readStdin returns empty for TTY streams and the full text otherwise', async () => {
  assert.equal(await readStdin({ isTTY: true }), '');
  assert.equal(await readStdin(stdinOf('olá\nmundo')), 'olá\nmundo');
});

test('resolveArgv appends stdin tokens only when --args-stdin is present', async () => {
  assert.deepEqual(await resolveArgv(['setup', '--json'], { stdin: stdinOf('ignored') }), ['setup', '--json']);
  assert.deepEqual(await resolveArgv(['setup', '--args-stdin'], { stdin: stdinOf('--stop-server "a b"\n') }), [
    'setup', '--stop-server', 'a b',
  ]);
});

test('extractCwd removes --cwd from anywhere before --', () => {
  assert.deepEqual(extractCwd(['setup', '--cwd', '/tmp/x y', '--json']), { cwd: '/tmp/x y', argv: ['setup', '--json'] });
  assert.deepEqual(extractCwd(['--cwd=/a', 'setup']), { cwd: '/a', argv: ['setup'] });
  assert.deepEqual(extractCwd(['task', '--', '--cwd', 'x']), { cwd: null, argv: ['task', '--', '--cwd', 'x'] });
  assert.throws(() => extractCwd(['setup', '--cwd']), UsageError);
  assert.throws(() => extractCwd(['setup', '--cwd', '--json']), UsageError);
  assert.throws(() => extractCwd(['setup', '--cwd=']), UsageError);
});

const SPEC = {
  flags: {
    json: { type: 'boolean' },
    model: { type: 'string', alias: 'm' },
    timeout: { type: 'number', default: 30 },
    models: { type: 'list' },
  },
  allowPositionals: true,
};

test('parseArgs handles booleans, strings, aliases, numbers, lists and defaults', () => {
  const { flags, positionals } = parseArgs(['--json', '-m', 'prov/a/b', '--timeout=5', '--models', 'a,b', '--models', 'c', 'hello', 'world'], SPEC);
  assert.deepEqual(flags, { json: true, model: 'prov/a/b', timeout: 5, models: ['a', 'b', 'c'] });
  assert.deepEqual(positionals, ['hello', 'world']);
  assert.deepEqual(parseArgs([], SPEC).flags, { json: false, timeout: 30, models: [] });
});

test('parseArgs keeps everything after -- as positionals', () => {
  assert.deepEqual(parseArgs(['--json', '--', '--not-a-flag', '-m'], SPEC).positionals, ['--not-a-flag', '-m']);
});

test('parseArgs rejects unknown flags, missing values, bad numbers and unexpected positionals', () => {
  assert.throws(() => parseArgs(['--nope'], SPEC), (e) => e instanceof UsageError && e.exitCode === 2);
  assert.throws(() => parseArgs(['--model'], SPEC), UsageError);
  assert.throws(() => parseArgs(['--timeout', 'abc'], SPEC), UsageError);
  assert.throws(() => parseArgs(['extra'], { flags: {} }), UsageError);
  assert.throws(() => parseArgs(['--model', '--json'], SPEC), UsageError);
  assert.throws(() => parseArgs(['--unknown'], SPEC), UsageError);
  assert.throws(() => parseArgs(['-unknown'], SPEC), UsageError);
  assert.deepEqual(parseArgs(['-5'], SPEC).positionals, ['-5']);
  assert.throws(() => parseArgs(['--toString'], SPEC), UsageError);
  assert.throws(() => parseArgs(['--model='], SPEC), UsageError);
  const offending = `--sk-${'A'.repeat(24)}`;
  assert.throws(() => parseArgs([offending], SPEC), (error) =>
    error instanceof UsageError && !error.message.includes(offending));
});
