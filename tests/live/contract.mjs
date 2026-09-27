#!/usr/bin/env node
// Contract check: records the real shapes of the endpoints/events opc uses and diffs them against the fake.
// Run: OPC_LIVE=1 node tests/live/contract.mjs [--write]   (exit 1 on divergence in used fields)
// Probe registry: PROBES/EVENT_TYPES live in tests/fixtures/contract-shapes.mjs; each phase APPENDS entries there
// (and to the fake) for the endpoints it starts using. This file is the only contract runner.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { clientFor, ensureServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { EventHub } from '../../plugins/opc/scripts/lib/sse.mjs';
import { ensurePrivateDir, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { EVENT_TYPES, PROBES, diffShapes, shapeOf } from '../fixtures/contract-shapes.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { REPO_ROOT, makeTempDir, createServerCleanup } from '../helpers.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('contract: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

async function collect(client, sseClient) {
  const shapes = {};
  for (const probe of PROBES) {
    const body = await client.request(probe.method, probe.path);
    // Both real and fake responses pass through this same pruning before snapshots/diffs.
    shapes[probe.name] = shapeOf(body, probe.name);
  }
  const hub = new EventHub({ client: sseClient });
  const seen = {};
  hub.onAny((e) => {
    if (EVENT_TYPES.includes(e.type) && !seen[e.type]) seen[e.type] = shapeOf(e, `event.${e.type}`);
  });
  await hub.start();
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline && EVENT_TYPES.some((t) => !seen[t])) await new Promise((r) => setTimeout(r, 200));
  hub.stop();
  for (const type of EVENT_TYPES) shapes[`event:${type}`] = seen[type] ?? 'não recebido';
  return shapes;
}

const base = makeTempDir('opc-contract-');
const cleanup = createServerCleanup(base);
const ws = path.join(base, 'contract-project');
fs.mkdirSync(ws);
execFileSync('git', ['init', '-q'], { cwd: ws });
const dataDir = path.join(base, 'data');
ensurePrivateDir(path.join(dataDir, 'state'));
const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, ws));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPC_SERVER_|OPENCODE_SERVER_|FAKE_)/.test(k)));
const ctx = cleanup.track({ stateDir, workspaceRoot: ws, config: mergeConfig({}, null).config, env });
let exitCode = 0;
let fake = null;
try {
  const server = await ensureServer(ctx);
  const realClient = clientFor(ctx, server);
  const real = await collect(realClient, realClient);
  fake = await startFake({ port: 0, password: 'contract-fake-password-01', heartbeatMs: 1000 });
  const fakeClient = createClient({ baseUrl: fake.url, password: 'contract-fake-password-01', directory: ws });
  const fakeShapes = await collect(fakeClient, fakeClient);
  const report = { version: server.version, date: new Date().toISOString(), divergences: {} };
  for (const probe of PROBES) {
    const d = diffShapes(real[probe.name], fakeShapes[probe.name], probe.used, probe.optionalUsed);
    if (d.length) report.divergences[probe.name] = d;
  }
  for (const type of EVENT_TYPES) {
    const d = diffShapes(real[`event:${type}`], fakeShapes[`event:${type}`], ['id', 'type', 'properties']);
    if (d.length) report.divergences[`event:${type}`] = d;
  }
  const snapshotDir = path.join(REPO_ROOT, 'tests', 'fixtures', 'contract');
  if (process.argv.includes('--write')) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, `opencode-${server.version}.shapes.json`), `${JSON.stringify(real, null, 2)}\n`);
  }
  const count = Object.keys(report.divergences).length;
  console.log(`# Contrato OpenCode ${server.version} × fake\n`);
  if (count === 0) console.log('Sem divergências nos campos usados.');
  for (const [name, list] of Object.entries(report.divergences)) {
    console.log(`## ${name}`);
    for (const p of list) console.log(`- ${p.field}: real=${p.real} fake=${p.fake}`);
  }
  exitCode = count === 0 ? 0 : 1;
} catch (err) {
  console.error(`contract: erro ${err.code ?? ''} ${err.message}`);
  exitCode = 2;
} finally {
  try {
    await cleanup.finish(fake ? [() => fake.close()] : []);
  } catch (err) {
    console.error(`contract: ${err.message}`);
    exitCode = 2;
  }
}
process.exit(exitCode);
