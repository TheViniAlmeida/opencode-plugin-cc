// opc catalog commands|skills [--json] — spec §4 (/opc:catalog)
import { f1Command } from '../lib/f1-command.mjs';
import { parseArgs } from '../lib/args.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { evaluateCommand } from '../lib/policy.mjs';
import { renderCatalog } from '../lib/render.mjs';

const SPEC = { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true };

async function runCommand(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const kind = positionals[0];
  if (positionals.length !== 1 || !['commands', 'skills'].includes(kind)) throw new UsageError('USAGE', 'uso: opc catalog commands|skills [--json]');
  const { api } = await connectApi(ctx);
  let items;
  if (kind === 'commands') {
    const [commands, agents] = await Promise.all([api.commands(), api.agents()]);
    const agentsByName = new Map(agents.map((a) => [a.name, a]));
    items = commands.map((c) => ({
      name: c.name,
      description: c.description ?? null,
      source: c.source ?? null,
      agent: c.agent ?? null,
      model: c.model ?? null,
      subtask: Boolean(c.subtask),
      hints: c.hints ?? [],
      ...evaluateCommand(c, ctx.config.policy, agentsByName),
    }));
  } else {
    items = (await api.skills()).map((s) => ({ name: s.name, description: s.description ?? null, location: s.location }));
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  const view = { kind, items };
  if (flags.json) ctx.json(view);
  else ctx.out(renderCatalog(view));
  return 0;
}

export const run = f1Command(runCommand);
