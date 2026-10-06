// /opc:permissions: lista e responde solicitações pendentes (spec §8.2, §8.3).
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, ExitCode, NotFoundError, PolicyError, UsageError } from '../lib/opc-error.mjs';
import { checkReply } from '../lib/policy.mjs';
import { redact } from '../lib/redact.mjs';
import { clearJobRequests, existingServerApi, listJobs } from '../lib/jobs.mjs';
import { renderPermissionList } from '../lib/render.mjs';

const FLAGS = { json: { type: 'boolean' }, cwd: { type: 'string' }, 'confirmed-by-user': { type: 'boolean' } };
const USAGE = 'uso: permissions list | reply <id> once|reject [mensagem] [--confirmed-by-user] | answer <question-id> <resposta...>';

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

function requireServerApi(ctx, getApi = existingServerApi) {
  const api = getApi(ctx);
  if (!api) throw new NotFoundError('NO_SERVER', 'não há servidor opc em execução para este workspace; não há solicitações pendentes');
  return api;
}

const jobForRequest = (ctx, id) => listJobs(ctx.stateDir, { all: true }).find((job) => (job.pendingRequest ?? []).some((request) => request.id === id)) ?? null;
const sessionForRequest = (job, id) => job?.pendingRequest?.find((request) => request.id === id)?.sessionID;
const trackedSessions = (jobs) => [...new Set(jobs.flatMap((job) => [job.sessionID, ...(job.childSessionIDs ?? []), ...(job.pendingRequest ?? []).map((request) => request.sessionID)]).filter(Boolean))];

export async function list(ctx, flags, getApi = existingServerApi) {
  const api = getApi(ctx);
  let requests = [];
  let serverDown = !api;
  const jobs = listJobs(ctx.stateDir, { all: true });
  if (api) {
    try {
      for (const sessionID of trackedSessions(jobs)) {
        const [permissions, questions] = await Promise.all([api.listPermissions(sessionID), api.listQuestions(sessionID)]);
        requests.push(...(permissions ?? []).map((p) => ({ type: 'permission', ...p })), ...(questions ?? []).map((q) => ({ type: 'question', ...q })));
      }
    } catch (err) {
      if (!(err instanceof ConnectionError) || err.code !== 'SERVER_DOWN') throw err;
      serverDown = true;
    }
  }
  if (serverDown) requests = jobs.flatMap((job) => (job.pendingRequest ?? []).map((request) => ({ type: request.type === 'question' || request.questions ? 'question' : 'permission', ...request })));
  if (flags.json) ctx.json({ requests: redact(requests) });
  else ctx.out(`${renderPermissionList(requests, jobs)}${serverDown ? '\nAviso: o servidor não está em execução; exibindo solicitações pendentes registradas nos arquivos das tarefas.\n' : ''}`);
  return ExitCode.OK;
}

async function reply(ctx, flags, id, rest, { getApi = existingServerApi, clearRequests = clearJobRequests } = {}) {
  const [decision, ...messageParts] = rest;
  if (!id || !decision) throw new UsageError('USAGE', USAGE);
  const policy = ctx.config?.policy ?? {};
  const approver = policy.approver ?? 'user';
  const syntax = checkReply({ approver, request: null, reply: decision, confirmedByUser: true, policy });
  if (!syntax.ok) throw new UsageError(syntax.code, syntax.reason);
  const message = messageParts.join(' ').trim();
  if (id.startsWith('frm')) {
    if (decision !== 'reject') throw new UsageError('INVALID_REPLY', 'perguntas só podem ser recusadas aqui; responda com: permissions answer <id> <resposta...>');
    const knownJob = jobForRequest(ctx, id);
    const api = requireServerApi(ctx, getApi);
    const sessionID = sessionForRequest(knownJob, id);
    const pending = sessionID && (await api.listQuestions(sessionID) ?? []).find((q) => q.id === id);
    if (!pending) throw new NotFoundError('NOT_FOUND', `a pergunta ${id} não está pendente`);
    await api.rejectQuestion(sessionID, id);
    if (knownJob) await clearRequests(ctx.stateDir, knownJob.id, [id]);
    ctx.out(`Pergunta ${id} recusada.${knownJob ? `\nAcompanhe a tarefa: /opc:status ${knownJob.id} --wait` : ''}\n`);
    return ExitCode.OK;
  }
  const knownJob = jobForRequest(ctx, id);
  const api = requireServerApi(ctx, getApi);
  const sessionID = sessionForRequest(knownJob, id);
  const pending = sessionID ? (await api.listPermissions(sessionID)) ?? [] : [];
  const request = pending.find((p) => p.id === id);
  if (!request) throw new NotFoundError('NOT_FOUND', `a solicitação de permissão ${id} não está pendente`);
  const verdict = checkReply({ approver, request, reply: decision, confirmedByUser: Boolean(flags['confirmed-by-user']), policy });
  if (!verdict.ok) throw verdict.code === 'INVALID_REPLY' ? new UsageError(verdict.code, verdict.reason) : new PolicyError(verdict.code, verdict.reason);
  await api.replyPermission(sessionID, id, decision === 'reject' ? { reply: 'reject', ...(message ? { message } : {}) } : { reply: 'once' });
  const siblings = decision === 'reject' ? pending.filter((p) => p.sessionID === request.sessionID && p.id !== id).map((p) => p.id) : [];
  if (knownJob) await clearRequests(ctx.stateDir, knownJob.id, [id, ...siblings]);
  const lines = [`Resposta ${decision} enviada para ${id} (${request.permission}).`];
  if (siblings.length) lines.push(`O OpenCode também recusou as outras solicitações pendentes desta sessão: ${siblings.join(', ')}.`);
  if (knownJob) lines.push(`Acompanhe a tarefa: /opc:status ${knownJob.id} --wait`);
  ctx.out(`${lines.join('\n')}\n`);
  return ExitCode.OK;
}

async function answer(ctx, id, values, { getApi = existingServerApi, clearRequests = clearJobRequests } = {}) {
  if (!id || !id.startsWith('frm') || values.length === 0) throw new UsageError('USAGE', USAGE);
  const knownJob = jobForRequest(ctx, id);
  const api = requireServerApi(ctx, getApi);
  const sessionID = sessionForRequest(knownJob, id);
  const request = sessionID && ((await api.listQuestions(sessionID)) ?? []).find((q) => q.id === id);
  if (!request) throw new NotFoundError('NOT_FOUND', `a pergunta ${id} não está pendente`);
  const answers = parseAnswers(request.questions ?? [], values);
  await api.replyQuestion(sessionID, request, answers);
  if (knownJob) await clearRequests(ctx.stateDir, knownJob.id, [id]);
  ctx.out(`Resposta enviada para ${id}.${knownJob ? `\nAcompanhe a tarefa: /opc:status ${knownJob.id} --wait` : ''}\n`);
  return ExitCode.OK;
}

export async function run(ctx, argv, dependencies = {}) {
  const { flags, positionals } = parseArgs(argv, { flags: FLAGS, allowPositionals: true });
  const [action = 'list', id, ...rest] = positionals;
  switch (action) {
    case 'list': return list(ctx, flags);
    case 'reply': return reply(ctx, flags, id, rest, dependencies);
    case 'answer': return answer(ctx, id, rest, dependencies);
    default: throw new UsageError('USAGE', USAGE);
  }
}
