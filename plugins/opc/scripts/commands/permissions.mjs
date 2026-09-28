// /opc:permissions: lista e responde solicitações pendentes (spec §8.2, §8.3).
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, ExitCode, NotFoundError, PolicyError, UsageError } from '../lib/opc-error.mjs';
import { checkReply } from '../lib/policy.mjs';
import { redact } from '../lib/redact.mjs';
import { existingServerApi, listJobs, updateJob } from '../lib/jobs.mjs';
import { renderPermissionList } from '../lib/render.mjs';

const FLAGS = { json: { type: 'boolean' }, cwd: { type: 'string' }, 'confirmed-by-user': { type: 'boolean' } };
const USAGE = 'uso: permissions list | reply <id> once|reject [mensagem] [--confirmed-by-user] | answer <question-id> <resposta...>';
const short = (value) => String(value ?? '').slice(0, 12) + (String(value ?? '').length > 12 ? '…' : '');

export function parseAnswers(questions, values) {
  const describe = () => questions.map((q, i) => `${i + 1}. [${q.header ?? ''}] ${q.question ?? ''} — opções: ${(q.options ?? []).map((o) => o.label).join(' | ') || '(texto livre)'}`).join('\n');
  if (values.length !== questions.length) {
    throw new UsageError('ANSWER_COUNT', `eram esperadas ${questions.length} resposta(s), uma por pergunta, na ordem (use | entre opções de múltipla escolha):\n${describe()}`);
  }
  return questions.map((q, i) => {
    const raw = String(values[i]);
    const parts = q.multiple ? raw.split('|').map((s) => s.trim()) : [raw.trim()];
    if (parts.length === 0 || parts.some((p) => !p)) throw new UsageError('ANSWER_EMPTY', `a resposta ${i + 1} está vazia`);
    return parts.map((part) => {
      const option = (q.options ?? []).find((o) => String(o.label).toLowerCase() === part.toLowerCase());
      if (option) return option.label;
      if (q.custom !== false) return part;
      throw new UsageError('ANSWER_INVALID', `a resposta ${i + 1} não corresponde a uma opção de [${q.header ?? ''}]:\n${describe()}`);
    });
  });
}

function requireServerApi(ctx) {
  const api = existingServerApi(ctx);
  if (!api) throw new NotFoundError('NO_SERVER', 'não há servidor opc em execução para este workspace; não há solicitações pendentes');
  return api;
}

async function clearPending(ctx, ids) {
  const job = listJobs(ctx.stateDir, { all: true }).find((j) => (j.pendingRequest ?? []).some((r) => ids.includes(r.id)));
  if (!job) return null;
  return updateJob(ctx.stateDir, job.id, (current) => {
    const remaining = (current.pendingRequest ?? []).filter((r) => !ids.includes(r.id));
    if (current.status !== 'waiting_permission') return { pendingRequest: remaining.length ? remaining : null };
    return remaining.length ? { pendingRequest: remaining } : { pendingRequest: null, status: 'running', phase: 'running' };
  });
}

async function list(ctx, flags) {
  const api = existingServerApi(ctx);
  let requests = [];
  if (api) {
    try {
      const [permissions, questions] = await Promise.all([api.listPermissions(), api.listQuestions()]);
      requests = [...(permissions ?? []).map((p) => ({ type: 'permission', ...p })), ...(questions ?? []).map((q) => ({ type: 'question', ...q }))];
    } catch (err) {
      if (!(err instanceof ConnectionError)) throw err;
    }
  }
  const jobs = listJobs(ctx.stateDir, { all: true });
  if (flags.json) ctx.json({ requests: redact(requests) });
  else ctx.out(renderPermissionList(requests, jobs));
  return ExitCode.OK;
}

async function reply(ctx, flags, id, rest) {
  const [decision, ...messageParts] = rest;
  if (!id || !decision) throw new UsageError('USAGE', USAGE);
  const policy = ctx.config?.policy ?? {};
  const approver = policy.approver ?? 'user';
  const syntax = checkReply({ approver, request: null, reply: decision, confirmedByUser: true, policy });
  if (!syntax.ok) throw new UsageError(syntax.code, syntax.reason);
  const message = messageParts.join(' ').trim();
  if (id.startsWith('que')) {
    if (decision !== 'reject') throw new UsageError('INVALID_REPLY', 'perguntas só podem ser recusadas aqui; responda com: permissions answer <id> <resposta...>');
    const api = requireServerApi(ctx);
    const pending = (await api.listQuestions() ?? []).find((q) => q.id === id);
    if (!pending) throw new NotFoundError('NOT_FOUND', `a pergunta ${short(id)} não está pendente`);
    await api.rejectQuestion(id);
    const job = await clearPending(ctx, [id]);
    ctx.out(`Pergunta ${short(id)} recusada.${job ? `\nAcompanhe a tarefa: /opc:status ${job.id} --wait` : ''}\n`);
    return ExitCode.OK;
  }
  const api = requireServerApi(ctx);
  const pending = (await api.listPermissions()) ?? [];
  const request = pending.find((p) => p.id === id);
  if (!request) throw new NotFoundError('NOT_FOUND', `a solicitação de permissão ${short(id)} não está pendente`);
  const verdict = checkReply({ approver, request, reply: decision, confirmedByUser: Boolean(flags['confirmed-by-user']), policy });
  if (!verdict.ok) throw verdict.code === 'INVALID_REPLY' ? new UsageError(verdict.code, verdict.reason) : new PolicyError(verdict.code, verdict.reason);
  await api.replyPermission(id, decision === 'reject' ? { reply: 'reject', ...(message ? { message } : {}) } : { reply: 'once' });
  const siblings = decision === 'reject' ? pending.filter((p) => p.sessionID === request.sessionID && p.id !== id).map((p) => p.id) : [];
  const job = await clearPending(ctx, [id, ...siblings]);
  const lines = [`Resposta ${decision} enviada para ${short(id)} (${request.permission}).`];
  if (siblings.length) lines.push(`O OpenCode também recusou as outras solicitações pendentes desta sessão: ${siblings.map(short).join(', ')}.`);
  if (job) lines.push(`Acompanhe a tarefa: /opc:status ${job.id} --wait`);
  ctx.out(`${lines.join('\n')}\n`);
  return ExitCode.OK;
}

async function answer(ctx, id, values) {
  if (!id || !id.startsWith('que') || values.length === 0) throw new UsageError('USAGE', USAGE);
  const api = requireServerApi(ctx);
  const request = ((await api.listQuestions()) ?? []).find((q) => q.id === id);
  if (!request) throw new NotFoundError('NOT_FOUND', `a pergunta ${short(id)} não está pendente`);
  const answers = parseAnswers(request.questions ?? [], values);
  await api.replyQuestion(id, answers);
  const job = await clearPending(ctx, [id]);
  ctx.out(`Resposta enviada para ${short(id)}.${job ? `\nAcompanhe a tarefa: /opc:status ${job.id} --wait` : ''}\n`);
  return ExitCode.OK;
}

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: FLAGS, allowPositionals: true });
  const [action = 'list', id, ...rest] = positionals;
  switch (action) {
    case 'list': return list(ctx, flags);
    case 'reply': return reply(ctx, flags, id, rest);
    case 'answer': return answer(ctx, id, rest);
    default: throw new UsageError('USAGE', USAGE);
  }
}
