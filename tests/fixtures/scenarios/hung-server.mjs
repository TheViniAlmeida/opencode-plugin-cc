// /global/health never answers in the process whose pid is written in `<stateFile>.hang`.
import fs from 'node:fs';

export default {
  routes: {
    'GET /global/health': (fake) => {
      let target = null;
      try {
        target = fs.readFileSync(`${fake.stateFile}.hang`, 'utf8').trim();
      } catch {
        return undefined;
      }
      if (target === String(process.pid)) return new Promise(() => {});
      return undefined;
    },
  },
};
