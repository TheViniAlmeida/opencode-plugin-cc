// Allow/deny policy (spec §3.2, §6 items 4-5). Permission profiles and approver arrive in F2a.
import { PolicyError, UsageError } from './opc-error.mjs';
import { matchesAny, parseFullId } from './models.mjs';

const SECTION = { provider: 'providers', model: 'models', agent: 'agents', tool: 'tools' };
const LABEL = { provider: 'provider', model: 'modelo', agent: 'agente', tool: 'ferramenta' };

function lists(policy, kind) {
  const section = policy?.[SECTION[kind]] ?? {};
  return {
    allow: Array.isArray(section.allow) ? section.allow : [],
    allowWorkspace: Array.isArray(section.allowWorkspace) ? section.allowWorkspace : [],
    deny: Array.isArray(section.deny) ? section.deny : [],
  };
}

function firstMatch(value, globs) {
  return globs.find((glob) => matchesAny(value, [glob])) ?? null;
}

export function evaluate(kind, value, policy) {
  if (!SECTION[kind]) throw new TypeError(`tipo de política desconhecido: ${kind}`);
  const name = SECTION[kind];
  if (kind === 'model') {
    const { providerID } = parseFullId(value);
    if (providerID) {
      const viaProvider = evaluate('provider', providerID, policy);
      if (!viaProvider.allowed) return viaProvider;
    }
  }
  const { allow, allowWorkspace, deny } = lists(policy, kind);
  const denied = firstMatch(value, deny);
  if (denied) return { allowed: false, rule: `policy.${name}.deny: ${denied}` };
  if (kind !== 'tool') {
    if (allow.length > 0 && !matchesAny(value, allow)) return { allowed: false, rule: `policy.${name}.allow (global): não consta na lista` };
    if (allowWorkspace.length > 0 && !matchesAny(value, allowWorkspace)) return { allowed: false, rule: `policy.${name}.allow (.opc.json): não consta na lista` };
  }
  return { allowed: true };
}

export function assertAllowed(kind, value, policy) {
  const result = evaluate(kind, value, policy);
  if (!result.allowed) {
    throw new PolicyError('POLICY_DENIED', `${LABEL[kind]} "${value}" negado pela regra ${result.rule}`, { details: { kind, value, rule: result.rule } });
  }
  return result;
}

export function pinnedModelOf(agentInfo) {
  const m = agentInfo?.model;
  return m && m.providerID && m.modelID ? `${m.providerID}/${m.modelID}` : null;
}

// A pinned model is checked against the provider policy first (explicit, even though evaluate('model')
// also inherits it) and then against the model policy.
function evaluatePinnedModel(full, policy, providerID = parseFullId(full).providerID) {
  if (providerID) {
    const byProvider = evaluate('provider', providerID, policy);
    if (!byProvider.allowed) return { allowed: false, rule: `modelo fixado ${full}: ${byProvider.rule}` };
  }
  const byModel = evaluate('model', full, policy);
  if (!byModel.allowed) return { allowed: false, rule: `modelo fixado ${full}: ${byModel.rule}` };
  return { allowed: true };
}

export function evaluateAgent(agentInfo, policy) {
  const byName = evaluate('agent', agentInfo.name, policy);
  if (!byName.allowed) return byName;
  const pinned = pinnedModelOf(agentInfo);
  if (pinned) {
    const byPinned = evaluatePinnedModel(pinned, policy, agentInfo.model.providerID);
    if (!byPinned.allowed) return byPinned;
  }
  return { allowed: true };
}

export function evaluateCommand(commandInfo, policy, agentsByName = new Map()) {
  if (commandInfo.model) {
    const byPinned = evaluatePinnedModel(String(commandInfo.model), policy);
    if (!byPinned.allowed) return byPinned;
  }
  if (commandInfo.agent) {
    const agent = agentsByName.get(commandInfo.agent) ?? { name: commandInfo.agent };
    const byAgent = evaluateAgent(agent, policy);
    if (!byAgent.allowed) return { allowed: false, rule: `agente fixado ${commandInfo.agent}: ${byAgent.rule}` };
  }
  return { allowed: true };
}

export function assertAgentUsable(agentInfo, policy) {
  const result = evaluateAgent(agentInfo, policy);
  if (!result.allowed) {
    throw new PolicyError('POLICY_DENIED', `agente "${agentInfo.name}" negado pela regra ${result.rule}`, { details: { kind: 'agent', value: agentInfo.name, rule: result.rule } });
  }
  return result;
}

export function assertCommandUsable(commandInfo, policy, agentsByName = new Map()) {
  const result = evaluateCommand(commandInfo, policy, agentsByName);
  if (!result.allowed) {
    throw new PolicyError('POLICY_DENIED', `comando "${commandInfo.name}" negado pela regra ${result.rule}`, { details: { kind: 'command', value: commandInfo.name, rule: result.rule } });
  }
  return result;
}

// ---- F2a: permission profiles, invariants, approver (spec §8) ----

export const BUILTIN_DESTRUCTIVE_BASH = Object.freeze([
  'rm *', 'rm -r *', 'rm -fr*', 'git push --force*', 'git push -f*', 'git push --delete*',
  'git reset --hard*', 'git clean -f*', 'git branch -D*', 'git tag -d*', 'docker rm*',
  'docker rmi*', 'docker volume rm*', 'docker system prune*', 'docker compose down -v*',
  'kubectl delete*', 'mkfs*', 'dd *of=*', 'shred*', 'truncate -s 0*', 'find * -delete*',
  'shutdown*', 'reboot*', 'poweroff*', 'systemctl stop*', '*DROP DATABASE*', '*DROP TABLE*',
  '*TRUNCATE*',
]);
export const READ_ONLY_ALLOW = Object.freeze(['read', 'glob', 'skill', 'question']);
export const SENSITIVE_PATH_PERMISSIONS = Object.freeze(['read', 'grep', 'glob']);
export const DEFAULT_SENSITIVE_PATHS = Object.freeze([
  '*.env', '*.env.*', '**/.ssh/**', '*.pem', '*.key', '**/id_rsa*', '**/id_ed25519*', '**/secrets.env',
]);
export const PATCH_PERMISSION_MODE = 'replace';
const RULE_ACTIONS = new Set(['allow', 'deny', 'ask']);
const r = (action, resource, effect) => ({ action, resource, effect });

export function displayValue(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

export function sensitivePathsOf(policy = {}) {
  return Array.isArray(policy.sensitivePaths) ? policy.sensitivePaths : [...DEFAULT_SENSITIVE_PATHS];
}

export function destructiveBashOf(policy = {}) {
  return [...BUILTIN_DESTRUCTIVE_BASH, ...(Array.isArray(policy.destructiveBash) ? policy.destructiveBash : [])];
}

export function parseProfile(profile) {
  if (profile === 'read-only' || profile === 'write') return { kind: profile, name: null };
  if (typeof profile === 'string' && profile.startsWith('custom:') && profile.length > 'custom:'.length) {
    return { kind: 'custom', name: profile.slice('custom:'.length) };
  }
  throw new UsageError('UNKNOWN_PROFILE', `perfil de permissões desconhecido "${displayValue(profile)}" (use read-only, write ou custom:<nome>)`);
}

function customRulesOf(name, permissionProfiles = {}) {
  const rules = permissionProfiles?.[name];
  if (!Array.isArray(rules)) throw new UsageError('UNKNOWN_PROFILE', `permissionProfiles.${displayValue(name)} não está definido na configuração global`);
  return rules.map((r, i) => {
    if (!r || typeof r.action !== 'string' || typeof r.resource !== 'string' || !RULE_ACTIONS.has(r.effect)) {
      throw new UsageError('INVALID_PROFILE', `permissionProfiles.${displayValue(name)}[${i}] deve ser {action, resource, effect: allow|deny|ask}`);
    }
    return { action: r.action, resource: r.resource, effect: r.effect };
  });
}

export function invariantRules(profile, { policy = {}, deniedAgentGlobs = [], bridged = null } = {}) {
  const { kind } = parseProfile(profile);
  const withDestructive = bridged ?? kind === 'write';
  const rules = [r('external_directory', '*', 'deny')];
  if (kind !== 'write') rules.push(r('grep', '*', 'deny'));
  for (const pattern of sensitivePathsOf(policy)) {
    for (const permission of SENSITIVE_PATH_PERMISSIONS) rules.push(r(permission, pattern, 'deny'));
  }
  for (const glob of deniedAgentGlobs) rules.push(r('subagent', glob, 'deny'));
  for (const tool of policy.tools?.deny ?? []) rules.push(r(tool, '*', 'deny'));
  if (withDestructive) for (const pattern of destructiveBashOf(policy)) rules.push(r('shell', pattern, 'ask'));
  rules.push(r('browser', '*', 'deny'));
  return rules;
}

export function buildPermissionRules(profile, { policy = {}, permissionProfiles = {}, deniedAgentGlobs = [] } = {}) {
  const { kind, name } = parseProfile(profile);
  const rules = [];
  let bridged = kind === 'write';
  if (kind !== 'write') {
    rules.push(r('*', '*', 'deny'));
    for (const permission of READ_ONLY_ALLOW) rules.push(r(permission, '*', 'allow'));
  }
  if (kind === 'custom') {
    const custom = customRulesOf(name, permissionProfiles);
    rules.push(...custom);
    bridged = custom.some((entry) => entry.action === 'shell' && entry.effect !== 'deny');
  }
  rules.push(...invariantRules(profile, { policy, deniedAgentGlobs, bridged }));
  return rules;
}

export function bridgeModeOf(profile) {
  return parseProfile(profile).kind === 'read-only' ? 'auto-reject' : 'bridge';
}

export function requiresUser(request, policy = {}) {
  if (!request || typeof request.permission !== 'string') return true;
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : [];
  if (request.permission === 'external_directory') return true;
  if (request.permission === 'shell') {
    const commands = [request.metadata?.command ?? patterns[0]].filter((command) => typeof command === 'string');
    const destructive = destructiveBashOf(policy);
    return commands.length === 0 || commands.some((command) => bashRequiresUser(command, destructive));
  }
  if (SENSITIVE_PATH_PERMISSIONS.includes(request.permission) || request.permission === 'edit') {
    return patterns.some((pattern) => matchesAny(pattern, sensitivePathsOf(policy)));
  }
  return false;
}

function bashSegments(command) {
  function scan(source, depth = 0) {
    if (depth > 32) return null;
    const parts = [];
    let start = 0;
    let quote = null;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote !== "'") {
        if (source[i + 1] === '`') {
          const end = source.indexOf('\\`', i + 2);
          if (end < 0) return null;
          const nested = scan(source.slice(i + 2, end), depth + 1);
          if (nested === null) return null;
          parts.push(...nested);
          i = end + 1;
          continue;
        }
        escaped = true; continue;
      }
      if (quote === "'") { if (char === "'") quote = null; continue; }
      if (quote === '"') {
        if (char === '"') { quote = null; continue; }
        if (char === '`') {
          const end = findBacktick(source, i + 1);
          if (end < 0) return null;
          const nested = scan(source.slice(i + 1, end), depth + 1);
          if (nested === null) return null;
          parts.push(...nested);
          i = end;
        } else if (char === '$' && source[i + 1] === '(') {
          const end = findParen(source, i + 1);
          if (end < 0) return null;
          const nested = scan(source.slice(i + 2, end), depth + 1);
          if (nested === null) return null;
          parts.push(...nested);
          i = end;
        }
        continue;
      }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '`') {
        const end = findBacktick(source, i + 1);
        if (end < 0) return null;
        const nested = scan(source.slice(i + 1, end), depth + 1);
        if (nested === null) return null;
        parts.push(...nested);
        i = end;
        continue;
      }
      if (char === '$' && source[i + 1] === '(') {
        const end = findParen(source, i + 1);
        if (end < 0) return null;
        const nested = scan(source.slice(i + 2, end), depth + 1);
        if (nested === null) return null;
        parts.push(...nested);
        i = end;
        continue;
      }
      if (char === '(' || char === '{') {
        const close = char === '(' ? ')' : '}';
        const end = findGroup(source, i, char, close);
        if (end < 0) return null;
        const nested = scan(source.slice(i + 1, end), depth + 1);
        if (nested === null) return null;
        parts.push(...nested);
        i = end;
        continue;
      }
      if (char === ')' || char === '}') {
        return null;
      }
      if (char === ';' || char === '|' || char === '\n' || char === '\r' || char === '&') {
        const end = char === '&' ? i : i;
        const segment = source.slice(start, end).trim();
        if (segment) parts.push(segment);
        if (char === '&' && source[i + 1] === '&') i += 1;
        start = i + 1;
      }
    }
    if (quote !== null || escaped) return null;
    const segment = source.slice(start).trim();
    if (segment) parts.push(segment);
    return parts;
  }

  function findBacktick(source, from) {
    let escaped = false;
    for (let i = from; i < source.length; i += 1) {
      if (escaped) { escaped = false; continue; }
      if (source[i] === '\\') { escaped = true; continue; }
      if (source[i] === '`') return i;
    }
    return -1;
  }

  function findParen(source, open) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = open; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote === "'") { if (char === "'") quote = null; continue; }
      if (quote === '"') { if (char === '"') quote = null; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '$' && source[i + 1] === '(') { depth += 1; i += 1; continue; }
      if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) return i;
    }
    return -1;
  }

  function findGroup(source, open, opening, closing) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = open; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote === "'") { if (char === "'") quote = null; continue; }
      if (quote === '"') { if (char === '"') quote = null; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === opening) depth += 1;
      else if (char === closing && --depth === 0) return i;
    }
    return -1;
  }

  return scan(String(command));
}

// Conservative shell inspection, never shell execution. Unknown syntax/options require a user.
// bashSegments scans substitutions/groups; words preserves quoting for re-entry via -c/eval.
function shellWords(source) {
  const words = [];
  let value = '', quote = null, active = false, dynamic = false;
  const push = () => {
    if (active) words.push({ value, dynamic });
    value = ''; active = false; dynamic = false;
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\' && quote !== "'") {
      if (++i >= source.length) return null;
      const next = source[i];
      // In double quotes, only these escapes are interpreted by the shell.
      if (quote === '"' && !'$`"\\\n'.includes(next)) value += '\\';
      if (next !== '\n') value += next;
      active = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else {
        value += char;
        if (quote === '"' && (char === '$' || char === '`')) dynamic = true;
      }
    } else if (char === "'" || char === '"') {
      quote = char; active = true;
    } else if (/\s/.test(char)) push();
    else {
      value += char; active = true;
      if ('$`*?[]'.includes(char)) dynamic = true;
    }
  }
  if (quote) return null;
  push();
  return words;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const UNSUPPORTED_SHELL_WORDS = new Set(['.', 'source', 'if', 'then', 'else', 'elif', 'fi', 'for', 'select', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '!', 'coproc']);
const WRAPPER_OPTIONS = {
  exec: { flags: ['-c', '-l'], values: ['-a'] },
  env: { flags: ['-i', '--ignore-environment', '-0', '--null'], values: ['-u', '--unset', '-C', '--chdir'] },
  xargs: { flags: ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose'], values: ['-I', '-n', '-P', '-s', '-L', '-d', '-E', '--replace', '--max-args', '--max-procs', '--delimiter'] },
  sudo: { flags: ['-n', '-E', '-H', '-k', '-S'], values: ['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host'] },
  doas: { flags: ['-n', '-L'], values: ['-u', '-C'] },
  nohup: { flags: [], values: [] },
  time: { flags: ['-p', '-v'], values: ['-f', '-o', '--format', '--output'] },
  nice: { flags: [], values: ['-n', '--adjustment'] },
  command: { flags: ['-p', '-v', '-V'], values: [] },
  builtin: { flags: [], values: [] },
};

function bashRequiresUser(source, destructive, depth = 0) {
  if (depth > 32 || source.includes('<<')) return true;
  const segments = bashSegments(source);
  if (!segments?.length) return true;
  return segments.some((segment) => inspectWords(shellWords(segment), destructive, depth));
}

function inspectWords(words, destructive, depth) {
  if (!words || depth > 32) return true;
  // Literal environment assignments do not change the executable, but a later $CMD does.
  let offset = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[offset]?.value ?? '')) offset += 1;
  words = words.slice(offset);
  if (!words.length) return false;
  const [head, ...args] = words;
  if (head.dynamic || !head.value || /[(){}<>]/.test(head.value)) return true;
  const executable = head.value.split('/').at(-1);
  if (UNSUPPORTED_SHELL_WORDS.has(executable)) return true;
  if (matchesAny([executable, ...args.map((word) => word.value)].join(' '), destructive)) return true;
  if (SHELLS.has(executable)) {
    // A shell script, stdin shell, or expansion in the script cannot be inspected here.
    for (let i = 0; i < args.length; i += 1) {
      const option = args[i];
      if (option.dynamic) return true;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option.value)) {
        const script = args[i + 1];
        return !script || script.dynamic || bashRequiresUser(script.value, destructive, depth + 1);
      }
      if (!['-l', '-e', '-u', '-x', '-f', '--noprofile', '--norc'].includes(option.value)) return true;
    }
    return true;
  }
  if (executable === 'eval') {
    return !args.length || args.some((word) => word.dynamic)
      || bashRequiresUser(args.map((word) => word.value).join(' '), destructive, depth + 1);
  }
  if (executable === 'find') {
    for (let i = 0; i < args.length; i += 1) {
      if (args[i].value === '-delete') return true;
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[i].value)) {
        const end = args.findIndex((word, j) => j > i && [';', '+'].includes(word.value));
        const command = args.slice(i + 1, end).map((word) => ({ ...word, dynamic: word.dynamic || word.value.includes('{}') }));
        if (end < 0 || inspectWords(command, destructive, depth + 1)) return true;
        i = end;
      }
    }
    return false;
  }
  if (!Object.hasOwn(WRAPPER_OPTIONS, executable)) return false;
  const options = WRAPPER_OPTIONS[executable];
  let i = 0;
  while (i < args.length) {
    const word = args[i];
    if (word.dynamic) return true;
    const option = word.value;
    if (option === '--') { i += 1; break; }
    if (executable === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) { i += 1; continue; }
    if (!option.startsWith('-')) break;
    if (options.flags.includes(option)) { i += 1; continue; }
    if (options.values.includes(option)) {
      if (!args[i + 1] || args[i + 1].dynamic) return true;
      i += 2; continue;
    }
    if (options.values.some((name) => name.startsWith('--') ? option.startsWith(`${name}=`) : option.startsWith(name) && option.length > name.length)) {
      i += 1; continue;
    }
    return true;
  }
  if (i === args.length) return true;
  const nestedRequiresUser = inspectWords(args.slice(i), destructive, depth + 1);
  // Unknown stdin may add destructive options or replace executable/script text.
  return nestedRequiresUser || executable === 'xargs';
}

export function checkReply({ approver = 'user', request, reply, confirmedByUser = false, policy = {} }) {
  if (reply === 'always') return { ok: false, code: 'INVALID_REPLY', reason: '"always" nunca é enviado: no OpenCode, aplica-se ao diretório inteiro e substitui as regras de negação da sessão; use once ou reject' };
  if (reply !== 'once' && reply !== 'reject') return { ok: false, code: 'INVALID_REPLY', reason: `resposta inválida "${displayValue(reply)}" (use once ou reject)` };
  if (reply === 'reject') return { ok: true };
  if (approver !== 'claude' && !confirmedByUser) return { ok: false, code: 'NEEDS_USER', reason: `o aprovador "${displayValue(approver)}" exige confirmação do usuário: apresente a solicitação, pergunte ao usuário (AskUserQuestion) e passe --confirmed-by-user` };
  if (approver === 'claude' && !confirmedByUser && requiresUser(request, policy)) return { ok: false, code: 'NEEDS_USER', reason: 'solicitação destrutiva, external_directory ou de caminho sensível: sempre exige confirmação do usuário (--confirmed-by-user após AskUserQuestion)' };
  return { ok: true };
}

export function sameRules(current, desired) {
  return Array.isArray(current) && Array.isArray(desired) && current.length === desired.length
    && desired.every((rule, i) => current[i]?.action === rule.action && current[i]?.resource === rule.resource && current[i]?.effect === rule.effect);
}

export function planPermissionSwitch(current, desired) {
  return sameRules(current, desired) ? { kind: 'none' } : { kind: 'replace', rules: desired };
}
