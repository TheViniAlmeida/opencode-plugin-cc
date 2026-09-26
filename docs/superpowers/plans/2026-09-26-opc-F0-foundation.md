# opc F0 — Fundação e conexão · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a fundação do plugin `opc` — repositório, CLI `opc`, módulos de núcleo, o ciclo de vida completo do `opencode serve` por workspace e o `/opc:setup` de diagnóstico — fechando com o portão da F0 (testes, validação ao vivo, contrato, docs e relatório).

**Architecture:** Uma CLI única (`bin/opc` → `scripts/opc-companion.mjs`) resolve o subcomando e chama `scripts/commands/<sub>.mjs`. O núcleo em `scripts/lib/` tem um módulo por responsabilidade (erros, redação, argumentos, processos, locks, estado, config, HTTP, SSE, servidor, contexto, render), com as assinaturas congeladas no plano mestre. O servidor `opencode serve` é destacado, escuta só em `127.0.0.1` numa porta escolhida pelo plugin, é protegido por senha aleatória e só recebe sinais depois de conferida a identidade do processo (cmdline + start time).

**Tech Stack:** Node.js ≥ 20 (ESM `.mjs`, `fetch` nativo), `node:test` + `node:assert/strict`, zero dependências (nem de desenvolvimento), OpenCode 1.18.32 (API v1), GitHub Actions (Node 20 e 22).

**Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3) — §3.1, §3.2, §4.1, §5 inteiro, §13.1 (infraestrutura), §13.3 F0 e §15 itens 1, 2, 4, 5 e 8.

**Plano mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` — estrutura de arquivos congelada, contrato de interfaces, convenções de teste, regras de git e portão. Quem executa lê os três documentos.

---

## Global Constraints

Copiadas do mestre (valem para todas as tarefas):

- Node ≥ 20 (`engines: {"node": ">=20"}`); checagem em runtime com mensagem clara; CI em Node 20 e 22.
- Zero dependências de runtime. `devDependencies` também vazias (nada de `npm install`).
- Código, identificadores, mensagens de commit e nomes de arquivo em inglês. Docs e textos voltados ao usuário em PT-BR.
- OpenCode mínimo `1.18.0`; alvo testado `1.18.32`; só a API v1 (`/session/*`, `/event`, …), nunca `/api/*`.
- Servidor sempre em `127.0.0.1`, porta escolhida pelo plugin e autenticado com `OPENCODE_SERVER_PASSWORD` (usuário `opencode`).
- A senha do servidor e as chaves de provider nunca aparecem em stdout, stderr, logs, docs ou fixtures commitadas.
- O plugin nunca escreve em `~/.config/opencode/` nem no `auth.json` do OpenCode.
- Nenhum sinal para um processo cuja identidade (cmdline + start time) não confira.
- Diretórios de estado com modo 700 e arquivos com modo 600.
- `always` nunca é enviado em `permission reply` (na F0 só o probe ao vivo o usa, para documentar o escopo).
- Exit codes conforme a spec, §4.1: `0, 2, 3, 4, 5, 6, 7, 130`.
- Namespace de comandos `/opc:`; executável `opc`; título das sessões com o prefixo `OPC: `.
- Testes ao vivo só com `OPC_LIVE=1`, nunca no CI, sempre em diretório descartável; modelos `omniroute-mvalmeida/opencode-go/{deepseek-v4.1-flash,qwen3.8-max,kimi-k3}` (F0: `deepseek-v4.1-flash`).
- Licença Apache-2.0; `NOTICE` credita o `openai/codex-plugin-cc`; nada copiado do `swarm-code-plugin`.

Específicas da F0:

- Arquivos portados do codex levam no cabeçalho `// Adapted from openai/codex-plugin-cc (Apache-2.0); modified`. **Na F0 nenhum arquivo é portado** (o código abaixo é original); o `LICENSE` é o texto padrão da Apache-2.0.
- Mensagens para o usuário (erros, render) em PT-BR; `code` dos erros em inglês (`SERVER_DOWN`, `AUTH_FAILED`…), que é o que os testes conferem.
- Todo prazo usa `performance.now()` (relógio monotônico).

## Review Focus

As cinco entradas do mestre. A F0 é dona dos testes das linhas 1 (parte de argumentos), 2 e 4; as demais estão nas fases indicadas e não têm tarefa aqui.

1. **Prompts com aspas, crases, `$()`, quebras de linha e unicode** passam intactos e nunca são expandidos pelo shell. → Task 4, teste `prompt-roundtrip: quotes, backticks, $(), newlines and unicode survive intact`; Task 14, teste `heredoc --args-stdin never expands $() or backticks (slash command invocation)`. (A ida até o OpenCode é da F2a.)
2. **Workspace sem git ou fora de repositório, caminho com espaços ou acentos:** estado, hash e `directory` corretos. → Task 7, teste `workspace-with-spaces: slug is sanitized, hash uses the realpath, symlinks map to the same dir`; Task 14, teste `workspace-with-spaces: git (from a subdir) and non-git dirs with spaces/accents keep exact directory and hash`.
3. **Primeiro uso sem config nenhuma** → F1 (`no-config-first-run`). A F0 cobre só a carga sem arquivos (Task 8, `loadConfig: first run without files works…`).
4. **Servidor morto entre dois comandos** (`kill -9`, reboot): detecta, limpa e sobe outro, sem pendurar. → Task 12, testes `server-killed-externally: after kill -9 the next ensureServer cleans up and respawns without hanging` e `server-killed-externally (client level): clientFor re-ensures the server and retries a GET`.
5. **Saídas grandes** → F2a/F2b. A F0 só garante o truncamento do `server.log` acima de 5 MB no spawn (Task 12).

---

## Antes de começar

- [ ] **Autorização de git.** Commits, push e PR só com autorização explícita do operador nesta sessão de execução (mestre, "Regras de git"). Sem ela, pergunte antes do primeiro commit. `[PAUSA-APROVAÇÃO]`
- [ ] **Branch.** A partir da `main` já com o commit `docs: add opc design spec and implementation plans` (mestre, regra 5): `git switch -c feat/opc-f0`. `[PAUSA-APROVAÇÃO]`
- [ ] **Ambiente.** `node --version` (≥ 20; ideal 20.10+ para `--test-concurrency`) e `git --version`. Não rode `npm install`: não há dependências.
- [ ] **Mensagens de commit.** Conventional Commits, em inglês, **sem** `Co-Authored-By`, `Signed-off-by`, "Generated with" ou qualquer marca de ferramenta. Releia a mensagem antes de cada `git commit`.

Todos os comandos abaixo rodam na raiz do repositório.

## Decisões desta fase (interpretações da spec)

Pontos em que a spec/mestre deixam margem. O plano segue estas escolhas; o relatório da fase as repete.

1. **`test:live` do mestre não funciona.** `node --test tests/live/` falha no Node 22 (“Cannot find module …/tests/live”) e, no Node 20, não coleta `*.mjs` sem sufixo `.test`. O `package.json` usa `node scripts/run-tests.mjs live`, que coleta `tests/live/*.mjs` (exceto os scripts isolados `contract.mjs` e `probe-*.mjs` e os módulos de apoio `_*.mjs` das fases seguintes), define `OPC_LIVE=1` e roda com concorrência 1.
2. **`.opc.json` × chave travada `policy`.** O `.opc.json` só entra com as formas restritivas: `policy.{providers,models,agents}.allow` (interseção), `.deny` (união), `policy.tools.deny` (união), `policy.sensitivePaths` e `policy.destructiveBash` (união) e `policy.approver` só se for `"user"`. Qualquer outra chave de `policy`, `permissionProfiles` e `server.configOverride` é ignorada com aviso.
3. **Interseção de allow com globs.** Mantém as entradas do workspace que estão contidas num glob global e as entradas globais contidas num glob do workspace (com `*` como único curinga, “o literal de A casa o glob B” implica A ⊆ B). É uma subaproximação segura: nunca permite mais do que a interseção real. Interseção vazia → `deny` recebe `*` (nada permitido), com aviso.
4. **Escalares sobrescrevíveis pelo `.opc.json`:** `defaultProvider`, `defaultModel`, `defaultVariant`, `defaultAgent`, `aliases`, `reviewModel`, `routing`, `conclave`, `orchestrate`, `project`, `stopGate.model`. `jobs`, `delegation`, `server.*` e `stopGate.enabled` não (um repositório clonado não liga delegação nem muda limites).
5. **`/opc:setup` sobe o servidor.** O diagnóstico chama `ensureServer` (o aceite ao vivo exige subir, reaproveitar e encerrar via setup). Sem OpenCode instalado ou com versão abaixo da mínima, não tenta subir.
6. **Exit codes do setup:** 0 pronto; 5 OpenCode ausente, versão antiga, boot falho ou 401; 4 sessões bloqueadas por `share: auto`; 2 URL de attach insegura, `--stop-server` com jobs ativos ou `--force` sem confirmação.
7. **Bootstrap do diretório de dados.** Só o `setup` cria `~/.claude/plugins/data/opc-opencode-plugin-cc/` quando nada resolve (spec §3.2, item 4: os outros comandos mandam rodar o `/opc:setup`).
8. **Senha troca a cada spawn.** O `onServerDown` do cliente devolve `{ url, password }` (o mestre diz “→ novo baseUrl”); o cliente também aceita string.
9. **Retry de GET.** A spec (§5.2) repete GET em `ServerDown`; o padrão de `retryOnServerDown` passa a ser `method === 'GET'` (o mestre mostrava `false`). POST só repete com `retryOnServerDown: true` (chave de deduplicação, F2a).
10. **Aquecimento que falha** vira aviso, não falha de boot (o servidor já está saudável).
11. **Servidor reaproveitado que responde 401** → `AUTH_FAILED` na hora, sem respawn (spec: 401 falha sem retry).
12. **Checagem de `model`/`small_model` negados** usa `config.matchesGlob` (a `policy.mjs` é da F1). A F1 troca por `policy.evaluate` sem mudar o comportamento.
13. **`share: auto`** é avaliado no `GET /config` servido (que já reflete o override quando o merge funciona). Bloqueado → `world.shareBlocked` no `server.json`; `assertCanCreateSessions(server)` lança `PolicyError('SHARE_AUTO')` (exit 4) para a F2a usar antes de `POST /session`.
14. **`ACTIVE_JOB_STATUSES` nasce em `state.mjs`**, porque o setup da F0 já precisa saber se há jobs ativos; a F2a faz `jobs.ACTIVE_STATUSES` reexportar esse valor (`import { ACTIVE_JOB_STATUSES } from './state.mjs'; export const ACTIVE_STATUSES = ACTIVE_JOB_STATUSES;`) e a F4a usa o mesmo valor em `MONITOR_ACTIVE`; ninguém redefine a lista.
15. **Locks órfãos** são renomeados para `*.stale-<ts>-<pid>` e mantidos (a spec fala em renomear; nada é apagado).
16. **`ensurePrivateDir`** também aperta para 700 diretórios existentes (inclusive o de dados criado pelo Claude Code).
17. **`EventHub.start()`** tenta a conexão inicial uma vez (falha → rejeita); o backoff vale só para reconexões. Esgotado o backoff, `onDown(err)` (nome novo) avisa quem acompanha.
18. **Fake e `OPENCODE_CONFIG_CONTENT`:** o fake faz merge raso do override sobre a config base (assume o merge — A CONFIRMAR §15.5, respondido pelo probe). O cenário `share-auto` simula override sem efeito.
19. **Marcador `scan-secrets:allow`:** linhas com esse marcador ficam fora dos padrões de token (fixtures de teste, o próprio scanner); a senha registrada do servidor é sempre reportada.
20. **Dispatcher dinâmico** (reconciliação entre planos, D11). Uma lista fixa `SUBCOMMANDS = ['setup']` obrigaria cada fase a editar o dispatcher (e nenhuma o fazia). O `opc-companion.mjs` descobre os subcomandos em `commands/*.mjs`: `loadCommand(sub)` só importa um nome que casa `/^[a-z][a-z0-9-]*$/` e tem arquivo existente (sem caminho arbitrário; senão `UsageError('USAGE')`, exit 2, listando `listSubcommands()`); o módulo precisa exportar `run`. `main(rawArgv, io)` aceita também `io.cwd` (padrão `process.cwd()`, usado sem `--cwd`) e `io.onError` (chamado com o erro antes do `renderError`; a F5 usa).
21. **Apóstrofo em prosa** (reconciliação entre planos, D3). No `splitArgString`, um `'` precedido **e** seguido por letra/dígito Unicode (`/[\p{L}\p{N}]/u`) é literal e nunca abre aspas (`don't and can't` → `["don't", "and", "can't"]`; `rock'n'roll` inteiro), para que valores de flag com apóstrofo (ex.: `config set project.goal …`) não virem aspas por engano. `--goal 'it is'` continua agrupando, o idioma `'a'\''b'` continua funcionando (o `'` depois de `\'` não é precedido por letra) e as aspas não fechadas que sobrarem continuam literais.
22. **Infraestrutura de teste extensível sem reescrita** (reconciliação entre planos, passe #2 — T1–T6 do mestre). (a) Limpeza por teste única: `testEnv`/`makeWorkspace` (e `trackEnv`/`trackWorkspace`/`trackTempDir`/`registerStopper`) alimentam um só `t.after`, que roda `registerStopper`s → `stopAllServers` por env × workspace → remoção dos temporários; nenhuma fase registra `t.after(() => stopAllServers(...))` (rodaria depois da remoção dos diretórios → `ENOENT`). (b) O fake ganha `registerFakeExtension(install)`: as fases acrescentam rotas por chamadas no **fim** de `fake-opencode.mjs`, sem editar o roteador; a resolução é rota do cenário → rota base (padrão + extensões) → 404, com `params` também no fallback. (c) `PROBES`/`EVENT_TYPES` do contrato moram em `tests/fixtures/contract-shapes.mjs` (registro); `tests/live/contract.mjs` é o único executor e as fases acrescentam entradas ao registro. (d) O coletor `live` ignora `_*.mjs`.

## Mapa de arquivos da F0

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `package.json` | scripts, `engines`, sem dependências | 1 |
| `scripts/run-tests.mjs` | coleta de testes portátil (Node 20/22) | 1 |
| `tests/helpers.mjs` | helpers de teste (temp dirs, workspaces, env com fake, CLI) | 1 |
| `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md` | licença, atribuição, esqueletos | 1 (README/CHANGELOG finais na 15) |
| `scripts/scan-secrets.mjs` | varredura de segredos | 2 |
| `.github/workflows/ci.yml` | CI Node 20/22 | 2 |
| `plugins/opc/scripts/lib/opc-error.mjs`, `redact.mjs` | erros tipados, redação | 3 |
| `plugins/opc/scripts/lib/args.mjs` | split sem expansão, `--args-stdin`, flags | 4 |
| `plugins/opc/scripts/lib/process.mjs` | identidade, spawn destacado, kill em grupo | 5 |
| `plugins/opc/scripts/lib/locks.mjs` | locks `O_EXCL` | 6 |
| `plugins/opc/scripts/lib/state.mjs` | dados, estado por workspace | 7 |
| `plugins/opc/scripts/lib/config.mjs` | config base e merge restritivo | 8 |
| `plugins/opc/scripts/lib/http.mjs` | cliente HTTP | 9 |
| `tests/fixtures/fake-opencode.mjs`, `tests/fixtures/bin/opencode`, `tests/fixtures/data/*.json`, `tests/fixtures/scenarios/*.mjs` | OpenCode falso | 10–12 |
| `plugins/opc/scripts/lib/sse.mjs` | SSE | 11 |
| `plugins/opc/scripts/lib/server.mjs` | ciclo de vida do servidor | 12 |
| `plugins/opc/scripts/lib/context.mjs`, `render.mjs` | contexto e Markdown | 13 |
| `plugins/opc/scripts/opc-companion.mjs`, `plugins/opc/scripts/commands/setup.mjs`, `plugins/opc/bin/opc`, `plugins/opc/commands/setup.md`, `plugins/opc/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | CLI e plugin | 14 |
| `tests/fixtures/contract-shapes.mjs`, `tests/live/*.mjs`, `docs/*.md`, `docs/phases/F0-report.md` | portão | 15 |

---

### Task 1: Esqueleto do repositório, runner de testes e helpers

Cria o `package.json`, o runner portátil (o `node --test` com glob só existe no Node 21+), os helpers de teste que todas as fases usam e os arquivos de licença.

**Files:**
- Create: `package.json`, `scripts/run-tests.mjs`, `tests/helpers.mjs`, `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md`
- Test: `tests/unit/run-tests.test.mjs`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `scripts/run-tests.mjs`: `KINDS = ['unit','integration','live']`; `collectTestFiles(root = REPO_ROOT, kinds = ['unit','integration']) → string[]` (ordenado por tipo e depois alfabeticamente); `supportsTestConcurrency(version = process.versions.node) → boolean`. CLI: `node scripts/run-tests.mjs [unit|integration|live]`. No tipo `live`, não coleta módulos de apoio `_*.mjs` nem os scripts isolados `contract.mjs` e `probe-*.mjs`.
  - `tests/helpers.mjs` (contrato do mestre + acréscimos): `REPO_ROOT, PLUGIN_ROOT, PLUGIN_BIN_DIR, COMPANION, FAKE_BIN_DIR`; `makeTempDir(prefix = 'opc-test-') → string` (realpath, sempre com prefixo `opc-`); `removeTempDir(dir)` (recusa qualquer coisa fora de `os.tmpdir()` sem prefixo `opc-`); `trackTempDir(t, dir) → dir`; `registerStopper(t, fn)`; `trackWorkspace(t, dir) → realpath`; `trackEnv(t, env) → env`; `makeWorkspace(t, { git = true, name = 'ws' }) → realpath`; `testEnv(t, { scenario = 'ok', extra = {} }) → env`; `runCli(args, { env, cwd, stdin = '', timeoutMs = 60000 }) → { code, stdout, stderr }`; `runProcess(command, args, opts)`; `parseJsonOutput(stdout)`; `readFakeState(env)`; `readJsonFile(file)`; `stopAllServers(env, cwd)`; `processAlive(pid)`; `waitFor(predicate, { timeoutMs, intervalMs, message })`; `spawnSleeper(t)`; `deadPid() → Promise<number>`.
  - Limpeza por teste (um único `t.after`, em ordem): `registerStopper`s (ordem inversa) → `opc setup --stop-server --force --confirmed-by-user` para cada par env × workspace registrado (só se o `COMPANION` já existir) → remoção dos diretórios temporários. O `node:test` roda os `t.after` na ordem de registro (FIFO, conferido no Node 22), por isso a limpeza é centralizada.
  - **Padrão canônico de teardown (vale para todas as fases):** `testEnv`/`makeWorkspace` registram env e workspace; env montado à mão (testes ao vivo) → `trackEnv(t, env)`; servidor rodando num diretório que não veio do `makeWorkspace` → `trackWorkspace(t, dir)`; diretório temporário próprio → `trackTempDir(t, makeTempDir(...))`; tudo o que precisa rodar **antes** de parar os servidores e remover os diretórios (cancelar jobs, fechar cliente MCP, matar filho que usa o workspace) → `registerStopper(t, fn)`. **Nunca** `t.after(() => stopAllServers(...))` nem `t.after(() => runCli(...))` depois de `testEnv`/`makeWorkspace`: esse `t.after` roda depois da remoção dos diretórios (`spawn` com `cwd` inexistente → `ENOENT`). `t.after` direto só para recursos que não dependem dos temporários (`AbortController`, `prompter.close()`, `fake.close()` de fake em processo — ele não grava nada depois do teste; em modo attach ele precisa continuar de pé enquanto a limpeza roda o `stopAllServers`). Exceção aceita: teste ao vivo autocontido que não usa os helpers de registro e faz, num único `t.after`, parar o servidor e só depois remover os próprios diretórios.

- [ ] **Step 1: Escrever os helpers e o teste que falha**

Crie `tests/helpers.mjs`:

````js
// Shared test helpers (F0). Later phases only APPEND at the end of this file (never rewrite it), using the
// default imports below (fs, os, path, spawn, execFileSync) or aliased imports (`<phase><Name>`), and never
// re-export a name that already exists here (a duplicate export is a SyntaxError).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'opc');
export const PLUGIN_BIN_DIR = path.join(PLUGIN_ROOT, 'bin');
export const COMPANION = path.join(PLUGIN_ROOT, 'scripts', 'opc-companion.mjs');
export const FAKE_BIN_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'bin');

const TEMP_PREFIX = 'opc-';
const cleanups = new WeakMap();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeTempDir(prefix = 'opc-test-') {
  const safe = prefix.startsWith(TEMP_PREFIX) ? prefix : `${TEMP_PREFIX}${prefix}`;
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), safe)));
}

export function removeTempDir(dir) {
  const tmp = fs.realpathSync(os.tmpdir());
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== tmp || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove non-temporary directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function registry(t) {
  let reg = cleanups.get(t);
  if (!reg) {
    reg = { stoppers: [], envs: [], workspaces: [], dirs: [] };
    cleanups.set(t, reg);
    t.after(async () => {
      for (const stop of [...reg.stoppers].reverse()) await Promise.resolve().then(stop).catch(() => {});
      if (fs.existsSync(COMPANION)) {
        for (const env of reg.envs) {
          for (const ws of reg.workspaces) {
            if (fs.existsSync(ws)) await stopAllServers(env, ws).catch(() => {});
          }
        }
      }
      for (const dir of reg.dirs) removeTempDir(dir);
    });
  }
  return reg;
}

export function registerStopper(t, fn) {
  registry(t).stoppers.push(fn);
}

export function trackTempDir(t, dir) {
  registry(t).dirs.push(dir);
  return dir;
}

// Registers a directory where servers may run (git worktrees, dirs not made by makeWorkspace): the per-test
// cleanup runs `stopAllServers(env, dir)` for it with every tracked env, before removing the temp dirs.
export function trackWorkspace(t, dir) {
  const real = fs.realpathSync(dir);
  const reg = registry(t);
  if (!reg.workspaces.includes(real)) reg.workspaces.push(real);
  return real;
}

// Registers an env built outside testEnv (live tests): its servers are stopped by the per-test cleanup.
export function trackEnv(t, env) {
  const reg = registry(t);
  if (!reg.envs.includes(env)) reg.envs.push(env);
  return env;
}

export function makeWorkspace(t, { git = true, name = 'ws' } = {}) {
  const base = trackTempDir(t, makeTempDir('opc-ws-'));
  const ws = path.join(base, name);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), '# test workspace\n');
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
    run('init', '-q');
    run('config', 'user.name', 'opc-test');
    run('config', 'user.email', 'opc-test@example.invalid');
    run('config', 'commit.gpgsign', 'false');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
  }
  return trackWorkspace(t, ws);
}

const INHERITED_BLOCKLIST = /^(OPC_|CLAUDE_PLUGIN_DATA$|OPENCODE_|FAKE_)/;

export function testEnv(t, { scenario = 'ok', extra = {} } = {}) {
  const base = trackTempDir(t, makeTempDir('opc-env-'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED_BLOCKLIST.test(k)));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...inherited,
    PATH: `${FAKE_BIN_DIR}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    OPC_DATA_DIR: path.join(base, 'data'),
    FAKE_OPENCODE_SCENARIO: scenario,
    FAKE_OPENCODE_STATE: path.join(base, 'fake-state.json'),
    FAKE_HEARTBEAT_MS: '200',
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined || v === null) delete env[k];
  return trackEnv(t, env);
}

export async function runCli(args, { env, cwd, stdin = '', timeoutMs = 60000 } = {}) {
  return runProcess(process.execPath, [COMPANION, ...args], { env, cwd, stdin, timeoutMs });
}

export async function runProcess(command, args, { env, cwd, stdin = '', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout after ${timeoutMs} ms: ${command} ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`stdout is not JSON: ${err.message}\n${stdout}`);
  }
}

export function readFakeState(env) {
  try {
    return JSON.parse(fs.readFileSync(env.FAKE_OPENCODE_STATE, 'utf8'));
  } catch {
    return { requests: [], sessions: {}, messages: {}, permissions: {}, questions: {}, signals: [], sseConnections: 0, bootAttempts: 0, boots: [] };
  }
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function stopAllServers(env, cwd) {
  return runCli(['setup', '--stop-server', '--force', '--confirmed-by-user', '--json'], { env, cwd, timeoutMs: 30000 });
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch {
      return false;
    }
  }
  return true;
}

export async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${message}`);
    await sleep(intervalMs);
  }
}

export function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  });
  return child;
}

export function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const { pid } = child;
  return new Promise((resolve) => child.on('exit', () => resolve(pid)));
}

````

Crie `tests/unit/run-tests.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { collectTestFiles, supportsTestConcurrency } from '../../scripts/run-tests.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

function touch(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('collectTestFiles finds *.test.mjs recursively under unit and integration, sorted', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  touch(root, 'tests/unit/b.test.mjs');
  touch(root, 'tests/unit/a.test.mjs');
  touch(root, 'tests/unit/nested/c.test.mjs');
  touch(root, 'tests/unit/helper.mjs');
  touch(root, 'tests/integration/x.test.mjs');
  const files = collectTestFiles(root).map((f) => path.relative(root, f));
  assert.deepEqual(files, [
    path.join('tests', 'unit', 'a.test.mjs'),
    path.join('tests', 'unit', 'b.test.mjs'),
    path.join('tests', 'unit', 'nested', 'c.test.mjs'),
    path.join('tests', 'integration', 'x.test.mjs'),
  ]);
});

test('collectTestFiles for live skips standalone scripts (contract, probe-*) and support modules (_*)', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  touch(root, 'tests/live/f0-connection.mjs');
  touch(root, 'tests/live/contract.mjs');
  touch(root, 'tests/live/probe-permission-precedence.mjs');
  touch(root, 'tests/live/_f2a-helpers.mjs');
  const files = collectTestFiles(root, ['live']).map((f) => path.basename(f));
  assert.deepEqual(files, ['f0-connection.mjs']);
});

test('supportsTestConcurrency is true from Node 20.10', () => {
  assert.equal(supportsTestConcurrency('20.9.0'), false);
  assert.equal(supportsTestConcurrency('20.10.0'), true);
  assert.equal(supportsTestConcurrency('22.1.0'), true);
});
````

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `node --test tests/unit/run-tests.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`Cannot find module '…/scripts/run-tests.mjs'`).

- [ ] **Step 3: Implementar o runner, o `package.json` e os arquivos de licença**

Crie `scripts/run-tests.mjs`:

````js
#!/usr/bin/env node
// Collects tests/<kind>/**/*.test.mjs (or tests/live/*.mjs) and runs `node --test` — portable to Node 20 and 22.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = Object.freeze(['unit', 'integration', 'live']);
// Not collected in tests/live: support modules (_*.mjs) and standalone scripts (contract.mjs, probe-*.mjs).
const LIVE_NOT_TESTS = /^(_.*|contract|probe-.*)\.mjs$/;

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function collectTestFiles(root = REPO_ROOT, kinds = ['unit', 'integration']) {
  const files = [];
  for (const kind of kinds) {
    const dir = path.join(root, 'tests', kind);
    const found = walk(dir, []).filter((f) => {
      const name = path.basename(f);
      if (kind === 'live') return path.dirname(f) === dir && name.endsWith('.mjs') && !LIVE_NOT_TESTS.test(name);
      return name.endsWith('.test.mjs');
    });
    files.push(...found.sort());
  }
  return files;
}

export function supportsTestConcurrency(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 10);
}

function main(argv) {
  const requested = argv[0];
  if (requested && !KINDS.includes(requested)) {
    process.stderr.write(`usage: node scripts/run-tests.mjs [${KINDS.join('|')}]\n`);
    return 2;
  }
  const kinds = requested ? [requested] : ['unit', 'integration'];
  const files = collectTestFiles(REPO_ROOT, kinds);
  if (files.length === 0) {
    process.stderr.write(`no test files found for: ${kinds.join(', ')}\n`);
    return 1;
  }
  const args = ['--test'];
  if (supportsTestConcurrency()) args.push(`--test-concurrency=${requested === 'live' ? 1 : 4}`);
  const env = requested === 'live' ? { ...process.env, OPC_LIVE: '1' } : process.env;
  const res = spawnSync(process.execPath, [...args, ...files], { stdio: 'inherit', env, cwd: REPO_ROOT });
  return res.status ?? 1;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
````

Crie `package.json`:

````json
{
  "name": "opencode-plugin-cc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Plugin Claude Code que usa o OpenCode como executor (opc).",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node scripts/run-tests.mjs",
    "test:unit": "node scripts/run-tests.mjs unit",
    "test:integration": "node scripts/run-tests.mjs integration",
    "test:live": "node scripts/run-tests.mjs live",
    "scan-secrets": "node scripts/scan-secrets.mjs docs README.md CHANGELOG.md plugins"
  }
}
````

Copie o texto integral da Apache-2.0 do plugin codex instalado localmente (não há acesso à internet garantido) e confira o hash:

```bash
cp ~/.claude/plugins/marketplaces/openai-codex/LICENSE LICENSE
sha256sum LICENSE
```

Expected: `e591c02a0b2ea7717d99e15bd51ea05d879bbf5a4452d66d15b51a7107d3821a  LICENSE` (201 linhas, começa com `Apache License` / `Version 2.0, January 2004`). Se o arquivo não existir nessa máquina, use o `LICENSE` do repositório `openai/codex-plugin-cc` ou `https://www.apache.org/licenses/LICENSE-2.0.txt` e registre a origem no relatório.

Crie `NOTICE`:

````
opc — plugin Claude Code para o OpenCode
Copyright 2026 TheViniAlmeida

Este produto é distribuído sob a Apache License, Version 2.0 (arquivo LICENSE).

Este produto inclui trabalho derivado de openai/codex-plugin-cc
(https://github.com/openai/codex-plugin-cc), Copyright 2026 OpenAI,
licenciado sob a Apache License, Version 2.0: estrutura de comandos, schema de
review, prompts adaptados e a coleta de diff (git.mjs). Os arquivos derivados
trazem no cabeçalho o aviso "Adapted from openai/codex-plugin-cc (Apache-2.0);
modified".

As capacidades inspiradas em apoapps/swarm-code-plugin foram reimplementadas do
zero; nenhum código ou texto desse projeto foi copiado.
````

Crie `README.md` (esqueleto; a versão da fase é escrita na Task 15):

````markdown
# opc — OpenCode dentro do Claude Code

Plugin do Claude Code que usa o OpenCode como executor. Em construção (F0).

Licença: Apache-2.0 (veja `LICENSE` e `NOTICE`).
````

Crie `CHANGELOG.md`:

````markdown
# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/run-tests.test.mjs`
Expected: PASS — `# tests 3`, `# pass 3`, `# fail 0`.

Run: `npm test`
Expected: PASS (só este arquivo existe por enquanto).

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/run-tests.mjs tests/helpers.mjs tests/unit/run-tests.test.mjs LICENSE NOTICE README.md CHANGELOG.md
git commit -m "chore: scaffold repository with test runner and helpers"
```

---

### Task 2: Scanner de segredos e CI

O scanner é usado pelos testes (varredura da senha), pelo CI e pelo portão (`docs/`).

**Files:**
- Create: `scripts/scan-secrets.mjs`, `.github/workflows/ci.yml`
- Test: `tests/unit/scan-secrets.test.mjs`

**Interfaces:**
- Consumes: `tests/helpers.mjs` (`REPO_ROOT, makeTempDir, removeTempDir, runProcess`).
- Produces: `PATTERNS`, `ALLOW_MARKER = 'scan-secrets:allow'`, `mask(value) → 'abcd…(N chars)'`, `scanText(text, { secrets }) → [{ line, kind, sample }]`, `scanPaths(paths, { secrets }) → [{ file, line, kind, sample }]`, `secretsFromServerJson(files) → string[]`, `serverJsonFilesUnder(dataDir) → string[]`. CLI: `node scripts/scan-secrets.mjs <path...> [--server-json <file>]` (também lê os `server.json` de `$OPC_DATA_DIR/state/*/`); exit 0 limpo, 1 com achados (mascarados), 2 uso.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/scan-secrets.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ALLOW_MARKER, mask, scanPaths, scanText, secretsFromServerJson } from '../../scripts/scan-secrets.mjs';
import { REPO_ROOT, makeTempDir, removeTempDir, runProcess } from '../helpers.mjs';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs');

test('scanText finds registered secrets and token patterns, masking samples', () => {
  const secret = 'a1b2c3d4e5f6a7b8c9d0';
  const findings = scanText(`line one\nurl with ${secret} inside\nAuthorization: Bearer ${'abcdefghij'.repeat(3)}\n`, { secrets: [secret] });
  assert.deepEqual(findings.map((f) => [f.line, f.kind]), [[2, 'registered-secret'], [3, 'bearer-token']]);
  for (const f of findings) assert.ok(!f.sample.includes(secret) && f.sample.includes('chars'));
});

test('scanText ignores redacted and placeholder passwords', () => {
  assert.deepEqual(scanText('{"password": "***"}\n{"password": "YOUR_PASSWORD_HERE"}\nOPENCODE_SERVER_PASSWORD=***'), []);
  assert.equal(scanText('{"password": "hunter2hunter2"}')[0].kind, 'json-password'); // scan-secrets:allow
});

test('the allow marker exempts a line from patterns but never from registered secrets', () => {
  const secret = 'b0b0b0b0b0b0b0b0';
  const line = `Bearer ${'x'.repeat(24)} ${secret} // ${ALLOW_MARKER}`;
  assert.deepEqual(scanText(line, { secrets: [secret] }).map((f) => f.kind), ['registered-secret']);
});

test('mask keeps only a short prefix and the length', () => {
  assert.equal(mask('abcdefghijkl'), 'abcd…(12 chars)');
});

test('scanPaths walks directories and skips binary files', (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.md'), `token ghp_${'abcdef0123'.repeat(4)}\n`);
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 115, 107, 45]));
  const findings = scanPaths([dir]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'github-token');
});

test('secretsFromServerJson reads passwords from server.json files', (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify({ password: 'feedfacefeedface' }));
  assert.deepEqual(secretsFromServerJson([file, path.join(dir, 'missing.json')]), ['feedfacefeedface']);
});

test('CLI exits 1 with masked output when a registered secret is found, 0 when clean', async (t) => {
  const dir = makeTempDir('opc-scan-');
  t.after(() => removeTempDir(dir));
  const secret = 'deadbeefdeadbeefdeadbeef';
  const serverJson = path.join(dir, 'server.json');
  fs.writeFileSync(serverJson, JSON.stringify({ password: secret }));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'ok.md'), '# nothing here\n');
  const clean = await runProcess(process.execPath, [SCRIPT, path.join(dir, 'docs'), '--server-json', serverJson], { env: { PATH: process.env.PATH } });
  assert.equal(clean.code, 0);
  fs.writeFileSync(path.join(dir, 'docs', 'leak.md'), `pw=${secret}\n`);
  const dirty = await runProcess(process.execPath, [SCRIPT, path.join(dir, 'docs'), '--server-json', serverJson], { env: { PATH: process.env.PATH } });
  assert.equal(dirty.code, 1);
  assert.match(dirty.stdout, /leak\.md:1: registered-secret/);
  assert.ok(!dirty.stdout.includes(secret));
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/scan-secrets.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/scripts/scan-secrets.mjs`).

- [ ] **Step 3: Implementar o scanner e o workflow**

Crie `scripts/scan-secrets.mjs`:

````js
#!/usr/bin/env node
// Scans files for secrets (registered server passwords + common token patterns). Exit 1 when something is found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATTERNS = Object.freeze([
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'basic-auth-header', re: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g },
  { kind: 'server-password-env', re: /OPENCODE_SERVER_PASSWORD=(?!\*\*\*)[^\s'"]{8,}/g }, // scan-secrets:allow
  { kind: 'json-password', re: /"password"\s*:\s*"(?!\*\*\*|YOUR_|<|\$\{)[^"]{6,}"/g },
]);

// Lines carrying this marker are exempt from the PATTERNS (test fixtures, this file); registered secrets are always reported.
export const ALLOW_MARKER = 'scan-secrets:allow';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function mask(value) {
  const s = String(value);
  return `${s.slice(0, 4)}…(${s.length} chars)`;
}

export function scanText(text, { secrets = [] } = {}) {
  const findings = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    for (const secret of secrets) {
      if (secret && secret.length >= 8 && line.includes(secret)) findings.push({ line: i + 1, kind: 'registered-secret', sample: mask(secret) });
    }
    if (line.includes(ALLOW_MARKER)) return;
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) findings.push({ line: i + 1, kind, sample: mask(m[0]) });
    }
  });
  return findings;
}

function listFiles(target, out) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return out;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) if (!SKIP_DIRS.has(name)) listFiles(path.join(target, name), out);
  } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
    out.push(target);
  }
  return out;
}

export function scanPaths(paths, { secrets = [] } = {}) {
  const findings = [];
  for (const file of paths.flatMap((p) => listFiles(p, []))) {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;
    for (const f of scanText(buf.toString('utf8'), { secrets })) findings.push({ file, ...f });
  }
  return findings;
}

export function secretsFromServerJson(files) {
  const out = [];
  for (const file of files) {
    try {
      const pw = JSON.parse(fs.readFileSync(file, 'utf8')).password;
      if (typeof pw === 'string' && pw.length >= 8) out.push(pw);
    } catch {
      // missing or invalid server.json: nothing to register
    }
  }
  return out;
}

export function serverJsonFilesUnder(dataDir) {
  const stateRoot = path.join(dataDir, 'state');
  try {
    return fs.readdirSync(stateRoot).map((d) => path.join(stateRoot, d, 'server.json')).filter((f) => fs.existsSync(f));
  } catch {
    return [];
  }
}

function main(argv) {
  const targets = [];
  const serverJsons = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--server-json') {
      if (!argv[i + 1]) {
        process.stderr.write('usage: scan-secrets.mjs <path...> [--server-json <file>]\n');
        return 2;
      }
      serverJsons.push(argv[i + 1]);
      i += 1;
    } else {
      targets.push(argv[i]);
    }
  }
  if (targets.length === 0) {
    process.stderr.write('usage: scan-secrets.mjs <path...> [--server-json <file>]\n');
    return 2;
  }
  if (process.env.OPC_DATA_DIR) serverJsons.push(...serverJsonFilesUnder(process.env.OPC_DATA_DIR));
  const findings = scanPaths(targets, { secrets: secretsFromServerJson(serverJsons) });
  for (const f of findings) process.stdout.write(`${f.file}:${f.line}: ${f.kind} ${f.sample}\n`);
  if (findings.length > 0) {
    process.stderr.write(`scan-secrets: ${findings.length} achado(s).\n`);
    return 1;
  }
  process.stderr.write('scan-secrets: nenhum achado.\n');
  return 0;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
````

Crie `.github/workflows/ci.yml` (as actions ficam fixadas por SHA, como no codex):

````yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    name: test (Node ${{ matrix.node }})
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22]
    steps:
      - name: Check out repository
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Set up Node.js
        uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with:
          node-version: ${{ matrix.node }}

      - name: Show versions
        run: node --version && git --version

      - name: Run test suite (unit + integration, fake OpenCode)
        run: npm test

      - name: Scan for secrets
        run: npm run scan-secrets
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/scan-secrets.test.mjs`
Expected: PASS — `# tests 7`, `# pass 7`.

Run: `node scripts/scan-secrets.mjs scripts tests NOTICE`
Expected: `scan-secrets: nenhum achado.` e exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan-secrets.mjs tests/unit/scan-secrets.test.mjs .github/workflows/ci.yml
git commit -m "ci: add secret scanner and node 20/22 workflow"
```

---

### Task 3: Erros tipados e redação (`opc-error`, `redact`)

**Files:**
- Create: `plugins/opc/scripts/lib/opc-error.mjs`, `plugins/opc/scripts/lib/redact.mjs`
- Test: `tests/unit/opc-error.test.mjs`, `tests/unit/redact.test.mjs`

**Interfaces:**
- Consumes: nada.
- Produces (contrato do mestre):
  - `ExitCode` (congelado), `OpcError(code, message, { exitCode = 7, details, cause })` com `code`, `exitCode`, `details`, `name`.
  - Subclasses com a **mesma** assinatura `(code = <padrão>, message, opts)`: `UsageError` (`'USAGE'`, 2), `PolicyError` (`'POLICY_DENIED'`, 4), `ConnectionError` (`'SERVER_DOWN'`, 5), `NotFoundError` (`'NOT_FOUND'`, 2), `RequestError` (`'SERVER_ERROR'`, 7). Ex.: `new UsageError('TOO_MANY_JOBS', 'msg')`.
  - `toExitCode(err)`.
  - `SECRET_KEYS`, `registerSecret(value)` (≥ 8 chars), `redact(value)` (clone profundo; chave secreta por nome exato, sem distinguir maiúsculas, ou com sufixo `password`/`secret`/`apikey` → `'***'`; strings com segredo registrado → `'***'`; `Error` → `{ name, code, message }`), `redactText(text)`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/unit/opc-error.test.mjs`:

````js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectionError, ExitCode, NotFoundError, OpcError, PolicyError, RequestError, UsageError, toExitCode,
} from '../../plugins/opc/scripts/lib/opc-error.mjs';

test('ExitCode matches spec §4.1 and is frozen', () => {
  assert.deepEqual({ ...ExitCode }, { OK: 0, USAGE: 2, WAITING: 3, POLICY: 4, CONNECTION: 5, WAIT_TIMEOUT: 6, JOB_FAILED: 7, CANCELLED: 130 });
  assert.ok(Object.isFrozen(ExitCode));
});

test('OpcError carries code, exitCode, details and cause', () => {
  const cause = new Error('root');
  const err = new OpcError('SOMETHING', 'msg', { exitCode: 3, details: { a: 1 }, cause });
  assert.equal(err.code, 'SOMETHING');
  assert.equal(err.message, 'msg');
  assert.equal(err.exitCode, 3);
  assert.deepEqual(err.details, { a: 1 });
  assert.equal(err.cause, cause);
  assert.equal(new OpcError('X').exitCode, ExitCode.JOB_FAILED);
});

test('subclasses have default codes and exit codes', () => {
  const cases = [
    [new UsageError(), 'USAGE', 2, 'UsageError'],
    [new PolicyError(), 'POLICY_DENIED', 4, 'PolicyError'],
    [new ConnectionError(), 'SERVER_DOWN', 5, 'ConnectionError'],
    [new NotFoundError(), 'NOT_FOUND', 2, 'NotFoundError'],
    [new RequestError(), 'SERVER_ERROR', 7, 'RequestError'],
  ];
  for (const [err, code, exitCode, name] of cases) {
    assert.ok(err instanceof OpcError);
    assert.equal(err.code, code);
    assert.equal(err.exitCode, exitCode);
    assert.equal(err.name, name);
  }
  const custom = new ConnectionError('AUTH_FAILED', 'nope');
  assert.equal(custom.code, 'AUTH_FAILED');
  assert.equal(custom.exitCode, 5);
  assert.equal(new UsageError('TOO_MANY_JOBS', 'x').exitCode, 2);
});

test('toExitCode maps OpcError to its exitCode and anything else to 7', () => {
  assert.equal(toExitCode(new PolicyError('POLICY_DENIED', 'x')), 4);
  assert.equal(toExitCode(new Error('boom')), 7);
  assert.equal(toExitCode('string'), 7);
});
````

Crie `tests/unit/redact.test.mjs`:

````js
import assert from 'node:assert/strict';
import test from 'node:test';

import { SECRET_KEYS, redact, redactText, registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

test('SECRET_KEYS lists the keys of spec §3.1', () => {
  for (const k of ['key', 'apiKey', 'apikey', 'password', 'authorization', 'headers', 'responseHeaders', 'token', 'secret']) {
    assert.ok(SECRET_KEYS.includes(k), k);
  }
});

test('redact masks secret keys deeply without mutating the input', () => {
  const input = {
    provider: { options: { apiKey: 'sk-live-123', headers: { 'x-a': 'b' }, baseURL: 'https://x' }, key: 'k' },
    list: [{ Authorization: 'Basic abc' }, { token: 't', tokens: { input: 3 } }],
    OPENCODE_SERVER_PASSWORD: 'p',
    nothing: null,
  };
  const out = redact(input);
  assert.equal(out.provider.options.apiKey, '***');
  assert.equal(out.provider.options.headers, '***');
  assert.equal(out.provider.options.baseURL, 'https://x');
  assert.equal(out.provider.key, '***');
  assert.equal(out.list[0].Authorization, '***');
  assert.equal(out.list[1].token, '***');
  assert.deepEqual(out.list[1].tokens, { input: 3 });
  assert.equal(out.OPENCODE_SERVER_PASSWORD, '***');
  assert.equal(out.nothing, null);
  assert.equal(input.provider.options.apiKey, 'sk-live-123');
});

test('registered secrets are replaced in text and nested strings; short values are ignored', () => {
  const secret = 'f00dbabe'.repeat(4);
  registerSecret(secret);
  registerSecret('short');
  assert.equal(redactText(`url ${secret} end ${secret}`), 'url *** end ***');
  assert.equal(redactText('short stays'), 'short stays');
  assert.deepEqual(redact({ msg: `x${secret}y`, arr: [secret] }), { msg: 'x***y', arr: ['***'] });
});

test('redact turns Error objects into safe plain objects', () => {
  const secret = 'c0ffee00'.repeat(4);
  registerSecret(secret);
  const err = Object.assign(new Error(`failed with ${secret}`), { code: 'E' });
  assert.deepEqual(redact(err), { name: 'Error', code: 'E', message: 'failed with ***' });
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/opc-error.test.mjs tests/unit/redact.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/opc-error.mjs`:

````js
// Typed errors and exit codes shared by every opc subcommand (spec §4.1).

export const ExitCode = Object.freeze({
  OK: 0,
  USAGE: 2,
  WAITING: 3,
  POLICY: 4,
  CONNECTION: 5,
  WAIT_TIMEOUT: 6,
  JOB_FAILED: 7,
  CANCELLED: 130,
});

export class OpcError extends Error {
  constructor(code, message, { exitCode = ExitCode.JOB_FAILED, details = undefined, cause = undefined } = {}) {
    super(message ?? code, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function subclass(defaultCode, defaultExit) {
  return class extends OpcError {
    constructor(code = defaultCode, message = undefined, opts = {}) {
      super(code, message, { ...opts, exitCode: opts.exitCode ?? defaultExit });
    }
  };
}

export class UsageError extends subclass('USAGE', ExitCode.USAGE) {}
export class PolicyError extends subclass('POLICY_DENIED', ExitCode.POLICY) {}
export class ConnectionError extends subclass('SERVER_DOWN', ExitCode.CONNECTION) {}
export class NotFoundError extends subclass('NOT_FOUND', ExitCode.USAGE) {}
export class RequestError extends subclass('SERVER_ERROR', ExitCode.JOB_FAILED) {}

export function toExitCode(err) {
  if (err instanceof OpcError && Number.isInteger(err.exitCode)) return err.exitCode;
  return ExitCode.JOB_FAILED;
}
````

Crie `plugins/opc/scripts/lib/redact.mjs`:

````js
// Secret redaction for every JSON output and log line (spec §3.1).

export const SECRET_KEYS = Object.freeze([
  'key', 'apiKey', 'apikey', 'password', 'authorization', 'headers', 'responseHeaders', 'token', 'secret',
]);

const EXACT = new Set(SECRET_KEYS.map((k) => k.toLowerCase()));
const SUFFIXES = ['password', 'secret', 'apikey'];
const MASK = '***';
const MIN_SECRET_LENGTH = 8;
const registered = new Set();

function isSecretKey(key) {
  const lower = String(key).toLowerCase();
  return EXACT.has(lower) || SUFFIXES.some((s) => lower.endsWith(s));
}

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) registered.add(value);
}

export function redactText(text) {
  if (typeof text !== 'string' || registered.size === 0) return text;
  let out = text;
  for (const secret of registered) out = out.split(secret).join(MASK);
  return out;
}

export function redact(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, code: value.code, message: redactText(value.message) };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) && v !== null && v !== undefined ? MASK : redact(v);
    }
    return out;
  }
  return value;
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/opc-error.test.mjs tests/unit/redact.test.mjs`
Expected: PASS — `# tests 8`, `# pass 8`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/opc-error.mjs plugins/opc/scripts/lib/redact.mjs tests/unit/opc-error.test.mjs tests/unit/redact.test.mjs
git commit -m "feat: add typed errors and secret redaction"
```

---

### Task 4: Argumentos sem expansão (`args`)

Base da regra de segurança do §4: os argumentos do usuário chegam por stdin (heredoc com delimitador entre aspas) e são divididos **sem** expansão de variáveis, crases ou `$()`. Um `'` precedido **e** seguido por letra/dígito Unicode (`/[\p{L}\p{N}]/u` — `don't`, `rock'n'roll`, `l'été`) é sempre literal e nunca abre aspas; e aspas não fechadas que sobrarem (ex.: `"hi`, `users'`) viram caracteres literais em vez de engolir o resto da linha.

**Files:**
- Create: `plugins/opc/scripts/lib/args.mjs`
- Test: `tests/unit/args.test.mjs`

**Interfaces:**
- Consumes: `UsageError` (Task 3).
- Produces: `splitArgString(input) → string[]` (apóstrofo entre letras/dígitos Unicode é literal; aspas não fechadas viram literais); `readStdin(stream = process.stdin) → Promise<string>` (vazio se TTY); `resolveArgv(argv, { stdin }) → Promise<string[]>`; `extractCwd(argv) → { cwd: string|null, argv: string[] }` (**nova**: remove `--cwd <dir>`/`--cwd=<dir>` antes de `--`); `parseArgs(argv, spec) → { flags, positionals }` com tipos `boolean|string|number|list`, `alias`, `default`, `allowPositionals`; booleanos começam `false`, listas `[]`; flag desconhecida, valor ausente, número inválido ou posicional inesperado → `UsageError` (exit 2).

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/args.test.mjs`:

````js
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { extractCwd, parseArgs, readStdin, resolveArgv, splitArgString } from '../../plugins/opc/scripts/lib/args.mjs';
import { UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const stdinOf = (text) => Readable.from([Buffer.from(text, 'utf8')]);

test('splitArgString splits like a shell without any expansion', () => {
  assert.deepEqual(splitArgString('a b  c'), ['a', 'b', 'c']);
  assert.deepEqual(splitArgString(`--model "prov/x y" 'single $HOME' \`ls\` $(touch pwned)`), [
    '--model', 'prov/x y', 'single $HOME', '`ls`', '$(touch', 'pwned)',
  ]);
  assert.deepEqual(splitArgString('"a \\" b" \'c\\d\' e\\ f'), ['a " b', 'c\\d', 'e f']);
  assert.deepEqual(splitArgString("'' \"\""), ['', '']);
  assert.deepEqual(splitArgString(''), []);
});

test('prompt-roundtrip: quotes, backticks, $(), newlines and unicode survive intact', () => {
  const prompt = 'Corrija "isso" com `crases`, $(rm -rf ~) e $HOME\nsegunda linha: ação ✓ 🚀 日本';
  const quoted = `'${prompt.replace(/'/g, `'\\''`)}'`;
  assert.deepEqual(splitArgString(`--json ${quoted}`), ['--json', prompt]);
  assert.deepEqual(splitArgString(`"${prompt.replace(/(["\\$`])/g, '\\$1')}"`), [prompt]);
});

test('unterminated quotes are treated as literal characters (apostrophes in prose)', () => {
  assert.deepEqual(splitArgString("fix the user's code"), ['fix', 'the', "user's", 'code']);
  assert.deepEqual(splitArgString('say "hi'), ['say', '"hi']);
  assert.deepEqual(splitArgString(`it's "quoted text" ok`), ["it's", 'quoted text', 'ok']);
});

test('an apostrophe between letters/digits is literal and never opens a quote', () => {
  assert.deepEqual(splitArgString("don't and can't stop"), ["don't", 'and', "can't", 'stop']);
  assert.deepEqual(splitArgString("--goal 'it is' rock'n'roll"), ['--goal', 'it is', "rock'n'roll"]);
  assert.deepEqual(splitArgString("l'été 2'3 'a'\\''b'"), ["l'été", "2'3", "a'b"]);
});

test('newlines outside quotes separate tokens; backslash-newline joins lines', () => {
  assert.deepEqual(splitArgString('a\nb\\\nc'), ['a', 'bc']);
});

test('readStdin returns empty for TTY streams and the full text otherwise', async () => {
  assert.equal(await readStdin({ isTTY: true }), '');
  assert.equal(await readStdin(stdinOf('olá\nmundo')), 'olá\nmundo');
});

test('resolveArgv appends stdin tokens only when --args-stdin is present', async () => {
  assert.deepEqual(await resolveArgv(['setup', '--json'], { stdin: stdinOf('ignored') }), ['setup', '--json']);
  assert.deepEqual(await resolveArgv(['setup', '--args-stdin'], { stdin: stdinOf('--stop-server "a b"\n') }), [
    'setup', '--stop-server', 'a b',
  ]);
});

test('extractCwd removes --cwd from anywhere before --', () => {
  assert.deepEqual(extractCwd(['setup', '--cwd', '/tmp/x y', '--json']), { cwd: '/tmp/x y', argv: ['setup', '--json'] });
  assert.deepEqual(extractCwd(['--cwd=/a', 'setup']), { cwd: '/a', argv: ['setup'] });
  assert.deepEqual(extractCwd(['task', '--', '--cwd', 'x']), { cwd: null, argv: ['task', '--', '--cwd', 'x'] });
  assert.throws(() => extractCwd(['setup', '--cwd']), UsageError);
});

const SPEC = {
  flags: {
    json: { type: 'boolean' },
    model: { type: 'string', alias: 'm' },
    timeout: { type: 'number', default: 30 },
    models: { type: 'list' },
  },
  allowPositionals: true,
};

test('parseArgs handles booleans, strings, aliases, numbers, lists and defaults', () => {
  const { flags, positionals } = parseArgs(['--json', '-m', 'prov/a/b', '--timeout=5', '--models', 'a,b', '--models', 'c', 'hello', 'world'], SPEC);
  assert.deepEqual(flags, { json: true, model: 'prov/a/b', timeout: 5, models: ['a', 'b', 'c'] });
  assert.deepEqual(positionals, ['hello', 'world']);
  assert.deepEqual(parseArgs([], SPEC).flags, { json: false, timeout: 30, models: [] });
});

test('parseArgs keeps everything after -- as positionals', () => {
  assert.deepEqual(parseArgs(['--json', '--', '--not-a-flag', '-m'], SPEC).positionals, ['--not-a-flag', '-m']);
});

test('parseArgs rejects unknown flags, missing values, bad numbers and unexpected positionals', () => {
  assert.throws(() => parseArgs(['--nope'], SPEC), (e) => e instanceof UsageError && e.exitCode === 2);
  assert.throws(() => parseArgs(['--model'], SPEC), UsageError);
  assert.throws(() => parseArgs(['--timeout', 'abc'], SPEC), UsageError);
  assert.throws(() => parseArgs(['extra'], { flags: {} }), UsageError);
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/args.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/args.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/args.mjs`:

````js
// Argument handling: shell-like splitting WITHOUT expansion, --args-stdin, flag parsing.
import { UsageError } from './opc-error.mjs';

const WHITESPACE = /\s/;
const WORD_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_AFTER = /^[\p{L}\p{N}]/u;

// An apostrophe between two letters/digits (don't, rock'n'roll) is prose, never a quote.
// slice() over two code units keeps astral letters (surrogate pairs) intact.
function isIntraWordApostrophe(input, i) {
  return input[i] === "'"
    && WORD_BEFORE.test(input.slice(Math.max(0, i - 2), i))
    && WORD_AFTER.test(input.slice(i + 1, i + 3));
}

function tokenize(input, literalQuotes) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;
  let quoteStart = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
        current += input[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < input.length) {
        if (input[i + 1] !== '\n') {
          current += input[i + 1];
          inToken = true;
        }
        i += 1;
      } else {
        current += ch;
        inToken = true;
      }
      continue;
    }
    if ((ch === "'" || ch === '"') && !literalQuotes.has(i) && !isIntraWordApostrophe(input, i)) {
      quote = ch;
      quoteStart = i;
      inToken = true;
      continue;
    }
    if (WHITESPACE.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return { unterminatedAt: quoteStart };
  if (inToken) tokens.push(current);
  return { tokens };
}

export function splitArgString(input) {
  const text = String(input ?? '');
  const literalQuotes = new Set();
  for (;;) {
    const result = tokenize(text, literalQuotes);
    if (result.tokens) return result.tokens;
    literalQuotes.add(result.unterminatedAt);
  }
}

export async function readStdin(stream = process.stdin) {
  if (!stream || stream.isTTY) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function resolveArgv(argv, { stdin = process.stdin } = {}) {
  const index = argv.indexOf('--args-stdin');
  if (index === -1) return [...argv];
  const rest = argv.filter((token, i) => i !== index);
  const content = await readStdin(stdin);
  return [...rest, ...splitArgString(content)];
}

export function extractCwd(argv) {
  const out = [];
  let cwd = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (token === '--cwd') {
      if (i + 1 >= argv.length) throw new UsageError('USAGE', 'Faltou o valor de --cwd.');
      cwd = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
      continue;
    }
    out.push(token);
  }
  return { cwd, argv: out };
}

function coerce(name, def, raw) {
  switch (def.type) {
    case 'number': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new UsageError('USAGE', `--${name} exige um número (recebido: ${raw}).`);
      return n;
    }
    case 'list':
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return String(raw);
  }
}

export function parseArgs(argv, spec) {
  const defs = spec?.flags ?? {};
  const aliases = new Map();
  for (const [name, def] of Object.entries(defs)) if (def.alias) aliases.set(def.alias, name);
  const flags = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.default !== undefined) flags[name] = Array.isArray(def.default) ? [...def.default] : def.default;
    else if (def.type === 'boolean') flags[name] = false;
    else if (def.type === 'list') flags[name] = [];
  }
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const isLong = token.startsWith('--') && token.length > 2;
    const isShort = !isLong && token.startsWith('-') && token.length === 2 && token !== '--';
    if (!isLong && !isShort) {
      positionals.push(token);
      continue;
    }
    let rawName;
    let inline;
    if (isLong) {
      const eq = token.indexOf('=');
      rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      rawName = token.slice(1);
    }
    const name = defs[rawName] ? rawName : aliases.get(rawName);
    if (!name) throw new UsageError('USAGE', `Flag desconhecida: ${token}`);
    const def = defs[name];
    if (def.type === 'boolean') {
      if (inline !== undefined) flags[name] = !['false', '0', 'no'].includes(inline.toLowerCase());
      else flags[name] = true;
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      if (i + 1 >= argv.length) throw new UsageError('USAGE', `Faltou o valor de ${token}.`);
      raw = argv[i + 1];
      i += 1;
    }
    const value = coerce(name, def, raw);
    flags[name] = def.type === 'list' ? [...(flags[name] ?? []), ...value] : value;
  }
  if (positionals.length > 0 && !spec?.allowPositionals) {
    throw new UsageError('USAGE', `Argumento inesperado: ${positionals[0]}`);
  }
  return { flags, positionals };
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/args.test.mjs`
Expected: PASS — `# tests 11`, `# pass 11`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/args.mjs tests/unit/args.test.mjs
git commit -m "feat: add shell-like argument splitting without expansion"
```

---

### Task 5: Identidade de processo, spawn destacado e kill em grupo (`process`)

Identidade = `{ pid, startTime, cmdline }` (Linux: campo 22 de `/proc/<pid>/stat` e `/proc/<pid>/cmdline`; macOS: `ps -o lstart=`/`command=` com `LC_ALL=C`). Zumbis contam como mortos (um filho destacado que morreu vira zumbi até ser colhido). O spawn manda stdout/stderr para um arquivo (nunca pipe para o pai de vida curta — evita EPIPE, spec §14.1).

**Files:**
- Create: `plugins/opc/scripts/lib/process.mjs`
- Test: `tests/unit/process.test.mjs`

**Interfaces:**
- Consumes: `tests/helpers.mjs` (`deadPid, makeTempDir, removeTempDir, waitFor`).
- Produces (contrato do mestre): `isPidAlive(pid)`, `getProcessIdentity(pid) → { pid, startTime: string, cmdline: string[] } | null`, `identityMatches(expected, matcher)`, `spawnDetached(command, args, { cwd, env, logFile }) → { pid, startTime }` (log aberto em modo `'a'` e 600; binário inexistente → erro com `code: 'ENOENT'`), `terminateProcessGroup(expected, matcher, { graceMs = 3000 }) → 'not-running' | 'identity-mismatch' | 'terminated' | 'killed'` (confere a identidade antes de cada sinal; SIGTERM no grupo, espera `graceMs`, SIGKILL no grupo).

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/process.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getProcessIdentity, identityMatches, isPidAlive, spawnDetached, terminateProcessGroup,
} from '../../plugins/opc/scripts/lib/process.mjs';
import { deadPid, makeTempDir, removeTempDir, waitFor } from '../helpers.mjs';

const linuxOnly = { skip: process.platform !== 'linux' && 'process groups and /proc are validated on Linux only' };
const IDLE = 'setInterval(() => {}, 1000)';
const IGNORE_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

function killHard(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

test('isPidAlive is true for this process and false for a dead or invalid pid', async () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(await deadPid()), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
});

test('getProcessIdentity returns start time and cmdline; null for dead pids', async () => {
  const me = getProcessIdentity(process.pid);
  assert.equal(me.pid, process.pid);
  assert.ok(me.startTime && String(me.startTime).length > 0);
  assert.ok(me.cmdline.some((a) => a.includes('node')));
  assert.equal(getProcessIdentity(await deadPid()), null);
});

test('identityMatches checks start time and the cmdline matcher', () => {
  const me = getProcessIdentity(process.pid);
  assert.equal(identityMatches({ pid: process.pid, startTime: me.startTime }, () => true), true);
  assert.equal(identityMatches({ pid: process.pid, startTime: 'other' }, () => true), false);
  assert.equal(identityMatches({ pid: process.pid, startTime: me.startTime }, () => false), false);
});

test('spawnDetached starts a group leader writing to the log file (mode 600)', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const logFile = path.join(dir, 'out.log');
  const proc = spawnDetached(process.execPath, ['-e', `console.log('hello-from-child'); ${IDLE}`], { cwd: dir, env: process.env, logFile });
  t.after(() => killHard(proc.pid));
  assert.ok(proc.pid > 0);
  assert.equal(proc.startTime, getProcessIdentity(proc.pid).startTime);
  const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf8');
  const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  assert.equal(pgrp, proc.pid);
  await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('hello-from-child'), { message: 'child output in log' });
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test('spawnDetached throws ENOENT for a missing binary', (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  assert.throws(() => spawnDetached('definitely-not-a-binary-opc', [], { cwd: dir, env: process.env, logFile: path.join(dir, 'l') }), { code: 'ENOENT' });
});

test('an exited detached child is reported dead (zombie-aware)', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const proc = spawnDetached(process.execPath, ['-e', ''], { cwd: dir, env: process.env, logFile: path.join(dir, 'l') });
  await waitFor(() => !isPidAlive(proc.pid), { message: 'child exit' });
  assert.equal(getProcessIdentity(proc.pid), null);
});

test('terminateProcessGroup: terminated with SIGTERM, killed when SIGTERM is ignored', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const polite = spawnDetached(process.execPath, ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'a') });
  t.after(() => killHard(polite.pid));
  assert.equal(await terminateProcessGroup(polite, () => true, { graceMs: 2000 }), 'terminated');
  assert.equal(isPidAlive(polite.pid), false);

  const stubborn = spawnDetached(process.execPath, ['-e', IGNORE_TERM], { cwd: dir, env: process.env, logFile: path.join(dir, 'b') });
  t.after(() => killHard(stubborn.pid));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await terminateProcessGroup(stubborn, () => true, { graceMs: 300 }), 'killed');
  assert.equal(isPidAlive(stubborn.pid), false);
});

test('terminateProcessGroup never signals a process whose identity does not match', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const other = spawnDetached(process.execPath, ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'c') });
  t.after(() => killHard(other.pid));
  assert.equal(await terminateProcessGroup(other, () => false), 'identity-mismatch');
  assert.equal(await terminateProcessGroup({ pid: other.pid, startTime: 'bogus' }, () => true), 'identity-mismatch');
  assert.equal(isPidAlive(other.pid), true);
  assert.equal(await terminateProcessGroup({ pid: await deadPid(), startTime: '1' }, () => true), 'not-running');
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/process.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/process.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/process.mjs`:

````js
// Process identity (cmdline + start time), detached spawn and group termination (spec §5.1.3, §5.5).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 2).split(' ');
    // fields[0] = state (field 3), fields[19] = starttime (field 22)
    return { state: fields[0], startTime: fields[19] };
  } catch {
    return null;
  }
}

function psField(pid, field) {
  const res = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out === '' ? null : out;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (process.platform === 'linux') {
    const stat = readProcStat(pid);
    return Boolean(stat) && stat.state !== 'Z';
  }
  if (process.platform === 'win32') return true;
  const state = psField(pid, 'stat');
  return Boolean(state) && !state.startsWith('Z');
}

export function getProcessIdentity(pid) {
  if (!isPidAlive(pid)) return null;
  if (process.platform === 'linux') {
    const stat = readProcStat(pid);
    if (!stat) return null;
    let cmdline = [];
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0);
    } catch {
      return null;
    }
    return { pid, startTime: stat.startTime, cmdline };
  }
  if (process.platform === 'win32') return null;
  const startTime = psField(pid, 'lstart');
  const command = psField(pid, 'command');
  if (!startTime || !command) return null;
  return { pid, startTime, cmdline: command.split(/\s+/) };
}

export function identityMatches(expected, matcher) {
  if (!expected || !Number.isInteger(expected.pid)) return false;
  const current = getProcessIdentity(expected.pid);
  if (!current) return false;
  if (String(current.startTime) !== String(expected.startTime)) return false;
  return Boolean(matcher(current.cmdline));
}

export function spawnDetached(command, args, { cwd, env, logFile }) {
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.on('error', () => {});
    if (!child.pid) {
      const err = new Error(`failed to spawn ${command}`);
      err.code = 'ENOENT';
      throw err;
    }
    child.unref();
    const identity = getProcessIdentity(child.pid);
    return { pid: child.pid, startTime: identity ? identity.startTime : null };
  } finally {
    fs.closeSync(fd);
  }
}

function signalGroup(pid, signal) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

function check(expected, matcher) {
  const current = getProcessIdentity(expected.pid);
  if (!current) return 'gone';
  if (String(current.startTime) !== String(expected.startTime) || !matcher(current.cmdline)) return 'mismatch';
  return 'ok';
}

async function waitGone(expected, matcher, ms) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    await sleep(100);
    if (check(expected, matcher) !== 'ok') return true;
  }
  return check(expected, matcher) !== 'ok';
}

export async function terminateProcessGroup(expected, matcher, { graceMs = 3000 } = {}) {
  const first = check(expected, matcher);
  if (first === 'gone') return 'not-running';
  if (first === 'mismatch') return 'identity-mismatch';
  signalGroup(expected.pid, 'SIGTERM');
  if (await waitGone(expected, matcher, graceMs)) return 'terminated';
  if (check(expected, matcher) !== 'ok') return 'terminated';
  signalGroup(expected.pid, 'SIGKILL');
  await waitGone(expected, matcher, 2000);
  return 'killed';
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/process.test.mjs`
Expected: PASS — `# tests 8`, `# pass 8` (fora do Linux, 4 deles aparecem como `skipped`).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/process.mjs tests/unit/process.test.mjs
git commit -m "feat: add process identity and group termination"
```

---

### Task 6: Locks com dono verificável (`locks`)

Spec §5.6: criação com `O_EXCL` contendo `{pid, startTime, acquiredAt, purpose, token}`; dono morto ou pid reaproveitado (start time diferente) → quebra atômica por `rename` para `*.stale-<ts>-<pid>` e nova tentativa. Se o `rename` pegar um lock recém-criado por outro processo, ele é devolvido com `link` (sem sobrescrever). Arquivo de lock vazio/ilegível com menos de 5 s é respeitado (janela entre `open` e `write`). `release()` só apaga o lock se o `token` ainda for o seu. O diretório do lock precisa existir (o chamador garante; nada é criado implicitamente).

**Files:**
- Create: `plugins/opc/scripts/lib/locks.mjs`
- Test: `tests/unit/locks.test.mjs`

**Interfaces:**
- Consumes: `ConnectionError` (Task 3); `getProcessIdentity` (Task 5).
- Produces (contrato do mestre): `acquireLock(lockPath, { timeoutMs, purpose, pollMs = 100 }) → release` (timeout → `ConnectionError('TIMEOUT')` com o pid/propósito do dono em `details.owner`), `tryAcquireLock(lockPath, { purpose }) → release | null`, `withLock(lockPath, opts, fn)`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/locks.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { acquireLock, tryAcquireLock, withLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { PLUGIN_ROOT, deadPid, makeTempDir, removeTempDir, runProcess } from '../helpers.mjs';

function tempLock(t) {
  const dir = makeTempDir('opc-lock-');
  t.after(() => removeTempDir(dir));
  return { dir, lock: path.join(dir, 'server.lock') };
}

test('tryAcquireLock creates an O_EXCL file (600) with the owner and release removes it', (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'test' });
  assert.equal(typeof release, 'function');
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.purpose, 'test');
  assert.ok(owner.startTime && owner.acquiredAt && owner.token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.equal(tryAcquireLock(lock, { purpose: 'second' }), null);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('acquireLock times out with ConnectionError TIMEOUT naming the holder', async (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'holder' });
  t.after(release);
  await assert.rejects(acquireLock(lock, { timeoutMs: 200, purpose: 'waiter', pollMs: 20 }), (err) => {
    assert.ok(err instanceof ConnectionError);
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.message, /holder/);
    return true;
  });
});

test('stale-lock: a lock owned by a dead pid is broken atomically (renamed to *.stale-*)', async (t) => {
  const { dir, lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: '1', acquiredAt: 'x', purpose: 'ghost', token: 'old' }));
  const release = await acquireLock(lock, { timeoutMs: 1000, purpose: 'new' });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'new');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('server.lock.stale-')).length, 1);
  release();
});

test('a lock whose owner pid was reused (start time differs) is broken', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: 'not-my-start-time', purpose: 'reused', token: 't' }));
  const release = await acquireLock(lock, { timeoutMs: 1000, purpose: 'new' });
  release();
});

test('a fresh unreadable lock is respected; an old unreadable one is broken', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, '');
  assert.equal(tryAcquireLock(lock, { purpose: 'x' }), null);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const release = tryAcquireLock(lock, { purpose: 'x' });
  assert.equal(typeof release, 'function');
  release();
});

test('release never removes a lock that now belongs to someone else', (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'mine' });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: null, purpose: 'theirs', token: 'other' }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'theirs');
});

test('withLock releases on success and on failure', async (t) => {
  const { lock } = tempLock(t);
  assert.equal(await withLock(lock, { timeoutMs: 500 }, async () => 42), 42);
  assert.equal(fs.existsSync(lock), false);
  await assert.rejects(withLock(lock, { timeoutMs: 500 }, async () => { throw new Error('inner'); }), /inner/);
  assert.equal(fs.existsSync(lock), false);
});

test('withLock gives mutual exclusion across processes', async (t) => {
  const { dir, lock } = tempLock(t);
  const counter = path.join(dir, 'counter.txt');
  fs.writeFileSync(counter, '0');
  const locksUrl = pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'locks.mjs')).href;
  const script = `
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(locksUrl)};
    await withLock(${JSON.stringify(lock)}, { timeoutMs: 20000, purpose: 'counter', pollMs: 10 }, async () => {
      const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
    });
  `;
  const runs = Array.from({ length: 5 }, () => runProcess(process.execPath, ['--input-type=module', '-e', script], { env: process.env }));
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), '5');
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/locks.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/locks.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/locks.mjs`:

````js
// File locks with O_EXCL, verifiable owner and atomic breaking of orphan locks (spec §5.6).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ConnectionError } from './opc-error.mjs';
import { getProcessIdentity } from './process.mjs';

const FRESH_UNREADABLE_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return { raw, owner: JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { raw: null, owner: null };
  }
}

function ownerAlive(lockPath, info) {
  if (info.missing) return false;
  if (!info.owner || !Number.isInteger(info.owner.pid)) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < FRESH_UNREADABLE_MS;
    } catch {
      return false;
    }
  }
  const identity = getProcessIdentity(info.owner.pid);
  if (!identity) return false;
  if (info.owner.startTime === null || info.owner.startTime === undefined) return true;
  return String(identity.startTime) === String(info.owner.startTime);
}

function createLockFile(lockPath, purpose) {
  const me = getProcessIdentity(process.pid);
  const token = randomUUID();
  const body = JSON.stringify({
    pid: process.pid,
    startTime: me ? me.startTime : null,
    acquiredAt: new Date().toISOString(),
    purpose: purpose ?? null,
    token,
  });
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const info = readOwner(lockPath);
    if (info.owner && info.owner.token === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  };
}

function breakStaleLock(lockPath, judged) {
  const stale = `${lockPath}.stale-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(lockPath, stale);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const moved = readOwner(stale);
  const sameLock = (moved.raw ?? null) === (judged.raw ?? null);
  if (!sameLock) {
    // We moved a fresh lock taken by someone else between our check and the rename: put it back.
    try {
      fs.linkSync(stale, lockPath);
      fs.unlinkSync(stale);
    } catch {
      // A third process already holds lockPath; the stale copy stays for inspection.
    }
  }
}

export function tryAcquireLock(lockPath, { purpose } = {}) {
  try {
    return createLockFile(lockPath, purpose);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const info = readOwner(lockPath);
  if (ownerAlive(lockPath, info)) return null;
  breakStaleLock(lockPath, info);
  try {
    return createLockFile(lockPath, purpose);
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

export async function acquireLock(lockPath, { timeoutMs, purpose, pollMs = 100 } = {}) {
  const deadline = performance.now() + (timeoutMs ?? 0);
  for (;;) {
    const release = tryAcquireLock(lockPath, { purpose });
    if (release) return release;
    if (performance.now() >= deadline) {
      const { owner } = readOwner(lockPath);
      const holder = owner ? ` (dono: pid ${owner.pid}, ${owner.purpose ?? 'sem propósito'})` : '';
      throw new ConnectionError('TIMEOUT', `Tempo esgotado esperando o lock ${path.basename(lockPath)}${holder}.`, {
        details: { lock: path.basename(lockPath), owner: owner ? { pid: owner.pid, purpose: owner.purpose } : null },
      });
    }
    await sleep(pollMs);
  }
}

export async function withLock(lockPath, opts, fn) {
  const release = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/locks.test.mjs`
Expected: PASS — `# tests 8`, `# pass 8`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/locks.mjs tests/unit/locks.test.mjs
git commit -m "feat: add file locks with verifiable owners"
```

---

### Task 7: Diretório de dados e estado por workspace (`state`)

Spec §3.2. Resolução do diretório de dados sem fallback para `$TMPDIR`; estado em `<dataDir>/state/<slug>-<sha256(realpath)[:16]>/` (slug sem acentos, espaços → `-`, até 40 chars); diretórios 700 conferindo o dono; escrita atômica (tmp + rename) com modo 600; `state.json` corrompido → cópia `state.json.corrupt-<ts>` e reconstrução a partir de `jobs/*.json`.

**Files:**
- Create: `plugins/opc/scripts/lib/state.mjs`
- Test: `tests/unit/state.test.mjs`

**Interfaces:**
- Consumes: `withLock` (Task 6); `OpcError`, `UsageError` (Task 3).
- Produces (contrato do mestre): `resolveDataDir(env, { home, pluginDataId })` (erro `OpcError('DATA_DIR_UNRESOLVED')`, exit 2), `resolveWorkspaceRoot(cwd)` (cwd inexistente → `UsageError`), `workspaceStateDir(dataDir, workspaceRoot)`, `ensurePrivateDir(dir) → dir` (dono diferente → `OpcError('UNSAFE_DIR')`, exit 2), `writeFileAtomic(filePath, data, { mode = 0o600 })` (objeto → JSON com 2 espaços), `readJson(filePath, fallback)`, `loadState(stateDir)`, `updateState(stateDir, mutator)` (sob `state.lock`, 10 s).
- Produces (**novas**): `PLUGIN_DATA_ID = 'opc-opencode-plugin-cc'`, `defaultDataDir({ home, pluginDataId }) → string`, `ACTIVE_JOB_STATUSES = ['queued','running','waiting_permission']`, `listActiveJobs(stateDir) → job[]`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/state.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ACTIVE_JOB_STATUSES, PLUGIN_DATA_ID, defaultDataDir, ensurePrivateDir, listActiveJobs, loadState, readJson,
  resolveDataDir, resolveWorkspaceRoot, updateState, workspaceStateDir, writeFileAtomic,
} from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, makeWorkspace, removeTempDir } from '../helpers.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX modes' };

function temp(t) {
  const dir = makeTempDir('opc-state-');
  t.after(() => removeTempDir(dir));
  return dir;
}

test('resolveDataDir order: OPC_DATA_DIR > CLAUDE_PLUGIN_DATA > existing default > error', (t) => {
  const home = temp(t);
  assert.equal(resolveDataDir({ OPC_DATA_DIR: '/a', CLAUDE_PLUGIN_DATA: '/b' }, { home }), path.resolve('/a'));
  assert.equal(resolveDataDir({ OPC_DATA_DIR: '', CLAUDE_PLUGIN_DATA: '/b' }, { home }), path.resolve('/b'));
  assert.throws(() => resolveDataDir({}, { home }), (err) => err.code === 'DATA_DIR_UNRESOLVED' && err.exitCode === 2 && /\/opc:setup/.test(err.message));
  fs.mkdirSync(defaultDataDir({ home }), { recursive: true });
  assert.equal(resolveDataDir({}, { home }), path.join(home, '.claude', 'plugins', 'data', PLUGIN_DATA_ID));
  assert.equal(PLUGIN_DATA_ID, 'opc-opencode-plugin-cc');
});

test('resolveWorkspaceRoot uses the git toplevel, or realpath(cwd) outside git', (t) => {
  const ws = makeWorkspace(t, { name: 'repo' });
  fs.mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true });
  assert.equal(resolveWorkspaceRoot(path.join(ws, 'sub', 'deep')), ws);
  const plain = temp(t);
  assert.equal(resolveWorkspaceRoot(plain), fs.realpathSync(plain));
  assert.throws(() => resolveWorkspaceRoot(path.join(plain, 'missing')), { code: 'USAGE' });
});

test('workspace-with-spaces: slug is sanitized, hash uses the realpath, symlinks map to the same dir', (t) => {
  const base = temp(t);
  const ws = path.join(base, 'meu projeto ação');
  fs.mkdirSync(ws);
  const link = path.join(base, 'atalho');
  fs.symlinkSync(ws, link);
  const dir = workspaceStateDir('/data', ws);
  assert.match(path.basename(dir), /^meu-projeto-acao-[0-9a-f]{16}$/);
  assert.equal(path.dirname(dir), path.join('/data', 'state'));
  assert.equal(workspaceStateDir('/data', link), dir);
  assert.notEqual(workspaceStateDir('/data', base), dir);
});

test('ensurePrivateDir creates 700 dirs and tightens existing ones', posixOnly, (t) => {
  const base = temp(t);
  const target = path.join(base, 'a', 'b');
  ensurePrivateDir(target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  const loose = path.join(base, 'loose');
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.chmodSync(loose, 0o755);
  ensurePrivateDir(loose);
  assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
});

test('writeFileAtomic writes JSON or text with mode 600 and leaves no temp files', posixOnly, (t) => {
  const base = temp(t);
  const file = path.join(base, 'x.json');
  writeFileAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeFileAtomic(file, 'plain', { mode: 0o644 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'plain');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(base), ['x.json']);
});

test('readJson returns the fallback for missing or invalid files', (t) => {
  const base = temp(t);
  assert.equal(readJson(path.join(base, 'none.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(base, 'bad.json'), '{oops');
  assert.equal(readJson(path.join(base, 'bad.json'), null), null);
});

test('loadState returns the default shape when state.json is missing', (t) => {
  assert.deepEqual(loadState(temp(t)), { version: 1, claudeSessions: [], jobs: [] });
});

test('loadState backs up a corrupted state.json and rebuilds jobs from jobs/*.json', (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'jobs'));
  fs.writeFileSync(path.join(dir, 'jobs', 'task-1.json'), JSON.stringify({ id: 'task-1', status: 'completed' }));
  fs.writeFileSync(path.join(dir, 'jobs', 'broken.json'), '{');
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  const state = loadState(dir);
  assert.deepEqual(state.jobs.map((j) => j.id), ['task-1']);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('state.json.corrupt-')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs.map((j) => j.id), ['task-1']);
});

test('updateState serializes concurrent mutations under state.lock', async (t) => {
  const dir = temp(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => updateState(dir, (s) => {
    s.jobs.push({ id: `job-${i}`, status: 'completed' });
  })));
  assert.equal(loadState(dir).jobs.length, 10);
  const replaced = await updateState(dir, () => ({ claudeSessions: [{ sessionId: 's' }], jobs: [] }));
  assert.deepEqual(replaced, { version: 1, claudeSessions: [{ sessionId: 's' }], jobs: [] });
  assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false);
});

test('listActiveJobs filters by ACTIVE_JOB_STATUSES', async (t) => {
  const dir = temp(t);
  assert.deepEqual([...ACTIVE_JOB_STATUSES], ['queued', 'running', 'waiting_permission']);
  await updateState(dir, (s) => {
    s.jobs.push({ id: 'a', status: 'running' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'waiting_permission' });
  });
  assert.deepEqual(listActiveJobs(dir).map((j) => j.id), ['a', 'c']);
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/state.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/state.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/state.mjs`:

````js
// Data directory, per-workspace state directory, atomic writes, private modes (spec §3.2).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withLock } from './locks.mjs';
import { OpcError, UsageError } from './opc-error.mjs';

export const PLUGIN_DATA_ID = 'opc-opencode-plugin-cc';
export const ACTIVE_JOB_STATUSES = Object.freeze(['queued', 'running', 'waiting_permission']);
const STATE_LOCK_TIMEOUT_MS = 10000;

export function defaultDataDir({ home = os.homedir(), pluginDataId = PLUGIN_DATA_ID } = {}) {
  return path.join(home, '.claude', 'plugins', 'data', pluginDataId);
}

export function resolveDataDir(env = process.env, { home = os.homedir(), pluginDataId = PLUGIN_DATA_ID } = {}) {
  if (env.OPC_DATA_DIR) return path.resolve(env.OPC_DATA_DIR);
  if (env.CLAUDE_PLUGIN_DATA) return path.resolve(env.CLAUDE_PLUGIN_DATA);
  const candidate = defaultDataDir({ home, pluginDataId });
  if (fs.existsSync(candidate)) return candidate;
  throw new OpcError(
    'DATA_DIR_UNRESOLVED',
    'Diretório de dados do opc não encontrado. Rode /opc:setup dentro do Claude Code (ou defina OPC_DATA_DIR).',
    { exitCode: 2 },
  );
}

export function resolveWorkspaceRoot(cwd) {
  let real;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    throw new UsageError('USAGE', `Diretório não encontrado: ${cwd}`);
  }
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8', shell: false });
  if (res.status === 0 && res.stdout.trim()) {
    try {
      return fs.realpathSync.native(res.stdout.trim());
    } catch {
      return real;
    }
  }
  return real;
}

function slugFor(dir) {
  const base = path.basename(dir) || 'workspace';
  const slug = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'workspace';
}

export function workspaceStateDir(dataDir, workspaceRoot) {
  let real = workspaceRoot;
  try {
    real = fs.realpathSync.native(workspaceRoot);
  } catch {
    real = path.resolve(workspaceRoot);
  }
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return path.join(dataDir, 'state', `${slugFor(real)}-${hash}`);
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new OpcError('UNSAFE_DIR', `O diretório ${dir} pertence a outro usuário; o opc não vai usá-lo.`, { exitCode: 2 });
  }
  if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

export function writeFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  const content = typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function defaultState() {
  return { version: 1, claudeSessions: [], jobs: [] };
}

function normalizeState(raw) {
  return {
    ...defaultState(),
    ...raw,
    version: 1,
    claudeSessions: Array.isArray(raw?.claudeSessions) ? raw.claudeSessions : [],
    jobs: Array.isArray(raw?.jobs) ? raw.jobs : [],
  };
}

function rebuildJobs(stateDir) {
  const jobsDir = path.join(stateDir, 'jobs');
  let names = [];
  try {
    names = fs.readdirSync(jobsDir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names.sort()) {
    const job = readJson(path.join(jobsDir, name), null);
    if (job && typeof job.id === 'string') jobs.push(job);
  }
  return jobs;
}

export function loadState(stateDir) {
  const file = path.join(stateDir, 'state.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState();
    throw err;
  }
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    const rebuilt = { ...defaultState(), jobs: rebuildJobs(stateDir) };
    writeFileAtomic(file, rebuilt);
    return rebuilt;
  }
}

export async function updateState(stateDir, mutator) {
  return withLock(path.join(stateDir, 'state.lock'), { timeoutMs: STATE_LOCK_TIMEOUT_MS, purpose: 'state' }, async () => {
    const state = loadState(stateDir);
    const result = await mutator(state);
    const next = normalizeState(result ?? state);
    writeFileAtomic(path.join(stateDir, 'state.json'), next);
    return next;
  });
}

export function listActiveJobs(stateDir) {
  return loadState(stateDir).jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status));
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/state.test.mjs`
Expected: PASS — `# tests 10`, `# pass 10`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/state.mjs tests/unit/state.test.mjs
git commit -m "feat: add data dir and per-workspace state"
```

---

### Task 8: Config base e merge restritivo (`config`)

Spec §3.2 e §3.3 (base; a F1 completa validação contra servidor, `config set/get`, onboarding). `DEFAULT_CONFIG` neutro (sem restrição, sem aliases; `sensitivePaths` padrão mantidos por serem proteção). Merge: defaults ← global (profundo) ← `.opc.json` pelas regras das Decisões 2–4. Config global inválida → `CONFIG_INVALID` (exit 2); `.opc.json` inválido → ignorado com aviso (é conteúdo não confiável).

**Files:**
- Create: `plugins/opc/scripts/lib/config.mjs`
- Test: `tests/unit/config.test.mjs`

**Interfaces:**
- Consumes: `readJson`, `writeFileAtomic` (Task 7); `OpcError` (Task 3).
- Produces (contrato do mestre): `DEFAULT_CONFIG`, `LOCKED_KEYS`, `getPath(obj, dotted)`, `setPath(obj, dotted, value)` (imutável), `validateConfigShape(obj, { source })` → `{ errors: [{path, message}], warnings: [{path, message}] }`, `mergeConfig(globalCfg, workspaceCfg) → { config, warnings }`, `loadConfig({ dataDir, workspaceRoot }) → { config, global, workspace, hasGlobal, warnings }` (avisos com `source: 'global'|'workspace'`), `saveGlobalConfig(dataDir, cfg)` (600), `saveWorkspaceConfig(workspaceRoot, cfg)` (644, versionável).
- Produces (**novas**): `matchesGlob(value, glob) → boolean` (`*` casa qualquer sequência, inclusive `/`; a F1 pode fazer `models.globToRegExp` usar a mesma regra), `globalConfigPath(dataDir)`, `workspaceConfigPath(workspaceRoot)`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/config.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG, LOCKED_KEYS, getPath, loadConfig, matchesGlob, mergeConfig, saveGlobalConfig, saveWorkspaceConfig,
  setPath, validateConfigShape,
} from '../../plugins/opc/scripts/lib/config.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

function temp(t) {
  const dir = makeTempDir('opc-cfg-');
  t.after(() => removeTempDir(dir));
  return dir;
}

const paths = (warnings) => warnings.map((w) => w.path);

test('DEFAULT_CONFIG is neutral and LOCKED_KEYS match spec §3.3', () => {
  assert.deepEqual(DEFAULT_CONFIG.policy.models, { allow: [], deny: [] });
  assert.deepEqual(DEFAULT_CONFIG.aliases, {});
  assert.equal(DEFAULT_CONFIG.policy.approver, 'user');
  assert.deepEqual(DEFAULT_CONFIG.server, { bootTimeoutSec: 60, requestTimeoutSec: 30, configOverride: { share: 'disabled' } });
  assert.deepEqual(DEFAULT_CONFIG.jobs, { maxActive: 8, maxParallel: 4 });
  assert.deepEqual([...LOCKED_KEYS], ['policy', 'permissionProfiles', 'server.configOverride']);
});

test('getPath/setPath use dotted paths and setPath is immutable', () => {
  const obj = { a: { b: { c: 1 } } };
  assert.equal(getPath(obj, 'a.b.c'), 1);
  assert.equal(getPath(obj, 'a.x.c'), undefined);
  const next = setPath(obj, 'a.b.d', 2);
  assert.deepEqual(next, { a: { b: { c: 1, d: 2 } } });
  assert.deepEqual(obj, { a: { b: { c: 1 } } });
  assert.deepEqual(setPath(undefined, 'x.y', 3), { x: { y: 3 } });
});

test('matchesGlob: * matches any sequence including /', () => {
  assert.equal(matchesGlob('omniroute-mvalmeida/opencode-go/kimi-k3', 'omniroute-mvalmeida/*'), true);
  assert.equal(matchesGlob('anthropic/claude', 'anthropic/*'), true);
  assert.equal(matchesGlob('work-review', 'work-*'), true);
  assert.equal(matchesGlob('prov.a/x', 'prov.a/x'), true);
  assert.equal(matchesGlob('provXa/x', 'prov.a/x'), false);
});

test('validateConfigShape reports type errors, unknown keys and secret-looking keys', () => {
  const { errors, warnings } = validateConfigShape({
    defaultModel: 3,
    policy: { approver: 'robot', models: { allow: 'x' } },
    jobs: { maxActive: 0 },
    mystery: true,
    aliases: { apiToken: 'x' },
  }, { source: 'global' });
  assert.deepEqual(paths(errors).sort(), ['defaultModel', 'jobs.maxActive', 'policy.approver', 'policy.models.allow']);
  assert.ok(paths(warnings).includes('mystery'));
  assert.ok(paths(warnings).includes('aliases.apiToken'));
  assert.deepEqual(validateConfigShape([], {}).errors.map((e) => e.path), ['']);
});

test('validateConfigShape warns about locked keys only for the workspace source', () => {
  const cfg = { permissionProfiles: {}, server: { configOverride: {} } };
  assert.deepEqual(paths(validateConfigShape(cfg, { source: 'workspace' }).warnings).sort(), ['permissionProfiles', 'server.configOverride']);
  assert.deepEqual(validateConfigShape(cfg, { source: 'global' }).warnings, []);
});

test('mergeConfig applies global over defaults', () => {
  const { config, warnings } = mergeConfig({ defaultModel: 'p/m', jobs: { maxActive: 3 } }, null);
  assert.equal(config.defaultModel, 'p/m');
  assert.deepEqual(config.jobs, { maxActive: 3, maxParallel: 4 });
  assert.deepEqual(warnings, []);
});

test('workspace deny lists are unioned with the global ones', () => {
  const { config } = mergeConfig(
    { policy: { models: { deny: ['a/*'] }, agents: { deny: ['work-*'] } } },
    { policy: { models: { deny: ['b/*', 'a/*'] }, tools: { deny: ['gitlab_*'] } } },
  );
  assert.deepEqual(config.policy.models.deny, ['a/*', 'b/*']);
  assert.deepEqual(config.policy.agents.deny, ['work-*']);
  assert.deepEqual(config.policy.tools.deny, ['gitlab_*']);
});

test('workspace allow is intersected with the global allow', () => {
  const g = { policy: { models: { allow: ['prov-a/*', 'anthropic/claude-x'] } } };
  const narrow = mergeConfig(g, { policy: { models: { allow: ['prov-a/fast-*', 'anthropic/*'] } } });
  assert.deepEqual(narrow.config.policy.models.allow.sort(), ['anthropic/claude-x', 'prov-a/fast-*']);
  const widen = mergeConfig(g, { policy: { models: { allow: ['prov-b/*'] } } });
  assert.deepEqual(widen.config.policy.models.deny, ['*']);
  assert.ok(widen.warnings.some((w) => w.path === 'policy.models.allow' && /amplia/.test(w.message)));
  assert.ok(widen.warnings.some((w) => /interseção vazia/.test(w.message)));
  const openGlobal = mergeConfig({}, { policy: { models: { allow: ['prov-a/*'] } } });
  assert.deepEqual(openGlobal.config.policy.models.allow, ['prov-a/*']);
  const openWs = mergeConfig(g, { policy: { models: { allow: [] } } });
  assert.deepEqual(openWs.config.policy.models.allow, ['prov-a/*', 'anthropic/claude-x']);
});

test('locked keys in the workspace are ignored with a warning (only restrictive policy forms pass)', () => {
  const { config, warnings } = mergeConfig(
    { policy: { approver: 'user', permissionTimeoutSec: 600 } },
    {
      policy: { approver: 'claude', permissionTimeoutSec: 5, sensitivePaths: ['*.secret'] },
      permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
      server: { configOverride: { share: 'auto' }, bootTimeoutSec: 1 },
    },
  );
  assert.equal(config.policy.approver, 'user');
  assert.equal(config.policy.permissionTimeoutSec, 600);
  assert.ok(config.policy.sensitivePaths.includes('*.secret'));
  assert.deepEqual(config.permissionProfiles, {});
  assert.deepEqual(config.server.configOverride, { share: 'disabled' });
  assert.equal(config.server.bootTimeoutSec, 60);
  const p = paths(warnings);
  for (const expected of ['policy.approver', 'policy.permissionTimeoutSec', 'permissionProfiles', 'server.configOverride', 'server.bootTimeoutSec']) {
    assert.ok(p.includes(expected), `missing warning for ${expected}: ${p.join(', ')}`);
  }
  const stricter = mergeConfig({ policy: { approver: 'claude' } }, { policy: { approver: 'user' } });
  assert.equal(stricter.config.policy.approver, 'user');
});

test('preference scalars are overridable; other keys are not', () => {
  const { config, warnings } = mergeConfig(
    { defaultModel: 'g/m', aliases: { fast: 'g/f' }, delegation: { auto: false } },
    { defaultModel: 'w/m', aliases: { strong: 'w/s' }, stopGate: { model: 'w/gate', enabled: true }, delegation: { auto: true }, jobs: { maxActive: 99 } },
  );
  assert.equal(config.defaultModel, 'w/m');
  assert.deepEqual(config.aliases, { fast: 'g/f', strong: 'w/s' });
  assert.equal(config.stopGate.model, 'w/gate');
  assert.equal(config.stopGate.enabled, false);
  assert.equal(config.delegation.auto, false);
  assert.equal(config.jobs.maxActive, 8);
  assert.deepEqual(paths(warnings).sort(), ['delegation', 'jobs', 'stopGate.enabled']);
});

test('invalid workspace values are dropped with a warning', () => {
  const { config, warnings } = mergeConfig({}, { defaultModel: 42 });
  assert.equal(config.defaultModel, null);
  assert.ok(paths(warnings).includes('defaultModel'));
});

test('loadConfig: first run without files works; invalid global fails; invalid .opc.json is ignored', (t) => {
  const dataDir = temp(t);
  const ws = temp(t);
  const first = loadConfig({ dataDir, workspaceRoot: ws });
  assert.equal(first.hasGlobal, false);
  assert.equal(first.global, null);
  assert.equal(first.workspace, null);
  assert.deepEqual(first.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  fs.writeFileSync(path.join(ws, '.opc.json'), '{broken');
  assert.ok(loadConfig({ dataDir, workspaceRoot: ws }).warnings.some((w) => w.path === '.opc.json'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{broken');
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.exitCode === 2);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ jobs: { maxActive: -1 } }));
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && /jobs\.maxActive/.test(e.message));
});

test('saveGlobalConfig (600) and saveWorkspaceConfig (644) round-trip through loadConfig', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = temp(t);
  const ws = temp(t);
  saveGlobalConfig(dataDir, { defaultModel: 'p/m' });
  saveWorkspaceConfig(ws, { defaultModel: 'p/w' });
  assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(ws, '.opc.json')).mode & 0o777, 0o644);
  const loaded = loadConfig({ dataDir, workspaceRoot: ws });
  assert.equal(loaded.hasGlobal, true);
  assert.equal(loaded.config.defaultModel, 'p/w');
  assert.deepEqual(loaded.global, { defaultModel: 'p/m' });
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/config.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/config.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/config.mjs`:

````js
// Global config + workspace override with the restrictive merge of spec §3.2 (F0 base; F1 completes).
import fs from 'node:fs';
import path from 'node:path';

import { OpcError } from './opc-error.mjs';
import { readJson, writeFileAtomic } from './state.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  defaultProvider: null,
  defaultModel: null,
  defaultVariant: null,
  defaultAgent: null,
  aliases: {},
  reviewModel: null,
  stopGate: { enabled: false, model: null },
  project: { goal: null, scope: [], taskTypes: [] },
  policy: {
    providers: { allow: [], deny: [] },
    models: { allow: [], deny: [] },
    agents: { allow: [], deny: [] },
    tools: { deny: [] },
    sensitivePaths: ['*.env', '*.env.*', '**/.ssh/**', '*.pem', '*.key', '**/id_rsa*', '**/id_ed25519*', '**/secrets.env'],
    destructiveBash: [],
    approver: 'user',
    permissionTimeoutSec: 600,
  },
  permissionProfiles: {},
  routing: {
    tasks: {},
    tiers: {},
    fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 },
  },
  conclave: { pools: {}, defaultPool: null, judge: 'claude', rounds: 1, quorum: 2, memberTimeoutSec: 900 },
  orchestrate: { planner: null, maxSubtasks: 5, synthesizer: 'claude' },
  delegation: { auto: false },
  jobs: { maxActive: 8, maxParallel: 4 },
  server: { bootTimeoutSec: 60, requestTimeoutSec: 30, configOverride: { share: 'disabled' } },
});

export const LOCKED_KEYS = Object.freeze(['policy', 'permissionProfiles', 'server.configOverride']);

const WORKSPACE_OVERRIDABLE = Object.freeze([
  'defaultProvider', 'defaultModel', 'defaultVariant', 'defaultAgent', 'aliases', 'reviewModel',
  'routing', 'conclave', 'orchestrate', 'project', 'stopGate.model',
]);
const POLICY_LIST_KINDS = Object.freeze(['providers', 'models', 'agents']);
const SECRET_KEY_RE = /token|password|secret|api[-_]?key/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function getPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, dotted, value) {
  const [head, ...rest] = String(dotted).split('.');
  const base = isPlainObject(obj) ? obj : {};
  if (rest.length === 0) return { ...base, [head]: value };
  return { ...base, [head]: setPath(base[head], rest.join('.'), value) };
}

function unsetPath(obj, dotted) {
  const [head, ...rest] = String(dotted).split('.');
  if (!isPlainObject(obj) || !(head in obj)) return obj;
  const copy = { ...obj };
  if (rest.length === 0) delete copy[head];
  else copy[head] = unsetPath(copy[head], rest.join('.'));
  return copy;
}

export function matchesGlob(value, glob) {
  const escaped = String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(String(value));
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

const isStr = (v) => typeof v === 'string';
const isStrOrNull = (v) => v === null || typeof v === 'string';
const isStrList = (v) => Array.isArray(v) && v.every(isStr);
const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isBool = (v) => typeof v === 'boolean';
const isStrMap = (v) => isPlainObject(v) && Object.values(v).every(isStr);
const isListMap = (v) => isPlainObject(v) && Object.values(v).every(isStrList);
const isRuleList = (v) => Array.isArray(v) && v.every((r) => isPlainObject(r) && isStr(r.permission) && isStr(r.pattern)
  && ['allow', 'deny', 'ask'].includes(r.action));

const SHAPE = {
  defaultProvider: [isStrOrNull, 'texto ou null'],
  defaultModel: [isStrOrNull, 'texto ou null'],
  defaultVariant: [isStrOrNull, 'texto ou null'],
  defaultAgent: [isStrOrNull, 'texto ou null'],
  aliases: [isStrMap, 'mapa de texto'],
  reviewModel: [isStrOrNull, 'texto ou null'],
  stopGate: [isPlainObject, 'objeto'],
  'stopGate.enabled': [isBool, 'booleano'],
  'stopGate.model': [isStrOrNull, 'texto ou null'],
  project: [isPlainObject, 'objeto'],
  'project.goal': [isStrOrNull, 'texto ou null'],
  'project.scope': [isStrList, 'lista de texto'],
  'project.taskTypes': [isStrList, 'lista de texto'],
  policy: [isPlainObject, 'objeto'],
  'policy.providers.allow': [isStrList, 'lista de texto'],
  'policy.providers.deny': [isStrList, 'lista de texto'],
  'policy.models.allow': [isStrList, 'lista de texto'],
  'policy.models.deny': [isStrList, 'lista de texto'],
  'policy.agents.allow': [isStrList, 'lista de texto'],
  'policy.agents.deny': [isStrList, 'lista de texto'],
  'policy.tools.deny': [isStrList, 'lista de texto'],
  'policy.sensitivePaths': [isStrList, 'lista de texto'],
  'policy.destructiveBash': [isStrList, 'lista de texto'],
  'policy.approver': [(v) => v === 'user' || v === 'claude', '"user" ou "claude"'],
  'policy.permissionTimeoutSec': [isPosNum, 'número > 0'],
  permissionProfiles: [(v) => isPlainObject(v) && Object.values(v).every(isRuleList), 'mapa de listas de regras'],
  routing: [isPlainObject, 'objeto'],
  'routing.tasks': [isListMap, 'mapa de listas'],
  'routing.tiers': [isListMap, 'mapa de listas'],
  'routing.fallback.enabled': [isBool, 'booleano'],
  'routing.fallback.maxAttempts': [isPosInt, 'inteiro > 0'],
  'routing.fallback.maxProviderRetries': [isPosInt, 'inteiro > 0'],
  'routing.fallback.maxRetryWaitSec': [isPosNum, 'número > 0'],
  conclave: [isPlainObject, 'objeto'],
  'conclave.pools': [isListMap, 'mapa de listas'],
  'conclave.defaultPool': [isStrOrNull, 'texto ou null'],
  'conclave.judge': [isStr, 'texto'],
  'conclave.rounds': [(v) => Number.isInteger(v) && v >= 1 && v <= 3, 'inteiro entre 1 e 3'],
  'conclave.quorum': [(v) => Number.isInteger(v) && v >= 2, 'inteiro >= 2'],
  'conclave.memberTimeoutSec': [isPosNum, 'número > 0'],
  orchestrate: [isPlainObject, 'objeto'],
  'orchestrate.planner': [isStrOrNull, 'texto ou null'],
  'orchestrate.maxSubtasks': [(v) => Number.isInteger(v) && v >= 2, 'inteiro >= 2'],
  'orchestrate.synthesizer': [isStr, 'texto'],
  delegation: [isPlainObject, 'objeto'],
  'delegation.auto': [isBool, 'booleano'],
  jobs: [isPlainObject, 'objeto'],
  'jobs.maxActive': [isPosInt, 'inteiro > 0'],
  'jobs.maxParallel': [isPosInt, 'inteiro > 0'],
  server: [isPlainObject, 'objeto'],
  'server.bootTimeoutSec': [isPosNum, 'número > 0'],
  'server.requestTimeoutSec': [isPosNum, 'número > 0'],
  'server.configOverride': [isPlainObject, 'objeto'],
};

function collectSecretLikeKeys(value, prefix, out) {
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_RE.test(k)) out.push(p);
    collectSecretLikeKeys(v, p, out);
  }
}

export function validateConfigShape(obj, { source = 'global' } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(obj)) {
    errors.push({ path: '', message: 'a configuração precisa ser um objeto JSON' });
    return { errors, warnings };
  }
  for (const key of Object.keys(obj)) {
    if (!(key in DEFAULT_CONFIG)) warnings.push({ path: key, message: 'chave desconhecida (ignorada)' });
  }
  for (const [dotted, [check, expected]] of Object.entries(SHAPE)) {
    const value = getPath(obj, dotted);
    if (value !== undefined && !check(value)) errors.push({ path: dotted, message: `valor inválido: esperado ${expected}` });
  }
  const secretLike = [];
  collectSecretLikeKeys(obj, '', secretLike);
  for (const p of secretLike) warnings.push({ path: p, message: 'chave com cara de segredo: não guarde segredos na config do opc' });
  if (source === 'workspace') {
    for (const key of LOCKED_KEYS) {
      if (getPath(obj, key) !== undefined && key !== 'policy') {
        warnings.push({ path: key, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
      }
    }
  }
  return { errors, warnings };
}

function intersectAllow(globalAllow, wsAllow) {
  if (wsAllow.length === 0) return { allow: [...globalAllow], dropped: [], empty: false };
  if (globalAllow.length === 0) return { allow: [...wsAllow], dropped: [], empty: false };
  const keptWs = wsAllow.filter((w) => globalAllow.some((g) => matchesGlob(w, g)));
  const keptGlobal = globalAllow.filter((g) => wsAllow.some((w) => matchesGlob(g, w)));
  const allow = [...new Set([...keptWs, ...keptGlobal])];
  const dropped = wsAllow.filter((w) => !allow.includes(w) && !keptGlobal.some((g) => matchesGlob(g, w)));
  return { allow: allow.length > 0 ? allow : [...globalAllow], dropped, empty: allow.length === 0 };
}

function mergeWorkspacePolicy(effective, wsPolicy, warnings) {
  if (wsPolicy === undefined) return effective;
  if (!isPlainObject(wsPolicy)) {
    warnings.push({ path: 'policy', message: 'policy do .opc.json inválida (ignorada)' });
    return effective;
  }
  const policy = clone(effective.policy);
  for (const [key, value] of Object.entries(wsPolicy)) {
    if (POLICY_LIST_KINDS.includes(key) && isPlainObject(value)) {
      for (const [listName, list] of Object.entries(value)) {
        const p = `policy.${key}.${listName}`;
        if (!isStrList(list) || !['allow', 'deny'].includes(listName)) {
          warnings.push({ path: p, message: 'entrada inválida no .opc.json (ignorada)' });
          continue;
        }
        if (listName === 'deny') {
          policy[key].deny = [...new Set([...policy[key].deny, ...list])];
        } else {
          const res = intersectAllow(policy[key].allow, list);
          policy[key].allow = res.allow;
          for (const d of res.dropped) warnings.push({ path: p, message: `"${d}" amplia o allow global (ignorado)` });
          if (res.empty) {
            policy[key].deny = [...new Set([...policy[key].deny, '*'])];
            warnings.push({ path: p, message: 'interseção vazia com o allow global: nada fica permitido' });
          }
        }
      }
    } else if (key === 'tools' && isPlainObject(value) && isStrList(value.deny ?? [])) {
      policy.tools.deny = [...new Set([...policy.tools.deny, ...(value.deny ?? [])])];
      for (const extra of Object.keys(value).filter((k) => k !== 'deny')) {
        warnings.push({ path: `policy.tools.${extra}`, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
      }
    } else if ((key === 'sensitivePaths' || key === 'destructiveBash') && isStrList(value)) {
      policy[key] = [...new Set([...policy[key], ...value])];
    } else if (key === 'approver' && value === 'user') {
      policy.approver = 'user';
    } else {
      warnings.push({ path: `policy.${key}`, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
    }
  }
  return { ...effective, policy };
}

export function mergeConfig(globalCfg, workspaceCfg) {
  const warnings = [];
  let config = deepMerge(clone(DEFAULT_CONFIG), isPlainObject(globalCfg) ? globalCfg : {});
  if (!isPlainObject(workspaceCfg)) return { config, warnings };
  const { errors } = validateConfigShape(workspaceCfg, { source: 'workspace' });
  const invalid = new Set(errors.map((e) => e.path));
  for (const e of errors) warnings.push({ path: e.path, message: `.opc.json: ${e.message} (ignorado)` });
  let ws = workspaceCfg;
  for (const p of invalid) ws = unsetPath(ws, p);
  config = mergeWorkspacePolicy(config, ws.policy, warnings);
  for (const key of ['permissionProfiles', 'server.configOverride']) {
    if (getPath(ws, key) !== undefined) {
      warnings.push({ path: key, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
    }
  }
  for (const dotted of WORKSPACE_OVERRIDABLE) {
    const value = getPath(ws, dotted);
    if (value === undefined) continue;
    const current = getPath(config, dotted);
    config = setPath(config, dotted, isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : clone(value));
  }
  const handledTop = new Set(['policy', 'permissionProfiles', ...WORKSPACE_OVERRIDABLE.map((k) => k.split('.')[0])]);
  for (const key of Object.keys(ws)) {
    if (handledTop.has(key)) continue;
    if (key === 'server') {
      for (const sub of Object.keys(ws.server ?? {}).filter((k) => k !== 'configOverride')) {
        warnings.push({ path: `server.${sub}`, message: 'chave não sobrescrevível no .opc.json (ignorada)' });
      }
      continue;
    }
    warnings.push({ path: key, message: 'chave não sobrescrevível no .opc.json (ignorada)' });
  }
  if (isPlainObject(ws.stopGate)) {
    for (const sub of Object.keys(ws.stopGate).filter((k) => k !== 'model')) {
      warnings.push({ path: `stopGate.${sub}`, message: 'chave não sobrescrevível no .opc.json (ignorada)' });
    }
  }
  return { config, warnings };
}

export function globalConfigPath(dataDir) {
  return path.join(dataDir, 'config.json');
}

export function workspaceConfigPath(workspaceRoot) {
  return path.join(workspaceRoot, '.opc.json');
}

export function loadConfig({ dataDir, workspaceRoot }) {
  const warnings = [];
  const gPath = globalConfigPath(dataDir);
  let global = null;
  if (fs.existsSync(gPath)) {
    global = readJson(gPath, undefined);
    if (global === undefined) {
      throw new OpcError('CONFIG_INVALID', `A config global ${gPath} não é um JSON válido.`, { exitCode: 2 });
    }
    const { errors, warnings: w } = validateConfigShape(global, { source: 'global' });
    if (errors.length > 0) {
      throw new OpcError('CONFIG_INVALID', `Config global inválida: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, {
        exitCode: 2,
        details: { errors },
      });
    }
    warnings.push(...w.map((x) => ({ ...x, source: 'global' })));
  }
  let workspace = null;
  const wPath = workspaceConfigPath(workspaceRoot);
  if (fs.existsSync(wPath)) {
    workspace = readJson(wPath, undefined);
    if (workspace === undefined || !isPlainObject(workspace)) {
      warnings.push({ path: '.opc.json', message: 'arquivo não é um objeto JSON válido (ignorado)', source: 'workspace' });
      workspace = null;
    } else {
      const { warnings: w } = validateConfigShape(workspace, { source: 'workspace' });
      warnings.push(...w.filter((x) => x.message.startsWith('chave com cara')).map((x) => ({ ...x, source: 'workspace' })));
    }
  }
  const merged = mergeConfig(global, workspace);
  warnings.push(...merged.warnings.map((x) => ({ ...x, source: 'workspace' })));
  return { config: merged.config, global, workspace, hasGlobal: global !== null, warnings };
}

export function saveGlobalConfig(dataDir, cfg) {
  writeFileAtomic(globalConfigPath(dataDir), cfg, { mode: 0o600 });
}

export function saveWorkspaceConfig(workspaceRoot, cfg) {
  writeFileAtomic(workspaceConfigPath(workspaceRoot), cfg, { mode: 0o644 });
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/config.test.mjs`
Expected: PASS — `# tests 13`, `# pass 13`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/config.mjs tests/unit/config.test.mjs
git commit -m "feat: add base config with restrictive workspace merge"
```

---

### Task 9: Cliente HTTP tipado (`http`)

Spec §5.2. Basic auth `opencode:<senha>`, `?directory=` automático (sobrescrevível pela query), timeout por request (`AbortController`), erros tipados com corpo redigido, 204 → `null`, mensagens sem headers, senha ou query string. `AUTH_FAILED` nunca repete.

**Files:**
- Create: `plugins/opc/scripts/lib/http.mjs`
- Test: `tests/unit/http.test.mjs`

**Interfaces:**
- Consumes: erros (Task 3); `redact`, `redactText`, `registerSecret` (Task 3).
- Produces (contrato do mestre): `createClient({ baseUrl, password, username = 'opencode', directory, requestTimeoutMs = 30000, fetchImpl = fetch, onServerDown = null })` → `client.request(method, path, { query, body, timeoutMs, retryOnServerDown })`, `client.get/post/patch`, `client.baseUrl`, `client.directory`. Erros: `ConnectionError('SERVER_DOWN'|'AUTH_FAILED'|'TIMEOUT')`, `NotFoundError`, `RequestError('BAD_REQUEST'|'SERVER_ERROR')` com `details: { status, body }` redigido.
- Produces (**novas**): `client.authHeaders() → { authorization } | {}` e `client.buildUrl(path, query) → string` (usados pelo `EventHub`); `retryOnServerDown` padrão = `method === 'GET'` (Decisão 9); `onServerDown()` pode devolver `string` ou `{ url, password }` (Decisão 8).

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/http.test.mjs`:

````js
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { ConnectionError, NotFoundError, RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const PASSWORD = 'http-test-password-0123456789';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    handler(req, res, url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('sends Basic auth, ?directory and JSON bodies; parses JSON and 204', async (t) => {
  const srv = await startServer(t, (req, res, url) => {
    if (url.pathname === '/empty') { res.writeHead(204); res.end(); return; }
    json(res, 200, { ok: true, method: req.method });
  });
  const client = createClient({ baseUrl: `${srv.url}/`, password: PASSWORD, directory: '/tmp/my ws' });
  assert.deepEqual(await client.get('/global/health'), { ok: true, method: 'GET' });
  assert.deepEqual(await client.post('/x', { a: 1 }), { ok: true, method: 'POST' });
  assert.deepEqual(await client.patch('/x', { b: 2 }, { query: { directory: '/other', limit: 5 } }), { ok: true, method: 'PATCH' });
  assert.equal(await client.get('/empty'), null);
  const expectedAuth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  assert.equal(srv.seen[0].auth, expectedAuth);
  assert.deepEqual(srv.seen[0].query, { directory: '/tmp/my ws' });
  assert.equal(srv.seen[1].body, '{"a":1}');
  assert.deepEqual(srv.seen[2].query, { directory: '/other', limit: '5' });
  assert.equal(client.baseUrl, srv.url);
  assert.equal(client.directory, '/tmp/my ws');
  assert.match(client.buildUrl('/event'), /\/event\?directory=%2Ftmp%2Fmy\+ws$/);
  assert.deepEqual(client.authHeaders(), { authorization: expectedAuth });
});

test('maps 401, 404, 400 and 5xx to typed errors with redacted bodies', async (t) => {
  const srv = await startServer(t, (req, res, url) => {
    const status = Number(url.pathname.slice(1));
    json(res, status, { name: 'BadRequest', data: { apiKey: 'sk-should-not-leak', message: 'bad' } });
  });
  const client = createClient({ baseUrl: srv.url, password: PASSWORD });
  await assert.rejects(client.get('/401'), (e) => e instanceof ConnectionError && e.code === 'AUTH_FAILED' && e.exitCode === 5);
  await assert.rejects(client.get('/404'), (e) => e instanceof NotFoundError);
  await assert.rejects(client.post('/400', {}), (e) => {
    assert.ok(e instanceof RequestError);
    assert.equal(e.code, 'BAD_REQUEST');
    assert.equal(e.details.body.data.apiKey, '***');
    assert.ok(!e.message.includes('sk-should-not-leak'));
    return true;
  });
  await assert.rejects(client.get('/503'), (e) => e instanceof RequestError && e.code === 'SERVER_ERROR');
  assert.equal(srv.seen.filter((r) => r.path === '/401').length, 1, 'AUTH_FAILED is never retried');
});

test('error messages never contain the password or the query string', async (t) => {
  const srv = await startServer(t, (req, res) => json(res, 500, { echo: req.headers.authorization, pw: PASSWORD }));
  const client = createClient({ baseUrl: srv.url, password: PASSWORD, directory: '/secret/dir' });
  await assert.rejects(client.get('/x'), (e) => {
    assert.ok(!e.message.includes(PASSWORD));
    assert.ok(!e.message.includes('/secret/dir'));
    assert.ok(!JSON.stringify(e.details).includes(PASSWORD));
    return true;
  });
});

test('timeouts become ConnectionError TIMEOUT', async (t) => {
  const srv = await startServer(t, () => {});
  const client = createClient({ baseUrl: srv.url, requestTimeoutMs: 5000 });
  await assert.rejects(client.get('/hang', { timeoutMs: 150, retryOnServerDown: false }), (e) => e.code === 'TIMEOUT' && e.exitCode === 5);
});

test('connection refused becomes SERVER_DOWN; GET retries once through onServerDown', async (t) => {
  const deadUrl = `http://127.0.0.1:${await freePort()}`;
  const srv = await startServer(t, (req, res) => json(res, 200, { auth: req.headers.authorization }));
  let calls = 0;
  const client = createClient({
    baseUrl: deadUrl,
    password: 'old-password-123456',
    onServerDown: async () => {
      calls += 1;
      return { url: srv.url, password: 'new-password-654321' };
    },
  });
  const body = await client.get('/global/health');
  assert.equal(calls, 1);
  assert.equal(body.auth, `Basic ${Buffer.from('opencode:new-password-654321').toString('base64')}`);
  assert.equal(client.baseUrl, srv.url);
});

test('POST does not retry on SERVER_DOWN unless retryOnServerDown is set', async (t) => {
  const deadUrl = `http://127.0.0.1:${await freePort()}`;
  const srv = await startServer(t, (req, res) => json(res, 200, { ok: true }));
  let calls = 0;
  const onServerDown = async () => { calls += 1; return srv.url; };
  const client = createClient({ baseUrl: deadUrl, onServerDown });
  await assert.rejects(client.post('/x', {}), (e) => e.code === 'SERVER_DOWN');
  assert.equal(calls, 0);
  const client2 = createClient({ baseUrl: deadUrl, onServerDown });
  assert.deepEqual(await client2.post('/x', {}, { retryOnServerDown: true }), { ok: true });
  assert.equal(calls, 1);
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/http.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/http.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/http.mjs`:

````js
// HTTP client for the OpenCode API v1: Basic auth, ?directory, typed errors, timeouts, redaction (spec §5.2).
import { ConnectionError, NotFoundError, RequestError } from './opc-error.mjs';
import { redact, redactText, registerSecret } from './redact.mjs';

const DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

function isServerDown(err) {
  const code = err?.cause?.code ?? err?.code;
  if (DOWN_CODES.has(code)) return true;
  return err instanceof TypeError && /fetch failed|terminated|socket/i.test(err.message);
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarize(body) {
  const safe = redact(body);
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
  return redactText(text ?? '').slice(0, 2000);
}

export function createClient({
  baseUrl,
  password,
  username = 'opencode',
  directory,
  requestTimeoutMs = 30000,
  fetchImpl = fetch,
  onServerDown = null,
}) {
  let currentBase = String(baseUrl).replace(/\/+$/, '');
  let currentPassword = password ?? null;
  registerSecret(currentPassword);

  function authHeaders() {
    if (!currentPassword) return {};
    const token = Buffer.from(`${username}:${currentPassword}`).toString('base64');
    return { authorization: `Basic ${token}` };
  }

  function buildUrl(path, query = {}) {
    const url = new URL(currentBase + path);
    const params = { ...(directory && query.directory === undefined ? { directory } : {}), ...query };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async function once(method, path, { query, body, timeoutMs }) {
    const controller = new AbortController();
    const limit = timeoutMs ?? requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), limit);
    let res;
    try {
      res = await fetchImpl(buildUrl(path, query), {
        method,
        headers: { ...authHeaders(), accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new ConnectionError('TIMEOUT', `${method} ${path}: sem resposta em ${limit} ms.`);
      }
      if (isServerDown(err)) throw new ConnectionError('SERVER_DOWN', `${method} ${path}: servidor OpenCode inacessível.`);
      throw new ConnectionError('SERVER_DOWN', `${method} ${path}: ${redactText(err.message)}`);
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ConnectionError('TIMEOUT', `${method} ${path}: sem resposta em ${limit} ms.`);
      throw new ConnectionError('SERVER_DOWN', `${method} ${path}: conexão encerrada durante a resposta.`);
    }
    clearTimeout(timer);
    const parsed = parseBody(text);
    if (res.ok) return res.status === 204 ? null : parsed;
    const details = { status: res.status, body: redact(parsed) };
    if (res.status === 401) throw new ConnectionError('AUTH_FAILED', `${method} ${path}: autenticação recusada (401).`, { details });
    if (res.status === 404) throw new NotFoundError('NOT_FOUND', `${method} ${path}: não encontrado (404).`, { details });
    if (res.status >= 500) {
      throw new RequestError('SERVER_ERROR', `${method} ${path}: erro do servidor (${res.status}): ${summarize(parsed)}`, { details });
    }
    throw new RequestError('BAD_REQUEST', `${method} ${path}: requisição recusada (${res.status}): ${summarize(parsed)}`, { details });
  }

  async function request(method, path, { query, body, timeoutMs, retryOnServerDown } = {}) {
    const retry = retryOnServerDown ?? method === 'GET';
    try {
      return await once(method, path, { query, body, timeoutMs });
    } catch (err) {
      if (!(retry && onServerDown && err instanceof ConnectionError && err.code === 'SERVER_DOWN')) throw err;
      const next = await onServerDown();
      if (typeof next === 'string') currentBase = next.replace(/\/+$/, '');
      else if (next && typeof next === 'object') {
        if (next.url) currentBase = String(next.url).replace(/\/+$/, '');
        if (next.password) {
          currentPassword = next.password;
          registerSecret(currentPassword);
        }
      }
      return once(method, path, { query, body, timeoutMs });
    }
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    authHeaders,
    buildUrl,
    get baseUrl() {
      return currentBase;
    },
    get directory() {
      return directory;
    },
  };
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/http.test.mjs`
Expected: PASS — `# tests 6`, `# pass 6`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/http.mjs tests/unit/http.test.mjs
git commit -m "feat: add typed http client for the opencode api"
```

---

### Task 10: Servidor OpenCode falso e binário falso

Infraestrutura de integração do mestre (“Servidor falso”). O fake é derivado da OpenAPI 1.18.32: `GET /global/health → {healthy:true, version}`, `POST /global/dispose → true`, `GET /agent → Agent[]`, `GET /config → Config` (com merge raso de `OPENCODE_CONFIG_CONTENT`), `GET /session/status → {}`, `GET /permission → []`, `GET /question → []` e `GET /event` (SSE com frames `data: {"id":"evt_…","type":…,"properties":…}`: `server.connected` e depois `server.heartbeat` a cada `FAKE_HEARTBEAT_MS`, padrão 10000). O estado é persistido de forma atômica em `FAKE_OPENCODE_STATE`. O binário falso sobe o fake no `serve` e imprime a linha `opencode server listening on http://H:N`, como o real.

**Files:**
- Create: `tests/fixtures/fake-opencode.mjs`, `tests/fixtures/bin/opencode` (executável), `tests/fixtures/data/agent.json`, `tests/fixtures/data/config.json`, `tests/fixtures/scenarios/ok.mjs`, `tests/fixtures/scenarios/auth-401.mjs`, `tests/fixtures/scenarios/old-version.mjs`, `tests/fixtures/scenarios/eaddrinuse.mjs`
- Test: `tests/unit/fake-opencode.test.mjs`

**Interfaces:**
- Consumes: `tests/helpers.mjs`.
- Produces (contrato do mestre + acréscimos):
  - `startFake({ port = 0, password = null, scenario = 'ok', stateFile = null, dataDir = FIXTURE_DATA_DIR, heartbeatMs, version, configContent }) → fake` com `url, port, state, close(), emit(event), persist(), recordSignal(signal), openEventStream(req, res), baseConfig, configOverride, version, rejectAllAuth, stateFile, dataDir, sseClients`.
  - Exports: `FIXTURE_DATA_DIR, SCENARIO_DIR, DEFAULT_VERSION, DEFAULT_ROUTES, freshState(), readStateFile(file), writeStateFile(file, state), loadScenario(name), readFixture(dataDir, name), registerFakeExtension(install)`.
  - **Mecanismo único de extensão (fases F1+):** cada fase acrescenta, no **fim** de `fake-opencode.mjs`, uma chamada `registerFakeExtension((fake) => ({ 'METHOD /path/:param': handler, … }))` (imports da fase no mesmo bloco — ESM iça os `import`). `install(fake)` roda uma vez por `startFake`, antes do `setup` do cenário; a tabela devolvida é mesclada sobre `DEFAULT_ROUTES` (mesma chave → substitui; chave nova → acrescenta). Nenhuma fase edita o roteador. Resolução de cada requisição: auth → registro em `state.requests` → rota do cenário (se casar) → se ela devolver `undefined`, a rota base que casar (padrão + extensões, com `params`) → 404. Comportamento por cenário: `routes`, `onPromptAsync` (F2a) e `data` (F1); comportamento por modelo: o cenário lê `body.model` (ex.: `FAKE_FAIL_MODELS` da F4a).
  - `state`: `{ requests: [{method, path, query, body, at}], sessions, messages, permissions, questions, signals: [{signal, pid, at}], sseConnections, bootAttempts, boots: [{pid, attempt, requestedPort, port, hostname, hasPassword, insideServer, username, configContent, cwd, startedAt}] }` (a senha nunca é gravada).
  - Forma do cenário (`export default {...}`, todos opcionais): `setup(fake)`, `routes: { 'METHOD /path/:param': handler }` com `handler(fake, { method, path, query, body, params, req, res }) → { status?, body?, headers? } | 'handled' | undefined` (`undefined` cai na rota base que casar, com `params`), `onEventStream(fake, stream)` com `stream = { index, send(event), sendConnected(), startHeartbeat(), close() }`, `boot({ attempt, port, hostname, env }) → { exitCode?, stderr?, delayMs?, listenPort?, printPort? }` (só o binário), `ignoreSigterm: boolean`, `version: string`, `onPromptAsync(...)` (F2a).
  - Binário: `--version` → versão do cenário, `FAKE_OPENCODE_VERSION` ou `1.18.32`; `serve --port N --hostname H` → incrementa `bootAttempts`, aplica `boot()`, sobe o fake, registra `boots[]`, imprime a linha `listening on`; grava SIGTERM/SIGINT em `signals` e sai (exceto SIGTERM com `ignoreSigterm`).

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/fake-opencode.test.mjs`:

````js
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadScenario, readStateFile, startFake } from '../fixtures/fake-opencode.mjs';
import { FAKE_BIN_DIR, makeTempDir, runProcess, trackTempDir, waitFor } from '../helpers.mjs';

const PASSWORD = 'fake-test-password-0123456789';
const auth = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` };

async function withFake(t, opts = {}) {
  const dir = trackTempDir(t, makeTempDir('opc-fake-'));
  const stateFile = path.join(dir, 'state.json');
  const fake = await startFake({ port: 0, password: PASSWORD, stateFile, ...opts });
  t.after(() => fake.close());
  return { fake, stateFile };
}

test('fake requires Basic auth and serves the F0 routes', async (t) => {
  const { fake, stateFile } = await withFake(t, { configContent: '{"share":"disabled"}' });
  assert.equal((await fetch(`${fake.url}/global/health`)).status, 401);
  assert.deepEqual(await (await fetch(`${fake.url}/global/health`, { headers: auth })).json(), { healthy: true, version: '1.18.32' });
  assert.equal(await (await fetch(`${fake.url}/global/dispose`, { method: 'POST', headers: auth })).json(), true);
  const agents = await (await fetch(`${fake.url}/agent?directory=/x`, { headers: auth })).json();
  // slice: the F1 agent.json keeps these four first and appends more agents
  assert.deepEqual(agents.map((a) => a.name).slice(0, 4), ['build', 'plan', 'general', 'explore']);
  const cfg = await (await fetch(`${fake.url}/config`, { headers: auth })).json();
  assert.equal(cfg.share, 'disabled', 'OPENCODE_CONFIG_CONTENT is merged over the base config');
  assert.deepEqual(await (await fetch(`${fake.url}/session/status`, { headers: auth })).json(), {});
  assert.deepEqual(await (await fetch(`${fake.url}/permission`, { headers: auth })).json(), []);
  assert.deepEqual(await (await fetch(`${fake.url}/question`, { headers: auth })).json(), []);
  assert.equal((await fetch(`${fake.url}/nope`, { headers: auth })).status, 404);
  const state = readStateFile(stateFile);
  assert.ok(state.requests.some((r) => r.path === '/agent' && r.query.directory === '/x'));
});

test('fake SSE sends server.connected then heartbeats; emit() broadcasts', async (t) => {
  const { fake } = await withFake(t, { heartbeatMs: 30 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${fake.url}/event`, { headers: auth, signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  fake.emit({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
  await waitFor(async () => {
    const { value } = await reader.read();
    text += Buffer.from(value).toString();
    return text.includes('server.heartbeat') && text.includes('server.connected');
  }, { message: 'sse frames' });
  assert.match(text, /^data: \{"id":"evt_/);
  assert.equal(fake.state.sseConnections, 1);
});

test('scenarios override routes and setup', async (t) => {
  const { fake } = await withFake(t, { scenario: 'auth-401' });
  assert.equal((await fetch(`${fake.url}/global/health`, { headers: auth })).status, 401);
  const old = await loadScenario('old-version');
  assert.equal(old.version, '1.17.9');
  await assert.rejects(loadScenario('../evil'), /invalid scenario name/);
});

test('fake binary: --version and serve announce the listening line', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-fakebin-'));
  const bin = path.join(FAKE_BIN_DIR, 'opencode');
  const version = await runProcess(bin, ['--version'], { env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'ok' } });
  assert.equal(version.stdout.trim(), '1.18.32');
  const oldVersion = await runProcess(bin, ['--version'], { env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'old-version' } });
  assert.equal(oldVersion.stdout.trim(), '1.17.9');
  const failing = await runProcess(bin, ['serve', '--port', '1', '--hostname', '127.0.0.1'], {
    env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'eaddrinuse', FAKE_OPENCODE_STATE: path.join(dir, 's.json') },
  });
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /EADDRINUSE/);
  assert.equal(readStateFile(path.join(dir, 's.json')).bootAttempts, 1);
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/fake-opencode.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/tests/fixtures/fake-opencode.mjs`).

- [ ] **Step 3: Implementar o fake, o binário, as fixtures e os cenários base**

Crie `tests/fixtures/fake-opencode.mjs`:

````js
// Fake OpenCode 1.18.32 server (HTTP + SSE) for integration tests. Phases add routes and scenarios.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DATA_DIR = path.join(HERE, 'data');
export const SCENARIO_DIR = path.join(HERE, 'scenarios');
export const DEFAULT_VERSION = '1.18.32';

export function freshState() {
  return {
    requests: [],
    sessions: {},
    messages: {},
    permissions: {},
    questions: {},
    signals: [],
    sseConnections: 0,
    bootAttempts: 0,
    boots: [],
  };
}

export function readStateFile(stateFile) {
  try {
    return { ...freshState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch {
    return freshState();
  }
}

export function writeStateFile(stateFile, state) {
  if (!stateFile) return;
  const tmp = `${stateFile}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

export async function loadScenario(name = 'ok') {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid scenario name: ${name}`);
  const mod = await import(pathToFileURL(path.join(SCENARIO_DIR, `${name}.mjs`)).href);
  return mod.default ?? {};
}

export function readFixture(dataDir, name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8'));
}

const newEventId = () => `evt_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;

function compileRoute(key) {
  const [method, pattern] = key.split(' ');
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, regex: new RegExp(`^${source}$`), names };
}

function matchRoute(table, method, pathname) {
  for (const [key, handler] of Object.entries(table)) {
    const route = compileRoute(key);
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.names.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]);
    });
    return { handler, params };
  }
  return null;
}

function parseConfigContent(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const DEFAULT_ROUTES = {
  'GET /global/health': (fake) => ({ body: { healthy: true, version: fake.version } }),
  'POST /global/dispose': () => ({ body: true }),
  'GET /agent': (fake) => ({ body: readFixture(fake.dataDir, 'agent') }),
  'GET /config': (fake) => ({ body: { ...fake.baseConfig, ...fake.configOverride } }),
  'GET /session/status': () => ({ body: {} }),
  'GET /permission': () => ({ body: [] }),
  'GET /question': () => ({ body: [] }),
  'GET /event': (fake, ctx) => {
    fake.openEventStream(ctx.req, ctx.res);
    return 'handled';
  },
};

// Phase extensions: F1+ append `registerFakeExtension(install)` calls at the END of this file (never edit the
// router). `install(fake)` runs once per startFake, before the scenario `setup`, and returns a route table
// `{ 'METHOD /path/:param': handler }` merged over DEFAULT_ROUTES (same key → replaced; new keys → appended).
const FAKE_EXTENSIONS = [];
export function registerFakeExtension(install) {
  FAKE_EXTENSIONS.push(install);
}

export async function startFake({
  port = 0,
  password = null,
  scenario = 'ok',
  stateFile = null,
  dataDir = FIXTURE_DATA_DIR,
  heartbeatMs = Number(process.env.FAKE_HEARTBEAT_MS || 10000),
  version = process.env.FAKE_OPENCODE_VERSION || DEFAULT_VERSION,
  configContent = process.env.OPENCODE_CONFIG_CONTENT,
} = {}) {
  const scn = await loadScenario(scenario);
  const state = stateFile ? readStateFile(stateFile) : freshState();
  const sseClients = new Set();

  const fake = {
    state,
    stateFile,
    dataDir,
    scenario: scn,
    scenarioName: scenario,
    version: scn.version ?? version,
    password,
    rejectAllAuth: false,
    heartbeatMs,
    baseConfig: readFixture(dataDir, 'config'),
    configOverride: parseConfigContent(configContent),
    sseClients,
    persist() {
      writeStateFile(stateFile, state);
    },
    recordSignal(signal) {
      state.signals.push({ signal, pid: process.pid, at: Date.now() });
      writeStateFile(stateFile, state);
    },
    emit(event) {
      const full = { id: newEventId(), properties: {}, ...event };
      for (const client of sseClients) client.send(full);
    },
    openEventStream(req, res) {
      state.sseConnections += 1;
      writeStateFile(stateFile, state);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders?.();
      let heartbeat = null;
      const stream = {
        index: state.sseConnections,
        send(event) {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ id: newEventId(), properties: {}, ...event })}\n\n`);
        },
        sendConnected() {
          stream.send({ type: 'server.connected', properties: {} });
        },
        startHeartbeat() {
          heartbeat = setInterval(() => stream.send({ type: 'server.heartbeat', properties: {} }), fake.heartbeatMs);
        },
        close() {
          clearInterval(heartbeat);
          sseClients.delete(stream);
          if (!res.writableEnded) res.end();
          res.socket?.destroy();
        },
      };
      sseClients.add(stream);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(stream);
      });
      if (typeof scn.onEventStream === 'function') scn.onEventStream(fake, stream);
      else {
        stream.sendConnected();
        stream.startHeartbeat();
      }
    },
  };

  // Resolution: scenario routes first; a scenario handler returning undefined falls through to the base route
  // (DEFAULT_ROUTES + phase extensions) that matches the same request, params included.
  const baseRoutes = { ...DEFAULT_ROUTES };
  for (const install of FAKE_EXTENSIONS) Object.assign(baseRoutes, install(fake) ?? {});
  const scenarioRoutes = scn.routes ?? {};

  function authorized(req) {
    if (fake.rejectAllAuth) return false;
    if (!fake.password) return true;
    const expected = `Basic ${Buffer.from(`opencode:${fake.password}`).toString('base64')}`;
    return req.headers.authorization === expected;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    state.requests.push({ method: req.method, path: url.pathname, query, body, at: Date.now() });
    writeStateFile(stateFile, state);
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const scenarioHit = matchRoute(scenarioRoutes, req.method, url.pathname);
    const baseHit = matchRoute(baseRoutes, req.method, url.pathname);
    if (!scenarioHit && !baseHit) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'NotFoundError', data: { message: `no route ${req.method} ${url.pathname}` } }));
      return;
    }
    const routeCtx = (hit) => ({ method: req.method, path: url.pathname, query, body, params: hit.params, req, res });
    try {
      let final = scenarioHit ? await scenarioHit.handler(fake, routeCtx(scenarioHit)) : undefined;
      if (final === 'handled') return;
      if (final === undefined && baseHit) final = await baseHit.handler(fake, routeCtx(baseHit));
      if (final === 'handled') return;
      const status = final?.status ?? 200;
      if (final?.body === undefined || status === 204) {
        res.writeHead(status === 200 ? 204 : status);
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...(final.headers ?? {}) });
      res.end(JSON.stringify(final.body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'UnknownError', data: { message: String(err?.message ?? err) } }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  fake.port = actualPort;
  fake.url = `http://127.0.0.1:${actualPort}`;
  fake.server = server;
  if (typeof scn.setup === 'function') await scn.setup(fake);
  fake.close = () =>
    new Promise((resolve) => {
      for (const client of [...sseClients]) client.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  return fake;
}
````

Crie `tests/fixtures/bin/opencode` e torne-o executável (`chmod +x tests/fixtures/bin/opencode`):

````js
#!/usr/bin/env node
// Fake `opencode` binary: `--version` and `serve --port N --hostname H` (starts tests/fixtures/fake-opencode.mjs).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeModule = await import(pathToFileURL(path.join(here, '..', 'fake-opencode.mjs')).href);
const { startFake, loadScenario, readStateFile, writeStateFile, DEFAULT_VERSION } = fakeModule;

const argv = process.argv.slice(2);
const scenarioName = process.env.FAKE_OPENCODE_SCENARIO || 'ok';
const stateFile = process.env.FAKE_OPENCODE_STATE || null;
const scenario = await loadScenario(scenarioName);
const version = scenario.version ?? process.env.FAKE_OPENCODE_VERSION ?? DEFAULT_VERSION;

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (argv[0] !== 'serve') {
  process.stderr.write(`fake opencode: unsupported command ${argv.join(' ')}\n`);
  process.exit(2);
}

const requestedPort = Number(flag('--port') ?? 4096);
const hostname = flag('--hostname') ?? '127.0.0.1';
const password = process.env.OPENCODE_SERVER_PASSWORD || null;

const state = stateFile ? readStateFile(stateFile) : null;
const attempt = state ? state.bootAttempts + 1 : 1;
if (state) {
  state.bootAttempts = attempt;
  writeStateFile(stateFile, state);
}

let fake = null;
const ignoring = Boolean(scenario.ignoreSigterm);
function recordSignal(signal) {
  if (fake) fake.recordSignal(signal);
  else if (stateFile) {
    const s = readStateFile(stateFile);
    s.signals.push({ signal, pid: process.pid, at: Date.now() });
    writeStateFile(stateFile, s);
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    recordSignal(signal);
    if (ignoring && signal === 'SIGTERM') return;
    if (fake) await fake.close();
    process.exit(0);
  });
}

const plan = (typeof scenario.boot === 'function'
  ? scenario.boot({ attempt, port: requestedPort, hostname, env: process.env })
  : undefined) ?? {};

if (plan.delayMs) await sleep(plan.delayMs);
if (plan.exitCode !== undefined) {
  if (plan.stderr) process.stderr.write(plan.stderr);
  process.exit(plan.exitCode);
}

if (!password) process.stdout.write('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n');

const listenPort = plan.listenPort ?? requestedPort;
try {
  fake = await startFake({ port: listenPort, password, scenario: scenarioName, stateFile, version });
} catch (err) {
  process.stderr.write(`Error: listen ${err.code ?? 'FAILED'}: ${err.message}\n`);
  process.exit(1);
}
fake.state.boots.push({
  pid: process.pid,
  attempt,
  requestedPort,
  port: fake.port,
  hostname,
  hasPassword: Boolean(password),
  insideServer: process.env.OPC_INSIDE_SERVER ?? null,
  username: process.env.OPENCODE_SERVER_USERNAME ?? null,
  configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  cwd: process.cwd(),
  startedAt: Date.now(),
});
fake.persist();
process.stdout.write(`opencode server listening on http://${hostname}:${plan.printPort ?? fake.port}\n`);
````

Crie `tests/fixtures/data/agent.json` (forma do schema `Agent` da OpenAPI 1.18.32; regras padrão do `build` iguais às do binário, spec §1.4):

````json
[
  {
    "name": "build",
    "description": "The default agent. Executes tools based on configured permissions.",
    "mode": "primary",
    "native": true,
    "permission": [
      { "permission": "*", "pattern": "*", "action": "allow" },
      { "permission": "doom_loop", "pattern": "*", "action": "ask" },
      { "permission": "external_directory", "pattern": "*", "action": "ask" },
      { "permission": "question", "pattern": "*", "action": "deny" },
      { "permission": "read", "pattern": "*.env", "action": "ask" },
      { "permission": "read", "pattern": "*.env.*", "action": "ask" }
    ],
    "options": {}
  },
  {
    "name": "plan",
    "description": "Plan mode. Disallows all edit tools.",
    "mode": "primary",
    "native": true,
    "permission": [
      { "permission": "*", "pattern": "*", "action": "allow" },
      { "permission": "edit", "pattern": "*", "action": "deny" }
    ],
    "options": {}
  },
  {
    "name": "general",
    "description": "General-purpose agent for researching complex questions and executing multi-step tasks.",
    "mode": "subagent",
    "native": true,
    "permission": [
      { "permission": "*", "pattern": "*", "action": "allow" }
    ],
    "options": {}
  },
  {
    "name": "explore",
    "description": "Fast agent specialized for exploring codebases.",
    "mode": "subagent",
    "native": true,
    "permission": [
      { "permission": "*", "pattern": "*", "action": "allow" },
      { "permission": "edit", "pattern": "*", "action": "deny" }
    ],
    "options": {}
  }
]
````

Crie `tests/fixtures/data/config.json` (nomes neutros; a F1 acrescenta `provider.json`, `command.json` e `skill.json` e substitui `agent.json`, mas **não** altera este arquivo: os testes de política da F0 negam `fake-provider`, e testes posteriores que dependem de resolução de modelo gravam `defaultModel` na config do opc):

````json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "fake-provider/fake-model",
  "small_model": "fake-provider/fake-small",
  "share": "manual",
  "autoupdate": false,
  "agent": {},
  "mcp": {},
  "provider": {},
  "permission": {}
}
````

Crie os cenários `tests/fixtures/scenarios/ok.mjs`:

````js
// Default behavior: healthy server, SSE with server.connected + heartbeat.
export default {};
````

`tests/fixtures/scenarios/auth-401.mjs`:

````js
// Every request is rejected with 401 (wrong credentials on the plugin side).
export default {
  setup(fake) {
    fake.rejectAllAuth = true;
  },
};
````

`tests/fixtures/scenarios/old-version.mjs`:

````js
// OpenCode older than the supported minimum (1.18.0).
export default {
  version: '1.17.9',
};
````

`tests/fixtures/scenarios/eaddrinuse.mjs`:

````js
// The first FAKE_FAIL_BOOTS boots (default 2) die with EADDRINUSE.
export default {
  boot({ attempt, port, env }) {
    const fails = Number(env.FAKE_FAIL_BOOTS ?? 2);
    if (attempt <= fails) {
      return { exitCode: 1, stderr: `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n` };
    }
    return undefined;
  },
};
````

- [ ] **Step 4: Rodar e ver passar**

Run: `chmod +x tests/fixtures/bin/opencode && node --test tests/unit/fake-opencode.test.mjs`
Expected: PASS — `# tests 4`, `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/fake-opencode.mjs tests/fixtures/bin/opencode tests/fixtures/data/agent.json tests/fixtures/data/config.json tests/fixtures/scenarios/ok.mjs tests/fixtures/scenarios/auth-401.mjs tests/fixtures/scenarios/old-version.mjs tests/fixtures/scenarios/eaddrinuse.mjs tests/unit/fake-opencode.test.mjs
git commit -m "test: add fake opencode server and binary"
```

Confira que o bit de execução foi registrado: `git ls-files -s tests/fixtures/bin/opencode` deve começar com `100755`.

---

### Task 11: SSE — parser e `EventHub`

Spec §5.3. Uma conexão `GET /event?directory=…`; `start()` resolve no primeiro evento (`server.connected`); qualquer evento renova a liveness (padrão 30 s); fim do stream, liveness estourada ou `server.instance.disposed` → reconexão com backoff 0,5/1/2/4/8 s; reconectou → `onReconnect` (ponto de ressincronização, que a F2a usa para `GET /session/status`, mensagens, `/permission` e `/question`); esgotou → estado `down` e `onDown(err)`. Roteamento por sessão (`properties.sessionID`, `properties.info.sessionID` ou `properties.part.sessionID`), incluindo filhas e netas anunciadas por `session.created` com `info.parentID` acompanhado.

**Files:**
- Create: `plugins/opc/scripts/lib/sse.mjs`, `tests/fixtures/scenarios/sse-drop.mjs`, `tests/fixtures/scenarios/no-heartbeat.mjs`, `tests/fixtures/scenarios/instance-disposed.mjs`
- Test: `tests/unit/sse.test.mjs`, `tests/integration/sse-hub.test.mjs`

**Interfaces:**
- Consumes: `createClient` (Task 9: usa `client.buildUrl('/event')` e `client.authHeaders()`); `ConnectionError` (Task 3); `startFake` (Task 10).
- Produces (contrato do mestre): `createSSEParser() → { push(chunkText) → events[] }`; `class EventHub({ client, livenessMs = 30000, backoffMs = [500,1000,2000,4000,8000], fetchImpl = fetch })` com `start()`, `stop()`, `track(sessionID, handler) → untrack`, `onAny(handler) → off`, `onReconnect(handler) → off`.
- Produces (**novas**): `eventSessionID(event) → string|null`; `EventHub#onDown(handler) → off` (`handler(ConnectionError)` com `SERVER_DOWN` ou `AUTH_FAILED`); getter `EventHub#state` (`'idle'|'connecting'|'open'|'reconnecting'|'down'|'stopped'`). `start()` que falha volta o estado para `'idle'`.

- [ ] **Step 1: Escrever os testes e os cenários de queda**

Crie `tests/unit/sse.test.mjs`:

````js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSSEParser, eventSessionID } from '../../plugins/opc/scripts/lib/sse.mjs';

test('parser returns JSON of each data frame, across chunk boundaries', () => {
  const p = createSSEParser();
  assert.deepEqual(p.push('data: {"type":"server.connected","properties":{}}\n\nda'), [{ type: 'server.connected', properties: {} }]);
  assert.deepEqual(p.push('ta: {"type":"server.heartbeat"}\n'), []);
  assert.deepEqual(p.push('\n'), [{ type: 'server.heartbeat' }]);
});

test('parser ignores comments, non-data fields and invalid JSON; handles CRLF and multi-line data', () => {
  const p = createSSEParser();
  const events = p.push(': keep-alive\n\nevent: x\nid: 1\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: not json\n\ndata:{"b":2}\n\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test('eventSessionID finds the session in properties, info or part', () => {
  assert.equal(eventSessionID({ properties: { sessionID: 'ses_a' } }), 'ses_a');
  assert.equal(eventSessionID({ properties: { info: { sessionID: 'ses_b' } } }), 'ses_b');
  assert.equal(eventSessionID({ properties: { part: { sessionID: 'ses_c' } } }), 'ses_c');
  assert.equal(eventSessionID({ type: 'server.heartbeat', properties: {} }), null);
  assert.equal(eventSessionID(null), null);
});
````

Crie `tests/integration/sse-hub.test.mjs`:

````js
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { EventHub } from '../../plugins/opc/scripts/lib/sse.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { makeTempDir, trackTempDir, waitFor } from '../helpers.mjs';

const PASSWORD = 'sse-hub-password-0123456789';
const FAST_BACKOFF = [20, 20, 20, 20, 20];

async function setup(t, { scenario = 'ok', heartbeatMs = 50, livenessMs = 1000 } = {}) {
  const dir = trackTempDir(t, makeTempDir('opc-sse-'));
  const fake = await startFake({ port: 0, password: PASSWORD, scenario, stateFile: path.join(dir, 'fake.json'), heartbeatMs });
  const client = createClient({ baseUrl: fake.url, password: PASSWORD, directory: dir });
  const hub = new EventHub({ client, livenessMs, backoffMs: FAST_BACKOFF });
  t.after(async () => {
    hub.stop();
    await fake.close();
  });
  return { fake, hub, dir };
}

test('start() resolves after server.connected and heartbeats reach onAny', async (t) => {
  const { hub, fake, dir } = await setup(t);
  const types = [];
  hub.onAny((e) => types.push(e.type));
  await hub.start();
  assert.equal(hub.state, 'open');
  await waitFor(() => types.includes('server.heartbeat'), { message: 'heartbeat' });
  assert.equal(types[0], 'server.connected');
  const req = fake.state.requests.find((r) => r.path === '/event');
  assert.equal(req.query.directory, dir);
});

test('track routes events by session and includes children created later', async (t) => {
  const { hub, fake } = await setup(t);
  await hub.start();
  const got = [];
  const untrack = hub.track('ses_root', (e) => got.push(`${e.type}:${e.properties.sessionID}`));
  fake.emit({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_root' } } });
  fake.emit({ type: 'session.created', properties: { sessionID: 'ses_grand', info: { id: 'ses_grand', parentID: 'ses_child' } } });
  fake.emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_grand', permission: 'bash', patterns: ['ls'] } });
  fake.emit({ type: 'permission.asked', properties: { id: 'per_2', sessionID: 'ses_other', permission: 'bash', patterns: ['ls'] } });
  fake.emit({ type: 'session.idle', properties: { sessionID: 'ses_root' } });
  await waitFor(() => got.includes('session.idle:ses_root'), { message: 'idle routed' });
  assert.deepEqual(got, [
    'session.created:ses_child',
    'session.created:ses_grand',
    'permission.asked:ses_grand',
    'session.idle:ses_root',
  ]);
  untrack();
  fake.emit({ type: 'session.idle', properties: { sessionID: 'ses_child' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.length, 4);
});

for (const scenario of ['sse-drop', 'no-heartbeat', 'instance-disposed']) {
  test(`${scenario}: the hub reconnects and fires onReconnect (resync point)`, async (t) => {
    const { hub, fake } = await setup(t, { scenario, livenessMs: 300 });
    let reconnects = 0;
    const types = [];
    hub.onReconnect(() => { reconnects += 1; });
    hub.onAny((e) => types.push(e.type));
    await hub.start();
    await waitFor(() => reconnects === 1, { timeoutMs: 5000, message: 'reconnect' });
    assert.equal(fake.state.sseConnections, 2);
    assert.equal(hub.state, 'open');
    await waitFor(() => types.filter((x) => x === 'server.connected').length === 2 && types.includes('server.heartbeat'), { message: 'events after reconnect' });
    if (scenario === 'instance-disposed') assert.ok(types.includes('server.instance.disposed'));
  });
}

test('after exhausting the backoff the hub goes down and calls onDown with SERVER_DOWN', async (t) => {
  const { hub, fake } = await setup(t);
  let downErr = null;
  hub.onDown((err) => { downErr = err; });
  await hub.start();
  await fake.close();
  await waitFor(() => downErr, { timeoutMs: 5000, message: 'onDown' });
  assert.equal(downErr.code, 'SERVER_DOWN');
  assert.equal(hub.state, 'down');
});

test('start() rejects with AUTH_FAILED when the password is wrong', async (t) => {
  const { fake } = await setup(t);
  const bad = new EventHub({ client: createClient({ baseUrl: fake.url, password: 'wrong-password-000000' }), backoffMs: FAST_BACKOFF });
  await assert.rejects(bad.start(), (e) => e.code === 'AUTH_FAILED');
  assert.equal(bad.state, 'idle');
});
````

Crie `tests/fixtures/scenarios/sse-drop.mjs`:

````js
// First /event connection sends server.connected and drops after 50 ms; later ones behave normally.
export default {
  onEventStream(fake, stream) {
    stream.sendConnected();
    if (stream.index === 1) setTimeout(() => stream.close(), 50);
    else stream.startHeartbeat();
  },
};
````

`tests/fixtures/scenarios/no-heartbeat.mjs`:

````js
// First /event connection sends server.connected and then stays silent (no heartbeat).
export default {
  onEventStream(fake, stream) {
    stream.sendConnected();
    if (stream.index !== 1) stream.startHeartbeat();
  },
};
````

`tests/fixtures/scenarios/instance-disposed.mjs`:

````js
// First /event connection emits server.instance.disposed and closes, like the real server does.
export default {
  onEventStream(fake, stream) {
    stream.sendConnected();
    if (stream.index === 1) {
      setTimeout(() => {
        stream.send({ type: 'server.instance.disposed', properties: { directory: '/fake' } });
        stream.close();
      }, 50);
    } else {
      stream.startHeartbeat();
    }
  },
};
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/sse.test.mjs tests/integration/sse-hub.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/sse.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/sse.mjs`:

````js
// SSE /event: parser, liveness, reconnection with backoff and per-session routing incl. children (spec §5.3).
import { ConnectionError } from './opc-error.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSSEParser() {
  let buffer = '';
  return {
    push(chunkText) {
      buffer += String(chunkText).replace(/\r\n/g, '\n');
      const events = [];
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) {
          try {
            events.push(JSON.parse(data));
          } catch {
            // invalid JSON frames are ignored
          }
        }
        index = buffer.indexOf('\n\n');
      }
      return events;
    },
  };
}

export function eventSessionID(event) {
  const p = event?.properties;
  if (!p || typeof p !== 'object') return null;
  return p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? null;
}

function safeCall(fn, ...args) {
  try {
    fn(...args);
  } catch {
    // a failing handler never breaks the hub
  }
}

export class EventHub {
  constructor({ client, livenessMs = 30000, backoffMs = [500, 1000, 2000, 4000, 8000], fetchImpl = fetch }) {
    this.client = client;
    this.livenessMs = livenessMs;
    this.backoffMs = backoffMs;
    this.fetchImpl = fetchImpl;
    this._state = 'idle';
    this._routes = new Map();
    this._any = new Set();
    this._reconnect = new Set();
    this._down = new Set();
    this._controller = null;
    this._livenessTimer = null;
  }

  get state() {
    return this._state;
  }

  onAny(handler) {
    this._any.add(handler);
    return () => this._any.delete(handler);
  }

  onReconnect(handler) {
    this._reconnect.add(handler);
    return () => this._reconnect.delete(handler);
  }

  onDown(handler) {
    this._down.add(handler);
    return () => this._down.delete(handler);
  }

  track(sessionID, handler) {
    const entry = { handler, ids: new Set([sessionID]) };
    this._routes.set(sessionID, entry);
    return () => {
      for (const id of entry.ids) if (this._routes.get(id) === entry) this._routes.delete(id);
    };
  }

  async start() {
    if (this._state !== 'idle') throw new Error('EventHub already started');
    this._state = 'connecting';
    let first;
    try {
      first = await this._connect();
    } catch (err) {
      clearTimeout(this._livenessTimer);
      this._state = 'idle';
      throw err;
    }
    this._state = 'open';
    this._loop(first);
  }

  stop() {
    this._state = 'stopped';
    clearTimeout(this._livenessTimer);
    if (this._controller) this._controller.abort();
  }

  _armLiveness() {
    clearTimeout(this._livenessTimer);
    this._livenessTimer = setTimeout(() => {
      if (this._controller) this._controller.abort();
    }, this.livenessMs);
    if (typeof this._livenessTimer.unref === 'function') this._livenessTimer.unref();
  }

  async _connect() {
    const controller = new AbortController();
    this._controller = controller;
    let res;
    try {
      res = await this.fetchImpl(this.client.buildUrl('/event'), {
        headers: { ...this.client.authHeaders(), accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch {
      throw new ConnectionError('SERVER_DOWN', 'Não foi possível abrir o fluxo de eventos (/event).');
    }
    if (res.status === 401) throw new ConnectionError('AUTH_FAILED', 'Fluxo de eventos recusado (401).');
    if (!res.ok || !res.body) throw new ConnectionError('SERVER_DOWN', `Fluxo de eventos falhou (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSSEParser();
    this._armLiveness();
    // Wait for the first event (server.connected) before declaring the stream open.
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw new ConnectionError('SERVER_DOWN', 'Fluxo de eventos encerrado antes do primeiro evento.');
      }
      if (chunk.done) throw new ConnectionError('SERVER_DOWN', 'Fluxo de eventos encerrado antes do primeiro evento.');
      const events = parser.push(decoder.decode(chunk.value, { stream: true }));
      if (events.length > 0) return { reader, decoder, parser, controller, pending: events };
    }
  }

  async _read(conn) {
    let disposed = false;
    const handle = (events) => {
      for (const event of events) {
        this._armLiveness();
        this._dispatch(event);
        if (event?.type === 'server.instance.disposed') disposed = true;
      }
    };
    handle(conn.pending);
    while (!disposed && this._state !== 'stopped') {
      let chunk;
      try {
        chunk = await conn.reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      handle(conn.parser.push(conn.decoder.decode(chunk.value, { stream: true })));
    }
    conn.controller.abort();
  }

  async _loop(first) {
    let conn = first;
    while (this._state !== 'stopped') {
      await this._read(conn);
      clearTimeout(this._livenessTimer);
      if (this._state === 'stopped') return;
      this._state = 'reconnecting';
      conn = null;
      let lastError = null;
      for (const delay of this.backoffMs) {
        await sleep(delay);
        if (this._state === 'stopped') return;
        try {
          conn = await this._connect();
          break;
        } catch (err) {
          lastError = err;
          if (err.code === 'AUTH_FAILED') break;
        }
      }
      if (!conn) {
        this._state = 'down';
        const err = lastError?.code === 'AUTH_FAILED'
          ? lastError
          : new ConnectionError('SERVER_DOWN', `Fluxo de eventos perdido após ${this.backoffMs.length} tentativas de reconexão.`);
        for (const h of this._down) safeCall(h, err);
        return;
      }
      this._state = 'open';
      for (const h of this._reconnect) safeCall(h);
    }
  }

  _dispatch(event) {
    for (const h of this._any) safeCall(h, event);
    if (event?.type === 'session.created') {
      const info = event.properties?.info;
      const parent = info?.parentID ? this._routes.get(info.parentID) : null;
      if (parent && info.id && !this._routes.has(info.id)) {
        parent.ids.add(info.id);
        this._routes.set(info.id, parent);
      }
    }
    const sid = eventSessionID(event);
    const entry = sid ? this._routes.get(sid) : null;
    if (entry) safeCall(entry.handler, event);
  }
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/sse.test.mjs tests/integration/sse-hub.test.mjs`
Expected: PASS — `# tests 10`, `# pass 10`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/sse.mjs tests/unit/sse.test.mjs tests/integration/sse-hub.test.mjs tests/fixtures/scenarios/sse-drop.mjs tests/fixtures/scenarios/no-heartbeat.mjs tests/fixtures/scenarios/instance-disposed.mjs
git commit -m "feat: add sse parser and event hub with reconnection"
```

---

### Task 12: Ciclo de vida do servidor (`server`)

Implementa o §5.1 inteiro (passos 1–10) e o §5.5, testado em processo contra o binário falso. Pontos que o engenheiro precisa saber:

- Tudo roda sob `server.lock` (espera `4 × bootTimeoutSec`). Reaproveitar e subir acontecem sob o lock, por isso duas chamadas simultâneas geram um único spawn.
- Identidade do registro = pid vivo + start time igual + `serverMatcher(port)` (argv com `opencode`/`opencode.exe` num dos 3 primeiros argumentos, `serve` e `--port <porta>`). Isso nunca casa com um `opencode serve` aberto à mão pelo usuário (outra porta).
- A linha `listening on` é lida do `server.log` **a partir do offset de antes do spawn** (o log é compartilhado entre boots). A cada 5 voltas o health é consultado como fallback (401 também conta como “subiu”, e o passo de versão lança `AUTH_FAILED`).
- Falha de tentativa (porta diferente, processo morto, timeout) → `terminateProcessGroup` com identidade → outra porta, até 3. `AUTH_FAILED` e `UNSUPPORTED_VERSION` não repetem. Binário ausente → `BOOT_FAILED` com orientação de instalação.
- Ambiente do filho: `OPENCODE_SERVER_PASSWORD` (24 bytes hex), `OPENCODE_SERVER_USERNAME=opencode`, `OPENCODE_CONFIG_CONTENT=JSON(server.configOverride)`, `OPC_INSIDE_SERVER=1`; `OPC_SERVER_URL`/`OPC_SERVER_PASSWORD` removidos.
- `server.json` (600): `{schemaVersion:1, pid, startTime, port, url, version, password, startedAt, spawnedBy:'opc', cmdline, world}`.

**Files:**
- Create: `plugins/opc/scripts/lib/server.mjs`, `tests/fixtures/scenarios/port-mismatch.mjs`, `tests/fixtures/scenarios/boot-slow.mjs`, `tests/fixtures/scenarios/hung-server.mjs`, `tests/fixtures/scenarios/version-changed.mjs`, `tests/fixtures/scenarios/ignores-sigterm.mjs`, `tests/fixtures/scenarios/share-auto.mjs`
- Test: `tests/unit/server.test.mjs`, `tests/integration/server-lifecycle.test.mjs`, `tests/integration/server-boot.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG`, `matchesGlob`, `mergeConfig` (Task 8); `createClient` (Task 9); `withLock` (Task 6); `getProcessIdentity`, `isPidAlive`, `spawnDetached`, `terminateProcessGroup` (Task 5); `registerSecret`, `redactText` (Task 3); `readJson`, `writeFileAtomic`, `ensurePrivateDir`, `workspaceStateDir` (Task 7); `startFake` (Task 10).
- Produces (contrato do mestre): `MIN_OPENCODE_VERSION = '1.18.0'`, `compareVersions(a, b)`, `pickFreePort()`, `serverMatcher(port)`, `readServerRecord(stateDir)` (registra a senha para redação), `ensureServer(ctx)`, `stopServer(ctx, { force = false, confirmedByUser = false })`, `clientFor(ctx, server)`.
  - `ctx`: `{ stateDir, workspaceRoot, config, env = process.env, opencodeBin = 'opencode', hasActiveJobs = () => false }`.
  - `ensureServer` → `{ url, password, version, pid, attached }` **mais** (novos) `port`, `reused: boolean`, `world: { shareBlocked, deniedDefaults: string[] }`, `warnings: string[]`. Erros: `ConnectionError('BOOT_FAILED'|'AUTH_FAILED'|'UNSUPPORTED_VERSION'|'TIMEOUT'|'SERVER_DOWN')`, `UsageError('INSECURE_SERVER_URL')`.
  - `stopServer` → `{ stopped, reason: 'not-running'|'attached'|'active-jobs'|'terminated'|'killed'|'identity-mismatch' }`; `force` sem `confirmedByUser` → `UsageError('CONFIRMATION_REQUIRED')`.
  - `clientFor` → cliente com `directory = workspaceRoot` e `onServerDown = () => ensureServer(ctx).then(s => ({ url: s.url, password: s.password }))`.
- Produces (**nova**): `assertCanCreateSessions(server)` → lança `PolicyError('SHARE_AUTO')` se `server.world.shareBlocked`.

- [ ] **Step 1: Escrever os testes e os cenários**

Crie `tests/unit/server.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import {
  MIN_OPENCODE_VERSION, assertCanCreateSessions, compareVersions, pickFreePort, readServerRecord, serverMatcher,
} from '../../plugins/opc/scripts/lib/server.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

test('MIN_OPENCODE_VERSION is 1.18.0 and compareVersions orders numerically', () => {
  assert.equal(MIN_OPENCODE_VERSION, '1.18.0');
  assert.equal(compareVersions('1.18.32', '1.18.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.18.0'), -1);
  assert.equal(compareVersions('1.18.0', '1.18.0'), 0);
  assert.equal(compareVersions('v2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.18.32-beta.1', '1.18.32'), 0);
  assert.equal(compareVersions('1.17.9', MIN_OPENCODE_VERSION), -1);
});

test('pickFreePort returns a port that can be bound on 127.0.0.1', async () => {
  const port = await pickFreePort();
  assert.ok(port > 0 && port < 65536);
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  });
});

test('serverMatcher accepts only `opencode serve --port <port>` (real binary or node wrapper)', () => {
  const m = serverMatcher(43210);
  assert.equal(m(['opencode', 'serve', '--port', '43210', '--hostname', '127.0.0.1']), true);
  assert.equal(m(['/usr/bin/node', '/x/tests/fixtures/bin/opencode', 'serve', '--port', '43210']), true);
  assert.equal(m(['/home/u/.bun/bin/opencode.exe', 'serve', '--port=43210']), true);
  assert.equal(m(['opencode', 'serve', '--port', '4096']), false);
  assert.equal(m(['opencode', 'serve']), false);
  assert.equal(m(['opencode', 'run', '--port', '43210']), false);
  assert.equal(m(['vim', 'a', 'b', '/tmp/opencode', 'serve', '--port', '43210']), false);
  assert.equal(m([]), false);
  assert.equal(m(null), false);
});

test('readServerRecord returns null for missing, invalid or foreign-schema files', (t) => {
  const dir = makeTempDir('opc-srv-');
  t.after(() => removeTempDir(dir));
  assert.equal(readServerRecord(dir), null);
  fs.writeFileSync(path.join(dir, 'server.json'), '{bad');
  assert.equal(readServerRecord(dir), null);
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 2, pid: 1, port: 2 }));
  assert.equal(readServerRecord(dir), null);
  const record = { schemaVersion: 1, pid: 123, port: 4567, url: 'http://127.0.0.1:4567', password: 'abcdefgh12345678', startTime: '9' };
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(record));
  assert.deepEqual(readServerRecord(dir), record);
});

test('assertCanCreateSessions refuses when share is auto (PolicyError, exit 4)', () => {
  assert.doesNotThrow(() => assertCanCreateSessions({ world: { shareBlocked: false } }));
  assert.throws(() => assertCanCreateSessions({ world: { shareBlocked: true } }), (e) => e.code === 'SHARE_AUTO' && e.exitCode === 4);
});
````

Crie `tests/integration/server-lifecycle.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { clientFor, ensureServer, serverMatcher, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { ensurePrivateDir, workspaceStateDir, writeFileAtomic } from '../../plugins/opc/scripts/lib/state.mjs';
import {
  deadPid, makeWorkspace, processAlive, readFakeState, readJsonFile, registerStopper, spawnSleeper, testEnv, waitFor,
} from '../helpers.mjs';

function serverCtx(t, { scenario = 'ok', extra = {}, config = {} } = {}) {
  const env = testEnv(t, { scenario, extra });
  const ws = makeWorkspace(t);
  ensurePrivateDir(path.join(env.OPC_DATA_DIR, 'state'));
  const stateDir = ensurePrivateDir(workspaceStateDir(env.OPC_DATA_DIR, ws));
  const ctx = { stateDir, workspaceRoot: ws, config: mergeConfig(config, null).config, env, hasActiveJobs: () => false };
  registerStopper(t, () => stopServer({ ...ctx, hasActiveJobs: () => false }, { force: true, confirmedByUser: true }));
  return { env, ws, ctx, stateDir };
}

test('ensureServer spawns a detached server, records it (600) and reuses it; stopServer disposes then signals', async (t) => {
  const { env, ctx, stateDir } = serverCtx(t);
  const first = await ensureServer(ctx);
  assert.equal(first.reused, false);
  assert.equal(first.attached, false);
  assert.notEqual(first.port, 4096);
  assert.equal(first.url, `http://127.0.0.1:${first.port}`);
  assert.equal(first.version, '1.18.32');
  const record = readJsonFile(path.join(stateDir, 'server.json'));
  assert.deepEqual(
    { schemaVersion: record.schemaVersion, pid: record.pid, port: record.port, spawnedBy: record.spawnedBy, version: record.version, password: record.password },
    { schemaVersion: 1, pid: first.pid, port: first.port, spawnedBy: 'opc', version: '1.18.32', password: first.password },
  );
  assert.equal(record.password.length, 48);
  assert.ok(serverMatcher(first.port)(record.cmdline));
  assert.equal(record.startTime, getProcessIdentity(first.pid).startTime);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(stateDir, 'server.json')).mode & 0o777, 0o600);

  const second = await ensureServer(ctx);
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.equal(readFakeState(env).bootAttempts, 1);

  assert.deepEqual(await stopServer(ctx), { stopped: true, reason: 'terminated' });
  await waitFor(() => !processAlive(first.pid), { message: 'server gone' });
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
  const fake = readFakeState(env);
  const disposeAt = fake.requests.find((r) => r.method === 'POST' && r.path === '/global/dispose')?.at;
  const sigtermAt = fake.signals.find((s) => s.signal === 'SIGTERM')?.at;
  assert.ok(disposeAt && sigtermAt && disposeAt <= sigtermAt, 'dispose happens before SIGTERM');
  assert.deepEqual(await stopServer(ctx), { stopped: false, reason: 'not-running' });
});

test('concurrent ensureServer calls in one process produce a single spawn', async (t) => {
  const { env, ctx } = serverCtx(t);
  const [a, b] = await Promise.all([ensureServer(ctx), ensureServer(ctx)]);
  assert.equal(a.pid, b.pid);
  assert.deepEqual([a.reused, b.reused].sort(), [false, true]);
  assert.equal(readFakeState(env).bootAttempts, 1);
});

test('stale-server-pid: a record pointing to a foreign live process is discarded without any signal', async (t) => {
  const { ctx, stateDir } = serverCtx(t);
  const sleeper = spawnSleeper(t);
  writeFileAtomic(path.join(stateDir, 'server.json'), {
    schemaVersion: 1, pid: sleeper.pid, startTime: getProcessIdentity(sleeper.pid).startTime, port: 45678,
    url: 'http://127.0.0.1:45678', version: '1.18.32', password: 'stale-password-0123456789', spawnedBy: 'opc',
  });
  const server = await ensureServer(ctx);
  assert.equal(server.reused, false);
  assert.ok(server.warnings.some((w) => /descartado/.test(w)));
  assert.ok(processAlive(sleeper.pid), 'foreign process was not signaled');
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, server.pid);
  assert.deepEqual(await stopServer({ ...ctx }), { stopped: true, reason: 'terminated' });
  writeFileAtomic(path.join(stateDir, 'server.json'), {
    schemaVersion: 1, pid: sleeper.pid, startTime: getProcessIdentity(sleeper.pid).startTime, port: 45678,
    url: 'http://127.0.0.1:45678', version: '1.18.32', password: 'stale-password-0123456789', spawnedBy: 'opc',
  });
  assert.deepEqual(await stopServer(ctx), { stopped: false, reason: 'identity-mismatch' });
  assert.ok(processAlive(sleeper.pid));
});

test('server-killed-externally: after kill -9 the next ensureServer cleans up and respawns without hanging', async (t) => {
  const { ctx, stateDir } = serverCtx(t);
  const first = await ensureServer(ctx);
  process.kill(-first.pid, 'SIGKILL');
  await waitFor(() => !processAlive(first.pid), { message: 'killed' });
  const started = Date.now();
  const second = await ensureServer(ctx);
  assert.ok(Date.now() - started < 15000, 'did not hang');
  assert.equal(second.reused, false);
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.password, first.password);
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, second.pid);
});

test('server-killed-externally (client level): clientFor re-ensures the server and retries a GET', async (t) => {
  const { ctx, stateDir } = serverCtx(t);
  const server = await ensureServer(ctx);
  const client = clientFor(ctx, server);
  assert.equal((await client.get('/global/health')).healthy, true);
  process.kill(-server.pid, 'SIGKILL');
  await waitFor(() => !processAlive(server.pid), { message: 'killed' });
  assert.equal((await client.get('/global/health')).healthy, true);
  assert.notEqual(readJsonFile(path.join(stateDir, 'server.json')).pid, server.pid);
  assert.notEqual(client.baseUrl, server.url);
});

test('hung-server: identity ok but health silent → terminated and replaced', async (t) => {
  const { env, ctx } = serverCtx(t, { scenario: 'hung-server' });
  const first = await ensureServer(ctx);
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.hang`, String(first.pid));
  const second = await ensureServer(ctx);
  assert.notEqual(second.pid, first.pid);
  assert.ok(second.warnings.some((w) => /travado/.test(w)));
  await waitFor(() => !processAlive(first.pid), { message: 'hung server gone' });
  assert.ok(readFakeState(env).signals.some((s) => s.signal === 'SIGTERM' && s.pid === first.pid));
});

test('version-changed: reused with a warning while jobs are active, replaced when idle', async (t) => {
  const { env, ctx, stateDir } = serverCtx(t, { scenario: 'version-changed' });
  const first = await ensureServer(ctx);
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.version`, '1.18.40');
  const busy = await ensureServer({ ...ctx, hasActiveJobs: () => true });
  assert.equal(busy.pid, first.pid);
  assert.equal(busy.reused, true);
  assert.ok(busy.warnings.some((w) => /mudou de versão/.test(w)));
  const idle = await ensureServer(ctx);
  assert.notEqual(idle.pid, first.pid);
  assert.equal(idle.version, '1.18.40');
  assert.ok(idle.warnings.some((w) => /versão mudou/.test(w)));
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).version, '1.18.40');
});

test('stopServer: refuses with active jobs, --force requires confirmation, attach mode is never stopped', async (t) => {
  const { ctx } = serverCtx(t);
  const server = await ensureServer(ctx);
  const busyCtx = { ...ctx, hasActiveJobs: () => true };
  assert.deepEqual(await stopServer(busyCtx), { stopped: false, reason: 'active-jobs' });
  assert.ok(processAlive(server.pid));
  await assert.rejects(stopServer(busyCtx, { force: true }), (e) => e.code === 'CONFIRMATION_REQUIRED' && e.exitCode === 2);
  assert.deepEqual(await stopServer(busyCtx, { force: true, confirmedByUser: true }), { stopped: true, reason: 'terminated' });
  assert.deepEqual(await stopServer({ ...ctx, env: { ...ctx.env, OPC_SERVER_URL: 'http://127.0.0.1:1' } }), { stopped: false, reason: 'attached' });
});

test('ignores-sigterm: stopServer escalates to SIGKILL on the group', async (t) => {
  const { env, ctx } = serverCtx(t, { scenario: 'ignores-sigterm' });
  const server = await ensureServer(ctx);
  assert.deepEqual(await stopServer(ctx), { stopped: true, reason: 'killed' });
  await waitFor(() => !processAlive(server.pid), { message: 'killed' });
  assert.ok(readFakeState(env).signals.some((s) => s.signal === 'SIGTERM'));
});

test('stale-lock: an orphan server.lock is broken and ensureServer proceeds', async (t) => {
  const { ctx, stateDir } = serverCtx(t);
  fs.writeFileSync(path.join(stateDir, 'server.lock'), JSON.stringify({ pid: await deadPid(), startTime: '1', purpose: 'ghost', token: 'x' }));
  const server = await ensureServer(ctx);
  assert.equal(server.reused, false);
  assert.equal(fs.readdirSync(stateDir).filter((n) => n.startsWith('server.lock.stale-')).length, 1);
});

test('the spawned server receives the password, username, override and OPC_INSIDE_SERVER; warm-up hits /agent', async (t) => {
  const { env, ctx, ws } = serverCtx(t, { config: { server: { configOverride: { share: 'disabled', small_model: 'p/small' } } } });
  await ensureServer(ctx);
  const fake = readFakeState(env);
  const boot = fake.boots[0];
  assert.deepEqual(
    { insideServer: boot.insideServer, hasPassword: boot.hasPassword, username: boot.username, hostname: boot.hostname, cwd: boot.cwd },
    { insideServer: '1', hasPassword: true, username: 'opencode', hostname: '127.0.0.1', cwd: ws },
  );
  assert.deepEqual(JSON.parse(boot.configContent), { share: 'disabled', small_model: 'p/small' });
  assert.ok(fake.requests.some((r) => r.path === '/agent' && r.query.directory === ws));
});
````

Crie `tests/integration/server-boot.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { assertCanCreateSessions, ensureServer, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { ensurePrivateDir, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';
import {
  makeTempDir, makeWorkspace, processAlive, readFakeState, readJsonFile, registerStopper, testEnv, trackTempDir,
} from '../helpers.mjs';

function serverCtx(t, { scenario = 'ok', extra = {}, config = {} } = {}) {
  const env = testEnv(t, { scenario, extra });
  const ws = makeWorkspace(t);
  ensurePrivateDir(path.join(env.OPC_DATA_DIR, 'state'));
  const stateDir = ensurePrivateDir(workspaceStateDir(env.OPC_DATA_DIR, ws));
  const ctx = { stateDir, workspaceRoot: ws, config: mergeConfig(config, null).config, env, hasActiveJobs: () => false };
  registerStopper(t, () => stopServer(ctx, { force: true, confirmedByUser: true }));
  return { env, ws, ctx, stateDir };
}

function assertNoLiveBoots(env) {
  for (const boot of readFakeState(env).boots) assert.equal(processAlive(boot.pid), false, `boot pid ${boot.pid} still alive`);
}

test('port-mismatch: the announced port differs → the attempt is killed and a new port is tried', async (t) => {
  const { env, ctx } = serverCtx(t, { scenario: 'port-mismatch' });
  const server = await ensureServer(ctx);
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 2);
  assert.equal(processAlive(fake.boots[0].pid), false, 'mismatched boot was terminated');
  assert.equal(server.port, fake.boots[1].requestedPort);
});

test('eaddrinuse: two failed boots then success on the third attempt', async (t) => {
  const { env, ctx } = serverCtx(t, { scenario: 'eaddrinuse' });
  const server = await ensureServer(ctx);
  assert.equal(server.reused, false);
  assert.equal(readFakeState(env).bootAttempts, 3);
});

test('eaddrinuse on every attempt → BOOT_FAILED after exactly 3 attempts', async (t) => {
  const { env, ctx, stateDir } = serverCtx(t, { scenario: 'eaddrinuse', extra: { FAKE_FAIL_BOOTS: '9' } });
  await assert.rejects(ensureServer(ctx), (e) => {
    assert.equal(e.code, 'BOOT_FAILED');
    assert.equal(e.exitCode, 5);
    assert.match(e.message, /3 tentativas/);
    assert.match(e.message, /EADDRINUSE/);
    return true;
  });
  assert.equal(readFakeState(env).bootAttempts, 3);
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
});

test('boot-slow: timeout on each attempt → BOOT_FAILED without orphans; a longer bootTimeoutSec succeeds', async (t) => {
  const { env, ctx } = serverCtx(t, { scenario: 'boot-slow', extra: { FAKE_BOOT_DELAY_MS: '2500' }, config: { server: { bootTimeoutSec: 0.5 } } });
  await assert.rejects(ensureServer(ctx), (e) => e.code === 'BOOT_FAILED' && /timeout/.test(e.message));
  assert.equal(readFakeState(env).bootAttempts, 3);
  assertNoLiveBoots(env);
  const patient = { ...ctx, config: mergeConfig({ server: { bootTimeoutSec: 10 } }, null).config };
  const server = await ensureServer(patient);
  assert.equal(server.reused, false);
});

test('version below the minimum → UNSUPPORTED_VERSION; the fresh server is terminated, no retry', async (t) => {
  const { env, ctx, stateDir } = serverCtx(t, { scenario: 'old-version' });
  await assert.rejects(ensureServer(ctx), (e) => e.code === 'UNSUPPORTED_VERSION' && e.exitCode === 5);
  assert.equal(readFakeState(env).bootAttempts, 1);
  assertNoLiveBoots(env);
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
});

test('auth-401 → AUTH_FAILED immediately (one boot), server terminated', async (t) => {
  const { env, ctx } = serverCtx(t, { scenario: 'auth-401' });
  await assert.rejects(ensureServer(ctx), (e) => e.code === 'AUTH_FAILED' && e.exitCode === 5);
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 1);
  assert.ok(fake.signals.some((s) => s.signal === 'SIGTERM'));
  assertNoLiveBoots(env);
});

test('missing opencode binary → BOOT_FAILED with install guidance', async (t) => {
  const { ctx } = serverCtx(t);
  await assert.rejects(ensureServer({ ...ctx, opencodeBin: 'opencode-missing-binary-xyz' }), (e) => e.code === 'BOOT_FAILED' && /npm install -g opencode-ai/.test(e.message));
});

test('share-auto: world check marks sessions as blocked and assertCanCreateSessions refuses', async (t) => {
  const { ctx, stateDir } = serverCtx(t, { scenario: 'share-auto' });
  const server = await ensureServer(ctx);
  assert.equal(server.world.shareBlocked, true);
  assert.ok(server.warnings.some((w) => /share "auto"/.test(w)));
  assert.throws(() => assertCanCreateSessions(server), (e) => e.code === 'SHARE_AUTO' && e.exitCode === 4);
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).world.shareBlocked, true);
  const reused = await ensureServer(ctx);
  assert.equal(reused.world.shareBlocked, true, 'block survives reuse');
});

test('world check: default override share:"disabled" keeps sessions allowed; denied model/small_model warn', async (t) => {
  const { ctx } = serverCtx(t, { config: { policy: { providers: { deny: ['fake-provider'] } } } });
  const server = await ensureServer(ctx);
  assert.equal(server.world.shareBlocked, false);
  assert.deepEqual(server.world.deniedDefaults, ['model', 'small_model']);
  assert.ok(server.warnings.some((w) => /"model"/.test(w) && /configOverride\.model/.test(w)));
});

test('attach mode: loopback http accepted, non-loopback http and credentials in URL refused, wrong password → AUTH_FAILED', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-attach-'));
  const password = 'attach-password-0123456789';
  const fake = await startFake({ port: 0, password, stateFile: path.join(dir, 'fake.json') });
  t.after(() => fake.close());
  const { env, ctx, stateDir } = serverCtx(t);
  const attached = await ensureServer({ ...ctx, env: { ...env, OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: password } });
  assert.deepEqual({ attached: attached.attached, pid: attached.pid, url: attached.url }, { attached: true, pid: null, url: fake.url });
  assert.ok(attached.warnings.some((w) => /Modo attach/.test(w)));
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
  assert.equal(readFakeState(env).bootAttempts, 0);
  for (const url of ['http://example.com:4096', 'ftp://127.0.0.1:1', 'https://user:pw@example.com', 'not a url']) {
    await assert.rejects(ensureServer({ ...ctx, env: { ...env, OPC_SERVER_URL: url } }), (e) => e.code === 'INSECURE_SERVER_URL' && e.exitCode === 2, url);
  }
  await assert.rejects(ensureServer({ ...ctx, env: { ...env, OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: 'wrong-password-000000' } }), (e) => e.code === 'AUTH_FAILED');
});
````

Crie `tests/fixtures/scenarios/port-mismatch.mjs`:

````js
// First boot listens on a random port and announces it, so the port differs from the requested one.
export default {
  boot({ attempt }) {
    if (attempt === 1) return { listenPort: 0 };
    return undefined;
  },
};
````

`tests/fixtures/scenarios/boot-slow.mjs`:

````js
// Every boot waits FAKE_BOOT_DELAY_MS (default 3000) before listening.
export default {
  boot({ env }) {
    return { delayMs: Number(env.FAKE_BOOT_DELAY_MS ?? 3000) };
  },
};
````

`tests/fixtures/scenarios/hung-server.mjs`:

````js
// /global/health never answers in the process whose pid is written in `<stateFile>.hang`.
import fs from 'node:fs';

export default {
  routes: {
    'GET /global/health': (fake) => {
      let target = null;
      try {
        target = fs.readFileSync(`${fake.stateFile}.hang`, 'utf8').trim();
      } catch {
        return undefined;
      }
      if (target === String(process.pid)) return new Promise(() => {});
      return undefined;
    },
  },
};
````

`tests/fixtures/scenarios/version-changed.mjs`:

````js
// /global/health reports the version written in `<stateFile>.version` (simulates an OpenCode upgrade).
import fs from 'node:fs';

export default {
  routes: {
    'GET /global/health': (fake) => {
      try {
        const version = fs.readFileSync(`${fake.stateFile}.version`, 'utf8').trim();
        return { body: { healthy: true, version } };
      } catch {
        return undefined;
      }
    },
  },
};
````

`tests/fixtures/scenarios/ignores-sigterm.mjs`:

````js
// The server records SIGTERM and keeps running (only SIGKILL on the group stops it).
export default {
  ignoreSigterm: true,
};
````

`tests/fixtures/scenarios/share-auto.mjs`:

````js
// GET /config reports share:"auto" even with OPENCODE_CONFIG_CONTENT (override not effective).
export default {
  routes: {
    'GET /config': (fake) => ({ body: { ...fake.baseConfig, ...fake.configOverride, share: 'auto' } }),
  },
};
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/server.test.mjs tests/integration/server-lifecycle.test.mjs tests/integration/server-boot.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/lib/server.mjs`).

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/server.mjs`:

````js
// Lifecycle of the per-workspace `opencode serve`: reuse, spawn, health, version, world checks, stop (spec §5).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { DEFAULT_CONFIG, matchesGlob } from './config.mjs';
import { createClient } from './http.mjs';
import { withLock } from './locks.mjs';
import { ConnectionError, PolicyError, UsageError } from './opc-error.mjs';
import { getProcessIdentity, isPidAlive, spawnDetached, terminateProcessGroup } from './process.mjs';
import { registerSecret, redactText } from './redact.mjs';
import { readJson, writeFileAtomic } from './state.mjs';

export const MIN_OPENCODE_VERSION = '1.18.0';
const MAX_BOOT_ATTEMPTS = 3;
const HEALTH_REUSE_TIMEOUT_MS = 2000;
const DISPOSE_TIMEOUT_MS = 3000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const LISTENING_RE = /opencode server listening on (https?:\/\/[^\s]+)/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function serverMatcher(port) {
  const wanted = String(port);
  return (cmdline) => {
    if (!Array.isArray(cmdline) || cmdline.length === 0) return false;
    const isOpencode = cmdline.slice(0, 3).some((arg) => /^opencode(\.exe)?$/.test(path.basename(arg)));
    if (!isOpencode || !cmdline.includes('serve')) return false;
    return cmdline.some((arg, i) => (arg === '--port' && cmdline[i + 1] === wanted) || arg === `--port=${wanted}`);
  };
}

function serverFile(stateDir) {
  return path.join(stateDir, 'server.json');
}

export function readServerRecord(stateDir) {
  const record = readJson(serverFile(stateDir), null);
  if (!record || record.schemaVersion !== 1 || !Number.isInteger(record.pid) || !Number.isInteger(record.port)) return null;
  if (record.password) registerSecret(record.password);
  return record;
}

function removeServerRecord(stateDir) {
  try {
    fs.unlinkSync(serverFile(stateDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function serverSettings(config) {
  return { ...DEFAULT_CONFIG.server, ...(config?.server ?? {}) };
}

function recordIdentityOk(record) {
  const identity = getProcessIdentity(record.pid);
  if (!identity) return false;
  return String(identity.startTime) === String(record.startTime) && serverMatcher(record.port)(identity.cmdline);
}

async function probeHealth(url, password, timeoutMs) {
  const client = createClient({ baseUrl: url, password, requestTimeoutMs: timeoutMs });
  try {
    const body = await client.get('/global/health', { retryOnServerDown: false });
    return { ok: body?.healthy === true, version: body?.version ?? null };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function shutdownRecorded(stateDir, record) {
  const client = createClient({ baseUrl: record.url, password: record.password, requestTimeoutMs: DISPOSE_TIMEOUT_MS });
  try {
    await client.post('/global/dispose', undefined, { retryOnServerDown: false });
  } catch {
    // dispose is best effort; the signals below decide
  }
  const result = await terminateProcessGroup({ pid: record.pid, startTime: record.startTime }, serverMatcher(record.port), {
    graceMs: 3000,
  });
  removeServerRecord(stateDir);
  return result;
}

function truncateLogIfLarge(logFile) {
  try {
    if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.truncateSync(logFile, 0);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readFrom(file, offset) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return '';
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function waitForListening({ logFile, offset, port, url, password, pid, timeoutMs }) {
  const deadline = performance.now() + timeoutMs;
  let iteration = 0;
  while (performance.now() < deadline) {
    const text = readFrom(logFile, offset);
    const m = LISTENING_RE.exec(text);
    if (m) {
      const announced = Number(new URL(m[1]).port);
      if (announced === port) return { ok: true };
      return { ok: false, reason: 'port-mismatch', detail: `anunciou a porta ${announced}, pedida ${port}` };
    }
    if (!isPidAlive(pid)) {
      const tail = redactText(text.trim().split('\n').slice(-3).join(' | '));
      return { ok: false, reason: 'exited', detail: tail || 'processo terminou sem saída' };
    }
    if (iteration % 5 === 4) {
      const health = await probeHealth(url, password, 500);
      if (health.ok || health.error?.code === 'AUTH_FAILED') return { ok: true };
    }
    iteration += 1;
    await sleep(100);
  }
  return { ok: false, reason: 'timeout', detail: `sem a linha "listening on" em ${Math.round(timeoutMs / 1000)} s` };
}

function isDeniedModel(full, policy) {
  if (!full || typeof full !== 'string') return false;
  const provider = full.split('/')[0];
  const p = policy ?? DEFAULT_CONFIG.policy;
  const listDenied = (value, lists) => {
    if ((lists?.deny ?? []).some((g) => matchesGlob(value, g))) return true;
    const allow = lists?.allow ?? [];
    return allow.length > 0 && !allow.some((g) => matchesGlob(value, g));
  };
  return listDenied(provider, p.providers) || listDenied(full, p.models);
}

async function worldCheck(client, config) {
  const world = { shareBlocked: false, deniedDefaults: [] };
  const warnings = [];
  let oc;
  try {
    oc = await client.get('/config', { retryOnServerDown: false });
  } catch (err) {
    warnings.push(`Não foi possível ler GET /config para as checagens de mundo: ${err.code ?? err.message}`);
    return { world, warnings };
  }
  if (oc?.share === 'auto' || (oc?.autoshare === true && oc?.share !== 'disabled')) {
    world.shareBlocked = true;
    warnings.push('O OpenCode está com share "auto": o opc recusa criar sessões até o share ser desligado '
      + '(server.configOverride.share = "disabled" na config global do opc, ou share "manual"/"disabled" no OpenCode).');
  }
  for (const key of ['model', 'small_model']) {
    if (isDeniedModel(oc?.[key], config?.policy)) {
      world.deniedDefaults.push(key);
      warnings.push(`O "${key}" do OpenCode (${oc[key]}) é negado pela política do opc; `
        + `considere trocar via server.configOverride.${key}.`);
    }
  }
  return { world, warnings };
}

export function assertCanCreateSessions(server) {
  if (server?.world?.shareBlocked) {
    throw new PolicyError('SHARE_AUTO', 'Criação de sessões recusada: o OpenCode está com share "auto". Rode /opc:setup para ver como desligar.');
  }
}

async function attachServer(env, settings, config) {
  let parsed;
  try {
    parsed = new URL(env.OPC_SERVER_URL);
  } catch {
    throw new UsageError('INSECURE_SERVER_URL', 'OPC_SERVER_URL inválida.');
  }
  if (parsed.username || parsed.password) {
    throw new UsageError('INSECURE_SERVER_URL', 'OPC_SERVER_URL não pode conter credenciais; use OPC_SERVER_PASSWORD.');
  }
  const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!secure) {
    throw new UsageError('INSECURE_SERVER_URL', 'OPC_SERVER_URL precisa ser http://127.0.0.1, http://localhost ou https://.');
  }
  const url = parsed.origin;
  const password = env.OPC_SERVER_PASSWORD || null;
  registerSecret(password);
  const client = createClient({ baseUrl: url, password, requestTimeoutMs: settings.requestTimeoutSec * 1000 });
  const health = await client.get('/global/health', { retryOnServerDown: false });
  if (compareVersions(health?.version, MIN_OPENCODE_VERSION) < 0) {
    throw new ConnectionError('UNSUPPORTED_VERSION', `OpenCode ${health?.version} é anterior ao mínimo ${MIN_OPENCODE_VERSION}.`);
  }
  const { world, warnings } = await worldCheck(client, config);
  warnings.unshift('Modo attach: o opc não sobe nem encerra este servidor, e o server.configOverride não se aplica.');
  return { url, password, version: health.version, pid: null, port: Number(parsed.port) || null, attached: true, reused: true, world, warnings };
}

async function spawnOnce({ stateDir, workspaceRoot, env, opencodeBin, settings, password }) {
  const port = await pickFreePort();
  const logFile = path.join(stateDir, 'server.log');
  truncateLogIfLarge(logFile);
  const offset = fileSize(logFile);
  const childEnv = {
    ...env,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(settings.configOverride ?? {}),
    OPC_INSIDE_SERVER: '1',
  };
  delete childEnv.OPC_SERVER_URL;
  delete childEnv.OPC_SERVER_PASSWORD;
  let proc;
  try {
    proc = spawnDetached(opencodeBin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: workspaceRoot,
      env: childEnv,
      logFile,
    });
  } catch (err) {
    throw new ConnectionError('BOOT_FAILED', `Não foi possível executar "${opencodeBin}": instale o OpenCode (npm install -g opencode-ai).`, {
      cause: err,
    });
  }
  const startTime = proc.startTime ?? getProcessIdentity(proc.pid)?.startTime ?? null;
  const url = `http://127.0.0.1:${port}`;
  const outcome = await waitForListening({
    logFile, offset, port, url, password, pid: proc.pid, timeoutMs: settings.bootTimeoutSec * 1000,
  });
  return { ...outcome, port, url, pid: proc.pid, startTime };
}

async function bootServer(ctx, settings) {
  const { stateDir, workspaceRoot, env, opencodeBin, config } = ctx;
  const password = randomBytes(24).toString('hex');
  registerSecret(password);
  const failures = [];
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt += 1) {
    const res = await spawnOnce({ stateDir, workspaceRoot, env, opencodeBin, settings, password });
    const expected = { pid: res.pid, startTime: res.startTime };
    const matcher = serverMatcher(res.port);
    if (!res.ok) {
      failures.push(`tentativa ${attempt} (porta ${res.port}): ${res.reason} — ${res.detail}`);
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      continue;
    }
    const client = createClient({ baseUrl: res.url, password, directory: workspaceRoot, requestTimeoutMs: settings.requestTimeoutSec * 1000 });
    let health;
    try {
      health = await client.get('/global/health', { retryOnServerDown: false });
    } catch (err) {
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      if (err.code === 'AUTH_FAILED') throw err;
      failures.push(`tentativa ${attempt} (porta ${res.port}): health falhou — ${err.code}`);
      continue;
    }
    if (compareVersions(health?.version, MIN_OPENCODE_VERSION) < 0) {
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      throw new ConnectionError('UNSUPPORTED_VERSION', `OpenCode ${health?.version} é anterior ao mínimo suportado ${MIN_OPENCODE_VERSION}. Atualize com npm install -g opencode-ai.`);
    }
    const identity = getProcessIdentity(res.pid);
    if (!identity || !matcher(identity.cmdline)) {
      throw new ConnectionError('BOOT_FAILED', `O processo ${res.pid} não se identifica como "opencode serve --port ${res.port}"; o opc não vai registrá-lo nem sinalizá-lo.`);
    }
    const warnings = [];
    try {
      await client.get('/agent', { timeoutMs: settings.bootTimeoutSec * 1000, retryOnServerDown: false });
    } catch (err) {
      warnings.push(`Aquecimento (GET /agent) falhou: ${err.code ?? err.message}`);
    }
    const checked = await worldCheck(client, config);
    warnings.push(...checked.warnings);
    const record = {
      schemaVersion: 1,
      pid: res.pid,
      startTime: identity.startTime,
      port: res.port,
      url: res.url,
      version: health.version,
      password,
      startedAt: new Date().toISOString(),
      spawnedBy: 'opc',
      cmdline: identity.cmdline,
      world: checked.world,
    };
    writeFileAtomic(serverFile(stateDir), record, { mode: 0o600 });
    return { url: res.url, password, version: health.version, pid: res.pid, port: res.port, attached: false, reused: false, world: checked.world, warnings };
  }
  throw new ConnectionError('BOOT_FAILED', `opencode serve não subiu após ${MAX_BOOT_ATTEMPTS} tentativas: ${failures.join('; ')}`, {
    details: { failures },
  });
}

export async function ensureServer(ctx) {
  const { stateDir, config, env = process.env, hasActiveJobs = () => false } = ctx;
  const full = { opencodeBin: 'opencode', ...ctx, env, hasActiveJobs };
  const settings = serverSettings(config);
  const lockTimeout = 4 * settings.bootTimeoutSec * 1000;
  return withLock(path.join(stateDir, 'server.lock'), { timeoutMs: lockTimeout, purpose: 'ensure-server' }, async () => {
    if (env.OPC_SERVER_URL) return attachServer(env, settings, config);
    const record = readServerRecord(stateDir);
    const warnings = [];
    if (record) {
      if (!recordIdentityOk(record)) {
        removeServerRecord(stateDir);
        warnings.push(`Registro de servidor antigo descartado (pid ${record.pid} não é mais o servidor do opc); nenhum sinal enviado.`);
      } else {
        const health = await probeHealth(record.url, record.password, HEALTH_REUSE_TIMEOUT_MS);
        if (health.error?.code === 'AUTH_FAILED') throw health.error;
        if (health.ok && health.version === record.version) {
          return {
            url: record.url, password: record.password, version: record.version, pid: record.pid, port: record.port,
            attached: false, reused: true, world: record.world ?? { shareBlocked: false, deniedDefaults: [] }, warnings,
          };
        }
        if (health.ok && hasActiveJobs()) {
          warnings.push(`O OpenCode mudou de versão (${record.version} → ${health.version}), mas há jobs ativos: servidor reaproveitado.`);
          return {
            url: record.url, password: record.password, version: record.version, pid: record.pid, port: record.port,
            attached: false, reused: true, world: record.world ?? { shareBlocked: false, deniedDefaults: [] }, warnings,
          };
        }
        const why = health.ok ? `versão mudou (${record.version} → ${health.version})` : 'servidor travado (health sem resposta)';
        await shutdownRecorded(stateDir, record);
        warnings.push(`Servidor anterior encerrado: ${why}.`);
      }
    }
    const booted = await bootServer(full, settings);
    return { ...booted, warnings: [...warnings, ...booted.warnings] };
  });
}

export async function stopServer(ctx, { force = false, confirmedByUser = false } = {}) {
  if (force && !confirmedByUser) {
    throw new UsageError('CONFIRMATION_REQUIRED', '--force exige --confirmed-by-user (confirmação explícita do usuário).');
  }
  const { stateDir, config, env = process.env, hasActiveJobs = () => false } = ctx;
  const settings = serverSettings(config);
  return withLock(path.join(stateDir, 'server.lock'), { timeoutMs: 4 * settings.bootTimeoutSec * 1000, purpose: 'stop-server' }, async () => {
    if (env.OPC_SERVER_URL) return { stopped: false, reason: 'attached' };
    const record = readServerRecord(stateDir);
    if (!record) return { stopped: false, reason: 'not-running' };
    if (hasActiveJobs() && !force) return { stopped: false, reason: 'active-jobs' };
    const identity = getProcessIdentity(record.pid);
    if (!identity) {
      removeServerRecord(stateDir);
      return { stopped: false, reason: 'not-running' };
    }
    if (!recordIdentityOk(record)) {
      removeServerRecord(stateDir);
      return { stopped: false, reason: 'identity-mismatch' };
    }
    const result = await shutdownRecorded(stateDir, record);
    if (result === 'identity-mismatch') return { stopped: false, reason: 'identity-mismatch' };
    return { stopped: true, reason: result === 'killed' ? 'killed' : 'terminated' };
  });
}

export function clientFor(ctx, server) {
  const settings = serverSettings(ctx.config);
  return createClient({
    baseUrl: server.url,
    password: server.password,
    directory: ctx.workspaceRoot,
    requestTimeoutMs: settings.requestTimeoutSec * 1000,
    onServerDown: () => ensureServer(ctx).then((s) => ({ url: s.url, password: s.password })),
  });
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/server.test.mjs tests/integration/server-lifecycle.test.mjs tests/integration/server-boot.test.mjs`
Expected: PASS — `# tests 26`, `# pass 26` (cerca de 15 s: os cenários de SIGKILL e boot lento esperam os prazos reais).

Confira que não sobrou servidor falso: `ps -ef | grep "[f]ixtures/bin/opencode serve"` → nenhuma linha.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/server.mjs tests/unit/server.test.mjs tests/integration/server-lifecycle.test.mjs tests/integration/server-boot.test.mjs tests/fixtures/scenarios/port-mismatch.mjs tests/fixtures/scenarios/boot-slow.mjs tests/fixtures/scenarios/hung-server.mjs tests/fixtures/scenarios/version-changed.mjs tests/fixtures/scenarios/ignores-sigterm.mjs tests/fixtures/scenarios/share-auto.mjs
git commit -m "feat: manage the per-workspace opencode server lifecycle"
```

---

### Task 13: Contexto da CLI e renderização (`context`, `render`)

**Files:**
- Create: `plugins/opc/scripts/lib/context.mjs`, `plugins/opc/scripts/lib/render.mjs`
- Test: `tests/unit/context.test.mjs`, `tests/unit/render.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` (Task 8); `defaultDataDir`, `ensurePrivateDir`, `resolveDataDir`, `resolveWorkspaceRoot`, `workspaceStateDir` (Task 7); `redact`, `redactText`, `registerSecret` (Task 3); `OpcError` (Task 3).
- Produces (contrato do mestre): `createContext({ argv, env, cwd, stdin, stdout, stderr })` → `{ env, cwd, stdin, stdout, stderr, dataDir, workspaceRoot, stateDir, config, configWarnings, claudeSessionId, out(text), err(text), json(obj) }` (tudo redigido); `renderTable(headers, rows)`, `renderError(err)` (`'# opc error\n<code>: <mensagem>\n'`, sem stack, redigido; erro não-`OpcError` → `INTERNAL`), `renderSetup(report)`.
- Produces (**novas**): opção `createDataDir = false` (só o `setup` passa `true`: cria o `defaultDataDir` quando nada resolve); `ctx.argv`; `ctx.log(line)` (stderr com prefixo `[opc] `); `ctx.configMeta = { hasGlobal, workspaceFound }`. `renderSetup` também renderiza o relatório de `--stop-server` (`report.mode === 'stop'`).
- Forma do relatório do setup (usada pela Task 14 e pelo onboarding da F1): `{ mode: 'diagnose', ready, node: {ok, version}, opencode: {installed, version, supported, detail}, dataDir, workspaceRoot, stateDir, config: {hasGlobal, globalPath, workspaceFound, workspacePath, warnings}, server: {status: 'running'|'attached'|'error'|'skipped', url, port, pid, version, reused, attached, sessionsBlocked, warnings, error?: {code, message}}, terminalAlias, nextSteps: string[] }` e `{ mode: 'stop', stop: {stopped, reason}, activeJobs: [{id, kind, status, title}] }`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/unit/context.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { makeTempDir, makeWorkspace, removeTempDir } from '../helpers.mjs';

function sink() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  stream.text = () => chunks.join('');
  return stream;
}

test('createContext resolves dirs (700), config and redacted output helpers', async (t) => {
  const data = makeTempDir('opc-ctx-');
  t.after(() => removeTempDir(data));
  const ws = makeWorkspace(t, { name: 'ctx ws' });
  const stdout = sink();
  const stderr = sink();
  const ctx = await createContext({ argv: ['--json'], env: { OPC_DATA_DIR: data, OPC_COMPANION_SESSION_ID: 'sess-1', HOME: data }, cwd: ws, stdout, stderr });
  assert.equal(ctx.dataDir, data);
  assert.equal(ctx.workspaceRoot, ws);
  assert.ok(ctx.stateDir.startsWith(path.join(data, 'state', 'ctx-ws-')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(ctx.stateDir).mode & 0o777, 0o700);
  assert.equal(ctx.claudeSessionId, 'sess-1');
  assert.equal(ctx.config.policy.approver, 'user');
  assert.deepEqual(ctx.configWarnings, []);
  assert.deepEqual(ctx.configMeta, { hasGlobal: false, workspaceFound: false });
  const secret = 'ctx-secret-0123456789abc';
  registerSecret(secret);
  ctx.out(`a ${secret}\n`);
  ctx.json({ password: 'x', note: secret });
  ctx.log('progress');
  ctx.err(`e ${secret}\n`);
  assert.equal(stdout.text(), 'a ***\n{\n  "password": "***",\n  "note": "***"\n}\n');
  assert.equal(stderr.text(), '[opc] progress\ne ***\n');
});

test('createContext fails with DATA_DIR_UNRESOLVED unless createDataDir is set', async (t) => {
  const home = makeTempDir('opc-ctx-');
  t.after(() => removeTempDir(home));
  const ws = makeWorkspace(t);
  await assert.rejects(createContext({ env: { HOME: home }, cwd: ws }), (e) => e.code === 'DATA_DIR_UNRESOLVED');
  const ctx = await createContext({ env: { HOME: home }, cwd: ws, createDataDir: true });
  assert.equal(ctx.dataDir, path.join(home, '.claude', 'plugins', 'data', 'opc-opencode-plugin-cc'));
  assert.ok(fs.existsSync(ctx.stateDir));
});
````

Crie `tests/unit/render.test.mjs`:

````js
import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { renderError, renderSetup, renderTable } from '../../plugins/opc/scripts/lib/render.mjs';

const SECRET = 'render-secret-abcdef123456';
registerSecret(SECRET);

test('renderTable escapes pipes and newlines', () => {
  assert.equal(renderTable(['a', 'b'], [['x|y', 'line1\nline2']]), '| a | b |\n| --- | --- |\n| x\\|y | line1 line2 |\n');
});

test('renderError prints code and message, redacted, without stack', () => {
  const out = renderError(new ConnectionError('AUTH_FAILED', `bad ${SECRET}`));
  assert.equal(out, '# opc error\nAUTH_FAILED: bad ***\n');
  assert.equal(renderError(new Error('plain')), '# opc error\nINTERNAL: plain\n');
});

const baseReport = {
  mode: 'diagnose',
  ready: true,
  node: { ok: true, version: '22.1.0' },
  opencode: { installed: true, version: '1.18.32', supported: true },
  dataDir: '/data',
  workspaceRoot: '/ws',
  stateDir: '/data/state/ws-0123456789abcdef',
  config: { hasGlobal: false, globalPath: '/data/config.json', workspaceFound: false, workspacePath: '/ws/.opc.json', warnings: [] },
  server: { status: 'running', url: 'http://127.0.0.1:43210', pid: 99, version: '1.18.32', reused: false, sessionsBlocked: null, warnings: [] },
  terminalAlias: `alias opc='OPC_DATA_DIR="/data" node "/p/scripts/opc-companion.mjs"'`,
  nextSteps: ['Faça algo'],
};

test('renderSetup shows checks, server, alias and next steps', () => {
  const out = renderSetup(baseReport);
  assert.match(out, /^# opc setup\n/);
  assert.match(out, /Status: pronto/);
  assert.match(out, /- opencode: ok \(1\.18\.32\)/);
  assert.match(out, /- url: http:\/\/127\.0\.0\.1:43210/);
  assert.match(out, /reaproveitado: não/);
  assert.ok(out.includes(baseReport.terminalAlias));
  assert.match(out, /## Próximos passos\n\n- Faça algo/);
});

test('renderSetup shows errors, blocked sessions and config warnings, redacting secrets', () => {
  const out = renderSetup({
    ...baseReport,
    ready: false,
    config: { ...baseReport.config, warnings: [{ path: 'policy.approver', message: 'chave travada' }] },
    server: { status: 'error', error: { code: 'BOOT_FAILED', message: `falhou ${SECRET}` }, warnings: ['aviso x'] },
  });
  assert.match(out, /requer atenção/);
  assert.match(out, /BOOT_FAILED: falhou \*\*\*/);
  assert.match(out, /- policy\.approver: chave travada/);
  assert.match(out, /- aviso: aviso x/);
  const blocked = renderSetup({ ...baseReport, server: { ...baseReport.server, sessionsBlocked: 'share-auto' } });
  assert.match(blocked, /BLOQUEADAS \(share-auto\)/);
});

test('renderSetup renders the stop result and the active jobs table', () => {
  const out = renderSetup({ mode: 'stop', stop: { stopped: false, reason: 'active-jobs' }, activeJobs: [{ id: 'task-1', kind: 'task', status: 'running', title: 'x|y' }] });
  assert.match(out, /recusado: há jobs ativos/);
  assert.match(out, /\| task-1 \| task \| running \| x\\\|y \|/);
  assert.match(renderSetup({ mode: 'stop', stop: { stopped: true, reason: 'killed' } }), /SIGKILL/);
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/context.test.mjs tests/unit/render.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implementar**

Crie `plugins/opc/scripts/lib/context.mjs`:

````js
// CLI execution context: resolved directories, effective config and redacted output helpers.
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { redact, redactText } from './redact.mjs';
import { defaultDataDir, ensurePrivateDir, resolveDataDir, resolveWorkspaceRoot, workspaceStateDir } from './state.mjs';

export async function createContext({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  createDataDir = false,
} = {}) {
  const home = env.HOME || os.homedir();
  let dataDir;
  try {
    dataDir = resolveDataDir(env, { home });
  } catch (err) {
    if (!(createDataDir && err.code === 'DATA_DIR_UNRESOLVED')) throw err;
    dataDir = defaultDataDir({ home });
  }
  ensurePrivateDir(dataDir);
  const workspaceRoot = resolveWorkspaceRoot(path.resolve(cwd));
  ensurePrivateDir(path.join(dataDir, 'state'));
  const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, workspaceRoot));
  const loaded = loadConfig({ dataDir, workspaceRoot });
  return {
    argv,
    env,
    cwd,
    stdin,
    stdout,
    stderr,
    dataDir,
    workspaceRoot,
    stateDir,
    config: loaded.config,
    configWarnings: loaded.warnings,
    configMeta: { hasGlobal: loaded.hasGlobal, workspaceFound: loaded.workspace !== null },
    claudeSessionId: env.OPC_COMPANION_SESSION_ID ?? null,
    out(text) {
      stdout.write(redactText(String(text)));
    },
    err(text) {
      stderr.write(redactText(String(text)));
    },
    log(line) {
      stderr.write(redactText(`[opc] ${line}\n`));
    },
    json(obj) {
      stdout.write(`${JSON.stringify(redact(obj), null, 2)}\n`);
    },
  };
}
````

Crie `plugins/opc/scripts/lib/render.mjs`:

````js
// Markdown rendering (no network I/O). Every output passes through redaction.
import { OpcError } from './opc-error.mjs';
import { redactText } from './redact.mjs';

function cell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function renderTable(headers, rows) {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
  return `${[head, sep, ...body].join('\n')}\n`;
}

export function renderError(err) {
  const code = err instanceof OpcError ? err.code : 'INTERNAL';
  const message = err?.message ?? String(err);
  return redactText(`# opc error\n${code}: ${message}\n`);
}

function check(ok) {
  if (ok === true) return 'ok';
  if (ok === false) return 'FALHA';
  return '—';
}

function renderServer(server) {
  if (!server) return [];
  const lines = ['## Servidor', ''];
  if (server.status === 'running' || server.status === 'attached') {
    lines.push(`- estado: ${server.status === 'attached' ? 'modo attach (servidor externo)' : 'rodando'}`);
    lines.push(`- url: ${server.url}`);
    if (server.pid) lines.push(`- pid: ${server.pid}`);
    lines.push(`- versão: ${server.version}`);
    lines.push(`- reaproveitado: ${server.reused ? 'sim' : 'não (subiu agora)'}`);
    lines.push(`- sessões: ${server.sessionsBlocked ? `BLOQUEADAS (${server.sessionsBlocked})` : 'liberadas'}`);
  } else if (server.status === 'error') {
    lines.push(`- estado: erro — ${server.error?.code}: ${server.error?.message}`);
  } else {
    lines.push(`- estado: ${server.status}`);
  }
  for (const w of server.warnings ?? []) lines.push(`- aviso: ${w}`);
  lines.push('');
  return lines;
}

function renderStop(report) {
  const { stop } = report;
  const reasons = {
    'not-running': 'nenhum servidor do opc rodando neste workspace',
    attached: 'modo attach: o opc não encerra servidores externos',
    'active-jobs': 'recusado: há jobs ativos',
    terminated: 'servidor encerrado',
    killed: 'servidor encerrado à força (SIGKILL)',
    'identity-mismatch': 'o processo registrado não é mais o servidor do opc; registro removido, nenhum sinal enviado',
  };
  const lines = ['# opc setup — encerrar servidor', '', `Resultado: ${reasons[stop.reason] ?? stop.reason}`, ''];
  if (stop.reason === 'active-jobs' && report.activeJobs?.length) {
    lines.push('Jobs ativos:', '');
    lines.push(renderTable(['job', 'tipo', 'status', 'título'], report.activeJobs.map((j) => [j.id, j.kind, j.status, j.title ?? ''])));
    lines.push('Espere os jobs terminarem, cancele-os, ou use `--stop-server --force` com confirmação do usuário.');
  }
  return lines;
}

export function renderSetup(report) {
  if (report.mode === 'stop') return redactText(`${renderStop(report).join('\n').trimEnd()}\n`);
  const lines = [
    '# opc setup',
    '',
    `Status: ${report.ready ? 'pronto' : 'requer atenção'}`,
    '',
    '## Verificações',
    '',
    `- node: ${check(report.node?.ok)} (${report.node?.version})`,
    `- opencode: ${report.opencode?.installed ? `${check(report.opencode.supported)} (${report.opencode.version ?? 'versão desconhecida'})` : 'não encontrado'}`,
    `- diretório de dados: ${report.dataDir}`,
    `- workspace: ${report.workspaceRoot}`,
    `- estado: ${report.stateDir}`,
    `- config global: ${report.config?.hasGlobal ? report.config.globalPath : 'ainda não existe (onboarding na F1)'}`,
    `- .opc.json: ${report.config?.workspaceFound ? report.config.workspacePath : 'não encontrado'}`,
    '',
  ];
  if (report.config?.warnings?.length) {
    lines.push('## Avisos de configuração', '');
    for (const w of report.config.warnings) lines.push(`- ${w.path}: ${w.message}`);
    lines.push('');
  }
  lines.push(...renderServer(report.server));
  lines.push('## Terminal', '', 'Para usar o mesmo estado fora do Claude, adicione ao seu shell:', '', '```sh', report.terminalAlias, '```', '');
  if (report.nextSteps?.length) {
    lines.push('## Próximos passos', '');
    for (const s of report.nextSteps) lines.push(`- ${s}`);
    lines.push('');
  }
  return redactText(`${lines.join('\n').trimEnd()}\n`);
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/context.test.mjs tests/unit/render.test.mjs`
Expected: PASS — `# tests 7`, `# pass 7`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/context.mjs plugins/opc/scripts/lib/render.mjs tests/unit/context.test.mjs tests/unit/render.test.mjs
git commit -m "feat: add cli context and markdown rendering"
```

---

### Task 14: CLI `opc`, `/opc:setup` e manifestos do plugin

O dispatcher só faz a checagem de Node antes dos `import()` dinâmicos (imports estáticos seriam avaliados antes da checagem). Subcomandos são descobertos dinamicamente — cada fase só acrescenta arquivos em `commands/` —, mas sem `import()` de caminho arbitrário: só um nome que casa com `/^[a-z][a-z0-9-]*$/` **e** tem `commands/<nome>.mjs` existente é importado (Decisão 20). Erros: `renderError` em stderr e, com `--json`, `{"error":{code,message,details}}` em stdout; exit por `toExitCode`. A saída espera o flush de stdout/stderr antes de `process.exit` (pipes são assíncronos no macOS).

**Files:**
- Create: `plugins/opc/scripts/opc-companion.mjs`, `plugins/opc/scripts/commands/setup.mjs`, `plugins/opc/bin/opc` (executável), `plugins/opc/commands/setup.md`, `plugins/opc/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Test: `tests/unit/companion.test.mjs`, `tests/integration/cli.test.mjs`, `tests/integration/setup.test.mjs`, `tests/integration/setup-server.test.mjs`, `tests/integration/secrets.test.mjs`

**Interfaces:**
- Consumes: tudo das Tasks 3–13 (`resolveArgv`, `extractCwd`, `parseArgs`, `createContext`, `renderError`, `renderSetup`, `redact`, `toExitCode`, `ExitCode`, `UsageError`, `ensureServer`, `stopServer`, `compareVersions`, `MIN_OPENCODE_VERSION`, `listActiveJobs`, `globalConfigPath`, `workspaceConfigPath`).
- Produces:
  - `opc-companion.mjs` (contrato do mestre): Node ≥ 20 senão exit 2; `resolveArgv` → `extractCwd` → `loadCommand(sub)` → `createContext` (com `createDataDir` só no `setup`) → `mod.run(ctx, rest)`; desconhecido/inválido → exit 2. Exports (**novos**): `MIN_NODE_MAJOR = 20`, `nodeVersionOk(version)`, `listSubcommands() → string[]` (nomes de `commands/*.mjs` sem extensão, ordenados), `loadCommand(sub) → Promise<module>` (nome `/^[a-z][a-z0-9-]*$/` e `commands/<sub>.mjs` existente → `import()` do módulo, que deve exportar `run`; senão `UsageError('USAGE', …)` exit 2 com a lista de `listSubcommands()`), `main(rawArgv, { stdin, stdout, stderr, env, cwd = process.cwd(), onError = null }) → Promise<number>` (`cwd` vale quando não há `--cwd`; `onError(err)` é chamado antes do `renderError`). Nenhuma fase posterior edita o dispatcher para registrar subcomando: basta criar `commands/<sub>.mjs`.
  - `commands/setup.mjs`: `run(ctx, argv) → exit code`; flags `--json`, `--stop-server`, `--force`, `--confirmed-by-user` (as duas últimas só com `--stop-server`); exports (**novos**) `terminalAlias(dataDir, pluginRoot) → string` e `detectOpencode(env, bin = 'opencode') → { installed, version, supported, detail }`.
  - Plugin: marketplace `opencode-plugin-cc` → plugin `opc` → id de dados `opc-opencode-plugin-cc` (A CONFIRMAR §15.8, validado no portão).

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/unit/companion.test.mjs`:

````js
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { MIN_NODE_MAJOR, listSubcommands, loadCommand, main, nodeVersionOk } from '../../plugins/opc/scripts/opc-companion.mjs';

function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  stream.text = () => chunks.join('');
  return stream;
}

test('Node guard requires major >= 20', () => {
  assert.equal(MIN_NODE_MAJOR, 20);
  assert.equal(nodeVersionOk('18.19.0'), false);
  assert.equal(nodeVersionOk('20.0.0'), true);
  assert.equal(nodeVersionOk('22.3.1'), true);
});

test('subcommands are discovered from commands/ (setup included, sorted)', () => {
  const subs = listSubcommands();
  assert.ok(subs.includes('setup'), subs.join(','));
  assert.deepEqual(subs, [...subs].sort());
});

test('loadCommand imports only valid names that map to commands/<name>.mjs', async () => {
  assert.equal(typeof (await loadCommand('setup')).run, 'function');
  for (const bad of ['../x', '../lib/state', '', 'Setup', 'nope']) {
    await assert.rejects(loadCommand(bad), (e) => e.code === 'USAGE' && e.exitCode === 2, bad);
  }
});

test('main: unknown or invalid subcommand exits 2, calls onError before rendering and lists the subcommands', async () => {
  for (const sub of ['nope', '../x']) {
    const stdout = sink();
    const stderr = sink();
    const seen = [];
    const code = await main([sub, '--json'], {
      stdin: Readable.from([]), stdout, stderr, env: {}, cwd: '/nonexistent',
      onError: (err) => seen.push({ code: err.code, stderrSoFar: stderr.text() }),
    });
    assert.equal(code, 2);
    assert.deepEqual(seen, [{ code: 'USAGE', stderrSoFar: '' }]);
    assert.match(stderr.text(), /Disponíveis: .*setup/);
    assert.equal(JSON.parse(stdout.text()).error.code, 'USAGE');
  }
});
````

Crie `tests/integration/cli.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PLUGIN_BIN_DIR, makeWorkspace, parseJsonOutput, runCli, runProcess, testEnv } from '../helpers.mjs';

test('no subcommand and unknown subcommands exit 2 with a rendered error', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const none = await runCli([], { env, cwd: ws });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /# opc error\nUSAGE: Uso: opc <subcomando>/);
  const unknown = await runCli(['nope', '--json'], { env, cwd: ws });
  assert.equal(unknown.code, 2);
  assert.equal(parseJsonOutput(unknown.stdout).error.code, 'USAGE');
  const traversal = await runCli(['../lib/state'], { env, cwd: ws });
  assert.equal(traversal.code, 2);
});

test('unknown flags exit 2', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const res = await runCli(['setup', '--bogus'], { env, cwd: ws });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /Flag desconhecida: --bogus/);
});

test('bin/opc runs the companion through sh', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  assert.ok(fs.statSync(path.join(PLUGIN_BIN_DIR, 'opc')).mode & 0o111, 'bin/opc must be executable');
  const res = await runProcess('sh', ['-c', 'opc setup --json'], { env: { ...env, PATH: `${PLUGIN_BIN_DIR}${path.delimiter}${env.PATH}` }, cwd: ws });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(parseJsonOutput(res.stdout).server.status, 'running');
});

test('heredoc --args-stdin never expands $() or backticks (slash command invocation)', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const script = [
    "opc setup --json --args-stdin <<'OPC_ARGS'",
    '$(touch pwned-dollar) `touch pwned-backtick` "$(touch pwned-quoted)"',
    'OPC_ARGS',
  ].join('\n');
  const res = await runProcess('bash', ['-c', script], { env: { ...env, PATH: `${PLUGIN_BIN_DIR}${path.delimiter}${env.PATH}` }, cwd: ws });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /Argumento inesperado: \$\(touch/);
  for (const f of ['pwned-dollar', 'pwned-backtick', 'pwned-quoted']) assert.equal(fs.existsSync(path.join(ws, f)), false, f);
});

test('--args-stdin feeds flags from stdin and --cwd selects the workspace', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t, { name: 'target ws' });
  const other = makeWorkspace(t, { name: 'other' });
  const res = await runCli(['setup', '--args-stdin'], { env, cwd: other, stdin: `--json --cwd "${ws}"\n` });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(parseJsonOutput(res.stdout).workspaceRoot, ws);
});
````

Crie `tests/integration/setup.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { startFake } from '../fixtures/fake-opencode.mjs';
import {
  FAKE_BIN_DIR, makeTempDir, makeWorkspace, parseJsonOutput, readFakeState, readJsonFile, runCli, testEnv, trackTempDir,
} from '../helpers.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX modes' };

async function setupJson(env, ws, extra = []) {
  const res = await runCli(['setup', '--json', ...extra], { env, cwd: ws });
  return { ...res, report: parseJsonOutput(res.stdout) };
}

test('diagnostic JSON: node, opencode, dirs, config and a running server on a port chosen by the plugin', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.equal(report.ready, true);
  assert.equal(report.node.ok, true);
  assert.deepEqual({ installed: report.opencode.installed, version: report.opencode.version, supported: report.opencode.supported }, { installed: true, version: '1.18.32', supported: true });
  assert.equal(report.dataDir, env.OPC_DATA_DIR);
  assert.equal(report.workspaceRoot, ws);
  assert.equal(report.server.status, 'running');
  assert.equal(report.server.reused, false);
  assert.notEqual(report.server.port, 4096);
  assert.equal(report.server.url, `http://127.0.0.1:${report.server.port}`);
  assert.equal(report.server.sessionsBlocked, null);
  assert.match(report.terminalAlias, /^alias opc='OPC_DATA_DIR=".*" node ".*opc-companion\.mjs"'$/);
  const fake = readFakeState(env);
  assert.equal(fake.boots[0].insideServer, '1');
  assert.equal(fake.boots[0].hasPassword, true);
  assert.equal(fake.boots[0].username, 'opencode');
  assert.equal(fake.boots[0].configContent, JSON.stringify({ share: 'disabled' }));
  assert.equal(fake.boots[0].hostname, '127.0.0.1');
  assert.ok(fake.requests.some((r) => r.path === '/agent' && r.query.directory === ws), 'warm-up GET /agent?directory');
  assert.ok(fake.requests.some((r) => r.path === '/config'), 'world check GET /config');
});

test('markdown output (no --json) contains the alias and no password', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const res = await runCli(['setup'], { env, cwd: ws });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^# opc setup/);
  assert.match(res.stdout, /alias opc=/);
  const { password } = readJsonFile(path.join(parseJsonOutput((await runCli(['setup', '--json'], { env, cwd: ws })).stdout).stateDir, 'server.json'));
  assert.ok(!res.stdout.includes(password));
});

test('opencode missing from PATH → ready:false, installed:false, exit 5, nothing spawned', async (t) => {
  const env = testEnv(t);
  env.PATH = env.PATH.split(path.delimiter).filter((p) => p !== FAKE_BIN_DIR && !fs.existsSync(path.join(p, 'opencode'))).join(path.delimiter);
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 5);
  assert.equal(report.ready, false);
  assert.equal(report.opencode.installed, false);
  assert.equal(report.server.status, 'skipped');
  assert.ok(report.nextSteps.some((s) => /npm install -g opencode-ai/.test(s)));
});

test('version below the minimum → UNSUPPORTED_VERSION, exit 5, no server', async (t) => {
  const env = testEnv(t, { scenario: 'old-version' });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 5);
  assert.equal(report.opencode.supported, false);
  assert.equal(report.server.error.code, 'UNSUPPORTED_VERSION');
  assert.equal(readFakeState(env).bootAttempts, 0);
});

test('auth-401 → AUTH_FAILED, exit 5, one single boot, no orphan server', async (t) => {
  const env = testEnv(t, { scenario: 'auth-401' });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 5);
  assert.equal(report.server.error.code, 'AUTH_FAILED');
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 1);
  assert.ok(fake.signals.some((s) => s.signal === 'SIGTERM'), 'spawned server was terminated');
  assert.equal(fs.existsSync(path.join(report.stateDir, 'server.json')), false);
});

test('share-auto → sessions blocked (exit 4), record keeps world.shareBlocked', async (t) => {
  const env = testEnv(t, { scenario: 'share-auto' });
  const ws = makeWorkspace(t);
  const blocked = await setupJson(env, ws);
  assert.equal(blocked.code, 4);
  assert.equal(blocked.report.ready, false);
  assert.equal(blocked.report.server.status, 'running');
  assert.equal(blocked.report.server.sessionsBlocked, 'share-auto');
  assert.ok(blocked.report.server.warnings.some((w) => /share "auto"/.test(w)));
  assert.ok(blocked.report.nextSteps.some((s) => /configOverride\.share/.test(s)));
  assert.equal(readJsonFile(path.join(blocked.report.stateDir, 'server.json')).world.shareBlocked, true);
  const again = await setupJson(env, ws);
  assert.equal(again.report.server.reused, true);
  assert.equal(again.code, 4, 'the block persists on reuse');
});

test('world check warns when the OpenCode model/small_model is denied by the policy', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.OPC_DATA_DIR, 'config.json'), JSON.stringify({ policy: { providers: { deny: ['fake-provider'] } } }));
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.ok(report.server.warnings.some((w) => /"model"/.test(w)));
  assert.ok(report.server.warnings.some((w) => /"small_model"/.test(w)));
});

test('.opc.json that widens allow or sets locked keys is ignored with warnings', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.OPC_DATA_DIR, 'config.json'), JSON.stringify({ policy: { models: { allow: ['prov-a/*'] } } }));
  fs.writeFileSync(path.join(ws, '.opc.json'), JSON.stringify({
    policy: { models: { allow: ['prov-b/*'] }, approver: 'claude' },
    permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
    server: { configOverride: { share: 'auto' } },
  }));
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.equal(report.config.workspaceFound, true);
  const warned = report.config.warnings.map((w) => w.path);
  for (const p of ['policy.models.allow', 'policy.approver', 'permissionProfiles', 'server.configOverride']) assert.ok(warned.includes(p), `${p} in ${warned}`);
  assert.equal(readFakeState(env).boots[0].configContent, JSON.stringify({ share: 'disabled' }));
});

test('data dir: the same state is seen through CLAUDE_PLUGIN_DATA and OPC_DATA_DIR', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  const viaPlugin = { ...env, CLAUDE_PLUGIN_DATA: env.OPC_DATA_DIR };
  delete viaPlugin.OPC_DATA_DIR;
  const second = await setupJson(viaPlugin, ws);
  assert.equal(second.report.dataDir, first.report.dataDir);
  assert.equal(second.report.stateDir, first.report.stateDir);
  assert.equal(second.report.server.reused, true);
  assert.equal(second.report.server.pid, first.report.server.pid);
});

test('setup bootstraps ~/.claude/plugins/data/opc-opencode-plugin-cc when nothing else resolves', async (t) => {
  const env = testEnv(t);
  delete env.OPC_DATA_DIR;
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.equal(report.dataDir, path.join(env.HOME, '.claude', 'plugins', 'data', 'opc-opencode-plugin-cc'));
  await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
});

test('permissions: dirs 700, server.json and server.log 600', posixOnly, async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { report } = await setupJson(env, ws);
  for (const dir of [report.dataDir, path.join(report.dataDir, 'state'), report.stateDir]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  for (const file of ['server.json', 'server.log']) {
    assert.equal(fs.statSync(path.join(report.stateDir, file)).mode & 0o777, 0o600, file);
  }
});

test('OPC_SERVER_URL non-loopback over http is refused (exit 2, INSECURE_SERVER_URL)', async (t) => {
  const env = testEnv(t, { extra: { OPC_SERVER_URL: 'http://example.com:4096' } });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 2);
  assert.equal(report.server.error.code, 'INSECURE_SERVER_URL');
  assert.equal(readFakeState(env).bootAttempts, 0);
  const withCreds = testEnv(t, { extra: { OPC_SERVER_URL: 'https://user:pw@example.com' } });
  assert.equal((await setupJson(withCreds, ws)).report.server.error.code, 'INSECURE_SERVER_URL');
});

test('attach mode on loopback: validates health with OPC_SERVER_PASSWORD, never spawns nor stops', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-attach-'));
  const password = 'attach-password-0123456789';
  const fake = await startFake({ port: 0, password, stateFile: path.join(dir, 'fake.json') });
  t.after(() => fake.close());
  const env = testEnv(t, { extra: { OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: password } });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.server.status, 'attached');
  assert.equal(report.server.attached, true);
  assert.ok(report.server.warnings.some((w) => /Modo attach/.test(w)));
  assert.equal(readFakeState(env).bootAttempts, 0);
  assert.equal(fs.existsSync(path.join(report.stateDir, 'server.json')), false);
  const stop = await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  assert.equal(parseJsonOutput(stop.stdout).stop.reason, 'attached');
  const health = await fetch(`${fake.url}/global/health`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  assert.equal(health.status, 200);
  const wrong = testEnv(t, { extra: { OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: 'wrong-password-000000' } });
  const denied = await setupJson(wrong, ws);
  assert.equal(denied.code, 5);
  assert.equal(denied.report.server.error.code, 'AUTH_FAILED');
});
````

Crie `tests/integration/setup-server.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { writeFileAtomic } from '../../plugins/opc/scripts/lib/state.mjs';
import {
  makeTempDir, makeWorkspace, parseJsonOutput, processAlive, readFakeState, runCli, testEnv, trackTempDir, waitFor,
} from '../helpers.mjs';

async function setupJson(env, cwd, extra = []) {
  const res = await runCli(['setup', '--json', ...extra], { env, cwd });
  return { ...res, report: parseJsonOutput(res.stdout) };
}

test('CLI: setup starts the server, the spawner exits, the next setup reuses it (no EPIPE), --stop-server stops it', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  assert.equal(first.code, 0, first.stderr);
  const { pid, port } = first.report.server;
  assert.ok(processAlive(pid), 'server outlives the setup process');
  const second = await setupJson(env, ws);
  assert.equal(second.report.server.reused, true);
  assert.equal(second.report.server.pid, pid);
  const log = fs.readFileSync(path.join(first.report.stateDir, 'server.log'), 'utf8');
  assert.match(log, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  assert.ok(!/EPIPE/.test(log));
  const stop = await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  assert.equal(stop.code, 0);
  assert.deepEqual(parseJsonOutput(stop.stdout).stop, { stopped: true, reason: 'terminated' });
  await waitFor(() => !processAlive(pid), { message: 'server gone' });
  const md = await runCli(['setup', '--stop-server'], { env, cwd: ws });
  assert.match(md.stdout, /nenhum servidor do opc rodando/);
});

test('CLI: two concurrent setups (separate processes) produce a single spawn', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const [a, b] = await Promise.all([setupJson(env, ws), setupJson(env, ws)]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.report.server.pid, b.report.server.pid);
  assert.deepEqual([a.report.server.reused, b.report.server.reused].sort(), [false, true]);
  assert.equal(readFakeState(env).bootAttempts, 1);
});

test('CLI: --stop-server with active jobs exits 2 listing them; --force needs --confirmed-by-user', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  writeFileAtomic(path.join(first.report.stateDir, 'state.json'), {
    version: 1, claudeSessions: [], jobs: [{ id: 'task-abc-123456', kind: 'task', status: 'running', title: 'long job' }],
  });
  const refused = await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  assert.equal(refused.code, 2);
  const body = parseJsonOutput(refused.stdout);
  assert.equal(body.stop.reason, 'active-jobs');
  assert.deepEqual(body.activeJobs.map((j) => j.id), ['task-abc-123456']);
  const md = await runCli(['setup', '--stop-server'], { env, cwd: ws });
  assert.match(md.stdout, /\| task-abc-123456 \| task \| running \| long job \|/);
  const noConfirm = await runCli(['setup', '--stop-server', '--force', '--json'], { env, cwd: ws });
  assert.equal(noConfirm.code, 2);
  assert.equal(parseJsonOutput(noConfirm.stdout).error.code, 'CONFIRMATION_REQUIRED');
  const misuse = await runCli(['setup', '--force'], { env, cwd: ws });
  assert.equal(misuse.code, 2);
  const forced = await runCli(['setup', '--stop-server', '--force', '--confirmed-by-user', '--json'], { env, cwd: ws });
  assert.equal(forced.code, 0);
  assert.equal(parseJsonOutput(forced.stdout).stop.stopped, true);
});

test('workspace-with-spaces: git (from a subdir) and non-git dirs with spaces/accents keep exact directory and hash', async (t) => {
  const env = testEnv(t);
  const gitWs = makeWorkspace(t, { name: 'meu projeto ação' });
  fs.mkdirSync(path.join(gitWs, 'sub dir'));
  const fromSub = await setupJson(env, path.join(gitWs, 'sub dir'));
  assert.equal(fromSub.code, 0, fromSub.stderr);
  assert.equal(fromSub.report.workspaceRoot, gitWs);
  assert.match(path.basename(fromSub.report.stateDir), /^meu-projeto-acao-[0-9a-f]{16}$/);
  const plainBase = trackTempDir(t, makeTempDir('opc-plain-'));
  const plain = path.join(plainBase, 'sem git é aqui');
  fs.mkdirSync(plain);
  const res = await setupJson(env, plain);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.report.workspaceRoot, plain);
  assert.notEqual(res.report.stateDir, fromSub.report.stateDir);
  const fake = readFakeState(env);
  const dirs = fake.requests.filter((r) => r.path === '/agent').map((r) => r.query.directory);
  assert.ok(dirs.includes(gitWs));
  assert.ok(dirs.includes(plain));
  assert.ok(fake.boots.some((b) => b.cwd === plain));
  await runCli(['setup', '--stop-server', '--json'], { env, cwd: plain });
});
````

Crie `tests/integration/secrets.test.mjs`:

````js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  REPO_ROOT, makeTempDir, makeWorkspace, parseJsonOutput, readJsonFile, runCli, runProcess, testEnv, trackTempDir,
} from '../helpers.mjs';

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

test('no output, log or state file (other than server.json) contains the server password', async (t) => {
  const env = testEnv(t, { scenario: 'ignores-sigterm' });
  const ws = makeWorkspace(t);
  const outputs = [];
  const run = async (args) => {
    const res = await runCli(args, { env, cwd: ws });
    outputs.push(res.stdout, res.stderr);
    return res;
  };
  const first = await run(['setup', '--json']);
  const { stateDir } = parseJsonOutput(first.stdout);
  const serverJson = path.join(stateDir, 'server.json');
  const { password } = readJsonFile(serverJson);
  assert.equal(password.length, 48);
  const keep = trackTempDir(t, makeTempDir('opc-secret-'));
  fs.copyFileSync(serverJson, path.join(keep, 'server.json'));
  await run(['setup']);
  await run(['setup', '--json']);
  await run(['setup', '--bogus', '--json']);
  await run(['setup', '--stop-server', '--json']);
  await run(['setup', '--stop-server']);

  for (const text of outputs) assert.ok(!text.includes(password), 'CLI output leaked the password');
  const dataFiles = filesUnder(env.OPC_DATA_DIR);
  for (const file of dataFiles) {
    if (path.basename(file) === 'server.json') continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes(password), `${file} leaked the password`);
  }
  assert.ok(!fs.readFileSync(env.FAKE_OPENCODE_STATE, 'utf8').includes(password), 'fake state leaked the password');

  const dump = path.join(keep, 'dump');
  fs.mkdirSync(dump);
  fs.writeFileSync(path.join(dump, 'outputs.txt'), outputs.join('\n'));
  for (const file of dataFiles.filter((f) => path.basename(f) !== 'server.json')) {
    fs.copyFileSync(file, path.join(dump, `${path.basename(path.dirname(file))}-${path.basename(file)}`));
  }
  const scan = await runProcess(process.execPath, [path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs'), dump, '--server-json', path.join(keep, 'server.json')], { env: { PATH: process.env.PATH } });
  assert.equal(scan.code, 0, scan.stdout + scan.stderr);
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/companion.test.mjs tests/integration/cli.test.mjs tests/integration/setup.test.mjs tests/integration/setup-server.test.mjs tests/integration/secrets.test.mjs`
Expected: FAIL — `companion.test.mjs` com `ERR_MODULE_NOT_FOUND` (`…/opc-companion.mjs`) e os de integração com `code` 1 (o `node` não acha o companion) em vez dos códigos esperados.

- [ ] **Step 3: Implementar a CLI, o comando e o plugin**

Crie `plugins/opc/scripts/opc-companion.mjs`:

````js
#!/usr/bin/env node
// opc companion: single CLI entry point (`opc <subcommand>`). Only the Node guard runs before dynamic imports.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_NODE_MAJOR = 20;
const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands');
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/;

export function nodeVersionOk(version = process.versions.node) {
  return Number(String(version).split('.')[0]) >= MIN_NODE_MAJOR;
}

// Subcommands = the commands/<name>.mjs files (each phase just adds files; no list to keep in sync).
export function listSubcommands() {
  let entries;
  try {
    entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name.slice(0, -'.mjs'.length))
    .filter((name) => SUBCOMMAND_RE.test(name))
    .sort();
}

// Only a validated name that maps to an existing commands/<name>.mjs is ever imported (no arbitrary paths).
export async function loadCommand(sub) {
  const { UsageError } = await import('./lib/opc-error.mjs');
  const name = String(sub ?? '');
  const file = SUBCOMMAND_RE.test(name) ? path.join(COMMANDS_DIR, `${name}.mjs`) : null;
  if (!file || !fs.existsSync(file)) {
    throw new UsageError('USAGE', `Subcomando desconhecido: ${name}. Disponíveis: ${listSubcommands().join(', ')}.`);
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.run !== 'function') throw new UsageError('USAGE', `O subcomando ${name} não exporta run().`);
  return mod;
}

async function flush(stream) {
  await new Promise((resolve) => {
    stream.write('', () => resolve());
  });
}

export async function main(rawArgv, io = {}) {
  const {
    stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env,
    cwd: defaultCwd = process.cwd(), onError = null,
  } = io;
  if (!nodeVersionOk()) {
    stderr.write(`opc: Node.js >= ${MIN_NODE_MAJOR} é obrigatório (encontrado ${process.versions.node}).\n`);
    return 2;
  }
  const { resolveArgv, extractCwd } = await import('./lib/args.mjs');
  const { UsageError, toExitCode } = await import('./lib/opc-error.mjs');
  const { renderError } = await import('./lib/render.mjs');
  const { redact } = await import('./lib/redact.mjs');
  let wantsJson = false;
  try {
    const resolved = await resolveArgv(rawArgv, { stdin });
    const { cwd, argv } = extractCwd(resolved);
    const [sub, ...rest] = argv;
    wantsJson = rest.includes('--json');
    if (!sub) throw new UsageError('USAGE', `Uso: opc <subcomando> [flags]. Subcomandos: ${listSubcommands().join(', ')}.`);
    const mod = await loadCommand(sub);
    const { createContext } = await import('./lib/context.mjs');
    const ctx = await createContext({ argv: rest, env, cwd: cwd ?? defaultCwd, stdin, stdout, stderr, createDataDir: sub === 'setup' });
    return await mod.run(ctx, rest);
  } catch (err) {
    if (onError) onError(err);
    stderr.write(renderError(err));
    if (wantsJson) {
      stdout.write(`${JSON.stringify(redact({ error: { code: err.code ?? 'INTERNAL', message: err.message, details: err.details } }), null, 2)}\n`);
    }
    return toExitCode(err);
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await main(process.argv.slice(2));
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}
````

Crie `plugins/opc/scripts/commands/setup.mjs`:

````js
// `opc setup`: diagnostic + start/reuse of the workspace server (F0); `--stop-server` (spec §4, §5.5).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../lib/args.mjs';
import { globalConfigPath, workspaceConfigPath } from '../lib/config.mjs';
import { ExitCode, UsageError, toExitCode } from '../lib/opc-error.mjs';
import { renderSetup } from '../lib/render.mjs';
import { MIN_OPENCODE_VERSION, compareVersions, ensureServer, stopServer } from '../lib/server.mjs';
import { listActiveJobs } from '../lib/state.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = {
  flags: {
    json: { type: 'boolean' },
    'stop-server': { type: 'boolean' },
    force: { type: 'boolean' },
    'confirmed-by-user': { type: 'boolean' },
  },
};

function shellSingleQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

export function terminalAlias(dataDir, pluginRoot = PLUGIN_ROOT) {
  const inner = `OPC_DATA_DIR="${dataDir}" node "${path.join(pluginRoot, 'scripts', 'opc-companion.mjs')}"`;
  return `alias opc=${shellSingleQuote(inner)}`;
}

export function detectOpencode(env, bin = 'opencode') {
  const res = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 15000, shell: false });
  if (res.error) {
    return { installed: false, version: null, supported: null, detail: res.error.code === 'ENOENT' ? 'não encontrado no PATH' : res.error.message };
  }
  const match = /\d+\.\d+\.\d+[^\s]*/.exec(`${res.stdout} ${res.stderr}`);
  const version = match ? match[0] : null;
  return {
    installed: res.status === 0,
    version,
    supported: version ? compareVersions(version, MIN_OPENCODE_VERSION) >= 0 : null,
    detail: res.status === 0 ? 'ok' : `saiu com ${res.status}`,
  };
}

function serverContext(ctx) {
  return {
    stateDir: ctx.stateDir,
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    env: ctx.env,
    opencodeBin: 'opencode',
    hasActiveJobs: () => listActiveJobs(ctx.stateDir).length > 0,
  };
}

function baseReport(ctx) {
  return {
    mode: 'diagnose',
    ready: false,
    node: { ok: true, version: process.versions.node },
    opencode: null,
    dataDir: ctx.dataDir,
    workspaceRoot: ctx.workspaceRoot,
    stateDir: ctx.stateDir,
    config: {
      hasGlobal: ctx.configMeta.hasGlobal,
      globalPath: globalConfigPath(ctx.dataDir),
      workspaceFound: ctx.configMeta.workspaceFound,
      workspacePath: workspaceConfigPath(ctx.workspaceRoot),
      warnings: ctx.configWarnings,
    },
    server: null,
    terminalAlias: terminalAlias(ctx.dataDir),
    nextSteps: [],
  };
}

const NEXT_STEP_BY_CODE = {
  AUTH_FAILED: 'O servidor recusou a senha (401). Rode `/opc:setup --stop-server` e depois `/opc:setup` de novo.',
  BOOT_FAILED: 'O servidor não subiu. Veja o server.log no diretório de estado e docs/troubleshooting.md.',
  UNSUPPORTED_VERSION: `Atualize o OpenCode para ${MIN_OPENCODE_VERSION} ou mais novo: npm install -g opencode-ai.`,
  TIMEOUT: 'Tempo esgotado. Tente de novo; se persistir, veja docs/troubleshooting.md (locks e boot lento).',
  INSECURE_SERVER_URL: 'Corrija OPC_SERVER_URL (http://127.0.0.1, http://localhost ou https://) ou remova a variável.',
  SERVER_DOWN: 'Servidor inacessível. Rode `/opc:setup` de novo.',
};

async function diagnose(ctx, flags) {
  const report = baseReport(ctx);
  const attach = Boolean(ctx.env.OPC_SERVER_URL);
  report.opencode = detectOpencode(ctx.env);
  let exitCode = ExitCode.OK;
  if (!attach && !report.opencode.installed) {
    report.server = { status: 'skipped', warnings: [] };
    report.nextSteps.push('Instale o OpenCode (npm install -g opencode-ai) e rode `/opc:setup` de novo.');
    exitCode = ExitCode.CONNECTION;
  } else if (!attach && report.opencode.supported === false) {
    report.server = {
      status: 'error',
      error: { code: 'UNSUPPORTED_VERSION', message: `OpenCode ${report.opencode.version} é anterior ao mínimo ${MIN_OPENCODE_VERSION}.` },
      warnings: [],
    };
    report.nextSteps.push(NEXT_STEP_BY_CODE.UNSUPPORTED_VERSION);
    exitCode = ExitCode.CONNECTION;
  } else {
    try {
      const s = await ensureServer(serverContext(ctx));
      report.server = {
        status: s.attached ? 'attached' : 'running',
        url: s.url,
        port: s.port,
        pid: s.pid,
        version: s.version,
        reused: s.reused,
        attached: s.attached,
        sessionsBlocked: s.world?.shareBlocked ? 'share-auto' : null,
        warnings: s.warnings,
      };
      if (s.world?.shareBlocked) {
        report.nextSteps.push('Desligue o share automático: `server.configOverride.share = "disabled"` na config global do opc, ou `share: "manual"` no OpenCode.');
        exitCode = ExitCode.POLICY;
      }
    } catch (err) {
      report.server = { status: 'error', error: { code: err.code ?? 'INTERNAL', message: err.message }, warnings: [] };
      if (NEXT_STEP_BY_CODE[err.code]) report.nextSteps.push(NEXT_STEP_BY_CODE[err.code]);
      exitCode = toExitCode(err);
    }
  }
  if (!report.config.hasGlobal) report.nextSteps.push('Ainda não há config global do opc; o onboarding guiado chega na F1.');
  report.ready = exitCode === ExitCode.OK;
  if (flags.json) ctx.json(report);
  else ctx.out(renderSetup(report));
  return exitCode;
}

async function stop(ctx, flags) {
  const result = await stopServer(serverContext(ctx), { force: flags.force, confirmedByUser: flags['confirmed-by-user'] });
  const report = {
    mode: 'stop',
    stop: result,
    activeJobs: result.reason === 'active-jobs'
      ? listActiveJobs(ctx.stateDir).map((j) => ({ id: j.id, kind: j.kind, status: j.status, title: j.title ?? null }))
      : [],
  };
  if (flags.json) ctx.json(report);
  else ctx.out(renderSetup(report));
  return result.reason === 'active-jobs' ? ExitCode.USAGE : ExitCode.OK;
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  if ((flags.force || flags['confirmed-by-user']) && !flags['stop-server']) {
    throw new UsageError('USAGE', '--force e --confirmed-by-user só valem junto com --stop-server.');
  }
  if (flags['stop-server']) return stop(ctx, flags);
  return diagnose(ctx, flags);
}
````

Crie `plugins/opc/bin/opc` e torne-o executável (`chmod +x plugins/opc/bin/opc`):

````sh
#!/bin/sh
# opc: entry point placed on the PATH of the Claude Code Bash tool by the plugin bin/ directory.
exec node "$(dirname "$0")/../scripts/opc-companion.mjs" "$@"
````

Crie `plugins/opc/commands/setup.md` (invocação por heredoc com delimitador entre aspas, spec §4; `allowed-tools` mínimos, spec §8.4 — o `Bash(npm:*)` entra na F1 com a instalação guiada):

````markdown
---
description: Diagnostica o OpenCode para o opc, sobe ou reaproveita o servidor do workspace, ou encerra esse servidor
argument-hint: '[--stop-server [--force]]'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Rode o diagnóstico do opc repassando os argumentos do usuário **somente** pelo heredoc abaixo. Não
edite, reordene nem interprete os argumentos, e mantenha o delimitador entre aspas simples, para que
o shell não expanda nada:

```bash
opc setup --args-stdin <<'OPC_ARGS'
$ARGUMENTS
OPC_ARGS
```

Se os argumentos contiverem `--force` (sempre junto com `--stop-server`):

- Antes de rodar, use `AskUserQuestion` exatamente uma vez para confirmar, com as opções
  `Encerrar mesmo com jobs ativos` e `Cancelar`.
- Só se o usuário escolher encerrar, rode com `--confirmed-by-user` **fora** do heredoc:

```bash
opc setup --confirmed-by-user --args-stdin <<'OPC_ARGS'
$ARGUMENTS
OPC_ARGS
```

- Se o usuário cancelar, não rode nada e diga que o servidor continua ativo.
- Nunca acrescente `--confirmed-by-user` sem essa confirmação.

Regras de saída:

- Apresente ao usuário a saída do comando como veio (ela já está em Markdown e sem segredos).
- Se o status for "requer atenção", destaque os próximos passos listados.
- Se o OpenCode não estiver instalado, oriente `npm install -g opencode-ai` e rodar `/opc:setup`
  de novo (a instalação guiada chega na F1).
- Preserve a linha `alias opc=...` da seção "Terminal", para o usuário copiar.
- Não tente corrigir nada por conta própria.
````

Crie `plugins/opc/.claude-plugin/plugin.json`:

````json
{
  "name": "opc",
  "version": "0.1.0",
  "description": "Use o OpenCode a partir do Claude Code: servidor gerenciado por workspace, providers, modelos, agentes e permissões.",
  "author": {
    "name": "TheViniAlmeida"
  },
  "license": "Apache-2.0"
}
````

Crie `.claude-plugin/marketplace.json`:

````json
{
  "name": "opencode-plugin-cc",
  "owner": {
    "name": "TheViniAlmeida"
  },
  "metadata": {
    "description": "Plugins Claude Code para usar o OpenCode: delegação, review, sessões e consulta a vários modelos.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "opc",
      "description": "Use o OpenCode a partir do Claude Code: servidor gerenciado por workspace, providers, modelos, agentes e permissões.",
      "version": "0.1.0",
      "author": {
        "name": "TheViniAlmeida"
      },
      "source": "./plugins/opc"
    }
  ]
}
````

- [ ] **Step 4: Rodar e ver passar**

Run: `chmod +x plugins/opc/bin/opc && node --test tests/unit/companion.test.mjs tests/integration/cli.test.mjs tests/integration/setup.test.mjs tests/integration/setup-server.test.mjs tests/integration/secrets.test.mjs`
Expected: PASS — `# tests 27`, `# pass 27`.

Run: `npm test`
Expected: PASS — `# tests 148`, `# pass 148`, `# fail 0` (cerca de 25 s). Depois: `ps -ef | grep "[f]ixtures/bin/opencode serve"` → nenhuma linha.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/opc-companion.mjs plugins/opc/scripts/commands/setup.mjs plugins/opc/bin/opc plugins/opc/commands/setup.md plugins/opc/.claude-plugin/plugin.json .claude-plugin/marketplace.json tests/unit/companion.test.mjs tests/integration/cli.test.mjs tests/integration/setup.test.mjs tests/integration/setup-server.test.mjs tests/integration/secrets.test.mjs
git commit -m "feat: add opc cli, setup command and plugin manifests"
```

Confira: `git ls-files -s plugins/opc/bin/opc` começa com `100755`.

---

### Task 15: Portão da F0

Executa o checklist do mestre (“Portão de fase”) para a F0: testes ao vivo, probe, contrato, documentação, relatório, CHANGELOG, aviso, git e gravação dupla.

**Files:**
- Create: `tests/fixtures/contract-shapes.mjs`, `tests/unit/contract-shapes.test.mjs`, `tests/live/f0-connection.mjs`, `tests/live/probe-permission-precedence.mjs`, `tests/live/contract.mjs`, `tests/fixtures/contract/opencode-<versão>.shapes.json` (gerado), `docs/installation.md`, `docs/troubleshooting.md`, `docs/architecture.md`, `docs/phases/F0-report.md`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `mergeConfig` (Task 8), `createClient` (Task 9), `EventHub` (Task 11), `ensureServer`, `stopServer`, `clientFor` (Task 12), `ensurePrivateDir`, `workspaceStateDir` (Task 7), `getProcessIdentity` (Task 5), `redact` (Task 3), `startFake` (Task 10), helpers.
- Produces (**novo arquivo**): `tests/fixtures/contract-shapes.mjs` com o **registro** `PROBES`/`EVENT_TYPES`, `MAP_PATHS`, `shapeOf(value, at)`, `lookup(shape, dotted)`, `diffShapes(real, fake, used, optionalUsed)`. `tests/live/contract.mjs` é o único executor do contrato (roda em todo portão) e lê o registro; as fases seguintes acrescentam, por passo "Modify" explícito, entradas em `PROBES`/`EVENT_TYPES`/`MAP_PATHS` desse arquivo para os endpoints GET e eventos passivos que passarem a usar (nunca criam outro `contract.mjs`). Formas que só aparecem com sessão/turno vivos ficam nos testes ao vivo da própria fase (`tests/live/f<n>-*.mjs`).

#### 15.1 Código dos testes ao vivo e do contrato

- [ ] **Step 1: Escrever o teste do helper de contrato (falha)**

Crie `tests/unit/contract-shapes.test.mjs`:

````js
import assert from 'node:assert/strict';
import test from 'node:test';

import { diffShapes, lookup, shapeOf } from '../fixtures/contract-shapes.mjs';

test('shapeOf records types, first array element and collapses user-data maps', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', n: null, l: [{ k: true }] }), { a: 'string', b: 'number', l: [{ k: 'boolean' }], n: 'null' });
  assert.deepEqual(shapeOf([]), ['empty']);
  assert.deepEqual(shapeOf({ mcp: { gitlab: { type: 'local' }, other: {} } }, 'config'), { mcp: { '*': { type: 'string' } } });
  assert.deepEqual(shapeOf({}, 'session.status'), { '*': 'empty' });
});

test('lookup walks dotted paths with [] for array elements', () => {
  const shape = shapeOf([{ name: 'build', permission: [{ action: 'allow' }] }]);
  assert.equal(lookup(shape, '[].name'), 'string');
  assert.deepEqual(lookup(shape, '[].permission'), [{ action: 'string' }]);
  assert.equal(lookup(shape, '[].missing'), undefined);
  assert.equal(lookup({ a: 'string' }, '[].a'), undefined);
});

test('diffShapes reports missing and different used fields only', () => {
  const real = shapeOf({ healthy: true, version: '1', extra: 1 });
  assert.deepEqual(diffShapes(real, shapeOf({ healthy: true, version: '1' }), ['healthy', 'version']), []);
  assert.deepEqual(diffShapes(real, shapeOf({ healthy: 'yes', version: '1' }), ['healthy']), [{ field: 'healthy', real: '"boolean"', fake: '"string"' }]);
  assert.equal(diffShapes(shapeOf({}), shapeOf({ version: '1' }), ['version'])[0].real, 'ausente');
  assert.equal(diffShapes(shapeOf([]), shapeOf({}), [])[0].field, '(root)');
  assert.deepEqual(diffShapes(shapeOf({ share: 'auto' }), shapeOf({}), [], ['share']), []);
  assert.deepEqual(diffShapes(shapeOf({ mcp: { a: { type: 'local' } } }, 'config'), shapeOf({ mcp: {} }, 'config'), [], ['mcp']), []);
  assert.deepEqual(diffShapes(shapeOf({ share: 'auto' }), shapeOf({ share: true }), [], ['share']), [{ field: 'share', real: 'string', fake: 'boolean' }]);
});
````

Run: `node --test tests/unit/contract-shapes.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`…/tests/fixtures/contract-shapes.mjs`).

- [ ] **Step 2: Implementar o helper**

Crie `tests/fixtures/contract-shapes.mjs` (os mapas cujas chaves são dados do usuário — nomes de provider, MCP, agente — viram `{"*": forma}`, para o snapshot não expor nomes):

````js
// Shape recording and diffing used by tests/live/contract.mjs (kept import-safe for unit tests).

// Probe registry read by tests/live/contract.mjs (the single contract runner). Later phases APPEND entries here
// (explicit "Modify" steps) for the GET endpoints / passive SSE events they start consuming:
// { name, method: 'GET', path, used: [dotted fields opc reads], optionalUsed?: [fields read only if present] }.
export const PROBES = [
  { name: 'health', method: 'GET', path: '/global/health', used: ['healthy', 'version'] },
  { name: 'agent', method: 'GET', path: '/agent', used: ['[].name', '[].mode', '[].permission', '[].options'] },
  { name: 'config', method: 'GET', path: '/config', used: [], optionalUsed: ['model', 'small_model', 'share', 'autoshare', 'mcp'] },
  { name: 'session.status', method: 'GET', path: '/session/status', used: [] },
  { name: 'permission', method: 'GET', path: '/permission', used: [] },
  { name: 'question', method: 'GET', path: '/question', used: [] },
];
export const EVENT_TYPES = ['server.connected', 'server.heartbeat'];

// Maps whose keys are user data (provider names, MCP names…): only the value shape is recorded.
export const MAP_PATHS = new Set([
  'config.agent', 'config.mcp', 'config.provider', 'config.command', 'config.mode', 'config.lsp', 'config.formatter',
  'config.permission', 'session.status',
]);

export function shapeOf(value, at = '') {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? ['empty'] : [shapeOf(value[0], `${at}[]`)];
  if (typeof value === 'object') {
    if (MAP_PATHS.has(at)) {
      const first = Object.values(value)[0];
      return { '*': first === undefined ? 'empty' : shapeOf(first, `${at}.*`) };
    }
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], at ? `${at}.${k}` : k)]));
  }
  return typeof value;
}

export function lookup(shape, dotted) {
  let cur = shape;
  for (const part of dotted.split('.')) {
    if (part === '[]') {
      if (!Array.isArray(cur)) return undefined;
      [cur] = cur;
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = cur[part];
    }
  }
  return cur;
}

const kindOf = (shape) => {
  if (Array.isArray(shape)) return 'array';
  return typeof shape === 'object' && shape !== null ? 'object' : shape;
};

export function diffShapes(real, fake, used = [], optionalUsed = []) {
  const problems = [];
  if (Array.isArray(real) !== Array.isArray(fake) || typeof real !== typeof fake) {
    problems.push({ field: '(root)', real: JSON.stringify(real).slice(0, 80), fake: JSON.stringify(fake).slice(0, 80) });
    return problems;
  }
  for (const field of used) {
    const r = lookup(real, field);
    const f = lookup(fake, field);
    if (r === undefined) problems.push({ field, real: 'ausente', fake: JSON.stringify(f ?? 'ausente') });
    else if (JSON.stringify(r) !== JSON.stringify(f)) {
      problems.push({ field, real: JSON.stringify(r).slice(0, 80), fake: JSON.stringify(f ?? 'ausente').slice(0, 80) });
    }
  }
  for (const field of optionalUsed) {
    const r = lookup(real, field);
    const f = lookup(fake, field);
    if (r !== undefined && f !== undefined && kindOf(r) !== kindOf(f)) {
      problems.push({ field, real: String(kindOf(r)), fake: String(kindOf(f)) });
    }
  }
  return problems;
}
````

Run: `node --test tests/unit/contract-shapes.test.mjs`
Expected: PASS — `# tests 3`, `# pass 3`.

- [ ] **Step 3: Escrever os três arquivos ao vivo**

Crie `tests/live/f0-connection.mjs` (checklist ao vivo da spec §13.3 F0; só Linux, porque varre `/proc` para comparar os `opencode serve` do usuário antes e depois **sem sinalizá-los**):

````js
// Live F0 checklist (spec §13.3 F0): real `opc setup`, port != 4096, reuse, stop without orphans,
// pre-existing user `opencode serve` processes untouched. Runs only with OPC_LIVE=1.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { COMPANION, makeTempDir, parseJsonOutput, removeTempDir, runProcess } from '../helpers.mjs';

const LIVE = process.env.OPC_LIVE === '1';
const LINUX = process.platform === 'linux';

function listOpencodeServe() {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const identity = getProcessIdentity(Number(name));
    if (!identity) continue;
    const isOpencode = identity.cmdline.slice(0, 3).some((a) => /^opencode(\.exe)?$/.test(path.basename(a)));
    if (isOpencode && identity.cmdline.includes('serve')) out.push(identity);
  }
  return out;
}

function processGroupMembers(pgid) {
  const members = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') members.push(Number(name));
    } catch {
      // process vanished while scanning
    }
  }
  return members;
}

function liveEnv(dataDir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPC_|OPENCODE_SERVER_|FAKE_)/.test(k)));
  return { ...env, OPC_DATA_DIR: dataDir };
}

async function opc(args, { env, cwd }) {
  const started = Date.now();
  const res = await runProcess(process.execPath, [COMPANION, ...args], { env, cwd, timeoutMs: 240000 });
  return { ...res, ms: Date.now() - started };
}

if (!LIVE) {
  test('F0 live checklist (set OPC_LIVE=1 to run)', { skip: 'OPC_LIVE != 1' }, () => {});
} else {
  test('F0 live: real setup, port != 4096, reuse, stop without orphans, user servers untouched', { skip: !LINUX && 'Linux only', timeout: 600000 }, async (t) => {
    const base = makeTempDir('opc-live-f0-');
    t.after(() => removeTempDir(base));
    const ws = path.join(base, 'workspace live');
    fs.mkdirSync(ws);
    execFileSync('git', ['init', '-q'], { cwd: ws });
    const env = liveEnv(path.join(base, 'data'));
    const userServersBefore = listOpencodeServe();
    console.log(`[live] opencode serve preexistentes: ${userServersBefore.length}`);

    const first = await opc(['setup', '--json'], { env, cwd: ws });
    const r1 = parseJsonOutput(first.stdout);
    console.log(`[live] setup #1: exit ${first.code} em ${first.ms} ms; porta ${r1.server?.port}; versão ${r1.server?.version}`);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(r1.server.status, 'running');
    assert.equal(r1.server.reused, false);
    assert.notEqual(r1.server.port, 4096);
    const { pid, port } = r1.server;
    const identity = getProcessIdentity(pid);
    assert.ok(identity.cmdline.includes('serve') && identity.cmdline.includes(String(port)), identity.cmdline.join(' '));

    const serverJson = path.join(r1.stateDir, 'server.json');
    const record = JSON.parse(fs.readFileSync(serverJson, 'utf8'));
    assert.equal(fs.statSync(serverJson).mode & 0o777, 0o600);
    const client = createClient({ baseUrl: record.url, password: record.password, directory: ws });
    const health = await client.get('/global/health');
    console.log(`[live] health: healthy=${health.healthy} version=${health.version}`);
    assert.equal(health.healthy, true);

    const second = await opc(['setup', '--json'], { env, cwd: ws });
    const r2 = parseJsonOutput(second.stdout);
    console.log(`[live] setup #2: exit ${second.code} em ${second.ms} ms; reaproveitado=${r2.server?.reused}`);
    assert.equal(r2.server.reused, true);
    assert.equal(r2.server.pid, pid);

    const stop = await opc(['setup', '--stop-server', '--json'], { env, cwd: ws });
    const r3 = parseJsonOutput(stop.stdout);
    console.log(`[live] stop: exit ${stop.code} em ${stop.ms} ms; ${JSON.stringify(r3.stop)}`);
    assert.equal(stop.code, 0);
    assert.equal(r3.stop.stopped, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(getProcessIdentity(pid), null, 'server pid still alive');
    assert.deepEqual(processGroupMembers(pid), [], 'orphan processes left in the server group');
    const leftovers = listOpencodeServe().filter((p) => p.cmdline.includes(String(port)));
    assert.deepEqual(leftovers, [], 'an opencode serve with our port is still running');

    for (const before of userServersBefore) {
      const now = getProcessIdentity(before.pid);
      assert.ok(now && String(now.startTime) === String(before.startTime), `user server ${before.pid} was affected`);
    }
    console.log(`[live] opencode serve preexistentes intactos: ${userServersBefore.length}/${userServersBefore.length}`);

    for (const text of [first.stdout, first.stderr, second.stdout, second.stderr, stop.stdout, stop.stderr]) {
      assert.ok(!text.includes(record.password), 'password leaked in CLI output');
    }
    const log = fs.readFileSync(path.join(r1.stateDir, 'server.log'), 'utf8');
    assert.ok(!log.includes(record.password), 'password leaked in server.log');
    assert.match(log, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  });
}
````

Crie `tests/live/probe-permission-precedence.mjs` (script isolado; projeto descartável e servidor dedicado; injeta um servidor MCP local mínimo via `server.configOverride` para testar ao mesmo tempo o merge do `OPENCODE_CONFIG_CONTENT` e o curinga de nome; o `always` é usado **só aqui**, por último, e o servidor é encerrado em seguida, o que descarta a aprovação em memória):

````js
#!/usr/bin/env node
// Standalone live probe for spec §15 items 1, 2, 4 and 5 (F0). Throwaway project, dedicated server, real model.
// Run: OPC_LIVE=1 node tests/live/probe-permission-precedence.mjs [--json]
// `always` is used HERE ONLY, to document its scope; the plugin never sends it (spec §8.3).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { redact } from '../../plugins/opc/scripts/lib/redact.mjs';
import { clientFor, ensureServer, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { EventHub } from '../../plugins/opc/scripts/lib/sse.mjs';
import { ensurePrivateDir, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('probe-permission-precedence: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

const WANT_JSON = process.argv.includes('--json');
const MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash';
const [providerID, ...modelRest] = MODEL.split('/');
const modelID = modelRest.join('/');
const TURN_TIMEOUT_MS = 240000;
const ENV_MARKER = 'OPC_PROBE_DUMMY_VALUE_7731';
const GREP_MARKER = 'OPC_PROBE_GREP_MARKER_42';
const SENSITIVE = ['*.env', '*.env.*'];
const log = (line) => process.stderr.write(`[probe] ${line}\n`);

const READ_ONLY_RULES = [
  { permission: '*', pattern: '*', action: 'deny' },
  ...['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'todowrite'].map((p) => ({ permission: p, pattern: '*', action: 'allow' })),
  { permission: 'external_directory', pattern: '*', action: 'deny' },
  ...SENSITIVE.map((p) => ({ permission: 'read', pattern: p, action: 'deny' })),
  { permission: 'doom_loop', pattern: '*', action: 'deny' },
];

const MCP_SERVER_SOURCE = `
import fs from 'node:fs';
import readline from 'node:readline';
const callLog = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opcprobe', version: '0.0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo_marker', description: 'Echo a marker text back (opc probe).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (msg.method === 'tools/call') {
    fs.appendFileSync(callLog, JSON.stringify({ at: Date.now(), args: msg.params?.arguments ?? null }) + '\\n');
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'marker:' + (msg.params?.arguments?.text ?? '') }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPC_SERVER_|OPENCODE_SERVER_|FAKE_)/.test(k)));
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function prepareProject(base) {
  const ws = path.join(base, 'probe-project');
  fs.mkdirSync(path.join(ws, 'secretdir'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'README.md'), '# opc probe project\n');
  fs.writeFileSync(path.join(ws, '.env'), `PROBE_VALUE=${ENV_MARKER}\n`);
  fs.writeFileSync(path.join(ws, 'secretdir', 'data.txt'), `${GREP_MARKER}\n`);
  const mcpScript = path.join(base, 'opcprobe-mcp.mjs');
  fs.writeFileSync(mcpScript, MCP_SERVER_SOURCE);
  return { ws, mcpScript, callLog: path.join(base, 'mcp-calls.jsonl') };
}

function makeTurnRunner(client, hub) {
  return async function turn({ title, rules, text, onAsk = 'reject', agent = 'build' }) {
    const session = await client.post('/session', { title: `OPC: probe: ${title}`, permission: rules });
    const asked = [];
    let sawActivity = false;
    let untrack = () => {};
    const done = new Promise((resolve) => {
      untrack = hub.track(session.id, async (e) => {
        if (e.type.startsWith('message.') || (e.type === 'session.status' && e.properties.status?.type !== 'idle')) sawActivity = true;
        if (e.type === 'permission.asked') {
          const reply = typeof onAsk === 'function' ? onAsk(e) : onAsk;
          asked.push({ permission: e.properties.permission, patterns: e.properties.patterns, always: e.properties.always, reply });
          await client.post(`/permission/${e.properties.id}/reply`, { reply, message: 'opc probe' }).catch((err) => log(`reply failed: ${err.code}`));
        }
        const idle = e.type === 'session.idle' || (e.type === 'session.status' && e.properties.status?.type === 'idle');
        if (e.type === 'session.error' || (idle && sawActivity)) resolve(e.type);
      });
    });
    await client.post(`/session/${session.id}/prompt_async`, { model: { providerID, modelID }, agent, parts: [{ type: 'text', text }] });
    let timer;
    const end = await Promise.race([done, new Promise((r) => { timer = setTimeout(() => r('timeout'), TURN_TIMEOUT_MS); })]);
    clearTimeout(timer);
    untrack();
    if (end === 'timeout') await client.post(`/session/${session.id}/abort`).catch(() => {});
    const messages = (await client.get(`/session/${session.id}/message`)) ?? [];
    const parts = messages.flatMap((m) => (m.parts ?? []).map((p) => ({ ...p, role: m.info?.role })));
    const tools = parts.filter((p) => p.type === 'tool').map((p) => ({
      tool: p.tool,
      status: p.state?.status,
      error: p.state?.error ? String(p.state.error).slice(0, 200) : undefined,
    }));
    const finalText = parts.filter((p) => p.type === 'text' && p.role === 'assistant').map((p) => p.text).join('\n');
    log(`${title}: end=${end} tools=${JSON.stringify(tools)} asked=${asked.length}`);
    return { sessionID: session.id, end, asked, tools, finalText };
  };
}

async function probeConfigMerge(client, userHasModel) {
  const cfg = await client.get('/config');
  const toolIds = await client.get('/experimental/tool/ids').catch(() => null);
  const probeTool = Array.isArray(toolIds) ? toolIds.find((id) => id.includes('echo_marker')) ?? null : null;
  return {
    item: '§15.5 OPENCODE_CONFIG_CONTENT',
    shareDisabled: cfg?.share === 'disabled',
    mcpInjected: Boolean(cfg?.mcp && 'opcprobe' in cfg.mcp),
    userMcpCount: Object.keys(cfg?.mcp ?? {}).filter((k) => k !== 'opcprobe').length,
    userModelStillPresent: typeof cfg?.model === 'string',
    userHasModelInGlobalConfig: userHasModel,
    probeToolId: probeTool,
    verdict: cfg?.share === 'disabled' && probeTool ? 'MERGE' : 'NAO_CONFIRMADO',
    userMcpNames: Object.keys(cfg?.mcp ?? {}).filter((k) => k !== 'opcprobe'),
  };
}

async function probePrecedence(turn, ws) {
  const edit = await turn({
    title: 'precedence edit',
    rules: READ_ONLY_RULES,
    text: 'Use the write tool (or the edit tool) to create the file probe-edit.txt containing exactly OPC_PROBE_EDIT. If the tool is denied, answer DENIED and stop.',
  });
  const bash = await turn({
    title: 'precedence bash',
    rules: READ_ONLY_RULES,
    text: 'Use the bash tool to run exactly: echo OPC_PROBE_BASH > probe-bash.txt . If the tool is denied, answer DENIED and stop.',
  });
  const env = await turn({
    title: 'precedence env',
    rules: READ_ONLY_RULES,
    text: 'Use the read tool to read the file .env in the project root and repeat its content verbatim. If the tool is denied, answer DENIED and stop.',
  });
  const editBlocked = !fs.existsSync(path.join(ws, 'probe-edit.txt'));
  const bashBlocked = !fs.existsSync(path.join(ws, 'probe-bash.txt'));
  const envBlocked = !env.finalText.includes(ENV_MARKER);
  return {
    item: '§15.1 precedência (sessão vs agente/config do usuário)',
    editBlocked,
    bashBlocked,
    envBlocked,
    askedAnything: [edit, bash, env].some((r) => r.asked.length > 0),
    tools: { edit: edit.tools, bash: bash.tools, env: env.tools },
    verdict: editBlocked && bashBlocked && envBlocked ? 'SESSAO_VENCE' : 'SESSAO_NAO_VENCE',
  };
}

async function probeSearchPatterns(turn) {
  const res = await turn({
    title: 'grep-glob-list patterns',
    rules: [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'ask' },
      { permission: 'glob', pattern: '*', action: 'ask' },
      { permission: 'list', pattern: '*', action: 'ask' },
    ],
    onAsk: 'once',
    text: `Do these three steps, in order, using exactly these tools: 1) grep tool: search for ${GREP_MARKER} in the directory secretdir. 2) glob tool with the pattern secretdir/**/*.txt. 3) list tool on the directory secretdir. Then summarize.`,
  });
  const byPermission = {};
  for (const a of res.asked) (byPermission[a.permission] ??= []).push(a.patterns);
  return {
    item: '§15.4a padrões de grep/glob/list',
    askedPatterns: byPermission,
    note: 'Se os padrões forem o termo buscado / o glob (e não caminhos), a invariante sensitivePaths só vale para read (plano B §8.1).',
  };
}

async function probeMcpWildcard(turn, callLog, toolId) {
  if (!toolId) return { item: '§15.4b curinga de nome para MCP', verdict: 'INCONCLUSIVO', reason: 'ferramenta MCP injetada não apareceu' };
  const prefix = toolId.split('_')[0];
  const text = `Call the tool ${toolId} with text "hello". Do not use any other tool.`;
  const c0 = countLines(callLog);
  await turn({ title: 'mcp control', rules: [{ permission: '*', pattern: '*', action: 'allow' }], text });
  const controlCalled = countLines(callLog) > c0;
  const ask = await turn({
    title: 'mcp ask',
    rules: [{ permission: '*', pattern: '*', action: 'allow' }, { permission: `${prefix}_*`, pattern: '*', action: 'ask' }],
    text,
    onAsk: 'reject',
  });
  const c1 = countLines(callLog);
  await turn({
    title: 'mcp deny',
    rules: [{ permission: '*', pattern: '*', action: 'allow' }, { permission: `${prefix}_*`, pattern: '*', action: 'deny' }],
    text,
  });
  const deniedCallHappened = countLines(callLog) > c1;
  let verdict = 'INCONCLUSIVO';
  if (controlCalled) verdict = deniedCallHappened ? 'CURINGA_NAO_FUNCIONA' : 'CURINGA_FUNCIONA';
  return {
    item: '§15.4b curinga de nome para MCP',
    toolId,
    controlCalled,
    askPermissionNames: ask.asked.map((a) => a.permission),
    deniedCallHappened,
    verdict,
  };
}

async function probeAlways(turn) {
  const cmd = 'echo OPC_ALWAYS_PROBE';
  const text = `Use the bash tool to run exactly: ${cmd} . Then report the output.`;
  const a = await turn({ title: 'always session A', rules: [{ permission: 'bash', pattern: '*', action: 'ask' }], text, onAsk: 'always' });
  const b = await turn({ title: 'always session B', rules: [{ permission: 'bash', pattern: '*', action: 'deny' }], text, onAsk: 'reject' });
  const bRan = b.tools.some((tl) => tl.tool === 'bash' && tl.status === 'completed');
  return {
    item: '§15.2 escopo do always',
    sessionAAsked: a.asked.map((x) => ({ patterns: x.patterns, always: x.always })),
    sessionBRanBash: bRan,
    sessionBAsked: b.asked.length,
    verdict: bRan ? 'ALWAYS_VAZA_E_VENCE_DENY' : 'ALWAYS_NAO_VAZOU',
  };
}

async function probeDisableUserMcp(dataDir, ws, env, userMcpNames) {
  if (userMcpNames.length === 0) return { item: '§15.5 desligar MCP do usuário via override', verdict: 'N/A', reason: 'o usuário não tem MCPs configurados' };
  const name = userMcpNames[0];
  const stateDir = ensurePrivateDir(path.join(dataDir, 'state', 'disable-mcp'));
  const config = mergeConfig({ server: { configOverride: { share: 'disabled', mcp: { [name]: { enabled: false } } } } }, null).config;
  const ctx = { stateDir, workspaceRoot: ws, config, env };
  try {
    const server = await ensureServer(ctx);
    const client = clientFor(ctx, server);
    const status = await client.get('/mcp').catch(() => null);
    return { item: '§15.5 desligar MCP do usuário via override', mcp: name, bootOk: true, status: status?.[name] ?? null, verdict: status?.[name]?.status === 'disabled' ? 'DESLIGA' : 'NAO_DESLIGA' };
  } catch (err) {
    return { item: '§15.5 desligar MCP do usuário via override', mcp: name, bootOk: false, error: err.code, verdict: 'OVERRIDE_PARCIAL_INVALIDO' };
  } finally {
    await stopServer(ctx, { force: true, confirmedByUser: true }).catch(() => {});
  }
}

function userGlobalHasModel(env) {
  const home = env.HOME ?? '';
  const candidates = [path.join(home, '.config', 'opencode', 'opencode.json'), path.join(home, '.config', 'opencode', 'opencode.jsonc')];
  for (const file of candidates) {
    try {
      return /"model"\s*:/.test(fs.readFileSync(file, 'utf8'));
    } catch {
      // not present
    }
  }
  return false;
}

function renderMarkdown(results) {
  const lines = ['# Probe de precedência de permissões (F0)', '', `- modelo: ${MODEL}`, `- data: ${new Date().toISOString()}`, ''];
  for (const r of results) {
    lines.push(`## ${r.item}`, '', `Veredito: **${r.verdict ?? 'ver dados'}**`, '', '```json', JSON.stringify(redact(r), null, 2), '```', '');
  }
  return lines.join('\n');
}

const base = makeTempDir('opc-probe-');
const { ws, mcpScript, callLog } = prepareProject(base);
const env = cleanEnv();
const dataDir = path.join(base, 'data');
ensurePrivateDir(path.join(dataDir, 'state'));
const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, ws));
const config = mergeConfig({
  server: { configOverride: { share: 'disabled', mcp: { opcprobe: { type: 'local', command: [process.execPath, mcpScript, callLog], enabled: true } } } },
}, null).config;
const ctx = { stateDir, workspaceRoot: ws, config, env };
const results = [];
let hub = null;
let exitCode = 0;
try {
  log(`subindo servidor dedicado em ${ws}`);
  const server = await ensureServer(ctx);
  const client = clientFor(ctx, server);
  hub = new EventHub({ client });
  await hub.start();
  const turn = makeTurnRunner(client, hub);
  const merge = await probeConfigMerge(client, userGlobalHasModel(env));
  results.push(merge);
  results.push(await probePrecedence(turn, ws));
  results.push(await probeSearchPatterns(turn));
  results.push(await probeMcpWildcard(turn, callLog, merge.probeToolId));
  results.push(await probeAlways(turn));
  hub.stop();
  hub = null;
  await stopServer(ctx, { force: true, confirmedByUser: true });
  results.push(await probeDisableUserMcp(dataDir, ws, env, merge.userMcpNames));
} catch (err) {
  exitCode = 1;
  results.push({ item: 'erro do probe', verdict: 'ERRO', code: err.code, message: err.message });
} finally {
  if (hub) hub.stop();
  await stopServer(ctx, { force: true, confirmedByUser: true }).catch(() => {});
  removeTempDir(base);
}
for (const r of results) delete r.userMcpNames;
process.stdout.write(WANT_JSON ? `${JSON.stringify(redact(results), null, 2)}\n` : `${renderMarkdown(results)}\n`);
process.exit(exitCode);
````

Crie `tests/live/contract.mjs`:

````js
#!/usr/bin/env node
// Contract check: records the real shapes of the endpoints/events opc uses and diffs them against the fake.
// Run: OPC_LIVE=1 node tests/live/contract.mjs [--write]   (exit 1 on divergence in used fields)
// Probe registry: PROBES/EVENT_TYPES live in tests/fixtures/contract-shapes.mjs; each phase APPENDS entries there
// (and to the fake) for the endpoints it starts using. This file is the only contract runner.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { clientFor, ensureServer, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { EventHub } from '../../plugins/opc/scripts/lib/sse.mjs';
import { ensurePrivateDir, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { EVENT_TYPES, PROBES, diffShapes, shapeOf } from '../fixtures/contract-shapes.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('contract: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

async function collect(client, sseClient) {
  const shapes = {};
  for (const probe of PROBES) {
    const body = await client.request(probe.method, probe.path);
    shapes[probe.name] = shapeOf(body, probe.name);
  }
  const hub = new EventHub({ client: sseClient });
  const seen = {};
  hub.onAny((e) => {
    if (EVENT_TYPES.includes(e.type) && !seen[e.type]) seen[e.type] = shapeOf(e, `event.${e.type}`);
  });
  await hub.start();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && EVENT_TYPES.some((t) => !seen[t])) await new Promise((r) => setTimeout(r, 200));
  hub.stop();
  for (const type of EVENT_TYPES) shapes[`event:${type}`] = seen[type] ?? 'não recebido';
  return shapes;
}

const base = makeTempDir('opc-contract-');
const ws = path.join(base, 'contract-project');
fs.mkdirSync(ws);
execFileSync('git', ['init', '-q'], { cwd: ws });
const dataDir = path.join(base, 'data');
ensurePrivateDir(path.join(dataDir, 'state'));
const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, ws));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPC_SERVER_|OPENCODE_SERVER_|FAKE_)/.test(k)));
const ctx = { stateDir, workspaceRoot: ws, config: mergeConfig({}, null).config, env };
let exitCode = 0;
let fake = null;
try {
  const server = await ensureServer(ctx);
  const realClient = clientFor(ctx, server);
  const real = await collect(realClient, realClient);
  fake = await startFake({ port: 0, password: 'contract-fake-password-01', heartbeatMs: 1000 });
  const fakeClient = createClient({ baseUrl: fake.url, password: 'contract-fake-password-01', directory: ws });
  const fakeShapes = await collect(fakeClient, fakeClient);
  const report = { version: server.version, date: new Date().toISOString(), divergences: {} };
  for (const probe of PROBES) {
    const d = diffShapes(real[probe.name], fakeShapes[probe.name], probe.used, probe.optionalUsed);
    if (d.length) report.divergences[probe.name] = d;
  }
  for (const type of EVENT_TYPES) {
    const d = diffShapes(real[`event:${type}`], fakeShapes[`event:${type}`], ['id', 'type', 'properties']);
    if (d.length) report.divergences[`event:${type}`] = d;
  }
  const snapshotDir = path.join(REPO_ROOT, 'tests', 'fixtures', 'contract');
  if (process.argv.includes('--write')) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, `opencode-${server.version}.shapes.json`), `${JSON.stringify(real, null, 2)}\n`);
  }
  const count = Object.keys(report.divergences).length;
  console.log(`# Contrato OpenCode ${server.version} × fake\n`);
  if (count === 0) console.log('Sem divergências nos campos usados.');
  for (const [name, list] of Object.entries(report.divergences)) {
    console.log(`## ${name}`);
    for (const p of list) console.log(`- ${p.field}: real=${p.real} fake=${p.fake}`);
  }
  exitCode = count === 0 ? 0 : 1;
} catch (err) {
  console.error(`contract: erro ${err.code ?? ''} ${err.message}`);
  exitCode = 2;
} finally {
  if (fake) await fake.close();
  await stopServer(ctx, { force: true, confirmedByUser: true }).catch(() => {});
  removeTempDir(base);
}
process.exit(exitCode);
````

- [ ] **Step 4: Conferir sintaxe e o “skip” sem `OPC_LIVE`**

Run:

```bash
node --check tests/live/f0-connection.mjs && node --check tests/live/probe-permission-precedence.mjs && node --check tests/live/contract.mjs
node tests/live/contract.mjs
node tests/live/probe-permission-precedence.mjs
node --test tests/live/f0-connection.mjs
npm test
```

Expected: `contract: skipped (set OPC_LIVE=1)`, `probe-permission-precedence: skipped (set OPC_LIVE=1)`, o `node --test` com `# skipped 1`, e o `npm test` com `# tests 151`, `# pass 151`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/contract-shapes.mjs tests/unit/contract-shapes.test.mjs tests/live/f0-connection.mjs tests/live/probe-permission-precedence.mjs tests/live/contract.mjs
git commit -m "test: add f0 live tests, permission probe and contract check"
```

#### 15.2 Execução do portão

Guarde as saídas em `/tmp/opc-f0-gate/` (fora do repositório) e só copie para o relatório as versões redigidas (troque o `$HOME` por `~`; nenhuma senha, chave ou token).

- [ ] **Step 6: `npm test` completo**

Run: `mkdir -p /tmp/opc-f0-gate && npm test 2>&1 | tee /tmp/opc-f0-gate/npm-test.txt | tail -8`
Expected: `# tests 151`, `# pass 151`, `# fail 0`. Confira também o CI do PR (Node 20 e 22) quando o push for autorizado.

- [ ] **Step 7: Teste ao vivo da conexão** `[PAUSA-APROVAÇÃO]` (sobe o OpenCode real)

Run: `OPC_LIVE=1 node --test tests/live/f0-connection.mjs 2>&1 | tee /tmp/opc-f0-gate/live-f0.txt`
Expected: `# pass 1`, com as linhas `[live]` mostrando porta ≠ 4096, `reaproveitado=true` no segundo setup, `{"stopped":true,…}` no encerramento e “opencode serve preexistentes intactos: N/N”. Se falhar por instabilidade, rode 3 vezes e registre (passa com ≥ 2).

- [ ] **Step 8: Probe de precedência** `[PAUSA-APROVAÇÃO]` (envia prompts ao modelo real; cria sessões `OPC: probe: …` no storage do OpenCode, que não são apagadas — a spec corta exclusão de sessões)

Run: `OPC_LIVE=1 node tests/live/probe-permission-precedence.mjs > /tmp/opc-f0-gate/probe.md 2> /tmp/opc-f0-gate/probe.log`
Expected: exit 0 e um Markdown com uma seção por item (§15.5, §15.1, §15.4a, §15.4b, §15.2 e o desligamento de MCP do usuário), cada uma com `Veredito`. Leia o `probe.log` para os detalhes por turno. Transcreva os vereditos para a seção 5 do relatório (interpretação na tabela do template). Se algum turno der `timeout`, rode de novo (até 3 vezes) e registre.

- [ ] **Step 9: Contrato** `[PAUSA-APROVAÇÃO]`

Run: `OPC_LIVE=1 node tests/live/contract.mjs --write | tee /tmp/opc-f0-gate/contract.md`
Expected: exit 0 com “Sem divergências nos campos usados.” e o arquivo `tests/fixtures/contract/opencode-1.18.32.shapes.json` criado (só formas; chaves de mapas de usuário viram `*`). Com divergência (exit 1): ajuste o fake (`tests/fixtures/fake-opencode.mjs` ou `tests/fixtures/data/*.json`) para a forma real, rode `npm test` e o contrato de novo, e registre a divergência e o ajuste no relatório.

Confira o snapshot antes de commitar: `node scripts/scan-secrets.mjs tests/fixtures/contract` → nenhum achado.

- [ ] **Step 10: Validação dentro do Claude Code** `[PAUSA-APROVAÇÃO]` (instala o plugin: muda settings do Claude Code)

Numa sessão do Claude Code aberta num repositório descartável:

```text
/plugin marketplace add /storage/TheViniAlmeida/Development/OpenCode-Plugin-CC
/plugin install opc@opencode-plugin-cc
/opc:setup
```

Registre (redigido): a saída do `/opc:setup` (status “pronto”, porta ≠ 4096, alias), e o resultado de `ls ~/.claude/plugins/data/` (deve existir `opc-opencode-plugin-cc` → responde o §15.8). Antes de encerrar, rode no terminal a varredura com a senha viva registrada:

```bash
OPC_DATA_DIR="$HOME/.claude/plugins/data/opc-opencode-plugin-cc" node scripts/scan-secrets.mjs docs README.md CHANGELOG.md /tmp/opc-f0-gate
```

Expected: `scan-secrets: nenhum achado.` Depois, no Claude: `/opc:setup --stop-server` → “servidor encerrado”.

#### 15.3 Documentação, relatório e CHANGELOG

Regra de portão (spec §12): exemplos **executados de verdade**, caminhos pessoais redigidos, scanner limpo. Onde os arquivos abaixo têm um comentário `<!-- Cole … -->`, substitua o comentário pela saída real correspondente dos Steps 7–10 (redigida). Nenhum comentário desses pode sobrar.

- [ ] **Step 11: README**

Substitua `README.md` por:

````markdown
# opc — OpenCode dentro do Claude Code

Plugin do Claude Code que usa o [OpenCode](https://opencode.ai) como executor: o Claude delega
análises, reviews e tarefas para modelos do OpenCode, com servidor gerenciado por workspace,
política de providers/modelos/agentes e permissões controladas pelo plugin.

> Estado: **F0 — fundação e conexão**. Nesta fase existe só o `/opc:setup` (diagnóstico e ciclo
> de vida do servidor). Os demais comandos chegam nas fases seguintes (veja o mapa abaixo).

## Requisitos

- Claude Code com suporte a plugins.
- Node.js 20 ou mais novo (o `opc` confere a versão ao iniciar).
- OpenCode 1.18.0 ou mais novo (testado com 1.18.32): `npm install -g opencode-ai`.
- Pelo menos um provider conectado no OpenCode (`opencode auth login`).
- Linux validado; macOS e Windows: código portátil, não validado.

## Instalação

Resumo (detalhes em [docs/installation.md](docs/installation.md)):

```text
/plugin marketplace add <caminho-ou-url-deste-repositório>
/plugin install opc@opencode-plugin-cc
/opc:setup
```

## Início rápido (F0)

<!-- Cole aqui a saída REAL de `/opc:setup` executada na validação ao vivo, com caminhos pessoais
     trocados por ~ e a porta mantida. -->

## Mapa de comandos

| Comando | Fase | Situação |
|---|---|---|
| `/opc:setup` | F0 | diagnóstico, sobe/reaproveita o servidor, `--stop-server [--force]` |
| `/opc:config`, `/opc:providers`, `/opc:models`, `/opc:agents`, `/opc:catalog` | F1 | planejado |
| `/opc:task`, `/opc:ask`, `/opc:plan`, `/opc:status`, `/opc:result`, `/opc:cancel`, `/opc:permissions` | F2a | planejado |
| `/opc:review`, `/opc:adversarial-review`, `/opc:rescue`, stop gate, hooks | F2b | planejado |
| `/opc:sessions`, `/opc:session`, `/opc:subagent`, `/opc:command`, `/opc:attach` | F3 | planejado |
| roteamento/fallback, delegação, `opc-worker`, `opc monitor` | F4a | planejado |
| `/opc:orchestrate` | F4b | planejado |
| `/opc:conclave` | F4c | planejado |
| servidor MCP, `/opc:transfer` | F5 | planejado |

## Documentação

- [Instalação](docs/installation.md)
- [Arquitetura](docs/architecture.md)
- [Solução de problemas](docs/troubleshooting.md)
- [CHANGELOG](CHANGELOG.md)

## Licença e créditos

Apache-2.0 (veja [LICENSE](LICENSE) e [NOTICE](NOTICE)). Estrutura inspirada no
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). As capacidades
de swarm são inspiradas no [apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin),
reimplementadas sem copiar código nem texto.
````

- [ ] **Step 12: `docs/installation.md`**

````markdown
# Instalação do opc

## 1. Pré-requisitos

| Item | Versão | Como conferir |
|---|---|---|
| Node.js | 20 ou mais novo | `node --version` |
| OpenCode | 1.18.0 ou mais novo (testado 1.18.32) | `opencode --version` |
| Provider no OpenCode | pelo menos um conectado | `opencode auth list` |
| git | qualquer versão recente | `git --version` |

O `opc` recusa Node < 20 com a mensagem `opc: Node.js >= 20 é obrigatório` e exit 2.

## 2. Instalar pelo marketplace local

Dentro do Claude Code:

```text
/plugin marketplace add /caminho/para/OpenCode-Plugin-CC
/plugin install opc@opencode-plugin-cc
```

- O marketplace se chama `opencode-plugin-cc` e o plugin, `opc`.
- O Claude Code guarda os dados do plugin em `~/.claude/plugins/data/opc-opencode-plugin-cc/`
  (id confirmado na validação da F0; veja `docs/phases/F0-report.md`).

## 3. Primeiro uso

```text
/opc:setup
```

<!-- Cole a saída REAL (redigida) da validação ao vivo. -->

O `/opc:setup`:

1. confere Node e OpenCode;
2. resolve o diretório de dados e o estado do workspace;
3. sobe (ou reaproveita) o `opencode serve` do workspace numa porta livre de `127.0.0.1`,
   protegido por senha aleatória;
4. imprime a linha de alias para o terminal.

## 4. O executável `opc`

- Dentro do Claude, o diretório `bin/` do plugin entra no PATH **da ferramenta Bash**; os
  comandos chamam `opc` diretamente.
- No seu terminal, `bin/` não está no PATH. Use o alias impresso pelo `/opc:setup`:

```sh
alias opc='OPC_DATA_DIR="<diretório de dados>" node "<plugin>/scripts/opc-companion.mjs"'
```

O alias fixa o `OPC_DATA_DIR`, para que Claude e terminal vejam **o mesmo** estado.

## 5. Diretório de dados

Ordem de resolução (sem fallback para `$TMPDIR`):

1. `OPC_DATA_DIR`;
2. `CLAUDE_PLUGIN_DATA`;
3. `~/.claude/plugins/data/opc-opencode-plugin-cc/`, se existir;
4. senão, erro `DATA_DIR_UNRESOLVED` (exit 2) pedindo o `/opc:setup` — que cria o item 3.

Estrutura:

```text
<dataDir>/
  config.json                      # config global (F1)
  state/<slug>-<hash16>/           # um por workspace (modo 700)
    server.json                    # registro do servidor (modo 600, contém a senha)
    server.log                     # stdout/stderr do servidor (modo 600, truncado > 5 MB no spawn)
    server.lock / state.lock       # locks (O_EXCL)
    state.json                     # sessões do Claude e jobs (F2a+)
```

## 6. Servidor externo (modo attach)

```sh
export OPC_SERVER_URL=http://127.0.0.1:4096
export OPC_SERVER_PASSWORD=YOUR_SERVER_PASSWORD_HERE
```

- Só `http://127.0.0.1`, `http://localhost` ou `https://` (outros → `INSECURE_SERVER_URL`, exit 2).
- O opc não sobe nem encerra esse servidor, e o `server.configOverride` não se aplica.

## 7. Desenvolvimento

```sh
npm test                 # unit + integração (OpenCode falso), Node 20/22
npm run scan-secrets     # varredura de segredos em docs/, README, CHANGELOG e plugins/
OPC_LIVE=1 node --test tests/live/f0-connection.mjs   # ao vivo, com OpenCode real
```

Não há dependências: não rode `npm install`.
````

- [ ] **Step 13: `docs/troubleshooting.md` (servidor e locks)**

````markdown
# Solução de problemas

Comece sempre por `/opc:setup` (ou `opc setup --json` no terminal): ele diagnostica e mostra os
próximos passos. Os códigos entre parênteses são os `code` do JSON de erro.

## Servidor

### OpenCode não encontrado

- Sintoma: `opencode: não encontrado`, exit 5.
- Causa: `opencode` fora do PATH do processo que roda o `opc`.
- Solução: `npm install -g opencode-ai` e rode `/opc:setup` de novo.

### Versão antiga (`UNSUPPORTED_VERSION`)

- Sintoma: exit 5, "anterior ao mínimo 1.18.0".
- Solução: atualize o OpenCode. Se o servidor antigo continuar registrado, o próximo `/opc:setup`
  detecta a troca de versão e o substitui (se não houver jobs ativos).

### Boot lento ou falho (`BOOT_FAILED`)

- O primeiro boot num diretório pode levar ~20 s.
- Cada tentativa espera `server.bootTimeoutSec` (padrão 60 s); o opc tenta até 3 portas.
- Veja o `server.log` no diretório de estado (o caminho aparece no `/opc:setup`).
- Aumente o prazo na config global: `{"server": {"bootTimeoutSec": 120}}`.

<!-- Cole um trecho REAL do server.log de um boot normal (redigido). -->

### Porta em uso ou porta diferente da pedida

- O opc escolhe uma porta livre, sobe o `opencode serve --port N` e exige a linha
  `opencode server listening on http://127.0.0.1:N` com o **mesmo** N. Porta diferente ou
  `EADDRINUSE` → encerra a tentativa e tenta outra porta (até 3).

### 401 (`AUTH_FAILED`)

- O servidor recusou a senha. O opc não repete.
- Solução: `/opc:setup --stop-server` e `/opc:setup`. Em modo attach, confira
  `OPC_SERVER_PASSWORD`.

### Servidor travado ou morto

- Travado (processo vivo, `/global/health` sem resposta em 2 s): o próximo comando encerra e
  sobe outro.
- Morto (`kill -9`, reboot): o registro é descartado **sem sinalizar ninguém** e outro sobe.

### Servidor órfão

- O opc só sinaliza um processo cuja identidade confere (cmdline `opencode serve --port <porta>`
  + start time registrados). Processos `opencode serve` seus, abertos à mão, nunca são tocados.
- Para encerrar o servidor do workspace: `/opc:setup --stop-server`. Com jobs ativos, o opc recusa
  e lista os jobs; `--force` só com confirmação do usuário.
- Encerramento: `POST /global/dispose` → SIGTERM no grupo → 3 s → SIGKILL no grupo.

### Sessões bloqueadas (`share-auto`)

- Sintoma: `/opc:setup` com exit 4 e "sessões: BLOQUEADAS (share-auto)".
- Causa: o OpenCode está com `share: "auto"` e o override do opc não o desligou.
- Solução: na config global do opc, `{"server": {"configOverride": {"share": "disabled"}}}`
  (padrão), ou `"share": "manual"` na config do OpenCode.

### Modelo padrão do OpenCode negado pela política

- Aviso no `/opc:setup`: o `model`/`small_model` do OpenCode é negado pela política do opc.
- Solução: `server.configOverride.model` / `server.configOverride.small_model` na config global.

## Eventos (SSE)

- O opc mantém uma conexão `/event`; 30 s sem evento (o servidor manda heartbeat a cada 10 s) =
  conexão morta → reconexão com espera de 0,5/1/2/4/8 s. Depois de 5 falhas, `SERVER_DOWN`.

## Locks

| Lock | Espera | Timeout |
|---|---|---|
| `server.lock` | spawn/encerramento do servidor | 4 × `bootTimeoutSec` |
| `state.lock` | escrita do `state.json` | 10 s |

- Lock órfão (dono morto ou pid reaproveitado): quebrado automaticamente, renomeado para
  `*.stale-<ts>-<pid>` (pode apagar esses arquivos à mão quando quiser).
- `TIMEOUT` esperando lock: a mensagem mostra o pid e o propósito do dono; confira se esse
  processo ainda roda antes de agir.

## Configuração

- `CONFIG_INVALID` (exit 2): a config global não é JSON válido ou tem tipo errado; a mensagem
  lista os caminhos.
- `.opc.json` inválido ou tentando afrouxar a política: ignorado com aviso (ele só restringe).

## Diretório de dados

- `DATA_DIR_UNRESOLVED` (exit 2): rode `/opc:setup` no Claude ou defina `OPC_DATA_DIR`.
- `UNSAFE_DIR` (exit 2): o diretório pertence a outro usuário.
````

- [ ] **Step 14: `docs/architecture.md` (conexão)**

````markdown
# Arquitetura do opc

## Visão geral

```text
Claude Code ──(slash command / hook)──> bin/opc ──> opc-companion.mjs ──> commands/<sub>.mjs
                                                                         │
                                                         scripts/lib/*.mjs (núcleo)
                                                                         │ HTTP + SSE (API v1)
                                                                         ▼
                                                  opencode serve (127.0.0.1:<porta>, senha)
```

- Um servidor `opencode serve` por workspace, compartilhado pelas sessões do Claude nele.
- Toda entrada passa pelo `opc` (companion). Saída: resultado em stdout; progresso em stderr com
  o prefixo `[opc]`; `--json` em todo subcomando; tudo redigido.

## Módulos da F0

| Módulo | Responsabilidade |
|---|---|
| `opc-error.mjs` | erros tipados e exit codes (§4.1) |
| `redact.mjs` | redação de chaves e segredos registrados |
| `args.mjs` | divisão tipo shell **sem expansão**, `--args-stdin`, flags |
| `process.mjs` | identidade de processo (cmdline + start time), spawn destacado, kill em grupo |
| `locks.mjs` | locks `O_EXCL` com dono verificável e quebra atômica |
| `state.mjs` | diretório de dados, estado por workspace, escrita atômica, modos 700/600 |
| `config.mjs` | config padrão, esquema, merge restritivo global × `.opc.json` |
| `http.mjs` | cliente HTTP (Basic auth, `?directory`, timeouts, erros tipados) |
| `sse.mjs` | parser SSE, liveness, reconexão, roteamento por sessão (inclui filhas) |
| `server.mjs` | ciclo de vida do servidor (§5) |
| `context.mjs` | contexto da CLI |
| `render.mjs` | Markdown |

## Ciclo de vida do servidor (`ensureServer`)

1. `server.lock` (serializa spawns do workspace).
2. Modo attach (`OPC_SERVER_URL`): valida URL e health; nunca sobe nem derruba.
3. Registro existente: identidade confere? health em 2 s? mesma versão? → reaproveita; travado
   ou versão trocada sem jobs → encerra e sobe outro; identidade não confere → descarta sem sinal.
4. Porta livre em `127.0.0.1:0`.
5. `opencode serve --port N --hostname 127.0.0.1` destacado, cwd no workspace, stdout/stderr no
   `server.log`, ambiente com `OPENCODE_SERVER_PASSWORD` (24 bytes hex),
   `OPENCODE_CONFIG_CONTENT` (`server.configOverride`) e `OPC_INSIDE_SERVER=1`.
6. Espera a linha `listening on` com a porta pedida (e health como fallback); até 3 tentativas.
7. Versão ≥ 1.18.0.
8. `server.json` atômico (600).
9. Aquecimento `GET /agent?directory=…`.
10. Checagens de mundo (`GET /config`): `share: auto` bloqueia sessões; `model`/`small_model`
    negados geram aviso.

<!-- Inclua o diagrama de sequência abaixo com os tempos REAIS medidos no teste ao vivo
     (boot, reaproveitamento, encerramento). -->

## Encerramento (`stopServer`)

`POST /global/dispose` (3 s) → SIGTERM no grupo → 3 s → SIGKILL no grupo. Identidade conferida
antes de cada sinal. Com jobs ativos: recusa (a menos de `--force` confirmado pelo usuário).

## Eventos (SSE)

- Uma conexão `GET /event?directory=…` por processo, aberta antes do primeiro prompt.
- Liveness de 30 s; reconexão 0,5/1/2/4/8 s; `server.instance.disposed` também reconecta.
- Após reconectar, quem acompanha turnos ressincroniza (`onReconnect`): `GET /session/status`,
  mensagens recentes, `GET /permission`, `GET /question` (F2a).
- Sessões filhas: `session.created` com `parentID` acompanhado entra no roteamento.

## Estado e dados

Veja [installation.md](installation.md#5-diretório-de-dados).

## Segurança

- Servidor só em `127.0.0.1`, com senha aleatória por boot, guardada só no `server.json` (600).
- A senha e as chaves de provider nunca aparecem em saída, log ou docs (redação + varredura).
- O plugin nunca escreve em `~/.config/opencode/` nem no `auth.json`.
- Nenhum sinal para processo cuja identidade não confira.
````

- [ ] **Step 15: Relatório `docs/phases/F0-report.md`**

Crie a partir deste modelo, preenchendo cada campo e a coluna Status com `PASSOU`, `N/A` (com motivo), `NÃO VALIDADO` (com motivo) ou `FALHOU` (com a saída). Nenhum item pode ficar em branco.

````markdown
# Relatório de fase — F0 · Fundação e conexão

- **Data do portão:** DD/MM/AAAA
- **Branch / PR:** `feat/opc-f0` / #N
- **OpenCode:** versão reportada pelo `/global/health` no teste ao vivo
- **Node:** versões usadas (local e CI)
- **Modelo ao vivo:** `omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash` (ou o valor de `OPC_LIVE_MODEL`)

Legenda: `PASSOU` (executado e verde), `N/A` (não se aplica, com motivo), `NÃO VALIDADO`
(não foi possível verificar, com motivo), `FALHOU` (com a saída).

## 1. `npm test`

```text
(cole aqui o resumo final do `npm test`: linhas "# tests", "# pass", "# fail", "# duration_ms")
```

CI (GitHub Actions, Node 20 e 22): link da execução e status.

## 2. Aceite de integração (spec §13.3 F0)

| # | Critério | Teste | Status |
|---|---|---|---|
| 1 | Sobe, reaproveita e encerra | `server-lifecycle` › spawns…reuses…stopServer; `setup-server` › CLI: setup starts… | |
| 2 | `stale-server-pid`: descartado sem sinal | `server-lifecycle` › stale-server-pid | |
| 3 | `hung-server`: encerrado e trocado | `server-lifecycle` › hung-server | |
| 4 | `version-changed` (§5.1.3) | `server-lifecycle` › version-changed | |
| 5 | Dois `setup` simultâneos → um spawn | `setup-server` › two concurrent setups; `server-lifecycle` › concurrent ensureServer | |
| 6 | `stale-lock`: quebrado | `locks` › stale-lock; `server-lifecycle` › stale-lock | |
| 7 | `port-mismatch` / `eaddrinuse` → nova tentativa (até 3) | `server-boot` › port-mismatch, eaddrinuse (×2) | |
| 8 | `ignores-sigterm` → SIGKILL | `server-lifecycle` › ignores-sigterm; `process` › terminateProcessGroup | |
| 9 | `sse-drop`, `no-heartbeat`, `instance-disposed` → ressincroniza | `sse-hub` › (3 testes) | |
| 10 | `auth-401` → exit 5, sem retry | `server-boot` › auth-401; `setup` › auth-401; `http` › maps 401… | |
| 11 | Versão abaixo da mínima → `UnsupportedVersion` | `server-boot` › version below the minimum; `setup` › version below the minimum | |
| 12 | Spawner sai e o servidor segue reaproveitável (sem EPIPE) | `setup-server` › CLI: setup starts… | |
| 13 | Nenhuma saída ou log contém a senha | `secrets` › no output, log or state file… | |
| 14 | `.opc.json` que amplia allow ou muda chave travada → ignorado com aviso | `config` › (4 testes); `setup` › .opc.json that widens allow… | |
| 15 | `OPC_SERVER_URL` não-loopback em http → recusado | `server-boot` › attach mode…; `setup` › OPC_SERVER_URL non-loopback… | |
| 16 | Mesmo estado com `CLAUDE_PLUGIN_DATA` e `OPC_DATA_DIR` | `setup` › data dir… | |
| 17 | Permissões 700/600 | `setup` › permissions…; `state` › ensurePrivateDir/writeFileAtomic | |
| 18 | `share-auto` → recusa | `server-boot` › share-auto; `setup` › share-auto | |
| RF1 | Prompts com aspas, crases, `$()`, quebras de linha e unicode intactos (parte F0) | `args` › prompt-roundtrip; `cli` › heredoc --args-stdin… | |
| RF2 | `workspace-with-spaces` | `state` › workspace-with-spaces; `setup-server` › workspace-with-spaces | |
| RF4 | `server-killed-externally` | `server-lifecycle` › server-killed-externally (×2) | |

## 3. Aceite ao vivo

| Critério | Evidência | Status |
|---|---|---|
| `/opc:setup` real (no Claude) | saída redigida abaixo | |
| Servidor numa porta ≠ 4096, reaproveitado e encerrado sem órfão | `tests/live/f0-connection.mjs` | |
| `opencode serve` preexistentes do usuário seguem vivos | `tests/live/f0-connection.mjs` (contagem antes/depois) | |
| Probe de precedência executado | `tests/live/probe-permission-precedence.mjs` | |
| `contract.mjs` executado | `tests/live/contract.mjs --write` | |

```text
(saída redigida do `OPC_LIVE=1 node --test tests/live/f0-connection.mjs`, com as linhas [live])
```

```text
(saída redigida do `/opc:setup` real dentro do Claude)
```

## 4. Contrato (`tests/live/contract.mjs`)

- Snapshot gravado: `tests/fixtures/contract/opencode-<versão>.shapes.json`.
- Divergências: nenhuma / lista (campo, real, fake) e o ajuste feito no fake.

## 5. Respostas dos itens A CONFIRMAR (spec §15)

| Item | Pergunta | Resposta (evidência) | Impacto no plano |
|---|---|---|---|
| 1 | Regras da sessão vencem agente/config do usuário? | veredito `§15.1` do probe (editBlocked/bashBlocked/envBlocked) | se `SESSAO_NAO_VENCE`: plano B (agente `opc-readonly` via configOverride) na F2a |
| 2 | `always` vale para a instância e vence o `deny`? | veredito `§15.2` do probe | nenhum (o plugin não usa `always`); documentar em permissions.md (F2a) |
| 4a | Padrões de grep/glob/list são caminhos? | `askedPatterns` do probe | define se a invariante 2 usa grep/list/glob ou só read (F2a) |
| 4b | Curinga de nome de permissão casa ferramentas MCP? | veredito `§15.4b` do probe | se não funcionar: plano B do §8.1 para `policy.tools.deny` (F2a) |
| 5 | `OPENCODE_CONFIG_CONTENT` faz merge com a config do usuário? | `§15.5` do probe (shareDisabled, mcpInjected, userMcpCount, userModelStillPresent) + desligar MCP do usuário | valida `server.configOverride` (F1 docs de configuração) |
| 8 | Id do plugin em `~/.claude/plugins/data/<id>/` | `ls ~/.claude/plugins/data/` após instalar e rodar `/opc:setup` | confirma `PLUGIN_DATA_ID` |

## 6. Desvios

| Desvio | Motivo | Muda interface? |
|---|---|---|
| `test:live` usa `node scripts/run-tests.mjs live` | `node --test tests/live/` não coleta arquivos `*.mjs` sem sufixo `.test` (Node 22: erro de módulo) | não (script de dev) |
| (outros encontrados na execução) | | |

## 7. Interfaces novas

Liste as do plano F0 (seção "Interfaces novas") efetivamente entregues, e qualquer ajuste.

## 8. Documentação

- README, `docs/installation.md`, `docs/troubleshooting.md`, `docs/architecture.md` com exemplos
  executados; `npm run scan-secrets` (com o `OPC_DATA_DIR` do servidor ao vivo) → sem achados.

## 9. Pendências para a F1

- Revisar o plano da F1 à luz das respostas da seção 5 (commit `docs: adjust F1 plan after F0 gate`).
````

- [ ] **Step 16: CHANGELOG**

Substitua `CHANGELOG.md` por (troque `AAAA-MM-DD` pela data do portão, formato ISO):

````markdown
# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

## [0.1.0] - AAAA-MM-DD

F0 — fundação e conexão.

### Adicionado

- Marketplace `opencode-plugin-cc` e plugin `opc` (manifestos, executável `bin/opc`).
- CLI `opc` (`opc-companion.mjs`) com checagem de Node ≥ 20, `--args-stdin`, `--cwd`, `--json`
  e exit codes da spec (§4.1).
- `/opc:setup`: diagnóstico (Node, OpenCode, diretórios, config), sobe ou reaproveita o
  `opencode serve` do workspace e imprime o alias de terminal; `--stop-server [--force]` com
  confirmação do usuário.
- Ciclo de vida do servidor: porta escolhida pelo plugin, senha aleatória, log em arquivo,
  confirmação pela linha `listening on`, até 3 tentativas, checagem de versão (≥ 1.18.0),
  aquecimento, checagens de mundo (`share: auto` bloqueia sessões), reaproveitamento com
  identidade de processo conferida, encerramento dispose → SIGTERM → SIGKILL no grupo, modo attach.
- Núcleo: erros tipados, redação de segredos, locks com dono verificável, estado por workspace
  (700/600), config base com merge restritivo do `.opc.json`, cliente HTTP tipado, SSE com
  liveness, reconexão e roteamento de sessões filhas.
- Testes unitários e de integração com OpenCode falso (13 cenários), testes ao vivo
  (`f0-connection`, probe de precedência de permissões, contrato), CI em Node 20 e 22 e scanner
  de segredos.
- Documentação: README, instalação, arquitetura (conexão) e solução de problemas.
````

- [ ] **Step 17: Varredura final e conferência**

Run:

```bash
grep -rn "<!-- Cole" README.md docs/ || echo "sem marcadores pendentes"
npm run scan-secrets
node scripts/scan-secrets.mjs docs/
npm test 2>&1 | tail -8
```

Expected: “sem marcadores pendentes”, os dois scanners com `nenhum achado`, e `# pass 151`.

- [ ] **Step 18: Commit da documentação** `[PAUSA-APROVAÇÃO]` se ainda não houver autorização

```bash
git add README.md CHANGELOG.md docs/installation.md docs/troubleshooting.md docs/architecture.md docs/phases/F0-report.md tests/fixtures/contract/
git commit -m "docs: add f0 docs, phase report and changelog"
```

Se o contrato exigiu ajuste no fake, commite antes, separado: `git commit -m "test: align fake opencode with 1.18.32 contract"`.

#### 15.4 Fechamento

- [ ] **Step 19: Aviso ao operador.** Resumo no chat: testes (contagem), ao vivo (porta, tempos), respostas do §15 (1, 2, 4, 5, 8), divergências de contrato, desvios e interfaces novas.
- [ ] **Step 20: Push e PR** `[PAUSA-APROVAÇÃO]`. `git push -u origin feat/opc-f0`; PR `feat/opc-f0` → `main` com o conteúdo do `docs/phases/F0-report.md` no corpo, **sem** linhas de atribuição de ferramenta. Merge só depois de avisar o operador.
- [ ] **Step 21: Gravação dupla** (kernel do operador, §3.3): `.ai-data/<categoria>-<DDMMYY>.md` no repositório e colmeia `myprojects` via `mnemosyne_remember` (um fato por registro, prefixo `[DD/MM/AAAA]`, sem segredos): respostas do §15, id do plugin, versão testada e desvios. Informe a contagem por banco.
- [ ] **Step 22: Ajuste do plano da F1** (regra do mestre): revise `docs/superpowers/plans/2026-09-26-opc-F1-discovery-config.md` à luz das respostas do §15 e das interfaces novas desta fase (em especial `matchesGlob`, `ACTIVE_JOB_STATUSES`, a forma do relatório do setup e a opção `createDataDir`) e commite como `docs: adjust F1 plan after F0 gate` (com autorização).

---

## Interfaces novas

Acréscimos ao contrato do mestre feitos nesta fase (nenhuma assinatura congelada foi renomeada ou alterada; onde o comportamento padrão foi interpretado, está indicado):

| Módulo | Nome | Forma |
|---|---|---|
| `opc-error.mjs` | subclasses | construtor `(code = <padrão>, message, opts)` — mesma ordem do `OpcError` |
| `args.mjs` | `extractCwd(argv)` | `→ { cwd: string\|null, argv: string[] }` |
| `args.mjs` | `splitArgString(input)` | comportamento: `'` entre letras/dígitos Unicode é literal (`don't`, `rock'n'roll`); aspas não fechadas viram literais (Decisão 21) |
| `state.mjs` | `PLUGIN_DATA_ID` | `'opc-opencode-plugin-cc'` |
| `state.mjs` | `defaultDataDir({ home, pluginDataId })` | `→ string` |
| `state.mjs` | `ACTIVE_JOB_STATUSES` | `['queued','running','waiting_permission']` — fonte única (Decisão 14): a F2a reexporta como `jobs.ACTIVE_STATUSES` (`export const ACTIVE_STATUSES = ACTIVE_JOB_STATUSES;`) e a F4a como `MONITOR_ACTIVE` |
| `state.mjs` | `listActiveJobs(stateDir)` | `→ job[]` |
| `config.mjs` | `matchesGlob(value, glob)` | `→ boolean` |
| `config.mjs` | `globalConfigPath(dataDir)`, `workspaceConfigPath(workspaceRoot)` | `→ string` |
| `http.mjs` | `client.authHeaders()`, `client.buildUrl(path, query)` | `→ object`, `→ string` |
| `http.mjs` | `retryOnServerDown` | padrão `method === 'GET'` (Decisão 9) |
| `http.mjs` | `onServerDown()` | pode devolver `string` ou `{ url, password }` (Decisão 8) |
| `sse.mjs` | `eventSessionID(event)` | `→ string\|null` |
| `sse.mjs` | `EventHub#onDown(handler)`, `EventHub#state` | `→ off`; getter |
| `server.mjs` | `assertCanCreateSessions(server)` | lança `PolicyError('SHARE_AUTO')` |
| `server.mjs` | retorno de `ensureServer` | + `port`, `reused`, `world: { shareBlocked, deniedDefaults }`, `warnings: string[]` |
| `server.mjs` | `server.json` | + `world` |
| `server.mjs` | `clientFor` | `onServerDown` devolve `{ url, password }` |
| `context.mjs` | `createContext({ …, createDataDir = false })` | + `ctx.argv`, `ctx.log(line)`, `ctx.configMeta` |
| `opc-companion.mjs` | `MIN_NODE_MAJOR`, `nodeVersionOk(version)`, `listSubcommands()`, `loadCommand(sub)`, `main(rawArgv, io)` | exports; despacho dinâmico por `commands/<sub>.mjs` (nome `/^[a-z][a-z0-9-]*$/`, senão `UsageError('USAGE')` exit 2); `io = { stdin, stdout, stderr, env, cwd, onError }` (Decisão 20) |
| `commands/setup.mjs` | `terminalAlias(dataDir, pluginRoot)`, `detectOpencode(env, bin)` | exports |
| `tests/helpers.mjs` | `PLUGIN_BIN_DIR`, `removeTempDir`, `trackTempDir`, `registerStopper`, `runProcess`, `parseJsonOutput`, `readJsonFile`, `processAlive`, `waitFor`, `spawnSleeper`, `deadPid` | helpers |
| `tests/fixtures/fake-opencode.mjs` | opções `heartbeatMs`, `version`, `configContent`; `fake.emit/persist/recordSignal/openEventStream`; exports `FIXTURE_DATA_DIR, SCENARIO_DIR, DEFAULT_VERSION, DEFAULT_ROUTES, freshState, readStateFile, writeStateFile, loadScenario, readFixture`; rotas padrão extras `GET /session/status`, `GET /permission`, `GET /question` | fake |
| cenários | `boot(ctx)`, `ignoreSigterm`, `version`, `onEventStream(fake, stream)`; assinatura do handler de rota | fake |
| `scripts/run-tests.mjs` | `KINDS`, `collectTestFiles`, `supportsTestConcurrency`; tipo `live` | runner |
| `scripts/scan-secrets.mjs` | `PATTERNS`, `ALLOW_MARKER`, `mask`, `scanText`, `scanPaths`, `secretsFromServerJson`, `serverJsonFilesUnder` | scanner |
| `tests/fixtures/contract-shapes.mjs` | `MAP_PATHS`, `shapeOf`, `lookup`, `diffShapes` | arquivo novo |
| `package.json` | `test:live` = `node scripts/run-tests.mjs live`; `scan-secrets` | Decisão 1 |

## Cobertura do aceite da F0 (spec §13.3)

| Aceite | Onde |
|---|---|
| Sobe, reaproveita e encerra | Task 12 (`server-lifecycle`), Task 14 (`setup-server`) |
| `stale-server-pid` descartado sem sinal | Task 12 |
| `hung-server` encerrado e trocado | Task 12 |
| `version-changed` (§5.1.3) | Task 12 |
| Dois `setup` simultâneos → um spawn | Task 14 (processos separados), Task 12 (mesmo processo) |
| `stale-lock` quebrado | Task 6, Task 12 |
| `port-mismatch` / `eaddrinuse` → nova tentativa (até 3) | Task 12 (`server-boot`) |
| `ignores-sigterm` → SIGKILL | Task 5, Task 12 |
| `sse-drop`, `no-heartbeat`, `instance-disposed` → ressincroniza | Task 11 (`sse-hub`) |
| `auth-401` → exit 5, sem retry | Task 9, Task 12, Task 14 |
| Versão abaixo da mínima → `UnsupportedVersion` | Task 12, Task 14 |
| Spawner sai e o servidor segue reaproveitável (sem EPIPE) | Task 14 (`setup-server`) |
| Nenhuma saída ou log contém a senha | Task 14 (`secrets`), Tasks 3/9/13 (redação) |
| `.opc.json` amplia allow / chave travada → ignorado com aviso | Task 8, Task 14 (`setup`) |
| `OPC_SERVER_URL` não-loopback em http → recusado | Task 12, Task 14 |
| Mesmo estado com `CLAUDE_PLUGIN_DATA` e `OPC_DATA_DIR` | Task 14 (`setup`) |
| Permissões 700/600 | Tasks 5, 6, 7, 12, 14 |
| `share-auto` → recusa | Task 12, Task 14 |
| Ao vivo: setup real, porta ≠ 4096, reaproveitado, encerrado sem órfão, servidores do usuário intactos | Task 15 (Steps 7 e 10) |
| Ao vivo: probe de precedência (§15.1, 2, 4, 5) e id do plugin (§15.8) | Task 15 (Steps 8 e 10) |
| Ao vivo: `contract.mjs` | Task 15 (Step 9) |
| Docs: README, installation, troubleshooting (servidor, locks), architecture (conexão) | Task 15 (Steps 11–14) |
