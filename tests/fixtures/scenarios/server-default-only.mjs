// V2 2.0.22: the OpenCode config declares no `model`; GET /api/model/default is the server's own catalog
// pick (a free opencode/* model), which opc must never use as an execution fallback.
export const SERVER_DEFAULT = Object.freeze({ id: 'space-bunny-free', modelID: 'space-bunny-free', providerID: 'opencode' });

export default {
  data: {
    'config.json': (base) => base.map((source) => {
      if (source?.type !== 'document') return source;
      const { model: _model, ...info } = source.info ?? {};
      return { ...source, info };
    }),
  },
  routes: {
    'GET /api/model/default': () => ({ body: { data: SERVER_DEFAULT } }),
  },
};
