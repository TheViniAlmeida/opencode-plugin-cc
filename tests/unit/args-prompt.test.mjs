import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { RAW_ARGS_FLAG, parsePromptArgs, readRawArgs } from '../../plugins/opc/scripts/lib/args.mjs';

const REF = /^(task|ask|plan)-[0-9a-z]+-[0-9a-z]{6}$|^ses[_0-9A-Za-z]+$/;
const SPEC = {
  model: { type: 'string', alias: 'm' }, write: { type: 'boolean' }, background: { type: 'boolean' },
  effort: { type: 'string' }, resume: { type: 'optional-string', match: REF }, fresh: { type: 'boolean' },
};

test('prompt mantido verbatim: aspas, apóstrofos, crases, expansão e unicode', () => {
  const raw = `--write -m omniroute-personal/opencode-go/deepseek-v4.1-flash fix "it" don't \`whoami\` $(touch pwned) \${HOME} ção 🚀\nsecond line \\ end\n`;
  const r = parsePromptArgs(raw, SPEC);
  assert.deepEqual(r.argv, ['--write', '-m', 'omniroute-personal/opencode-go/deepseek-v4.1-flash']);
  assert.equal(r.prompt, `fix "it" don't \`whoami\` $(touch pwned) \${HOME} ção 🚀\nsecond line \\ end`);
});

test('flags em palavras inteiras; valores entre aspas; --flag=value; -- encerra flags', () => {
  const r = parsePromptArgs('explain the bug --background --effort "high" in src', SPEC);
  assert.deepEqual(r.argv, ['--background', '--effort', 'high']);
  assert.equal(r.prompt, 'explain the bug in src');
  const e = parsePromptArgs('--model=fast do it -- --write is literal here', SPEC);
  assert.deepEqual(e.argv, ['--model', 'fast']);
  assert.equal(e.prompt, 'do it --write is literal here');
  assert.deepEqual(parsePromptArgs('talk about --writers and -mild', SPEC).argv, []);
});

test('optional-string consome a próxima palavra somente se corresponder', () => {
  assert.deepEqual(parsePromptArgs('--resume task-abc123-x1y2z3 go on', SPEC), { argv: ['--resume', 'task-abc123-x1y2z3'], prompt: 'go on' });
  assert.deepEqual(parsePromptArgs('--resume ses_01ABC keep going', SPEC), { argv: ['--resume', 'ses_01ABC'], prompt: 'keep going' });
  assert.deepEqual(parsePromptArgs('--resume keep going', SPEC), { argv: ['--resume'], prompt: 'keep going' });
  assert.deepEqual(parsePromptArgs('--resume', SPEC), { argv: ['--resume'], prompt: '' });
  assert.deepEqual(parsePromptArgs('--resume=keep going', SPEC), { argv: ['--resume'], prompt: 'keep going' });
});

test('preserva exatamente quebras de linha e o terminador -- dentro do texto', () => {
  assert.equal(parsePromptArgs('a\r\nb', SPEC).prompt, 'a\r\nb');
  assert.equal(parsePromptArgs('a\n--\nb', SPEC).prompt, 'a\n--\nb');
  const raw = 'quotes "x" don\'t `whoami` $(touch pwned) ${HOME} ção 🚀\n';
  assert.equal(parsePromptArgs(raw, SPEC).prompt, raw.slice(0, -1));
});

test('flag de valor sem valor gera erro de uso; entrada vazia fica vazia', () => {
  assert.throws(() => parsePromptArgs('do it --model', SPEC), (e) => e.code === 'USAGE' && e.exitCode === 2);
  assert.throws(() => parsePromptArgs('--model --write fix', SPEC), (e) => e.code === 'USAGE' && e.exitCode === 2);
  assert.deepEqual(parsePromptArgs('\n', SPEC), { argv: [], prompt: '' });
});

test('readRawArgs sem a flag copia argv e não lê stdin', async () => {
  let touched = false;
  const stdin = { isTTY: false, [Symbol.asyncIterator]() { touched = true; throw new Error('stdin não deve ser lido'); } };
  const argv = ['--write', 'fix', 'it'];
  const r = await readRawArgs(argv, SPEC, { stdin });
  assert.deepEqual(r, { argv: ['--write', 'fix', 'it'], text: null });
  assert.notEqual(r.argv, argv);
  assert.equal(touched, false);
});

test('readRawArgs com a flag acrescenta flags e retorna texto verbatim', async () => {
  assert.equal(RAW_ARGS_FLAG, '--raw-args-stdin');
  const r = await readRawArgs(['--background', RAW_ARGS_FLAG], SPEC, { stdin: Readable.from(["--write don't touch `x` $(id) -m fast\n"]) });
  assert.deepEqual(r.argv, ['--background', '--raw-args-stdin', '--write', '-m', 'fast']);
  assert.equal(r.text, "don't touch `x` $(id)");
  const agent = await readRawArgs(['--write', RAW_ARGS_FLAG], SPEC, { stdin: Readable.from(['--\n--model x is text, don\'t split\n']) });
  assert.deepEqual(agent.argv, ['--write', RAW_ARGS_FLAG]);
  assert.equal(agent.text, "--model x is text, don't split");
  assert.deepEqual(await readRawArgs([RAW_ARGS_FLAG], SPEC, { stdin: Readable.from(['']) }), { argv: [RAW_ARGS_FLAG], text: '' });
});
