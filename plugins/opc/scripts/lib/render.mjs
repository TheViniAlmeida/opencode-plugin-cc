// Markdown rendering (no network I/O). Every output passes through redaction.
import { OpcError } from './opc-error.mjs';
import { redact, redactText } from './redact.mjs';

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
  policy: (item) => (item.allowed === false ? `negado (${item.rule})` : 'permitido'),
  yesNo: (v) => (v ? 'sim' : 'não'),
  dash: (v) => (v === null || v === undefined || v === '' ? '—' : String(v)),
  json: (value) => `\`\`\`json\n${JSON.stringify(redact(value), null, 2)}\n\`\`\`\n`,
  warnings: (warnings = []) => (warnings.length
    ? `\n**Avisos**\n${warnings.map((w) => `- ${typeof w === 'string' ? w : `\`${w.path}\`: ${w.message}`}`).join('\n')}\n`
    : ''),
});

export function renderProviders(view) {
  const rows = view.providers.map((p) => [p.id, p.name, RenderF1.yesNo(p.connected), p.modelCount, RenderF1.dash(p.defaultModel), RenderF1.policy(p)]);
  const title = view.all ? '# Providers do OpenCode (catálogo completo)' : '# Providers conectados';
  const body = rows.length ? renderTable(['Provider', 'Nome', 'Conectado', 'Modelos', 'Modelo padrão', 'Política'], rows) : 'Nenhum provider conectado. Rode `opencode auth login` no terminal.\n';
  return `${title}\n\n${body}${RenderF1.warnings(view.warnings)}`;
}

export function renderModels(view) {
  const scope = view.provider ? ` de \`${view.provider}\`` : '';
  const flags = [view.all ? 'inclui não conectados' : null, view.allowedOnly ? 'só permitidos' : null].filter(Boolean);
  const title = `# Modelos${scope}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  if (!view.models.length) return `${title}\n\nNenhum modelo encontrado.\n${RenderF1.warnings(view.warnings)}`;
  const headers = view.verbose
    ? ['Modelo', 'Nome', 'Variants', 'Contexto', 'Saída', 'Custo in/out (US$/M)', 'Status', 'Política']
    : ['Modelo', 'Nome', 'Variants', 'Política'];
  const rows = view.models.map((m) => (view.verbose
    ? [m.full, m.name, m.variants.join(', ') || '—', RenderF1.dash(m.limit.context), RenderF1.dash(m.limit.output), `${RenderF1.dash(m.cost.input)} / ${RenderF1.dash(m.cost.output)}`, RenderF1.dash(m.status), RenderF1.policy(m)]
    : [m.full, m.name, m.variants.join(', ') || '—', RenderF1.policy(m)]));
  return `${title}\n\n${renderTable(headers, rows)}\n${view.models.length} modelo(s).\n${RenderF1.warnings(view.warnings)}`;
}

export function renderAgents(view) {
  const title = `# Agentes do OpenCode${view.mode && view.mode !== 'all' ? ` (modo ${view.mode})` : ''}`;
  if (!view.agents.length) return `${title}\n\nNenhum agente encontrado.\n`;
  const headers = view.verbose
    ? ['Agente', 'Modo', 'Descrição', 'Nativo', 'Oculto', 'Modelo fixado', 'Variant', 'Política']
    : ['Agente', 'Modo', 'Descrição', 'Política'];
  const rows = view.agents.map((a) => (view.verbose
    ? [a.name, a.mode, RenderF1.dash(a.description), RenderF1.yesNo(a.native), RenderF1.yesNo(a.hidden), RenderF1.dash(a.pinnedModel), RenderF1.dash(a.variant), RenderF1.policy(a)]
    : [a.name, a.mode, RenderF1.dash(a.description), RenderF1.policy(a)]));
  return `${title}\n\n${renderTable(headers, rows)}${RenderF1.warnings(view.warnings)}`;
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
      return `# opc config path\n\n- Dados: \`${view.dataDir}\`\n- Global: \`${view.global}\`\n- Workspace: \`${view.workspace}\`\n- Rascunho do onboarding: \`${view.draft}\`\n`;
    case 'get':
      return `${view.setting} = ${JSON.stringify(redact(view.value))}\n`;
    case 'edit':
      return `# opc config ${view.op}\n\n\`${view.setting}\` (${view.scope}) → \`${view.path}\`\n\nValor: \`${JSON.stringify(redact(view.value ?? null))}\`\n${RenderF1.warnings(view.warnings)}`;
    case 'show':
      return `# opc config\n\n## Global (\`${view.paths.global}\`)\n\n${view.global ? RenderF1.json(view.global) : '_sem config global (rode /opc:setup)_\n'}\n## Workspace (\`${view.paths.workspace}\`)\n\n${view.workspace ? RenderF1.json(view.workspace) : '_sem .opc.json_\n'}${RenderF1.warnings(view.warnings)}`;
    case 'effective':
      return `# opc config efetiva\n\n${RenderF1.json(view.config)}${RenderF1.warnings(view.warnings)}`;
    case 'validate': {
      const status = view.errors.length ? '**Config inválida.**' : '**Config válida.**';
      const server = view.serverChecked ? '' : `\n_Checagem contra o servidor não executada: ${view.serverError}_\n`;
      const errors = view.errors.length ? `\n## Erros\n\n${renderTable(['Origem', 'Chave', 'Código', 'Mensagem'], view.errors.map((e) => [e.source, e.path, e.code, e.message]))}` : '';
      const warns = view.warnings.length ? `\n## Avisos\n\n${renderTable(['Origem', 'Chave', 'Código', 'Mensagem'], view.warnings.map((w) => [w.source, w.path, RenderF1.dash(w.code), w.message]))}` : '';
      return `# opc config validate\n\n${status}\n${server}${errors}${warns}`;
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
        `- Providers conectados: ${s.connectedProviders.length ? s.connectedProviders.map((p) => `${p.id} (${p.modelCount})`).join(', ') : 'nenhum'}`,
        `- Rascunho: ${s.draft.exists ? `sim, próxima etapa: ${s.nextStep ?? 'commit'}` : 'não'}`,
        `- Chaves travadas editáveis aqui: ${RenderF1.yesNo(s.lockedKeysEditable)}`,
      ];
      if (s.serverError) lines.push(`- Servidor: ${s.serverError}`);
      return `\n${lines.join('\n')}\n`;
    }
    case 'models': {
      const rows = view.suggestions.map((m) => [m.full, m.name, m.variants.join(', ') || '—', RenderF1.dash(m.limit.context)]);
      const matches = view.matches ? `\n## Resultado da busca \`${view.query}\`\n\n${view.matches.length ? renderTable(['Modelo', 'Nome'], view.matches.map((m) => [m.full, m.name])) : 'Nada encontrado.\n'}` : '';
      return `# Sugestões de modelo para \`${view.provider}\`\n\n${rows.length ? renderTable(['Modelo', 'Nome', 'Variants', 'Contexto'], rows) : 'Nenhum modelo permitido.\n'}${matches}`;
    }
    case 'apply':
      return `# Rascunho atualizado\n\nAplicado: ${view.applied.map((k) => `\`${k}\``).join(', ')}\nPróxima etapa: ${view.nextStep ?? 'commit'}\n${RenderF1.warnings(view.warnings)}`;
    case 'commit':
      return `# Config gravada\n\nEscopo: ${view.scope} → \`${view.path}\`\n${RenderF1.warnings(view.warnings)}`;
    case 'discard':
      return view.discarded ? '# Rascunho descartado\n' : '# Nenhum rascunho para descartar\n';
    default:
      throw new TypeError(`renderOnboarding: unknown view kind ${view.kind}`);
  }
}
// ---- end F1 ----
