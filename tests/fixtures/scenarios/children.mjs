import { withF3, seedSession, SEED } from '../f3-fake.mjs';

// Seed session with two child sessions (subagent-like), for `session children`.
export default withF3({
  setup(fake) {
    seedSession(fake);
    fake.createChildSession(SEED.session, { title: 'OPC: sub: #1 general: child one', agent: 'general' });
    fake.createChildSession(SEED.session, { title: 'OPC: sub: #2 explore: child two', agent: 'explore' });
  },
});
