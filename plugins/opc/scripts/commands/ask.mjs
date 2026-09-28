// /opc:ask: read-only question or analysis (spec §10.1).
import { runKindCommand } from './task.mjs';

export async function run(ctx, argv) {
  return runKindCommand(ctx, argv, 'ask');
}
