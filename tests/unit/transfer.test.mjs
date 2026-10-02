import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildExport,
  buildTitle,
  convertClaudeRecords,
  createIdGenerator,
  detectOpencodeVersion,
  MAX_TRANSCRIPT_BYTES,
  parseImportOutput,
  parseJsonlLines,
  readTranscript,
  resolveTranscriptPath,
  resolveTransferModel,
  runImport,
  transferHeader,
  truncateText,
  validateExportShape,
  writeExportFile,
} from '../../plugins/opc/scripts/lib/transfer.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const SAMPLE_JSONL = path.join(DATA, 'claude-transcript-sample.jsonl');
const EXPORT_SAMPLE = JSON.parse(fs.readFileSync(path.join(DATA, 'export-sample.json'), 'utf8'));
const MODEL = { providerID: 'example-provider', modelID: 'example/model-a', full: 'example-provider/example/model-a' };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function projectsRoot(t) {
  const home = tempDir(t);
  const root = path.join(home, '.claude', 'projects', '-tmp-ws');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'session.jsonl');
  fs.copyFileSync(SAMPLE_JSONL, file);
  return { home, root: path.join(home, '.claude', 'projects'), file };
}

async function sampleConversion() {
  const { records } = await readTranscript(SAMPLE_JSONL);
  return convertClaudeRecords(records, { now: 0 });
}

test('resolveTranscriptPath uses OPC_COMPANION_TRANSCRIPT_PATH by default and --source when given', (t) => {
  const { home, file } = projectsRoot(t);
  assert.equal(resolveTranscriptPath({ env: { OPC_COMPANION_TRANSCRIPT_PATH: file }, cwd: home, home }), file);
  const other = path.join(path.dirname(file), 'other.jsonl');
  fs.writeFileSync(other, '{}\n');
  assert.equal(resolveTranscriptPath({ source: other, env: { OPC_COMPANION_TRANSCRIPT_PATH: file }, cwd: home, home }), other);
  assert.equal(resolveTranscriptPath({ source: '~/.claude/projects/-tmp-ws/session.jsonl', env: {}, cwd: '/', home }), file);
});

test('resolveTranscriptPath rejects missing source, non-jsonl, missing file and oversized file', (t) => {
  const { home, root, file } = projectsRoot(t);
  assert.throws(() => resolveTranscriptPath({ env: {}, cwd: home, home }), (e) => e.code === 'NO_TRANSCRIPT' && e.exitCode === 2);
  const txt = path.join(root, 'notes.txt');
  fs.writeFileSync(txt, 'x');
  assert.throws(() => resolveTranscriptPath({ source: txt, env: {}, cwd: home, home }), (e) => e.code === 'NOT_JSONL' && e.exitCode === 2);
  assert.throws(() => resolveTranscriptPath({ source: path.join(root, 'missing.jsonl'), env: {}, cwd: home, home }), (e) => e.code === 'NOT_FOUND' && e.exitCode === 2);
  const big = path.join(path.dirname(file), 'big.jsonl');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_TRANSCRIPT_BYTES + 1);
  assert.throws(() => resolveTranscriptPath({ source: big, env: {}, cwd: home, home }), (e) => e.code === 'TRANSCRIPT_TOO_LARGE' && e.exitCode === 2);
});

test('resolveTranscriptPath refuses files outside the allowed root, including symlinks and ".." paths', (t) => {
  const { home, root, file } = projectsRoot(t);
  const outsideDir = tempDir(t);
  const outside = path.join(outsideDir, 'x.jsonl');
  fs.writeFileSync(outside, '{}\n');
  const isPolicy = (e) => e.code === 'TRANSCRIPT_OUTSIDE_ALLOWED_ROOT' && e.exitCode === 4;
  assert.throws(() => resolveTranscriptPath({ source: outside, env: {}, cwd: home, home }), isPolicy);
  const link = path.join(root, 'link.jsonl');
  fs.symlinkSync(outside, link);
  assert.throws(() => resolveTranscriptPath({ source: link, env: {}, cwd: home, home }), isPolicy);
  const traversal = path.join(root, '-tmp-ws', '..', '..', '..', path.relative(home, outside));
  assert.throws(() => resolveTranscriptPath({ source: traversal, env: {}, cwd: home, home }), isPolicy);
  assert.equal(resolveTranscriptPath({ source: outside, env: { OPC_TRANSFER_ALLOWED_ROOT: outsideDir }, cwd: home, home }), outside);
  assert.equal(resolveTranscriptPath({ source: file, env: {}, cwd: home, home }), file);
});

test('erros de caminho exibem apenas um prefixo da origem fornecida', (t) => {
  const { home, root } = projectsRoot(t);
  const source = path.join(root, 'um-arquivo-inexistente.jsonl');
  assert.throws(() => resolveTranscriptPath({ source, env: {}, cwd: home, home }), (error) =>
    error.code === 'NOT_FOUND' && error.message.includes(`${source.slice(0, 12)}…`) && !error.message.includes(source));
});

test('parseJsonlLines counts invalid lines and ignores blanks', () => {
  const { records, invalid } = parseJsonlLines(['{"type":"user"}', '', 'not json', '[1,2]', '  {"type":"assistant"}  ']);
  assert.equal(records.length, 2);
  assert.equal(invalid, 2);
});

test('convertClaudeRecords turns the sample transcript into user/assistant turns with tool summaries', async () => {
  const { invalid } = await readTranscript(SAMPLE_JSONL);
  const conversion = await sampleConversion();
  assert.equal(invalid, 1);
  assert.equal(conversion.title, 'Fixture transfer');
  assert.equal(conversion.claudeSessionId, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(conversion.turns.map((turn) => [turn.role, turn.texts]), [
    ['user', ['List the files in src and explain main.mjs.']],
    ['assistant', [
      "I'll look at the directory first.",
      '[chamada de ferramenta: Bash] {"command":"ls src"}',
      '[resultado da ferramenta: sucesso] main.mjs\nutil.mjs',
      'src has main.mjs and util.mjs. main.mjs is the entry point.',
    ]],
    ['user', ['Now add a --verbose flag. Keep `$(echo hi)` and "quotes" intact: ção ✓', '[imagem omitida]']],
    ['assistant', [
      '[chamada de ferramenta: Edit] {"file_path":"src/main.mjs","old_string":"a","new_string":"b"}',
      '[resultado da ferramenta: erro] File has not been read yet',
      'Added the flag.',
    ]],
  ]);
  assert.deepEqual(conversion.stats.skipped, { meta: 1, sidechain: 1, command: 1, thinking: 1, other: 1 });
  assert.equal(conversion.turns[0].createdAt, Date.parse('2026-09-26T10:00:00.000Z'));
  assert.equal(conversion.turns[1].completedAt, Date.parse('2026-09-26T10:00:05.000Z'));
});

test('long texts and tool payloads are truncated with an explicit marker', () => {
  assert.equal(truncateText('abc', 5), 'abc');
  assert.match(truncateText('x'.repeat(10), 4), /^xxxx\n…\[6 caracteres truncados\]$/);
  const records = [
    { type: 'user', message: { content: 'y'.repeat(100) }, timestamp: '2026-09-26T10:00:00.000Z' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'z'.repeat(100) } }] } },
  ];
  const conversion = convertClaudeRecords(records, { maxTextChars: 10, maxToolChars: 20 });
  assert.match(conversion.turns[0].texts[0], /^y{10}\n…\[90 caracteres truncados\]$/);
  assert.ok(conversion.turns[1].texts[0].startsWith('[chamada de ferramen'));
  assert.match(conversion.turns[1].texts[0], /…\[\d+ caracteres truncados\]$/);
});

test('createIdGenerator follows the OpenCode identifier format and ordering', () => {
  let clock = 1_790_000_000_000;
  const nextId = createIdGenerator({ now: () => clock });
  const a = nextId('msg', 'ascending');
  const b = nextId('msg', 'ascending');
  clock += 1000;
  const c = nextId('msg', 'ascending');
  assert.match(a, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(a < b && b < c, 'ascending ids sort by creation order');
  const s1 = nextId('ses', 'descending');
  clock += 1000;
  const s2 = nextId('ses', 'descending');
  assert.match(s1, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(s2 < s1, 'descending ids put the newest first');
});

test('createIdGenerator reproduces real OpenCode 1.18.32 id prefixes', () => {
  // Vectors from `opencode export`: msg_0db91501c001… created at 1790390128668, ses_f246eb45fffe… at 1790390127520.
  assert.ok(createIdGenerator({ now: () => 1790390128668 })('msg', 'ascending').startsWith('msg_0db91501c001'));
  assert.ok(createIdGenerator({ now: () => 1790390127520 })('ses', 'descending').startsWith('ses_f246eb45fffe'));
});

test('buildExport produces a valid export with a synthetic header and linked parents', async () => {
  const conversion = await sampleConversion();
  const exported = buildExport(conversion, { model: MODEL, directory: '/tmp/opc-fixture/proj', version: '1.18.32' });
  assert.deepEqual(validateExportShape(exported), []);
  assert.equal(exported.info.title, 'OPC: transfer: Fixture transfer');
  assert.equal(exported.messages.length, 4);
  const [u1, a1, u2, a2] = exported.messages;
  assert.equal(u1.parts[0].synthetic, true);
  assert.equal(u1.parts[0].text, transferHeader('11111111-2222-4333-8444-555555555555'));
  assert.equal(u1.parts[1].text, 'List the files in src and explain main.mjs.');
  assert.equal(a1.info.parentID, u1.info.id);
  assert.equal(a2.info.parentID, u2.info.id);
  assert.deepEqual(u1.info.model, { providerID: 'example-provider', modelID: 'example/model-a' });
  assert.equal(a1.info.providerID, 'example-provider');
  assert.equal(a1.info.path.cwd, '/tmp/opc-fixture/proj');
  assert.equal(exported.info.time.created, Date.parse('2026-09-26T10:00:00.000Z'));
  assert.equal(exported.info.time.updated, Date.parse('2026-09-26T10:02:03.000Z'));
  const ids = exported.messages.map((m) => m.info.id);
  assert.deepEqual([...ids].sort(), ids, 'message ids ascend in conversation order');
});

test('buildExport inserts an empty user turn when the transcript starts with the assistant', () => {
  const conversion = convertClaudeRecords([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, timestamp: '2026-09-26T10:00:00.000Z' }]);
  const exported = buildExport(conversion, { model: MODEL, directory: '/w', version: '1.18.32' });
  assert.deepEqual(validateExportShape(exported), []);
  assert.equal(exported.messages[0].info.role, 'user');
  assert.equal(exported.messages[0].parts.length, 1);
  assert.equal(exported.messages[1].info.parentID, exported.messages[0].info.id);
});

test('buildExport refuses an empty conversion and buildTitle truncates to 56 chars', () => {
  assert.throws(() => buildExport({ turns: [], title: null, claudeSessionId: null }, { model: MODEL, directory: '/w', version: '1.18.32' }), (e) => e.code === 'EMPTY_TRANSCRIPT' && e.exitCode === 2);
  const title = buildTitle({ title: null, turns: [{ role: 'user', texts: [`${'word '.repeat(30)}\nend`] }] });
  assert.equal(title.length, 'OPC: transfer: '.length + 56);
});

test('validateExportShape accepts the real (scrubbed) export and rejects malformed ones', () => {
  assert.deepEqual(validateExportShape(EXPORT_SAMPLE), []);
  const broken = structuredClone(EXPORT_SAMPLE);
  delete broken.info.slug;
  broken.info.extra = true;
  broken.messages[0].info.id = 'bad_1';
  broken.messages[1].info.parentID = 'msg_unknown';
  broken.messages[2].parts[0].messageID = 'msg_other';
  const errors = validateExportShape(broken);
  assert.ok(errors.includes('info.slug: obrigatório'));
  assert.ok(errors.includes('info.extra…: chave inválida para exportação'));
  assert.ok(errors.includes('messages[0].info.id: deve começar com "msg"'));
  assert.ok(errors.includes('messages[1].info.parentID: deve apontar para uma mensagem anterior do usuário'));
  assert.ok(errors.includes('messages[2].parts[0].messageID: deve ser igual ao ID da mensagem'));
  assert.deepEqual(validateExportShape([]), ['$: esperado { info: objeto, messages: lista }']);
});

test('resolveTransferModel expands aliases, needs a full id and applies the policy', () => {
  const config = { defaultModel: 'fast', aliases: { fast: 'example-provider/example/model-a' }, policy: { providers: { deny: ['blocked'] }, models: { allow: [], deny: [] } } };
  assert.deepEqual(resolveTransferModel({ config }), MODEL);
  assert.equal(resolveTransferModel({ flag: 'other/x', config }).full, 'other/x');
  assert.throws(() => resolveTransferModel({ config: { policy: {} } }), (e) => e.code === 'NO_MODEL' && e.exitCode === 2);
  assert.throws(() => resolveTransferModel({ flag: 'shortname', config }), (e) => e.code === 'MODEL_NEEDS_FULL_ID');
  assert.throws(() => resolveTransferModel({ flag: 'blocked/m', config }), (e) => e.exitCode === 4);
  const denied = 'blocked/modelo-que-nao-pode-ser-exibido';
  assert.throws(() => resolveTransferModel({ flag: denied, config }), (error) =>
    error.code === 'POLICY_DENIED' && !error.message.includes(denied) && !JSON.stringify(error.details).includes(denied));
});

test('parseImportOutput reads the success line printed by opencode import', () => {
  assert.equal(parseImportOutput('Imported session: ses_f246e5370ffeRHyqkGfyUsIYTQ\n'), 'ses_f246e5370ffeRHyqkGfyUsIYTQ');
  assert.equal(parseImportOutput('noise\nImported session: ses_abc123\nmore'), 'ses_abc123');
  assert.equal(parseImportOutput('Failed to read session data\n'), null);
});

function fakeExec(result) {
  const calls = [];
  const impl = (file, args, options, cb) => {
    calls.push({ file, args, options });
    setImmediate(() => cb(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
  };
  return { impl, calls };
}

test('runImport returns the session id and maps failures to exit 7 / 5', async () => {
  const ok = fakeExec({ stdout: 'Imported session: ses_abc123\n', stderr: '[autotitle] Module loaded\n' });
  assert.deepEqual(await runImport({ file: '/f.json', cwd: '/w', env: {}, execFileImpl: ok.impl }), { sessionID: 'ses_abc123', exitCode: 0 });
  assert.deepEqual(ok.calls[0].args, ['import', '/f.json']);
  assert.equal(ok.calls[0].options.cwd, '/w');
  const soft = fakeExec({ stdout: 'Failed to read session data\n' });
  await assert.rejects(runImport({ file: '/f.json', cwd: '/w', execFileImpl: soft.impl }), (e) => e.code === 'IMPORT_FAILED' && e.exitCode === 7 && /A importação pelo opencode falhou/.test(e.message) && !e.message.includes('Failed to read session data'));
  const crash = fakeExec({ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Error: boom' });
  await assert.rejects(runImport({ file: '/f.json', cwd: '/w', execFileImpl: crash.impl }), (e) => e.code === 'IMPORT_FAILED' && /saída 1/.test(e.message) && !e.message.includes('boom'));
  const missing = fakeExec({ error: Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(runImport({ file: '/f.json', cwd: '/w', execFileImpl: missing.impl }), (e) => e.code === 'OPENCODE_NOT_FOUND' && e.exitCode === 5);
});

test('detectOpencodeVersion enforces the minimum OpenCode version', async () => {
  assert.equal(await detectOpencodeVersion({ execFileImpl: fakeExec({ stdout: '1.18.32\n' }).impl }), '1.18.32');
  await assert.rejects(detectOpencodeVersion({ execFileImpl: fakeExec({ stdout: '1.17.9\n' }).impl }), (e) => e.code === 'UNSUPPORTED_VERSION' && e.exitCode === 5);
});

test('writeExportFile writes a 0600 file inside a 0700 transfer directory', (t) => {
  const stateDir = tempDir(t);
  const file = writeExportFile(stateDir, { info: { id: 'ses_abc' }, messages: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { info: { id: 'ses_abc' }, messages: [] });
});
