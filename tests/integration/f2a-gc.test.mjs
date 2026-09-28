import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opc, setupF2a } from '../helpers.mjs';

function oldState(env, name, days) {
  const dir = join(env.OPC_DATA_DIR, 'state', name);
  mkdirSync(join(dir, 'jobs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'state.json'), '{"version":1,"claudeSessions":[],"jobs":[]}', { mode: 0o600 });
  const when = new Date(Date.now() - days * 86400000);
  for (const p of [join(dir, 'state.json'), join(dir, 'jobs'), dir]) utimesSync(p, when, when);
  return dir;
}

test('gc: lista e exige confirmação sem TTY; remove com --confirmed-by-user', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const stale = oldState(ctx.env, 'old-ws-0123456789abcdef', 45);
  const fresh = oldState(ctx.env, 'fresh-ws-0123456789abcdee', 2);
  const dry = await opc(ctx, ['gc']);
  assert.equal(dry.code, 2);
  assert.match(dry.stdout, /old-ws-0123456789abcdef/);
  assert.doesNotMatch(dry.stdout, /fresh-ws/);
  assert.ok(existsSync(stale));
  const done = await opc(ctx, ['gc', '--confirmed-by-user']);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(fresh));
  const nothing = await opc(ctx, ['gc']);
  assert.equal(nothing.code, 0);
  assert.match(nothing.stdout, /nenhum estado de workspace sem uso/);
});
