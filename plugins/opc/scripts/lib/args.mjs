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

// Parse only the leading and trailing runs of known flags; preserve the intervening prompt bytes.
// flagSpec: { [name]: { type: 'boolean'|'string'|'number'|'optional-string', alias?, match? } }
export function parsePromptArgs(raw, flagSpec) {
  const source = String(raw ?? '');
  const text = source.endsWith('\r\n') ? source.slice(0, -2) : source.endsWith('\n') ? source.slice(0, -1) : source;
  const tokens = [];
  for (let i = 0; i < text.length;) {
    while (i < text.length && /\s/u.test(text[i])) i += 1;
    if (i >= text.length) break;
    const start = i;
    while (i < text.length && !/\s/u.test(text[i])) {
      const quote = (i === start || text[i - 1] === '=') && (text[i] === '"' || text[i] === "'") ? text[i] : null;
      if (quote) {
        const close = text.indexOf(quote, i + 1);
        if (close > i) {
          i = close + 1;
          continue;
        }
      }
      i += 1;
    }
    tokens.push({ raw: text.slice(start, i), start, end: i });
  }
  const known = new Map();
  for (const [name, def] of Object.entries(flagSpec)) {
    known.set(`--${name}`, def);
    if (def.alias) known.set(`-${def.alias}`, def);
  }
  const argv = [];
  let promptStartOverride = null;
  const parseHead = (token) => {
    const eq = token.indexOf('=');
    const head = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
    const def = known.get(head);
    return def ? { head, def, inline: eq > 0 ? decodeValue(token.slice(eq + 1)) : undefined } : null;
  };
  const decodeValue = (value) => {
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      return value.slice(1, -1);
    }
    return value;
  }
  const isFlag = (token) => token === '--' || Boolean(parseHead(token));
  let left = 0;
  let stoppedByTerminator = false;
  while (left < tokens.length) {
    const token = tokens[left].raw;
    if (token === '--') {
      left += 1;
      stoppedByTerminator = true;
      break;
    }
    const flag = parseHead(token);
    if (!flag) break;
    if (flag.inline !== undefined) {
      if (flag.def.type === 'optional-string' && (!flag.inline || !(flag.def.match instanceof RegExp) || !flag.def.match.test(flag.inline))) {
        argv.push(flag.head);
        promptStartOverride = tokens[left].start + flag.head.length + 1;
      } else {
        if (flag.def.type !== 'boolean' && !flag.inline) throw new UsageError('USAGE', `A flag ${flag.head} exige um valor.`);
        argv.push(flag.head, flag.inline);
      }
      left += 1;
      continue;
    }
    argv.push(flag.head);
    if (flag.def.type === 'boolean') {
      left += 1;
      continue;
    }
    const next = tokens[left + 1]?.raw;
    if (next !== undefined && isFlag(next)) throw new UsageError('USAGE', `A flag ${flag.head} exige um valor.`);
    if (flag.def.type === 'optional-string') {
      const value = next === undefined ? '' : decodeValue(next);
      if (value && flag.def.match instanceof RegExp && flag.def.match.test(value)) {
        argv.push(value);
        left += 2;
      } else left += 1;
      continue;
    }
    if (next === undefined) throw new UsageError('USAGE', `A flag ${flag.head} exige um valor.`);
    argv.push(decodeValue(next));
    left += 2;
  }

  let right = tokens.length;
  const suffixGroups = [];
  if (!stoppedByTerminator) {
    while (right > left) {
      const last = tokens[right - 1].raw;
      const inlineFlag = parseHead(last);
      if (inlineFlag) {
        if (inlineFlag.def.type === 'optional-string' && (!inlineFlag.inline || !(inlineFlag.def.match instanceof RegExp) || !inlineFlag.def.match.test(inlineFlag.inline))) break;
        if (inlineFlag.def.type !== 'boolean' && inlineFlag.inline === '') throw new UsageError('USAGE', `A flag ${inlineFlag.head} exige um valor.`);
        if (inlineFlag.inline === undefined && inlineFlag.def.type !== 'boolean' && inlineFlag.def.type !== 'optional-string') {
          throw new UsageError('USAGE', `A flag ${inlineFlag.head} exige um valor.`);
        }
        suffixGroups.push(inlineFlag.inline === undefined ? [inlineFlag.head] : [inlineFlag.head, inlineFlag.inline]);
        right -= 1;
        continue;
      }
      if (right - 1 === left) break;
      const before = parseHead(tokens[right - 2].raw);
      if (!before || before.inline !== undefined || before.def.type === 'boolean') break;
      const value = decodeValue(last);
      if (before.def.type === 'optional-string' && (!value || !(before.def.match instanceof RegExp) || !before.def.match.test(value))) break;
      suffixGroups.push([before.head, value]);
      right -= 2;
    }
  }
  // Suffix groups were discovered backwards; restore their original order.
  for (const group of suffixGroups.reverse()) argv.push(...group);

  if (left > right) right = left;
  let promptStart = promptStartOverride;
  if (promptStart === null) {
    promptStart = left === 0 ? 0 : (tokens[left - 1]?.end ?? text.length);
    if (left > 0) while (promptStart < text.length && /\s/u.test(text[promptStart])) promptStart += 1;
  }
  let promptEnd = text.length;
  if (right < tokens.length) {
    promptEnd = right > left ? tokens[right - 1].end : promptStart;
  }
  const prompt = text.slice(promptStart, Math.max(promptStart, promptEnd));
  return { argv, prompt };
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
