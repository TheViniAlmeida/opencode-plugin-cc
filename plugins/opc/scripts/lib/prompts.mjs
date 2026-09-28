// The single home of the text/prompt helpers (F2b; summarize and sessionTitle moved from F2a commands/task.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExitCode, OpcError } from './opc-error.mjs';

export const PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));
export const SCHEMAS_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));

const LEADING_COMMENT = /^\s*<!--[\s\S]*?-->\s*/;
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

// Accepts 'ask' or 'ask.md' (the F2a callers pass the file name).
export function loadPrompt(name, { dir = PROMPTS_DIR } = {}) {
  const file = name.endsWith('.md') ? name : `${name}.md`;
  return fs.readFileSync(path.join(dir, file), 'utf8').replace(LEADING_COMMENT, '');
}

// Single pass: substituted values are never re-expanded. A placeholder without a value becomes ''
// or, with { strict: true }, a TEMPLATE_UNFILLED error listing the missing keys.
export function fillTemplate(template, vars = {}, { strict = false } = {}) {
  const missing = new Set();
  const text = template.replace(PLACEHOLDER, (_, key) => {
    if (Object.hasOwn(vars, key) && vars[key] != null) return String(vars[key]);
    missing.add(key);
    return '';
  });
  if (strict && missing.size) {
    throw new OpcError('TEMPLATE_UNFILLED', `modelo sem valor para os campos: ${[...missing].join(', ')}`, {
      exitCode: ExitCode.JOB_FAILED,
    });
  }
  return text;
}

export function loadSchema(name, { dir = SCHEMAS_DIR } = {}) {
  const { $schema, $comment, ...schema } = JSON.parse(fs.readFileSync(path.join(dir, `${name}.schema.json`), 'utf8'));
  return schema;
}

// Same output as the F2a helper (lowercase keys), so task/ask/plan prompts do not change.
export function projectContextBlock(project) {
  if (!project || typeof project !== 'object') return '';
  const lines = [];
  if (typeof project.goal === 'string' && project.goal.trim()) lines.push(`goal: ${project.goal.trim()}`);
  if (Array.isArray(project.scope) && project.scope.length) lines.push(`scope: ${project.scope.join(', ')}`);
  if (Array.isArray(project.taskTypes) && project.taskTypes.length) lines.push(`task types: ${project.taskTypes.join(', ')}`);
  return lines.length ? `<project_context>\n${lines.join('\n')}\n</project_context>` : '';
}

export function summarize(text, max = 56) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function sessionTitle(kind, summary) {
  return `OPC: ${kind}: ${summary}`;
}
