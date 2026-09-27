// Markdown rendering (no network I/O). Every output passes through redaction.
import { OpcError } from './opc-error.mjs';
import { redactText } from './redact.mjs';

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
