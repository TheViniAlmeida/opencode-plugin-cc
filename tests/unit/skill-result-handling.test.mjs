import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPermissionRequest } from '../../plugins/opc/scripts/lib/render.mjs';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'opc', 'skills', 'opc-result-handling', 'SKILL.md');

test('opc-result-handling quotes the exact requires-user label the renderer prints', () => {
  const job = {
    id: 'task-abc123-a1b2c3',
    status: 'waiting_permission',
    kind: 'task',
    pendingRequest: [{ id: 'per_1', type: 'permission', permission: 'bash', patterns: ['rm -rf build'], requiresUser: true }],
  };
  const rendered = renderPermissionRequest(job, { timeoutSec: 600 });
  const label = /- (Exige o usuário: sim)/.exec(rendered)?.[1];
  assert.ok(label, rendered);
  assert.ok(fs.readFileSync(SKILL, 'utf8').includes(`"${label}"`), 'SKILL.md must quote the renderer label verbatim');
});
