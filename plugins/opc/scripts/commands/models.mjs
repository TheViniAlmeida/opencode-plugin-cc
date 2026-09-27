// opc models [provider] [--verbose] [--allowed] [--all] [--json] — spec §4 (/opc:models)
import { parseArgs } from '../lib/args.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { evaluate } from '../lib/policy.mjs';
import { renderModels } from '../lib/render.mjs';

const SPEC = {
  flags: { verbose: { type: 'boolean' }, allowed: { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' }, cwd: { type: 'string' } },
  allowPositionals: true,
};

export function providerEcho(provider) {
  return `${provider.slice(0, 12)}…`;
}

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (positionals.length > 1) throw new UsageError('USAGE', 'uso: opc models [provider] [--verbose] [--allowed] [--all] [--json]');
  const provider = positionals[0] ?? null;
  const { api } = await connectApi(ctx);
  const catalog = buildCatalog(await api.providers());
  if (provider) {
    const known = catalog.providers.find((p) => p.id === provider);
    if (!known) throw new UsageError('UNKNOWN_PROVIDER', `provider desconhecido "${providerEcho(provider)}" (conhecidos: ${catalog.providers.map((p) => p.id).join(', ')})`);
    if (!known.connected && !flags.all) throw new UsageError('UNKNOWN_PROVIDER', `provider "${providerEcho(provider)}" não está conectado; use --all para listar o catálogo ou execute: opencode auth login`);
  }
  const models = catalog.models
    .filter((m) => (flags.all || m.connected) && (!provider || m.providerID === provider))
    .map((m) => ({ ...m, ...evaluate('model', m.full, ctx.config.policy) }))
    .filter((m) => !flags.allowed || m.allowed);
  const view = { provider, all: Boolean(flags.all), allowedOnly: Boolean(flags.allowed), verbose: Boolean(flags.verbose), models, warnings: ctx.configWarnings ?? [] };
  if (flags.json) ctx.json(view);
  else ctx.out(renderModels(view));
  return 0;
}
