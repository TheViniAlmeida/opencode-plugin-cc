// F5: three pending permission requests seeded at boot, for the MCP approver/confirmation tests.
export const DESTRUCTIVE_ID = 'per_mcpdestructive0001';
export const SAFE_ID = 'per_mcpsafe0001';
export const SENSITIVE_ID = 'per_mcpsensitive0001';

export default {
  setup(fake) {
    const session = fake.createSession({ title: 'OPC: solicitações MCP', permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
    const base = { sessionID: session.id, save: [], source: { type: 'tool', messageID: 'msg_mcp', id: 'call_mcp' } };
    fake.state.permissions[DESTRUCTIVE_ID] = { ...base, id: DESTRUCTIVE_ID, action: 'shell', resources: ['rm -rf build'] };
    fake.state.permissions[SAFE_ID] = { ...base, id: SAFE_ID, action: 'shell', resources: ['npm test'] };
    fake.state.permissions[SENSITIVE_ID] = { ...base, id: SENSITIVE_ID, action: 'read', resources: ['config/.env'] };
  },
};
