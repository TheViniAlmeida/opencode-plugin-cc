// First /event connection sends server.connected and drops after 50 ms; later ones behave normally.
export default {
  onEventStream(fake, stream) {
    stream.sendConnected();
    if (stream.index === 1) setTimeout(() => stream.close(), 50);
    else stream.startHeartbeat();
  },
};
