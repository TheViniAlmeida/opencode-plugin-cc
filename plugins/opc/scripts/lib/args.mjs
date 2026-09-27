// Argument handling: shell-like splitting WITHOUT expansion, --args-stdin, flag parsing.
import { UsageError } from './opc-error.mjs';

const WHITESPACE = /\s/;
const WORD_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_AFTER = /^[\p{L}\p{N}]/u;

function preview(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

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
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError('USAGE', 'Faltou o valor de --cwd.');
      cwd = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      if (!cwd) throw new UsageError('USAGE', 'Faltou o valor de --cwd.');
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
      if (raw === '' || !Number.isFinite(n)) throw new UsageError('USAGE', `--${name} exige um número (recebido: ${preview(raw)}).`);
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
  const isDeclaredFlagToken = (value) => {
    if (value.startsWith('--') && value.length > 2) {
      const raw = value.slice(2).split('=', 1)[0];
      return Object.hasOwn(defs, raw);
    }
    if (value.startsWith('-') && value.length === 2) return aliases.has(value.slice(1));
    return false;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const isLong = token.startsWith('--') && token.length > 2;
    const isShort = !isLong && token.startsWith('-') && token !== '-' && !/^-\d+(?:\.\d+)?$/.test(token);
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
    const name = Object.hasOwn(defs, rawName) ? rawName : aliases.get(rawName);
    if (!name) throw new UsageError('USAGE', `Flag desconhecida: ${preview(token)}`);
    const def = defs[name];
    if (def.type === 'boolean') {
      if (inline === '') throw new UsageError('USAGE', `Faltou o valor de ${preview(token)}.`);
      if (inline !== undefined) flags[name] = !['false', '0', 'no'].includes(inline.toLowerCase());
      else flags[name] = true;
      continue;
    }
    let raw = inline;
    if (raw === '') throw new UsageError('USAGE', `Faltou o valor de ${preview(token)}.`);
    if (raw === undefined) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--') || isDeclaredFlagToken(argv[i + 1])) {
        throw new UsageError('USAGE', `Faltou o valor de ${preview(token)}.`);
      }
      raw = argv[i + 1];
      i += 1;
    }
    const value = coerce(name, def, raw);
    flags[name] = def.type === 'list' ? [...(flags[name] ?? []), ...value] : value;
  }
  if (positionals.length > 0 && !spec?.allowPositionals) {
    throw new UsageError('USAGE', `Argumento inesperado: ${preview(positionals[0])}`);
  }
  return { flags, positionals };
}

// ---- F2a: prompt-preserving argument parsing for free-text commands ----

const isSpaceChar = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

// Splits a raw argument string into known flags and a verbatim prompt. Unlike splitArgString it
// never interprets quotes or apostrophes in the prompt text ("don't" stays intact). Known flags
// are recognized only as whole words; everything after a standalone `--` is prompt.
// flagSpec: { [name]: { type: 'boolean'|'string'|'number'|'optional-string', alias?, match? } }
export function parsePromptArgs(raw, flagSpec) {
  const source = String(raw ?? '');
  const text = source.endsWith('\r\n') ? source.slice(0, -2) : source.endsWith('\n') ? source.slice(0, -1) : source;
  const known = new Map();
  for (const [name, def] of Object.entries(flagSpec)) {
    known.set(`--${name}`, def);
    if (def.alias) known.set(`-${def.alias}`, def);
  }
  const argv = [];
  const kept = [];
  let afterFlag = false;
  const dropTrailingSpace = () => {
    if (kept.length && /^\s+$/.test(kept.at(-1))) kept.pop();
  };
  let i = 0;
  while (i < text.length) {
    if (isSpaceChar(text[i])) {
      let j = i;
      while (j < text.length && isSpaceChar(text[j])) j += 1;
      if (afterFlag) {
        if (kept.join('').length > 0) kept.push(' ');
        afterFlag = false;
      } else kept.push(text.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < text.length && !isSpaceChar(text[j])) j += 1;
    const word = text.slice(i, j);
    const isPromptLine = text.slice(Math.max(0, i - 1), i).includes('\n') || text.slice(j, Math.min(text.length, j + 1)).includes('\n');
    if (word === '--' && (!kept.join('').trim() || !isPromptLine)) {
      let k = j;
      while (k < text.length && isSpaceChar(text[k])) k += 1;
      dropTrailingSpace();
      if (kept.length) kept.push(' ');
      kept.push(text.slice(k));
      break;
    }
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const head = eq > 0 ? word.slice(0, eq) : word;
    const def = known.get(head);
    if (!def) {
      kept.push(word);
      i = j;
      continue;
    }
    dropTrailingSpace();
    if (eq > 0) {
      if (def.type === 'optional-string') {
        const inlineValue = word.slice(eq + 1);
        if (!inlineValue || !(def.match instanceof RegExp) || !def.match.test(inlineValue)) {
          argv.push(head);
          kept.push(inlineValue);
          afterFlag = false;
          i = j;
          continue;
        }
      }
      argv.push(head, word.slice(eq + 1));
      afterFlag = true;
      i = j;
      continue;
    }
    if (def.type === 'boolean') {
      argv.push(head);
      afterFlag = true;
      i = j;
      continue;
    }
    let k = j;
    while (k < text.length && isSpaceChar(text[k])) k += 1;
    if (def.type !== 'optional-string' && k < text.length) {
      let nextEnd = k;
      while (nextEnd < text.length && !isSpaceChar(text[nextEnd])) nextEnd += 1;
      const nextWord = text.slice(k, nextEnd);
      const nextHead = nextWord.startsWith('--') && nextWord.includes('=') ? nextWord.slice(0, nextWord.indexOf('=')) : nextWord;
      if (known.has(nextHead)) throw new UsageError('USAGE', `A flag ${head} exige um valor.`);
    }
    let value;
    let end = k;
    const quote = text[k];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, k + 1);
      if (close > k) {
        value = text.slice(k + 1, close);
        end = close + 1;
      }
    }
    if (value === undefined) {
      while (end < text.length && !isSpaceChar(text[end])) end += 1;
      value = text.slice(k, end);
    }
    if (def.type === 'optional-string') {
      if (value && def.match instanceof RegExp && def.match.test(value)) {
        argv.push(head, value);
        afterFlag = true;
        i = end;
      } else {
        argv.push(head);
        afterFlag = true;
        i = j;
      }
      continue;
    }
    if (!value) throw new UsageError('USAGE', `A flag ${head} exige um valor.`);
    argv.push(head, value);
    afterFlag = true;
    i = end;
  }
  return { argv, prompt: kept.join('') };
}

export const RAW_ARGS_FLAG = '--raw-args-stdin';

// Commands that take free text: with --raw-args-stdin in argv, reads stdin once, extracts the known
// flags with parsePromptArgs and returns the verbatim text (the flag itself stays in argv, so the
// command's parseArgs spec must declare 'raw-args-stdin': { type: 'boolean' }). Otherwise text is null.
export async function readRawArgs(argv, flagSpec, { stdin = process.stdin } = {}) {
  if (!argv.includes(RAW_ARGS_FLAG)) return { argv: [...argv], text: null };
  const { argv: flagArgv, prompt } = parsePromptArgs(await readStdin(stdin), flagSpec);
  return { argv: [...argv, ...flagArgv], text: prompt };
}
