import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAttempts } from '../../plugins/opc/scripts/lib/render.mjs';

test('renderAttempts is empty for zero or one attempt', () => {
  assert.equal(renderAttempts([]), '');
  assert.equal(renderAttempts([{ model: 'p/a', status: 'completed' }]), '');
  assert.equal(renderAttempts(undefined), '');
});

test('renderAttempts lists every attempt with its outcome and session', () => {
  const text = renderAttempts([
    { model: 'p/a', status: 'failed', errorClass: 'recoverable', errorType: 'APIError', sessionID: 'ses_1' },
    { model: 'p/b', status: 'completed', errorClass: null, errorType: null, sessionID: 'ses_2' },
  ]);
  assert.match(text, /## Tentativas \(2\)/);
  assert.match(text, /1\. `p\/a` — failed \(recoverable APIError\) — sessão `ses_1`/);
  assert.match(text, /2\. `p\/b` — concluída — sessão `ses_2`/);
});

test('renderAttempts tolerates attempts without session or error type', () => {
  const text = renderAttempts([{ model: 'p/a', status: 'failed', errorClass: 'fatal' }, { model: 'p/b', status: 'cancelled' }]);
  assert.match(text, /1\. `p\/a` — failed \(fatal\)\n/);
  assert.match(text, /2\. `p\/b` — cancelled\n/);
});
