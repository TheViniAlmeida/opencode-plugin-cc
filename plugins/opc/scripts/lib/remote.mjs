// F10: servidor OpenCode em outra máquina — regra de host privado para http e mapeamento da raiz remota.
import net from 'node:net';
import path from 'node:path';

import { UsageError } from './opc-error.mjs';

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

// Só IP literal: um nome DNS pode resolver para um IP público, então nunca conta como privado.
export function isPrivateIpLiteral(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const v4 = IPV4_RE.exec(hostname);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const inner = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (inner.includes('%') || !net.isIPv6(inner) || inner.startsWith(':')) return false;
  const first = Number.parseInt(inner.split(':')[0], 16);
  // fc00::/7 (ULA): os 7 bits mais altos do primeiro grupo valem 1111110.
  return Number.isInteger(first) && (first & 0xfe00) === 0xfc00;
}

export function isPosixAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}

// Caminho remoto canônico: POSIX, sem barra final (exceto a raiz).
function normalizeRemote(value) {
  return path.posix.resolve(value);
}

// Raiz remota em uso para o workspace, ou null. OPC_REMOTE_ROOT sobrepõe o mapa server.remoteRoots;
// fora do modo attach nada se aplica (o servidor gerenciado roda na própria máquina).
export function resolveRemoteRoot({ workspaceRoot, env = {}, config = {}, attached = false } = {}) {
  if (!attached) return null;
  const fromEnv = env?.OPC_REMOTE_ROOT;
  if (fromEnv) {
    if (!isPosixAbsolute(fromEnv)) {
      throw new UsageError('INVALID_REMOTE_ROOT', 'OPC_REMOTE_ROOT precisa ser um caminho absoluto POSIX (começando com /) na máquina do servidor.');
    }
    return { remoteRoot: normalizeRemote(fromEnv), localRoot: path.resolve(workspaceRoot), source: 'env' };
  }
  const roots = config?.server?.remoteRoots;
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) return null;
  const local = path.resolve(workspaceRoot);
  let best = null;
  for (const [key, value] of Object.entries(roots)) {
    if (!path.isAbsolute(key) || !isPosixAbsolute(value)) continue;
    const base = path.resolve(key);
    const rel = path.relative(base, local);
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (!inside || (best && best.localRoot.length >= base.length)) continue;
    const remote = rel === '' ? normalizeRemote(value) : path.posix.join(normalizeRemote(value), ...rel.split(path.sep));
    best = { remoteRoot: remote, localRoot: base, source: 'config' };
  }
  return best;
}

// Diretório que o opc envia ao servidor (header x-opencode-directory, export de sessão) e compara com o
// que ele devolve: o caminho remoto mapeado em attach, senão o próprio workspace local.
export function serverDirectory({ workspaceRoot, env = {}, config = {}, attached = false } = {}) {
  return resolveRemoteRoot({ workspaceRoot, env, config, attached })?.remoteRoot ?? workspaceRoot;
}
