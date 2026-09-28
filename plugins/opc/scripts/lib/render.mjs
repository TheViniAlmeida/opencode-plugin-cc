// Markdown rendering (no network I/O). Every output passes through redaction.
import { OpcError } from './opc-error.mjs';
import { redact, redactText } from './redact.mjs';
import { isSecretLikeSetting } from './config.mjs';

function cell(value) {
  return redactText(String(value ?? '')).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function renderTable(headers, rows) {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
  return redactText(`${[head, sep, ...body].join('\n')}\n`);
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
  for (const req of job.pendingRequest ?? []) {
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
    if (req.requiresUser) lines.push('- Exige o usuário: sim (comando destrutivo, diretório externo ou caminho sensível)');
    lines.push('- Responder:', `  - \`/opc:permissions reply ${req.id} once\``, `  - \`/opc:permissions reply ${req.id} reject "<reason>"\``, '');
  }
  lines.push(`Depois: \`/opc:status ${job.id} --wait\``);
  if (timeoutSec) lines.push(`Solicitações sem resposta serão recusadas automaticamente após ${timeoutSec} s.`);
  return lines;
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
  const r = job.result ?? {};
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
  return redactText(`${lines.join('\n').trimEnd()}\n`);
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
