// Independent OpenCode 2.0.22 session import oracle.
import fs from 'node:fs';
import path from 'node:path';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SESSION_KEYS = ['id', 'projectID', 'agent', 'model', 'cost', 'tokens', 'time', 'title', 'permissions', 'location'];
const MESSAGE_KEYS = { user: ['id', 'type', 'time', 'text'], assistant: ['id', 'type', 'time', 'agent', 'model', 'content', 'cost', 'tokens'], idle: ['id', 'type', 'time', 'outcome'], synthetic: ['id', 'type', 'time', 'text'] };
const ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export function checkImportShape(data) {
  if (!object(data?.info) || !Array.isArray(data?.messages)) return ['Esperado { info, messages[] }'];
  const errors = [];
  for (const key of SESSION_KEYS) if (data.info[key] === undefined) errors.push(`info.${key} ausente`);
  if (!ID.test(data.info.id)) errors.push('info.id inválido');
  if (!Number.isFinite(data.info.cost)) errors.push('info.cost inválido');
  if (!object(data.info.model) || typeof data.info.model.id !== 'string' || typeof data.info.model.providerID !== 'string' || data.info.model.variant !== 'default') errors.push('info.model inválido');
  if (!Array.isArray(data.info.permissions)) errors.push('info.permissions inválidas');
  if (typeof data.info.location?.directory !== 'string') errors.push('info.location inválido');
  if (!Number.isFinite(data.info.time?.created) || !Number.isFinite(data.info.time?.updated)) errors.push('info.time inválido');
  for (const key of ['input', 'output', 'reasoning']) if (!Number.isFinite(data.info.tokens?.[key])) errors.push(`info.tokens.${key} inválido`);
  for (const key of ['read', 'write']) if (!Number.isFinite(data.info.tokens?.cache?.[key])) errors.push(`info.tokens.cache.${key} inválido`);
  const seen = new Set();
  data.messages.forEach((item, index) => {
    const at = `messages[${index}]`;
    if (!object(item) || !MESSAGE_KEYS[item.type]) { errors.push(`${at} inválida`); return; }
    for (const key of MESSAGE_KEYS[item.type]) if (item[key] === undefined) errors.push(`${at}.${key} ausente`);
    if (!/^msg_/.test(item.id)) errors.push(`${at}.id inválido`);
    if (seen.has(item.id)) errors.push(`${at}.id duplicado`);
    seen.add(item.id);
    if (!Number.isFinite(item.time?.created)) errors.push(`${at}.time inválido`);
    if (item.type === 'assistant') {
      if (!Array.isArray(item.content)) errors.push(`${at}.content inválido`);
      else if (item.content.some((part) => !object(part) || !['text', 'reasoning', 'tool'].includes(part.type))) errors.push(`${at}.content inválido`);
      if (!Number.isFinite(item.cost) || !object(item.tokens) || item.model?.variant !== 'default' || item.finish !== 'stop') errors.push(`${at}.usage inválido`);
    }
  });
  return errors;
}

function recordImport(entry) {
  const stateFile = process.env.FAKE_OPENCODE_STATE;
  if (!stateFile) return;
  let state = { requests: [], sessions: {}, messages: {}, permissions: {}, forms: {}, signals: [], sseConnections: 0, bootAttempts: 0, boots: [] };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state.imports = [...(state.imports ?? []), entry];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export async function runFakeImport(args) {
  if (args[0] !== '--server' || !args[1]) { process.stderr.write('Servidor gerenciado obrigatório\n'); return 1; }
  args = args.slice(2);
  let directory = null;
  if (args[0] === '--directory') { directory = args[1]; args = args.slice(2); }
  const file = args[0];
  if (!file || args.length !== 1) { process.stderr.write('Informe um arquivo de exportação\n'); return 1; }
  let stat;
  try { stat = fs.statSync(file); } catch { process.stderr.write('Arquivo de exportação não encontrado\n'); return 1; }
  const entry = { file, cwd: process.cwd(), directory, mode: (stat.mode & 0o777).toString(8),
    dirMode: (fs.statSync(path.dirname(file)).mode & 0o777).toString(8), errors: [], sessionID: null,
    messageCount: 0, partCount: 0, texts: [] };
  const mode = process.env.FAKE_OPENCODE_IMPORT ?? 'ok';
  if (mode === 'fail' || mode === 'crash') {
    recordImport(entry);
    process.stdout.write('Falha ao ler dados da sessão\n');
    process.stderr.write('Falha simulada na importação\n');
    return mode === 'fail' ? 0 : 1;
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    entry.errors.push('JSON inválido'); recordImport(entry); process.stderr.write('JSON de exportação inválido\n'); return 1;
  }
  entry.errors = checkImportShape(data);
  entry.sessionID = data?.info?.id ?? null;
  entry.title = data?.info?.title ?? null;
  entry.messageCount = data?.messages?.length ?? 0;
  entry.partCount = (data?.messages ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0);
  entry.texts = (data?.messages ?? []).flatMap((m) => [...(m.type === 'user' || m.type === 'synthetic' ? [m.text] : []), ...(m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text)]);
  recordImport(entry);
  if (entry.errors.length) { process.stderr.write('Formato de exportação inválido\n'); return 1; }
  const reportedID = mode === 'mismatch' ? 'ses_0000000000000123456789ABCD' : data.info.id;
  process.stdout.write(`Imported session: ${reportedID}\n`);
  return mode === 'success-nonzero' ? 1 : 0;
}
