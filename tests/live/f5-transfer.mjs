// Real import/export round trip, with synthetic history and isolated OpenCode storage.
// No provider request is made. OPC_LIVE_MODEL is recorded as session metadata only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { validateExportShape } from '../../plugins/opc/scripts/lib/transfer.mjs';
import { cliJson, makeTempDir, makeWorkspace, REPO_ROOT, stateDirFor, trackTempDir } from '../helpers.mjs';
import { appendSafeOutput, safeOutputText } from './_f3-lib.mjs';

const MODEL = process.env.OPC_LIVE_MODEL?.trim();
const SKIP = process.env.OPC_LIVE !== '1' ? 'OPC_LIVE!=1' : !MODEL && 'Informe OPC_LIVE_MODEL (provider/model).';
const REPORT = path.join(REPO_ROOT, 'docs/phases/F5-live-output.md');

test('F5 live: isolated transfer, session list and export preserve synthetic history', { skip: SKIP, timeout: 600_000 }, async (t) => {
  const root = trackTempDir(t, makeTempDir('opc-live-f5-transfer-'));
  fs.chmodSync(root, 0o700);
  const ws = makeWorkspace(t, { git: false, name: 'f5-transfer' });
  const home = path.join(root, 'home');
  const projects = path.join(home, '.claude', 'projects', 'synthetic');
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    OPC_DATA_DIR: path.join(root, 'opc'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], mcp: {}, provider: {} }),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
  for (const key of ['OPC_COMPANION_TRANSCRIPT_PATH', 'OPC_TRANSFER_ALLOWED_ROOT', 'OPC_SERVER_URL', 'OPC_SERVER_PASSWORD', 'CLAUDE_PLUGIN_DATA', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']) delete env[key];
  const marker = `OPC-F5-${Date.now()}`;
  const source = path.join(projects, 'session.jsonl');
  const record = (type, content, seconds, extra = {}) => ({
    type, sessionId: 'synthetic-f5-transfer', timestamp: `2026-10-03T10:00:0${seconds}.000Z`,
    message: { role: type, content }, ...extra,
  });
  const records = [
    { type: 'custom-title', customTitle: `live transfer ${marker}` },
    record('user', `Remember the code word ${marker}.`, 0),
    record('assistant', [{ type: 'text', text: `Noted: ${marker}.` }], 1),
    record('assistant', [{ type: 'tool_use', id: 'tool-synthetic', name: 'Read', input: { file_path: 'notes.md' } }], 2),
    record('user', [{ type: 'tool_result', tool_use_id: 'tool-synthetic', content: marker }], 3),
    record('user', 'What is the code word?', 4),
    record('assistant', [{ type: 'text', text: `The code word is ${marker}.` }], 5),
  ];
  fs.writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  const safe = (value) => safeOutputText(String(value), env.OPC_DATA_DIR).split(root).join('<isolated>').split(ws).join('<workspace>');
  const result = await cliJson(['transfer', '--source', source, '--model', MODEL], { env, cwd: ws, timeoutMs: 180_000 });
  assert.equal(result.code, 0, safe(result.stderr));
  const { sessionID } = result.data;
  assert.match(sessionID, /^ses_[0-9A-Za-z]+$/);
  assert.equal(result.data.messages.total, 4);
  const server = JSON.parse(fs.readFileSync(path.join(stateDirFor(env, ws), 'server.json'), 'utf8'));
  const request = async (apiPath) => {
    const response = await fetch(`${server.url}${apiPath}`, { headers: {
      authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`,
      'x-opencode-directory': ws,
    } });
    assert.equal(response.status, 200, `A consulta ${apiPath} falhou.`);
    return response.json();
  };
  const info = (await request(`/api/session/${sessionID}`)).data;
  assert.equal(info.id, sessionID);
  assert.equal(info.title, `OPC: transfer: live transfer ${marker}`);
  assert.equal(info.location.directory, ws);
  const messages = (await request(`/api/session/${sessionID}/message?order=asc&limit=50`)).data;
  const exported = { info, messages };
  assert.deepEqual(validateExportShape(exported), []);
  assert.equal(messages.length, 5);
  const texts = messages.flatMap((message) => [message.text, ...(message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text)].filter(Boolean));
  assert.ok(texts.includes(`Remember the code word ${marker}.`));
  assert.ok(texts.includes(`The code word is ${marker}.`));
  assert.ok(texts.some((text) => text.includes('Read') && text.includes('notes.md')));
  assert.ok(texts.some((text) => text.includes('resultado da ferramenta') && text.includes(marker)));
  const evidence = { sessionID, messages: messages.length, sessionLoaded: true, importShapeValid: true, storage: 'isolated', providerRequests: 0 };
  appendSafeOutput(REPORT, `### Transfer: round trip com armazenamento isolado\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n\n`, env.OPC_DATA_DIR);
  t.diagnostic(JSON.stringify(evidence));
});
