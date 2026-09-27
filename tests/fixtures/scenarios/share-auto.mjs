// GET /config reports share:"auto" even with OPENCODE_CONFIG_CONTENT (override not effective).
export default {
  routes: {
    'GET /config': (fake) => ({ body: { ...fake.baseConfig, ...fake.configOverride, share: 'auto' } }),
  },
};
