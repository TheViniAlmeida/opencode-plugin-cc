// /api/info reports the version written in `<stateFile>.version`.
import fs from 'node:fs';

export default {
  routes: {
    'GET /api/info': (fake) => {
      try {
        const version = fs.readFileSync(`${fake.stateFile}.version`, 'utf8').trim();
        return { body: { version, pid: process.pid, urls: [fake.url], paths: { tmp: '<tmp>' } } };
      } catch {
        return undefined;
      }
    },
  },
};
