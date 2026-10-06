// Independent import oracle: OpenCode 1.18.32 Session/Message/TextPart contract.
// This module deliberately does not import the plugin's converter or validator.
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = {
  session: ['id', 'slug', 'projectID', 'directory', 'title', 'version', 'time'],
  user: ['id', 'sessionID', 'role', 'time', 'agent', 'model'],
  assistant: ['id', 'sessionID', 'role', 'time', 'parentID', 'modelID', 'providerID', 'mode', 'agent', 'path', 'cost', 'tokens'],
  text: ['id', 'sessionID', 'messageID', 'type', 'text'],
};
const ID = { ses: /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, msg: /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/, prt: /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/ };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function checkImportShape(data) {
  if (!object(data?.info) || !Array.isArray(data?.messages)) return ['expected { info, messages[] }'];
  const errors = [];
  const required = (value, keys, where) => {
    for (const key of keys) if (value[key] === undefined) errors.push(`${where}.${key} missing`);
  };
  required(data.info, REQUIRED.session, 'info');
  if (!ID.ses.test(data.info.id)) errors.push('info.id invalid');
  if (!Number.isFinite(data.info.time?.created) || !Number.isFinite(data.info.time?.updated)) errors.push('info.time invalid');
  const ids = new Set([data.info.id]);
  const users = new Set();
  const unique = (id, where) => {
    if (ids.has(id)) errors.push(`${where} duplicated`);
    ids.add(id);
  };
  data.messages.forEach((message, i) => {
    const where = `messages[${i}]`;
    const m = message?.info;
    if (!object(m) || !Array.isArray(message.parts) || !['user', 'assistant'].includes(m.role)) {
      errors.push(`${where} invalid`);
      return;
    }
    required(m, REQUIRED[m.role], `${where}.info`);
    if (!ID.msg.test(m.id)) errors.push(`${where}.info.id invalid`);
    unique(m.id, `${where}.info.id`);
    if (m.sessionID !== data.info.id) errors.push(`${where}.info.sessionID mismatch`);
    if (!Number.isFinite(m.time?.created)) errors.push(`${where}.info.time invalid`);
    if (m.role === 'user') {
      users.add(m.id);
      if (typeof m.model?.providerID !== 'string' || typeof m.model?.modelID !== 'string') errors.push(`${where}.info.model invalid`);
    } else {
      if (!users.has(m.parentID)) errors.push(`${where}.info.parentID invalid`);
      if (m.path?.cwd !== data.info.directory || m.path?.root !== data.info.directory) errors.push(`${where}.info.path mismatch`);
      for (const key of ['input', 'output', 'reasoning']) if (!Number.isFinite(m.tokens?.[key])) errors.push(`${where}.info.tokens.${key} invalid`);
      for (const key of ['read', 'write']) if (!Number.isFinite(m.tokens?.cache?.[key])) errors.push(`${where}.info.tokens.cache.${key} invalid`);
    }
    message.parts.forEach((part, j) => {
      const wherePart = `${where}.parts[${j}]`;
      if (!object(part)) { errors.push(`${wherePart} invalid`); return; }
      required(part, REQUIRED.text, wherePart);
      if (!ID.prt.test(part.id)) errors.push(`${wherePart}.id invalid`);
      unique(part.id, `${wherePart}.id`);
      if (part.messageID !== m.id || part.sessionID !== data.info.id) errors.push(`${wherePart} reference mismatch`);
      if (part.type !== 'text' || typeof part.text !== 'string') errors.push(`${wherePart} must be text`);
    });
  });
  return errors;
}

function recordImport(entry) {
  const stateFile = process.env.FAKE_OPENCODE_STATE;
  if (!stateFile) return;
  let state = { requests: [], sessions: {}, messages: {}, permissions: {}, questions: {}, signals: [], sseConnections: 0, bootAttempts: 0, boots: [] };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state.imports = [...(state.imports ?? []), entry];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export async function runFakeImport(args) {
  const file = args[0];
  if (!file || args.length !== 1) { process.stderr.write('Expected one export file\n'); return 1; }
  let stat;
  try { stat = fs.statSync(file); } catch { process.stderr.write('Export file not found\n'); return 1; }
  const entry = {
    file, cwd: process.cwd(), mode: (stat.mode & 0o777).toString(8),
    dirMode: (fs.statSync(path.dirname(file)).mode & 0o777).toString(8),
    errors: [], sessionID: null, messageCount: 0, partCount: 0, texts: [],
  };
  const mode = process.env.FAKE_OPENCODE_IMPORT ?? 'ok';
  if (mode === 'fail' || mode === 'crash') {
    recordImport(entry);
    process.stdout.write('Failed to read session data\n');
    process.stderr.write('RAW_TRANSCRIPT_SENTINEL password=fixture-sensitive-value /home/private-person/session.jsonl\n');
    return mode === 'fail' ? 0 : 1;
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    entry.errors.push('Invalid JSON'); recordImport(entry); process.stderr.write('Invalid export JSON\n'); return 1;
  }
  entry.errors = checkImportShape(data);
  entry.sessionID = data?.info?.id ?? null;
  entry.title = data?.info?.title ?? null;
  entry.messageCount = data?.messages?.length ?? 0;
  entry.partCount = (data?.messages ?? []).reduce((n, m) => n + (m.parts?.length ?? 0), 0);
  entry.texts = (data?.messages ?? []).flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text));
  recordImport(entry);
  if (entry.errors.length) { process.stderr.write('Session export decode failed\n'); return 1; }
  const reportedID = mode === 'mismatch' ? 'ses_0000000000000123456789ABCD' : data.info.id;
  process.stdout.write(`Imported session: ${reportedID}\n`);
  return mode === 'success-nonzero' ? 1 : 0;
}
