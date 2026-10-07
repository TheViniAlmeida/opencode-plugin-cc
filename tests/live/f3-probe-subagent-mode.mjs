import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, MODELS, liveWorkspace, opc, record, note, parseList } from './_f3-lib.mjs';

test('F3 probe (§15 item 7): agente subagent-mode em child-session e subagent-tool', { skip: SKIP, timeout: 30 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const agentsRes = await opc(['agents', '--mode', 'subagent', '--json'], { env, cwd: ws });
  const agents = parseList(agentsRes.stdout, 'agents').filter((a) => a.mode === 'subagent');
  const agent = (agents.find((a) => a.name === 'explore') ?? agents.find((a) => a.name === 'general') ?? agents[0])?.name;
  assert.ok(agent, 'ao menos um agente em modo subagent');
  const findings = { agent };
  const child = await opc(['subagent', '--agent', agent, '--model', MODELS.deepseek, '--mechanism', 'child-session', '--json', 'Reply with the single word PROBE.'], { env, cwd: ws });
  record(`probe child-session (${agent})`, child, dataDir);
  const childMember = JSON.parse(child.stdout).members[0];
  findings.childSession = { status: childMember.status, fellBack: childMember.result?.fellBack, mechanism: childMember.result?.mechanism, error: childMember.errorMessage ?? null };
  if (childMember.status === 'completed' && !childMember.result.fellBack) {
    const shown = JSON.parse((await opc(['session', 'show', childMember.sessionID, '--json'], { env, cwd: ws })).stdout);
    const assistant = shown.messages.filter((m) => m.type === 'assistant').at(-1);
    findings.childSession.effectiveAgent = assistant?.agent ?? null;
    findings.childSession.sessionAgent = shown.session.agent ?? null;
  }
  const sub = await opc(['subagent', '--agent', agent, '--model', MODELS.deepseek, '--mechanism', 'subagent-tool', '--json', 'Reply with the single word PROBE.'], { env, cwd: ws });
  record(`probe subagent-tool (${agent})`, sub, dataDir);
  const subMember = JSON.parse(sub.stdout).members[0];
  findings.subagentTool = { status: subMember.status, finalText: subMember.result?.finalText?.slice(0, 200) ?? null };
  if (subMember.result?.carrierSessionID) {
    const kids = JSON.parse((await opc(['session', 'children', subMember.result.carrierSessionID, '--json'], { env, cwd: ws })).stdout).children;
    findings.subagentTool.grandchildren = kids.length;
    if (kids[0]) { const grand = JSON.parse((await opc(['session', 'show', kids[0].id, '--json'], { env, cwd: ws })).stdout).session; findings.subagentTool.grandchildHasPermissionRules = Array.isArray(grand.permissions) && grand.permissions.length > 0; }
  }
  findings.conclusion = findings.childSession.status === 'completed' && !findings.childSession.fellBack
    ? `child-session aceita o agente ${agent} (agente efetivo: ${findings.childSession.effectiveAgent})`
    : `child-session recusada ou falhou; subagent-tool: ${findings.subagentTool.status}`;
  note('§15 item 7 — resultado', findings, dataDir);
  assert.ok(childMember.status === 'completed' || subMember.status === 'completed', 'ao menos um mecanismo deve funcionar');
});
