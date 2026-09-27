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
  'rm -rf*', 'rm -r *', 'rm -fr*', 'git push --force*', 'git push -f*', 'git push --delete*',
  'git reset --hard*', 'git clean -f*', 'git branch -D*', 'git tag -d*', 'docker rm*',
  'docker rmi*', 'docker volume rm*', 'docker system prune*', 'docker compose down -v*',
  'kubectl delete*', 'mkfs*', 'dd *of=*', 'shred*', 'truncate -s 0*', 'find * -delete*',
  'shutdown*', 'reboot*', 'poweroff*', 'systemctl stop*', '*DROP DATABASE*', '*DROP TABLE*',
  '*TRUNCATE*',
]);
export const READ_ONLY_ALLOW = Object.freeze(['read', 'glob', 'list', 'lsp', 'skill', 'todowrite']);
export const SENSITIVE_PATH_PERMISSIONS = Object.freeze(['read', 'grep', 'glob', 'list']);
export const DEFAULT_SENSITIVE_PATHS = Object.freeze([
  '*.env', '*.env.*', '**/.ssh/**', '*.pem', '*.key', '**/id_rsa*', '**/id_ed25519*', '**/secrets.env',
]);
export const PATCH_PERMISSION_MODE = 'append';
const RULE_ACTIONS = new Set(['allow', 'deny', 'ask']);
const rule = (permission, pattern, action) => ({ permission, pattern, action });

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
  throw new UsageError('UNKNOWN_PROFILE', `unknown permission profile "${profile}" (use read-only, write or custom:<name>)`);
}

function customRulesOf(name, permissionProfiles = {}) {
  const rules = permissionProfiles?.[name];
  if (!Array.isArray(rules)) throw new UsageError('UNKNOWN_PROFILE', `permissionProfiles.${name} is not defined in the global config`);
  return rules.map((r, i) => {
    if (!r || typeof r.permission !== 'string' || typeof r.pattern !== 'string' || !RULE_ACTIONS.has(r.action)) {
      throw new UsageError('INVALID_PROFILE', `permissionProfiles.${name}[${i}] must be {permission, pattern, action: allow|deny|ask}`);
    }
    return rule(r.permission, r.pattern, r.action);
  });
}

export function invariantRules(profile, { policy = {}, deniedAgentGlobs = [], bridged = null } = {}) {
  const { kind } = parseProfile(profile);
  const withDestructive = bridged ?? kind === 'write';
  const rules = [rule('external_directory', '*', 'deny')];
  if (kind === 'read-only') rules.push(rule('grep', '*', 'deny'));
  for (const pattern of sensitivePathsOf(policy)) {
    for (const permission of SENSITIVE_PATH_PERMISSIONS) rules.push(rule(permission, pattern, 'deny'));
  }
  for (const glob of deniedAgentGlobs) rules.push(rule('task', glob, 'deny'));
  for (const tool of policy.tools?.deny ?? []) rules.push(rule(tool, '*', 'deny'));
  if (withDestructive) for (const pattern of destructiveBashOf(policy)) rules.push(rule('bash', pattern, 'ask'));
  rules.push(rule('doom_loop', '*', kind === 'write' ? 'ask' : 'deny'));
  return rules;
}

export function buildPermissionRules(profile, { policy = {}, permissionProfiles = {}, deniedAgentGlobs = [] } = {}) {
  const { kind, name } = parseProfile(profile);
  const rules = [];
  let bridged = kind === 'write';
  if (kind !== 'write') {
    rules.push(rule('*', '*', 'deny'));
    for (const permission of READ_ONLY_ALLOW) rules.push(rule(permission, '*', 'allow'));
  }
  if (kind === 'custom') {
    const custom = customRulesOf(name, permissionProfiles);
    rules.push(...custom);
    bridged = custom.some((r) => r.permission === 'bash' && r.action !== 'deny');
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
  if (request.permission === 'bash') {
    const commands = [...patterns];
    if (typeof request.metadata?.command === 'string') commands.push(request.metadata.command);
    return commands.some((command) => matchesAny(command.trim(), destructiveBashOf(policy)));
  }
  if (SENSITIVE_PATH_PERMISSIONS.includes(request.permission) || request.permission === 'edit') {
    return patterns.some((pattern) => matchesAny(pattern, sensitivePathsOf(policy)));
  }
  return false;
}

export function checkReply({ approver = 'user', request, reply, confirmedByUser = false, policy = {} }) {
  if (reply === 'always') return { ok: false, code: 'INVALID_REPLY', reason: '"always" is never sent: in OpenCode it applies to the whole directory and overrides the session deny rules; use once or reject' };
  if (reply !== 'once' && reply !== 'reject') return { ok: false, code: 'INVALID_REPLY', reason: `invalid reply "${reply}" (use once or reject)` };
  if (reply === 'reject') return { ok: true };
  if (approver !== 'claude' && !confirmedByUser) return { ok: false, code: 'NEEDS_USER', reason: 'approver is "user": present the request, ask the user (AskUserQuestion) and pass --confirmed-by-user' };
  if (approver === 'claude' && !confirmedByUser && requiresUser(request, policy)) return { ok: false, code: 'NEEDS_USER', reason: 'destructive, external_directory or sensitive-path request: it always needs the user (--confirmed-by-user after AskUserQuestion)' };
  return { ok: true };
}

export function endsWithRules(current, desired) {
  if (desired.length > current.length) return false;
  const offset = current.length - desired.length;
  return desired.every((r, i) => {
    const c = current[offset + i];
    return c && c.permission === r.permission && c.pattern === r.pattern && c.action === r.action;
  });
}

export function planPermissionSwitch(current, desired, mode = PATCH_PERMISSION_MODE) {
  const existing = Array.isArray(current) ? current : [];
  if (endsWithRules(existing, desired)) return 'none';
  if (mode === 'replace') return 'patch';
  const first = desired[0];
  if (first && first.permission === '*' && first.pattern === '*') return 'patch';
  throw new UsageError('PROFILE_SWITCH_UNSUPPORTED', 'this session was created with another permission profile and OpenCode 1.18.32 appends (does not replace) session rules on PATCH, so switching to this profile would not take effect; start a new session with --fresh');
}
