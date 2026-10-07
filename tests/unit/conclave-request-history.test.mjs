import assert from 'node:assert/strict';
import test from 'node:test';
import { promptRequestsFromState } from '../integration/_conclave-helpers.mjs';
import { kindOf } from '../fixtures/scenarios/_conclave-common.mjs';

test('conclave prompt inspection recovers text by message ID without changing request history', () => {
  const memberText = 'Question: private input\n"title": "ConclaveMember"';
  const debateText = 'Question: private input\n"title": "ConclaveDebate"';
  const state = {
    requests: [
      { method: 'POST', path: '/api/session/ses_one/prompt', body: { id: 'msg_member', text: '[REDACTED]' } },
      { method: 'POST', path: '/api/session/ses_one/prompt', body: { id: 'msg_debate', text: '[REDACTED]' } },
      { method: 'GET', path: '/api/session/ses_one/message', body: null },
    ],
    messages: { ses_one: [
      { id: 'msg_member', type: 'user', text: memberText },
      { id: 'msg_debate', type: 'user', text: debateText },
    ] },
  };

  const prompts = promptRequestsFromState(state);
  assert.deepEqual(prompts.map((request) => kindOf(request.body)), ['member', 'debate']);
  assert.deepEqual(prompts.map((request) => request.body.text), [memberText, debateText]);
  assert.deepEqual(state.requests.slice(0, 2).map((request) => request.body.text), ['[REDACTED]', '[REDACTED]']);
});
