// First boot listens on a random port and announces it, so the port differs from the requested one.
export default {
  boot({ attempt }) {
    if (attempt === 1) return { listenPort: 0 };
    return undefined;
  },
};
