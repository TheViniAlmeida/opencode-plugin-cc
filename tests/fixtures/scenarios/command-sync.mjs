import { withF3, seedSession } from '../f3-fake.mjs';

// Synchronous /command: the base F3 route answers after FAKE_COMMAND_DELAY_MS (default here 2000 ms),
// which must exceed a short server.requestTimeoutSec to prove the long timeout is used.
export default withF3({
  setup(fake) {
    process.env.FAKE_COMMAND_DELAY_MS ??= '2000';
    seedSession(fake);
  },
});
