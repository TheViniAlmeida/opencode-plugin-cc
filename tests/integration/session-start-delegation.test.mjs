import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  testEnv, makeWorkspace, runCli, writeGlobalConfig, writeWorkspaceConfig, stateDirFor,
} from '../helpers.mjs';
import { delegationReminder } from '../../plugins/opc/scripts/lib/render.mjs';
import { loadState } from '../../plugins/opc/scripts/lib/state.mjs';

async function sessionStart(t, { globalCfg = null, workspaceCfg = null, invalidScope = null } = {}) {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true, mode: 0o700 });
  if (globalCfg) writeGlobalConfig(env, globalCfg);
  if (workspaceCfg) writeWorkspaceConfig(ws, workspaceCfg);
  if (invalidScope === 'global') fs.writeFileSync(path.join(env.OPC_DATA_DIR, 'config.json'), '{invalid json', { mode: 0o600 });
  if (invalidScope === 'workspace') fs.writeFileSync(path.join(ws, '.opc.json'), '{invalid json');
  const envFile = path.join(env.OPC_DATA_DIR, 'claude-env.sh');
  fs.writeFileSync(envFile, '');
  const r = await runCli(['hook-session-start'], {
    env: { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: env.OPC_DATA_DIR },
    cwd: ws,
    stdin: JSON.stringify({ session_id: 'f4a-session-1', transcript_path: path.join(ws, 't.jsonl'), cwd: ws, hook_event_name: 'SessionStart', source: 'startup' }),
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  return { r, out, envFile, env, ws };
}

test('SessionStart injeta o lembrete em additionalContext quando ativo globalmente', async (t) => {
  const { r, out, envFile } = await sessionStart(t, { globalCfg: { delegation: { auto: true } } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart', JSON.stringify({ code: r.code, stdout: r.stdout, stderr: r.stderr }));
  assert.equal(out.hookSpecificOutput?.additionalContext, delegationReminder());
  assert.ok(out.hookSpecificOutput.additionalContext.length < 10_000);
  assert.match(fs.readFileSync(envFile, 'utf8'), /OPC_DATA_DIR/, 'exportação de ambiente F2b continua');
});

test('SessionStart não injeta lembrete quando desativado', async (t) => {
  const { r, out } = await sessionStart(t, { globalCfg: { delegation: { auto: false } } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

test('SessionStart sem configuração não injeta lembrete', async (t) => {
  const { r, out } = await sessionStart(t);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

test('workspace não pode ativar lembrete de delegação', async (t) => {
  const { r, out } = await sessionStart(t, { globalCfg: { delegation: { auto: false } }, workspaceCfg: { delegation: { auto: true } } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

test('workspace pode desativar lembrete de delegação', async (t) => {
  const { r, out } = await sessionStart(t, { globalCfg: { delegation: { auto: true } }, workspaceCfg: { delegation: { auto: false } } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

for (const scope of ['global', 'workspace']) {
  test(`SessionStart com config ${scope} inválida registra sessão, exporta ambiente e desativa lembrete`, async (t) => {
    const opts = scope === 'global'
      ? { invalidScope: 'global' }
      : { globalCfg: { delegation: { auto: true } }, invalidScope: 'workspace' };
    const { r, out, envFile, env, ws } = await sessionStart(t, opts);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(envFile, 'utf8'), /export OPC_DATA_DIR=/);
    assert.ok(loadState(stateDirFor(env, ws)).claudeSessions.some((session) => session.sessionId === 'f4a-session-1'));
    assert.match(r.stderr, /^\[opc\] config inválida; lembrete de delegação desativado \(CONFIG_INVALID\)\.[\r\n]*$/);
    assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
  });
}
