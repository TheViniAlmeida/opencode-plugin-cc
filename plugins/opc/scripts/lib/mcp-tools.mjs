import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { validateInput } from './mcp-schema.mjs';
import { ExitCode, OpcError, toExitCode } from './opc-error.mjs';
import { getProcessIdentity } from './process.mjs';
import { redactOutput, safeOutputText } from './redact.mjs';
import { loadState, resolveDataDir, resolveWorkspaceRoot, workspaceStateDir } from './state.mjs';

export const MAX_WAIT_SEC = 540;
export const DEFAULT_WAIT_SEC = 120;
export const DEFAULT_STATUS_WAIT_SEC = 60;
export const CALL_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_CHARS = 200_000;
export const EXIT_STATE = Object.freeze({ 0: 'ok', 2: 'usage_error', 3: 'waiting_permission', 4: 'policy_denied', 5: 'connection_error', 6: 'wait_timeout', 7: 'job_failed', 130: 'cancelled' });
const NON_ERROR_EXITS = new Set([ExitCode.OK, ExitCode.WAITING, ExitCode.WAIT_TIMEOUT]);

export const ALLOWED_COMMANDS = Object.freeze([
  'models', 'providers', 'agents', 'catalog', 'config get',
  'task', 'ask', 'plan', 'subagent', 'orchestrate', 'conclave',
  'sessions', 'session show', 'session new', 'session fork', 'session summarize', 'session children', 'session diff', 'session todo',
  'status', 'result', 'cancel',
  'permissions list', 'permissions reply', 'permissions answer',
]);
const TWO_LEVEL = new Set(['config', 'session', 'permissions']);

export function commandKey(argv) {
  return TWO_LEVEL.has(argv[0]) ? `${argv[0]} ${argv[1]}` : argv[0];
}

export const SERVER_INSTRUCTIONS = [
  'opc executa modelos, agentes e sessões do OpenCode. As ferramentas seguem as mesmas regras dos comandos /opc:.',
  'Ferramentas demoradas (opc_task, opc_ask, opc_plan, opc_subagent, opc_orchestrate, opc_conclave) iniciam um job em segundo plano por padrão e devolvem seu ID; acompanhe com opc_job_status e opc_job_result.',
  'O estado "waiting_permission" indica que um job precisa de aprovação: liste com opc_permissions_list e apresente ao usuário com AskUserQuestion antes de chamar opc_permissions_reply, exceto se o aprovador configurado for "claude" e a solicitação não envolver operação destrutiva, external_directory ou caminho sensível.',
  'Nunca defina confirmedByUser=true sem aprovação explícita do usuário nesta conversa. "always" nunca é aceito.',
  'Não há ferramentas MCP para alterar configuração, reverter sessões, parar o servidor, executar revisões ou transferir sessões: peça ao usuário que execute o comando /opc: correspondente.',
].join('\n');

const IDENT_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_.:-]*$';
const MODEL_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_./:@+-]*$';

const CWD = { type: 'string', minLength: 1, maxLength: 4096, description: 'Diretório absoluto do workspace. Padrão: diretório do projeto Claude Code.' };
const ident = (description) => ({ type: 'string', pattern: IDENT_PATTERN, maxLength: 200, description });
const modelId = (description) => ({ type: 'string', pattern: MODEL_PATTERN, maxLength: 300, description });
const text = (description, maxLength = 1_000_000) => ({ type: 'string', minLength: 1, maxLength, description });
const bool = (description) => ({ type: 'boolean', description });
const int = (description, minimum, maximum) => ({ type: 'integer', minimum, maximum, description });
const WAIT = bool('Aguarda a conclusão do job (limitado por waitTimeoutSec) em vez de retornar o ID imediatamente. Padrão false: job em segundo plano.');
const WAIT_TIMEOUT = int(`Segundos de espera quando wait=true (padrão ${DEFAULT_WAIT_SEC}, máximo ${MAX_WAIT_SEC}). Após o prazo, o job continua e seu ID é retornado.`, 1, MAX_WAIT_SEC);

function object(properties, required = []) {
  return { type: 'object', properties: { ...properties, cwd: CWD }, required, additionalProperties: false };
}

class ArgvBuilder {
  constructor(...head) {
    this.head = head;
    this.positionals = [];
    this.flags = [];
    this.tailValues = [];
  }

  pos(value) {
    if (value !== undefined && value !== null) this.positionals.push(String(value));
    return this;
  }

  str(flag, value) {
    if (value !== undefined && value !== null) {
      assertFlagValue(flag, value);
      this.flags.push(`--${flag}`, String(value));
    }
    return this;
  }

  num(flag, value) {
    if (value !== undefined && value !== null) this.flags.push(`--${flag}`, String(value));
    return this;
  }

  list(flag, values) {
    if (values && values.length > 0) {
      values.forEach((value) => assertFlagValue(flag, value));
      this.flags.push(`--${flag}`, values.join(','));
    }
    return this;
  }

  bool(flag, value) {
    if (value === true) this.flags.push(`--${flag}`);
    return this;
  }

  wait(args) {
    return args.wait === true ? this.num('wait-timeout', args.waitTimeoutSec ?? DEFAULT_WAIT_SEC) : this.bool('background', true);
  }

  tail(values) {
    this.tailValues = values.filter((value) => value !== undefined && value !== null).map(String);
    return this;
  }

  build() {
    const argv = [...this.head, ...this.positionals, ...this.flags, '--json'];
    if (this.tailValues.length > 0) argv.push('--', ...this.tailValues);
    return argv;
  }
}

function assertFlagValue(flag, value) {
  if (String(value).startsWith('-')) {
    throw new OpcError('INVALID_ARGUMENTS', `O valor de --${flag} não pode começar com "-"`, { exitCode: ExitCode.USAGE });
  }
}

const waitTimeout = (args) => (args.wait === true ? ((args.waitTimeoutSec ?? DEFAULT_WAIT_SEC) + 300) * 1000 : undefined);
const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const STATEFUL = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const MAY_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

const MODEL_FLAGS = {
  model: modelId('Modelo: alias, ID completo provider/model ou nome curto no provedor padrão. Mesma resolução e política de --model.'),
  variant: ident('Variante do modelo (validada contra as variantes disponíveis).'),
  tier: ident('Nível de roteamento da configuração opc (por exemplo, light ou heavy).'),
  resume: ident('Retoma este ID de sessão OpenCode ou ID de job opc.'),
  resumeLast: bool('Retoma o último job concluído do mesmo tipo nesta sessão Claude.'),
  fresh: bool('Força uma nova sessão.'),
  timeoutSec: int('Prazo do turno em segundos (o job é interrompido após esse prazo).', 1, 86_400),
  wait: WAIT,
  waitTimeoutSec: WAIT_TIMEOUT,
};

function readOnlyTurnTool(name, title, sub, what) {
  return {
    name,
    title,
    description: `${what} Perfil de permissões somente leitura. Inicia um job em segundo plano por padrão e retorna seu ID. Mesmas opções e regras de /opc:${sub}.`,
    annotations: STATEFUL,
    inputSchema: object({ prompt: text('Texto do prompt, enviado sem alterações ao OpenCode.'), ...MODEL_FLAGS }),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder(sub).str('model', a.model).str('variant', a.variant).str('tier', a.tier).str('resume-id', a.resume)
      .bool('resume-last', a.resumeLast).bool('fresh', a.fresh).num('timeout', a.timeoutSec).wait(a).tail([a.prompt]).build(),
  };
}

function sessionTool(name, title, action, description) {
  return {
    name,
    title,
    description,
    annotations: READ_ONLY,
    inputSchema: object({ sessionId: ident('ID da sessão OpenCode (ses_…).') }, ['sessionId']),
    toArgv: (a) => new ArgvBuilder('session', action).pos(a.sessionId).build(),
  };
}

export const TOOLS = Object.freeze([
  {
    name: 'opc_models',
    title: 'Listar modelos OpenCode',
    description: 'Lista modelos dos provedores conectados, com variantes, limites e custos, aplicando a política opc. Igual a /opc:models.',
    annotations: READ_ONLY,
    inputSchema: object({
      provider: ident('Somente este ID de provedor.'),
      allowed: bool('Oculta modelos negados pela política.'),
      all: bool('Inclui provedores não conectados.'),
      verbose: bool('Inclui detalhes.'),
    }),
    toArgv: (a) => new ArgvBuilder('models').pos(a.provider).bool('allowed', a.allowed).bool('all', a.all).bool('verbose', a.verbose).build(),
  },
  {
    name: 'opc_providers',
    title: 'Listar provedores OpenCode',
    description: 'Lista provedores conectados com a política aplicada (all=true para o catálogo completo). Igual a /opc:providers.',
    annotations: READ_ONLY,
    inputSchema: object({ all: bool('Inclui o catálogo completo de provedores.') }),
    toArgv: (a) => new ArgvBuilder('providers').bool('all', a.all).build(),
  },
  {
    name: 'opc_agents',
    title: 'Listar agentes OpenCode',
    description: 'Lista agentes OpenCode. Igual a /opc:agents.',
    annotations: READ_ONLY,
    inputSchema: object({
      mode: { type: 'string', enum: ['primary', 'subagent', 'all'], description: 'Filtro de modo dos agentes.' },
      verbose: bool('Inclui detalhes.'),
      allowed: bool('Oculta agentes negados pela política.'),
    }),
    toArgv: (a) => new ArgvBuilder('agents').str('mode', a.mode).bool('verbose', a.verbose).bool('allowed', a.allowed).build(),
  },
  {
    name: 'opc_catalog',
    title: 'Listar comandos ou skills OpenCode',
    description: 'Lista comandos de barra ou skills OpenCode. Igual a /opc:catalog.',
    annotations: READ_ONLY,
    inputSchema: object({ kind: { type: 'string', enum: ['commands', 'skills'], description: 'O que listar.' } }, ['kind']),
    toArgv: (a) => new ArgvBuilder('catalog').pos(a.kind).build(),
  },
  {
    name: 'opc_config_get',
    title: 'Ler configuração opc',
    description: 'Lê a configuração efetiva ou uma chave (somente leitura). Não há ferramenta MCP para alterá-la: o usuário executa /opc:config ou /opc:setup.',
    annotations: READ_ONLY,
    inputSchema: object({ key: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]*$', maxLength: 200, description: 'Chave pontuada, por exemplo policy.approver.' } }),
    toArgv: (a) => new ArgvBuilder('config', 'get').pos(a.key).build(),
  },
  {
    name: 'opc_task',
    title: 'Executar tarefa no OpenCode',
    description: 'Delega uma tarefa ao OpenCode. Somente leitura, exceto com write=true (comandos destrutivos ainda exigem aprovação). Inicia em segundo plano por padrão e retorna o ID. Mesmas opções e regras de /opc:task.',
    annotations: MAY_WRITE,
    inputSchema: object({
      prompt: text('Prompt da tarefa, enviado sem alterações ao OpenCode. Opcional apenas ao retomar.'),
      ...MODEL_FLAGS,
      agent: ident('Agente OpenCode.'),
      write: bool('Permite edições (perfil de permissão write).'),
      profile: ident('Perfil de permissão: read-only, write ou custom:<name>.'),
    }),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('task').str('model', a.model).str('agent', a.agent).str('variant', a.variant).str('tier', a.tier)
      .bool('write', a.write).str('profile', a.profile).str('resume-id', a.resume).bool('resume-last', a.resumeLast).bool('fresh', a.fresh)
      .num('timeout', a.timeoutSec).wait(a).tail([a.prompt]).build(),
  },
  readOnlyTurnTool('opc_ask', 'Perguntar ao OpenCode', 'ask', 'Solicita análise do código ao OpenCode (resposta concisa com arquivo:linha).'),
  readOnlyTurnTool('opc_plan', 'Planejar com OpenCode', 'plan', 'Solicita um plano de implementação ao OpenCode (arquivos, ordem, alternativas, riscos e testes).'),
  {
    name: 'opc_subagent',
    title: 'Executar subagentes OpenCode em paralelo',
    description: 'Executa o mesmo prompt em vários agentes OpenCode (e modelos opcionais) como um grupo de jobs. Segundo plano por padrão. Igual a /opc:subagent.',
    annotations: STATEFUL,
    inputSchema: object({
      prompt: text('Texto do prompt, enviado sem alterações.'),
      agents: { type: 'array', minItems: 1, maxItems: 8, items: ident('Nome do agente.'), description: 'Agentes, um job por agente.' },
      models: { type: 'array', minItems: 1, maxItems: 8, items: modelId('Modelo.'), description: 'Modelos opcionais, correspondentes à posição dos agentes.' },
      wait: WAIT,
      waitTimeoutSec: WAIT_TIMEOUT,
    }, ['prompt', 'agents']),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('subagent').list('agent', a.agents).list('model', a.models).wait(a).tail([a.prompt]).build(),
  },
  {
    name: 'opc_orchestrate',
    title: 'Orquestrar tarefa com OpenCode',
    description: 'Decompõe a tarefa em subtarefas paralelas e sintetiza o resultado. Edição apenas com write=true. Segundo plano por padrão. Igual a /opc:orchestrate.',
    annotations: MAY_WRITE,
    inputSchema: object({
      task: text('Descrição da tarefa, enviada sem alterações.'),
      planner: modelId('Modelo planejador.'),
      maxSubtasks: int('Número máximo de subtarefas (--max).', 2, 10),
      synthesizer: modelId('"claude" ou um modelo.'),
      write: bool('Permite subtarefas de edição (uma por vez).'),
      wait: WAIT,
      waitTimeoutSec: WAIT_TIMEOUT,
    }, ['task']),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('orchestrate').str('planner', a.planner).num('max', a.maxSubtasks).str('synthesizer', a.synthesizer)
      .bool('write', a.write).wait(a).tail([a.task]).build(),
  },
  {
    name: 'opc_conclave',
    title: 'Executar conclave de modelos',
    description: 'Faz a mesma pergunta a vários modelos em paralelo (opinião ou debate) e sintetiza as respostas. Segundo plano por padrão. Igual a /opc:conclave.',
    annotations: STATEFUL,
    inputSchema: object({
      question: text('Pergunta, enviada sem alterações.'),
      models: { type: 'array', minItems: 2, maxItems: 8, items: modelId('Modelo.'), description: 'Membros (use isto ou pool).' },
      pool: ident('Nome do grupo configurado.'),
      mode: { type: 'string', enum: ['opinion', 'debate'], description: 'Modo do conclave.' },
      rounds: int('Rodadas (debate exige pelo menos 2).', 1, 3),
      judge: modelId('"claude" ou um modelo.'),
      quorum: int('Mínimo de respostas válidas.', 2, 8),
      allowJudgeMember: bool('Permite que o juiz também seja membro.'),
      wait: WAIT,
      waitTimeoutSec: WAIT_TIMEOUT,
    }, ['question']),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('conclave').list('models', a.models).str('pool', a.pool).str('mode', a.mode).num('rounds', a.rounds)
      .str('judge', a.judge).num('quorum', a.quorum).bool('allow-judge-member', a.allowJudgeMember).wait(a).tail([a.question]).build(),
  },
  {
    name: 'opc_session_list',
    title: 'Listar sessões OpenCode',
    description: 'Lista sessões OPC: deste workspace (all=true para todas as sessões). Igual a /opc:sessions.',
    annotations: READ_ONLY,
    inputSchema: object({ all: bool('Lista todas as sessões, não apenas as OPC:.') }),
    toArgv: (a) => new ArgvBuilder('sessions').bool('all', a.all).build(),
  },
  sessionTool('opc_session_show', 'Exibir sessão OpenCode', 'show', 'Exibe a sessão e as mensagens recentes. Igual a /opc:session show.'),
  {
    name: 'opc_session_new',
    title: 'Criar sessão OpenCode',
    description: 'Cria uma nova sessão OPC:. Igual a /opc:session new.',
    annotations: STATEFUL,
    inputSchema: object({ title: text('Título da sessão (não pode começar com "-").', 200), agent: ident('Agente.'), model: modelId('Modelo.') }),
    toArgv: (a) => new ArgvBuilder('session', 'new').str('title', a.title).str('agent', a.agent).str('model', a.model).build(),
  },
  {
    name: 'opc_session_fork',
    title: 'Bifurcar sessão OpenCode',
    description: 'Bifurca uma sessão, opcionalmente em uma mensagem. Igual a /opc:session fork.',
    annotations: STATEFUL,
    inputSchema: object({ sessionId: ident('ID da sessão.'), messageId: ident('ID da mensagem de bifurcação.') }, ['sessionId']),
    toArgv: (a) => new ArgvBuilder('session', 'fork').pos(a.sessionId).pos(a.messageId).build(),
  },
  {
    name: 'opc_session_summarize',
    title: 'Resumir sessão OpenCode',
    description: 'Resume e compacta uma sessão com um modelo (política aplicada). Igual a /opc:session summarize.',
    annotations: STATEFUL,
    inputSchema: object({ sessionId: ident('ID da sessão.'), model: modelId('Modelo de resumo.') }, ['sessionId']),
    toArgv: (a) => new ArgvBuilder('session', 'summarize').pos(a.sessionId).str('model', a.model).build(),
  },
  sessionTool('opc_session_children', 'Listar sessões filhas', 'children', 'Lista sessões filhas (subagentes). Igual a /opc:session children.'),
  sessionTool('opc_session_diff', 'Exibir diff da sessão', 'diff', 'Exibe o diff dos arquivos da sessão. Igual a /opc:session diff.'),
  sessionTool('opc_session_todo', 'Exibir tarefas da sessão', 'todo', 'Exibe a lista de tarefas da sessão. Igual a /opc:session todo.'),
  {
    name: 'opc_job_status',
    title: 'Estado do job opc',
    description: 'Exibe o estado de um job ou os jobs recentes desta sessão Claude. wait=true (exige jobId) aguarda até timeoutSec. Igual a /opc:status.',
    annotations: READ_ONLY,
    inputSchema: object({
      jobId: ident('ID do job ou prefixo único.'),
      all: bool('Jobs de todas as sessões Claude.'),
      wait: bool('Aguarda a conclusão do job ou uma solicitação de permissão.'),
      timeoutSec: int(`Prazo de espera em segundos (padrão ${DEFAULT_STATUS_WAIT_SEC}).`, 1, MAX_WAIT_SEC),
    }),
    timeoutMs: (a) => (a.wait === true ? ((a.timeoutSec ?? DEFAULT_STATUS_WAIT_SEC) + 60) * 1000 : undefined),
    toArgv: (a) => {
      const builder = new ArgvBuilder('status').pos(a.jobId).bool('all', a.all);
      if (a.wait === true) builder.bool('wait', true).num('timeout-ms', (a.timeoutSec ?? DEFAULT_STATUS_WAIT_SEC) * 1000);
      return builder.build();
    },
  },
  {
    name: 'opc_job_result',
    title: 'Resultado do job opc',
    description: 'Resultado final de um job concluído (erro enquanto estiver em execução). Para grupos, data contém { group, members } e o resultado agregado fica em group.result. Igual a /opc:result.',
    annotations: READ_ONLY,
    inputSchema: object({ jobId: ident('ID do job ou prefixo único.') }),
    toArgv: (a) => new ArgvBuilder('result').pos(a.jobId).build(),
  },
  {
    name: 'opc_job_cancel',
    title: 'Cancelar job opc',
    description: 'Cancela um job (sem jobId: o único job ativo desta sessão Claude). Igual a /opc:cancel.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: object({ jobId: ident('ID do job ou prefixo único.') }),
    toArgv: (a) => new ArgvBuilder('cancel').pos(a.jobId).build(),
  },
  {
    name: 'opc_permissions_list',
    title: 'Listar solicitações de permissão OpenCode',
    description: 'Lista permissões e perguntas pendentes dos jobs opc. Igual a /opc:permissions list.',
    annotations: READ_ONLY,
    inputSchema: object({}),
    toArgv: () => new ArgvBuilder('permissions', 'list').build(),
  },
  {
    name: 'opc_permissions_reply',
    title: 'Responder solicitação de permissão OpenCode',
    description: [
      'Responde "once" ou "reject" a uma permissão pendente ("always" não existe). Mesmas regras de /opc:permissions reply:',
      'com aprovador "user" (padrão), apresente a solicitação ao usuário via AskUserQuestion antes de responder;',
      'comandos destrutivos, external_directory e caminhos sensíveis sempre exigem o usuário, qualquer que seja o aprovador.',
      'Defina confirmedByUser=true SOMENTE após o usuário aprovar explicitamente esta solicitação exata nesta conversa; nunca por conta própria.',
      'Agentes opc-worker e opc-rescue nunca devem chamar esta ferramenta.',
      'A resposta pode entregar data como string Markdown.',
    ].join(' '),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: object({
      requestId: { type: 'string', pattern: '^per[A-Za-z0-9_]*$', maxLength: 200, description: 'ID da solicitação de permissão (per_…).' },
      reply: { type: 'string', enum: ['once', 'reject'], description: 'once ou reject.' },
      message: text('Mensagem opcional enviada com reject.', 2000),
      confirmedByUser: bool('True apenas depois que o usuário aprovar explicitamente esta solicitação (AskUserQuestion).'),
    }, ['requestId', 'reply']),
    toArgv: (a) => {
      if (a.reply !== 'once' && a.reply !== 'reject') {
        throw new OpcError('INVALID_ARGUMENTS', 'reply deve ser "once" ou "reject"', { exitCode: ExitCode.USAGE });
      }
      return new ArgvBuilder('permissions', 'reply').pos(a.requestId).pos(a.reply).bool('confirmed-by-user', a.confirmedByUser).tail([a.message]).build();
    },
  },
  {
    name: 'opc_permissions_answer',
    title: 'Responder pergunta OpenCode',
    description: 'Responde uma pergunta pendente, com uma entrada por questão na ordem (mesma codificação de /opc:permissions answer). Pergunte ao usuário quando a resposta for dele. A resposta pode entregar data como string Markdown.',
    annotations: STATEFUL,
    inputSchema: object({
      requestId: { type: 'string', pattern: '^que[A-Za-z0-9_]*$', maxLength: 200, description: 'ID da pergunta (que_…).' },
      answers: { type: 'array', minItems: 1, maxItems: 20, items: text('Rótulo da resposta ou texto livre.', 2000), description: 'Respostas na ordem das perguntas.' },
    }, ['requestId', 'answers']),
    toArgv: (a) => new ArgvBuilder('permissions', 'answer').pos(a.requestId).tail(a.answers).build(),
  },
]);

export const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

export function resolveClaudeSessionId({ env, cwd, ppid }, deps = {}) {
  if (env.OPC_COMPANION_SESSION_ID) return env.OPC_COMPANION_SESSION_ID;
  const d = { resolveDataDir, resolveWorkspaceRoot, workspaceStateDir, loadState, getProcessIdentity, ...deps };
  try {
    const identity = d.getProcessIdentity(ppid);
    if (!identity) return null;
    const stateDir = d.workspaceStateDir(d.resolveDataDir(env), d.resolveWorkspaceRoot(cwd));
    const matches = d.loadState(stateDir).claudeSessions.filter((s) => s.pid === ppid && s.pidStartTime === identity.startTime);
    matches.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return matches[0]?.sessionId ?? null;
  } catch {
    return null;
  }
}

export function createCaptureStream({ maxChars = MAX_OUTPUT_CHARS } = {}) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const piece = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (size + piece.length > maxChars) truncated = true;
      if (size < maxChars) chunks.push(piece.slice(0, maxChars - size));
      size += piece.length;
      callback();
    },
  });
  stream.isTTY = false;
  stream.text = () => chunks.join('');
  stream.truncated = () => truncated;
  return stream;
}

export function emptyStdin() {
  const stream = Readable.from([]);
  stream.isTTY = false;
  return stream;
}

export function buildEnvelope({ exitCode, stdout = '', stderr = '', error = null, truncated = false }) {
  const envelope = { exitCode, state: EXIT_STATE[exitCode] ?? 'error' };
  const out = String(stdout).trim();
  if (out) {
    try {
      envelope.data = redactOutput(JSON.parse(out));
    } catch {
      envelope.data = safeOutputText(out);
    }
  }
  if (truncated) envelope.truncated = true;
  const isError = !NON_ERROR_EXITS.has(exitCode);
  if (error) {
    envelope.error = { code: error.code ?? 'INTERNAL', message: safeOutputText(error.message ?? error) };
  } else if (isError) {
    const commandError = envelope.data && typeof envelope.data === 'object' && envelope.data.error;
    if (commandError) {
      envelope.error = {
        code: typeof commandError === 'object' ? commandError.code ?? 'COMMAND_FAILED' : 'COMMAND_FAILED',
        message: safeOutputText(typeof commandError === 'object' ? commandError.message ?? JSON.stringify(commandError) : commandError),
      };
    } else {
      const tail = safeOutputText(String(stderr).trim()).slice(-2000);
      if (tail) envelope.error = { code: 'COMMAND_FAILED', message: tail };
    }
  }
  return { envelope, isError };
}

export function toolResult({ envelope, isError }) {
  return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], isError };
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new OpcError('MCP_CALL_TIMEOUT', `A chamada da ferramenta excedeu ${Math.round(ms / 1000)} s; o comando pode continuar em execução`, { exitCode: ExitCode.CONNECTION }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function maskInputEcho(message, input) {
  const values = [];
  function collect(value) {
    if (typeof value === 'string' && value.length > 0) values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(input);
  if (values.length === 0) return String(message);
  const pattern = values.sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(message).replace(new RegExp(pattern, 'gu'), '***');
}

export function createToolCaller({ dispatch, env = process.env, defaultCwd = env.CLAUDE_PROJECT_DIR || process.cwd(), ppid = process.ppid, resolveSessionId = resolveClaudeSessionId, callTimeoutMs = CALL_TIMEOUT_MS, log = () => {} }) {
  return async function callTool(tool, args) {
    const input = args ?? {};
    const errors = validateInput(tool.inputSchema, input);
    if (errors.length > 0) {
      return toolResult(buildEnvelope({ exitCode: ExitCode.USAGE, error: { code: 'INVALID_ARGUMENTS', message: 'Argumentos inválidos.' } }));
    }
    let argv;
    try {
      argv = tool.toArgv(input);
    } catch (err) {
      return toolResult(buildEnvelope({ exitCode: toExitCode(err), error: { code: err.code, message: maskInputEcho(err.message, input) } }));
    }
    const cwd = input.cwd ?? defaultCwd;
    if (!path.isAbsolute(cwd) || !isDirectory(cwd)) {
      return toolResult(buildEnvelope({ exitCode: ExitCode.USAGE, error: { code: 'INVALID_CWD', message: 'cwd deve ser um diretório absoluto existente' } }));
    }
    const callEnv = { ...env };
    const sessionId = resolveSessionId({ env: callEnv, cwd, ppid });
    if (sessionId) callEnv.OPC_COMPANION_SESSION_ID = sessionId;
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    let captured = null;
    let exitCode;
    try {
      exitCode = await withTimeout(
        Promise.resolve(dispatch(argv, { env: callEnv, cwd, stdin: emptyStdin(), stdout, stderr, onError: (err) => { captured = err; } })),
        tool.timeoutMs?.(input) ?? callTimeoutMs,
      );
    } catch (err) {
      captured = err;
      exitCode = toExitCode(err);
    }
    await new Promise((resolve) => setImmediate(resolve));
    log(`[opc] mcp ${tool.name} → exit ${exitCode}`);
    const safeError = captured && { code: captured.code, message: maskInputEcho(captured.message ?? captured, input) };
    const safeStdout = NON_ERROR_EXITS.has(exitCode) ? stdout.text() : maskInputEcho(stdout.text(), input);
    return toolResult(buildEnvelope({ exitCode, stdout: safeStdout, stderr: maskInputEcho(stderr.text(), input), error: safeError, truncated: stdout.truncated() }));
  };
}
