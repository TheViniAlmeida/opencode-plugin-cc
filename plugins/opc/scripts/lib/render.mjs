// Markdown rendering (no network I/O). Every output passes through redaction.
import { OpcError } from './opc-error.mjs';
import { shellQuote } from './args.mjs';
import { redact, redactText, redactOutput, redactTurnOutput, maskSecretPatterns, safeOutputText, maskDeep } from './redact.mjs';
import { isSecretLikeSetting } from './config.mjs';
import { ACTIVE_JOB_STATUSES } from './state.mjs';

function cell(value) {
  return redactText(String(value ?? '')).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function renderTable(headers, rows) {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
  return redactText(`${[head, sep, ...body].join('\n')}\n`);
}

// ---- F4a: lembrete de delegação (SessionStart) ------------------------------

export const DELEGATION_COMMANDS = [
  { cli: 'opc ask', slash: '/opc:ask', use: 'dúvidas sobre o código, investigação e análise de causa raiz' },
  { cli: 'opc plan', slash: '/opc:plan', use: 'planos de implementação: arquivos, ordem, escolhas, riscos e testes' },
  { cli: 'opc review --wait', slash: '/opc:review', use: 'revisão das alterações atuais' },
];

export function delegationReminder(commands = DELEGATION_COMMANDS) {
  const lines = commands.map((c) => `- ${c.use}: \`${c.cli}\` (${c.slash})`);
  return [
    'A delegação opc está ativa nesta sessão (delegation.auto). Para análises relevantes, encaminhe o trabalho ao OpenCode:',
    ...lines,
    'Siga a skill opc-delegation: evite perguntas triviais e pequenas edições, valide cada resultado antes de apresentá-lo e respeite a política do opc e a pessoa aprovadora. Siga também a opc-result-handling para pedidos de permissão; nunca responda sem o usuário. Nunca encadeie delegações.',
  ].join('\n');
}

export function renderError(err) {
  const code = err instanceof OpcError ? err.code : 'INTERNAL';
  const message = err?.message ?? String(err);
  return redactText(`# opc error\n${code}: ${message}\n`);
}

function check(ok) {
  if (ok === true) return 'ok';
  if (ok === false) return 'FALHA';
  return '—';
}

function renderServer(server) {
  if (!server) return [];
  const lines = ['## Servidor', ''];
  if (server.status === 'running' || server.status === 'attached') {
    lines.push(`- estado: ${server.status === 'attached' ? 'modo attach (servidor externo)' : 'rodando'}`);
    lines.push(`- url: ${server.url}`);
    if (server.pid) lines.push(`- pid: ${server.pid}`);
    lines.push(`- versão: ${server.version}`);
    if (server.status === 'attached') {
      lines.push('- reaproveitado: externo (attach)');
    } else {
      lines.push(`- reaproveitado: ${server.reused ? 'sim' : 'não (subiu agora)'}`);
    }
    lines.push(`- sessões: ${server.sessionsBlocked ? `BLOQUEADAS (${server.sessionsBlocked})` : 'liberadas'}`);
  } else if (server.status === 'error') {
    lines.push(`- estado: erro — ${server.error?.code && server.error?.message ? `${server.error.code}: ${server.error.message}` : 'erro: desconhecido'}`);
  } else {
    lines.push(`- estado: ${server.status}`);
  }
  for (const w of server.warnings ?? []) lines.push(`- aviso: ${w}`);
  lines.push('');
  return lines;
}

function renderStop(report) {
  const { stop } = report;
  const reasons = {
    'not-running': 'nenhum servidor do opc rodando neste workspace',
    attached: 'modo attach: o opc não encerra servidores externos',
    'active-jobs': 'recusado: há jobs ativos',
    terminated: 'servidor encerrado',
    killed: 'servidor encerrado à força (SIGKILL)',
    'identity-mismatch': 'o processo registrado não é mais o servidor do opc; registro removido, nenhum sinal enviado',
  };
  const lines = ['# opc setup — encerrar servidor', '', `Resultado: ${reasons[stop.reason] ?? stop.reason}`, ''];
  if (stop.reason === 'active-jobs' && report.activeJobs?.length) {
    lines.push('Jobs ativos:', '');
    lines.push(renderTable(['job', 'tipo', 'status', 'título'], report.activeJobs.map((j) => [j.id, j.kind, j.status, j.title ?? ''])));
    lines.push('Espere os jobs terminarem, cancele-os, ou use `--stop-server --force` com confirmação do usuário.');
  }
  if (report.warnings?.length) lines.push('', 'Avisos:', ...report.warnings.map((warning) => `- ${warning}`));
  return lines;
}

export function renderSetup(report) {
  if (report.mode === 'stop') return redactText(`${renderStop(report).join('\n').trimEnd()}\n`);
  const lines = [
    '# opc setup',
    '',
    `Status: ${report.ready ? 'pronto' : 'requer atenção'}`,
    '',
    '## Verificações',
    '',
    `- node: ${check(report.node?.ok)} (${report.node?.version})`,
    `- opencode: ${report.opencode?.installed ? `${check(report.opencode.supported)} (${report.opencode.version ?? 'versão desconhecida'})` : 'não encontrado'}`,
    `- diretório de dados: ${report.dataDir}`,
    `- workspace: ${report.workspaceRoot}`,
    `- estado: ${report.stateDir}`,
    `- config global: ${report.config?.hasGlobal ? report.config.globalPath : 'ainda não existe (onboarding na F1)'}`,
    `- .opc.json: ${report.config?.workspaceFound ? report.config.workspacePath : 'não encontrado'}`,
    '',
  ];
  if (report.config?.warnings?.length) {
    lines.push('## Avisos de configuração', '');
    for (const w of report.config.warnings) lines.push(`- ${w.path}: ${w.message}`);
    lines.push('');
  }
  lines.push(...renderServer(report.server));
  lines.push('## Terminal', '', 'Para usar o mesmo estado fora do Claude, adicione ao seu shell:', '', '```sh', report.terminalAlias, '```', '');
  if (report.nextSteps?.length) {
    lines.push('## Próximos passos', '');
    for (const s of report.nextSteps) lines.push(`- ${s}`);
    lines.push('');
  }
  return redactText(`${lines.join('\n').trimEnd()}\n`);
}

// ---- F1: discovery, config and onboarding renderers (pure; no network I/O) ----

const RenderF1 = Object.freeze({
  finish: (text) => redactText(text),
  settingValue: (setting, value) => (isSecretLikeSetting(setting) ? '***' : redact(value)),
  policy: (item) => (item.allowed === false ? `negado (${item.rule})` : 'permitido'),
  yesNo: (v) => (v ? 'sim' : 'não'),
  dash: (v) => (v === null || v === undefined || v === '' ? '—' : String(v)),
  json: (value) => `\`\`\`json\n${JSON.stringify(redact(value), null, 2)}\n\`\`\`\n`,
  warnings: (warnings = []) => (warnings.length
    ? redactText(`\n**Avisos**\n${warnings.map((w) => `- ${typeof w === 'string' ? w : `\`${w.path}\`: ${w.message}`}`).join('\n')}\n`)
    : ''),
});

export function renderProviders(view) {
  const rows = view.providers.map((p) => [p.id, p.name, RenderF1.yesNo(p.connected), p.modelCount, RenderF1.dash(p.defaultModel), RenderF1.policy(p)]);
  const title = view.all ? '# Providers do OpenCode (catálogo completo)' : '# Providers conectados';
  const body = rows.length ? renderTable(['Provider', 'Nome', 'Conectado', 'Modelos', 'Modelo padrão', 'Política'], rows) : 'Nenhum provider conectado. Rode `opencode auth login` no terminal.\n';
  return RenderF1.finish(`${title}\n\n${body}${RenderF1.warnings(view.warnings)}`);
}

export function renderModels(view) {
  const scope = view.provider ? ` de \`${view.provider}\`` : '';
  const flags = [view.all ? 'inclui não conectados' : null, view.allowedOnly ? 'só permitidos' : null].filter(Boolean);
  const title = `# Modelos${scope}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  if (!view.models.length) return RenderF1.finish(`${title}\n\nNenhum modelo encontrado.\n${RenderF1.warnings(view.warnings)}`);
  const headers = view.verbose
    ? ['Modelo', 'Nome', 'Variants', 'Contexto', 'Saída', 'Custo in/out (US$/M)', 'Status', 'Política']
    : ['Modelo', 'Nome', 'Variants', 'Política'];
  const rows = view.models.map((m) => (view.verbose
    ? [m.full, m.name, m.variants.join(', ') || '—', RenderF1.dash(m.limit.context), RenderF1.dash(m.limit.output), `${RenderF1.dash(m.cost.input)} / ${RenderF1.dash(m.cost.output)}`, RenderF1.dash(m.status), RenderF1.policy(m)]
    : [m.full, m.name, m.variants.join(', ') || '—', RenderF1.policy(m)]));
  return RenderF1.finish(`${title}\n\n${renderTable(headers, rows)}\n${view.models.length} modelo(s).\n${RenderF1.warnings(view.warnings)}`);
}

export function renderAgents(view) {
  const title = `# Agentes do OpenCode${view.mode && view.mode !== 'all' ? ` (modo ${view.mode})` : ''}`;
  if (!view.agents.length) return RenderF1.finish(`${title}\n\nNenhum agente encontrado.\n${RenderF1.warnings(view.warnings)}`);
  const headers = view.verbose
    ? ['Agente', 'Modo', 'Descrição', 'Nativo', 'Oculto', 'Modelo fixado', 'Variant', 'Política']
    : ['Agente', 'Modo', 'Descrição', 'Política'];
  const rows = view.agents.map((a) => (view.verbose
    ? [a.name, a.mode, RenderF1.dash(a.description), RenderF1.yesNo(a.native), RenderF1.yesNo(a.hidden), RenderF1.dash(a.pinnedModel), RenderF1.dash(a.variant), RenderF1.policy(a)]
    : [a.name, a.mode, RenderF1.dash(a.description), RenderF1.policy(a)]));
  return RenderF1.finish(`${title}\n\n${renderTable(headers, rows)}${RenderF1.warnings(view.warnings)}`);
}

export function renderCatalog(view) {
  if (view.kind === 'skills') {
    if (!view.items.length) return '# Skills do OpenCode\n\nNenhuma skill encontrada.\n';
    return `# Skills do OpenCode\n\n${renderTable(['Skill', 'Descrição', 'Local'], view.items.map((s) => [s.name, RenderF1.dash(s.description), s.location]))}`;
  }
  if (!view.items.length) return '# Commands do OpenCode\n\nNenhum command encontrado.\n';
  const rows = view.items.map((c) => [c.name, RenderF1.dash(c.description), RenderF1.dash(c.source), RenderF1.dash(c.agent), RenderF1.dash(c.model), RenderF1.policy(c)]);
  return `# Commands do OpenCode\n\n${renderTable(['Command', 'Descrição', 'Origem', 'Agente', 'Modelo fixado', 'Política'], rows)}`;
}

export function renderConfig(view) {
  switch (view.kind) {
    case 'path':
      return redactText(`# opc config path\n\n- Dados: \`${view.dataDir}\`\n- Global: \`${view.global}\`\n- Workspace: \`${view.workspace}\`\n- Rascunho do onboarding: \`${view.draft}\`\n`);
    case 'get':
      return RenderF1.finish(`${view.setting} = ${JSON.stringify(RenderF1.settingValue(view.setting, view.value))}\n`);
    case 'edit':
      return RenderF1.finish(`# opc config ${view.op}\n\n\`${view.setting}\` (${view.scope}) → \`${view.path}\`\n\nValor: \`${JSON.stringify(RenderF1.settingValue(view.setting, view.value ?? null))}\`\n${RenderF1.warnings(view.warnings)}`);
    case 'show':
      return redactText(`# opc config\n\n## Global (\`${view.paths.global}\`)\n\n${view.global ? RenderF1.json(view.global) : '_sem config global (rode /opc:setup)_\n'}\n## Workspace (\`${view.paths.workspace}\`)\n\n${view.workspace ? RenderF1.json(view.workspace) : '_sem .opc.json_\n'}${RenderF1.warnings(view.warnings)}`);
    case 'effective':
      return redactText(`# opc config efetiva\n\n${RenderF1.json(view.config)}${RenderF1.warnings(view.warnings)}`);
    case 'validate': {
      const status = view.errors.length || view.valid === false ? '**Config inválida ou incompleta.**' : '**Config válida.**';
      const server = view.serverChecked ? '' : `\n_A checagem contra o servidor não foi realizada: ${view.serverError}_\n`;
      const errors = view.errors.length ? `\n## Erros\n\n${renderTable(['Origem', 'Chave', 'Código', 'Mensagem'], view.errors.map((e) => [e.source, e.path, e.code, e.message]))}` : '';
      const warns = view.warnings.length ? `\n## Avisos\n\n${renderTable(['Origem', 'Chave', 'Código', 'Mensagem'], view.warnings.map((w) => [w.source, w.path, RenderF1.dash(w.code), w.message]))}` : '';
      return RenderF1.finish(`# opc config validate\n\n${status}\n${server}${errors}${warns}`);
    }
    default:
      throw new TypeError(`renderConfig: unknown view kind ${view.kind}`);
  }
}

export function renderOnboarding(view) {
  switch (view.kind) {
    case 'state': {
      const s = view.onboarding;
      const lines = [
        '## Onboarding',
        '',
        `- Config global: ${s.configExists ? 'existe' : 'ainda não existe'} (modo ${s.mode})`,
        `- OpenCode: ${s.opencodeInstalled ? `instalado (${s.opencodeVersion ?? 'versão ?'})` : 'não instalado'}`,
        `- Providers conectados: ${s.connectedProviders === null ? 'não consultados' : s.connectedProviders.length ? s.connectedProviders.map((p) => `${p.id} (${p.modelCount})`).join(', ') : 'nenhum'}`,
        `- Rascunho: ${s.draft.exists ? `sim, próxima etapa: ${s.nextStep ?? 'commit'}` : 'não'}`,
        `- Chaves travadas editáveis aqui: ${RenderF1.yesNo(s.lockedKeysEditable)}`,
      ];
      if (s.serverError) lines.push(`- Servidor: ${s.serverError}`);
      return RenderF1.finish(`\n${lines.join('\n')}\n`);
    }
    case 'models': {
      const rows = view.suggestions.map((m) => [m.full, m.name, m.variants.join(', ') || '—', RenderF1.dash(m.limit.context)]);
      const matches = view.matches ? `\n## Resultado da busca \`${view.query}\`\n\n${view.matches.length ? renderTable(['Modelo', 'Nome'], view.matches.map((m) => [m.full, m.name])) : 'Nada encontrado.\n'}` : '';
      return RenderF1.finish(`# Sugestões de modelo para \`${view.provider}\`\n\n${rows.length ? renderTable(['Modelo', 'Nome', 'Variants', 'Contexto'], rows) : 'Nenhum modelo permitido.\n'}${matches}`);
    }
    case 'apply':
      return RenderF1.finish(`# Rascunho atualizado\n\nAplicado: ${view.applied.map((k) => `\`${k}\``).join(', ')}\nPróxima etapa: ${view.nextStep ?? 'commit'}\n${RenderF1.warnings(view.warnings)}`);
    case 'commit':
      return RenderF1.finish(`# Config gravada\n\nEscopo: ${view.scope} → \`${view.path}\`\n${RenderF1.warnings(view.warnings)}`);
    case 'discard':
      return view.discarded ? '# Rascunho descartado\n' : '# Nenhum rascunho para descartar\n';
    default:
      throw new TypeError(`renderOnboarding: unknown view kind ${view.kind}`);
  }
}

// ---- F2a: renderização de jobs, turnos e solicitações de permissão ----
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.

const ACTIVE = new Set(['queued', 'running', 'waiting_permission']);
const RESUMABLE_KINDS = new Set(['task', 'ask', 'plan']);

export function formatDuration(startIso, endIso = null, now = Date.now()) {
  const start = Date.parse(startIso ?? '');
  if (!Number.isFinite(start)) return '';
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(end) || end < start) return '';
  const total = Math.round((end - start) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fence(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function codeBlock(text, lang = 'text') {
  const f = fence(text);
  return [`${f}${lang}`, String(text), f];
}

function jobActions(job) {
  const actions = [`/opc:status ${job.id}`];
  if (ACTIVE.has(job.status)) actions.push(`/opc:status ${job.id} --wait`, `/opc:cancel ${job.id}`);
  else actions.push(`/opc:result ${job.id}`);
  return actions;
}

function resumeHint(job) {
  if (!job.sessionID || !RESUMABLE_KINDS.has(job.kind) || ACTIVE.has(job.status)) return null;
  return `/opc:${job.kind} --resume ${job.id}`;
}

export function renderQueuedJob(job) {
  return redactText([
    `Tarefa opc ${job.id} na fila em segundo plano (${job.kind}${job.model ? `, ${job.model}` : ''}).`,
    `- Acompanhar: /opc:status ${job.id}`,
    `- Aguardar: /opc:status ${job.id} --wait`,
    `- Resultado: /opc:result ${job.id}`,
    `- Cancelar: /opc:cancel ${job.id}`,
    '',
  ].join('\n'));
}

function pendingLines(job, { timeoutSec = null } = {}) {
  const lines = [];
  for (const req of redactOutput(job.pendingRequest ?? [])) {
    if (req.type === 'question') {
      lines.push(`## Pergunta ${req.id}`, '');
      if (req.sessionID && req.sessionID !== job.sessionID) lines.push(`- Sessão: ${req.sessionID} (sessão filha)`);
      (req.questions ?? []).forEach((q, i) => {
        const options = (q.options ?? []).map((o) => o.label).join(' | ') || '(texto livre)';
        lines.push(`${i + 1}. [${q.header ?? ''}] ${q.question ?? ''}`, `   Opções: ${options}${q.multiple ? ' · várias permitidas (separadas por |)' : ''}${q.custom ? ' · texto livre permitido' : ''}`);
      });
      const placeholders = (req.questions ?? []).map((_, i) => `"<answer ${i + 1}>"`).join(' ');
      lines.push('', `- Responder: \`/opc:permissions answer ${req.id} ${placeholders}\``, `- Recusar: \`/opc:permissions reply ${req.id} reject\``, '');
      continue;
    }
    lines.push(`## Solicitação ${req.id}`, '');
    if (req.sessionID && req.sessionID !== job.sessionID) lines.push(`- Sessão: ${req.sessionID} (sessão filha)`);
    lines.push(`- Ferramenta: ${req.permission}`, '- Padrões:', ...codeBlock((req.patterns ?? []).join('\n') || '*'));
    if (req.requiresUser) lines.push(requiresUserLine());
    lines.push('- Responder:', `  - \`/opc:permissions reply ${req.id} once\``, `  - \`/opc:permissions reply ${req.id} reject "<reason>"\``, '');
  }
  lines.push(`Depois: \`/opc:status ${job.id} --wait\``);
  if (timeoutSec) lines.push(`Solicitações sem resposta serão recusadas automaticamente após ${timeoutSec} s.`);
  return lines;
}

function requiresUserLine() {
  return '- Exige o usuário: sim (comando destrutivo, diretório externo ou caminho sensível)';
}

export function renderPermissionRequest(job, { timeoutSec = null } = {}) {
  const lines = [
    '# opc: aguardando uma decisão',
    '',
    `Tarefa: ${job.id} (${job.kind}) · Sessão: ${job.sessionID ?? '-'}`,
    '',
    ...pendingLines(job, { timeoutSec }),
  ];
  return redactText(`${lines.join('\n').trimEnd()}\n`);
}

export function renderJobStatus(job, { progress = [], now = Date.now() } = {}) {
  const active = ACTIVE.has(job.status);
  const lines = [`# opc tarefa ${job.id}`, ''];
  lines.push(`- Estado: ${job.status}${job.phase ? ` (fase: ${job.phase})` : ''}`);
  lines.push(`- Tipo: ${job.kind} · Perfil: ${job.permissionProfile ?? '-'}`);
  lines.push(`- Modelo: ${job.model ?? '-'}${job.agent ? ` · Agente: ${job.agent}` : ''}${job.variant ? ` · Variante: ${job.variant}` : ''}`);
  if (job.sessionID) lines.push(`- Sessão: ${job.sessionID}${job.childSessionIDs?.length ? ` (filhas: ${job.childSessionIDs.join(', ')})` : ''}`);
  if (job.summary) lines.push(`- Resumo: ${job.summary}`);
  const time = active ? formatDuration(job.startedAt ?? job.createdAt, null, now) : formatDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt, now);
  if (time) lines.push(`- ${active ? 'Decorrido' : 'Duração'}: ${time}`);
  if (job.status === 'failed') lines.push(`- Erro: ${job.errorType ?? 'erro'} (${job.errorClass ?? 'fatal'}): ${job.errorMessage ?? ''}`);
  if (job.logFile) lines.push(`- Log: ${job.logFile}`);
  if (job.status === 'waiting_permission' && job.pendingRequest?.length) lines.push('', ...pendingLines(job));
  if (progress.length) lines.push('', 'Progresso:', ...progress.map((line) => `  ${line}`));
  const hint = resumeHint(job);
  lines.push('', 'Ações:', ...jobActions(job).map((a) => `- ${a}`), ...(hint ? [`- ${hint}`] : []));
  return redactText(`${lines.join('\n').trimEnd()}\n`);
}

export function renderStatusList(jobs, { maxJobs = 8, progressById = {}, now = Date.now() } = {}) {
  const active = jobs.filter((j) => ACTIVE.has(j.status));
  const recent = jobs.filter((j) => !ACTIVE.has(j.status)).slice(0, Math.max(0, maxJobs));
  const lines = ['# opc status', ''];
  if (active.length === 0 && recent.length === 0) return '# opc status\n\nNenhum job registrado ainda.\n';
  if (active.length) {
    lines.push('Jobs ativos:', '');
    lines.push(renderTable(
      ['Tarefa', 'Tipo', 'Estado', 'Fase', 'Decorrido', 'Sessão', 'Resumo', 'Ações'],
      active.map((j) => [j.id, j.kind, j.status, j.phase ?? '', formatDuration(j.startedAt ?? j.createdAt, null, now), j.sessionID ?? '', j.summary ?? '', jobActions(j).slice(1).map((a) => `\`${a}\``).join(' ')]),
    ));
    const withProgress = active.filter((j) => (progressById[j.id] ?? []).length);
    if (withProgress.length) {
      lines.push('', 'Detalhes recentes:');
      for (const j of withProgress) lines.push(`- ${j.id}`, ...(progressById[j.id] ?? []).slice(-4).map((l) => `    ${l}`));
    }
    lines.push('');
  }
  if (recent.length) {
    lines.push('Jobs recentes:', '');
    lines.push(renderTable(
      ['Tarefa', 'Tipo', 'Estado', 'Duração', 'Resumo', 'Ações'],
      recent.map((j) => [j.id, j.kind, j.status, formatDuration(j.startedAt ?? j.createdAt, j.completedAt ?? j.updatedAt, now), j.summary ?? '', `\`/opc:result ${j.id}\``]),
    ));
  }
  return redactText(`${lines.join('\n').trimEnd()}\n`);
}

export function renderTurnResult(job) {
  const r = redactTurnOutput(job.result ?? {});
  const lines = [];
  if (job.status === 'completed') {
    if (r.finalText) lines.push(r.finalText);
    if (r.structured !== null && r.structured !== undefined) {
      if (r.finalText) lines.push('', 'Saída estruturada:');
      lines.push(...codeBlock(JSON.stringify(redact(r.structured), null, 2), 'json'));
    }
    if (!r.finalText && (r.structured === null || r.structured === undefined)) lines.push('(o modelo não retornou texto final)');
  } else if (job.status === 'cancelled') {
    lines.push(`# opc tarefa ${job.id} cancelada`);
    if (r.finalText) lines.push('', 'Saída parcial:', '', r.finalText);
  } else {
    lines.push(`# opc tarefa ${job.id} falhou`, '', `- Erro: ${job.errorType ?? 'erro'} (${job.errorClass ?? 'fatal'}): ${job.errorMessage ?? ''}`);
    if (job.errorCode === 'server_lost' && job.sessionID) {
      lines.push(`- O servidor OpenCode foi perdido durante o turno; a sessão ${job.sessionID} foi preservada. Continue com: /opc:${RESUMABLE_KINDS.has(job.kind) ? job.kind : 'task'} --resume ${job.id}`);
    }
    if (r.finalText) {
      lines.push('', job.errorType === 'StructuredOutputError' ? 'Saída bruta (falha na saída estruturada):' : 'Saída parcial:', '', r.finalText);
    }
  }
  lines.push('', '---', `Tarefa: ${job.id} · Sessão: ${job.sessionID ?? '-'} · Modelo: ${job.model ?? '-'}`);
  if (r.touchedFiles?.length) lines.push(`Arquivos alterados: ${r.touchedFiles.join(', ')}`);
  const hint = resumeHint(job);
  if (hint) lines.push(`Continuar: ${hint}`);
  return redactText(`${lines.join('\n').trimEnd()}\n${renderAttempts(job.attempts)}`);
}

// ---- F4a: tentativas ---------------------------------------------------------------

export function renderAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length < 2) return '';
  const lines = attempts.map((a, i) => {
    const outcome = a.status === 'completed'
      ? 'concluída'
      : `${a.status}${a.errorClass ? ` (${a.errorClass}${a.errorType ? ` ${a.errorType}` : ''})` : ''}`;
    return `${i + 1}. \`${a.model}\` — ${outcome}${a.sessionID ? ` — sessão \`${a.sessionID}\`` : ''}`;
  });
  return redactText(`\n## Tentativas (${attempts.length})\n\n${lines.join('\n')}\n`);
}

export function renderCancel(job, report) {
  const sessionResult = report.aborted ? (report.idle ? 'cancelada; sessão ociosa' : 'cancelada; o estado ocioso não foi confirmado em 10 s') : 'não enviada (sem sessão ou servidor)';
  return redactText([
    '# opc cancelamento',
    '',
    `Cancelada ${job.id} (${job.kind}).`,
    `- Interrupção da sessão: ${sessionResult}`,
    `- Processo: ${report.worker}`,
    '- Consulte a lista atualizada em `/opc:status`.',
    '',
  ].join('\n'));
}

export function renderPermissionList(requests, jobs = []) {
  if (requests.length === 0) return '# opc permissions\n\nNenhuma solicitação pendente.\n';
  const jobFor = (sessionID) => jobs.find((j) => j.sessionID === sessionID || (j.childSessionIDs ?? []).includes(sessionID));
  const rows = requests.map((req) => {
    const job = jobFor(req.sessionID);
    const what = req.type === 'question'
      ? (req.questions ?? []).map((q) => q.header ?? q.question).join(' | ')
      : `${req.permission}: ${(req.patterns ?? []).join(' ')}`;
    return [req.id, req.type, what, req.sessionID, job?.id ?? '-'];
  });
  return redactText(`# opc permissions\n\n${renderTable(['Id', 'Tipo', 'Solicitação', 'Sessão', 'Tarefa'], rows)}\n`);
}
// ---- end F1 ----

// ---- F2b: review rendering. Adapted from openai/codex-plugin-cc (Apache-2.0); modified ----
const REVIEW_SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const REVIEW_LABELS = { review: 'Revisão', adversarial: 'Revisão Adversarial' };
const REVIEW_KEYS = ['verdict', 'summary', 'findings', 'next_steps'];
const REVIEW_FINDING_KEYS = ['severity', 'title', 'body', 'file', 'line_start', 'line_end', 'confidence', 'recommendation'];

function reviewSeverityRank(severity) {
  const index = REVIEW_SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? REVIEW_SEVERITY_ORDER.length : index;
}

function reviewCodeFence(text, lang = 'text') {
  const longestRun = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((run) => run.length));
  const marks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${marks}${lang}\n${text}\n${marks}`;
}

function reviewNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateReviewFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'deve ser um objeto.';
  if (!REVIEW_SEVERITY_ORDER.includes(finding.severity)) return '`severity` deve ser critical, high, medium ou low.';
  for (const key of ['title', 'body', 'file']) {
    if (!reviewNonEmpty(finding[key])) return `\`${key}\` deve ser uma string não vazia.`;
  }
  for (const key of ['line_start', 'line_end']) {
    if (!Number.isInteger(finding[key]) || finding[key] < 1) return `\`${key}\` deve ser um inteiro >= 1.`;
  }
  if (typeof finding.confidence !== 'number' || finding.confidence < 0 || finding.confidence > 1) {
    return '`confidence` deve ser um número entre 0 e 1.';
  }
  if (typeof finding.recommendation !== 'string') return '`recommendation` deve ser uma string.';
  const extra = Object.keys(finding).filter((key) => !REVIEW_FINDING_KEYS.includes(key));
  return extra.length ? `campo(s) inesperado(s): ${extra.join(', ')}.` : null;
}

export function validateReviewOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Esperado um objeto JSON no nível superior.';
  if (!['approve', 'needs-attention'].includes(data.verdict)) return 'O campo `verdict` deve ser "approve" ou "needs-attention".';
  if (!reviewNonEmpty(data.summary)) return 'Campo `summary` ausente ou inválido.';
  if (!Array.isArray(data.findings)) return 'Campo `findings` deve ser uma lista.';
  if (!Array.isArray(data.next_steps)) return 'Campo `next_steps` deve ser uma lista.';
  for (const [index, finding] of data.findings.entries()) {
    const error = validateReviewFinding(finding);
    if (error) return `findings[${index}]: ${error}`;
  }
  for (const [index, step] of data.next_steps.entries()) {
    if (!reviewNonEmpty(step)) return `next_steps[${index}] deve ser uma string não vazia.`;
  }
  const extra = Object.keys(data).filter((key) => !REVIEW_KEYS.includes(key));
  return extra.length ? `Campo(s) inesperado(s): ${extra.join(', ')}.` : null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === 'object' && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd = Number.isInteger(source.line_end) && source.line_end >= (lineStart ?? 1) ? source.line_end : lineStart;
  return {
    severity: reviewNonEmpty(source.severity) ? source.severity.trim() : 'low',
    title: reviewNonEmpty(source.title) ? source.title.trim() : `Achado ${index + 1}`,
    body: reviewNonEmpty(source.body) ? source.body.trim() : 'Nenhum detalhe informado.',
    file: reviewNonEmpty(source.file) ? source.file.trim() : 'desconhecido',
    lineStart,
    lineEnd,
    recommendation: typeof source.recommendation === 'string' ? source.recommendation.trim() : '',
  };
}

function reviewLineRange({ lineStart, lineEnd }) {
  if (!lineStart) return '';
  if (!lineEnd || lineEnd === lineStart) return `:${lineStart}`;
  return `:${lineStart}-${lineEnd}`;
}

function reviewIndent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function reviewFinish(lines) {
  return redactText(`${lines.join('\n').trimEnd()}\n`);
}

export function reviewMetaFromJob(job) {
  const review = job?.request?.review ?? {};
  return {
    variant: review.variant ?? 'review',
    targetLabel: review.targetLabel ?? null,
    model: job?.request?.modelFull ?? (typeof job?.model === 'string' ? job.model : null),
    jobId: job?.id ?? null,
  };
}

export function renderReview(result = {}, meta = {}) {
  result = redactTurnOutput(result);
  const label = REVIEW_LABELS[meta.variant] ?? REVIEW_LABELS.review;
  const lines = [`# OPC ${label}`, ''];
  if (meta.targetLabel) lines.push(`Alvo: ${meta.targetLabel}`);
  if (meta.model) lines.push(`Modelo: ${meta.model}`);
  if (meta.jobId) lines.push(`Job: ${meta.jobId}`);

  if (isFailedResult(result)) {
    if (result.status === 'cancelled') {
      if (result.errorCode || result.errorClass) {
        lines.push('', `Revisão cancelada: ${result.errorType ?? 'Cancelled'} (${result.errorCode ?? 'sem código'}; ${result.errorClass ?? 'sem classe'}): ${result.errorMessage ?? 'operação cancelada'}`);
      } else {
        lines.push('', 'Revisão cancelada.');
      }
    } else {
      lines.push('', `Falha na revisão: ${result.errorType ?? result.errorName ?? 'Erro'}${result.errorCode || result.errorClass ? ` (${result.errorCode ?? 'sem código'}; ${result.errorClass ?? 'sem classe'})` : ''}: ${result.errorMessage ?? result.error ?? 'erro desconhecido'}`);
    }
    const partialError = validateReviewOutput(result.structured);
    if (partialError === null) {
      lines.push('', 'Dados parciais:', '', ...renderReviewStructured(result.structured).split('\n').slice(2));
    } else if (result.structured != null) {
      lines.push('', ...renderInvalidReviewStructured(result.structured, partialError));
    } else if (result.errorType === 'StructuredOutputError' || result.errorName === 'StructuredOutputError') {
      lines.push('', 'O OpenCode não retornou uma saída estruturada válida.');
      if (result.errorMessage) lines.push('', `- Erro: ${result.errorMessage}`);
    }
    const raw = typeof result.finalText === 'string' ? result.finalText.trim() : '';
    if (raw) lines.push('', 'Mensagem final bruta:', '', reviewCodeFence(raw));
    return reviewFinish(lines);
  }

  const structured = result.structured;
  if (structured != null) {
    const shapeError = validateReviewOutput(structured);
    if (shapeError) {
      lines.push('', ...renderInvalidReviewStructured(structured, shapeError));
      return reviewFinish(lines);
    }
    lines.push('', ...renderReviewStructured(structured).split('\n'));
    return reviewFinish(lines);
  }

  const raw = typeof result.finalText === 'string' ? result.finalText.trim() : '';
  if (result.errorType === 'StructuredOutputError' || result.status === 'completed') {
    lines.push('', 'O OpenCode não retornou uma saída estruturada válida.');
    if (result.errorMessage) lines.push('', `- Erro: ${result.errorMessage}`);
    lines.push('', 'Mensagem final bruta:', '', raw ? reviewCodeFence(raw) : '(sem saída de texto)');
    return reviewFinish(lines);
  }

  lines.push('', `Falha na revisão: ${result.errorType ?? result.errorName ?? 'Erro'}: ${result.errorMessage ?? result.error ?? 'erro desconhecido'}`);
  if (raw) lines.push('', 'Mensagem final bruta:', '', reviewCodeFence(raw));
  return reviewFinish(lines);
}

function isFailedResult(result) {
  return result.status === 'failed' || result.status === 'cancelled'
    || result.errorCode != null || result.errorClass != null || result.errorName != null || result.error != null;
}

function renderInvalidReviewStructured(structured, validationError) {
  return [
    'O OpenCode não retornou uma saída estruturada válida.',
    '',
    `- Erro de validação: ${validationError}`,
    '',
    'Saída estruturada bruta:',
    '',
    reviewCodeFence(JSON.stringify(structured, null, 2), 'json'),
  ];
}

function renderReviewStructured(structured) {
  const lines = [`Veredito: ${structured.verdict.trim()}`, '', structured.summary.trim(), ''];
  const findings = structured.findings
    .map(normalizeReviewFinding)
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => reviewSeverityRank(a.finding.severity) - reviewSeverityRank(b.finding.severity) || a.index - b.index)
    .map(({ finding }) => finding);
  if (findings.length === 0) {
    lines.push('Nenhum achado relevante.');
  } else {
    lines.push('Achados:');
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${reviewLineRange(finding)})`);
      lines.push(reviewIndent(finding.body));
      if (finding.recommendation) lines.push(`  Recomendação: ${finding.recommendation}`);
    }
  }
  const steps = structured.next_steps.filter(reviewNonEmpty).map((step) => step.trim());
  if (steps.length) {
    lines.push('', 'Próximos passos:');
    for (const step of steps) lines.push(`- ${step}`);
  }
  return lines.join('\n');
}

function reviewResultFromJob(job) {
  const result = job?.result ?? {};
  return {
    ...result,
    status: ['cancelled', 'failed'].includes(job?.status) ? job.status : result.status ?? job?.status,
    errorType: result.errorType ?? job?.errorType ?? null,
    errorName: result.errorName ?? job?.errorName ?? null,
    errorCode: result.errorCode ?? job?.errorCode ?? null,
    errorClass: result.errorClass ?? job?.errorClass ?? null,
    errorMessage: result.errorMessage ?? job?.errorMessage ?? null,
    error: result.error ?? job?.error ?? null,
  };
}

export function renderReviewJob(job) {
  return renderReview(reviewResultFromJob(job), reviewMetaFromJob(job));
}

export function renderReviewEstimate(estimate) {
  return reviewFinish([
    '# Estimativa de revisão OPC',
    '',
    `Alvo: ${estimate.target.label}`,
    `Arquivos: ${estimate.files} (+${estimate.insertions} -${estimate.deletions})`,
    `Recomendação: ${estimate.recommendation}`,
  ]);
}

export function renderReviewGate({ enabled, changed }) {
  return redactText(`Gate de parada: ${enabled ? 'ativado' : 'desativado'}${changed ? ' (atualizado)' : ''}\n`);
}

// --- F3 renderers -----------------------------------------------------------------
const F3_ACTIVE = ['queued', 'running', 'waiting_permission'];
const F3_MAX_INLINE_DIFF = 400 * 1024;

function f3Finish(lines) {
  return redactText(`${lines.join('\n')}\n`);
}

function f3DerivedText(value) {
  return safeOutputText(value);
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function oneLine(text, max = 100) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fenceFor(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

const f3Table = (headers, rows) => renderTable(headers, rows).trimEnd();

function messageText(message) {
  return (message.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text ?? '').join(' ');
}

function modelLabel(model) {
  if (!model) return '-';
  if (typeof model === 'string') return model;
  const id = model.modelID ?? model.id;
  return model.providerID && id ? `${model.providerID}/${id}` : '-';
}

function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return { text: String(text), truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function diffBody(diffs, maxInlineBytes) {
  const lines = [f3Table(['Arquivo', 'Status', '+', '-'], diffs.map((d) => [d.file ?? '(desconhecido)', d.status ?? '-', String(d.additions ?? 0), String(d.deletions ?? 0)]))];
  const ordered = diffs.filter((d) => typeof d.patch === 'string' && d.patch.length > 0).sort((a, b) => a.patch.length - b.patch.length);
  let used = 0;
  let omitted = 0;
  const chunks = [];
  for (const d of ordered) {
    const size = Buffer.byteLength(d.patch, 'utf8');
    if (used + size > maxInlineBytes) {
      omitted += 1;
      continue;
    }
    used += size;
    const patch = f3DerivedText(d.patch);
    chunks.push(patch.endsWith('\n') ? patch : `${patch}\n`);
  }
  if (chunks.length) {
    const body = chunks.join('').trimEnd();
    const fence = fenceFor(body);
    lines.push('', `${fence}diff`, body, fence);
  }
  if (omitted) lines.push('', `(${omitted} arquivo(s) fora do diff inline: limite de ${Math.round(maxInlineBytes / 1024)} KB)`);
  return lines;
}

export function renderSessions(sessions, { statusMap = {}, title = 'Sessões OPC', hiddenCount = 0 } = {}) {
  sessions = maskDeep(sessions);
  statusMap = maskDeep(statusMap);
  title = safeOutputText(title);
  if (!sessions.length) return f3Finish([`# ${title}`, '', 'Nenhuma sessão encontrada.']);
  const rows = sessions.map((s) => [s.id, s.title ?? '', statusMap[s.id]?.type ?? 'idle', fmtTime(s.time?.updated), s.parentID ?? '-']);
  const lines = [`# ${title}`, '', f3Table(['ID', 'Título', 'Status', 'Atualizada (UTC)', 'Pai'], rows)];
  if (hiddenCount > 0) lines.push('', `(${hiddenCount} sessão(ões) omitida(s); use --limit para ver mais)`);
  return f3Finish(lines);
}

export function renderSession(session, { status = null, messages = [], note = null } = {}) {
  session = maskDeep(session);
  messages = maskDeep(messages);
  status = status === null ? null : safeOutputText(status);
  note = note === null ? null : safeOutputText(note);
  const lines = [`# Sessão ${session.id}`, ''];
  lines.push(`- Título: ${session.title ?? '-'}`);
  lines.push(`- Status: ${status ?? '-'}`);
  lines.push(`- Diretório: ${session.directory ?? '-'}`);
  lines.push(`- Agente: ${session.agent ?? '-'} · Modelo: ${modelLabel(session.model)}`);
  if (session.parentID) lines.push(`- Pai: ${session.parentID}`);
  lines.push(`- Criada: ${fmtTime(session.time?.created)} · Atualizada: ${fmtTime(session.time?.updated)} (UTC)`);
  if (session.summary) lines.push(`- Alterações: +${session.summary.additions} -${session.summary.deletions} em ${session.summary.files} arquivo(s)`);
  if (session.revert?.messageID) {
    lines.push(`- Revert ativo: a partir de ${session.revert.messageID} (desfazer: opc session unrevert ${session.id} --confirmed-by-user)`);
  }
  if (note) lines.push('', note);
  if (messages.length) {
    lines.push('', `## Mensagens (${messages.length})`, '');
    lines.push(f3Table(['#', 'ID', 'Papel', 'Agente/Modelo', 'Texto'], messages.map((m, i) => [
      String(i + 1),
      m.info?.id ?? '-',
      m.info?.role ?? '-',
      m.info?.role === 'assistant' ? `${m.info.agent ?? '-'} · ${m.info.providerID ?? '-'}/${m.info.modelID ?? '-'}${m.info.summary ? ' (resumo)' : ''}` : (m.info?.agent ?? '-'),
      oneLine(messageText(m), 100),
    ])));
  }
  return f3Finish(lines);
}

export function renderSessionDiff(diffs, { maxInlineBytes = F3_MAX_INLINE_DIFF, title = 'Diff da sessão' } = {}) {
  diffs = maskDeep(diffs);
  title = safeOutputText(title);
  if (!diffs.length) return f3Finish([`# ${title}`, '', 'Nenhuma alteração registrada.']);
  return f3Finish([`# ${title}`, '', ...diffBody(diffs, maxInlineBytes)]);
}

export function renderTodos(todos, { sessionID = null } = {}) {
  todos = maskDeep(todos);
  const heading = `# Tarefas${sessionID ? ` da sessão ${safeOutputText(sessionID)}` : ''}`;
  if (!todos.length) return f3Finish([heading, '', 'Nenhum todo.']);
  return f3Finish([heading, '', f3Table(['Status', 'Prioridade', 'Tarefa'], todos.map((t) => [t.status ?? '-', t.priority ?? '-', oneLine(t.content, 160)]))]);
}

export function renderRevertPreview({ action, sessionID, messageID = null, affected = [], rawDiff = null, command }) {
  affected = maskDeep(affected);
  sessionID = safeOutputText(sessionID);
  messageID = messageID === null ? null : safeOutputText(messageID);
  command = safeOutputText(command);
  const lines = [`# opc: confirmação necessária (${action})`, ''];
  if (action === 'revert') {
    lines.push(`Sessão ${sessionID} · a partir da mensagem ${messageID}.`);
    lines.push('O revert remove do histórico as mensagens a partir dessa e restaura os arquivos abaixo ao estado anterior:', '');
    if (affected.length) lines.push(...diffBody(affected, F3_MAX_INLINE_DIFF));
    else lines.push('(nenhuma alteração de arquivo registrada para essas mensagens; só o histórico muda)');
  } else {
    lines.push(`Sessão ${sessionID} · revert ativo a partir de ${messageID ?? '-'}.`);
    lines.push('O unrevert devolve as mensagens e reaplica nos arquivos o diff abaixo:', '');
    if (rawDiff) {
      const { text, truncated } = truncateBytes(f3DerivedText(rawDiff), F3_MAX_INLINE_DIFF);
      const fence = fenceFor(text);
      lines.push(`${fence}diff`, text.trimEnd(), fence);
      if (truncated) lines.push('(diff truncado em 400 KB)');
    } else {
      lines.push('(o OpenCode não informou o diff do revert)');
    }
  }
  lines.push('', 'Nada foi alterado. Confirme com o usuário e só então rode:', '', `    ${command}`);
  return f3Finish(lines);
}

// job.pendingRequest is a list (F2a); in a group each item carries memberId.
export function renderPendingLines(job) {
  return (job?.pendingRequest ?? []).flatMap((req) => {
    const owner = req.memberId ?? job.id;
    if (req.type === 'question') {
      const questions = (req.questions ?? []).map((q) => oneLine(q.question ?? q.header ?? '', 80)).join(' | ');
      return [`- ${owner}: pergunta ${req.id} (${questions || 'sem texto'})`, `  /opc:permissions answer ${req.id} <resposta...>`];
    }
    const patterns = (req.patterns ?? []).join(', ');
    return [
      `- ${owner}: permissão ${req.permission ?? '?'} [${patterns}] (pedido ${req.id}, sessão ${req.sessionID ?? '-'})`,
      ...(req.requiresUser ? [requiresUserLine()] : []),
      `  /opc:permissions reply ${req.id} once`,
      `  /opc:permissions reply ${req.id} reject`,
    ];
  }).map((line) => redactText(line));
}

export function renderGroupStatus(group, members) {
  const lines = [`# Grupo ${group.id} (${group.kind})`, '', `Status: ${group.status} · ${group.phase ?? '-'} · sessão pai ${group.sessionID ?? '-'}`, ''];
  lines.push(f3Table(['#', 'Job', 'Agente', 'Modelo', 'Status', 'Fase', 'Sessão'], members.map((m, i) => [
    String(i + 1), m.id, m.agent ?? '-', modelLabel(m.model), m.status, m.phase ?? '-', m.sessionID ?? '-',
  ])));
  const pending = members.flatMap((m) => renderPendingLines(m));
  if (pending.length) lines.push('', 'Pedidos pendentes:', ...pending);
  const warnings = group.result?.warnings ?? [];
  if (warnings.length) lines.push('', `Avisos: ${warnings.join('; ')}`);
  lines.push('', `Cancelar um membro: /opc:cancel <job> · o grupo inteiro: /opc:cancel ${group.id}`);
  if (F3_ACTIVE.includes(group.status)) lines.push(`Acompanhar: /opc:status ${group.id} --wait`);
  return f3Finish(lines);
}

export function renderGroupResult(group, members) {
  const counts = group.result?.counts ?? {};
  const countText = ['completed', 'failed', 'cancelled'].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ') || '-';
  const lines = [`# Resultado do grupo ${group.id}`, '', `Status: ${group.status} · ${members.length} membro(s): ${countText}`];
  const warnings = group.result?.warnings ?? [];
  if (warnings.length) lines.push(`Avisos: ${warnings.join('; ')}`);
  members.forEach((m, i) => {
    const r = m.result ?? {};
    lines.push('', `## #${i + 1} ${m.agent ?? '-'} · ${modelLabel(m.model)} — ${m.status}`);
    lines.push(`Sessão: ${r.sessionID ?? m.sessionID ?? '-'} (mecanismo ${r.mechanism ?? '-'}${r.fellBack ? ', fallback de child-session' : ''})`);
    if (m.status === 'completed') lines.push('', f3DerivedText(r.finalText).trim() || '(sem texto final)');
    else if (m.status === 'cancelled') lines.push('', 'Cancelado.');
    else lines.push('', `Erro: ${m.errorType ?? r.errorType ?? m.errorCode ?? 'erro'}: ${f3DerivedText(m.errorMessage ?? r.errorMessage ?? '(sem mensagem)')}`);
  });
  return f3Finish(lines);
}

export function renderCommandResult(result) {
  const lines = [`# opc command /${result.command}`, ''];
  if (result.status) lines.push(`Status: ${result.status}`);
  const safeArgs = safeOutputText(result.argumentsPreview ?? result.arguments ?? '');
  const args = safeArgs.length > 200 ? `${safeArgs.slice(0, 199)}…` : safeArgs;
  lines.push(`Argumentos: ${args ? `\`${f3DerivedText(args)}\`` : '(nenhum)'}`);
  lines.push(`Sessão: ${result.sessionID ?? '-'} · modelo ${result.model ?? '-'} · agente ${result.agent ?? '(padrão)'}`, '');
  if (result.error) lines.push(`Erro: ${result.error.name ?? 'Error'}: ${f3DerivedText(result.error.data?.message ?? result.error.message ?? '')}`);
  else lines.push(f3DerivedText(result.finalText).trim() || '(sem texto final)');
  return f3Finish(lines);
}

export function renderAttach(info) {
  const args = info.argv.map(shellQuote).join(' ');
  const secret = info.authSource?.type === 'file'
    ? `OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(info.authSource.path)})"`
    : `OPENCODE_SERVER_PASSWORD="$${info.authSource?.name ?? 'OPC_SERVER_PASSWORD'}"`;
  const lines = ['# opc attach', ''];
  lines.push(`Servidor: ${info.url} (${info.attached ? 'externo, via OPC_SERVER_URL' : 'gerenciado pelo opc'})`);
  lines.push(`Sessão: ${info.sessionID ?? '(nenhuma: a TUI abre o seletor)'}`);
  lines.push(`Diretório: ${info.directory}`, '');
  if (info.pane) {
    lines.push(`Pane aberto: ${info.pane.id}. A senha foi lida do arquivo 0600 dentro do pane (não passa por argv).`);
    return f3Finish(lines);
  }
  lines.push('Rode no seu terminal (a senha não aparece na linha de comando; vem', info.authSource?.type === 'file' ? 'do arquivo de modo 600 para a variável de ambiente):' : 'da variável OPC_SERVER_PASSWORD que você já usa:', '');
  lines.push(`    ${secret} ${args}`, '');
  if (!info.attached) lines.push(`Dentro do tmux: /opc:attach --pane${info.sessionID ? ` ${info.sessionID}` : ''}`);
  return f3Finish(lines);
}

// ---- F4a: monitor ----------------------------------------------------------

const ANSI = Object.freeze({ reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m' });

const STATUS_STYLE = Object.freeze({
  queued: { icon: '○', color: 'gray' },
  running: { icon: '●', color: 'cyan' },
  waiting_permission: { icon: '⏸', color: 'yellow' },
  completed: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  cancelled: { icon: '⊘', color: 'gray' },
});

// The monitor uses the canonical active-job list from state.mjs (F0).
export const MONITOR_ACTIVE = ACTIVE_JOB_STATUSES;

function paint(text, color, enabled) {
  return enabled && ANSI[color] ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

// Snapshot data is untrusted display text. Strip terminal controls before it can
// be wrapped in renderer-owned ANSI styling, then apply both redaction layers.
function monitorText(value) {
  const text = String(value ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // every monitor field renders on a single line
    .replace(/\r\n|[\t\n\r]/g, ' ');
  return safeOutputText(text);
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function elapsedOf(job, now) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? '');
  if (!Number.isFinite(start)) return '--:--';
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  return formatElapsed((Number.isFinite(end) ? end : now) - start);
}

function monitorClock(now) {
  return new Date(now).toISOString().replace('T', ' ').slice(0, 19);
}

function pendingMonitorLines(job, color) {
  if (!Array.isArray(job.pending) || job.pending.length === 0) return [];
  return job.pending.map((pending) => {
    if (pending.kind === 'question') {
      return paint(`    ⏸ pergunta ${monitorText(pending.id)}: ${monitorText(pending.what)} → /opc:permissions answer ${monitorText(pending.id)} <resposta>`, 'yellow', color);
    }
    const patterns = pending.patterns?.length ? ` [${pending.patterns.map(monitorText).join(', ')}]` : '';
    return paint(`    ⏸ permissão ${monitorText(pending.id)}: ${monitorText(pending.what)}${patterns} → /opc:permissions reply ${monitorText(pending.id)} once|reject`, 'yellow', color);
  });
}

function monitorJobLine(job, now, color, indent) {
  const style = STATUS_STYLE[job.status] ?? { icon: '?', color: 'reset' };
  const attempt = `tentativa ${monitorText(job.attempt.current)}/${monitorText(job.attempt.limit)}`;
  return [
    `${indent}${paint(monitorText(style.icon), style.color, color)} ${paint(monitorText(job.id), 'bold', color)}`,
    monitorText(job.status),
    monitorText(job.phase ?? '—'),
    monitorText(job.model ?? '—'),
    attempt,
    elapsedOf(job, now),
  ].join('  ');
}

export function renderMonitor(snapshot, { color = false } = {}) {
  const { now, jobs, focus } = snapshot;
  const active = jobs.filter((job) => MONITOR_ACTIVE.includes(job.status)).length;
  const header = `${paint('opc monitor', 'bold', color)} — ${monitorClock(now)} — ${active} ativo(s), ${jobs.length - active} recente(s) — Ctrl+C para sair`;
  if (jobs.length === 0) return redactText(`${header}\n\nNenhum job neste workspace.\n${(snapshot.warnings ?? []).map((warning) => `${warning}\n`).join('')}`);
  const out = [header, ''];
  for (const job of jobs) {
    const indent = job.groupId && jobs.some((item) => item.id === job.groupId) ? '  ' : '';
    out.push(monitorJobLine(job, now, color, indent));
    if (job.title) out.push(paint(`${indent}    ${monitorText(job.title)}`, 'dim', color));
    out.push(...pendingMonitorLines(job, color));
    if (job.status === 'failed' && job.errorMessage) {
      out.push(paint(`${indent}    erro: ${job.errorType ? `${monitorText(job.errorType)}: ` : ''}${monitorText(job.errorMessage)}`, 'red', color));
    }
    if (focus === job.id && Array.isArray(job.attempts) && job.attempts.length > 0) {
      out.push(`${indent}    tentativas:`);
      job.attempts.forEach((attempt, index) => {
        const cls = attempt.errorClass ? ` (${monitorText(attempt.errorClass)}${attempt.errorType ? ` ${monitorText(attempt.errorType)}` : ''})` : '';
        out.push(`${indent}      ${index + 1}. ${monitorText(attempt.model)} — ${monitorText(attempt.status)}${cls}`);
      });
    }
    for (const line of job.log ?? []) out.push(paint(`${indent}    │ ${monitorText(line)}`, 'gray', color));
  }
  for (const warning of snapshot.warnings ?? []) out.push(warning);
  return redactText(`${out.join('\n')}\n`);
}
