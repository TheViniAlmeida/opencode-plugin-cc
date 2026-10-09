import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('F10 live output records every live fact and stays sanitized', () => {
  const live = read('docs/phases/F10-live-output.md');
  for (const key of ['refusedWithoutOptIn', 'attachPrivateHttp', 'remoteRootEnv', 'remoteRootsConfig', 'transferRemoteRoot']) assert.match(live, new RegExp(`"${key}"`));
  assert.doesNotMatch(live, /\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/);
  assert.doesNotMatch(live, /\/home\/|\/storage\//);
  assert.doesNotMatch(live, /omniroute-(?!personal)[a-z]/);
});

test('F10 report and docs describe the remote mode without overclaiming', () => {
  const report = read('docs/phases/F10-report.md');
  assert.match(report, /\| Suíte completa \|[^\n]*\| PASSOU \|/);
  assert.match(report, /\| Servidor em outra máquina física \|[^\n]*\| NÃO VALIDADO \|/);
  assert.match(read('docs/configuration.md'), /server\.allowPrivateHttp/);
  assert.match(read('docs/configuration.md'), /server\.remoteRoots/);
  assert.match(read('docs/installation.md'), /OPC_REMOTE_ROOT/);
  assert.match(read('CHANGELOG.md'), /### Adicionado — F10/);
});
