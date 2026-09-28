#!/usr/bin/env node
// Stands in for `opencode` in attach --pane tests. Records argv and whether
// OPENCODE_SERVER_PASSWORD matches EXPECTED_SHA256 — never the value itself.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const passwordMatches = createHash('sha256').update(password).digest('hex') === process.env.EXPECTED_SHA256;
const passwordInArgv = password !== '' && process.argv.some((arg) => arg.includes(password));
appendFileSync(process.env.PROBE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), passwordMatches, passwordInArgv })}\n`);
