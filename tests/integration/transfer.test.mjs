import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import { MAX_TRANSCRIPT_BYTES } from '../../plugins/opc/scripts/lib/transfer.mjs';
import { checkImportShape } from '../fixtures/fake-import.mjs';
import {
  cliJson, makeTempDir, makeWorkspace, PLUGIN_ROOT, readFakeState, REPO_ROOT,
  runCli, stateDirFor, testEnv, trackTempDir, trackWorkspace, writeTestConfig, startExternalFake,
} from '../helpers.mjs';

const SAMPLE = path.join(REPO_ROOT, 'tests', 'fixtures', 'data', 'claude-transcript-sample.jsonl');
const MODEL = 'example-provider/example/model-a';

function setup(t, extra = {}) {
  const env = testEnv(t, { extra });
  delete env.OPC_COMPANION_TRANSCRIPT_PATH;
  const ws = makeWorkspace(t, { git: false });
  const root = trackTempDir(t, makeTempDir('opc-f5-projects-'));
  const project = path.join(root, '-tmp-ws');
  fs.mkdirSync(project);
  const source = path.join(project, 'session.jsonl');
  fs.copyFileSync(SAMPLE, source);
  env.OPC_TRANSFER_ALLOWED_ROOT = root;
  return { env, ws, root, source };
}

const imports = (env) => readFakeState(env).imports ?? [];
const transferArgs = (source, model = MODEL) => ['transfer', '--source', source, '--model', model];

function assertNoImport(env) {
  assert.equal(imports(env).length, 0);
  assert.equal(readFakeState(env).bootAttempts, 0);
}

function assertTemporaryRemoved(env, ws) {
  for (const entry of imports(env)) assert.equal(fs.existsSync(entry.file), false);
  const dir = path.join(stateDirFor(env, ws), 'transfer');
  if (fs.existsSync(dir)) assert.deepEqual(fs.readdirSync(dir), []);
}

test('transfer imports a valid export in private files and returns only a resumable summary', async (t) => {
  const { env, ws, source } = setup(t);
  const r = await cliJson(transferArgs(source), { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  const [imp] = imports(env);
  assert.deepEqual(imp.errors, []);
  assert.equal(imp.mode, '600');
  assert.equal(imp.dirMode, '700');
  assert.equal(imp.cwd, ws);
  assert.equal((fs.statSync(stateDirFor(env, ws)).mode & 0o777).toString(8), '700');
  assertTemporaryRemoved(env, ws);
  assert.match(r.data.sessionID, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(r.data.sessionID, imp.sessionID);
  assert.equal(r.data.title, 'OPC: transfer: Fixture transfer');
  assert.equal(imp.title, r.data.title);
  assert.deepEqual(r.data.messages, { total: 4, user: 2, assistant: 2 });
  assert.deepEqual(r.data.skipped, { meta: 1, sidechain: 1, command: 1, thinking: 1, other: 1, invalidLines: 1 });
  assert.equal(r.data.model, MODEL);
  assert.equal(r.data.workspaceRoot, ws);
  assert.equal(r.data.resumeCommand, `cd ${shellQuote(ws)} && opencode -s ${r.data.sessionID}`);
  assert.deepEqual(r.data.warnings, []);
  assert.equal(Object.hasOwn(r.data, 'source'), false);
  assert.doesNotMatch(r.stdout + r.stderr, /List the files|Now add a --verbose|session\.jsonl|\[tool call:/);
  assert.ok(imp.texts.includes('List the files in src and explain main.mjs.'));
  // A V2 user message carries a single text, so the omitted-image marker is appended to the same message.
  assert.ok(imp.texts.includes('Now add a --verbose flag. Keep `$(echo hi)` and "quotes" intact: ção ✓\n\n[imagem omitida]'));
  assert.ok(imp.texts.includes('[chamada de ferramenta: Bash] {"command":"ls src"}'));
  assert.ok(imp.texts.includes('[resultado da ferramenta: sucesso] main.mjs\nutil.mjs'));
  assert.ok(!imp.texts.some((text) => text.includes('Sidechain prompt') || text.includes('Plan the listing.')));
  assert.equal(readFakeState(env).bootAttempts, 1, 'import uses the managed V2 server');
});

test('transfer uses OPC_OPENCODE_BIN for version detection and import', async (t) => {
  const { env, ws, source } = setup(t);
  const external = await startExternalFake(t, { scenario: 'ok' });
  env.OPC_SERVER_URL = external.url;
  env.OPC_SERVER_PASSWORD = external.password;
  const binDir = trackTempDir(t, makeTempDir('opc-transfer-bin-'));
  const bin = path.join(binDir, 'configured-opencode.mjs');
  const calls = path.join(binDir, 'calls.jsonl');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.OPC_BIN_CALLS, JSON.stringify(args) + '\\n');\nif (args[0] === '--version') process.stdout.write('opencode v2.0.22\\n');\nelse if (args[0] === '--server' && args[2] === 'session' && args[3] === 'import') process.stdout.write('Imported session: ' + JSON.parse(fs.readFileSync(args[4], 'utf8')).info.id + '\\n');\nelse process.exitCode = 2;\n`, { mode: 0o700 });
  env.OPC_OPENCODE_BIN = bin;
  env.OPC_BIN_CALLS = calls;
  const result = await cliJson(transferArgs(source), { env, cwd: ws });
  assert.equal(result.code, 0, result.stderr);
  const invoked = fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(invoked.map((args) => args[0]), ['--version', '--server']);
  assert.deepEqual(invoked[1].slice(2, 4), ['session', 'import']);
});

test('transfer uses the SessionStart source and default model alias and renders Markdown', async (t) => {
  const { env, ws, source } = setup(t);
  writeTestConfig(env, { defaultModel: 'transfer-model', aliases: { 'transfer-model': MODEL } });
  const r = await runCli(['transfer'], { env: { ...env, OPC_COMPANION_TRANSCRIPT_PATH: source }, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^# opc transfer\n/);
  assert.match(r.stdout, /opencode -s ses_[0-9A-Za-z]+/);
  assert.match(r.stdout, /4 \(2 do usuário, 2 do assistente\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /Origem:|session\.jsonl|Now add a --verbose/);
  assert.equal(imports(env).length, 1);
});

test('transfer resolves relative source and --cwd using ctx.env and ctx.cwd', async (t) => {
  const { env, root, source } = setup(t);
  const cwd = path.dirname(source);
  trackWorkspace(t, cwd); // the V2 import boots the managed server for --cwd, so cleanup must stop it
  const r = await cliJson(['transfer', '--cwd', cwd, '--source', 'session.jsonl', '-m', MODEL], { env, cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(imports(env)[0].cwd, cwd);
  assert.equal(r.data.workspaceRoot, cwd);
  assertTemporaryRemoved(env, cwd);
});

test('transfer preserves private history during import while masking credentials in the public title', async (t) => {
  const { env, ws, source } = setup(t);
  const privateText = 'password=fixture-private-history';
  fs.writeFileSync(source, JSON.stringify({ type: 'user', message: { content: privateText } }) + '\n');
  const r = await cliJson(transferArgs(source), { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(imports(env)[0].texts.includes(privateText));
  assert.doesNotMatch(r.stdout + r.stderr, /fixture-private-history/);
  assert.match(r.data.title, /password=\*\*\*/);
});

for (const origin of ['outside', 'symlink-outside', 'parent-escape', 'symlink-non-jsonl']) {
  test(`transfer refuses ${origin} before executing OpenCode`, async (t) => {
    // Missing OpenCode proves source validation precedes --version/import.
    const { env, ws, root } = setup(t, { PATH: '/opc-missing-bin' });
    const outside = path.join(ws, 'private-personal-transcript.jsonl');
    fs.copyFileSync(SAMPLE, outside);
    let file = outside;
    let expected = 'TRANSCRIPT_OUTSIDE_ALLOWED_ROOT';
    let exit = 4;
    if (origin === 'symlink-outside') {
      file = path.join(root, 'link.jsonl');
      fs.symlinkSync(outside, file);
    } else if (origin === 'parent-escape') {
      // The workspace has a separate parent; express an actual ../ escape from root.
      file = `${root}/../${path.relative(path.dirname(root), outside)}`;
    } else if (origin === 'symlink-non-jsonl') {
      const txt = path.join(root, 'private-notes.txt');
      fs.copyFileSync(SAMPLE, txt);
      file = path.join(root, 'link.jsonl');
      fs.symlinkSync(txt, file);
      expected = 'NOT_JSONL';
      exit = 2;
    }
    const r = await cliJson(transferArgs(file), { env, cwd: ws });
    assert.equal(r.code, exit, r.stderr);
    assert.equal(r.data.error.code, expected);
    assert.doesNotMatch(r.stdout + r.stderr, /private-personal-transcript|private-notes|opc-f5-projects|OPENCODE_NOT_FOUND/);
    assertNoImport(env);
  });
}

for (const [kind, expected] of [
  ['no-source', 'NO_TRANSCRIPT'], ['non-jsonl', 'NOT_JSONL'], ['missing', 'NOT_FOUND'],
  ['directory', 'NOT_A_FILE'], ['large', 'TRANSCRIPT_TOO_LARGE'], ['empty', 'EMPTY_TRANSCRIPT'],
  ['no-model', 'NO_MODEL'], ['short-model', 'MODEL_NEEDS_FULL_ID'],
]) {
  test(`transfer ${kind} returns usage exit 2 before executing OpenCode`, async (t) => {
    const { env, ws, root, source } = setup(t, { PATH: '/opc-missing-bin' });
    let file = source;
    let args;
    if (kind === 'no-source') args = ['transfer', '--model', MODEL];
    if (kind === 'non-jsonl') { file = path.join(root, 'notes.txt'); fs.writeFileSync(file, 'x'); }
    if (kind === 'missing') file = path.join(root, 'missing.jsonl');
    if (kind === 'directory') { file = path.join(root, 'directory.jsonl'); fs.mkdirSync(file); }
    if (kind === 'large') {
      const fd = fs.openSync(file, 'w');
      try { fs.ftruncateSync(fd, MAX_TRANSCRIPT_BYTES + 1); } finally { fs.closeSync(fd); }
    }
    if (kind === 'empty') fs.writeFileSync(file, 'invalid\n');
    if (kind === 'no-model') {
      writeTestConfig(env, { defaultModel: null });
      args = ['transfer', '--source', file];
    }
    const r = await cliJson(args ?? transferArgs(file, kind === 'short-model' ? 'unknown-alias' : MODEL), { env, cwd: ws });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.data.error.code, expected);
    assertNoImport(env);
  });
}

for (const kind of ['providers', 'models']) {
  test(`transfer honors denied ${kind} with policy exit 4`, async (t) => {
    const { env, ws, source } = setup(t, { PATH: '/opc-missing-bin' });
    writeTestConfig(env, { policy: { [kind]: { allow: [], deny: [kind === 'providers' ? 'example-provider' : MODEL] } } });
    const r = await cliJson(transferArgs(source), { env, cwd: ws });
    assert.equal(r.code, 4, r.stderr);
    assert.equal(r.data.error.code, 'POLICY_DENIED');
    assertNoImport(env);
  });
}

for (const mode of ['fail', 'crash', 'success-nonzero', 'mismatch']) {
  test(`opencode import ${mode} fails with exit 7 and always removes the temporary export`, async (t) => {
    const { env, ws, source } = setup(t, { FAKE_OPENCODE_IMPORT: mode });
    const r = await cliJson(transferArgs(source), { env, cwd: ws });
    assert.equal(r.code, 7, r.stderr);
    assert.equal(r.data.error.code, 'IMPORT_FAILED');
    assert.equal(imports(env).length, 1);
    assertTemporaryRemoved(env, ws);
    assert.doesNotMatch(r.stdout + r.stderr, /RAW_TRANSCRIPT_SENTINEL|fixture-sensitive-value|private-person|Failed to read session data/);
  });
}

for (const [kind, extra, expected] of [
  ['missing executable', { PATH: '/opc-missing-bin' }, 'OPENCODE_NOT_FOUND'],
  ['old version', { FAKE_OPENCODE_VERSION: '1.0.0' }, 'UNSUPPORTED_VERSION'],
]) {
  test(`transfer ${kind} fails with connection exit 5 without importing`, async (t) => {
    const { env, ws, source } = setup(t, extra);
    const r = await cliJson(transferArgs(source), { env, cwd: ws });
    assert.equal(r.code, 5, r.stderr);
    assert.equal(r.data.error.code, expected);
    assertNoImport(env);
  });
}

test('/opc:transfer is user-only, uses a guarded quoted heredoc and does not run OpenCode directly', () => {
  const md = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'transfer.md'), 'utf8');
  assert.match(md, /^disable-model-invocation: true$/m);
  assert.match(md, /^allowed-tools: Bash\(opc:\*\)$/m);
  assert.match(md, /opc transfer --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\$ARGUMENTS\nOPC_ARGS_5f1d0c7a_EOF\n```/);
  assert.match(md, /não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado/);
  assert.match(md, /Não rode `opencode` você mesmo/);
});

test('fake import oracle independently rejects malformed export references', () => {
  assert.ok(checkImportShape({ info: {}, messages: [] }).includes('info.id inválido'));
  const sample = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'contract', 'opencode-2.0.22', 'export.json'), 'utf8'));
  sample.messages[1].id = sample.messages[0].id;
  assert.ok(checkImportShape(sample).some((error) => /id duplicado/.test(error)));
});
