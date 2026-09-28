import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ACTIVE_JOB_STATUSES, PLUGIN_DATA_ID, defaultDataDir, ensurePrivateDir, listActiveJobs, loadState, readJson,
  resolveDataDir, resolveWorkspaceRoot, updateState, workspaceStateDir, writeFileAtomic,
} from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, makeWorkspace, removeTempDir } from '../helpers.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX modes' };

function temp(t) {
  const dir = makeTempDir('opc-state-');
  t.after(() => removeTempDir(dir));
  return dir;
}

test('resolveDataDir order: OPC_DATA_DIR > CLAUDE_PLUGIN_DATA > existing default > error', (t) => {
  const home = temp(t);
  assert.equal(resolveDataDir({ OPC_DATA_DIR: '/a', CLAUDE_PLUGIN_DATA: '/b' }, { home }), path.resolve('/a'));
  assert.equal(resolveDataDir({ OPC_DATA_DIR: '', CLAUDE_PLUGIN_DATA: '/b' }, { home }), path.resolve('/b'));
  assert.throws(() => resolveDataDir({}, { home }), (err) => err.code === 'DATA_DIR_UNRESOLVED' && err.exitCode === 2 && /\/opc:setup/.test(err.message));
  fs.mkdirSync(defaultDataDir({ home }), { recursive: true });
  assert.equal(resolveDataDir({}, { home }), path.join(home, '.claude', 'plugins', 'data', PLUGIN_DATA_ID));
  assert.equal(PLUGIN_DATA_ID, 'opc-opencode-plugin-cc');
});

test('resolveWorkspaceRoot uses the git toplevel, or realpath(cwd) outside git', (t) => {
  const ws = makeWorkspace(t, { name: 'repo' });
  fs.mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true });
  assert.equal(resolveWorkspaceRoot(path.join(ws, 'sub', 'deep')), ws);
  const plain = temp(t);
  assert.equal(resolveWorkspaceRoot(plain), fs.realpathSync(plain));
  assert.throws(() => resolveWorkspaceRoot(path.join(plain, 'missing')), { code: 'USAGE' });
  assert.equal(resolveWorkspaceRoot(plain, { env: { PATH: '' } }), fs.realpathSync(plain));
  assert.throws(() => resolveWorkspaceRoot(ws, { runner: () => ({ status: 2, stdout: '', stderr: 'fatal: injected failure' }) }),
    (err) => err.code === 'WORKSPACE_UNRESOLVED' && err.exitCode === 2 && /workspace/i.test(err.message));
});

test('workspace-with-spaces: slug is sanitized, hash uses the realpath, symlinks map to the same dir', (t) => {
  const base = temp(t);
  const ws = path.join(base, 'meu projeto ação');
  fs.mkdirSync(ws);
  const link = path.join(base, 'atalho');
  fs.symlinkSync(ws, link);
  const dir = workspaceStateDir('/data', ws);
  assert.match(path.basename(dir), /^meu-projeto-acao-[0-9a-f]{16}$/);
  assert.equal(path.dirname(dir), path.join('/data', 'state'));
  assert.equal(workspaceStateDir('/data', link), dir);
  assert.notEqual(workspaceStateDir('/data', base), dir);
});

test('ensurePrivateDir creates 700 dirs and tightens existing ones', posixOnly, (t) => {
  const base = temp(t);
  const target = path.join(base, 'a', 'b');
  ensurePrivateDir(target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  const loose = path.join(base, 'loose');
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.chmodSync(loose, 0o755);
  ensurePrivateDir(loose);
  assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
});

test('writeFileAtomic writes JSON or text with mode 600 and leaves no temp files', posixOnly, (t) => {
  const base = temp(t);
  const file = path.join(base, 'x.json');
  writeFileAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeFileAtomic(file, 'plain', { mode: 0o644 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'plain');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(base), ['x.json']);
});

test('writeFileAtomic removes its exact temp file when writing or renaming fails', (t) => {
  const base = temp(t);
  const file = path.join(base, 'failure.json');
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const leftovers = [];
  for (const phase of ['write', 'rename']) {
    if (phase === 'write') {
      fs.writeFileSync = (...args) => {
        originalWrite(...args);
        throw new Error('injected write failure');
      };
    } else {
      fs.writeFileSync = originalWrite;
      fs.renameSync = () => { throw new Error('injected rename failure'); };
    }
    try {
      assert.throws(() => writeFileAtomic(file, 'private'), new RegExp(`injected ${phase} failure`));
    } finally {
      fs.writeFileSync = originalWrite;
      fs.renameSync = originalRename;
    }
    leftovers.push(...fs.readdirSync(base));
  }
  assert.deepEqual(leftovers, [], 'write and rename failures must leave no atomic temp files');
});

test('readJson returns fallback only for missing files and reports invalid JSON or I/O failures', (t) => {
  const base = temp(t);
  assert.equal(readJson(path.join(base, 'none.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(base, 'bad.json'), '{oops');
  assert.throws(() => readJson(path.join(base, 'bad.json'), null), (e) => e.code === 'INVALID_JSON' && e.exitCode === 2 && e.details.path.endsWith('bad.json'));
  assert.throws(() => readJson(base, null), (e) => e.code === 'READ_FAILED' && e.exitCode === 5 && e.details.path === base);
});

test('loadState returns the default shape when state.json is missing', (t) => {
  assert.deepEqual(loadState(temp(t)), { version: 1, claudeSessions: [], jobs: [] });
});

test('loadState backs up a corrupted state.json and rebuilds jobs from jobs/*.json', (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'jobs'));
  fs.writeFileSync(path.join(dir, 'jobs', 'task-1.json'), JSON.stringify({ id: 'task-1', status: 'completed' }));
  fs.writeFileSync(path.join(dir, 'jobs', 'broken.json'), '{');
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  const state = loadState(dir);
  assert.deepEqual(state.jobs.map((j) => j.id), ['task-1']);
  assert.deepEqual(state.rebuildWarnings, ['broken.json']);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('state.json.corrupt-')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs.map((j) => j.id), ['task-1']);
});

test('loadState throws STATE_UNREADABLE for a jobs directory that cannot be listed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const dir = temp(t);
  const jobsDir = path.join(dir, 'jobs');
  fs.mkdirSync(jobsDir);
  fs.writeFileSync(path.join(dir, 'state.json'), 'invalid');
  fs.chmodSync(jobsDir, 0o000);
  try {
    assert.throws(() => loadState(dir), (err) => err.code === 'STATE_UNREADABLE' && err.exitCode === 5 && err.details.path === jobsDir);
  } finally {
    fs.chmodSync(jobsDir, 0o700);
  }
});

test('corrupt state backup is mode 600 even when source is mode 644', posixOnly, (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'invalid', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  loadState(dir);
  const backup = fs.readdirSync(dir).find((name) => name.startsWith('state.json.corrupt-'));
  assert.equal(fs.statSync(path.join(dir, backup)).mode & 0o777, 0o600);
});

test('updateState serializes concurrent mutations under state.lock', async (t) => {
  const dir = temp(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => updateState(dir, (s) => {
    s.jobs.push({ id: `job-${i}`, status: 'completed' });
  })));
  assert.equal(loadState(dir).jobs.length, 10);
  const replaced = await updateState(dir, () => ({ claudeSessions: [{ sessionId: 's' }], jobs: [] }));
  assert.deepEqual(replaced, { version: 1, claudeSessions: [{ sessionId: 's' }], jobs: [] });
  assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false);
});

test('listActiveJobs filters by ACTIVE_JOB_STATUSES', async (t) => {
  const dir = temp(t);
  assert.deepEqual([...ACTIVE_JOB_STATUSES], ['queued', 'running', 'waiting_permission']);
  await updateState(dir, (s) => {
    s.jobs.push({ id: 'a', status: 'running' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'waiting_permission' });
  });
  assert.deepEqual(listActiveJobs(dir).map((j) => j.id), ['a', 'c']);
});

for (const invalid of [null, [], 'state', 42, { version: 2, jobs: [], claudeSessions: [] },
  { version: 1, jobs: {}, claudeSessions: [] }, { version: 1, jobs: [], claudeSessions: {} }, {}]) {
  test(`structurally invalid state is backed up and rebuilt: ${JSON.stringify(invalid)}`, async (t) => {
    const dir = temp(t);
    const raw = JSON.stringify(invalid);
    fs.mkdirSync(path.join(dir, 'jobs'));
    const job = { id: 'recovered', status: 'running' };
    fs.writeFileSync(path.join(dir, 'jobs', 'recovered.json'), JSON.stringify(job));
    fs.writeFileSync(path.join(dir, 'state.json'), raw, { mode: 0o644 });
    const state = await updateState(dir, (s) => { s.claudeSessions.push({ id: 'new' }); });
    assert.deepEqual(state.jobs, [job]);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
    const backup = path.join(dir, backups[0]);
    assert.equal(fs.readFileSync(backup, 'utf8'), raw);
    if (process.platform !== 'win32') assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(loadState(dir).version, 1);
  });
}
