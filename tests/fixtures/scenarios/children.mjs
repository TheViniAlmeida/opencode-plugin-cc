import { withF3, seedSession, createSessionRecord, SEED } from '../f3-fake.mjs';

// Seed session with two child sessions (subagent-like), for `session children`.
export default withF3({
  setup(fake) {
    seedSession(fake);
    createSessionRecord(fake, { parentID: SEED.session, title: 'OPC: sub: #1 general: child one', agent: 'general' });
    createSessionRecord(fake, { parentID: SEED.session, title: 'OPC: sub: #2 explore: child two', agent: 'explore' });
  },
});
