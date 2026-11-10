import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('F11 permissions document rule order, caller grants and user-only requests', () => {
  const permissions = read('docs/permissions.md');
  for (const term of ['extraAllow', 'SUBAGENT_DENIED', 'metadata.command', 'patterns', 'webfetch', 'websearch', 'prefixo']) {
    assert.ok(permissions.includes(term), term);
  }
  assert.match(permissions, /permissão desconhecida/i);
  const invariants = permissions.split('## Ordem final das regras e invariantes')[1].split('## Comandos destrutivos')[0];
  const order = ['external_directory * deny', 'grep * deny', 'shell <destrutivo> ask', 'read/grep/glob <sensível> deny', 'subagent <agente negado> deny', '<policy.tools.deny> * deny', 'browser * deny'];
  let previous = -1;
  for (const rule of order) {
    const index = invariants.indexOf(`\`${rule}\``);
    assert.ok(index > previous, `rule order: ${rule}`);
    previous = index;
  }
});

test('F11 permissions describe classifier categories and residual policy limits', () => {
  const permissions = read('docs/permissions.md');
  for (const term of ['git normalizado', 'env de execução', 'set', 'shopt', 'eval', 'source', 'trap', 'nameref', '~/.gitconfig', '.gnupg', 'LD_PRELOAD', '--output-directory', 'GIT_TERMINAL_PROMPT', 'GIT_TRACE', '4096', 'approver=user', 'approver=claude', 'policy.destructiveBash', 'confirmedByUser']) {
    assert.ok(permissions.includes(term), term);
  }
  assert.match(permissions, /melhor esforço/);
  assert.match(permissions, /não é fronteira de segurança/);
  assert.match(permissions, /profile restritivo/);
});

test('F11 configuration records all tighten-only keys and merge defenses', () => {
  const config = read('docs/configuration.md');
  const section = config.slice(config.indexOf('### Limites só de aperto'));
  for (const key of ['routing.fallback.maxAttempts', 'routing.fallback.maxProviderRetries', 'routing.fallback.maxRetryWaitSec', 'conclave.rounds', 'conclave.memberTimeoutSec', 'orchestrate.maxSubtasks']) {
    assert.ok(section.includes(key), key);
  }
  for (const term of ['__proto__', 'min(global ou default, workspace)', 'o workspace só pode apertar', 'stderr', '**/.npmrc', '**/.netrc', '**/.git-credentials', '**/.aws/credentials', '**/kubeconfig', '**/.kube/config']) {
    assert.ok(config.includes(term), term);
  }
});

test('F11 TTY docs state detection signals, escapes and platform limits', () => {
  const config = read('docs/configuration.md');
  for (const term of ['CLAUDECODE', 'ancestral', '/claude/versions/', '~/.claude/remote/ccd-cli/', '@anthropic-ai/claude-code', 'setsid', 'daemonização', 'tmux', 'screen', 'systemd-run', 'ssh localhost', 'at/cron', 'Windows', 'macOS']) {
    assert.ok(config.includes(term), term);
  }
  assert.match(config, /conveniência/);
  assert.match(config, /não prova[^\n]*humano/);
});

test('F11 command docs cover transfer masking, MCP boundaries and review result failures', () => {
  const commands = read('docs/commands.md');
  for (const term of ['maskSecretPatterns', 'user', 'assistant', 'tool_use', 'tool_result', 'confirmedByUser', 'destructiveHint', 'realpath', 'INVALID_CWD', 'frm_', 'UNEXPECTED_REDIRECT']) {
    assert.ok(commands.includes(term), term);
  }
  assert.match(commands, /result[^\n]*7/);
  assert.match(commands, /prompt de permissão do Claude Code/);
});

test('F11 troubleshooting names errors and distinguishes unreadable jobs from quarantine', () => {
  const troubleshooting = read('docs/troubleshooting.md');
  for (const code of ['SERVER_UNRESPONSIVE', 'ABORT_UNCONFIRMED', 'SHARE_AUTO', 'UNEXPECTED_REDIRECT', 'SUBAGENT_DENIED', 'READ_FAILED', 'INVALID_JSON']) {
    assert.ok(troubleshooting.includes(code), code);
  }
  for (const term of ['*.json.corrupt-<ms>', '30 dias', '(ilegível)', 'potencialmente ativos', 'não são movidos', '/opc:setup --stop-server --force', 'SSE']) {
    assert.ok(troubleshooting.includes(term), term);
  }
});

test('F11 changelog includes one numbered entry for each finding', () => {
  const section = read('CHANGELOG.md').split('### Corrigido — F11')[1]?.split('\n### ')[0];
  assert.ok(section, 'F11 changelog section');
  const entries = [...section.matchAll(/^- #([0-9]+) — /gm)].map((match) => Number(match[1]));
  assert.deepEqual(entries, Array.from({ length: 24 }, (_, index) => index + 1));
});

test('F11 report preserves finding origins and links executable evidence', () => {
  const report = read('docs/phases/F11-report.md');
  const plan = read('docs/superpowers/plans/2026-10-09-opc-F11-review-fixes.md');
  for (let number = 1; number <= 24; number += 1) {
    const source = plan.split('\n').find((line) => line.startsWith(`| ${number} |`));
    const row = report.split('\n').find((line) => line.startsWith(`| ${number} |`));
    assert.ok(row, `finding ${number}`);
    assert.equal(row.split('|')[2].trim(), source.split('|')[2].trim(), `origin ${number}`);
    assert.match(row, /\| (PASSOU|NÃO VALIDADO|N\/A) \|/);
    if (row.includes('| PASSOU |')) {
      assert.match(row, /tests\/(unit|integration)\/[^\s)`]+\.test\.mjs/);
    }
  }
  for (const match of report.matchAll(/`(tests\/(?:unit|integration)\/[^`]+\.test\.mjs)`/g)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, match[1])), match[1]);
  }
  assert.match(report, /## Decisões/);
  assert.match(report, /## Limitações conhecidas/);
  for (const term of ['fsync', 'TOCTOU', '4 KB', '8 chars', 'macOS', 'Windows', 'NÃO VALIDADO', 'N/A', 'Bearer', '16', 'READ_FAILED']) {
    assert.ok(report.includes(term), term);
  }
});

test('F11 report contains no personal absolute paths or email addresses', () => {
  const report = read('docs/phases/F11-report.md');
  assert.doesNotMatch(report, /\/home\/|\/storage\/|[A-Za-z]:\\Users\\/);
  assert.doesNotMatch(report, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(report, /omniroute-(?!personal)[a-z]/);
});
