// Every boot waits FAKE_BOOT_DELAY_MS (default 3000) before listening.
export default {
  boot({ env }) {
    return { delayMs: Number(env.FAKE_BOOT_DELAY_MS ?? 3000) };
  },
};
