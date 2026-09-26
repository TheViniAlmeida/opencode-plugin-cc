#!/usr/bin/env node
// Scans files for secrets (registered server passwords + common token patterns). Exit 1 when something is found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATTERNS = Object.freeze([
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'basic-auth-header', re: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g },
  { kind: 'server-password-env', re: /OPENCODE_SERVER_PASSWORD=(?!\*\*\*)[^\s'"]{8,}/g }, // scan-secrets:allow
  { kind: 'json-password', re: /"password"\s*:\s*"(?!\*\*\*|YOUR_|<|\$\{)[^"]{6,}"/g },
]);

// Lines carrying this marker are exempt from the PATTERNS (test fixtures, this file); registered secrets are always reported.
export const ALLOW_MARKER = 'scan-secrets:allow';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function mask(value) {
  const s = String(value);
  return `${s.slice(0, 4)}…(${s.length} chars)`;
}

export function scanText(text, { secrets = [] } = {}) {
  const findings = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    for (const secret of secrets) {
      if (secret && secret.length >= 8 && line.includes(secret)) findings.push({ line: i + 1, kind: 'registered-secret', sample: mask(secret) });
    }
    if (line.includes(ALLOW_MARKER)) return;
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) findings.push({ line: i + 1, kind, sample: mask(m[0]) });
    }
  });
  return findings;
}

function listFiles(target, out, { explicit = false, onMissing = () => {} } = {}) {
  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if (err.code === 'ENOENT' && explicit) {
      onMissing(target);
      return out;
    }
    throw new Error(`não foi possível acessar ${target}: ${err.message}`, { cause: err });
  }
  if (st.isDirectory()) {
    let names;
    try {
      names = fs.readdirSync(target);
    } catch (err) {
      throw new Error(`não foi possível ler ${target}: ${err.message}`, { cause: err });
    }
    for (const name of names) if (!SKIP_DIRS.has(name)) listFiles(path.join(target, name), out, { onMissing });
  } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
    out.push(target);
  }
  return out;
}

export function scanPaths(paths, { secrets = [], onMissing = () => {} } = {}) {
  const findings = [];
  const files = paths.flatMap((p) => listFiles(p, [], { explicit: true, onMissing }));
  for (const file of files) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      throw new Error(`não foi possível ler ${file}: ${err.message}`, { cause: err });
    }
    if (buf.includes(0)) continue;
    for (const f of scanText(buf.toString('utf8'), { secrets })) findings.push({ file, ...f });
  }
  return findings;
}

export function secretsFromServerJson(files) {
  const out = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new Error(`não foi possível ler ${file}${err.code ? ` (${err.code})` : ''}`, { cause: err });
    }
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error(`JSON inválido em ${file}`);
    }
    const pw = data?.password;
    if (typeof pw === 'string' && pw.length >= 8) out.push(pw);
  }
  return out;
}

export function serverJsonFilesUnder(dataDir) {
  const stateRoot = path.join(dataDir, 'state');
  try {
    return fs.readdirSync(stateRoot).map((d) => path.join(stateRoot, d, 'server.json')).filter((f) => fs.existsSync(f));
  } catch {
    return [];
  }
}

function main(argv) {
  const targets = [];
  const serverJsons = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--server-json') {
      if (!argv[i + 1]) {
        process.stderr.write('usage: scan-secrets.mjs <path...> [--server-json <file>]\n');
        return 2;
      }
      serverJsons.push(argv[i + 1]);
      i += 1;
    } else {
      targets.push(argv[i]);
    }
  }
  if (targets.length === 0) {
    process.stderr.write('usage: scan-secrets.mjs <path...> [--server-json <file>]\n');
    return 2;
  }
  if (process.env.OPC_DATA_DIR) serverJsons.push(...serverJsonFilesUnder(process.env.OPC_DATA_DIR));
  let findings;
  try {
    const secrets = secretsFromServerJson(serverJsons);
    findings = scanPaths(targets, {
      secrets,
      onMissing: (missing) => process.stderr.write(`scan-secrets: aviso: caminho inexistente ignorado: ${missing}\n`),
    });
  } catch (err) {
    process.stderr.write(`scan-secrets: erro: ${err.message}\n`);
    return 2;
  }
  for (const f of findings) process.stdout.write(`${f.file}:${f.line}: ${f.kind} ${f.sample}\n`);
  if (findings.length > 0) {
    process.stderr.write(`scan-secrets: ${findings.length} achado(s).\n`);
    return 1;
  }
  process.stderr.write('scan-secrets: nenhum achado.\n');
  return 0;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
