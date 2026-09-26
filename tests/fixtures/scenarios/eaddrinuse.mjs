// The first FAKE_FAIL_BOOTS boots (default 2) die with EADDRINUSE.
export default {
  boot({ attempt, port, env }) {
    const fails = Number(env.FAKE_FAIL_BOOTS ?? 2);
    if (attempt <= fails) {
      return { exitCode: 1, stderr: `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n` };
    }
    return undefined;
  },
};
