# opc F1 — Descoberta, configuração e onboarding · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a descoberta (providers, modelos, agentes, commands, skills), a config completa com merge restritivo e chaves travadas, e o onboarding pelas três portas (guiado no Claude, assistente de terminal e `opc config` não interativo).

**Architecture:** Módulos puros novos (`api` leitura, `models`, `policy` allow/deny, `onboarding`, `tty`) e a conclusão do `config` do F0; os subcomandos `providers`, `models`, `agents`, `catalog`, `config` e as extensões do `setup` só compõem esses módulos, abrem a conexão com `connectApi(ctx)` e renderizam com `render.mjs`. O onboarding grava um rascunho (`config.draft.json`) passo a passo e faz um commit atômico validado contra o servidor e a política. Os testes de integração rodam a CLI real contra o servidor falso, com fixtures derivadas da OpenAPI 1.18.32.

**Tech Stack:** Node.js ≥ 20 (ESM `.mjs`, `node:test`, `node:readline`), zero dependências, OpenCode 1.18.32 (API v1: `GET /provider`, `/agent`, `/command`, `/skill`, `/config`).

**Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3) — §3.2 (esquema e merge restritivo), §3.3 (onboarding e chaves travadas), §4 (comandos da F1), §6 (IDs, aliases, validação, modelos fixados, política), §13.3 (aceite da F1).
**Mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` — estrutura de arquivos, contrato de interfaces, convenções de teste, regras de git e portão. Quem executa lê os três.

---

## Ajustes pós-F0 (26/09/2026 — obrigatório ler antes de qualquer tarefa)

A F0 foi implementada e revisada (merge `de234b4`). As rodadas de revisão mudaram comportamentos em relação ao código original do plano da F0. Onde o código desta fase conflitar com a lista abaixo, **vale o código real da `main`** (leia o módulo antes de estendê-lo) e esta lista:

- **Heredoc:** o delimitador canônico é `OPC_ARGS_5f1d0c7a_EOF` (e `OPC_JSON_5f1d0c7a_EOF` para JSON). Todas as ocorrências deste plano já foram trocadas.
- **`args`:** flag de valor seguida de outra flag → `UsageError`; flag desconhecida com um só hífen (`-x`) → `UsageError`; lookup via `Object.hasOwn`; mensagens de erro ecoam no máximo 12 caracteres do token + `…`.
- **`state.readJson(file, fallback)`:** só `ENOENT` devolve o fallback; JSON inválido → `OpcError INVALID_JSON` (exit 2); outro erro de I/O → `READ_FAILED` (exit 5). `loadState` pode trazer `rebuildWarnings` e faz backup+reconstrução também para estrutura inválida. `resolveWorkspaceRoot` lança `WORKSPACE_UNRESOLVED` em falhas de git que não sejam "não é repositório"/git ausente.
- **`config.loadConfig`:** arquivo existente cujo conteúdo não é objeto → `CONFIG_INVALID`; arquivo ilegível → erro (não é ignorado). `validateConfigShape` valida os tipos dos contêineres de `policy`. O merge de `allow` da F0 usa contenção de globs (conservador); a decisão D desta fase (allow + allowWorkspace) o substitui.
- **`redact`:** substituição do segredo mais longo para o mais curto; `Error.code`/`Error.name` também são redigidos. `renderTable` redige cada célula **antes** de qualquer transformação.
- **`http`:** só falhas genuínas de conexão viram `SERVER_DOWN` (e disparam `onServerDown`); outras exceções viram `RequestError CLIENT_ERROR`. O token Basic (base64) também é segredo registrado.
- **`process`/`locks`:** `spawnDetached` lança `SPAWN_FAILED` se não conseguir ler a identidade; `terminateProcessGroup` confirma o grupo inteiro (`KILL_UNCONFIRMED`); locks publicados por `link()` com recuperação serializada por `<lock>.break` (`LOCK_RESTORE_FAILED`).
- **`server`:** falha ou corpo inválido em `GET /config` bloqueia sessões (`world.shareBlocked`, `world.shareReason: 'config-unavailable'`), reavaliado a cada `ensureServer`; `server.json` sem senha é inválido; `stopServer` encerra por identidade mesmo sem senha.
- **Companion:** erros em modo `--json` sempre saem como objeto JSON, mesmo erros de parsing; subcomando desconhecido é ecoado truncado.
- **Testes:** `makeServerCtx(t, …)` em `tests/helpers.mjs`; a limpeza exige parada confirmada (`stopped`, `attached` ou `not-running` verificado pelos boots do fake) e preserva o diretório se falhar; o scanner aceita o marcador `scan-secrets:allow` na linha.
- **Contrato:** `tests/fixtures/contract-shapes.mjs` usa `CONFIG_USED_FIELDS` e a allowlist `KNOWN_CONFIG_PROPS`; mapas de permissão sempre colapsados. Ao acrescentar as sondas desta fase (`/provider`, `/command`, `/skill`), **colapse sempre as chaves de mapas de IDs** (`provider.*.models`, catálogos de agentes/commands/skills) para `*` — nomes de modelos/agentes do operador nunca podem entrar no snapshot público.
- **Execução:** implementadores rodam no sandbox do Codex (sem `listen` em sockets, `.git` somente leitura); o controlador roda a suíte completa fora do sandbox e faz os commits.

## Global Constraints

- Node ≥ 20 (`engines: {"node": ">=20"}`); CI em Node 20 e 22.
- Zero dependências de runtime; `devDependencies` também vazias (nada de `npm install`).
- Código, identificadores, mensagens de commit e nomes de arquivo em inglês. Docs e textos voltados ao usuário em PT-BR.
- OpenCode mínimo `1.18.0`; alvo testado `1.18.32`; só a API v1, nunca `/api/*`.
- A senha do servidor e as chaves de provider nunca aparecem em stdout, stderr, logs, docs ou fixtures commitadas (as fixtures usam valores falsos `FIXTURE-*` justamente para provar a redação).
- O plugin nunca escreve em `~/.config/opencode/` nem no `auth.json` do OpenCode.
- Diretórios de estado com modo 700 e arquivos com modo 600 (inclui `config.json` e `config.draft.json`).
- Exit codes conforme a spec, §4.1: `0, 2, 3, 4, 5, 6, 7, 130` (na F1: 0, 2, 4, 5).
- Namespace de comandos `/opc:`; executável `opc`; argumentos do usuário sempre por heredoc com delimitador entre aspas, conforme a convenção única entre fases: comandos só de flags/ids (todos os da F1: `setup`, `config`, `providers`, `models`, `agents`, `catalog`) → `--args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'` (divisão tipo shell sem expansão); JSON do `setup apply` → `--stdin <<'OPC_JSON_5f1d0c7a_EOF'` (D5); texto livre (a partir da F2a: `task`, `ask`, `plan`, …) → `--raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'`, fora do escopo da F1.
- Todo JSON e todo log passam por redação (`redact`): por isso **nenhuma view JSON usa uma propriedade chamada `key`** (o `redact()` do F0 mascara qualquer campo `key`); o nome de uma chave de config vai em `setting`.
- Testes ao vivo só com `OPC_LIVE=1`, nunca no CI, sempre em diretório descartável; modelo da F1: `omniroute-mvalmeida/opencode-go/kimi-k3`.
- Git: branch `feat/opc-f1`; Conventional Commits; **sem** `Co-Authored-By`/`Signed-off-by`/"Generated with"; commit, push e PR só com autorização explícita do operador na sessão de execução. Sem ela, os passos "Commit" ficam pendentes e o trabalho segue acumulado na branch.

## Review Focus

Entradas e condições que a spec implica e que mais provavelmente quebram o uso real da F1. Cada linha tem teste na tarefa dona.

1. **IDs de modelo com várias barras e prefixos ambíguos** (`opencode/big-pickle` é provider `opencode` *e* nome curto em `omniroute-mvalmeida/opencode/big-pickle`): nunca escolher em silêncio; erro `AMBIGUOUS_MODEL` (exit 2) com os dois candidatos, `=` força a leitura completa, e IDs já gravados são relidos sem prefixo. [Task 3 · `models.test.mjs`; Task 11 · `config-cli.test.mjs` "model ids"]
2. **Primeiro uso sem config nenhuma** (Review Focus 3 do mestre): descoberta, `config show/get/validate/path` e `setup --json` funcionam com os padrões; erros de edição são claros (exit 2/4), sem stack trace e sem gravar nada. [Task 13 · `no-config-first-run.test.mjs`]
3. **Texto do usuário com aspas, `$()`, crases e apóstrofos** em `config set` (via `--args-stdin`; apóstrofos sem aspas, como `can't-won't`, ficam literais graças à regra do `splitArgString` da F0 — `'` entre letras/dígitos nunca abre aspas) e no payload do onboarding (via `setup apply --stdin`): gravado literalmente, nada executado. [Task 11 · `config-cli.test.mjs` "arguments via --args-stdin"; Task 13 · `onboarding.test.mjs` "guided flow"]
4. **Rascunho velho ou corrida do bootstrap** (uma config global surge entre o `apply` de uma chave travada e o `commit`): o commit recusa com `LOCKED_KEY` (exit 4) e imprime o comando de terminal; rascunho corrompido é tratado como ausente. [Task 8 · `onboarding.test.mjs`; Task 13 · `onboarding.test.mjs` "bootstrap race"]
5. **Segredos na entrada**: `key`/`options.apiKey`/`headers` de `/provider` e chaves com cara de segredo na própria config (`server.configOverride…apiKey`) nunca aparecem em JSON ou texto, e o `config validate` avisa. [Task 9 · `render-f1.test.mjs`; Task 10 · `discovery.test.mjs`; Task 11 · `config-cli.test.mjs` "validate"]

---

## Premissas sobre o F0 (verificadas na Task 1, passo 1)

A F1 consome o contrato congelado do mestre. Onde o contrato não fixa um detalhe, este plano assume o seguinte; a Task 1 confere cada item antes de qualquer código. Se algum não valer, **pare**, ajuste só a cola indicada e registre no relatório da fase (regra de ajuste entre fases do mestre).

| # | Premissa | Onde a F1 depende |
|---|---|---|
| P1 | `UsageError`, `PolicyError`, `ConnectionError` e `NotFoundError` usam a assinatura de `OpcError`: `new UsageError(code, message, { details })`, com `exitCode` fixo (2, 4, 5, 2) e `err.code` = o `code` passado | todos os módulos da F1 |
| P2 | `createContext` devolve `ctx.config` (config **efetiva** de `loadConfig`), `ctx.configWarnings`, `ctx.dataDir`, `ctx.workspaceRoot`, `ctx.stateDir`, `ctx.env`, `ctx.stdin/stdout/stderr`, `ctx.out/err/json`; aceita `stdin/stdout/stderr` injetados | comandos, `runInProcess` |
| P3 | `loadConfig` chama `mergeConfig` e `validateConfigShape` **do próprio módulo** (a F1 troca as duas e o efeito aparece em `loadConfig`) | Task 5 |
| P4 | `saveGlobalConfig`/`saveWorkspaceConfig` gravam com `writeFileAtomic` (global com modo 600) | Tasks 8, 11 |
| P5 | `scripts/commands/setup.mjs` exporta `run(ctx, argv)` e imprime o resultado final com **uma** chamada de `ctx.json` (com `--json`) ou `ctx.out` | Task 13 |
| P6 | **Garantida pela F0** (Decisão 20 da F0; reconciliação D11): o dispatcher resolve `./commands/<sub>.mjs` dinamicamente via `loadCommand(sub)`/`listSubcommands()` (sem lista fixa; basta criar o arquivo do subcomando) e imprime erros com `renderError` + `toExitCode` | Tasks 10–13 |
| P7 | O servidor falso tem uma tabela/lógica de rotas onde as rotas do **cenário** têm precedência sobre as rotas base, e exporta `startFake` e a constante `FIXTURE_DATA_DIR` | Task 2 |
| P8 | `tests/helpers.mjs` exporta `REPO_ROOT`, `PLUGIN_ROOT`, `makeTempDir`, `makeWorkspace`, `testEnv`, `runCli`, `stopAllServers`, `readFakeState`; `runCli` executa o companion com `process.execPath` (não depende de `node` no `PATH`) | Tasks 2, 10–15 |
| P9 | `lib/render.mjs` importa `redact` de `./redact.mjs` (o `renderError` é redigido) | Task 9 |
| P10 | `spawn`/`spawnSync` com `env` resolvem o executável pelo `env.PATH` passado (comportamento do Node usado pelo binário falso desde o F0) | Tasks 10, 13 |

---

## Estrutura de arquivos da F1

Nenhum arquivo fora da estrutura congelada do mestre.

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `plugins/opc/scripts/lib/api.mjs` | criar | leitura da API v1 (`createApi`) |
| `plugins/opc/scripts/lib/context.mjs` | modificar | + `connectApi(ctx)` (sobe/reaproveita o servidor e devolve a API) |
| `plugins/opc/scripts/lib/models.mjs` | criar | glob, catálogo, parse/normalização de IDs, aliases, variants, busca |
| `plugins/opc/scripts/lib/policy.mjs` | criar | `evaluate`/`assertAllowed` + agentes/commands com modelo fixado (perfis ficam para a F2a) |
| `plugins/opc/scripts/lib/config.mjs` | modificar | esquema completo, merge restritivo, chaves travadas, segredos, edição, validação contra o servidor |
| `plugins/opc/scripts/lib/tty.mjs` | criar | prompts de terminal (lista numerada, filtro, seleção múltipla), streams injetáveis |
| `plugins/opc/scripts/lib/onboarding.mjs` | criar | etapas, rascunho, `applyDraftStep`, `commitDraft` atômico, sugestões, assistente |
| `plugins/opc/scripts/lib/render.mjs` | modificar | `renderProviders`, `renderModels`, `renderAgents`, `renderCatalog`, `renderConfig`, `renderOnboarding` |
| `plugins/opc/scripts/commands/{providers,models,agents,catalog,config}.mjs` | criar | subcomandos da F1 |
| `plugins/opc/scripts/commands/setup.mjs` | modificar | subcomandos de onboarding (`models`, `apply`, `commit`, `discard`) e estado `onboarding` no `setup --json` |
| `plugins/opc/commands/{config,providers,models,agents,catalog}.md` | criar | slash commands |
| `plugins/opc/commands/setup.md` | reescrever | onboarding guiado com AskUserQuestion |
| `tests/fixtures/data/{provider,command,skill}.json` | criar | respostas realistas (OpenAPI 1.18.32) |
| `tests/fixtures/data/agent.json` | substituir | agentes built-in, ocultos, `work-*` e um com modelo fixado |
| `tests/fixtures/fake-opencode.mjs` | modificar | rotas de dados (`/provider`, `/command`, `/skill`, `/agent`, `/config`) com override por cenário |
| `tests/fixtures/scenarios/pinned-denied-model.mjs` | criar | cenário da spec §13.1 |
| `tests/helpers.mjs` | modificar | helpers de TTY roteirizado, config e execução em processo |
| `tests/unit/{api,models,policy,config-f1,config-f1-edit,tty,onboarding,onboarding-wizard,render-f1,commands-md}.test.mjs` | criar | unitários |
| `tests/integration/{fake-f1-routes,discovery,config-cli,config-tty,onboarding,no-config-first-run}.test.mjs` | criar | integração |
| `tests/live/f1-discovery.mjs`, `tests/live/f1-fixture-coverage.mjs` | criar | ao vivo |
| `docs/configuration.md`, `docs/commands.md`, `README.md`, `docs/phases/F1-report.md`, `CHANGELOG.md` | criar/atualizar | portão |

## Decisões desta fase (ambiguidades resolvidas)

| # | Ambiguidade | Decisão |
|---|---|---|
| D1 | A spec exige o ID completo quando as duas leituras são válidas, mas `opencode/big-pickle` continua ambíguo mesmo escrito "completo" | Prefixo `=` força a leitura completa (`=opencode/big-pickle`); valores lidos da config (já normalizados) e alvos de alias usam sempre a leitura completa (`fullOnly`) |
| D2 | `allow` do `.opc.json` é "interseção" com o global, mas duas listas de globs não viram uma lista só | A config efetiva guarda `policy.<tipo>.allow` (global) e `policy.<tipo>.allowWorkspace` (workspace); `evaluate` exige as duas. Entrada do workspace fora do allow global gera aviso |
| D3 | `policy` inteira é travada, mas a spec também une `deny` e intersecta `allow` do `.opc.json` | No `.opc.json` valem só `policy.{providers,models,agents}.{allow,deny}`, `policy.tools.deny`, `policy.sensitivePaths` e `policy.destructiveBash` (todos só restringem); `approver`, `permissionTimeoutSec`, `permissionProfiles` e `server.*` são ignorados com aviso. **Escrever** qualquer `policy.*` pelo companion (global ou workspace) exige `--tty-confirm` num TTY |
| D4 | A lista de escalares sobrescrevíveis por workspace omite `defaultProvider`, `defaultVariant`, `defaultAgent` | Entram como preferência de workspace; `stopGate.enabled`, `delegation`, `jobs` e `server.*` ficam só globais |
| D5 | Formato do `setup apply --json '<partial>'` e risco de aspas no heredoc | O payload é uma config parcial aninhada (mais a pseudochave `scope`); o slash command manda por `--stdin` em heredoc `<<'OPC_JSON_5f1d0c7a_EOF'` (JSON cru, sem `splitArgString`); no terminal também aceita o JSON posicional |
| D6 | Mapas (`aliases`) no onboarding: substituir ou mesclar | Mesclam com o arquivo; `null` remove um alias; valores já gravados não são renormalizados |
| D7 | O assistente de terminal pode editar chaves travadas; o rascunho não pode virar escada de privilégio | `allowLocked` nunca é gravado no rascunho: `setup apply/commit` calculam `bootstrap && !existe config global`; `config init` passa `true`. O `config init` usa rascunho só em memória (interrupção não grava nada) |
| D8 | `setup --json` precisa do estado de onboarding sem conhecer o formato do relatório do F0 | O `run` do F1 envolve o do F0 (renomeado `runDiagnostics`) e acrescenta `onboarding` ao JSON (ou uma seção ao texto) interceptando `ctx.json`/`ctx.out`; se o diagnóstico lançar erro com `--json`, imprime `{error, onboarding}` com o exit code do erro |
| D9 | "Descartar rascunho" não está na spec | `opc setup discard` (o slash command só chama após perguntar "Retomar ou recomeçar?") |
| D10 | Agentes ocultos (`title`, `summary`, `compaction`) | Aparecem só com `--verbose` (marcados); `--mode primary` inclui agentes de modo `all` |
| D11 | Exit code do `config validate` | erros → 2; só erros de política → 4; servidor inacessível → 5 (com o resultado da checagem de forma impresso); válido → 0 |
| D12 | Texto das instruções dos slash commands | `description` em PT-BR (visível ao usuário), corpo em inglês (instruções ao modelo), perguntas do AskUserQuestion em PT-BR |
| D13 | Onde mora o assistente de terminal | `runInitWizard` em `onboarding.mjs` recebe o `prompter` injetado (o TTY é só interface das mesmas etapas); `config.mjs` (comando) só o conecta ao `ctx` |
| D14 | Como os argumentos do usuário chegam ao `opc` (convenção entre fases) | Comandos da F1 recebem só flags/ids → slash commands usam `--args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'` (inalterado); `setup apply` recebe JSON por `--stdin <<'OPC_JSON_5f1d0c7a_EOF'` (D5); `--raw-args-stdin` (texto livre verbatim) é da F2a em diante e não aparece na F1. Valores com apóstrofo em `config set` funcionam sem aspas porque o `splitArgString` da F0 trata `'` entre letras/dígitos como literal |

---

### Task 1: API de leitura e `connectApi`

**Files:**
- Create: `plugins/opc/scripts/lib/api.mjs`
- Modify: `plugins/opc/scripts/lib/context.mjs` (acrescentar `connectApi` no fim)
- Test: `tests/unit/api.test.mjs`

**Interfaces:**
- Consumes: `client.get(path, { query, retryOnServerDown })` de `createClient` (F0, `lib/http.mjs`); `ensureServer(ctx)` e `clientFor(ctx, server)` (F0, `lib/server.mjs`); campos de `ctx` (premissa P2).
- Produces: `createApi(client)` → `{ health(), getConfig(), providers(), agents(), commands(), skills(), listSessions(), getSession(id), sessionStatus(), messages(id, { limit }), children(id), diff(id), todo(id), listPermissions(), listQuestions() }` (todas `Promise<JSON>`, GET com `retryOnServerDown: true`); `connectApi(ctx)` → `Promise<{ api, server, client }>` (`client` = o `clientFor` usado pela `api`; fases seguintes que precisam do cliente cru — `EventHub`, escritas — reaproveitam a mesma conexão).

- [ ] **Step 1: Conferir as premissas do F0 (P1–P10)**

Criar a branch `feat/opc-f1` a partir da `main` (operação git: só com autorização do operador; sem ela, pedir antes). Depois:

```bash
grep -n "class UsageError\|class PolicyError\|class ConnectionError\|class NotFoundError" plugins/opc/scripts/lib/opc-error.mjs
grep -n "export async function createContext\|configWarnings\|stateDir" plugins/opc/scripts/lib/context.mjs
grep -n "mergeConfig(\|validateConfigShape(\|writeFileAtomic" plugins/opc/scripts/lib/config.mjs
grep -n "export async function run\|ctx.json\|ctx.out" plugins/opc/scripts/commands/setup.mjs
grep -n "export async function loadCommand\|export function listSubcommands" plugins/opc/scripts/opc-companion.mjs
grep -n "FIXTURE_DATA_DIR\|export async function startFake\|routes" tests/fixtures/fake-opencode.mjs
grep -n "^export" tests/helpers.mjs
grep -n "import { redact\|import {.*redact" plugins/opc/scripts/lib/render.mjs
node -e "import('./plugins/opc/scripts/lib/opc-error.mjs').then(m=>{const e=new m.UsageError('X_CODE','msg',{details:{a:1}});console.log(e.code,e.exitCode,e.details.a)})"
```

Expected: cada grep acha a linha correspondente; o último comando imprime `X_CODE 2 1`. Qualquer divergência → registrar no relatório e ajustar só a cola afetada antes de seguir.

- [ ] **Step 2: Write the failing test**

`tests/unit/api.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { connectApi, createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { makeWorkspace, testEnv } from '../helpers.mjs';

function recordingClient() {
  const calls = [];
  return { calls, get: async (path, opts) => { calls.push({ method: 'GET', path, opts }); return { path }; } };
}

test('read methods map to the v1 routes and retry on ServerDown', async () => {
  const client = recordingClient();
  const api = createApi(client);
  await api.health(); await api.getConfig(); await api.providers(); await api.agents(); await api.commands(); await api.skills();
  await api.listSessions(); await api.getSession('ses_1'); await api.sessionStatus(); await api.messages('ses_1', { limit: 5 });
  await api.children('ses_1'); await api.diff('ses_1'); await api.todo('ses_1'); await api.listPermissions(); await api.listQuestions();
  assert.deepEqual(client.calls.map((c) => c.path), [
    '/global/health', '/config', '/provider', '/agent', '/command', '/skill', '/session', '/session/ses_1', '/session/status',
    '/session/ses_1/message', '/session/ses_1/children', '/session/ses_1/diff', '/session/ses_1/todo', '/permission', '/question',
  ]);
  assert.ok(client.calls.every((c) => c.opts.retryOnServerDown === true));
  assert.deepEqual(client.calls[9].opts.query, { limit: 5 });
  assert.equal(client.calls[7].opts.query, undefined);
});

test('session ids are URL-encoded', async () => {
  const client = recordingClient();
  await createApi(client).getSession('../x y');
  assert.equal(client.calls[0].path, '/session/..%2Fx%20y');
});

test('connectApi starts/reuses the workspace server and returns { api, server, client }', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t); // the F0 per-test cleanup stops this env × workspace server before removing the dirs
  const ctx = await createContext({ argv: [], env, cwd: ws, createDataDir: true });
  const { api, server, client } = await connectApi(ctx);
  assert.equal(client.baseUrl, server.url);
  assert.equal(client.directory, ctx.workspaceRoot);
  assert.equal((await api.health()).healthy, true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/unit/api.test.mjs`
Expected: FAIL com `Cannot find module '.../plugins/opc/scripts/lib/api.mjs'` (ou `does not provide an export named 'connectApi'`).

- [ ] **Step 4: Write the implementation**

`plugins/opc/scripts/lib/api.mjs`:

```js
// Domain operations over the OpenCode v1 API (spec §3). F1: read methods; F2a/F3 add writes.
const GET = { retryOnServerDown: true };
const seg = (id) => encodeURIComponent(String(id));

export function createApi(client) {
  return {
    health: () => client.get('/global/health', GET),
    getConfig: () => client.get('/config', GET),
    providers: () => client.get('/provider', GET),
    agents: () => client.get('/agent', GET),
    commands: () => client.get('/command', GET),
    skills: () => client.get('/skill', GET),
    listSessions: () => client.get('/session', GET),
    getSession: (id) => client.get(`/session/${seg(id)}`, GET),
    sessionStatus: () => client.get('/session/status', GET),
    messages: (id, { limit } = {}) => client.get(`/session/${seg(id)}/message`, limit ? { ...GET, query: { limit } } : GET),
    children: (id) => client.get(`/session/${seg(id)}/children`, GET),
    diff: (id) => client.get(`/session/${seg(id)}/diff`, GET),
    todo: (id) => client.get(`/session/${seg(id)}/todo`, GET),
    listPermissions: () => client.get('/permission', GET),
    listQuestions: () => client.get('/question', GET),
  };
}
```

Acrescentar ao **fim** de `plugins/opc/scripts/lib/context.mjs` (imports dinâmicos para não colidir com os nomes que o F0 já importa):

```js
// ---- F1: connection helper for discovery/config commands ----
export async function connectApi(ctx) {
  const { ensureServer, clientFor } = await import('./server.mjs');
  const { createApi } = await import('./api.mjs');
  const serverCtx = { stateDir: ctx.stateDir, workspaceRoot: ctx.workspaceRoot, config: ctx.config, env: ctx.env };
  const server = await ensureServer(serverCtx);
  const client = clientFor(serverCtx, server);
  return { api: createApi(client), server, client };
}
// ---- end F1 ----
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/unit/api.test.mjs && npm test`
Expected: PASS (3 testes novos); a suíte do F0 continua verde.

- [ ] **Step 6: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/api.mjs plugins/opc/scripts/lib/context.mjs tests/unit/api.test.mjs
git commit -m "feat(api): add read-only OpenCode API operations and connectApi"
```

---

### Task 2: Fixtures, rotas de dados do servidor falso e helpers de teste

**Files:**
- Create: `tests/fixtures/data/provider.json`, `tests/fixtures/data/command.json`, `tests/fixtures/data/skill.json`
- Modify (substituir o conteúdo): `tests/fixtures/data/agent.json`
- Modify: `tests/fixtures/fake-opencode.mjs` (bloco F1 + registro das rotas)
- Create: `tests/fixtures/scenarios/pinned-denied-model.mjs`
- Modify: `tests/helpers.mjs` (acrescentar no fim)
- Test: `tests/integration/fake-f1-routes.test.mjs`

**Interfaces:**
- Consumes: `startFake({ port, password, scenario, stateFile, dataDir })` e `FIXTURE_DATA_DIR` (F0); `pickFreePort()` (F0); `createClient` (F0); `createApi` (Task 1).
- Produces: fixtures `provider.json` (5 providers, 4 conectados, **com** `key`/`options.apiKey`/`headers` falsos), `agent.json` (10 agentes), `command.json` (5), `skill.json` (2); `loadFixtureData(name, { dataDir, scenario })`, `F1_DATA_ROUTES` e a extensão F1 (`registerFakeExtension`) no fake; campo opcional `data: { '<arquivo>.json': valor | (base) => valor }` nos módulos de cenário (mecanismo único para trocar catálogos por cenário); cenário `pinned-denied-model`; helpers `scriptedTTY(lines)`, `pipedStdin(text)`, `captureStream({ isTTY })`, `fixtureData(name)`, `writeGlobalConfig(env, cfg) → caminho`, `readGlobalConfig(env)`, `writeWorkspaceConfig(ws, cfg) → caminho`, `runInProcess(sub, argv, { env, cwd, stdin })` → `{ code, stdout, stderr }`.

As fixtures seguem os schemas `Provider`, `Model`, `Agent` e `Command` da OpenAPI 1.18.32 (todos os campos obrigatórios presentes). Os IDs reais de `models.txt` foram usados; `omniroute-mvalmeida/opencode/big-pickle` é sintético, para reproduzir a ambiguidade do §3.2.

- [ ] **Step 1: Write the failing test**

`tests/integration/fake-f1-routes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir, fixtureData, PLUGIN_ROOT } from '../helpers.mjs';
import { startFake, loadFixtureData } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

async function boot(t, scenario = 'ok') {
  const port = await pickFreePort();
  const stateFile = path.join(makeTempDir(), 'fake-state.json');
  const fake = await startFake({ port, password: 'fake-password-123456', scenario, stateFile });
  t.after(() => fake.close());
  const client = createClient({ baseUrl: fake.url, password: 'fake-password-123456', directory: PLUGIN_ROOT });
  return { fake, api: createApi(client) };
}

test('fake serves /provider, /command, /skill and /agent from fixtures (raw, with keys)', async (t) => {
  const { api } = await boot(t);
  const providers = await api.providers();
  assert.deepEqual(providers.connected, fixtureData('provider.json').connected);
  assert.equal(providers.all.find((p) => p.id === 'omniroute-mvalmeida').key, 'sk-omr-FIXTURE-mvalmeida-0001', 'raw fixture keeps the key so redaction can be proven'); // scan-secrets:allow
  assert.deepEqual((await api.commands()).map((c) => c.name), fixtureData('command.json').map((c) => c.name));
  assert.deepEqual((await api.skills()).map((s) => s.name), ['brainstorm', 'release-notes']);
  assert.ok((await api.agents()).some((a) => a.name === 'work-deploy'));
});

test('scenario data overrides extend fixture responses (pinned-denied-model)', async (t) => {
  const { api } = await boot(t, 'pinned-denied-model');
  const agents = await api.agents();
  assert.deepEqual(agents.find((a) => a.name === 'pinned-reviewer').model, { providerID: 'omniroute-work', modelID: 'opencode-go/kimi-k3' });
  assert.ok((await api.commands()).some((c) => c.name === 'work-release'));
});

test('loadFixtureData: static override value and function override', () => {
  assert.deepEqual(loadFixtureData('skill.json', { scenario: { data: { 'skill.json': [] } } }), []);
  const extended = loadFixtureData('skill.json', { scenario: { data: { 'skill.json': (base) => base.slice(0, 1) } } });
  assert.equal(extended.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/fake-f1-routes.test.mjs`
Expected: FAIL — `fixtureData` não existe em `tests/helpers.mjs` (SyntaxError de import) ou `loadFixtureData` não é exportado pelo fake.

- [ ] **Step 3: Create the fixtures**

Antes de substituir `agent.json`, confirmar que nenhum teste do F0 depende do conteúdo antigo: `grep -rn "agent.json\|'build'\|\"build\"" tests/ | grep -v fixtures/data` — o teste do fake da F0 compara só os quatro primeiros nomes (`slice(0, 4)` → `build`, `plan`, `general`, `explore`), que a lista abaixo mantém nessa ordem; qualquer outro teste do F0 que afirme a lista inteira é desvio a registrar. Não tocar em `tests/fixtures/data/config.json` do F0.

`tests/fixtures/data/provider.json`:

```json
{
  "all": [
    {"id":"omniroute-mvalmeida","name":"OmniRoute (mvalmeida)","source":"config","env":[],"key":"sk-omr-FIXTURE-mvalmeida-0001","options":{"baseURL":"http://127.0.0.1:9/v1","apiKey":"sk-FIXTURE-apikey-0002","headers":{"Authorization":"Bearer FIXTURE-hdr-0003"}}, // scan-secrets:allow
      "models": {
        "opencode-go/deepseek-v4.1-flash": {"id":"opencode-go/deepseek-v4.1-flash","providerID":"omniroute-mvalmeida","api":{"id":"opencode-go/deepseek-v4.1-flash","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"DeepSeek V4.1 Flash","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{"X-Fixture-Secret":"FIXTURE-model-header-0004"},"release_date":"2026-08-20","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"}}},
        "opencode-go/qwen3.8-max": {"id":"opencode-go/qwen3.8-max","providerID":"omniroute-mvalmeida","api":{"id":"opencode-go/qwen3.8-max","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Qwen3.8 Max","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":1.6,"output":6.4,"cache":{"read":0,"write":0}},"limit":{"context":262144,"output":32768},"status":"active","options":{},"headers":{},"release_date":"2026-09-02","variants":{"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}},
        "opencode-go/kimi-k3": {"id":"opencode-go/kimi-k3","providerID":"omniroute-mvalmeida","api":{"id":"opencode-go/kimi-k3","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Kimi K3","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.6,"output":2.5,"cache":{"read":0,"write":0}},"limit":{"context":262144,"output":32768},"status":"active","options":{},"headers":{},"release_date":"2026-08-28","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}},
        "opencode-go/qwen3.8-flash": {"id":"opencode-go/qwen3.8-flash","providerID":"omniroute-mvalmeida","api":{"id":"opencode-go/qwen3.8-flash","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Qwen3.8 Flash","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{},"release_date":"2026-09-02","variants":{}},
        "opencode-go/kimi-k2.6": {"id":"opencode-go/kimi-k2.6","providerID":"omniroute-mvalmeida","api":{"id":"opencode-go/kimi-k2.6","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Kimi K2.6","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"deprecated","options":{},"headers":{},"release_date":"2026-01-15","variants":{}},
        "cx/gpt-5.6-sol": {"id":"cx/gpt-5.6-sol","providerID":"omniroute-mvalmeida","api":{"id":"cx/gpt-5.6-sol","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"GPT-5.6 Sol","family":"cx","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":1.25,"output":10,"cache":{"read":0,"write":0}},"limit":{"context":400000,"output":128000},"status":"active","options":{},"headers":{},"release_date":"2026-07-10","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}},
        "opencode/big-pickle": {"id":"opencode/big-pickle","providerID":"omniroute-mvalmeida","api":{"id":"opencode/big-pickle","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Big Pickle (via omniroute)","family":"opencode","capabilities":{"temperature":true,"reasoning":false,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{},"release_date":"2026-03-01","variants":{}}
      }},
    {"id":"omniroute-work","name":"OmniRoute (work)","source":"config","env":[],"key":"sk-omr-FIXTURE-work-0006","options":{"baseURL":"http://127.0.0.1:9/v1","apiKey":"sk-FIXTURE-apikey-0007"}, // scan-secrets:allow
      "models": {
        "opencode-go/kimi-k3": {"id":"opencode-go/kimi-k3","providerID":"omniroute-work","api":{"id":"opencode-go/kimi-k3","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Kimi K3 (EQ)","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":262144,"output":32768},"status":"active","options":{},"headers":{},"release_date":"2026-08-28","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}},
        "opencode-go/deepseek-v4-flash": {"id":"opencode-go/deepseek-v4-flash","providerID":"omniroute-work","api":{"id":"opencode-go/deepseek-v4-flash","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"DeepSeek V4 Flash (EQ)","family":"opencode-go","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{},"release_date":"2026-05-01","variants":{}},
        "cx/gpt-5.5": {"id":"cx/gpt-5.5","providerID":"omniroute-work","api":{"id":"cx/gpt-5.5","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"GPT-5.5 (EQ)","family":"cx","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0.3,"output":1.2,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{},"release_date":"2026-04-01","variants":{}}
      }},
    {"id":"opencode","name":"OpenCode Zen","source":"api","env":["OPENCODE_API_KEY"],"options":{},
      "models": {
        "big-pickle": {"id":"big-pickle","providerID":"opencode","api":{"id":"big-pickle","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Big Pickle","family":"big-pickle","capabilities":{"temperature":true,"reasoning":false,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0,"output":0,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{},"release_date":"2026-03-01","variants":{}},
        "space-bunny-free": {"id":"space-bunny-free","providerID":"opencode","api":{"id":"space-bunny-free","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Space Bunny (free)","family":"space-bunny","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":0,"output":0,"cache":{"read":0,"write":0}},"limit":{"context":128000,"output":16384},"status":"active","options":{},"headers":{},"release_date":"2026-07-01","variants":{}}
      }},
    {"id":"anthropic","name":"Anthropic","source":"env","env":["ANTHROPIC_API_KEY"],"key":"sk-ant-FIXTURE-0008","options":{},
      "models": {
        "claude-opus-5-5": {"id":"claude-opus-5-5","providerID":"anthropic","api":{"id":"claude-opus-5-5","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Claude Opus 5.5","family":"claude-opus","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":5,"output":25,"cache":{"read":0,"write":0}},"limit":{"context":1000000,"output":128000},"status":"active","options":{},"headers":{},"release_date":"2026-08-01","variants":{"high":{"thinking":{"budgetTokens":16000}},"max":{"thinking":{"budgetTokens":32000}}}},
        "claude-haiku-4-5": {"id":"claude-haiku-4-5","providerID":"anthropic","api":{"id":"claude-haiku-4-5","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"Claude Haiku 4.5","family":"claude-haiku","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":1,"output":5,"cache":{"read":0,"write":0}},"limit":{"context":200000,"output":64000},"status":"active","options":{},"headers":{},"release_date":"2025-10-01","variants":{}}
      }},
    {"id":"openai","name":"OpenAI","source":"api","env":["OPENAI_API_KEY"],"options":{},
      "models": {
        "gpt-5.6": {"id":"gpt-5.6","providerID":"openai","api":{"id":"gpt-5.6","url":"http://127.0.0.1:9/v1","npm":"@ai-sdk/openai-compatible"},"name":"GPT-5.6","family":"gpt","capabilities":{"temperature":true,"reasoning":true,"attachment":false,"toolcall":true,"input":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"output":{"text":true,"audio":false,"image":false,"video":false,"pdf":false},"interleaved":false},"cost":{"input":1.25,"output":10,"cache":{"read":0,"write":0}},"limit":{"context":400000,"output":128000},"status":"active","options":{},"headers":{},"release_date":"2026-07-10","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
      }}
  ],
  "default": {"omniroute-mvalmeida":"opencode-go/deepseek-v4.1-flash","omniroute-work":"opencode-go/kimi-k3","opencode":"big-pickle","anthropic":"claude-opus-5-5","openai":"gpt-5.6"},
  "connected": ["omniroute-mvalmeida","omniroute-work","opencode","anthropic"]
}
```

`tests/fixtures/data/agent.json`:

```json
[
  {"name":"build","description":"The default agent. Executes tools based on configured permissions.","mode":"primary","native":true,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"plan","description":"Plan mode. Disallows all edit tools.","mode":"primary","native":true,"permission":[{"permission":"*","pattern":"*","action":"allow"},{"permission":"edit","pattern":"*","action":"deny"}],"options":{}},
  {"name":"general","description":"General-purpose agent for researching complex questions and executing multi-step tasks.","mode":"subagent","native":true,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"explore","description":"Fast agent specialized for exploring codebases.","mode":"subagent","native":true,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"title","mode":"primary","native":true,"hidden":true,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"summary","mode":"primary","native":true,"hidden":true,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"compaction","mode":"primary","native":true,"hidden":true,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"docs-writer","description":"Writes and updates documentation in PT-BR.","mode":"subagent","native":false,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"model":{"providerID":"omniroute-mvalmeida","modelID":"opencode-go/qwen3.8-max"},"variant":"high","prompt":"You write docs.","options":{}},
  {"name":"work-deploy","description":"Work deploy helper.","mode":"subagent","native":false,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}},
  {"name":"work-reviewer","description":"Work code reviewer.","mode":"all","native":false,"permission":[{"permission":"*","pattern":"*","action":"allow"}],"options":{}}
]
```

`tests/fixtures/data/command.json`:

```json
[
  {"name":"init","description":"create/update AGENTS.md","source":"command","template":"Please analyze this codebase and create an AGENTS.md file.","hints":[]},
  {"name":"review","description":"review changes [commit|branch|pr], defaults to uncommitted","source":"command","agent":"plan","subtask":true,"template":"Review the following changes: $ARGUMENTS","hints":["$ARGUMENTS"]},
  {"name":"docs","description":"Update the docs for a module","source":"command","agent":"docs-writer","model":"omniroute-mvalmeida/opencode-go/qwen3.8-max","template":"Update docs for $1","hints":["$1"]},
  {"name":"gitlab:list-mrs","description":"List open merge requests (MCP prompt)","source":"mcp","template":"List MRs","hints":[]},
  {"name":"brainstorm","description":"Brainstorm before building","source":"skill","template":"Use the brainstorm skill.","hints":[]}
]
```

`tests/fixtures/data/skill.json`:

```json
[
  {"name":"brainstorm","description":"Explore intent and design before building.","location":"/home/fixture/.config/opencode/skill/brainstorm/SKILL.md","content":"---\nname: brainstorm\n---\nAsk one question at a time."},
  {"name":"release-notes","description":"Draft release notes from git log.","location":"/home/fixture/project/.opencode/skill/release-notes/SKILL.md","content":"---\nname: release-notes\n---\nSummarize commits."}
]
```

Conferência rápida (sem dependências):

```bash
node -e "for (const f of ['provider','agent','command','skill']) JSON.parse(require('fs').readFileSync('tests/fixtures/data/'+f+'.json','utf8')); console.log('fixtures ok')"
```

- [ ] **Step 4: Add the data routes to the fake**

Acrescentar ao **fim** de `tests/fixtures/fake-opencode.mjs` (mecanismo único de extensão da F0: `registerFakeExtension`; o roteador da F0 não é editado; `fs`, `path` e `FIXTURE_DATA_DIR` já existem no arquivo):

```js

// ---- F1: data-driven discovery routes (fixtures in tests/fixtures/data; scenarios override with `data`) ----
// Scenario modules may export `data: { '<file>.json': value | (base) => value }` to override fixture responses.
export function loadFixtureData(name, { dataDir = FIXTURE_DATA_DIR, scenario = null } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  const override = scenario?.data?.[name];
  if (override === undefined) return base;
  return typeof override === 'function' ? override(base) : override;
}

export const F1_DATA_ROUTES = Object.freeze({
  'GET /provider': 'provider.json',
  'GET /agent': 'agent.json',
  'GET /command': 'command.json',
  'GET /skill': 'skill.json',
  'GET /config': 'config.json',
});

registerFakeExtension(() => Object.fromEntries(Object.entries(F1_DATA_ROUTES).map(([key, file]) => [key, (fake) => {
  const data = loadFixtureData(file, { dataDir: fake.dataDir, scenario: fake.scenario });
  // GET /config keeps the F0 contract: OPENCODE_CONFIG_CONTENT (configOverride) is merged over the file.
  return { body: file === 'config.json' ? { ...data, ...fake.configOverride } : data };
}])));
// ---- end F1 ----
```

As chaves `GET /agent` e `GET /config` substituem as da `DEFAULT_ROUTES` da F0 (mesma chave); as demais são acrescentadas. Rotas de cenário continuam vencendo (o `share-auto` da F0 segue sobrescrevendo `GET /config`), e o teste da F0 "OPENCODE_CONFIG_CONTENT is merged over the base config" continua valendo.

- [ ] **Step 5: Create the scenario**

`tests/fixtures/scenarios/pinned-denied-model.mjs`:

```js
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
```

- [ ] **Step 6: Add the test helpers**

Acrescentar ao **fim** de `tests/helpers.mjs` (imports com alias para não colidir com os do F0; nenhum destes nomes existe na F0). `writeGlobalConfig` e `writeWorkspaceConfig` passam a ser os escritores canônicos de config para todas as fases (devolvem o caminho; a F2a+ não os redefine):

```js
// ---- F1 additions (aliased imports so they never collide with F0's) ----
import { PassThrough as F1PassThrough, Writable as F1Writable } from 'node:stream';
import * as fsF1 from 'node:fs';
import * as pathF1 from 'node:path';
import { pathToFileURL as pathToFileURLF1 } from 'node:url';

export function scriptedTTY(lines) {
  const input = new F1PassThrough();
  input.isTTY = true;
  input.end(lines.map((line) => `${line}\n`).join(''));
  return input;
}

export function pipedStdin(text = '') {
  const input = new F1PassThrough();
  input.isTTY = false;
  input.end(text);
  return input;
}

export function captureStream({ isTTY = false } = {}) {
  const chunks = [];
  const stream = new F1Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  stream.isTTY = isTTY;
  stream.text = () => chunks.join('');
  return stream;
}

export function fixtureData(name) {
  return JSON.parse(fsF1.readFileSync(pathF1.join(REPO_ROOT, 'tests', 'fixtures', 'data', name), 'utf8'));
}

// Canonical writer of <OPC_DATA_DIR>/config.json for every phase (mode 600) → file path.
export function writeGlobalConfig(env, cfg) {
  fsF1.mkdirSync(env.OPC_DATA_DIR, { recursive: true, mode: 0o700 });
  const file = pathF1.join(env.OPC_DATA_DIR, 'config.json');
  fsF1.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fsF1.chmodSync(file, 0o600);
  return file;
}

export function readGlobalConfig(env) {
  const file = pathF1.join(env.OPC_DATA_DIR, 'config.json');
  return fsF1.existsSync(file) ? JSON.parse(fsF1.readFileSync(file, 'utf8')) : null;
}

// Canonical writer of <ws>/.opc.json → file path.
export function writeWorkspaceConfig(ws, cfg) {
  const file = pathF1.join(ws, '.opc.json');
  fsF1.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

export async function runInProcess(sub, argv, { env, cwd, stdin = pipedStdin('') }) {
  const lib = (m) => pathToFileURLF1(pathF1.join(PLUGIN_ROOT, 'scripts', 'lib', m)).href;
  const { createContext } = await import(lib('context.mjs'));
  const { toExitCode } = await import(lib('opc-error.mjs'));
  const { renderError } = await import(lib('render.mjs'));
  const stdout = captureStream();
  const stderr = captureStream();
  let code;
  try {
    const ctx = await createContext({ argv, env, cwd, stdin, stdout, stderr });
    const mod = await import(pathToFileURLF1(pathF1.join(PLUGIN_ROOT, 'scripts', 'commands', `${sub}.mjs`)).href);
    code = await mod.run(ctx, argv);
  } catch (err) {
    stderr.write(renderError(err));
    code = toExitCode(err);
  }
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
// ---- end F1 additions ----
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test tests/integration/fake-f1-routes.test.mjs && npm test`
Expected: PASS (3 testes novos); a suíte do F0 continua verde (o aquecimento `GET /agent` do `ensureServer` agora recebe a fixture nova).

- [ ] **Step 8: Commit** (só com autorização do operador)

```bash
git add tests/fixtures tests/helpers.mjs tests/integration/fake-f1-routes.test.mjs
git commit -m "test: add discovery fixtures, fake data routes and pinned-denied-model scenario"
```

---

### Task 3: `models.mjs` — catálogo, IDs, aliases, variants e globs

**Files:**
- Create: `plugins/opc/scripts/lib/models.mjs`
- Test: `tests/unit/models.test.mjs`

**Interfaces:**
- Consumes: `UsageError` (F0).
- Produces (contrato do mestre + acréscimos):
  - `globToRegExp(glob)` → `RegExp` (`*` casa qualquer sequência, inclusive `/`; demais caracteres literais);
  - `matchesAny(value, globs)` → `boolean` (lista vazia → `false`);
  - `buildCatalog(providerResponse)` → `{ connected: Set<string>, models: ModelEntry[], byFull: Map<string, ModelEntry>, providers: ProviderEntry[], defaults }`, com `ModelEntry = { providerID, modelID, full, name, family, status, releaseDate, variants: string[], limit: {context, output}, cost: {input, output}, reasoning, toolcall, connected }` e `ProviderEntry = { id, name, source, connected, modelCount, defaultModel }` (nunca carrega `key`, `options` ou `headers`);
  - `parseFullId(full)` → `{ providerID: string|null, modelID }`;
  - `expandAlias(value, aliases)` → string (1 nível);
  - `normalizeModelId(input, { catalog, defaultProvider, aliases, fullOnly = false })` → `{ providerID, modelID, full, entry }`; `UsageError('AMBIGUOUS_MODEL' | 'UNKNOWN_MODEL')` com `details.candidates`/`details.suggestions`; prefixo `=` equivale a `fullOnly`;
  - `resolveModelRef(value, { catalog, defaultProvider, aliases, allowClaude })` → `{ kind: 'alias'|'model'|'claude', value, full? }` (nome de alias é mantido);
  - `validateVariant(entry, variant)` → `variant|null`; `UsageError('UNKNOWN_VARIANT')`;
  - `searchModels(catalog, query, { providerID, connectedOnly = true, limit = 20 })` → `ModelEntry[]` (glob se houver `*`, senão substring).

- [ ] **Step 1: Write the failing test**

`tests/unit/models.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  globToRegExp, matchesAny, parseFullId, buildCatalog, expandAlias, normalizeModelId,
  resolveModelRef, validateVariant, searchModels,
} from '../../plugins/opc/scripts/lib/models.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const providers = JSON.parse(fs.readFileSync(path.join(DATA, 'provider.json'), 'utf8'));
const catalog = buildCatalog(providers);
const MV = 'omniroute-mvalmeida';

test('globToRegExp: * matches any sequence including slashes', () => {
  assert.ok(globToRegExp('omniroute-mvalmeida/*').test('omniroute-mvalmeida/opencode-go/kimi-k3'));
  assert.ok(globToRegExp('*/kimi-*').test('omniroute-work/opencode-go/kimi-k3'));
  assert.ok(!globToRegExp('anthropic/*').test('omniroute-mvalmeida/anthropic/x'));
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dots are literal');
  assert.ok(globToRegExp('work-*').test('work-deploy'));
});

test('matchesAny: empty list never matches', () => {
  assert.equal(matchesAny('x', []), false);
  assert.equal(matchesAny('x', undefined), false);
  assert.equal(matchesAny('work-reviewer', ['build', 'work-*']), true);
});

test('parseFullId: first segment is provider, rest (with slashes) is model', () => {
  assert.deepEqual(parseFullId(`${MV}/opencode-go/deepseek-v4.1-flash`), { providerID: MV, modelID: 'opencode-go/deepseek-v4.1-flash' });
  assert.deepEqual(parseFullId('kimi-k3'), { providerID: null, modelID: 'kimi-k3' });
});

test('buildCatalog: connected set, models with full ids, variants, providers summary', () => {
  assert.ok(catalog.connected.has(MV));
  assert.ok(!catalog.connected.has('openai'));
  const kimi = catalog.byFull.get(`${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(kimi.variants, ['low', 'medium', 'high']);
  assert.equal(kimi.limit.context, 262144);
  assert.equal(kimi.connected, true);
  const mv = catalog.providers.find((p) => p.id === MV);
  assert.equal(mv.modelCount, 7);
  assert.equal(mv.defaultModel, `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.ok(!JSON.stringify(catalog.models).includes('FIXTURE'), 'catalog never carries keys/headers');
});

test('expandAlias: one level only', () => {
  const aliases = { fast: `${MV}/opencode-go/deepseek-v4.1-flash`, loop: 'fast' };
  assert.equal(expandAlias('fast', aliases), `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.equal(expandAlias('loop', aliases), 'fast');
  assert.equal(expandAlias('other', aliases), 'other');
});

test('normalizeModelId: full id with slashes stays intact', () => {
  const r = normalizeModelId(`${MV}/opencode-go/deepseek-v4.1-flash`, { catalog, defaultProvider: MV });
  assert.equal(r.full, `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.equal(r.providerID, MV);
  assert.equal(r.modelID, 'opencode-go/deepseek-v4.1-flash');
});

test('normalizeModelId: short name gets defaultProvider prefix', () => {
  assert.equal(normalizeModelId('opencode-go/kimi-k3', { catalog, defaultProvider: MV }).full, `${MV}/opencode-go/kimi-k3`);
});

test('normalizeModelId: both readings valid is AMBIGUOUS_MODEL', () => {
  assert.throws(() => normalizeModelId('opencode/big-pickle', { catalog, defaultProvider: MV }), (err) => {
    assert.equal(err.code, 'AMBIGUOUS_MODEL');
    assert.equal(err.exitCode, 2);
    assert.deepEqual(err.details.candidates, ['opencode/big-pickle', `${MV}/opencode/big-pickle`]);
    return true;
  });
});

test('normalizeModelId: "=" prefix and fullOnly force the full reading', () => {
  assert.equal(normalizeModelId('=opencode/big-pickle', { catalog, defaultProvider: MV }).full, 'opencode/big-pickle');
  assert.equal(normalizeModelId('opencode/big-pickle', { catalog, defaultProvider: MV, fullOnly: true }).full, 'opencode/big-pickle');
  assert.equal(normalizeModelId(`${MV}/opencode/big-pickle`, { catalog, defaultProvider: MV }).full, `${MV}/opencode/big-pickle`);
});

test('normalizeModelId: alias expands and resolves as full id', () => {
  const aliases = { pickle: 'opencode/big-pickle' };
  assert.equal(normalizeModelId('pickle', { catalog, defaultProvider: MV, aliases }).full, 'opencode/big-pickle');
});

test('normalizeModelId: unknown model and disconnected provider', () => {
  assert.throws(() => normalizeModelId('nope-model', { catalog, defaultProvider: MV }), (err) => err.code === 'UNKNOWN_MODEL' && err.exitCode === 2);
  assert.throws(() => normalizeModelId('openai/gpt-5.6', { catalog, defaultProvider: MV }), (err) => err.code === 'UNKNOWN_MODEL' && /not connected/.test(err.message));
  assert.throws(() => normalizeModelId('   ', { catalog }), (err) => err.code === 'UNKNOWN_MODEL');
});

test('normalizeModelId: suggestions on unknown model', () => {
  assert.throws(() => normalizeModelId('kimi-k3', { catalog, defaultProvider: MV }), (err) => {
    assert.ok(err.details.suggestions.includes(`${MV}/opencode-go/kimi-k3`));
    return true;
  });
});

test('resolveModelRef: keeps alias names, normalizes models, accepts claude when allowed', () => {
  const aliases = { strong: `${MV}/opencode-go/qwen3.8-max` };
  assert.deepEqual(resolveModelRef('strong', { catalog, aliases, defaultProvider: MV }), { kind: 'alias', value: 'strong', full: `${MV}/opencode-go/qwen3.8-max` });
  assert.equal(resolveModelRef('opencode-go/kimi-k3', { catalog, aliases, defaultProvider: MV }).value, `${MV}/opencode-go/kimi-k3`);
  assert.equal(resolveModelRef('claude', { catalog, allowClaude: true }).kind, 'claude');
  assert.throws(() => resolveModelRef('claude', { catalog }), (err) => err.code === 'UNKNOWN_MODEL');
});

test('validateVariant: accepts known, rejects unknown', () => {
  const kimi = catalog.byFull.get(`${MV}/opencode-go/kimi-k3`);
  assert.equal(validateVariant(kimi, 'high'), 'high');
  assert.equal(validateVariant(kimi, null), null);
  assert.throws(() => validateVariant(kimi, 'ultra'), (err) => err.code === 'UNKNOWN_VARIANT' && err.exitCode === 2);
});

test('searchModels: glob and substring, provider filter', () => {
  assert.deepEqual(searchModels(catalog, 'opencode-go/qwen*', { providerID: MV }).map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`]);
  assert.ok(searchModels(catalog, 'kimi').every((m) => m.connected));
  assert.equal(searchModels(catalog, 'gpt-5.6', { connectedOnly: false }).some((m) => m.providerID === 'openai'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/models.test.mjs`
Expected: FAIL com `Cannot find module '.../lib/models.mjs'`.

- [ ] **Step 3: Write the implementation**

`plugins/opc/scripts/lib/models.mjs`:

```js
// Model catalog, ID parsing, aliases and normalization (spec §3.2 "IDs de modelo", §6).
import { UsageError } from './opc-error.mjs';

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

export function globToRegExp(glob) {
  const body = String(glob).split('*').map((part) => part.replace(REGEX_SPECIALS, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

export function matchesAny(value, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  return globs.some((glob) => globToRegExp(glob).test(String(value)));
}

export function parseFullId(full) {
  const text = String(full ?? '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return { providerID: null, modelID: text };
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

export function buildCatalog(providerResponse) {
  const all = Array.isArray(providerResponse?.all) ? providerResponse.all : [];
  const connected = new Set(Array.isArray(providerResponse?.connected) ? providerResponse.connected : []);
  const defaults = providerResponse?.default && typeof providerResponse.default === 'object' ? providerResponse.default : {};
  const models = [];
  const byFull = new Map();
  const providers = [];
  for (const provider of all) {
    const entries = Object.values(provider.models ?? {});
    providers.push({
      id: provider.id,
      name: provider.name ?? provider.id,
      source: provider.source ?? null,
      connected: connected.has(provider.id),
      modelCount: entries.length,
      defaultModel: defaults[provider.id] ? `${provider.id}/${defaults[provider.id]}` : null,
    });
    for (const m of entries) {
      const modelID = m.id;
      const full = `${provider.id}/${modelID}`;
      const entry = {
        providerID: provider.id,
        modelID,
        full,
        name: m.name ?? modelID,
        family: m.family ?? null,
        status: m.status ?? null,
        releaseDate: m.release_date ?? null,
        variants: Object.keys(m.variants ?? {}),
        limit: { context: m.limit?.context ?? null, output: m.limit?.output ?? null },
        cost: { input: m.cost?.input ?? null, output: m.cost?.output ?? null },
        reasoning: Boolean(m.capabilities?.reasoning),
        toolcall: Boolean(m.capabilities?.toolcall),
        connected: connected.has(provider.id),
      };
      models.push(entry);
      byFull.set(full, entry);
    }
  }
  models.sort((a, b) => a.full.localeCompare(b.full));
  providers.sort((a, b) => a.id.localeCompare(b.id));
  return { connected, models, byFull, providers, defaults };
}

export function expandAlias(value, aliases = {}) {
  if (typeof value !== 'string') return value;
  const key = value.trim();
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, key) && typeof aliases[key] === 'string') return aliases[key];
  return key;
}

function usable(catalog, full) {
  const entry = catalog.byFull.get(full);
  return entry && catalog.connected.has(entry.providerID) ? entry : null;
}

function suggestionsFor(catalog, text) {
  const needle = text.toLowerCase().split('/').pop();
  return catalog.models
    .filter((m) => m.connected && m.full.toLowerCase().includes(needle))
    .slice(0, 5)
    .map((m) => m.full);
}

export function normalizeModelId(input, { catalog, defaultProvider = null, aliases = {}, fullOnly = false } = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new UsageError('UNKNOWN_MODEL', 'empty model id');
  let text = raw;
  let forceFull = fullOnly;
  if (text.startsWith('=')) {
    text = text.slice(1);
    forceFull = true;
  }
  const expanded = expandAlias(text, aliases);
  if (expanded !== text) forceFull = true; // alias targets are stored as full IDs
  const { providerID } = parseFullId(expanded);
  const fullReading = providerID && catalog.connected.has(providerID) ? usable(catalog, expanded) : null;
  const shortReading = !forceFull && defaultProvider && catalog.connected.has(defaultProvider)
    ? usable(catalog, `${defaultProvider}/${expanded}`)
    : null;
  if (fullReading && shortReading) {
    throw new UsageError('AMBIGUOUS_MODEL',
      `model "${raw}" is ambiguous: "${fullReading.full}" or "${shortReading.full}". Use "=${fullReading.full}" or "${shortReading.full}".`,
      { details: { input: raw, candidates: [fullReading.full, shortReading.full] } });
  }
  const hit = fullReading ?? shortReading;
  if (hit) return { providerID: hit.providerID, modelID: hit.modelID, full: hit.full, entry: hit };
  const known = providerID ? catalog.byFull.get(expanded) : null;
  const reason = known && !catalog.connected.has(known.providerID)
    ? `provider "${known.providerID}" is not connected (run: opencode auth login)`
    : 'not found in /provider';
  throw new UsageError('UNKNOWN_MODEL', `unknown model "${raw}": ${reason}`,
    { details: { input: raw, suggestions: suggestionsFor(catalog, expanded) } });
}

export function resolveModelRef(value, { catalog, defaultProvider = null, aliases = {}, allowClaude = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (allowClaude && text === 'claude') return { kind: 'claude', value: 'claude' };
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, text)) {
    const target = normalizeModelId(aliases[text], { catalog, aliases: {}, fullOnly: true });
    return { kind: 'alias', value: text, full: target.full };
  }
  const model = normalizeModelId(text, { catalog, defaultProvider, aliases: {} });
  return { kind: 'model', value: model.full, full: model.full };
}

export function validateVariant(entry, variant) {
  if (variant === null || variant === undefined || variant === '') return null;
  if (!entry.variants.includes(variant)) {
    throw new UsageError('UNKNOWN_VARIANT',
      `variant "${variant}" is not valid for ${entry.full} (valid: ${entry.variants.join(', ') || 'none'})`,
      { details: { model: entry.full, variant, valid: entry.variants } });
  }
  return variant;
}

export function searchModels(catalog, query, { providerID = null, connectedOnly = true, limit = 20 } = {}) {
  const text = String(query ?? '').trim();
  const pool = catalog.models.filter((m) => (!connectedOnly || m.connected) && (!providerID || m.providerID === providerID));
  let hits;
  if (text.includes('*')) {
    const re = globToRegExp(text);
    hits = pool.filter((m) => re.test(m.full) || re.test(m.modelID));
  } else {
    const needle = text.toLowerCase();
    hits = pool.filter((m) => m.full.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  }
  return hits.slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/models.test.mjs`
Expected: PASS (15 testes).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/models.mjs tests/unit/models.test.mjs
git commit -m "feat(models): add catalog, model id normalization, aliases and globs"
```

---

### Task 4: `policy.mjs` — allow/deny e modelos fixados

**Files:**
- Create: `plugins/opc/scripts/lib/policy.mjs`
- Test: `tests/unit/policy.test.mjs`

**Interfaces:**
- Consumes: `PolicyError` (F0); `matchesAny`, `parseFullId` (Task 3).
- Produces:
  - `evaluate(kind, value, policy)` → `{ allowed: true } | { allowed: false, rule }` — `kind`: `provider|model|agent|tool`; `deny` vence `allow`; `allow` vazio = tudo; `allowWorkspace` (D2) também precisa casar; modelo herda o `deny`/`allow` do seu provider; `tool` só tem `deny`;
  - `assertAllowed(kind, value, policy)` → lança `PolicyError('POLICY_DENIED')` com `details: { kind, value, rule }`;
  - acréscimos: `pinnedModelOf(agentInfo)` → `string|null`; `evaluateAgent(agentInfo, policy)` (nome + modelo fixado); `evaluateCommand(commandInfo, policy, agentsByName)` (modelo fixado + agente fixado e o modelo dele); o modelo fixado é checado primeiro por `evaluate('provider', providerID)` (provider de `model.providerID` ou do `parseFullId`) e depois por `evaluate('model', …)` — provider negado → agente/command negado; `assertAgentUsable`, `assertCommandUsable` (exit 4). F2a/F3 reusam `assertAgentUsable`/`assertCommandUsable` (donos das checagens de agente e command).
- Fora desta fase (F2a, mesmo arquivo): `BUILTIN_DESTRUCTIVE_BASH`, `buildPermissionRules`, `requiresUser`, `checkReply`.

- [ ] **Step 1: Write the failing test**

`tests/unit/policy.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, assertAllowed, evaluateAgent, evaluateCommand, assertAgentUsable, assertCommandUsable, pinnedModelOf,
} from '../../plugins/opc/scripts/lib/policy.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const WORLD = {
  providers: { allow: [], deny: [EQ] },
  models: { allow: [`${MV}/opencode-go/*`, 'anthropic/*'], deny: [] },
  agents: { allow: [], deny: ['work-*'] },
  tools: { deny: ['gitlab_*'] },
};

test('evaluate: empty policy allows everything', () => {
  assert.deepEqual(evaluate('model', `${EQ}/opencode-go/kimi-k3`, {}), { allowed: true });
  assert.deepEqual(evaluate('agent', 'work-deploy', undefined), { allowed: true });
});

test('evaluate: provider deny also denies its models', () => {
  const r = evaluate('model', `${EQ}/opencode-go/kimi-k3`, WORLD);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /policy\.providers\.deny: omniroute-work/);
});

test('evaluate: model allow list with globs across slashes', () => {
  assert.equal(evaluate('model', `${MV}/opencode-go/kimi-k3`, WORLD).allowed, true);
  assert.equal(evaluate('model', 'anthropic/claude-opus-5-5', WORLD).allowed, true);
  const r = evaluate('model', `${MV}/cx/gpt-5.6-sol`, WORLD);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /policy\.models\.allow \(global\)/);
});

test('evaluate: deny wins over allow', () => {
  const p = { models: { allow: ['*'], deny: ['*/kimi-*'] } };
  assert.equal(evaluate('model', `${MV}/opencode-go/kimi-k3`, p).allowed, false);
});

test('evaluate: workspace allow is an intersection (both lists must match)', () => {
  const p = { models: { allow: [`${MV}/*`], allowWorkspace: [`${MV}/opencode-go/kimi-*`], deny: [] } };
  assert.equal(evaluate('model', `${MV}/opencode-go/kimi-k3`, p).allowed, true);
  const r = evaluate('model', `${MV}/opencode-go/qwen3.8-max`, p);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /\.opc\.json/);
  const outside = evaluate('model', 'anthropic/claude-opus-5-5', { models: { allow: [`${MV}/*`], allowWorkspace: ['anthropic/*'] } });
  assert.equal(outside.allowed, false, 'workspace cannot widen the global allow');
});

test('evaluate: tools only have deny', () => {
  assert.equal(evaluate('tool', 'gitlab_list_mrs', WORLD).allowed, false);
  assert.equal(evaluate('tool', 'read', WORLD).allowed, true);
  assert.throws(() => evaluate('bogus', 'x', WORLD), TypeError);
});

test('assertAllowed: throws PolicyError (exit 4) with the rule', () => {
  assert.throws(() => assertAllowed('agent', 'work-reviewer', WORLD), (err) => {
    assert.equal(err.exitCode, 4);
    assert.equal(err.code, 'POLICY_DENIED');
    assert.equal(err.details.rule, 'policy.agents.deny: work-*');
    return true;
  });
  assert.deepEqual(assertAllowed('agent', 'build', WORLD), { allowed: true });
});

test('evaluateAgent: pinned model goes through the policy', () => {
  const pinned = { name: 'pinned-reviewer', model: { providerID: EQ, modelID: 'opencode-go/kimi-k3' } };
  assert.equal(pinnedModelOf(pinned), `${EQ}/opencode-go/kimi-k3`);
  const r = evaluateAgent(pinned, WORLD);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /^pinned model omniroute-work\/opencode-go\/kimi-k3/);
  assert.equal(evaluateAgent({ name: 'docs-writer', model: { providerID: MV, modelID: 'opencode-go/qwen3.8-max' } }, WORLD).allowed, true);
  assert.throws(() => assertAgentUsable(pinned, WORLD), (err) => err.exitCode === 4);
});

test('evaluateCommand: pinned model and pinned agent', () => {
  const agents = new Map([['work-deploy', { name: 'work-deploy' }]]);
  assert.equal(evaluateCommand({ name: 'docs', model: `${MV}/opencode-go/qwen3.8-max` }, WORLD).allowed, true);
  assert.equal(evaluateCommand({ name: 'work-release', model: `${EQ}/cx/gpt-5.5` }, WORLD).allowed, false);
  const r = evaluateCommand({ name: 'ship', agent: 'work-deploy' }, WORLD, agents);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /pinned agent work-deploy/);
  assert.throws(() => assertCommandUsable({ name: 'ship', agent: 'work-deploy' }, WORLD, agents), (err) => err.exitCode === 4);
});

test('pinned models also go through the provider policy (agent and command)', () => {
  const p = { providers: { allow: ['anthropic'], deny: [] }, models: { allow: ['*'], deny: [] } };
  const helper = { name: 'helper', model: { providerID: 'acme', modelID: 'm-1' } };
  const r = evaluateAgent(helper, p);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /^pinned model acme\/m-1: policy\.providers\.allow \(global\)/);
  assert.throws(() => assertAgentUsable(helper, p), (err) => err.exitCode === 4);
  assert.equal(evaluateCommand({ name: 'c', model: 'acme/m-1' }, p).allowed, false);
  assert.equal(evaluateCommand({ name: 'c2', agent: 'helper' }, p, new Map([['helper', helper]])).allowed, false);
  assert.equal(evaluateAgent({ name: 'ok', model: { providerID: 'anthropic', modelID: 'claude-x' } }, p).allowed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/policy.test.mjs`
Expected: FAIL com `Cannot find module '.../lib/policy.mjs'`.

- [ ] **Step 3: Write the implementation**

`plugins/opc/scripts/lib/policy.mjs`:

```js
// Allow/deny policy (spec §3.2, §6 items 4-5). Permission profiles and approver arrive in F2a.
import { PolicyError } from './opc-error.mjs';
import { matchesAny, parseFullId } from './models.mjs';

const SECTION = { provider: 'providers', model: 'models', agent: 'agents', tool: 'tools' };

function lists(policy, kind) {
  const section = policy?.[SECTION[kind]] ?? {};
  return {
    allow: Array.isArray(section.allow) ? section.allow : [],
    allowWorkspace: Array.isArray(section.allowWorkspace) ? section.allowWorkspace : [],
    deny: Array.isArray(section.deny) ? section.deny : [],
  };
}

function firstMatch(value, globs) {
  return globs.find((glob) => matchesAny(value, [glob])) ?? null;
}

export function evaluate(kind, value, policy) {
  if (!SECTION[kind]) throw new TypeError(`unknown policy kind: ${kind}`);
  const name = SECTION[kind];
  if (kind === 'model') {
    const { providerID } = parseFullId(value);
    if (providerID) {
      const viaProvider = evaluate('provider', providerID, policy);
      if (!viaProvider.allowed) return viaProvider;
    }
  }
  const { allow, allowWorkspace, deny } = lists(policy, kind);
  const denied = firstMatch(value, deny);
  if (denied) return { allowed: false, rule: `policy.${name}.deny: ${denied}` };
  if (kind !== 'tool') {
    if (allow.length > 0 && !matchesAny(value, allow)) return { allowed: false, rule: `policy.${name}.allow (global): not listed` };
    if (allowWorkspace.length > 0 && !matchesAny(value, allowWorkspace)) return { allowed: false, rule: `policy.${name}.allow (.opc.json): not listed` };
  }
  return { allowed: true };
}

export function assertAllowed(kind, value, policy) {
  const result = evaluate(kind, value, policy);
  if (!result.allowed) {
    throw new PolicyError('POLICY_DENIED', `${kind} "${value}" denied by ${result.rule}`, { details: { kind, value, rule: result.rule } });
  }
  return result;
}

export function pinnedModelOf(agentInfo) {
  const m = agentInfo?.model;
  return m && m.providerID && m.modelID ? `${m.providerID}/${m.modelID}` : null;
}

// A pinned model is checked against the provider policy first (explicit, even though evaluate('model')
// also inherits it) and then against the model policy.
function evaluatePinnedModel(full, policy, providerID = parseFullId(full).providerID) {
  if (providerID) {
    const byProvider = evaluate('provider', providerID, policy);
    if (!byProvider.allowed) return { allowed: false, rule: `pinned model ${full}: ${byProvider.rule}` };
  }
  const byModel = evaluate('model', full, policy);
  if (!byModel.allowed) return { allowed: false, rule: `pinned model ${full}: ${byModel.rule}` };
  return { allowed: true };
}

export function evaluateAgent(agentInfo, policy) {
  const byName = evaluate('agent', agentInfo.name, policy);
  if (!byName.allowed) return byName;
  const pinned = pinnedModelOf(agentInfo);
  if (pinned) {
    const byPinned = evaluatePinnedModel(pinned, policy, agentInfo.model.providerID);
    if (!byPinned.allowed) return byPinned;
  }
  return { allowed: true };
}

export function evaluateCommand(commandInfo, policy, agentsByName = new Map()) {
  if (commandInfo.model) {
    const byPinned = evaluatePinnedModel(String(commandInfo.model), policy);
    if (!byPinned.allowed) return byPinned;
  }
  if (commandInfo.agent) {
    const agent = agentsByName.get(commandInfo.agent) ?? { name: commandInfo.agent };
    const byAgent = evaluateAgent(agent, policy);
    if (!byAgent.allowed) return { allowed: false, rule: `pinned agent ${commandInfo.agent}: ${byAgent.rule}` };
  }
  return { allowed: true };
}

export function assertAgentUsable(agentInfo, policy) {
  const result = evaluateAgent(agentInfo, policy);
  if (!result.allowed) {
    throw new PolicyError('POLICY_DENIED', `agent "${agentInfo.name}" denied by ${result.rule}`, { details: { kind: 'agent', value: agentInfo.name, rule: result.rule } });
  }
  return result;
}

export function assertCommandUsable(commandInfo, policy, agentsByName = new Map()) {
  const result = evaluateCommand(commandInfo, policy, agentsByName);
  if (!result.allowed) {
    throw new PolicyError('POLICY_DENIED', `command "${commandInfo.name}" denied by ${result.rule}`, { details: { kind: 'command', value: commandInfo.name, rule: result.rule } });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/policy.test.mjs`
Expected: PASS (10 testes).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/policy.mjs tests/unit/policy.test.mjs
git commit -m "feat(policy): add allow/deny evaluation and pinned model checks"
```

---
### Task 5: `config.mjs` (parte A) — esquema completo, segredos, chaves travadas e merge restritivo

**Files:**
- Modify: `plugins/opc/scripts/lib/config.mjs` (substituir `DEFAULT_CONFIG`, `validateConfigShape` e `mergeConfig` do F0; acrescentar o bloco F1 parte A)
- Test: `tests/unit/config-f1.test.mjs`

**Interfaces:**
- Consumes: `LOCKED_KEYS`, `getPath`, `setPath`, `loadConfig`, `saveGlobalConfig`, `saveWorkspaceConfig` (F0, sem mudança); `matchesAny` (Task 3).
- Produces:
  - `DEFAULT_CONFIG` (congelado, neutro: sem restrição, sem aliases; `sensitivePaths` da spec; `approver: 'user'`; `configOverride: { share: 'disabled' }`);
  - `CONFIG_SCHEMA` — mapa `caminho → { type, nullable?, values?, min?, max?, internal? }`; tipos: `string`, `model`, `modelref`, `modelref-or-claude`, `boolean`, `integer`, `enum`, `string-list`, `modelref-list`, `enum-list`, `model-map`, `modelref-list-map`, `rules`, `rules-map`, `object`, `json`;
  - `schemaFor(dotted)` → descritor (inclui entradas de mapas: `aliases.<n>` → `model`, `routing.tasks.<n>` → `modelref-list`, `permissionProfiles.<n>` → `rules`, `server.configOverride.*` → `json`) ou `null`;
  - `isLockedKey(dotted)`, `isWorkspaceKey(dotted)`, `keyNeedsServer(dotted)` → `boolean`;
  - `findSecretLikeKeys(obj)` → `string[]` (chaves que casam `token|password|secret|api[-_]?key`, em qualquer profundidade);
  - `validateConfigShape(obj, { source })` → `{ errors: [{path, code:'INVALID_VALUE', message}], warnings: [{path, code:'UNKNOWN_KEY'|'SECRET_LIKE_KEY', message}] }`;
  - `mergeConfig(globalCfg, workspaceCfg)` → `{ config, warnings: [{path, code:'WORKSPACE_IGNORED'|'WORKSPACE_ALLOW_NARROWED', message}] }` (D2–D4).

- [ ] **Step 1: Write the failing test**

`tests/unit/config-f1.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, CONFIG_SCHEMA, validateConfigShape, mergeConfig, findSecretLikeKeys, isLockedKey, isWorkspaceKey,
  schemaFor, keyNeedsServer,
} from '../../plugins/opc/scripts/lib/config.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';

test('DEFAULT_CONFIG is valid against CONFIG_SCHEMA and neutral', () => {
  assert.deepEqual(validateConfigShape(DEFAULT_CONFIG, { source: 'default' }), { errors: [], warnings: [] });
  assert.deepEqual(DEFAULT_CONFIG.policy.models, { allow: [], deny: [] });
  assert.deepEqual(DEFAULT_CONFIG.aliases, {});
  assert.equal(DEFAULT_CONFIG.policy.approver, 'user');
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.policy));
});

test('validateConfigShape: type errors, unknown keys and secret-looking keys', () => {
  const { errors, warnings } = validateConfigShape({
    defaultModel: 42,
    stopGate: { enabled: 'yes' },
    policy: { approver: 'robot', models: { allow: 'x' } },
    conclave: { rounds: 9 },
    permissionProfiles: { bad: [{ permission: 'bash', pattern: 'x', action: 'always' }] },
    mystery: true,
    server: { configOverride: { provider: { p: { options: { apiKey: 'x' } } } } },
    githubToken: 'nope',
  }, { source: 'global' });
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['conclave.rounds', 'defaultModel', 'permissionProfiles', 'policy.approver', 'policy.models.allow', 'stopGate.enabled']);
  const warnPaths = warnings.map((w) => w.path);
  assert.ok(warnPaths.includes('mystery'));
  assert.ok(warnPaths.includes('githubToken'));
  assert.ok(warnPaths.includes('server.configOverride.provider.p.options.apiKey'));
  assert.ok(warnings.find((w) => w.path === 'githubToken' && w.code === 'SECRET_LIKE_KEY').message.includes('secret'));
  assert.ok(warnings.find((w) => w.path === 'mystery').code === 'UNKNOWN_KEY');
});

test('validateConfigShape: non-object config is an error', () => {
  assert.equal(validateConfigShape([], { source: 'workspace' }).errors.length, 1);
  assert.deepEqual(validateConfigShape(null), { errors: [], warnings: [] });
});

test('findSecretLikeKeys: token/password/secret/apikey at any depth', () => {
  assert.deepEqual(findSecretLikeKeys({ a: { API_KEY: 1, b: [{ password: 2 }] }, secretSauce: 3, fine: 4 }).sort(), ['a.API_KEY', 'a.b.0.password', 'secretSauce']);
});

test('isLockedKey / isWorkspaceKey', () => {
  for (const k of ['policy', 'policy.approver', 'policy.models.allow', 'permissionProfiles.x', 'server.configOverride', 'server.configOverride.share', 'server']) assert.ok(isLockedKey(k), k);
  for (const k of ['defaultModel', 'server.bootTimeoutSec', 'aliases.fast', 'stopGate.enabled']) assert.ok(!isLockedKey(k), k);
  assert.ok(isWorkspaceKey('policy.models.deny'));
  assert.ok(isWorkspaceKey('aliases.fast'));
  assert.ok(isWorkspaceKey('routing.tasks.ask'));
  assert.ok(!isWorkspaceKey('policy.approver'));
  assert.ok(!isWorkspaceKey('jobs.maxActive'));
  assert.ok(!isWorkspaceKey('stopGate.enabled'));
});

test('mergeConfig: global over defaults; restrictive workspace merge', () => {
  const global = {
    defaultModel: `${MV}/opencode-go/deepseek-v4.1-flash`,
    policy: { providers: { deny: [EQ] }, models: { allow: [`${MV}/*`] }, agents: { deny: ['work-*'] }, approver: 'claude' },
  };
  const workspace = {
    defaultModel: `${MV}/opencode-go/kimi-k3`,
    aliases: { k3: `${MV}/opencode-go/kimi-k3` },
    policy: {
      providers: { deny: ['anthropic'] },
      models: { allow: [`${MV}/opencode-go/*`, 'anthropic/*'], deny: ['*/qwen*'] },
      agents: { allow: ['build', 'plan'] },
      approver: 'claude',
      sensitivePaths: ['*.sqlite'],
    },
    permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
    server: { configOverride: { share: 'auto' }, bootTimeoutSec: 5 },
    jobs: { maxActive: 64 },
    stopGate: { enabled: true, model: 'fast' },
  };
  const { config, warnings } = mergeConfig(global, workspace);
  assert.equal(config.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(config.aliases.k3, `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(config.policy.providers.deny, [EQ, 'anthropic']);
  assert.deepEqual(config.policy.models.allow, [`${MV}/*`]);
  assert.deepEqual(config.policy.models.allowWorkspace, [`${MV}/opencode-go/*`, 'anthropic/*']);
  assert.deepEqual(config.policy.models.deny, ['*/qwen*']);
  assert.deepEqual(config.policy.agents.allowWorkspace, ['build', 'plan']);
  assert.equal(config.policy.approver, 'claude', 'global approver kept');
  assert.ok(config.policy.sensitivePaths.includes('*.sqlite'));
  assert.ok(config.policy.sensitivePaths.includes('*.env'));
  assert.deepEqual(config.permissionProfiles, {});
  assert.deepEqual(config.server.configOverride, { share: 'disabled' });
  assert.equal(config.server.bootTimeoutSec, 60);
  assert.equal(config.jobs.maxActive, 8);
  assert.equal(config.stopGate.enabled, false);
  assert.equal(config.stopGate.model, 'fast');
  const w = warnings.map((x) => x.path);
  for (const p of ['policy.approver', 'permissionProfiles', 'server', 'jobs', 'stopGate.enabled', 'policy.models.allow']) assert.ok(w.includes(p), `warning for ${p}`);
  assert.match(warnings.find((x) => x.path === 'policy.models.allow').message, /anthropic\/\*.*intersection/);
  assert.equal(validateConfigShape(config, { source: 'effective' }).errors.length, 0);
});

test('mergeConfig: missing files give DEFAULT_CONFIG and no warnings', () => {
  const { config, warnings } = mergeConfig(null, undefined);
  assert.deepEqual(config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  assert.deepEqual(warnings, []);
});

test('schemaFor: exact keys and map entries', () => {
  assert.equal(schemaFor('defaultModel').type, 'model');
  assert.equal(schemaFor('aliases.fast').type, 'model');
  assert.equal(schemaFor('routing.tasks.ask').type, 'modelref-list');
  assert.equal(schemaFor('permissionProfiles.npm-test-only').type, 'rules');
  assert.equal(schemaFor('server.configOverride.share').type, 'json');
  assert.equal(schemaFor('nope'), null);
  assert.equal(schemaFor('routing.tasks.ask.deeper'), null);
  assert.ok(Object.keys(CONFIG_SCHEMA).length > 40);
});

test('keyNeedsServer', () => {
  for (const k of ['defaultModel', 'reviewModel', 'aliases.fast', 'routing.tasks.ask', 'defaultAgent', 'defaultVariant', 'defaultProvider', 'conclave.judge']) assert.ok(keyNeedsServer(k), k);
  for (const k of ['stopGate.enabled', 'policy.models.allow', 'jobs.maxActive']) assert.ok(!keyNeedsServer(k), k);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/config-f1.test.mjs`
Expected: FAIL — `CONFIG_SCHEMA`/`schemaFor`/`isLockedKey` não são exportados por `config.mjs`.

- [ ] **Step 3: Check for name collisions, then replace the F0 definitions**

```bash
grep -nE "^(export )?(const|function|let) (freezeDeep|schemaField|TASK_TYPES|MAP_ENTRY|GROUPS|SECRET_LIKE|WORKSPACE_PREFERENCE_KEYS|WORKSPACE_POLICY_LISTS|MODEL_TYPES|isObj|cloneJson|checkValue|checkRules|mergeDeep|unionList|mergeWorkspacePolicy)\b" plugins/opc/scripts/lib/config.mjs
grep -n "export const DEFAULT_CONFIG\|export function validateConfigShape\|export function mergeConfig" plugins/opc/scripts/lib/config.mjs
```

Expected: o primeiro grep não acha nada (se achar, renomear a versão do F1 com sufixo `F1` em todo o bloco); o segundo acha as três definições do F0. **Apagar** essas três definições do F0 (e helpers privados usados só por elas) e colar no fim do arquivo:

```js
// ---- F1: complete schema, restrictive merge, locked keys, edits and server validation (spec §3.2, §3.3) ----
import { matchesAny } from './models.mjs';

const freezeDeep = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && freezeDeep(v)); return Object.freeze(o); };

export const DEFAULT_CONFIG = freezeDeep({
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
  routing: { tasks: {}, tiers: {}, fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } },
  conclave: { pools: {}, defaultPool: null, judge: 'claude', rounds: 1, quorum: 2, memberTimeoutSec: 900 },
  orchestrate: { planner: null, maxSubtasks: 5, synthesizer: 'claude' },
  delegation: { auto: false },
  jobs: { maxActive: 8, maxParallel: 4 },
  server: { bootTimeoutSec: 60, requestTimeoutSec: 30, configOverride: { share: 'disabled' } },
});

const schemaField = (type, extra = {}) => Object.freeze({ type, ...extra });
const TASK_TYPES = ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'];

export const CONFIG_SCHEMA = Object.freeze({
  defaultProvider: schemaField('string', { nullable: true }),
  defaultModel: schemaField('model', { nullable: true }),
  defaultVariant: schemaField('string', { nullable: true }),
  defaultAgent: schemaField('string', { nullable: true }),
  aliases: schemaField('model-map'),
  reviewModel: schemaField('modelref', { nullable: true }),
  'stopGate.enabled': schemaField('boolean'),
  'stopGate.model': schemaField('modelref', { nullable: true }),
  'project.goal': schemaField('string', { nullable: true }),
  'project.scope': schemaField('string-list'),
  'project.taskTypes': schemaField('enum-list', { values: TASK_TYPES }),
  'policy.providers.allow': schemaField('string-list'),
  'policy.providers.deny': schemaField('string-list'),
  'policy.providers.allowWorkspace': schemaField('string-list', { internal: true }),
  'policy.models.allow': schemaField('string-list'),
  'policy.models.deny': schemaField('string-list'),
  'policy.models.allowWorkspace': schemaField('string-list', { internal: true }),
  'policy.agents.allow': schemaField('string-list'),
  'policy.agents.deny': schemaField('string-list'),
  'policy.agents.allowWorkspace': schemaField('string-list', { internal: true }),
  'policy.tools.deny': schemaField('string-list'),
  'policy.sensitivePaths': schemaField('string-list'),
  'policy.destructiveBash': schemaField('string-list'),
  'policy.approver': schemaField('enum', { values: ['user', 'claude'] }),
  'policy.permissionTimeoutSec': schemaField('integer', { min: 1, max: 86400 }),
  permissionProfiles: schemaField('rules-map'),
  'routing.tasks': schemaField('modelref-list-map'),
  'routing.tiers': schemaField('modelref-list-map'),
  'routing.fallback.enabled': schemaField('boolean'),
  'routing.fallback.maxAttempts': schemaField('integer', { min: 1, max: 10 }),
  'routing.fallback.maxProviderRetries': schemaField('integer', { min: 0, max: 20 }),
  'routing.fallback.maxRetryWaitSec': schemaField('integer', { min: 0, max: 3600 }),
  'conclave.pools': schemaField('modelref-list-map'),
  'conclave.defaultPool': schemaField('string', { nullable: true }),
  'conclave.judge': schemaField('modelref-or-claude'),
  'conclave.rounds': schemaField('integer', { min: 1, max: 3 }),
  'conclave.quorum': schemaField('integer', { min: 2, max: 16 }),
  'conclave.memberTimeoutSec': schemaField('integer', { min: 1, max: 86400 }),
  'orchestrate.planner': schemaField('modelref', { nullable: true }),
  'orchestrate.maxSubtasks': schemaField('integer', { min: 2, max: 20 }),
  'orchestrate.synthesizer': schemaField('modelref-or-claude'),
  'delegation.auto': schemaField('boolean'),
  'jobs.maxActive': schemaField('integer', { min: 1, max: 64 }),
  'jobs.maxParallel': schemaField('integer', { min: 1, max: 32 }),
  'server.bootTimeoutSec': schemaField('integer', { min: 1, max: 600 }),
  'server.requestTimeoutSec': schemaField('integer', { min: 1, max: 600 }),
  'server.configOverride': schemaField('object'),
});

const MAP_ENTRY = { 'model-map': schemaField('model'), 'modelref-list-map': schemaField('modelref-list'), 'rules-map': schemaField('rules'), object: schemaField('json') };
const GROUPS = new Set(Object.keys(CONFIG_SCHEMA).flatMap((k) => k.split('.').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('.'))));
const SECRET_LIKE = /(token|password|secret|api[-_]?key)/i;
const WORKSPACE_PREFERENCE_KEYS = ['defaultProvider', 'defaultModel', 'defaultVariant', 'defaultAgent', 'aliases', 'reviewModel', 'stopGate.model', 'project', 'routing', 'conclave', 'orchestrate'];
const WORKSPACE_POLICY_LISTS = ['policy.providers.allow', 'policy.providers.deny', 'policy.models.allow', 'policy.models.deny', 'policy.agents.allow', 'policy.agents.deny', 'policy.tools.deny', 'policy.sensitivePaths', 'policy.destructiveBash'];
const MODEL_TYPES = new Set(['model', 'modelref', 'modelref-or-claude', 'model-map', 'modelref-list-map', 'modelref-list']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cloneJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function schemaFor(dotted) {
  if (CONFIG_SCHEMA[dotted]) return CONFIG_SCHEMA[dotted];
  const parts = dotted.split('.');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const parent = CONFIG_SCHEMA[parts.slice(0, i).join('.')];
    if (parent && MAP_ENTRY[parent.type]) return parent.type === 'object' ? MAP_ENTRY.object : (i === parts.length - 1 ? MAP_ENTRY[parent.type] : null);
  }
  return null;
}

export function isLockedKey(dotted) {
  return LOCKED_KEYS.some((k) => dotted === k || dotted.startsWith(`${k}.`) || k.startsWith(`${dotted}.`));
}

export function isWorkspaceKey(dotted) {
  if (WORKSPACE_POLICY_LISTS.includes(dotted)) return true;
  return WORKSPACE_PREFERENCE_KEYS.some((k) => dotted === k || dotted.startsWith(`${k}.`));
}

export function keyNeedsServer(dotted) {
  const desc = schemaFor(dotted);
  return Boolean(desc && MODEL_TYPES.has(desc.type)) || ['defaultProvider', 'defaultAgent', 'defaultVariant'].includes(dotted);
}

function checkValue(desc, value) {
  if (value === null) return desc.nullable ? null : 'must not be null';
  switch (desc.type) {
    case 'string': case 'model': case 'modelref': case 'modelref-or-claude':
      return typeof value === 'string' && value.trim() !== '' ? null : 'must be a non-empty string';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'integer':
      if (!Number.isInteger(value)) return 'must be an integer';
      if (value < desc.min || value > desc.max) return `must be between ${desc.min} and ${desc.max}`;
      return null;
    case 'enum':
      return desc.values.includes(value) ? null : `must be one of: ${desc.values.join(', ')}`;
    case 'string-list': case 'modelref-list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '') ? null : 'must be a list of non-empty strings';
    case 'enum-list':
      if (!Array.isArray(value)) return 'must be a list';
      return value.every((v) => desc.values.includes(v)) ? null : `items must be in: ${desc.values.join(', ')}`;
    case 'model-map':
      return isObj(value) && Object.values(value).every((v) => typeof v === 'string' && v.trim() !== '') ? null : 'must map names to model IDs';
    case 'modelref-list-map':
      return isObj(value) && Object.values(value).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string')) ? null : 'must map names to lists of models';
    case 'rules': return checkRules(value);
    case 'rules-map':
      if (!isObj(value)) return 'must map profile names to rule lists';
      for (const rules of Object.values(value)) { const e = checkRules(rules); if (e) return e; }
      return null;
    case 'object': return isObj(value) ? null : 'must be an object';
    case 'json': return null;
    default: return `unknown schema type ${desc.type}`;
  }
}

function checkRules(rules) {
  if (!Array.isArray(rules)) return 'rules must be a list';
  const ok = rules.every((r) => isObj(r) && typeof r.permission === 'string' && typeof r.pattern === 'string' && ['allow', 'deny', 'ask'].includes(r.action));
  return ok ? null : 'each rule needs {permission, pattern, action: allow|deny|ask}';
}

export function findSecretLikeKeys(obj, prefix = '') {
  const hits = [];
  if (!isObj(obj) && !Array.isArray(obj)) return hits;
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!Array.isArray(obj) && SECRET_LIKE.test(key)) hits.push(p);
    hits.push(...findSecretLikeKeys(value, p));
  }
  return hits;
}

export function validateConfigShape(obj, { source = 'global' } = {}) {
  const errors = [];
  const warnings = [];
  if (obj === null || obj === undefined) return { errors, warnings };
  if (!isObj(obj)) return { errors: [{ path: '', code: 'INVALID_VALUE', message: `${source} config must be a JSON object` }], warnings };
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${key}` : key;
      const desc = CONFIG_SCHEMA[p];
      if (desc) {
        const problem = checkValue(desc, value);
        if (problem) errors.push({ path: p, code: 'INVALID_VALUE', message: problem });
      } else if (GROUPS.has(p)) {
        if (isObj(value)) walk(value, p);
        else errors.push({ path: p, code: 'INVALID_VALUE', message: 'must be an object' });
      } else {
        warnings.push({ path: p, code: 'UNKNOWN_KEY', message: `unknown key (ignored) in ${source} config` });
      }
    }
  };
  walk(obj, '');
  for (const p of findSecretLikeKeys(obj)) {
    warnings.push({ path: p, code: 'SECRET_LIKE_KEY', message: 'key looks like a secret; config files must never hold secrets (use env vars or the vault)' });
  }
  return { errors, warnings };
}

function mergeDeep(base, over) {
  if (!isObj(base) || !isObj(over)) return cloneJson(over);
  const out = cloneJson(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : cloneJson(v);
  return out;
}

const unionList = (a = [], b = []) => [...new Set([...(a ?? []), ...(b ?? [])])];

export function mergeConfig(globalCfg, workspaceCfg) {
  const warnings = [];
  const config = mergeDeep(cloneJson(DEFAULT_CONFIG), isObj(globalCfg) ? globalCfg : {});
  const ws = isObj(workspaceCfg) ? workspaceCfg : {};
  const ignore = (p, why) => warnings.push({ path: p, code: 'WORKSPACE_IGNORED', message: `.opc.json: ${why}; ignored` });
  for (const [key, value] of Object.entries(ws)) {
    if (key === 'policy') {
      if (!isObj(value)) { ignore('policy', 'must be an object'); continue; }
      mergeWorkspacePolicy(config, value, ignore, warnings);
    } else if (key === 'stopGate' && isObj(value)) {
      for (const [sub, v] of Object.entries(value)) {
        if (sub === 'model') config.stopGate.model = cloneJson(v);
        else ignore(`stopGate.${sub}`, 'not overridable per workspace');
      }
    } else if (WORKSPACE_PREFERENCE_KEYS.includes(key)) {
      config[key] = isObj(value) && isObj(config[key]) ? mergeDeep(config[key], value) : cloneJson(value);
    } else if (isLockedKey(key) || key === 'server') {
      ignore(key, 'locked key (global only)');
    } else if (key in DEFAULT_CONFIG) {
      ignore(key, 'not overridable per workspace');
    } else {
      ignore(key, 'unknown key');
    }
  }
  return { config, warnings };
}

function mergeWorkspacePolicy(config, wsPolicy, ignore, warnings) {
  for (const [sub, value] of Object.entries(wsPolicy)) {
    const p = `policy.${sub}`;
    if (['providers', 'models', 'agents', 'tools'].includes(sub) && isObj(value)) {
      for (const [listName, list] of Object.entries(value)) {
        const lp = `${p}.${listName}`;
        if (!Array.isArray(list)) { ignore(lp, 'must be a list'); continue; }
        if (listName === 'deny') {
          config.policy[sub].deny = unionList(config.policy[sub].deny, list);
        } else if (listName === 'allow' && sub !== 'tools') {
          if (list.length === 0) continue;
          const globalAllow = config.policy[sub].allow;
          if (globalAllow.length > 0) {
            for (const entry of list) {
              if (!matchesAny(entry, globalAllow)) warnings.push({ path: lp, code: 'WORKSPACE_ALLOW_NARROWED', message: `.opc.json: "${entry}" is outside the global allow list; only the intersection applies` });
            }
          }
          config.policy[sub].allowWorkspace = [...list];
        } else {
          ignore(lp, 'only allow/deny lists can be set per workspace');
        }
      }
    } else if ((sub === 'sensitivePaths' || sub === 'destructiveBash') && Array.isArray(value)) {
      config.policy[sub] = unionList(config.policy[sub], value);
    } else {
      ignore(p, 'locked key (global only)');
    }
  }
}
// ---- end F1 (part A) ----
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/config-f1.test.mjs && npm test`
Expected: PASS (9 testes novos). Se algum teste do F0 em `tests/unit/config.test.mjs` afirmar a representação antiga do `allow` do workspace, atualizar a asserção para `allowWorkspace` (mesmo comportamento: o workspace não amplia) e registrar no relatório como ajuste de representação. O aceite do F0 ".opc.json que tenta ampliar allow ou mudar chave travada → ignorado com aviso" continua verde.

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/config.mjs tests/unit/config-f1.test.mjs tests/unit/config.test.mjs
git commit -m "feat(config): complete schema, secret-key warnings and restrictive workspace merge"
```

---

### Task 6: `config.mjs` (parte B) — edição, coerção, normalização e validação contra o servidor

**Files:**
- Modify: `plugins/opc/scripts/lib/config.mjs` (imports + bloco F1 parte B)
- Test: `tests/unit/config-f1-edit.test.mjs`

**Interfaces:**
- Consumes: parte A (Task 5); `UsageError` (F0); `resolveModelRef`, `normalizeModelId`, `validateVariant` (Task 3); `evaluate`, `evaluateAgent` (Task 4).
- Produces:
  - `unsetPath(obj, dotted)` → novo objeto;
  - `coerceValue(dotted, raw)` → valor tipado pelo esquema (`'null'`, booleanos, inteiros com faixa, enums, listas por JSON ou vírgulas — também `[a,b]` com aspas removidas pelo shell —, mapas/regras por JSON); `UsageError('UNKNOWN_KEY' | 'INVALID_VALUE')`;
  - `isListKey(dotted)` → `boolean`;
  - `applyConfigEdit(cfg, op, dotted, value)` → novo objeto; `op`: `set|unset|add|remove`; `UsageError('NOT_A_LIST' | 'NOT_IN_LIST')`;
  - `normalizeEditValue(dotted, value, { catalog, aliases, defaultProvider })` → valor com IDs completos (aliases e `claude` preservados);
  - `modelRefsIn(cfg)` → `[{ path, value, kind: 'model'|'modelref'|'modelref-or-claude' }]` (`routing.tasks.ask[0]`, `aliases.fast`, …);
  - `validateAgainstServer(cfg, { catalog, agents, opencodeConfig })` → `{ errors: [{path, code, message}], warnings }` — códigos `UNKNOWN_MODEL`, `BROKEN_ALIAS`, `UNKNOWN_VARIANT`, `UNKNOWN_PROVIDER`, `UNKNOWN_AGENT`, `AGENT_MODE`, `UNKNOWN_POOL`; lê valores gravados com `fullOnly` (D1);
  - `policyViolations(cfg, { catalog, agents })` → `[{ path, code: 'POLICY_DENIED', message, rule }]` (modelos referenciados, `defaultProvider`, `defaultAgent` e o modelo que ele fixa);
  - `configPaths({ dataDir, workspaceRoot })` → `{ dataDir, global, workspace, draft }`.

- [ ] **Step 1: Write the failing test**

`tests/unit/config-f1-edit.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG, mergeConfig, coerceValue, applyConfigEdit, unsetPath, normalizeEditValue, modelRefsIn,
  validateAgainstServer, policyViolations, configPaths,
} from '../../plugins/opc/scripts/lib/config.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog(load('provider.json'));
const agents = load('agent.json');
const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const fresh = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));

test('coerceValue: per type', () => {
  assert.equal(coerceValue('stopGate.enabled', 'true'), true);
  assert.equal(coerceValue('jobs.maxActive', '4'), 4);
  assert.equal(coerceValue('defaultModel', 'null'), null);
  assert.deepEqual(coerceValue('policy.models.deny', 'a/*,b/*'), ['a/*', 'b/*']);
  assert.deepEqual(coerceValue('policy.models.deny', '["a/*","b/*"]'), ['a/*', 'b/*']);
  assert.deepEqual(coerceValue('policy.models.deny', '[a/*,b/*]'), ['a/*', 'b/*'], 'shell-stripped quotes still parse');
  assert.deepEqual(coerceValue('aliases', '{"fast":"p/m"}'), { fast: 'p/m' });
  assert.equal(coerceValue('policy.approver', 'claude'), 'claude');
  assert.throws(() => coerceValue('policy.approver', 'robot'), (e) => e.code === 'INVALID_VALUE' && e.exitCode === 2);
  assert.throws(() => coerceValue('jobs.maxActive', '999'), (e) => e.code === 'INVALID_VALUE');
  assert.throws(() => coerceValue('jobs.maxActive', 'four'), (e) => e.code === 'INVALID_VALUE');
  assert.throws(() => coerceValue('nope.key', 'x'), (e) => e.code === 'UNKNOWN_KEY');
  assert.throws(() => coerceValue('aliases', '{bad'), (e) => e.code === 'INVALID_VALUE');
});

test('applyConfigEdit: set, unset, add (dedupe), remove', () => {
  let cfg = applyConfigEdit({}, 'set', 'stopGate.enabled', true);
  assert.deepEqual(cfg, { stopGate: { enabled: true } });
  cfg = applyConfigEdit(cfg, 'add', 'policy.models.deny', 'a/*');
  cfg = applyConfigEdit(cfg, 'add', 'policy.models.deny', 'a/*');
  assert.deepEqual(cfg.policy.models.deny, ['a/*']);
  cfg = applyConfigEdit(cfg, 'remove', 'policy.models.deny', 'a/*');
  assert.deepEqual(cfg.policy.models.deny, []);
  assert.throws(() => applyConfigEdit(cfg, 'remove', 'policy.models.deny', 'zzz'), (e) => e.code === 'NOT_IN_LIST');
  assert.throws(() => applyConfigEdit(cfg, 'add', 'defaultModel', 'x'), (e) => e.code === 'NOT_A_LIST');
  cfg = applyConfigEdit(cfg, 'unset', 'stopGate.enabled');
  assert.deepEqual(cfg.stopGate, {});
  assert.deepEqual(unsetPath({ a: 1 }, 'b.c'), { a: 1 });
});

test('normalizeEditValue: short names become full ids, aliases stay', () => {
  const aliases = { strong: `${MV}/opencode-go/qwen3.8-max` };
  const opts = { catalog, aliases, defaultProvider: MV };
  assert.equal(normalizeEditValue('defaultModel', 'opencode-go/kimi-k3', opts), `${MV}/opencode-go/kimi-k3`);
  assert.equal(normalizeEditValue('reviewModel', 'strong', opts), 'strong');
  assert.equal(normalizeEditValue('conclave.judge', 'claude', opts), 'claude');
  assert.deepEqual(normalizeEditValue('routing.tasks.ask', ['strong', 'opencode-go/kimi-k3'], opts), ['strong', `${MV}/opencode-go/kimi-k3`]);
  assert.deepEqual(normalizeEditValue('aliases', { fast: 'opencode-go/deepseek-v4.1-flash' }, opts), { fast: `${MV}/opencode-go/deepseek-v4.1-flash` });
  assert.throws(() => normalizeEditValue('defaultModel', 'opencode/big-pickle', opts), (e) => e.code === 'AMBIGUOUS_MODEL');
  assert.equal(normalizeEditValue('policy.approver', 'user', opts), 'user');
});

test('modelRefsIn lists every model reference with its path', () => {
  const refs = modelRefsIn({ ...DEFAULT_CONFIG, defaultModel: 'p/m', aliases: { fast: 'p/f' }, routing: { tasks: { ask: ['fast', 'p/x'] }, tiers: {} } });
  assert.deepEqual(refs.map((r) => r.path), ['defaultModel', 'orchestrate.synthesizer', 'conclave.judge', 'aliases.fast', 'routing.tasks.ask[0]', 'routing.tasks.ask[1]']);
  assert.deepEqual(refs.map((r) => r.kind), ['model', 'modelref-or-claude', 'modelref-or-claude', 'model', 'modelref', 'modelref']);
});

test('validateAgainstServer: unknown model, invalid variant, broken alias, alias chain, agent checks', () => {
  const cfg = {
    ...fresh(),
    defaultProvider: 'openai',
    defaultModel: `${MV}/opencode-go/kimi-k3`,
    defaultVariant: 'ultra',
    defaultAgent: 'general',
    aliases: { fast: `${MV}/opencode-go/deepseek-v4.1-flash`, gone: `${MV}/opencode-go/removed-model`, chain: 'fast' },
    reviewModel: 'gone',
    stopGate: { enabled: false, model: `${MV}/opencode-go/nope` },
    routing: { tasks: { ask: ['fast'] }, tiers: {}, fallback: DEFAULT_CONFIG.routing.fallback },
    conclave: { ...DEFAULT_CONFIG.conclave, defaultPool: 'missing' },
  };
  const { errors } = validateAgainstServer(cfg, { catalog, agents });
  const byPath = Object.fromEntries(errors.map((e) => [e.path, e.code]));
  assert.equal(byPath.defaultProvider, 'UNKNOWN_PROVIDER');
  assert.equal(byPath.defaultVariant, 'UNKNOWN_VARIANT');
  assert.equal(byPath.defaultAgent, 'AGENT_MODE');
  assert.equal(byPath['aliases.gone'], 'UNKNOWN_MODEL');
  assert.equal(byPath['aliases.chain'], 'BROKEN_ALIAS');
  assert.equal(byPath.reviewModel, 'BROKEN_ALIAS');
  assert.equal(byPath['stopGate.model'], 'UNKNOWN_MODEL');
  assert.equal(byPath['conclave.defaultPool'], 'UNKNOWN_POOL');
  assert.equal(byPath['routing.tasks.ask[0]'], undefined, 'valid alias reference');
  const ok = validateAgainstServer({ ...fresh(), defaultModel: `${MV}/opencode-go/kimi-k3`, defaultVariant: 'high', defaultAgent: 'build' }, { catalog, agents });
  assert.deepEqual(ok.errors, []);
});

test('validateAgainstServer: stored full ids are read without defaultProvider prefix', () => {
  const cfg = { ...fresh(), defaultProvider: MV, defaultModel: 'opencode/big-pickle' };
  assert.deepEqual(validateAgainstServer(cfg, { catalog, agents }).errors, []);
});

test('defaultVariant falls back to the OpenCode default model', () => {
  const cfg = { ...fresh(), defaultVariant: 'max' };
  const { errors } = validateAgainstServer(cfg, { catalog, agents, opencodeConfig: { model: `${MV}/opencode-go/qwen3.8-max` } });
  assert.deepEqual(errors, []);
});

test('policyViolations: denied defaults, aliases and pinned agent models', () => {
  const cfg = mergeConfig({
    defaultProvider: EQ,
    defaultModel: `${EQ}/opencode-go/kimi-k3`,
    defaultAgent: 'docs-writer',
    aliases: { eqk3: `${EQ}/opencode-go/kimi-k3` },
    reviewModel: 'eqk3',
    policy: { providers: { deny: [EQ] }, models: { deny: ['*/qwen3.8-max'] } },
  }, {}).config;
  const v = policyViolations(cfg, { catalog, agents });
  const paths = v.map((e) => e.path).sort();
  assert.deepEqual(paths, ['aliases.eqk3', 'defaultAgent', 'defaultModel', 'defaultProvider', 'reviewModel']);
  assert.match(v.find((e) => e.path === 'defaultAgent').rule, /pinned model/);
  assert.ok(v.every((e) => e.code === 'POLICY_DENIED'));
});

test('configPaths', () => {
  assert.deepEqual(configPaths({ dataDir: '/d', workspaceRoot: '/w' }), { dataDir: '/d', global: '/d/config.json', workspace: '/w/.opc.json', draft: '/d/config.draft.json' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/config-f1-edit.test.mjs`
Expected: FAIL — `coerceValue` (e os demais) não são exportados.

- [ ] **Step 3: Write the implementation**

No bloco F1 de `config.mjs`, trocar a linha `import { matchesAny } from './models.mjs';` por (se o F0 já importar `UsageError` de `./opc-error.mjs`, **não** repetir essa linha):

```js
import { join as joinPathF1 } from 'node:path';
import { UsageError } from './opc-error.mjs';
import { matchesAny, resolveModelRef, normalizeModelId, validateVariant } from './models.mjs';
import { evaluate, evaluateAgent } from './policy.mjs';
```

E colar no fim do arquivo:

```js
// ---- F1 (part B): edits, coercion, normalization, server validation ----
export function unsetPath(obj, dotted) {
  const [head, ...rest] = dotted.split('.');
  if (!isObj(obj) || !(head in obj)) return obj;
  const out = { ...obj };
  if (rest.length === 0) delete out[head];
  else out[head] = unsetPath(obj[head], rest.join('.'));
  return out;
}

function parseList(raw) {
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch { /* fall back to comma split (quotes may have been stripped by the shell splitter) */ }
    return text.replace(/^\[|\]$/g, '').split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return text === '' ? [] : text.split(',').map((v) => v.trim()).filter(Boolean);
}

export function coerceValue(dotted, raw) {
  const desc = schemaFor(dotted);
  if (!desc) throw new UsageError('UNKNOWN_KEY', `unknown config key "${dotted}"`);
  const text = String(raw).trim();
  if (desc.nullable && text === 'null') return null;
  switch (desc.type) {
    case 'boolean':
      if (['true', 'yes', 'on', '1'].includes(text.toLowerCase())) return true;
      if (['false', 'no', 'off', '0'].includes(text.toLowerCase())) return false;
      throw new UsageError('INVALID_VALUE', `${dotted} must be true or false`);
    case 'integer': {
      if (!/^-?\d+$/.test(text)) throw new UsageError('INVALID_VALUE', `${dotted} must be an integer`);
      const n = Number(text);
      const problem = checkValue(desc, n);
      if (problem) throw new UsageError('INVALID_VALUE', `${dotted} ${problem}`);
      return n;
    }
    case 'enum':
      if (!desc.values.includes(text)) throw new UsageError('INVALID_VALUE', `${dotted} must be one of: ${desc.values.join(', ')}`);
      return text;
    case 'string-list': case 'modelref-list': case 'enum-list': {
      const list = parseList(text);
      const problem = checkValue(desc, list);
      if (problem) throw new UsageError('INVALID_VALUE', `${dotted} ${problem}`);
      return list;
    }
    case 'model-map': case 'modelref-list-map': case 'rules-map': case 'rules': case 'object': case 'json': {
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new UsageError('INVALID_VALUE', `${dotted} expects JSON`); }
      const problem = checkValue(desc, parsed);
      if (problem) throw new UsageError('INVALID_VALUE', `${dotted} ${problem}`);
      return parsed;
    }
    default:
      if (text === '') throw new UsageError('INVALID_VALUE', `${dotted} must not be empty`);
      return text;
  }
}

export function isListKey(dotted) {
  const desc = schemaFor(dotted);
  return Boolean(desc && desc.type.endsWith('-list'));
}

export function applyConfigEdit(cfg, op, dotted, value) {
  const base = isObj(cfg) ? cfg : {};
  if (op === 'set') return setPath(base, dotted, value);
  if (op === 'unset') return unsetPath(base, dotted);
  if (!isListKey(dotted)) throw new UsageError('NOT_A_LIST', `${dotted} is not a list key (use set)`);
  const current = Array.isArray(getPath(base, dotted)) ? getPath(base, dotted) : [];
  const items = Array.isArray(value) ? value : [value];
  if (op === 'add') return setPath(base, dotted, unionList(current, items));
  if (op === 'remove') {
    const missing = items.filter((v) => !current.includes(v));
    if (missing.length) throw new UsageError('NOT_IN_LIST', `${dotted} does not contain: ${missing.join(', ')}`);
    return setPath(base, dotted, current.filter((v) => !items.includes(v)));
  }
  throw new UsageError('USAGE', `unknown config operation "${op}"`);
}

export function normalizeEditValue(dotted, value, { catalog, aliases = {}, defaultProvider = null }) {
  const desc = schemaFor(dotted);
  if (!desc || value === null) return value;
  const ref = (v, allowClaude = false) => resolveModelRef(v, { catalog, aliases, defaultProvider, allowClaude }).value;
  switch (desc.type) {
    case 'model': return normalizeModelId(value, { catalog, aliases, defaultProvider }).full;
    case 'modelref': return ref(value);
    case 'modelref-or-claude': return ref(value, true);
    case 'modelref-list': return value.map((v) => ref(v));
    case 'model-map': return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeModelId(v, { catalog, defaultProvider }).full]));
    case 'modelref-list-map': return Object.fromEntries(Object.entries(value).map(([k, list]) => [k, list.map((v) => ref(v))]));
    default: return value;
  }
}

export function modelRefsIn(cfg) {
  const out = [];
  const push = (path, value, kind) => { if (typeof value === 'string' && value !== '') out.push({ path, value, kind }); };
  push('defaultModel', cfg.defaultModel, 'model');
  push('reviewModel', cfg.reviewModel, 'modelref');
  push('stopGate.model', cfg.stopGate?.model, 'modelref');
  push('orchestrate.planner', cfg.orchestrate?.planner, 'modelref');
  push('orchestrate.synthesizer', cfg.orchestrate?.synthesizer, 'modelref-or-claude');
  push('conclave.judge', cfg.conclave?.judge, 'modelref-or-claude');
  for (const [name, target] of Object.entries(cfg.aliases ?? {})) push(`aliases.${name}`, target, 'model');
  for (const group of ['routing.tasks', 'routing.tiers', 'conclave.pools']) {
    for (const [name, list] of Object.entries(getPath(cfg, group) ?? {})) {
      (Array.isArray(list) ? list : []).forEach((v, i) => push(`${group}.${name}[${i}]`, v, 'modelref'));
    }
  }
  return out;
}

function resolveStored(ref, cfg, catalog) {
  if (ref.kind === 'modelref-or-claude' && ref.value === 'claude') return { full: null };
  if (ref.kind !== 'model' && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value)) {
    const target = cfg.aliases[ref.value];
    return { full: normalizeModelId(target, { catalog, fullOnly: true }).full };
  }
  return { full: normalizeModelId(ref.value, { catalog, fullOnly: true }).full };
}

export function validateAgainstServer(cfg, { catalog, agents = [], opencodeConfig = null }) {
  const errors = [];
  const warnings = [];
  for (const ref of modelRefsIn(cfg)) {
    if (ref.path.startsWith('aliases.') && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value)) {
      errors.push({ path: ref.path, code: 'BROKEN_ALIAS', message: `alias points to another alias "${ref.value}" (only 1 level is allowed)` });
      continue;
    }
    try {
      resolveStored(ref, cfg, catalog);
    } catch (err) {
      const viaAlias = ref.kind !== 'model' && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value);
      errors.push({ path: ref.path, code: viaAlias ? 'BROKEN_ALIAS' : (err.code ?? 'UNKNOWN_MODEL'), message: viaAlias ? `alias "${ref.value}" is broken: ${err.message}` : err.message });
    }
  }
  if (cfg.defaultProvider && !catalog.connected.has(cfg.defaultProvider)) {
    errors.push({ path: 'defaultProvider', code: 'UNKNOWN_PROVIDER', message: `provider "${cfg.defaultProvider}" is not connected` });
  }
  if (cfg.defaultVariant) {
    const modelId = cfg.defaultModel ?? opencodeConfig?.model ?? null;
    const entry = modelId ? catalog.byFull.get(modelId) : null;
    if (!entry) errors.push({ path: 'defaultVariant', code: 'UNKNOWN_VARIANT', message: 'defaultVariant needs a valid defaultModel (or OpenCode default model)' });
    else {
      try { validateVariant(entry, cfg.defaultVariant); } catch (err) { errors.push({ path: 'defaultVariant', code: err.code, message: err.message }); }
    }
  }
  if (cfg.defaultAgent) {
    const agent = agents.find((a) => a.name === cfg.defaultAgent);
    if (!agent) errors.push({ path: 'defaultAgent', code: 'UNKNOWN_AGENT', message: `agent "${cfg.defaultAgent}" not found in /agent` });
    else if (agent.mode === 'subagent') errors.push({ path: 'defaultAgent', code: 'AGENT_MODE', message: `agent "${cfg.defaultAgent}" is subagent-only and cannot be a session agent` });
  }
  if (cfg.conclave?.defaultPool && !Object.prototype.hasOwnProperty.call(cfg.conclave.pools ?? {}, cfg.conclave.defaultPool)) {
    errors.push({ path: 'conclave.defaultPool', code: 'UNKNOWN_POOL', message: `pool "${cfg.conclave.defaultPool}" is not defined in conclave.pools` });
  }
  return { errors, warnings };
}

export function policyViolations(cfg, { catalog, agents = [] }) {
  const errors = [];
  const deny = (path, value, rule) => errors.push({ path, code: 'POLICY_DENIED', message: `"${value}" denied by ${rule}`, rule });
  for (const ref of modelRefsIn(cfg)) {
    let full;
    try { full = resolveStored(ref, cfg, catalog).full; } catch { continue; }
    if (!full) continue;
    const r = evaluate('model', full, cfg.policy);
    if (!r.allowed) deny(ref.path, full, r.rule);
  }
  if (cfg.defaultProvider) {
    const r = evaluate('provider', cfg.defaultProvider, cfg.policy);
    if (!r.allowed) deny('defaultProvider', cfg.defaultProvider, r.rule);
  }
  if (cfg.defaultAgent) {
    const agent = agents.find((a) => a.name === cfg.defaultAgent) ?? { name: cfg.defaultAgent };
    const r = evaluateAgent(agent, cfg.policy);
    if (!r.allowed) deny('defaultAgent', cfg.defaultAgent, r.rule);
  }
  return errors;
}

export function configPaths({ dataDir, workspaceRoot }) {
  return {
    dataDir,
    global: joinPathF1(dataDir, 'config.json'),
    workspace: joinPathF1(workspaceRoot, '.opc.json'),
    draft: joinPathF1(dataDir, 'config.draft.json'),
  };
}
// ---- end F1 ----
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/config-f1.test.mjs tests/unit/config-f1-edit.test.mjs && npm test`
Expected: PASS (9 testes novos, 18 no total de config F1).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/config.mjs tests/unit/config-f1-edit.test.mjs
git commit -m "feat(config): add edits, value coercion and validation against the server"
```

---

### Task 7: `tty.mjs` — prompts de terminal com streams injetáveis

**Files:**
- Create: `plugins/opc/scripts/lib/tty.mjs`
- Test: `tests/unit/tty.test.mjs`

**Interfaces:**
- Consumes: `UsageError`, `OpcError` (F0); `scriptedTTY`, `captureStream` (Task 2, helpers).
- Produces:
  - `parseSelection(text, count)` → índices ordenados (`"1,3"`, `"2-4"`, `"todos"`/`"all"`/`"*"`, vazio → `[]`) ou `null` se inválido;
  - `createPrompter({ input, output })` → `{ select, multiSelect, text, confirm, close }`; `input.isTTY` falso → `UsageError('NOT_A_TTY')` (exit 2); entrada fechada no meio → `OpcError('TTY_CLOSED', …, { exitCode: 2 })`;
  - `select(question, choices, { defaultIndex, allowOther })` → `value` ou `{ other: string }` (número escolhe; texto filtra a lista por substring e renumera; vazio usa o padrão; `o` = "Outro");
  - `multiSelect(question, choices, { min })` → `value[]`;
  - `text(question, { defaultValue, required, validate })` → `string`;
  - `confirm(question, { defaultValue })` → `boolean` (`s/sim/y/yes`, `n/nao/não/no`).
- As linhas da entrada vão para uma fila (não se perdem quando chegam antes da pergunta — é o que permite testes roteirizados sem pseudo-terminal, spec §13.1).

- [ ] **Step 1: Write the failing test**

`tests/unit/tty.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter, parseSelection } from '../../plugins/opc/scripts/lib/tty.mjs';
import { scriptedTTY, captureStream } from '../helpers.mjs';

const CHOICES = [
  { label: 'omniroute-mvalmeida (182 modelos)', value: 'omniroute-mvalmeida' },
  { label: 'omniroute-work (51 modelos)', value: 'omniroute-work' },
  { label: 'anthropic (18 modelos)', value: 'anthropic' },
  { label: 'opencode (7 modelos)', value: 'opencode' },
];

test('parseSelection: numbers, ranges, all, empty, invalid', () => {
  assert.deepEqual(parseSelection('1,3', 4), [0, 2]);
  assert.deepEqual(parseSelection('2-4', 4), [1, 2, 3]);
  assert.deepEqual(parseSelection('4 1 1', 4), [0, 3]);
  assert.deepEqual(parseSelection('todos', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('', 3), []);
  assert.equal(parseSelection('5', 4), null);
  assert.equal(parseSelection('3-1', 4), null);
  assert.equal(parseSelection('abc', 4), null);
});

test('createPrompter refuses a non-TTY input', () => {
  const input = new PassThrough();
  assert.throws(() => createPrompter({ input, output: captureStream() }), (err) => err.code === 'NOT_A_TTY' && err.exitCode === 2);
});

test('select by number, with invalid answer retried', async () => {
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY(['9', '3']), output });
  assert.equal(await p.select('Provider padrão?', CHOICES), 'anthropic');
  assert.match(output.text(), /Opção inválida: 9/);
  assert.match(output.text(), / 1\) omniroute-mvalmeida \(182 modelos\)/);
  p.close();
});

test('select with text filter then number within the filtered list', async () => {
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY(['omniroute', '2']), output });
  assert.equal(await p.select('Provider padrão?', CHOICES), 'omniroute-work');
  p.close();
});

test('select default on empty answer and "Outro"', async () => {
  const p = createPrompter({ input: scriptedTTY(['', 'o', 'my/glob-*']), output: captureStream() });
  assert.equal(await p.select('Q?', CHOICES, { defaultIndex: 1 }), 'omniroute-work');
  assert.deepEqual(await p.select('Q?', CHOICES, { allowOther: true }), { other: 'my/glob-*' });
  p.close();
});

test('multiSelect by ranges, min enforced', async () => {
  const output = captureStream();
  const p = createPrompter({ input: scriptedTTY(['', '1,3-4']), output });
  assert.deepEqual(await p.multiSelect('Tipos?', CHOICES, { min: 1 }), ['omniroute-mvalmeida', 'anthropic', 'opencode']);
  assert.match(output.text(), /pelo menos 1/);
  p.close();
});

test('text with default and validation; confirm s/n', async () => {
  const p = createPrompter({ input: scriptedTTY(['', 'bad', 'good', 'x', 's', '']), output: captureStream() });
  assert.equal(await p.text('Objetivo? ', { defaultValue: 'Plugin' }), 'Plugin');
  assert.equal(await p.text('Nome? ', { validate: (v) => (v === 'bad' ? 'inválido' : null) }), 'good');
  assert.equal(await p.confirm('Seguir?'), true);
  assert.equal(await p.confirm('De novo?', { defaultValue: false }), false);
  p.close();
});

test('closed input rejects with TTY_CLOSED', async () => {
  const p = createPrompter({ input: scriptedTTY([]), output: captureStream() });
  await assert.rejects(p.text('x? '), (err) => err.code === 'TTY_CLOSED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/tty.test.mjs`
Expected: FAIL com `Cannot find module '.../lib/tty.mjs'`.

- [ ] **Step 3: Write the implementation**

`plugins/opc/scripts/lib/tty.mjs`:

```js
// Terminal prompts without dependencies (spec §3.3 door 2, §13.1 "Testes de TTY").
// Streams are injectable; lines are queued so scripted input never gets lost.
import readline from 'node:readline';
import { UsageError, OpcError } from './opc-error.mjs';

export function parseSelection(text, count) {
  const input = String(text ?? '').trim().toLowerCase();
  if (input === '') return [];
  if (input === '*' || input === 'all' || input === 'todos') return Array.from({ length: count }, (_, i) => i);
  const picked = new Set();
  for (const token of input.split(/[\s,]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a < 1 || b > count || a > b) return null;
      for (let i = a; i <= b; i += 1) picked.add(i - 1);
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1 || n > count) return null;
      picked.add(n - 1);
    } else {
      return null;
    }
  }
  return [...picked].sort((x, y) => x - y);
}

export function createPrompter({ input, output }) {
  if (!input || !input.isTTY) {
    throw new UsageError('NOT_A_TTY', 'this command needs an interactive terminal (stdin is not a TTY); run it directly in your terminal');
  }
  const rl = readline.createInterface({ input, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift().resolve(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift().reject(new OpcError('TTY_CLOSED', 'input closed before the answer', { exitCode: 2 }));
  });
  const write = (text) => output.write(text);
  const nextLine = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.reject(new OpcError('TTY_CLOSED', 'input closed before the answer', { exitCode: 2 }));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const ask = async (question) => {
    write(question);
    return (await nextLine()).trim();
  };
  const printList = (items, marker = '') => {
    items.forEach((c, i) => write(`  ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? ` — ${c.hint}` : ''}${marker}\n`));
  };

  async function select(question, choices, { defaultIndex = null, allowOther = false } = {}) {
    if (!choices.length && !allowOther) throw new UsageError('NO_CHOICES', `no options available for: ${question}`);
    let visible = choices;
    for (;;) {
      write(`\n${question}\n`);
      printList(visible);
      if (allowOther) write(`   o) Outro (digitar valor)\n`);
      const def = defaultIndex !== null && visible === choices ? ` [${defaultIndex + 1}]` : '';
      const answer = await ask(`Número, texto para filtrar${allowOther ? " ou 'o'" : ''}${def}: `);
      if (answer === '' && def) return choices[defaultIndex].value;
      if (allowOther && answer.toLowerCase() === 'o') return { other: await text('Valor: ', { required: true }) };
      if (/^\d+$/.test(answer)) {
        const n = Number(answer);
        if (n >= 1 && n <= visible.length) return visible[n - 1].value;
        write(`Opção inválida: ${answer}\n`);
        continue;
      }
      if (answer === '') { visible = choices; continue; }
      const needle = answer.toLowerCase();
      const filtered = choices.filter((c) => c.label.toLowerCase().includes(needle));
      if (!filtered.length) { write(`Nada casa com "${answer}".\n`); visible = choices; continue; }
      visible = filtered;
    }
  }

  async function multiSelect(question, choices, { min = 0 } = {}) {
    for (;;) {
      write(`\n${question}\n`);
      printList(choices);
      const answer = await ask(`Números/intervalos (ex.: 1,3,5-7), 'todos' ou vazio para nenhum: `);
      const picked = parseSelection(answer, choices.length);
      if (picked === null) { write(`Seleção inválida: ${answer}\n`); continue; }
      if (picked.length < min) { write(`Escolha pelo menos ${min}.\n`); continue; }
      return picked.map((i) => choices[i].value);
    }
  }

  async function text(question, { defaultValue = null, required = false, validate = null } = {}) {
    for (;;) {
      const answer = await ask(defaultValue !== null ? `${question}[${defaultValue}] ` : question);
      const value = answer === '' && defaultValue !== null ? defaultValue : answer;
      if (required && value === '') { write('Valor obrigatório.\n'); continue; }
      const problem = validate ? validate(value) : null;
      if (problem) { write(`${problem}\n`); continue; }
      return value;
    }
  }

  async function confirm(question, { defaultValue = false } = {}) {
    for (;;) {
      const answer = (await ask(`${question} ${defaultValue ? '[S/n]' : '[s/N]'} `)).toLowerCase();
      if (answer === '') return defaultValue;
      if (['s', 'sim', 'y', 'yes'].includes(answer)) return true;
      if (['n', 'nao', 'não', 'no'].includes(answer)) return false;
      write('Responda s ou n.\n');
    }
  }

  function close() {
    rl.close();
  }

  return { select, multiSelect, text, confirm, close };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/tty.test.mjs`
Expected: PASS (8 testes).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/tty.mjs tests/unit/tty.test.mjs
git commit -m "feat(tty): add dependency-free terminal prompts with injectable streams"
```

---

### Task 8: `onboarding.mjs` — etapas, rascunho e commit atômico

**Files:**
- Create: `plugins/opc/scripts/lib/onboarding.mjs`
- Test: `tests/unit/onboarding.test.mjs`

**Interfaces:**
- Consumes: `writeFileAtomic`, `readJson`, `ensurePrivateDir` (F0, `state.mjs`); parte A e B de `config.mjs` (Tasks 5–6); `validateVariant` (Task 3); `evaluate` (Task 4).
- Produces (nomes congelados do mestre com assinatura fixada aqui + acréscimos):
  - `ONBOARDING_STEPS` — ids na ordem do §3.3: `scope, defaultProvider, defaultModel, reviewModels, defaultVariant, allowedModels*, allowedAgents*, approver*, behaviour, project, aliases` (`*` = travada; `behaviour` só no escopo global);
  - `buildDraft({ hasGlobal, now })` → `{ schemaVersion: 1, mode: 'bootstrap'|'reconfigure', scope: 'global', values: { [dotted]: value }, completed: string[], createdAt, updatedAt }` (no bootstrap `scope` já nasce concluída);
  - `loadDraft(dataDir)` → rascunho ou `null` (ausente, corrompido ou de outra versão);
  - `saveDraft(dataDir, draft)` (modo 600), `discardDraft(dataDir)` → `boolean`, `draftPath(dataDir)`;
  - `nextStep(draft, { allowLocked })` → `stepId|null`; `remainingSteps(draft, { allowLocked })` → `stepId[]`;
  - `applyDraftStep(draft, partial, { catalog, agents, existing: { global, workspace }, allowLocked, now })` → `{ draft, applied: string[], warnings, nextStep }` — `partial` é uma config parcial aninhada (mais `scope`); erros: `UsageError('INVALID_VALUE'|'UNKNOWN_KEY'|'UNKNOWN_PROVIDER'|'UNKNOWN_AGENT'|'UNKNOWN_VARIANT'|'AMBIGUOUS_MODEL'|'UNKNOWN_MODEL'|'GLOBAL_ONLY_KEY')`, `PolicyError('LOCKED_KEY')` com `details.command` e `PolicyError('POLICY_DENIED')` quando a chave aplicada fica negada; violações de chaves antigas viram `warnings`;
  - `commitDraft({ dataDir, workspaceRoot, draft, catalog, agents, opencodeConfig, existing, allowLocked })` → `{ scope, path, config, effective, warnings }`; valida forma, servidor e política da config **efetiva**, grava atômico (`saveGlobalConfig`/`saveWorkspaceConfig`) e remove o rascunho; sem `allowLocked`, chave travada diferente da base → `PolicyError('LOCKED_KEY')` com `details.commands`;
  - `lockedCommand(setting, value)` → `"opc config set <chave> '<valor>' --tty-confirm"` (aspas simples seguras);
  - `candidateConfig(draft, existing)`, `draftEffectiveConfig(draft, existing)`;
  - `rankProviders(catalog, policy)`, `suggestModels(catalog, providerID, { top, policy })`, `suggestAliases(catalog, providerID, policy)` → `{ fast, strong }`, `modelFamilies(catalog, providerID)` → `[{ family, count, glob }]`, `projectDirs(workspaceRoot)` → diretórios de 1º nível de `git ls-files` (ou do disco, sem git);
  - `onboardingSummary({ hasGlobal, draft, catalog, policy, opencode, npmAvailable, reconfigure, workspaceRoot, serverError })` → objeto `onboarding` do `setup --json` (campos: `needed, mode, configExists, opencodeInstalled, opencodeVersion, npmAvailable, serverError, connectedProviders, providerChoices, needsOtherProvider, lockedKeysEditable, draft, nextStep, projectDirs, terminalWizard`).

- [ ] **Step 1: Write the failing test**

`tests/unit/onboarding.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONBOARDING_STEPS, buildDraft, loadDraft, saveDraft, discardDraft, draftPath, nextStep, remainingSteps, applyDraftStep,
  commitDraft, lockedCommand, rankProviders, suggestModels, suggestAliases, modelFamilies, projectDirs, onboardingSummary,
} from '../../plugins/opc/scripts/lib/onboarding.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog(load('provider.json'));
const agents = load('agent.json');
const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const NOW = new Date('2026-09-26T12:00:00Z');
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-onb-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const NONE = { global: null, workspace: null };
const deps = (extra = {}) => ({ catalog, agents, existing: NONE, allowLocked: true, now: NOW, ...extra });

test('steps are the spec §3.3 list in order', () => {
  assert.deepEqual(ONBOARDING_STEPS.map((s) => s.id), ['scope', 'defaultProvider', 'defaultModel', 'reviewModels', 'defaultVariant', 'allowedModels', 'allowedAgents', 'approver', 'behaviour', 'project', 'aliases']);
});

test('buildDraft: bootstrap skips scope; reconfigure starts at scope', () => {
  const boot = buildDraft({ hasGlobal: false, now: NOW });
  assert.equal(boot.mode, 'bootstrap');
  assert.equal(nextStep(boot, { allowLocked: true }), 'defaultProvider');
  const re = buildDraft({ hasGlobal: true, now: NOW });
  assert.equal(re.mode, 'reconfigure');
  assert.equal(nextStep(re), 'scope');
  assert.ok(!remainingSteps(re).includes('allowedModels'), 'locked steps hidden without allowLocked');
  assert.ok(remainingSteps(re, { allowLocked: true }).includes('allowedModels'));
});

test('draft persistence: save (0600), load, discard; corrupt draft reads as null', (t) => {
  const dir = tmp(t);
  const d = buildDraft({ hasGlobal: false, now: NOW });
  saveDraft(dir, d);
  assert.equal(fs.statSync(draftPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(loadDraft(dir), d);
  assert.equal(discardDraft(dir), true);
  assert.equal(loadDraft(dir), null);
  assert.equal(discardDraft(dir), false);
  fs.writeFileSync(draftPath(dir), '{"schemaVersion":99}');
  assert.equal(loadDraft(dir), null);
});

test('applyDraftStep: provider, short model name normalized, variant validated', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV }, deps());
  let r = applyDraftStep(draft, { defaultModel: 'opencode-go/kimi-k3' }, deps());
  assert.equal(r.draft.values.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(r.nextStep, 'reviewModels');
  draft = r.draft;
  assert.throws(() => applyDraftStep(draft, { defaultVariant: 'ultra' }, deps()), (e) => e.code === 'UNKNOWN_VARIANT' && e.exitCode === 2);
  r = applyDraftStep(draft, { defaultVariant: 'high' }, deps());
  assert.equal(r.draft.values.defaultVariant, 'high');
  assert.ok(r.draft.completed.includes('defaultVariant'));
});

test('applyDraftStep: ambiguity, unknown provider, unknown key', () => {
  const { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV }, deps());
  assert.throws(() => applyDraftStep(draft, { defaultModel: 'opencode/big-pickle' }, deps()), (e) => e.code === 'AMBIGUOUS_MODEL');
  assert.throws(() => applyDraftStep(draft, { defaultProvider: 'openai' }, deps()), (e) => e.code === 'UNKNOWN_PROVIDER');
  assert.throws(() => applyDraftStep(draft, { nonsense: 1 }, deps()), (e) => e.code === 'UNKNOWN_KEY');
  assert.throws(() => applyDraftStep(draft, { scope: 'workspace' }, deps()), (e) => e.code === 'INVALID_VALUE');
  assert.throws(() => applyDraftStep(draft, 'x', deps()), (e) => e.code === 'INVALID_VALUE');
});

test('applyDraftStep: locked keys need allowLocked; error carries the terminal command', () => {
  const draft = buildDraft({ hasGlobal: true, now: NOW });
  assert.throws(() => applyDraftStep(draft, { policy: { models: { allow: [`${MV}/*`] } } }, deps({ allowLocked: false })), (e) => {
    assert.equal(e.code, 'LOCKED_KEY');
    assert.equal(e.exitCode, 4);
    assert.equal(e.details.command, `opc config set policy.models.allow '["omniroute-mvalmeida/*"]' --tty-confirm`);
    return true;
  });
});

test('applyDraftStep: policy applied in the same draft denies a new default (exit 4)', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { policy: { providers: { deny: [EQ] } } }, deps());
  assert.throws(() => applyDraftStep(draft, { defaultModel: `${EQ}/opencode-go/kimi-k3` }, deps()), (e) => e.code === 'POLICY_DENIED' && e.exitCode === 4);
  ({ draft } = applyDraftStep(draft, { defaultModel: `${MV}/opencode-go/kimi-k3` }, deps()));
  const r = applyDraftStep(draft, { policy: { models: { allow: ['anthropic/*'] } } }, deps());
  assert.equal(r.warnings[0].path, 'defaultModel', 'later policy step warns about earlier default');
});

test('applyDraftStep: aliases merge with the existing file and null removes', () => {
  const existing = { global: { defaultProvider: MV, aliases: { k3: `${MV}/opencode-go/kimi-k3`, pickle: 'opencode/big-pickle', old: `${MV}/opencode-go/qwen3.8-flash` } }, workspace: null };
  const draft = buildDraft({ hasGlobal: true, now: NOW });
  const r = applyDraftStep(draft, { aliases: { fast: 'opencode-go/deepseek-v4.1-flash', old: null } }, deps({ existing, allowLocked: false }));
  assert.deepEqual(r.draft.values.aliases, { k3: `${MV}/opencode-go/kimi-k3`, pickle: 'opencode/big-pickle', fast: `${MV}/opencode-go/deepseek-v4.1-flash` }, 'stored full ids are not re-normalized');
});

test('applyDraftStep: reviewModel accepts an alias defined earlier in the draft', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV, aliases: { strong: 'opencode-go/qwen3.8-max' } }, deps());
  ({ draft } = applyDraftStep(draft, { reviewModel: 'strong', stopGate: { model: null } }, deps()));
  assert.equal(draft.values.reviewModel, 'strong');
  assert.ok(draft.completed.includes('reviewModels'));
});

test('workspace scope: global-only keys refused', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: true, now: NOW }), { scope: 'workspace' }, deps({ allowLocked: false }));
  assert.equal(draft.scope, 'workspace');
  assert.throws(() => applyDraftStep(draft, { delegation: { auto: true } }, deps({ allowLocked: false })), (e) => e.code === 'GLOBAL_ONLY_KEY');
  assert.ok(!remainingSteps(draft).includes('behaviour'));
});

test('commitDraft: writes atomically, removes draft, returns effective config', (t) => {
  const dataDir = tmp(t);
  const ws = tmp(t);
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV, defaultModel: 'opencode-go/kimi-k3', policy: { providers: { deny: [EQ] }, agents: { deny: ['work-*'] } } }, deps());
  saveDraft(dataDir, draft);
  const r = commitDraft({ dataDir, workspaceRoot: ws, draft, catalog, agents, existing: NONE, allowLocked: true });
  assert.equal(r.path, path.join(dataDir, 'config.json'));
  const written = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(written.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(written.policy.providers.deny, [EQ]);
  assert.equal(r.effective.policy.approver, 'user');
  assert.equal(loadDraft(dataDir), null);
});

test('commitDraft: denied default refused (exit 4), nothing written, draft kept', (t) => {
  const dataDir = tmp(t);
  const draft = { ...buildDraft({ hasGlobal: false, now: NOW }), values: { defaultModel: `${EQ}/opencode-go/kimi-k3`, 'policy.providers.deny': [EQ] } };
  saveDraft(dataDir, draft);
  assert.throws(() => commitDraft({ dataDir, workspaceRoot: dataDir, draft, catalog, agents, existing: NONE, allowLocked: true }), (e) => e.code === 'POLICY_DENIED' && e.exitCode === 4);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
  assert.ok(loadDraft(dataDir));
});

test('commitDraft: invalid model refused (exit 2); locked change refused without allowLocked', (t) => {
  const dataDir = tmp(t);
  const bad = { ...buildDraft({ hasGlobal: false, now: NOW }), values: { defaultModel: `${MV}/opencode-go/removed` } };
  assert.throws(() => commitDraft({ dataDir, workspaceRoot: dataDir, draft: bad, catalog, agents, existing: NONE, allowLocked: true }), (e) => e.code === 'INVALID_CONFIG' && e.exitCode === 2);
  const lockedDraft = { ...buildDraft({ hasGlobal: false, now: NOW }), values: { 'policy.approver': 'claude' } };
  const existing = { global: { defaultProvider: MV }, workspace: null };
  assert.throws(() => commitDraft({ dataDir, workspaceRoot: dataDir, draft: lockedDraft, catalog, agents, existing, allowLocked: false }), (e) => {
    assert.equal(e.code, 'LOCKED_KEY');
    assert.deepEqual(e.details.commands, [`opc config set policy.approver 'claude' --tty-confirm`]);
    return true;
  });
});

test('lockedCommand quotes single quotes safely', () => {
  assert.equal(lockedCommand('project.goal', "it's"), `opc config set project.goal 'it'\\''s' --tty-confirm`);
});

test('rankProviders / suggestModels / suggestAliases / modelFamilies', () => {
  const policy = { providers: { deny: [EQ] }, models: { allow: [], deny: [] }, agents: {} };
  const ranked = rankProviders(catalog, policy);
  assert.deepEqual(ranked.map((p) => p.id), [MV, EQ, 'anthropic', 'opencode']);
  assert.equal(ranked.find((p) => p.id === EQ).allowed, false);
  const top = suggestModels(catalog, MV, { top: 3, policy });
  assert.equal(top.length, 3);
  assert.ok(top.every((m) => m.status !== 'deprecated'));
  assert.deepEqual(top.map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`, `${MV}/opencode-go/kimi-k3`]);
  assert.deepEqual(suggestAliases(catalog, MV, policy), { fast: `${MV}/opencode-go/qwen3.8-flash`, strong: `${MV}/opencode-go/qwen3.8-max` });
  assert.deepEqual(modelFamilies(catalog, MV)[0], { family: 'opencode-go', count: 5, glob: `${MV}/opencode-go/*` });
  assert.deepEqual(modelFamilies(catalog, 'opencode').map((f) => f.glob), ['opencode/big-pickle*', 'opencode/space-bunny*']);
});

test('projectDirs: non-git folder lists visible directories', (t) => {
  const ws = tmp(t);
  for (const d of ['src', 'tests', '.git-not', 'node_modules']) fs.mkdirSync(path.join(ws, d));
  assert.deepEqual(projectDirs(ws), ['src/', 'tests/']);
});

test('onboardingSummary: bootstrap without draft', () => {
  const s = onboardingSummary({ hasGlobal: false, draft: null, catalog, policy: {}, opencode: { installed: true, version: '1.18.32' }, npmAvailable: true });
  assert.equal(s.needed, true);
  assert.equal(s.mode, 'bootstrap');
  assert.equal(s.lockedKeysEditable, true);
  assert.equal(s.nextStep, 'defaultProvider');
  assert.deepEqual(s.providerChoices, [MV, EQ, 'anthropic']);
  assert.equal(s.needsOtherProvider, true);
  assert.equal(s.draft.exists, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/onboarding.test.mjs`
Expected: FAIL com `Cannot find module '.../lib/onboarding.mjs'`.

- [ ] **Step 3: Write the implementation**

`plugins/opc/scripts/lib/onboarding.mjs`:

```js
// Onboarding logic (spec §3.3): draft file + step validation + atomic commit.
// Pure with respect to the UI: the Claude flow (setup apply/commit) and the TTY wizard both drive it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UsageError, PolicyError } from './opc-error.mjs';
import { writeFileAtomic, readJson, ensurePrivateDir } from './state.mjs';
import {
  CONFIG_SCHEMA, schemaFor, getPath, setPath, isLockedKey, isWorkspaceKey, validateConfigShape, mergeConfig,
  normalizeEditValue, validateAgainstServer, policyViolations, saveGlobalConfig, saveWorkspaceConfig, configPaths,
} from './config.mjs';
import { validateVariant } from './models.mjs';
import { evaluate } from './policy.mjs';

export const DRAFT_SCHEMA_VERSION = 1;

export const ONBOARDING_STEPS = Object.freeze([
  { id: 'scope', keys: ['scope'] },
  { id: 'defaultProvider', keys: ['defaultProvider'] },
  { id: 'defaultModel', keys: ['defaultModel'] },
  { id: 'reviewModels', keys: ['reviewModel', 'stopGate.model'] },
  { id: 'defaultVariant', keys: ['defaultVariant'] },
  { id: 'allowedModels', keys: ['policy.providers.allow', 'policy.providers.deny', 'policy.models.allow', 'policy.models.deny'], locked: true },
  { id: 'allowedAgents', keys: ['policy.agents.allow', 'policy.agents.deny'], locked: true },
  { id: 'approver', keys: ['policy.approver'], locked: true },
  { id: 'behaviour', keys: ['stopGate.enabled', 'delegation.auto'], globalOnly: true },
  { id: 'project', keys: ['project.goal', 'project.scope', 'project.taskTypes'] },
  { id: 'aliases', keys: ['aliases'] },
].map(Object.freeze));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function draftPath(dataDir) {
  return path.join(dataDir, 'config.draft.json');
}

export function buildDraft({ hasGlobal, now = new Date() }) {
  const stamp = now.toISOString();
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    mode: hasGlobal ? 'reconfigure' : 'bootstrap',
    scope: 'global',
    values: {},
    completed: hasGlobal ? [] : ['scope'],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function loadDraft(dataDir) {
  const draft = readJson(draftPath(dataDir), null);
  if (!isPlainObject(draft) || draft.schemaVersion !== DRAFT_SCHEMA_VERSION || !isPlainObject(draft.values)) return null;
  return draft;
}

export function saveDraft(dataDir, draft) {
  ensurePrivateDir(dataDir);
  writeFileAtomic(draftPath(dataDir), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
}

export function discardDraft(dataDir) {
  const file = draftPath(dataDir);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function stepApplies(step, draft, allowLocked) {
  if (step.id === 'scope') return draft.mode === 'reconfigure';
  if (step.locked) return allowLocked && draft.scope === 'global';
  if (step.globalOnly) return draft.scope === 'global';
  return true;
}

export function nextStep(draft, { allowLocked = false } = {}) {
  const step = ONBOARDING_STEPS.find((s) => stepApplies(s, draft, allowLocked) && !draft.completed.includes(s.id));
  return step ? step.id : null;
}

export function remainingSteps(draft, { allowLocked = false } = {}) {
  return ONBOARDING_STEPS.filter((s) => stepApplies(s, draft, allowLocked) && !draft.completed.includes(s.id)).map((s) => s.id);
}

function flattenPartial(partial) {
  if (!isPlainObject(partial)) throw new UsageError('INVALID_VALUE', 'onboarding payload must be a JSON object');
  const out = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (p === 'scope' || CONFIG_SCHEMA[p] || (prefix && schemaFor(p))) out.push([p, value]);
      else if (isPlainObject(value)) walk(value, p);
      else throw new UsageError('UNKNOWN_KEY', `unknown config key "${p}"`);
    }
  };
  walk(partial, '');
  return out;
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

export function lockedCommand(key, value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return `opc config set ${key} ${shellQuote(rendered)} --tty-confirm`;
}

export function candidateConfig(draft, existing) {
  const base = (draft.scope === 'workspace' ? existing.workspace : existing.global) ?? {};
  return Object.entries(draft.values).reduce((cfg, [key, value]) => setPath(cfg, key, value), base);
}

function effectiveOf(draft, candidate, existing) {
  return draft.scope === 'workspace' ? mergeConfig(existing.global ?? {}, candidate) : mergeConfig(candidate, existing.workspace ?? {});
}

function effectiveValue(draft, existing, key) {
  return getPath(effectiveOf(draft, candidateConfig(draft, existing), existing).config, key);
}

export function applyDraftStep(draft, partial, { catalog, agents = [], existing = { global: null, workspace: null }, allowLocked = false, now = new Date() }) {
  const next = { ...draft, values: { ...draft.values }, completed: [...draft.completed] };
  const applied = [];
  const warnings = [];
  for (const [key, rawValue] of flattenPartial(partial)) {
    if (key === 'scope') {
      if (!['global', 'workspace'].includes(rawValue)) throw new UsageError('INVALID_VALUE', 'scope must be "global" or "workspace"');
      if (next.mode === 'bootstrap' && rawValue !== 'global') throw new UsageError('INVALID_VALUE', 'first setup must use the global scope (no global config yet)');
      next.scope = rawValue;
      applied.push('scope');
      continue;
    }
    if (isLockedKey(key) && !allowLocked) {
      const command = lockedCommand(key, rawValue);
      throw new PolicyError('LOCKED_KEY', `"${key}" is locked after the first setup; run in your own terminal: ${command}`, { details: { setting: key, command } });
    }
    if (next.scope === 'workspace' && !isWorkspaceKey(key)) {
      throw new UsageError('GLOBAL_ONLY_KEY', `"${key}" can only be set in the global config`);
    }
    const defaultProvider = key === 'defaultProvider' ? null : effectiveValue(next, existing, 'defaultProvider');
    let value;
    if (key === 'aliases') {
      if (!isPlainObject(rawValue)) throw new UsageError('INVALID_VALUE', 'aliases must map names to model IDs');
      const merged = { ...(getPath(candidateConfig(next, existing), 'aliases') ?? {}) };
      for (const [name, target] of Object.entries(rawValue)) {
        if (target === null) delete merged[name];
        else merged[name] = normalizeEditValue(`aliases.${name}`, target, { catalog, defaultProvider });
      }
      value = merged;
    } else {
      const shape = validateConfigShape(setPath({}, key, rawValue), { source: 'onboarding' });
      if (shape.errors.length) throw new UsageError('INVALID_VALUE', shape.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      const aliases = effectiveValue(next, existing, 'aliases') ?? {};
      value = normalizeEditValue(key, rawValue, { catalog, aliases, defaultProvider });
    }
    if (key === 'defaultProvider' && value !== null && !catalog.connected.has(value)) {
      throw new UsageError('UNKNOWN_PROVIDER', `provider "${value}" is not connected (connected: ${[...catalog.connected].join(', ')})`);
    }
    if (key === 'defaultAgent' && value !== null) {
      const agent = agents.find((a) => a.name === value);
      if (!agent) throw new UsageError('UNKNOWN_AGENT', `agent "${value}" not found`);
    }
    if (key === 'defaultVariant' && value !== null) {
      const model = effectiveValue(next, existing, 'defaultModel');
      const entry = model ? catalog.byFull.get(model) : null;
      if (!entry) throw new UsageError('UNKNOWN_VARIANT', 'choose the default model before the variant');
      validateVariant(entry, value);
    }
    next.values[key] = value;
    applied.push(key);
  }
  const candidate = candidateConfig(next, existing);
  const effective = effectiveOf(next, candidate, existing).config;
  for (const violation of policyViolations(effective, { catalog, agents })) {
    const touched = applied.some((k) => violation.path === k || violation.path.startsWith(`${k}.`) || violation.path.startsWith(`${k}[`));
    if (touched) throw new PolicyError('POLICY_DENIED', `${violation.path}: ${violation.message}`, { details: violation });
    warnings.push({ path: violation.path, code: violation.code, message: `${violation.message} (commit will be refused until fixed)` });
  }
  for (const step of ONBOARDING_STEPS) {
    if (!next.completed.includes(step.id) && step.keys.some((k) => applied.includes(k))) next.completed.push(step.id);
  }
  next.updatedAt = now.toISOString();
  return { draft: next, applied, warnings, nextStep: nextStep(next, { allowLocked }) };
}

export function commitDraft({ dataDir, workspaceRoot, draft, catalog, agents = [], opencodeConfig = null, existing, allowLocked = false }) {
  const base = (draft.scope === 'workspace' ? existing.workspace : existing.global) ?? {};
  if (!allowLocked) {
    const changedLocked = Object.keys(draft.values).filter((k) => isLockedKey(k) && JSON.stringify(draft.values[k]) !== JSON.stringify(getPath(base, k)));
    if (changedLocked.length) {
      const commands = changedLocked.map((k) => lockedCommand(k, draft.values[k]));
      throw new PolicyError('LOCKED_KEY', `locked keys can no longer be changed from Claude (a global config now exists); run in your own terminal: ${commands.join(' ; ')}`,
        { details: { settings: changedLocked, commands } });
    }
  }
  const candidate = candidateConfig(draft, existing);
  const shape = validateConfigShape(candidate, { source: draft.scope });
  if (shape.errors.length) throw new UsageError('INVALID_CONFIG', 'draft config is invalid', { details: { errors: shape.errors } });
  const merged = effectiveOf(draft, candidate, existing);
  const server = validateAgainstServer(merged.config, { catalog, agents, opencodeConfig });
  if (server.errors.length) {
    throw new UsageError('INVALID_CONFIG', `draft config is invalid: ${server.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { details: { errors: server.errors } });
  }
  const denied = policyViolations(merged.config, { catalog, agents });
  if (denied.length) {
    throw new PolicyError('POLICY_DENIED', `draft config uses values denied by the policy: ${denied.map((e) => `${e.path} ${e.message}`).join('; ')}`, { details: { errors: denied } });
  }
  if (draft.scope === 'workspace') saveWorkspaceConfig(workspaceRoot, candidate);
  else saveGlobalConfig(dataDir, candidate);
  discardDraft(dataDir);
  const paths = configPaths({ dataDir, workspaceRoot });
  return {
    scope: draft.scope,
    path: draft.scope === 'workspace' ? paths.workspace : paths.global,
    config: candidate,
    effective: merged.config,
    warnings: [...shape.warnings, ...merged.warnings, ...server.warnings],
  };
}

export function rankProviders(catalog, policy) {
  return catalog.providers
    .filter((p) => p.connected)
    .map((p) => ({ id: p.id, name: p.name, modelCount: p.modelCount, ...evaluate('provider', p.id, policy) }))
    .sort((a, b) => b.modelCount - a.modelCount || a.id.localeCompare(b.id));
}

function allowedModels(catalog, providerID, policy) {
  return catalog.models.filter((m) => m.connected && m.providerID === providerID && evaluate('model', m.full, policy).allowed);
}

const byQuality = (a, b) => (Number(b.reasoning && b.toolcall) - Number(a.reasoning && a.toolcall))
  || String(b.releaseDate ?? '').localeCompare(String(a.releaseDate ?? ''))
  || a.full.localeCompare(b.full);

export function suggestModels(catalog, providerID, { top = 3, policy } = {}) {
  return allowedModels(catalog, providerID, policy)
    .filter((m) => m.status !== 'deprecated')
    .sort(byQuality)
    .slice(0, top);
}

export function suggestAliases(catalog, providerID, policy) {
  const pool = allowedModels(catalog, providerID, policy).filter((m) => m.status !== 'deprecated').sort(byQuality);
  const pick = (re) => pool.find((m) => re.test(m.modelID))?.full ?? null;
  return { fast: pick(/flash|mini|lite|haiku|fast/i), strong: pick(/max|pro|opus|k3|strong/i) };
}

export function modelFamilies(catalog, providerID) {
  const counts = new Map();
  for (const m of catalog.models.filter((x) => x.providerID === providerID)) {
    const family = m.modelID.includes('/') ? m.modelID.split('/')[0] : (m.family ?? m.modelID);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count, glob: `${providerID}/${family}${catalog.models.some((m) => m.providerID === providerID && m.modelID.startsWith(`${family}/`)) ? '/' : ''}*` }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

export function projectDirs(workspaceRoot, { limit = 30 } = {}) {
  const git = spawnSync('git', ['ls-files'], { cwd: workspaceRoot, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
  let dirs;
  if (git.status === 0) {
    dirs = [...new Set(git.stdout.split('\n').filter((f) => f.includes('/')).map((f) => `${f.split('/')[0]}/`))];
  } else {
    dirs = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => `${d.name}/`);
  }
  return dirs.sort().slice(0, limit);
}

export function onboardingSummary({ hasGlobal, draft, catalog, policy, opencode, npmAvailable, reconfigure = false, workspaceRoot = null, serverError = null }) {
  const allowLocked = draft ? draft.mode === 'bootstrap' && !hasGlobal : !hasGlobal;
  const providers = catalog ? rankProviders(catalog, policy) : [];
  return {
    needed: !hasGlobal || reconfigure,
    mode: hasGlobal ? 'reconfigure' : 'bootstrap',
    configExists: hasGlobal,
    opencodeInstalled: Boolean(opencode?.installed),
    opencodeVersion: opencode?.version ?? null,
    npmAvailable: Boolean(npmAvailable),
    serverError,
    connectedProviders: providers,
    providerChoices: providers.filter((p) => p.allowed).slice(0, 3).map((p) => p.id),
    needsOtherProvider: providers.filter((p) => p.allowed).length > 3,
    lockedKeysEditable: allowLocked,
    draft: draft ? { exists: true, mode: draft.mode, scope: draft.scope, completed: draft.completed, values: draft.values, updatedAt: draft.updatedAt } : { exists: false },
    nextStep: draft ? nextStep(draft, { allowLocked }) : (hasGlobal ? 'scope' : 'defaultProvider'),
    projectDirs: workspaceRoot ? projectDirs(workspaceRoot) : [],
    terminalWizard: 'opc config init',
  };
}

export function draftEffectiveConfig(draft, existing) {
  return effectiveOf(draft, candidateConfig(draft, existing), existing).config;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/onboarding.test.mjs`
Expected: PASS (17 testes).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/onboarding.mjs tests/unit/onboarding.test.mjs
git commit -m "feat(onboarding): add draft steps, validation and atomic commit"
```

---

### Task 9: Renderizadores da F1

**Files:**
- Modify: `plugins/opc/scripts/lib/render.mjs` (acrescentar o bloco F1 no fim)
- Test: `tests/unit/render-f1.test.mjs`

**Interfaces:**
- Consumes: `renderTable` (F0, mesmo módulo); `redact` (F0, já importado — premissa P9).
- Produces (funções puras, sem I/O):
  - `renderProviders({ providers, all, warnings })`;
  - `renderModels({ models, provider, all, allowedOnly, verbose, warnings })`;
  - `renderAgents({ agents, mode, verbose, warnings })`;
  - `renderCatalog({ kind: 'commands'|'skills', items })`;
  - `renderConfig(view)` — `view.kind`: `path | get | edit | show | effective | validate` (campos: `setting`, `value`, `op`, `scope`, `path`, `global`, `workspace`, `paths`, `config`, `errors`, `warnings`, `serverChecked`, `serverError`); objetos de config passam por `redact`;
  - `renderOnboarding(view)` — `view.kind`: `state | models | apply | commit | discard`.

- [ ] **Step 1: Write the failing test**

`tests/unit/render-f1.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProviders, renderModels, renderAgents, renderCatalog, renderConfig, renderOnboarding } from '../../plugins/opc/scripts/lib/render.mjs';

const model = { full: 'omniroute-mvalmeida/opencode-go/kimi-k3', name: 'Kimi K3', variants: ['low', 'high'], limit: { context: 262144, output: 32768 }, cost: { input: 0.6, output: 2.5 }, status: 'active', allowed: true };

test('renderProviders: table with policy column and empty state', () => {
  const text = renderProviders({ providers: [{ id: 'omniroute-work', name: 'EQ', connected: true, modelCount: 3, defaultModel: null, allowed: false, rule: 'policy.providers.deny: omniroute-work' }], all: false });
  assert.match(text, /# Providers conectados/);
  assert.match(text, /negado \(policy\.providers\.deny: omniroute-work\)/);
  assert.match(renderProviders({ providers: [], all: false }), /opencode auth login/);
});

test('renderModels: compact and verbose', () => {
  const compact = renderModels({ models: [model], provider: null, verbose: false });
  assert.match(compact, /\| omniroute-mvalmeida\/opencode-go\/kimi-k3 \| Kimi K3 \| low, high \| permitido \|/);
  const verbose = renderModels({ models: [model], provider: 'omniroute-mvalmeida', verbose: true, allowedOnly: true });
  assert.match(verbose, /só permitidos/);
  assert.match(verbose, /262144/);
  assert.match(verbose, /0\.6 \/ 2\.5/);
  assert.match(renderModels({ models: [], verbose: false }), /Nenhum modelo/);
});

test('renderAgents / renderCatalog', () => {
  const a = renderAgents({ agents: [{ name: 'docs-writer', mode: 'subagent', description: 'Docs | PT-BR', native: false, hidden: false, pinnedModel: 'p/m', variant: 'high', allowed: true }], verbose: true, mode: 'subagent' });
  assert.match(a, /Docs \\\| PT-BR/, 'pipe escaped');
  assert.match(a, /\| p\/m \| high \|/);
  assert.match(renderCatalog({ kind: 'skills', items: [{ name: 'brainstorm', description: 'x', location: '/l' }] }), /# Skills/);
  assert.match(renderCatalog({ kind: 'commands', items: [{ name: 'docs', source: 'command', model: 'p/m', allowed: false, rule: 'r' }] }), /negado \(r\)/);
});

test('renderConfig: redacts secret-looking values and renders all kinds', () => {
  const show = renderConfig({ kind: 'show', global: { server: { configOverride: { provider: { p: { options: { apiKey: 'sk-live-123' } } } } } }, workspace: null, paths: { global: '/d/config.json', workspace: '/w/.opc.json' }, warnings: [] });
  assert.ok(!show.includes('sk-live-123'));
  assert.match(show, /\*\*\*/);
  assert.match(show, /sem \.opc\.json/);
  assert.equal(renderConfig({ kind: 'get', setting: 'defaultModel', value: null }), 'defaultModel = null\n');
  assert.match(renderConfig({ kind: 'validate', errors: [{ source: 'global', path: 'defaultModel', code: 'UNKNOWN_MODEL', message: 'x' }], warnings: [], serverChecked: true }), /Config inválida/);
  assert.match(renderConfig({ kind: 'validate', errors: [], warnings: [], serverChecked: false, serverError: 'down' }), /não executada: down/);
  assert.match(renderConfig({ kind: 'path', dataDir: '/d', global: '/d/c', workspace: '/w/.opc.json', draft: '/d/config.draft.json' }), /Rascunho/);
  assert.throws(() => renderConfig({ kind: 'nope' }), TypeError);
});

test('renderOnboarding: state/apply/commit/discard', () => {
  const state = renderOnboarding({ kind: 'state', onboarding: { configExists: false, mode: 'bootstrap', opencodeInstalled: true, opencodeVersion: '1.18.32', connectedProviders: [{ id: 'p', modelCount: 2 }], draft: { exists: false }, nextStep: 'defaultProvider', lockedKeysEditable: true } });
  assert.match(state, /ainda não existe/);
  assert.match(renderOnboarding({ kind: 'apply', applied: ['defaultModel'], nextStep: null, warnings: [] }), /Próxima etapa: commit/);
  assert.match(renderOnboarding({ kind: 'commit', scope: 'global', path: '/d/config.json', warnings: [] }), /global/);
  assert.match(renderOnboarding({ kind: 'discard', discarded: false }), /Nenhum rascunho/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/render-f1.test.mjs`
Expected: FAIL — `renderProviders` não é exportado.

- [ ] **Step 3: Write the implementation**

Conferir `grep -n "RenderF1\|export function renderProviders" plugins/opc/scripts/lib/render.mjs` (deve vir vazio) e acrescentar ao **fim** de `plugins/opc/scripts/lib/render.mjs` (sem a linha de import: `redact` já vem do F0; se não vier, acrescentar `import { redact } from './redact.mjs';` ao topo):

```js
// ---- F1: discovery, config and onboarding renderers (pure; no network I/O) ----

const RenderF1 = Object.freeze({
  policy: (item) => (item.allowed === false ? `negado (${item.rule})` : 'permitido'),
  yesNo: (v) => (v ? 'sim' : 'não'),
  dash: (v) => (v === null || v === undefined || v === '' ? '—' : String(v)),
  json: (value) => `\`\`\`json\n${JSON.stringify(redact(value), null, 2)}\n\`\`\`\n`,
  warnings: (warnings = []) => (warnings.length
    ? `\n**Avisos**\n${warnings.map((w) => `- ${typeof w === 'string' ? w : `\`${w.path}\`: ${w.message}`}`).join('\n')}\n`
    : ''),
});

export function renderProviders(view) {
  const rows = view.providers.map((p) => [p.id, p.name, RenderF1.yesNo(p.connected), p.modelCount, RenderF1.dash(p.defaultModel), RenderF1.policy(p)]);
  const title = view.all ? '# Providers do OpenCode (catálogo completo)' : '# Providers conectados';
  const body = rows.length ? renderTable(['Provider', 'Nome', 'Conectado', 'Modelos', 'Modelo padrão', 'Política'], rows) : 'Nenhum provider conectado. Rode `opencode auth login` no terminal.\n';
  return `${title}\n\n${body}${RenderF1.warnings(view.warnings)}`;
}

export function renderModels(view) {
  const scope = view.provider ? ` de \`${view.provider}\`` : '';
  const flags = [view.all ? 'inclui não conectados' : null, view.allowedOnly ? 'só permitidos' : null].filter(Boolean);
  const title = `# Modelos${scope}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  if (!view.models.length) return `${title}\n\nNenhum modelo encontrado.\n${RenderF1.warnings(view.warnings)}`;
  const headers = view.verbose
    ? ['Modelo', 'Nome', 'Variants', 'Contexto', 'Saída', 'Custo in/out (US$/M)', 'Status', 'Política']
    : ['Modelo', 'Nome', 'Variants', 'Política'];
  const rows = view.models.map((m) => (view.verbose
    ? [m.full, m.name, m.variants.join(', ') || '—', RenderF1.dash(m.limit.context), RenderF1.dash(m.limit.output), `${RenderF1.dash(m.cost.input)} / ${RenderF1.dash(m.cost.output)}`, RenderF1.dash(m.status), RenderF1.policy(m)]
    : [m.full, m.name, m.variants.join(', ') || '—', RenderF1.policy(m)]));
  return `${title}\n\n${renderTable(headers, rows)}\n${view.models.length} modelo(s).\n${RenderF1.warnings(view.warnings)}`;
}

export function renderAgents(view) {
  const title = `# Agentes do OpenCode${view.mode && view.mode !== 'all' ? ` (modo ${view.mode})` : ''}`;
  if (!view.agents.length) return `${title}\n\nNenhum agente encontrado.\n`;
  const headers = view.verbose
    ? ['Agente', 'Modo', 'Descrição', 'Nativo', 'Oculto', 'Modelo fixado', 'Variant', 'Política']
    : ['Agente', 'Modo', 'Descrição', 'Política'];
  const rows = view.agents.map((a) => (view.verbose
    ? [a.name, a.mode, RenderF1.dash(a.description), RenderF1.yesNo(a.native), RenderF1.yesNo(a.hidden), RenderF1.dash(a.pinnedModel), RenderF1.dash(a.variant), RenderF1.policy(a)]
    : [a.name, a.mode, RenderF1.dash(a.description), RenderF1.policy(a)]));
  return `${title}\n\n${renderTable(headers, rows)}${RenderF1.warnings(view.warnings)}`;
}

export function renderCatalog(view) {
  if (view.kind === 'skills') {
    if (!view.items.length) return '# Skills do OpenCode\n\nNenhuma skill encontrada.\n';
    return `# Skills do OpenCode\n\n${renderTable(['Skill', 'Descrição', 'Local'], view.items.map((s) => [s.name, RenderF1.dash(s.description), s.location]))}`;
  }
  if (!view.items.length) return '# Commands do OpenCode\n\nNenhum command encontrado.\n';
  const rows = view.items.map((c) => [c.name, RenderF1.dash(c.description), RenderF1.dash(c.source), RenderF1.dash(c.agent), RenderF1.dash(c.model), RenderF1.policy(c)]);
  return `# Commands do OpenCode\n\n${renderTable(['Command', 'Descrição', 'Origem', 'Agente', 'Modelo fixado', 'Política'], rows)}`;
}

export function renderConfig(view) {
  switch (view.kind) {
    case 'path':
      return `# opc config path\n\n- Dados: \`${view.dataDir}\`\n- Global: \`${view.global}\`\n- Workspace: \`${view.workspace}\`\n- Rascunho do onboarding: \`${view.draft}\`\n`;
    case 'get':
      return `${view.setting} = ${JSON.stringify(redact(view.value))}\n`;
    case 'edit':
      return `# opc config ${view.op}\n\n\`${view.setting}\` (${view.scope}) → \`${view.path}\`\n\nValor: \`${JSON.stringify(redact(view.value ?? null))}\`\n${RenderF1.warnings(view.warnings)}`;
    case 'show':
      return `# opc config\n\n## Global (\`${view.paths.global}\`)\n\n${view.global ? RenderF1.json(view.global) : '_sem config global (rode /opc:setup)_\n'}\n## Workspace (\`${view.paths.workspace}\`)\n\n${view.workspace ? RenderF1.json(view.workspace) : '_sem .opc.json_\n'}${RenderF1.warnings(view.warnings)}`;
    case 'effective':
      return `# opc config efetiva\n\n${RenderF1.json(view.config)}${RenderF1.warnings(view.warnings)}`;
    case 'validate': {
      const status = view.errors.length ? '**Config inválida.**' : '**Config válida.**';
      const server = view.serverChecked ? '' : `\n_Checagem contra o servidor não executada: ${view.serverError}_\n`;
      const errors = view.errors.length ? `\n## Erros\n\n${renderTable(['Origem', 'Chave', 'Código', 'Mensagem'], view.errors.map((e) => [e.source, e.path, e.code, e.message]))}` : '';
      const warns = view.warnings.length ? `\n## Avisos\n\n${renderTable(['Origem', 'Chave', 'Código', 'Mensagem'], view.warnings.map((w) => [w.source, w.path, RenderF1.dash(w.code), w.message]))}` : '';
      return `# opc config validate\n\n${status}\n${server}${errors}${warns}`;
    }
    default:
      throw new TypeError(`renderConfig: unknown view kind ${view.kind}`);
  }
}

export function renderOnboarding(view) {
  switch (view.kind) {
    case 'state': {
      const s = view.onboarding;
      const lines = [
        '## Onboarding',
        '',
        `- Config global: ${s.configExists ? 'existe' : 'ainda não existe'} (modo ${s.mode})`,
        `- OpenCode: ${s.opencodeInstalled ? `instalado (${s.opencodeVersion ?? 'versão ?'})` : 'não instalado'}`,
        `- Providers conectados: ${s.connectedProviders.length ? s.connectedProviders.map((p) => `${p.id} (${p.modelCount})`).join(', ') : 'nenhum'}`,
        `- Rascunho: ${s.draft.exists ? `sim, próxima etapa: ${s.nextStep ?? 'commit'}` : 'não'}`,
        `- Chaves travadas editáveis aqui: ${RenderF1.yesNo(s.lockedKeysEditable)}`,
      ];
      if (s.serverError) lines.push(`- Servidor: ${s.serverError}`);
      return `\n${lines.join('\n')}\n`;
    }
    case 'models': {
      const rows = view.suggestions.map((m) => [m.full, m.name, m.variants.join(', ') || '—', RenderF1.dash(m.limit.context)]);
      const matches = view.matches ? `\n## Resultado da busca \`${view.query}\`\n\n${view.matches.length ? renderTable(['Modelo', 'Nome'], view.matches.map((m) => [m.full, m.name])) : 'Nada encontrado.\n'}` : '';
      return `# Sugestões de modelo para \`${view.provider}\`\n\n${rows.length ? renderTable(['Modelo', 'Nome', 'Variants', 'Contexto'], rows) : 'Nenhum modelo permitido.\n'}${matches}`;
    }
    case 'apply':
      return `# Rascunho atualizado\n\nAplicado: ${view.applied.map((k) => `\`${k}\``).join(', ')}\nPróxima etapa: ${view.nextStep ?? 'commit'}\n${RenderF1.warnings(view.warnings)}`;
    case 'commit':
      return `# Config gravada\n\nEscopo: ${view.scope} → \`${view.path}\`\n${RenderF1.warnings(view.warnings)}`;
    case 'discard':
      return view.discarded ? '# Rascunho descartado\n' : '# Nenhum rascunho para descartar\n';
    default:
      throw new TypeError(`renderOnboarding: unknown view kind ${view.kind}`);
  }
}
// ---- end F1 ----
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/render-f1.test.mjs && npm test`
Expected: PASS (5 testes novos).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/render.mjs tests/unit/render-f1.test.mjs
git commit -m "feat(render): add discovery, config and onboarding renderers"
```

---
### Task 10: Comandos de descoberta — `providers`, `models`, `agents`, `catalog`

**Files:**
- Create: `plugins/opc/scripts/commands/providers.mjs`, `plugins/opc/scripts/commands/models.mjs`, `plugins/opc/scripts/commands/agents.mjs`, `plugins/opc/scripts/commands/catalog.mjs`
- Test: `tests/integration/discovery.test.mjs`

**Interfaces:**
- Consumes: `parseArgs` (F0); `connectApi` (Task 1); `buildCatalog` (Task 3); `evaluate`, `evaluateAgent`, `evaluateCommand`, `pinnedModelOf` (Task 4); `renderProviders`, `renderModels`, `renderAgents`, `renderCatalog` (Task 9); `ctx.config.policy` e `ctx.configWarnings` (P2).
- Produces (CLI, `run(ctx, argv) → exit code`):
  - `opc providers [--all] [--json]` → `{ all, providers: [ProviderEntry & {allowed, rule?}], warnings }`;
  - `opc models [provider] [--verbose] [--allowed] [--all] [--json]` → `{ provider, all, allowedOnly, verbose, models: [ModelEntry & {allowed, rule?}], warnings }`; provider desconhecido ou não conectado sem `--all` → exit 2 `UNKNOWN_PROVIDER`;
  - `opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json]` → `{ mode, verbose, allowedOnly, agents: [{ name, description, mode, native, hidden, pinnedModel, variant, allowed, rule? }], warnings }`;
  - `opc catalog commands|skills [--json]` → `{ kind, items }` (commands: `name, description, source, agent, model, subtask, hints, allowed, rule?`; skills: `name, description, location` — nunca o `content`).

- [ ] **Step 1: Write the failing test**

`tests/integration/discovery.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, stopAllServers, writeGlobalConfig } from '../helpers.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const WORLD = { policy: { providers: { allow: [], deny: [EQ] }, agents: { allow: [], deny: ['work-*'] } } };
const SECRET_MARKERS = /FIXTURE-|sk-omr|sk-ant|sk-FIXTURE|Bearer /;

function setup(t, { scenario = 'ok', config = null } = {}) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { scenario }); // the F0 per-test cleanup stops this env × workspace server before removing the dirs
  if (config) writeGlobalConfig(env, config);
  return { ws, env };
}
const noSecrets = (r) => {
  assert.doesNotMatch(r.stdout, SECRET_MARKERS);
  assert.doesNotMatch(r.stderr, SECRET_MARKERS);
};

test('providers: connected by default, --all shows the catalog, keys never printed', async (t) => {
  const { ws, env } = setup(t);
  const def = await runCli(['providers', '--json'], { env, cwd: ws });
  assert.equal(def.code, 0, def.stderr);
  const view = JSON.parse(def.stdout);
  assert.deepEqual(view.providers.map((p) => p.id), ['anthropic', EQ, MV, 'opencode']);
  assert.equal(view.providers.find((p) => p.id === MV).modelCount, 7);
  assert.equal(view.providers.find((p) => p.id === MV).defaultModel, `${MV}/opencode-go/deepseek-v4.1-flash`);
  const all = await runCli(['providers', '--all', '--json'], { env, cwd: ws });
  assert.equal(JSON.parse(all.stdout).providers.length, 5);
  assert.equal(JSON.parse(all.stdout).providers.find((p) => p.id === 'openai').connected, false);
  const text = await runCli(['providers', '--all'], { env, cwd: ws });
  assert.match(text.stdout, /# Providers do OpenCode \(catálogo completo\)/);
  for (const r of [def, all, text]) noSecrets(r);
});

test('models: listing, provider filter, --all, --verbose, no model headers leak', async (t) => {
  const { ws, env } = setup(t);
  const def = JSON.parse((await runCli(['models', '--json'], { env, cwd: ws })).stdout);
  assert.equal(def.models.length, 14);
  assert.ok(def.models.every((m) => m.connected));
  const mv = await runCli(['models', MV, '--verbose', '--json'], { env, cwd: ws });
  const kimi = JSON.parse(mv.stdout).models.find((m) => m.full === `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(kimi.variants, ['low', 'medium', 'high']);
  assert.deepEqual(kimi.limit, { context: 262144, output: 32768 });
  assert.equal(kimi.modelID, 'opencode-go/kimi-k3', 'model id with slashes kept intact');
  const verboseText = await runCli(['models', MV, '--verbose'], { env, cwd: ws });
  assert.match(verboseText.stdout, /Custo in\/out/);
  const all = JSON.parse((await runCli(['models', '--all', '--json'], { env, cwd: ws })).stdout);
  assert.equal(all.models.length, 15);
  const notConnected = await runCli(['models', 'openai'], { env, cwd: ws });
  assert.equal(notConnected.code, 2);
  assert.match(notConnected.stdout + notConnected.stderr, /not connected; use --all/);
  const unknown = await runCli(['models', 'nope'], { env, cwd: ws });
  assert.equal(unknown.code, 2);
  for (const r of [mv, verboseText]) noSecrets(r);
});

test('--allowed hides denied entries and marks them with the rule', async (t) => {
  const { ws, env } = setup(t, { config: WORLD });
  const models = JSON.parse((await runCli(['models', '--allowed', '--json'], { env, cwd: ws })).stdout).models;
  assert.equal(models.length, 11);
  assert.ok(models.every((m) => m.providerID !== EQ));
  const marked = JSON.parse((await runCli(['models', EQ, '--json'], { env, cwd: ws })).stdout).models;
  assert.ok(marked.every((m) => m.allowed === false && /policy\.providers\.deny: omniroute-work/.test(m.rule)));
  const agents = JSON.parse((await runCli(['agents', '--allowed', '--json'], { env, cwd: ws })).stdout).agents;
  assert.deepEqual(agents.map((a) => a.name), ['build', 'docs-writer', 'explore', 'general', 'plan']);
});

test('agents: hidden only with --verbose, mode filter, pinned model shown', async (t) => {
  const { ws, env } = setup(t);
  const def = JSON.parse((await runCli(['agents', '--json'], { env, cwd: ws })).stdout).agents.map((a) => a.name);
  assert.deepEqual(def, ['build', 'docs-writer', 'work-deploy', 'work-reviewer', 'explore', 'general', 'plan']);
  const primary = JSON.parse((await runCli(['agents', '--mode', 'primary', '--json'], { env, cwd: ws })).stdout).agents.map((a) => a.name);
  assert.deepEqual(primary, ['build', 'work-reviewer', 'plan']);
  const verbose = JSON.parse((await runCli(['agents', '--verbose', '--json'], { env, cwd: ws })).stdout).agents;
  assert.ok(verbose.some((a) => a.name === 'title' && a.hidden));
  assert.equal(verbose.find((a) => a.name === 'docs-writer').pinnedModel, `${MV}/opencode-go/qwen3.8-max`);
  const bad = await runCli(['agents', '--mode', 'robot'], { env, cwd: ws });
  assert.equal(bad.code, 2);
});

test('scenario pinned-denied-model: agent and command pinning a denied model are marked denied', async (t) => {
  const { ws, env } = setup(t, { scenario: 'pinned-denied-model', config: WORLD });
  const verbose = JSON.parse((await runCli(['agents', '--verbose', '--json'], { env, cwd: ws })).stdout).agents;
  const pinned = verbose.find((a) => a.name === 'pinned-reviewer');
  assert.equal(pinned.allowed, false);
  assert.match(pinned.rule, /^pinned model omniroute-work\/opencode-go\/kimi-k3/);
  const allowed = JSON.parse((await runCli(['agents', '--allowed', '--json'], { env, cwd: ws })).stdout).agents;
  assert.ok(!allowed.some((a) => a.name === 'pinned-reviewer'));
  const commands = JSON.parse((await runCli(['catalog', 'commands', '--json'], { env, cwd: ws })).stdout).items;
  const release = commands.find((c) => c.name === 'work-release');
  assert.equal(release.allowed, false);
  assert.match(release.rule, /pinned model omniroute-work\/cx\/gpt-5\.5/);
});

test('catalog lists commands and skills (never skill content)', async (t) => {
  const { ws, env } = setup(t);
  const commands = JSON.parse((await runCli(['catalog', 'commands', '--json'], { env, cwd: ws })).stdout).items;
  assert.deepEqual(commands.map((c) => c.name), ['brainstorm', 'docs', 'gitlab:list-mrs', 'init', 'review']);
  assert.equal(commands.find((c) => c.name === 'docs').model, `${MV}/opencode-go/qwen3.8-max`);
  const skills = await runCli(['catalog', 'skills'], { env, cwd: ws });
  assert.equal(skills.code, 0);
  assert.match(skills.stdout, /release-notes/);
  assert.doesNotMatch(skills.stdout, /Summarize commits/);
  const usage = await runCli(['catalog'], { env, cwd: ws });
  assert.equal(usage.code, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/discovery.test.mjs`
Expected: FAIL — exit 2 `USAGE: Subcomando desconhecido: providers` (os arquivos de comando ainda não existem).

- [ ] **Step 3: Write the commands**

O dispatcher do F0 é dinâmico (premissa P6, garantida pela F0): criar `commands/<sub>.mjs` com `export async function run(ctx, argv)` basta para `providers`, `models`, `agents`, `catalog` e `config` responderem; nada a editar no `opc-companion.mjs`.

`plugins/opc/scripts/commands/providers.mjs`:

```js
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
  if (positionals.length) throw new UsageError('USAGE', 'usage: opc providers [--all] [--json]');
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
```

`plugins/opc/scripts/commands/models.mjs`:

```js
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

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (positionals.length > 1) throw new UsageError('USAGE', 'usage: opc models [provider] [--verbose] [--allowed] [--all] [--json]');
  const provider = positionals[0] ?? null;
  const { api } = await connectApi(ctx);
  const catalog = buildCatalog(await api.providers());
  if (provider) {
    const known = catalog.providers.find((p) => p.id === provider);
    if (!known) throw new UsageError('UNKNOWN_PROVIDER', `unknown provider "${provider}" (known: ${catalog.providers.map((p) => p.id).join(', ')})`);
    if (!known.connected && !flags.all) throw new UsageError('UNKNOWN_PROVIDER', `provider "${provider}" is not connected; use --all to list its catalog or run: opencode auth login`);
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
```

`plugins/opc/scripts/commands/agents.mjs`:

```js
// opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json] — spec §4 (/opc:agents)
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

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (positionals.length) throw new UsageError('USAGE', 'usage: opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json]');
  if (!MODES.includes(flags.mode)) throw new UsageError('USAGE', `--mode must be one of: ${MODES.join(', ')}`);
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
```

`plugins/opc/scripts/commands/catalog.mjs`:

```js
// opc catalog commands|skills [--json] — spec §4 (/opc:catalog)
import { parseArgs } from '../lib/args.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { evaluateCommand } from '../lib/policy.mjs';
import { renderCatalog } from '../lib/render.mjs';

const SPEC = { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true };

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const kind = positionals[0];
  if (positionals.length !== 1 || !['commands', 'skills'].includes(kind)) throw new UsageError('USAGE', 'usage: opc catalog commands|skills [--json]');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/discovery.test.mjs && npm test`
Expected: PASS (6 testes novos). O "uso bloqueia (exit 4)" do aceite é testado na Task 11 (`config-cli.test.mjs`), onde o comando `config` existe.

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/commands/providers.mjs plugins/opc/scripts/commands/models.mjs plugins/opc/scripts/commands/agents.mjs plugins/opc/scripts/commands/catalog.mjs tests/integration/discovery.test.mjs
git commit -m "feat(cli): add providers, models, agents and catalog commands"
```

---

### Task 11: Comando `config` — get, set, unset, add, remove, show, validate, path e `--tty-confirm`

**Files:**
- Create: `plugins/opc/scripts/commands/config.mjs`
- Test: `tests/integration/config-cli.test.mjs`

**Interfaces:**
- Consumes: `parseArgs` (F0); `UsageError`, `PolicyError`, `ConnectionError` (F0); `connectApi` (Task 1); `buildCatalog` (Task 3); toda a API de `config.mjs` (Tasks 5–6); `createPrompter` (Task 7); `renderConfig` (Task 9).
- Produces (CLI):
  - `opc config path [--json]` → `{ kind:'path', dataDir, global, workspace, draft }`;
  - `opc config get [chave] [--global|--workspace] [--json]` → `{ kind:'get', setting, source, value }` (padrão: config efetiva);
  - `opc config set|unset|add|remove <chave> [valor…] [--workspace] [--tty-confirm] [--json]` → `{ kind:'edit', op, setting, scope, path, value, warnings }`. Chaves de modelo/agente/provider/variant consultam o servidor, normalizam e passam pela política efetiva (exit 2 inválido, 4 negado). Chave travada: sem `--tty-confirm` → exit 4 `LOCKED_KEY` com o comando de terminal; com `--tty-confirm` e stdin sem TTY → exit 4; com TTY → digitar o nome da chave confirma. Chave não permitida no `.opc.json` com `--workspace` → exit 2 `GLOBAL_ONLY_KEY`;
  - `opc config show [--effective] [--json]`;
  - `opc config validate [--json]` → `{ kind:'validate', valid, serverChecked, serverError, errors: [{source, path, code, message}], warnings }`, exit conforme D11.

- [ ] **Step 1: Write the failing test**

`tests/integration/config-cli.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace, testEnv, runCli, stopAllServers, writeGlobalConfig, readGlobalConfig, writeWorkspaceConfig,
} from '../helpers.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const WORLD = { policy: { providers: { allow: [], deny: [EQ] }, agents: { allow: [], deny: ['work-*'] } } };

function setup(t, { config = null, scenario = 'ok' } = {}) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { scenario }); // servers stopped by the F0 per-test cleanup
  if (config) writeGlobalConfig(env, config);
  return { ws, env, cli: (args, opts = {}) => runCli(args, { env, cwd: ws, ...opts }) };
}
const all = (r) => `${r.stdout}${r.stderr}`;

test('path and get work without any config', async (t) => {
  const { env, cli } = setup(t);
  const p = JSON.parse((await cli(['config', 'path', '--json'])).stdout);
  assert.equal(p.global, path.join(env.OPC_DATA_DIR, 'config.json'));
  assert.equal(p.draft, path.join(env.OPC_DATA_DIR, 'config.draft.json'));
  const get = await cli(['config', 'get', 'defaultModel']);
  assert.equal(get.code, 0);
  assert.equal(get.stdout, 'defaultModel = null\n');
  assert.equal((await cli(['config', 'get', 'no.such.key'])).code, 2);
});

test('set scalar without server: file created with mode 0600', async (t) => {
  const { env, cli } = setup(t);
  const r = await cli(['config', 'set', 'stopGate.enabled', 'true', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readGlobalConfig(env).stopGate.enabled, true);
  assert.equal(fs.statSync(path.join(env.OPC_DATA_DIR, 'config.json')).mode & 0o777, 0o600);
  assert.equal((await cli(['config', 'set', 'jobs.maxActive', 'lots'])).code, 2);
  assert.equal((await cli(['config', 'set', 'nope.key', '1'])).code, 2);
});

test('model ids: short name gets the default provider, ambiguity, "=" prefix, unknown, variant', async (t) => {
  const { env, cli } = setup(t, { config: { defaultProvider: MV } });
  let r = await cli(['config', 'set', 'defaultModel', 'opencode-go/kimi-k3', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).value, `${MV}/opencode-go/kimi-k3`);
  assert.equal(JSON.parse(r.stdout).setting, 'defaultModel', 'JSON never uses a "key" field (redact() masks it)');
  r = await cli(['config', 'set', 'defaultModel', 'opencode/big-pickle']);
  assert.equal(r.code, 2);
  assert.match(all(r), /AMBIGUOUS_MODEL/);
  assert.match(all(r), /=opencode\/big-pickle/);
  r = await cli(['config', 'set', 'defaultModel', '=opencode/big-pickle', '--json']);
  assert.equal(JSON.parse(r.stdout).value, 'opencode/big-pickle');
  r = await cli(['config', 'set', 'defaultModel', `${MV}/opencode/big-pickle`, '--json']);
  assert.equal(JSON.parse(r.stdout).value, `${MV}/opencode/big-pickle`);
  r = await cli(['config', 'set', 'defaultModel', 'opencode-go/does-not-exist']);
  assert.equal(r.code, 2);
  assert.match(all(r), /UNKNOWN_MODEL/);
  await cli(['config', 'set', 'defaultModel', 'opencode-go/kimi-k3']);
  assert.equal((await cli(['config', 'set', 'defaultVariant', 'high'])).code, 0);
  r = await cli(['config', 'set', 'defaultVariant', 'ultra']);
  assert.equal(r.code, 2);
  assert.match(all(r), /UNKNOWN_VARIANT/);
  assert.equal(readGlobalConfig(env).defaultVariant, 'high');
});

test('aliases: expanded on input, alias names kept in model references, lists', async (t) => {
  const { env, cli } = setup(t, { config: { defaultProvider: MV } });
  assert.equal((await cli(['config', 'set', 'aliases.fast', 'opencode-go/deepseek-v4.1-flash'])).code, 0);
  assert.equal((await cli(['config', 'set', 'reviewModel', 'fast'])).code, 0);
  assert.equal((await cli(['config', 'add', 'routing.tasks.ask', 'fast'])).code, 0);
  assert.equal((await cli(['config', 'add', 'routing.tasks.ask', 'opencode-go/kimi-k3'])).code, 0);
  const cfg = readGlobalConfig(env);
  assert.equal(cfg.aliases.fast, `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.equal(cfg.reviewModel, 'fast');
  assert.deepEqual(cfg.routing.tasks.ask, ['fast', `${MV}/opencode-go/kimi-k3`]);
  assert.equal((await cli(['config', 'remove', 'routing.tasks.ask', 'fast'])).code, 0);
  const missing = await cli(['config', 'remove', 'routing.tasks.ask', 'fast']);
  assert.equal(missing.code, 2);
  assert.match(all(missing), /NOT_IN_LIST/);
  assert.equal((await cli(['config', 'unset', 'reviewModel'])).code, 0);
  assert.equal(readGlobalConfig(env).reviewModel, undefined);
});

test('validate: unknown model, invalid variant, broken alias, secret-looking key', async (t) => {
  const { cli } = setup(t, {
    config: {
      defaultModel: `${MV}/opencode-go/removed-model`,
      defaultVariant: 'ultra',
      aliases: { gone: `${MV}/opencode-go/also-removed` },
      reviewModel: 'gone',
      server: { configOverride: { share: 'disabled', provider: { x: { options: { apiKey: 'sk-should-not-be-here' } } } } },
      githubToken: 'nope',
    },
  });
  const r = await cli(['config', 'validate', '--json']);
  assert.equal(r.code, 2);
  const view = JSON.parse(r.stdout);
  const errors = view.errors.map((e) => `${e.path}:${e.code}`);
  assert.ok(errors.includes('defaultModel:UNKNOWN_MODEL'), errors.join());
  assert.ok(errors.includes('defaultVariant:UNKNOWN_VARIANT'), errors.join());
  assert.ok(errors.includes('reviewModel:BROKEN_ALIAS'), errors.join());
  assert.ok(errors.includes('aliases.gone:UNKNOWN_MODEL'), errors.join());
  const secretWarnings = view.warnings.filter((w) => w.code === 'SECRET_LIKE_KEY').map((w) => w.path);
  assert.ok(secretWarnings.includes('githubToken'));
  assert.ok(secretWarnings.includes('server.configOverride.provider.x.options.apiKey'));
  assert.doesNotMatch(r.stdout, /sk-should-not-be-here/);
  const text = await cli(['config', 'show']);
  assert.doesNotMatch(text.stdout, /sk-should-not-be-here/);
});

test('validate: policy-denied default gives exit 4; clean config gives exit 0', async (t) => {
  const denied = setup(t, { config: { ...WORLD, defaultModel: `${EQ}/opencode-go/kimi-k3` } });
  const r = await denied.cli(['config', 'validate', '--json']);
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.stdout).errors[0].code, 'POLICY_DENIED');
  const clean = setup(t, { config: { ...WORLD, defaultModel: `${MV}/opencode-go/kimi-k3` } });
  const ok = await clean.cli(['config', 'validate', '--json']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).valid, true);
});

test('policy blocks explicit use of denied models and agents (exit 4)', async (t) => {
  const { env, cli } = setup(t, { config: WORLD });
  const model = await cli(['config', 'set', 'defaultModel', `${EQ}/opencode-go/kimi-k3`]);
  assert.equal(model.code, 4, all(model));
  assert.match(all(model), /policy\.providers\.deny: omniroute-work/);
  const agent = await cli(['config', 'set', 'defaultAgent', 'work-reviewer']);
  assert.equal(agent.code, 4, all(agent));
  assert.match(all(agent), /policy\.agents\.deny: work-\*/);
  const alias = await cli(['config', 'set', 'aliases.eq', `${EQ}/opencode-go/kimi-k3`]);
  assert.equal(alias.code, 4, 'aliases pass through the policy too');
  assert.equal(readGlobalConfig(env).defaultModel, undefined, 'nothing written');
});

test('pinned-denied-model: an agent whose pinned model is denied cannot become the default (exit 4)', async (t) => {
  const { cli } = setup(t, { config: WORLD, scenario: 'pinned-denied-model' });
  const r = await cli(['config', 'set', 'defaultAgent', 'pinned-reviewer']);
  assert.equal(r.code, 4, all(r));
  assert.match(all(r), /pinned model omniroute-work\/opencode-go\/kimi-k3/);
  assert.equal((await cli(['config', 'set', 'defaultAgent', 'docs-writer'])).code, 2, 'subagent-only agent cannot be the session agent');
  assert.equal((await cli(['config', 'set', 'defaultAgent', 'build'])).code, 0);
});

test('locked keys are refused without a TTY (exit 4) and nothing is written', async (t) => {
  const { env, cli } = setup(t);
  let r = await cli(['config', 'set', 'policy.models.deny', 'x/*']);
  assert.equal(r.code, 4);
  assert.match(all(r), /LOCKED_KEY/);
  assert.match(all(r), /opc config set policy\.models\.deny 'x\/\*' --tty-confirm/);
  r = await cli(['config', 'set', 'policy.models.deny', 'x/*', '--tty-confirm']);
  assert.equal(r.code, 4);
  assert.match(all(r), /not a TTY/);
  r = await cli(['config', 'unset', 'policy.approver']);
  assert.equal(r.code, 4, 'unset of a locked key is locked too');
  r = await cli(['config', 'set', 'server.configOverride', '{"share":"auto"}']);
  assert.equal(r.code, 4);
  assert.equal(readGlobalConfig(env), null);
});

test('workspace edits: preference keys go to .opc.json; global-only keys refused', async (t) => {
  const { ws, cli } = setup(t);
  const r = await cli(['config', 'set', 'defaultModel', `${MV}/opencode-go/kimi-k3`, '--workspace', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.opc.json'), 'utf8')).defaultModel, `${MV}/opencode-go/kimi-k3`);
  const approver = await cli(['config', 'set', 'policy.approver', 'claude', '--workspace']);
  assert.equal(approver.code, 2);
  assert.match(all(approver), /GLOBAL_ONLY_KEY/);
  const jobs = await cli(['config', 'set', 'jobs.maxActive', '64', '--workspace']);
  assert.equal(jobs.code, 2);
});

test('restrictive merge: .opc.json can only narrow the global policy', async (t) => {
  const { ws, cli } = setup(t, { config: { policy: { models: { allow: [`${MV}/*`] }, providers: { deny: [EQ] } } } });
  writeWorkspaceConfig(ws, {
    policy: { models: { allow: [`${MV}/opencode-go/kimi-*`, 'anthropic/*'], deny: ['*/qwen*'] }, approver: 'claude' },
    permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
  });
  const eff = JSON.parse((await cli(['config', 'show', '--effective', '--json'])).stdout);
  assert.deepEqual(eff.config.policy.models.allow, [`${MV}/*`]);
  assert.deepEqual(eff.config.policy.models.allowWorkspace, [`${MV}/opencode-go/kimi-*`, 'anthropic/*']);
  assert.equal(eff.config.policy.approver, 'user');
  assert.deepEqual(eff.config.permissionProfiles, {});
  const warned = eff.warnings.map((w) => w.path);
  for (const p of ['policy.approver', 'permissionProfiles', 'policy.models.allow']) assert.ok(warned.includes(p), p);
  const allowed = JSON.parse((await cli(['models', '--allowed', '--json'])).stdout).models.map((m) => m.full);
  assert.deepEqual(allowed, [`${MV}/opencode-go/kimi-k2.6`, `${MV}/opencode-go/kimi-k3`], 'anthropic/* cannot widen the global allow');
});

test('arguments via --args-stdin are never expanded by a shell', async (t) => {
  const { ws, env, cli } = setup(t);
  const r = await cli(['config', '--args-stdin'], { stdin: 'set project.goal "it\'s $(touch pwned) `id` ok"\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readGlobalConfig(env).project.goal, "it's $(touch pwned) `id` ok");
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false);
  // Unquoted prose apostrophes stay literal (F0 splitArgString: ' between letters never opens a quote).
  const prose = await cli(['config', '--args-stdin'], { stdin: "set project.goal can't-won't\n" });
  assert.equal(prose.code, 0, prose.stderr);
  assert.equal(readGlobalConfig(env).project.goal, "can't-won't");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/config-cli.test.mjs`
Expected: FAIL — exit 2 `USAGE: Subcomando desconhecido: config`.

- [ ] **Step 3: Write the command**

`plugins/opc/scripts/commands/config.mjs`:

```js
// opc config get|set|unset|add|remove|show|validate|path|init — spec §3.2, §3.3
import { parseArgs } from '../lib/args.mjs';
import { UsageError, PolicyError, ConnectionError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import {
  loadConfig, configPaths, getPath, schemaFor, coerceValue, applyConfigEdit, isLockedKey, isWorkspaceKey,
  keyNeedsServer, normalizeEditValue, validateConfigShape, mergeConfig, validateAgainstServer, policyViolations,
  saveGlobalConfig, saveWorkspaceConfig, CONFIG_SCHEMA,
} from '../lib/config.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { createPrompter } from '../lib/tty.mjs';
import { renderConfig } from '../lib/render.mjs';

const SPEC = {
  flags: {
    json: { type: 'boolean' }, cwd: { type: 'string' }, workspace: { type: 'boolean' }, global: { type: 'boolean' },
    'tty-confirm': { type: 'boolean' }, effective: { type: 'boolean' },
  },
  allowPositionals: true,
};
const USAGE = 'usage: opc config get [key] | set <key> <value> | unset <key> | add|remove <list-key> <value> | show [--effective] | validate | path   (edits accept --workspace and --tty-confirm)';

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const emit = (ctx, flags, view, render) => { if (flags.json) ctx.json(view); else ctx.out(render(view)); };
const touches = (key) => (e) => e.path === key || e.path.startsWith(`${key}.`) || e.path.startsWith(`${key}[`);
const knownKey = (key) => Boolean(schemaFor(key)) || Object.keys(CONFIG_SCHEMA).some((k) => k.startsWith(`${key}.`));

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const [sub, ...rest] = positionals;
  switch (sub) {
    case 'path': return cmdPath(ctx, flags);
    case 'get': return cmdGet(ctx, flags, rest);
    case 'set': case 'unset': case 'add': case 'remove': return cmdEdit(ctx, flags, sub, rest);
    case 'show': return cmdShow(ctx, flags);
    case 'validate': return cmdValidate(ctx, flags);
    default: throw new UsageError('USAGE', USAGE);
  }
}

function cmdPath(ctx, flags) {
  emit(ctx, flags, { kind: 'path', ...configPaths({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot }) }, renderConfig);
  return 0;
}

function cmdGet(ctx, flags, rest) {
  if (rest.length > 1) throw new UsageError('USAGE', USAGE);
  const key = rest[0] ?? null;
  if (key && !knownKey(key)) throw new UsageError('UNKNOWN_KEY', `unknown config key "${key}"`);
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const source = flags.global ? 'global' : flags.workspace ? 'workspace' : 'effective';
  const obj = source === 'global' ? (loaded.global ?? {}) : source === 'workspace' ? (loaded.workspace ?? {}) : loaded.config;
  const value = key ? (getPath(obj, key) ?? null) : obj;
  emit(ctx, flags, { kind: 'get', setting: key ?? '(all)', source, value }, renderConfig);
  return 0;
}

function terminalCommand(op, key, raw, scope) {
  return `opc config ${op} ${key}${raw !== undefined ? ` ${shellQuote(raw)}` : ''}${scope === 'workspace' ? ' --workspace' : ''} --tty-confirm`;
}

async function confirmLocked(ctx, flags, { op, key, raw, scope }) {
  const command = terminalCommand(op, key, raw, scope);
  if (!flags['tty-confirm']) {
    throw new PolicyError('LOCKED_KEY', `"${key}" is a locked key; change it in your own terminal: ${command} (or run: opc config init)`, { details: { setting: key, command } });
  }
  if (!ctx.stdin || !ctx.stdin.isTTY) {
    throw new PolicyError('LOCKED_KEY', `--tty-confirm needs an interactive terminal (stdin is not a TTY); run in your terminal: ${command}`, { details: { setting: key, command } });
  }
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
  try {
    ctx.err(`[opc] "${key}" é uma chave travada (política/mundo).\n`);
    const typed = await prompter.text(`Digite "${key}" para confirmar a alteração: `);
    if (typed !== key) throw new PolicyError('LOCKED_KEY', 'confirmation did not match; nothing was changed', { details: { setting: key } });
  } finally {
    prompter.close();
  }
}

async function serverDeps(ctx) {
  const { api } = await connectApi(ctx);
  const [providers, agents, opencodeConfig] = await Promise.all([api.providers(), api.agents(), api.getConfig()]);
  return { catalog: buildCatalog(providers), agents, opencodeConfig };
}

async function cmdEdit(ctx, flags, op, rest) {
  const [key, ...valueParts] = rest;
  if (!key) throw new UsageError('USAGE', USAGE);
  if (!schemaFor(key)) throw new UsageError('UNKNOWN_KEY', `unknown config key "${key}"`);
  if (op === 'unset' ? valueParts.length > 0 : valueParts.length === 0) throw new UsageError('USAGE', USAGE);
  const raw = op === 'unset' ? undefined : valueParts.join(' ');
  const scope = flags.workspace ? 'workspace' : 'global';
  if (scope === 'workspace' && !isWorkspaceKey(key)) {
    throw new UsageError('GLOBAL_ONLY_KEY', `"${key}" cannot be set in .opc.json (the workspace file only restricts); use the global config`);
  }
  if (isLockedKey(key)) await confirmLocked(ctx, flags, { op, key, raw, scope });
  let value = raw === undefined ? undefined : coerceValue(key, raw);
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const base = (scope === 'workspace' ? loaded.workspace : loaded.global) ?? {};
  const warnings = [];
  let next;
  if (value !== undefined && value !== null && keyNeedsServer(key)) {
    const deps = await serverDeps(ctx);
    const normOpts = { catalog: deps.catalog, aliases: loaded.config.aliases ?? {}, defaultProvider: key === 'defaultProvider' ? null : loaded.config.defaultProvider };
    try {
      value = normalizeEditValue(key, value, normOpts);
    } catch (err) {
      if (op !== 'remove') throw err;
    }
    next = applyConfigEdit(base, op, key, value);
    const effective = scope === 'workspace' ? mergeConfig(loaded.global ?? {}, next) : mergeConfig(next, loaded.workspace ?? {});
    const checked = validateAgainstServer(effective.config, deps);
    const own = checked.errors.filter(touches(key));
    if (own.length) throw new UsageError(own[0].code ?? 'INVALID_VALUE', own.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: own } });
    const denied = policyViolations(effective.config, deps).filter(touches(key));
    if (denied.length) throw new PolicyError('POLICY_DENIED', denied.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: denied } });
    for (const e of checked.errors.filter((x) => !touches(key)(x))) warnings.push({ path: e.path, code: e.code, message: e.message });
  } else {
    next = applyConfigEdit(base, op, key, value);
  }
  const shape = validateConfigShape(next, { source: scope });
  if (shape.errors.length) throw new UsageError('INVALID_VALUE', shape.errors.map((e) => `${e.path}: ${e.message}`).join('; '), { details: { errors: shape.errors } });
  warnings.push(...shape.warnings);
  if (scope === 'workspace') saveWorkspaceConfig(ctx.workspaceRoot, next);
  else saveGlobalConfig(ctx.dataDir, next);
  const paths = configPaths({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  emit(ctx, flags, { kind: 'edit', op, setting: key, scope, path: scope === 'workspace' ? paths.workspace : paths.global, value: getPath(next, key) ?? null, warnings }, renderConfig);
  return 0;
}

function cmdShow(ctx, flags) {
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const paths = configPaths({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const view = flags.effective
    ? { kind: 'effective', config: loaded.config, warnings: loaded.warnings ?? [] }
    : { kind: 'show', global: loaded.global, workspace: loaded.workspace, paths, warnings: loaded.warnings ?? [] };
  emit(ctx, flags, view, renderConfig);
  return 0;
}

async function cmdValidate(ctx, flags) {
  const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const addWarning = (source, w) => {
    const id = `${w.path}|${w.code ?? ''}|${w.message}`;
    if (!seen.has(id)) { seen.add(id); warnings.push({ source, ...w }); }
  };
  for (const [source, obj] of [['global', loaded.global], ['workspace', loaded.workspace]]) {
    const shape = validateConfigShape(obj, { source });
    errors.push(...shape.errors.map((e) => ({ source, ...e })));
    shape.warnings.forEach((w) => addWarning(source, w));
  }
  (loaded.warnings ?? []).forEach((w) => addWarning('merge', typeof w === 'string' ? { path: '', message: w } : w));
  let serverChecked = false;
  let serverError = null;
  try {
    const deps = await serverDeps(ctx);
    const checked = validateAgainstServer(loaded.config, deps);
    errors.push(...checked.errors.map((e) => ({ source: 'effective', ...e })));
    checked.warnings.forEach((w) => addWarning('effective', w));
    errors.push(...policyViolations(loaded.config, deps).map((e) => ({ source: 'effective', ...e })));
    serverChecked = true;
  } catch (err) {
    if (!(err instanceof ConnectionError)) throw err;
    serverError = `${err.code}: ${err.message}`;
  }
  const view = { kind: 'validate', valid: errors.length === 0 && serverChecked, serverChecked, serverError, errors, warnings };
  emit(ctx, flags, view, renderConfig);
  if (errors.length) return errors.every((e) => e.code === 'POLICY_DENIED') ? 4 : 2;
  return serverChecked ? 0 : 5;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/config-cli.test.mjs && npm test`
Expected: PASS (12 testes novos).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/commands/config.mjs tests/integration/config-cli.test.mjs
git commit -m "feat(cli): add config command with locked keys and server validation"
```

---

### Task 12: Assistente de terminal `opc config init` e confirmação por TTY

**Files:**
- Modify: `plugins/opc/scripts/lib/onboarding.mjs` (import de `redact` + bloco do assistente no fim)
- Modify: `plugins/opc/scripts/commands/config.mjs` (imports, `case 'init'`, `cmdInit`, texto de uso)
- Test: `tests/unit/onboarding-wizard.test.mjs`, `tests/integration/config-tty.test.mjs`

**Interfaces:**
- Consumes: `createPrompter` (Task 7); `buildDraft`, `nextStep`, `applyDraftStep`, `commitDraft`, `candidateConfig`, `draftEffectiveConfig`, `rankProviders`, `suggestModels`, `suggestAliases`, `modelFamilies`, `projectDirs` (Task 8); `redact` (F0); `runInProcess`, `scriptedTTY` (Task 2).
- Produces: `runInitWizard({ prompter, catalog, agents, opencodeConfig, existing, hasGlobal, dataDir, workspaceRoot, log })` → resultado de `commitDraft` ou `null` (usuário não confirmou); `opc config init [--json]` (exige TTY: sem TTY → exit 2 `NOT_A_TTY`; entrada fechada no meio → exit 2 `TTY_CLOSED`, nada gravado). Resposta inválida numa etapa (ex.: modelo ambíguo) é mostrada em stderr e a mesma etapa é perguntada de novo; o assistente pode editar chaves travadas (é o TTY do operador, spec §3.3).

- [ ] **Step 1: Write the failing tests**

`tests/unit/onboarding-wizard.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInitWizard } from '../../plugins/opc/scripts/lib/onboarding.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { createPrompter } from '../../plugins/opc/scripts/lib/tty.mjs';
import { scriptedTTY, captureStream } from '../helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog(load('provider.json'));
const agents = load('agent.json');
const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-wiz-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function wizard(t, answers, { existing = { global: null, workspace: null }, hasGlobal = false } = {}) {
  const dataDir = tmp(t);
  const ws = tmp(t);
  const output = captureStream();
  const log = captureStream();
  const prompter = createPrompter({ input: scriptedTTY(answers), output });
  t.after(() => prompter.close());
  const run = runInitWizard({ prompter, catalog, agents, existing, hasGlobal, dataDir, workspaceRoot: ws, log: (s) => log.write(s) });
  return { run, dataDir, output, log };
}

test('bootstrap wizard: invalid answer is re-asked, locked steps included, config committed', async (t) => {
  const answers = [
    '1',                 // provider
    'o', 'opencode/big-pickle', // "Outro": ambiguous -> error, step re-asked
    'kimi-k3', '1',      // model
    '1', '1',            // review / stop gate: none
    '1',                 // variant: none
    '1', '',             // models: no restriction; no provider deny
    '2', '',             // agents: only built-in; no deny
    '2',                 // approver: claude
    's', 'n',            // stop gate on, delegation off
    '', 'todos',         // no goal; all task types (no dirs: empty workspace)
    'n', 's',            // aliases: skip fast, create strong
    's',                 // save
  ];
  const { run, dataDir, log } = wizard(t, answers);
  const result = await run;
  assert.equal(result.scope, 'global');
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.defaultVariant, null);
  assert.deepEqual(cfg.policy.agents.allow, ['build', 'plan', 'general', 'explore']);
  assert.equal(cfg.policy.approver, 'claude');
  assert.equal(cfg.stopGate.enabled, true);
  assert.deepEqual(cfg.project, { goal: null, scope: [], taskTypes: ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'] });
  assert.deepEqual(cfg.aliases, { strong: `${MV}/opencode-go/qwen3.8-max` });
  assert.match(log.text(), /AMBIGUOUS|ambiguous/);
});

test('reconfigure wizard asks the scope first and may decline saving', async (t) => {
  const existing = { global: { defaultProvider: MV, defaultModel: `${MV}/opencode-go/kimi-k3` }, workspace: null };
  const answers = [
    '1',                 // scope: global
    '1',                 // provider
    'deepseek', '1',     // model
    '1', '1', '1',       // review, stop gate, variant
    '1', EQ,             // models: no restriction; deny omniroute-work
    '1', '',             // agents: all; no deny
    '1',                 // approver user
    'n', 'n',            // behaviour
    '', '',              // goal none; task types none
    'n', 'n',            // aliases
    'n',                 // do not save
  ];
  const { run, dataDir } = wizard(t, answers, { existing, hasGlobal: true });
  assert.equal(await run, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});
```

`tests/integration/config-tty.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace, testEnv, runCli, stopAllServers, writeGlobalConfig, readGlobalConfig, runInProcess, scriptedTTY,
} from '../helpers.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';

function setup(t, { config = null, git = true } = {}) {
  const ws = makeWorkspace(t, { git });
  const env = testEnv(t); // servers stopped by the F0 per-test cleanup
  if (config) writeGlobalConfig(env, config);
  return { ws, env };
}

test('--tty-confirm on a TTY: typed key confirms; mismatch refuses (exit 4)', async (t) => {
  const { ws, env } = setup(t, { config: { defaultProvider: MV } });
  const wrong = await runInProcess('config', ['set', 'policy.approver', 'claude', '--tty-confirm'], { env, cwd: ws, stdin: scriptedTTY(['policy.aprover']) });
  assert.equal(wrong.code, 4);
  assert.match(wrong.stderr, /did not match/);
  assert.equal(readGlobalConfig(env).policy, undefined);
  const ok = await runInProcess('config', ['set', 'policy.approver', 'claude', '--tty-confirm', '--json'], { env, cwd: ws, stdin: scriptedTTY(['policy.approver']) });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(readGlobalConfig(env).policy.approver, 'claude');
  assert.match(ok.stderr, /chave travada/);
  const list = await runInProcess('config', ['add', 'policy.agents.deny', 'work-*', '--tty-confirm'], { env, cwd: ws, stdin: scriptedTTY(['policy.agents.deny']) });
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(readGlobalConfig(env).policy.agents.deny, ['work-*']);
});

test('config init: scripted wizard writes the full config (numbered lists, filter, ranges)', async (t) => {
  const { ws, env } = setup(t, { git: false });
  fs.mkdirSync(path.join(ws, 'src'));
  fs.mkdirSync(path.join(ws, 'tests'));
  const answers = [
    '1',                        // provider: omniroute-mvalmeida (most models)
    'kimi-k3', '1',             // model: filter by text, pick the first match
    '1',                        // review model: none (use default)
    '1',                        // stop gate model: none
    '4',                        // variant: Nenhuma, low, medium, [high]
    '2', EQ,                    // allowed models: <provider>/*; deny provider omniroute-work
    '1', 'work-*',                // agents: all; deny work-*
    '1',                        // approver: user
    'n', 'n',                   // stop gate, auto delegation
    'Plugin Claude Code para OpenCode', '1-2', '1,3', // goal; dirs src/ + tests/; task types ask + review
    's', 's',                   // aliases fast / strong
    's',                        // save
  ];
  const r = await runInProcess('config', ['init', '--json'], { env, cwd: ws, stdin: scriptedTTY(answers) });
  assert.equal(r.code, 0, r.stderr);
  const cfg = readGlobalConfig(env);
  assert.equal(cfg.defaultProvider, MV);
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.defaultVariant, 'high');
  assert.equal(cfg.reviewModel, null);
  assert.deepEqual(cfg.policy.models.allow, [`${MV}/*`]);
  assert.deepEqual(cfg.policy.providers.deny, [EQ]);
  assert.deepEqual(cfg.policy.agents, { allow: [], deny: ['work-*'] });
  assert.equal(cfg.policy.approver, 'user');
  assert.deepEqual(cfg.project, { goal: 'Plugin Claude Code para OpenCode', scope: ['src/', 'tests/'], taskTypes: ['ask', 'review'] });
  assert.equal(cfg.aliases.fast, `${MV}/opencode-go/qwen3.8-flash`);
  assert.equal(cfg.aliases.strong, `${MV}/opencode-go/qwen3.8-max`);
  assert.match(r.stderr, / 1\) omniroute-mvalmeida/);
});

test('config init without a TTY is refused (exit 2) and writes nothing', async (t) => {
  const { ws, env } = setup(t);
  const r = await runCli(['config', 'init'], { env, cwd: ws });
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /NOT_A_TTY/);
  assert.equal(readGlobalConfig(env), null);
});

test('config init: interrupted input writes nothing (exit 2)', async (t) => {
  const { ws, env } = setup(t);
  const r = await runInProcess('config', ['init'], { env, cwd: ws, stdin: scriptedTTY(['1']) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TTY_CLOSED|interrupted/);
  assert.equal(readGlobalConfig(env), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/onboarding-wizard.test.mjs tests/integration/config-tty.test.mjs`
Expected: FAIL — `runInitWizard` não é exportado; `config init` cai no uso (exit 2 sem `NOT_A_TTY`). Os dois testes de `--tty-confirm` em `config-tty` já passam (Task 11).

- [ ] **Step 3: Write the wizard**

No topo de `plugins/opc/scripts/lib/onboarding.mjs`, junto dos outros imports:

```js
import { redact } from './redact.mjs';
```

E no fim do arquivo:

```js

// ---- F1 Task 12: terminal wizard (the TTY is only an interface over the same steps) ----
const TASK_TYPE_CHOICES = ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'].map((t) => ({ label: t, value: t }));
const splitGlobs = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const modelChoice = (m) => ({ label: m.full, hint: `${m.name}${m.variants.length ? ` · variants: ${m.variants.join(', ')}` : ''}`, value: m.full });

async function askStep(prompter, stepId, { draft, catalog, agents, existing, workspaceRoot }) {
  const eff = draftEffectiveConfig(draft, existing);
  const provider = eff.defaultProvider;
  const allowedOf = (p) => suggestModels(catalog, p, { top: Infinity, policy: eff.policy });
  const pickModel = async (question, { allowNone }) => {
    const choices = [...(allowNone ? [{ label: 'Nenhum (usar o modelo padrão)', value: null }] : []), ...(provider ? allowedOf(provider) : []).map(modelChoice)];
    const answer = await prompter.select(question, choices, { allowOther: true });
    return answer && typeof answer === 'object' ? answer.other : answer;
  };
  switch (stepId) {
    case 'scope':
      return { scope: await prompter.select('Onde gravar?', [{ label: 'Global (todas as pastas)', value: 'global' }, { label: 'Só este workspace (.opc.json)', value: 'workspace' }]) };
    case 'defaultProvider': {
      const ranked = rankProviders(catalog, eff.policy).filter((p) => p.allowed);
      if (!ranked.length) throw new UsageError('NO_PROVIDER', 'no connected provider allowed by the policy; run: opencode auth login');
      return { defaultProvider: await prompter.select('Provider padrão?', ranked.map((p) => ({ label: p.id, hint: `${p.modelCount} modelos`, value: p.id }))) };
    }
    case 'defaultModel':
      return { defaultModel: await pickModel('Modelo padrão? (número, texto para filtrar ou "o" para digitar)', { allowNone: false }) };
    case 'reviewModels': {
      const reviewModel = await pickModel('Modelo do review?', { allowNone: true });
      const stopGateModel = await pickModel('Modelo do stop gate?', { allowNone: true });
      return { reviewModel, stopGate: { model: stopGateModel } };
    }
    case 'defaultVariant': {
      const entry = eff.defaultModel ? catalog.byFull.get(eff.defaultModel) : null;
      const variants = entry ? entry.variants : [];
      return { defaultVariant: await prompter.select('Variant padrão?', [{ label: 'Nenhuma', value: null }, ...variants.map((v) => ({ label: v, value: v }))]) };
    }
    case 'allowedModels': {
      const families = provider ? modelFamilies(catalog, provider).slice(0, 3) : [];
      const answer = await prompter.select('Modelos permitidos?', [
        { label: 'Sem restrição', value: [] },
        ...(provider ? [{ label: `Todos do provider padrão (${provider}/*)`, value: [`${provider}/*`] }] : []),
        ...families.map((f) => ({ label: `Só ${f.glob}`, hint: `${f.count} modelos`, value: [f.glob] })),
      ], { allowOther: true });
      const allow = Array.isArray(answer) ? answer : splitGlobs(answer.other);
      const denyProviders = splitGlobs(await prompter.text('Providers a negar (globs separados por vírgula; vazio = nenhum): ', { defaultValue: '' }));
      return { policy: { models: { allow }, providers: { deny: denyProviders } } };
    }
    case 'allowedAgents': {
      const builtIn = agents.filter((a) => a.native && !a.hidden).map((a) => a.name);
      const answer = await prompter.select('Agentes permitidos?', [
        { label: 'Todos', value: [] },
        { label: `Só built-in (${builtIn.join(', ')})`, value: builtIn },
      ], { allowOther: true });
      const allow = Array.isArray(answer) ? answer : splitGlobs(answer.other);
      const deny = splitGlobs(await prompter.text('Agentes a negar (globs separados por vírgula; vazio = nenhum): ', { defaultValue: '' }));
      return { policy: { agents: { allow, deny } } };
    }
    case 'approver':
      return { policy: { approver: await prompter.select('Quem aprova pedidos de permissão?', [{ label: 'Eu (usuário) — recomendado', value: 'user' }, { label: 'O Claude (exceto destrutivos, fora do diretório e caminhos sensíveis)', value: 'claude' }]) } };
    case 'behaviour':
      return {
        stopGate: { enabled: await prompter.confirm('Ligar o stop gate (review ao parar)?', { defaultValue: false }) },
        delegation: { auto: await prompter.confirm('Ligar a delegação automática?', { defaultValue: false }) },
      };
    case 'project': {
      const goal = await prompter.text('Objetivo do projeto (vazio = nenhum): ', { defaultValue: eff.project?.goal ?? '' });
      const dirs = projectDirs(workspaceRoot);
      const scope = dirs.length ? await prompter.multiSelect('Diretórios do escopo?', dirs.map((d) => ({ label: d, value: d }))) : [];
      const taskTypes = await prompter.multiSelect('Tipos de tarefa?', TASK_TYPE_CHOICES);
      return { project: { goal: goal === '' ? null : goal, scope, taskTypes } };
    }
    case 'aliases': {
      const suggested = provider ? suggestAliases(catalog, provider, eff.policy) : { fast: null, strong: null };
      const aliases = {};
      for (const name of ['fast', 'strong']) {
        if (suggested[name] && await prompter.confirm(`Criar alias "${name}" → ${suggested[name]}?`, { defaultValue: true })) aliases[name] = suggested[name];
      }
      return { aliases };
    }
    default:
      throw new UsageError('USAGE', `unknown onboarding step ${stepId}`);
  }
}

export async function runInitWizard({ prompter, catalog, agents, opencodeConfig = null, existing, hasGlobal, dataDir, workspaceRoot, log = () => {} }) {
  let draft = buildDraft({ hasGlobal });
  const deps = { catalog, agents, existing, allowLocked: true };
  for (let step = nextStep(draft, { allowLocked: true }); step; step = nextStep(draft, { allowLocked: true })) {
    const partial = await askStep(prompter, step, { draft, catalog, agents, existing, workspaceRoot });
    try {
      const result = applyDraftStep(draft, partial, deps);
      draft = result.draft;
      result.warnings.forEach((w) => log(`[opc] aviso: ${w.path}: ${w.message}\n`));
    } catch (err) {
      if (!(err.exitCode === 2 || err.exitCode === 4) || err.code === 'NO_PROVIDER') throw err;
      log(`[opc] ${err.message}\n`);
    }
  }
  log(`\n${JSON.stringify(redact(candidateConfig(draft, existing)), null, 2)}\n`);
  if (!(await prompter.confirm('Gravar esta config?', { defaultValue: true }))) return null;
  return commitDraft({ dataDir, workspaceRoot, draft, catalog, agents, opencodeConfig, existing, allowLocked: true });
}
```

- [ ] **Step 4: Wire `config init`**

Em `plugins/opc/scripts/commands/config.mjs`:

1. Trocar `import { UsageError, PolicyError, ConnectionError } from '../lib/opc-error.mjs';` por `import { UsageError, PolicyError, OpcError, ConnectionError } from '../lib/opc-error.mjs';`.
2. Trocar `import { renderConfig } from '../lib/render.mjs';` por:

```js
import { runInitWizard } from '../lib/onboarding.mjs';
import { renderConfig, renderOnboarding } from '../lib/render.mjs';
```

3. No `switch` de `run`, antes de `default:`, acrescentar `case 'init': return cmdInit(ctx, flags);`.
4. Na constante `USAGE`, trocar `| validate | path   (edits` por `| validate | path | init   (edits`.
5. Acrescentar no fim do arquivo:

```js
async function cmdInit(ctx, flags) {
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
  try {
    const deps = await serverDeps(ctx);
    const loaded = loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const result = await runInitWizard({
      prompter,
      ...deps,
      existing: { global: loaded.global, workspace: loaded.workspace },
      hasGlobal: loaded.hasGlobal,
      dataDir: ctx.dataDir,
      workspaceRoot: ctx.workspaceRoot,
      log: (text) => ctx.err(text),
    });
    if (!result) {
      ctx.out('Nada foi gravado.\n');
      return 0;
    }
    emit(ctx, flags, { kind: 'commit', ...result }, renderOnboarding);
    return 0;
  } catch (err) {
    if (err instanceof OpcError && err.code === 'TTY_CLOSED') throw new UsageError('TTY_CLOSED', 'wizard interrupted; nothing was written');
    throw err;
  } finally {
    prompter.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/unit/onboarding-wizard.test.mjs tests/integration/config-tty.test.mjs && npm test`
Expected: PASS (2 unitários + 4 de integração).

- [ ] **Step 6: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/lib/onboarding.mjs plugins/opc/scripts/commands/config.mjs tests/unit/onboarding-wizard.test.mjs tests/integration/config-tty.test.mjs
git commit -m "feat(config): add terminal wizard (config init) over the onboarding steps"
```

---

### Task 13: Onboarding pelo `setup` — estado, sugestões, rascunho e commit

**Files:**
- Modify: `plugins/opc/scripts/commands/setup.mjs` (renomear o `run` do F0 e acrescentar o bloco F1)
- Test: `tests/integration/onboarding.test.mjs`, `tests/integration/no-config-first-run.test.mjs`

**Interfaces:**
- Consumes: o `run` do F0 (renomeado `runDiagnostics`, premissa P5); `parseArgs`, `readStdin` (F0); `connectApi` (Task 1); `loadConfig` (F0/Task 5); `buildCatalog`, `searchModels` (Task 3); `buildDraft`, `loadDraft`, `saveDraft`, `discardDraft`, `draftPath`, `applyDraftStep`, `commitDraft`, `remainingSteps`, `suggestModels`, `suggestAliases`, `modelFamilies`, `onboardingSummary`, `draftEffectiveConfig` (Task 8); `renderOnboarding` (Task 9); `toExitCode` (F0).
- Produces (CLI; usados pelo `/opc:setup`):
  - `opc setup [--reconfigure] [--json]` → o relatório do F0 **mais** `onboarding` (campos da Task 8); em texto, uma seção "## Onboarding" no fim; `--stop-server`/flags de gate passam direto para o F0;
  - `opc setup models --provider <id> [--top N] [--query texto|glob] [--json]` → `{ kind:'models', provider, total, suggestions, aliases: {fast, strong}, families, query?, matches? }`;
  - `opc setup apply [--json] ('<JSON>' | --stdin)` → `{ kind:'apply', draftPath, applied, nextStep, remainingSteps, warnings, draft: {mode, scope, completed} }` (grava o rascunho só se a etapa valer);
  - `opc setup commit [--json]` → `{ kind:'commit', scope, path, config, effective, warnings }`; sem rascunho → exit 2 `NO_DRAFT`;
  - `opc setup discard [--json]` → `{ kind:'discard', discarded }`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/onboarding.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace, makeTempDir, testEnv, runCli, stopAllServers, writeGlobalConfig, readGlobalConfig,
} from '../helpers.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';

function setup(t, { config = null, env: extra = {} } = {}) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { extra }); // the tracked env object itself (a copy would escape the F0 cleanup)
  if (config) writeGlobalConfig(env, config);
  const cli = (args, opts = {}) => runCli(args, { env, cwd: ws, ...opts });
  const apply = (payload) => cli(['setup', 'apply', '--json', '--stdin'], { stdin: JSON.stringify(payload) });
  const draftFile = path.join(env.OPC_DATA_DIR, 'config.draft.json');
  return { ws, env, cli, apply, draftFile };
}
const all = (r) => `${r.stdout}${r.stderr}`;

test('setup --json reports the onboarding state on first run', async (t) => {
  const { cli } = setup(t);
  const r = await cli(['setup', '--json']);
  const s = JSON.parse(r.stdout).onboarding;
  assert.equal(s.needed, true);
  assert.equal(s.mode, 'bootstrap');
  assert.equal(s.configExists, false);
  assert.equal(s.opencodeInstalled, true);
  assert.equal(s.opencodeVersion, '1.18.32');
  assert.deepEqual(s.connectedProviders.map((p) => p.id), [MV, EQ, 'anthropic', 'opencode']);
  assert.deepEqual(s.providerChoices, [MV, EQ, 'anthropic']);
  assert.equal(s.needsOtherProvider, true);
  assert.equal(s.lockedKeysEditable, true);
  assert.equal(s.draft.exists, false);
  assert.equal(s.nextStep, 'defaultProvider');
  const text = await cli(['setup']);
  assert.match(text.stdout, /## Onboarding/);
});

test('setup --json without opencode on PATH: install offer data', async (t) => {
  const bin = makeTempDir();
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const { cli } = setup(t, { env: { PATH: bin } });
  const r = await cli(['setup', '--json']);
  const s = JSON.parse(r.stdout).onboarding;
  assert.equal(s.opencodeInstalled, false);
  assert.equal(s.npmAvailable, false);
  assert.deepEqual(s.connectedProviders, []);
});

test('setup models: top suggestions, aliases, families and search', async (t) => {
  const { cli } = setup(t);
  const r = await cli(['setup', 'models', '--provider', MV, '--top', '3', '--query', 'opencode-go/qwen*', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.total, 7);
  assert.deepEqual(v.suggestions.map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`, `${MV}/opencode-go/kimi-k3`]);
  assert.deepEqual(v.aliases, { fast: `${MV}/opencode-go/qwen3.8-flash`, strong: `${MV}/opencode-go/qwen3.8-max` });
  assert.equal(v.families[0].glob, `${MV}/opencode-go/*`);
  assert.deepEqual(v.matches.map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`]);
  assert.equal((await cli(['setup', 'models', '--provider', 'openai'])).code, 2);
  assert.equal((await cli(['setup', 'models'])).code, 2);
});

test('guided flow: apply every step, commit atomically, effective config shown', async (t) => {
  const { ws, env, cli, apply, draftFile } = setup(t);
  const steps = [
    [{ defaultProvider: MV }, 'defaultModel'],
    [{ defaultModel: 'opencode-go/kimi-k3' }, 'reviewModels'],
    [{ reviewModel: null, stopGate: { model: null } }, 'defaultVariant'],
    [{ defaultVariant: 'high' }, 'allowedModels'],
    [{ policy: { models: { allow: [`${MV}/*`] }, providers: { deny: [EQ] } } }, 'allowedAgents'],
    [{ policy: { agents: { allow: [], deny: ['work-*'] } } }, 'approver'],
    [{ policy: { approver: 'user' } }, 'behaviour'],
    [{ stopGate: { enabled: false }, delegation: { auto: false } }, 'project'],
    [{ project: { goal: "it's $(touch pwned) plugin", scope: ['plugins/'], taskTypes: ['review', 'ask'] } }, 'aliases'],
    [{ aliases: { fast: 'opencode-go/qwen3.8-flash', strong: 'opencode-go/qwen3.8-max' } }, null],
  ];
  for (const [payload, next] of steps) {
    const r = await apply(payload);
    assert.equal(r.code, 0, `${JSON.stringify(payload)}: ${all(r)}`);
    assert.equal(JSON.parse(r.stdout).nextStep, next);
  }
  assert.equal(fs.statSync(draftFile).mode & 0o777, 0o600);
  assert.equal(readGlobalConfig(env), null, 'nothing written before commit');
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 0, all(commit));
  const cfg = readGlobalConfig(env);
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.project.goal, "it's $(touch pwned) plugin");
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false, 'payload text is never executed');
  assert.deepEqual(cfg.policy.agents.deny, ['work-*']);
  assert.equal(cfg.aliases.strong, `${MV}/opencode-go/qwen3.8-max`);
  assert.equal(fs.existsSync(draftFile), false);
  const eff = JSON.parse((await cli(['config', 'show', '--effective', '--json'])).stdout);
  assert.equal(eff.config.defaultVariant, 'high');
});

test('setup commit refuses a denied default (exit 4); only the draft remains', async (t) => {
  const { env, cli, apply, draftFile } = setup(t);
  assert.equal((await apply({ defaultProvider: MV, defaultModel: `${EQ}/opencode-go/kimi-k3` })).code, 0);
  const pol = await apply({ policy: { providers: { deny: [EQ] } } });
  assert.equal(pol.code, 0);
  assert.equal(JSON.parse(pol.stdout).warnings[0].path, 'defaultModel');
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 4);
  assert.match(all(commit), /POLICY_DENIED/);
  assert.equal(readGlobalConfig(env), null);
  assert.ok(fs.existsSync(draftFile));
});

test('interruption leaves only the draft and setup resumes from the next step', async (t) => {
  const { env, cli, apply } = setup(t);
  await apply({ defaultProvider: MV });
  await apply({ defaultModel: 'opencode-go/kimi-k3' });
  assert.equal(readGlobalConfig(env), null);
  const s = JSON.parse((await cli(['setup', '--json'])).stdout).onboarding;
  assert.equal(s.draft.exists, true);
  assert.equal(s.nextStep, 'reviewModels');
  assert.equal(s.draft.values.defaultModel, `${MV}/opencode-go/kimi-k3`);
  const discard = await cli(['setup', 'discard', '--json']);
  assert.equal(JSON.parse(discard.stdout).discarded, true);
  assert.equal(JSON.parse((await cli(['setup', '--json'])).stdout).onboarding.draft.exists, false);
  assert.equal((await cli(['setup', 'commit'])).code, 2);
});

test('invalid payloads: bad JSON, unknown key, ambiguous and unknown models (exit 2)', async (t) => {
  const { cli, apply } = setup(t);
  assert.equal((await cli(['setup', 'apply', '--stdin'], { stdin: '{not json' })).code, 2);
  assert.equal((await apply({ nonsense: true })).code, 2);
  await apply({ defaultProvider: MV });
  const amb = await apply({ defaultModel: 'opencode/big-pickle' });
  assert.equal(amb.code, 2);
  assert.match(all(amb), /AMBIGUOUS_MODEL/);
  assert.equal((await apply({ defaultModel: 'opencode-go/nope' })).code, 2);
  assert.equal((await apply({ defaultVariant: 'ultra' })).code, 2);
});

test('after bootstrap: locked keys refused from Claude with the terminal command', async (t) => {
  const { cli, apply } = setup(t, { config: { defaultProvider: MV } });
  const s = JSON.parse((await cli(['setup', '--reconfigure', '--json'])).stdout).onboarding;
  assert.equal(s.mode, 'reconfigure');
  assert.equal(s.needed, true);
  assert.equal(s.lockedKeysEditable, false);
  assert.equal(s.nextStep, 'scope');
  const locked = await apply({ policy: { approver: 'claude' } });
  assert.equal(locked.code, 4);
  assert.match(all(locked), /LOCKED_KEY/);
  assert.match(all(locked), /opc config set policy\.approver 'claude' --tty-confirm/);
  const ok = await apply({ scope: 'global', stopGate: { enabled: true } });
  assert.equal(ok.code, 0, all(ok));
  assert.ok(!JSON.parse(ok.stdout).remainingSteps.includes('allowedModels'));
});

test('bootstrap race: a global config created before commit makes locked values fail', async (t) => {
  const { env, cli, apply } = setup(t);
  assert.equal((await apply({ policy: { approver: 'claude' } })).code, 0);
  assert.equal((await cli(['config', 'set', 'stopGate.enabled', 'false'])).code, 0);
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 4);
  assert.match(all(commit), /LOCKED_KEY/);
  assert.equal(readGlobalConfig(env).policy, undefined);
});

test('reconfigure with workspace scope writes .opc.json', async (t) => {
  const { ws, cli, apply } = setup(t, { config: { defaultProvider: MV } });
  assert.equal((await apply({ scope: 'workspace' })).code, 0);
  assert.equal((await apply({ defaultModel: 'opencode-go/qwen3.8-max' })).code, 0);
  const globalOnly = await apply({ delegation: { auto: true } });
  assert.equal(globalOnly.code, 2);
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 0, all(commit));
  assert.equal(JSON.parse(commit.stdout).scope, 'workspace');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.opc.json'), 'utf8')).defaultModel, `${MV}/opencode-go/qwen3.8-max`);
});
```

`tests/integration/no-config-first-run.test.mjs` (Review Focus 3 do mestre; a parte "`task` funciona com o default do OpenCode" é da F2a, que acrescenta o caso a este arquivo):

```js
// Master Review Focus 3: first use without config.json and without .opc.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, testEnv, runCli, stopAllServers, fixtureData } from '../helpers.mjs';

const STACK_TRACE = /\n\s+at .+\.m?js:\d+:\d+/;

test('no-config-first-run: discovery, config and setup work with OpenCode defaults', async (t) => {
  const ws = makeWorkspace(t);
  const env = testEnv(t); // servers stopped by the F0 per-test cleanup
  assert.equal(fs.existsSync(path.join(env.OPC_DATA_DIR, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(ws, '.opc.json')), false);
  const cases = [
    ['providers', '--json'],
    ['models', '--json'],
    ['models', '--allowed', '--json'],
    ['agents', '--json'],
    ['catalog', 'commands', '--json'],
    ['catalog', 'skills', '--json'],
    ['config', 'show', '--effective', '--json'],
    ['config', 'get', 'defaultModel', '--json'],
    ['config', 'validate', '--json'],
    ['config', 'path', '--json'],
    ['setup', '--json'],
  ];
  for (const args of cases) {
    const r = await runCli(args, { env, cwd: ws });
    assert.equal(r.code, 0, `${args.join(' ')} → ${r.code}\n${r.stdout}\n${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${args.join(' ')} prints JSON`);
    assert.doesNotMatch(r.stderr, STACK_TRACE, `${args.join(' ')} has no stack trace`);
  }
  const models = JSON.parse((await runCli(['models', '--allowed', '--json'], { env, cwd: ws })).stdout).models;
  assert.equal(models.length, 14, 'no policy yet: every connected model is allowed');
  const setup = JSON.parse((await runCli(['setup', '--json'], { env, cwd: ws })).stdout);
  assert.equal(setup.onboarding.needed, true);
  const opencodeDefault = fixtureData('config.json').model ?? null;
  const eff = JSON.parse((await runCli(['config', 'show', '--effective', '--json'], { env, cwd: ws })).stdout);
  assert.equal(eff.config.defaultModel, null, `opc has no default yet; the OpenCode default (${opencodeDefault}) applies at run time (F2a)`);
  const bad = await runCli(['config', 'set', 'defaultVariant', 'definitely-not-a-variant'], { env, cwd: ws });
  assert.ok([2, 4].includes(bad.code), 'clear error, not a crash');
  assert.doesNotMatch(bad.stderr, STACK_TRACE);
  assert.equal(fs.existsSync(path.join(env.OPC_DATA_DIR, 'config.json')), false, 'failed edits write nothing');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/onboarding.test.mjs tests/integration/no-config-first-run.test.mjs`
Expected: FAIL — `JSON.parse(...).onboarding` é `undefined`; `setup apply` cai no parse de flags do F0 (exit 2).

- [ ] **Step 3: Rename the F0 entry point**

Em `plugins/opc/scripts/commands/setup.mjs`, trocar exatamente `export async function run(ctx, argv)` por `async function runDiagnostics(ctx, argv)` (corpo intacto). Conferir: `grep -n "function runDiagnostics\|export async function run" plugins/opc/scripts/commands/setup.mjs` → só `runDiagnostics`. Conferir também que os nomes novos não existem no arquivo: `grep -n "SetupOnboarding\|SETUP_PASSTHROUGH_FLAGS" plugins/opc/scripts/commands/setup.mjs` → vazio.

- [ ] **Step 4: Append the onboarding block**

Acrescentar no fim de `plugins/opc/scripts/commands/setup.mjs` (dependências por `import()` dinâmico dentro de `SetupOnboarding.deps()`, para não colidir com os imports do F0):

```js

// ---- F1: onboarding (spec §3.3). Only two new top-level names (`run`, `SetupOnboarding`);
// dependencies are loaded with dynamic import so they never collide with F0's imports. ----
const SETUP_PASSTHROUGH_FLAGS = ['--stop-server', '--enable-review-gate', '--disable-review-gate'];

const SetupOnboarding = {
  async deps() {
    const mods = await Promise.all([
      import('node:child_process'), import('../lib/args.mjs'), import('../lib/opc-error.mjs'), import('../lib/context.mjs'),
      import('../lib/config.mjs'), import('../lib/models.mjs'), import('../lib/onboarding.mjs'), import('../lib/render.mjs'),
    ]);
    return Object.assign({}, ...mods);
  },

  existingOf(loaded) {
    return { global: loaded.global, workspace: loaded.workspace };
  },

  probeBinary(d, command, args, env) {
    const r = d.spawnSync(command, args, { env, encoding: 'utf8', shell: false, timeout: 15000 });
    if (r.error || r.status !== 0) return { installed: false, version: null };
    return { installed: true, version: String(r.stdout).trim().split('\n')[0] || null };
  },

  async discovery(d, ctx) {
    const { api } = await d.connectApi(ctx);
    const [providers, agents, opencodeConfig] = await Promise.all([api.providers(), api.agents(), api.getConfig()]);
    return { catalog: d.buildCatalog(providers), agents, opencodeConfig };
  },

  policyFor(d, ctx) {
    const loaded = d.loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const draft = d.loadDraft(ctx.dataDir);
    const policy = draft ? d.draftEffectiveConfig(draft, this.existingOf(loaded)).policy : loaded.config.policy;
    return { loaded, draft, policy };
  },

  emit(d, ctx, flags, view) {
    if (flags.json) ctx.json(view);
    else ctx.out(d.renderOnboarding(view));
    return 0;
  },

  async state(ctx, { reconfigure }) {
    const d = await this.deps();
    const opencode = this.probeBinary(d, 'opencode', ['--version'], ctx.env);
    const npmAvailable = this.probeBinary(d, 'npm', ['--version'], ctx.env).installed;
    const { loaded, draft, policy } = this.policyFor(d, ctx);
    let catalog = null;
    let serverError = null;
    if (opencode.installed) {
      try {
        const { api } = await d.connectApi(ctx);
        catalog = d.buildCatalog(await api.providers());
      } catch (err) {
        serverError = `${err.code ?? 'ERROR'}: ${err.message}`;
      }
    }
    const onboarding = d.onboardingSummary({ hasGlobal: loaded.hasGlobal, draft, catalog, policy, opencode, npmAvailable, reconfigure, workspaceRoot: ctx.workspaceRoot, serverError });
    return { onboarding, text: d.renderOnboarding({ kind: 'state', onboarding }) };
  },

  async models(ctx, argv) {
    const d = await this.deps();
    const { flags, positionals } = d.parseArgs(argv, {
      flags: { provider: { type: 'string' }, top: { type: 'number', default: 3 }, query: { type: 'string' }, json: { type: 'boolean' }, cwd: { type: 'string' } },
      allowPositionals: true,
    });
    if (!flags.provider || positionals.length) throw new d.UsageError('USAGE', 'usage: opc setup models --provider <id> [--top N] [--query text|glob] [--json]');
    if (!Number.isInteger(flags.top) || flags.top < 1 || flags.top > 50) throw new d.UsageError('USAGE', '--top must be an integer between 1 and 50');
    const { catalog } = await this.discovery(d, ctx);
    if (!catalog.connected.has(flags.provider)) throw new d.UsageError('UNKNOWN_PROVIDER', `provider "${flags.provider}" is not connected`);
    const { policy } = this.policyFor(d, ctx);
    const view = {
      kind: 'models',
      provider: flags.provider,
      total: catalog.models.filter((m) => m.providerID === flags.provider).length,
      suggestions: d.suggestModels(catalog, flags.provider, { top: flags.top, policy }),
      aliases: d.suggestAliases(catalog, flags.provider, policy),
      families: d.modelFamilies(catalog, flags.provider),
    };
    if (flags.query) {
      view.query = flags.query;
      view.matches = d.searchModels(catalog, flags.query, { providerID: flags.provider });
    }
    return this.emit(d, ctx, flags, view);
  },

  async apply(ctx, argv) {
    const d = await this.deps();
    const { flags, positionals } = d.parseArgs(argv, { flags: { json: { type: 'boolean' }, stdin: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
    const text = flags.stdin ? await d.readStdin(ctx.stdin) : positionals.join(' ');
    if (!text.trim()) throw new d.UsageError('USAGE', "usage: opc setup apply [--json] ('<partial config JSON>' | --stdin)");
    let partial;
    try { partial = JSON.parse(text); } catch (err) { throw new d.UsageError('INVALID_JSON', `payload is not valid JSON: ${err.message}`); }
    const loaded = d.loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const draft = d.loadDraft(ctx.dataDir) ?? d.buildDraft({ hasGlobal: loaded.hasGlobal });
    const allowLocked = draft.mode === 'bootstrap' && !loaded.hasGlobal;
    const { catalog, agents } = await this.discovery(d, ctx);
    const result = d.applyDraftStep(draft, partial, { catalog, agents, existing: this.existingOf(loaded), allowLocked });
    d.saveDraft(ctx.dataDir, result.draft);
    return this.emit(d, ctx, flags, {
      kind: 'apply',
      draftPath: d.draftPath(ctx.dataDir),
      applied: result.applied,
      nextStep: result.nextStep,
      remainingSteps: d.remainingSteps(result.draft, { allowLocked }),
      warnings: result.warnings,
      draft: { mode: result.draft.mode, scope: result.draft.scope, completed: result.draft.completed },
    });
  },

  async commit(ctx, argv) {
    const d = await this.deps();
    const { flags, positionals } = d.parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
    if (positionals.length) throw new d.UsageError('USAGE', 'usage: opc setup commit [--json]');
    const draft = d.loadDraft(ctx.dataDir);
    if (!draft) throw new d.UsageError('NO_DRAFT', 'no onboarding draft to commit; run /opc:setup first');
    const loaded = d.loadConfig({ dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot });
    const deps = await this.discovery(d, ctx);
    const result = d.commitDraft({
      dataDir: ctx.dataDir, workspaceRoot: ctx.workspaceRoot, draft, ...deps,
      existing: this.existingOf(loaded), allowLocked: draft.mode === 'bootstrap' && !loaded.hasGlobal,
    });
    return this.emit(d, ctx, flags, { kind: 'commit', ...result });
  },

  async discard(ctx, argv) {
    const d = await this.deps();
    const { flags } = d.parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: false });
    return this.emit(d, ctx, flags, { kind: 'discard', discarded: d.discardDraft(ctx.dataDir) });
  },
};

export async function run(ctx, argv) {
  const sub = argv[0];
  if (['models', 'apply', 'commit', 'discard'].includes(sub)) return SetupOnboarding[sub](ctx, argv.slice(1));
  const reconfigure = argv.includes('--reconfigure');
  const rest = argv.filter((a) => a !== '--reconfigure');
  if (rest.some((a) => SETUP_PASSTHROUGH_FLAGS.includes(a))) return runDiagnostics(ctx, rest);
  const { onboarding, text } = await SetupOnboarding.state(ctx, { reconfigure });
  let emitted = false;
  const wrapped = {
    ...ctx,
    json: (obj) => { emitted = true; ctx.json({ ...obj, onboarding }); },
    out: (chunk) => {
      ctx.out(emitted ? chunk : `${chunk}${text}`);
      emitted = true;
    },
  };
  try {
    return await runDiagnostics(wrapped, rest);
  } catch (err) {
    if (emitted || !rest.includes('--json')) throw err;
    const { toExitCode } = await import('../lib/opc-error.mjs');
    ctx.json({ error: { code: err.code ?? 'ERROR', message: err.message }, onboarding });
    return toExitCode(err);
  }
}
// ---- end F1 ----
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/integration/onboarding.test.mjs tests/integration/no-config-first-run.test.mjs && npm test`
Expected: PASS (10 + 1 testes); os testes de `setup` do F0 (diagnóstico e `--stop-server`) continuam verdes.

- [ ] **Step 6: Commit** (só com autorização do operador)

```bash
git add plugins/opc/scripts/commands/setup.mjs tests/integration/onboarding.test.mjs tests/integration/no-config-first-run.test.mjs
git commit -m "feat(setup): add guided onboarding subcommands (models, apply, commit, discard)"
```

---

### Task 14: Slash commands da F1

**Files:**
- Modify (reescrever): `plugins/opc/commands/setup.md`
- Create: `plugins/opc/commands/config.md`, `plugins/opc/commands/providers.md`, `plugins/opc/commands/models.md`, `plugins/opc/commands/agents.md`, `plugins/opc/commands/catalog.md`
- Test: `tests/unit/commands-md.test.mjs`

**Interfaces:**
- Consumes: os subcomandos das Tasks 10–13; o `bin/opc` do F0 (no PATH do Bash do Claude).
- Produces: frontmatter conforme spec §4/§8.4 — `allowed-tools` mínimos (`Bash(opc:*)`; `Bash(npm:*)` e `AskUserQuestion` só no `setup`); `disable-model-invocation: true` só no `config`; toda invocação com `$ARGUMENTS` via heredoc `<<'OPC_ARGS_5f1d0c7a_EOF'`; o payload do onboarding via `opc setup apply --json --stdin <<'OPC_JSON_5f1d0c7a_EOF'`; nenhum bloco bash com `--tty-confirm`, `--dangerously*`, `--no-verify` ou `$(`.

- [ ] **Step 1: Write the failing test**

`tests/unit/commands-md.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'opc', 'commands');
const F1 = {
  setup: { tools: ['Bash(opc:*)', 'Bash(npm:*)', 'AskUserQuestion'], disableModel: false },
  config: { tools: ['Bash(opc:*)'], disableModel: true },
  providers: { tools: ['Bash(opc:*)'], disableModel: false },
  models: { tools: ['Bash(opc:*)'], disableModel: false },
  agents: { tools: ['Bash(opc:*)'], disableModel: false },
  catalog: { tools: ['Bash(opc:*)'], disableModel: false },
};

function parse(name) {
  const text = fs.readFileSync(path.join(COMMANDS, `${name}.md`), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name}.md has frontmatter`);
  const front = Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')];
  }));
  const bashBlocks = [...match[2].matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  return { front, body: match[2], bashBlocks };
}

for (const [name, expected] of Object.entries(F1)) {
  test(`${name}.md: frontmatter and safe invocation`, () => {
    const { front, body, bashBlocks } = parse(name);
    assert.ok(front.description && front.description.length > 10);
    assert.ok(front['argument-hint']);
    const tools = front['allowed-tools'].split(',').map((s) => s.trim());
    assert.deepEqual(tools, expected.tools);
    assert.equal(front['disable-model-invocation'] === 'true', expected.disableModel);
    assert.match(body, /opc \S+ (--json )?--args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\$ARGUMENTS\nOPC_ARGS/);
    for (const block of bashBlocks) {
      assert.doesNotMatch(block, /--tty-confirm|--dangerously|--no-verify|\$\(/, `${name}.md bash block is safe`);
      if (block.includes('$ARGUMENTS')) assert.match(block, /<<'OPC_ARGS_5f1d0c7a_EOF'/, 'user arguments only through the quoted heredoc');
    }
  });
}

test('setup.md: install offer, heredoc payloads, commit', () => {
  const { body, bashBlocks } = parse('setup');
  assert.ok(bashBlocks.some((b) => b.trim() === 'npm install -g opencode-ai'));
  assert.ok(bashBlocks.some((b) => b.includes("opc setup apply --json --stdin <<'OPC_JSON_5f1d0c7a_EOF'")));
  assert.ok(bashBlocks.some((b) => b.includes('opc setup commit --json')));
  assert.ok(bashBlocks.some((b) => b.includes('--stop-server --force --confirmed-by-user')));
  for (const step of ['scope', 'defaultProvider', 'defaultModel', 'reviewModels', 'defaultVariant', 'allowedModels', 'allowedAgents', 'approver', 'behaviour', 'project', 'aliases']) {
    assert.match(body, new RegExp(`\\| \`${step}\` \\|`), `step ${step} documented`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/commands-md.test.mjs`
Expected: FAIL — `ENOENT … commands/config.md` (e o `setup.md` do F0 não tem o fluxo de onboarding).

- [ ] **Step 3: Write the command files**

`plugins/opc/commands/setup.md` (substitui o do F0; mantém o diagnóstico, a instalação guiada e o `--stop-server --force` com confirmação):

````markdown
---
description: Diagnostica o OpenCode, oferece a instalação e conduz o onboarding guiado do opc (provider, modelos, política, projeto)
argument-hint: '[--reconfigure] [--stop-server [--force]]'
allowed-tools: Bash(opc:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
opc setup --json --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Read the JSON. The diagnostic fields come from the server check; the `onboarding` object drives everything below. Follow the first branch that applies.

## A. Stop server (`--stop-server` in the arguments)

- Without `--force`: present the output. If it refuses because of active jobs, show the list and stop.
- With `--force`: before anything else, use `AskUserQuestion` once: "Encerrar o servidor do OpenCode mesmo com jobs ativos? Os jobs serão interrompidos." Options: `Encerrar agora`, `Cancelar`. Only on `Encerrar agora` run:

```bash
opc setup --stop-server --force --confirmed-by-user --json
```

## B. OpenCode not installed (`onboarding.opencodeInstalled` is false)

- If `onboarding.npmAvailable` is true, use `AskUserQuestion` exactly once: "O OpenCode não está instalado. Instalar agora com `npm install -g opencode-ai`?" Options, in this order: `Instalar o OpenCode (Recomendado)`, `Agora não`.
- On install, run the command below and then rerun the first command of this file:

```bash
npm install -g opencode-ai
```

- If the user skips or npm is not available, present the setup output, explain how to install OpenCode (<https://opencode.ai>) and stop.

## C. No connected provider (`onboarding.connectedProviders` is empty and `onboarding.serverError` is null)

Tell the user to run `!opencode auth login` and then `/opc:setup` again. Stop.

If `onboarding.serverError` is set, present it with the diagnostic output and stop.

## D. Nothing to do (`onboarding.needed` is false and `onboarding.draft.exists` is false)

Present the diagnostic output (including the terminal alias line), then run `opc config show --effective` and show a short summary: default provider, default model, review model, allowed models/agents. Mention `/opc:setup --reconfigure` to change it. Stop.

## E. Onboarding

1. If `onboarding.draft.exists` is true, use `AskUserQuestion`: "Existe um onboarding pela metade (próxima etapa: `<nextStep>`). Retomar?" Options: `Retomar (Recomendado)`, `Recomeçar do zero`. On `Recomeçar do zero`, run `opc setup discard --json` and then rerun the first command of this file.
2. Start at `onboarding.nextStep`. Ask **one** `AskUserQuestion` per step, build the JSON payload described below and apply it:

```bash
opc setup apply --json --stdin <<'OPC_JSON_5f1d0c7a_EOF'
{"defaultProvider":"<id>"}
OPC_JSON_5f1d0c7a_EOF```

   The result carries the next `nextStep`. Continue until `nextStep` is `null`. Text typed by the user goes **only** inside the heredoc, never on the command line.
3. Steps (`AskUserQuestion` always offers "Other" for free text; use it as the "Outro" option):

| Step | Question (PT-BR) | Options | Payload |
|---|---|---|---|
| `scope` | "Onde gravar a config?" | `Global — todas as pastas (Recomendado)`, `Só este workspace (.opc.json)` | `{"scope":"global"}` or `{"scope":"workspace"}` |
| `defaultProvider` | "Qual provider padrão?" | `onboarding.providerChoices` (label `<id> (<modelCount> modelos)`, from `connectedProviders`) | `{"defaultProvider":"<id>"}` |
| `defaultModel` | "Qual modelo padrão?" | the 3 `suggestions` of `opc setup models` (below); label = model ID, description = name + variants | `{"defaultModel":"<full id>"}` |
| `reviewModels` | "Modelo do review?" then "Modelo do stop gate?" (two separate calls) | `Mesmo do padrão (Recomendado)`, the `aliases.strong` suggestion, one more suggestion | `{"reviewModel":<id or null>,"stopGate":{"model":<id or null>}}` |
| `defaultVariant` | "Variant padrão?" | `Nenhuma (Recomendado)` + up to 3 variants of the chosen model (skip the question and send `null` when the model has none) | `{"defaultVariant":<name or null>}` |
| `allowedModels` | "Quais modelos o opc pode usar?" | `Todos do provider padrão (<provider>/*)`, `Só <families[0].glob>`, `Sem restrição` | `{"policy":{"models":{"allow":[...]}}}`; in "Other", comma-separated globs, and entries starting with `!` go to `deny` |
| `allowedAgents` | "Quais agentes do OpenCode o opc pode usar?" | `Todos`, `Só os built-in (build, plan, general, explore)` | `{"policy":{"agents":{"allow":[...]}}}`; "Other" as above (`!work-*` → `deny`) |
| `approver` | "Quem aprova os pedidos de permissão do OpenCode?" | `Eu aprovo (Recomendado)`, `O Claude aprova (destrutivos e caminhos sensíveis continuam comigo)` | `{"policy":{"approver":"user"}}` or `"claude"` |
| `behaviour` | "Ligar o stop gate (review antes de encerrar)?" then "Ligar a delegação automática?" | `Não (Recomendado)`, `Sim` | `{"stopGate":{"enabled":<bool>},"delegation":{"auto":<bool>}}` |
| `project` | "Objetivo do projeto?", then (multiSelect) "Quais diretórios fazem parte do escopo?", then (multiSelect) "Quais tipos de tarefa você vai delegar?" | goal: a one-line goal you infer from the README, `Sem objetivo`; scope: up to 3 of `onboarding.projectDirs` + `Todos`; task types: `ask`, `plan`, `review`, `task` | `{"project":{"goal":<text or null>,"scope":[...],"taskTypes":[...]}}` |
| `aliases` | (multiSelect) "Criar os aliases sugeridos?" | `fast → <aliases.fast>`, `strong → <aliases.strong>` (only the non-null ones) | `{"aliases":{"fast":"<id>","strong":"<id>"}}` (only the selected ones; `{}` when none) |

4. Model suggestions for `defaultModel` and `reviewModels`:

```bash
opc setup models --json --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--provider <defaultProvider> --top 3
OPC_ARGS_5f1d0c7a_EOF```

   When the user types a name or glob in "Other", search it and confirm the match with one more `AskUserQuestion` (up to 4 matches as options):

```bash
opc setup models --json --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--provider <defaultProvider> --query <typed text>
OPC_ARGS_5f1d0c7a_EOF```

5. Errors while applying: exit code 2 (invalid, unknown or ambiguous model, invalid variant) → show the message and ask the same step again. Exit code 4 with `POLICY_DENIED` → explain the rule and ask again. Exit code 4 with `LOCKED_KEY` (reconfigure) → show the terminal command from the message and move on to the next step.
6. When `nextStep` is `null`, commit:

```bash
opc setup commit --json
```

   On success run `opc config show --effective` and present a short summary. On exit code 2 or 4, show the message, re-apply the offending step (the message names the key) and commit again. If the user stops in the middle, only the draft remains; `/opc:setup` resumes it.

## Reconfigure and locked keys

With `--reconfigure`, the locked keys (`policy.*`, `permissionProfiles`, `server.configOverride`) are skipped. If the user wants to change them, tell them to run, in their own terminal (alias from the diagnostic output), `opc config init` or `opc config set <key> <value> --tty-confirm`. Never pass `--tty-confirm` yourself and never edit the config files by hand.

## Output rules

- Present the final setup output, including the terminal alias line.
- If OpenCode is installed but no provider is connected, preserve the guidance to run `!opencode auth login`.
````

`plugins/opc/commands/config.md`:

````markdown
---
description: Lê e altera a config do opc (get, set, unset, add, remove, show, validate, path)
argument-hint: 'get [chave] | set <chave> <valor> [--workspace] | unset <chave> | add|remove <chave-lista> <valor> | show [--effective] | validate | path'
allowed-tools: Bash(opc:*)
disable-model-invocation: true
---

Run:

```bash
opc config --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Output rules:
- Present the command output to the user verbatim.
- Exit code 4 with `LOCKED_KEY`: the key is a locked policy key (`policy.*`, `permissionProfiles`, `server.configOverride`). Explain that it can only be changed in the user's own terminal and show the exact command printed in the message (it ends with `--tty-confirm`), or `opc config init` for the full wizard. Never retry the command yourself and never add `--tty-confirm`.
- Exit code 4 with `POLICY_DENIED`: the value is denied by the current policy; show the rule from the message.
- Exit code 2 with `AMBIGUOUS_MODEL`: show both candidates from the message and ask which one the user wants; prefix the full ID with `=` (for example `=opencode/big-pickle`) to force the full reading.
- `init` needs an interactive terminal: tell the user to run `opc config init` in their terminal (the alias line is printed by `/opc:setup`).
- Never edit `config.json` or `.opc.json` by hand.
````

`plugins/opc/commands/providers.md`:

````markdown
---
description: Lista os providers do OpenCode com a política do opc aplicada (--all para o catálogo completo)
argument-hint: '[--all] [--json]'
allowed-tools: Bash(opc:*)
---

Run:

```bash
opc providers --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Output rules:
- Present the command output to the user verbatim (it is already Markdown).
- Do not add providers, keys or credentials that are not in the output.
- If the output says no provider is connected, tell the user to run `!opencode auth login` and then `/opc:providers` again.
- Exit code 5 means the OpenCode server is unavailable: suggest `/opc:setup`.
````

`plugins/opc/commands/models.md`:

````markdown
---
description: Lista os modelos do OpenCode (variants, limites, custo) com a política do opc aplicada
argument-hint: '[provider] [--verbose] [--allowed] [--all] [--json]'
allowed-tools: Bash(opc:*)
---

Run:

```bash
opc models --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Output rules:
- Present the command output to the user verbatim.
- Model IDs are `provider/model` and the model part may contain more slashes (for example `omniroute-mvalmeida/opencode-go/kimi-k3`); never shorten or rewrite them.
- A model marked `negado` is blocked by the opc policy: using it fails with exit code 4. Do not suggest it as an alternative.
- Exit code 2 with `UNKNOWN_PROVIDER`: show the message (it lists the known providers).
````

`plugins/opc/commands/agents.md`:

````markdown
---
description: Lista os agentes do OpenCode (primary/subagent), com modelos fixados e a política do opc aplicada
argument-hint: '[--mode primary|subagent|all] [--verbose] [--allowed] [--json]'
allowed-tools: Bash(opc:*)
---

Run:

```bash
opc agents --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Output rules:
- Present the command output to the user verbatim.
- An agent is `negado` when its name is denied or when the model it pins is denied; using it fails with exit code 4.
- Hidden agents (title, summary, compaction) only appear with `--verbose`.
````

`plugins/opc/commands/catalog.md`:

````markdown
---
description: Lista os commands ou as skills do OpenCode disponíveis neste workspace
argument-hint: 'commands|skills [--json]'
allowed-tools: Bash(opc:*)
---

Run:

```bash
opc catalog --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Output rules:
- Present the command output to the user verbatim.
- If no argument was given, the command fails with a usage error: ask the user whether they want `commands` or `skills`.
- A command marked `negado` pins a model or agent blocked by the policy; running it later (`/opc:command`) will be refused.
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/commands-md.test.mjs && npm test`
Expected: PASS (7 testes novos).

- [ ] **Step 5: Commit** (só com autorização do operador)

```bash
git add plugins/opc/commands tests/unit/commands-md.test.mjs
git commit -m "feat(commands): add F1 slash commands and guided /opc:setup onboarding"
```

---
### Task 15: Portão da F1

**Files:**
- Create: `tests/live/f1-discovery.mjs`, `tests/live/f1-fixture-coverage.mjs` (cobertura das fixtures; **não** é outro executor de contrato — o único é `tests/live/contract.mjs` da F0)
- Modify: `tests/fixtures/contract-shapes.mjs` (registro de probes da F0: entradas de `/provider`, `/command`, `/skill`)
- Create: `docs/configuration.md`, `docs/phases/F1-report.md`
- Modify (criar se não existir): `docs/commands.md` (seções de descoberta e config), `README.md` (início rápido), `CHANGELOG.md`

**Interfaces:**
- Consumes: tudo das Tasks 1–14; do F0: `tests/live/contract.mjs`, `scripts/scan-secrets.mjs`, `resolveDataDir`, `resolveWorkspaceRoot`, `workspaceStateDir`, `ensurePrivateDir`, `ensureServer`, `clientFor`, helpers `runCli`, `stopAllServers`, `REPO_ROOT`, `fixtureData` (Task 2).
- Produces: evidência do portão (mestre, "Portão de fase") e a documentação da fase (spec §12).

- [ ] **Step 1: Write the live tests**

`tests/live/f1-discovery.mjs` (modelo da fase: `kimi-k3`; cada teste usa `OPC_DATA_DIR` e workspace descartáveis e encerra o servidor no `after`; a config real do operador nunca é tocada):

```js
// F1 live checks (spec §13.3 F1 "Aceite (ao vivo)"). Run: OPC_LIVE=1 node --test tests/live/f1-discovery.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, stopAllServers, REPO_ROOT } from '../helpers.mjs';

const LIVE = process.env.OPC_LIVE === '1';
const MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-mvalmeida/opencode-go/kimi-k3';
const WORLD_PROVIDER = 'omniroute-work';
const WORLD = { policy: { providers: { allow: [], deny: [WORLD_PROVIDER] }, agents: { allow: [], deny: ['work-*'] } } };

function liveEnv(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f1-data-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f1-ws-'));
  fs.writeFileSync(path.join(ws, 'README.md'), '# live f1\n');
  const env = { ...process.env, OPC_DATA_DIR: dataDir };
  delete env.OPC_SERVER_URL;
  t.after(async () => {
    await stopAllServers(env, ws);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
  const cli = async (args, opts = {}) => runCli(args, { env, cwd: ws, timeoutMs: 180000, ...opts });
  const json = async (args) => {
    const r = await cli(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  return { env, ws, dataDir, cli, json };
}

function opencode(args, { cwd }) {
  const r = spawnSync('opencode', args, { cwd, encoding: 'utf8', timeout: 180000, shell: false });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('live: /opc:models --all matches `opencode models` per provider', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { ws, json } = liveEnv(t);
  const { providers } = await json(['providers', '--json']);
  assert.ok(providers.length > 0, 'at least one connected provider');
  let listing = opencode(['models'], { cwd: ws });
  assert.equal(listing.code, 0, listing.stderr);
  const theirsAll = new Set(listing.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[^\s/]+\/\S+$/.test(l)));
  for (const p of providers) {
    const perProvider = opencode(['models', p.id], { cwd: ws });
    const theirs = perProvider.code === 0
      ? perProvider.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${p.id}/`))
      : [...theirsAll].filter((l) => l.startsWith(`${p.id}/`));
    const ours = (await json(['models', p.id, '--all', '--json'])).models.map((m) => m.full);
    t.diagnostic(`${p.id}: opc=${ours.length} opencode=${theirs.length} (per-provider arg ${perProvider.code === 0 ? 'ok' : 'unsupported, used full list'})`);
    assert.deepEqual([...ours].sort(), [...new Set(theirs)].sort(), `models of ${p.id}`);
  }
});

test('live: /opc:agents matches `opencode agent list`', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { ws, json } = liveEnv(t);
  const listing = opencode(['agent', 'list'], { cwd: ws });
  assert.equal(listing.code, 0, listing.stderr);
  const ours = (await json(['agents', '--json'])).agents.map((a) => a.name);
  assert.ok(ours.length > 0);
  for (const name of ours) {
    assert.match(listing.stdout, new RegExp(`(^|\\W)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'm'), `agent ${name} in opencode agent list`);
  }
  t.diagnostic(`agents: ${ours.join(', ')}`);
});

test('live: world policy hides omniroute-work/* and work-* and refuses explicit use', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { dataDir, cli, json } = liveEnv(t);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(WORLD), { mode: 0o600 });
  const models = (await json(['models', '--allowed', '--json'])).models;
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m.providerID !== WORLD_PROVIDER));
  const agents = (await json(['agents', '--allowed', '--verbose', '--json'])).agents;
  assert.ok(agents.every((a) => !a.name.startsWith('work-')));
  const everyModel = (await json(['models', '--all', '--json'])).models;
  const eqModel = everyModel.find((m) => m.providerID === WORLD_PROVIDER && m.connected);
  if (eqModel) {
    const r = await cli(['config', 'set', 'defaultModel', eqModel.full]);
    assert.equal(r.code, 4, r.stderr);
  } else {
    t.diagnostic(`N/A: provider ${WORLD_PROVIDER} not connected on this machine`);
  }
  const eqAgent = (await json(['agents', '--verbose', '--json'])).agents.find((a) => a.name.startsWith('work-'));
  if (eqAgent) {
    const r = await cli(['config', 'set', 'defaultAgent', eqAgent.name]);
    assert.equal(r.code, 4, r.stderr);
  } else {
    t.diagnostic('N/A: no work-* agent configured in OpenCode on this machine');
  }
});

test('live: valid variant of the phase model is accepted; invalid one refused', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { cli, json } = liveEnv(t);
  const provider = MODEL.split('/')[0];
  const entry = (await json(['models', provider, '--verbose', '--json'])).models.find((m) => m.full === MODEL);
  assert.ok(entry, `${MODEL} is in the catalog`);
  assert.equal((await cli(['config', 'set', 'defaultModel', MODEL])).code, 0);
  if (!entry.variants.length) {
    t.skip(`N/A: ${MODEL} has no variants`);
    return;
  }
  const ok = await cli(['config', 'set', 'defaultVariant', entry.variants[0]]);
  assert.equal(ok.code, 0, ok.stderr);
  const bad = await cli(['config', 'set', 'defaultVariant', 'definitely-not-a-variant']);
  assert.equal(bad.code, 2);
  assert.match(bad.stdout + bad.stderr, /UNKNOWN_VARIANT/);
});

test('live: companion side of the guided onboarding writes the expected config', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { dataDir, cli, json } = liveEnv(t);
  const state = (await json(['setup', '--json'])).onboarding;
  assert.equal(state.mode, 'bootstrap');
  const provider = MODEL.split('/')[0];
  const apply = async (payload) => {
    const r = await cli(['setup', 'apply', '--json', '--stdin'], { stdin: JSON.stringify(payload) });
    assert.equal(r.code, 0, `${JSON.stringify(payload)}: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  await apply({ defaultProvider: provider });
  await apply({ defaultModel: MODEL });
  await apply({ reviewModel: null, stopGate: { model: null } });
  await apply({ defaultVariant: null });
  await apply({ policy: { models: { allow: [`${provider}/*`] }, providers: { deny: [WORLD_PROVIDER] } } });
  await apply({ policy: { agents: { allow: [], deny: ['work-*'] } } });
  await apply({ policy: { approver: 'user' } });
  await apply({ stopGate: { enabled: false }, delegation: { auto: false } });
  await apply({ project: { goal: 'opc live F1', scope: [], taskTypes: ['ask', 'review'] } });
  const last = await apply({ aliases: { k3: MODEL } });
  assert.equal(last.nextStep, null);
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 0, commit.stdout + commit.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.defaultModel, MODEL);
  assert.deepEqual(cfg.policy.providers.deny, [WORLD_PROVIDER]);
  assert.equal(cfg.aliases.k3, MODEL);
  assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
});

test('live: JSON output of providers/models never carries provider credentials', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { cli, dataDir } = liveEnv(t);
  const outputs = [];
  for (const args of [['providers', '--all', '--json'], ['models', '--all', '--verbose', '--json'], ['setup', '--json']]) {
    const r = await cli(args);
    assert.equal(r.code, 0, r.stderr);
    outputs.push(r.stdout);
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          assert.ok(!['key', 'apiKey', 'headers', 'options'].includes(k) || val === '***', `${args.join(' ')} exposes "${k}"`);
          walk(val);
        }
      }
    };
    walk(JSON.parse(r.stdout));
  }
  const file = path.join(dataDir, 'live-f1-outputs.json');
  fs.writeFileSync(file, outputs.join('\n'));
  const scan = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs'), file], { encoding: 'utf8' });
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
});
```

`tests/live/f1-fixture-coverage.mjs` (compara só **caminhos de chaves**, nunca valores):

```js
// F1 contract: shapes of GET /provider, /agent, /command, /skill on the real 1.18.x server vs the fake fixtures.
// Run: OPC_LIVE=1 node --test tests/live/f1-fixture-coverage.mjs   (prints key paths only, never values)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureData, stopAllServers } from '../helpers.mjs';
import { resolveDataDir, resolveWorkspaceRoot, workspaceStateDir, ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { loadConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { ensureServer, clientFor } from '../../plugins/opc/scripts/lib/server.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

const LIVE = process.env.OPC_LIVE === '1';
// Levels whose keys are IDs (collapsed to "<map>", values still compared) and free-form objects (not descended).
const MAP_PATHS = new Set(['$.all[].models', '$.default']);
const OPAQUE_PATHS = new Set(['$.all[].options', '$.all[].models.<map>.options', '$.all[].models.<map>.headers', '$.all[].models.<map>.variants', '$[].options']);

export function shapePaths(value, at = '$', out = new Set()) {
  if (OPAQUE_PATHS.has(at)) return out;
  if (Array.isArray(value)) {
    out.add(`${at}[]`);
    value.forEach((v) => shapePaths(v, `${at}[]`, out));
  } else if (value && typeof value === 'object') {
    if (MAP_PATHS.has(at)) {
      out.add(`${at}.<map>`);
      Object.values(value).forEach((v) => shapePaths(v, `${at}.<map>`, out));
    } else {
      for (const [k, v] of Object.entries(value)) {
        out.add(`${at}.${k}`);
        shapePaths(v, `${at}.${k}`, out);
      }
    }
  }
  return out;
}

test('live contract: fixtures cover every key path the real server returns', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f1c-data-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f1c-ws-'));
  const env = { ...process.env, OPC_DATA_DIR: dataDir };
  delete env.OPC_SERVER_URL;
  t.after(async () => {
    await stopAllServers(env, ws);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
  const workspaceRoot = resolveWorkspaceRoot(ws);
  const stateDir = workspaceStateDir(resolveDataDir(env), workspaceRoot);
  ensurePrivateDir(stateDir);
  const ctx = { stateDir, workspaceRoot, config: loadConfig({ dataDir, workspaceRoot }).config, env };
  const api = createApi(clientFor(ctx, await ensureServer(ctx)));
  const pairs = [
    ['provider.json', await api.providers()],
    ['agent.json', await api.agents()],
    ['command.json', await api.commands()],
    ['skill.json', await api.skills()],
  ];
  const divergences = [];
  for (const [file, real] of pairs) {
    const fake = shapePaths(fixtureData(file));
    const live = shapePaths(real);
    const missingInFake = [...live].filter((p) => !fake.has(p)).sort();
    const extraInFake = [...fake].filter((p) => !live.has(p)).sort();
    t.diagnostic(`${file}: missing in fake=${missingInFake.length} extra in fake=${extraInFake.length}`);
    missingInFake.forEach((p) => t.diagnostic(`  missing ${p}`));
    extraInFake.forEach((p) => t.diagnostic(`  extra   ${p} (optional field absent on this machine?)`));
    divergences.push(...missingInFake.map((p) => `${file} ${p}`));
  }
  assert.deepEqual(divergences, [], 'update tests/fixtures/data/*.json (and the report) for every key path the real server returns');
});
```

- [ ] **Step 1b: Register the F1 endpoints in the contract registry**

Em `tests/fixtures/contract-shapes.mjs` (F0), acrescentar ao **fim** do array `PROBES` (antes do `];`) as três entradas abaixo e, ao `Set` `MAP_PATHS`, os mapas cujas chaves são IDs ou dados livres (para o snapshot não expor nomes de provider/modelo nem chaves de opções). `used` só com campos sempre presentes; o resto em `optionalUsed` (checa só o tipo quando os dois lados têm o campo), porque a máquina real pode ter zero skills ou providers sem modelos:

```js
  { name: 'provider', method: 'GET', path: '/provider', used: ['all.[].id', 'all.[].name'], optionalUsed: ['connected', 'default', 'all.[].models', 'all.[].models.*.id', 'all.[].models.*.name', 'all.[].models.*.limit', 'all.[].models.*.variants', 'all.[].models.*.status', 'all.[].models.*.release_date'] },
  { name: 'command', method: 'GET', path: '/command', used: ['[].name'], optionalUsed: ['[].description', '[].source', '[].agent', '[].model', '[].subtask', '[].template', '[].hints'] },
  { name: 'skill', method: 'GET', path: '/skill', used: [], optionalUsed: ['[].name', '[].description', '[].location'] },
```

```js
  'provider.all[].models', 'provider.default', 'provider.all[].options', 'provider.all[].models.*.options',
  'provider.all[].models.*.headers', 'provider.all[].models.*.variants',
```

Run: `node --test tests/unit/contract-shapes.test.mjs && node --check tests/live/contract.mjs`
Expected: PASS (o executor `tests/live/contract.mjs` passa a comparar também essas três rotas no portão).

- [ ] **Step 2: Check the live guard**

Run: `node --check tests/live/f1-discovery.mjs && node --check tests/live/f1-fixture-coverage.mjs && node --test tests/live/f1-discovery.mjs tests/live/f1-fixture-coverage.mjs`
Expected: todos os testes `# SKIP OPC_LIVE!=1` (nenhum servidor real sobe sem `OPC_LIVE=1`).

- [ ] **Step 3: Full suite**

Run: `bash -o pipefail -c 'npm test 2>&1 | tee /tmp/opc-f1-npm-test.txt'; echo "exit=$?"`
Expected: 100% verde (F0 + F1). Anexar a saída ao relatório.

- [ ] **Step 4: Live checklist (modelo real)**

Pré-condições: `opencode --version` ≥ 1.18.0; providers conectados (`opencode auth list`); nada do operador precisa parar (o `opencode serve` do plugin sobe numa porta própria, em diretório temporário).

```bash
OPC_LIVE=1 OPC_LIVE_MODEL=omniroute-mvalmeida/opencode-go/kimi-k3 node --test tests/live/f1-discovery.mjs 2>&1 | tee /tmp/opc-f1-live.txt
OPC_LIVE=1 node --test tests/live/f1-fixture-coverage.mjs 2>&1 | tee /tmp/opc-f1-contract.txt
OPC_LIVE=1 node tests/live/contract.mjs 2>&1 | tee /tmp/opc-f0-contract.txt
```

Expected: `f1-discovery` verde (itens `N/A` aparecem como `# diagnostic N/A: …`); `f1-fixture-coverage` sem "missing" — se houver, acrescentar os campos faltantes às fixtures de `tests/fixtures/data/`, rodar `npm test` de novo e registrar a divergência no relatório. Itens instáveis: 3 execuções, passa com ≥ 2. Antes de anexar, conferir que as saídas não têm segredos: `node scripts/scan-secrets.mjs /tmp/opc-f1-live.txt /tmp/opc-f1-contract.txt`.

- [ ] **Step 5: Manual checks (operador)**

Registrar cada item no relatório como `PASSOU` / `NÃO VALIDADO` com a evidência:

1. **Onboarding guiado nesta sessão do Claude** (bootstrap sem tocar na config real): abrir o Claude com `OPC_DATA_DIR=$(mktemp -d) claude` na pasta do repo, rodar `/opc:setup`, responder todas as etapas (provider `omniroute-mvalmeida`, modelo `opencode-go/kimi-k3`, allow `omniroute-mvalmeida/*`, agentes com `!work-*` no "Other", aprovador "Eu aprovo") e conferir no fim o `opc config show --effective` exibido. Interromper uma segunda rodada no meio e rodar `/opc:setup` de novo: deve oferecer "Retomar".
2. **`opc config init`** (validação manual do usuário, spec §13.3): no terminal, `OPC_DATA_DIR=$(mktemp -d) node plugins/opc/scripts/opc-companion.mjs config init`; percorrer as listas numeradas, usar o filtro por texto e uma seleção por intervalo (`1-2`).
3. **Config de mundo real do operador** (se a config global real já tiver o perfil de mundo): `opc models --allowed --json` sem nenhum `omniroute-work/*`; `opc agents --allowed --json` sem `work-*`; `opc config set defaultModel omniroute-work/opencode-go/kimi-k3` → exit 4. Sem perfil de mundo na config real → `N/A` (coberto pelo teste ao vivo com a config simulada).

- [ ] **Step 6: Write the documentation (spec §12)**

Todas as saídas de exemplo vêm de execuções reais (com `OPC_DATA_DIR` temporário), com caminhos pessoais trocados por `~`/`<workspace>` e sem nenhum valor de chave.

`docs/configuration.md` — estrutura:

1. **Onde fica cada coisa** — `opc config path` (exemplo executado); config global em `<dataDir>/config.json` (600), `.opc.json` no workspace (versionável, sem segredos), rascunho `config.draft.json`; alias de terminal impresso pelo `/opc:setup`.
2. **Todas as chaves** — a tabela abaixo (gerada do `CONFIG_SCHEMA`/`DEFAULT_CONFIG`), seguida do exemplo completo do §3.2 da spec.
3. **IDs de modelo** — ID completo `provider/modelo` (o modelo pode ter barras); nome curto completado com `defaultProvider`; ambiguidade (`opencode/big-pickle` × `omniroute-mvalmeida/opencode/big-pickle`) e o prefixo `=`; aliases (1 nível; mapa de alias → ID completo; referências por nome em `reviewModel`, `routing.*`, `conclave.*`, `orchestrate.*`); globs (`*` casa `/`). Exemplos executados: `opc config set defaultModel opencode-go/kimi-k3`, o erro `AMBIGUOUS_MODEL` e `opc config set defaultModel =opencode/big-pickle`.
4. **Merge restritivo do `.opc.json`** — o que vale (preferências de D4; `deny` une; `allow` intersecta via `allowWorkspace`; `sensitivePaths`/`destructiveBash` unem) e o que é ignorado com aviso; exemplo executado de `opc config show --effective` com um `.opc.json` que tenta ampliar o allow.
5. **Chaves travadas** — `policy.*`, `permissionProfiles`, `server.configOverride`; bootstrap (só o onboarding antes de existir config global); depois só `opc config init` ou `opc config set … --tty-confirm` num TTY; qualquer `opc config set` de chave comum cria a config global e **encerra o bootstrap**; limitação: edição manual do arquivo não é impedida.
6. **Onboarding — as três portas** — `/opc:setup` (etapas, rascunho, retomar/recomeçar, `--reconfigure`), `opc config init` (listas numeradas, filtro, `1,3,5-7`, `todos`), `opc config …` não interativo.
7. **Perfil de mundo (exemplo do operador)** — `providers.deny: ["omniroute-work"]`, `models.allow: ["omniroute-mvalmeida/opencode-go/*", "anthropic/*"]`, `agents.deny: ["work-*"]`; efeito em `/opc:models --allowed` e `/opc:agents --allowed` (exemplos executados).
8. **`opc config validate`** — o que checa (forma, modelos, variants, aliases quebrados, agente padrão, pool, política, chaves com cara de segredo) e os exit codes (D11). Exemplo executado com um alias quebrado.

Tabela de chaves (colar como está na seção 2):

| Chave | Tipo | Padrão | Escopo | Descrição |
|---|---|---|---|---|
| `defaultProvider` | string \| null | `null` | global + workspace | Provider usado para completar nomes curtos de modelo |
| `defaultModel` | model \| null | `null` | global + workspace | Modelo padrão (ID completo normalizado) |
| `defaultVariant` | string \| null | `null` | global + workspace | Variant padrão (validada contra as variants do modelo padrão) |
| `defaultAgent` | string \| null | `null` | global + workspace | Agente de sessão padrão (modo primary ou all) |
| `aliases` | model-map | `{}` | global + workspace | Apelidos → ID completo (1 nível) |
| `reviewModel` | modelref \| null | `null` | global + workspace | Modelo do review (alias ou ID) |
| `stopGate.enabled` | boolean | `false` | só global | Liga o stop gate (F2b) |
| `stopGate.model` | modelref \| null | `null` | global + workspace | Modelo do stop gate (alias ou ID) |
| `project.goal` | string \| null | `null` | global + workspace | Objetivo do projeto (vai no <project_context>) |
| `project.scope` | string-list | `[]` | global + workspace | Diretórios do escopo |
| `project.taskTypes` | enum-list (ask|plan|review|task|orchestrate|conclave) | `[]` | global + workspace | Tipos de tarefa delegados |
| `policy.providers.allow` | string-list | `[]` | travada (workspace só restringe) | Providers permitidos (vazio = todos) |
| `policy.providers.deny` | string-list | `[]` | travada (workspace só restringe) | Providers negados |
| `policy.providers.allowWorkspace` | string-list | `(interno)` | travada, só global | Interno: allow do .opc.json (interseção) |
| `policy.models.allow` | string-list | `[]` | travada (workspace só restringe) | Modelos permitidos (globs; vazio = todos) |
| `policy.models.deny` | string-list | `[]` | travada (workspace só restringe) | Modelos negados (globs) |
| `policy.models.allowWorkspace` | string-list | `(interno)` | travada, só global | Interno: allow do .opc.json (interseção) |
| `policy.agents.allow` | string-list | `[]` | travada (workspace só restringe) | Agentes permitidos (globs; vazio = todos) |
| `policy.agents.deny` | string-list | `[]` | travada (workspace só restringe) | Agentes negados (globs) |
| `policy.agents.allowWorkspace` | string-list | `(interno)` | travada, só global | Interno: allow do .opc.json (interseção) |
| `policy.tools.deny` | string-list | `[]` | travada (workspace só restringe) | Ferramentas negadas (nomes, inclusive MCP) |
| `policy.sensitivePaths` | string-list | `["*.env","*.env.*","**/.ssh/**","*.pe…` | travada (workspace só restringe) | Caminhos nunca lidos pelo OpenCode (F2a) |
| `policy.destructiveBash` | string-list | `[]` | travada (workspace só restringe) | Padrões destrutivos adicionais (F2a) |
| `policy.approver` | enum (user|claude) | `"user"` | travada, só global | Quem aprova permissões: user | claude |
| `policy.permissionTimeoutSec` | integer 1–86400 | `600` | travada, só global | Prazo de resposta a um pedido de permissão |
| `permissionProfiles` | rules-map | `{}` | travada, só global | Perfis custom:<nome> (regras extras) |
| `routing.tasks` | modelref-list-map | `{}` | global + workspace | Listas de modelos por tipo de tarefa |
| `routing.tiers` | modelref-list-map | `{}` | global + workspace | Listas de modelos por tier (light/heavy) |
| `routing.fallback.enabled` | boolean | `true` | global + workspace | Liga o fallback entre candidatos (F4a) |
| `routing.fallback.maxAttempts` | integer 1–10 | `3` | global + workspace | Máximo de candidatos tentados |
| `routing.fallback.maxProviderRetries` | integer 0–20 | `3` | global + workspace | Teto de retries do OpenCode antes de abortar |
| `routing.fallback.maxRetryWaitSec` | integer 0–3600 | `60` | global + workspace | Espera máxima anunciada por retry |
| `conclave.pools` | modelref-list-map | `{}` | global + workspace | Pools nomeados de modelos |
| `conclave.defaultPool` | string \| null | `null` | global + workspace | Pool padrão |
| `conclave.judge` | modelref-or-claude | `"claude"` | global + workspace | claude ou modelo juiz |
| `conclave.rounds` | integer 1–3 | `1` | global + workspace | Rodadas (1–3) |
| `conclave.quorum` | integer 2–16 | `2` | global + workspace | Respostas válidas mínimas |
| `conclave.memberTimeoutSec` | integer 1–86400 | `900` | global + workspace | Prazo por membro |
| `orchestrate.planner` | modelref \| null | `null` | global + workspace | Modelo que decompõe a tarefa |
| `orchestrate.maxSubtasks` | integer 2–20 | `5` | global + workspace | Máximo de subtarefas |
| `orchestrate.synthesizer` | modelref-or-claude | `"claude"` | global + workspace | claude ou modelo sintetizador |
| `delegation.auto` | boolean | `false` | só global | Lembrete de delegação no SessionStart (F4a) |
| `jobs.maxActive` | integer 1–64 | `8` | só global | Jobs ativos por workspace |
| `jobs.maxParallel` | integer 1–32 | `4` | só global | Turnos simultâneos por grupo |
| `server.bootTimeoutSec` | integer 1–600 | `60` | só global | Prazo de boot do opencode serve |
| `server.requestTimeoutSec` | integer 1–600 | `30` | só global | Timeout padrão de request |
| `server.configOverride` | object | `{"share":"disabled"}` | travada, só global | OPENCODE_CONFIG_CONTENT do servidor do plugin |

`docs/commands.md` — uma seção por comando, cada uma com sinopse, flags, exit codes (§4.1) e **exemplos executados** (texto e `--json` resumido):

- `/opc:setup` — diagnóstico (F0), instalação guiada, onboarding, `--reconfigure`; subcomandos de apoio `opc setup models|apply|commit|discard` (para quem usa o terminal).
- `/opc:config` — `get`, `set`, `unset`, `add`, `remove`, `show [--effective]`, `validate`, `path`; `--workspace`; `--tty-confirm` (terminal); `init` (terminal).
- `/opc:providers` — `--all`; coluna de política.
- `/opc:models` — `[provider] --verbose --allowed --all`.
- `/opc:agents` — `--mode primary|subagent|all --verbose --allowed`; modelos fixados.
- `/opc:catalog` — `commands` | `skills`.

Exemplos a executar e colar (num workspace descartável com `OPC_DATA_DIR` temporário):

```bash
opc setup --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).onboarding,null,2)))"
opc providers
opc models omniroute-mvalmeida --verbose
opc models --allowed
opc agents --verbose
opc catalog commands
opc catalog skills
opc config set defaultProvider omniroute-mvalmeida
opc config set defaultModel opencode-go/kimi-k3
opc config set defaultVariant high
opc config set policy.approver claude            # exit 4 LOCKED_KEY (sem TTY)
opc config validate
opc config show --effective
```

`README.md` — seção **Início rápido** (curta; as demais seções do README vêm do F0):

1. Requisitos: Node ≥ 20, OpenCode ≥ 1.18 (o `/opc:setup` oferece `npm install -g opencode-ai`), um provider conectado (`opencode auth login`).
2. `/opc:setup` → responder o onboarding (provider, modelo padrão, modelos/agentes permitidos, aprovador, projeto, aliases).
3. `/opc:models --allowed` e `/opc:agents` para ver o que o opc pode usar.
4. Ajustes: `/opc:config set …`; mudanças de política só no terminal (`opc config init`).
5. Próximo passo: o primeiro review chega com a F2b (`/opc:review`).

Depois de escrever: `node scripts/scan-secrets.mjs docs/ README.md` → sem achados.

- [ ] **Step 7: Write the phase report**

`docs/phases/F1-report.md` (preencher cada `Status` com `PASSOU`, `N/A (motivo)` ou `NÃO VALIDADO (motivo)`; nunca `PASSOU` sem ter executado):

````markdown
# Relatório da fase F1 — Descoberta, configuração e onboarding

- **Data:** DD/MM/AAAA
- **Branch / PR:** `feat/opc-f1` / #N
- **Ambiente:** Node vX.Y.Z · OpenCode 1.18.x (`opencode --version`) · Linux (kernel) · modelo ao vivo `omniroute-mvalmeida/opencode-go/kimi-k3`

## Portão

| Item | Status | Evidência |
|---|---|---|
| `npm test` 100% verde | | saída anexa (resumo: tests / pass / fail) |
| Checklist ao vivo (`tests/live/f1-discovery.mjs`) | | saída redigida anexa |
| Contrato (`tests/live/contract.mjs` + `tests/live/f1-fixture-coverage.mjs`) | | divergências e fixtures atualizadas |
| Documentação (`configuration`, `commands`, README) com exemplos executados | | `scan-secrets` sem achados |
| CHANGELOG | | |

## Aceite de integração (spec §13.3 F1)

| Critério | Teste | Status |
|---|---|---|
| Listagens a partir de fixtures, sem chave de provider no JSON | `discovery.test.mjs` (providers, models) | |
| `--allowed` esconde e o uso bloqueia (exit 4) | `discovery.test.mjs` (allowed) + `config-cli.test.mjs` (policy blocks) | |
| Merge restritivo | `config-f1.test.mjs` (mergeConfig) + `config-cli.test.mjs` (restrictive merge) | |
| Aliases, nome curto e ambiguidade | `models.test.mjs` + `config-cli.test.mjs` (model ids, aliases) | |
| `config validate` (modelo inexistente, variant inválida, alias quebrado, chave com cara de segredo) | `config-cli.test.mjs` (validate) | |
| `setup commit` recusa default negado | `onboarding.test.mjs` (commit refuses) | |
| Interrupção do onboarding deixa só o rascunho | `onboarding.test.mjs` (interruption) | |
| Chave travada recusada sem TTY | `config-cli.test.mjs` (locked keys) + `onboarding.test.mjs` (after bootstrap) | |
| TTY com entrada roteirizada | `tty.test.mjs`, `onboarding-wizard.test.mjs`, `config-tty.test.mjs` | |
| `pinned-denied-model` → recusa | `discovery.test.mjs` (scenario) + `config-cli.test.mjs` (pinned) | |
| `/opc:catalog` lista commands e skills | `discovery.test.mjs` (catalog) | |
| Primeiro uso sem config (Review Focus 3 do mestre) | `no-config-first-run.test.mjs` | |

## Aceite ao vivo

| Critério | Status | Evidência |
|---|---|---|
| `/opc:models --all` bate com `opencode models` por provider | | |
| `/opc:agents` bate com `opencode agent list` | | |
| Onboarding guiado completo nesta sessão grava a config esperada | | `config show --effective` redigido |
| `opc config init` (validação manual do usuário) | | |
| Mundo: `omniroute-work/*` e `work-*` fora do `--allowed`; uso explícito recusado | | |
| Variant válida do `kimi-k3` aceita; inválida recusada | | |
| Nenhuma credencial no JSON (`scan-secrets`) | | |

## Desvios

- Premissas do F0 (P1–P10) que não valeram e a cola ajustada: …
- Representação do allow do workspace (`allowWorkspace`) e testes do F0 ajustados: …
- Outros: …

## Itens A CONFIRMAR levantados na F1

1. `opencode models <provider>` aceita o argumento de provider? (o teste ao vivo cai para a lista completa se não aceitar) — resposta: …
2. Formato de `opencode agent list` e se ele lista agentes ocultos — resposta: …
3. Campos reais de `/provider`, `/agent`, `/command`, `/skill` ausentes nas fixtures (saída do `f1-fixture-coverage`) — resposta: …

## Git e gravação dupla

- Commits (Conventional Commits, sem atribuição): …
- PR: … (merge após aviso ao operador)
- `.ai-data/<categoria>-<DDMMYY>.md`: … · colmeia `myprojects`: N fatos
````

- [ ] **Step 8: Update the CHANGELOG**

Acrescentar em `CHANGELOG.md`, na seção `## [Unreleased]` (Keep a Changelog):

```markdown
### Adicionado (F1 — descoberta, configuração e onboarding)
- `/opc:providers`, `/opc:models`, `/opc:agents` e `/opc:catalog`, com a política do opc aplicada (`--allowed`, `--all`, `--verbose`, `--mode`).
- `/opc:config` (`get`, `set`, `unset`, `add`, `remove`, `show --effective`, `validate`, `path`) e o assistente de terminal `opc config init`.
- Onboarding guiado no `/opc:setup` (instalação do OpenCode, provider, modelos, política, projeto, aliases) com rascunho retomável e commit atômico validado contra o servidor.
- Esquema completo da config, merge restritivo do `.opc.json`, chaves travadas (`policy.*`, `permissionProfiles`, `server.configOverride`) e aviso de chaves com cara de segredo.
- Normalização de IDs de modelo (nome curto, ambiguidade, prefixo `=`), aliases, validação de variants e checagem de modelos fixados por agentes e commands.
```

- [ ] **Step 9: Notify, git and double record**

1. Avisar o operador com o resumo do relatório (status por item, desvios, A CONFIRMAR).
2. Com autorização explícita: `git add docs/ README.md CHANGELOG.md tests/live/f1-discovery.mjs tests/live/f1-fixture-coverage.mjs tests/fixtures/contract-shapes.mjs tests/fixtures/data` → `git commit -m "docs: add F1 configuration, commands and phase report"` (reler a mensagem: sem trailers) → `git push -u origin feat/opc-f1` → PR com o relatório no corpo. Merge só depois de avisar o operador.
3. Gravação dupla (kernel do operador, §3.3): fatos relevantes da fase em `.ai-data/decisions-<DDMMYY>.md` (não versionado) **e** na colmeia `myprojects` (`mnemosyne_remember`, um fato por registro, prefixo `[DD/MM/AAAA]`, sem segredos) — por exemplo: a decisão D1 (prefixo `=`), D2 (`allowWorkspace`), as respostas dos A CONFIRMAR da F1. Informar a contagem por banco.

---

## Interfaces novas

Acréscimos ao contrato congelado do mestre (nenhuma assinatura existente muda). O mestre deve ser atualizado com esta lista e o operador avisado.

**`lib/context.mjs`**
- `connectApi(ctx)` → `Promise<{ api, server, client }>` (usa `ensureServer` + `clientFor` + `createApi`; `client` é o mesmo cliente da `api`). A F2a troca o `serverCtx` literal por `serverContext(ctx)` sem mudar o retorno.

**`lib/models.mjs`**
- `normalizeModelId(input, { catalog, defaultProvider, aliases, fullOnly = false })` — opção `fullOnly` e prefixo `=` na entrada; o retorno ganha `entry`.
- `buildCatalog(...)` — além de `connected`, `models`, `byFull`: `providers: [{ id, name, source, connected, modelCount, defaultModel }]` e `defaults`; cada modelo ganha `family, status, releaseDate, reasoning, toolcall, connected`.
- `resolveModelRef(value, { catalog, defaultProvider, aliases, allowClaude })` → `{ kind, value, full? }`.
- `validateVariant(entry, variant)` → `variant|null` (UsageError `UNKNOWN_VARIANT`).
- `searchModels(catalog, query, { providerID, connectedOnly, limit })` → `ModelEntry[]`.

**`lib/policy.mjs`**
- `pinnedModelOf(agentInfo)`, `evaluateAgent(agentInfo, policy)`, `evaluateCommand(commandInfo, policy, agentsByName)`, `assertAgentUsable(agentInfo, policy)`, `assertCommandUsable(commandInfo, policy, agentsByName)`. O modelo fixado passa pela política de **provider** (`evaluate('provider', providerID)`) antes da de `model`; provider negado → agente/command negado.
- `evaluate` considera `policy.<tipo>.allowWorkspace` (D2).

**`lib/config.mjs`**
- `CONFIG_SCHEMA`, `schemaFor`, `isLockedKey`, `isWorkspaceKey`, `keyNeedsServer`, `findSecretLikeKeys`, `unsetPath`, `coerceValue`, `isListKey`, `applyConfigEdit`, `normalizeEditValue`, `modelRefsIn`, `validateAgainstServer`, `policyViolations`, `configPaths`.
- Formato de erros/avisos de `validateConfigShape` e `mergeConfig`: `{ path, code, message }`.
- Config efetiva: `policy.{providers,models,agents}.allowWorkspace` (interno).

**`lib/onboarding.mjs`** (nomes congelados com assinatura fixada: `buildDraft({ hasGlobal, now })`, `applyDraftStep(draft, partial, { catalog, agents, existing, allowLocked, now })`, `commitDraft({ dataDir, workspaceRoot, draft, catalog, agents, opencodeConfig, existing, allowLocked })`, `loadDraft(dataDir)`)
- `DRAFT_SCHEMA_VERSION`, `ONBOARDING_STEPS`, `draftPath`, `saveDraft`, `discardDraft`, `nextStep`, `remainingSteps`, `lockedCommand`, `candidateConfig`, `draftEffectiveConfig`, `rankProviders`, `suggestModels`, `suggestAliases`, `modelFamilies`, `projectDirs`, `onboardingSummary`, `runInitWizard`.

**`lib/tty.mjs`** (nome congelado: `createPrompter({ input, output })` → `{ select, multiSelect, text, confirm, close }`)
- `parseSelection(text, count)`; opções `select(question, choices, { defaultIndex, allowOther })`, `multiSelect(question, choices, { min })`, `text(question, { defaultValue, required, validate })`, `confirm(question, { defaultValue })`.

**`lib/render.mjs`**
- `renderOnboarding(view)` (além dos cinco previstos: `renderProviders`, `renderModels`, `renderAgents`, `renderCatalog`, `renderConfig`).

**CLI**
- `opc setup models|apply|commit|discard` (subcomandos de apoio ao onboarding) e `opc setup apply --stdin`.
- `opc config get --global|--workspace`; `opc config init`.
- Chaves JSON de views de config usam `setting` (nunca `key`).

**Testes**
- `tests/fixtures/fake-opencode.mjs`: `loadFixtureData(name, { dataDir, scenario })`, `F1_DATA_ROUTES`; campo opcional `data` nos módulos de cenário.
- `tests/helpers.mjs`: `scriptedTTY`, `pipedStdin`, `captureStream`, `fixtureData`, `writeGlobalConfig`, `readGlobalConfig`, `writeWorkspaceConfig`, `runInProcess`.

---

## Autorrevisão (cobertura da spec)

| Spec | Onde |
|---|---|
| §3.2 esquema completo, valores neutros | Task 5 (`DEFAULT_CONFIG`, `CONFIG_SCHEMA`) |
| §3.2 `.opc.json` só restringe (deny união, allow interseção, travadas ignoradas, escalares com política) | Task 5 (`mergeConfig`), Task 11 (edições `--workspace`), D2–D4 |
| §3.2 aviso de chaves com cara de segredo | Task 5 (`findSecretLikeKeys`), Task 11 (`validate`) |
| §3.2 IDs completos, nome curto, ambiguidade, globs com `/` | Task 3, Task 11 |
| §3.3 chaves travadas, bootstrap, TTY, `--tty-confirm`, `--reconfigure` imprime o comando | Tasks 6, 8, 11, 12, 13 |
| §3.3 porta 1 (`/opc:setup`: instalação, etapas 1–10, rascunho, commit, retomada) | Tasks 8, 13, 14 |
| §3.3 porta 2 (`opc config init`, listas numeradas, filtro, intervalos, recusa sem TTY) | Tasks 7, 12 |
| §3.3 porta 3 (`get/set/unset/add/remove/show/validate/path`) | Task 11 |
| §4 comandos da F1, flags, `disable-model-invocation`, heredoc | Tasks 10–14 |
| §6.2–6.3 parse, aliases (1 nível), validação de modelo/variant/agente | Tasks 3, 6 |
| §6.4 modelos fixados por agente/command | Task 4, Task 10 (cenário), Task 11 |
| §6.5 política em todo modelo usado pela config | Task 6 (`policyViolations`), Tasks 8, 11 |
| §3.1 redação de todo JSON | Tasks 9–13 (views sem `key`, `redact` nos objetos de config), testes de segredo |
| §13.3 aceite de integração e ao vivo da F1 | Tasks 10–13 e 15 (tabela do relatório) |
| Review Focus 3 do mestre | Task 13 (`no-config-first-run`) |
