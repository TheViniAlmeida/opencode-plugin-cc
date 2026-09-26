// Argument handling: shell-like splitting WITHOUT expansion, --args-stdin, flag parsing.
import { UsageError } from './opc-error.mjs';

const WHITESPACE = /\s/;
const WORD_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_AFTER = /^[\p{L}\p{N}]/u;

// An apostrophe between two letters/digits (don't, rock'n'roll) is prose, never a quote.
// slice() over two code units keeps astral letters (surrogate pairs) intact.
function isIntraWordApostrophe(input, i) {
  return input[i] === "'"
    && WORD_BEFORE.test(input.slice(Math.max(0, i - 2), i))
    && WORD_AFTER.test(input.slice(i + 1, i + 3));
}

function tokenize(input, literalQuotes) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;
  let quoteStart = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
        current += input[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < input.length) {
        if (input[i + 1] !== '\n') {
          current += input[i + 1];
          inToken = true;
        }
        i += 1;
      } else {
        current += ch;
        inToken = true;
      }
      continue;
    }
    if ((ch === "'" || ch === '"') && !literalQuotes.has(i) && !isIntraWordApostrophe(input, i)) {
      quote = ch;
      quoteStart = i;
      inToken = true;
      continue;
    }
    if (WHITESPACE.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return { unterminatedAt: quoteStart };
  if (inToken) tokens.push(current);
  return { tokens };
}

export function splitArgString(input) {
  const text = String(input ?? '');
  const literalQuotes = new Set();
  for (;;) {
    const result = tokenize(text, literalQuotes);
    if (result.tokens) return result.tokens;
    literalQuotes.add(result.unterminatedAt);
  }
}

export async function readStdin(stream = process.stdin) {
  if (!stream || stream.isTTY) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function resolveArgv(argv, { stdin = process.stdin } = {}) {
  const index = argv.indexOf('--args-stdin');
  if (index === -1) return [...argv];
  const rest = argv.filter((token, i) => i !== index);
  const content = await readStdin(stdin);
  return [...rest, ...splitArgString(content)];
}

export function extractCwd(argv) {
  const out = [];
  let cwd = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (token === '--cwd') {
      if (i + 1 >= argv.length) throw new UsageError('USAGE', 'Faltou o valor de --cwd.');
      cwd = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }
    out.push(token);
  }
  return { cwd, argv: out };
}

function coerce(name, def, raw) {
  switch (def.type) {
    case 'number': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new UsageError('USAGE', `--${name} exige um número (recebido: ${raw}).`);
      return n;
    }
    case 'list':
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return String(raw);
  }
}

export function parseArgs(argv, spec) {
  const defs = spec?.flags ?? {};
  const aliases = new Map();
  for (const [name, def] of Object.entries(defs)) if (def.alias) aliases.set(def.alias, name);
  const flags = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.default !== undefined) flags[name] = Array.isArray(def.default) ? [...def.default] : def.default;
    else if (def.type === 'boolean') flags[name] = false;
    else if (def.type === 'list') flags[name] = [];
  }
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const isLong = token.startsWith('--') && token.length > 2;
    const isShort = !isLong && token.startsWith('-') && token.length === 2 && token !== '--';
    if (!isLong && !isShort) {
      positionals.push(token);
      continue;
    }
    let rawName;
    let inline;
    if (isLong) {
      const eq = token.indexOf('=');
      rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      rawName = token.slice(1);
    }
    const name = defs[rawName] ? rawName : aliases.get(rawName);
    if (!name) throw new UsageError('USAGE', `Flag desconhecida: ${token}`);
    const def = defs[name];
    if (def.type === 'boolean') {
      if (inline !== undefined) flags[name] = !['false', '0', 'no'].includes(inline.toLowerCase());
      else flags[name] = true;
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      if (i + 1 >= argv.length) throw new UsageError('USAGE', `Faltou o valor de ${token}.`);
      raw = argv[i + 1];
      i += 1;
    }
    const value = coerce(name, def, raw);
    flags[name] = def.type === 'list' ? [...(flags[name] ?? []), ...value] : value;
  }
  if (positionals.length > 0 && !spec?.allowPositionals) {
    throw new UsageError('USAGE', `Argumento inesperado: ${positionals[0]}`);
  }
  return { flags, positionals };
}
