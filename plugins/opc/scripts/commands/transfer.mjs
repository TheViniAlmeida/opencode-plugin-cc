// opc transfer: import a Claude transcript as a resumable OpenCode session.
import fs from 'node:fs';

import { parseArgs, shellQuote } from '../lib/args.mjs';
import { ExitCode, OpcError } from '../lib/opc-error.mjs';
import { redactOutput } from '../lib/redact.mjs';
import { renderTransfer, safeResumeCommand } from '../lib/render.mjs';
import { ensurePrivateDir } from '../lib/state.mjs';
import { attachSecretPath, ensureServer, resolveOpencodeBin } from '../lib/server.mjs';
import { serverContext } from '../lib/jobs.mjs';
import { persistManagedAttachSecret } from './attach.mjs';
import {
  buildExport, convertClaudeRecords, detectOpencodeVersion, readTranscript,
  resolveTranscriptPath, resolveTransferModel, runImport, validateExportShape, writeExportFile,
} from '../lib/transfer.mjs';

const SPEC = {
  flags: {
    source: { type: 'string' },
    model: { type: 'string', alias: 'm' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
};

export async function execute(ctx, { source = null, model = null } = {}) {
  const options = { env: ctx.env, cwd: ctx.cwd };
  const opencodeBin = resolveOpencodeBin({ env: ctx.env, config: ctx.config });
  const transcript = resolveTranscriptPath({ source, ...options });
  const resolvedModel = resolveTransferModel({ flag: model, config: ctx.config });
  // Revalidate and read the source before invoking OpenCode, including --version.
  const { records, invalid } = await readTranscript(transcript, options);
  const conversion = convertClaudeRecords(records);
  if (conversion.turns.length === 0) {
    throw new OpcError('EMPTY_TRANSCRIPT', 'A transcrição do Claude não contém texto do usuário nem do assistente para transferir.', { exitCode: ExitCode.USAGE });
  }
  const version = await detectOpencodeVersion({ env: ctx.env, opencodeBin });
  const exported = buildExport(conversion, { model: resolvedModel, directory: ctx.workspaceRoot, version });
  const errors = validateExportShape(exported);
  if (errors.length) {
    throw new OpcError('EXPORT_SHAPE_INVALID', 'A exportação gerada não corresponde ao formato do OpenCode.', { exitCode: ExitCode.JOB_FAILED });
  }
  ensurePrivateDir(ctx.stateDir);
  const file = writeExportFile(ctx.stateDir, exported);
  let imported;
  let server;
  try {
    server = await ensureServer(serverContext(ctx));
    imported = await runImport({ file, cwd: ctx.workspaceRoot,
      env: ctx.env, password: server.password, serverUrl: server.url, opencodeBin });
    if (imported.sessionID !== exported.info.id) {
      throw new OpcError('IMPORT_FAILED', 'O OpenCode informou um ID de sessão diferente do exportado.', { exitCode: ExitCode.JOB_FAILED });
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  // The resume line reads the password from a source instead of embedding it in argv.
  // The session already exists at this point: a failure to persist the secret must not hide its ID (a retry would
  // import the transcript again), so it degrades to a warning without the resume line.
  const warnings = [];
  let passwordFrom = null;
  if (server.attached) passwordFrom = '"$OPC_SERVER_PASSWORD"';
  else {
    try {
      await persistManagedAttachSecret(ctx, server);
      passwordFrom = `"$(cat ${shellQuote(attachSecretPath(ctx.stateDir))})"`;
    } catch (err) {
      warnings.push(`A sessão foi importada, mas a linha de retomada não pôde ser gerada (${err.code ?? 'erro desconhecido'}). Não rode o transfer de novo (duplicaria a sessão): use /opc:attach ${imported.sessionID} para obter uma linha de retomada.`);
    }
  }
  const user = exported.messages.filter((message) => message.type === 'user').length;
  const assistant = exported.messages.filter((message) => message.type === 'assistant').length;
  const result = {
    sessionID: imported.sessionID,
    title: exported.info.title,
    model: resolvedModel.full,
    workspaceRoot: ctx.workspaceRoot,
    messages: { total: user + assistant, user, assistant },
    skipped: { ...conversion.stats.skipped, invalidLines: invalid },
    resumeCommand: passwordFrom === null ? null : `cd ${shellQuote(ctx.workspaceRoot)} && OPENCODE_SERVER_PASSWORD=${passwordFrom} ${shellQuote(opencodeBin)} --server ${shellQuote(server.url)} -s ${imported.sessionID}`, // scan-secrets:allow (template, no secret value)
    warnings,
  };
  // The attach-mode variable reference must survive pattern masking; registered secrets are still redacted.
  const safe = redactOutput(result);
  return { ...safe, resumeCommand: result.resumeCommand === null ? null : safeResumeCommand(result.resumeCommand) };
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const result = await execute(ctx, { source: flags.source ?? null, model: flags.model ?? null });
  if (flags.json) ctx.json(result);
  else ctx.out(renderTransfer(result));
  return ExitCode.OK;
}
