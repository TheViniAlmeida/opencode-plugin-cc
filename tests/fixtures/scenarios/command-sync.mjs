import { withF3, seedSession } from '../f3-fake.mjs';

// V2 /command returns 204 immediately; the turn finishes after FAKE_COMMAND_DELAY_MS.
export default withF3({
  setup(fake) {
    process.env.FAKE_COMMAND_DELAY_MS ??= '2000';
    seedSession(fake);
  },
});
