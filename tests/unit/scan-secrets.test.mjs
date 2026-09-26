import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ALLOW_MARKER, mask, scanPaths, scanText, secretsFromServerJson } from '../../scripts/scan-secrets.mjs';
import { REPO_ROOT, makeTempDir, removeTempDir, runProcess } from '../helpers.mjs';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs');

test('scanText finds registered secrets and token patterns, masking samples', () => {
  const secret = 'a1b2c3d4e5f6a7b8c9d0';
  const findings = scanText(`line one\nurl with ${secret} inside\nAuthorization: Bearer ${'abcdefghij'.repeat(3)}\n`, { secrets: [secret] });
  assert.deepEqual(findings.map((f) => [f.line, f.kind]), [[2, 'registered-secret'], [3, 'bearer-token']]);
  for (const f of findings) assert.ok(!f.sample.includes(secret) && f.sample.includes('chars'));
});

test('scanText ignores redacted and placeholder passwords', () => {
  assert.deepEqual(scanText('{"password": "***"}\n{"password": "YOUR_PASSWORD_HERE"}\nOPENCODE_SERVER_PASSWORD=***'), []);
  assert.equal(scanText('{"password": "hunter2hunter2"}')[0].kind, 'json-password'); // scan-secrets:allow
});

test('the allow marker exempts a line from patterns but never from registered secrets', () => {
  const secret = 'b0b0b0b0b0b0b0b0';
  const line = `Bearer ${'x'.repeat(24)} ${secret} // ${ALLOW_MARKER}`;
  assert.deepEqual(scanText(line, { secrets: [secret] }).map((f) => f.kind), ['registered-secret']);
});

test('mask keeps only a short prefix and the length', () => {
  assert.equal(mask('abcdefghijkl'), 'abcd…(12 chars)');
});

test('scanPaths walks directories and skips binary files', (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.md'), `token ghp_${'abcdef0123'.repeat(4)}\n`);
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 115, 107, 45]));
  const findings = scanPaths([dir]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'github-token');
});

test('secretsFromServerJson reads passwords from server.json files', (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify({ password: 'feedfacefeedface' }));
  assert.deepEqual(secretsFromServerJson([file, path.join(dir, 'missing.json')]), ['feedfacefeedface']);
});

test('CLI exits 1 with masked output when a registered secret is found, 0 when clean', async (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  const secret = 'deadbeefdeadbeefdeadbeef';
  const serverJson = path.join(dir, 'server.json');
  fs.writeFileSync(serverJson, JSON.stringify({ password: secret }));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'ok.md'), '# nothing here\n');
  const clean = await runProcess(process.execPath, [SCRIPT, path.join(dir, 'docs'), '--server-json', serverJson], { env: { PATH: process.env.PATH } });
  assert.equal(clean.code, 0);
  fs.writeFileSync(path.join(dir, 'docs', 'leak.md'), `pw=${secret}\n`);
  const dirty = await runProcess(process.execPath, [SCRIPT, path.join(dir, 'docs'), '--server-json', serverJson], { env: { PATH: process.env.PATH } });
  assert.equal(dirty.code, 1);
  assert.match(dirty.stdout, /leak\.md:1: registered-secret/);
  assert.ok(!dirty.stdout.includes(secret));
});

test('CLI warns and ignores an explicit missing path', async (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  const missing = path.join(dir, 'missing');
  const result = await runProcess(process.execPath, [SCRIPT, missing], { env: { PATH: process.env.PATH } });
  assert.equal(result.code, 0);
  assert.ok(result.stderr.includes(`scan-secrets: aviso: caminho inexistente ignorado: ${missing}`));
});

test('CLI exits 2 and names invalid or unreadable server.json without printing its contents', async (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  const clean = path.join(dir, 'clean');
  fs.mkdirSync(clean);
  const invalid = path.join(dir, 'server.json');
  const privateContent = 'not-json-and-never-print-this';
  fs.writeFileSync(invalid, privateContent);
  const result = await runProcess(process.execPath, [SCRIPT, clean, '--server-json', invalid], { env: { PATH: process.env.PATH } });
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes(`scan-secrets: erro:`) && result.stderr.includes(invalid));
  assert.ok(!result.stderr.includes(privateContent));
});
