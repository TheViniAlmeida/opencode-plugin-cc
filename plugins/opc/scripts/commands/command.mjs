import { join } from 'node:path';
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, requireAgent, resolveModel, profileRules } from '../lib/context.mjs';
import { assertCommandUsable } from '../lib/policy.mjs';
import {
  createJob, spawnWorker, waitForJob, readJob, updateJob, appendJobLog, assertNotInsideServer, withServerLock,
} from '../lib/jobs.mjs';
import { classifyError } from '../lib/errors.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderCommandResult, renderPermissionRequest } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';
import { createRequestBridge, createSerialUpdater } from './task-worker.mjs';
import { parseFullId } from '../lib/models.mjs';
import { safeOutputText } from '../lib/redact.mjs';
import { runTurn } from '../lib/runner.mjs';

const DEFAULT_COMMAND_TIMEOUT_SEC = 1800;
const SPEC = {
  flags: {
    agent: { type: 'string' }, model: { type: 'string', alias: 'm' }, variant: { type: 'string' },
    write: { type: 'boolean' }, background: { type: 'boolean' }, timeout: { type: 'number' },
    'wait-timeout': { type: 'number' }, json: { type: 'boolean' }, cwd: { type: 'string' },
    'raw-args-stdin': { type: 'boolean' },
  }, allowPositionals: true,
};

export function safeFailureMessage(value, rawArguments = '') {
  // remove the raw arguments before masking: masking first can split them so they no longer match
  const text = String(value ?? '');
  return safeOutputText(rawArguments ? text.split(rawArguments).join('***') : text);
}

function positiveSeconds(value, flag) {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) throw new UsageError('USAGE', `${flag} exige um número positivo de segundos`);
  return value;
}

export async function run(ctx, argv) {
  const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, SPEC);
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'informe o texto do stdin (--raw-args-stdin) ou argumentos posicionais, não ambos');
  let rawName;
  let args;
  if (raw.text !== null) {
    let text = raw.text;
    if (text.endsWith('\n')) text = text.slice(0, -1);
    text = text.replace(/^\s+/, '');
    const match = text.match(/^(\S+)([\s\S]*)$/);
    rawName = match?.[1];
    args = match?.[2] ?? '';
    if (args.startsWith(' ') || args.startsWith('\t')) args = args.slice(1);
  } else {
    rawName = positionals[0];
    args = positionals.slice(1).join(' ');
  }
  if (!rawName) throw new UsageError('NO_COMMAND', 'informe o comando OpenCode: /opc:command <cmd> [args] (veja /opc:catalog commands)');
  const name = rawName.replace(/^\//, '');
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(name)) {
    const preview = `${rawName.slice(0, 12)}${rawName.length > 12 ? '…' : ''}`;
    throw new UsageError('INVALID_COMMAND', `nome de comando inválido: ${preview}`);
  }
  const timeoutSec = positiveSeconds(flags.timeout, '--timeout') ?? DEFAULT_COMMAND_TIMEOUT_SEC;
  const waitTimeoutSec = positiveSeconds(flags['wait-timeout'], '--wait-timeout');
  assertNotInsideServer(ctx.env);
  const conn = await openApi(ctx);
  let commands;
  let discovery;
  try { [commands, discovery] = await Promise.all([conn.api.commands(), loadDiscovery(conn.api)]); }
  finally { conn.close(); }
  const cmd = (commands ?? []).find((entry) => entry.name === name);
  if (!cmd) {
    const names = (commands ?? []).map((entry) => entry.name).slice(0, 20).join(', ');
    throw new UsageError('UNKNOWN_COMMAND', `comando desconhecido: /${name}. Disponíveis: ${names || '(nenhum)'}`);
  }
  const policy = ctx.config.policy ?? {};
  assertCommandUsable(cmd, policy, new Map(discovery.agents.map((agent) => [agent.name, agent])));
  const agent = flags.agent ?? cmd.agent ?? ctx.config.defaultAgent ?? null;
  if (agent) requireAgent(discovery, agent, policy);
  const model = flags.model
    ? resolveModel(ctx, discovery, 'task', flags.model, { variant: flags.variant }).full
    : (cmd.model ?? resolveModel(ctx, discovery, 'task', null, { variant: flags.variant }).full);
  const profile = flags.write ? 'write' : 'read-only';
  const argumentsPreview = previewArguments(args);
  const argumentsBytes = Buffer.byteLength(args);
  const title = `OPC: command: /${name}`;
  const job = await withServerLock(ctx, () => createJob(ctx.stateDir, {
    kind: 'cmd', title, summary: `/${name}`, workspaceRoot: ctx.workspaceRoot,
    claudeSessionId: ctx.claudeSessionId, status: 'queued', agent, model, variant: flags.variant ?? null,
    permissionProfile: profile,
    request: { command: name, arguments: args, argumentsPreview, argumentsBytes, agent, model, variant: flags.variant ?? null,
      timeoutMs: timeoutSec * 1000, profile, rules: profileRules(ctx, profile), subtask: Boolean(cmd.subtask) },
  }, { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: 'register-job:cmd' });
  await spawnWorker(ctx, job.id);
  if (flags.background) {
    if (flags.json) ctx.json({ job: readJob(ctx.stateDir, job.id) ?? job });
    else ctx.out(`# opc command /${name}\n\nJob em segundo plano: ${job.id}\nAcompanhar: /opc:status ${job.id} --wait · resultado: /opc:result ${job.id}\n`);
    return ExitCode.OK;
  }
  const final = await waitForJob(ctx, job.id, {
    waitTimeoutMs: waitTimeoutSec ? waitTimeoutSec * 1000 : undefined,
    onLog: (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`),
  });
  if (flags.json) ctx.json({ job: final });
  else if (final.status === 'waiting_permission') ctx.out(renderPermissionRequest(final));
  else ctx.out(final.rendered ?? renderCommandResult(final.result ?? { command: name, argumentsPreview, argumentsBytes }));
  return exitCodeForJob(final);
}

export async function runWorker(ctx, job, request = job.request) {
  const { stateDir } = ctx;
  const now = () => new Date().toISOString();
  const policy = ctx.config.policy ?? {};
  const rawArguments = request.arguments ?? '';
  const safeMessage = (value) => safeFailureMessage(value, rawArguments);
  let conn;
  let release;
  try {
    conn = await openApi(ctx, { withHub: true, respawn: false });
    const { api, hub } = conn;
    const selected = parseFullId(request.model);
    const session = await api.createSession({ title: job.title, permissions: request.rules,
      model: { providerID: selected.providerID, id: selected.modelID }, ...(request.agent ? { agent: request.agent } : {}) });
    release = tryAcquireLock(join(stateDir, `session-${session.id}.lock`), { purpose: `job ${job.id}` });
    await updateJob(stateDir, job.id, { status: 'running', phase: 'running', startedAt: now(), sessionID: session.id });
    const updater = createSerialUpdater(stateDir, job.id);
    const bridge = createRequestBridge({ update: (patch) => updater.update(patch), jobId: job.id, stateDir, api,
      profileKind: request.profile, policy, timeoutMs: (policy.permissionTimeoutSec ?? 600) * 1000,
      log: (line) => appendJobLog(stateDir, job.id, line) });
    let outcome = null;
    let failure = null;
    try {
      outcome = await runTurn({ api, hub,
        request: { sessionID: session.id, model: selected, agent: request.agent ?? 'build',
          command: { name: request.command, text: request.arguments ?? '' },
          timeoutMs: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_SEC * 1000 },
        onPermission: (permission) => bridge.onPermission(permission),
        onQuestion: (question) => bridge.onQuestion(question),
        onRequestResolved: (resolved) => bridge.onResolved(resolved),
      });
    } catch (err) {
      failure = err;
    } finally { bridge.dispose(); await updater.flush(); }
    const latest = readJob(stateDir, job.id);
    const error = outcome?.error ?? (outcome?.status === 'failed' ? { type: outcome.errorType, message: outcome.errorMessage } : null);
    let patch;
    if (latest?.status === 'cancelled') patch = { status: 'cancelled' };
    else if (failure) patch = { status: 'failed', errorCode: failure.code === 'TIMEOUT' ? 'timeout' : (failure.code ?? 'error'), errorType: failure.code ?? failure.name, errorMessage: safeMessage(failure.message) };
    else if (error) {
      const classified = classifyError(error, { toolsRan: false });
      patch = { status: 'failed', errorClass: classified.errorClass, errorType: classified.errorType, errorMessage: safeMessage(classified.message) };
    } else patch = { status: 'completed' };
    const resultError = error
      ? { name: safeMessage(error.type ?? error.name ?? 'Error'), message: safeMessage(error.data?.message ?? error.message ?? '') }
      : (failure ? { name: safeMessage(failure.code ?? 'Error'), message: safeMessage(failure.message) } : null);
    const result = { status: patch.status, command: request.command, argumentsPreview: request.argumentsPreview ?? previewArguments(rawArguments),
      argumentsBytes: request.argumentsBytes ?? Buffer.byteLength(rawArguments), sessionID: session.id, model: request.model,
      agent: request.agent ?? null, finalText: safeOutputText(outcome?.finalText ?? ''), error: resultError };
    await updateJob(stateDir, job.id, { ...patch, phase: patch.status, completedAt: now(), pendingRequest: null,
      result, rendered: renderCommandResult(result) });
    return exitCodeForJob(patch);
  } catch (err) {
    const message = safeFailureMessage(err.message ?? String(err), rawArguments);
    const errorName = safeFailureMessage(err.code ?? err.name ?? 'Error', rawArguments);
    appendJobLog(stateDir, job.id, `[opc] falha no worker command: ${message}`);
    const latest = readJob(stateDir, job.id);
    if (latest && latest.status !== 'cancelled') await updateJob(stateDir, job.id, {
      status: 'failed', errorCode: err.code ?? 'error', errorMessage: message, completedAt: now(),
      result: { status: 'failed', command: request.command, argumentsPreview: request.argumentsPreview ?? previewArguments(rawArguments),
        argumentsBytes: request.argumentsBytes ?? Buffer.byteLength(rawArguments), sessionID: latest.sessionID ?? null,
        model: request.model ?? null, agent: request.agent ?? null, finalText: '', error: { name: errorName, message } },
      rendered: renderCommandResult({ status: 'failed', command: request.command, argumentsPreview: request.argumentsPreview ?? previewArguments(rawArguments),
        argumentsBytes: request.argumentsBytes ?? Buffer.byteLength(rawArguments), sessionID: latest.sessionID ?? null,
        model: request.model ?? null, agent: request.agent ?? null, error: { name: errorName, message } }),
    });
    return ExitCode.JOB_FAILED;
  } finally { release?.(); conn?.close(); }
}

function previewArguments(args) {
  const safe = safeOutputText(args);
  return safe.length > 200 ? `${safe.slice(0, 199)}…` : safe;
}
