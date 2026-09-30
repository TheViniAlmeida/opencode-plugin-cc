// Helpers for the conclave integration tests (not a test file; the runner only collects *.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, testEnv, runCli, fakeRequests, writeGlobalConfig } from '../helpers.mjs';
export { fakeRequests };
export const PREFIX = 'omniroute-personal/opencode-go/';
export const DS = `${PREFIX}deepseek-v4.1-flash`;
export const QW = `${PREFIX}qwen3.8-max`;
export const KM = `${PREFIX}kimi-k3`;
export const TRIO = `${DS},${QW},${KM}`;
export const FORBIDDEN_NAMES = ['deepseek', 'qwen', 'kimi', 'omniroute', 'opencode-go', 'alibaba', 'moonshot'];
export function setupConclave(t, { scenario, config = null, git = true } = {}) {
  const cwd = makeWorkspace(t, { git });
  const env = testEnv(t, { scenario });
  if (config) writeGlobalConfig(env, config);
  return { env, cwd };
}
export async function conclave(args, { env, cwd, stdin = '', timeoutMs = 90_000 } = {}) {
  const res = await runCli(['conclave', ...args], { env, cwd, stdin, timeoutMs });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch {}
  return { ...res, json };
}
export function promptRequests(env) { return fakeRequests(env).filter((r) => r.method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(r.path)); }
export function sessionOfRequest(request) { return request.path.split('/')[2]; }
export function requestsBySchema(env, title) { return promptRequests(env).filter((r) => (r.body?.format?.schema?.title ?? null) === title); }
export function reviewRequests(env) { const titles = new Set(['ConclaveMember', 'ConclaveDebate', 'ConclaveSynthesis']); return promptRequests(env).filter((r) => !titles.has(r.body?.format?.schema?.title)); }
export function textOf(body) { return (body?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'); }
export function section(text, tag) { const start = text.indexOf(`<${tag}>`); const end = text.indexOf(`</${tag}>`); return start >= 0 && end > start ? text.slice(start, end) : ''; }
export function labelOf(pkg, full) { return pkg.composition.find((c) => c.model === full)?.label ?? null; }
export function writeReviewChanges(cwd) {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'calc.js'), 'export function mean(values) {\n  const count = values.length;\n  return values.reduce((a, b) => a + b, 0) / count;\n}\n');
  fs.writeFileSync(path.join(cwd, 'src', 'list.js'), 'export function last(items) {\n  for (let i = 0; i <= items.length; i++) {}\n  return items[items.length];\n}\n');
}
