import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { renderTransfer, safeResumeCommand } from '../../plugins/opc/scripts/lib/render.mjs';

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
  assert.match(rendered, /    cd \/tmp\/fixture && opencode -s ses_example\n\nA linha lê a senha do servidor sem expô-la na linha de comando\.\n$/);
  assert.doesNotMatch(rendered, /private-person|secret-transcript|Origem:/);
});

test('renderTransfer masks credentials in every public text field', () => {
  const rendered = renderTransfer({ ...result, title: 'password=fixture-title-private', model: 'token=fixture-model-private', warnings: ['Bearer fixture-warning-private'], resumeCommand: 'secret=fixture-command-private' });
  assert.doesNotMatch(rendered, /fixture-(?:title|model|warning|command)-private/);
  assert.match(rendered, /\*\*\*/);
});

test('renderTransfer omits the resume block when there is no resume command', () => {
  const rendered = renderTransfer({ ...result, resumeCommand: null, warnings: ['Use /opc:attach.'] });
  assert.match(rendered, /Sessão OpenCode criada: `ses_example`/);
  assert.match(rendered, /Aviso: Use \/opc:attach\./);
  assert.doesNotMatch(rendered, /Para retomar no terminal|null/);
});

const ATTACH_REF = 'OPENCODE_SERVER_PASSWORD="$OPC_SERVER_PASSWORD"';

test('renderTransfer keeps the attach-mode variable reference verbatim and still masks the rest', () => {
  registerSecret('fixture-registered-secret-1');
  const command = `cd /w && ${ATTACH_REF} opencode --server http://x -s ses_x`;
  const rendered = renderTransfer({ ...result, resumeCommand: command });
  assert.ok(rendered.includes(`    ${command}\n`), rendered);
  const masked = renderTransfer({
    ...result,
    title: 'password=fixture-title-private',
    resumeCommand: `cd /fixture-registered-secret-1/w && ${ATTACH_REF} opencode --server http://x -s ses_x`,
  });
  assert.ok(masked.includes(`${ATTACH_REF} opencode --server`), masked);
  assert.doesNotMatch(masked, /fixture-title-private|fixture-registered-secret-1/);
});

test('safeResumeCommand keeps the exact literal and masks around it', () => {
  registerSecret('fixture-registered-secret-2');
  assert.equal(safeResumeCommand(`a ${ATTACH_REF} b`), `a ${ATTACH_REF} b`);
  const adjacent = safeResumeCommand(`token=fixture-adjacent-private ${ATTACH_REF} secret=fixture-after-private`);
  assert.ok(adjacent.includes(ATTACH_REF));
  assert.doesNotMatch(adjacent, /fixture-(?:adjacent|after)-private/);
  const inPath = safeResumeCommand(`cd /home/fixture-registered-secret-2/ws && ${ATTACH_REF} opencode`);
  assert.ok(inPath.includes(ATTACH_REF));
  assert.doesNotMatch(inPath, /fixture-registered-secret-2/);
});
