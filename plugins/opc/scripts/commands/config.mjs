// opc config get|set|unset|add|remove|show|validate|path|init — spec §3.2, §3.3
import { redact } from '../lib/redact.mjs';
import { f1Command } from '../lib/f1-command.mjs';
import { parseArgs } from '../lib/args.mjs';
import { UsageError, PolicyError, OpcError, ConnectionError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import {
  loadConfig, configPaths, getPath, schemaFor, coerceValue, applyConfigEdit, isLockedKey, isWorkspaceKey,
  keyNeedsServer, normalizeEditValue, validateConfigShape, mergeConfig, validateAgainstServer, policyViolations,
  saveGlobalConfig, saveWorkspaceConfig, CONFIG_SCHEMA, isSecretLikeSetting,
} from '../lib/config.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { loadOpencodeConfig } from '../lib/opencode-config.mjs';
import { createPrompter } from '../lib/tty.mjs';
import { runInitWizard } from '../lib/onboarding.mjs';
import { renderConfig, renderOnboarding } from '../lib/render.mjs';

const SPEC = {
  flags: {
    json: { type: 'boolean' }, cwd: { type: 'string' }, workspace: { type: 'boolean' }, global: { type: 'boolean' },
    'tty-confirm': { type: 'boolean' }, effective: { type: 'boolean' },
  },
  allowPositionals: true,
};
const USAGE = 'uso: opc config get [chave] | set <chave> <valor> | unset <chave> | add|remove <chave-de-lista> <valor> | show [--effective] | validate | path | init   (edições aceitam --workspace e --tty-confirm)';

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const emit = (ctx, flags, view, render) => { if (flags.json) ctx.json(redact(view)); else ctx.out(render(view)); };
const touches = (key) => (e) => e.path === key || e.path.startsWith(`${key}.`) || e.path.startsWith(`${key}[`);
const knownKey = (key) => Boolean(schemaFor(key)) || Object.keys(CONFIG_SCHEMA).some((k) => k.startsWith(`${key}.`));

export function contextOptions(argv) {
  return argv[0] === 'validate' ? { allowInvalidConfig: true } : {};
}

async function runCommand(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const [sub, ...rest] = positionals;
  switch (sub) {
    case 'path': return cmdPath(ctx, flags);
    case 'get': return cmdGet(ctx, flags, rest);
    case 'set': case 'unset': case 'add': case 'remove': return cmdEdit(ctx, flags, sub, rest);
    case 'show': return cmdShow(ctx, flags);
    case 'validate': return cmdValidate(ctx, flags);
    case 'init': return cmdInit(ctx, flags);
    default: throw new UsageError('USAGE', USAGE);
  }
}

function cmdPath(ctx, flags) {
  emit(ctx, flags, { kind: 'path', ...configPaths({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot }) }, renderConfig);
  return 0;
}

function cmdGet(ctx, flags, rest) {
  if (rest.length > 1) throw new UsageError('USAGE', USAGE);
  const key = rest[0] ?? null;
  if (key && !knownKey(key)) throw new UsageError('UNKNOWN_KEY', `chave de configuração desconhecida: "${key}"`);
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const source = flags.global ? 'global' : flags.workspace ? 'workspace' : 'effective';
  const obj = source === 'global' ? (loaded.global ?? {}) : source === 'workspace' ? (loaded.workspace ?? {}) : loaded.config;
  const rawValue = key ? (getPath(obj, key) ?? null) : obj;
  const value = key && isSecretLikeSetting(key) && rawValue !== null ? '***' : rawValue;
  emit(ctx, flags, { kind: 'get', setting: key ?? '(all)', source, value }, renderConfig);
  return 0;
}

function terminalCommand(op, key, raw, scope) {
  const safeRaw = raw === undefined ? undefined : '<valor>';
  return `opc config ${op} ${key}${safeRaw !== undefined ? ` ${shellQuote(safeRaw)}` : ''}${scope === 'workspace' ? ' --workspace' : ''} --tty-confirm`;
}

async function confirmLocked(ctx, flags, { op, key, raw, scope }) {
  const command = terminalCommand(op, key, raw, scope);
  if (!flags['tty-confirm']) {
    throw new PolicyError('LOCKED_KEY', `"${key}" é uma chave travada; altere-a no seu terminal: ${command} (ou execute: opc config init)`, { details: { setting: key, command } });
  }
  if (!ctx.stdin || !ctx.stdin.isTTY) {
    throw new PolicyError('LOCKED_KEY', `--tty-confirm exige um terminal interativo (stdin não é TTY); execute no seu terminal: ${command}`, { details: { setting: key, command } });
  }
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
  try {
    ctx.err(`[opc] "${key}" é uma chave travada (política/mundo).\n`);
    const typed = await prompter.text(`Digite "${key}" para confirmar a alteração: `);
    if (typed !== key) throw new PolicyError('LOCKED_KEY', 'a confirmação não correspondeu; nada foi alterado', { details: { setting: key } });
  } finally {
    prompter.close();
  }
}

async function serverDeps(ctx) {
  const { api } = await connectApi(ctx);
  const [providers, models, defaultModel, agents, opencodeConfig] = await Promise.all([api.providers(), api.models(), api.defaultModel(), api.agents(), loadOpencodeConfig(api)]);
  return { catalog: buildCatalog({ providers, models, defaultModel }), agents, opencodeConfig };
}

async function cmdEdit(ctx, flags, op, rest) {
  const [key, ...valueParts] = rest;
  if (!key) throw new UsageError('USAGE', USAGE);
  if (!schemaFor(key)) throw new UsageError('UNKNOWN_KEY', `chave de configuração desconhecida: "${key}"`);
  if (op === 'unset' ? valueParts.length > 0 : valueParts.length === 0) throw new UsageError('USAGE', USAGE);
  const raw = op === 'unset' ? undefined : valueParts.join(' ');
  const scope = flags.workspace ? 'workspace' : 'global';
  if (scope === 'workspace' && !isWorkspaceKey(key)) {
    throw new UsageError('GLOBAL_ONLY_KEY', `"${key}" não pode ser definida em .opc.json (o arquivo do workspace só pode restringir); use a configuração global`);
  }
  if (isLockedKey(key)) await confirmLocked(ctx, flags, { op, key, raw, scope });
  let value = raw === undefined ? undefined : coerceValue(key, raw);
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const base = (scope === 'workspace' ? loaded.workspace : loaded.global) ?? {};
  // Compare effective configs: a workspace override may mask a denied global default.
  const before = loaded.config;
  const warnings = [];
  let next;
  let deps = { catalog: undefined, agents: [] };
  if (keyNeedsServer(key)) {
    deps = await serverDeps(ctx);
    if (value !== undefined && value !== null) {
      const normOpts = { catalog: deps.catalog, aliases: loaded.config.aliases ?? {}, defaultProvider: key === 'defaultProvider' ? null : loaded.config.defaultProvider };
      try {
        value = normalizeEditValue(key, value, normOpts);
      } catch (err) {
        if (op !== 'remove') throw err;
      }
    }
    next = applyConfigEdit(base, op, key, value);
    const effective = scope === 'workspace' ? mergeConfig(loaded.global ?? {}, next) : mergeConfig(next, loaded.workspace ?? {});
    const checked = validateAgainstServer(effective.config, deps);
    const own = checked.errors.filter(touches(key));
    if (own.length) throw new UsageError(own[0].code ?? 'INVALID_VALUE', own.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: own } });
    const existingViolations = new Set(policyViolations(before, deps).map((e) => `${e.path}|${e.code}|${e.message}`));
    const denied = policyViolations(effective.config, deps).filter((e) => !existingViolations.has(`${e.path}|${e.code}|${e.message}`));
    if (denied.length) throw new PolicyError('POLICY_DENIED', denied.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: denied } });
    for (const e of checked.errors.filter((x) => !touches(key)(x))) warnings.push({ path: e.path, code: e.code, message: e.message });
  } else {
    next = applyConfigEdit(base, op, key, value);
    const effective = scope === 'workspace' ? mergeConfig(loaded.global ?? {}, next) : mergeConfig(next, loaded.workspace ?? {});
    const existingViolations = new Set(policyViolations(before, deps).map((e) => `${e.path}|${e.code}|${e.message}`));
    const denied = policyViolations(effective.config, deps).filter((e) => !existingViolations.has(`${e.path}|${e.code}|${e.message}`));
    if (denied.length) throw new PolicyError('POLICY_DENIED', denied.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: denied } });
  }
  const shape = validateConfigShape(next, { source: scope });
  if (shape.errors.length) throw new UsageError('INVALID_VALUE', shape.errors.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: shape.errors } });
  warnings.push(...shape.warnings);
  if (scope === 'workspace') saveWorkspaceConfig(ctx.workspaceRoot, next);
  else saveGlobalConfig(ctx.dataDir, next);
  const paths = configPaths({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  emit(ctx, flags, { kind: 'edit', op, setting: key, scope, path: scope === 'workspace' ? paths.workspace : paths.global, value: getPath(next, key) ?? null, warnings }, renderConfig);
  return 0;
}

function cmdShow(ctx, flags) {
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const paths = configPaths({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const view = flags.effective
    ? { kind: 'effective', config: loaded.config, warnings: loaded.warnings ?? [] }
    : { kind: 'show', global: loaded.global, workspace: loaded.workspace, paths, warnings: loaded.warnings ?? [] };
  emit(ctx, flags, view, renderConfig);
  return 0;
}

async function cmdValidate(ctx, flags) {
  let loaded;
  try {
    loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  } catch (err) {
    if (err.code !== 'CONFIG_INVALID') throw err;
    const details = err.details ?? {};
    const source = details.path?.endsWith('.opc.json') ? 'workspace' : 'global';
    const errors = (details.errors?.length ? details.errors : [{ path: '', code: 'CONFIG_INVALID', message: err.message }])
      .map((e) => ({ source, ...e }));
    emit(ctx, flags, { kind: 'validate', valid: false, errors, warnings: [], serverChecked: false, serverError: null }, renderConfig);
    return 2;
  }
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const addWarning = (source, w) => {
    const id = `${w.path}|${w.code ?? ''}|${w.message}`;
    if (!seen.has(id)) { seen.add(id); warnings.push({ source, ...w }); }
  };
  for (const [source, obj] of [['global', loaded.global], ['workspace', loaded.workspace]]) {
    const shape = validateConfigShape(obj, { source });
    errors.push(...shape.errors.map((e) => ({ source, ...e })));
    shape.warnings.forEach((w) => addWarning(source, w));
  }
  (loaded.warnings ?? []).forEach((w) => addWarning('merge', typeof w === 'string' ? { path: '', message: w } : w));
  let serverChecked = false;
  let serverError = null;
  try {
    const deps = await serverDeps(ctx);
    const checked = validateAgainstServer(loaded.config, deps);
    errors.push(...checked.errors.map((e) => ({ source: 'effective', ...e })));
    checked.warnings.forEach((w) => addWarning('effective', w));
    errors.push(...policyViolations(loaded.config, deps).map((e) => ({ source: 'effective', ...e })));
    serverChecked = true;
  } catch (err) {
    if (!(err instanceof ConnectionError)) throw err;
    serverError = `${err.code}: ${err.message}`;
  }
  const view = { kind: 'validate', valid: errors.length === 0 && serverChecked, serverChecked, serverError, errors, warnings };
  emit(ctx, flags, view, renderConfig);
  if (errors.length) return errors.every((e) => e.code === 'POLICY_DENIED') ? 4 : 2;
  return serverChecked ? 0 : 5;
}

async function cmdInit(ctx, flags) {
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
  try {
    const deps = await serverDeps(ctx);
    const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const result = await runInitWizard({
      prompter,
      ...deps,
      existing: { global: loaded.global, workspace: loaded.workspace },
      hasGlobal: loaded.hasGlobal,
      dataDir: ctx.dataDir,
      workspaceRoot: ctx.workspaceRoot,
      log: (text) => ctx.err(text),
    });
    if (!result) {
      if (flags.json) ctx.json({ ok: true, saved: false, message: 'Nada foi gravado.' });
      else ctx.out('Nada foi gravado.\n');
      return 0;
    }
    emit(ctx, flags, { kind: 'commit', ...result }, renderOnboarding);
    return 0;
  } catch (err) {
    if (err instanceof OpcError && err.code === 'TTY_CLOSED') throw new UsageError('TTY_CLOSED', 'assistente interrompido; nada foi gravado');
    throw err;
  } finally {
    prompter.close();
  }
}

export const run = f1Command(runCommand);
