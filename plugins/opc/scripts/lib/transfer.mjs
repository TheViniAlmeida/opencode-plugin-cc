// Claude Code JSONL transcript -> `opencode export` JSON -> `opencode import` (spec §4, §13.3 F5).
// Export format verified against OpenCode 1.18.32 (`opencode export`, OpenAPI Session/UserMessage/AssistantMessage/TextPart).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { expandAlias, parseFullId } from './models.mjs';
import { ExitCode, OpcError } from './opc-error.mjs';
import { assertAllowed } from './policy.mjs';
import { compareVersions, MIN_OPENCODE_VERSION } from './server.mjs';
import { ensurePrivateDir } from './state.mjs';

export const TRANSCRIPT_PATH_ENV = 'OPC_COMPANION_TRANSCRIPT_PATH';
export const ALLOWED_ROOT_ENV = 'OPC_TRANSFER_ALLOWED_ROOT';
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_CHARS = 65536;
export const MAX_TOOL_CHARS = 2000;
export const TITLE_PREFIX = 'OPC: transfer: ';
export const IMPORT_SUCCESS_RE = /^Imported session: (ses_[0-9A-Za-z]+)\s*$/m;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LOCAL_COMMAND_RE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

export const EXPORT_SHAPE = Object.freeze({
  session: {
    required: ['id', 'slug', 'projectID', 'directory', 'title', 'version', 'time'],
    allowed: ['id', 'slug', 'projectID', 'workspaceID', 'directory', 'path', 'parentID', 'summary', 'cost', 'tokens', 'share', 'title', 'agent', 'model', 'version', 'metadata', 'time', 'permission', 'revert'],
  },
  user: {
    required: ['id', 'sessionID', 'role', 'time', 'agent', 'model'],
    allowed: ['id', 'sessionID', 'role', 'time', 'format', 'summary', 'agent', 'model', 'system', 'tools'],
  },
  assistant: {
    required: ['id', 'sessionID', 'role', 'time', 'parentID', 'modelID', 'providerID', 'mode', 'agent', 'path', 'cost', 'tokens'],
    allowed: ['id', 'sessionID', 'role', 'time', 'error', 'parentID', 'modelID', 'providerID', 'mode', 'agent', 'path', 'summary', 'cost', 'tokens', 'structured', 'variant', 'finish'],
  },
  partBase: ['id', 'sessionID', 'messageID', 'type'],
  parts: {
    text: {
      required: ['id', 'sessionID', 'messageID', 'type', 'text'],
      allowed: ['id', 'sessionID', 'messageID', 'type', 'text', 'synthetic', 'ignored', 'time', 'metadata'],
    },
    reasoning: { required: ['id', 'sessionID', 'messageID', 'type', 'text', 'time'] },
    tool: { required: ['id', 'sessionID', 'messageID', 'type', 'callID', 'tool', 'state'] },
    'step-start': { required: ['id', 'sessionID', 'messageID', 'type'] },
    'step-finish': { required: ['id', 'sessionID', 'messageID', 'type', 'reason', 'cost', 'tokens'] },
  },
});

function usage(code, message) {
  return new OpcError(code, message, { exitCode: ExitCode.USAGE });
}

function preview(value) {
  return `${String(value).slice(0, 12)}…`;
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function resolveTranscriptPath({ source = null, env = process.env, cwd = process.cwd(), home = env.HOME || os.homedir() } = {}) {
  const requested = source || env[TRANSCRIPT_PATH_ENV];
  if (!requested) {
    throw usage('NO_TRANSCRIPT', 'Não foi possível identificar a transcrição atual do Claude. Tente novamente com --source <valor>.');
  }
  const candidate = path.resolve(cwd, expandHome(String(requested), home));
  if (path.extname(candidate) !== '.jsonl') throw usage('NOT_JSONL', `A origem da sessão do Claude precisa ser um arquivo .jsonl: ${preview(requested)}`);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new OpcError('NOT_FOUND', `Arquivo da sessão do Claude não encontrado: ${preview(requested)}`, { exitCode: ExitCode.USAGE });
  }
  if (path.extname(real) !== '.jsonl') throw usage('NOT_JSONL', `A origem da sessão do Claude precisa apontar para um arquivo .jsonl: ${preview(requested)}`);
  const rootInput = env[ALLOWED_ROOT_ENV] || path.join(home, '.claude', 'projects');
  let root;
  try {
    root = fs.realpathSync(rootInput);
  } catch {
    throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', `A raiz permitida da transcrição não existe: ${preview(rootInput)}`, { exitCode: ExitCode.POLICY });
  }
  if (!isInside(root, real)) {
    throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', `O opc importa sessões do Claude apenas da raiz permitida. Origem: ${preview(requested)}`, { exitCode: ExitCode.POLICY });
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw usage('NOT_A_FILE', `A origem da sessão do Claude não é um arquivo regular: ${preview(requested)}`);
  if (stat.size > MAX_TRANSCRIPT_BYTES) throw usage('TRANSCRIPT_TOO_LARGE', `O arquivo da sessão do Claude excede ${MAX_TRANSCRIPT_BYTES} bytes: ${preview(requested)}`);
  return real;
}

export function parseJsonlLines(lines) {
  const records = [];
  let invalid = 0;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { records, invalid };
}

export async function readTranscript(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return parseJsonlLines(lines);
}

export function truncateText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[${text.length - max} caracteres truncados]`;
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block?.type === 'text' ? String(block.text ?? '') : '[conteúdo omitido]')).join('\n');
  }
  return compactJson(content ?? '');
}

function timestampMs(record, fallback) {
  const ms = Date.parse(record.timestamp ?? '');
  return Number.isFinite(ms) ? ms : fallback;
}

export function convertClaudeRecords(records, { maxTextChars = MAX_TEXT_CHARS, maxToolChars = MAX_TOOL_CHARS, now = Date.now() } = {}) {
  const turns = [];
  const stats = { records: records.length, skipped: { meta: 0, sidechain: 0, command: 0, thinking: 0, other: 0 } };
  let title = null;
  let claudeSessionId = null;
  let lastTime = now;
  let current = null;

  const pushUser = (texts, createdAt) => {
    turns.push({ role: 'user', createdAt, texts });
    current = null;
  };
  const assistant = (createdAt) => {
    if (!current) {
      current = { role: 'assistant', createdAt, completedAt: createdAt, texts: [] };
      turns.push(current);
    }
    current.completedAt = Math.max(current.completedAt, createdAt);
    return current;
  };

  for (const record of records) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      title = record.customTitle;
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') {
      stats.skipped.other += 1;
      continue;
    }
    if (record.isSidechain === true) {
      stats.skipped.sidechain += 1;
      continue;
    }
    if (record.isMeta === true) {
      stats.skipped.meta += 1;
      continue;
    }
    if (claudeSessionId === null && typeof record.sessionId === 'string') claudeSessionId = record.sessionId;
    const createdAt = timestampMs(record, lastTime);
    lastTime = createdAt;
    const content = record.message?.content;

    if (record.type === 'user') {
      if (typeof content === 'string') {
        if (LOCAL_COMMAND_RE.test(content.trim())) stats.skipped.command += 1;
        else if (!content.trim()) stats.skipped.other += 1;
        else pushUser([truncateText(content, maxTextChars)], createdAt);
        continue;
      }
      if (!Array.isArray(content)) {
        stats.skipped.other += 1;
        continue;
      }
      const results = content.filter((block) => block?.type === 'tool_result');
      if (results.length > 0) {
        const turn = assistant(createdAt);
        for (const block of results) {
          turn.texts.push(truncateText(`[resultado da ferramenta: ${block.is_error ? 'erro' : 'sucesso'}] ${toolResultText(block.content)}`, maxToolChars));
        }
        continue;
      }
      const texts = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && !LOCAL_COMMAND_RE.test(block.text.trim())) {
          texts.push(truncateText(block.text, maxTextChars));
        } else if (block?.type === 'image') texts.push('[imagem omitida]');
        else if (block?.type === 'document') texts.push('[documento omitido]');
      }
      if (texts.length > 0) pushUser(texts, createdAt);
      else stats.skipped.command += 1;
      continue;
    }

    if (typeof content === 'string') {
      if (content.trim()) assistant(createdAt).texts.push(truncateText(content, maxTextChars));
      continue;
    }
    if (!Array.isArray(content)) {
      stats.skipped.other += 1;
      continue;
    }
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim()) assistant(createdAt).texts.push(truncateText(block.text, maxTextChars));
      } else if (block?.type === 'tool_use') {
        assistant(createdAt).texts.push(truncateText(`[chamada de ferramenta: ${block.name ?? 'desconhecida'}] ${compactJson(block.input ?? {})}`, maxToolChars));
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        stats.skipped.thinking += 1;
      } else if (block?.type) {
        assistant(createdAt).texts.push('[conteúdo omitido]');
      }
    }
  }
  return { turns: turns.filter((turn) => turn.texts.length > 0), title, claudeSessionId, stats };
}

export function createIdGenerator({ now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  let lastMs = 0;
  let counter = 0;
  return function nextId(prefix, direction = 'ascending') {
    const ms = now();
    if (ms !== lastMs) {
      lastMs = ms;
      counter = 0;
    }
    counter += 1;
    let value = BigInt(ms) * 4096n + BigInt(counter);
    if (direction === 'descending') value = ~value;
    const bytes = Buffer.alloc(6);
    for (let i = 0; i < 6; i += 1) bytes[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
    const random = randomBytes(14);
    let suffix = '';
    for (let i = 0; i < 14; i += 1) suffix += BASE62[random[i] % 62];
    return `${prefix}_${bytes.toString('hex')}${suffix}`;
  };
}

export function buildTitle(conversion) {
  const firstUser = conversion.turns.find((turn) => turn.role === 'user')?.texts[0] ?? '';
  const base = String(conversion.title || firstUser || 'Claude session').replace(/\s+/g, ' ').trim();
  return `${TITLE_PREFIX}${base.slice(0, 56)}`;
}

export function transferHeader(claudeSessionId) {
  return `[opc transfer] Conversa importada da sessão ${claudeSessionId ? preview(claudeSessionId) : 'desconhecida'} do Claude Code. Chamadas de ferramenta aparecem resumidas como texto.`;
}

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

export function buildExport(conversion, { model, agent = 'build', directory, version, nextId = createIdGenerator() }) {
  if (conversion.turns.length === 0) {
    throw usage('EMPTY_TRANSCRIPT', 'A transcrição do Claude não contém texto do usuário nem do assistente para transferir.');
  }
  const sessionID = nextId('ses', 'descending');
  const first = conversion.turns[0];
  const turns = first.role === 'user' ? conversion.turns : [{ role: 'user', createdAt: first.createdAt, texts: [] }, ...conversion.turns];
  const messages = [];
  let lastUserId = null;
  let updated = turns[0].createdAt;
  turns.forEach((turn, index) => {
    const id = nextId('msg', 'ascending');
    const parts = [];
    if (index === 0) {
      parts.push({ id: nextId('prt', 'ascending'), sessionID, messageID: id, type: 'text', text: transferHeader(conversion.claudeSessionId), synthetic: true });
    }
    for (const text of turn.texts) parts.push({ id: nextId('prt', 'ascending'), sessionID, messageID: id, type: 'text', text });
    updated = Math.max(updated, turn.completedAt ?? turn.createdAt);
    if (turn.role === 'user') {
      lastUserId = id;
      messages.push({
        info: { id, sessionID, role: 'user', time: { created: turn.createdAt }, agent, model: { providerID: model.providerID, modelID: model.modelID } },
        parts,
      });
      return;
    }
    messages.push({
      info: {
        id,
        sessionID,
        role: 'assistant',
        time: { created: turn.createdAt, completed: turn.completedAt ?? turn.createdAt },
        parentID: lastUserId,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: agent,
        agent,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: structuredClone(ZERO_TOKENS),
        finish: 'stop',
      },
      parts,
    });
  });
  return {
    info: {
      id: sessionID,
      slug: `transfer-${sessionID.slice(-6).toLowerCase()}`,
      projectID: 'global',
      directory,
      title: buildTitle(conversion),
      agent,
      model: { id: model.modelID, providerID: model.providerID },
      version,
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: structuredClone(ZERO_TOKENS),
      time: { created: turns[0].createdAt, updated },
    },
    messages,
  };
}

function checkKeys(obj, shape, where, errors) {
  for (const key of shape.required) if (obj[key] === undefined) errors.push(`${where}.${key}: obrigatório`);
  if (shape.allowed) for (const key of Object.keys(obj)) if (!shape.allowed.includes(key)) errors.push(`${where}.${preview(key)}: chave inválida para exportação`);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateExportShape(data) {
  const errors = [];
  if (!isObject(data) || !isObject(data.info) || !Array.isArray(data.messages)) return ['$: esperado { info: objeto, messages: lista }'];
  const info = data.info;
  checkKeys(info, EXPORT_SHAPE.session, 'info', errors);
  if (typeof info.id !== 'string' || !info.id.startsWith('ses')) errors.push('info.id: deve começar com "ses"');
  if (!isObject(info.time) || typeof info.time.created !== 'number' || typeof info.time.updated !== 'number') errors.push('info.time: created/updated devem ser números');
  const userIds = new Set();
  data.messages.forEach((message, i) => {
    const where = `messages[${i}]`;
    if (!isObject(message) || !isObject(message.info) || !Array.isArray(message.parts)) {
      errors.push(`${where}: esperado { info: objeto, parts: lista }`);
      return;
    }
    const m = message.info;
    const shape = EXPORT_SHAPE[m.role];
    if (m.role !== 'user' && m.role !== 'assistant') {
      errors.push(`${where}.info.role: deve ser user ou assistant`);
      return;
    }
    checkKeys(m, shape, `${where}.info`, errors);
    if (typeof m.id !== 'string' || !m.id.startsWith('msg')) errors.push(`${where}.info.id: deve começar com "msg"`);
    if (m.sessionID !== info.id) errors.push(`${where}.info.sessionID: deve ser igual a info.id`);
    if (!isObject(m.time) || typeof m.time.created !== 'number') errors.push(`${where}.info.time.created: deve ser um número`);
    if (m.role === 'user') {
      if (!isObject(m.model) || typeof m.model.providerID !== 'string' || typeof m.model.modelID !== 'string') errors.push(`${where}.info.model: exige providerID e modelID`);
      userIds.add(m.id);
    } else if (!userIds.has(m.parentID)) {
      errors.push(`${where}.info.parentID: deve apontar para uma mensagem anterior do usuário`);
    }
    message.parts.forEach((part, j) => {
      const pw = `${where}.parts[${j}]`;
      if (!isObject(part)) {
        errors.push(`${pw}: esperado objeto`);
        return;
      }
      checkKeys(part, EXPORT_SHAPE.parts[part.type] ?? { required: EXPORT_SHAPE.partBase }, pw, errors);
      if (typeof part.id !== 'string' || !part.id.startsWith('prt')) errors.push(`${pw}.id: deve começar com "prt"`);
      if (part.sessionID !== info.id) errors.push(`${pw}.sessionID: deve ser igual a info.id`);
      if (part.messageID !== m.id) errors.push(`${pw}.messageID: deve ser igual ao ID da mensagem`);
      if (part.type === 'text' && typeof part.text !== 'string') errors.push(`${pw}.text: deve ser texto`);
    });
  });
  return errors;
}

export function resolveTransferModel({ flag = null, config }) {
  const raw = flag ?? config.defaultModel ?? null;
  if (!raw) {
    throw usage('NO_MODEL', 'Nenhum modelo para registrar na sessão transferida. Use --model <valor> ou configure defaultModel com /opc:setup.');
  }
  const full = expandAlias(String(raw), config.aliases ?? {});
  if (!full.includes('/')) throw usage('MODEL_NEEDS_FULL_ID', `A transferência exige um ID de modelo completo (provider/model) ou alias: ${preview(raw)}`);
  const { providerID, modelID } = parseFullId(full);
  for (const [kind, value] of [['provider', providerID], ['model', full]]) {
    try {
      assertAllowed(kind, value, config.policy ?? {});
    } catch (error) {
      if (error.code !== 'POLICY_DENIED') throw error;
      throw new OpcError(error.code, `A política não permite ${kind === 'provider' ? 'o provedor' : 'o modelo'} ${preview(value)}.`, {
        exitCode: error.exitCode,
        details: { kind, value: preview(value) },
      });
    }
  }
  return { providerID, modelID, full };
}

function execFileResult(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ error, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function notFound(error) {
  return error?.code === 'ENOENT'
    ? new OpcError('OPENCODE_NOT_FOUND', 'Executável opencode não encontrado no PATH; execute /opc:setup', { exitCode: ExitCode.CONNECTION })
    : null;
}

export async function detectOpencodeVersion({ opencodeBin = 'opencode', env = process.env, execFileImpl = execFile } = {}) {
  const r = await execFileResult(execFileImpl, opencodeBin, ['--version'], { env, timeout: 15000, encoding: 'utf8' });
  const missing = notFound(r.error);
  if (missing) throw missing;
  const match = /(\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!match) throw new OpcError('UNSUPPORTED_VERSION', 'Não foi possível identificar a versão do OpenCode.', { exitCode: ExitCode.CONNECTION });
  if (compareVersions(match[1], MIN_OPENCODE_VERSION) < 0) {
    throw new OpcError('UNSUPPORTED_VERSION', `A versão do OpenCode é anterior à mínima exigida (${MIN_OPENCODE_VERSION}).`, { exitCode: ExitCode.CONNECTION });
  }
  return match[1];
}

export function writeExportFile(stateDir, exported) {
  const dir = path.join(stateDir, 'transfer');
  ensurePrivateDir(dir);
  const file = path.join(dir, `export-${exported.info.id}.json`);
  fs.writeFileSync(file, JSON.stringify(exported), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return file;
}

export function parseImportOutput(stdout) {
  const match = IMPORT_SUCCESS_RE.exec(String(stdout ?? ''));
  return match ? match[1] : null;
}

export async function runImport({ opencodeBin = 'opencode', file, cwd, env = process.env, timeoutMs = 120000, execFileImpl = execFile }) {
  const r = await execFileResult(execFileImpl, opencodeBin, ['import', file], { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const missing = notFound(r.error);
  if (missing) throw missing;
  const sessionID = parseImportOutput(r.stdout);
  if (!sessionID) {
    throw new OpcError('IMPORT_FAILED', `A importação pelo opencode falhou (saída ${r.code}).`, { exitCode: ExitCode.JOB_FAILED });
  }
  return { sessionID, exitCode: r.code };
}
