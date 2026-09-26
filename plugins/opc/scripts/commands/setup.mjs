// `opc setup`: diagnostic + start/reuse of the workspace server (F0); `--stop-server` (spec §4, §5.5).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../lib/args.mjs';
import { globalConfigPath, workspaceConfigPath } from '../lib/config.mjs';
import { ExitCode, UsageError, toExitCode } from '../lib/opc-error.mjs';
import { renderSetup } from '../lib/render.mjs';
import { MIN_OPENCODE_VERSION, compareVersions, ensureServer, stopServer } from '../lib/server.mjs';
import { listActiveJobs } from '../lib/state.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = {
  flags: {
    json: { type: 'boolean' },
    'stop-server': { type: 'boolean' },
    force: { type: 'boolean' },
    'confirmed-by-user': { type: 'boolean' },
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
    return { installed: false, version: null, supported: null, detail: res.error.code === 'ENOENT' ? 'não encontrado no PATH' : res.error.message };
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

function serverContext(ctx) {
  return {
    stateDir: ctx.stateDir,
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    env: ctx.env,
    opencodeBin: 'opencode',
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
  };
}

const NEXT_STEP_BY_CODE = {
  AUTH_FAILED: 'O servidor recusou a senha (401). Rode `/opc:setup --stop-server` e depois `/opc:setup` de novo.',
  BOOT_FAILED: 'O servidor não subiu. Veja o server.log no diretório de estado e docs/troubleshooting.md.',
  UNSUPPORTED_VERSION: `Atualize o OpenCode para ${MIN_OPENCODE_VERSION} ou mais novo: npm install -g opencode-ai.`,
  TIMEOUT: 'Tempo esgotado. Tente de novo; se persistir, veja docs/troubleshooting.md (locks e boot lento).',
  INSECURE_SERVER_URL: 'Corrija OPC_SERVER_URL (http://127.0.0.1, http://localhost ou https://) ou remova a variável.',
  SERVER_DOWN: 'Servidor inacessível. Rode `/opc:setup` de novo.',
};

async function diagnose(ctx, flags) {
  const report = baseReport(ctx);
  const attach = Boolean(ctx.env.OPC_SERVER_URL);
  report.opencode = detectOpencode(ctx.env);
  let exitCode = ExitCode.OK;
  if (!attach && !report.opencode.installed) {
    report.server = { status: 'skipped', warnings: [] };
    report.nextSteps.push('Instale o OpenCode (npm install -g opencode-ai) e rode `/opc:setup` de novo.');
    exitCode = ExitCode.CONNECTION;
  } else if (!attach && report.opencode.supported === false) {
    report.server = {
      status: 'error',
      error: { code: 'UNSUPPORTED_VERSION', message: `OpenCode ${report.opencode.version} é anterior ao mínimo ${MIN_OPENCODE_VERSION}.` },
      warnings: [],
    };
    report.nextSteps.push(NEXT_STEP_BY_CODE.UNSUPPORTED_VERSION);
    exitCode = ExitCode.CONNECTION;
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
        sessionsBlocked: s.world?.shareBlocked ? 'share-auto' : null,
        warnings: s.warnings,
      };
      if (s.world?.shareBlocked) {
        report.nextSteps.push('Desligue o share automático: `server.configOverride.share = "disabled"` na config global do opc, ou `share: "manual"` no OpenCode.');
        exitCode = ExitCode.POLICY;
      }
    } catch (err) {
      report.server = { status: 'error', error: { code: err.code ?? 'INTERNAL', message: err.message }, warnings: [] };
      if (NEXT_STEP_BY_CODE[err.code]) report.nextSteps.push(NEXT_STEP_BY_CODE[err.code]);
      exitCode = toExitCode(err);
    }
  }
  if (!report.config.hasGlobal) report.nextSteps.push('Ainda não há config global do opc; o onboarding guiado chega na F1.');
  report.ready = exitCode === ExitCode.OK;
  if (flags.json) ctx.json(report);
  else ctx.out(renderSetup(report));
  return exitCode;
}

async function stop(ctx, flags) {
  const result = await stopServer(serverContext(ctx), { force: flags.force, confirmedByUser: flags['confirmed-by-user'] });
  const report = {
    mode: 'stop',
    stop: result,
    activeJobs: result.reason === 'active-jobs'
      ? listActiveJobs(ctx.stateDir).map((j) => ({ id: j.id, kind: j.kind, status: j.status, title: j.title ?? null }))
      : [],
  };
  if (flags.json) ctx.json(report);
  else ctx.out(renderSetup(report));
  return result.reason === 'active-jobs' ? ExitCode.USAGE : ExitCode.OK;
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  if ((flags.force || flags['confirmed-by-user']) && !flags['stop-server']) {
    throw new UsageError('USAGE', '--force e --confirmed-by-user só valem junto com --stop-server.');
  }
  if (flags['stop-server']) return stop(ctx, flags);
  return diagnose(ctx, flags);
}
