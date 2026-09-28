// Shared helpers for F2b live tests. Uses F2a's tracked disposable workspace and cleanup.
import fs from 'node:fs';
import path from 'node:path';

import { LIVE_MODEL, LIVE_SKIP as F2A_LIVE_SKIP, LIVE_TIMEOUT_MS, liveSetup, opcLive } from './_f2a-helpers.mjs';

export { LIVE_MODEL, LIVE_TIMEOUT_MS };
export const LIVE_SKIP = F2A_LIVE_SKIP;

export const MATH_BASE = [
  'export function sum(values) {',
  '  let total = 0;',
  '  for (let i = 0; i < values.length; i += 1) total += values[i];',
  '  return total;',
  '}',
  '',
].join('\n');

export const MATH_PLANTED = [
  'export function sum(values) {',
  '  let total = 0;',
  '  for (let i = 0; i <= values.length; i += 1) total += values[i];',
  '  return total;',
  '}',
  '',
  'export function average(values) {',
  '  return sum(values) / values.length;',
  '}',
  '',
  'export function divide(a, b) {',
  '  return a / 0;',
  '}',
  '',
].join('\n');

export function livePrepare(t, { config = {}, extra = {} } = {}) {
  const ctx = liveSetup(t, { files: { 'src/math.js': MATH_BASE } });
  Object.assign(ctx.env, extra);
  const configPath = path.join(ctx.env.OPC_DATA_DIR, 'config.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...current, reviewModel: LIVE_MODEL, ...config }, null, 2)}\n`, { mode: 0o600 });
  return { cwd: ctx.cwd, env: ctx.env, dataDir: ctx.env.OPC_DATA_DIR };
}

export function plantBug(cwd) {
  fs.writeFileSync(path.join(cwd, 'src', 'math.js'), MATH_PLANTED);
}

export function liveCli(ctx, args, options = {}) {
  return opcLive(ctx, args, options);
}
