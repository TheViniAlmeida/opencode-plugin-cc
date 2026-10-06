// opc transfer: import a Claude transcript as a resumable OpenCode session.
import fs from 'node:fs';

import { parseArgs, shellQuote } from '../lib/args.mjs';
import { ExitCode, OpcError } from '../lib/opc-error.mjs';
import { redactOutput } from '../lib/redact.mjs';
import { renderTransfer } from '../lib/render.mjs';
import { ensurePrivateDir } from '../lib/state.mjs';
import { resolveOpencodeBin } from '../lib/server.mjs';
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
  try {
    imported = await runImport({ file, cwd: ctx.workspaceRoot, env: ctx.env, opencodeBin });
    if (imported.sessionID !== exported.info.id) {
      throw new OpcError('IMPORT_FAILED', 'O OpenCode informou um ID de sessão diferente do exportado.', { exitCode: ExitCode.JOB_FAILED });
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  const user = exported.messages.filter((message) => message.info.role === 'user').length;
  return redactOutput({
    sessionID: imported.sessionID,
    title: exported.info.title,
    model: resolvedModel.full,
    workspaceRoot: ctx.workspaceRoot,
    messages: { total: exported.messages.length, user, assistant: exported.messages.length - user },
    skipped: { ...conversion.stats.skipped, invalidLines: invalid },
    resumeCommand: `cd ${shellQuote(ctx.workspaceRoot)} && opencode -s ${imported.sessionID}`,
    warnings: [],
  });
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const result = await execute(ctx, { source: flags.source ?? null, model: flags.model ?? null });
  if (flags.json) ctx.json(result);
  else ctx.out(renderTransfer(result));
  return ExitCode.OK;
}
