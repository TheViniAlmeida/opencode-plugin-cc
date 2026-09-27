import fs from 'node:fs';

export default {
  routes: {
    'GET /config': (fake) => {
      if (!fs.existsSync(`${fake.stateFile}.config-ok`)) {
        return { status: 500, body: { name: 'UnavailableError', data: { message: 'config temporarily unavailable' } } };
      }
      return undefined;
    },
  },
};
