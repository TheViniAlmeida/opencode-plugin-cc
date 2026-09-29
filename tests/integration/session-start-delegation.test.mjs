import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  testEnv, makeWorkspace, runCli, writeGlobalConfig, writeWorkspaceConfig,
} from '../helpers.mjs';
import { delegationReminder } from '../../plugins/opc/scripts/lib/render.mjs';

async function sessionStart(t, { globalCfg = null, workspaceCfg = null } = {}) {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  if (globalCfg) writeGlobalConfig(env, globalCfg);
  if (workspaceCfg) writeWorkspaceConfig(ws, workspaceCfg);
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true });
  const envFile = path.join(env.OPC_DATA_DIR, 'claude-env.sh');
  fs.writeFileSync(envFile, '');
  const r = await runCli(['hook-session-start'], {
    env: { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: env.OPC_DATA_DIR },
    cwd: ws,
    stdin: JSON.stringify({ session_id: 'f4a-session-1', transcript_path: path.join(ws, 't.jsonl'), cwd: ws, hook_event_name: 'SessionStart', source: 'startup' }),
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  return { r, out, envFile };
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
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

test('SessionStart sem configuração não injeta lembrete', async (t) => {
  const { r, out } = await sessionStart(t);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

test('workspace não pode ativar lembrete de delegação', async (t) => {
  const { r, out } = await sessionStart(t, { globalCfg: { delegation: { auto: false } }, workspaceCfg: { delegation: { auto: true } } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});

test('workspace pode desativar lembrete de delegação', async (t) => {
  const { r, out } = await sessionStart(t, { globalCfg: { delegation: { auto: true } }, workspaceCfg: { delegation: { auto: false } } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
});
