import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (name) => readFileSync(new URL(`../live/${name}.mjs`, import.meta.url), 'utf8');

test('LIVE-2: diff de notes.txt é exigido antes do revert; pós-unrevert é só registrado', () => {
  const code = source('f3-sessions');
  const firstDiff = code.indexOf("['session', 'diff', sid, '--json']");
  const revert = code.indexOf("['session', 'revert', sid, m2]");
  const assertion = code.indexOf("assert.ok(JSON.parse(res.stdout).diffs.some((d) => String(d.file).endsWith('notes.txt')))");
  assert.ok(firstDiff > 0 && firstDiff < assertion && assertion < revert);
  const afterUnrevert = code.slice(code.indexOf("['session', 'unrevert', sid, '--confirmed-by-user', '--json']"));
  assert.match(afterUnrevert, /await run\([^\n]*\['session', 'diff', sid, '--json'\]/);
  assert.doesNotMatch(afterUnrevert, /assert[^\n]*diffs/);
  assert.match(code, /assert\.deepEqual\(fileLines\(notes\), \['original', 'ALPHA'\]\)/);
  assert.match(afterUnrevert, /assert\.deepEqual\(fileLines\(notes\), \['original', 'ALPHA', 'BETA'\]\)/);
  assert.match(afterUnrevert, /session\.revert, undefined/);
});

test('LIVE-3: visibilidade é observação antes e depois do refresh após o término', () => {
  const code = source('f3-concurrent-storage');
  assert.doesNotMatch(code, /assert[^\n]*nonOpcSessionVisible/);
  const refresh = code.indexOf("['sessions', '--all', '--refresh', '--json']");
  assert.ok(refresh > code.indexOf('const finishedJob ='));
  assert.ok(refresh < code.indexOf('const findings ='));
  assert.match(code, /nonOpcSessionVisibleToPluginServerAfterRefresh:\s*[^\n]+\.some\(/);
  assert.match(code, /note\('§15 item 12 — parte automatizada', findings, dataDir\)/);
  assert.match(code, /assert\.equal\(lockErrors, false\)/);
  assert.match(code, /assert\.ok\(Date\.parse\(finishedJob\.completedAt\) > direct\.startedAt/);
});
