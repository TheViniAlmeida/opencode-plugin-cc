export default {
  routes: {
    'GET /api/info': (_fake, { res }) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>OpenCode</body></html>');
      return 'handled';
    },
  },
};
