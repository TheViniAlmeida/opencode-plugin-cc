import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFromDiscovery } from '../../plugins/opc/scripts/commands/conclave.mjs';
import { F3_PROVIDERS, F3_MODEL_CATALOG, F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';

test('conclave keeps selected models separate from the V2 API catalog', async () => {
  const api = {
    providers: async () => F3_PROVIDERS,
    models: async () => F3_MODEL_CATALOG,
    defaultModel: async () => ({ 'omniroute-personal': 'opencode-go/deepseek-v4.1-flash' }),
  };
  const result = await composeFromDiscovery(api, [F3_MODELS.deepseek, F3_MODELS.qwen],
    { config: F3_TEST_CONFIG, policy: F3_TEST_CONFIG.policy, mode: 'opinion' });
  assert.deepEqual(result.members.map((member) => member.full).sort(), [F3_MODELS.deepseek, F3_MODELS.qwen].sort());
});
