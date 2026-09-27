// opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json] — spec §4 (/opc:agents)
import { f1Command } from '../lib/f1-command.mjs';
import { parseArgs } from '../lib/args.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { evaluateAgent, pinnedModelOf } from '../lib/policy.mjs';
import { renderAgents } from '../lib/render.mjs';

const MODES = ['primary', 'subagent', 'all'];
const SPEC = {
  flags: { mode: { type: 'string', default: 'all' }, verbose: { type: 'boolean' }, allowed: { type: 'boolean' }, json: { type: 'boolean' }, cwd: { type: 'string' } },
  allowPositionals: true,
};

function agentRow(agent, policy) {
  return {
    name: agent.name,
    description: agent.description ?? null,
    mode: agent.mode,
    native: Boolean(agent.native),
    hidden: Boolean(agent.hidden),
    pinnedModel: pinnedModelOf(agent),
    variant: agent.variant ?? null,
    ...evaluateAgent(agent, policy),
  };
}

async function runCommand(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (positionals.length) throw new UsageError('USAGE', 'uso: opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json]');
  if (!MODES.includes(flags.mode)) throw new UsageError('USAGE', `--mode deve ser um de: ${MODES.join(', ')}`);
  const { api } = await connectApi(ctx);
  const agents = (await api.agents())
    .filter((a) => flags.verbose || !a.hidden)
    .filter((a) => flags.mode === 'all' || a.mode === flags.mode || a.mode === 'all')
    .map((a) => agentRow(a, ctx.config.policy))
    .filter((a) => !flags.allowed || a.allowed)
    .sort((a, b) => a.name.localeCompare(b.name));
  const view = { mode: flags.mode, verbose: Boolean(flags.verbose), allowedOnly: Boolean(flags.allowed), agents, warnings: ctx.configWarnings ?? [] };
  if (flags.json) ctx.json(view);
  else ctx.out(renderAgents(view));
  return 0;
}

export const run = f1Command(runCommand);
