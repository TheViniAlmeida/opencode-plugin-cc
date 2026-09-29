import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, MODELS, liveWorkspace, opc, record, note, treeChecksum, parseList } from './_f3-lib.mjs';
const RISKY = /init|commit|push|deploy|release|delete|remove|clean|reset|migrate/i;

test('F3 live: comando OpenCode inofensivo executa em modo somente leitura', { skip: SKIP, timeout: 30 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const catalog = await opc(['catalog', 'commands', '--json'], { env, cwd: ws });
  assert.equal(catalog.code, 0, catalog.stderr);
  const candidates = parseList(catalog.stdout, 'commands').filter((c) => (c.source ?? 'command') === 'command' && !c.subtask && !RISKY.test(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  note('comandos candidatos', candidates.map((c) => ({ name: c.name, agent: c.agent ?? null, model: c.model ?? null })), dataDir);
  if (!candidates.length) { note('NÃO VALIDADO', { reason: 'nenhum comando inofensivo disponível em GET /command' }, dataDir); t.skip('NÃO VALIDADO: nenhum comando inofensivo disponível'); return; }
  const chosen = candidates[0]; const before = treeChecksum(ws);
  const res = await opc(['command', chosen.name, '--model', MODELS.kimi, '--json'], { env, cwd: ws });
  record(`command /${chosen.name}`, res, dataDir);
  assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  const { job } = JSON.parse(res.stdout);
  assert.equal(job.status, 'completed'); assert.ok(job.result.finalText.length > 0);
  assert.equal(treeChecksum(ws), before, 'o comando somente leitura não deve alterar o workspace');
});
