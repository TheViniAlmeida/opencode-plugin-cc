// OpenCode V2 configuration as declared by the user (GET /api/config sources).
// The "opencode" execution fallback is only the `model` declared there. GET /api/model/default is the
// server's own catalog pick (e.g. a free `opencode/*` model) and must never become an execution model.
import { OpcError, UsageError } from './opc-error.mjs';

const UNAVAILABLE = Symbol('opc.opencodeConfigUnavailable');

export function mergeOpencodeConfigSources(sources) {
  if (!Array.isArray(sources)) throw new UsageError('UNSUPPORTED_VERSION', 'A configuração do OpenCode V2 não é uma lista de fontes.');
  return Object.assign({}, ...sources.filter((source) => source?.type === 'document' && source.info && typeof source.info === 'object' && !Array.isArray(source.info)).map((source) => source.info));
}

// Merged user config, or a marker (no enumerable keys, so no `model`) when GET /api/config failed:
// the caller then has no "opencode" fallback and NO_MODEL explains why. Non-API errors propagate.
export async function loadOpencodeConfig(api) {
  try {
    return mergeOpencodeConfigSources(await api.getConfigSources());
  } catch (err) {
    if (!(err instanceof OpcError)) throw err;
    return Object.freeze({ [UNAVAILABLE]: err.code ?? 'ERROR' });
  }
}

// Error code of the failed GET /api/config read, or null when the config was read.
export function opencodeConfigUnavailable(opencodeConfig) {
  return opencodeConfig?.[UNAVAILABLE] ?? null;
}
