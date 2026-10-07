// Claude Code JSONL transcript -> OpenCode V2 session export -> session import.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandAlias, parseFullId } from './models.mjs';
import { ExitCode, OpcError } from './opc-error.mjs';
import { assertAllowed } from './policy.mjs';
import { maskSecretPatterns } from './redact.mjs';
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
  session: ['id', 'projectID', 'agent', 'model', 'cost', 'tokens', 'time', 'title', 'permissions', 'location'],
  user: ['id', 'type', 'time', 'text'],
  assistant: ['id', 'type', 'time', 'agent', 'model', 'content', 'cost', 'tokens'],
  synthetic: ['id', 'type', 'time', 'text'],
});

function usage(code, message) {
  return new OpcError(code, message, { exitCode: ExitCode.USAGE });
}

function preview(value) {
  return `${String(value).slice(0, 12)}…`;
}

function previewPath() {
  return '[caminho omitido]';
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

function resolveTranscriptDetails({ source = null, env = process.env, cwd = process.cwd(), home = env.HOME || os.homedir() } = {}) {
  const requested = source || env[TRANSCRIPT_PATH_ENV];
  if (!requested) {
    throw usage('NO_TRANSCRIPT', 'Não foi possível identificar a transcrição atual do Claude. Tente novamente com --source <valor>.');
  }
  const candidate = path.resolve(cwd, expandHome(String(requested), home));
  if (path.extname(candidate) !== '.jsonl') throw usage('NOT_JSONL', `A origem da sessão do Claude precisa ser um arquivo .jsonl: ${previewPath()}`);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new OpcError('NOT_FOUND', `Arquivo da sessão do Claude não encontrado: ${previewPath()}`, { exitCode: ExitCode.USAGE });
  }
  if (path.extname(real) !== '.jsonl') throw usage('NOT_JSONL', `A origem da sessão do Claude precisa apontar para um arquivo .jsonl: ${previewPath()}`);
  const rootInput = env[ALLOWED_ROOT_ENV] || path.join(home, '.claude', 'projects');
  let root;
  try {
    root = fs.realpathSync(rootInput);
  } catch {
    throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', `A raiz permitida da transcrição não existe: ${previewPath()}`, { exitCode: ExitCode.POLICY });
  }
  if (!isInside(root, real)) {
    throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', `O opc importa sessões do Claude apenas da raiz permitida. Origem: ${previewPath()}`, { exitCode: ExitCode.POLICY });
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new OpcError('NOT_FOUND', `Arquivo da sessão do Claude não encontrado: ${previewPath()}`, { exitCode: ExitCode.USAGE });
  }
  if (!stat.isFile()) throw usage('NOT_A_FILE', `A origem da sessão do Claude não é um arquivo regular: ${previewPath()}`);
  if (stat.size > MAX_TRANSCRIPT_BYTES) throw usage('TRANSCRIPT_TOO_LARGE', `O arquivo da sessão do Claude excede ${MAX_TRANSCRIPT_BYTES} bytes: ${previewPath()}`);
  return { real, stat };
}

export function resolveTranscriptPath(options = {}) {
  return resolveTranscriptDetails(options).real;
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

export async function readTranscript(file, options = {}) {
  const { real, stat } = resolveTranscriptDetails({ ...options, source: file });
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', 'A origem da sessão do Claude mudou durante a abertura.', { exitCode: ExitCode.POLICY });
    }
    throw new OpcError('NOT_FOUND', `Não foi possível abrir a sessão do Claude: ${previewPath()}`, { exitCode: ExitCode.USAGE });
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', 'A origem da sessão do Claude mudou durante a abertura.', { exitCode: ExitCode.POLICY });
    }
    if (opened.size > MAX_TRANSCRIPT_BYTES) throw usage('TRANSCRIPT_TOO_LARGE', `O arquivo da sessão do Claude excede ${MAX_TRANSCRIPT_BYTES} bytes: ${previewPath()}`);
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = await new Promise((resolve, reject) => {
        fs.read(fd, buffer, 0, buffer.length, null, (error, count) => error ? reject(error) : resolve(count));
      });
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_TRANSCRIPT_BYTES) throw usage('TRANSCRIPT_TOO_LARGE', `O arquivo da sessão do Claude excede ${MAX_TRANSCRIPT_BYTES} bytes: ${previewPath()}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return parseJsonlLines(Buffer.concat(chunks).toString('utf8').split(/\r\n|\n|\r/));
  } finally {
    fs.closeSync(fd);
  }
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
      }
      const texts = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && !LOCAL_COMMAND_RE.test(block.text.trim())) {
          texts.push(truncateText(block.text, maxTextChars));
        } else if (block?.type === 'image') texts.push('[imagem omitida]');
        else if (block?.type === 'document') texts.push('[documento omitido]');
      }
      if (texts.length > 0) pushUser(texts, createdAt);
      else if (results.length === 0) stats.skipped.command += 1;
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
  return `${TITLE_PREFIX}${maskSecretPatterns(base).slice(0, 56)}`;
}

export function transferHeader(claudeSessionId) {
  return `[opc transfer] Conversa importada da sessão ${claudeSessionId ? preview(claudeSessionId) : 'desconhecida'} do Claude Code. Chamadas de ferramenta aparecem resumidas como texto.`;
}

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

export function buildExport(conversion, { model, agent = 'build', directory, nextId = createIdGenerator() }) {
  if (conversion.turns.length === 0) {
    throw usage('EMPTY_TRANSCRIPT', 'A transcrição do Claude não contém texto do usuário nem do assistente para transferir.');
  }
  const sessionID = nextId('ses', 'descending');
  const first = conversion.turns[0];
  const turns = first.role === 'user' ? conversion.turns : [{ role: 'user', createdAt: first.createdAt, texts: [] }, ...conversion.turns];
  const modelRef = { id: model.modelID, providerID: model.providerID, variant: 'default' };
  const messages = [{ id: nextId('msg', 'ascending'), type: 'synthetic', time: { created: first.createdAt }, text: transferHeader(conversion.claudeSessionId) }];
  let updated = turns[0].createdAt;
  for (const turn of turns) {
    updated = Math.max(updated, turn.completedAt ?? turn.createdAt);
    const id = nextId('msg', 'ascending');
    if (turn.role === 'user') {
      messages.push({ id, type: 'user', time: { created: turn.createdAt }, text: turn.texts.join('\n\n') });
    } else {
      messages.push({ id, type: 'assistant', time: { created: turn.createdAt, completed: turn.completedAt ?? turn.createdAt },
        agent, model: modelRef, content: turn.texts.map((text) => ({ type: 'text', text })), finish: 'stop',
        cost: 0, tokens: structuredClone(ZERO_TOKENS) });
    }
  }
  return {
    info: {
      id: sessionID, projectID: 'global', agent, model: modelRef, cost: 0, tokens: structuredClone(ZERO_TOKENS),
      time: { created: turns[0].createdAt, updated }, title: buildTitle(conversion),
      permissions: [{ action: '*', resource: '*', effect: 'deny' }], location: { directory },
    },
    messages,
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateExportShape(data) {
  const errors = [];
  if (!isObject(data?.info) || !Array.isArray(data?.messages)) return ['$: esperado { info: objeto, messages: lista }'];
  const info = data.info;
  for (const key of EXPORT_SHAPE.session) if (info[key] === undefined) errors.push(`info.${key}: obrigatório`);
  if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(info.id ?? '')) errors.push('info.id: inválido');
  if (!isObject(info.model) || typeof info.model.id !== 'string' || typeof info.model.providerID !== 'string' || info.model.variant !== 'default') errors.push('info.model: inválido');
  if (!Array.isArray(info.permissions) || info.permissions.length === 0) errors.push('info.permissions: obrigatório');
  if (typeof info.location?.directory !== 'string') errors.push('info.location.directory: obrigatório');
  const seen = new Set();
  data.messages.forEach((message, index) => {
    const where = `messages[${index}]`;
    if (!isObject(message) || !EXPORT_SHAPE[message.type]) { errors.push(`${where}: tipo inválido`); return; }
    for (const key of EXPORT_SHAPE[message.type]) if (message[key] === undefined) errors.push(`${where}.${key}: obrigatório`);
    if (!/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(message.id ?? '')) errors.push(`${where}.id: inválido`);
    if (seen.has(message.id)) errors.push(`${where}.id: duplicado`);
    seen.add(message.id);
    if (message.type === 'assistant' && (!Array.isArray(message.content) || message.content.some((part) => part?.type !== 'text' || typeof part.text !== 'string'))) errors.push(`${where}.content: inválido`);
    if (message.type === 'assistant' && message.model?.variant !== 'default') errors.push(`${where}.model: inválido`);
  });
  return errors;
}

export function resolveTransferModel({ flag = null, config }) {
  const raw = flag ?? config.defaultModel ?? null;
  if (!raw) {
    throw usage('NO_MODEL', 'Nenhum modelo para registrar na sessão transferida. Use --model <valor> ou configure defaultModel com /opc:setup.');
  }
  const full = expandAlias(String(raw), config.aliases ?? {});
  if (!full.includes('/') || full.startsWith('/') || full.endsWith('/')) throw usage('MODEL_NEEDS_FULL_ID', `A transferência exige um ID de modelo completo (provider/model) ou alias: ${preview(raw)}`);
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
  if (r.error || r.code !== 0) throw new OpcError('UNSUPPORTED_VERSION', 'Não foi possível identificar a versão do OpenCode.', { exitCode: ExitCode.CONNECTION });
  const match = /(\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!match) throw new OpcError('UNSUPPORTED_VERSION', 'Não foi possível identificar a versão do OpenCode.', { exitCode: ExitCode.CONNECTION });
  if (compareVersions(match[1], MIN_OPENCODE_VERSION) < 0) {
    throw new OpcError('UNSUPPORTED_VERSION', `OpenCode ${match[1]} é anterior ao mínimo suportado ${MIN_OPENCODE_VERSION}. Instale o OpenCode V2 ou aponte server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário V2.`, { exitCode: ExitCode.CONNECTION });
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

export async function runImport({ opencodeBin = 'opencode', serverUrl, password, file, cwd, env = process.env, timeoutMs = 120000, execFileImpl = execFile }) {
  if (typeof serverUrl !== 'string' || !serverUrl) {
    throw new OpcError('SERVER_URL_REQUIRED', 'A importação requer a URL do servidor gerenciado.', { exitCode: ExitCode.CONNECTION });
  }
  if (typeof password !== 'string' || !password) {
    throw new OpcError('SERVER_PASSWORD_REQUIRED', 'A importação requer a senha do servidor gerenciado.', { exitCode: ExitCode.CONNECTION });
  }
  const childEnv = { ...env, OPENCODE_SERVER_PASSWORD: password };
  const r = await execFileResult(execFileImpl, opencodeBin, ['session', 'import', '--server', serverUrl, '--directory', cwd, file], { cwd, env: childEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const missing = notFound(r.error);
  if (missing) throw missing;
  const sessionID = parseImportOutput(r.stdout);
  if (r.error || r.code !== 0 || !sessionID) {
    throw new OpcError('IMPORT_FAILED', `A importação pelo opencode falhou (saída ${r.code}).`, { exitCode: ExitCode.JOB_FAILED });
  }
  return { sessionID, exitCode: r.code };
}
