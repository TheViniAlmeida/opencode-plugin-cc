import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter, parseSelection } from '../../plugins/opc/scripts/lib/tty.mjs';
import { UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { scriptedTTY, captureStream } from '../helpers.mjs';

const CHOICES = [
  { label: 'omniroute-mvalmeida (182 modelos)', value: 'omniroute-mvalmeida' },
  { label: 'omniroute-work (51 modelos)', value: 'omniroute-work' },
  { label: 'anthropic (18 modelos)', value: 'anthropic' },
  { label: 'opencode (7 modelos)', value: 'opencode' },
];

test('parseSelection: numbers, ranges, all, empty, invalid', () => {
  assert.deepEqual(parseSelection('1,3', 4), [0, 2]);
  assert.deepEqual(parseSelection('2-4', 4), [1, 2, 3]);
  assert.deepEqual(parseSelection('4 1 1', 4), [0, 3]);
  assert.deepEqual(parseSelection('todos', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('', 3), []);
  assert.equal(parseSelection('5', 4), null);
  assert.equal(parseSelection('3-1', 4), null);
  assert.equal(parseSelection('abc', 4), null);
});

test('createPrompter refuses a non-TTY input', () => {
  const input = new PassThrough();
  assert.throws(() => createPrompter({ input, output: captureStream() }), (err) => {
    assert.equal(err.code, 'NOT_A_TTY');
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /terminal.*interativo/i);
    return true;
  });
});

test('select with no choices reports NO_CHOICES in Brazilian Portuguese', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const p = createPrompter({ input, output: captureStream() });
  await assert.rejects(p.select('Q?', []), (err) => {
    assert.equal(err.code, 'NO_CHOICES');
    assert.match(err.message, /nenhuma opção disponível/i);
    return true;
  });
  p.close();
});

test('select by number, with invalid answer retried', async () => {
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY(['9', '3']), output });
  assert.equal(await p.select('Provider padrão?', CHOICES), 'anthropic');
  assert.match(output.text(), /Opção inválida: 9/);
  assert.match(output.text(), / 1\) omniroute-mvalmeida \(182 modelos\)/);
  p.close();
});

test('invalid long answers and unmatched filters are truncated before output', async () => {
  const token = 'FAKE-TOKEN-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY([token, '3']), output });
  assert.equal(await p.select('Provider padrão?', CHOICES), 'anthropic');
  assert.ok(!output.text().includes(token));
  assert.ok(output.text().includes(`${token.slice(0, 12)}…`));
  p.close();

  const filter = 'NO-MATCH-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const filterOutput = captureStream();
  const filterPrompter = createPrompter({ input: scriptedTTY([filter, '2']), output: filterOutput });
  assert.equal(await filterPrompter.select('Provider padrão?', CHOICES), 'omniroute-work');
  assert.ok(!filterOutput.text().includes(filter));
  assert.ok(filterOutput.text().includes(`${filter.slice(0, 12)}…`));
  filterPrompter.close();
});

test('select with text filter then number within the filtered list', async () => {
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY(['omniroute', '2']), output });
  assert.equal(await p.select('Provider padrão?', CHOICES), 'omniroute-work');
  p.close();
});

test('select default on empty answer and "Outro"', async () => {
  const p = createPrompter({ input: scriptedTTY(['', 'o', 'my/glob-*']), output: captureStream() });
  assert.equal(await p.select('Q?', CHOICES, { defaultIndex: 1 }), 'omniroute-work');
  assert.deepEqual(await p.select('Q?', CHOICES, { allowOther: true }), { other: 'my/glob-*' });
  p.close();
});

test('multiSelect by ranges, min enforced', async () => {
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY(['', '1,3-4']), output });
  assert.deepEqual(await p.multiSelect('Tipos?', CHOICES, { min: 1 }), ['omniroute-mvalmeida', 'anthropic', 'opencode']);
  assert.match(output.text(), /pelo menos 1/);
  p.close();
});

test('text with default and validation; confirm s/n', async () => {
  const p = createPrompter({ input: scriptedTTY(['', 'bad', 'good', 'x', 's', '']), output: captureStream() });
  assert.equal(await p.text('Objetivo? ', { defaultValue: 'Plugin' }), 'Plugin');
  assert.equal(await p.text('Nome? ', { validate: (v) => (v === 'bad' ? 'inválido' : null) }), 'good');
  assert.equal(await p.confirm('Seguir?'), true);
  assert.equal(await p.confirm('De novo?', { defaultValue: false }), false);
  p.close();
});

test('closed input rejects with TTY_CLOSED', async () => {
  const p = createPrompter({ input: scriptedTTY([]), output: captureStream() });
  await assert.rejects(p.text('x? '), (err) => {
    assert.equal(err.code, 'TTY_CLOSED');
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /a entrada foi encerrada antes da resposta/i);
    return true;
  });
});

test('input closed while waiting rejects with translated TTY_CLOSED', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const p = createPrompter({ input, output: captureStream() });
  const prompt = p.text('x? ');
  input.end();
  await assert.rejects(prompt, (err) => {
    assert.equal(err.code, 'TTY_CLOSED');
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /a entrada foi encerrada antes da resposta/i);
    return true;
  });
});
