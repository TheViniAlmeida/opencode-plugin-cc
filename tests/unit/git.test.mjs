// Adapted from openai/codex-plugin-cc (Apache-2.0); modified
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CHUNKED_GUIDANCE,
  DEFAULT_MAX_INLINE_BYTES,
  collectReviewContext,
  detectDefaultBranch,
  diffSizeEstimate,
  parseShortstat,
  resolveReviewTarget,
} from '../../plugins/opc/scripts/lib/git.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

function run(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function repo(t) {
  const cwd = trackTempDir(t, makeTempDir('opc-git-test-'));
  run(cwd, ['init', '-b', 'main']);
  run(cwd, ['config', 'user.name', 'opc tests']);
  run(cwd, ['config', 'user.email', 'tests@example.com']);
  run(cwd, ['config', 'commit.gpgsign', 'false']);
  write(cwd, 'app.js', "console.log('v1');\n");
  commitAll(cwd, 'init');
  return cwd;
}

function write(cwd, rel, content) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commitAll(cwd, message) {
  run(cwd, ['add', '-A']);
  run(cwd, ['commit', '-m', message]);
}

function assertCompleteChunkedContext(context, maxInlineBytes) {
  assert.ok(Buffer.byteLength(context.content) <= maxInlineBytes);
  assert.match(context.content, /## Arquivos omitidos\n\n(?:\(none\)|[^\n]+(?:\n[^\n]+)*)\n?$/);
  for (const heading of context.content.matchAll(/^## .+$/gm)) {
    const body = context.content.slice(heading.index + heading[0].length).match(/^\n\n([^\n](?:[\s\S]*?))(?=\n## |\n?$)/)?.[1];
    assert.ok(body?.trim(), `${heading[0]} has a complete non-empty body`);
  }
  for (const file of context.includedFiles) {
    assert.ok(context.content.includes(`### ${file}\n`), `included file ${file} has a rendered diff header`);
  }
  const omittedBody = context.content.match(/## Arquivos omitidos\n\n([\s\S]*)$/)?.[1] ?? '';
  const omittedLines = omittedBody.split('\n').filter((line) => line && line !== '(none)' && !line.startsWith('e mais '));
  for (const file of omittedLines) {
    assert.ok(context.omittedFiles.includes(file), `listed omitted file ${file} is accounted for`);
  }
  const omittedMarker = omittedBody.match(/e mais (\d+) arquivos/);
  if (omittedMarker) {
    assert.equal(Number(omittedMarker[1]), context.omittedFiles.length - omittedLines.length);
  } else if (context.omittedFiles.length) {
    assert.equal(omittedLines.length, context.omittedFiles.length);
  }
}

test('resolveReviewTarget prefers the working tree when the repo is dirty', (t) => {
  const cwd = repo(t);
  write(cwd, 'app.js', "console.log('v2');\n");
  assert.equal(resolveReviewTarget(cwd, {}).mode, 'working-tree');
});

test('resolveReviewTarget falls back to the branch diff when the repo is clean', (t) => {
  const cwd = repo(t);
  run(cwd, ['checkout', '-b', 'feature/test']);
  write(cwd, 'app.js', "console.log('BRANCH_MARKER');\n");
  commitAll(cwd, 'change');
  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);
  assert.equal(target.mode, 'branch');
  assert.equal(target.baseRef, 'main');
  assert.match(context.content, /## Diff da branch/);
  assert.match(context.content, /BRANCH_MARKER/);
  assert.deepEqual(context.files, ['app.js']);
});

test('resolveReviewTarget honors an explicit base and rejects option-like or unknown refs', (t) => {
  const cwd = repo(t);
  run(cwd, ['checkout', '-b', 'feature/test']);
  write(cwd, 'app.js', "console.log('v2');\n");
  commitAll(cwd, 'change');
  assert.deepEqual(resolveReviewTarget(cwd, { base: 'main' }), {
    mode: 'branch',
    label: 'diff da branch em relação a main',
    baseRef: 'main',
    explicit: true,
  });
  assert.throws(() => resolveReviewTarget(cwd, { base: '--output=/tmp/x' }), (err) => err.code === 'INVALID_BASE' && err.exitCode === 2 && /Referência base inválida/.test(err.message));
  assert.throws(() => resolveReviewTarget(cwd, { base: 'no-such-branch' }), (err) => err.code === 'UNKNOWN_BASE' && err.exitCode === 2 && /Referência base desconhecida/.test(err.message));
});

test('resolveReviewTarget rejects unsupported scopes with a usage error', (t) => {
  const cwd = repo(t);
  assert.throws(() => resolveReviewTarget(cwd, { scope: 'staged' }), (err) => err.code === 'INVALID_SCOPE' && err.exitCode === 2 && /Escopo de revisão não suportado/.test(err.message));
});

test('resolveReviewTarget requires an explicit base when no default branch can be inferred', (t) => {
  const cwd = repo(t);
  run(cwd, ['branch', '-m', 'feature-only']);
  assert.throws(() => resolveReviewTarget(cwd, {}), /Não foi possível detectar a branch padrão do repositório\. Informe --base <valor> ou use --scope working-tree\./);
});

test('default branch names with special characters are passed to git literally', (t) => {
  const cwd = repo(t);
  const branchName = 'main&branch-helper&x';
  run(cwd, ['branch', '-m', branchName]);
  run(cwd, ['update-ref', `refs/remotes/origin/${branchName}`, branchName]);
  run(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branchName}`]);
  run(cwd, ['checkout', '-b', 'feature/test']);
  write(cwd, 'app.js', "console.log('feature');\n");
  commitAll(cwd, 'feature');
  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /## Diff da branch/);
});

test('non-git directories fail with a usage error', (t) => {
  const cwd = trackTempDir(t, makeTempDir('opc-nogit-'));
  assert.throws(() => resolveReviewTarget(cwd, {}), (err) => err.code === 'NOT_A_GIT_REPO' && err.exitCode === 2 && /precisa ser executado dentro de um repositório Git/.test(err.message));
});

test('assembled inline headers count toward the limit and produce a complete omitted list', (t) => {
  const cwd = repo(t);
  const names = Array.from({ length: 24 }, (_, index) => `nested/${String(index).padStart(2, '0')}-${'name'.repeat(8)}.js`);
  for (const name of names) write(cwd, name, `export const marker = '${name}';\n`);
  const baseline = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes: 1024 * 1024 });
  const maxInlineBytes = baseline.diffBytes + 1;
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes });
  assert.ok(context.diffBytes <= maxInlineBytes);
  assert.equal(context.inputMode, 'chunked');
  assert.equal(context.truncated, true);
  assert.ok(context.omittedFiles.length > 0);
  assert.match(context.content, /## Arquivos omitidos/);
  assertCompleteChunkedContext(context, maxInlineBytes);
  assert.doesNotMatch(context.content, /## Status do Git/);
  assert.match(context.content, /## Estatísticas do diff/);
});

test('status and log are dropped as complete sections when they exceed the limit (L2)', (t) => {
  const cwd = repo(t);
  const names = Array.from({ length: 24 }, (_, index) => `nested/${String(index).padStart(2, '0')}-${'name'.repeat(8)}.js`);
  for (const name of names) write(cwd, name, `export const marker = '${name}';\n`);
  const baseline = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes: 1024 * 1024 });
  const maxInlineBytes = baseline.diffBytes + 1;
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes });

  assert.equal(context.inputMode, 'chunked');
  assert.doesNotMatch(context.content, /## Status do Git|## Log de commits/);
  assert.match(context.content, /## Estatísticas do diff/);
  assertCompleteChunkedContext(context, maxInlineBytes);
});

test('an oversized stat selects the complete summarized fallback level (L3)', (t) => {
  const cwd = repo(t);
  const names = Array.from({ length: 40 }, (_, index) => `${'long-directory/'.repeat(4)}file-${index}.js`);
  for (const name of names) write(cwd, name, `export const marker_${indexOf(name)} = 1;\n`);
  const maxInlineBytes = 1200;
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes });

  assert.equal(context.inputMode, 'chunked');
  assert.match(context.content, /## Estatísticas resumidas/);
  assert.match(context.content, /## Arquivos alterados/);
  assertCompleteChunkedContext(context, maxInlineBytes);
});

test('a limit too small for the complete L4 scaffold raises REVIEW_CONTEXT_LIMIT', (t) => {
  const cwd = repo(t);
  write(cwd, 'app.js', "export const value = 'changed';\n");
  assert.throws(
    () => collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes: 32 }),
    (err) => err.code === 'REVIEW_CONTEXT_LIMIT' && err.exitCode === 2 && /32 bytes/.test(err.message),
  );
});

test('oversized diff stat falls back to shortstat and a capped plain filename list', (t) => {
  const cwd = repo(t);
  const names = Array.from({ length: 40 }, (_, index) => `${'long-directory/'.repeat(4)}file-${index}.js`);
  for (const name of names) write(cwd, name, `export const marker_${indexOf(name)} = 1;\n`);
  const maxInlineBytes = 1200;
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }), { maxInlineBytes });
  assert.equal(context.inputMode, 'chunked');
  assert.equal(context.truncated, true);
  assert.match(context.content, /Estatísticas resumidas/);
  assert.match(context.content, /estatísticas detalhadas foram resumidas/);
  assert.match(context.content, /Arquivos alterados/);
  assert.match(context.content, /e mais \d+ arquivos/);
  assert.match(context.content, /## Arquivos omitidos/);
  assert.ok(Buffer.byteLength(context.content) <= maxInlineBytes);
});

test('chunked output caps huge excluded lists and keeps included files in the rendered diffs', (t) => {
  const cwd = repo(t);
  const excludedNames = Array.from({ length: 48 }, (_, index) => `${'very-long-directory-name/'.repeat(5)}excluded-${index}.env`);
  excludedNames.forEach((name) => write(cwd, name, `export const excluded_${indexOf(name)} = 1;\n`));
  write(cwd, 'visible.js', "export const visible = 'VISIBLE_DIFF_MARKER';\n");

  const maxInlineBytes = 2048;
  const context = collectReviewContext(
    cwd,
    resolveReviewTarget(cwd, { scope: 'working-tree' }),
    { maxInlineBytes, excludeGlobs: ['**/*.env'] },
  );

  assert.equal(context.inputMode, 'chunked');
  assert.ok(context.content.includes('e mais '), 'the excluded list should be capped');
  assert.ok(Buffer.byteLength(context.content) <= maxInlineBytes, `content is ${Buffer.byteLength(context.content)} bytes`);
  assert.match(context.content, /VISIBLE_DIFF_MARKER/);
  for (const file of context.includedFiles) {
    assert.ok(context.content.includes(`### ${file}\n`), `included file ${file} has a rendered diff header`);
  }
});

function indexOf(name) {
  return Number(name.match(/file-(\d+)/)?.[1] ?? 0);
}

test('origin default branch uses remote tracking ref when no local branch exists', (t) => {
  const base = trackTempDir(t, makeTempDir('opc-git-remote-'));
  const source = path.join(base, 'source');
  const bare = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  fs.mkdirSync(source);
  run(source, ['init', '-b', 'main']);
  run(source, ['config', 'user.name', 'opc tests']);
  run(source, ['config', 'user.email', 'tests@example.com']);
  run(source, ['config', 'commit.gpgsign', 'false']);
  write(source, 'app.js', 'export const base = 1;\n');
  commitAll(source, 'base');
  run(base, ['init', '--bare', bare]);
  run(source, ['remote', 'add', 'origin', bare]);
  run(source, ['push', '-u', 'origin', 'main']);
  fs.mkdirSync(clone);
  run(clone, ['init', '-b', 'main']);
  run(clone, ['remote', 'add', 'origin', bare]);
  run(clone, ['fetch', 'origin']);
  run(clone, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  run(clone, ['checkout', '-b', 'feature', 'origin/main']);
  run(clone, ['config', 'user.name', 'opc tests']);
  run(clone, ['config', 'user.email', 'tests@example.com']);
  run(clone, ['config', 'commit.gpgsign', 'false']);
  write(clone, 'app.js', 'export const feature = 1;\n');
  commitAll(clone, 'feature');
  const target = resolveReviewTarget(clone, {});
  assert.equal(target.baseRef, 'origin/main');
  assert.match(collectReviewContext(clone, target).content, /feature/);
});

test('git errors distinguish non-repositories from IO failures and redact stderr', (t) => {
  const cwd = trackTempDir(t, makeTempDir('opc-git-io-'));
  const file = path.join(cwd, 'not-a-directory');
  fs.writeFileSync(file, 'x');
  assert.throws(() => resolveReviewTarget(file, {}), (err) => err.code === 'GIT_FAILED' && err.exitCode === 2 && err.message.startsWith('Falha ao executar git') && err.message.length <= 240);
});

test('failed default-branch probes become GIT_FAILED with a bounded stderr summary', (t) => {
  const cwd = repo(t);
  const shimDir = trackTempDir(t, makeTempDir('opc-git-shim-'));
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(shim, '#!/bin/sh\necho "fatal: Permission denied /private/operator/path" >&2\nexit 2\n');
  fs.chmodSync(shim, 0o755);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = shimDir;
    assert.throws(() => detectDefaultBranch(cwd), (err) => err.code === 'GIT_FAILED' && /Falha ao executar git symbolic-ref:/.test(err.message) && !err.message.includes('/private/operator/path') && Buffer.byteLength(err.message.split(': ').slice(1).join(': ')) <= 210);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('small working-tree diffs are inlined, including untracked files', (t) => {
  const cwd = repo(t);
  write(cwd, 'app.js', "console.log('INLINE_MARKER');\n");
  write(cwd, 'new file.js', "export const created = 'UNTRACKED_MARKER';\n");
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));
  assert.equal(context.inputMode, 'inline-diff');
  assert.equal(context.truncated, false);
  assert.deepEqual(context.files, ['app.js', 'new file.js']);
  assert.match(context.content, /## Status do Git/);
  assert.match(context.content, /## Diff/);
  assert.match(context.content, /INLINE_MARKER/);
  assert.match(context.content, /UNTRACKED_MARKER/);
  assert.match(context.guidance, /evidência principal/);
});

test('untracked directories, symlinks and binary files are skipped without reading them', (t) => {
  const cwd = repo(t);
  const outside = trackTempDir(t, makeTempDir('opc-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_MARKER\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'link-to-outside'));
  fs.symlinkSync('missing-target', path.join(cwd, 'broken-link'));
  fs.writeFileSync(path.join(cwd, 'image.bin'), Buffer.from([0x89, 0x00, 0x01, 0x02]));
  const nested = path.join(cwd, '.claude', 'worktrees', 'agent-test');
  fs.mkdirSync(nested, { recursive: true });
  run(nested, ['init', '-b', 'main']);
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: 'working-tree' }));
  assert.doesNotMatch(context.content, /OUTSIDE_MARKER/);
  assert.match(context.content, /### link-to-outside\n\(ignorado: link simbólico\)/);
  assert.match(context.content, /### broken-link\n\(ignorado: link simbólico\)/);
  assert.match(context.content, /### image\.bin\n\(ignorado: arquivo binário\)/);
  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(ignorado: diretório\)/);
});

test('files matching policy.sensitivePaths are excluded from the collected context', (t) => {
  const cwd = repo(t);
  write(cwd, 'config/secrets.env', 'TOKEN=old\n');
  commitAll(cwd, 'add secrets');
  write(cwd, 'config/secrets.env', 'TOKEN=TRACKED_SECRET_MARKER\n');
  write(cwd, '.env', 'API_KEY=UNTRACKED_SECRET_MARKER\n');
  write(cwd, 'app.js', "console.log('VISIBLE_MARKER');\n");
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { excludeGlobs: ['*.env', '**/secrets.env'] });
  assert.doesNotMatch(context.content, /SECRET_MARKER/);
  assert.match(context.content, /VISIBLE_MARKER/);
  assert.match(context.content, /## Arquivos excluídos \(policy\.sensitivePaths\)\n\n\.env\nconfig\/secrets\.env/);
  assert.deepEqual(context.excludedFiles, ['.env', 'config/secrets.env']);
});

test('huge-diff: more than 400 KB switches to chunked mode with the full stat and the smallest diffs first', (t) => {
  const cwd = repo(t);
  const bigBody = (tag, index) =>
    Array.from({ length: 400 }, (_, line) => `export const ${tag}_${index}_${line} = '${'x'.repeat(40)}';`).join('\n') + '\n';
  const bigNames = Array.from({ length: 30 }, (_, index) => `big/file-${String(index).padStart(2, '0')}.js`);
  const smallNames = Array.from({ length: 5 }, (_, index) => `small/s${index}.js`);
  bigNames.forEach((name, index) => write(cwd, name, bigBody('OLD', index)));
  smallNames.forEach((name, index) => write(cwd, name, `export const s${index} = 1;\n`));
  commitAll(cwd, 'base');
  bigNames.forEach((name, index) => write(cwd, name, bigBody('NEW', index)));
  smallNames.forEach((name, index) => write(cwd, name, `export const s${index} = 'SMALL_MARKER_${index}';\n`));

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));

  assert.equal(context.truncated, true);
  assert.equal(context.inputMode, 'chunked');
  assert.equal(context.guidance, CHUNKED_GUIDANCE);
  assert.match(context.guidance, /ferramenta read/);
  assert.ok(context.diffBytes > DEFAULT_MAX_INLINE_BYTES);
  assert.ok(Buffer.byteLength(context.content) <= DEFAULT_MAX_INLINE_BYTES, `content is ${Buffer.byteLength(context.content)} bytes`);
  assert.match(context.content, /## Estatísticas do diff/);
  for (const name of [...bigNames, ...smallNames]) assert.ok(context.content.includes(name), `stat lists ${name}`);
  smallNames.forEach((_, index) => assert.match(context.content, new RegExp(`SMALL_MARKER_${index}`)));
  assert.deepEqual([...context.includedFiles.slice(0, 5)].sort(), smallNames);
  assert.ok(context.omittedFiles.length > 0);
  assert.ok(context.includedFiles.length + context.omittedFiles.length === 35);
  for (const file of context.includedFiles) {
    assert.ok(context.content.includes(`### ${file}\n`), `included file ${file} has a rendered diff header`);
  }
  assert.match(context.content, /## Arquivos omitidos/);
});

test('an oversized single-file diff is omitted but still listed in the stat', (t) => {
  const cwd = repo(t);
  write(cwd, 'app.js', `export const value = '${'x'.repeat(16384)}';\n`);
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { maxInlineBytes: 4096 });
  assert.equal(context.inputMode, 'chunked');
  assert.deepEqual(context.omittedFiles, ['app.js']);
  assert.doesNotMatch(context.content, /xxxxxxxxxx/);
  assert.match(context.content, /## Estatísticas do diff/);
});

test('branch reviews also switch to chunked mode and keep per-file diffs for odd file names', (t) => {
  const cwd = repo(t);
  run(cwd, ['checkout', '-b', 'feature/odd']);
  write(cwd, 'a b.js', "export const a = 'SPACE_MARKER';\n");
  write(cwd, 'ação.js', "export const b = 'UNICODE_MARKER';\n");
  write(cwd, 'star*.js', "export const c = 'GLOB_MARKER';\n");
  write(cwd, 'big.js', `${'y'.repeat(30000)}\n`);
  commitAll(cwd, 'odd names');
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { maxInlineBytes: 20 * 1024 });
  assert.equal(context.mode, 'branch');
  assert.equal(context.inputMode, 'chunked');
  assert.match(context.content, /SPACE_MARKER/);
  assert.match(context.content, /UNICODE_MARKER/);
  assert.match(context.content, /GLOB_MARKER/);
  assert.match(context.content, /### ação\.js/);
  assert.deepEqual(context.omittedFiles, ['big.js']);
});

test('diffSizeEstimate counts staged, unstaged and untracked work', (t) => {
  const cwd = repo(t);
  write(cwd, 'app.js', "console.log('v2');\n");
  write(cwd, 'new.js', 'a\nb\nc\n');
  write(cwd, 'staged.js', 'one\n');
  run(cwd, ['add', 'staged.js']);
  const target = resolveReviewTarget(cwd, {});
  assert.deepEqual(diffSizeEstimate(cwd, target), { files: 3, insertions: 5, deletions: 1 });
});

test('diffSizeEstimate measures the branch range', (t) => {
  const cwd = repo(t);
  run(cwd, ['checkout', '-b', 'feature/test']);
  write(cwd, 'app.js', "console.log('v2');\nconsole.log('v3');\n");
  commitAll(cwd, 'change');
  assert.deepEqual(diffSizeEstimate(cwd, resolveReviewTarget(cwd, {})), { files: 1, insertions: 2, deletions: 1 });
});

test('parseShortstat reads git --shortstat output', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), { files: 3, insertions: 10, deletions: 2 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), { files: 1, insertions: 1, deletions: 0 });
  assert.deepEqual(parseShortstat(''), { files: 0, insertions: 0, deletions: 0 });
});
