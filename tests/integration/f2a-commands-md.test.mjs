import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from '../helpers.mjs';

function frontmatter(file) {
  const text = readFileSync(join(PLUGIN_ROOT, 'commands', file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file} has frontmatter`);
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }));
  return { fields, body: match[2] };
}

const EXPECT = {
  'task.md': { sub: 'task --raw-args-stdin', modelInvocable: true, ask: true },
  'ask.md': { sub: 'ask --raw-args-stdin', modelInvocable: true, ask: true },
  'plan.md': { sub: 'plan --raw-args-stdin', modelInvocable: true, ask: true },
  'status.md': { sub: 'status --args-stdin', modelInvocable: false, ask: false },
  'result.md': { sub: 'result --args-stdin', modelInvocable: false, ask: false },
  'cancel.md': { sub: 'cancel --args-stdin', modelInvocable: false, ask: false },
  'permissions.md': { sub: 'permissions --args-stdin', modelInvocable: true, ask: true },
};

for (const [file, expected] of Object.entries(EXPECT)) {
  test(`commands/${file}: frontmatter per spec §4/§8.4 and quoted heredoc invocation`, () => {
    const { fields, body } = frontmatter(file);
    assert.ok(fields.description, 'description');
    assert.ok(fields['argument-hint'] !== undefined, 'argument-hint');
    assert.equal(fields['disable-model-invocation'] === 'true', !expected.modelInvocable);
    assert.match(fields['allowed-tools'], /Bash\(opc:\*\)/);
    assert.equal(/AskUserQuestion/.test(fields['allowed-tools']), expected.ask);
    assert.doesNotMatch(fields['allowed-tools'], /Bash\(node|dangerously|no-verify/);
    assert.ok(body.includes(`opc ${expected.sub} <<'OPC_ARGS_5f1d0c7a_EOF'\n$ARGUMENTS\nOPC_ARGS`), `${file} heredoc`);
  });
}
