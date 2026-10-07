import fs from 'node:fs';

export default {
  routes: {
    'GET /api/config': (fake) => {
      if (!fs.existsSync(`${fake.stateFile}.config-ok`)) {
        return { status: 500, body: { _tag: 'UnavailableError', message: 'Configuração temporariamente indisponível' } };
      }
      return undefined;
    },
  },
};
