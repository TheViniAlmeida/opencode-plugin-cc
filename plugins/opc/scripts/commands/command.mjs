import { join } from 'node:path';
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, requireAgent, resolveModel, profileRules } from '../lib/context.mjs';
import { assertCommandUsable } from '../lib/policy.mjs';
import {
  createJob, spawnWorker, waitForJob, readJob, updateJob, appendJobLog, assertNotInsideServer, withServerLock,
} from '../lib/jobs.mjs';
import { newMessageId } from '../lib/runner.mjs';
import { classifyError } from '../lib/errors.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderCommandResult, renderPermissionRequest } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';
import { createRequestBridge, createSerialUpdater } from './task-worker.mjs';

const DEFAULT_COMMAND_TIMEOUT_SEC = 1800;
const SPEC = {
  flags: {
    agent: { type: 'string' }, model: { type: 'string', alias: 'm' }, variant: { type: 'string' },
    write: { type: 'boolean' }, background: { type: 'boolean' }, timeout: { type: 'number' },
    'wait-timeout': { type: 'number' }, json: { type: 'boolean' }, cwd: { type: 'string' },
    'raw-args-stdin': { type: 'boolean' },
  }, allowPositionals: true,
};

export function textFromParts(parts) {
  return (parts ?? []).filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => part.text ?? '').join('\n').trim();
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
    const match = raw.text.trim().match(/^(\S+)\s*([\s\S]*)$/);
    rawName = match?.[1];
    args = match?.[2] ?? '';
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
  const title = `OPC: command: /${name}${args ? ` ${args}` : ''}`.replace(/\s+/g, ' ').slice(0, 100);
  const job = await withServerLock(ctx, () => createJob(ctx.stateDir, {
    kind: 'cmd', title, summary: `/${name} ${args}`.trim().slice(0, 80), workspaceRoot: ctx.workspaceRoot,
    claudeSessionId: ctx.claudeSessionId, status: 'queued', agent, model, variant: flags.variant ?? null,
    permissionProfile: profile,
    request: { command: name, arguments: args, agent, model, variant: flags.variant ?? null,
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
  else ctx.out(final.rendered ?? renderCommandResult(final.result ?? { command: name, arguments: args }));
  return exitCodeForJob(final);
}

export async function runWorker(ctx, job, request = job.request) {
  const { stateDir } = ctx;
  const now = () => new Date().toISOString();
  const policy = ctx.config.policy ?? {};
  let conn;
  let release;
  try {
    conn = await openApi(ctx, { withHub: true, respawn: false });
    const { api, hub } = conn;
    const session = await api.createSession({ title: job.title, permission: request.rules });
    release = tryAcquireLock(join(stateDir, `session-${session.id}.lock`), { purpose: `job ${job.id}` });
    await updateJob(stateDir, job.id, { status: 'running', phase: 'running', startedAt: now(), sessionID: session.id });
    const updater = createSerialUpdater(stateDir, job.id);
    const bridge = createRequestBridge({ update: (patch) => updater.update(patch), jobId: job.id, stateDir, api,
      profileKind: request.profile, policy, timeoutMs: (policy.permissionTimeoutSec ?? 600) * 1000,
      log: (line) => appendJobLog(stateDir, job.id, line) });
    const bridgeError = (kind) => (err) => appendJobLog(stateDir, job.id, `[opc] falha na ponte de ${kind}: ${err.message}`);
    const untrack = hub.track(session.id, (event) => {
      const props = event?.properties ?? {};
      if (event?.type === 'permission.asked') bridge.onPermission(props).catch(bridgeError('permissões'));
      else if (event?.type === 'question.asked') bridge.onQuestion(props).catch(bridgeError('perguntas'));
      else if (event?.type === 'permission.replied') bridge.onResolved({ type: 'permission', requestID: props.requestID, sessionID: props.sessionID, outcome: props.reply }).catch(bridgeError('permissões'));
      else if (event?.type === 'question.replied' || event?.type === 'question.rejected') bridge.onResolved({ type: 'question', requestID: props.requestID, sessionID: props.sessionID, outcome: event.type === 'question.replied' ? 'replied' : 'rejected' }).catch(bridgeError('perguntas'));
    });
    let response = null;
    let failure = null;
    try {
      response = await api.runCommand(session.id, { command: request.command, arguments: request.arguments ?? '',
        agent: request.agent ?? undefined, model: request.model, variant: request.variant ?? undefined,
        messageID: newMessageId(), timeoutMs: request.timeoutMs });
    } catch (err) {
      failure = err;
      if (err.code === 'TIMEOUT') await api.abort(session.id).catch(() => {});
    } finally { untrack(); bridge.dispose(); await updater.flush(); }
    const latest = readJob(stateDir, job.id);
    const error = response?.info?.error ?? null;
    let patch;
    if (latest?.status === 'cancelled') patch = { status: 'cancelled' };
    else if (failure) patch = { status: 'failed', errorCode: failure.code === 'TIMEOUT' ? 'timeout' : (failure.code ?? 'error'), errorType: failure.code ?? failure.name, errorMessage: failure.message };
    else if (error) {
      const classified = classifyError(error, { toolsRan: false });
      patch = { status: 'failed', errorClass: classified.errorClass, errorType: classified.errorType, errorMessage: classified.message };
    } else patch = { status: 'completed' };
    const result = { command: request.command, arguments: request.arguments ?? '', sessionID: session.id, model: request.model,
      agent: request.agent ?? null, finalText: textFromParts(response?.parts), error: error ?? (failure ? { name: failure.code ?? 'Error', message: failure.message } : null) };
    await updateJob(stateDir, job.id, { ...patch, phase: patch.status, completedAt: now(), pendingRequest: null,
      result, rendered: renderCommandResult(result) });
    return exitCodeForJob(patch);
  } catch (err) {
    appendJobLog(stateDir, job.id, `[opc] falha no worker command: ${err.message}`);
    const latest = readJob(stateDir, job.id);
    if (latest && latest.status !== 'cancelled') await updateJob(stateDir, job.id, {
      status: 'failed', errorCode: err.code ?? 'error', errorMessage: err.message, completedAt: now(),
    });
    return ExitCode.JOB_FAILED;
  } finally { release?.(); conn?.close(); }
}
