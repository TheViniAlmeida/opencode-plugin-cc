// GET /config reports share:"auto" even with OPENCODE_CONFIG_CONTENT (override not effective).
export default {
  routes: {
    'GET /api/config': (fake) => ({ body: [{ type: 'document', info: { ...fake.baseConfig, ...fake.configOverride, share: 'auto' } }] }),
  },
};
