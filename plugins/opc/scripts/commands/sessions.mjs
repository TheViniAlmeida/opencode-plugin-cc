import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi } from '../lib/context.mjs';
import { listJobs, ACTIVE_STATUSES, topLevelJobs, withServerLock } from '../lib/jobs.mjs';
import { renderSessions } from '../lib/render.mjs';

const SPEC = {
  flags: {
    all: { type: 'boolean' },
    limit: { type: 'number', default: 30 },
    refresh: { type: 'boolean' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
};

export function isOpcSession(session, workspaceRoot) {
  return typeof session.title === 'string'
    && session.title.startsWith('OPC: ')
    && !session.parentID
    && (!session.directory || session.directory === workspaceRoot);
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const conn = await openApi(ctx);
  try {
    const { api, server } = conn;
    if (flags.refresh) {
      if (server.attached) {
        throw new UsageError('REFRESH_ATTACHED', '--refresh descarta a instância do servidor e não é permitido num servidor externo (OPC_SERVER_URL)');
      }
      await withServerLock(ctx, async () => {
        const active = topLevelJobs(listJobs(ctx.stateDir, { all: true })).filter((j) => ACTIVE_STATUSES.includes(j.status));
        if (active.length) {
          throw new UsageError('ACTIVE_JOBS', `--refresh recusado: há jobs ativos (${active.map((j) => j.id).join(', ')}); aguarde ou cancele`);
        }
        await api.dispose();
      }, { purpose: 'sessions-refresh' });
    }
    const [all, statusMap] = await Promise.all([api.listSessions(), api.sessionStatus()]);
    const list = (all ?? [])
      .filter((s) => flags.all || isOpcSession(s, ctx.workspaceRoot))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    const shown = list.slice(0, Math.max(1, flags.limit));
    if (flags.json) {
      ctx.json({ sessions: shown, total: list.length, filtered: !flags.all });
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
