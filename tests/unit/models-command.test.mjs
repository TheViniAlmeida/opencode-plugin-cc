import test from 'node:test';
import assert from 'node:assert/strict';

import { providerEcho } from '../../plugins/opc/scripts/commands/models.mjs';

test('models: unknown provider echo is limited to 12 characters plus ellipsis', () => {
  assert.equal(providerEcho('abcdefghijklmnop-provider'), 'abcdefghijkl…');
  assert.equal(providerEcho('short'), 'short…');
  assert.match(`provider desconhecido "${providerEcho('a-very-long-unrecognized-provider-name')}"`, /provider desconhecido "a-very-long-…"/);
});
