#!/usr/bin/env node
// Stands in for `opencode` in attach --pane tests. Records argv and whether
// OPENCODE_SERVER_PASSWORD matches EXPECTED_SHA256 — never the value itself.
import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

if (process.argv[2] === 'serve') {
  await import('./bin/opencode');
} else {
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
  const passwordMatches = createHash('sha256').update(password).digest('hex') === process.env.EXPECTED_SHA256;
  const passwordInArgv = password !== '' && process.argv.some((arg) => arg.includes(password));
  const args = process.argv.slice(2);
  const redactedArgs = args.map((arg, index) => {
    if ((password && arg === password) || (/^(--password|-p)$/.test(args[index - 1] ?? '') && arg) || /:\/\/[^/@\s]*:[^/@\s]*@/.test(arg)) return '***';
    return arg;
  });
  const fd = openSync(process.env.PROBE_LOG, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify({ argv: redactedArgs, passwordMatches, passwordInArgv })}\n`);
  } finally {
    closeSync(fd);
  }

}
