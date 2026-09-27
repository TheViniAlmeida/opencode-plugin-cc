// /global/health reports the version written in `<stateFile>.version` (simulates an OpenCode upgrade).
import fs from 'node:fs';

export default {
  routes: {
    'GET /global/health': (fake) => {
      try {
        const version = fs.readFileSync(`${fake.stateFile}.version`, 'utf8').trim();
        return { body: { healthy: true, version } };
      } catch {
        return undefined;
      }
    },
  },
};
