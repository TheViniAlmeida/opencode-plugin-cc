// First /event connection emits server.instance.disposed and closes, like the real server does.
export default {
  onEventStream(fake, stream) {
    stream.sendConnected();
    if (stream.index === 1) {
      setTimeout(() => {
        stream.send({ type: 'server.instance.disposed', properties: { directory: '/fake' } });
        stream.close();
      }, 50);
    } else {
      stream.startHeartbeat();
    }
  },
};
