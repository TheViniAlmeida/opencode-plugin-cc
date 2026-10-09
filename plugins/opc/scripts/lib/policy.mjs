// Allow/deny policy (spec §3.2, §6 items 4-5). Permission profiles and approver arrive in F2a.
import { PolicyError, UsageError } from './opc-error.mjs';
import { matchesAny, parseFullId } from './models.mjs';

export const DEFAULT_AGENT = 'build';

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
  '**/.npmrc', '**/.netrc', '**/.git-credentials', '**/.aws/credentials', '**/kubeconfig', '**/.kube/config',
]);
export const PATCH_PERMISSION_MODE = 'replace';
const RULE_ACTIONS = new Set(['allow', 'deny', 'ask']);
const USER_FREE_PERMISSIONS = new Set(['read', 'glob', 'grep', 'list', 'edit', 'skill', 'question', 'todowrite', 'task']);
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
  if (withDestructive) for (const pattern of destructiveBashOf(policy)) rules.push(r('shell', pattern, 'ask'));
  for (const pattern of sensitivePathsOf(policy)) {
    for (const permission of SENSITIVE_PATH_PERMISSIONS) rules.push(r(permission, pattern, 'deny'));
  }
  for (const glob of deniedAgentGlobs) rules.push(r('subagent', glob, 'deny'));
  for (const tool of policy.tools?.deny ?? []) rules.push(r(tool, '*', 'deny'));
  rules.push(r('browser', '*', 'deny'));
  return rules;
}

export function buildPermissionRules(profile, { policy = {}, permissionProfiles = {}, deniedAgentGlobs = [], extraAllow = [] } = {}) {
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
  rules.push(...extraAllow, ...invariantRules(profile, { policy, deniedAgentGlobs, bridged }));
  return rules;
}

export function bridgeModeOf(profile) {
  return parseProfile(profile).kind === 'read-only' ? 'auto-reject' : 'bridge';
}

export function requiresUser(request, policy = {}) {
  if (!request || typeof request.permission !== 'string') return true;
  if (request.permission === 'external_directory') return true;
  if (request.permission === 'shell') {
    const commands = [...new Set([request.metadata?.command, ...(Array.isArray(request.patterns) ? request.patterns : [])]
      .filter((command) => typeof command === 'string'))];
    const destructive = destructiveBashOf(policy);
    const sensitive = sensitivePathsOf(policy);
    return commands.length === 0 || commands.some((command) => bashRequiresUser(command, destructive, 0, sensitive));
  }
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : [];
  if (SENSITIVE_PATH_PERMISSIONS.includes(request.permission) || ['list', 'edit'].includes(request.permission)) {
    return patterns.some((pattern) => matchesAny(pattern, sensitivePathsOf(policy)));
  }
  return !USER_FREE_PERMISSIONS.has(request.permission);
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
      if (quote === 'ansi') {
        if (char === '\\') i += 1;
        else if (char === "'") quote = null;
        continue;
      }
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
      if (char === '$' && source[i + 1] === "'") { quote = 'ansi'; i += 1; continue; }
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
        // A brace inside a word (or a comma expression) is expansion, not a script group.
        if (char === '{' && ((i > start && !/[\s;|&]/.test(source[i - 1])) || source.slice(i + 1, end).includes(','))) {
          i = end; continue;
        }
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
      if (quote === 'ansi') {
        if (char === '\\') i += 1;
        else if (char === "'") quote = null;
        continue;
      }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote === "'") { if (char === "'") quote = null; continue; }
      if (quote === '"') { if (char === '"') quote = null; continue; }
      if (char === '$' && source[i + 1] === "'") { quote = 'ansi'; i += 1; continue; }
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
      if (quote === 'ansi') {
        if (char === '\\') i += 1;
        else if (char === "'") quote = null;
        continue;
      }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote === "'") { if (char === "'") quote = null; continue; }
      if (quote === '"') { if (char === '"') quote = null; continue; }
      if (char === '$' && source[i + 1] === "'") { quote = 'ansi'; i += 1; continue; }
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
    if (quote === 'ansi') {
      if (char === "'") quote = null;
      else if (char === '\\') {
        const escape = ansiEscape(source, i);
        if (!escape) return null;
        value += escape.value; i = escape.end;
      } else value += char;
    } else if (char === '\\' && quote !== "'") {
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
    } else if (char === '$' && source[i + 1] === "'") {
      quote = 'ansi'; active = true; i += 1;
    } else if (char === "'" || char === '"') {
      quote = char; active = true;
    } else if (/\s/.test(char)) push();
    else {
      value += char; active = true;
      if ('$`*?[]{}'.includes(char)) dynamic = true;
    }
  }
  if (quote) return null;
  push();
  return words;
}

function ansiEscape(source, offset) {
  const next = source[offset + 1];
  if (next === undefined) return null;
  const escapes = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  if (Object.hasOwn(escapes, next)) return { value: escapes[next], end: offset + 1 };
  const numeric = /^(?:x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3})/.exec(source.slice(offset + 1))?.[0];
  if (numeric) {
    const code = /^[0-7]/.test(numeric) ? parseInt(numeric, 8) & 0xff : parseInt(numeric.slice(1), 16);
    if (code === 0 || code > 0x10ffff) return null;
    return { value: String.fromCodePoint(code), end: offset + numeric.length };
  }
  if (next === 'c') {
    const control = source[offset + 2];
    if (!control) return null;
    const code = control === '?' ? 127 : control.toUpperCase().charCodeAt(0) & 31;
    if (code === 0) return null;
    return { value: String.fromCharCode(code), end: offset + 2 };
  }
  return { value: `\\${next}`, end: offset + 1 };
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
  timeout: { flags: ['--preserve-status', '--foreground', '-v', '--verbose'], values: ['-s', '--signal', '-k', '--kill-after'], positionals: 1 },
  setsid: { flags: ['-f', '--fork', '-w', '--wait', '-c', '--ctty'], values: [] },
  stdbuf: { flags: [], values: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  ionice: { flags: ['-t', '--ignore'], values: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'] },
  flock: { flags: ['-s', '--shared', '-x', '--exclusive', '-u', '--unlock', '-n', '--nonblock', '-o', '--close', '-F', '--no-fork', '--verbose', '--fcntl'],
    values: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code', '--start', '--length', '-c', '--command'], positionals: 1, scripts: ['-c', '--command'] },
  watch: { flags: ['-b', '--beep', '-c', '--color', '-C', '--no-color', '-d', '--differences', '-e', '--errexit', '-g', '--chgexit', '-p', '--precise', '-t', '--no-title', '-w', '--no-wrap', '-x', '--exec'],
    values: ['-n', '--interval', '-q', '--equexit'], shell: true },
  busybox: { flags: [], values: [] },
  taskset: { flags: ['-a', '--all-tasks', '-p', '--pid'], values: ['-c', '--cpu-list'], positionals: 1, replacesPositional: ['-c', '--cpu-list'] },
  unshare: { flags: ['-m', '--mount', '-u', '--uts', '-i', '--ipc', '-n', '--net', '-p', '--pid', '-U', '--user', '-C', '--cgroup', '-T', '--time',
    '-f', '--fork', '-r', '--map-root-user', '-c', '--map-current-user', '--map-auto', '--mount-proc', '--kill-child'],
    values: ['-R', '--root', '-w', '--wd', '-S', '--setuid', '-G', '--setgid', '--map-user', '--map-group', '--map-users', '--map-groups', '--propagation', '--setgroups', '--monotonic', '--boottime'] },
  chroot: { flags: ['--skip-chdir'], values: ['--userspec', '--groups'], positionals: 1 },
  su: { flags: ['-', '-l', '--login', '-m', '-p', '--preserve-environment'], values: ['-c', '--command', '-s', '--shell', '-g', '--group', '-G', '--supp-group'],
    scripts: ['-c', '--command'], positionals: 1, optionalPositional: true },
  ssh: { flags: ['-4', '-6', '-A', '-a', '-C', '-f', '-G', '-g', '-K', '-k', '-M', '-N', '-n', '-q', '-s', '-T', '-t', '-V', '-v', '-X', '-x', '-Y', '-y'],
    values: ['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'], positionals: 1, shell: true },
};

const SHELL_DECLARATIONS = new Set(['export', 'declare', 'typeset']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const GIT_ENVIRONMENT = new Set(['PAGER', 'EDITOR', 'VISUAL', 'SSH_ASKPASS']);
const unsafeGitEnvironment = (name) => GIT_ENVIRONMENT.has(name)
  || (name.startsWith('GIT_') && name !== 'GIT_TERMINAL_PROMPT' && !name.startsWith('GIT_TRACE'));

function declaredEnvironment(words) {
  const offset = words?.findIndex((word) => !ASSIGNMENT.test(word.value)) ?? -1;
  if (offset < 0 || !SHELL_DECLARATIONS.has(words[offset].value)) return [];
  return words.slice(offset + 1).filter((word) => !word.value.startsWith('-'))
    .map((word) => word.value.split('=')[0]);
}

function bashRequiresUser(source, destructive, depth = 0, sensitivePaths = [], environment = []) {
  if (depth > 32 || source.includes('<<')) return true;
  const segments = bashSegments(source);
  if (!segments?.length) return true;
  const commands = segments.map(shellWords);
  const declared = commands.flatMap(declaredEnvironment);
  return commands.some((words) => inspectWords(words, destructive, depth, sensitivePaths, [...environment, ...declared]));
}

function shellTouchesSensitive(words, sensitivePaths) {
  const samples = [
    '.env', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc', '.git-credentials', 'secrets.env',
    '.aws/credentials', 'x.pem', 'x.key', ...sensitivePaths.filter((path) => !/[*?\[]/.test(path)),
  ].filter((path) => matchesAny(path, sensitivePaths));
  return words.some(({ value, dynamic }) => {
    const candidates = value.startsWith('-') ? [] : [value];
    if (value.startsWith('-') && value.includes('=')) candidates.push(value.slice(value.indexOf('=') + 1));
    if (/^-[^-]/.test(value) && value.length > 2) candidates.push(value.slice(2));
    return candidates.some((candidate) => {
      const expanded = expandShellBraces(candidate);
      if (!expanded) return true;
      return expanded.some((path) => {
        const basename = path.split('/').at(-1);
        if (matchesAny(path, sensitivePaths) || matchesAny(basename, sensitivePaths)) return true;
        const expansion = dynamic ? path.search(/[$`]/) : -1;
        const prefix = expansion < 0 ? null : path.slice(0, expansion);
        const patterns = /[*?\[]/.test(path) ? [path, basename] : [];
        if (prefix) {
          patterns.push(`${prefix}*`);
          const basePrefix = prefix.split('/').at(-1);
          if (basePrefix) patterns.push(`${basePrefix}*`);
        }
        return patterns.some((pattern) => {
          const match = shellGlobMatcher(pattern);
          return samples.some((sample) => match(sample) || match(sample.split('/').at(-1)));
        });
      });
    });
  });
}

function expandShellBraces(word) {
  const pending = [word], result = [];
  while (pending.length) {
    const path = pending.pop();
    const braces = [...path.matchAll(/\{([^{}]*,[^{}]*)\}/g)].find((match) => path[match.index - 1] !== '$');
    if (!braces) { result.push(path); continue; }
    const alternatives = braces[1].split(',');
    if (result.length + pending.length + alternatives.length > 64) return null;
    for (const alternative of alternatives) {
      pending.push(path.slice(0, braces.index) + alternative + path.slice(braces.index + braces[0].length));
    }
  }
  return result;
}

function shellGlobMatcher(glob) {
  const tokens = [];
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') { if (tokens.at(-1) !== '*') tokens.push('*'); }
    else if (char === '?') tokens.push(() => true);
    else if (char === '[' && glob.indexOf(']', i + 1) > i + 1) {
      const end = glob.indexOf(']', i + 1);
      const content = glob.slice(i + 1, end).replace(/^!/, '^');
      let expression;
      try { expression = new RegExp(`^[${content.replaceAll('\\', '\\\\')}]$`); }
      catch { return () => true; } // Uninspectable classes fail closed; each valid class matches one character.
      tokens.push((value) => expression.test(value));
      i = end;
    } else tokens.push((value) => value === char);
  }
  // Greedy two-pointer matching retries only the latest star, never a tree of alternatives.
  return (value) => {
    let token = 0, offset = 0, star = -1, retry = 0;
    while (offset < value.length) {
      if (tokens[token] === '*') { star = token++; retry = offset; }
      else if (tokens[token]?.(value[offset])) { token += 1; offset += 1; }
      else if (star >= 0) { token = star + 1; offset = ++retry; }
      else return false;
    }
    while (tokens[token] === '*') token += 1;
    return token === tokens.length;
  };
}

function harmlessGitConfig(value) {
  const key = value.slice(0, value.indexOf('=')).toLowerCase();
  return value.includes('=') && (/^(color|advice)\.[a-z0-9.-]+$/.test(key)
    || ['user.name', 'user.email', 'core.quotepath', 'init.defaultbranch'].includes(key));
}

function normalizeGitWords(words) {
  const flags = ['--no-pager', '-p', '-P', '--paginate', '--bare', '--no-replace-objects', '--literal-pathspecs', '--exec-path',
    '--no-optional-locks', '--version', '--help', '--no-lazy-fetch', '--no-advice'];
  const values = ['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace'];
  let i = 1;
  while (i < words.length) {
    const word = words[i];
    if (word.dynamic) return null;
    if (!word.value.startsWith('-')) break;
    if (flags.includes(word.value)) { i += 1; continue; }
    if (values.includes(word.value)) {
      if (!words[i + 1] || words[i + 1].dynamic) return null;
      if (['-c', '--config-env'].includes(word.value) && !harmlessGitConfig(words[i + 1].value)) return null;
      i += 2; continue;
    }
    if (word.value.startsWith('-c') && !word.value.startsWith('--')) {
      if (!harmlessGitConfig(word.value.slice(2))) return null;
      i += 1; continue;
    }
    if ([...values.filter((option) => option.startsWith('--')), '--exec-path'].some((option) => word.value.startsWith(`${option}=`))) {
      if (word.value.startsWith('--config-env=') && !harmlessGitConfig(word.value.slice('--config-env='.length))) return null;
      i += 1; continue;
    }
    return null;
  }
  return [words[0], ...words.slice(i)];
}

const GIT_VALUE_OPTIONS = {
  push: ['-o', '--push-option', '--receive-pack', '--exec', '--repo', '--recurse-submodules'],
  reset: ['--pathspec-from-file'],
  clean: ['-e', '--exclude'],
  branch: ['-u', '--set-upstream-to', '--format', '--sort'],
  tag: ['-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup', '--format', '--sort'],
  checkout: ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'],
  switch: ['-c', '-C', '--create', '--force-create', '--orphan', '--conflict'],
  restore: ['-s', '--source', '--conflict', '--pathspec-from-file'],
  stash: ['-m', '--message', '--pathspec-from-file'],
  'update-ref': ['-m', '--message'],
  rm: ['--pathspec-from-file'],
  rebase: ['-x', '--exec', '--onto', '--strategy', '-s', '--strategy-option', '-X'],
  fetch: ['--upload-pack', '-u', '--receive-pack', '--depth', '--shallow-since', '--shallow-exclude', '--refmap', '-j', '--jobs'],
  pull: ['--upload-pack', '-u', '--receive-pack', '--depth', '--strategy', '-s', '--strategy-option', '-X'],
  clone: ['--upload-pack', '-u', '--receive-pack', '--template', '-o', '--origin', '-b', '--branch', '--depth', '--reference', '--separate-git-dir', '-j', '--jobs'],
  'ls-remote': ['--upload-pack', '-u', '--receive-pack'],
  archive: ['--upload-pack', '-u', '--receive-pack', '--format', '--prefix', '-o', '--output', '--remote', '--exec'],
  difftool: ['-x', '--extcmd', '-t', '--tool'],
  worktree: ['-b', '-B', '--reason', '--expire'],
  submodule: ['-b', '--branch', '--name', '--reference', '--depth', '-j', '--jobs'],
};

function gitOptions(args, subcommand) {
  const short = new Set();
  const long = [];
  const operands = [];
  const values = GIT_VALUE_OPTIONS[subcommand] ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { operands.push(...args.slice(i)); break; }
    if (arg.startsWith('--')) {
      const option = arg.split('=')[0];
      long.push(option);
      if (!arg.includes('=') && values.some((name) => name.startsWith('--') && name.startsWith(option))) i += 1;
    } else if (arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j += 1) {
        const letter = arg[j];
        short.add(letter);
        if (values.includes(`-${letter}`)) {
          if (j === arg.length - 1) i += 1;
          break;
        }
      }
    } else operands.push(arg);
  }
  // A prefix that could select a destructive option also needs the user when ambiguous.
  const hasLong = (...names) => long.some((option) => names.some((name) => name.startsWith(option)));
  return { short, long, hasLong, operands };
}

function inspectWords(words, destructive, depth, sensitivePaths, environment = []) {
  if (!words || depth > 32) return true;
  if (shellTouchesSensitive(words, sensitivePaths)) return true;
  // Carry assignments through wrappers/scripts so git configuration cannot hide in env.
  let offset = 0;
  environment = [...environment];
  while (ASSIGNMENT.test(words[offset]?.value ?? '')) {
    environment.push(ASSIGNMENT.exec(words[offset].value)[1]); offset += 1;
  }
  words = words.slice(offset);
  if (!words.length) return false;
  const [head, ...args] = words;
  if (head.dynamic || !head.value || /[(){}<>]/.test(head.value)) return true;
  const executable = head.value.split('/').at(-1);
  if (UNSUPPORTED_SHELL_WORDS.has(executable)) return true;
  if (SHELL_DECLARATIONS.has(executable) && declaredEnvironment(words).some((name) => name.startsWith('GIT_'))) return true;
  if (executable === 'git') {
    if (environment.some(unsafeGitEnvironment)) return true;
    const normalized = normalizeGitWords(words);
    if (!normalized) return true;
    const [, subcommand, ...rest] = normalized.map((word) => word.value);
    if (['push', 'reset', 'clean', 'branch', 'tag', 'checkout', 'switch', 'restore', 'stash', 'update-ref', 'rm'].includes(subcommand)
      && normalized.slice(2).some((word) => word.dynamic)) return true;
    const { short, long, hasLong, operands } = gitOptions(rest, subcommand);
    const force = short.has('f') || hasLong('--force');
    const dryRun = subcommand === 'clean' && (short.has('n') || hasLong('--dry-run'));
    if (subcommand === 'push' && (force || short.has('d') || hasLong('--force-with-lease', '--delete', '--mirror', '--prune')
      || operands.some((arg) => arg.startsWith('+') || arg.startsWith(':')))) return true;
    if (subcommand === 'reset' && hasLong('--hard', '--merge', '--keep')) return true;
    if (subcommand === 'clean' && !dryRun && (force || short.has('x') || short.has('X'))) return true;
    if (subcommand === 'branch' && (short.has('D') || force)) return true;
    if (subcommand === 'tag' && (short.has('d') || hasLong('--delete') || force)) return true;
    if (subcommand === 'checkout' && (force || short.has('B') || operands.includes('.') || (operands.includes('--') && operands.indexOf('--') < operands.length - 1))) return true;
    if (subcommand === 'switch' && (force || short.has('C') || hasLong('--discard-changes', '--force-create'))) return true;
    if (subcommand === 'restore') {
      const staged = short.has('S') || long.some((option) => '--staged'.startsWith(option) && !'--source'.startsWith(option));
      if (!hasLong('--help') && !short.has('h') && (short.has('W') || hasLong('--worktree') || !staged)) return true;
    }
    if (subcommand === 'stash' && operands.some((arg) => ['drop', 'clear'].includes(arg))) return true;
    if (['filter-branch', 'filter-repo'].includes(subcommand) || (subcommand === 'update-ref' && (short.has('d') || hasLong('--delete')))) return true;
    if (subcommand === 'rm' && (force || ((short.has('r') || hasLong('--recursive')) && operands.includes('.')))) return true;
    if (subcommand === 'reflog' && ['expire', 'delete'].includes(operands[0])) return true;
    if (subcommand === 'gc' && rest.some((arg) => /^--prune=(now|all)$/.test(arg))) return true;
    if (subcommand === 'worktree' && operands[0] === 'remove' && force) return true;
    if (subcommand === 'submodule' && ((operands[0] === 'deinit' && force) || operands[0] === 'foreach')) return true;
    if (subcommand === 'bisect' && operands[0] === 'run') return true;
    if (subcommand === 'rebase' && (short.has('x') || hasLong('--exec'))) return true;
    if (subcommand === 'difftool' && (short.has('x') || hasLong('--extcmd'))) return true;
    if (['push', 'fetch', 'pull', 'clone', 'ls-remote', 'archive'].includes(subcommand)
      && (hasLong('--upload-pack', '--receive-pack', '--exec') || (subcommand !== 'push' && short.has('u')))) return true;
    const patterns = dryRun ? destructive.filter((pattern, i) => i >= BUILTIN_DESTRUCTIVE_BASH.length || !pattern.startsWith('git clean ')) : destructive;
    return matchesAny(['git', subcommand, ...rest].join(' '), patterns)
      || matchesAny(['git', ...args.map((word) => word.value)].join(' '), patterns);
  }
  if (matchesAny([executable, ...args.map((word) => word.value)].join(' '), destructive)) return true;
  if (SHELLS.has(executable)) {
    // A shell script, stdin shell, or expansion in the script cannot be inspected here.
    for (let i = 0; i < args.length; i += 1) {
      const option = args[i];
      if (option.dynamic) return true;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option.value)) {
        const script = args[i + 1];
        return !script || script.dynamic || bashRequiresUser(script.value, destructive, depth + 1, sensitivePaths, environment);
      }
      if (!['-l', '-e', '-u', '-x', '-f', '--noprofile', '--norc'].includes(option.value)) return true;
    }
    return true;
  }
  if (executable === 'eval') {
    return !args.length || args.some((word) => word.dynamic)
      || bashRequiresUser(args.map((word) => word.value).join(' '), destructive, depth + 1, sensitivePaths, environment);
  }
  if (executable === 'find') {
    for (let i = 0; i < args.length; i += 1) {
      if (args[i].value === '-delete') return true;
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[i].value)) {
        const end = args.findIndex((word, j) => j > i && [';', '+'].includes(word.value));
        const command = args.slice(i + 1, end).map((word) => ({ ...word, dynamic: word.dynamic || word.value.includes('{}') }));
        if (end < 0 || inspectWords(command, destructive, depth + 1, sensitivePaths, environment)) return true;
        i = end;
      }
    }
    return false;
  }
  if (!Object.hasOwn(WRAPPER_OPTIONS, executable)) return false;
  const options = WRAPPER_OPTIONS[executable];
  let i = 0;
  let positionals = options.positionals ?? 0;
  let script = null;
  while (i < args.length) {
    const word = args[i];
    if (word.dynamic) return true;
    const option = word.value;
    if (option === '--') { i += 1; break; }
    if (executable === 'env' && ASSIGNMENT.test(option)) { environment.push(ASSIGNMENT.exec(option)[1]); i += 1; continue; }
    if (!option.startsWith('-')) {
      if (positionals > 0) { positionals -= 1; i += 1; continue; }
      break;
    }
    if (options.flags.includes(option)) { i += 1; continue; }
    if (options.values.includes(option)) {
      if (!args[i + 1] || args[i + 1].dynamic) return true;
      if (options.scripts?.includes(option)) script = args[i + 1].value;
      if (options.replacesPositional?.includes(option)) positionals = 0;
      i += 2; continue;
    }
    if (options.values.some((name) => name.startsWith('--') ? option.startsWith(`${name}=`) : option.startsWith(name) && option.length > name.length)) {
      const scriptOption = options.scripts?.find((name) => name.startsWith('--') ? option.startsWith(`${name}=`) : option.startsWith(name));
      if (scriptOption) script = option.slice(scriptOption.length + (scriptOption.startsWith('--') ? 1 : 0));
      if (options.replacesPositional?.some((name) => option.startsWith(name))) positionals = 0;
      i += 1; continue;
    }
    return true;
  }
  // -- ends wrapper options but still leaves its required duration/lock positional.
  while (positionals > 0) {
    if (options.optionalPositional && !args[i]) break;
    if (!args[i] || args[i].dynamic) return true;
    positionals -= 1; i += 1;
  }
  if (script !== null) return bashRequiresUser(script, destructive, depth + 1, sensitivePaths, environment);
  if (i === args.length) return true;
  if (options.shell) {
    return args.slice(i).some((word) => word.dynamic)
      || bashRequiresUser(args.slice(i).map((word) => word.value).join(' '), destructive, depth + 1, sensitivePaths, environment);
  }
  const nestedRequiresUser = inspectWords(args.slice(i), destructive, depth + 1, sensitivePaths, environment);
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
