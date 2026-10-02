// F5: three pending permission requests seeded at boot, for the MCP approver/confirmation tests.
export const SESSION_ID = 'ses_mcpfixture0001';
export const DESTRUCTIVE_ID = 'per_mcpdestructive0001';
export const SAFE_ID = 'per_mcpsafe0001';
export const SENSITIVE_ID = 'per_mcpsensitive0001';

export default {
  setup(fake) {
    const base = { sessionID: SESSION_ID, metadata: {}, always: [] };
    fake.state.permissions[DESTRUCTIVE_ID] = { ...base, id: DESTRUCTIVE_ID, permission: 'bash', patterns: ['rm -rf build'] };
    fake.state.permissions[SAFE_ID] = { ...base, id: SAFE_ID, permission: 'bash', patterns: ['npm test'] };
    fake.state.permissions[SENSITIVE_ID] = { ...base, id: SENSITIVE_ID, permission: 'read', patterns: ['config/.env'] };
  },
};
