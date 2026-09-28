import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

import {
  buildStopGatePrompt,
  lastAssistantTextFromTranscript,
  parseStopGateOutput,
} from '../../plugins/opc/scripts/commands/hook-stop.mjs';

test('parseStopGateOutput reads only an exact ALLOW:/BLOCK: first line', () => {
  assert.deepEqual(parseStopGateOutput('ALLOW: fine'), { kind: 'allow', reason: 'fine' });
  assert.deepEqual(parseStopGateOutput('\n\nBLOCK: bug in x\nmore detail'), { kind: 'block', reason: 'bug in x' });
  assert.deepEqual(parseStopGateOutput('BLOCK:'), { kind: 'block', reason: 'motivo não informado' });
  assert.equal(parseStopGateOutput('   ').kind, 'malformed');
  assert.equal(parseStopGateOutput(null).kind, 'malformed');
  assert.equal(parseStopGateOutput('Sure! ALLOW: x').kind, 'malformed');
  assert.equal(parseStopGateOutput('allow: x').kind, 'malformed');
  assert.equal(parseStopGateOutput('**BLOCK:** x').kind, 'malformed');
});

test('lastAssistantTextFromTranscript returns the last assistant text block', (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FIRST' }] } }),
    '{not json',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'LAST_MARKER' }, { type: 'tool_use', name: 'Edit' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
    '',
  ].join('\n'));
  assert.equal(lastAssistantTextFromTranscript(file), 'LAST_MARKER');
  assert.equal(lastAssistantTextFromTranscript(path.join(dir, 'missing.jsonl')), '');
  assert.equal(lastAssistantTextFromTranscript(''), '');
});

test('buildStopGatePrompt fills the message, repository context and the output contract', () => {
  const prompt = buildStopGatePrompt({ lastMessage: 'I edited math.js', repositoryContext: 'DIFF_CONTEXT', project: { goal: 'G' } });
  assert.match(prompt, /Resposta anterior do Claude:\nI edited math\.js/);
  assert.match(prompt, /<repository_context>\nDIFF_CONTEXT\n<\/repository_context>/);
  assert.match(prompt, /<project_context>\ngoal: G\n<\/project_context>/);
  assert.match(prompt, /- BLOCK: <motivo breve>/);
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  assert.match(buildStopGatePrompt({ lastMessage: '', repositoryContext: '' }), /Resposta anterior do Claude: \(indisponível\)/);
  assert.match(buildStopGatePrompt({ lastMessage: 'x'.repeat(60000), repositoryContext: 'r' }), /\[truncado\]/);
});
