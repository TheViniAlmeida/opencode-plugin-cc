# opc F3 — Sessões, subagentes, commands e attach · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar os comandos `/opc:sessions`, `/opc:session` (new/show/fork/revert/unrevert/summarize/children/diff/todo), `/opc:subagent` (job-grupo com N membros concorrentes), `/opc:command` e `/opc:attach` (inclusive `--pane` no tmux sem expor a senha), fechando com o portão ao vivo nos três modelos.

**Architecture:** Os comandos novos são arquivos em `scripts/commands/` que usam `lib/api.mjs` (operações F3 novas), `lib/context.mjs` (conexão + descoberta + política num lugar só) e `lib/render.mjs`. O `subagent` cria um job-grupo e **um** worker coordenador (`task-worker` delega por `kind`) que roda os membros como turnos concorrentes (até `jobs.maxParallel`) com um único `EventHub`; cada membro é uma sessão filha (`POST /session {parentID, agent}` + `prompt_async`) com fallback para a parte `subtask`, tudo atrás de `dispatchSubagent(...)` em `lib/runner.mjs`. O `command` roda como job `cmd` num worker, para manter a ponte de permissões. O `attach --pane` lê a senha, dentro do pane, de `<stateDir>/attach.secret` (modo 600), escrito pelo `ensureServer`.

**Tech Stack:** Node.js ≥ 20 (ESM `.mjs`, `fetch` nativo, `node:test`), zero dependências, OpenCode 1.18.32 (API v1), tmux ≥ 3.0 (só para `--pane`).

**Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3) — §4 (linhas F3 e regras transversais), §6 (resolução e modelos fixados), §8.2 (pedidos de sessões filhas), §9.1 (grupos), §10.5 (attach `--pane`), §13.3 F3, §15 itens 7 e 12.
**Plano mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` — estrutura, contrato congelado, convenções de teste, regras de git e portão. Este plano assume que F0–F2b entregaram exatamente o contrato do mestre.

---

## Global Constraints

- Node ≥ 20 (`engines: {"node": ">=20"}`); zero dependências de runtime e de dev (nada de `npm install`).
- Código, identificadores, mensagens de commit e nomes de arquivo em inglês. Docs e textos voltados ao usuário em PT-BR.
- OpenCode mínimo `1.18.0`; alvo testado `1.18.32`; só a API v1 (`/session/*`, `/event`, `/command`, `/instance/dispose`), nunca `/api/*`.
- Servidor sempre em `127.0.0.1`, porta escolhida pelo plugin, autenticado com `OPENCODE_SERVER_PASSWORD` (usuário `opencode`).
- A senha do servidor e as chaves de provider **nunca** aparecem em stdout, stderr, logs, docs, fixtures commitadas **ou argv de qualquer processo** (inclusive `tmux` e o `opencode attach` do pane).
- Diretórios de estado com modo 700 e arquivos com modo 600 (o script do pane é 700: precisa ser executável só pelo dono).
- `always` nunca é enviado em `permission reply`.
- Nenhum sinal para processo cuja identidade (cmdline + start time) não confira.
- Exit codes da spec §4.1: `0, 2, 3, 4, 5, 6, 7, 130`.
- Títulos de sessão com o prefixo `OPC: `.
- `revert`/`unrevert` só executam com `--confirmed-by-user`; sem ele, exit 2 com o diff afetado e a instrução.
- `/opc:attach` com `disable-model-invocation: true`; `Bash(tmux:*)` só nesse comando.
- Política aplicada a **todo** modelo e agente usados, inclusive os fixados por agente ou por command do OpenCode, **antes** de criar sessão (spec §6.4, §6.7).
- Testes ao vivo só com `OPC_LIVE=1`, nunca no CI, em diretório descartável; modelos `omniroute-mvalmeida/opencode-go/{deepseek-v4.1-flash,qwen3.8-max,kimi-k3}`.
- Nada de exclusão de sessão, `share` ou `--auto-approve` (spec D15).

## Review Focus

Entradas e condições que a spec implica e que mais provavelmente quebram o uso real. Cada
linha tem teste na tarefa dona, indicada entre colchetes.

1. **IDs malformados ou maliciosos** (`ses_x/../../global/dispose`, `msg$(id)`, vazio, prefixo
   errado): exit 2 **sem** subir servidor e sem nenhuma requisição. [Task 5, teste
   `rejects malformed ids without contacting the server`; Task 6, teste `revert rejects a
   message id with path characters`]
2. **Prompt de subagente com aspas, crases, `$()`, quebra de linha e unicode** chega idêntico
   a **cada** membro e nunca é expandido. [Task 9, teste `prompt reaches every member intact`]
3. **Revert com sessão em uso** (lock de job ativo) ou com mensagem que não pertence à sessão:
   recusa com exit 2 e **nenhum** `POST /revert`. [Task 6, testes `refuses when the session
   lock is held` e `unknown message is refused before any revert`]
4. **Workspace com espaços e acentos no attach**: a linha impressa e o comando do pane levam o
   caminho intacto e a senha nunca entra em argv. [Task 12, teste `pane: tmux argv has no
   password and the pane script receives intact args`]
5. **Grupo com membro que falha rápido, membro cancelado e membro esperando permissão**:
   agregação correta, grupo nunca preso em `running`, e cancelar um membro não derruba o
   coordenador nem os outros membros. [Task 9, testes `one failing member leaves the group
   completed with warnings` e `member permission request: exit 3, reply, completes`; Task 10,
   teste `cancelling one member aborts only its session`]

---

## Pontos de encaixe com F0–F2b (verificar na Task 0)

O contrato do mestre congela **assinaturas**, não o código interno. As premissas abaixo foram
conferidas contra o texto dos planos F0–F2b (e o DECISIONS da reconciliação) e o código F3 já
está escrito para a forma real. A Task 0 só reconfirma no repositório; nada de F0–F2b é
renomeado — as únicas mudanças em código de fases anteriores são as da Task 7 (E12) e da Task 12
(`attach.secret`), registradas no relatório.

| # | Premissa | Onde | Situação |
|---|---|---|---|
| E1 | `new UsageError(code, message, { details })`, `new PolicyError(code, message)`, `new OpcError(code, message, { exitCode })` (uso `UsageError('TOO_MANY_JOBS')` do mestre) | `lib/opc-error.mjs` | Confirmada (todas as subclasses são code-first; `opts.exitCode` sobrescreve) |
| E2 | `ctx.out(text)` e `ctx.err(text)` escrevem o texto **sem** acrescentar `\n`; `ctx.json(obj)` escreve JSON + `\n`, redigido | `lib/context.mjs` | Confirmada (F0 `createContext`: `out`/`err` = `write(redactText(text))`, `json` = `JSON.stringify(redact(obj), null, 2) + '\n'`); os renders F3 terminam em `\n` |
| E3 | `parseArgs` com `type: 'list'` devolve array (repetição ou vírgula); F3 normaliza com `splitList` de qualquer forma | `lib/args.mjs` | Confirmada (listas começam `[]` e acumulam) |
| E4 | `createJob(stateDir, fields, { maxActive = 8 })` aceita campos arbitrários (inclusive `groupId`, `role`, `memberIds`, `request`, `pid`) e gera `id` (pelo `kind`), `createdAt`, `logFile` | `lib/jobs.mjs` | Ajustada: o `createJob` da F2a **sempre** grava `status`/`phase` `'queued'` (ignora `fields.status`); por isso `addGroupMember` (Task 7) aplica um `status` diferente com `updateJob` logo após criar, e os testes F3 não dependem do `status` passado a `createJob` |
| E5 | `cancelJob(ctx, id)` tolera `sessionID` nulo (pula o abort) e, com pid cuja identidade não confere, só marca `cancelled` | `lib/jobs.mjs` | Confirmada (F2a: abort só com `client && job.sessionID`; identidade que não confere → `report.worker = 'identity-mismatch'`, sem sinal); job não ativo → `UsageError('NOT_ACTIVE')` |
| E6 | `waitForJob` devolve o job ao ficar terminal **ou** `waiting_permission` com `pendingRequest?.length` | `lib/jobs.mjs` | Ajustada: a F2a exige a **lista** não vazia; `refreshGroup` monta o `pendingRequest` do grupo como lista (Task 7), então o grupo em espera devolve |
| E7 | `runTurn({ api, hub, request, onProgress, onPermission, onQuestion, onRequestResolved, signal })` registra a sessão no `hub` (`hub.track`) antes do `prompt_async`, chama `onPermission(req)`/`onQuestion(req)` com o objeto `properties` do evento e `onRequestResolved({ type, requestID, sessionID, outcome })` nos `*.replied`/`question.rejected` de sessões acompanhadas; `onProgress` recebe objetos `{ phase?, message?, sessionID?, childSessionID? }` | `lib/runner.mjs` | Ajustada: `dispatchSubagent` repassa `onRequestResolved` (Task 8) e o coordenador lê `p?.phase` (aceitar string é só tolerância) |
| E8 | `task-worker` lê o job em `const stored = readJob(ctx.stateDir, jobId); if (!stored?.request) throw …; const request = stored.request;` e só depois atualiza o job | `scripts/commands/task-worker.mjs` | Confirmada: a delegação da Task 9 entra logo após o `throw` e antes de `const request`, usando `stored` |
| E9 | Fake: cenário `routes` aceita chaves `'METHOD /path/:param'` e `handler(fake, { method, path, query, body, params, req, res }) → { status?, body?, headers? } \| 'handled' \| undefined` (`undefined` cai na rota padrão); `fake.state.sessions` e `fake.state.messages` são objetos por `sessionID` (mensagens `{info, parts}`); existem `fake.emit(event)` e `fake.persist()` (F0) e `fake.emitTurn(sessionID, opts)`, `fake.abortSession(id)` (F2a); toda requisição é registrada em `state.requests` (`{ method, path, query, body, at }`) antes do roteamento; `POST /session/:id/abort` interrompe um `emitTurn` com `delayMs` | `tests/fixtures/fake-opencode.mjs` | Confirmada; os handlers F3 sempre devolvem objeto (substituem a rota base) |
| E10 | `readFakeState(env)` lê o `stateFile` do fake subido pelo `opencode` falso; `testEnv` repassa `extra` ao ambiente do servidor falso | `tests/helpers.mjs` | Confirmada |
| E11 | O cliente HTTP acrescenta `?directory=<workspaceRoot>` a toda requisição e aceita `{ query, timeoutMs }` | `lib/http.mjs` | Confirmada (contrato F0) |
| E12 | A F2a poda em `createJob` (`pruneTerminal`), conta todos os ativos para `maxActive`, e `workerLost` (privado) trata membros como jobs de topo | `lib/jobs.mjs` | Ajustada na Task 7 com trechos concretos: poda por `selectJobsToPrune`; `maxActive` conta `countsTowardLimit` e não se aplica a `fields.groupId`; `workerLost` é `false` para membros; grupo perdido (varredura do `createJob` e `reconcileJob`) derruba os membros ativos; `resolveJobRef` sem `ref` usa `topLevelJobs` |

---

## Interfaces novas (acréscimos ao contrato; nada renomeado)

```js
// lib/args.mjs (F3)
export function shellQuote(value)                    // aspas simples POSIX; strings seguras ficam sem aspas

// lib/api.mjs (F3) — além de fork/revert/unrevert/summarize/runCommand/dispose do mestre
export function assertId(prefix, value, label = prefix) // 'ses'|'msg'|'prt'; inválido → UsageError('INVALID_ID')
// diff(id, { messageID } = {})                      // parâmetro opcional novo (query messageID)
// summarize(id, { providerID, modelID, timeoutMs }) e runCommand(id, { ..., messageID, timeoutMs }) aceitam timeoutMs
// runCommand: model deve ser string "provider/model"; arguments padrão ''

// lib/context.mjs (F3)
export async function openApi(ctx, { withHub = false, respawn = true } = {}) // → { server, client, api, hub|null, close() }
  // respawn: true → connectApi(ctx) (F1); respawn: false (workers/coordenadores) → ensureServer(serverContext(ctx))
  // + createClient(...) SEM onServerDown (nunca sobe outro servidor no meio do turno, F2a D9)
export async function loadDiscovery(api)                       // → { catalog, opencodeConfig, agents }
export function resolveModel(ctx, discovery, kind, modelInput, { variant = null } = {})
  // = resolveCandidates + validateSelection (F2a); → { providerID, modelID, full, source, variant }
export function requireAgent(discovery, name, policy, { modes = null } = {})     // existe? + modo + assertAgentUsable (F1); → agent
export function profileRules(ctx, profile, extra = [])         // buildPermissionRules(...) + extra no fim

// lib/render.mjs (F3) — renderSessions e renderSession eram nomes congelados sem assinatura
export function renderSessions(sessions, { statusMap = {}, title = 'Sessões OPC', hiddenCount = 0 } = {})
export function renderSession(session, { status = null, messages = [], note = null } = {})
export function renderSessionDiff(diffs, { maxInlineBytes = 409600, title = 'Diff da sessão' } = {})
export function renderTodos(todos, { sessionID = null } = {})
export function renderRevertPreview({ action, sessionID, messageID = null, affected = [], rawDiff = null, command })
export function renderPendingLines(job)              // → string[]; itera a lista job.pendingRequest (usa memberId, se houver)
// (job em waiting_permission: renderPermissionRequest(job) da F2a — sem renderizador próprio)
export function renderGroupStatus(group, members)
export function renderGroupResult(group, members)
export function renderCommandResult(result)
export function renderAttach(info)

// lib/jobs.mjs (F3)
export const GROUP_ROLE                              // 'group'
export function isGroupMember(job)                   // job.groupId != null
export function topLevelJobs(jobs)                   // sem membros de grupo
export function countsTowardLimit(job)               // ativo e não membro (grupo conta como 1 no maxActive)
export function selectJobsToPrune(jobs, keep = 50)   // ids a podar; grupo conta como 1 e leva os membros junto
export async function addGroupMember(stateDir, groupId, fields) // → member; acrescenta a group.memberIds;
  // kind = fields.kind ?? group.kind; role padrão 'member:<n>'; fields.status ≠ 'queued' aplicado após criar
export async function createGroup(stateDir, groupFields, memberFieldsList, { maxActive = 8 } = {})
  // → { group, members }; group.role = GROUP_ROLE, group.memberIds; membros via addGroupMember; só o grupo passa pelo maxActive
export function listGroupMembers(stateDir, groupId)  // → jobs na ordem de memberIds
export function aggregateGroup(members)              // → { status, counts, total, done, phase, warnings };
  // status = todos queued ? 'queued' : groupStatus(members) (F2a)
export async function refreshGroup(stateDir, groupId, { final = false } = {}) // → group atualizado;
  // pendingRequest do grupo = lista dos pedidos dos membros em espera, cada um com memberId
export async function cancelGroup(ctx, groupId)      // → { group, cancelledMembers: string[] }
export async function runWithConcurrency(items, limit, fn) // → [{status:'fulfilled',value}|{status:'rejected',reason}]
// Sem ponte e sem mapa de exit codes próprios: createRequestBridge/createSerialUpdater (F2a, commands/task-worker.mjs)
// e exitCodeForJob(job) (F2a, commands/task.mjs).
// Ajustes E12 no F2a (Task 7): createJob conta countsTowardLimit e pula maxActive para fields.groupId; workerLost é
// false para membros; grupo perdido (varredura do createJob e reconcileJob) derruba os membros ativos.
// Campo novo de job: memberIds (grupo); pendingRequest é lista (F2a). Membros herdam pid/pidStartTime do coordenador
// (informativo; a vida do membro segue o grupo).
// Kinds: 'sub' (grupo e membros; papéis 'group' e 'member:<n>'), 'cmd' (id 'cmd-…'; KIND_PREFIX/JOB_ID_RE da F2a).

// lib/runner.mjs (F3)
export const SUBAGENT_MECHANISMS                     // ['child-session', 'subtask']
export function isAgentModeRefusal(errOrResult)      // erro/resultado que indica "agente subagent não pode ser agente de sessão"
export function extractTaskOutput(messages)          // saída da última tool 'task' concluída
export async function dispatchSubagent({ api, hub, parentSessionID, member, prompt, rules, mechanism = 'child-session',
  allowFallback = true, timeoutMs, fallbackCfg, onSession, onProgress, onPermission, onQuestion, onRequestResolved,
  signal, runTurnImpl = runTurn })
  // member: { agent, model: {providerID, modelID}, variant?, title } → { ...resultado do runTurn, mechanism, fellBack, carrierSessionID? }
  // onRequestResolved é repassado ao runTurn (liberação da ponte da F2a: (e) => bridge.onResolved(e))

// lib/server.mjs (F3)
export const ATTACH_SECRET_FILE                      // 'attach.secret'
export function attachSecretPath(stateDir)
export function writeAttachSecret(stateDir, password) // modo 600, sem '\n' final; ensureServer chama no spawn
export function removeAttachSecret(stateDir)          // stopServerUnlocked (F2b) chama ao encerrar
```

- `scripts/commands/task-worker.mjs`: `export const WORKER_DELEGATES` (`{ sub: './subagent.mjs', cmd: './command.mjs' }`; tabela única de despacho — a F4b acrescenta `orch`, a F4c `conclave`); cada módulo delegado exporta `runWorker(ctx, job)`. A delegação entra no `run` logo após `if (!stored?.request) throw …` (Task 9 Step 5).
- `subagent` e `command`: texto livre por `--raw-args-stdin` (`readRawArgs` da F2a; `'raw-args-stdin'` no SPEC); `assertNotInsideServer(ctx.env)` antes de conectar (exit 4); registro de topo sob `withServerLock` (F2b) com `{ maxActive: ctx.config?.jobs?.maxActive ?? 8 }`; exit code por `exitCodeForJob` (F2a). `sessions`/`session`/`attach` seguem `--args-stdin`.
- `scripts/commands/{sessions,session,subagent,command,attach}.mjs`: `run(ctx, argv)` + helpers exportados para teste (`isOpcSession`, `collectAffectedDiff`, `withSessionGuard`, `pairAgentsAndModels`, `MAX_SUBAGENTS`, `textFromParts`, `PANE_SCRIPT`, `PANE_SCRIPT_NAME`, `buildAttachArgs`, `resolveExecutable`).
- `scripts/commands/{status,result,cancel}.mjs`: helpers `statusForGroup`, `resultForGroupOrCommand`, `cancelForGroup`.
- `tests/helpers.mjs`: `startExternalFake`, `eventually` (acréscimos); reaproveita `writeGlobalConfig` (F1), `stateDirFor` (F2a), `fakeRequests` (F2b), `waitFor` (F0).
- `tests/fixtures/f3-fake.mjs`: fixtures e rotas F3 (usadas só pelos cenários F3 via `withF3`).
- Variáveis de ambiente de teste: `FAKE_GROUP_DELAY_MS`, `FAKE_FAIL_MODEL`, `FAKE_GROUP_ASK`, `FAKE_COMMAND_DELAY_MS`, `FAKE_COMMAND_ERROR`, `FAKE_HUGE_DIFF`, `FAKE_TMUX_LOG`, `FAKE_TMUX_FAIL`; e `OPC_ATTACH_OPENCODE_BIN` (troca o binário que o pane executa; documentado como gancho de teste).

## Ambiguidades resolvidas neste plano

1. **Grupo sempre existe**, mesmo com N = 1 (renderização e cancelamento uniformes). Membros **não** contam no `jobs.maxActive` (o grupo conta como 1), **nunca** são barrados por ele (`createJob` pula a checagem para `fields.groupId`; senão, com 7 ativos, o grupo entraria e o 1º membro falharia) e são podados junto com o grupo. Membros podem ser criados de uma vez (`createGroup`) ou sob demanda (`addGroupMember`, usado pela F4b). Máximo de 8 membros por grupo no `subagent`.
2. **Pareamento agente × modelo:** listas de mesmo tamanho pareiam por índice; 1 agente × N modelos ou N agentes × 1 (ou 0) modelo expandem; tamanhos diferentes > 1 → exit 2. `--agent` é obrigatório (como na spec). Modos aceitos: `subagent` e `all` (agente `primary` → exit 2, sugerindo `/opc:task --agent`).
3. **Agregação do grupo:** regra única do `groupStatus` da F2a — algum membro em `waiting_permission` → grupo `waiting_permission`; algum ativo → `running`; todos `cancelled` → `cancelled`; senão, algum `completed` → `completed` (com avisos se houve falha/cancelamento); senão `failed`. Único acréscimo da F3: todos os membros `queued` → `queued`. `cancelled` do grupo é "pegajoso". O `pendingRequest` do grupo é a lista dos pedidos dos membros em espera, cada um com `memberId`.
4. **Vida dos membros e cancelar membro sem matar o coordenador:** a vida do membro segue a do grupo — `workerLost` (F2a) devolve `false` para membros, e a reconciliação que marca o grupo `worker_lost` (varredura do `createJob` e `reconcileJob`) marca também os membros ativos. Os membros ainda herdam `pid`/`pidStartTime` do coordenador, só como informação (inofensivo): o `workerMatcher(memberId)` nunca casa com o cmdline do coordenador (`--job-id <groupId>`), então `cancelJob(membro)` vê `identity-mismatch`, não sinaliza nada, só aborta a sessão do membro e marca `cancelled`.
5. **`--write` no subagente roda em série** (`maxParallel = 1`), como as subtarefas de escrita da orquestração (§10.3).
6. **Mecanismo `subtask`:** cada membro usa uma sessão "portadora" filha da sessão-pai (uma sessão só processa um prompt por vez); as regras do perfil ganham, no fim, `{task, <agente>, allow}` (o agente já passou pela política). Se as regras da sessão valem para a neta criada pelo OpenCode é A CONFIRMAR (§15.7, probe ao vivo); na dúvida, a ponte da F2a (`profileKind: 'read-only'`) rejeita qualquer pedido na hora.
7. **Detecção de recusa do modo:** `BadRequest` (ou turno `failed`) cujo texto cita "agent" e "subagent|primary|mode". Só essa recusa aciona o fallback; outros erros falham o membro.
8. **`POST /session` usa `model: {id, providerID}`** (OpenAPI 1.18.32), diferente do `prompt_async` (`{providerID, modelID}`).
9. **Diff afetado pelo revert:** união, por arquivo, de `GET /session/:id/diff?messageID=<m>` para cada mensagem de usuário a partir da mensagem alvo (e da mensagem de usuário dona do alvo, se o alvo for do assistente), até 50 mensagens. **Unrevert:** mostra `session.revert.diff`. Sem revert ativo → exit 2 `NOT_REVERTED`.
10. **Revert/unrevert/summarize seguram o `session-<id>.lock`** (sem espera) e recusam sessão ocupada (`/session/status` ≠ idle).
11. **`summarize` é síncrono** (não é job), com timeout longo (`--timeout`, padrão 600 s); modelo por `resolveModel(kind 'summarize')`.
12. **`command` roda como job `cmd` num worker** (mantém a ponte de permissões e perguntas da F2a, exit 3/6 iguais ao `task`), numa sessão nova por execução, perfil `read-only` por padrão e `--write` opcional. Como a rota `/command` é síncrona e não passa pelo `runTurn`, o worker acompanha a sessão no `EventHub` e chama ele mesmo `bridge.onPermission`/`onQuestion` (`*.asked`) e `bridge.onResolved` (`*.replied`/`question.rejected`). Política: `assertCommandUsable(cmd, policy, agentsByName)` (F1: modelo fixado com provider, agente fixado e o modelo fixado dele) + `requireAgent` para o agente efetivo. Modelo sempre enviado em string: `--model` > modelo fixado no command > rota `task`. Agente: `--agent` > agente fixado no command > `defaultAgent` > omitido.
13. **`attach.secret`:** escrito pelo `ensureServer` a cada spawn e reescrito (idempotente) pelo `attach`; apagado no `stopServerUnlocked` (corpo do encerramento desde a F2b, chamado por `stopServer` com ou sem `lockHeld`). Em modo attach (`OPC_SERVER_URL`), o opc não guarda a senha: a linha impressa usa `"$OPC_SERVER_PASSWORD"` e `--pane` é recusado (exit 2).
14. **`sessions`:** por padrão, sessões com título `OPC: `, raiz (sem `parentID`) e do diretório do workspace; `--all` mostra tudo. `--refresh` chama `api.dispose()` (`POST /instance/dispose`) para reler o storage, recusado com jobs ativos ou em modo attach.
15. **Seleção do command ao vivo:** nenhum command é criado. Escolhe-se, em `/opc:catalog commands`, o primeiro por nome com `source` `command`, sem `subtask` e sem nome de ação arriscada (`init|commit|push|deploy|release|delete|remove|clean|reset|migrate`); roda em read-only e o checksum do workspace tem de ficar igual. Sem candidato → `NÃO VALIDADO`.
16. **§15.12 (storage concorrente):** parte automatizada (um `opencode run` concorrente a um job do opc, varrendo `server.log` por `SQLITE_BUSY`/`database is locked`) + checagem manual do operador com a TUI.

---

## Estrutura de arquivos desta fase

```
plugins/opc/
  commands/sessions.md  session.md  subagent.md  command.md  attach.md        (novos)
  skills/opc-result-handling/SKILL.md                                         (seção F3 acrescentada)
  scripts/commands/sessions.mjs  session.mjs  subagent.mjs  command.mjs  attach.mjs  (novos)
  scripts/commands/task-worker.mjs  status.mjs  result.mjs  cancel.mjs       (delegação e grupos)
  scripts/lib/api.mjs  args.mjs  context.mjs  jobs.mjs  render.mjs  runner.mjs  server.mjs (acréscimos)
tests/
  helpers.mjs                                                                 (acréscimos)
  fixtures/f3-fake.mjs  fixtures/attach-probe.mjs  fixtures/bin/tmux          (novos)
  fixtures/scenarios/f3-sessions.mjs  children.mjs  group-slow.mjs  subagent-mode-refused.mjs  command-sync.mjs
  unit/fake-f3  api-f3  render-f3  context-f3  jobs-groups  runner-subagent  subagent-pairing  session-guard  commands-f3-frontmatter  (.test.mjs)
  integration/sessions  session-actions  session-revert  subagent  groups  command  attach  (.test.mjs)
  live/_f3-lib.mjs  f3-sessions.mjs  f3-subagents.mjs  f3-command.mjs  f3-probe-subagent-mode.mjs  f3-concurrent-storage.mjs  f3-session-shapes.mjs
docs/commands.md  troubleshooting.md  architecture.md  phases/F3-report.md  README.md  CHANGELOG.md
```

---

### Task 0: Pontos de encaixe e branch

**Files:** nenhum arquivo de código (só leitura e git).

**Interfaces:**
- Consumes: o repositório com F0–F2b mergeados na `main`.
- Produces: branch `feat/opc-f3`; a tabela "Pontos de encaixe" conferida (resultado anotado para o relatório).

- [ ] **Step 1: Confirmar autorização de git**

Regras de git do mestre: commit, push e PR só com autorização explícita do operador **nesta
sessão**. Se ainda não houver, pergunte antes de criar a branch e antes do primeiro commit.

- [ ] **Step 2: Criar a branch**

```bash
git switch main
git switch -c feat/opc-f3
```

- [ ] **Step 3: Conferir as premissas E1–E12**

```bash
grep -n "class UsageError\|class PolicyError\|constructor(code" plugins/opc/scripts/lib/opc-error.mjs
grep -n "out(\|err(\|json(" plugins/opc/scripts/lib/context.mjs
grep -n "export async function createJob\|export async function cancelJob\|function workerLost\|function pruneTerminal\|export async function reconcileJob\|export function groupStatus\|export async function withServerLock\|export function assertNotInsideServer\|maxActive" plugins/opc/scripts/lib/jobs.mjs
grep -n "onPermission\|onQuestion\|onProgress\|onRequestResolved\|hub.track" plugins/opc/scripts/lib/runner.mjs
grep -n "const stored = readJob\|stored?.request\|export function createRequestBridge\|export function createSerialUpdater" plugins/opc/scripts/commands/task-worker.mjs
grep -n "export function exitCodeForJob" plugins/opc/scripts/commands/task.mjs
grep -n "export async function readRawArgs" plugins/opc/scripts/lib/args.mjs
grep -n "export async function connectApi\|return { api" plugins/opc/scripts/lib/context.mjs
grep -n "function stopServerUnlocked\|export async function stopServer" plugins/opc/scripts/lib/server.mjs
grep -n "routes\|persist\|emit(\|:param\|params\|registerFakeExtension\|loadFixtureData" tests/fixtures/fake-opencode.mjs
grep -n "emitTurn\|abortSession\|SESSION_API_ROUTES" tests/fixtures/fake-session-api.mjs
grep -n "export function readFakeState\|export function testEnv" tests/helpers.mjs
```

Expected: cada premissa com a forma da coluna "Situação" (já conferida contra os planos; o
código F3 desta fase foi escrito para ela). Se o repositório divergir do plano da fase anterior,
pare e avise o operador (é defeito da fase anterior, não se contorna na F3). Guarde o resultado;
ele vai para a seção "Pontos de encaixe" do relatório.

- [ ] **Step 4: Linha de base verde**

Run: `npm test`
Expected: 100% verde (estado entregue pela F2b). Se falhar, pare e avise o operador: a F3 não
começa sobre base vermelha.

---

### Task 1: Servidor falso F3 (rotas, catálogos, cenários), tmux falso e helpers de teste

**Files:**
- Create: `tests/fixtures/f3-fake.mjs`
- Create: `tests/fixtures/scenarios/f3-sessions.mjs`, `children.mjs`, `group-slow.mjs`, `subagent-mode-refused.mjs`, `command-sync.mjs`
- Create: `tests/fixtures/bin/tmux` (executável)
- Create: `tests/fixtures/attach-probe.mjs` (executável)
- Modify: `tests/helpers.mjs` (acrescentar no fim)
- Test: `tests/unit/fake-f3.test.mjs`

**Interfaces:**
- Consumes: `startFake({ port, password, scenario, stateFile })` e o contrato de cenário do mestre (premissa E9); `pickFreePort()` de `lib/server.mjs`; `workspaceStateDir`, `resolveWorkspaceRoot` de `lib/state.mjs`; `readFakeState(env)`, `makeTempDir` de `tests/helpers.mjs`.
- Produces: `F3_MODELS`, `F3_PROVIDERS`, `F3_AGENTS`, `F3_COMMANDS`, `F3_OPENCODE_CONFIG`, `F3_TEST_CONFIG`, `SEED`, `withF3(scenario)`, `seedSession(fake)`, `createSessionRecord(fake, body, directory)`, `userMessage`, `assistantMessage`, `ok`, `bad`, `notFound`; cenários `f3-sessions`, `children`, `group-slow`, `subagent-mode-refused`, `command-sync`; helpers `startExternalFake(t, { scenario })`, `eventually(fn, { timeoutMs, intervalMs })` (os demais — `writeGlobalConfig`, `stateDirFor`, `fakeRequests` — já existem em `tests/helpers.mjs`, F1/F2a/F2b). Catálogos F3 entregues pelo campo `data` do cenário (mecanismo da F1), não por rotas.

- [ ] **Step 1: Escrever o teste do fake (falha: módulos inexistentes)**

Create `tests/unit/fake-f3.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { F3_MODELS, SEED } from '../fixtures/f3-fake.mjs';

const PASSWORD = 'f3-fake-password-0123456789';

async function boot(t, scenario = 'f3-sessions') {
  const dir = mkdtempSync(join(tmpdir(), 'opc-f3fake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = await startFake({ port: await pickFreePort(), password: PASSWORD, scenario, stateFile: join(dir, 'state.json') });
  t.after(() => fake.close());
  const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  async function call(method, path, body) {
    const res = await fetch(`${fake.url}${path}`, {
      method,
      headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { fake, call };
}

test('f3 fake: seeded sessions are listed newest first', async (t) => {
  const { call } = await boot(t);
  const res = await call('GET', '/session');
  assert.equal(res.status, 200);
  const ids = res.body.map((s) => s.id);
  assert.ok(ids.includes(SEED.session));
  assert.ok(ids.includes(SEED.userSession));
});

test('f3 fake: POST /session stores parentID, agent and model; children lists it', async (t) => {
  const { call } = await boot(t);
  const created = await call('POST', '/session', { parentID: SEED.session, title: 'OPC: sub: x', agent: 'general', model: { id: 'opencode-go/kimi-k3', providerID: 'omniroute-mvalmeida' } });
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^ses/);
  assert.equal(created.body.parentID, SEED.session);
  assert.equal(created.body.agent, 'general');
  const children = await call('GET', `/session/${SEED.session}/children`);
  assert.deepEqual(children.body.map((s) => s.id), [created.body.id]);
});

test('f3 fake: fork copies only messages before messageID', async (t) => {
  const { call } = await boot(t);
  const forked = await call('POST', `/session/${SEED.session}/fork`, { messageID: SEED.m3 });
  assert.equal(forked.status, 200);
  const msgs = await call('GET', `/session/${forked.body.id}/message`);
  assert.deepEqual(msgs.body.map((m) => m.info.role), ['user', 'assistant']);
  const unknown = await call('POST', `/session/${SEED.session}/fork`, { messageID: 'msg_nope' });
  assert.equal(unknown.status, 400);
});

test('f3 fake: revert sets session.revert with a diff; unrevert clears it', async (t) => {
  const { call } = await boot(t);
  const reverted = await call('POST', `/session/${SEED.session}/revert`, { messageID: SEED.m3 });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.body.revert.messageID, SEED.m3);
  assert.match(reverted.body.revert.diff, /\+BETA/);
  const missing = await call('POST', `/session/${SEED.session}/revert`, {});
  assert.equal(missing.status, 400);
  const restored = await call('POST', `/session/${SEED.session}/unrevert`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.revert, undefined);
});

test('f3 fake: summarize requires providerID and modelID', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', `/session/${SEED.session}/summarize`, {})).status, 400);
  const res = await call('POST', `/session/${SEED.session}/summarize`, { providerID: 'omniroute-mvalmeida', modelID: 'opencode-go/qwen3.8-max' });
  assert.equal(res.status, 200);
  assert.equal(res.body, true);
  const msgs = await call('GET', `/session/${SEED.session}/message`);
  assert.equal(msgs.body.at(-1).info.summary, true);
});

test('f3 fake: command requires command and string arguments, answers synchronously', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', `/session/${SEED.session}/command`, { command: 'echo' })).status, 400);
  assert.equal((await call('POST', `/session/${SEED.session}/command`, { command: 'nope', arguments: '' })).status, 400);
  const res = await call('POST', `/session/${SEED.session}/command`, { command: 'echo', arguments: 'a b', model: F3_MODELS.qwen });
  assert.equal(res.status, 200);
  assert.equal(res.body.info.modelID, 'opencode-go/qwen3.8-max');
  assert.equal(res.body.parts[0].text, 'COMMAND echo ARGS[a b]');
});

test('f3 fake: diff (with and without messageID), todo, dispose and catalogs', async (t) => {
  const { fake, call } = await boot(t);
  assert.equal((await call('GET', `/session/${SEED.session}/diff`)).body.length, 1);
  const perMessage = await call('GET', `/session/${SEED.session}/diff?messageID=${SEED.m3}`);
  assert.deepEqual(perMessage.body.map((d) => d.file), ['notes.txt', 'extra.txt']);
  assert.equal((await call('GET', `/session/${SEED.session}/todo`)).body.length, 2);
  assert.equal((await call('POST', '/instance/dispose')).body, true);
  assert.equal(fake.state.f3.disposed, 1);
  const providers = await call('GET', '/provider');
  assert.deepEqual(providers.body.connected, ['omniroute-mvalmeida', 'omniroute-work']);
  assert.ok((await call('GET', '/agent')).body.some((a) => a.name === 'explore' && a.mode === 'subagent'));
  assert.ok((await call('GET', '/command')).body.some((c) => c.name === 'pinned-model'));
});

test('f3 fake: children scenario seeds two children of the seed session', async (t) => {
  const { call } = await boot(t, 'children');
  const res = await call('GET', `/session/${SEED.session}/children`);
  assert.equal(res.body.length, 2);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/fake-f3.test.mjs`
Expected: FAIL com `Cannot find module '../fixtures/f3-fake.mjs'` (ou cenário inexistente).

- [ ] **Step 3: Implementar `tests/fixtures/f3-fake.mjs`**

```js
// F3 extensions for the fake OpenCode server: session operations, catalogs and seed data.
// Used only through F3 scenarios (withF3), so F0–F2b scenarios keep their behavior.

export const F3_MODELS = Object.freeze({
  deepseek: 'omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash',
  qwen: 'omniroute-mvalmeida/opencode-go/qwen3.8-max',
  kimi: 'omniroute-mvalmeida/opencode-go/kimi-k3',
  denied: 'omniroute-work/cx/gpt-5.5',
});

export const SEED = Object.freeze({
  session: 'ses_seed',
  userSession: 'ses_user',
  m1: 'msg_seed_001',
  m2: 'msg_seed_002',
  m3: 'msg_seed_003',
  m4: 'msg_seed_004',
});

function fakeModel(providerID, id) {
  return {
    id,
    providerID,
    name: id,
    family: id.split('/').pop(),
    api: { id, url: 'http://127.0.0.1/fake', npm: '@ai-sdk/openai-compatible' },
    capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: 'active',
    options: {},
    headers: {},
    release_date: '2026-01-01',
    variants: {},
  };
}

function fakeProvider(id, modelIDs) {
  return { id, name: id, source: 'config', env: [], options: {}, models: Object.fromEntries(modelIDs.map((m) => [m, fakeModel(id, m)])) };
}

export const F3_PROVIDERS = {
  all: [
    fakeProvider('omniroute-mvalmeida', ['opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3']),
    fakeProvider('omniroute-work', ['cx/gpt-5.5']),
  ],
  default: { 'omniroute-mvalmeida': 'opencode-go/deepseek-v4.1-flash', 'omniroute-work': 'cx/gpt-5.5' },
  connected: ['omniroute-mvalmeida', 'omniroute-work'],
};

const agent = (name, mode, extra = {}) => ({ name, mode, native: false, permission: [], options: {}, ...extra });

export const F3_AGENTS = [
  agent('build', 'primary', { native: true }),
  agent('plan', 'primary', { native: true }),
  agent('general', 'subagent', { native: true }),
  agent('explore', 'subagent', { native: true }),
  agent('work-secret', 'subagent'),
  agent('pinned-sub', 'subagent', { model: { providerID: 'omniroute-work', modelID: 'cx/gpt-5.5' } }),
];

export const F3_COMMANDS = [
  { name: 'echo', description: 'Echo the arguments', template: 'Reply with: $ARGUMENTS', hints: ['$ARGUMENTS'], source: 'command' },
  { name: 'sub-echo', description: 'Echo in a subtask', template: 'Reply with: $ARGUMENTS', hints: ['$ARGUMENTS'], source: 'command', subtask: true, agent: 'general' },
  { name: 'pinned-model', description: 'Pins a denied model', template: 'x', hints: [], source: 'command', model: F3_MODELS.denied },
  { name: 'pinned-agent', description: 'Pins a denied agent', template: 'x', hints: [], source: 'command', agent: 'work-secret' },
];

export const F3_OPENCODE_CONFIG = { model: F3_MODELS.deepseek, share: 'manual' };

// Global opc config used by F3 integration tests (written to <OPC_DATA_DIR>/config.json).
export const F3_TEST_CONFIG = {
  defaultProvider: 'omniroute-mvalmeida',
  defaultModel: F3_MODELS.deepseek,
  aliases: { fast: F3_MODELS.deepseek, strong: F3_MODELS.qwen, k3: F3_MODELS.kimi },
  policy: {
    providers: { allow: [], deny: ['omniroute-work'] },
    models: { allow: [], deny: [] },
    agents: { allow: [], deny: ['work-*'] },
    tools: { deny: [] },
    sensitivePaths: ['*.env', '*.env.*'],
    destructiveBash: [],
    approver: 'user',
    permissionTimeoutSec: 600,
  },
  jobs: { maxActive: 8, maxParallel: 4 },
};

// --- response adapters (premissa E9: único ponto a ajustar se o fake do F0 divergir) ---
export const ok = (body) => ({ status: 200, body });
export const bad = (message) => ({ status: 400, body: { name: 'BadRequest', data: { message } } });
export const notFound = (message) => ({ status: 404, body: { name: 'NotFoundError', data: { message } } });

const persist = (fake) => fake.persist?.();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function initF3State(fake) {
  fake.state.sessions ??= {};
  fake.state.messages ??= {};
  fake.state.f3 ??= { seq: 0, diffs: {}, messageDiffs: {}, todos: {}, disposed: 0, prompts: [] };
}

function nextId(fake, prefix) {
  fake.state.f3.seq += 1;
  return `${prefix}_f3${String(fake.state.f3.seq).padStart(6, '0')}`;
}

export function userMessage(sessionID, id, text, created = Date.now()) {
  return {
    info: { id, sessionID, role: 'user', time: { created }, agent: 'build', model: { providerID: 'omniroute-mvalmeida', modelID: 'opencode-go/deepseek-v4.1-flash' } },
    parts: [{ id: `prt_${id.slice(4)}`, sessionID, messageID: id, type: 'text', text }],
  };
}

export function assistantMessage(sessionID, id, parentID, text, { providerID = 'omniroute-mvalmeida', modelID = 'opencode-go/deepseek-v4.1-flash', agent: agentName = 'build', summary = false, error = undefined, created = Date.now() } = {}) {
  return {
    info: {
      id, sessionID, role: 'assistant', time: { created, completed: created }, parentID, modelID, providerID,
      mode: agentName, agent: agentName, path: { cwd: '/fake', root: '/fake' }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop',
      ...(summary ? { summary: true } : {}), ...(error ? { error } : {}),
    },
    parts: text ? [{ id: `prt_${id.slice(4)}`, sessionID, messageID: id, type: 'text', text }] : [],
  };
}

export function createSessionRecord(fake, body = {}, directory = null) {
  initF3State(fake);
  const id = nextId(fake, 'ses');
  const now = Date.now();
  const session = {
    id,
    slug: id.slice(4),
    projectID: 'prj_fake',
    directory: directory ?? '/fake',
    title: body.title ?? `New session ${id}`,
    version: '1.18.32',
    time: { created: now, updated: now },
    ...(body.parentID ? { parentID: body.parentID } : {}),
    ...(body.agent ? { agent: body.agent } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.permission ? { permission: body.permission } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  };
  fake.state.sessions[id] = session;
  fake.state.messages[id] ??= [];
  fake.emit({ type: 'session.created', properties: { sessionID: id, info: session } });
  persist(fake);
  return session;
}

export function seedSession(fake) {
  initF3State(fake);
  const t0 = Date.now() - 60_000;
  const s = SEED.session;
  fake.state.sessions[s] = { id: s, slug: 'seed', projectID: 'prj_fake', directory: null, title: 'OPC: task: seeded session', version: '1.18.32', time: { created: t0, updated: t0 + 4000 } };
  fake.state.sessions[SEED.userSession] = { id: SEED.userSession, slug: 'user', projectID: 'prj_fake', directory: null, title: 'User session from the TUI', version: '1.18.32', time: { created: t0, updated: t0 + 1000 } };
  fake.state.messages[s] = [
    userMessage(s, SEED.m1, 'first question', t0 + 1000),
    assistantMessage(s, SEED.m2, SEED.m1, 'first answer', { created: t0 + 2000 }),
    userMessage(s, SEED.m3, 'second question', t0 + 3000),
    assistantMessage(s, SEED.m4, SEED.m3, 'second answer', { created: t0 + 4000 }),
  ];
  fake.state.messages[SEED.userSession] = [];
  const alpha = { file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n original\n+ALPHA\n' };
  const beta = { file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,2 +1,3 @@\n original\n ALPHA\n+BETA\n' };
  const extra = { file: 'extra.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+new file\n' };
  fake.state.f3.diffs[s] = [{ file: 'notes.txt', status: 'modified', additions: 2, deletions: 0, patch: '@@ -1 +1,3 @@\n original\n+ALPHA\n+BETA\n' }];
  fake.state.f3.messageDiffs[s] = { [SEED.m1]: [alpha], [SEED.m3]: [beta, extra] };
  fake.state.f3.todos[s] = [
    { content: 'check alpha', status: 'completed', priority: 'high' },
    { content: 'check beta', status: 'pending', priority: 'low' },
  ];
  persist(fake);
}

function hugeDiff() {
  return { file: 'huge.txt', status: 'added', additions: 250000, deletions: 0, patch: '+x\n'.repeat(250000) };
}

// F3 catalogs through the F1 `data` mechanism (loadFixtureData): GET /provider, /agent, /command and /config
// stay served by the F1 extension (so /config still merges OPENCODE_CONFIG_CONTENT), with these values.
export const F3_DATA = {
  'provider.json': F3_PROVIDERS,
  'agent.json': F3_AGENTS,
  'command.json': F3_COMMANDS,
  'config.json': F3_OPENCODE_CONFIG,
};

export const F3_SESSION_ROUTES = {
  'POST /session': (fake, { body = {}, query = {} }) => ok(createSessionRecord(fake, body, query.directory ?? null)),
  'GET /session': (fake) => ok(Object.values(fake.state.sessions).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))),
  'GET /session/:id': (fake, { params }) => (fake.state.sessions[params.id] ? ok(fake.state.sessions[params.id]) : notFound(`session ${params.id} not found`)),
  'GET /session/:id/children': (fake, { params }) => ok(Object.values(fake.state.sessions).filter((s) => s.parentID === params.id)),
  'GET /session/:id/diff': (fake, { params, query = {} }) => {
    const base = query.messageID ? (fake.state.f3.messageDiffs[params.id]?.[query.messageID] ?? []) : (fake.state.f3.diffs[params.id] ?? []);
    return ok(process.env.FAKE_HUGE_DIFF === '1' && !query.messageID ? [...base, hugeDiff()] : base);
  },
  'GET /session/:id/todo': (fake, { params }) => ok(fake.state.f3.todos[params.id] ?? []),
  'POST /session/:id/fork': (fake, { params, body = {} }) => {
    const src = fake.state.sessions[params.id];
    if (!src) return notFound(`session ${params.id} not found`);
    const msgs = fake.state.messages[params.id] ?? [];
    if (body.messageID && !msgs.some((m) => m.info.id === body.messageID)) return bad(`message ${body.messageID} not found`);
    const kept = body.messageID ? msgs.filter((m) => m.info.id < body.messageID) : msgs;
    const forked = createSessionRecord(fake, { title: `${src.title} (fork #1)` }, src.directory);
    fake.state.messages[forked.id] = kept.map((m) => ({
      info: { ...m.info, sessionID: forked.id },
      parts: m.parts.map((p) => ({ ...p, sessionID: forked.id })),
    }));
    persist(fake);
    return ok(forked);
  },
  'POST /session/:id/revert': (fake, { params, body = {} }) => {
    const session = fake.state.sessions[params.id];
    if (!session) return notFound(`session ${params.id} not found`);
    if (!body.messageID) return bad('messageID is required');
    const msgs = fake.state.messages[params.id] ?? [];
    if (!msgs.some((m) => m.info.id === body.messageID)) return bad(`message ${body.messageID} not found`);
    const perMessage = fake.state.f3.messageDiffs[params.id] ?? {};
    const diff = Object.entries(perMessage).filter(([id]) => id >= body.messageID).flatMap(([, diffs]) => diffs.map((d) => d.patch)).join('\n');
    session.revert = { messageID: body.messageID, ...(body.partID ? { partID: body.partID } : {}), snapshot: 'snap_fake', diff };
    session.time.updated = Date.now();
    fake.emit({ type: 'session.updated', properties: { sessionID: params.id, info: session } });
    persist(fake);
    return ok(session);
  },
  'POST /session/:id/unrevert': (fake, { params }) => {
    const session = fake.state.sessions[params.id];
    if (!session) return notFound(`session ${params.id} not found`);
    delete session.revert;
    session.time.updated = Date.now();
    fake.emit({ type: 'session.updated', properties: { sessionID: params.id, info: session } });
    persist(fake);
    return ok(session);
  },
  'POST /session/:id/summarize': (fake, { params, body = {} }) => {
    if (!fake.state.sessions[params.id]) return notFound(`session ${params.id} not found`);
    if (!body.providerID || !body.modelID) return bad('providerID and modelID are required');
    const msgs = (fake.state.messages[params.id] ??= []);
    const parent = [...msgs].reverse().find((m) => m.info.role === 'user')?.info.id ?? 'msg_none';
    msgs.push(assistantMessage(params.id, nextId(fake, 'msg'), parent, 'Summary of the conversation.', { providerID: body.providerID, modelID: body.modelID, agent: 'compaction', summary: true }));
    persist(fake);
    return ok(true);
  },
  'POST /session/:id/command': async (fake, { params, body = {} }) => {
    if (typeof body.command !== 'string' || typeof body.arguments !== 'string') return bad('command and arguments are required');
    const cmd = F3_COMMANDS.find((c) => c.name === body.command);
    if (!cmd) return bad(`command ${body.command} not found`);
    const session = fake.state.sessions[params.id];
    if (!session) return notFound(`session ${params.id} not found`);
    const delay = Number(process.env.FAKE_COMMAND_DELAY_MS ?? 0);
    if (delay > 0) await sleep(delay);
    const [providerID, ...rest] = String(body.model ?? F3_MODELS.deepseek).split('/');
    const userID = nextId(fake, 'msg');
    const msgs = (fake.state.messages[params.id] ??= []);
    msgs.push(userMessage(params.id, userID, `/${body.command} ${body.arguments}`.trim()));
    const error = process.env.FAKE_COMMAND_ERROR === '1' ? { name: 'ProviderAuthError', data: { providerID, message: 'invalid api key' } } : undefined;
    const reply = assistantMessage(params.id, nextId(fake, 'msg'), userID, error ? '' : `COMMAND ${body.command} ARGS[${body.arguments}]`, {
      providerID, modelID: rest.join('/'), agent: body.agent ?? cmd.agent ?? 'build', error,
    });
    msgs.push(reply);
    persist(fake);
    return ok(reply);
  },
  'POST /instance/dispose': (fake) => {
    fake.state.f3.disposed += 1;
    persist(fake);
    return ok(true);
  },
};

// Wraps an F3 scenario: seeds F3 state, F3 catalogs via `data` (F1 mechanism), F3 session routes as scenario
// routes (they win over the F2a extension; prompt_async/abort/message stay with F2a), overrides last.
export function withF3(scenario = {}) {
  return {
    ...scenario,
    data: { ...F3_DATA, ...(scenario.data ?? {}) },
    setup(fake) {
      initF3State(fake);
      scenario.setup?.(fake);
      persist(fake);
    },
    routes: { ...F3_SESSION_ROUTES, ...(scenario.routes ?? {}) },
  };
}
```

- [ ] **Step 4: Criar os cenários**

Create `tests/fixtures/scenarios/f3-sessions.mjs`:

```js
import { withF3, seedSession } from '../f3-fake.mjs';

// Base F3 scenario: catalogs + session routes + one seeded OPC session and one user session.
export default withF3({ setup: seedSession });
```

Create `tests/fixtures/scenarios/children.mjs`:

```js
import { withF3, seedSession, createSessionRecord, SEED } from '../f3-fake.mjs';

// Seed session with two child sessions (subagent-like), for `session children`.
export default withF3({
  setup(fake) {
    seedSession(fake);
    createSessionRecord(fake, { parentID: SEED.session, title: 'OPC: sub: #1 general: child one', agent: 'general' });
    createSessionRecord(fake, { parentID: SEED.session, title: 'OPC: sub: #2 explore: child two', agent: 'explore' });
  },
});
```

Create `tests/fixtures/scenarios/group-slow.mjs`:

```js
import { withF3, seedSession, ok } from '../f3-fake.mjs';

// Subagent groups: every prompt is answered after FAKE_GROUP_DELAY_MS with
// "RESULT <agent> <modelID>". FAKE_FAIL_MODEL=<suffix> makes that model fail fast.
// FAKE_GROUP_ASK=permission|question makes the kimi-k3 member ask before answering.
function recordPrompt(fake, sessionID, body) {
  fake.state.f3.prompts.push({ at: Date.now(), sessionID, agent: body.agent ?? null, model: body.model ?? null, parts: body.parts ?? [] });
  fake.persist?.();
}

function answerAfterReply(fake, sessionID) {
  delete fake.state.permissions?.per_f3_1;
  delete fake.state.questions?.que_f3_1;
  fake.persist?.();
  fake.emitTurn(sessionID, { text: 'AFTER REPLY', delayMs: 50 });
}

export default withF3({
  setup: seedSession,
  onPromptAsync(fake, sessionID, body) {
    recordPrompt(fake, sessionID, body);
    const delayMs = Number(process.env.FAKE_GROUP_DELAY_MS ?? 300);
    const modelID = body.model?.modelID ?? 'none';
    const failSuffix = process.env.FAKE_FAIL_MODEL;
    if (failSuffix && modelID.endsWith(failSuffix)) {
      return fake.emitTurn(sessionID, { error: { name: 'ProviderAuthError', data: { providerID: body.model.providerID, message: 'invalid api key' } }, delayMs: 50 });
    }
    const ask = process.env.FAKE_GROUP_ASK;
    if (ask && modelID.endsWith('kimi-k3')) {
      fake.state.f3.askSession = sessionID;
      // Also registered in state.permissions/state.questions so GET /permission and GET /question (F2a) list them.
      if (ask === 'question') {
        const properties = { id: 'que_f3_1', sessionID, questions: [{ question: 'Qual opção?', header: 'Opção', options: [{ label: 'A', description: 'primeira' }, { label: 'B', description: 'segunda' }] }] };
        (fake.state.questions ??= {})[properties.id] = properties;
        fake.emit({ type: 'question.asked', properties });
      } else {
        const properties = { id: 'per_f3_1', sessionID, permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] };
        (fake.state.permissions ??= {})[properties.id] = properties;
        fake.emit({ type: 'permission.asked', properties });
      }
      fake.persist?.();
      return undefined;
    }
    const subtask = (body.parts ?? []).find((p) => p.type === 'subtask');
    const text = subtask ? `SUBTASK ${subtask.agent} ${subtask.model?.modelID ?? 'none'}` : `RESULT ${body.agent ?? 'default'} ${modelID}`;
    return fake.emitTurn(sessionID, { text, delayMs });
  },
  routes: {
    'POST /permission/:id/reply': (fake, { params, body = {} }) => {
      const sessionID = fake.state.f3.askSession;
      fake.emit({ type: 'permission.replied', properties: { sessionID, requestID: params.id, reply: body.reply } });
      answerAfterReply(fake, sessionID);
      return ok(true);
    },
    'POST /question/:id/reply': (fake, { params, body = {} }) => {
      const sessionID = fake.state.f3.askSession;
      fake.emit({ type: 'question.replied', properties: { sessionID, requestID: params.id, answers: body.answers ?? [] } });
      answerAfterReply(fake, sessionID);
      return ok(true);
    },
    'POST /question/:id/reject': (fake, { params }) => {
      const sessionID = fake.state.f3.askSession;
      fake.emit({ type: 'question.rejected', properties: { sessionID, requestID: params.id } });
      answerAfterReply(fake, sessionID);
      return ok(true);
    },
  },
});
```

Create `tests/fixtures/scenarios/subagent-mode-refused.mjs`:

```js
import { withF3, seedSession, createSessionRecord, bad, notFound, F3_AGENTS } from '../f3-fake.mjs';

// Simulates an OpenCode that refuses a subagent-mode agent as the agent of a session
// (spec §15 item 7): prompt_async with such an agent → 400. A `subtask` part works.
export default withF3({
  setup: seedSession,
  routes: {
    'POST /session/:id/prompt_async': (fake, { params, body = {} }) => {
      const session = fake.state.sessions[params.id];
      if (!session) return notFound(`session ${params.id} not found`);
      const subtask = (body.parts ?? []).find((p) => p.type === 'subtask');
      if (subtask) {
        const child = createSessionRecord(fake, { parentID: params.id, title: `${subtask.description} (@${subtask.agent} subagent)`, agent: subtask.agent }, session.directory);
        fake.emitTurn(params.id, { text: `SUBTASK ${subtask.agent} ${subtask.model?.modelID ?? 'none'} via ${child.id}`, delayMs: 50 });
        return { status: 204 };
      }
      const mode = F3_AGENTS.find((a) => a.name === body.agent)?.mode;
      if (body.agent && mode === 'subagent') return bad(`Agent ${body.agent} is a subagent and cannot be used as the session agent`);
      fake.emitTurn(params.id, { text: `DIRECT ${body.agent ?? 'default'}`, delayMs: 50 });
      return { status: 204 };
    },
  },
});
```

Create `tests/fixtures/scenarios/command-sync.mjs`:

```js
import { withF3, seedSession } from '../f3-fake.mjs';

// Synchronous /command: the base F3 route answers after FAKE_COMMAND_DELAY_MS (default here 2000 ms),
// which must exceed a short server.requestTimeoutSec to prove the long timeout is used.
export default withF3({
  setup(fake) {
    process.env.FAKE_COMMAND_DELAY_MS ??= '2000';
    seedSession(fake);
  },
});
```

- [ ] **Step 5: Criar o `tmux` falso e a sonda do attach**

Create `tests/fixtures/bin/tmux`:

```js
#!/usr/bin/env node
// Fake tmux for tests: records argv and whether a password variable leaked into its
// environment (never the value) into FAKE_TMUX_LOG, then prints a pane id.
import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_TMUX_LOG;
if (log) {
  appendFileSync(log, `${JSON.stringify({
    argv: process.argv.slice(2),
    hasPasswordEnv: 'OPENCODE_SERVER_PASSWORD' in process.env || 'OPC_SERVER_PASSWORD' in process.env,
  })}\n`);
}
if (process.env.FAKE_TMUX_FAIL === '1') {
  process.stderr.write('fake tmux: no server running\n');
  process.exit(1);
}
process.stdout.write('%42\n');
```

Create `tests/fixtures/attach-probe.mjs`:

```js
#!/usr/bin/env node
// Stands in for `opencode` in attach --pane tests. Records argv and whether
// OPENCODE_SERVER_PASSWORD matches EXPECTED_SHA256 — never the value itself.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const passwordMatches = createHash('sha256').update(password).digest('hex') === process.env.EXPECTED_SHA256;
const passwordInArgv = password !== '' && process.argv.some((arg) => arg.includes(password));
appendFileSync(process.env.PROBE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), passwordMatches, passwordInArgv })}\n`);
```

Run:

```bash
chmod +x tests/fixtures/bin/tmux tests/fixtures/attach-probe.mjs
```

- [ ] **Step 6: Acrescentar os helpers em `tests/helpers.mjs`**

Acrescente ao **fim** do arquivo (não mexa nos imports do topo: o bloco usa `path` e os helpers da F0 e só
importa `randomBytes` com alias). Reaproveita, sem redefinir: `writeGlobalConfig` (F1), `stateDirFor` (F2a,
síncrono — os testes desta fase que fazem `await stateDirFor(...)` continuam válidos), `fakeRequests` (F2b) e
`waitFor` (F0). `eventually` é acréscimo com semântica própria: igual ao `waitFor`, mas uma exceção do predicado
conta como "ainda não" (útil para ler arquivos que podem estar a meio de uma escrita):

```js

// ---- F3 helpers (appended) ----
import { randomBytes as f3RandomBytes } from 'node:crypto';

// Starts a fake OpenCode server in-process (not spawned by opc) for OPC_SERVER_URL tests. Its temp dir goes to
// the F0 per-test cleanup; fake.close() is a plain t.after (it must stay up while the cleanup runs
// `setup --stop-server` in attach mode).
export async function startExternalFake(t, { scenario = 'f3-sessions' } = {}) {
  const { startFake } = await import('./fixtures/fake-opencode.mjs');
  const { pickFreePort } = await import('../plugins/opc/scripts/lib/server.mjs');
  const dir = trackTempDir(t, makeTempDir('opc-ext-'));
  const password = f3RandomBytes(24).toString('hex');
  const stateFile = path.join(dir, 'fake-state.json');
  const fake = await startFake({ port: await pickFreePort(), password, scenario, stateFile });
  t.after(() => fake.close());
  return { url: fake.url, password, stateFile, fake };
}

// waitFor (F0) that also treats a throwing predicate as "not yet"; the last error goes into the timeout message.
export async function eventually(fn, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  let lastError;
  try {
    return await waitFor(async () => {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        return false;
      }
    }, { timeoutMs, intervalMs, message: 'eventually' });
  } catch {
    throw new Error(`eventually: condition not met in ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ''}`);
  }
}
// ---- end F3 ----
```

- [ ] **Step 7: Rodar e ver passar**

Run: `node --test tests/unit/fake-f3.test.mjs`
Expected: PASS (8 testes). Se o roteador do fake não suportar `:param` ou handlers `async`
(premissa E9), acrescente esse suporte no roteamento de `routes` de cenário do
`fake-opencode.mjs` (mudança só de fixture) e rode de novo.

- [ ] **Step 8: Suíte completa continua verde**

Run: `npm test`
Expected: PASS (nada de F0–F2b mudou de comportamento).

- [ ] **Step 9: Commit**

```bash
git add tests/fixtures/f3-fake.mjs tests/fixtures/scenarios/f3-sessions.mjs tests/fixtures/scenarios/children.mjs tests/fixtures/scenarios/group-slow.mjs tests/fixtures/scenarios/subagent-mode-refused.mjs tests/fixtures/scenarios/command-sync.mjs tests/fixtures/bin/tmux tests/fixtures/attach-probe.mjs tests/helpers.mjs tests/unit/fake-f3.test.mjs
git commit -m "test: add F3 fake routes, scenarios, fake tmux and helpers"
```

---
### Task 2: Operações de sessão na `lib/api.mjs`

**Files:**
- Modify: `plugins/opc/scripts/lib/api.mjs`
- Test: `tests/unit/api-f3.test.mjs`

**Interfaces:**
- Consumes: `createApi(client)` (F1/F2a), cliente com `get(path, opts)`, `post(path, body, opts)`, `request(method, path, opts)` (mestre, `lib/http.mjs`); `UsageError` (E1).
- Produces: `assertId(prefix, value, label)`; métodos `fork`, `revert`, `unrevert`, `summarize`, `runCommand`, `dispose` e `diff(id, { messageID })` no objeto devolvido por `createApi`.

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/unit/api-f3.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, assertId } from '../../plugins/opc/scripts/lib/api.mjs';

function recorder(responses = {}) {
  const calls = [];
  const client = {
    directory: '/ws',
    baseUrl: 'http://127.0.0.1:1',
    async request(method, path, opts = {}) {
      calls.push({ method, path, body: opts.body, query: opts.query, timeoutMs: opts.timeoutMs });
      return responses[`${method} ${path}`] ?? null;
    },
  };
  client.get = (path, opts = {}) => client.request('GET', path, opts);
  client.post = (path, body, opts = {}) => client.request('POST', path, { ...opts, body });
  client.patch = (path, body, opts = {}) => client.request('PATCH', path, { ...opts, body });
  return { client, calls };
}

test('assertId accepts real-looking ids and rejects path tricks', () => {
  assert.equal(assertId('ses', 'ses_2b1XyZ-9'), 'ses_2b1XyZ-9');
  assert.equal(assertId('msg', 'msg_01J'), 'msg_01J');
  for (const bad of ['ses_x/../../global/dispose', 'msg_1', '', undefined, 'ses x', 'ses_$(id)', 'ses_%2e%2e']) {
    assert.throws(() => assertId('ses', bad), (err) => err.exitCode === 2 && err.code === 'INVALID_ID', String(bad));
  }
});

test('fork sends messageID only when given', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.fork('ses_a', { messageID: 'msg_b' });
  await api.fork('ses_a');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['POST', '/session/ses_a/fork', { messageID: 'msg_b' }],
    ['POST', '/session/ses_a/fork', {}],
  ]);
});

test('revert requires messageID and forwards partID', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.revert('ses_a', { messageID: 'msg_b', partID: 'prt_c' });
  assert.deepEqual(calls[0], { method: 'POST', path: '/session/ses_a/revert', body: { messageID: 'msg_b', partID: 'prt_c' }, query: undefined, timeoutMs: undefined });
  assert.throws(() => api.revert('ses_a', {}), (err) => err.exitCode === 2);
  assert.throws(() => api.revert('ses_a', { messageID: 'msg_b', partID: 'bad' }), (err) => err.code === 'INVALID_ID');
});

test('unrevert posts without body; dispose hits /instance/dispose', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.unrevert('ses_a');
  await api.dispose();
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['POST', '/session/ses_a/unrevert', undefined],
    ['POST', '/instance/dispose', undefined],
  ]);
});

test('summarize requires providerID/modelID and passes a long timeout', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.summarize('ses_a', { providerID: 'p', modelID: 'm/x', timeoutMs: 600000 });
  assert.deepEqual(calls[0].body, { providerID: 'p', modelID: 'm/x' });
  assert.equal(calls[0].timeoutMs, 600000);
  assert.throws(() => api.summarize('ses_a', { providerID: 'p' }), (err) => err.exitCode === 2);
});

test('runCommand: model as string, arguments default to empty string, undefined fields omitted', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.runCommand('ses_a', { command: 'echo', model: 'p/m', timeoutMs: 1800000 });
  assert.deepEqual(calls[0].body, { command: 'echo', arguments: '', model: 'p/m' });
  assert.equal(calls[0].timeoutMs, 1800000);
  await api.runCommand('ses_a', { command: 'echo', arguments: 'x y', agent: 'build', variant: 'high', messageID: 'msg_1' });
  assert.deepEqual(calls[1].body, { command: 'echo', arguments: 'x y', agent: 'build', variant: 'high', messageID: 'msg_1' });
  assert.throws(() => api.runCommand('ses_a', { command: 'echo', model: { providerID: 'p', modelID: 'm' } }), (err) => err.code === 'MODEL_NOT_STRING');
  assert.throws(() => api.runCommand('ses_a', {}), (err) => err.exitCode === 2);
});

test('diff forwards messageID as query', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.diff('ses_a');
  await api.diff('ses_a', { messageID: 'msg_b' });
  assert.deepEqual(calls.map((c) => [c.path, c.query]), [
    ['/session/ses_a/diff', undefined],
    ['/session/ses_a/diff', { messageID: 'msg_b' }],
  ]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/api-f3.test.mjs`
Expected: FAIL com `assertId is not exported` (ou `api.fork is not a function`).

- [ ] **Step 3: Implementar**

Em `plugins/opc/scripts/lib/api.mjs`, garanta o import `import { UsageError } from './opc-error.mjs';`
e acrescente, fora de `createApi`:

```js
// --- F3: session operations ----------------------------------------------------
const ID_BODY = /^[A-Za-z0-9_-]{1,160}$/;

export function assertId(prefix, value, label = prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !ID_BODY.test(value)) {
    const shown = JSON.stringify(String(value ?? '')).slice(0, 80);
    throw new UsageError('INVALID_ID', `id inválido para ${label}: ${shown} (esperado prefixo "${prefix}")`);
  }
  return value;
}

const seg = (prefix, id) => encodeURIComponent(assertId(prefix, id));

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function f3Methods(client) {
  return {
    diff: (id, { messageID } = {}) =>
      client.get(`/session/${seg('ses', id)}/diff`, messageID ? { query: { messageID: assertId('msg', messageID) } } : {}),
    fork: (id, { messageID } = {}) =>
      client.post(`/session/${seg('ses', id)}/fork`, messageID ? { messageID: assertId('msg', messageID) } : {}),
    revert: (id, { messageID, partID } = {}) => {
      if (!messageID) throw new UsageError('MISSING_MESSAGE_ID', 'revert exige messageID');
      const body = { messageID: assertId('msg', messageID) };
      if (partID) body.partID = assertId('prt', partID);
      return client.post(`/session/${seg('ses', id)}/revert`, body);
    },
    unrevert: (id) => client.post(`/session/${seg('ses', id)}/unrevert`, undefined),
    summarize: (id, { providerID, modelID, timeoutMs } = {}) => {
      if (!providerID || !modelID) throw new UsageError('MISSING_MODEL', 'summarize exige providerID e modelID');
      return client.post(`/session/${seg('ses', id)}/summarize`, { providerID, modelID }, timeoutMs ? { timeoutMs } : {});
    },
    runCommand: (id, { command, arguments: args = '', agent, model, variant, messageID, timeoutMs } = {}) => {
      if (!command) throw new UsageError('MISSING_COMMAND', 'runCommand exige o nome do command');
      if (model !== undefined && model !== null && typeof model !== 'string') {
        throw new UsageError('MODEL_NOT_STRING', 'runCommand: model deve ser a string "provider/model"');
      }
      if (typeof args !== 'string') throw new UsageError('ARGUMENTS_NOT_STRING', 'runCommand: arguments deve ser string');
      const body = { ...compact({ command, agent, model, variant, messageID }), arguments: args };
      const ordered = { command: body.command, arguments: body.arguments, ...body };
      return client.post(`/session/${seg('ses', id)}/command`, ordered, timeoutMs ? { timeoutMs } : {});
    },
    dispose: () => client.post('/instance/dispose', undefined),
  };
}
```

No `return` de `createApi`, acrescente `...f3Methods(client)` **por último** (o `diff` novo
substitui o do F1, compatível com a chamada antiga `diff(id)`):

```js
  return {
    // ...métodos de leitura (F1) e escrita (F2a) existentes, inalterados...
    ...f3Methods(client),
  };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/api-f3.test.mjs`
Expected: PASS (7 testes).

- [ ] **Step 5: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/api.mjs tests/unit/api-f3.test.mjs
git commit -m "feat: add session fork/revert/unrevert/summarize/command/dispose to api"
```

---

### Task 3: Renderizadores F3 e `shellQuote`

**Files:**
- Modify: `plugins/opc/scripts/lib/args.mjs` (acrescentar `shellQuote`)
- Modify: `plugins/opc/scripts/lib/render.mjs` (acrescentar no fim)
- Test: `tests/unit/render-f3.test.mjs`

**Interfaces:**
- Consumes: `renderTable(headers, rows)` (F0).
- Produces: `shellQuote(value)`; `renderSessions`, `renderSession`, `renderSessionDiff`, `renderTodos`, `renderRevertPreview`, `renderPendingLines` (itera a lista `job.pendingRequest`; o job em espera usa o `renderPermissionRequest(job)` da F2a, sem renderizador próprio), `renderGroupStatus`, `renderGroupResult`, `renderCommandResult`, `renderAttach` (assinaturas em "Interfaces novas").

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/unit/render-f3.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import {
  renderSessions, renderSession, renderSessionDiff, renderTodos, renderRevertPreview,
  renderPendingLines, renderGroupStatus, renderGroupResult, renderCommandResult, renderAttach,
} from '../../plugins/opc/scripts/lib/render.mjs';

test('shellQuote keeps safe tokens and quotes everything else', () => {
  assert.equal(shellQuote('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  assert.equal(shellQuote('/tmp/a b/ç'), "'/tmp/a b/ç'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('$(touch x)'), "'$(touch x)'");
});

test('renderSessions: table with status, escaped title, empty state', () => {
  const out = renderSessions([{ id: 'ses_a', title: 'OPC: task: a | b', time: { updated: Date.UTC(2026, 8, 26, 12, 30) } }], { statusMap: { ses_a: { type: 'busy' } } });
  assert.match(out, /# Sessões OPC/);
  assert.match(out, /ses_a/);
  assert.match(out, /busy/);
  assert.match(out, /2026-09-26 12:30/);
  assert.match(out, /a \\\| b/);
  assert.match(renderSessions([]), /Nenhuma sessão encontrada/);
  assert.match(renderSessions([{ id: 'ses_a', title: 't', time: {} }], { hiddenCount: 3 }), /3 sessão\(ões\) omitida/);
});

test('renderSession: fields, revert marker and message table', () => {
  const out = renderSession(
    { id: 'ses_a', title: 'OPC: x', directory: '/ws', agent: 'build', model: { id: 'm', providerID: 'p' }, parentID: 'ses_p', time: { created: 0, updated: 0 }, revert: { messageID: 'msg_3' } },
    { status: 'idle', messages: [{ info: { id: 'msg_1', role: 'user', agent: 'build' }, parts: [{ type: 'text', text: 'hello\nworld' }] }], note: 'Nota X.' },
  );
  assert.match(out, /# Sessão ses_a/);
  assert.match(out, /Modelo: p\/m/);
  assert.match(out, /Pai: ses_p/);
  assert.match(out, /Revert ativo: a partir de msg_3/);
  assert.match(out, /opc session unrevert ses_a --confirmed-by-user/);
  assert.match(out, /msg_1/);
  assert.match(out, /hello world/);
  assert.match(out, /Nota X\./);
});

test('renderSessionDiff: small patches inline, huge ones listed but omitted, safe fences', () => {
  const small = { file: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '+has ``` fence\n' };
  const huge = { file: 'huge.txt', status: 'added', additions: 1, deletions: 0, patch: '+x\n'.repeat(200000) };
  const out = renderSessionDiff([huge, small], { maxInlineBytes: 1024 });
  assert.match(out, /a\.txt/);
  assert.match(out, /huge\.txt/);
  assert.match(out, /````diff/);
  assert.match(out, /1 arquivo\(s\) fora do diff inline/);
  assert.ok(Buffer.byteLength(out) < 4096);
  assert.match(renderSessionDiff([]), /Nenhuma alteração registrada/);
});

test('renderTodos lists status, priority and content', () => {
  const out = renderTodos([{ content: 'check alpha', status: 'completed', priority: 'high' }], { sessionID: 'ses_a' });
  assert.match(out, /ses_a/);
  assert.match(out, /completed/);
  assert.match(out, /check alpha/);
  assert.match(renderTodos([]), /Nenhum todo/);
});

test('renderRevertPreview shows files, patch and the exact confirmation command', () => {
  const out = renderRevertPreview({
    action: 'revert', sessionID: 'ses_a', messageID: 'msg_3',
    affected: [{ file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '+BETA\n' }],
    command: 'opc session revert ses_a msg_3 --confirmed-by-user',
  });
  assert.match(out, /confirmação necessária \(revert\)/);
  assert.match(out, /notes\.txt/);
  assert.match(out, /\+BETA/);
  assert.match(out, /Nada foi alterado/);
  assert.match(out, /opc session revert ses_a msg_3 --confirmed-by-user/);
  const un = renderRevertPreview({ action: 'unrevert', sessionID: 'ses_a', messageID: 'msg_3', rawDiff: '+BETA\n', command: 'opc session unrevert ses_a --confirmed-by-user' });
  assert.match(un, /unrevert/);
  assert.match(un, /\+BETA/);
  assert.match(renderRevertPreview({ action: 'revert', sessionID: 's', messageID: 'm', affected: [], command: 'c' }), /nenhuma alteração de arquivo/i);
});

test('renderPendingLines: iterates the pendingRequest list (permission and question reply lines, memberId)', () => {
  assert.deepEqual(renderPendingLines({ id: 'sub-1' }), []);
  assert.deepEqual(renderPendingLines({ id: 'sub-1', pendingRequest: [] }), []);
  const perm = renderPendingLines({ id: 'sub-1', pendingRequest: [{ type: 'permission', id: 'per_1', permission: 'bash', patterns: ['npm test'], sessionID: 'ses_c' }] });
  assert.ok(perm.some((l) => l.includes('/opc:permissions reply per_1 once')));
  assert.ok(perm.some((l) => l.includes('/opc:permissions reply per_1 reject')));
  const q = renderPendingLines({ id: 'sub-1', pendingRequest: [{ type: 'question', id: 'que_1', questions: [{ question: 'Qual?' }] }] });
  assert.ok(q.some((l) => l.includes('/opc:permissions answer que_1')));
  const both = renderPendingLines({ id: 'sub-g', pendingRequest: [
    { type: 'permission', id: 'per_2', permission: 'edit', patterns: ['a.txt'], memberId: 'sub-m2' },
    { type: 'question', id: 'que_2', questions: [], memberId: 'sub-m3' },
  ] });
  assert.ok(both.some((l) => l.startsWith('- sub-m2: permissão edit')));
  assert.ok(both.some((l) => l.startsWith('- sub-m3: pergunta que_2')));
});

const group = { id: 'sub-g', kind: 'sub', status: 'running', phase: '1/2 done', sessionID: 'ses_p', result: { counts: { completed: 1, failed: 1 }, warnings: ['1 failed, 0 cancelled'] } };
const members = [
  { id: 'sub-m1', agent: 'general', model: 'p/deepseek', status: 'completed', phase: 'completed', sessionID: 'ses_c1', result: { finalText: 'RESULT one', mechanism: 'child-session', sessionID: 'ses_c1' } },
  { id: 'sub-m2', agent: 'general', model: 'p/kimi', status: 'failed', sessionID: 'ses_c2', errorType: 'ProviderAuthError', errorMessage: 'invalid api key', result: { mechanism: 'subtask', fellBack: true } },
];

test('renderGroupStatus: member table, warnings and cancel hints', () => {
  const out = renderGroupStatus(group, members);
  assert.match(out, /# Grupo sub-g/);
  assert.match(out, /1\/2 done/);
  assert.match(out, /sub-m1/);
  assert.match(out, /p\/kimi/);
  assert.match(out, /Avisos: 1 failed/);
  assert.match(out, /\/opc:cancel sub-g/);
  assert.match(out, /\/opc:status sub-g --wait/);
});

test('renderGroupResult: one section per member with text or error', () => {
  const out = renderGroupResult({ ...group, status: 'completed' }, members);
  assert.match(out, /## #1 general · p\/deepseek — completed/);
  assert.match(out, /RESULT one/);
  assert.match(out, /Erro: ProviderAuthError: invalid api key/);
  assert.match(out, /fallback de child-session/);
});

test('renderCommandResult: text or error', () => {
  assert.match(renderCommandResult({ command: 'echo', arguments: '', sessionID: 'ses_a', model: 'p/m', agent: null, finalText: 'OK' }), /Argumentos: \(nenhum\)[\s\S]*OK/);
  assert.match(renderCommandResult({ command: 'echo', arguments: 'x', sessionID: 'ses_a', model: 'p/m', error: { name: 'ProviderAuthError', data: { message: 'bad' } } }), /Erro: ProviderAuthError: bad/);
});

test('renderAttach: command reads the password from file or env, never inline', () => {
  const file = renderAttach({ url: 'http://127.0.0.1:4100', sessionID: 'ses_a', directory: '/tmp/a b', attached: false, credential: { type: 'file', path: '/data/state/x/attach.secret' } });
  assert.match(file, /OPENCODE_SERVER_PASSWORD="\$\(cat \/data\/state\/x\/attach\.secret\)" opencode attach http:\/\/127\.0\.0\.1:4100 -s ses_a --dir '\/tmp\/a b'/);
  assert.match(file, /\/opc:attach --pane ses_a/);
  const env = renderAttach({ url: 'http://127.0.0.1:4100', sessionID: null, directory: '/ws', attached: true, credential: { type: 'env', name: 'OPC_SERVER_PASSWORD' } });
  assert.match(env, /OPENCODE_SERVER_PASSWORD="\$OPC_SERVER_PASSWORD" opencode attach http:\/\/127\.0\.0\.1:4100 --dir \/ws/);
  assert.match(env, /externo/);
  assert.match(renderAttach({ url: 'u', sessionID: 'ses_a', directory: '/ws', attached: false, credential: { type: 'file', path: '/p' }, pane: { id: '%42' } }), /Pane aberto: %42/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/render-f3.test.mjs`
Expected: FAIL com `shellQuote is not exported`.

- [ ] **Step 3: Implementar `shellQuote` em `lib/args.mjs`**

Acrescente no fim de `plugins/opc/scripts/lib/args.mjs`:

```js
// POSIX single-quote quoting for display and for tmux shell-commands. Safe tokens stay bare.
export function shellQuote(value) {
  const s = String(value);
  if (s !== '' && /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Implementar os renders em `lib/render.mjs`**

Garanta `import { shellQuote } from './args.mjs';` no topo e acrescente no fim:

```js
// --- F3 renderers -----------------------------------------------------------------
const F3_ACTIVE = ['queued', 'running', 'waiting_permission'];
const F3_MAX_INLINE_DIFF = 400 * 1024;

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function oneLine(text, max = 100) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fenceFor(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

const f3Table = (headers, rows) => renderTable(headers, rows).trimEnd();

function messageText(message) {
  return (message.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text ?? '').join(' ');
}

function modelLabel(model) {
  if (!model) return '-';
  if (typeof model === 'string') return model;
  const id = model.modelID ?? model.id;
  return model.providerID && id ? `${model.providerID}/${id}` : '-';
}

function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return { text: String(text), truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function diffBody(diffs, maxInlineBytes) {
  const lines = [f3Table(['Arquivo', 'Status', '+', '-'], diffs.map((d) => [d.file ?? '(desconhecido)', d.status ?? '-', String(d.additions ?? 0), String(d.deletions ?? 0)]))];
  const ordered = diffs.filter((d) => typeof d.patch === 'string' && d.patch.length > 0).sort((a, b) => a.patch.length - b.patch.length);
  let used = 0;
  let omitted = 0;
  const chunks = [];
  for (const d of ordered) {
    const size = Buffer.byteLength(d.patch, 'utf8');
    if (used + size > maxInlineBytes) {
      omitted += 1;
      continue;
    }
    used += size;
    chunks.push(d.patch.endsWith('\n') ? d.patch : `${d.patch}\n`);
  }
  if (chunks.length) {
    const body = chunks.join('').trimEnd();
    const fence = fenceFor(body);
    lines.push('', `${fence}diff`, body, fence);
  }
  if (omitted) lines.push('', `(${omitted} arquivo(s) fora do diff inline: limite de ${Math.round(maxInlineBytes / 1024)} KB)`);
  return lines;
}

export function renderSessions(sessions, { statusMap = {}, title = 'Sessões OPC', hiddenCount = 0 } = {}) {
  if (!sessions.length) return `# ${title}\n\nNenhuma sessão encontrada.\n`;
  const rows = sessions.map((s) => [s.id, s.title ?? '', statusMap[s.id]?.type ?? 'idle', fmtTime(s.time?.updated), s.parentID ?? '-']);
  const lines = [`# ${title}`, '', f3Table(['ID', 'Título', 'Status', 'Atualizada (UTC)', 'Pai'], rows)];
  if (hiddenCount > 0) lines.push('', `(${hiddenCount} sessão(ões) omitida(s); use --limit para ver mais)`);
  return `${lines.join('\n')}\n`;
}

export function renderSession(session, { status = null, messages = [], note = null } = {}) {
  const lines = [`# Sessão ${session.id}`, ''];
  lines.push(`- Título: ${session.title ?? '-'}`);
  lines.push(`- Status: ${status ?? '-'}`);
  lines.push(`- Diretório: ${session.directory ?? '-'}`);
  lines.push(`- Agente: ${session.agent ?? '-'} · Modelo: ${modelLabel(session.model)}`);
  if (session.parentID) lines.push(`- Pai: ${session.parentID}`);
  lines.push(`- Criada: ${fmtTime(session.time?.created)} · Atualizada: ${fmtTime(session.time?.updated)} (UTC)`);
  if (session.summary) lines.push(`- Alterações: +${session.summary.additions} -${session.summary.deletions} em ${session.summary.files} arquivo(s)`);
  if (session.revert?.messageID) {
    lines.push(`- Revert ativo: a partir de ${session.revert.messageID} (desfazer: opc session unrevert ${session.id} --confirmed-by-user)`);
  }
  if (note) lines.push('', note);
  if (messages.length) {
    lines.push('', `## Mensagens (${messages.length})`, '');
    lines.push(f3Table(['#', 'ID', 'Papel', 'Agente/Modelo', 'Texto'], messages.map((m, i) => [
      String(i + 1),
      m.info?.id ?? '-',
      m.info?.role ?? '-',
      m.info?.role === 'assistant' ? `${m.info.agent ?? '-'} · ${m.info.providerID ?? '-'}/${m.info.modelID ?? '-'}${m.info.summary ? ' (resumo)' : ''}` : (m.info?.agent ?? '-'),
      oneLine(messageText(m), 100),
    ])));
  }
  return `${lines.join('\n')}\n`;
}

export function renderSessionDiff(diffs, { maxInlineBytes = F3_MAX_INLINE_DIFF, title = 'Diff da sessão' } = {}) {
  if (!diffs.length) return `# ${title}\n\nNenhuma alteração registrada.\n`;
  return `${[`# ${title}`, '', ...diffBody(diffs, maxInlineBytes)].join('\n')}\n`;
}

export function renderTodos(todos, { sessionID = null } = {}) {
  const heading = `# Todos${sessionID ? ` da sessão ${sessionID}` : ''}`;
  if (!todos.length) return `${heading}\n\nNenhum todo.\n`;
  return `${heading}\n\n${f3Table(['Status', 'Prioridade', 'Tarefa'], todos.map((t) => [t.status ?? '-', t.priority ?? '-', oneLine(t.content, 160)]))}\n`;
}

export function renderRevertPreview({ action, sessionID, messageID = null, affected = [], rawDiff = null, command }) {
  const lines = [`# opc: confirmação necessária (${action})`, ''];
  if (action === 'revert') {
    lines.push(`Sessão ${sessionID} · a partir da mensagem ${messageID}.`);
    lines.push('O revert remove do histórico as mensagens a partir dessa e restaura os arquivos abaixo ao estado anterior:', '');
    if (affected.length) lines.push(...diffBody(affected, F3_MAX_INLINE_DIFF));
    else lines.push('(nenhuma alteração de arquivo registrada para essas mensagens; só o histórico muda)');
  } else {
    lines.push(`Sessão ${sessionID} · revert ativo a partir de ${messageID ?? '-'}.`);
    lines.push('O unrevert devolve as mensagens e reaplica nos arquivos o diff abaixo:', '');
    if (rawDiff) {
      const { text, truncated } = truncateBytes(rawDiff, F3_MAX_INLINE_DIFF);
      const fence = fenceFor(text);
      lines.push(`${fence}diff`, text.trimEnd(), fence);
      if (truncated) lines.push('(diff truncado em 400 KB)');
    } else {
      lines.push('(o OpenCode não informou o diff do revert)');
    }
  }
  lines.push('', 'Nada foi alterado. Confirme com o usuário e só então rode:', '', `    ${command}`);
  return `${lines.join('\n')}\n`;
}

// job.pendingRequest is a list (F2a); in a group each item carries memberId.
export function renderPendingLines(job) {
  return (job?.pendingRequest ?? []).flatMap((req) => {
    const owner = req.memberId ?? job.id;
    if (req.type === 'question') {
      const questions = (req.questions ?? []).map((q) => oneLine(q.question ?? q.header ?? '', 80)).join(' | ');
      return [`- ${owner}: pergunta ${req.id} (${questions || 'sem texto'})`, `  /opc:permissions answer ${req.id} <resposta...>`];
    }
    const patterns = (req.patterns ?? []).join(', ');
    return [
      `- ${owner}: permissão ${req.permission ?? '?'} [${patterns}] (pedido ${req.id}, sessão ${req.sessionID ?? '-'})`,
      `  /opc:permissions reply ${req.id} once`,
      `  /opc:permissions reply ${req.id} reject`,
    ];
  });
}

export function renderGroupStatus(group, members) {
  const lines = [`# Grupo ${group.id} (${group.kind})`, '', `Status: ${group.status} · ${group.phase ?? '-'} · sessão pai ${group.sessionID ?? '-'}`, ''];
  lines.push(f3Table(['#', 'Job', 'Agente', 'Modelo', 'Status', 'Fase', 'Sessão'], members.map((m, i) => [
    String(i + 1), m.id, m.agent ?? '-', modelLabel(m.model), m.status, m.phase ?? '-', m.sessionID ?? '-',
  ])));
  const pending = members.flatMap((m) => renderPendingLines(m));
  if (pending.length) lines.push('', 'Pedidos pendentes:', ...pending);
  const warnings = group.result?.warnings ?? [];
  if (warnings.length) lines.push('', `Avisos: ${warnings.join('; ')}`);
  lines.push('', `Cancelar um membro: /opc:cancel <job> · o grupo inteiro: /opc:cancel ${group.id}`);
  if (F3_ACTIVE.includes(group.status)) lines.push(`Acompanhar: /opc:status ${group.id} --wait`);
  return `${lines.join('\n')}\n`;
}

export function renderGroupResult(group, members) {
  const counts = group.result?.counts ?? {};
  const countText = ['completed', 'failed', 'cancelled'].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ') || '-';
  const lines = [`# Resultado do grupo ${group.id}`, '', `Status: ${group.status} · ${members.length} membro(s): ${countText}`];
  const warnings = group.result?.warnings ?? [];
  if (warnings.length) lines.push(`Avisos: ${warnings.join('; ')}`);
  members.forEach((m, i) => {
    const r = m.result ?? {};
    lines.push('', `## #${i + 1} ${m.agent ?? '-'} · ${modelLabel(m.model)} — ${m.status}`);
    lines.push(`Sessão: ${r.sessionID ?? m.sessionID ?? '-'} (mecanismo ${r.mechanism ?? '-'}${r.fellBack ? ', fallback de child-session' : ''})`);
    if (m.status === 'completed') lines.push('', String(r.finalText ?? '').trim() || '(sem texto final)');
    else if (m.status === 'cancelled') lines.push('', 'Cancelado.');
    else lines.push('', `Erro: ${m.errorType ?? r.errorType ?? m.errorCode ?? 'erro'}: ${m.errorMessage ?? r.errorMessage ?? '(sem mensagem)'}`);
  });
  return `${lines.join('\n')}\n`;
}

export function renderCommandResult(result) {
  const lines = [`# opc command /${result.command}`, ''];
  lines.push(`Argumentos: ${result.arguments ? `\`${result.arguments}\`` : '(nenhum)'}`);
  lines.push(`Sessão: ${result.sessionID ?? '-'} · modelo ${result.model ?? '-'} · agente ${result.agent ?? '(padrão)'}`, '');
  if (result.error) lines.push(`Erro: ${result.error.name ?? 'Error'}: ${result.error.data?.message ?? result.error.message ?? ''}`);
  else lines.push(String(result.finalText ?? '').trim() || '(sem texto final)');
  return `${lines.join('\n')}\n`;
}

export function renderAttach(info) {
  const args = ['opencode', 'attach', info.url, ...(info.sessionID ? ['-s', info.sessionID] : []), '--dir', info.directory].map(shellQuote).join(' ');
  const secret = info.credential?.type === 'file'
    ? `OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(info.credential.path)})"`
    : `OPENCODE_SERVER_PASSWORD="$${info.credential?.name ?? 'OPC_SERVER_PASSWORD'}"`;
  const lines = ['# opc attach', ''];
  lines.push(`Servidor: ${info.url} (${info.attached ? 'externo, via OPC_SERVER_URL' : 'gerenciado pelo opc'})`);
  lines.push(`Sessão: ${info.sessionID ?? '(nenhuma: a TUI abre o seletor)'}`);
  lines.push(`Diretório: ${info.directory}`, '');
  if (info.pane) {
    lines.push(`Pane aberto: ${info.pane.id}. A senha foi lida do arquivo 0600 dentro do pane (não passa por argv).`);
    return `${lines.join('\n')}\n`;
  }
  lines.push('Rode no seu terminal (a senha não aparece na linha de comando; vem', info.credential?.type === 'file' ? 'do arquivo de modo 600 para a variável de ambiente):' : 'da variável OPC_SERVER_PASSWORD que você já usa:', '');
  lines.push(`    ${secret} ${args}`, '');
  if (!info.attached) lines.push(`Dentro do tmux: /opc:attach --pane${info.sessionID ? ` ${info.sessionID}` : ''}`);
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/render-f3.test.mjs`
Expected: PASS (11 testes). Se `renderTable` não escapar `|` (contrato F0 diz que escapa),
o teste do título falha: corrija no F3 só se o contrato estiver sendo violado, registrando.

- [ ] **Step 6: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/opc/scripts/lib/args.mjs plugins/opc/scripts/lib/render.mjs tests/unit/render-f3.test.mjs
git commit -m "feat: add session, group, command and attach renderers"
```

---

### Task 4: Conexão, descoberta e política em `lib/context.mjs`; comando `sessions`

**Files:**
- Modify: `plugins/opc/scripts/lib/context.mjs` (acrescentar no fim)
- Create: `plugins/opc/scripts/commands/sessions.mjs`
- Test: `tests/unit/context-f3.test.mjs`, `tests/integration/sessions.test.mjs`

**Interfaces:**
- Consumes: `connectApi(ctx)` → `{ api, server, client }` (F1, com o `serverContext` da F2a dentro); `ensureServer(ctx)` (F0); `createClient` (F0, `lib/http.mjs`); `serverContext(ctx)` (F2a); `createApi` (Task 2); `EventHub` (F0); `listJobs`, `ACTIVE_STATUSES` (F2a, só no `sessions.mjs`); `buildCatalog` (F1); `assertAgentUsable` (F1), `buildPermissionRules` (F2a); `resolveCandidates`, `validateSelection` (F2a, `lib/routing.mjs`); `renderSessions` (Task 3); helpers da Task 1.
- Produces: `openApi(ctx, { withHub, respawn })`, `loadDiscovery(api)`, `resolveModel(ctx, discovery, kind, modelInput, { variant })` (candidato + `variant` conferido), `requireAgent(discovery, name, policy, { modes })`, `profileRules(ctx, profile, extra)`; subcomando `sessions` com `isOpcSession(session, workspaceRoot)`.

- [ ] **Step 1: Escrever o teste unitário do contexto (falha)**

Create `tests/unit/context-f3.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAgent, resolveModel, profileRules } from '../../plugins/opc/scripts/lib/context.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';
import { F3_PROVIDERS, F3_AGENTS, F3_OPENCODE_CONFIG, F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';

const config = { ...DEFAULT_CONFIG, ...F3_TEST_CONFIG };
const ctx = { config, err: () => {} };
const discovery = { catalog: buildCatalog(F3_PROVIDERS), opencodeConfig: F3_OPENCODE_CONFIG, agents: F3_AGENTS };
const policy = config.policy;

test('requireAgent: existence, mode, policy and pinned model', () => {
  assert.equal(requireAgent(discovery, 'general', policy, { modes: ['subagent', 'all'] }).name, 'general');
  assert.throws(() => requireAgent(discovery, 'build', policy, { modes: ['subagent', 'all'] }), (e) => e.exitCode === 2 && e.code === 'AGENT_MODE');
  assert.throws(() => requireAgent(discovery, 'nope', policy), (e) => e.exitCode === 2 && e.code === 'UNKNOWN_AGENT');
  assert.throws(() => requireAgent(discovery, 'work-secret', policy), (e) => e.exitCode === 4);
  assert.throws(() => requireAgent(discovery, 'pinned-sub', policy), (e) => e.exitCode === 4);
});

test('resolveModel: alias, default and policy denial', () => {
  assert.equal(resolveModel(ctx, discovery, 'task', 'strong').full, F3_MODELS.qwen);
  assert.equal(resolveModel(ctx, discovery, 'task', null).full, F3_MODELS.deepseek);
  assert.throws(() => resolveModel(ctx, discovery, 'task', F3_MODELS.denied), (e) => e.exitCode === 4);
});

test('resolveModel checks the variant through F2a validateSelection (F1 validateVariant)', () => {
  assert.equal(resolveModel(ctx, discovery, 'task', 'fast').variant, null);
  assert.throws(() => resolveModel(ctx, discovery, 'task', 'fast', { variant: 'no-such-variant' }), (e) => e.exitCode === 2 && e.code === 'UNKNOWN_VARIANT');
});

test('profileRules: read-only starts with deny-all; extra rules go last', () => {
  const rules = profileRules(ctx, 'read-only', [{ permission: 'task', pattern: 'explore', action: 'allow' }]);
  assert.deepEqual(rules[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.deepEqual(rules.at(-1), { permission: 'task', pattern: 'explore', action: 'allow' });
  assert.ok(profileRules(ctx, 'write').some((r) => r.permission === 'external_directory' && r.action === 'deny'));
});
```

- [ ] **Step 2: Escrever o teste de integração do `sessions` (falha)**

Create `tests/integration/sessions.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, stateDirFor } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { createJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';

async function setup(t, { scenario = 'f3-sessions', config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, config); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

test('sessions: default lists only root OPC sessions of the workspace', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['sessions', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.sessions.map((s) => s.id), [SEED.session]);
  assert.equal(out.filtered, true);
  const text = await runCli(['sessions'], { env, cwd });
  assert.match(text.stdout, /# Sessões OPC/);
  assert.match(text.stdout, /ses_seed/);
  assert.doesNotMatch(text.stdout, /ses_user/);
});

test('sessions --all shows every session; --limit trims', async (t) => {
  const { cwd, env } = await setup(t);
  const all = JSON.parse((await runCli(['sessions', '--all', '--json'], { env, cwd })).stdout);
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), [SEED.session, SEED.userSession].sort());
  const one = JSON.parse((await runCli(['sessions', '--all', '--limit', '1', '--json'], { env, cwd })).stdout);
  assert.equal(one.sessions.length, 1);
  assert.equal(one.total, 2);
});

test('sessions --refresh disposes the instance', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['sessions', '--refresh', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/instance/dispose').length, 1);
});

test('sessions --refresh is refused while a job is active', async (t) => {
  const { cwd, env } = await setup(t);
  const stateDir = await stateDirFor(env, cwd);
  ensurePrivateDir(stateDir);
  const job = await createJob(stateDir, { kind: 'task', title: 'active', status: 'running', workspaceRoot: cwd });
  const res = await runCli(['sessions', '--refresh'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, new RegExp(job.id));
  assert.equal(fakeRequests(env).filter((r) => r.path === '/instance/dispose').length, 0);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/context-f3.test.mjs tests/integration/sessions.test.mjs`
Expected: FAIL (`requireAgent is not exported`; subcomando `sessions` desconhecido → exit 2).

- [ ] **Step 4: Implementar os helpers em `lib/context.mjs`**

Acrescente no topo os imports que faltarem e, no fim do arquivo:

```js
import { ensureServer } from './server.mjs';
import { createClient } from './http.mjs';
import { createApi } from './api.mjs';
import { EventHub } from './sse.mjs';
import { buildCatalog } from './models.mjs';
import { assertAgentUsable, buildPermissionRules } from './policy.mjs';
import { resolveCandidates, validateSelection } from './routing.mjs';
import { UsageError } from './opc-error.mjs';

// --- F3: connection, discovery and policy helpers shared by the F3 commands ------------

// respawn: true (foreground commands) → F1 connectApi (serverContext of F2a inside, client with
// onServerDown). respawn: false (workers/coordinators) → never bring up another server mid-turn
// (F2a D9): same server context, client WITHOUT onServerDown.
export async function openApi(ctx, { withHub = false, respawn = true } = {}) {
  let server;
  let client;
  let api;
  if (respawn) {
    ({ api, server, client } = await connectApi(ctx));
  } else {
    const { serverContext } = await import('./jobs.mjs'); // dynamic: jobs.mjs ↔ context.mjs stay acyclic
    server = await ensureServer(serverContext(ctx));
    client = createClient({
      baseUrl: server.url,
      password: server.password,
      directory: ctx.workspaceRoot,
      requestTimeoutMs: (ctx.config?.server?.requestTimeoutSec ?? 30) * 1000,
    });
    api = createApi(client);
  }
  let hub = null;
  if (withHub) {
    hub = new EventHub({ client });
    await hub.start();
  }
  return { server, client, api, hub, close() { hub?.stop(); } };
}

export async function loadDiscovery(api) {
  const [providers, opencodeConfig, agents] = await Promise.all([api.providers(), api.getConfig(), api.agents()]);
  return { catalog: buildCatalog(providers), opencodeConfig, agents: agents ?? [] };
}

// No logic of its own: F2a resolveCandidates (level, alias, policy, connected provider) +
// F2a validateSelection (variant via F1 validateVariant → UNKNOWN_VARIANT). Returns the first
// candidate with the checked variant.
export function resolveModel(ctx, discovery, kind, modelInput, { variant = null } = {}) {
  const flags = modelInput ? { model: modelInput } : {};
  const { candidates, warnings } = resolveCandidates({ kind, flags, config: ctx.config, catalog: discovery.catalog, opencodeConfig: discovery.opencodeConfig });
  for (const warning of warnings ?? []) ctx.err(`[opc] ${warning}\n`);
  const candidate = candidates[0];
  const selection = validateSelection({ candidate, variant, catalog: discovery.catalog, policy: ctx.config.policy ?? {} });
  return { ...candidate, variant: selection.variant };
}

// Exists? + mode + F1 assertAgentUsable (agent name and pinned provider/model by policy).
export function requireAgent(discovery, name, policy, { modes = null } = {}) {
  const agent = discovery.agents.find((a) => a.name === name);
  if (!agent) throw new UsageError('UNKNOWN_AGENT', `agente desconhecido: ${name} (veja /opc:agents)`);
  if (modes && !modes.includes(agent.mode)) {
    throw new UsageError('AGENT_MODE', `o agente ${name} tem modo "${agent.mode}"; aqui só ${modes.join(' ou ')} (para agentes primários use /opc:task --agent)`);
  }
  assertAgentUsable(agent, policy);
  return agent;
}

export function profileRules(ctx, profile, extra = []) {
  const policy = ctx.config.policy ?? {};
  const base = buildPermissionRules(profile, {
    policy,
    permissionProfiles: ctx.config.permissionProfiles ?? {},
    deniedAgentGlobs: policy.agents?.deny ?? [],
  });
  return [...base, ...extra];
}
```

(Se o arquivo já importa algum desses símbolos, não duplique o import. `connectApi` é a do
próprio `context.mjs` (F1, que devolve `{ api, server, client }` e já usa o `serverContext` da
F2a, com `hasActiveJobs`); por isso não há `hasActiveJobs` inline aqui. O `serverContext` do
ramo `respawn: false` vem por `import()` dinâmico de `jobs.mjs`, como na `connectApi`.)

- [ ] **Step 5: Implementar `scripts/commands/sessions.mjs`**

```js
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi } from '../lib/context.mjs';
import { listJobs, ACTIVE_STATUSES, topLevelJobs } from '../lib/jobs.mjs';
import { renderSessions } from '../lib/render.mjs';

const SPEC = {
  flags: {
    all: { type: 'boolean' },
    limit: { type: 'number', default: 30 },
    refresh: { type: 'boolean' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
};

export function isOpcSession(session, workspaceRoot) {
  return typeof session.title === 'string'
    && session.title.startsWith('OPC: ')
    && !session.parentID
    && (!session.directory || session.directory === workspaceRoot);
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const conn = await openApi(ctx);
  try {
    const { api, server } = conn;
    if (flags.refresh) {
      if (server.attached) {
        throw new UsageError('REFRESH_ATTACHED', '--refresh descarta a instância do servidor e não é permitido num servidor externo (OPC_SERVER_URL)');
      }
      const active = topLevelJobs(listJobs(ctx.stateDir, { all: true })).filter((j) => ACTIVE_STATUSES.includes(j.status));
      if (active.length) {
        throw new UsageError('ACTIVE_JOBS', `--refresh recusado: há jobs ativos (${active.map((j) => j.id).join(', ')}); aguarde ou cancele`);
      }
      await api.dispose();
    }
    const [all, statusMap] = await Promise.all([api.listSessions(), api.sessionStatus()]);
    const list = (all ?? [])
      .filter((s) => flags.all || isOpcSession(s, ctx.workspaceRoot))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    const shown = list.slice(0, Math.max(1, flags.limit));
    if (flags.json) {
      ctx.json({ sessions: shown, total: list.length, filtered: !flags.all });
    } else {
      ctx.out(renderSessions(shown, {
        statusMap: statusMap ?? {},
        title: flags.all ? 'Sessões do workspace (todas)' : 'Sessões OPC',
        hiddenCount: list.length - shown.length,
      }));
    }
    return ExitCode.OK;
  } finally {
    conn.close();
  }
}
```

`topLevelJobs` chega na Task 7. Para esta tarefa passar isolada, acrescente **já** em
`lib/jobs.mjs` (a Task 7 mantém exatamente este código):

```js
export function isGroupMember(job) {
  return Boolean(job && job.groupId);
}

export function topLevelJobs(jobs) {
  return jobs.filter((job) => !isGroupMember(job));
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/unit/context-f3.test.mjs tests/integration/sessions.test.mjs`
Expected: PASS (4 + 4 testes).

- [ ] **Step 7: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/opc/scripts/lib/context.mjs plugins/opc/scripts/lib/jobs.mjs plugins/opc/scripts/commands/sessions.mjs tests/unit/context-f3.test.mjs tests/integration/sessions.test.mjs
git commit -m "feat: add sessions command and shared connection/discovery helpers"
```

---
### Task 5: `session new | show | fork | children | diff | todo`

**Files:**
- Create: `plugins/opc/scripts/commands/session.mjs`
- Test: `tests/integration/session-actions.test.mjs`

**Interfaces:**
- Consumes: `openApi`, `loadDiscovery`, `resolveModel`, `requireAgent`, `profileRules` (Task 4); `assertId` e métodos F3 da api (Task 2); `renderSession`, `renderSessions`, `renderSessionDiff`, `renderTodos` (Task 3); F1 `getSession`, `sessionStatus`, `messages`, `children`, `todo`.
- Produces: subcomando `session` com `ACTIONS` (a Task 6 acrescenta `revert`, `unrevert`, `summarize`); formatos `--json`: `new`/`show` → `{ session, status?, messages? }`; `fork` → `{ session, forkedFrom: { sessionID, messageID } }`; `children` → `{ sessionID, children }`; `diff` → `{ sessionID, messageID, diffs }`; `todo` → `{ sessionID, todos }`.

- [ ] **Step 1: Escrever o teste de integração (falha)**

Create `tests/integration/session-actions.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';

async function setup(t, { scenario = 'f3-sessions', extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, F3_TEST_CONFIG); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const posts = (env, path) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === path);

test('session new: title prefix, agent, model {id, providerID} and read-only rules', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'new', '--title', 'meu teste', '--agent', 'build', '--model', 'strong', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const { session } = JSON.parse(res.stdout);
  assert.equal(session.title, 'OPC: session: meu teste');
  const body = posts(env, '/session').at(-1).body;
  assert.equal(body.title, 'OPC: session: meu teste');
  assert.equal(body.agent, 'build');
  assert.deepEqual(body.model, { id: 'opencode-go/qwen3.8-max', providerID: 'omniroute-mvalmeida' });
  assert.deepEqual(body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('session new --write sends write rules (no deny-all first rule)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'new', '--write', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const body = posts(env, '/session').at(-1).body;
  assert.equal(body.title, 'OPC: session: manual');
  assert.notDeepEqual(body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.ok(body.permission.some((r) => r.permission === 'external_directory' && r.action === 'deny'));
});

test('session new refuses a denied agent (exit 4) and an unknown one (exit 2) before creating', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['session', 'new', '--agent', 'work-secret'], { env, cwd })).code, 4);
  assert.equal((await runCli(['session', 'new', '--agent', 'nope'], { env, cwd })).code, 2);
  assert.equal((await runCli(['session', 'new', '--model', 'omniroute-work/cx/gpt-5.5'], { env, cwd })).code, 4);
  assert.equal(posts(env, '/session').length, 0);
});

test('session show: session, status and messages with ids', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'show', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.session.id, SEED.session);
  assert.equal(out.status, 'idle');
  assert.deepEqual(out.messages.map((m) => m.info.id), [SEED.m1, SEED.m2, SEED.m3, SEED.m4]);
  const text = await runCli(['session', 'show', SEED.session], { env, cwd });
  assert.match(text.stdout, /# Sessão ses_seed/);
  assert.match(text.stdout, /msg_seed_003/);
  assert.equal((await runCli(['session', 'show', 'ses_missing'], { env, cwd })).code, 2);
});

test('session fork: body with and without messageID; forked history stops before the message', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'fork', SEED.session, SEED.m3, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.forkedFrom, { sessionID: SEED.session, messageID: SEED.m3 });
  assert.deepEqual(posts(env, `/session/${SEED.session}/fork`)[0].body, { messageID: SEED.m3 });
  const shown = JSON.parse((await runCli(['session', 'show', out.session.id, '--json'], { env, cwd })).stdout);
  assert.equal(shown.messages.length, 2);
  assert.equal((await runCli(['session', 'fork', SEED.session], { env, cwd })).code, 0);
  assert.deepEqual(posts(env, `/session/${SEED.session}/fork`)[1].body, {});
});

test('session children lists child sessions', async (t) => {
  const { cwd, env } = await setup(t, { scenario: 'children' });
  const res = await runCli(['session', 'children', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.children.length, 2);
  assert.ok(out.children.every((c) => c.parentID === SEED.session));
  assert.match((await runCli(['session', 'children', SEED.session], { env, cwd })).stdout, /Filhas de ses_seed/);
});

test('session diff: whole session, per message, and huge diffs truncated inline', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_HUGE_DIFF: '1' } });
  const whole = JSON.parse((await runCli(['session', 'diff', SEED.session, '--json'], { env, cwd })).stdout);
  assert.ok(whole.diffs.some((d) => d.file === 'notes.txt'));
  const perMessage = JSON.parse((await runCli(['session', 'diff', SEED.session, '--message', SEED.m3, '--json'], { env, cwd })).stdout);
  assert.deepEqual(perMessage.diffs.map((d) => d.file), ['notes.txt', 'extra.txt']);
  const diffReq = fakeRequests(env).filter((r) => r.path === `/session/${SEED.session}/diff`);
  assert.equal(diffReq.at(-1).query.messageID, SEED.m3);
  const text = await runCli(['session', 'diff', SEED.session], { env, cwd });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /fora do diff inline/);
  assert.ok(Buffer.byteLength(text.stdout) < 450 * 1024);
});

test('session todo lists todos', async (t) => {
  const { cwd, env } = await setup(t);
  const out = JSON.parse((await runCli(['session', 'todo', SEED.session, '--json'], { env, cwd })).stdout);
  assert.equal(out.todos.length, 2);
  assert.match((await runCli(['session', 'todo', SEED.session], { env, cwd })).stdout, /check beta/);
});

test('session: unknown action and missing id are usage errors', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['session', 'explode'], { env, cwd })).code, 2);
  assert.equal((await runCli(['session', 'show'], { env, cwd })).code, 2);
});

test('rejects malformed ids without contacting the server', async (t) => {
  const { cwd, env } = await setup(t);
  for (const args of [
    ['session', 'show', 'ses_x/../../global/dispose'],
    ['session', 'fork', SEED.session, 'msg$(id)'],
    ['session', 'todo', 'msg_wrong_prefix'],
    ['session', 'diff', SEED.session, '--message', 'nope'],
  ]) {
    const res = await runCli(args, { env, cwd });
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.stdout + res.stderr, /id inválido/);
  }
  let started = true;
  try { readFakeState(env); } catch { started = false; }
  assert.ok(!started || fakeRequests(env).every((r) => !r.path.startsWith('/session')), 'no session request expected');
  assert.equal(existsSync(`${cwd}/pwned`), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/session-actions.test.mjs`
Expected: FAIL (subcomando `session` desconhecido → exit 2 em todos).

- [ ] **Step 3: Implementar `scripts/commands/session.mjs`**

```js
import { join } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, resolveModel, requireAgent, profileRules } from '../lib/context.mjs';
import { assertId } from '../lib/api.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderSession, renderSessions, renderSessionDiff, renderTodos, renderRevertPreview } from '../lib/render.mjs';

const SPEC = {
  flags: {
    title: { type: 'string' },
    agent: { type: 'string' },
    model: { type: 'string', alias: 'm' },
    write: { type: 'boolean' },
    limit: { type: 'number', default: 20 },
    part: { type: 'string' },
    message: { type: 'string' },
    'confirmed-by-user': { type: 'boolean' },
    timeout: { type: 'number' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
  allowPositionals: true,
};

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

async function actionNew(ctx, api, { flags }) {
  const policy = ctx.config.policy ?? {};
  const body = {
    title: `OPC: session: ${oneLine(flags.title || 'manual').slice(0, 72)}`,
    permission: profileRules(ctx, flags.write ? 'write' : 'read-only'),
  };
  if (flags.agent || flags.model) {
    const discovery = await loadDiscovery(api);
    if (flags.agent) body.agent = requireAgent(discovery, flags.agent, policy).name;
    if (flags.model) {
      const model = resolveModel(ctx, discovery, 'task', flags.model);
      body.model = { id: model.modelID, providerID: model.providerID };
    }
  }
  const session = await api.createSession(body);
  if (flags.json) ctx.json({ session });
  else ctx.out(renderSession(session, { note: `Continue com: /opc:task --resume ${session.id} <prompt> · veja na TUI: /opc:attach ${session.id}` }));
  return ExitCode.OK;
}

async function actionShow(ctx, api, { flags, sessionID }) {
  const [session, statusMap, messages] = await Promise.all([
    api.getSession(sessionID),
    api.sessionStatus(),
    api.messages(sessionID, { limit: flags.limit }),
  ]);
  const status = statusMap?.[sessionID]?.type ?? 'idle';
  if (flags.json) ctx.json({ session, status, messages });
  else ctx.out(renderSession(session, { status, messages: messages ?? [] }));
  return ExitCode.OK;
}

async function actionFork(ctx, api, { flags, sessionID, rest }) {
  const messageID = rest[1] ? assertId('msg', rest[1], 'mensagem') : undefined;
  const forked = await api.fork(sessionID, { messageID });
  if (flags.json) ctx.json({ session: forked, forkedFrom: { sessionID, messageID: messageID ?? null } });
  else ctx.out(renderSession(forked, { note: `Fork de ${sessionID}${messageID ? `, com o histórico anterior a ${messageID}` : ''}.` }));
  return ExitCode.OK;
}

async function actionChildren(ctx, api, { flags, sessionID }) {
  const children = (await api.children(sessionID)) ?? [];
  if (flags.json) ctx.json({ sessionID, children });
  else ctx.out(renderSessions(children, { title: `Filhas de ${sessionID}` }));
  return ExitCode.OK;
}

async function actionDiff(ctx, api, { flags, sessionID }) {
  const messageID = flags.message ? assertId('msg', flags.message, 'mensagem') : undefined;
  const diffs = (await api.diff(sessionID, { messageID })) ?? [];
  if (flags.json) ctx.json({ sessionID, messageID: messageID ?? null, diffs });
  else ctx.out(renderSessionDiff(diffs, { title: `Diff da sessão ${sessionID}${messageID ? ` (mensagem ${messageID})` : ''}` }));
  return ExitCode.OK;
}

async function actionTodo(ctx, api, { flags, sessionID }) {
  const todos = (await api.todo(sessionID)) ?? [];
  if (flags.json) ctx.json({ sessionID, todos });
  else ctx.out(renderTodos(todos, { sessionID }));
  return ExitCode.OK;
}

const ACTIONS = {
  new: actionNew,
  show: actionShow,
  fork: actionFork,
  children: actionChildren,
  diff: actionDiff,
  todo: actionTodo,
};

// Validates every id before connecting, so malformed input never reaches the server.
function validateIds(action, rest, flags) {
  if (action === 'new') return null;
  if (!rest[0]) throw new UsageError('MISSING_ID', `session ${action} exige <sessionID>`);
  const sessionID = assertId('ses', rest[0], 'sessão');
  if (rest[1] && ['fork', 'revert'].includes(action)) assertId('msg', rest[1], 'mensagem');
  if (flags.message) assertId('msg', flags.message, 'mensagem');
  if (flags.part) assertId('prt', flags.part, 'parte');
  return sessionID;
}

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const [action, ...rest] = positionals;
  const handler = ACTIONS[action];
  if (!handler) throw new UsageError('UNKNOWN_ACTION', `ação desconhecida: ${action ?? '(vazia)'}. Use: ${Object.keys(ACTIONS).join(', ')}`);
  const sessionID = validateIds(action, rest, flags);
  const conn = await openApi(ctx);
  try {
    return await handler(ctx, conn.api, { flags, sessionID, rest });
  } finally {
    conn.close();
  }
}
```

(Os imports `join`, `tryAcquireLock` e `renderRevertPreview` já ficam no arquivo; a Task 6 os usa.)

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/integration/session-actions.test.mjs`
Expected: PASS (10 testes). `session show ses_missing` → a api lança `NotFoundError` (exit 2).

- [ ] **Step 5: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/commands/session.mjs tests/integration/session-actions.test.mjs
git commit -m "feat: add session new/show/fork/children/diff/todo"
```

---

### Task 6: `session revert | unrevert | summarize` com confirmação, lock e diff afetado

**Files:**
- Modify: `plugins/opc/scripts/commands/session.mjs`
- Test: `tests/unit/session-guard.test.mjs`, `tests/integration/session-revert.test.mjs`

**Interfaces:**
- Consumes: `tryAcquireLock(lockPath, { purpose })` (F0); `api.revert/unrevert/summarize/diff/messages/getSession/sessionStatus`; `renderRevertPreview`, `renderSession` (Task 3); `resolveModel(ctx, discovery, 'summarize', model)` (Task 4).
- Produces: `collectAffectedDiff(api, sessionID, messageID)` → `SnapshotFileDiff[]` (mesclado por arquivo); `withSessionGuard(ctx, api, sessionID, fn)`; ações `revert`, `unrevert`, `summarize`. Formatos `--json`: sem confirmação `{ confirmed: false, action, sessionID, messageID, affected | rawDiff, command }` (exit 2); com confirmação `{ confirmed: true, action, session }`; summarize `{ sessionID, model, summarized: true }`.

- [ ] **Step 1: Escrever o teste unitário do guarda e do diff afetado (falha)**

Create `tests/unit/session-guard.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSessionGuard, collectAffectedDiff } from '../../plugins/opc/scripts/commands/session.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';

function tmpState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('withSessionGuard refuses a busy session and releases the lock', async (t) => {
  const stateDir = tmpState(t);
  const api = { sessionStatus: async () => ({ ses_a: { type: 'busy' } }) };
  await assert.rejects(withSessionGuard({ stateDir }, api, 'ses_a', async () => 'ran'), (e) => e.code === 'SESSION_BUSY' && e.exitCode === 2);
  const release = tryAcquireLock(join(stateDir, 'session-ses_a.lock'), { purpose: 'test' });
  assert.ok(release, 'lock must be released after the refusal');
  release();
});

test('withSessionGuard refuses when another holder owns the session lock', async (t) => {
  const stateDir = tmpState(t);
  const release = tryAcquireLock(join(stateDir, 'session-ses_a.lock'), { purpose: 'job' });
  t.after(() => release());
  const api = { sessionStatus: async () => ({}) };
  await assert.rejects(withSessionGuard({ stateDir }, api, 'ses_a', async () => 'ran'), (e) => e.code === 'SESSION_IN_USE');
});

test('withSessionGuard runs fn for an idle session', async (t) => {
  const stateDir = tmpState(t);
  const api = { sessionStatus: async () => ({ ses_a: { type: 'idle' } }) };
  assert.equal(await withSessionGuard({ stateDir }, api, 'ses_a', async () => 'ran'), 'ran');
});

test('collectAffectedDiff merges per-file diffs from the target message onward', async () => {
  const calls = [];
  const api = {
    messages: async () => [
      { info: { id: 'msg_1', role: 'user' } }, { info: { id: 'msg_2', role: 'assistant', parentID: 'msg_1' } },
      { info: { id: 'msg_3', role: 'user' } }, { info: { id: 'msg_4', role: 'assistant', parentID: 'msg_3' } },
    ],
    diff: async (_id, { messageID }) => {
      calls.push(messageID);
      return messageID === 'msg_1'
        ? [{ file: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '+A' }]
        : [{ file: 'a.txt', status: 'modified', additions: 2, deletions: 1, patch: '+B' }, { file: 'b.txt', status: 'added', additions: 1, deletions: 0, patch: '+C' }];
    },
  };
  const fromFirst = await collectAffectedDiff(api, 'ses_a', 'msg_1');
  assert.deepEqual(calls, ['msg_1', 'msg_3']);
  assert.deepEqual(fromFirst.find((d) => d.file === 'a.txt'), { file: 'a.txt', status: 'modified', additions: 3, deletions: 1, patch: '+A\n+B' });
  calls.length = 0;
  await collectAffectedDiff(api, 'ses_a', 'msg_4');
  assert.deepEqual(calls, ['msg_3'], 'assistant target includes its parent user message');
  await assert.rejects(collectAffectedDiff(api, 'ses_a', 'msg_9'), (e) => e.code === 'UNKNOWN_MESSAGE' && e.exitCode === 2);
});
```

- [ ] **Step 2: Escrever o teste de integração (falha)**

Create `tests/integration/session-revert.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, stateDirFor } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';

async function setup(t) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions' });
  writeGlobalConfig(env, F3_TEST_CONFIG); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const posts = (env, path) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === path);

test('revert without --confirmed-by-user: exit 2, affected diff and instruction, nothing reverted', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /confirmação necessária \(revert\)/);
  assert.match(res.stdout, /notes\.txt/);
  assert.match(res.stdout, /extra\.txt/);
  assert.match(res.stdout, /\+BETA/);
  assert.match(res.stdout, /opc session revert ses_seed msg_seed_003 --confirmed-by-user/);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
  const json = await runCli(['session', 'revert', SEED.session, SEED.m3, '--json'], { env, cwd });
  assert.equal(json.code, 2);
  const out = JSON.parse(json.stdout);
  assert.equal(out.confirmed, false);
  assert.deepEqual(out.affected.map((d) => d.file).sort(), ['extra.txt', 'notes.txt']);
});

test('revert with --confirmed-by-user posts {messageID, partID?} and shows the revert marker', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(posts(env, `/session/${SEED.session}/revert`)[0].body, { messageID: SEED.m3 });
  assert.equal(JSON.parse(res.stdout).session.revert.messageID, SEED.m3);
  const withPart = await runCli(['session', 'revert', SEED.session, SEED.m1, '--part', 'prt_seed_001', '--confirmed-by-user'], { env, cwd });
  assert.equal(withPart.code, 0, withPart.stderr);
  assert.deepEqual(posts(env, `/session/${SEED.session}/revert`)[1].body, { messageID: SEED.m1, partID: 'prt_seed_001' });
  assert.match(withPart.stdout, /Revert aplicado/);
});

test('unknown message is refused before any revert', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, 'msg_not_here', '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /não pertence à sessão/);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
});

test('revert rejects a message id with path characters', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, 'msg_1/../x', '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
});

test('refuses when the session lock is held (active job on the session)', async (t) => {
  const { cwd, env } = await setup(t);
  const stateDir = await stateDirFor(env, cwd);
  ensurePrivateDir(stateDir);
  const release = tryAcquireLock(join(stateDir, `session-${SEED.session}.lock`), { purpose: 'job test' });
  t.after(() => release());
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /em uso/);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
});

test('unrevert: nothing to undo → exit 2; preview shows revert diff; confirmed posts unrevert', async (t) => {
  const { cwd, env } = await setup(t);
  const none = await runCli(['session', 'unrevert', SEED.session], { env, cwd });
  assert.equal(none.code, 2);
  assert.match(none.stdout + none.stderr, /não tem revert ativo/);
  assert.equal((await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user'], { env, cwd })).code, 0);
  const preview = await runCli(['session', 'unrevert', SEED.session], { env, cwd });
  assert.equal(preview.code, 2);
  assert.match(preview.stdout, /confirmação necessária \(unrevert\)/);
  assert.match(preview.stdout, /\+BETA/);
  assert.match(preview.stdout, /opc session unrevert ses_seed --confirmed-by-user/);
  assert.equal(posts(env, `/session/${SEED.session}/unrevert`).length, 0);
  const done = await runCli(['session', 'unrevert', SEED.session, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(posts(env, `/session/${SEED.session}/unrevert`).length, 1);
  assert.equal(JSON.parse(done.stdout).session.revert, undefined);
});

test('summarize: model from --model (alias) or routing; denied model refused', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'summarize', SEED.session, '--model', 'strong', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(posts(env, `/session/${SEED.session}/summarize`)[0].body, { providerID: 'omniroute-mvalmeida', modelID: 'opencode-go/qwen3.8-max' });
  assert.equal(JSON.parse(res.stdout).model, 'omniroute-mvalmeida/opencode-go/qwen3.8-max');
  assert.equal((await runCli(['session', 'summarize', SEED.session], { env, cwd })).code, 0);
  assert.deepEqual(posts(env, `/session/${SEED.session}/summarize`)[1].body, { providerID: 'omniroute-mvalmeida', modelID: 'opencode-go/deepseek-v4.1-flash' });
  assert.equal((await runCli(['session', 'summarize', SEED.session, '--model', 'omniroute-work/cx/gpt-5.5'], { env, cwd })).code, 4);
  assert.equal(posts(env, `/session/${SEED.session}/summarize`).length, 2);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/session-guard.test.mjs tests/integration/session-revert.test.mjs`
Expected: FAIL (`withSessionGuard is not exported`; ação `revert` desconhecida).

- [ ] **Step 4: Implementar em `session.mjs`**

Acrescente, antes de `const ACTIONS`:

```js
const MAX_DIFF_MESSAGES = 50;
const DEFAULT_SUMMARIZE_TIMEOUT_SEC = 600;

export async function withSessionGuard(ctx, api, sessionID, fn) {
  const release = tryAcquireLock(join(ctx.stateDir, `session-${sessionID}.lock`), { purpose: 'session-op' });
  if (!release) {
    throw new UsageError('SESSION_IN_USE', `a sessão ${sessionID} está em uso por um job ativo; aguarde (/opc:status) ou cancele (/opc:cancel)`);
  }
  try {
    const status = (await api.sessionStatus())?.[sessionID];
    if (status && status.type !== 'idle') {
      throw new UsageError('SESSION_BUSY', `a sessão ${sessionID} está ocupada (${status.type}); tente de novo quando ficar ociosa`);
    }
    return await fn();
  } finally {
    release();
  }
}

export async function collectAffectedDiff(api, sessionID, messageID) {
  const messages = (await api.messages(sessionID)) ?? [];
  const index = messages.findIndex((m) => m.info?.id === messageID);
  if (index < 0) throw new UsageError('UNKNOWN_MESSAGE', `a mensagem ${messageID} não pertence à sessão ${sessionID}`);
  const target = messages[index].info;
  const ids = [];
  if (target.role === 'assistant' && target.parentID) ids.push(target.parentID);
  for (const m of messages.slice(index)) if (m.info?.role === 'user' && !ids.includes(m.info.id)) ids.push(m.info.id);
  const byFile = new Map();
  for (const id of ids.slice(0, MAX_DIFF_MESSAGES)) {
    for (const d of (await api.diff(sessionID, { messageID: id })) ?? []) {
      const key = d.file ?? '(desconhecido)';
      const prev = byFile.get(key);
      if (!prev) {
        byFile.set(key, { ...d });
        continue;
      }
      byFile.set(key, {
        ...prev,
        additions: (prev.additions ?? 0) + (d.additions ?? 0),
        deletions: (prev.deletions ?? 0) + (d.deletions ?? 0),
        patch: [prev.patch, d.patch].filter(Boolean).join('\n'),
        status: prev.status === 'added' ? 'added' : (d.status ?? prev.status),
      });
    }
  }
  return [...byFile.values()];
}

async function actionRevert(ctx, api, { flags, sessionID, rest }) {
  if (!rest[1]) throw new UsageError('MISSING_MESSAGE_ID', 'session revert exige <sessionID> <messageID>');
  const messageID = assertId('msg', rest[1], 'mensagem');
  const partID = flags.part ? assertId('prt', flags.part, 'parte') : undefined;
  return withSessionGuard(ctx, api, sessionID, async () => {
    const affected = await collectAffectedDiff(api, sessionID, messageID);
    if (!flags['confirmed-by-user']) {
      const command = `opc session revert ${sessionID} ${messageID}${partID ? ` --part ${partID}` : ''} --confirmed-by-user`;
      if (flags.json) ctx.json({ confirmed: false, action: 'revert', sessionID, messageID, affected, command });
      else ctx.out(renderRevertPreview({ action: 'revert', sessionID, messageID, affected, command }));
      return ExitCode.USAGE;
    }
    const session = await api.revert(sessionID, { messageID, partID });
    if (flags.json) ctx.json({ confirmed: true, action: 'revert', session });
    else ctx.out(renderSession(session, { note: `Revert aplicado a partir de ${messageID}. Para desfazer: opc session unrevert ${sessionID} --confirmed-by-user` }));
    return ExitCode.OK;
  });
}

async function actionUnrevert(ctx, api, { flags, sessionID }) {
  return withSessionGuard(ctx, api, sessionID, async () => {
    const current = await api.getSession(sessionID);
    if (!current.revert) throw new UsageError('NOT_REVERTED', `a sessão ${sessionID} não tem revert ativo; nada a desfazer`);
    if (!flags['confirmed-by-user']) {
      const command = `opc session unrevert ${sessionID} --confirmed-by-user`;
      const rawDiff = current.revert.diff ?? null;
      if (flags.json) ctx.json({ confirmed: false, action: 'unrevert', sessionID, messageID: current.revert.messageID, rawDiff, command });
      else ctx.out(renderRevertPreview({ action: 'unrevert', sessionID, messageID: current.revert.messageID, rawDiff, command }));
      return ExitCode.USAGE;
    }
    const session = await api.unrevert(sessionID);
    if (flags.json) ctx.json({ confirmed: true, action: 'unrevert', session });
    else ctx.out(renderSession(session, { note: 'Unrevert aplicado: mensagens e arquivos restaurados.' }));
    return ExitCode.OK;
  });
}

async function actionSummarize(ctx, api, { flags, sessionID }) {
  const discovery = await loadDiscovery(api);
  const model = resolveModel(ctx, discovery, 'summarize', flags.model);
  return withSessionGuard(ctx, api, sessionID, async () => {
    await api.summarize(sessionID, {
      providerID: model.providerID,
      modelID: model.modelID,
      timeoutMs: (flags.timeout ?? DEFAULT_SUMMARIZE_TIMEOUT_SEC) * 1000,
    });
    if (flags.json) ctx.json({ sessionID, model: model.full, summarized: true });
    else ctx.out(`# Sessão ${sessionID} resumida\n\nModelo: ${model.full}\nVeja o resultado: opc session show ${sessionID}\n`);
    return ExitCode.OK;
  });
}
```

E troque o objeto `ACTIONS` por:

```js
const ACTIONS = {
  new: actionNew,
  show: actionShow,
  fork: actionFork,
  revert: actionRevert,
  unrevert: actionUnrevert,
  summarize: actionSummarize,
  children: actionChildren,
  diff: actionDiff,
  todo: actionTodo,
};
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/session-guard.test.mjs tests/integration/session-revert.test.mjs tests/integration/session-actions.test.mjs`
Expected: PASS (4 + 7 + 10 testes).

- [ ] **Step 6: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/opc/scripts/commands/session.mjs tests/unit/session-guard.test.mjs tests/integration/session-revert.test.mjs
git commit -m "feat: add session revert/unrevert with confirmation and summarize"
```

---
### Task 7: Grupos de jobs em `lib/jobs.mjs` (ponte de pedidos: a da F2a)

**Files:**
- Modify: `plugins/opc/scripts/lib/jobs.mjs`
- Test: `tests/unit/jobs-groups.test.mjs`

**Interfaces:**
- Consumes: `createJob`, `updateJob`, `readJob`, `listJobs`, `appendJobLog`, `cancelJob`, `reconcileJob`, `groupStatus`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES`, `NotFoundError` (F2a, mesmo módulo `lib/jobs.mjs`); `createRequestBridge`, `createSerialUpdater` (F2a, `commands/task-worker.mjs`, só no teste); `ensurePrivateDir` (F0, só no teste).
- Produces: `GROUP_ROLE`, `isGroupMember`, `topLevelJobs` (já criados na Task 4, mantidos), `countsTowardLimit`, `selectJobsToPrune`, `addGroupMember`, `createGroup`, `listGroupMembers`, `aggregateGroup`, `refreshGroup`, `cancelGroup`, `runWithConcurrency` (assinaturas em "Interfaces novas"). A ponte de pedidos **não** é desta fase: é a da F2a (`createRequestBridge`/`createSerialUpdater` de `commands/task-worker.mjs`). Mudanças de comportamento do F2a (E12): `createJob` conta só `countsTowardLimit` e não aplica `maxActive` a membros (`fields.groupId`); `workerLost` devolve `false` para membros e a reconciliação que perde um grupo perde também os membros ativos; a poda usa `selectJobsToPrune`; `resolveJobRef` sem `ref` considera só `topLevelJobs`.

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/unit/jobs-groups.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJob, readJob, updateJob, resolveJobRef, reconcileJob,
  GROUP_ROLE, isGroupMember, topLevelJobs, countsTowardLimit, selectJobsToPrune, addGroupMember, createGroup, listGroupMembers,
  aggregateGroup, refreshGroup, runWithConcurrency,
} from '../../plugins/opc/scripts/lib/jobs.mjs';
import { createRequestBridge, createSerialUpdater } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';

function tmpState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-groups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  ensurePrivateDir(dir);
  return dir;
}

async function eventually(fn, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met');
}

test('member helpers: isGroupMember, topLevelJobs, countsTowardLimit', () => {
  const jobs = [
    { id: 'g', role: GROUP_ROLE, groupId: null, status: 'running' },
    { id: 'm1', role: 'member:1', groupId: 'g', status: 'running' },
    { id: 't', status: 'completed' },
  ];
  assert.deepEqual(jobs.filter(isGroupMember).map((j) => j.id), ['m1']);
  assert.deepEqual(topLevelJobs(jobs).map((j) => j.id), ['g', 't']);
  assert.deepEqual(jobs.filter(countsTowardLimit).map((j) => j.id), ['g']);
});

test('selectJobsToPrune: a group counts as one and drops its members with it', () => {
  const jobs = [
    { id: 'old-g', role: GROUP_ROLE, status: 'completed', completedAt: '2026-01-01' },
    { id: 'old-m1', groupId: 'old-g', status: 'completed', completedAt: '2026-01-01' },
    { id: 'new-t', status: 'failed', completedAt: '2026-09-01' },
    { id: 'active', status: 'running' },
  ];
  assert.deepEqual(selectJobsToPrune(jobs, 1).sort(), ['old-g', 'old-m1']);
  assert.deepEqual(selectJobsToPrune(jobs, 2), []);
});

test('createGroup: group + ordered members with groupId, roles and memberIds', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'OPC: subagents: x', workspaceRoot: '/ws', claudeSessionId: 'c1' }, [
    { title: 'a', agent: 'general', model: 'p/a' },
    { title: 'b', agent: 'general', model: 'p/b' },
  ]);
  assert.equal(group.role, GROUP_ROLE);
  assert.deepEqual(group.memberIds, members.map((m) => m.id));
  assert.deepEqual(members.map((m) => [m.groupId, m.role, m.kind, m.status]), [[group.id, 'member:1', 'sub', 'queued'], [group.id, 'member:2', 'sub', 'queued']]);
  assert.deepEqual(listGroupMembers(stateDir, group.id).map((m) => m.model), ['p/a', 'p/b']);
});

test('addGroupMember: on-demand member appended to memberIds; own kind and status honoured', async (t) => {
  const stateDir = tmpState(t);
  const { group } = await createGroup(stateDir, { kind: 'sub', title: 'g', workspaceRoot: '/ws' }, []);
  assert.deepEqual(group.memberIds, []);
  const a = await addGroupMember(stateDir, group.id, { title: 'a' });
  const b = await addGroupMember(stateDir, group.id, { title: 'b', kind: 'cmd', role: 'planner', status: 'running' });
  assert.deepEqual([a.kind, a.role, a.status, a.groupId, a.workspaceRoot], ['sub', 'member:1', 'queued', group.id, '/ws']);
  assert.deepEqual([b.kind, b.role, b.status], ['cmd', 'planner', 'running']);
  assert.deepEqual(readJob(stateDir, group.id).memberIds, [a.id, b.id]);
  await assert.rejects(addGroupMember(stateDir, a.id, { title: 'x' }), (e) => e.code === 'NOT_FOUND');
});

test('aggregateGroup: waiting > running > completed(with warnings) > failed > cancelled', () => {
  const s = (...statuses) => statuses.map((status) => ({ status }));
  assert.equal(aggregateGroup(s('running', 'waiting_permission')).status, 'waiting_permission');
  assert.equal(aggregateGroup(s('completed', 'running')).status, 'running');
  assert.equal(aggregateGroup(s('queued', 'queued')).status, 'queued');
  const partial = aggregateGroup(s('completed', 'failed', 'cancelled'));
  assert.equal(partial.status, 'completed');
  assert.equal(partial.phase, '3/3 done');
  assert.deepEqual(partial.warnings, ['1 failed, 1 cancelled']);
  assert.equal(aggregateGroup(s('failed', 'cancelled')).status, 'failed');
  assert.equal(aggregateGroup(s('cancelled', 'cancelled')).status, 'cancelled');
});

test('refreshGroup aggregates members; cancelled group stays cancelled; final forces a terminal state', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  await updateJob(stateDir, members[0].id, { status: 'completed', result: { finalText: 'ok' } });
  let g = await refreshGroup(stateDir, group.id);
  assert.equal(g.status, 'running');
  assert.equal(g.phase, '1/2 done');
  g = await refreshGroup(stateDir, group.id, { final: true });
  assert.equal(g.status, 'failed', 'a member still queued at the end is a coordinator failure');
  // F2a updateJob never changes the status of a terminal job, so stickiness is checked on a fresh group.
  const other = await createGroup(stateDir, { kind: 'sub', title: 'g2' }, [{ title: 'c' }]);
  await updateJob(stateDir, other.group.id, { status: 'cancelled' });
  await updateJob(stateDir, other.members[0].id, { status: 'completed' });
  assert.equal((await refreshGroup(stateDir, other.group.id)).status, 'cancelled');
});

test('maxActive counts a group as one job', async (t) => {
  const stateDir = tmpState(t);
  await createGroup(stateDir, { kind: 'sub', title: 'g', status: 'running' }, Array.from({ length: 6 }, (_, i) => ({ title: `m${i}`, status: 'running' })));
  // 1 group + 7 tasks = 8 top-level active jobs (the default maxActive); the 6 members do not count.
  for (let i = 0; i < 7; i += 1) await createJob(stateDir, { kind: 'task', title: `t${i}`, status: 'running' });
  await assert.rejects(createJob(stateDir, { kind: 'task', title: 'one too many', status: 'running' }), (e) => e.code === 'TOO_MANY_JOBS');
});

test('members are never refused by maxActive (the group already took its slot)', async (t) => {
  const stateDir = tmpState(t);
  for (let i = 0; i < 7; i += 1) await createJob(stateDir, { kind: 'task', title: `t${i}` });
  // 7 active + the group = 8 (the default maxActive): the group fits, and so do all its members.
  const { members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
  assert.equal(members.length, 3);
  const groupId = members[0].groupId;
  assert.ok(await addGroupMember(stateDir, groupId, { title: 'd' }));
  await assert.rejects(createGroup(stateDir, { kind: 'sub', title: 'g2' }, [{ title: 'x' }]), (e) => e.code === 'TOO_MANY_JOBS');
  await assert.rejects(createJob(stateDir, { kind: 'task', title: 'one too many' }, { maxActive: 8 }), (e) => e.code === 'TOO_MANY_JOBS');
});

const LONG_AGO = '2020-01-01T00:00:00.000Z';

test('a member is never worker_lost while its group lives', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }]);
  // member a: queued, no pid, created long ago (a top-level job would be lost after 60 s);
  // member b: pid of a process whose cmdline is not "task-worker --job-id <b>" (e.g. the inherited coordinator pid).
  await updateJob(stateDir, members[0].id, { createdAt: LONG_AGO });
  await updateJob(stateDir, members[1].id, { status: 'running', pid: process.pid, pidStartTime: null });
  for (const m of members) assert.ok(['queued', 'running'].includes((await reconcileJob(stateDir, readJob(stateDir, m.id))).status));
  await createJob(stateDir, { kind: 'task', title: 'triggers the createJob sweep' });
  assert.deepEqual(listGroupMembers(stateDir, group.id).map((m) => m.errorCode), [null, null]);
});

test('a lost group takes its active members down (reconcileJob and the createJob sweep)', async (t) => {
  const stateDir = tmpState(t);
  const one = await createGroup(stateDir, { kind: 'sub', title: 'g1' }, [{ title: 'a' }, { title: 'b' }]);
  const two = await createGroup(stateDir, { kind: 'sub', title: 'g2' }, [{ title: 'c' }]);
  await updateJob(stateDir, one.members[1].id, { status: 'completed' });
  for (const g of [one.group, two.group]) await updateJob(stateDir, g.id, { createdAt: LONG_AGO });
  const lost = await reconcileJob(stateDir, readJob(stateDir, one.group.id));
  assert.equal(lost.errorCode, 'worker_lost');
  assert.deepEqual(listGroupMembers(stateDir, one.group.id).map((m) => [m.status, m.errorCode]), [['failed', 'worker_lost'], ['completed', null]]);
  await createJob(stateDir, { kind: 'task', title: 'triggers the createJob sweep' });
  assert.equal(readJob(stateDir, two.group.id).errorCode, 'worker_lost');
  assert.deepEqual(listGroupMembers(stateDir, two.group.id).map((m) => m.errorCode), ['worker_lost']);
});

test('resolveJobRef without ref ignores group members', async (t) => {
  const stateDir = tmpState(t);
  const { group } = await createGroup(stateDir, { kind: 'sub', title: 'g', claudeSessionId: 'c1' }, [{ title: 'a' }, { title: 'b' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  const resolved = resolveJobRef(stateDir, undefined, { claudeSessionId: 'c1', activeOnly: true });
  assert.equal(resolved.id ?? resolved, group.id);
});

test('runWithConcurrency respects the limit, keeps order and captures rejections', async () => {
  let current = 0;
  let peak = 0;
  const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
    current += 1;
    peak = Math.max(peak, current);
    await new Promise((r) => setTimeout(r, 15));
    current -= 1;
    if (x === 3) throw new Error('boom');
    return x * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[4].value, 50);
});

// The request bridge itself is F2a's (tested in F2a Task 10); here only its use inside a group:
// the member's update is wrapped so every change is reflected in the group.
test('F2a bridge on a member: the group lists the pending requests with memberId and clears them on resolve', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  await updateJob(stateDir, members[0].id, { status: 'running' });
  const updater = createSerialUpdater(stateDir, members[0].id);
  const bridge = createRequestBridge({
    update: async (patch) => { const job = await updater.update(patch); await refreshGroup(stateDir, group.id); return job; },
    api: { replyPermission: async () => {}, rejectQuestion: async () => {} },
    profileKind: 'write', policy: {}, timeoutMs: 60000,
  });
  t.after(() => bridge.dispose());
  await bridge.onPermission({ id: 'per_1', sessionID: 'ses_c', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] });
  await bridge.onQuestion({ id: 'que_1', sessionID: 'ses_c', questions: [{ question: 'Qual?' }] });
  let g = readJob(stateDir, group.id);
  assert.equal(g.status, 'waiting_permission');
  assert.deepEqual(g.pendingRequest.map((r) => [r.type, r.id, r.memberId]), [['permission', 'per_1', members[0].id], ['question', 'que_1', members[0].id]]);
  await bridge.onResolved({ type: 'permission', requestID: 'per_1', sessionID: 'ses_c', outcome: 'once' });
  assert.deepEqual(readJob(stateDir, group.id).pendingRequest.map((r) => r.id), ['que_1']);
  await bridge.onResolved({ type: 'question', requestID: 'que_1', sessionID: 'ses_c', outcome: 'rejected' });
  g = readJob(stateDir, group.id);
  assert.equal(g.status, 'running');
  assert.equal(g.pendingRequest, null);
  assert.equal(readJob(stateDir, members[0].id).pendingRequest, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/jobs-groups.test.mjs`
Expected: FAIL (`createGroup is not exported`).

- [ ] **Step 3: Implementar em `lib/jobs.mjs`**

Nenhum import novo: `ACTIVE_STATUSES`, `TERMINAL_STATUSES`, `groupStatus`, `NotFoundError`,
`createJob`, `updateJob`, `readJob`, `listJobs`, `appendJobLog` e `cancelJob` já estão no
próprio `lib/jobs.mjs` (F2a). **Não** redeclare `TERMINAL_STATUSES` (a F2a já o exporta no
mesmo módulo: uma segunda declaração é `SyntaxError`). Acrescente (mantendo `isGroupMember` e
`topLevelJobs` já criados na Task 4):

```js
// --- F3: groups, pruning and concurrency (the request bridge is F2a's, in task-worker.mjs) ---
export const GROUP_ROLE = 'group';

export function countsTowardLimit(job) {
  return ACTIVE_STATUSES.includes(job.status) && !isGroupMember(job);
}

export function selectJobsToPrune(jobs, keep = 50) {
  const hasActiveMember = (group) => jobs.some((m) => m.groupId === group.id && ACTIVE_STATUSES.includes(m.status));
  const terminalTop = topLevelJobs(jobs)
    .filter((j) => TERMINAL_STATUSES.includes(j.status) && !(j.role === GROUP_ROLE && hasActiveMember(j)))
    .sort((a, b) => String(b.completedAt ?? b.updatedAt ?? '').localeCompare(String(a.completedAt ?? a.updatedAt ?? '')));
  const ids = new Set(terminalTop.slice(keep).map((j) => j.id));
  for (const j of jobs) if (j.groupId && ids.has(j.groupId)) ids.add(j.id);
  return [...ids];
}

// On-demand member (F4b adds planner/worker/synthesizer members while the group runs). Members
// never count toward maxActive (createJob skips the check for fields.groupId) and never become
// worker_lost on their own (workerLost is false for members; a lost group takes them down).
export async function addGroupMember(stateDir, groupId, fields = {}) {
  const group = readJob(stateDir, groupId);
  if (!group || group.role !== GROUP_ROLE) throw new NotFoundError('NOT_FOUND', `group ${groupId} not found`);
  let member = await createJob(stateDir, {
    workspaceRoot: group.workspaceRoot ?? null,
    claudeSessionId: group.claudeSessionId ?? null,
    ...fields,
    kind: fields.kind ?? group.kind,
    groupId,
    role: fields.role ?? `member:${(group.memberIds ?? []).length + 1}`,
  });
  // createJob always starts at 'queued'; a coordinator may register a member that is already running.
  if (fields.status && fields.status !== member.status) {
    member = await updateJob(stateDir, member.id, { status: fields.status, phase: fields.phase ?? fields.status });
  }
  await updateJob(stateDir, groupId, (g) => ({ memberIds: [...(g.memberIds ?? []), member.id] }));
  return member;
}

export async function createGroup(stateDir, groupFields, memberFieldsList, { maxActive = 8 } = {}) {
  // Only the group goes through maxActive (it counts as one job).
  const group = await createJob(stateDir, { ...groupFields, role: GROUP_ROLE, groupId: null, memberIds: [] }, { maxActive });
  const members = [];
  try {
    for (const fields of memberFieldsList) members.push(await addGroupMember(stateDir, group.id, fields));
  } catch (err) {
    const failed = { status: 'failed', errorCode: 'group_create_failed', errorMessage: err.message, completedAt: new Date().toISOString() };
    for (const m of members) await updateJob(stateDir, m.id, failed);
    await updateJob(stateDir, group.id, failed);
    throw err;
  }
  return { group: readJob(stateDir, group.id), members };
}

export function listGroupMembers(stateDir, groupId) {
  const group = readJob(stateDir, groupId);
  const ids = group?.memberIds ?? listJobs(stateDir, { all: true }).filter((j) => j.groupId === groupId).map((j) => j.id);
  return ids.map((id) => readJob(stateDir, id)).filter(Boolean);
}

export function aggregateGroup(members) {
  const counts = { queued: 0, running: 0, waiting_permission: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const m of members) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const total = members.length;
  const done = counts.completed + counts.failed + counts.cancelled;
  // Status rule is F2a's groupStatus; the only extra state is "every member still queued".
  const status = total > 0 && counts.queued === total ? 'queued' : groupStatus(members);
  const warnings = status === 'completed' && done > counts.completed ? [`${counts.failed} failed, ${counts.cancelled} cancelled`] : [];
  return { status, counts, total, done, phase: `${done}/${total} done`, warnings };
}

function memberSummary(m) {
  return {
    id: m.id, role: m.role, agent: m.agent ?? null, model: m.model ?? null, status: m.status,
    sessionID: m.sessionID ?? null, mechanism: m.result?.mechanism ?? null, errorMessage: m.errorMessage ?? null,
  };
}

export async function refreshGroup(stateDir, groupId, { final = false } = {}) {
  const group = readJob(stateDir, groupId);
  if (!group || group.status === 'cancelled') return group;
  const members = listGroupMembers(stateDir, groupId);
  const agg = aggregateGroup(members);
  let status = agg.status;
  if (status === 'queued' && group.status === 'running') status = 'running';
  const warnings = [...agg.warnings];
  if (final && ACTIVE_STATUSES.includes(status)) {
    status = 'failed';
    warnings.push('coordinator finished with members still active');
  }
  // pendingRequest is a list everywhere (F2a): the group's is the concatenation of its waiting
  // members' requests, each tagged with memberId.
  const pending = members
    .filter((m) => m.status === 'waiting_permission')
    .flatMap((m) => (m.pendingRequest ?? []).map((req) => ({ ...req, memberId: m.id })));
  const patch = {
    status,
    phase: agg.phase,
    pendingRequest: pending.length ? pending : null,
    result: { counts: agg.counts, warnings, members: members.map(memberSummary) },
  };
  if (TERMINAL_STATUSES.includes(status)) patch.completedAt = group.completedAt ?? new Date().toISOString();
  return updateJob(stateDir, groupId, patch);
}

export async function cancelGroup(ctx, groupId) {
  const group = readJob(ctx.stateDir, groupId);
  const active = listGroupMembers(ctx.stateDir, groupId).filter((m) => ACTIVE_STATUSES.includes(m.status));
  await Promise.all(active.map((m) => cancelJob(ctx, m.id).catch((err) => appendJobLog(ctx.stateDir, groupId, `[opc] cancel ${m.id} failed: ${err.message}`))));
  const cancelled = ACTIVE_STATUSES.includes(group.status) ? await cancelJob(ctx, groupId) : group;
  return { group: readJob(ctx.stateDir, groupId) ?? cancelled, cancelledMembers: active.map((m) => m.id) };
}

export async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const laneCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}
```

Sem ponte própria e sem mapa de exit codes nesta fase: a ponte é a da F2a
(`createRequestBridge`/`createSerialUpdater` em `commands/task-worker.mjs`, liberada pelo
`onRequestResolved` do `runTurn`) e o exit code por status é o `exitCodeForJob(job)` de
`commands/task.mjs` (F2a).

Ajustes nas funções do F2a em `lib/jobs.mjs` (premissa E12, conferida contra o texto da F2a
Task 7; mudança de comportamento, registrar no relatório). `isGroupMember` e `GROUP_ROLE` são
declarações de função/constante de módulo, usáveis por essas funções (içamento de `function`;
a constante só é lida em tempo de chamada):

1. `workerLost` — membro nunca é "perdido" por conta própria (o pid dele é o do coordenador ou
   nenhum; `workerMatcher(memberId)` nunca casaria):

   ```js
   function workerLost(job, now = Date.now()) {
     if (!isActive(job) || isGroupMember(job)) return false;
     if (job.pid) return !identityMatches({ pid: job.pid, startTime: job.pidStartTime }, workerMatcher(job.id));
     return job.status === 'queued' && now - Date.parse(job.createdAt) > QUEUED_WITHOUT_WORKER_MS;
   }
   ```

2. `createJob` — a varredura de perdidos derruba também os membros ativos de um grupo perdido;
   o `maxActive` conta só `countsTowardLimit` e **não se aplica** a membros (`fields.groupId`);
   `SESSION_BUSY` continua olhando todos os ativos:

   ```js
     const jobs = listJobs(stateDir, { all: true });
     const lostGroups = new Set();
     for (const job of jobs) {
       if (!workerLost(job)) continue;
       Object.assign(job, lostPatch(), { updatedAt: nowIso() });
       writeJob(stateDir, job);
       upsertIndex(state, job);
       if (job.role === GROUP_ROLE) lostGroups.add(job.id);
     }
     for (const member of jobs) {
       if (!lostGroups.has(member.groupId) || !isActive(member)) continue;
       Object.assign(member, lostPatch(), { updatedAt: nowIso() });
       writeJob(stateDir, member);
       upsertIndex(state, member);
     }
     const active = jobs.filter(isActive);
     const counted = jobs.filter(countsTowardLimit);
     if (!fields.groupId && counted.length >= maxActive) {
       throw new UsageError('TOO_MANY_JOBS', `jobs.maxActive (${maxActive}) reached; active jobs:\n${counted.map((j) => `- ${j.id} (${j.kind}, ${j.status})`).join('\n')}`, {
         details: { active: counted.map((j) => ({ id: j.id, kind: j.kind, status: j.status })) },
       });
     }
   ```

   (o resto de `createJob` — `SESSION_BUSY` com `active`, criação e poda — fica como está.)

3. `reconcileJob` — quando perde um grupo, perde também os membros ativos dele:

   ```js
   export async function reconcileJob(stateDir, job) {
     if (!workerLost(job)) return job;
     const lost = await updateJob(stateDir, job.id, lostPatch());
     if (job.role === GROUP_ROLE) {
       for (const member of listJobs(stateDir, { all: true })) {
         if (member.groupId === job.id && isActive(member)) await updateJob(stateDir, member.id, lostPatch());
       }
     }
     return lost;
   }
   ```

4. Poda: em `createJob`, troque a chamada `pruneTerminal(stateDir, state, jobs)` por uma que
   remove os ids de `selectJobsToPrune(jobs, MAX_TERMINAL_JOBS)` (mesmos arquivos e mesma
   limpeza de `state.jobs` que o `pruneTerminal` da F2a já faz):

   ```js
   function pruneTerminal(stateDir, state, jobs) {
     const ids = new Set(selectJobsToPrune(jobs, MAX_TERMINAL_JOBS));
     if (ids.size === 0) return;
     for (const id of ids) {
       for (const file of [jobPath(stateDir, id), jobLogPath(stateDir, id), workerLogPath(stateDir, id)]) rmSync(file, { force: true });
     }
     state.jobs = (state.jobs ?? []).filter((entry) => !ids.has(entry.id));
   }
   ```

5. `resolveJobRef`, ramo **sem** `ref`: `const scoped = topLevelJobs(pool).filter((j) => isActive(j) && (!claudeSessionId || j.claudeSessionId === claudeSessionId));`.
   Com `ref` explícito, nada muda (um membro pode ser referenciado pelo id).

Com o item 1, a herança de `pid`/`pidStartTime` do coordenador pelos membros (Task 9) deixa de
ser necessária para a vida do membro; ela fica por ser inofensiva: `cancelJob(membro)` vê o pid
vivo com identidade que não confere (`worker: 'identity-mismatch'`) e **não** sinaliza nada.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/jobs-groups.test.mjs`
Expected: PASS (13 testes).

- [ ] **Step 5: Suíte completa**

Run: `npm test`
Expected: PASS (os testes de `maxActive`, poda e `cancel` sem id do F2a continuam verdes: eles
não criam grupos).

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/jobs.mjs tests/unit/jobs-groups.test.mjs
git commit -m "feat: add job groups, aggregation and concurrency"
```

---

### Task 8: `dispatchSubagent` em `lib/runner.mjs` (sessão filha com fallback para `subtask`)

**Files:**
- Modify: `plugins/opc/scripts/lib/runner.mjs`
- Test: `tests/unit/runner-subagent.test.mjs`

**Interfaces:**
- Consumes: `runTurn(...)` e `newMessageId()` (F2a, mesmo módulo); `api.createSession`, `api.messages`; `UsageError` (E1).
- Produces: `SUBAGENT_MECHANISMS`, `isAgentModeRefusal(errOrResult)`, `extractTaskOutput(messages)`, `dispatchSubagent({...})` → `{ ...resultado do runTurn, mechanism, fellBack, carrierSessionID? }`.

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/unit/runner-subagent.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSubagent, isAgentModeRefusal, extractTaskOutput, SUBAGENT_MECHANISMS } from '../../plugins/opc/scripts/lib/runner.mjs';

const RULES = [{ permission: '*', pattern: '*', action: 'deny' }];
const MEMBER = { agent: 'explore', model: { providerID: 'p', modelID: 'm/x' }, title: 'OPC: sub: #1 explore: hi' };

function fakeApi({ refuseCreateWithAgent = false, messages = [] } = {}) {
  const created = [];
  return {
    created,
    async createSession(body) {
      if (refuseCreateWithAgent && body.agent) {
        const err = new Error('Agent explore is a subagent and cannot be used as the session agent');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      created.push(body);
      return { id: `ses_${created.length}` };
    },
    async messages() { return messages; },
  };
}

const okTurn = (text = 'done') => async ({ request }) => ({ status: 'completed', sessionID: request.sessionID, finalText: text, toolsRan: false, childSessionIDs: [] });

test('mechanisms and refusal detection', () => {
  assert.deepEqual(SUBAGENT_MECHANISMS, ['child-session', 'subtask']);
  assert.equal(isAgentModeRefusal(new Error('Agent explore is a subagent and cannot be used as the session agent')), true);
  assert.equal(isAgentModeRefusal({ status: 'failed', errorType: 'BadRequest', errorMessage: 'agent "x" mode primary required' }), true);
  assert.equal(isAgentModeRefusal(new Error('invalid api key')), false);
  assert.equal(isAgentModeRefusal(null), false);
});

test('extractTaskOutput returns the last completed task tool output', () => {
  const messages = [
    { info: {}, parts: [{ type: 'tool', tool: 'task', state: { status: 'completed', output: 'first' } }] },
    { info: {}, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', output: 'nope' } }, { type: 'tool', tool: 'task', state: { status: 'completed', output: 'second' } }] },
  ];
  assert.equal(extractTaskOutput(messages), 'second');
  assert.equal(extractTaskOutput([]), '');
});

test('child-session: creates child with parentID/agent/rules, then runs the turn with the agent', async () => {
  const api = fakeApi();
  const seen = [];
  const sessions = [];
  const onRequestResolved = async () => {};
  let forwarded = null;
  const res = await dispatchSubagent({
    api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'hi "there"', rules: RULES,
    onSession: (sid) => sessions.push(sid), onRequestResolved,
    runTurnImpl: async (args) => { seen.push(args.request); forwarded = args.onRequestResolved; return okTurn()(args); },
  });
  assert.equal(forwarded, onRequestResolved, 'onRequestResolved reaches runTurn (bridge release)');
  assert.deepEqual(api.created, [{ parentID: 'ses_parent', title: MEMBER.title, agent: 'explore', permission: RULES }]);
  assert.deepEqual(sessions, ['ses_1']);
  assert.equal(seen[0].sessionID, 'ses_1');
  assert.equal(seen[0].agent, 'explore');
  assert.deepEqual(seen[0].model, MEMBER.model);
  assert.deepEqual(seen[0].parts, [{ type: 'text', text: 'hi "there"' }]);
  assert.match(seen[0].messageID, /^msg/);
  assert.equal(res.mechanism, 'child-session');
  assert.equal(res.fellBack, false);
});

test('falls back to a subtask part when createSession refuses the agent mode', async () => {
  const api = fakeApi({ refuseCreateWithAgent: true });
  const seen = [];
  const res = await dispatchSubagent({ api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES, runTurnImpl: async (args) => { seen.push(args.request); return okTurn('sub ok')(args); } });
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].agent, undefined);
  assert.deepEqual(api.created[0].permission.at(-1), { permission: 'task', pattern: 'explore', action: 'allow' });
  assert.deepEqual(seen[0].parts, [{ type: 'subtask', prompt: 'p', description: MEMBER.title, agent: 'explore', model: MEMBER.model }]);
  assert.equal(res.mechanism, 'subtask');
  assert.equal(res.fellBack, true);
  assert.equal(res.carrierSessionID, 'ses_1');
});

test('falls back when the turn fails with an agent-mode refusal', async () => {
  const api = fakeApi();
  let call = 0;
  const res = await dispatchSubagent({
    api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES,
    runTurnImpl: async ({ request }) => {
      call += 1;
      if (call === 1) return { status: 'failed', sessionID: request.sessionID, errorType: 'BadRequest', errorMessage: 'Agent explore is a subagent and cannot be used as the session agent', finalText: '' };
      return { status: 'completed', sessionID: request.sessionID, finalText: 'ok' };
    },
  });
  assert.equal(res.mechanism, 'subtask');
  assert.equal(res.fellBack, true);
  assert.equal(api.created.length, 2);
});

test('subtask with empty final text reads the task tool output', async () => {
  const api = fakeApi({ messages: [{ info: {}, parts: [{ type: 'tool', tool: 'task', state: { status: 'completed', output: 'TASK OUT' } }] }] });
  const res = await dispatchSubagent({ api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES, mechanism: 'subtask', runTurnImpl: okTurn('') });
  assert.equal(res.finalText, 'TASK OUT');
  assert.equal(res.fellBack, false);
  assert.equal(api.created.length, 1);
});

test('non-refusal errors propagate; allowFallback=false never falls back; bad mechanism is a usage error', async () => {
  const boom = async () => { throw new Error('invalid api key'); };
  await assert.rejects(dispatchSubagent({ api: fakeApi(), hub: {}, parentSessionID: 'p', member: MEMBER, prompt: 'p', rules: RULES, runTurnImpl: boom }), /invalid api key/);
  await assert.rejects(dispatchSubagent({ api: fakeApi({ refuseCreateWithAgent: true }), hub: {}, parentSessionID: 'p', member: MEMBER, prompt: 'p', rules: RULES, allowFallback: false, runTurnImpl: okTurn() }), /subagent/);
  await assert.rejects(dispatchSubagent({ api: fakeApi(), hub: {}, parentSessionID: 'p', member: MEMBER, prompt: 'p', rules: RULES, mechanism: 'magic', runTurnImpl: okTurn() }), (e) => e.exitCode === 2);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/runner-subagent.test.mjs`
Expected: FAIL (`dispatchSubagent is not exported`).

- [ ] **Step 3: Implementar em `lib/runner.mjs`**

Garanta `import { UsageError } from './opc-error.mjs';` e acrescente no fim:

```js
// --- F3: subagents ------------------------------------------------------------------
export const SUBAGENT_MECHANISMS = Object.freeze(['child-session', 'subtask']);

export function isAgentModeRefusal(errOrResult) {
  if (!errOrResult) return false;
  const text = typeof errOrResult === 'string'
    ? errOrResult
    : [errOrResult.message, errOrResult.errorMessage, errOrResult.errorType, errOrResult.details ? JSON.stringify(errOrResult.details) : '']
      .filter(Boolean).join(' ');
  return /\bagent\b/i.test(text) && /(subagent|primary|\bmode\b)/i.test(text);
}

export function extractTaskOutput(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part.type === 'tool' && part.tool === 'task' && part.state?.status === 'completed' && typeof part.state.output === 'string') {
        return part.state.output;
      }
    }
  }
  return '';
}

// Runs one subagent member. Default: a child session with the agent (spec §13.3 F3).
// If OpenCode refuses a subagent-mode agent as session agent (§15 item 7), falls back to a
// `subtask` part sent to a carrier child session (one carrier per member: one prompt per session).
export async function dispatchSubagent({
  api, hub, parentSessionID, member, prompt, rules, mechanism = 'child-session', allowFallback = true,
  timeoutMs, fallbackCfg, onSession = () => {}, onProgress = () => {}, onPermission = async () => {},
  onQuestion = async () => {}, onRequestResolved = async () => {}, signal, runTurnImpl = runTurn,
}) {
  if (!SUBAGENT_MECHANISMS.includes(mechanism)) {
    throw new UsageError('INVALID_MECHANISM', `mecanismo inválido: ${mechanism} (use ${SUBAGENT_MECHANISMS.join(' ou ')})`);
  }
  // onRequestResolved is forwarded to runTurn so the F2a request bridge (bridge.onResolved) releases pending requests.
  const common = { api, hub, onProgress, onPermission, onQuestion, onRequestResolved, signal };
  const baseRequest = { model: member.model, variant: member.variant, timeoutMs, fallbackCfg };

  const viaSubtask = async (fellBack) => {
    const carrier = await api.createSession({
      parentID: parentSessionID,
      title: `${member.title} (subtask)`,
      permission: [...rules, { permission: 'task', pattern: member.agent, action: 'allow' }],
    });
    await onSession(carrier.id);
    const result = await runTurnImpl({
      ...common,
      request: {
        ...baseRequest,
        sessionID: carrier.id,
        messageID: newMessageId(),
        parts: [{ type: 'subtask', prompt, description: member.title, agent: member.agent, model: member.model }],
      },
    });
    let finalText = result.finalText;
    if (!finalText && result.status === 'completed') finalText = extractTaskOutput(await api.messages(carrier.id));
    return { ...result, finalText, mechanism: 'subtask', fellBack, carrierSessionID: carrier.id };
  };

  if (mechanism === 'subtask') return viaSubtask(false);

  let child;
  try {
    child = await api.createSession({ parentID: parentSessionID, title: member.title, agent: member.agent, permission: rules });
  } catch (err) {
    if (allowFallback && isAgentModeRefusal(err)) return viaSubtask(true);
    throw err;
  }
  await onSession(child.id);
  let result;
  try {
    result = await runTurnImpl({
      ...common,
      request: { ...baseRequest, sessionID: child.id, messageID: newMessageId(), agent: member.agent, parts: [{ type: 'text', text: prompt }] },
    });
  } catch (err) {
    if (allowFallback && isAgentModeRefusal(err)) return viaSubtask(true);
    throw err;
  }
  if (result.status === 'failed' && allowFallback && isAgentModeRefusal(result)) return viaSubtask(true);
  return { ...result, mechanism: 'child-session', fellBack: false };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/runner-subagent.test.mjs`
Expected: PASS (7 testes).

- [ ] **Step 5: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/runner.mjs tests/unit/runner-subagent.test.mjs
git commit -m "feat: add dispatchSubagent with child-session and subtask mechanisms"
```

---
### Task 9: Comando `subagent` e worker coordenador do grupo

**Files:**
- Create: `plugins/opc/scripts/commands/subagent.mjs`
- Modify: `plugins/opc/scripts/commands/task-worker.mjs` (delegação por `kind`)
- Test: `tests/unit/subagent-pairing.test.mjs`, `tests/integration/subagent.test.mjs`

**Interfaces:**
- Consumes: `openApi` (`respawn: false` no coordenador), `loadDiscovery`, `requireAgent`, `resolveModel`, `profileRules` (Task 4); `createGroup` (com `{ maxActive }`), `listGroupMembers`, `refreshGroup`, `runWithConcurrency` (Task 7); `dispatchSubagent` (com `onRequestResolved`), `SUBAGENT_MECHANISMS` (Task 8); `renderGroupStatus`, `renderGroupResult` (Task 3); F2a `spawnWorker`, `waitForJob`, `readJob`, `updateJob`, `appendJobLog`, `ACTIVE_STATUSES`, `assertNotInsideServer`, `readRawArgs` (`lib/args.mjs`), `exitCodeForJob` (`commands/task.mjs`), `createRequestBridge`/`createSerialUpdater` (`commands/task-worker.mjs`); F2b `withServerLock`; F0 `getProcessIdentity(pid)`.
- Produces: subcomando `subagent` (`--agent a[,b] --model m[,n] [--variant] [--write] [--background] [--mechanism child-session|subtask] [--prompt-file f] [--timeout s] [--wait-timeout s] <prompt>`, texto livre por `--raw-args-stdin`); `pairAgentsAndModels(agents, models)`; `MAX_SUBAGENTS = 8`; `runWorker(ctx, groupJob)`; `WORKER_DELEGATES` no `task-worker`. `--json` → `{ group, members }`. Exit: `exitCodeForJob(group)`; `OPC_INSIDE_SERVER=1` → 4; `--wait-timeout` → 6 (F2a).

- [ ] **Step 1: Escrever o teste unitário do pareamento (falha)**

Create `tests/unit/subagent-pairing.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairAgentsAndModels, MAX_SUBAGENTS } from '../../plugins/opc/scripts/commands/subagent.mjs';

test('pairAgentsAndModels expands 1×N and N×1, pairs N×N', () => {
  assert.deepEqual(pairAgentsAndModels(['general'], ['a', 'b', 'c']), [
    { agent: 'general', model: 'a' }, { agent: 'general', model: 'b' }, { agent: 'general', model: 'c' },
  ]);
  assert.deepEqual(pairAgentsAndModels(['x', 'y'], []), [{ agent: 'x', model: null }, { agent: 'y', model: null }]);
  assert.deepEqual(pairAgentsAndModels(['x', 'y'], ['a']), [{ agent: 'x', model: 'a' }, { agent: 'y', model: 'a' }]);
  assert.deepEqual(pairAgentsAndModels(['x', 'y'], ['a', 'b']), [{ agent: 'x', model: 'a' }, { agent: 'y', model: 'b' }]);
});

test('pairAgentsAndModels rejects mismatches, no agent and too many members', () => {
  assert.throws(() => pairAgentsAndModels(['x', 'y'], ['a', 'b', 'c']), (e) => e.exitCode === 2 && e.code === 'AGENT_MODEL_MISMATCH');
  assert.throws(() => pairAgentsAndModels([], ['a']), (e) => e.code === 'NO_AGENT');
  assert.equal(MAX_SUBAGENTS, 8);
  assert.throws(() => pairAgentsAndModels(Array(9).fill('general'), []), (e) => e.code === 'TOO_MANY_SUBAGENTS');
});
```

- [ ] **Step 2: Escrever o teste de integração (falha)**

Create `tests/integration/subagent.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState, stateDirFor, eventually } from '../helpers.mjs';
import { F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';
import { readJob, listGroupMembers } from '../../plugins/opc/scripts/lib/jobs.mjs';

async function setup(t, { scenario = 'group-slow', config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, config); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const created = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/session').map((r) => r.body);
const prompts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /\/prompt_async$/.test(r.path)).map((r) => r.body);
const DENY_ALL = { permission: '*', pattern: '*', action: 'deny' };

test('three members, one per model: own child session, own result, correct bodies', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong,k3', '--json', 'Explain the repo'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'completed');
  assert.equal(group.role, 'group');
  assert.deepEqual(members.map((m) => m.model), [F3_MODELS.deepseek, F3_MODELS.qwen, F3_MODELS.kimi]);
  assert.deepEqual(members.map((m) => m.result.finalText), [
    'RESULT general opencode-go/deepseek-v4.1-flash', 'RESULT general opencode-go/qwen3.8-max', 'RESULT general opencode-go/kimi-k3',
  ]);
  assert.equal(new Set(members.map((m) => m.sessionID)).size, 3);
  const bodies = created(env);
  const parent = bodies.find((b) => !b.parentID);
  assert.match(parent.title, /^OPC: subagents: Explain the repo/);
  const children = bodies.filter((b) => b.parentID);
  assert.equal(children.length, 3);
  assert.ok(children.every((b) => b.parentID === group.sessionID && b.agent === 'general'));
  assert.ok(children.every((b) => b.title.startsWith('OPC: sub: #')));
  assert.ok(children.every((b) => JSON.stringify(b.permission[0]) === JSON.stringify(DENY_ALL)));
  const sent = prompts(env);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((b) => b.agent === 'general' && b.parts[0].type === 'text' && b.parts[0].text === 'Explain the repo'));
  assert.deepEqual(sent.map((b) => b.model.modelID).sort(), ['opencode-go/deepseek-v4.1-flash', 'opencode-go/kimi-k3', 'opencode-go/qwen3.8-max']);
  const text = await runCli(['subagent', '--agent', 'general', '--model', 'fast', 'hello'], { env, cwd });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /# Resultado do grupo/);
  assert.match(text.stdout, /RESULT general/);
});

test('prompt reaches every member intact (quotes, backticks, $(), newline, unicode)', async (t) => {
  const { cwd, env } = await setup(t);
  const prompt = 'line1\nline2 `tick` $(touch pwned) "q" ção 🚀';
  // Same path as /opc:subagent: `--raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'`; known flags leave the text, the rest is verbatim.
  const res = await runCli(['subagent', '--raw-args-stdin'], { env, cwd, stdin: `--agent general --model fast,strong -- ${prompt}\n` });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(prompts(env).map((b) => b.parts[0].text), [prompt, prompt]);
  assert.equal(existsSync(join(cwd, 'pwned')), false);
});

test('refuses to start from inside the OpenCode server (exit 4, no session)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['subagent', '--agent', 'general', 'hi'], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd });
  assert.equal(res.code, 4, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /INSIDE_SERVER|inside the OpenCode server/);
  assert.equal(created(env).length, 0);
});

test('jobs.maxParallel limits concurrent member turns', async (t) => {
  const { cwd, env } = await setup(t, { config: { ...F3_TEST_CONFIG, jobs: { maxActive: 8, maxParallel: 2 } }, extra: { FAKE_GROUP_DELAY_MS: '1500' } });
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong,k3', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const at = readFakeState(env).f3.prompts.map((p) => p.at);
  const t0 = Math.min(...at);
  assert.equal(at.filter((x) => x - t0 < 750).length, 2);
  assert.equal(at.length, 3);
});

test('--write runs members one at a time with write rules', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_DELAY_MS: '800' } });
  const res = await runCli(['subagent', '--write', '--agent', 'general', '--model', 'fast,strong', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const at = readFakeState(env).f3.prompts.map((p) => p.at);
  assert.ok(Math.max(...at) - Math.min(...at) >= 700, 'second member starts after the first finished');
  assert.ok(created(env).filter((b) => b.parentID).every((b) => JSON.stringify(b.permission[0]) !== JSON.stringify(DENY_ALL)));
});

test('policy and usage refusals happen before any session is created', async (t) => {
  const { cwd, env } = await setup(t);
  const cases = [
    [['subagent', '--agent', 'work-secret', 'hi'], 4],
    [['subagent', '--agent', 'pinned-sub', 'hi'], 4],
    [['subagent', '--agent', 'build', 'hi'], 2],
    [['subagent', '--agent', 'general', '--model', 'omniroute-work/cx/gpt-5.5', 'hi'], 4],
    [['subagent', '--agent', 'general,explore', '--model', 'fast,strong,k3', 'hi'], 2],
    [['subagent', 'hi'], 2],
    [['subagent', '--agent', 'general'], 2],
    [['subagent', '--agent', 'general', '--mechanism', 'magic', 'hi'], 2],
    [['subagent', '--agent', Array(9).fill('general').join(','), 'hi'], 2],
  ];
  for (const [args, code] of cases) {
    const res = await runCli(args, { env, cwd });
    assert.equal(res.code, code, `${args.join(' ')} → ${res.stdout}${res.stderr}`);
  }
  assert.equal(created(env).length, 0);
});

test('one failing member leaves the group completed with warnings', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_FAIL_MODEL: 'kimi-k3' } });
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong,k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'completed');
  assert.deepEqual(members.map((m) => m.status), ['completed', 'completed', 'failed']);
  assert.deepEqual(group.result.warnings, ['1 failed, 0 cancelled']);
  const stateDir = await stateDirFor(env, cwd);
  assert.match(readJob(stateDir, group.id).rendered, /ProviderAuthError|invalid api key/);
});

test('--background returns at once; the coordinator finishes the group', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong', '--background', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const { group } = JSON.parse(res.stdout);
  assert.ok(['queued', 'running'].includes(group.status));
  const stateDir = await stateDirFor(env, cwd);
  await eventually(() => readJob(stateDir, group.id)?.status === 'completed');
  const members = listGroupMembers(stateDir, group.id);
  assert.ok(members.every((m) => m.status === 'completed' && m.pid === readJob(stateDir, group.id).pid));
});

test('falls back to a subtask part when the agent mode is refused', async (t) => {
  const { cwd, env } = await setup(t, { scenario: 'subagent-mode-refused' });
  const res = await runCli(['subagent', '--agent', 'explore', '--model', 'fast', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const [member] = JSON.parse(res.stdout).members;
  assert.equal(member.result.mechanism, 'subtask');
  assert.equal(member.result.fellBack, true);
  assert.match(member.result.finalText, /^SUBTASK explore opencode-go\/deepseek-v4\.1-flash via ses_/);
  const sent = prompts(env);
  assert.equal(sent[0].agent, 'explore');
  assert.equal(sent[0].parts[0].type, 'text');
  const part = sent[1].parts[0];
  assert.equal(part.type, 'subtask');
  assert.equal(part.agent, 'explore');
  assert.ok(part.description.length > 0);
  assert.deepEqual(part.model, { providerID: 'omniroute-mvalmeida', modelID: 'opencode-go/deepseek-v4.1-flash' });
  const carrier = created(env).find((b) => b.parentID && !b.agent && / \(subtask\)$/.test(b.title));
  assert.deepEqual(carrier.permission.at(-1), { permission: 'task', pattern: 'explore', action: 'allow' });
});

test('--mechanism subtask skips the child-session attempt', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast', '--mechanism', 'subtask', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const [member] = JSON.parse(res.stdout).members;
  assert.equal(member.result.mechanism, 'subtask');
  assert.equal(member.result.fellBack, false);
  assert.equal(member.result.finalText, 'SUBTASK general opencode-go/deepseek-v4.1-flash');
  assert.ok(created(env).every((b) => !b.agent));
});

test('member permission request: exit 3, reply, completes', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_ASK: 'permission' } });
  const res = await runCli(['subagent', '--write', '--agent', 'general', '--model', 'fast,k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 3, res.stderr);
  const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'waiting_permission');
  assert.equal(group.pendingRequest[0].id, 'per_f3_1');
  assert.equal(group.pendingRequest[0].memberId, members[1].id);
  assert.equal(members[1].status, 'waiting_permission');
  const reply = await runCli(['permissions', 'reply', 'per_f3_1', 'once'], { env, cwd });
  assert.equal(reply.code, 0, reply.stdout + reply.stderr);
  const stateDir = await stateDirFor(env, cwd);
  await eventually(() => readJob(stateDir, group.id)?.status === 'completed');
  assert.equal(listGroupMembers(stateDir, group.id)[1].result.finalText, 'AFTER REPLY');
});

test('member question: answer through /opc:permissions answer', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_ASK: 'question' } });
  const res = await runCli(['subagent', '--write', '--agent', 'general', '--model', 'k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 3, res.stderr);
  assert.equal(JSON.parse(res.stdout).group.pendingRequest[0].type, 'question');
  const answer = await runCli(['permissions', 'answer', 'que_f3_1', 'A'], { env, cwd });
  assert.equal(answer.code, 0, answer.stdout + answer.stderr);
  const stateDir = await stateDirFor(env, cwd);
  await eventually(() => readJob(stateDir, JSON.parse(res.stdout).group.id)?.status === 'completed');
});

test('read-only members get permission requests rejected immediately', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_ASK: 'permission' } });
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const replies = fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/permission/per_f3_1/reply');
  assert.ok(replies.some((r) => r.body.reply === 'reject'));
  assert.ok(replies.every((r) => r.body.reply !== 'always'));
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/subagent-pairing.test.mjs tests/integration/subagent.test.mjs`
Expected: FAIL (módulo `subagent.mjs` inexistente; subcomando desconhecido).

- [ ] **Step 4: Implementar `scripts/commands/subagent.mjs`**

```js
import { readFileSync } from 'node:fs';
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, requireAgent, resolveModel, profileRules } from '../lib/context.mjs';
import {
  createGroup, spawnWorker, waitForJob, readJob, updateJob, appendJobLog, listGroupMembers, refreshGroup,
  runWithConcurrency, assertNotInsideServer, withServerLock, ACTIVE_STATUSES,
} from '../lib/jobs.mjs';
import { dispatchSubagent, SUBAGENT_MECHANISMS } from '../lib/runner.mjs';
import { renderGroupStatus, renderGroupResult } from '../lib/render.mjs';
import { getProcessIdentity } from '../lib/process.mjs';
import { exitCodeForJob } from './task.mjs';
import { createRequestBridge, createSerialUpdater } from './task-worker.mjs';

export const MAX_SUBAGENTS = 8;
const DEFAULT_TURN_TIMEOUT_SEC = 1800;
const SUBAGENT_MODES = ['subagent', 'all'];

const SPEC = {
  flags: {
    agent: { type: 'list' },
    model: { type: 'list', alias: 'm' },
    variant: { type: 'string' },
    effort: { type: 'string' },
    write: { type: 'boolean' },
    background: { type: 'boolean' },
    mechanism: { type: 'string', default: 'child-session' },
    'prompt-file': { type: 'string' },
    timeout: { type: 'number' },
    'wait-timeout': { type: 'number' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
    'raw-args-stdin': { type: 'boolean' },
  },
  allowPositionals: true,
};

function splitList(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
}

export function pairAgentsAndModels(agents, models) {
  if (!agents.length) throw new UsageError('NO_AGENT', 'informe --agent a[,b,c] (veja /opc:agents --mode subagent)');
  let pairs;
  if (models.length <= 1) pairs = agents.map((agent) => ({ agent, model: models[0] ?? null }));
  else if (agents.length === 1) pairs = models.map((model) => ({ agent: agents[0], model }));
  else if (agents.length === models.length) pairs = agents.map((agent, i) => ({ agent, model: models[i] }));
  else throw new UsageError('AGENT_MODEL_MISMATCH', `--agent tem ${agents.length} itens e --model tem ${models.length}; use listas do mesmo tamanho, ou 1 agente, ou 1 modelo`);
  if (pairs.length > MAX_SUBAGENTS) throw new UsageError('TOO_MANY_SUBAGENTS', `no máximo ${MAX_SUBAGENTS} subagentes por grupo (pedidos: ${pairs.length})`);
  return pairs;
}

function summaryOf(prompt, max = 56) {
  const s = prompt.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const logLine = (ctx) => (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`);

export async function run(ctx, argv) {
  // Free text (D3): /opc:subagent sends `--raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'`; known flags are pulled out
  // of the text, the rest is the prompt verbatim.
  const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, SPEC);
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'use o texto do stdin (--raw-args-stdin) ou argumentos posicionais, não os dois');
  const text = raw.text ?? positionals.join(' ');
  const prompt = flags['prompt-file'] ? readFileSync(flags['prompt-file'], 'utf8') : text;
  if (!prompt.trim()) throw new UsageError('NO_PROMPT', 'informe o prompt dos subagentes (texto ou --prompt-file)');
  if (!SUBAGENT_MECHANISMS.includes(flags.mechanism)) {
    throw new UsageError('INVALID_MECHANISM', `--mechanism deve ser ${SUBAGENT_MECHANISMS.join(' ou ')}`);
  }
  const pairs = pairAgentsAndModels(splitList(flags.agent), splitList(flags.model));
  const variant = flags.variant ?? flags.effort ?? null;
  assertNotInsideServer(ctx.env); // exit 4 before connecting: delegation never recurses

  const conn = await openApi(ctx);
  let discovery;
  try {
    discovery = await loadDiscovery(conn.api);
  } finally {
    conn.close();
  }
  const policy = ctx.config.policy ?? {};
  const profile = flags.write ? 'write' : 'read-only';
  const summary = summaryOf(prompt);
  const specs = pairs.map((pair, i) => {
    const agent = requireAgent(discovery, pair.agent, policy, { modes: SUBAGENT_MODES });
    const model = resolveModel(ctx, discovery, 'task', pair.model, { variant });
    return {
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.modelID },
      full: model.full,
      variant: model.variant, // checked by validateSelection (UNKNOWN_VARIANT → exit 2)
      title: `OPC: sub: #${i + 1} ${agent.name}: ${summary}`.slice(0, 120),
    };
  });
  const maxParallel = flags.write ? 1 : Math.max(1, Number(ctx.config.jobs?.maxParallel ?? 4));
  const request = {
    prompt,
    mechanism: flags.mechanism,
    profile,
    rules: profileRules(ctx, profile),
    timeoutMs: (flags.timeout ?? DEFAULT_TURN_TIMEOUT_SEC) * 1000,
    maxParallel,
    fallbackCfg: ctx.config.routing?.fallback ?? null,
    members: specs,
  };
  // Top-level registration under the F2b server.lock (closes the reaper × new job race); only the
  // group counts toward jobs.maxActive.
  const { group, members } = await withServerLock(ctx, () => createGroup(ctx.stateDir, {
    kind: 'sub',
    title: `OPC: subagents: ${summary}`,
    summary,
    workspaceRoot: ctx.workspaceRoot,
    claudeSessionId: ctx.claudeSessionId,
    permissionProfile: profile,
    request,
  }, specs.map((spec, i) => ({
    title: spec.title, summary, agent: spec.agent, model: spec.full, variant: spec.variant ?? null,
    permissionProfile: profile, role: `member:${i + 1}`, request: { memberIndex: i },
  })), { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: 'register-job:sub' });
  await spawnWorker(ctx, group.id);

  if (flags.background) {
    const current = readJob(ctx.stateDir, group.id) ?? group;
    if (flags.json) ctx.json({ group: current, members });
    else ctx.out(renderGroupStatus(current, members));
    return ExitCode.OK;
  }
  const final = await waitForJob(ctx, group.id, {
    waitTimeoutMs: flags['wait-timeout'] ? flags['wait-timeout'] * 1000 : undefined,
    onLog: logLine(ctx),
  });
  const finalMembers = listGroupMembers(ctx.stateDir, group.id);
  if (flags.json) ctx.json({ group: final, members: finalMembers });
  else if (ACTIVE_STATUSES.includes(final.status)) ctx.out(renderGroupStatus(final, finalMembers));
  else ctx.out(final.rendered ?? renderGroupResult(final, finalMembers));
  return exitCodeForJob(final);
}

function memberResult(res, spec, fallbackMechanism) {
  return {
    finalText: res.finalText ?? '',
    structured: res.structured ?? null,
    error: res.error ?? null,
    errorClass: res.errorClass ?? null,
    errorType: res.errorType ?? null,
    errorMessage: res.errorMessage ?? null,
    sessionID: res.sessionID ?? null,
    mechanism: res.mechanism ?? fallbackMechanism,
    fellBack: Boolean(res.fellBack),
    carrierSessionID: res.carrierSessionID ?? null,
    touchedFiles: res.touchedFiles ?? [],
    toolsRan: Boolean(res.toolsRan),
    childSessionIDs: res.childSessionIDs ?? [],
    usage: res.usage ?? null,
    model: spec.full,
    agent: spec.agent,
  };
}

// Group coordinator (spec §9.1): one worker process, N concurrent member turns, one EventHub.
export async function runWorker(ctx, groupJob) {
  const { stateDir } = ctx;
  const req = groupJob.request;
  const memberIds = groupJob.memberIds ?? [];
  const now = () => new Date().toISOString();
  let chain = Promise.resolve();
  const refresh = () => {
    chain = chain.then(() => refreshGroup(stateDir, groupJob.id)).catch((err) => appendJobLog(stateDir, groupJob.id, `[opc] refresh failed: ${err.message}`));
    return chain;
  };
  let conn;
  try {
    // respawn: false — a coordinator never brings up another server mid-turn (F2a D9).
    conn = await openApi(ctx, { withHub: true, respawn: false });
    const { api, hub } = conn;
    const parent = await api.createSession({ title: groupJob.title, permission: req.rules });
    // Member liveness follows the group (workerLost is false for members; a lost group takes its
    // members down, Task 7). Inheriting the coordinator's identity is informational and harmless:
    // workerMatcher(memberId) never matches this cmdline (--job-id <groupId>), so cancelling a
    // member never signals the coordinator.
    const coordinator = { pid: process.pid, pidStartTime: getProcessIdentity(process.pid)?.startTime ?? null };
    await updateJob(stateDir, groupJob.id, { status: 'running', startedAt: now(), sessionID: parent.id });
    for (const id of memberIds) {
      await updateJob(stateDir, id, { parentSessionID: parent.id, pid: coordinator.pid, pidStartTime: coordinator.pidStartTime });
    }
    const policy = ctx.config.policy ?? {};

    await runWithConcurrency(memberIds, req.maxParallel ?? 4, async (memberId, index) => {
      if (readJob(stateDir, groupJob.id)?.status === 'cancelled') return;
      if (readJob(stateDir, memberId)?.status !== 'queued') return;
      const spec = req.members[index];
      const tag = `[#${index + 1} ${spec.agent}]`;
      await updateJob(stateDir, memberId, { status: 'running', phase: 'starting', startedAt: now() });
      appendJobLog(stateDir, groupJob.id, `${tag} starting (${spec.full})`);
      await refresh();
      // F2a bridge per member; its update is wrapped so every pending change is reflected in the group.
      const updater = createSerialUpdater(stateDir, memberId);
      const bridge = createRequestBridge({
        update: async (patch) => { const job = await updater.update(patch); await refresh(); return job; },
        api,
        profileKind: req.profile, // 'read-only' | 'write' (parseProfile kind equals the name)
        policy,
        timeoutMs: (policy.permissionTimeoutSec ?? 600) * 1000,
        log: (line) => appendJobLog(stateDir, groupJob.id, `${tag} ${line}`),
      });
      let res;
      try {
        res = await dispatchSubagent({
          api, hub, parentSessionID: parent.id, member: spec, prompt: req.prompt, rules: req.rules,
          mechanism: req.mechanism, timeoutMs: req.timeoutMs, fallbackCfg: req.fallbackCfg,
          onSession: async (sessionID) => {
            const job = await updateJob(stateDir, memberId, { sessionID });
            if (job?.status === 'cancelled') await api.abort(sessionID).catch(() => {});
          },
          onProgress: (p) => {
            const phase = typeof p === 'string' ? p : p?.phase;
            if (!phase) return;
            appendJobLog(stateDir, groupJob.id, `${tag} ${phase}`);
            updateJob(stateDir, memberId, { phase }).catch(() => {});
          },
          onPermission: (request) => bridge.onPermission(request),
          onQuestion: (request) => bridge.onQuestion(request),
          onRequestResolved: (event) => bridge.onResolved(event),
        });
      } catch (err) {
        res = { status: 'failed', errorType: err.code ?? err.name ?? 'Error', errorMessage: err.message, finalText: '', sessionID: readJob(stateDir, memberId)?.sessionID ?? null };
      } finally {
        bridge.dispose();
        await updater.flush();
      }
      const latest = readJob(stateDir, memberId);
      const status = latest?.status === 'cancelled' ? 'cancelled' : res.status;
      await updateJob(stateDir, memberId, {
        status,
        phase: status,
        completedAt: now(),
        sessionID: res.sessionID ?? latest?.sessionID ?? null,
        errorClass: res.errorClass ?? null,
        errorType: res.errorType ?? null,
        errorMessage: res.errorMessage ?? null,
        childSessionIDs: res.childSessionIDs ?? [],
        pendingRequest: null,
        result: memberResult(res, spec, req.mechanism),
      });
      appendJobLog(stateDir, groupJob.id, `${tag} ${status}`);
      await refresh();
    });

    await chain;
    const finalGroup = await refreshGroup(stateDir, groupJob.id, { final: true });
    await updateJob(stateDir, groupJob.id, { rendered: renderGroupResult(finalGroup, listGroupMembers(stateDir, groupJob.id)) });
    return exitCodeForJob(finalGroup);
  } catch (err) {
    appendJobLog(stateDir, groupJob.id, `[opc] coordinator error: ${err.message}`);
    for (const id of memberIds) {
      const m = readJob(stateDir, id);
      if (m && ACTIVE_STATUSES.includes(m.status)) {
        await updateJob(stateDir, id, { status: 'failed', errorCode: 'coordinator_error', errorMessage: err.message, completedAt: now() });
      }
    }
    const g = readJob(stateDir, groupJob.id);
    if (g && g.status !== 'cancelled') {
      await updateJob(stateDir, groupJob.id, { status: 'failed', errorCode: 'coordinator_error', errorMessage: err.message, completedAt: now() });
    }
    return ExitCode.JOB_FAILED;
  } finally {
    conn?.close();
  }
}
```

- [ ] **Step 5: Delegar no `task-worker`**

Em `plugins/opc/scripts/commands/task-worker.mjs`, acrescente no nível do módulo:

```js
// F3: kinds whose worker logic lives in their own command module (group coordinators, commands).
// Single dispatch table: F4b adds `orch: './orchestrate.mjs'` and F4c `conclave: './conclave.mjs'`
// by editing this literal; each module exports runWorker(ctx, job).
export const WORKER_DELEGATES = Object.freeze({ sub: './subagent.mjs', cmd: './command.mjs' });
```

e, no `run` do F2a (Task 10 Step 7), **logo após** a linha
`if (!stored?.request) throw new NotFoundError('NOT_FOUND', …);` e **antes** de
`const request = stored.request;` (premissa E8; o job lido chama-se `stored`):

```js
  if (stored.groupId) {
    throw new UsageError('GROUP_MEMBER_WORKER', `o job ${stored.id} é membro do grupo ${stored.groupId} e roda dentro do coordenador`);
  }
  const delegate = WORKER_DELEGATES[stored.kind];
  if (delegate) {
    const mod = await import(delegate);
    const code = await mod.runWorker(ctx, stored);
    // same safety net as the F2a turn path: a lingering keep-alive socket must not keep a detached coordinator alive
    setTimeout(() => process.exit(code), 2000).unref();
    return code;
  }
```

(`UsageError` já é importado pelo `task-worker` da F2a. O `command.mjs` chega na Task 11; até
lá nenhum job `cmd` existe. O delegado roda antes do `jobUpdates.update({ status: 'running', … })`
do turno único: o `pid`/`pidStartTime` do job já foram gravados pelo `spawnWorker` e o
`runWorker` de cada módulo faz a própria transição para `running`.)

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/unit/subagent-pairing.test.mjs tests/integration/subagent.test.mjs`
Expected: PASS (2 + 13 testes).

- [ ] **Step 7: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/opc/scripts/commands/subagent.mjs plugins/opc/scripts/commands/task-worker.mjs tests/unit/subagent-pairing.test.mjs tests/integration/subagent.test.mjs
git commit -m "feat: add subagent command with group coordinator worker"
```

---

### Task 10: `status`, `result` e `cancel` cientes de grupos

**Files:**
- Modify: `plugins/opc/scripts/commands/status.mjs`, `result.mjs`, `cancel.mjs`
- Test: `tests/integration/groups.test.mjs`

**Interfaces:**
- Consumes: `GROUP_ROLE`, `listGroupMembers`, `topLevelJobs`, `cancelGroup`, `ACTIVE_STATUSES`, `waitForJob` (F2a/Task 7); `exitCodeForJob` (F2a, `commands/task.mjs`); `renderGroupStatus`, `renderGroupResult`, `renderCommandResult` (Task 3).
- Produces: `statusForGroup(ctx, job, flags)` → exit code | `null`; `resultForGroupOrCommand(ctx, job, flags)` → exit code | `null`; `cancelForGroup(ctx, job, flags)` → exit code | `null`. `--json`: status/result de grupo → `{ group, members }`; cancel de grupo → `{ group, cancelledMembers }`; result de `cmd` → `{ job }`.

- [ ] **Step 1: Escrever o teste de integração (falha)**

Create `tests/integration/groups.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, eventually } from '../helpers.mjs';
import { F3_TEST_CONFIG } from '../fixtures/f3-fake.mjs';

async function setup(t, extra = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'group-slow', extra: { OPC_COMPANION_SESSION_ID: 'claude-f3-test', ...extra } });
  writeGlobalConfig(env, F3_TEST_CONFIG); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

async function startGroup(env, cwd, models = 'fast,strong,k3') {
  const res = await runCli(['subagent', '--agent', 'general', '--model', models, '--background', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout).group;
}

async function runningMembers(env, cwd, groupId) {
  return eventually(async () => {
    const res = await runCli(['status', groupId, '--json'], { env, cwd });
    const { members } = JSON.parse(res.stdout);
    return members.every((m) => m.status === 'running' && m.sessionID) ? members : null;
  }, { timeoutMs: 20000, intervalMs: 300 });
}

const aborts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /\/abort$/.test(r.path)).map((r) => r.path);

test('background group → status --wait (aggregated) → result with every member', async (t) => {
  const { cwd, env } = await setup(t);
  const group = await startGroup(env, cwd);
  const waited = await runCli(['status', group.id, '--wait', '--poll-interval-ms', '200', '--json'], { env, cwd });
  assert.equal(waited.code, 0, waited.stderr);
  const out = JSON.parse(waited.stdout);
  assert.equal(out.group.status, 'completed');
  assert.equal(out.group.phase, '3/3 done');
  assert.equal(out.members.length, 3);
  const text = await runCli(['status', group.id], { env, cwd });
  assert.match(text.stdout, /# Grupo /);
  const result = await runCli(['result', group.id], { env, cwd });
  assert.equal(result.code, 0);
  assert.equal((result.stdout.match(/RESULT general/g) ?? []).length, 3);
  const json = JSON.parse((await runCli(['result', group.id, '--json'], { env, cwd })).stdout);
  assert.equal(json.members.length, 3);
});

test('status list shows the group, never its members', async (t) => {
  const { cwd, env } = await setup(t);
  const group = await startGroup(env, cwd, 'fast,strong');
  await runCli(['status', group.id, '--wait', '--poll-interval-ms', '200'], { env, cwd });
  const members = JSON.parse((await runCli(['status', group.id, '--json'], { env, cwd })).stdout).members;
  const list = await runCli(['status', '--all'], { env, cwd });
  assert.match(list.stdout, new RegExp(group.id));
  for (const m of members) assert.doesNotMatch(list.stdout, new RegExp(m.id));
});

test('result on an active group is refused', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '5000' });
  const group = await startGroup(env, cwd, 'fast');
  const res = await runCli(['result', group.id], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /ainda está em execução/);
});

test('cancelling one member aborts only its session; the others complete', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '6000' });
  const group = await startGroup(env, cwd);
  const members = await runningMembers(env, cwd, group.id);
  const target = members[1];
  const cancel = await runCli(['cancel', target.id], { env, cwd });
  assert.equal(cancel.code, 0, cancel.stdout + cancel.stderr);
  assert.deepEqual(aborts(env), [`/session/${target.sessionID}/abort`]);
  const waited = JSON.parse((await runCli(['status', group.id, '--wait', '--poll-interval-ms', '200', '--json'], { env, cwd })).stdout);
  assert.equal(waited.group.status, 'completed');
  assert.deepEqual(waited.members.map((m) => m.status), ['completed', 'cancelled', 'completed']);
  assert.match((await runCli(['result', group.id], { env, cwd })).stdout, /Cancelado\./);
});

test('cancelling the group aborts every active member and ends cancelled', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '6000' });
  const group = await startGroup(env, cwd);
  const members = await runningMembers(env, cwd, group.id);
  const res = await runCli(['cancel', group.id, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).cancelledMembers.sort(), members.map((m) => m.id).sort());
  for (const m of members) assert.ok(aborts(env).includes(`/session/${m.sessionID}/abort`));
  const status = JSON.parse((await runCli(['status', group.id, '--json'], { env, cwd })).stdout);
  assert.equal(status.group.status, 'cancelled');
  assert.ok(status.members.every((m) => m.status === 'cancelled'));
  assert.equal((await runCli(['result', group.id], { env, cwd })).code, 130);
});

test('cancel without id picks the only active top-level job (the group)', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '6000' });
  const group = await startGroup(env, cwd, 'fast,strong');
  await runningMembers(env, cwd, group.id);
  const res = await runCli(['cancel', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).group.id, group.id);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/groups.test.mjs`
Expected: FAIL (o `status <grupo> --json` do F2a não tem `members`; `cancel` sem id recusa
"vários ativos" antes do ajuste da Task 7 no `resolveJobRef`, ou mata o coordenador).

- [ ] **Step 3: `status.mjs`**

Acrescente os imports:

```js
import { GROUP_ROLE, listGroupMembers, topLevelJobs, waitForJob } from '../lib/jobs.mjs';
import { renderGroupStatus } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';
```

(sem duplicar símbolos já importados) e a função exportada:

```js
export async function statusForGroup(ctx, job, flags) {
  if (job?.role !== GROUP_ROLE) return null;
  const final = flags.wait
    ? await waitForJob(ctx, job.id, {
      waitTimeoutMs: flags['timeout-ms'] ?? 240000,
      pollMs: flags['poll-interval-ms'] ?? 2000,
      onLog: (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`),
    })
    : job;
  const members = listGroupMembers(ctx.stateDir, job.id);
  if (flags.json) ctx.json({ group: final, members });
  else ctx.out(renderGroupStatus(final, members));
  return flags.wait ? exitCodeForJob(final) : ExitCode.OK;
}
```

No `run`:
- no ramo **com** id, logo após resolver o job e antes da renderização do F2a:

```js
    const groupExit = await statusForGroup(ctx, job, flags);
    if (groupExit !== null) return groupExit;
```

- no ramo **de lista**, passe `topLevelJobs(jobs)` (no lugar de `jobs`) ao render e ao JSON.

- [ ] **Step 4: `result.mjs`**

Imports (sem duplicar: o `result.mjs` da F2a já importa `UsageError` e `exitCodeForJob`):

```js
import { GROUP_ROLE, ACTIVE_STATUSES, listGroupMembers } from '../lib/jobs.mjs';
import { renderGroupResult, renderCommandResult } from '../lib/render.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { exitCodeForJob } from './task.mjs';
```

Função exportada:

```js
export function resultForGroupOrCommand(ctx, job, flags) {
  const isGroup = job?.role === GROUP_ROLE;
  if (!isGroup && job?.kind !== 'cmd') return null;
  if (ACTIVE_STATUSES.includes(job.status)) {
    throw new UsageError('JOB_ACTIVE', `o ${isGroup ? 'grupo' : 'job'} ${job.id} ainda está em execução (${job.phase ?? job.status}); use /opc:status ${job.id} --wait`);
  }
  if (isGroup) {
    const members = listGroupMembers(ctx.stateDir, job.id);
    if (flags.json) ctx.json({ group: job, members });
    else ctx.out(job.rendered ?? renderGroupResult(job, members));
  } else if (flags.json) {
    ctx.json({ job });
  } else {
    ctx.out(job.rendered ?? renderCommandResult(job.result ?? { command: job.request?.command ?? '?', arguments: job.request?.arguments ?? '' }));
  }
  return exitCodeForJob(job);
}
```

No `run`, logo após resolver o job e **antes** das checagens do F2a:

```js
  const special = resultForGroupOrCommand(ctx, job, flags);
  if (special !== null) return special;
```

- [ ] **Step 5: `cancel.mjs`**

Imports:

```js
import { GROUP_ROLE, cancelGroup } from '../lib/jobs.mjs';
```

Função exportada:

```js
export async function cancelForGroup(ctx, job, flags) {
  if (job?.role !== GROUP_ROLE) return null;
  const { group, cancelledMembers } = await cancelGroup(ctx, job.id);
  if (flags.json) ctx.json({ group, cancelledMembers });
  else ctx.out(`# Grupo ${group.id} cancelado\n\nMembros cancelados: ${cancelledMembers.join(', ') || '(nenhum ativo)'}\n`);
  return ExitCode.OK;
}
```

No `run`, logo após resolver o job (com ou sem id) e antes do `cancelJob` do F2a:

```js
  const groupExit = await cancelForGroup(ctx, job, flags);
  if (groupExit !== null) return groupExit;
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/integration/groups.test.mjs`
Expected: PASS (6 testes). Se o teste do membro cancelado mostrar mais de um abort, confira a
premissa E5 (`cancelJob` não pode sinalizar o coordenador: o `workerMatcher(memberId)` não
casa com `--job-id <groupId>`).

- [ ] **Step 7: Suíte completa**

Run: `npm test`
Expected: PASS (inclui os testes de `status`/`result`/`cancel` do F2a).

- [ ] **Step 8: Commit**

```bash
git add plugins/opc/scripts/commands/status.mjs plugins/opc/scripts/commands/result.mjs plugins/opc/scripts/commands/cancel.mjs tests/integration/groups.test.mjs
git commit -m "feat: aggregate status, result and cancel for job groups"
```

---
### Task 11: Comando `command` (job `cmd` com worker e ponte de permissões)

**Files:**
- Create: `plugins/opc/scripts/commands/command.mjs`
- Test: `tests/integration/command.test.mjs`

**Interfaces:**
- Consumes: `openApi` (`respawn: false` no worker), `loadDiscovery`, `requireAgent`, `resolveModel`, `profileRules` (Task 4); `assertCommandUsable(cmdInfo, policy, agentsByName)` (F1); `api.commands()` (F1), `api.createSession`, `api.runCommand`, `api.abort` (F2a/Task 2); `createJob` (com `{ maxActive }`), `spawnWorker`, `waitForJob`, `readJob`, `updateJob`, `appendJobLog`, `assertNotInsideServer` (F2a); `withServerLock` (F2b); `readRawArgs` (F2a); `exitCodeForJob` (F2a, `commands/task.mjs`); `createRequestBridge`/`createSerialUpdater` (F2a, `commands/task-worker.mjs`); `newMessageId` (F2a); `classifyError` (F2a); `tryAcquireLock` (F0); `renderCommandResult` (Task 3); `renderPermissionRequest(job)` (F2a); `WORKER_DELEGATES.cmd` (Task 9).
- Produces: subcomando `command <cmd> [args...] [--agent a] [--model m] [--variant v] [--write] [--background] [--timeout s] [--wait-timeout s]` (texto livre por `--raw-args-stdin`); `runWorker(ctx, job)`; `textFromParts(parts)`. Job `kind: 'cmd'` com `request: { command, arguments, agent, model, variant, timeoutMs, profile, rules, subtask }`, `result: { command, arguments, sessionID, model, agent, finalText, error }`, `rendered`. `--json` → `{ job }`.

- [ ] **Step 1: Escrever o teste de integração (falha)**

Create `tests/integration/command.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, eventually } from '../helpers.mjs';
import { F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';

async function setup(t, { config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'command-sync', extra: { FAKE_COMMAND_DELAY_MS: '0', ...extra } });
  writeGlobalConfig(env, config); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const commandPosts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /^\/session\/[^/]+\/command$/.test(r.path));
const sessionPosts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/session');

test('command without args: arguments "", model as provider/model string, read-only session', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'echo'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /COMMAND echo ARGS\[\]/);
  const [post] = commandPosts(env);
  assert.equal(post.body.command, 'echo');
  assert.equal(post.body.arguments, '');
  assert.equal(post.body.model, F3_MODELS.deepseek);
  assert.equal(typeof post.body.model, 'string');
  assert.match(post.body.messageID, /^msg/);
  assert.equal('agent' in post.body, false);
  const session = sessionPosts(env).at(-1).body;
  assert.match(session.title, /^OPC: command: \/echo/);
  assert.deepEqual(session.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('command with args, alias model and explicit agent; leading slash accepted', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', '/echo', 'hello', 'world', '--model', 'strong', '--agent', 'build', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const [post] = commandPosts(env);
  assert.deepEqual({ a: post.body.arguments, m: post.body.model, g: post.body.agent }, { a: 'hello world', m: F3_MODELS.qwen, g: 'build' });
  const { job } = JSON.parse(res.stdout);
  assert.equal(job.kind, 'cmd');
  assert.match(job.id, /^cmd-/);
  assert.equal(job.result.finalText, 'COMMAND echo ARGS[hello world]');
});

test('pinned model/agent of the command go through policy; unknown command lists the available ones', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['command', 'pinned-model'], { env, cwd })).code, 4);
  assert.equal((await runCli(['command', 'pinned-agent'], { env, cwd })).code, 4);
  const unknown = await runCli(['command', 'nope'], { env, cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout + unknown.stderr, /echo/);
  assert.equal((await runCli(['command'], { env, cwd })).code, 2);
  assert.equal(commandPosts(env).length, 0);
  assert.equal(sessionPosts(env).length, 0);
});

test('command pinned to a subagent sends the pinned agent', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'sub-echo', 'x'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(commandPosts(env)[0].body.agent, 'general');
});

test('synchronous command longer than server.requestTimeoutSec still completes (long timeout)', async (t) => {
  const config = { ...F3_TEST_CONFIG, server: { bootTimeoutSec: 60, requestTimeoutSec: 1, configOverride: { share: 'disabled' } } };
  const { cwd, env } = await setup(t, { config, extra: { FAKE_COMMAND_DELAY_MS: '2500' } });
  const res = await runCli(['command', 'echo', 'slow'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /COMMAND echo ARGS\[slow\]/);
});

test('--background returns the job id; result prints the rendered output', async (t) => {
  const { cwd, env } = await setup(t);
  const bg = await runCli(['command', 'echo', 'bg', '--background', '--json'], { env, cwd });
  assert.equal(bg.code, 0, bg.stderr);
  const { job } = JSON.parse(bg.stdout);
  const result = await eventually(async () => {
    const r = await runCli(['result', job.id], { env, cwd });
    return r.code === 0 ? r : null;
  });
  assert.match(result.stdout, /# opc command \/echo/);
  assert.match(result.stdout, /COMMAND echo ARGS\[bg\]/);
});

test('an assistant error in the command response fails the job (exit 7)', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_COMMAND_ERROR: '1' } });
  const res = await runCli(['command', 'echo'], { env, cwd });
  assert.equal(res.code, 7);
  assert.match(res.stdout, /Erro: ProviderAuthError/);
});

test('--write creates the session with write rules', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['command', 'echo', '--write'], { env, cwd })).code, 0);
  assert.notDeepEqual(sessionPosts(env).at(-1).body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('--raw-args-stdin (the /opc:command path): name + arguments verbatim, flags pulled out', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', '--raw-args-stdin'], { env, cwd, stdin: `echo it's "$(x)" --model strong\n` });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const [post] = commandPosts(env);
  assert.deepEqual({ c: post.body.command, a: post.body.arguments, m: post.body.model }, { c: 'echo', a: `it's "$(x)"`, m: F3_MODELS.qwen });
});

test('refuses to start from inside the OpenCode server (exit 4, nothing sent)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'echo'], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd });
  assert.equal(res.code, 4, res.stdout + res.stderr);
  assert.equal(sessionPosts(env).length, 0);
  assert.equal(commandPosts(env).length, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/command.test.mjs`
Expected: FAIL (subcomando `command` desconhecido).

- [ ] **Step 3: Implementar `scripts/commands/command.mjs`**

```js
import { join } from 'node:path';
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, requireAgent, resolveModel, profileRules } from '../lib/context.mjs';
import { assertCommandUsable } from '../lib/policy.mjs';
import {
  createJob, spawnWorker, waitForJob, readJob, updateJob, appendJobLog, assertNotInsideServer, withServerLock,
} from '../lib/jobs.mjs';
import { newMessageId } from '../lib/runner.mjs';
import { classifyError } from '../lib/errors.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderCommandResult, renderPermissionRequest } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';
import { createRequestBridge, createSerialUpdater } from './task-worker.mjs';

const DEFAULT_COMMAND_TIMEOUT_SEC = 1800;

const SPEC = {
  flags: {
    agent: { type: 'string' },
    model: { type: 'string', alias: 'm' },
    variant: { type: 'string' },
    write: { type: 'boolean' },
    background: { type: 'boolean' },
    timeout: { type: 'number' },
    'wait-timeout': { type: 'number' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
    'raw-args-stdin': { type: 'boolean' },
  },
  allowPositionals: true,
};

export function textFromParts(parts) {
  return (parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic && !p.ignored)
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

export async function run(ctx, argv) {
  // Free text (D3): /opc:command sends `--raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'`; the first word of the text is
  // the command name and the rest are its arguments, verbatim.
  const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, SPEC);
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'use o texto do stdin (--raw-args-stdin) ou argumentos posicionais, não os dois');
  let rawName;
  let args;
  if (raw.text !== null) {
    const match = raw.text.trim().match(/^(\S+)\s*([\s\S]*)$/);
    rawName = match?.[1];
    args = match?.[2] ?? '';
  } else {
    rawName = positionals[0];
    args = positionals.slice(1).join(' ');
  }
  if (!rawName) throw new UsageError('NO_COMMAND', 'informe o command do OpenCode: /opc:command <cmd> [args] (veja /opc:catalog commands)');
  const name = rawName.replace(/^\//, '');
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(name)) throw new UsageError('INVALID_COMMAND', `nome de command inválido: ${JSON.stringify(rawName).slice(0, 80)}`);
  assertNotInsideServer(ctx.env); // exit 4 before connecting: delegation never recurses

  const conn = await openApi(ctx);
  let commands;
  let discovery;
  try {
    [commands, discovery] = await Promise.all([conn.api.commands(), loadDiscovery(conn.api)]);
  } finally {
    conn.close();
  }
  const cmd = (commands ?? []).find((c) => c.name === name);
  if (!cmd) {
    const names = (commands ?? []).map((c) => c.name).slice(0, 20).join(', ');
    throw new UsageError('UNKNOWN_COMMAND', `command desconhecido: /${name}. Disponíveis: ${names || '(nenhum)'}`);
  }
  const policy = ctx.config.policy ?? {};
  // Spec §6.4: model/agent pinned by the OpenCode command also pass through the policy
  // (F1 assertCommandUsable: pinned model with its provider, pinned agent and the agent's own pin).
  assertCommandUsable(cmd, policy, new Map(discovery.agents.map((a) => [a.name, a])));
  const agent = flags.agent ?? cmd.agent ?? ctx.config.defaultAgent ?? null;
  if (agent) requireAgent(discovery, agent, policy); // exists + F1 assertAgentUsable
  const model = flags.model
    ? resolveModel(ctx, discovery, 'task', flags.model, { variant: flags.variant }).full
    : (cmd.model ?? resolveModel(ctx, discovery, 'task', null, { variant: flags.variant }).full);
  const profile = flags.write ? 'write' : 'read-only';
  const title = `OPC: command: /${name}${args ? ` ${args}` : ''}`.replace(/\s+/g, ' ').slice(0, 100);

  // Top-level registration under the F2b server.lock, with jobs.maxActive from the config.
  const job = await withServerLock(ctx, () => createJob(ctx.stateDir, {
    kind: 'cmd',
    title,
    summary: `/${name} ${args}`.trim().slice(0, 80),
    workspaceRoot: ctx.workspaceRoot,
    claudeSessionId: ctx.claudeSessionId,
    status: 'queued',
    agent,
    model,
    variant: flags.variant ?? null,
    permissionProfile: profile,
    request: {
      command: name,
      arguments: args,
      agent,
      model,
      variant: flags.variant ?? null,
      timeoutMs: (flags.timeout ?? DEFAULT_COMMAND_TIMEOUT_SEC) * 1000,
      profile,
      rules: profileRules(ctx, profile),
      subtask: Boolean(cmd.subtask),
    },
  }, { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: 'register-job:cmd' });
  await spawnWorker(ctx, job.id);

  if (flags.background) {
    if (flags.json) ctx.json({ job: readJob(ctx.stateDir, job.id) ?? job });
    else ctx.out(`# opc command /${name}\n\nJob em background: ${job.id}\nAcompanhar: /opc:status ${job.id} --wait · resultado: /opc:result ${job.id}\n`);
    return ExitCode.OK;
  }
  const final = await waitForJob(ctx, job.id, {
    waitTimeoutMs: flags['wait-timeout'] ? flags['wait-timeout'] * 1000 : undefined,
    onLog: (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`),
  });
  if (flags.json) ctx.json({ job: final });
  else if (final.status === 'waiting_permission') ctx.out(renderPermissionRequest(final));
  else ctx.out(final.rendered ?? renderCommandResult(final.result ?? { command: name, arguments: args }));
  return exitCodeForJob(final);
}

// Worker for kind 'cmd' (delegated by task-worker). The /command route is synchronous and does not
// go through runTurn, so the EventHub tracks the session (and children, for subtask commands) and
// feeds the F2a bridge itself: *.asked → onPermission/onQuestion, *.replied/rejected → onResolved
// (the same release runTurn does through onRequestResolved).
export async function runWorker(ctx, job) {
  const { stateDir } = ctx;
  const req = job.request;
  const now = () => new Date().toISOString();
  const policy = ctx.config.policy ?? {};
  let conn;
  let release = null;
  try {
    // respawn: false — a worker never brings up another server mid-turn (F2a D9).
    conn = await openApi(ctx, { withHub: true, respawn: false });
    const { api, hub } = conn;
    const session = await api.createSession({ title: job.title, permission: req.rules });
    release = tryAcquireLock(join(stateDir, `session-${session.id}.lock`), { purpose: `job ${job.id}` });
    await updateJob(stateDir, job.id, { status: 'running', phase: 'running', startedAt: now(), sessionID: session.id });
    const updater = createSerialUpdater(stateDir, job.id);
    const bridge = createRequestBridge({
      update: (patch) => updater.update(patch),
      api,
      profileKind: req.profile, // 'read-only' | 'write'
      policy,
      timeoutMs: (policy.permissionTimeoutSec ?? 600) * 1000,
      log: (line) => appendJobLog(stateDir, job.id, line),
    });
    const bridgeError = (what) => (err) => appendJobLog(stateDir, job.id, `[opc] ${what} bridge: ${err.message}`);
    const untrack = hub.track(session.id, (event) => {
      const properties = event?.properties ?? {};
      switch (event?.type) {
        case 'permission.asked':
          bridge.onPermission(properties).catch(bridgeError('permission'));
          break;
        case 'question.asked':
          bridge.onQuestion(properties).catch(bridgeError('question'));
          break;
        case 'permission.replied':
          bridge.onResolved({ type: 'permission', requestID: properties.requestID, sessionID: properties.sessionID, outcome: properties.reply }).catch(bridgeError('permission'));
          break;
        case 'question.replied':
        case 'question.rejected':
          bridge.onResolved({ type: 'question', requestID: properties.requestID, sessionID: properties.sessionID, outcome: event.type === 'question.replied' ? 'replied' : 'rejected' }).catch(bridgeError('question'));
          break;
        default:
      }
    });
    let response = null;
    let failure = null;
    try {
      response = await api.runCommand(session.id, {
        command: req.command,
        arguments: req.arguments ?? '',
        agent: req.agent ?? undefined,
        model: req.model,
        variant: req.variant ?? undefined,
        messageID: newMessageId(),
        timeoutMs: req.timeoutMs,
      });
    } catch (err) {
      failure = err;
      if (err.code === 'TIMEOUT') await api.abort(session.id).catch(() => {});
    } finally {
      untrack();
      bridge.dispose();
      await updater.flush();
    }
    const latest = readJob(stateDir, job.id);
    const error = response?.info?.error ?? null;
    let patch;
    if (latest?.status === 'cancelled') patch = { status: 'cancelled' };
    else if (failure) patch = { status: 'failed', errorCode: failure.code === 'TIMEOUT' ? 'timeout' : (failure.code ?? 'error'), errorType: failure.code ?? failure.name, errorMessage: failure.message };
    else if (error) {
      const c = classifyError(error, { toolsRan: false });
      patch = { status: 'failed', errorClass: c.errorClass, errorType: c.errorType, errorMessage: c.message };
    } else patch = { status: 'completed' };
    const result = {
      command: req.command,
      arguments: req.arguments ?? '',
      sessionID: session.id,
      model: req.model,
      agent: req.agent ?? null,
      finalText: textFromParts(response?.parts),
      error: error ?? (failure ? { name: failure.code ?? 'Error', message: failure.message } : null),
    };
    await updateJob(stateDir, job.id, { ...patch, phase: patch.status, completedAt: now(), pendingRequest: null, result, rendered: renderCommandResult(result) });
    return exitCodeForJob(patch);
  } catch (err) {
    appendJobLog(stateDir, job.id, `[opc] command worker error: ${err.message}`);
    const latest = readJob(stateDir, job.id);
    if (latest && latest.status !== 'cancelled') {
      await updateJob(stateDir, job.id, { status: 'failed', errorCode: err.code ?? 'error', errorMessage: err.message, completedAt: now() });
    }
    return ExitCode.JOB_FAILED;
  } finally {
    release?.();
    conn?.close();
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/integration/command.test.mjs`
Expected: PASS (10 testes). O teste do timeout longo prova que o `runCommand` usa o
`timeoutMs` do job (30 min por padrão) e não o `server.requestTimeoutSec` (1 s no teste).

- [ ] **Step 5: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/commands/command.mjs tests/integration/command.test.mjs
git commit -m "feat: add command subcommand running OpenCode commands as jobs"
```

---

### Task 12: `attach.secret` no servidor e comando `attach` (inclusive `--pane`)

**Files:**
- Modify: `plugins/opc/scripts/lib/server.mjs`
- Create: `plugins/opc/scripts/commands/attach.mjs`
- Test: `tests/integration/attach.test.mjs`

**Interfaces:**
- Consumes: `writeFileAtomic` (F0); `ensureServer` (F0) e `stopServerUnlocked` (corpo privado do encerramento desde a F2b); `openApi` (Task 4); `assertId` (Task 2); `listJobs` (F2a); `shellQuote` (Task 3); `renderAttach` (Task 3); fixtures `tests/fixtures/bin/tmux` e `tests/fixtures/attach-probe.mjs` (Task 1); `startExternalFake` (Task 1).
- Produces: `ATTACH_SECRET_FILE`, `attachSecretPath`, `writeAttachSecret`, `removeAttachSecret`; subcomando `attach [sessionID] [--pane] [--json]`; `PANE_SCRIPT`, `PANE_SCRIPT_NAME`, `buildAttachArgs({ url, sessionID, directory })`, `resolveExecutable(name, pathEnv)`. `--json` → `{ url, sessionID, directory, attached, credential, argv, pane? }` (sem senha).

- [ ] **Step 1: Escrever o teste de integração (falha)**

Create `tests/integration/attach.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, stateDirFor, startExternalFake, REPO_ROOT } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { PANE_SCRIPT } from '../../plugins/opc/scripts/commands/attach.mjs';
import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import { resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';
import { createJob } from '../../plugins/opc/scripts/lib/jobs.mjs';

const ATTACH_PROBE = join(REPO_ROOT, 'tests/fixtures/attach-probe.mjs');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-attach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, { name = 'ws', extra = {} } = {}) {
  const cwd = makeWorkspace(t, { name });
  const env = testEnv(t, { scenario: 'f3-sessions', extra: { TMUX: '', ...extra } });
  writeGlobalConfig(env, F3_TEST_CONFIG); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const serverRecord = (stateDir) => JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8'));

test('server spawn writes attach.secret (0600, same password) and stop removes it', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['sessions'], { env, cwd })).code, 0);
  const stateDir = await stateDirFor(env, cwd);
  const secretPath = join(stateDir, 'attach.secret');
  assert.equal(readFileSync(secretPath, 'utf8'), serverRecord(stateDir).password);
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  assert.equal((await runCli(['setup', '--stop-server'], { env, cwd })).code, 0);
  assert.equal(existsSync(secretPath), false);
});

test('attach prints the command without the password; workspace with spaces is quoted', async (t) => {
  const { cwd, env } = await setup(t, { name: 'meu ws ç' });
  const res = await runCli(['attach', SEED.session], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const stateDir = await stateDirFor(env, cwd);
  const { password, url } = serverRecord(stateDir);
  const root = resolveWorkspaceRoot(cwd);
  assert.ok(!res.stdout.includes(password) && !res.stderr.includes(password));
  assert.ok(res.stdout.includes(`OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(join(stateDir, 'attach.secret'))})"`));
  assert.ok(res.stdout.includes(`opencode attach ${url} -s ${SEED.session} --dir ${shellQuote(root)}`));
  const json = JSON.parse((await runCli(['attach', SEED.session, '--json'], { env, cwd })).stdout);
  assert.deepEqual(json.argv, ['opencode', 'attach', url, '-s', SEED.session, '--dir', root]);
  assert.deepEqual(json.credential, { type: 'file', path: join(stateDir, 'attach.secret') });
  assert.equal(json.attached, false);
  assert.ok(!JSON.stringify(json).includes(password));
});

test('attach without id uses the session of the last job; unknown session → exit 2', async (t) => {
  const { cwd, env } = await setup(t, { extra: { OPC_COMPANION_SESSION_ID: 'claude-attach' } });
  assert.equal((await runCli(['sessions'], { env, cwd })).code, 0);
  const stateDir = await stateDirFor(env, cwd);
  await createJob(stateDir, { kind: 'task', title: 'done', status: 'completed', claudeSessionId: 'claude-attach', sessionID: SEED.session, workspaceRoot: cwd });
  const json = JSON.parse((await runCli(['attach', '--json'], { env, cwd })).stdout);
  assert.equal(json.sessionID, SEED.session);
  assert.equal((await runCli(['attach', 'ses_missing'], { env, cwd })).code, 2);
  assert.equal((await runCli(['attach', 'not-a-session'], { env, cwd })).code, 2);
});

test('--pane outside tmux is refused and tmux is never called', async (t) => {
  const log = join(scratch(t), 'tmux.log');
  const { cwd, env } = await setup(t, { extra: { FAKE_TMUX_LOG: log } });
  const res = await runCli(['attach', SEED.session, '--pane'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /tmux/);
  assert.equal(existsSync(log), false);
});

test('pane: tmux argv has no password and the pane script receives intact args', async (t) => {
  const dir = scratch(t);
  const log = join(dir, 'tmux.log');
  const probeLog = join(dir, 'probe.log');
  const { cwd, env } = await setup(t, { name: 'pane ws ç', extra: { TMUX: '/tmp/fake-tmux,999,0', FAKE_TMUX_LOG: log, OPC_ATTACH_OPENCODE_BIN: ATTACH_PROBE } });
  const res = await runCli(['attach', SEED.session, '--pane', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).pane.id, '%42');
  const stateDir = await stateDirFor(env, cwd);
  const { password, url } = serverRecord(stateDir);
  const root = resolveWorkspaceRoot(cwd);
  const entries = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 1);
  const { argv, hasPasswordEnv } = entries[0];
  assert.equal(hasPasswordEnv, false);
  assert.ok(argv.every((a) => !a.includes(password)), 'password must never be in tmux argv');
  assert.deepEqual(argv.slice(0, 7), ['split-window', '-h', '-P', '-F', '#{pane_id}', '-c', root]);
  const script = join(stateDir, 'attach-pane.sh');
  assert.equal(statSync(script).mode & 0o777, 0o700);
  assert.equal(readFileSync(script, 'utf8'), PANE_SCRIPT);
  assert.ok(!readFileSync(script, 'utf8').includes(password));
  const sha = createHash('sha256').update(password).digest('hex');
  const ran = spawnSync('/bin/sh', ['-c', argv[7]], { env: { PATH: process.env.PATH, PROBE_LOG: probeLog, EXPECTED_SHA256: sha }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const probe = JSON.parse(readFileSync(probeLog, 'utf8').trim());
  assert.deepEqual(probe.argv, ['attach', url, '-s', SEED.session, '--dir', root]);
  assert.equal(probe.passwordMatches, true);
  assert.equal(probe.passwordInArgv, false);
});

test('pane: tmux failure is reported with exit 2', async (t) => {
  const { cwd, env } = await setup(t, { extra: { TMUX: '/tmp/fake-tmux,999,0', FAKE_TMUX_FAIL: '1', OPC_ATTACH_OPENCODE_BIN: ATTACH_PROBE } });
  const res = await runCli(['attach', SEED.session, '--pane'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /tmux split-window falhou/);
});

test('attach mode (OPC_SERVER_URL) end to end: sessions, subagent and attach on an external server', async (t) => {
  const ext = await startExternalFake(t, { scenario: 'f3-sessions' });
  const log = join(scratch(t), 'tmux.log');
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions', extra: { OPC_SERVER_URL: ext.url, OPC_SERVER_PASSWORD: ext.password, TMUX: '/tmp/fake-tmux,1,0', FAKE_TMUX_LOG: log } });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  const created = await runCli(['session', 'new', '--title', 'ext', '--json'], { env, cwd });
  assert.equal(created.code, 0, created.stderr);
  const sid = JSON.parse(created.stdout).session.id;
  assert.ok(ext.fake.state.sessions[sid], 'session must exist on the external server');
  const listed = JSON.parse((await runCli(['sessions', '--json'], { env, cwd })).stdout);
  assert.ok(listed.sessions.some((s) => s.id === sid));

  const sub = await runCli(['subagent', '--agent', 'general', '--model', 'fast', '--json', 'hi'], { env, cwd });
  assert.equal(sub.code, 0, sub.stdout + sub.stderr);
  assert.equal(JSON.parse(sub.stdout).group.status, 'completed');

  const att = await runCli(['attach', sid, '--json'], { env, cwd });
  assert.equal(att.code, 0, att.stderr);
  const info = JSON.parse(att.stdout);
  assert.equal(info.url, ext.url);
  assert.equal(info.attached, true);
  assert.deepEqual(info.credential, { type: 'env', name: 'OPC_SERVER_PASSWORD' });
  const text = await runCli(['attach', sid], { env, cwd });
  assert.ok(!text.stdout.includes(ext.password));
  assert.match(text.stdout, /OPENCODE_SERVER_PASSWORD="\$OPC_SERVER_PASSWORD"/);

  const pane = await runCli(['attach', sid, '--pane'], { env, cwd });
  assert.equal(pane.code, 2);
  assert.equal(existsSync(log), false);
  const refresh = await runCli(['sessions', '--refresh'], { env, cwd });
  assert.equal(refresh.code, 2);
  assert.equal(ext.fake.state.f3.disposed, 0);

  const stateDir = await stateDirFor(env, cwd);
  assert.equal(existsSync(join(stateDir, 'server.json')), false);
  assert.equal(existsSync(join(stateDir, 'attach.secret')), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/attach.test.mjs`
Expected: FAIL (`attach.mjs` inexistente; `attach.secret` não existe).

- [ ] **Step 3: `attach.secret` em `lib/server.mjs`**

Acrescente (com `rmSync` de `node:fs` e `join` de `node:path` importados, se ainda não
estiverem):

```js
// --- F3: attach secret (spec §10.5) ---------------------------------------------------
// Dedicated 0600 file holding only the server password, read *inside* the tmux pane by
// `opc attach --pane`, so the password never shows up in any argv.
export const ATTACH_SECRET_FILE = 'attach.secret';

export function attachSecretPath(stateDir) {
  return join(stateDir, ATTACH_SECRET_FILE);
}

export function writeAttachSecret(stateDir, password) {
  if (!password) return;
  writeFileAtomic(attachSecretPath(stateDir), password, { mode: 0o600 });
}

export function removeAttachSecret(stateDir) {
  rmSync(attachSecretPath(stateDir), { force: true });
}
```

Chamadas novas (mudança de comportamento, registrar):
1. Em `ensureServer`, no caminho de **spawn bem-sucedido**, imediatamente antes de gravar o
   `server.json`: `writeAttachSecret(ctx.stateDir, password);` (a variável com a senha gerada
   no passo 5 do §5.1). Nunca no modo attach (`OPC_SERVER_URL`).
2. Em `stopServerUnlocked` (o corpo do encerramento desde a F2b; o `stopServer` exportado só
   decide o lock e o chama), quando o resultado for `'terminated'` ou `'killed'`, depois de
   remover o `server.json`: `removeAttachSecret(ctx.stateDir);`. Assim o arquivo some em
   qualquer caminho de parada (com ou sem `lockHeld`, inclusive o reaper da F2b).

- [ ] **Step 4: Implementar `scripts/commands/attach.mjs`**

```js
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { parseArgs, shellQuote } from '../lib/args.mjs';
import { ExitCode, OpcError, UsageError } from '../lib/opc-error.mjs';
import { openApi } from '../lib/context.mjs';
import { assertId } from '../lib/api.mjs';
import { attachSecretPath, writeAttachSecret } from '../lib/server.mjs';
import { listJobs } from '../lib/jobs.mjs';
import { renderAttach } from '../lib/render.mjs';

export const PANE_SCRIPT_NAME = 'attach-pane.sh';
export const PANE_SCRIPT = `#!/bin/sh
# Generated by opc (attach --pane). Reads the OpenCode server password from a
# 0600 file inside the pane, so it never appears in any process argv.
set -eu
secret_file=$1
opencode_bin=$2
shift 2
OPENCODE_SERVER_PASSWORD=$(cat "$secret_file")
export OPENCODE_SERVER_PASSWORD
exec "$opencode_bin" "$@"
`;

const SPEC = {
  flags: { pane: { type: 'boolean' }, json: { type: 'boolean' }, cwd: { type: 'string' } },
  allowPositionals: true,
};

export function resolveExecutable(name, pathEnv = process.env.PATH ?? '') {
  if (isAbsolute(name)) return name;
  for (const dir of String(pathEnv).split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return name;
}

export function buildAttachArgs({ url, sessionID, directory }) {
  return ['attach', url, ...(sessionID ? ['-s', sessionID] : []), '--dir', directory];
}

function lastJobSession(ctx) {
  const jobs = listJobs(ctx.stateDir, { claudeSessionId: ctx.claudeSessionId, all: !ctx.claudeSessionId })
    .filter((j) => j.sessionID && !j.groupId)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
  return jobs[0]?.sessionID ?? null;
}

function envWithoutSecrets(env) {
  const copy = { ...env };
  delete copy.OPENCODE_SERVER_PASSWORD;
  delete copy.OPC_SERVER_PASSWORD;
  return copy;
}

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const explicit = positionals[0] ? assertId('ses', positionals[0], 'sessão') : null;
  if (flags.pane && !ctx.env.TMUX) {
    throw new UsageError('NOT_IN_TMUX', '--pane só funciona dentro do tmux ($TMUX vazio). Rode /opc:attach sem --pane e use a linha impressa num terminal.');
  }
  const conn = await openApi(ctx);
  try {
    const { server, api } = conn;
    const sessionID = explicit ?? lastJobSession(ctx);
    if (sessionID) await api.getSession(sessionID);
    const attached = Boolean(server.attached);
    if (flags.pane && attached) {
      throw new UsageError('PANE_ATTACHED_MODE', '--pane não é suportado com OPC_SERVER_URL: o opc não guarda a senha de servidores externos. Use a linha impressa sem --pane.');
    }
    const directory = ctx.workspaceRoot;
    const credential = attached
      ? { type: 'env', name: 'OPC_SERVER_PASSWORD' }
      : { type: 'file', path: attachSecretPath(ctx.stateDir) };
    if (!attached) writeAttachSecret(ctx.stateDir, server.password);
    const info = { url: server.url, sessionID, directory, attached, credential, argv: ['opencode', ...buildAttachArgs({ url: server.url, sessionID, directory })] };

    if (flags.pane) {
      const scriptPath = join(ctx.stateDir, PANE_SCRIPT_NAME);
      writeFileSync(scriptPath, PANE_SCRIPT, { mode: 0o700 });
      chmodSync(scriptPath, 0o700);
      const opencodeBin = resolveExecutable(ctx.env.OPC_ATTACH_OPENCODE_BIN ?? 'opencode', ctx.env.PATH);
      const paneCommand = ['/bin/sh', scriptPath, credential.path, opencodeBin, ...buildAttachArgs({ url: server.url, sessionID, directory })]
        .map(shellQuote)
        .join(' ');
      const res = spawnSync('tmux', ['split-window', '-h', '-P', '-F', '#{pane_id}', '-c', directory, paneCommand], {
        env: envWithoutSecrets(ctx.env),
        encoding: 'utf8',
        shell: false,
      });
      if (res.error || res.status !== 0) {
        throw new OpcError('TMUX_FAILED', `tmux split-window falhou: ${String(res.stderr || res.error?.message || '').trim()}`, { exitCode: ExitCode.USAGE });
      }
      info.pane = { id: String(res.stdout).trim() };
    }

    if (flags.json) ctx.json(info);
    else ctx.out(renderAttach(info));
    return ExitCode.OK;
  } finally {
    conn.close();
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/integration/attach.test.mjs`
Expected: PASS (7 testes).

- [ ] **Step 6: Varredura de segredos nas saídas dos testes**

Run: `npm test && node scripts/scan-secrets.mjs tests/ plugins/`
Expected: suíte verde; scanner sem achados (nenhuma senha em fixture ou código).

- [ ] **Step 7: Commit**

```bash
git add plugins/opc/scripts/lib/server.mjs plugins/opc/scripts/commands/attach.mjs tests/integration/attach.test.mjs
git commit -m "feat: add attach command with tmux pane reading a 0600 secret file"
```

---

### Task 13: Slash commands e skill `opc-result-handling`

**Files:**
- Create: `plugins/opc/commands/sessions.md`, `session.md`, `subagent.md`, `command.md`, `attach.md`
- Modify: `plugins/opc/skills/opc-result-handling/SKILL.md` (seção F3 no fim)
- Test: `tests/unit/commands-f3-frontmatter.test.mjs`

**Interfaces:**
- Consumes: subcomandos das Tasks 4–12; formato de invocação da spec §4 (heredoc com `'OPC_ARGS'`).
- Produces: `/opc:sessions`, `/opc:session`, `/opc:subagent`, `/opc:command` (modelo pode invocar) e `/opc:attach` (`disable-model-invocation: true`, `Bash(opc:*)`, `Bash(tmux:*)`).

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/unit/commands-f3-frontmatter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from '../helpers.mjs';

function frontmatter(name) {
  const text = readFileSync(join(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name}.md needs a frontmatter block`);
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')];
  }));
  return { fields, body: match[2] };
}

// D3: free text (subagent prompt, command arguments) → --raw-args-stdin; flags/ids only → --args-stdin.
const STDIN_FLAG = { sessions: '--args-stdin', session: '--args-stdin', subagent: '--raw-args-stdin', command: '--raw-args-stdin', attach: '--args-stdin' };

for (const name of Object.keys(STDIN_FLAG)) {
  test(`${name}.md: description, heredoc invocation (${STDIN_FLAG[name]}), opc-only Bash`, () => {
    const { fields, body } = frontmatter(name);
    assert.ok(fields.description?.length > 10);
    assert.ok(fields['argument-hint']);
    assert.match(fields['allowed-tools'], /Bash\(opc:\*\)/);
    assert.doesNotMatch(fields['allowed-tools'], /Bash\((node|npm|git|rm|sh)/);
    assert.ok(body.includes(`opc ${name} ${STDIN_FLAG[name]} <<'OPC_ARGS_5f1d0c7a_EOF'\n$ARGUMENTS\nOPC_ARGS`));
    assert.doesNotMatch(body, /--dangerously|--no-verify/);
  });
}

test('only attach disables model invocation and allows tmux', () => {
  for (const name of ['sessions', 'session', 'subagent', 'command']) {
    const { fields } = frontmatter(name);
    assert.equal(fields['disable-model-invocation'], undefined, name);
    assert.doesNotMatch(fields['allowed-tools'], /tmux/, name);
  }
  const { fields } = frontmatter('attach');
  assert.equal(fields['disable-model-invocation'], 'true');
  assert.match(fields['allowed-tools'], /Bash\(tmux:\*\)/);
});

test('session.md asks the user before --confirmed-by-user', () => {
  const { fields, body } = frontmatter('session');
  assert.match(fields['allowed-tools'], /AskUserQuestion/);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /--confirmed-by-user/);
});

test('opc-result-handling skill documents revert confirmation and groups', () => {
  const skill = readFileSync(join(PLUGIN_ROOT, 'skills/opc-result-handling/SKILL.md'), 'utf8');
  assert.match(skill, /## Sessões: revert e unrevert/);
  assert.match(skill, /## Grupos de subagentes/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/commands-f3-frontmatter.test.mjs`
Expected: FAIL (`ENOENT ... commands/sessions.md`).

- [ ] **Step 3: Criar os arquivos de comando**

Create `plugins/opc/commands/sessions.md`:

````markdown
---
description: Lista as sessões OPC do OpenCode neste workspace (--all para todas)
argument-hint: '[--all] [--limit N] [--refresh] [--json]'
allowed-tools: Bash(opc:*)
---

Execute exatamente:

```bash
opc sessions --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

- Apresente a saída como veio (tabela Markdown), sem resumir.
- `--refresh` descarta a instância do servidor do opc para reler o storage; só use se o usuário pedir.
````

Create `plugins/opc/commands/session.md`:

````markdown
---
description: Gerencia sessões do OpenCode (new, show, fork, revert, unrevert, summarize, children, diff, todo)
argument-hint: '<new|show|fork|revert|unrevert|summarize|children|diff|todo> [sessionID] [messageID] [--title t] [--agent a] [--model m] [--write]'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Execute exatamente:

```bash
opc session --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Regras:
- Apresente a saída ao usuário sem resumir. Em `show`, preserve os IDs de mensagem (são eles que `fork` e `revert` usam).
- Código de saída 2 com "confirmação necessária" (revert/unrevert) **não é erro**: siga a skill `opc-result-handling`. Mostre o diff afetado, pergunte com AskUserQuestion ("Reverter" / "Cancelar") e, só se o usuário escolher reverter, rode o comando impresso, que já traz `--confirmed-by-user`.
- Nunca acrescente `--confirmed-by-user` por conta própria, nem reaproveite uma confirmação anterior para outra sessão ou mensagem.
````

Create `plugins/opc/commands/subagent.md`:

````markdown
---
description: Dispara subagentes do OpenCode em paralelo (um por agente/modelo) como um grupo de jobs
argument-hint: '--agent a[,b,c] [--model m[,m2,m3]] [--write] [--background] [--mechanism child-session|subtask] <prompt>'
allowed-tools: Bash(opc:*)
---

Execute exatamente (o heredoc com delimitador entre aspas não expande nada; não edite, cite nem escape os argumentos — as flags conhecidas são extraídas do texto e o resto vira o prompt, sem mudança):

```bash
opc subagent --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

- Apresente o resultado de **cada** membro separadamente (agente, modelo, sessão, texto ou erro); não funda as respostas numa só sem avisar.
- Exit 3: um membro pediu permissão ou fez pergunta. Siga a skill `opc-result-handling` (pergunte ao usuário antes de qualquer `/opc:permissions reply`).
- `--write` roda os membros em série e pode editar arquivos: só use se o usuário pediu escrita.
````

Create `plugins/opc/commands/command.md`:

````markdown
---
description: Roda um slash command do OpenCode (veja /opc:catalog commands) num job próprio
argument-hint: '<cmd> [args...] [--agent a] [--model m] [--write] [--background]'
allowed-tools: Bash(opc:*)
---

Execute exatamente (o heredoc com delimitador entre aspas não expande nada; não edite, cite nem escape os argumentos — a primeira palavra é o command, o resto são os argumentos dele, sem mudança):

```bash
opc command --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

- Apresente a saída sem resumir.
- Exit 4: o command fixa um modelo ou agente negado pela política; explique e não tente contornar.
- Exit 3: pedido de permissão pendente; siga a skill `opc-result-handling`.
````

Create `plugins/opc/commands/attach.md`:

````markdown
---
description: Mostra como abrir uma sessão do opc na TUI do OpenCode; --pane abre num split do tmux
argument-hint: '[sessionID] [--pane] [--json]'
disable-model-invocation: true
allowed-tools: Bash(opc:*), Bash(tmux:*)
---

Execute exatamente:

```bash
opc attach --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

- Apresente a saída como veio. A linha impressa lê a senha de um arquivo de modo 600 para a variável de ambiente; nunca peça, mostre ou copie a senha.
- `--pane` precisa do tmux; se falhar, mostre a linha impressa para o usuário rodar num terminal.
````

- [ ] **Step 4: Acrescentar a seção F3 à skill**

Acrescente no fim de `plugins/opc/skills/opc-result-handling/SKILL.md`:

```markdown
## Sessões: revert e unrevert

- `opc session revert|unrevert` sem `--confirmed-by-user` sai com código 2 e imprime o diff
  afetado e o comando de confirmação. Isso é um pedido de confirmação, não uma falha.
- Mostre ao usuário os arquivos e os trechos do diff e pergunte com AskUserQuestion:
  "Reverter a sessão <id> a partir de <mensagem>?" (opções "Reverter" e "Cancelar"; para
  unrevert, "Desfazer o revert" e "Cancelar").
- Só com a resposta afirmativa, rode **exatamente** o comando impresso (ele já traz
  `--confirmed-by-user`). A confirmação vale para aquela sessão e aquela mensagem, e só.
- "Cancelar" ou silêncio: não rode nada e diga que nada foi alterado.

## Grupos de subagentes

- O resultado de `/opc:subagent` e o `/opc:result` de um grupo têm uma seção por membro.
  Apresente cada membro com agente, modelo e sessão; marque falhas e cancelados.
- Grupo `completed` com avisos = alguns membros falharam; diga quais.
- Pedido de permissão ou pergunta de um membro: mesmo fluxo de `/opc:permissions` (aprovador,
  destrutivos sempre com o usuário). Cancelar um membro (`/opc:cancel <membro>`) aborta só a
  sessão dele; `/opc:cancel <grupo>` cancela todos.

## /opc:attach

- É só do usuário (`disable-model-invocation`). Não sugira `--pane` fora do tmux e nunca
  exponha a senha do servidor.
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/commands-f3-frontmatter.test.mjs`
Expected: PASS (9 testes).

- [ ] **Step 6: Suíte completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/opc/commands/sessions.md plugins/opc/commands/session.md plugins/opc/commands/subagent.md plugins/opc/commands/command.md plugins/opc/commands/attach.md plugins/opc/skills/opc-result-handling/SKILL.md tests/unit/commands-f3-frontmatter.test.mjs
git commit -m "feat: add F3 slash commands and revert/group guidance to result skill"
```

---
### Task 14: Documentação da fase (commands, troubleshooting, architecture, README, CHANGELOG, modelo de relatório)

**Files:**
- Modify: `docs/commands.md` (seções novas no fim), `docs/troubleshooting.md`, `docs/architecture.md`, `README.md` (mapa de comandos), `CHANGELOG.md`
- Create: `docs/phases/F3-report.md` (modelo, preenchido no portão)

**Interfaces:**
- Consumes: comportamento das Tasks 4–13.
- Produces: documentação da F3 (spec §12); o bloco "Saída real" de cada exemplo é colado no portão (Task 16, Step 6) a partir de `docs/phases/F3-live-output.md`.

- [ ] **Step 1: Acrescentar em `docs/commands.md`**

````markdown
## Sessões

### `/opc:sessions`

Lista as sessões do OpenCode criadas pelo opc neste workspace: título com o prefixo `OPC: `,
sessões raiz (sem pai) e do diretório do workspace, da mais recente para a mais antiga.

| Flag | Efeito |
|---|---|
| `--all` | Mostra todas as sessões que o servidor conhece para o projeto, inclusive filhas e as criadas na TUI |
| `--limit N` | Máximo de linhas (padrão 30) |
| `--refresh` | Chama `POST /instance/dispose` para o servidor do opc reler o storage. Recusado com jobs ativos ou com `OPC_SERVER_URL`. Uma TUI anexada ao servidor do opc é desconectada da instância e reconecta |
| `--json` | `{ sessions, total, filtered }` |

Exemplo:

```bash
opc sessions
opc sessions --all --limit 10 --json
```

### `/opc:session`

| Ação | Uso | Endpoint |
|---|---|---|
| `new` | `new [--title t] [--agent a] [--model m] [--write]` | `POST /session` com `title: "OPC: session: <t>"`, `agent`, `model: {id, providerID}` e as regras do perfil (`read-only` por padrão) |
| `show` | `show <sessionID> [--limit N]` | `GET /session/:id`, `/session/status`, `/session/:id/message` (lista os IDs de mensagem usados por `fork` e `revert`) |
| `fork` | `fork <sessionID> [messageID]` | `POST /session/:id/fork {messageID?}`; o fork leva o histórico **anterior** à mensagem |
| `revert` | `revert <sessionID> <messageID> [--part prt_…] [--confirmed-by-user]` | `POST /session/:id/revert {messageID, partID?}` |
| `unrevert` | `unrevert <sessionID> [--confirmed-by-user]` | `POST /session/:id/unrevert` |
| `summarize` | `summarize <sessionID> [--model m] [--timeout s]` | `POST /session/:id/summarize {providerID, modelID}` (síncrono, padrão 600 s) |
| `children` | `children <sessionID>` | `GET /session/:id/children` |
| `diff` | `diff <sessionID> [--message msg_…]` | `GET /session/:id/diff[?messageID]` (inline até 400 KB; acima disso, lista os arquivos omitidos) |
| `todo` | `todo <sessionID>` | `GET /session/:id/todo` |

Regras:

- IDs são validados antes de qualquer conexão (`ses…`, `msg…`, `prt…`, só letras, números,
  `_` e `-`); ID inválido → exit 2.
- **`revert` e `unrevert` exigem `--confirmed-by-user`.** Sem a flag, o comando sai com
  código 2, mostra o diff afetado (união dos diffs das mensagens de usuário a partir da
  mensagem alvo; no unrevert, o diff guardado no revert) e imprime o comando de confirmação.
  No Claude, a skill `opc-result-handling` só roda esse comando depois de perguntar ao usuário.
- `revert`, `unrevert` e `summarize` recusam (exit 2) sessão em uso por um job do opc
  (`session-<id>.lock`) ou ocupada no servidor.
- O modelo do `summarize` segue a resolução do §6 da spec (`--model` → modelo do summarize →
  rota → `defaultModel` → default do OpenCode), sempre pela política (negado → exit 4).

Exemplos:

```bash
opc session new --title "investigar login" --model strong
opc session show ses_XXXXXXXX
opc session fork ses_XXXXXXXX msg_YYYYYYYY
opc session revert ses_XXXXXXXX msg_YYYYYYYY            # exit 2: mostra o diff e pede confirmação
opc session revert ses_XXXXXXXX msg_YYYYYYYY --confirmed-by-user
opc session unrevert ses_XXXXXXXX --confirmed-by-user
opc session summarize ses_XXXXXXXX --model strong
opc session diff ses_XXXXXXXX
opc session todo ses_XXXXXXXX
```

## Subagentes

### `/opc:subagent`

```
opc subagent --agent a[,b,c] [--model m[,m2,m3]] [--variant v] [--write] [--background]
             [--mechanism child-session|subtask] [--prompt-file f] [--timeout s] [--wait-timeout s] <prompt>
```

- Cria um **grupo** (job `sub-…`, papel `group`) e um membro por par agente/modelo
  (`member:<n>`). Pareamento: listas do mesmo tamanho pareiam por posição; 1 agente com N
  modelos, ou N agentes com 1 modelo (ou nenhum), expandem. Máximo de 8 membros.
- Agentes aceitos: modo `subagent` ou `all` (veja `/opc:agents --mode subagent`). Cada agente,
  o modelo que ele fixa e cada modelo passam pela política antes de criar qualquer sessão.
- Um único worker coordenador roda os membros em paralelo, até `jobs.maxParallel` (padrão
  4); com `--write`, em série. O grupo conta como **um** job no `jobs.maxActive`.
- **Mecanismo padrão `child-session`:** uma sessão pai `OPC: subagents: …` e, por membro, uma
  sessão filha `POST /session {parentID, agent}` + `prompt_async`. Se o OpenCode recusar um
  agente `subagent` como agente de sessão, o membro cai para **`subtask`**: uma sessão
  portadora filha recebe uma parte `{type: "subtask", prompt, description, agent, model}`.
  O resultado de cada membro informa `mechanism` e `fellBack`.
- `status`, `result` e `cancel` do grupo agregam os membros: algum pedindo permissão →
  `waiting_permission` (exit 3); algum ativo → `running`; senão, algum concluído →
  `completed` (com avisos se outros falharam); senão `failed` ou `cancelled`.
- `/opc:cancel <membro>` aborta só a sessão daquele membro; `/opc:cancel <grupo>` cancela
  todos.
- `--json` → `{ group, members }`.

Exemplos:

```bash
opc subagent --agent general --model fast,strong,k3 "Liste os riscos deste módulo em 3 itens"
opc subagent --agent explore,general "Onde a configuração é carregada?" --background
opc status sub-XXXX --wait
opc result sub-XXXX
opc cancel sub-XXXX-membro
```

## Commands do OpenCode

### `/opc:command`

```
opc command <cmd> [args...] [--agent a] [--model m] [--variant v] [--write] [--background] [--timeout s] [--wait-timeout s]
```

- Busca o command em `GET /command` (veja `/opc:catalog commands`); desconhecido → exit 2 com
  a lista.
- Modelo e agente fixados pelo command passam pela política (negado → exit 4).
- Roda num job `cmd-…` numa sessão nova `OPC: command: /<cmd> …`, com perfil `read-only`
  (ou `write` com `--write`), via `POST /session/:id/command {command, arguments, model:
  "provider/model", agent?, variant?}`. `arguments` vai como `""` quando vazio. A chamada é
  síncrona e usa o timeout do job (padrão 30 min), não o `server.requestTimeoutSec`.
- Modelo enviado: `--model` > modelo fixado no command > rota `task`. Agente: `--agent` >
  agente fixado > `defaultAgent` > padrão do OpenCode.
- Permissões e perguntas durante o command seguem a ponte (exit 3), como no `task`.

Exemplos:

```bash
opc catalog commands
opc command review
opc command minha-checagem arquivo.ts --model strong --background
```

## Attach

### `/opc:attach` (só o usuário invoca)

```
opc attach [sessionID] [--pane] [--json]
```

- Imprime a linha para abrir a sessão na TUI do OpenCode, **sem a senha**:

  ```bash
  OPENCODE_SERVER_PASSWORD="$(cat '<stateDir>/attach.secret')" opencode attach http://127.0.0.1:<porta> -s <sessionID> --dir '<workspace>'
  ```

  O `<stateDir>/attach.secret` (modo 600) guarda só a senha do servidor do opc; é escrito a
  cada subida do servidor e apagado quando ele é encerrado. A senha vai para a variável de
  ambiente e nunca para a linha de comando.
- Sem `sessionID`, usa a sessão do último job desta sessão do Claude; sem nenhum, a TUI abre o
  seletor.
- `--pane` (dentro do tmux): abre um split que roda um script gerado
  (`<stateDir>/attach-pane.sh`, modo 700) que lê a senha do arquivo **dentro do pane**. Nem o
  `tmux` nem o `opencode attach` recebem a senha em argv. Fora do tmux → exit 2.
- Com `OPC_SERVER_URL` (servidor externo), a linha usa `"$OPC_SERVER_PASSWORD"` e `--pane` é
  recusado: o opc não guarda senhas de servidores que não subiu.
- Gancho de teste: `OPC_ATTACH_OPENCODE_BIN` troca o binário executado no pane.

Exemplos:

```bash
opc attach ses_XXXXXXXX
opc attach --pane ses_XXXXXXXX
```
````

- [ ] **Step 2: Acrescentar em `docs/troubleshooting.md`**

```markdown
## TUI do OpenCode e o servidor do opc no mesmo projeto (storage concorrente)

O OpenCode guarda sessões num storage compartilhado por usuário. A TUI (`opencode`) e o
servidor que o opc sobe (`opencode serve`) podem estar abertos no mesmo projeto ao mesmo
tempo. Resultado da F3 (§15, item 12): ver `docs/phases/F3-report.md`.

- Sintoma: a TUI não mostra uma sessão criada pelo opc, ou o contrário. Rode
  `opc sessions --all`; se faltar, `opc sessions --refresh` (sem jobs ativos) faz o servidor do
  opc reler o storage.
- Sintoma: `SQLITE_BUSY` ou `database is locked` no `server.log` do estado do workspace.
  Evite escrever na mesma sessão pela TUI e pelo opc ao mesmo tempo; prefira abrir a sessão do
  opc na TUI com `/opc:attach`, que usa o mesmo servidor.

## `/opc:attach --pane` não abre

- `$TMUX` vazio: rode dentro do tmux, ou use a linha impressa por `/opc:attach`.
- `tmux split-window falhou`: confira `tmux -V` (≥ 3.0) e se há um servidor tmux ativo.
- A TUI abre e pede senha: o `attach.secret` não corresponde ao servidor atual. Rode
  `/opc:attach` de novo (ele regrava o arquivo) ou `/opc:setup` para conferir o servidor.
- Com `OPC_SERVER_URL`, `--pane` não é suportado (por desenho).

## Revert não mostra arquivos

O diff afetado vem de `GET /session/:id/diff?messageID=…` para cada mensagem de usuário a partir
da mensagem alvo. Mensagens sem edição de arquivo não têm diff; o revert, nesse caso, só muda o
histórico. `opc session diff <id> --message <msg>` mostra o diff de uma mensagem.
```

- [ ] **Step 3: Acrescentar em `docs/architecture.md`**

```markdown
## Grupos de jobs e subagentes (F3)

- Um grupo é um job com `role: "group"` e `memberIds`; cada membro é um job com `groupId` e
  `role: "member:<n>"`. Só o grupo conta no `jobs.maxActive` e na poda.
- `opc task-worker --job-id <grupo>` delega, por `kind`, ao `runWorker` do módulo do comando
  (`WORKER_DELEGATES`: `sub` → `subagent.mjs`, `cmd` → `command.mjs`).
- O coordenador abre **um** `EventHub`, cria a sessão pai e roda os membros com
  `runWithConcurrency(memberIds, jobs.maxParallel, …)`. Cada membro chama
  `dispatchSubagent(...)` (`lib/runner.mjs`): sessão filha com o agente ou, se recusada, parte
  `subtask` numa sessão portadora.
- A ponte de pedidos é a da F2a (`createRequestBridge`/`createSerialUpdater`,
  `commands/task-worker.mjs`), uma por membro, com o `update` embrulhado para chamar
  `refreshGroup`: põe o membro em `waiting_permission` e o `pendingRequest` do grupo vira a
  lista dos pedidos dos membros, cada um com `memberId`; a liberação vem do
  `onRequestResolved` do `runTurn`.
- Vida dos membros: `workerLost` nunca marca um membro sozinho; quando a reconciliação perde o
  grupo (`worker_lost`), perde também os membros ativos. Membros não contam no `jobs.maxActive`
  nem são barrados por ele. Eles ainda herdam `pid`/`pidStartTime` do coordenador (inofensivo:
  o `workerMatcher(membro)` não casa com o cmdline do coordenador, então cancelar um membro só
  aborta a sessão dele).

## attach e a senha do servidor (F3)

- `ensureServer` grava `<stateDir>/attach.secret` (600) a cada spawn; o encerramento (`stopServerUnlocked`, chamado por `stopServer` com ou sem `lockHeld`) apaga.
- `/opc:attach --pane` gera `<stateDir>/attach-pane.sh` (700) e chama
  `tmux split-window … '/bin/sh <script> <secret> <opencode> attach <url> -s <id> --dir <ws>'`
  com o ambiente sem variáveis de senha; o script exporta `OPENCODE_SERVER_PASSWORD` dentro do
  pane e faz `exec` do `opencode`.
```

- [ ] **Step 4: Atualizar o mapa de comandos do `README.md`**

Na tabela/lista de comandos do README, acrescente:

```markdown
| `/opc:sessions` | Lista as sessões OPC do workspace (`--all` para todas) |
| `/opc:session` | `new`, `show`, `fork`, `revert`/`unrevert` (com confirmação), `summarize`, `children`, `diff`, `todo` |
| `/opc:subagent` | Subagentes em paralelo, um por agente/modelo, como um grupo de jobs |
| `/opc:command` | Roda um slash command do OpenCode |
| `/opc:attach` | Abre a sessão na TUI do OpenCode (`--pane` no tmux); só o usuário invoca |
```

- [ ] **Step 5: CHANGELOG**

Em `CHANGELOG.md`, sob `## [Unreleased]`:

```markdown
### Added (F3 — sessões, subagentes, commands, attach)
- `/opc:sessions` e `/opc:session` (new, show, fork, revert/unrevert com `--confirmed-by-user` e diff afetado, summarize, children, diff, todo).
- `/opc:subagent`: grupo de jobs com N membros concorrentes (`jobs.maxParallel`), sessão filha por membro com fallback para a parte `subtask`; `status`/`result`/`cancel` agregados; cancelar um membro aborta só a sessão dele.
- `/opc:command`: roda commands do OpenCode num job, com a política aplicada ao modelo/agente fixados.
- `/opc:attach` e `--pane` no tmux, com a senha lida de `<stateDir>/attach.secret` (600) dentro do pane.

### Changed
- `jobs.maxActive` e a poda contam um grupo como um job (membros nunca são barrados por `maxActive`); `/opc:cancel` sem id ignora membros de grupo.
- Membro de grupo não vira `worker_lost` sozinho; um grupo perdido derruba os membros ativos.
- O servidor gerenciado grava `attach.secret` ao subir e o apaga ao encerrar.
```

- [ ] **Step 6: Criar o modelo de relatório `docs/phases/F3-report.md`**

```markdown
# Relatório da fase F3 — Sessões, subagentes, commands, attach

- Data do portão: DD/MM/AAAA
- Branch / PR: `feat/opc-f3` / #
- OpenCode: 1.18.32 · Node: (versão) · tmux: (versão)
- Modelos ao vivo: `omniroute-mvalmeida/opencode-go/{deepseek-v4.1-flash,qwen3.8-max,kimi-k3}`

Legenda: `PASSOU` (executado e conferido), `N/A` (não se aplica, com motivo),
`NÃO VALIDADO` (não foi possível verificar, com motivo). Nenhum item fica sem status.

## 1. `npm test`

| Item | Status | Evidência |
|---|---|---|
| Suíte completa (unit + integração) | | contagem de testes e trecho final da saída |

## 2. Aceite de integração (spec §13.3 F3)

| Item | Status | Teste |
|---|---|---|
| Cada ação com o corpo certo (`summarize` com modelo, `revert` com `messageID`, `command` com `model` string e `arguments`) | | `session-actions`, `session-revert`, `command` |
| `revert` sem `--confirmed-by-user` → recusa com diff | | `session-revert` |
| Grupo com N membros: status, result e cancel agregados | | `subagent`, `groups` |
| `attach --pane` sem a senha em argv | | `attach` (pane) |
| Modo attach (`OPC_SERVER_URL`) de ponta a ponta | | `attach` (attach mode) |

## 3. Aceite ao vivo

| Item | Modelo | Status | Evidência (`docs/phases/F3-live-output.md`) |
|---|---|---|---|
| `session new` | deepseek-v4.1-flash | | |
| `fork` conferido no histórico | deepseek-v4.1-flash | | |
| `revert`/`unrevert` no histórico **e** no arquivo | deepseek-v4.1-flash | | |
| `summarize` | qwen3.8-max | | |
| `diff`, `todo`, `children` | deepseek-v4.1-flash | | |
| 3 subagentes em paralelo, um por modelo, cada um com resultado próprio | os três | | |
| `/opc:command` (command escolhido e critério) | kimi-k3 | | |
| `attach` (manual do operador) | — | | |
| `attach --pane` (manual do operador) | — | | |
| `contract.mjs` + `f3-session-shapes.mjs` | — | | |

## 4. Itens A CONFIRMAR (spec §15)

| Item | Resposta | Evidência |
|---|---|---|
| 7 — agente `subagent` como agente de sessão filha | | `f3-probe-subagent-mode` |
| 7b — regras da sessão portadora valem para a neta criada pelo `subtask`? | | idem |
| 12 — storage concorrente TUI × servidor do opc | | `f3-concurrent-storage` + checagem manual |
| Diff por mensagem (`GET /session/:id/diff?messageID`) cobre o revert | | `f3-sessions` |
| `session.revert.diff` presente no 1.18.32 | | `f3-session-shapes` |

## 5. Pontos de encaixe com F0–F2b

| Premissa | Conferida? | Ajuste feito |
|---|---|---|

## 6. Desvios e mudanças de comportamento

- `maxActive`/poda contam grupo como 1 e `createJob` não aplica `maxActive` a membros; `workerLost` é `false` para membros e a reconciliação de um grupo perdido derruba os membros ativos; `resolveJobRef` sem id ignora membros; `ensureServer`/`stopServerUnlocked` gravam/apagam `attach.secret`.

## 7. Documentação

| Item | Status |
|---|---|
| `docs/commands.md` (sessões, subagentes, command, attach) com saídas reais | |
| `docs/troubleshooting.md`, `docs/architecture.md`, README, CHANGELOG | |
| `node scripts/scan-secrets.mjs docs/` sem achados | |
```

- [ ] **Step 7: Varredura e commit**

Run: `node scripts/scan-secrets.mjs docs/`
Expected: sem achados.

```bash
git add docs/commands.md docs/troubleshooting.md docs/architecture.md README.md CHANGELOG.md docs/phases/F3-report.md
git commit -m "docs: document F3 sessions, subagents, command and attach"
```

---

### Task 15: Testes ao vivo da F3

**Files:**
- Create: `tests/live/_f3-lib.mjs`, `tests/live/f3-sessions.mjs`, `tests/live/f3-subagents.mjs`, `tests/live/f3-command.mjs`, `tests/live/f3-probe-subagent-mode.mjs`, `tests/live/f3-concurrent-storage.mjs`, `tests/live/f3-session-shapes.mjs`

**Interfaces:**
- Consumes: `runCli`, `stopAllServers`, `REPO_ROOT` (`tests/helpers.mjs`); `registerSecret`, `redactText` (F0); `createClient` (F0); `createApi` (Task 2); `startFake` (F0); `pickFreePort` (F0); `workspaceStateDir`, `resolveWorkspaceRoot` (F0).
- Produces: testes guardados por `OPC_LIVE=1` que anexam saídas redigidas em `docs/phases/F3-live-output.md`.

- [ ] **Step 1: Biblioteca comum dos testes ao vivo**

Create `tests/live/_f3-lib.mjs` (o prefixo `_` evita que o `node --test tests/live/f3-*.mjs` a rode):

```js
// Shared helpers for the F3 live tests (OPC_LIVE=1). Real OpenCode, real models, disposable dirs.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli, stopAllServers, REPO_ROOT } from '../helpers.mjs';
import { registerSecret, redactText } from '../../plugins/opc/scripts/lib/redact.mjs';
import { workspaceStateDir, resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';

export const LIVE = process.env.OPC_LIVE === '1';
export const SKIP = LIVE ? false : 'OPC_LIVE!=1 (teste ao vivo)';
const PREFIX = 'omniroute-mvalmeida/opencode-go/';
export const MODELS = Object.freeze({ deepseek: `${PREFIX}deepseek-v4.1-flash`, qwen: `${PREFIX}qwen3.8-max`, kimi: `${PREFIX}kimi-k3` });
export const REPORT = join(REPO_ROOT, 'docs/phases/F3-live-output.md');

export function liveWorkspace(t, { name = 'ws' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opc-live-f3-'));
  const ws = join(root, name);
  const dataDir = join(root, 'data');
  mkdirSync(ws);
  mkdirSync(dataDir, { mode: 0o700 });
  const git = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'opc-live');
  git('config', 'user.email', 'opc-live@example.invalid');
  writeFileSync(join(ws, 'notes.txt'), 'original\n');
  writeFileSync(join(ws, 'README.md'), '# Live F3 workspace\n\nDisposable repository for opc F3 live tests.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const env = { ...process.env, OPC_DATA_DIR: dataDir, OPC_COMPANION_SESSION_ID: `live-f3-${Date.now()}` };
  delete env.OPC_SERVER_URL;
  delete env.OPC_SERVER_PASSWORD;
  t.after(() => stopAllServers(env, ws));
  return { root, ws, env, dataDir, stateDir: () => workspaceStateDir(dataDir, resolveWorkspaceRoot(ws)) };
}

export function opc(args, { env, cwd, stdin = '', timeoutMs = 20 * 60_000 } = {}) {
  return runCli(args, { env, cwd, stdin, timeoutMs });
}

export function registerServerSecrets(dataDir) {
  const stateRoot = join(dataDir, 'state');
  if (!existsSync(stateRoot)) return;
  for (const dir of readdirSync(stateRoot)) {
    const file = join(stateRoot, dir, 'server.json');
    if (existsSync(file)) registerSecret(JSON.parse(readFileSync(file, 'utf8')).password);
  }
}

function sanitize(text, dataDir) {
  if (dataDir) registerServerSecrets(dataDir);
  return redactText(String(text)).split(homedir()).join('~').split(tmpdir()).join('<tmp>');
}

export function record(title, res, dataDir) {
  mkdirSync(dirname(REPORT), { recursive: true });
  const stderr = String(res.stderr ?? '').trim();
  const body = [`### ${title}`, '', `exit ${res.code}`, '', '```', String(res.stdout ?? '').trim(), '```',
    ...(stderr ? ['', 'stderr (fim):', '', '```', stderr.slice(-4000), '```'] : []), '', ''].join('\n');
  appendFileSync(REPORT, sanitize(body, dataDir));
}

export function note(title, obj, dataDir) {
  appendFileSync(REPORT, sanitize(`### ${title}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\n`, dataDir));
}

export function fileLines(file) {
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function treeChecksum(ws) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ws, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readFileSync(join(ws, f))).update('\0');
  return hash.digest('hex');
}

export function parseList(stdout, key) {
  const data = JSON.parse(stdout);
  return Array.isArray(data) ? data : (data[key] ?? data.items ?? []);
}

export const userText = (m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
```

Os diretórios temporários dos testes ao vivo **não** são apagados pelo teste (ficam como
evidência em `$TMPDIR/opc-live-f3-*`; o sistema os limpa). Nenhum teste ao vivo remove arquivos.

- [ ] **Step 2: `tests/live/f3-sessions.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SKIP, MODELS, liveWorkspace, opc, record, note, fileLines, userText } from './_f3-lib.mjs';

test('F3 live: session new, fork, revert/unrevert (history + file), diff, todo, summarize, children', { skip: SKIP, timeout: 60 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const notes = join(ws, 'notes.txt');
  const run = async (title, args, opts = {}) => {
    const res = await opc(args, { env, cwd: ws, ...opts });
    record(title, res, dataDir);
    return res;
  };

  let res = await run('session new', ['session', 'new', '--title', 'live-f3', '--model', MODELS.deepseek, '--write', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const session = JSON.parse(res.stdout).session;
  assert.match(session.title, /^OPC: session: live-f3/);
  const sid = session.id;

  for (const word of ['ALPHA', 'BETA']) {
    res = await run(`task ${word}`, ['task', '--resume', sid, '--write', '--model', MODELS.deepseek,
      `Append a new line containing exactly ${word} to the end of notes.txt. Do not change anything else and do not run shell commands.`]);
    assert.equal(res.code, 0, `turn ${word} failed (exit 3 = o config do usuário pede aprovação de edit): ${res.stdout}${res.stderr}`);
  }
  assert.deepEqual(fileLines(notes), ['original', 'ALPHA', 'BETA']);

  res = await run('session show', ['session', 'show', sid, '--limit', '100', '--json']);
  const users = JSON.parse(res.stdout).messages.filter((m) => m.info.role === 'user');
  const m2 = users.find((m) => userText(m).includes('BETA'))?.info.id;
  assert.ok(m2, 'user message of the BETA turn');

  res = await run('session fork (antes do turno BETA)', ['session', 'fork', sid, m2, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const forkId = JSON.parse(res.stdout).session.id;
  const forkUsers = JSON.parse((await opc(['session', 'show', forkId, '--limit', '100', '--json'], { env, cwd: ws })).stdout).messages.filter((m) => m.info.role === 'user');
  assert.ok(forkUsers.some((m) => userText(m).includes('ALPHA')), 'fork keeps the ALPHA turn');
  assert.ok(!forkUsers.some((m) => userText(m).includes('BETA')), 'fork drops the BETA turn');

  res = await run('session revert sem confirmação', ['session', 'revert', sid, m2]);
  assert.equal(res.code, 2);
  assert.match(res.stdout, /notes\.txt/);
  assert.match(res.stdout, /--confirmed-by-user/);
  assert.deepEqual(fileLines(notes), ['original', 'ALPHA', 'BETA'], 'nothing changes without confirmation');

  res = await run('session revert confirmado', ['session', 'revert', sid, m2, '--confirmed-by-user', '--json']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(fileLines(notes), ['original', 'ALPHA'], 'file restored to before BETA');
  assert.equal(JSON.parse((await opc(['session', 'show', sid, '--json'], { env, cwd: ws })).stdout).session.revert?.messageID, m2);

  res = await run('session unrevert sem confirmação', ['session', 'unrevert', sid]);
  assert.equal(res.code, 2);
  res = await run('session unrevert confirmado', ['session', 'unrevert', sid, '--confirmed-by-user', '--json']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(fileLines(notes), ['original', 'ALPHA', 'BETA'], 'file back after unrevert');
  assert.equal(JSON.parse((await opc(['session', 'show', sid, '--json'], { env, cwd: ws })).stdout).session.revert, undefined);

  res = await run('session diff', ['session', 'diff', sid, '--json']);
  assert.ok(JSON.parse(res.stdout).diffs.some((d) => String(d.file).endsWith('notes.txt')));

  res = await run('task todowrite', ['task', '--resume', sid, '--write', '--model', MODELS.deepseek,
    'Use the todowrite tool to create a todo list with exactly two items: "check alpha" and "check beta". Then reply DONE.']);
  assert.equal(res.code, 0, res.stderr);
  res = await run('session todo', ['session', 'todo', sid, '--json']);
  const todos = JSON.parse(res.stdout).todos;
  assert.ok(Array.isArray(todos));
  note('todo count (critério: >= 1)', { count: todos.length }, dataDir);
  assert.ok(todos.length >= 1, 'model should have written todos (instável: 3 execuções, >= 2)');

  const before = JSON.parse((await opc(['session', 'show', sid, '--limit', '200', '--json'], { env, cwd: ws })).stdout).messages.length;
  res = await run('session summarize (qwen3.8-max)', ['session', 'summarize', sid, '--model', MODELS.qwen, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const after = JSON.parse((await opc(['session', 'show', sid, '--limit', '200', '--json'], { env, cwd: ws })).stdout).messages;
  assert.ok(after.some((m) => m.info.summary === true) || after.length > before, 'summarize produced a summary message');

  res = await run('session children', ['session', 'children', sid, '--json']);
  assert.equal(res.code, 0);
  assert.ok(Array.isArray(JSON.parse(res.stdout).children));
});
```

- [ ] **Step 3: `tests/live/f3-subagents.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, MODELS, liveWorkspace, opc, record, note } from './_f3-lib.mjs';

const PROMPT = 'Reply with one short sentence that contains the word PINEAPPLE. Do not use any tool.';

test('F3 live: 3 parallel subagents, one per model, each with its own result', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const res = await opc(['subagent', '--agent', 'general', '--model', `${MODELS.deepseek},${MODELS.qwen},${MODELS.kimi}`, '--json', PROMPT], { env, cwd: ws });
  record('subagent x3', res, dataDir);
  assert.equal(res.code, 0, res.stderr);
  const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'completed');
  assert.equal(members.length, 3);
  assert.deepEqual(members.map((m) => m.model).sort(), [MODELS.deepseek, MODELS.kimi, MODELS.qwen].sort());
  assert.equal(new Set(members.map((m) => m.sessionID)).size, 3);
  for (const m of members) {
    assert.equal(m.status, 'completed', `${m.model}: ${m.errorMessage}`);
    assert.match(m.result.finalText, /pineapple/i, m.model);
    const shown = JSON.parse((await opc(['session', 'show', m.result.carrierSessionID ?? m.sessionID, '--json'], { env, cwd: ws })).stdout);
    assert.equal(shown.session.parentID, group.sessionID, 'member session is a child of the group parent session');
  }
  note('mecanismo por membro (§15 item 7)', members.map((m) => ({ model: m.model, mechanism: m.result.mechanism, fellBack: m.result.fellBack })), dataDir);
});

test('F3 live: background group, status --wait and result', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const bg = await opc(['subagent', '--agent', 'general', '--model', `${MODELS.deepseek},${MODELS.kimi}`, '--background', '--json', PROMPT], { env, cwd: ws });
  record('subagent --background', bg, dataDir);
  assert.equal(bg.code, 0, bg.stderr);
  const { group } = JSON.parse(bg.stdout);
  const waited = await opc(['status', group.id, '--wait', '--timeout-ms', '1800000', '--json'], { env, cwd: ws });
  record('status --wait (grupo)', waited, dataDir);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).group.status, 'completed');
  const result = await opc(['result', group.id], { env, cwd: ws });
  record('result (grupo)', result, dataDir);
  assert.equal(result.code, 0);
  assert.equal((result.stdout.match(/^## #/gm) ?? []).length, 2);
});
```

- [ ] **Step 4: `tests/live/f3-command.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, MODELS, liveWorkspace, opc, record, note, treeChecksum, parseList } from './_f3-lib.mjs';

// Selection logic (no command is created): first command by name with source "command",
// not a subtask and without a risky action in its name. It runs read-only, and the
// workspace checksum must not change.
const RISKY = /init|commit|push|deploy|release|delete|remove|clean|reset|migrate/i;

test('F3 live: /opc:command runs a harmless OpenCode command read-only', { skip: SKIP, timeout: 30 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const catalog = await opc(['catalog', 'commands', '--json'], { env, cwd: ws });
  assert.equal(catalog.code, 0, catalog.stderr);
  const candidates = parseList(catalog.stdout, 'commands')
    .filter((c) => (c.source ?? 'command') === 'command' && !c.subtask && !RISKY.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  note('commands candidatos', candidates.map((c) => ({ name: c.name, agent: c.agent ?? null, model: c.model ?? null })), dataDir);
  if (!candidates.length) {
    note('NÃO VALIDADO', { reason: 'nenhum command inofensivo disponível em GET /command' }, dataDir);
    t.skip('NÃO VALIDADO: nenhum command inofensivo disponível');
    return;
  }
  const chosen = candidates[0];
  const before = treeChecksum(ws);
  const res = await opc(['command', chosen.name, '--model', MODELS.kimi, '--json'], { env, cwd: ws });
  record(`command /${chosen.name} (kimi-k3)`, res, dataDir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const { job } = JSON.parse(res.stdout);
  assert.equal(job.status, 'completed');
  assert.ok(job.result.finalText.length > 0);
  assert.equal(treeChecksum(ws), before, 'read-only command must not change the workspace');
});
```

- [ ] **Step 5: `tests/live/f3-probe-subagent-mode.mjs` (§15 item 7)**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, MODELS, liveWorkspace, opc, record, note, parseList } from './_f3-lib.mjs';

test('F3 probe (§15 item 7): subagent-mode agent as child-session agent vs subtask part', { skip: SKIP, timeout: 30 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const agentsRes = await opc(['agents', '--mode', 'subagent', '--json'], { env, cwd: ws });
  const agents = parseList(agentsRes.stdout, 'agents').filter((a) => a.mode === 'subagent');
  const agent = (agents.find((a) => a.name === 'explore') ?? agents.find((a) => a.name === 'general') ?? agents[0])?.name;
  assert.ok(agent, 'at least one subagent-mode agent');
  const findings = { agent };

  const child = await opc(['subagent', '--agent', agent, '--model', MODELS.deepseek, '--mechanism', 'child-session', '--json', 'Reply with the single word PROBE.'], { env, cwd: ws });
  record(`probe child-session (${agent})`, child, dataDir);
  const childMember = JSON.parse(child.stdout).members[0];
  findings.childSession = { status: childMember.status, fellBack: childMember.result?.fellBack, mechanism: childMember.result?.mechanism, error: childMember.errorMessage ?? null };
  if (childMember.status === 'completed' && !childMember.result.fellBack) {
    const shown = JSON.parse((await opc(['session', 'show', childMember.sessionID, '--json'], { env, cwd: ws })).stdout);
    const assistant = shown.messages.filter((m) => m.info.role === 'assistant').at(-1);
    findings.childSession.effectiveAgent = assistant?.info.agent ?? null;
    findings.childSession.sessionAgent = shown.session.agent ?? null;
  }

  const sub = await opc(['subagent', '--agent', agent, '--model', MODELS.deepseek, '--mechanism', 'subtask', '--json', 'Reply with the single word PROBE.'], { env, cwd: ws });
  record(`probe subtask (${agent})`, sub, dataDir);
  const subMember = JSON.parse(sub.stdout).members[0];
  findings.subtask = { status: subMember.status, finalText: subMember.result?.finalText?.slice(0, 200) ?? null };
  if (subMember.result?.carrierSessionID) {
    const kids = JSON.parse((await opc(['session', 'children', subMember.result.carrierSessionID, '--json'], { env, cwd: ws })).stdout).children;
    findings.subtask.grandchildren = kids.length;
    if (kids[0]) {
      const grand = JSON.parse((await opc(['session', 'show', kids[0].id, '--json'], { env, cwd: ws })).stdout).session;
      findings.subtask.grandchildHasPermissionRules = Array.isArray(grand.permission) && grand.permission.length > 0;
    }
  }
  findings.conclusion = findings.childSession.status === 'completed' && !findings.childSession.fellBack
    ? `child-session aceita o agente ${agent} (agente efetivo: ${findings.childSession.effectiveAgent})`
    : `child-session recusada ou falhou; subtask: ${findings.subtask.status}`;
  note('§15 item 7 — resultado', findings, dataDir);
  assert.ok(childMember.status === 'completed' || subMember.status === 'completed', 'at least one mechanism must work');
});
```

- [ ] **Step 6: `tests/live/f3-concurrent-storage.mjs` (§15 item 12, parte automatizada)**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP, MODELS, liveWorkspace, opc, record, note } from './_f3-lib.mjs';

function runOpencode(args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('OPC_')) delete env[key];
    const child = spawn('opencode', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('F3 live (§15 item 12): `opencode run` concurrent with an opc job on the same project', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { ws, env, dataDir, stateDir } = liveWorkspace(t);
  const bg = await opc(['ask', '--background', '--model', MODELS.deepseek, 'List the files in this repository and describe each one in one line.'], { env, cwd: ws });
  record('opc ask --background', bg, dataDir);
  assert.equal(bg.code, 0, bg.stderr);
  const jobId = (bg.stdout.match(/\bask-[a-z0-9]+-[a-z0-9]+\b/) ?? [])[0];
  assert.ok(jobId, 'job id printed');
  const direct = await runOpencode(['run', '-m', MODELS.deepseek, 'Reply with the single word OK.'], { cwd: ws, timeoutMs: 15 * 60_000 });
  record('opencode run (concorrente)', direct, dataDir);
  const waited = await opc(['status', jobId, '--wait', '--timeout-ms', '1800000'], { env, cwd: ws });
  record('opc status --wait', waited, dataDir);
  const logFile = join(stateDir(), 'server.log');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const lockErrors = /SQLITE_BUSY|database is locked/i.test(log);
  const all = JSON.parse((await opc(['sessions', '--all', '--json'], { env, cwd: ws })).stdout).sessions;
  const findings = {
    opencodeRunExit: direct.code,
    opcJobExit: waited.code,
    lockErrorsInServerLog: lockErrors,
    nonOpcSessionVisibleToPluginServer: all.some((s) => !String(s.title).startsWith('OPC: ')),
  };
  note('§15 item 12 — parte automatizada', findings, dataDir);
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(lockErrors, false);
});
```

- [ ] **Step 7: `tests/live/f3-session-shapes.mjs` (formas reais × fake dos endpoints F3)**

Teste ao vivo da fase, **não** um segundo executor de contrato (o único é `tests/live/contract.mjs`, que lê o registro `PROBES` de `tests/fixtures/contract-shapes.mjs`): estas formas só existem com sessão e turno reais (fork/revert/summarize), por isso ficam aqui.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP, MODELS, liveWorkspace, opc, record, note } from './_f3-lib.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';

// Fields the F3 code reads, per captured response. A divergence is a field present on one
// side and absent on the other, or with a different JS type.
const READ_PATHS = {
  session: ['id', 'title', 'directory', 'time.updated'],
  fork: ['id', 'title'],
  reverted: ['id', 'revert.messageID', 'revert.diff'],
  unreverted: ['id'],
  message: ['info.id', 'info.role', 'parts'],
  diff: ['file', 'status', 'additions', 'deletions', 'patch'],
  todo: ['content', 'status', 'priority'],
  command: ['name', 'template', 'hints'],
  summarized: [''],
};

const get = (obj, path) => (path === '' ? obj : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

async function capture(api, sid, model) {
  const messages = await api.messages(sid);
  const lastId = messages.at(-1).info.id;
  const fork = await api.fork(sid, { messageID: lastId });
  const forkMsgs = await api.messages(fork.id);
  const forkUser = forkMsgs.find((m) => m.info.role === 'user');
  const reverted = await api.revert(fork.id, { messageID: forkUser.info.id });
  const unreverted = await api.unrevert(fork.id);
  const summarized = await api.summarize(fork.id, { providerID: model.providerID, modelID: model.modelID, timeoutMs: 600000 });
  const [session, diff, todo, commands] = await Promise.all([api.getSession(sid), api.diff(sid), api.todo(sid), api.commands()]);
  return { session, fork, reverted, unreverted, summarized, message: messages[0], diff: diff[0] ?? null, todo: todo[0] ?? null, command: commands[0] ?? null };
}

function compare(real, fake) {
  const divergences = [];
  const notApplicable = [];
  for (const [key, paths] of Object.entries(READ_PATHS)) {
    if (real[key] == null || fake[key] == null) {
      notApplicable.push(key);
      continue;
    }
    for (const path of paths) {
      const r = get(real[key], path);
      const f = get(fake[key], path);
      if (r === undefined && f === undefined) continue;
      if (r === undefined || f === undefined || typeof r !== typeof f || Array.isArray(r) !== Array.isArray(f)) {
        divergences.push({ key, path: path || '(value)', real: r === undefined ? 'missing' : (Array.isArray(r) ? 'array' : typeof r), fake: f === undefined ? 'missing' : (Array.isArray(f) ? 'array' : typeof f) });
      }
    }
  }
  return { divergences, notApplicable };
}

test('F3 contract: real 1.18.32 vs fake for fork/revert/unrevert/summarize/diff/todo/command', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { root, ws, env, dataDir, stateDir } = liveWorkspace(t);
  const created = await opc(['session', 'new', '--title', 'contract', '--model', MODELS.deepseek, '--write', '--json'], { env, cwd: ws });
  assert.equal(created.code, 0, created.stderr);
  const sid = JSON.parse(created.stdout).session.id;
  const turn = await opc(['task', '--resume', sid, '--write', '--model', MODELS.deepseek, 'Append a line CONTRACT to notes.txt. Do not run shell commands.'], { env, cwd: ws });
  record('contract: turno de preparo', turn, dataDir);
  assert.equal(turn.code, 0, turn.stderr);

  const server = JSON.parse(readFileSync(join(stateDir(), 'server.json'), 'utf8'));
  registerSecret(server.password);
  const model = { providerID: 'omniroute-mvalmeida', modelID: 'opencode-go/deepseek-v4.1-flash' };
  const real = await capture(createApi(createClient({ baseUrl: server.url, password: server.password, directory: resolveWorkspaceRoot(ws) })), sid, model);

  const fakePassword = 'contract-fake-password-000';
  const fake = await startFake({ port: await pickFreePort(), password: fakePassword, scenario: 'f3-sessions', stateFile: join(root, 'fake-state.json') });
  t.after(() => fake.close());
  const fakeShapes = await capture(createApi(createClient({ baseUrl: fake.url, password: fakePassword, directory: '/fake' })), 'ses_seed', model);

  const result = compare(real, fakeShapes);
  note('F3 contract — divergências e N/A', result, dataDir);
  assert.deepEqual(result.divergences, [], 'record each divergence in the report and update tests/fixtures/f3-fake.mjs');
});
```

- [ ] **Step 8: Conferir que os testes ao vivo pulam sem `OPC_LIVE`**

Run: `node --test tests/live/f3-*.mjs`
Expected: todos `skipped` (sem `OPC_LIVE=1`), exit 0. `npm test` continua sem rodá-los.

- [ ] **Step 9: Commit**

```bash
git add tests/live/_f3-lib.mjs tests/live/f3-sessions.mjs tests/live/f3-subagents.mjs tests/live/f3-command.mjs tests/live/f3-probe-subagent-mode.mjs tests/live/f3-concurrent-storage.mjs tests/live/f3-session-shapes.mjs
git commit -m "test: add F3 live tests, subagent-mode probe and storage concurrency check"
```

---

### Task 16: Portão da F3

**Files:**
- Modify: `docs/phases/F3-report.md` (preencher), `docs/commands.md` (saídas reais), `CHANGELOG.md` (conferir)
- Create (gerado): `docs/phases/F3-live-output.md` (saída redigida dos testes ao vivo)

**Interfaces:**
- Consumes: tudo das Tasks 0–15.
- Produces: relatório da fase; PR `feat/opc-f3`; gravação dupla.

- [ ] **Step 1: Suíte completa**

Run: `npm test 2>&1 | tee /tmp/opc-f3-npm-test.txt`
Expected: 100% verde. Anexe a contagem e o trecho final à seção 1 do relatório.

- [ ] **Step 2: Testes ao vivo (três modelos)**

Pré-requisitos: `opencode --version` → `1.18.32`; `opencode auth` com o provider
`omniroute-mvalmeida` conectado; nenhum `OPC_SERVER_URL` exportado.

Se `docs/phases/F3-live-output.md` já existir de uma execução anterior, renomeie-o antes
(`mv docs/phases/F3-live-output.md docs/phases/F3-live-output.prev-DDMMYY.md`); os testes
anexam ao arquivo. Nada é apagado.

```bash
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f3-sessions.mjs
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f3-subagents.mjs
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f3-command.mjs
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f3-probe-subagent-mode.mjs
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f3-concurrent-storage.mjs
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f3-session-shapes.mjs
```

Expected: todos PASS. Itens que dependem do modelo (texto `PINEAPPLE`, todos escritos, resumo
gerado, arquivo com as linhas exatas): se falharem, repita a execução do arquivo até 3 vezes;
passa com ≥ 2 (registre as 3 saídas). Falha de `revert` por diff vazio no preview: registre
como resposta do item "diff por mensagem" (seção 4) e ajuste `collectAffectedDiff` antes de
fechar.

- [ ] **Step 3: Teste de contrato do mestre**

Run: `OPC_LIVE=1 node tests/live/contract.mjs`
Expected: sem divergência, ou divergência registrada e fake atualizado (com commit
`test: update fake after F3 contract run`).

- [ ] **Step 4: Validação manual do operador — attach e `--pane`** `[HUMANO]`

Peça ao operador para executar e relatar (o agente só prepara e registra):

1. Num workspace de teste: `opc session new --title manual-attach --json` e anote o id.
2. `opc attach <id>` → copiar a linha impressa para um terminal **fora** do tmux e rodar. A TUI
   abre na sessão `OPC: session: manual-attach`. Critério: TUI conectada sem pedir senha.
3. Enquanto a TUI está aberta: `ps -eo args | grep -F "opencode attach"` → a senha **não**
   aparece (compare com `jq -r .password <stateDir>/server.json` sem colar o valor em lugar
   nenhum; basta `grep -c` retornar 0).
4. Dentro do tmux, no Claude: `/opc:attach --pane <id>` → abre um split com a TUI. Repetir o
   `ps` do passo 3 incluindo `tmux` e `attach-pane.sh`: a senha não aparece.
5. Fora do tmux: `/opc:attach --pane <id>` → exit 2 com a orientação.
6. `/opc:setup --stop-server` → `<stateDir>/attach.secret` deixa de existir.

Registre cada passo como `PASSOU`/`NÃO VALIDADO` na seção 3.

- [ ] **Step 5: Validação manual do operador — storage concorrente com a TUI (§15.12)** `[HUMANO]`

1. Abra `opencode` (TUI) no mesmo workspace de teste, **sem** attach (processo próprio).
2. No Claude: `/opc:ask --background "Descreva os arquivos do repositório"` e, enquanto roda,
   mande uma mensagem qualquer na TUI.
3. Critérios: os dois terminam; a TUI lista a sessão `OPC: ask: …` (pode exigir reabrir a lista);
   `opc sessions --all` mostra a sessão criada na TUI (se não, `opc sessions --refresh`);
   `grep -Ei "SQLITE_BUSY|database is locked" <stateDir>/server.log` sem resultado.
4. Registre a resposta do item 12 (seção 4), juntando a parte automatizada do Step 2.

- [ ] **Step 6: Documentação com saídas reais**

Em `docs/commands.md`, sob cada exemplo das seções Sessões, Subagentes, Commands e Attach,
acrescente um bloco "Saída real (portão F3, DD/MM/AAAA)" copiado de
`docs/phases/F3-live-output.md` (já redigido: `~` no lugar do home, `<tmp>` no lugar do
diretório temporário, senha como `***`). Depois:

Run: `node scripts/scan-secrets.mjs docs/`
Expected: sem achados.

- [ ] **Step 7: Preencher o relatório**

Complete `docs/phases/F3-report.md`: seções 1–7 com `PASSOU` / `N/A` / `NÃO VALIDADO` e
evidência; as respostas dos itens §15.7, 7b e 12; a tabela de pontos de encaixe da Task 0; e os
desvios (mudanças de comportamento de F0–F2b listadas em "Interfaces novas" e Task 7/12).
Nenhum `PASSOU` sem execução correspondente no `F3-live-output.md` ou na saída do `npm test`.

- [ ] **Step 8: Conferir CHANGELOG e commit dos documentos do portão**

```bash
git add docs/phases/F3-report.md docs/phases/F3-live-output.md docs/commands.md CHANGELOG.md
git commit -m "docs: add F3 gate report and live outputs"
```

- [ ] **Step 9: Aviso ao operador, push e PR** `[PAUSA-APROVAÇÃO]`

Resuma ao operador: testes (contagem), itens ao vivo, respostas de §15.7 e §15.12, desvios. Com
autorização explícita para push e PR nesta sessão:

```bash
git push -u origin feat/opc-f3
gh pr create --base main --head feat/opc-f3 --title "feat: F3 sessions, subagents, commands and attach" --body-file docs/phases/F3-report.md
```

Releia título e corpo antes: sem `Co-Authored-By`, `Signed-off-by` ou "Generated with". Merge
só depois de avisar o operador.

- [ ] **Step 10: Gravação dupla** `[AGENT-OK]`

1. `.ai-data/decisions-DDMMYY.md` e `.ai-data/facts-DDMMYY.md` no repositório (não versionado):
   respostas de §15.7 e §15.12, o mecanismo padrão de subagente confirmado, o `attach.secret` e
   os desvios de F0–F2b.
2. Colmeia `myprojects` via `mnemosyne_remember`, um fato por item, prefixado `[DD/MM/AAAA]`,
   sem segredos (ex.: "[DD/MM/AAAA] opc F3: agente em modo subagent <é/não é> aceito como
   agente de sessão filha no OpenCode 1.18.32; mecanismo padrão <child-session/subtask>").
3. Avise o operador com a contagem por banco.

---

## Cobertura da spec nesta fase

| Spec | Tarefa |
|---|---|
| §4 `/opc:sessions` (lista OPC do workspace, `--all`) | Task 4, Task 13 |
| §4 `/opc:session` new/show/fork/children/diff/todo | Task 5, Task 13 |
| §4 `/opc:session` revert/unrevert/summarize + regra transversal de `--confirmed-by-user` | Task 6, Task 13 (skill) |
| §4 `/opc:subagent` (N jobs paralelos, um por agente/modelo) | Tasks 7, 8, 9 |
| §4 `/opc:command` (model string, `arguments`, modelo/agente fixados pela política — §6.4) | Task 11 |
| §4 `/opc:attach` + `--pane` (`disable-model-invocation`, `Bash(tmux:*)` — §8.4) | Tasks 12, 13 |
| §4.1 exit codes (2 uso/confirmação, 3 permissão, 4 política, 6 wait-timeout, 7 falha, 130 cancelado) | Tasks 5, 6, 9, 10, 11, 12 |
| §5.1.2 modo attach (`OPC_SERVER_URL`) de ponta a ponta | Task 12 |
| §6 resolução de modelo/agente, modelos fixados, política antes da sessão | Tasks 4, 5, 6, 9, 11 |
| §8.1 perfis nas sessões filhas, portadoras e de command | Tasks 4, 8, 9, 11 |
| §8.2 pedidos de sessões filhas e perguntas completas nos subagentes | Tasks 7, 9, 11 |
| §9.1 grupos (status/result/cancel agregados, `maxParallel`, cancelar membro só aborta a sessão dele) | Tasks 7, 9, 10 |
| §9.2 concorrência por sessão (`session-<id>.lock`) | Tasks 6, 11 |
| §10.5 attach `--pane` com senha lida de arquivo 600 dentro do pane | Task 12 |
| §12 documentação | Task 14, Task 16 |
| §13.3 F3 aceite de integração | Tasks 5, 6, 9, 10, 11, 12 |
| §13.3 F3 aceite ao vivo (três modelos, manual do attach) | Tasks 15, 16 |
| §15 item 7 (agente `subagent` como agente de sessão filha) | Task 8 (fallback), Task 15 (probe), Task 16 |
| §15 item 12 (storage concorrente) | Task 15 (parte automatizada), Task 16 (manual) |
| Contrato (fake × real) | Task 15 (`f3-session-shapes.mjs`), Task 16 (`contract.mjs`) |
