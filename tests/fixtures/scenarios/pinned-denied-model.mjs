// Scenario pinned-denied-model (spec §6 item 4, §13.1): an agent and a command pin a model from a
// provider that the world policy denies. Used by tests/integration/discovery.test.mjs.
const ALLOW_ALL = [{ action: '*', resource: '*', effect: 'allow' }];

export default {
  data: {
    'agent.json': (base) => [
      ...base,
      {
        id: 'pinned-reviewer', name: 'pinned-reviewer',
        description: 'Reviewer pinned to a work model.',
        mode: 'primary',
        hidden: false,
        permissions: ALLOW_ALL,
        model: { providerID: 'omniroute-work', id: 'opencode-go/kimi-k3' },
      },
    ],
    'command.json': (base) => [
      ...base,
      {
        id: 'work-release', name: 'work-release',
        description: 'Release notes using the Work model',
        model: 'omniroute-work/cx/gpt-5.5',
        template: 'Write release notes for $1',
        hints: ['$1'],
      },
    ],
  },
};
