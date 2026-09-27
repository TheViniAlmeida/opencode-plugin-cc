// Scenario pinned-denied-model (spec §6 item 4, §13.1): an agent and a command pin a model from a
// provider that the world policy denies. Used by tests/integration/discovery.test.mjs.
const ALLOW_ALL = [{ permission: '*', pattern: '*', action: 'allow' }];

export default {
  data: {
    'agent.json': (base) => [
      ...base,
      {
        name: 'pinned-reviewer',
        description: 'Reviewer pinned to a work model.',
        mode: 'primary',
        native: false,
        permission: ALLOW_ALL,
        model: { providerID: 'omniroute-work', modelID: 'opencode-go/kimi-k3' },
        options: {},
      },
    ],
    'command.json': (base) => [
      ...base,
      {
        name: 'work-release',
        description: 'Release notes using the Work model',
        source: 'command',
        model: 'omniroute-work/cx/gpt-5.5',
        template: 'Write release notes for $1',
        hints: ['$1'],
      },
    ],
  },
};
