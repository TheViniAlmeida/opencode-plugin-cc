import { parseArgs } from '../lib/args.mjs';
import { ExitCode } from '../lib/opc-error.mjs';
import { openApi } from '../lib/context.mjs';
import { renderSessions } from '../lib/render.mjs';
import { maskDeep } from '../lib/redact.mjs';
import { serverDirectory } from '../lib/remote.mjs';

const SPEC = {
  flags: {
    all: { type: 'boolean' },
    limit: { type: 'number', default: 30 },
    refresh: { type: 'boolean' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
};

// `directory` é o diretório do workspace como o servidor o vê (a raiz remota em attach com mapeamento).
export function isOpcSession(session, directory) {
  return typeof session.title === 'string'
    && session.title.startsWith('OPC: ')
    && !session.parentID
    && (!session.location?.directory || session.location.directory === directory);
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const conn = await openApi(ctx);
  try {
    const { api, server } = conn;
    const directory = serverDirectory({ workspaceRoot: ctx.workspaceRoot, env: ctx.env, config: ctx.config, attached: Boolean(server?.attached) });
    const [all, statusMap] = await Promise.all([api.listSessions(), api.sessionStatus()]);
    const list = (all ?? [])
      .filter((s) => flags.all || isOpcSession(s, directory))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    const shown = list.slice(0, Math.max(1, flags.limit));
    if (flags.json) {
      ctx.json(maskDeep({ sessions: shown, total: list.length, filtered: !flags.all }));
    } else {
      ctx.out(renderSessions(shown, {
        statusMap: statusMap ?? {},
        title: flags.all ? 'Sessões do workspace (todas)' : 'Sessões OPC',
        hiddenCount: list.length - shown.length,
      }));
    }
    return ExitCode.OK;
  } finally {
    conn.close();
  }
}
