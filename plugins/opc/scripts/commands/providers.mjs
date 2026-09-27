// opc providers [--all] [--json] — spec §4 (/opc:providers)
import { parseArgs } from '../lib/args.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { evaluate } from '../lib/policy.mjs';
import { renderProviders } from '../lib/render.mjs';

const SPEC = { flags: { all: { type: 'boolean' }, json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true };

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (positionals.length) throw new UsageError('USAGE', 'uso: opc providers [--all] [--json]');
  const { api } = await connectApi(ctx);
  const catalog = buildCatalog(await api.providers());
  const providers = catalog.providers
    .filter((p) => flags.all || p.connected)
    .map((p) => ({ ...p, ...evaluate('provider', p.id, ctx.config.policy) }));
  const view = { all: Boolean(flags.all), providers, warnings: ctx.configWarnings ?? [] };
  if (flags.json) ctx.json(view);
  else ctx.out(renderProviders(view));
  return 0;
}
