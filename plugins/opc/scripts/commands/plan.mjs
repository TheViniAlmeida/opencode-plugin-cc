// /opc:plan: read-only implementation plan (spec §10.1).
import { runKindCommand } from './task.mjs';

export async function run(ctx, argv) {
  return runKindCommand(ctx, argv, 'plan');
}
