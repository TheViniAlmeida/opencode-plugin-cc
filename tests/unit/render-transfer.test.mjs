import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderTransfer } from '../../plugins/opc/scripts/lib/render.mjs';

const result = {
  sessionID: 'ses_example', title: 'OPC: transfer: Fixture transfer', model: 'example/model',
  source: '/home/private-person/secret-transcript.jsonl',
  messages: { total: 4, user: 2, assistant: 2 },
  skipped: { meta: 1, sidechain: 2, command: 3, thinking: 4, other: 5, invalidLines: 6 },
  warnings: ['Texto truncado.'], resumeCommand: 'cd /tmp/fixture && opencode -s ses_example',
};

test('renderTransfer reports counts, warnings and resume command without disclosing the source', () => {
  const rendered = renderTransfer(result);
  assert.match(rendered, /^# opc transfer\n/);
  assert.match(rendered, /4 \(2 do usuário, 2 do assistente\)/);
  assert.match(rendered, /1 meta, 2 sidechain, 3 comandos locais, 4 blocos de raciocínio, 5 outros, 6 linhas inválidas/);
  assert.match(rendered, /Aviso: Texto truncado\./);
  assert.match(rendered, /    cd \/tmp\/fixture && opencode -s ses_example\n$/);
  assert.doesNotMatch(rendered, /private-person|secret-transcript|Origem:/);
});

test('renderTransfer masks credentials in every public text field', () => {
  const rendered = renderTransfer({ ...result, title: 'password=fixture-title-private', model: 'token=fixture-model-private', warnings: ['Bearer fixture-warning-private'], resumeCommand: 'secret=fixture-command-private' });
  assert.doesNotMatch(rendered, /fixture-(?:title|model|warning|command)-private/);
  assert.match(rendered, /\*\*\*/);
});
