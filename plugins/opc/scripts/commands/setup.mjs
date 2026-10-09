// `opc setup`: diagnostic + start/reuse of the workspace server (F0); `--stop-server` (spec §4, §5.5).
import { withLock } from '../lib/locks.mjs';
import { redact } from '../lib/redact.mjs';
import { providerEcho } from './models.mjs';
import { f1Command, f1Error } from '../lib/f1-command.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../lib/args.mjs';
import { globalConfigPath, workspaceConfigPath, setStopGateEnabled } from '../lib/config.mjs';
import { ExitCode, UsageError, toExitCode } from '../lib/opc-error.mjs';
import { renderSetup, renderReviewGate } from '../lib/render.mjs';
import { MIN_OPENCODE_VERSION, compareVersions, ensureServer, resolveOpencodeBin, stopServer } from '../lib/server.mjs';
import { mergeOpencodeConfigSources } from '../lib/opencode-config.mjs';
import { listActiveJobs, ensurePrivateDir } from '../lib/state.mjs';
import { liveActiveJobs } from '../lib/jobs.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function setupCatalog(buildCatalog, providers, models) {
  return buildCatalog({ providers, models });
}

export { mergeOpencodeConfigSources };
const SPEC = {
  flags: {
    json: { type: 'boolean' },
    'stop-server': { type: 'boolean' },
    force: { type: 'boolean' },
    'confirmed-by-user': { type: 'boolean' },
    'enable-review-gate': { type: 'boolean' },
    'disable-review-gate': { type: 'boolean' },
  },
};

function shellSingleQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

export function terminalAlias(dataDir, pluginRoot = PLUGIN_ROOT) {
  const companion = path.join(pluginRoot, 'scripts', 'opc-companion.mjs');
  const inner = `OPC_DATA_DIR=${shellSingleQuote(dataDir)} node ${shellSingleQuote(companion)}`;
  return `alias opc=${shellSingleQuote(inner)}`;
}

export function detectOpencode(env, bin = 'opencode') {
  const res = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 15000, shell: false });
  if (res.error) {
    return { installed: false, version: null, supported: null, detail: res.error.code === 'ENOENT' ? 'binário não encontrado' : `falha ao executar o binário (${res.error.code ?? 'erro desconhecido'})` };
  }
  const match = /\d+\.\d+\.\d+[^\s]*/.exec(`${res.stdout} ${res.stderr}`);
  const version = match ? match[0] : null;
  return {
    installed: res.status === 0,
    version,
    supported: version ? compareVersions(version, MIN_OPENCODE_VERSION) >= 0 : null,
    detail: res.status === 0 ? 'ok' : `saiu com ${res.status}`,
  };
}

export function reviewGateChange(flags) {
  if (flags['enable-review-gate'] && flags['disable-review-gate']) {
    throw new UsageError('USAGE', 'Escolha --enable-review-gate ou --disable-review-gate, não ambos.');
  }
  if (flags['enable-review-gate']) return true;
  if (flags['disable-review-gate']) return false;
  return null;
}

export function contextOptions(argv) {
  return argv.some((arg) => ['--stop-server', '--enable-review-gate', '--disable-review-gate'].includes(arg))
    ? { allowInvalidConfig: true }
    : {};
}

function serverContext(ctx) {
  return {
    stateDir: ctx.stateDir,
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    env: ctx.env,
    opencodeBin: resolveOpencodeBin({ env: ctx.env, config: ctx.config }),
    hasActiveJobs: () => listActiveJobs(ctx.stateDir).length > 0,
  };
}

function baseReport(ctx) {
  return {
    mode: 'diagnose',
    ready: false,
    node: { ok: true, version: process.versions.node },
    opencode: null,
    dataDir: ctx.dataDir,
    workspaceRoot: ctx.workspaceRoot,
    stateDir: ctx.stateDir,
    config: {
      hasGlobal: ctx.configMeta.hasGlobal,
      globalPath: globalConfigPath(ctx.dataDir),
      workspaceFound: ctx.configMeta.workspaceFound,
      workspacePath: workspaceConfigPath(ctx.workspaceRoot),
      warnings: ctx.configWarnings,
    },
    server: null,
    terminalAlias: terminalAlias(ctx.dataDir),
    nextSteps: [],
    reviewGate: { enabled: ctx.config?.stopGate?.enabled === true, changed: ctx.reviewGateChanged === true },
  };
}

const NEXT_STEP_BY_CODE = {
  AUTH_FAILED: 'O servidor recusou a senha (401). Rode `/opc:setup --stop-server` e depois `/opc:setup` de novo.',
  BOOT_FAILED: 'O servidor não subiu. Veja o server.log no diretório de estado e docs/troubleshooting.md.',
  UNSUPPORTED_VERSION: `Instale o OpenCode V2 ${MIN_OPENCODE_VERSION} ou configure server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário V2.`,
  TIMEOUT: 'Tempo esgotado. Tente de novo; se persistir, veja docs/troubleshooting.md (locks e boot lento).',
  INSECURE_SERVER_URL: 'Corrija OPC_SERVER_URL (https://, http://127.0.0.1, http://localhost ou http://<IP privado> com `opc config set server.allowPrivateHttp true --tty-confirm`) ou remova a variável.',
  INVALID_REMOTE_ROOT: 'Corrija OPC_REMOTE_ROOT: caminho absoluto POSIX (começando com /) do repositório na máquina do servidor.',
  SERVER_DOWN: 'Servidor inacessível. Rode `/opc:setup` de novo.',
};

async function diagnose(ctx, flags) {
  const report = baseReport(ctx);
  const attach = Boolean(ctx.env.OPC_SERVER_URL);
  const opencodeBin = resolveOpencodeBin({ env: ctx.env, config: ctx.config });
  report.opencode = { ...detectOpencode(ctx.env, opencodeBin), bin: opencodeBin };
  let exitCode = ExitCode.OK;
  if (!attach && !report.opencode.installed) {
    report.server = { status: 'skipped', warnings: [] };
    // The npm package `opencode-ai` still publishes V1 (1.18.x), so opc does not suggest it.
    report.nextSteps.push(`Instale o OpenCode ${MIN_OPENCODE_VERSION} ou mais novo pela documentação oficial (https://opencode.ai), ou aponte server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário, e rode \`/opc:setup\` de novo.`);
    exitCode = ExitCode.CONNECTION;
  } else if (!attach && report.opencode.supported === false) {
    report.server = {
      status: 'error',
      error: { code: 'UNSUPPORTED_VERSION', message: `OpenCode ${report.opencode.version} é anterior ao mínimo suportado ${MIN_OPENCODE_VERSION}. Instale o OpenCode V2 ou aponte server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário V2.` },
      warnings: [],
    };
    report.nextSteps.push(NEXT_STEP_BY_CODE.UNSUPPORTED_VERSION);
    exitCode = ExitCode.WAITING;
  } else {
    try {
      const s = await ensureServer(serverContext(ctx));
      report.server = {
        status: s.attached ? 'attached' : 'running',
        url: s.url,
        port: s.port,
        pid: s.pid,
        version: s.version,
        reused: s.reused,
        attached: s.attached,
        remoteRoot: s.remoteRoot ?? null,
        sessionsBlocked: s.world?.shareBlocked ? (s.world.shareReason ?? 'share-auto') : null,
        warnings: s.warnings,
      };
      if (s.world?.shareBlocked) {
        report.nextSteps.push(s.world.shareReason === 'config-unavailable'
          ? 'Não foi possível confirmar a configuração de compartilhamento. Verifique o servidor OpenCode e tente `/opc:setup` novamente.'
          : 'Desligue o share automático: `server.configOverride.share = "disabled"` na config global do opc, ou `share: "manual"` no OpenCode.');
        exitCode = ExitCode.POLICY;
      }
    } catch (err) {
      report.server = { status: 'error', error: { code: err.code ?? 'INTERNAL', message: err.message }, warnings: [] };
      if (NEXT_STEP_BY_CODE[err.code]) report.nextSteps.push(NEXT_STEP_BY_CODE[err.code]);
      exitCode = toExitCode(f1Error(err));
    }
  }
  if (!report.config.hasGlobal) report.nextSteps.push('Ainda não há config global do opc; o onboarding guiado chega na F1.');
  report.ready = exitCode === ExitCode.OK;
  if (flags.json) ctx.json(report);
  else { ctx.out(renderSetup(report)); ctx.out(renderReviewGate(report.reviewGate)); }
  return exitCode;
}

async function stop(ctx, flags) {
  let activeJobs = [];
  const result = await stopServer({
    ...serverContext(ctx),
    hasActiveJobs: () => {
      activeJobs = liveActiveJobs(ctx.stateDir);
      return activeJobs.length > 0;
    },
  }, { force: flags.force, confirmedByUser: flags['confirmed-by-user'] });
  const report = {
    mode: 'stop',
    stop: result,
    warnings: ctx.configWarnings ?? [],
    activeJobs: result.reason === 'active-jobs'
      ? activeJobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, title: j.title ?? null }))
      : [],
    reviewGate: { enabled: ctx.config?.stopGate?.enabled === true, changed: ctx.reviewGateChanged === true },
  };
  if (flags.json) ctx.json(report);
  else { ctx.out(renderSetup(report)); ctx.out(renderReviewGate(report.reviewGate)); }
  return result.reason === 'active-jobs' ? ExitCode.USAGE : ExitCode.OK;
}

async function runDiagnostics(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const gateChange = reviewGateChange(flags);
  if (gateChange !== null && ctx.configError) {
    const { scope, path: configPath } = ctx.configError;
    throw new UsageError(
      'CONFIG_INVALID',
      `Configuração ${scope} inválida em ${configPath}. Execute "opc config validate" antes de alterar o gate.`,
      { details: ctx.configError.details },
    );
  }
  if ((flags.force || flags['confirmed-by-user']) && !flags['stop-server']) {
    throw new UsageError('USAGE', '--force e --confirmed-by-user só valem junto com --stop-server.');
  }
  if (flags.force && !flags['confirmed-by-user']) {
    throw new UsageError('CONFIRMATION_REQUIRED', '--force exige --confirmed-by-user (confirmação explícita do usuário).');
  }
  if (flags['confirmed-by-user'] && !flags.force) {
    throw new UsageError('USAGE', '--confirmed-by-user só vale junto com --stop-server --force.');
  }
  ctx.reviewGateChanged = gateChange !== null;
  if (gateChange !== null) {
    await setStopGateEnabled(ctx.dataDir, gateChange);
    ctx.config = { ...ctx.config, stopGate: { ...ctx.config.stopGate, enabled: gateChange } };
  }
  if (flags['stop-server']) return stop(ctx, flags);
  return diagnose(ctx, flags);
}

// ---- F1: onboarding (spec §3.3). Only two new top-level names (`run`, `SetupOnboarding`);
// dependencies are loaded with dynamic import so they never collide with F0's imports. ----
const SETUP_PASSTHROUGH_FLAGS = ['--stop-server', '--enable-review-gate', '--disable-review-gate'];

const SetupOnboarding = {
  async deps() {
    const mods = await Promise.all([
      import('node:child_process'), import('../lib/args.mjs'), import('../lib/opc-error.mjs'), import('../lib/context.mjs'),
      import('../lib/config.mjs'), import('../lib/models.mjs'), import('../lib/onboarding.mjs'), import('../lib/render.mjs'),
    ]);
    return Object.assign({}, ...mods);
  },

  existingOf(loaded) {
    return { global: loaded.global, workspace: loaded.workspace };
  },

  probeBinary(d, command, args, env) {
    const r = d.spawnSync(command, args, { env, encoding: 'utf8', shell: false, timeout: 15000 });
    if (r.error || r.status !== 0) return { installed: false, version: null };
    const line = String(r.stdout).trim().split('\n')[0] || null;
    return { installed: true, version: /\d+\.\d+\.\d+[^\s]*/.exec(line ?? '')?.[0] ?? line };
  },

  async discovery(d, ctx) {
    const { api } = await d.connectApi(ctx);
    const [providers, models, agents, opencodeConfig] = await Promise.all([api.providers(), api.models(), api.agents(), api.getConfigSources()]);
    return { catalog: setupCatalog(d.buildCatalog, providers, models), agents, opencodeConfig: mergeOpencodeConfigSources(opencodeConfig) };
  },

  policyFor(d, ctx) {
    const loaded = d.loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const draft = d.loadDraft(ctx.dataDir);
    const policy = draft ? d.draftEffectiveConfig(draft, this.existingOf(loaded)).policy : loaded.config.policy;
    return { loaded, draft, policy };
  },

  emit(d, ctx, flags, view) {
    if (flags.json) ctx.json(redact(view));
    else ctx.out(d.renderOnboarding(view));
    return 0;
  },

  async state(ctx, { reconfigure }) {
    const d = await this.deps();
    const opencode = this.probeBinary(d, resolveOpencodeBin({ env: ctx.env, config: ctx.config }), ['--version'], ctx.env);
    const npmAvailable = this.probeBinary(d, 'npm', ['--version'], ctx.env).installed;
    const { loaded, draft, policy } = this.policyFor(d, ctx);
    let catalog = null;
    let serverError = null;
    if (opencode.installed || ctx.env.OPC_SERVER_URL) {
      try {
        const { api } = await d.connectApi(ctx);
        const [providers, models] = await Promise.all([api.providers(), api.models()]);
        catalog = setupCatalog(d.buildCatalog, providers, models);
      } catch (err) {
        if (err.code === 'SERVER_ERROR') throw err;
        serverError = `${err.code ?? 'ERROR'}: ${err.message}`;
      }
    }
    const onboarding = d.onboardingSummary({ hasGlobal: loaded.hasGlobal, draft, catalog, policy, opencode, npmAvailable, reconfigure, workspaceRoot: ctx.workspaceRoot, serverError });
    return { onboarding, text: d.renderOnboarding({ kind: 'state', onboarding }) };
  },

  async offlineState(ctx, { reconfigure, opencode }) {
    const d = await this.deps();
    const npmAvailable = this.probeBinary(d, 'npm', ['--version'], ctx.env).installed;
    const { loaded, draft, policy } = this.policyFor(d, ctx);
    const summary = d.onboardingSummary({
      hasGlobal: loaded.hasGlobal,
      draft,
      catalog: null,
      policy,
      opencode: opencode ?? detectOpencode(ctx.env),
      npmAvailable,
      reconfigure,
      workspaceRoot: ctx.workspaceRoot,
      serverError: 'Dados do servidor e provedores não consultados devido à falha no diagnóstico.',
    });
    const onboarding = { ...summary, connectedProviders: null, providerChoices: null, needsOtherProvider: null };
    return { onboarding, text: d.renderOnboarding({ kind: 'state', onboarding }) };
  },

  async models(ctx, argv) {
    const d = await this.deps();
    const { flags, positionals } = d.parseArgs(argv, {
      flags: { provider: { type: 'string' }, top: { type: 'number', default: 3 }, query: { type: 'string' }, json: { type: 'boolean' }, cwd: { type: 'string' } },
      allowPositionals: true,
    });
    if (!flags.provider || positionals.length) throw new d.UsageError('USAGE', 'uso: opc setup models --provider <id> [--top N] [--query texto|padrão] [--json]');
    if (!Number.isInteger(flags.top) || flags.top < 1 || flags.top > 50) throw new d.UsageError('USAGE', '--top deve ser um inteiro entre 1 e 50');
    const { catalog } = await this.discovery(d, ctx);
    if (!catalog.connected.has(flags.provider)) throw new d.UsageError('UNKNOWN_PROVIDER', `o provedor "${providerEcho(flags.provider)}" não está conectado`);
    const { policy } = this.policyFor(d, ctx);
    const view = {
      kind: 'models',
      provider: flags.provider,
      total: catalog.models.filter((m) => m.providerID === flags.provider).length,
      suggestions: d.suggestModels(catalog, flags.provider, { top: flags.top, policy }),
      aliases: d.suggestAliases(catalog, flags.provider, policy),
      families: d.modelFamilies(catalog, flags.provider),
    };
    if (flags.query) {
      view.query = flags.query;
      view.matches = d.searchModels(catalog, flags.query, { providerID: flags.provider });
    }
    return this.emit(d, ctx, flags, view);
  },

  async apply(ctx, argv) {
    const d = await this.deps();
    const { flags, positionals } = d.parseArgs(argv, { flags: { json: { type: 'boolean' }, stdin: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
    if (flags.stdin && positionals.length) {
      throw new d.UsageError('USAGE', "uso: opc setup apply [--json] ('<JSON parcial>' | --stdin); não combine --stdin com um payload posicional");
    }
    const text = flags.stdin ? await d.readStdin(ctx.stdin) : positionals.join(' ');
    if (!text.trim()) throw new d.UsageError('USAGE', "uso: opc setup apply [--json] ('<JSON parcial>' | --stdin)");
    let partial;
    try { partial = JSON.parse(text); } catch { throw new d.UsageError('INVALID_JSON', 'O payload informado não contém JSON válido.'); }
    const loaded = d.loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const draft = d.loadDraft(ctx.dataDir) ?? d.buildDraft({ hasGlobal: loaded.hasGlobal });
    const allowLocked = draft.mode === 'bootstrap' && !loaded.hasGlobal;
    const { catalog, agents } = await this.discovery(d, ctx);
    const result = d.applyDraftStep(draft, partial, { catalog, agents, existing: this.existingOf(loaded), allowLocked });
    d.saveDraft(ctx.dataDir, result.draft);
    return this.emit(d, ctx, flags, {
      kind: 'apply',
      draftPath: d.draftPath(ctx.dataDir),
      applied: result.applied,
      nextStep: result.nextStep,
      remainingSteps: d.remainingSteps(result.draft, { allowLocked }),
      warnings: result.warnings,
      draft: { mode: result.draft.mode, scope: result.draft.scope, completed: result.draft.completed },
    });
  },

  async commit(ctx, argv) {
    const d = await this.deps();
    const { flags, positionals } = d.parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
    if (positionals.length) throw new d.UsageError('USAGE', 'uso: opc setup commit [--json]');
    ensurePrivateDir(ctx.dataDir);
    return withLock(path.join(ctx.dataDir, 'config.lock'), { timeoutMs: 30000, purpose: 'setup-commit' }, async () => {
      const draft = d.loadDraft(ctx.dataDir);
      if (!draft) throw new d.UsageError('NO_DRAFT', 'nenhum rascunho de configuração para gravar; execute /opc:setup primeiro');
      const loaded = d.loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
      const allowLocked = draft.mode === 'bootstrap' && !loaded.hasGlobal;
      d.assertDraftComplete(draft, { allowLocked });
      const deps = await this.discovery(d, ctx);
      const result = d.commitDraft({
        dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot, draft, ...deps,
        existing: this.existingOf(loaded), allowLocked,
      });
      return this.emit(d, ctx, flags, { kind: 'commit', ...result });
    });
  },

  async discard(ctx, argv) {
    const d = await this.deps();
    const { flags } = d.parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: false });
    return this.emit(d, ctx, flags, { kind: 'discard', discarded: d.discardDraft(ctx.dataDir) });
  },
};

async function runCommand(ctx, argv) {
  const sub = argv[0];
  if (['models', 'apply', 'commit', 'discard'].includes(sub)) return SetupOnboarding[sub](ctx, argv.slice(1));
  const reconfigure = argv.includes('--reconfigure');
  const rest = argv.filter((a) => a !== '--reconfigure');
  const isF0Control = rest.some((a) => SETUP_PASSTHROUGH_FLAGS.includes(a)
    || a === '--force' || a === '--confirmed-by-user');
  if (isF0Control) return runDiagnostics(ctx, rest);

  // Run the F0 diagnostic exactly once before collecting optional onboarding details.
  // In particular, failed version/auth checks must keep their original report and boot count.
  let report;
  let output = '';
  const captured = {
    ...ctx,
    json: (value) => { report = value; },
    out: (value) => { output += value; },
  };
  const exitCode = await runDiagnostics(captured, rest);
  if (exitCode !== ExitCode.OK) {
    const { onboarding, text } = await SetupOnboarding.offlineState(ctx, { reconfigure, opencode: report?.opencode });
    if (report !== undefined) ctx.json({ ...report, onboarding });
    else ctx.out(`${output}${text}`);
    return exitCode;
  }

  const { onboarding, text } = await SetupOnboarding.state(ctx, { reconfigure });
  if (report !== undefined) ctx.json({ ...report, onboarding });
  else ctx.out(`${output}${text}`);
  return exitCode;
}
// ---- end F1 ----

export const run = f1Command(runCommand);
