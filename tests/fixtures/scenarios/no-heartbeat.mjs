// First /event connection sends server.connected and then stays silent (no heartbeat).
export default {
  onEventStream(fake, stream) {
    stream.sendConnected();
    if (stream.index !== 1) stream.startHeartbeat();
  },
};
