// Preloaded into every `node --test` file process by scripts/run-tests.mjs. Once all tests of the file are done, a
// handle leaked by a test (a child whose t.after was skipped) must not keep the process alive forever. Unlike
// --test-force-exit, which exits as soon as the tests end and can drop results not yet sent to the runner (seen on
// Node 22/24), this exits only after a grace period and only if something still holds the event loop.
import { after } from 'node:test';

export const EXIT_GRACE_MS = 3000;

after(() => {
  setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
});
