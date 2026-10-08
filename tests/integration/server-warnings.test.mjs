import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  cliJson, makeTempDir, makeWorkspace, REPO_ROOT, runCli, startExternalFake, testEnv, trackTempDir,
} from '../helpers.mjs';

const SAMPLE = path.join(REPO_ROOT, 'tests', 'fixtures', 'data', 'claude-transcript-sample.jsonl');
const SHARE_AUTO_WARNING = /^\[opc\] aviso: O OpenCode está com share "auto"/m;

// Attach-mode environment against a fake whose GET /api/config reports share "auto" (a world-check warning).
async function attachEnv(t) {
  const env = testEnv(t);
  const external = await startExternalFake(t, { scenario: 'share-auto' });
  env.OPC_SERVER_URL = external.url;
  env.OPC_SERVER_PASSWORD = external.password;
  return { env, ws: makeWorkspace(t, { git: false }) };
}

test('a discovery command in attach mode shows the server warning on stderr and keeps stdout valid JSON', async (t) => {
  const { env, ws } = await attachEnv(t);
  const r = await runCli(['models', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout must stay parseable JSON');
  assert.match(r.stderr, SHARE_AUTO_WARNING);
  assert.doesNotMatch(r.stderr, /Modo attach:/);
  assert.doesNotMatch(r.stdout, /aviso: O OpenCode está com share|Modo attach:/);
});

test('transfer carries the server warnings in its result, in JSON and Markdown, without the attach info line', async (t) => {
  const { env, ws } = await attachEnv(t);
  const root = trackTempDir(t, makeTempDir('opc-warn-transfer-'));
  const project = path.join(root, '-tmp-ws');
  fs.mkdirSync(project);
  const source = path.join(project, 'session.jsonl');
  fs.copyFileSync(SAMPLE, source);
  env.OPC_TRANSFER_ALLOWED_ROOT = root;
  delete env.OPC_COMPANION_TRANSCRIPT_PATH;
  const args = ['transfer', '--source', source, '--model', 'example-provider/example/model-a'];

  const json = await cliJson(args, { env, cwd: ws });
  assert.equal(json.code, 0, json.stderr);
  assert.ok(json.data.warnings.some((w) => /share "auto"/.test(w)), JSON.stringify(json.data.warnings));
  assert.equal(json.data.warnings.some((w) => w.startsWith('Modo attach:')), false);

  const md = await runCli(args, { env, cwd: ws });
  assert.equal(md.code, 0, md.stderr);
  assert.match(md.stdout, /share "auto"/);
  assert.doesNotMatch(md.stdout, /Modo attach:/);
});
