# opc F5 — Servidor MCP e transfer · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor o núcleo do opc ao Claude Code como servidor MCP stdio sem dependências (25 ferramentas `opc_*` que passam pelo **mesmo** despachante da CLI, com as mesmas regras) e entregar `/opc:transfer`, que converte o JSONL de uma sessão do Claude Code no formato do `opencode export` e o importa com `opencode import`.

**Architecture:** `scripts/mcp-server.mjs` fala JSON-RPC 2.0 por linhas (MCP 2025-06-18) e, a cada `tools/call`, valida os argumentos contra o JSON Schema da ferramenta, traduz para o `argv` de um subcomando existente e chama `main(argv, io)` do `opc-companion.mjs` (F0; importado como `dispatch`) — a mesma função que o executável `opc` usa — com stdin vazio e stdout/stderr capturados. Nenhuma regra de negócio vive no MCP: política, aprovador, confirmações, limites de jobs e exit codes vêm dos comandos das fases F0–F4c. O `transfer` é um subcomando novo (`scripts/commands/transfer.mjs`) apoiado em `lib/transfer.mjs` (conversão pura + chamada ao `opencode import`).

**Tech Stack:** Node.js ≥ 20 (ESM, `node:test`, `node:child_process`, `node:stream`), zero dependências, OpenCode 1.18.32, MCP 2025-06-18 (aceita 2025-03-26 e 2024-11-05 por negociação).

**Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3) — §3.1, §4 (linha `/opc:transfer`, §4.1), §8.3, §13.3 F5, §14.3, §15 item 10.
**Plano mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` (estrutura, contrato de interfaces, convenções de teste, regras de git e portão — congelados). Este plano assume que F0–F4c entregaram exatamente o contrato do mestre.

---

## Ajustes pós-F4c (30/09/2026, antes da execução)

O plano foi escrito em 26/09, antes da implementação da F2 à F4c. As premissas sobre o código existente foram conferidas contra a `main` com a F4c mergeada, e os itens abaixo **prevalecem** sobre o texto das tarefas. Cerca de 35 premissas conferem sem ajuste (`main`/`loadCommand`/`listSubcommands`, `ExitCode`/`OpcError`/`toExitCode`, `redact`/`redactText`, `parseArgs`/`extractCwd`, estado "antes" de `resolveArgv`/`readRawArgs` descrito na Task 1, `JOB_ID_RE`/`newJobId`, `assertNotInsideServer` → exit 4, flags dos comandos, fake de permissões, helpers `testEnv`/`makeWorkspace`/`runCli`, âncora do `bin/opencode`, `OPC_COMPANION_TRANSCRIPT_PATH`).

1. **Permissões precisam de servidor (Task 7).** `permissions list/reply` usam `existingServerApi` (`lib/jobs.mjs:466`, `commands/permissions.mjs:30-39`): sem servidor, `list` devolve `requests: []` e `reply` sai com `NO_SERVER` (exit 2). Antes dos testes de permissão, suba o servidor gerenciado com um comando que o inicia (por exemplo `opc_models` pelo MCP) ou use `startExternalFake` com `OPC_SERVER_URL`. Nenhum teste de recusa pode passar vazio: afirme que a requisição semeada aparece em `list` antes de exercitar a recusa.
2. **`data` nem sempre é JSON.** `permissions reply/answer` aceitam `--json`, mas imprimem Markdown (`commands/permissions.mjs:68-70,83-92,101`). O envelope das ferramentas `opc_permission_reply`/`opc_question_answer` traz `data` como string. Documente isso na Decisão 6 e no catálogo; não mude o comando nesta fase.
3. **Modelo padrão nos testes (Tasks 1 e 6).** `testEnv` não grava config e `DEFAULT_CONFIG.defaultModel` é `null`. O modelo do fake (`fake-provider/fake-model`) não está no catálogo, então `task/ask/plan` sem `--model` saem com `UNKNOWN_MODEL` (exit 2, `lib/routing.mjs:46-48`). Grave `writeGlobalConfig(env, { defaultProvider: F2A_PROVIDER, defaultModel: F2A_MODEL, policy: F2A_POLICY })` ou use `setupF2a`.
4. **Ids de modelo reais do fixture (Tasks 1 e 6).** Em vez de `fixture-a/m` e `example-provider/example/model-a`, use `FIXTURE_MODELS`/`F2A_MODEL` (`tests/helpers.mjs:514`). O teste de política precisa negar um modelo que existe, porque `UNKNOWN_MODEL` vem antes da checagem de política (`lib/routing.mjs:51-65`). Conclave usa o cenário `conclave-opinion`. Nenhum caso fica atrás de `if (cli.code === 0)`: afirme o exit code esperado.
5. **Subagent.** `build` é `mode: primary` no `agent.json` do fake e `subagent` o recusa (`commands/subagent.mjs:18,89`). Use `--agent general`.
6. **`writeTestConfig`.** `saveGlobalConfig` não cria o diretório (`lib/config.mjs:403-405`). `writeTestConfig` vira um wrapper fino de `writeGlobalConfig(env, cfg)` (`tests/helpers.mjs:370`), que já faz `mkdir` e `chmod`.
7. **`transfer.md` (Task 9, Step 7).** `tests/unit/commands-md.test.mjs:66-85` exige, em todo `.md` com heredoc, a frase de guarda do delimitador e a cerca fechada. Copie a frase exata de um comando existente (por exemplo `plugins/opc/commands/status.md:8`) antes do bloco bash.
8. **`opc_orchestrate.maxSubtasks`.** Faixa `2..10` (`MAX_SUBTASKS_CAP = 10`, `lib/orchestrator.mjs:19`), não `2..20`.
9. **`opc_conclave` sem `review`.** O modo `review` manda o diff a modelos de terceiros, e o `/opc:conclave` estima o tamanho e pergunta antes (`commands/conclave.md`, passo 2). Isso contraria a Decisão 3. Tire `review` do `enum` de `opc_conclave.mode` (fica `opinion | debate`), com um teste que recusa `mode: 'review'`.
10. **Decisão 4, racional.** `status`, `result`, `cancel` e `config` também têm `disable-model-invocation` e estão expostos. A regra passa a ser: **expor só o que é somente leitura ou exige as mesmas confirmações do comando** (aprovador, `--confirmed-by-user`), e não "o que é invocável pelo modelo".
11. **Testes ao vivo (Task 11).** Rotas por ambiente, como na F4c: `OPC_LIVE_MODEL`, `_2`, `_3`, via `tests/live/_f4a-lib.mjs` (`FAST`, `SECOND`, `THIRD`, `SKIP`), sem default hardcoded; as rotas `omniroute-personal/opencode-go/*` respondem 402. As saídas vão para `docs/phases/F5-live-output.md` via `appendSafeOutput`/`safeOutputText` (`tests/live/_f3-lib.mjs`), sanitizadas (id de provider neutro, caminhos como `<tmp>`/`~`), nunca em `/tmp` versionado.
12. **README e CHANGELOG.** README: linha "Estado" (`README.md:7`), linha `servidor MCP, /opc:transfer | F5` do "Mapa do mínimo" (`:57`) e os links da lista "Documentação" (relatório F5). CHANGELOG em PT-BR: `### Adicionado — F5 (MCP e transfer)`, como as fases anteriores.
13. **Formas de espera e falha no envelope.** Há duas formas de timeout de espera: `{ job, waitTimedOut: true }` (`commands/task.mjs:131`) e `WAIT_TIMEOUT` lançado por `status --wait` de grupo (`lib/jobs.mjs:540`), com `{"error": …}`. `cancel --json` com falha sai com exit 5 e `{ error, message, report }` em stdout (`commands/cancel.mjs:19-22`). O envelope trata as três: exit ≠ 0 com `data.error` preenche `error` no envelope; teste para cada uma.
14. **Corrida no teste de espera.** O cenário `slow` segura o turno por cerca de 3000 ms. Use `waitTimeoutSec: 1` no teste de `wait_timeout`, não 2 s.
15. **Redação.** Texto derivado de modelo, provider ou stderr no envelope (mensagem de erro, cauda de stderr, `data` não-JSON) passa por `safeOutputText`/`redactOutput` (`lib/redact.mjs:80-95`), não só `redactText`. `redact(JSON)` continua igual ao `ctx.json`.
16. **Já aplicado.** `normalizeResumeFlag` já para no `--` (`commands/task.mjs:56-59`, comentário "MCP, F5"); a Task 1 acrescenta um teste que prova isso, sem reimplementar.
17. **`main` com opções.** `main` também aceita `commandLoader` e `contextFactory` (`opc-companion.mjs:55`); use-as nos testes unitários do dispatcher, sem disco.
18. **Sessão do Claude pelo MCP.** Segue `NÃO VALIDADO` (F2b-report); mantenha o fallback `status --all` na doc.
19. **Herdados da F4c.** Prompts de modelo em inglês; prosa ao usuário em PT-BR; Conventional Commits sem atribuição; `makeWorkspace` já desliga a manutenção automática do git; testes com socket e subprocesso rodam fora do sandbox, pelo controlador; nada da `.ai-data` é commitado.

## Global Constraints

- Node ≥ 20 (`engines: {"node": ">=20"}`); checagem em runtime com mensagem clara; CI em Node 20 e 22.
- Zero dependências de runtime. `devDependencies` também vazias (nada de `npm install`).
- Código, identificadores, mensagens de commit e nomes de arquivo em inglês. Docs e textos voltados ao usuário em PT-BR.
- OpenCode mínimo `1.18.0`; alvo testado `1.18.32`; só a API v1 (`/session/*`, `/event`, …), nunca `/api/*`.
- A senha do servidor e as chaves de provider nunca aparecem em stdout, stderr, logs, docs ou fixtures commitadas.
- O plugin nunca escreve em `~/.config/opencode/` nem no `auth.json` do OpenCode.
- Diretórios de estado com modo 700 e arquivos com modo 600.
- `always` nunca é enviado em `permission reply`.
- Exit codes conforme a spec, §4.1: `0, 2, 3, 4, 5, 6, 7, 130`.
- Namespace de comandos `/opc:`; executável `opc`; título das sessões com o prefixo `OPC: `.
- Testes ao vivo só com `OPC_LIVE=1`, nunca no CI, sempre em diretório descartável; modelos por ambiente (`OPC_LIVE_MODEL`, `_2`, `_3`; Ajustes pós-F4c, item 11).
- Licença Apache-2.0; `NOTICE` credita o `openai/codex-plugin-cc`; nada copiado do `swarm-code-plugin`.
- **F5 (spec §13.3):** nada que exija o usuário (review com `disable-model-invocation`, revert/unrevert, `--stop-server`, config) é exposto via MCP sem as mesmas confirmações; **decisão desta fase: esses itens simplesmente não são expostos** (ver "Decisões").
- **F5:** toda ferramenta MCP chama a mesma função da CLI (`main` do companion da F0 → `loadCommand` → `commands/<sub>.mjs#run`); o MCP não reimplementa regra.
- **F5:** o stdout do processo MCP é exclusivo do protocolo; qualquer outra escrita vai para stderr.
- **F5:** o `transfer` só lê JSONL cujo `realpath` esteja sob `~/.claude/projects` (sobrescrevível só por `OPC_TRANSFER_ALLOWED_ROOT`, para testes) e grava o JSON temporário com modo 600 dentro do diretório de estado (700), removendo-o ao fim.

## Review Focus

Entradas e condições que a spec implica e que mais provavelmente quebram o uso real. Cada linha tem teste na tarefa dona, entre colchetes.

1. **Texto livre vindo do MCP que parece flag ou shell** (prompt começando com `--write`, `$()`, crases, aspas, quebras de linha, unicode, resposta de pergunta igual a `--args-stdin` ou `--raw-args-stdin`): chega ao OpenCode byte a byte e nunca vira flag. [Task 1 · `args-terminator`; Task 4 · caso `EVIL` da tabela de argv; Task 6 · `prompt reaches OpenCode verbatim`]
2. **Qualquer módulo escrevendo em `process.stdout`** (um `console.log` esquecido, progresso) enquanto o MCP roda: o canal JSON-RPC continua íntegro e a sujeira vai para stderr. [Task 5 · `stdout carries only JSON-RPC frames`]
3. **Chamadas longas e concorrentes** (`wait: true`, `opc_job_status --wait`) não travam o servidor nem roubam o stdin do protocolo: um `ping` é respondido enquanto outra chamada espera, e a espera tem teto. [Task 4 · timeout da chamada; Task 6 · `wait=true is bounded`]
4. **Transcript do Claude "sujo"** (linhas inválidas, blocos `thinking`, sidechains, mensagens meta, comandos locais, imagens, textos enormes, conversa que começa pelo assistente): conversão estável, com contagem do que foi ignorado e truncamento explícito. [Task 8 · `convertClaudeRecords…`, `truncated`, `assistant-first`]
5. **Caminho de transcript que escapa da raiz permitida** (symlink para fora, `..`, arquivo não `.jsonl`, arquivo gigante): recusado antes de ler, sem importar nada. [Task 8 · `resolveTranscriptPath refuses…`; Task 9 · `outside the allowed root … exit 4`]

---

## Evidências coletadas no planejamento (26/09/2026)

Base para o §15 item 10 e para as fixtures. Nada foi importado durante o planejamento.

| Fato | Evidência |
|---|---|
| `opencode export <id>` imprime em stdout **só JSON** `{ info: Session, messages: [{ info: Message, parts: Part[] }] }`; logs vão para stderr | `opencode export ses_f246e5370ffeRHyqkGfyUsIYTQ` (sessão de sondagem), salvo em `scratchpad/plancheck-F5/export-2.json` |
| `opencode import <file>` lê o JSON, decodifica `Session.Info` **sobrescrevendo** `projectID`, `directory` e `path` com os da instância (cwd de quem importa), faz upsert da sessão por `info.id`, insere mensagens e partes com `onConflictDoNothing` e imprime `Imported session: <info.id>` + EOL em stdout | código do handler `Cli.import.body` extraído de `strings` do binário 1.18.32 |
| Falhas do `import` nem sempre dão exit ≠ 0: `Failed to read session data` sai com exit 0 | mesmo trecho (`process.stdout.write("Failed to read session data"); return`) |
| O id da sessão importada é o do arquivo → o conversor precisa gerar ids novos no formato do OpenCode | idem (`Imported session: ${B.info.id}`) |
| Formato de id: `<prefixo>_` + 6 bytes hex de `ms·4096 + contador` (invertido com `~` para `descending`) + 14 caracteres base62 aleatórios; sessões usam `descending`, mensagens e partes `ascending` | função `Identifier.create` no binário; vetores reais `msg_0db91501c001…` (1790390128668) e `ses_f246eb45fffe…` (1790390127520) reproduzidos no teste da Task 8 |
| Campos obrigatórios: `Session{id,slug,projectID,directory,title,version,time}`, `UserMessage{id,sessionID,role,time,agent,model}`, `AssistantMessage{id,sessionID,role,time,parentID,modelID,providerID,mode,agent,path,cost,tokens}`, `TextPart{id,sessionID,messageID,type,text}`; todos com `additionalProperties:false` | OpenAPI 1.18.32 salva (`scratchpad/opencode-openapi.json`) |
| `opencode session list --format json` → `[{id,title,updated,created,projectId,directory}]`, só sessões raiz do projeto do cwd | handler `Cli.session.list` no binário; `opencode session list --help` |
| `opencode -s <id>` retoma a sessão na TUI | `opencode --help` (`-s, --session`) |
| JSONL do Claude Code: registros `user`/`assistant` com `message.content` string ou blocos (`text`, `thinking`, `tool_use`, `tool_result`, `image`), um bloco por registro no assistente (mesmo `message.id`), mais `isSidechain`, `isMeta`, `custom-title`, `file-history-snapshot` etc. | chaves (sem conteúdo) de um transcript local do operador |
| MCP de plugin: `mcpServers` no `plugin.json`, `${CLAUDE_PLUGIN_ROOT}` substituído em `args`; o processo recebe `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` e `CLAUDE_PROJECT_DIR` no ambiente | extrato das docs do Claude Code (`scratchpad/hooks.md`, linhas 468–495 e 619–621) |
| Referência de paridade: o `transfer` do codex resolve o JSONL por `--source` ou pela variável do SessionStart e exige `realpath` sob `~/.claude/projects` | `openai-codex/.../claude-session-transfer.mjs`, `commands/transfer.md` |

Os módulos novos deste plano (protocolo, esquema, ferramentas, transfer) foram executados num sandbox com stubs do contrato: **43 testes unitários verdes** e um smoke test do `mcp-server.mjs` (handshake, `tools/list` com 25 ferramentas, `tools/call`, `console.log` desviado para stderr). Os testes de integração dependem do código real de F0–F4c e não foram executados no planejamento (`NÃO VALIDADO` até a execução).

---

## Decisões desta fase (ambiguidades resolvidas)

1. **Mesma função = mesmo despachante.** Em vez de extrair um `execute()` de cada um dos ~15 comandos (refatoração ampla sobre código que este plano não enxerga), o MCP chama `main(argv, io)` do `opc-companion.mjs` — o despachante da F0, que é exatamente o que o `bin/opc` executa. A F0 já o entrega importável sem efeito colateral (guarda `invokedDirectly()`), com `loadCommand(sub)` dinâmico e `io = { env, cwd, stdin, stdout, stderr, onError }`; a F5 **não** recria `dispatch`/`loadCommand`/`main`: importa `import { main as dispatch } from './opc-companion.mjs'` e o injeta em `createToolCaller({ dispatch })` (o parâmetro mantém o nome). O único `execute()` novo é o do `transfer` (comando novo, escrito já no formato `execute` + `run`).
2. **Texto livre sempre depois de `--`.** O MCP monta `argv` com flags validadas e coloca prompt/pergunta/mensagem/respostas depois de `--`. O `parseArgs` e o `extractCwd` da F0 já tratam `--` como fim das opções; a lacuna era a flag de stdin: a Task 1 faz `resolveArgv` (F0) ignorar `--args-stdin` e `readRawArgs` (F2a) ignorar `--raw-args-stdin` depois do primeiro `--` (acréscimo sem mudança de assinatura; sem `--` no `argv`, comportamento idêntico).
3. **Não expostos via MCP (por segurança, não por confirmação):** `session revert`/`unrevert`, `setup` (inclui `--stop-server` e instalação), `config set/unset/add/remove/init`, `review`/`adversarial-review` (são `disable-model-invocation`), `transfer` (idem), `command` (rota síncrona arbitrária, fora do framework de jobs), `attach`, `monitor`, `gc`, `rescue` (é fluxo de agente). As instruções do servidor e a doc dizem ao Claude para pedir ao usuário o comando `/opc:` correspondente.
4. **Exposto além da lista da spec:** `opc_catalog` (read-only; `/opc:catalog` é invocável pelo modelo). Total: 25 ferramentas.
5. **Long-running em background por padrão.** `opc_task/ask/plan/subagent/orchestrate/conclave` passam `--background`; com `wait: true` passam `--wait-timeout <s>` (padrão 120, teto 540). O job continua após o teto (exit 6 → `state: "wait_timeout"`, sem `isError`). `opc_job_status` com `wait` usa `--wait --timeout-ms`.
6. **Envelope do resultado.** Todo `tools/call` devolve `content: [{type:"text", text: JSON}]` com `{exitCode, state, data?, error?, truncated?}`; `state` vem do exit code (§4.1); `isError = exitCode ∉ {0, 3, 6}`. `data` é o JSON que a CLI imprimiria com `--json` (redigido de novo por garantia). Erros tipados trazem `error.code` (ex.: `POLICY_DENIED`) e mensagem redigida (capturados pelo `io.onError` do `main` da F0); como o MCP sempre passa `--json`, nesses casos `data` é o documento `{"error":{code,message,details}}` que o `main` da F0 imprime — o mesmo que a CLI devolve. Argumentos inválidos viram `isError` com `INVALID_ARGUMENTS` (exit 2), para o modelo corrigir; ferramenta inexistente é erro JSON-RPC `-32602`.
7. **Sessão do Claude no MCP.** O servidor MCP não recebe `OPC_COMPANION_SESSION_ID` (a variável só chega ao Bash via `CLAUDE_ENV_FILE`). A cada chamada, ele procura em `claudeSessions` a entrada mais recente cujo `pid` é o `ppid` do MCP (o processo do Claude) e cujo `pidStartTime` confere; achando, exporta `OPC_COMPANION_SESSION_ID` para o comando. Depende do §15 item 9 (respondido na F2b): se o `ppid` do hook não for o Claude, os jobs do MCP ficam sem sessão (não são colhidos pelo reaper) — registrar no relatório.
8. **Modelo do `transfer`.** Sem subir servidor: `--model` (alias ou id completo `provider/model`) → `defaultModel` → erro `NO_MODEL` (exit 2). Passa por `assertAllowed('provider'|'model')` (exit 4). Não valida existência no catálogo (só o OpenCode valida ao retomar) — desvio registrado no relatório. Usuário e assistente importados registram esse modelo, para que `opencode -s` retome com um modelo válido; o modelo original do Claude não é preservado.
9. **Conversão do transcript.** Uma mensagem OpenCode `user` por prompt real do usuário; tudo do assistente até o próximo prompt vira **uma** mensagem `assistant` com partes `text`: texto, `[tool call: <nome>] <input JSON>` (≤ 2000 chars) e `[tool result: ok|error] <saída>` (≤ 2000 chars). Ignorados e contados: `thinking`, sidechains, `isMeta`, comandos locais (`<command-name>`, `<local-command-*>`), registros de outros tipos e linhas inválidas. Imagem/documento → `[image omitted]`/`[document omitted]`. Texto > 64 KiB é truncado com marcador. A primeira mensagem do usuário ganha uma parte `synthetic: true` com o cabeçalho `[opc transfer] …`. Título: `OPC: transfer: <custom-title ou 1º prompt, 56 chars>`.
10. **Descrições das ferramentas e instruções do servidor em inglês** (texto para o modelo, como identificadores); saída renderizada do `transfer` e docs em PT-BR.
11. **Timer de timeout da chamada MCP sem `unref`** (o teste com dispatch pendurado precisa do timer vivo; ele é limpo no `finally`).

---

## Contrato consumido (F0–F4c) — premissas confirmadas

Assinaturas usadas aqui: `ExitCode`, `OpcError`, `toExitCode` (`opc-error`); `redact`, `redactText` (`redact`); `parseArgs`, `resolveArgv`, `splitArgString`, `readStdin`, `extractCwd` (F0 `args`), `RAW_ARGS_FLAG`, `parsePromptArgs`, `readRawArgs` (F2a `args`), `shellQuote` (F3 `args`); `main(rawArgv, { stdin, stdout, stderr, env, cwd, onError }) → Promise<number>`, `loadCommand(sub)`, `listSubcommands()` (F0 `opc-companion.mjs`, importável sem efeito colateral: só executa sob `invokedDirectly()`); `createContext` (`context`); `renderError` (`render`); `resolveDataDir`, `resolveWorkspaceRoot`, `workspaceStateDir`, `ensurePrivateDir`, `loadState`, `updateState` (`state`); `getProcessIdentity` (`process`); `expandAlias`, `parseFullId` (`models`); `assertAllowed` (`policy`); `compareVersions`, `MIN_OPENCODE_VERSION` (`server`); `DEFAULT_CONFIG`, `saveGlobalConfig` (`config`); `readJob` (`jobs`); helpers `REPO_ROOT`, `PLUGIN_ROOT`, `makeWorkspace`, `testEnv`, `runCli`, `readFakeState`, `stopAllServers`.

Premissas de comportamento, conferidas no texto das fases donas e cobertas por teste:

- **Despachante (F0 Task 14):** `main` é o despachante da CLI e do MCP (`resolveArgv` → `extractCwd` → `loadCommand(sub)` → `createContext({ …, cwd: cwd ?? io.cwd })` → `run(ctx, rest)`); subcomando desconhecido ou inválido → `UsageError('USAGE')`, exit 2; em erro chama `io.onError(err)` antes de renderizar, escreve `renderError` em stderr e, com `--json`, `{"error":{code,message,details}}` em stdout. [Task 1 · `companion-dispatch`]
- **`--` (F0 Task 4):** `parseArgs` já devolve tudo depois de `--` como posicionais (e recusa posicionais quando o spec não os aceita, exit 2); `extractCwd` para no `--`. Só `resolveArgv`/`readRawArgs` precisavam ignorar a flag de stdin depois de `--` (Task 1). [Task 1 · `args-terminator`]
- **`--json`:** todo subcomando aceita `--json` e imprime **um** documento JSON em stdout (`ctx.json` dos comandos; o `main` da F0 no caminho de erro). [Task 5, pares CLI × MCP]
- **Execução longa:** `task`/`ask`/`plan` (F2a `TURN_FLAGS`: `background`, `'wait-timeout'`), `subagent` (F3 `SPEC`), `orchestrate` (F4b `FLAG_SPEC`) e `conclave` (F4c `SPEC`) declaram `--background` (boolean) e `--wait-timeout <s>` (number); com `--background --json` imprimem um documento com o id do job/grupo. [Task 1 · `mcp-compat`]
- **Ids de job (F2a D4.1):** `newJobId(kind)` = `<prefixo>-<Date.now() base36>-<6 chars base36>`; `JOB_ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/`; grupos de `subagent` → `sub-…`, `orchestrate` → `orch-…`, `conclave` → `conc-…`. O `findJobId` dos helpers usa a mesma regex.
- **Permissões (F2a Task 13):** `permissions list | reply <id> once|reject [mensagem] [--confirmed-by-user] | answer <id> <resposta…>`; `reply` exige o pedido pendente em `GET /permission` (senão exit 2 `NOT_FOUND`) e decide com `checkReply` (`NEEDS_USER` → exit 4; `always` → exit 2; `reject` sempre passa). O fake da F2a guarda os pedidos em `fake.state.permissions` (mapa id → pedido), serve `GET /permission` com `Object.values(state.permissions)` e registra toda requisição (inclusive `POST /permission/:id/reply`) em `state.requests`. O MCP passa o `argv` direto (sem `--args-stdin`; esse caminho é só dos slash commands). [Task 7]
- **`pendingRequest` (F2a/D4.5):** é lista (`Array<{ type, id, sessionID, … }> | null`; em grupo, itens com `memberId`). A F5 não lê o campo: repassa o JSON de `status`/`result` como `data`, sem reinterpretar.
- **Resultado de grupo (F3/D4.6):** `result --json` de grupo imprime `{ group, members }` (pacote de F4b/F4c em `group.result`); `opc_job_result` devolve exatamente isso em `data`. [Task 6 · pares CLI × MCP; `tests/live/f5-mcp.mjs`]
- **Guarda de recursão (F2a D10/D4.3):** todo comando que cria job (`task`, `ask`, `plan`, `review`, `adversarial-review`, `subagent`, `command`, `orchestrate`, `conclave`) chama `assertNotInsideServer(ctx.env)` antes de conectar → `PolicyError('INSIDE_SERVER')`, exit 4. Pelo MCP: exit 4, `state: "policy_denied"`, `error.code: "INSIDE_SERVER"`. [Task 6]
- **Fake:** o cenário `ok` conclui turnos; o cenário `slow` (F2a `tests/fixtures/scenarios/slow.mjs`) mantém o turno vivo por mais de 2 s. [Tasks 1 e 6]
- **`config path`** (F1) imprime caminhos sob `OPC_DATA_DIR`. [Task 1]

---

## Interfaces novas

Acréscimos (nenhuma assinatura congelada muda). Documentar no mestre ao fechar o portão, conforme a regra de ajuste.

**Consumido da F0 sem alteração (o despachante do MCP):**

```js
// scripts/opc-companion.mjs (F0 Task 14) — importável sem efeito colateral (executa só sob invokedDirectly())
export async function main(rawArgv, { stdin, stdout, stderr, env, cwd, onError } = {}) // → Promise<number>; o MCP importa `import { main as dispatch } from './opc-companion.mjs'`
export async function loadCommand(sub)              // usado pelo main; a F5 não chama direto
export function listSubcommands()
```

**Ajuste de comportamento (Task 1), sem mudança de assinatura:**

```js
// lib/args.mjs — resolveArgv (F0): só considera '--args-stdin' antes do primeiro '--' (tokens do stdin entram antes do tail)
//              — readRawArgs (F2a): só considera '--raw-args-stdin' antes do primeiro '--' (flags do stdin entram antes do tail)
//              — parseArgs/extractCwd (F0): já tratam '--' — inalterados
```

**Módulos novos:**

```js
// scripts/lib/mcp-protocol.mjs
export const LATEST_PROTOCOL_VERSION                // '2025-06-18'
export const SUPPORTED_PROTOCOL_VERSIONS            // ['2025-06-18', '2025-03-26', '2024-11-05']
export const JsonRpcErrorCode                       // { PARSE_ERROR:-32700, INVALID_REQUEST:-32600, METHOD_NOT_FOUND:-32601, INVALID_PARAMS:-32602, INTERNAL_ERROR:-32603 }
export const MAX_LINE_CHARS                         // 10 MiB
export function negotiateProtocolVersion(requested) // suportada → a mesma; senão LATEST
export function errorResponse(id, code, message)    // mensagem redigida; id inválido → null
export function createMcpServer({ serverInfo, instructions, tools, callTool, log }) // → { handle(msg) → Promise<response|null>, state }
export function createLineSplitter({ maxLineChars }) // → { push(chunk) → (string|null)[], flush() → string[] }
export function serveStdio({ server, input, write, log }) // → Promise<void> (resolve no fim do input, após respostas pendentes)

// scripts/lib/mcp-schema.mjs
export function validateInput(schema, value, where = '$') // → string[] (subconjunto: type, enum, pattern, min/maxLength, minimum/maximum, items, min/maxItems, required, additionalProperties:false)

// scripts/lib/mcp-tools.mjs
export const MAX_WAIT_SEC /* 540 */, DEFAULT_WAIT_SEC /* 120 */, DEFAULT_STATUS_WAIT_SEC /* 60 */, CALL_TIMEOUT_MS /* 300000 */, MAX_OUTPUT_CHARS /* 200000 */
export const EXIT_STATE                             // {0:'ok',2:'usage_error',3:'waiting_permission',4:'policy_denied',5:'connection_error',6:'wait_timeout',7:'job_failed',130:'cancelled'}
export const ALLOWED_COMMANDS                       // allowlist 'sub' | 'sub action'
export function commandKey(argv)                    // 'config get', 'session show', 'task'…
export const SERVER_INSTRUCTIONS                    // texto de initialize.instructions
export const TOOLS                                  // [{ name, title, description, annotations, inputSchema, toArgv(args) → string[], timeoutMs?(args) }]
export const TOOL_NAMES
export function resolveClaudeSessionId({ env, cwd, ppid }, deps = {}) // → string | null
export function createCaptureStream({ maxChars })   // Writable com isTTY=false, text(), truncated()
export function emptyStdin()                        // Readable vazio, isTTY=false
export function buildEnvelope({ exitCode, stdout, stderr, error, truncated }) // → { envelope, isError }
export function toolResult({ envelope, isError })   // → { content:[{type:'text', text}], isError }
export function createToolCaller({ dispatch, env, defaultCwd, ppid, resolveSessionId, callTimeoutMs, log }) // dispatch = main da F0 (argv, io) → Promise<number>; → async (tool, args) → CallToolResult

// scripts/lib/transfer.mjs
export const TRANSCRIPT_PATH_ENV /* 'OPC_COMPANION_TRANSCRIPT_PATH' */, ALLOWED_ROOT_ENV /* 'OPC_TRANSFER_ALLOWED_ROOT' */
export const MAX_TRANSCRIPT_BYTES /* 64 MiB */, MAX_TEXT_CHARS /* 65536 */, MAX_TOOL_CHARS /* 2000 */, TITLE_PREFIX /* 'OPC: transfer: ' */, IMPORT_SUCCESS_RE, EXPORT_SHAPE
export function resolveTranscriptPath({ source, env, cwd, home })      // → realpath; erros: NO_TRANSCRIPT/NOT_JSONL/NOT_FOUND/NOT_A_FILE/TRANSCRIPT_TOO_LARGE (exit 2), TRANSCRIPT_OUTSIDE_ALLOWED_ROOT (exit 4)
export function parseJsonlLines(lines)              // → { records, invalid }
export async function readTranscript(file)          // → { records, invalid }
export function truncateText(text, max)
export function convertClaudeRecords(records, { maxTextChars, maxToolChars, now }) // → { turns:[{role, createdAt, completedAt?, texts[]}], title, claudeSessionId, stats:{records, skipped:{meta,sidechain,command,thinking,other}} }
export function createIdGenerator({ now, randomBytes }) // → nextId(prefix, 'ascending'|'descending')
export function buildTitle(conversion)
export function transferHeader(claudeSessionId)
export function buildExport(conversion, { model, agent = 'build', directory, version, nextId }) // → objeto no formato do opencode export; EMPTY_TRANSCRIPT (exit 2)
export function validateExportShape(data)           // → string[]
export function resolveTransferModel({ flag, config }) // → { providerID, modelID, full }; NO_MODEL / MODEL_NEEDS_FULL_ID (exit 2); PolicyError (exit 4)
export async function detectOpencodeVersion({ opencodeBin, env, execFileImpl }) // → '1.18.32'; OPENCODE_NOT_FOUND / UNSUPPORTED_VERSION (exit 5)
export function writeExportFile(stateDir, exported) // → caminho <stateDir>/transfer/export-<id>.json (600, dir 700)
export function parseImportOutput(stdout)           // → sessionID | null
export async function runImport({ opencodeBin, file, cwd, env, timeoutMs, execFileImpl }) // → { sessionID, exitCode }; IMPORT_FAILED (exit 7), OPENCODE_NOT_FOUND (exit 5)
// (sem shellQuote próprio: o comando usa `shellQuote` de lib/args.mjs, F3)

// scripts/commands/transfer.mjs
export async function execute(ctx, { source = null, model = null }) // → { sessionID, title, model, source, workspaceRoot, messages:{total,user,assistant}, skipped:{…, invalidLines}, resumeCommand, warnings[] }
export async function run(ctx, argv)                // flags: --source, --model/-m, --json, --cwd

// scripts/lib/render.mjs (acréscimo)
export function renderTransfer(result)              // Markdown PT-BR

// tests/helpers.mjs (acréscimos)
export const MCP_SERVER
export function startMcpClient({ env, cwd, timeoutMs = 120000, nodeArgs = [] }) // → { request, notify, initialize, callTool, waitFor, close, sendRaw, messages, rawLines, stderr, exited, child }
export function findJobId(value, kind = null)      // busca recursiva por um id que case com o JOB_ID_RE da F2a (inclui cmd; sufixo [0-9a-z]{6})
export function writeTestConfig(env, patch = {})    // DEFAULT_CONFIG + patch (policy mesclada) → saveGlobalConfig
export async function cliJson(args, { env, cwd, timeoutMs }) // runCli com '--json' inserido antes de '--' → { code, data, stderr }

// tests/fixtures/fake-import.mjs — checkImportShape(data) → string[]; runFakeImport(args) → exit code
// Variáveis novas: OPC_TRANSFER_ALLOWED_ROOT (produto, só testes); FAKE_OPENCODE_IMPORT = ok | fail | crash (fake)
```

---

## Estrutura de arquivos da fase

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `plugins/opc/scripts/opc-companion.mjs` | — (consumido da F0) | `main(argv, io)` é o despachante do MCP; nenhuma alteração |
| `plugins/opc/scripts/lib/args.mjs` | Modificar | `resolveArgv` (F0) e `readRawArgs` (F2a): flag de stdin só antes de `--` |
| `plugins/opc/scripts/lib/mcp-protocol.mjs` | Criar | JSON-RPC/MCP stdio |
| `plugins/opc/scripts/lib/mcp-schema.mjs` | Criar | validação de argumentos |
| `plugins/opc/scripts/lib/mcp-tools.mjs` | Criar | catálogo de ferramentas, argv, envelope, sessão do Claude |
| `plugins/opc/scripts/mcp-server.mjs` | Criar | entry point MCP (guarda do stdout) |
| `plugins/opc/.claude-plugin/plugin.json` | Modificar | `mcpServers.opc` |
| `plugins/opc/scripts/lib/transfer.mjs` | Criar | conversão, ids, forma do export, import |
| `plugins/opc/scripts/commands/transfer.mjs` | Criar | subcomando `transfer` |
| `plugins/opc/scripts/lib/render.mjs` | Modificar | `renderTransfer` |
| `plugins/opc/commands/transfer.md` | Criar | `/opc:transfer` |
| `plugins/opc/skills/opc-result-handling/SKILL.md` | Modificar | regras das ferramentas MCP |
| `tests/helpers.mjs` | Modificar (acréscimo) | cliente MCP, `findJobId`, `writeTestConfig`, `cliJson` |
| `tests/fixtures/fake-import.mjs` | Criar | `opencode import` falso |
| `tests/fixtures/bin/opencode` | Modificar | ramo `import` |
| `tests/fixtures/scenarios/mcp-pending-permission.mjs` | Criar | pedidos de permissão semeados |
| `tests/fixtures/data/export-sample.json` | Criar | export real higienizado |
| `tests/fixtures/data/claude-transcript-sample.jsonl` | Criar | transcript sintético |
| `tests/unit/{args-terminator,companion-dispatch,mcp-protocol,mcp-schema,mcp-tools,transfer}.test.mjs` | Criar | unitários |
| `tests/integration/{mcp-compat,mcp-server,mcp-jobs,mcp-permissions,transfer}.test.mjs` | Criar | integração |
| `tests/live/f5-mcp.mjs`, `tests/live/f5-transfer.mjs` | Criar | ao vivo |
| `docs/architecture.md`, `docs/commands.md`, `docs/troubleshooting.md`, `README.md`, `CHANGELOG.md`, `docs/phases/F5-report.md` | Modificar/Criar | documentação e relatório |

---

## Tarefas

### Task 1: Contrato do companion (F0), `--args-stdin`/`--raw-args-stdin` só antes de `--` e compatibilidade dos comandos longos

Sem mudança de comportamento da CLI quando o `argv` não tem `--`. A F0 já entrega o companion importável sem efeito colateral (`main(rawArgv, { stdin, stdout, stderr, env, cwd, onError }) → Promise<number>`, `loadCommand(sub)`, `listSubcommands()`, execução guardada por `invokedDirectly()`) e o `parseArgs` que trata `--` como fim das opções (teste F0 "parseArgs keeps everything after -- as positionals"). Esta tarefa **não recria** `dispatch`/`loadCommand`/`main`: fixa, com testes, o pedaço desse contrato que o MCP usa (o `main` da F0 **é** o despachante que o MCP chama) e fecha a única lacuna real — `resolveArgv` (F0) e `readRawArgs` (F2a) procuravam a flag de stdin no `argv` inteiro, inclusive depois de `--`, onde o MCP põe o texto livre.

**Files:**
- Modify: `plugins/opc/scripts/lib/args.mjs` (`resolveArgv` da F0 e `readRawArgs` da F2a: flag de stdin só antes do primeiro `--`; assinaturas inalteradas)
- Test: `tests/unit/companion-dispatch.test.mjs`, `tests/unit/args-terminator.test.mjs`, `tests/integration/mcp-compat.test.mjs`
- Modify (acréscimo): `tests/helpers.mjs`

**Interfaces:**
- Consumes: `main(rawArgv, { stdin, stdout, stderr, env, cwd, onError }) → Promise<number>` (F0 `opc-companion.mjs`: `resolveArgv` → `extractCwd` → `loadCommand(sub)` → `createContext` → `run(ctx, rest)`; erro → `onError?.(err)`, `renderError` em stderr, `{"error":…}` em stdout com `--json`, `toExitCode(err)`; desconhecido → `USAGE`, exit 2); `resolveArgv(argv, { stdin })`, `parseArgs(argv, spec)` (`--` já encerra as opções), `splitArgString(input)`, `readStdin(stream)` (F0 `args`); `RAW_ARGS_FLAG`, `parsePromptArgs(raw, flagSpec)`, `readRawArgs(argv, flagSpec, { stdin })` (F2a `args`); helpers `testEnv`, `makeWorkspace`, `runCli`, `stopAllServers`.
- Produces: `resolveArgv` e `readRawArgs` que ignoram a flag de stdin depois de `--` (sem `--` no `argv`, comportamento idêntico ao da F0/F2a); helpers `MCP_SERVER`, `startMcpClient`, `findJobId`, `writeTestConfig`, `cliJson`.

- [x] **Step 1: Criar a branch da fase (com autorização do operador)**

Pedir autorização explícita no chat antes do primeiro comando git da fase (regras de git do mestre). Com o "sim":

```bash
git checkout main && git pull --ff-only && git checkout -b feat/opc-f5
```

- [x] **Step 2: Acrescentar os helpers da F5 ao fim de `tests/helpers.mjs`**

Colar ao **fim** do arquivo (imports com alias para não colidir com os que já existem; `import` no meio do módulo é válido em ESM):

```js
// ---- F5: MCP client, job id lookup, config seeding, CLI JSON (appended; aliased imports avoid clashes) ----
import { spawn as spawnF5 } from 'node:child_process';
import nodePathF5 from 'node:path';
import { DEFAULT_CONFIG as F5_DEFAULT_CONFIG, saveGlobalConfig as f5SaveGlobalConfig } from '../plugins/opc/scripts/lib/config.mjs';

export const MCP_SERVER = nodePathF5.join(PLUGIN_ROOT, 'scripts', 'mcp-server.mjs');

export function startMcpClient({ env, cwd, timeoutMs = 120000, nodeArgs = [] }) {
  const child = spawnF5(process.execPath, [...nodeArgs, MCP_SERVER], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const rawLines = [];
  const waiters = [];
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      rawLines.push(line);
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      if (msg) {
        messages.push(msg);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(msg)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(msg);
          }
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  function waitFor(predicate, timeout = timeoutMs) {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`MCP wait timed out; stderr tail:\n${stderr.slice(-2000)}`));
      }, timeout);
      waiters.push(waiter);
    });
  }

  function send(obj) {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function request(method, params, { timeout = timeoutMs } = {}) {
    const id = nextId++;
    const pending = waitFor((msg) => msg.id === id && ('result' in msg || 'error' in msg), timeout);
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return pending;
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async function initialize(protocolVersion = '2025-06-18') {
    const response = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'opc-test', version: '0.0.0' } });
    notify('notifications/initialized');
    return response;
  }

  async function callTool(name, args = {}, { timeout = timeoutMs } = {}) {
    const response = await request('tools/call', { name, arguments: args }, { timeout });
    if (response.error) throw new Error(`tools/call ${name} → JSON-RPC ${response.error.code}: ${response.error.message}`);
    return { isError: response.result.isError === true, envelope: JSON.parse(response.result.content[0].text), result: response.result };
  }

  async function close() {
    child.stdin.end();
    return exited;
  }

  return {
    child,
    messages,
    rawLines,
    request,
    notify,
    initialize,
    callTool,
    waitFor,
    close,
    exited,
    sendRaw: (text) => child.stdin.write(text),
    get stderr() {
      return stderr;
    },
  };
}

const JOB_ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/; // = F2a jobs.mjs JOB_ID_RE (newJobId suffix is base36)

export function findJobId(value, kind = null) {
  if (typeof value === 'string') return JOB_ID_RE.test(value) && (kind === null || value.startsWith(`${kind}-`)) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findJobId(item, kind);
      if (id) return id;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const id = findJobId(item, kind);
      if (id) return id;
    }
  }
  return null;
}

export function writeTestConfig(env, patch = {}) {
  const config = { ...F5_DEFAULT_CONFIG, ...patch, policy: { ...F5_DEFAULT_CONFIG.policy, ...(patch.policy ?? {}) } };
  f5SaveGlobalConfig(env.OPC_DATA_DIR, config);
  return config;
}

export async function cliJson(args, { env, cwd, timeoutMs = 60000 }) {
  const cut = args.indexOf('--');
  const withJson = cut === -1 ? [...args, '--json'] : [...args.slice(0, cut), '--json', ...args.slice(cut)];
  const r = await runCli(withJson, { env, cwd, timeoutMs });
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    data = r.stdout.trim() || null;
  }
  return { code: r.code, data, stderr: r.stderr };
}
```

- [x] **Step 3: Escrever os testes (os de `parseArgs` e do companion fixam o contrato da F0 e já passam; os de flag de stdin após `--` falham)**

`tests/unit/args-terminator.test.mjs`:

```js
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { parseArgs, RAW_ARGS_FLAG, readRawArgs, resolveArgv } from '../../plugins/opc/scripts/lib/args.mjs';

const SPEC = { flags: { json: { type: 'boolean' }, write: { type: 'boolean' }, model: { type: 'string' } }, allowPositionals: true };
const PROMPT_FLAGS = { write: { type: 'boolean' }, model: { type: 'string', alias: 'm' } };

function untouchedStdin() {
  const probe = { touched: false };
  probe.stream = { isTTY: false, [Symbol.asyncIterator]() { probe.touched = true; throw new Error('stdin must not be read'); } };
  return probe;
}

// F0 contract the MCP relies on (already delivered by F0 parseArgs; kept here as the MCP regression net).
test('"--" ends option parsing and keeps the tail verbatim', () => {
  const { flags, positionals } = parseArgs(['--json', '--model', 'a/b', '--', '--write', 'line1\nline2 $(x) `y` ç'], SPEC);
  assert.equal(flags.json, true);
  assert.equal(flags.model, 'a/b');
  assert.notEqual(flags.write, true);
  assert.deepEqual(positionals, ['--write', 'line1\nline2 $(x) `y` ç']);
});

test('positionals before "--" keep their order ahead of the tail', () => {
  const { positionals } = parseArgs(['reply', 'per_1', 'reject', '--json', '--', '--no thanks'], SPEC);
  assert.deepEqual(positionals, ['reply', 'per_1', 'reject', '--no thanks']);
});

test('"--" followed by nothing is accepted', () => {
  assert.deepEqual(parseArgs(['--json', '--'], SPEC).positionals, []);
});

test('a tail after "--" is still refused when the command takes no positionals', () => {
  assert.throws(() => parseArgs(['--', 'x'], { flags: { json: { type: 'boolean' } } }), (e) => e.exitCode === 2);
});

// Gap closed by this task: a free-text token after "--" equal to a stdin flag must stay text.
test('resolveArgv ignores --args-stdin that appears after "--"', async () => {
  const probe = untouchedStdin();
  assert.deepEqual(await resolveArgv(['task', '--', '--args-stdin'], { stdin: probe.stream }), ['task', '--', '--args-stdin']);
  assert.equal(probe.touched, false);
});

test('resolveArgv still expands --args-stdin before "--" and keeps the tail last', async () => {
  assert.deepEqual(await resolveArgv(['task', '--args-stdin'], { stdin: Readable.from(['--model "a/b" hello']) }), ['task', '--model', 'a/b', 'hello']);
  assert.deepEqual(await resolveArgv(['task', '--args-stdin', '--', '--write'], { stdin: Readable.from(['--model a/b']) }), ['task', '--model', 'a/b', '--', '--write']);
});

test('readRawArgs ignores --raw-args-stdin that appears after "--"', async () => {
  const probe = untouchedStdin();
  assert.deepEqual(await readRawArgs(['--json', '--', RAW_ARGS_FLAG], PROMPT_FLAGS, { stdin: probe.stream }), { argv: ['--json', '--', RAW_ARGS_FLAG], text: null });
  assert.equal(probe.touched, false);
});

test('readRawArgs before "--" keeps the F2a behavior and inserts the stdin flags ahead of the tail', async () => {
  const plain = await readRawArgs(['--json', RAW_ARGS_FLAG], PROMPT_FLAGS, { stdin: Readable.from(["--write don't split\n"]) });
  assert.deepEqual(plain, { argv: ['--json', RAW_ARGS_FLAG, '--write'], text: "don't split" });
  const withTail = await readRawArgs([RAW_ARGS_FLAG, '--', 'x'], PROMPT_FLAGS, { stdin: Readable.from(['-m fast y']) });
  assert.deepEqual(withTail.argv, [RAW_ARGS_FLAG, '-m', 'fast', '--', 'x']);
});
```

`tests/unit/companion-dispatch.test.mjs` (contrato da F0 que o MCP consome — o `main` do companion é o despachante):

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

const exitCodeBeforeImport = process.exitCode;
// The MCP imports the F0 entry point under this name (scripts/mcp-server.mjs does the same).
const { main: dispatch } = await import('../../plugins/opc/scripts/opc-companion.mjs');

function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  stream.isTTY = false;
  stream.text = () => chunks.join('');
  return stream;
}

function noStdin() {
  const stream = Readable.from([]);
  stream.isTTY = false;
  return stream;
}

test('importing the companion does not run the CLI (F0 invokedDirectly guard)', () => {
  assert.equal(typeof dispatch, 'function');
  assert.equal(process.exitCode, exitCodeBeforeImport);
});

test('unknown subcommand: exit 2, io.onError gets the typed USAGE error, stderr gets the rendered error', async () => {
  let seen = null;
  const stderr = sink();
  const stdout = sink();
  const code = await dispatch(['definitely-not-a-command', '--json'], { env: {}, cwd: os.tmpdir(), stdin: noStdin(), stdout, stderr, onError: (err) => { seen = err; } });
  assert.equal(code, 2);
  assert.equal(seen.code, 'USAGE');
  assert.equal(seen.exitCode, 2);
  assert.match(stderr.text(), /opc error/);
  assert.equal(JSON.parse(stdout.text()).error.code, 'USAGE', 'with --json the error is one JSON document on stdout');
});

test('main runs a real subcommand with the injected env, io.cwd and streams (never process.*)', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-dispatch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stdout = sink();
  const code = await dispatch(['config', 'path'], { env: { ...process.env, OPC_DATA_DIR: dir }, cwd: dir, stdin: noStdin(), stdout, stderr: sink() });
  assert.equal(code, 0);
  assert.ok(stdout.text().includes(dir), stdout.text());
});
```

`tests/integration/mcp-compat.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cliJson, findJobId, makeWorkspace, testEnv } from '../helpers.mjs';

const UNKNOWN_FLAG = /unknown (flag|option)|flag desconhecida|opção desconhecida/i;

test('task, ask and plan accept --background, --wait-timeout and a "--" terminated prompt', async (t) => {
  const env = testEnv(t, { scenario: 'ok' });
  const ws = makeWorkspace(t);
  for (const sub of ['task', 'ask', 'plan']) {
    const background = await cliJson([sub, '--background', '--', '--not-a-flag prompt'], { env, cwd: ws });
    assert.equal(background.code, 0, `${sub} --background: ${background.stderr}`);
    assert.ok(findJobId(background.data, sub), `${sub} --background returns a ${sub} job id: ${JSON.stringify(background.data)}`);
    const foreground = await cliJson([sub, '--wait-timeout', '60', '--', 'say ok'], { env, cwd: ws });
    assert.equal(foreground.code, 0, `${sub} --wait-timeout: ${foreground.stderr}`);
  }
});

test('subagent, orchestrate and conclave accept --background and --wait-timeout', async (t) => {
  const env = testEnv(t, { scenario: 'ok' });
  const ws = makeWorkspace(t);
  const heads = [['subagent', '--agent', 'build'], ['orchestrate'], ['conclave', '--models', 'fixture-a/m,fixture-b/m']];
  for (const head of heads) {
    for (const mode of [['--background'], ['--wait-timeout', '1']]) {
      const r = await cliJson([...head, ...mode, '--', 'x'], { env, cwd: ws });
      assert.doesNotMatch(r.stderr, UNKNOWN_FLAG, `${head[0]} ${mode[0]}: ${r.stderr}`);
    }
  }
});
```

- [x] **Step 4: Rodar e ver falhar**

Run: `node --test tests/unit/args-terminator.test.mjs tests/unit/companion-dispatch.test.mjs tests/integration/mcp-compat.test.mjs`
Expected: FAIL só nos 4 testes de flag de stdin do `args-terminator` (4 pass / 4 fail no arquivo): os dois "… ignores --args-stdin / --raw-args-stdin that appears after "--"" (o `resolveArgv` da F0 remove o token e lê o stdin; o `readRawArgs` da F2a lê o stdin — o `untouchedStdin` lança `stdin must not be read`) e os dois "… ahead of / keeps the tail last" (F0 e F2a anexam o que veio do stdin depois do tail). Os testes de `parseArgs`, o `companion-dispatch` (contrato da F0) e o `mcp-compat` (flags confirmadas em F2a/F3/F4b/F4c) já passam; se algum deles falhar, o defeito está na fase dona (F0, F2a, F3, F4b ou F4c) — parar e reportar ao operador em vez de contornar aqui.

- [x] **Step 5: Ajustar `resolveArgv` (F0) e `readRawArgs` (F2a) em `plugins/opc/scripts/lib/args.mjs`**

Acréscimo mínimo, sem mudar assinatura nem o comportamento quando não há `--` no `argv` (os testes da F0 e da F2a continuam valendo). Substituir as duas funções por:

```js
// Splits argv at the first "--": stdin flags only count before it; free text after it is never a flag.
function splitAtTerminator(argv) {
  const cut = argv.indexOf('--');
  return cut === -1 ? { head: argv, tail: [] } : { head: argv.slice(0, cut), tail: argv.slice(cut) };
}

export async function resolveArgv(argv, { stdin = process.stdin } = {}) {
  const { head, tail } = splitAtTerminator(argv);
  const index = head.indexOf('--args-stdin');
  if (index === -1) return [...argv];
  const rest = head.filter((token, i) => i !== index);
  const content = await readStdin(stdin);
  return [...rest, ...splitArgString(content), ...tail];
}
```

```js
export async function readRawArgs(argv, flagSpec, { stdin = process.stdin } = {}) {
  const { head, tail } = splitAtTerminator(argv);
  if (!head.includes(RAW_ARGS_FLAG)) return { argv: [...argv], text: null };
  const { argv: flagArgv, prompt } = parsePromptArgs(await readStdin(stdin), flagSpec);
  return { argv: [...head, ...flagArgv, ...tail], text: prompt };
}
```

(`splitAtTerminator` é privado; declarar antes de `resolveArgv`. `parseArgs` e `extractCwd` da F0 já tratam `--` e não mudam.)

- [x] **Step 6: Rodar os testes da tarefa e a suíte inteira**

Run: `node --test tests/unit/args-terminator.test.mjs tests/unit/companion-dispatch.test.mjs tests/integration/mcp-compat.test.mjs`
Expected: PASS (13 testes).

Run: `npm test`
Expected: PASS — sem `--` no `argv` nada muda; todas as suítes de F0–F4c verdes (inclusive `args.test.mjs` da F0 e `args-prompt.test.mjs` da F2a).

- [x] **Step 7: Commit**

```bash
git add plugins/opc/scripts/lib/args.mjs tests/helpers.mjs tests/unit/args-terminator.test.mjs tests/unit/companion-dispatch.test.mjs tests/integration/mcp-compat.test.mjs
git commit -m "fix: ignore stdin argument flags after -- and pin the companion contract used by MCP"
```

---

### Task 2: Núcleo do protocolo MCP (JSON-RPC 2.0 por stdio)

**Files:**
- Create: `plugins/opc/scripts/lib/mcp-protocol.mjs`
- Test: `tests/unit/mcp-protocol.test.mjs`

**Interfaces:**
- Consumes: `redactText(text)` (`redact`).
- Produces: `LATEST_PROTOCOL_VERSION`, `SUPPORTED_PROTOCOL_VERSIONS`, `JsonRpcErrorCode`, `MAX_LINE_CHARS`, `negotiateProtocolVersion`, `errorResponse`, `createMcpServer({ serverInfo, instructions, tools, callTool, log })` → `{ handle, state }`, `createLineSplitter`, `serveStdio({ server, input, write, log })`. Uma ferramenta é `{ name, title?, description, inputSchema, annotations? }` (o protocolo ignora os demais campos); `callTool(tool, args)` devolve o `CallToolResult`.

Regras do protocolo implementadas (MCP 2025-06-18, transporte stdio): uma mensagem JSON-RPC por linha, sem `\n` interno; `initialize` negocia a versão (suportada → ecoa; senão responde a mais recente); `notifications/initialized` e demais notificações nunca têm resposta; `ping` → `{}`; antes do `initialize`, só `initialize`/`ping` são aceitos (`-32600`); `tools/list` sem paginação; `tools/call` com ferramenta inexistente → `-32602`; lotes (arrays) não são aceitos na 2025-06-18 → `-32600`; JSON inválido → `-32700` com `id: null`; respostas vindas do cliente são ignoradas; exceção interna → `-32603` com mensagem redigida.

- [x] **Step 1: Escrever o teste que falha**

```js
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  createLineSplitter,
  createMcpServer,
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  serveStdio,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../plugins/opc/scripts/lib/mcp-protocol.mjs';

const TOOL = { name: 'echo', title: 'Echo', description: 'Echo args', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, toArgv: () => [] };

function makeServer(callTool = async (tool, args) => ({ content: [{ type: 'text', text: JSON.stringify({ tool: tool.name, args }) }], isError: false })) {
  return createMcpServer({ serverInfo: { name: 'opc', version: '9.9.9' }, instructions: 'be careful', tools: [TOOL], callTool });
}

async function initialized(server, protocolVersion = LATEST_PROTOCOL_VERSION) {
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return res;
}

test('protocol constants and negotiation', () => {
  assert.equal(LATEST_PROTOCOL_VERSION, '2025-06-18');
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateProtocolVersion('2099-01-01'), '2025-06-18');
  assert.equal(negotiateProtocolVersion(undefined), '2025-06-18');
});

test('initialize returns capabilities, serverInfo, instructions and the negotiated version', async () => {
  const server = makeServer();
  const res = await initialized(server, '2025-03-26');
  assert.deepEqual(res, {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'opc', version: '9.9.9' }, instructions: 'be careful' },
  });
  assert.equal(server.state.initialized, true);
});

test('requests other than initialize/ping are refused before initialize', async () => {
  const server = makeServer();
  assert.deepEqual(await server.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
  const res = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.error.code, JsonRpcErrorCode.INVALID_REQUEST);
});

test('tools/list exposes name, title, description, inputSchema and annotations only', async () => {
  const server = makeServer();
  await initialized(server);
  const res = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(res.result.tools, [{ name: 'echo', title: 'Echo', description: 'Echo args', inputSchema: TOOL.inputSchema, annotations: { readOnlyHint: true } }]);
});

test('tools/call delegates to callTool; unknown tool is -32602', async () => {
  const server = makeServer();
  await initialized(server);
  const ok = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { tool: 'echo', args: { a: 1 } });
  const unknown = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'opc_config_set', arguments: {} } });
  assert.equal(unknown.error.code, JsonRpcErrorCode.INVALID_PARAMS);
  assert.match(unknown.error.message, /Unknown tool: opc_config_set/);
  const noName = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} });
  assert.equal(noName.error.code, JsonRpcErrorCode.INVALID_PARAMS);
});

test('method not found, invalid messages, batches, notifications and client responses', async () => {
  const server = makeServer();
  await initialized(server);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).error.code, JsonRpcErrorCode.METHOD_NOT_FOUND);
  assert.equal((await server.handle({ id: 8, method: 'ping' })).error.code, JsonRpcErrorCode.INVALID_REQUEST);
  assert.deepEqual((await server.handle([{ jsonrpc: '2.0', id: 9, method: 'ping' }])).id, null);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, JsonRpcErrorCode.INVALID_REQUEST);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', id: 10, result: {} }), null);
});

test('an exception inside callTool becomes -32603 with a redacted message', async () => {
  const server = makeServer(async () => {
    throw new Error('boom');
  });
  await initialized(server);
  const res = await server.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'echo' } });
  assert.deepEqual(res.error, { code: JsonRpcErrorCode.INTERNAL_ERROR, message: 'boom' });
});

test('createLineSplitter handles partial chunks, CRLF and oversize lines', () => {
  const splitter = createLineSplitter({ maxLineChars: 10 });
  assert.deepEqual(splitter.push('{"a"'), []);
  assert.deepEqual(splitter.push(':1}\r\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(splitter.push('x'.repeat(11)), [null]);
  assert.deepEqual(splitter.push('tail'), []);
  assert.deepEqual(splitter.flush(), ['tail']);
});

test('serveStdio answers each line, reports parse errors with id null and ends with the input', async () => {
  const server = makeServer();
  const input = new PassThrough();
  const written = [];
  const done = serveStdio({ server, input, write: (line) => written.push(line) });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  input.write('{not json\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  input.end();
  await done;
  const messages = written.map((line) => {
    assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'), 'one JSON message per line');
    return JSON.parse(line);
  });
  assert.equal(messages.length, 3);
  assert.ok(messages.some((m) => m.id === 1 && m.result.protocolVersion === '2025-06-18'));
  assert.ok(messages.some((m) => m.id === null && m.error.code === JsonRpcErrorCode.PARSE_ERROR));
  assert.ok(messages.some((m) => m.id === 2 && typeof m.result === 'object'));
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/mcp-protocol.test.mjs`
Expected: FAIL com `Cannot find module '.../scripts/lib/mcp-protocol.mjs'`.

- [x] **Step 3: Implementar `plugins/opc/scripts/lib/mcp-protocol.mjs`**

```js
// Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited), zero dependencies.
// Protocol revision implemented: 2025-06-18 (older revisions accepted by negotiation).
import { redactText } from './redact.mjs';

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const JsonRpcErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});
export const MAX_LINE_CHARS = 10 * 1024 * 1024;

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

function isValidId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: isValidId(id) ? id : null, error: { code, message: redactText(String(message)) } };
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function publicTool(tool) {
  const out = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  if (tool.title) out.title = tool.title;
  if (tool.annotations) out.annotations = tool.annotations;
  return out;
}

export function createMcpServer({ serverInfo, instructions = undefined, tools, callTool, log = () => {} }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const state = { initializeReceived: false, initialized: false, protocolVersion: null, clientInfo: null };

  async function handleRequest(msg) {
    const { id, method } = msg;
    const params = msg.params ?? {};
    if (method === 'initialize') {
      state.initializeReceived = true;
      state.protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      state.clientInfo = params.clientInfo ?? null;
      const result = { protocolVersion: state.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo };
      if (instructions) result.instructions = instructions;
      return resultResponse(id, result);
    }
    if (method === 'ping') return resultResponse(id, {});
    if (!state.initializeReceived) return errorResponse(id, JsonRpcErrorCode.INVALID_REQUEST, 'Server not initialized: send initialize first');
    if (method === 'tools/list') return resultResponse(id, { tools: tools.map(publicTool) });
    if (method === 'tools/call') {
      if (typeof params.name !== 'string') return errorResponse(id, JsonRpcErrorCode.INVALID_PARAMS, 'tools/call requires params.name');
      const tool = byName.get(params.name);
      if (!tool) return errorResponse(id, JsonRpcErrorCode.INVALID_PARAMS, `Unknown tool: ${params.name}`);
      return resultResponse(id, await callTool(tool, params.arguments ?? {}));
    }
    return errorResponse(id, JsonRpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  async function handle(msg) {
    if (Array.isArray(msg)) return errorResponse(null, JsonRpcErrorCode.INVALID_REQUEST, 'JSON-RPC batches are not supported');
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return errorResponse(msg?.id, JsonRpcErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 message');
    }
    if (typeof msg.method !== 'string') return null;
    if (!('id' in msg)) {
      if (msg.method === 'notifications/initialized') state.initialized = true;
      return null;
    }
    if (!isValidId(msg.id)) return errorResponse(null, JsonRpcErrorCode.INVALID_REQUEST, 'Invalid request id');
    try {
      return await handleRequest(msg);
    } catch (err) {
      log(`[opc] mcp: internal error in ${msg.method}: ${redactText(String(err?.message ?? err))}`);
      return errorResponse(msg.id, JsonRpcErrorCode.INTERNAL_ERROR, err?.message ?? 'Internal error');
    }
  }

  return { handle, state };
}

export function createLineSplitter({ maxLineChars = MAX_LINE_CHARS } = {}) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = [];
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        lines.push(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      if (buffer.length > maxLineChars) {
        buffer = '';
        lines.push(null);
      }
      return lines;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return rest.trim() ? [rest] : [];
    },
  };
}

export function serveStdio({ server, input, write, log = () => {} }) {
  const splitter = createLineSplitter();
  const pending = new Set();
  const send = (obj) => write(`${JSON.stringify(obj)}\n`);

  function processLine(line) {
    if (line === null) {
      send(errorResponse(null, JsonRpcErrorCode.PARSE_ERROR, `Message exceeds ${MAX_LINE_CHARS} characters`));
      return;
    }
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(errorResponse(null, JsonRpcErrorCode.PARSE_ERROR, 'Parse error: invalid JSON'));
      return;
    }
    const task = Promise.resolve()
      .then(() => server.handle(msg))
      .then((response) => {
        if (response) send(response);
      })
      .catch((err) => log(`[opc] mcp: ${redactText(String(err?.message ?? err))}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  }

  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) processLine(line);
    });
    input.on('end', async () => {
      for (const line of splitter.flush()) processLine(line);
      await Promise.allSettled([...pending]);
      resolve();
    });
  });
}
```

- [x] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/mcp-protocol.test.mjs`
Expected: PASS (9 testes).

- [x] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/mcp-protocol.mjs tests/unit/mcp-protocol.test.mjs
git commit -m "feat: add zero-dependency MCP stdio protocol core"
```

---

### Task 3: Validação dos argumentos das ferramentas (subconjunto de JSON Schema)

**Files:**
- Create: `plugins/opc/scripts/lib/mcp-schema.mjs`
- Test: `tests/unit/mcp-schema.test.mjs`

**Interfaces:**
- Consumes: nada.
- Produces: `validateInput(schema, value, where = '$') → string[]` (cada erro no formato `<caminho>: <motivo>`), com suporte a `type` (`object|array|string|number|integer|boolean`), `enum`, `pattern` (flag `u`), `minLength`, `maxLength`, `minimum`, `maximum`, `items`, `minItems`, `maxItems`, `required`, `additionalProperties: false`. É o único validador usado pelo MCP (o cliente pode não validar).

- [x] **Step 1: Escrever o teste que falha**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateInput } from '../../plugins/opc/scripts/lib/mcp-schema.mjs';

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^per[A-Za-z0-9_]*$', maxLength: 10 },
    reply: { type: 'string', enum: ['once', 'reject'] },
    n: { type: 'integer', minimum: 1, maximum: 3 },
    tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 1 } },
    flag: { type: 'boolean' },
  },
  required: ['id', 'reply'],
  additionalProperties: false,
};

test('valid input yields no errors', () => {
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_1', reply: 'once', n: 2, tags: ['a'], flag: true }), []);
});

test('each violation is reported with its path', () => {
  const errors = validateInput(SCHEMA, { id: 'bad', reply: 'always', n: 4, tags: [], flag: 'yes', extra: 1 });
  assert.deepEqual(errors, [
    '$.id: does not match ^per[A-Za-z0-9_]*$',
    '$.reply: must be one of once, reject',
    '$.n: above 3',
    '$.tags: fewer than 1 items',
    '$.flag: expected boolean',
    '$.extra: unknown property',
  ]);
});

test('required keys, wrong root type, item validation, integer and length checks', () => {
  assert.deepEqual(validateInput(SCHEMA, {}), ['$.id: is required', '$.reply: is required']);
  assert.deepEqual(validateInput(SCHEMA, []), ['$: expected object']);
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_1', reply: 'once', tags: ['', 'b', 'c'] }), ['$.tags: more than 2 items', '$.tags[0]: shorter than 1']);
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_123456789', reply: 'once', n: 1.5 }), ['$.id: longer than 10', '$.n: expected integer']);
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/mcp-schema.test.mjs`
Expected: FAIL com `Cannot find module '.../scripts/lib/mcp-schema.mjs'`.

- [x] **Step 3: Implementar `plugins/opc/scripts/lib/mcp-schema.mjs`**

```js
// Validates tool arguments against the JSON Schema subset used by the opc MCP tools.
const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
};

export function validateInput(schema, value, where = '$') {
  const errors = [];
  if (schema.type && !TYPE_CHECKS[schema.type](value)) {
    errors.push(`${where}: expected ${schema.type}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${where}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateInput(schema.items, item, `${where}[${i}]`)));
  }
  if (TYPE_CHECKS.object(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${where}.${key}: is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateInput(properties[key], item, `${where}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${where}.${key}: unknown property`);
    }
  }
  return errors;
}
```

- [x] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/mcp-schema.test.mjs`
Expected: PASS (3 testes).

- [x] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/mcp-schema.mjs tests/unit/mcp-schema.test.mjs
git commit -m "feat: add JSON Schema subset validator for MCP tool arguments"
```

---

### Task 4: Catálogo de ferramentas MCP, mapeamento para argv e envelope de resultado

O coração da regra "mesma função": cada ferramenta só traduz argumentos para o `argv` de um subcomando da allowlist e entrega ao `dispatch` injetado. O teste usa um `dispatch` espião para provar, ferramenta por ferramenta, o `argv` exato, o stdio isolado e a propagação de erros.

**Files:**
- Create: `plugins/opc/scripts/lib/mcp-tools.mjs`
- Test: `tests/unit/mcp-tools.test.mjs`

**Interfaces:**
- Consumes: `validateInput` (Task 3); `ExitCode`, `OpcError`, `toExitCode`; `getProcessIdentity(pid)`; `redact`, `redactText`; `loadState`, `resolveDataDir`, `resolveWorkspaceRoot`, `workspaceStateDir`; o tipo do `main` do companion da F0, injetado como `dispatch`: `(argv, { env, cwd, stdin, stdout, stderr, onError }) → Promise<number>`.
- Produces: `TOOLS`, `TOOL_NAMES`, `ALLOWED_COMMANDS`, `commandKey`, `EXIT_STATE`, `SERVER_INSTRUCTIONS`, `MAX_WAIT_SEC`, `DEFAULT_WAIT_SEC`, `DEFAULT_STATUS_WAIT_SEC`, `CALL_TIMEOUT_MS`, `MAX_OUTPUT_CHARS`, `resolveClaudeSessionId`, `createCaptureStream`, `emptyStdin`, `buildEnvelope`, `toolResult`, `createToolCaller` (assinaturas em "Interfaces novas").

Mapa das 25 ferramentas (o teste fixa o argv exato de cada uma):

| Ferramenta | Subcomando | Observações |
|---|---|---|
| `opc_models`, `opc_providers`, `opc_agents`, `opc_catalog` | `models`, `providers`, `agents`, `catalog` | read-only |
| `opc_config_get` | `config get [key]` | única ferramenta de config; `key` com padrão `^[A-Za-z][A-Za-z0-9_.-]*$` |
| `opc_task`, `opc_ask`, `opc_plan` | `task`, `ask`, `plan` | `--background` por padrão; `wait` → `--wait-timeout`; prompt após `--` |
| `opc_subagent`, `opc_orchestrate`, `opc_conclave` | `subagent`, `orchestrate`, `conclave` | idem; listas viram `a,b` |
| `opc_session_list` | `sessions [--all]` | |
| `opc_session_show/new/fork/summarize/children/diff/todo` | `session <ação>` | sem `revert`/`unrevert` |
| `opc_job_status`, `opc_job_result`, `opc_job_cancel` | `status`, `result`, `cancel` | `status --wait --timeout-ms` |
| `opc_permissions_list/reply/answer` | `permissions list/reply/answer` | `reply` ∈ {`once`,`reject`}; `confirmedByUser` → `--confirmed-by-user` |

- [x] **Step 1: Escrever o teste que falha**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateInput } from '../../plugins/opc/scripts/lib/mcp-schema.mjs';
import {
  ALLOWED_COMMANDS,
  buildEnvelope,
  commandKey,
  createCaptureStream,
  createToolCaller,
  emptyStdin,
  MAX_WAIT_SEC,
  resolveClaudeSessionId,
  SERVER_INSTRUCTIONS,
  TOOL_NAMES,
  TOOLS,
} from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { OpcError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const EVIL = '--write\n$(touch pwned) `id` "q" \'s\' ção ✓';

// One row per tool: sample arguments → exact argv given to the CLI dispatcher.
const CASES = [
  ['opc_models', { provider: 'omni', allowed: true, all: true, verbose: true }, ['models', 'omni', '--allowed', '--all', '--verbose', '--json']],
  ['opc_providers', { all: true }, ['providers', '--all', '--json']],
  ['opc_agents', { mode: 'subagent', verbose: true, allowed: true }, ['agents', '--mode', 'subagent', '--verbose', '--allowed', '--json']],
  ['opc_catalog', { kind: 'skills' }, ['catalog', 'skills', '--json']],
  ['opc_config_get', { key: 'policy.approver' }, ['config', 'get', 'policy.approver', '--json']],
  ['opc_config_get', {}, ['config', 'get', '--json']],
  ['opc_task', { prompt: EVIL, model: 'p/m/x', agent: 'build', variant: 'high', tier: 'heavy', write: true, profile: 'custom:npm-test-only', timeoutSec: 60 },
    ['task', '--model', 'p/m/x', '--agent', 'build', '--variant', 'high', '--tier', 'heavy', '--write', '--profile', 'custom:npm-test-only', '--timeout', '60', '--background', '--json', '--', EVIL]],
  ['opc_task', { resume: 'ses_abc', wait: true, waitTimeoutSec: 30 }, ['task', '--resume-id', 'ses_abc', '--wait-timeout', '30', '--json']],
  ['opc_task', { prompt: 'x', resumeLast: true, fresh: true, wait: true }, ['task', '--resume-last', '--fresh', '--wait-timeout', '120', '--json', '--', 'x']],
  ['opc_ask', { prompt: 'why?', model: 'fast', variant: 'low', tier: 'light' }, ['ask', '--model', 'fast', '--variant', 'low', '--tier', 'light', '--background', '--json', '--', 'why?']],
  ['opc_plan', { prompt: 'plan it', resume: 'plan-mabc12-a1b2c3', timeoutSec: 5, wait: true, waitTimeoutSec: 9 }, ['plan', '--resume-id', 'plan-mabc12-a1b2c3', '--timeout', '5', '--wait-timeout', '9', '--json', '--', 'plan it']],
  ['opc_subagent', { prompt: 'p', agents: ['general', 'explore'], models: ['a/b', 'c/d'] }, ['subagent', '--agent', 'general,explore', '--model', 'a/b,c/d', '--background', '--json', '--', 'p']],
  ['opc_orchestrate', { task: 't', planner: 'strong', maxSubtasks: 3, synthesizer: 'claude', write: true }, ['orchestrate', '--planner', 'strong', '--max', '3', '--synthesizer', 'claude', '--write', '--background', '--json', '--', 't']],
  ['opc_conclave', { question: 'q?', models: ['a/b', 'c/d'], mode: 'debate', rounds: 2, judge: 'claude', quorum: 2, allowJudgeMember: true },
    ['conclave', '--models', 'a/b,c/d', '--mode', 'debate', '--rounds', '2', '--judge', 'claude', '--quorum', '2', '--allow-judge-member', '--background', '--json', '--', 'q?']],
  ['opc_conclave', { question: 'q?', pool: 'default', wait: true, waitTimeoutSec: MAX_WAIT_SEC }, ['conclave', '--pool', 'default', '--wait-timeout', String(MAX_WAIT_SEC), '--json', '--', 'q?']],
  ['opc_session_list', { all: true }, ['sessions', '--all', '--json']],
  ['opc_session_show', { sessionId: 'ses_1' }, ['session', 'show', 'ses_1', '--json']],
  ['opc_session_new', { title: 'My title', agent: 'plan', model: 'a/b' }, ['session', 'new', '--title', 'My title', '--agent', 'plan', '--model', 'a/b', '--json']],
  ['opc_session_fork', { sessionId: 'ses_1', messageId: 'msg_2' }, ['session', 'fork', 'ses_1', 'msg_2', '--json']],
  ['opc_session_summarize', { sessionId: 'ses_1', model: 'fast' }, ['session', 'summarize', 'ses_1', '--model', 'fast', '--json']],
  ['opc_session_children', { sessionId: 'ses_1' }, ['session', 'children', 'ses_1', '--json']],
  ['opc_session_diff', { sessionId: 'ses_1' }, ['session', 'diff', 'ses_1', '--json']],
  ['opc_session_todo', { sessionId: 'ses_1' }, ['session', 'todo', 'ses_1', '--json']],
  ['opc_job_status', { jobId: 'task-1', all: true }, ['status', 'task-1', '--all', '--json']],
  ['opc_job_status', { jobId: 'task-1', wait: true, timeoutSec: 10 }, ['status', 'task-1', '--wait', '--timeout-ms', '10000', '--json']],
  ['opc_job_result', { jobId: 'task-1' }, ['result', 'task-1', '--json']],
  ['opc_job_cancel', {}, ['cancel', '--json']],
  ['opc_permissions_list', {}, ['permissions', 'list', '--json']],
  ['opc_permissions_reply', { requestId: 'per_1', reply: 'reject', message: '--no thanks', confirmedByUser: true }, ['permissions', 'reply', 'per_1', 'reject', '--confirmed-by-user', '--json', '--', '--no thanks']],
  ['opc_permissions_reply', { requestId: 'per_1', reply: 'once' }, ['permissions', 'reply', 'per_1', 'once', '--json']],
  ['opc_permissions_answer', { requestId: 'que_1', answers: ['Yes', '--other'] }, ['permissions', 'answer', 'que_1', '--json', '--', 'Yes', '--other']],
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spyDispatch(result = { exitCode: 0, stdout: '{"ok":true}\n' }) {
  const calls = [];
  const dispatch = async (argv, io) => {
    calls.push({ argv, io });
    if (result.stdout) io.stdout.write(result.stdout);
    if (result.stderr) io.stderr.write(result.stderr);
    if (result.throw) {
      io.onError(result.throw);
      io.stderr.write('# opc error\n');
      return result.throw.exitCode;
    }
    return result.exitCode;
  };
  return { dispatch, calls };
}

test('the tool set is exactly the documented list (25 tools)', () => {
  assert.deepEqual(TOOL_NAMES, [
    'opc_models', 'opc_providers', 'opc_agents', 'opc_catalog', 'opc_config_get',
    'opc_task', 'opc_ask', 'opc_plan', 'opc_subagent', 'opc_orchestrate', 'opc_conclave',
    'opc_session_list', 'opc_session_show', 'opc_session_new', 'opc_session_fork', 'opc_session_summarize', 'opc_session_children', 'opc_session_diff', 'opc_session_todo',
    'opc_job_status', 'opc_job_result', 'opc_job_cancel',
    'opc_permissions_list', 'opc_permissions_reply', 'opc_permissions_answer',
  ]);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.inputSchema.properties.cwd, `${tool.name} accepts cwd`);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
  }
});

test('every tool has at least one argv case and every case matches exactly', () => {
  const covered = new Set(CASES.map(([name]) => name));
  assert.deepEqual([...TOOL_NAMES].filter((name) => !covered.has(name)), []);
  for (const [name, args, expected] of CASES) {
    const tool = byName.get(name);
    assert.deepEqual(validateInput(tool.inputSchema, args), [], `${name} sample args are valid`);
    assert.deepEqual(tool.toArgv(args), expected, name);
  }
});

test('no tool reaches a command outside the allowlist (no config writes, revert, stop-server, review, transfer)', () => {
  for (const [name, args] of CASES) {
    const argv = byName.get(name).toArgv(args);
    assert.ok(ALLOWED_COMMANDS.includes(commandKey(argv)), `${name} → ${commandKey(argv)}`);
    if (argv[0] === 'config') assert.equal(argv[1], 'get');
    assert.ok(!argv.slice(0, argv.indexOf('--json')).includes('--tty-confirm'));
  }
  for (const forbidden of ['config set', 'config unset', 'config add', 'config remove', 'config init', 'session revert', 'session unrevert', 'setup', 'review', 'adversarial-review', 'transfer', 'gc', 'command', 'attach', 'monitor']) {
    assert.ok(!ALLOWED_COMMANDS.includes(forbidden), forbidden);
  }
  assert.equal(TOOL_NAMES.filter((name) => /config_(set|unset|add|remove|init)|revert|stop|review|transfer|setup/.test(name)).length, 0);
});

test('schemas reject "always", flag-like identifiers and out-of-range waits', () => {
  const reply = byName.get('opc_permissions_reply');
  assert.ok(validateInput(reply.inputSchema, { requestId: 'per_1', reply: 'always' }).length > 0);
  assert.ok(validateInput(byName.get('opc_config_get').inputSchema, { key: '--tty-confirm' }).length > 0);
  assert.ok(validateInput(byName.get('opc_task').inputSchema, { prompt: 'x', model: '--write' }).length > 0);
  assert.ok(validateInput(byName.get('opc_task').inputSchema, { prompt: 'x', wait: true, waitTimeoutSec: MAX_WAIT_SEC + 1 }).length > 0);
  assert.ok(validateInput(byName.get('opc_session_show').inputSchema, { sessionId: '-x' }).length > 0);
  assert.throws(() => reply.toArgv({ requestId: 'per_1', reply: 'always' }), (e) => e.code === 'INVALID_ARGUMENTS' && e.exitCode === 2);
  assert.throws(() => byName.get('opc_session_new').toArgv({ title: '-oops' }), (e) => e.code === 'INVALID_ARGUMENTS');
});

test('the tool caller validates, maps argv and calls the same dispatcher with an isolated stdio', async (t) => {
  const cwd = tempDir(t);
  const spy = spyDispatch();
  const callTool = createToolCaller({ dispatch: spy.dispatch, env: { A: '1' }, defaultCwd: cwd, ppid: 1, resolveSessionId: () => 'claude-session-1' });
  const res = await callTool(byName.get('opc_models'), { allowed: true });
  assert.equal(res.isError, false);
  assert.deepEqual(JSON.parse(res.content[0].text), { exitCode: 0, state: 'ok', data: { ok: true } });
  assert.equal(spy.calls.length, 1);
  const { argv, io } = spy.calls[0];
  assert.deepEqual(argv, ['models', '--allowed', '--json']);
  assert.equal(io.cwd, cwd);
  assert.equal(io.env.A, '1');
  assert.equal(io.env.OPC_COMPANION_SESSION_ID, 'claude-session-1');
  assert.notEqual(io.stdin, process.stdin);
  assert.notEqual(io.stdout, process.stdout);
  assert.equal(io.stdin.isTTY, false);
  assert.equal(typeof io.onError, 'function');
});

test('invalid arguments and bad cwd never reach the dispatcher', async (t) => {
  const spy = spyDispatch();
  const callTool = createToolCaller({ dispatch: spy.dispatch, env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null });
  const bad = await callTool(byName.get('opc_permissions_reply'), { requestId: 'per_1', reply: 'always' });
  assert.equal(bad.isError, true);
  const envelope = JSON.parse(bad.content[0].text);
  assert.equal(envelope.exitCode, 2);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  const cwdBad = await callTool(byName.get('opc_models'), { cwd: 'relative/dir' });
  assert.equal(JSON.parse(cwdBad.content[0].text).error.code, 'INVALID_CWD');
  assert.equal(spy.calls.length, 0);
});

test('typed errors become isError envelopes with code and exit code; waiting states are not errors', async (t) => {
  const cwd = tempDir(t);
  const denied = createToolCaller({ dispatch: spyDispatch({ throw: new OpcError('POLICY_DENIED', 'model denied: x', { exitCode: 4 }) }).dispatch, env: {}, defaultCwd: cwd, resolveSessionId: () => null });
  const res = await denied(byName.get('opc_task'), { prompt: 'x', model: 'x/y' });
  assert.equal(res.isError, true);
  assert.deepEqual(JSON.parse(res.content[0].text), { exitCode: 4, state: 'policy_denied', error: { code: 'POLICY_DENIED', message: 'model denied: x' } });
  const waiting = createToolCaller({ dispatch: spyDispatch({ exitCode: 3, stdout: '{"status":"waiting_permission"}' }).dispatch, env: {}, defaultCwd: cwd, resolveSessionId: () => null });
  const w = await waiting(byName.get('opc_task'), { prompt: 'x', wait: true });
  assert.equal(w.isError, false);
  assert.equal(JSON.parse(w.content[0].text).state, 'waiting_permission');
  const failed = createToolCaller({ dispatch: spyDispatch({ exitCode: 7, stdout: '', stderr: 'job failed: boom' }).dispatch, env: {}, defaultCwd: cwd, resolveSessionId: () => null });
  const f = await failed(byName.get('opc_job_result'), {});
  assert.equal(f.isError, true);
  assert.deepEqual(JSON.parse(f.content[0].text).error, { code: 'COMMAND_FAILED', message: 'job failed: boom' });
});

test('a hanging dispatch is cut by the call timeout with a connection-like error', async (t) => {
  const callTool = createToolCaller({ dispatch: () => new Promise(() => {}), env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null, callTimeoutMs: 50 });
  const res = await callTool(byName.get('opc_models'), {});
  assert.equal(res.isError, true);
  assert.deepEqual(JSON.parse(res.content[0].text).error.code, 'MCP_CALL_TIMEOUT');
  assert.equal(JSON.parse(res.content[0].text).exitCode, 5);
});

test('buildEnvelope keeps raw text when stdout is not JSON and flags truncation', () => {
  const { envelope, isError } = buildEnvelope({ exitCode: 6, stdout: 'still running: task-1', truncated: true });
  assert.equal(isError, false);
  assert.deepEqual(envelope, { exitCode: 6, state: 'wait_timeout', data: 'still running: task-1', truncated: true });
  assert.equal(buildEnvelope({ exitCode: 42 }).envelope.state, 'error');
  assert.equal(buildEnvelope({ exitCode: 130 }).isError, true);
});

test('buildEnvelope redacts secret keys in the command JSON', () => {
  const { envelope } = buildEnvelope({ exitCode: 0, stdout: JSON.stringify({ provider: { options: { apiKey: 'sk-live-123456789' } } }) });
  assert.equal(envelope.data.provider.options.apiKey, '***');
});

test('createCaptureStream caps output and emptyStdin ends immediately', async () => {
  const stream = createCaptureStream({ maxChars: 5 });
  stream.write('abc');
  stream.write('defgh');
  assert.equal(stream.text(), 'abcde');
  assert.equal(stream.truncated(), true);
  const chunks = [];
  for await (const chunk of emptyStdin()) chunks.push(chunk);
  assert.deepEqual(chunks, []);
});

test('resolveClaudeSessionId prefers the env, then the claudeSessions entry of the parent process', () => {
  assert.equal(resolveClaudeSessionId({ env: { OPC_COMPANION_SESSION_ID: 'env-id' }, cwd: '/w', ppid: 10 }), 'env-id');
  const deps = {
    getProcessIdentity: (pid) => (pid === 10 ? { pid: 10, startTime: 'st-10', cmdline: ['claude'] } : null),
    resolveDataDir: () => '/data',
    resolveWorkspaceRoot: (cwd) => cwd,
    workspaceStateDir: () => '/data/state/w',
    loadState: () => ({
      claudeSessions: [
        { sessionId: 'old', pid: 10, pidStartTime: 'st-10', startedAt: '2026-09-26T10:00:00.000Z' },
        { sessionId: 'new', pid: 10, pidStartTime: 'st-10', startedAt: '2026-09-26T11:00:00.000Z' },
        { sessionId: 'reused-pid', pid: 10, pidStartTime: 'other', startedAt: '2026-09-26T12:00:00.000Z' },
        { sessionId: 'other-proc', pid: 11, pidStartTime: 'st-11', startedAt: '2026-09-26T12:00:00.000Z' },
      ],
    }),
  };
  assert.equal(resolveClaudeSessionId({ env: {}, cwd: '/w', ppid: 10 }, deps), 'new');
  assert.equal(resolveClaudeSessionId({ env: {}, cwd: '/w', ppid: 99 }, deps), null);
  assert.equal(resolveClaudeSessionId({ env: {}, cwd: '/w', ppid: 10 }, { ...deps, loadState: () => { throw new Error('corrupt'); } }), null);
});

test('server instructions state the confirmation rules', () => {
  assert.match(SERVER_INSTRUCTIONS, /confirmedByUser=true/);
  assert.match(SERVER_INSTRUCTIONS, /"always" is never accepted/);
  assert.match(byName.get('opc_permissions_reply').description, /ONLY after the user explicitly approved/);
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/mcp-tools.test.mjs`
Expected: FAIL com `Cannot find module '.../scripts/lib/mcp-tools.mjs'`.

- [x] **Step 3: Implementar `plugins/opc/scripts/lib/mcp-tools.mjs`**

```js
// opc MCP tools: each tool maps its arguments to the argv of an existing `opc` subcommand and runs it
// through the same dispatcher the CLI uses (F0 opc-companion.mjs `main`, injected as `dispatch`). No command logic lives here.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { validateInput } from './mcp-schema.mjs';
import { ExitCode, OpcError, toExitCode } from './opc-error.mjs';
import { getProcessIdentity } from './process.mjs';
import { redact, redactText } from './redact.mjs';
import { loadState, resolveDataDir, resolveWorkspaceRoot, workspaceStateDir } from './state.mjs';

export const MAX_WAIT_SEC = 540;
export const DEFAULT_WAIT_SEC = 120;
export const DEFAULT_STATUS_WAIT_SEC = 60;
export const CALL_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_CHARS = 200_000;
export const EXIT_STATE = Object.freeze({ 0: 'ok', 2: 'usage_error', 3: 'waiting_permission', 4: 'policy_denied', 5: 'connection_error', 6: 'wait_timeout', 7: 'job_failed', 130: 'cancelled' });
const NON_ERROR_EXITS = new Set([ExitCode.OK, ExitCode.WAITING, ExitCode.WAIT_TIMEOUT]);

// Subcommands (and actions) the MCP server may run. Anything else is unreachable from MCP.
export const ALLOWED_COMMANDS = Object.freeze([
  'models', 'providers', 'agents', 'catalog', 'config get',
  'task', 'ask', 'plan', 'subagent', 'orchestrate', 'conclave',
  'sessions', 'session show', 'session new', 'session fork', 'session summarize', 'session children', 'session diff', 'session todo',
  'status', 'result', 'cancel',
  'permissions list', 'permissions reply', 'permissions answer',
]);
const TWO_LEVEL = new Set(['config', 'session', 'permissions']);

export function commandKey(argv) {
  return TWO_LEVEL.has(argv[0]) ? `${argv[0]} ${argv[1]}` : argv[0];
}

export const SERVER_INSTRUCTIONS = [
  'opc runs OpenCode models, agents and sessions for you. The tools follow exactly the rules of the /opc: slash commands.',
  'Long-running tools (opc_task, opc_ask, opc_plan, opc_subagent, opc_orchestrate, opc_conclave) start a background job by default and return its id; follow up with opc_job_status and opc_job_result.',
  'state "waiting_permission" means a job needs an approval: list it with opc_permissions_list and present it to the user with AskUserQuestion before calling opc_permissions_reply, unless the configured approver is "claude" and the request is not destructive, external_directory or a sensitive path.',
  'Never set confirmedByUser=true without an explicit approval from the user in this conversation. "always" is never accepted.',
  'There are no MCP tools to change configuration, revert or unrevert sessions, stop the server, run reviews or transfer sessions: ask the user to run the matching /opc: command.',
].join('\n');

const IDENT_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_.:-]*$';
const MODEL_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_./:@+-]*$';

const CWD = { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute workspace directory. Defaults to the Claude Code project directory.' };
const ident = (description) => ({ type: 'string', pattern: IDENT_PATTERN, maxLength: 200, description });
const modelId = (description) => ({ type: 'string', pattern: MODEL_PATTERN, maxLength: 300, description });
const text = (description, maxLength = 1_000_000) => ({ type: 'string', minLength: 1, maxLength, description });
const bool = (description) => ({ type: 'boolean', description });
const int = (description, minimum, maximum) => ({ type: 'integer', minimum, maximum, description });
const WAIT = bool('Wait for the job to finish (bounded by waitTimeoutSec) instead of returning the job id right away. Default false: background job.');
const WAIT_TIMEOUT = int(`Seconds to wait when wait=true (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}). On timeout the job keeps running and its id is returned.`, 1, MAX_WAIT_SEC);

function object(properties, required = []) {
  return { type: 'object', properties: { ...properties, cwd: CWD }, required, additionalProperties: false };
}

class ArgvBuilder {
  constructor(...head) {
    this.head = head;
    this.positionals = [];
    this.flags = [];
    this.tailValues = [];
  }

  pos(value) {
    if (value !== undefined && value !== null) this.positionals.push(String(value));
    return this;
  }

  str(flag, value) {
    if (value !== undefined && value !== null) {
      assertFlagValue(flag, value);
      this.flags.push(`--${flag}`, String(value));
    }
    return this;
  }

  num(flag, value) {
    if (value !== undefined && value !== null) this.flags.push(`--${flag}`, String(value));
    return this;
  }

  list(flag, values) {
    if (values && values.length > 0) {
      values.forEach((value) => assertFlagValue(flag, value));
      this.flags.push(`--${flag}`, values.join(','));
    }
    return this;
  }

  bool(flag, value) {
    if (value === true) this.flags.push(`--${flag}`);
    return this;
  }

  wait(args) {
    return args.wait === true ? this.num('wait-timeout', args.waitTimeoutSec ?? DEFAULT_WAIT_SEC) : this.bool('background', true);
  }

  tail(values) {
    this.tailValues = values.filter((value) => value !== undefined && value !== null).map(String);
    return this;
  }

  build() {
    const argv = [...this.head, ...this.positionals, ...this.flags, '--json'];
    if (this.tailValues.length > 0) argv.push('--', ...this.tailValues);
    return argv;
  }
}

function assertFlagValue(flag, value) {
  if (String(value).startsWith('-')) {
    throw new OpcError('INVALID_ARGUMENTS', `Value for --${flag} must not start with "-"`, { exitCode: ExitCode.USAGE });
  }
}

const waitTimeout = (args) => (args.wait === true ? ((args.waitTimeoutSec ?? DEFAULT_WAIT_SEC) + 300) * 1000 : undefined);
const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const STATEFUL = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const MAY_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

const MODEL_FLAGS = {
  model: modelId('Model: alias, full id provider/model, or short name in the default provider. Same resolution and policy as --model.'),
  variant: ident('Model variant (validated against the model variants).'),
  tier: ident('Routing tier name from the opc config (e.g. light, heavy).'),
  resume: ident('Resume this OpenCode session id or opc job id.'),
  resumeLast: bool('Resume the last finished job of the same kind in this Claude session.'),
  fresh: bool('Force a new session.'),
  timeoutSec: int('Turn timeout in seconds (the job is aborted after it).', 1, 86_400),
  wait: WAIT,
  waitTimeoutSec: WAIT_TIMEOUT,
};

function readOnlyTurnTool(name, title, sub, what) {
  return {
    name,
    title,
    description: `${what} Read-only permission profile. Starts a background job by default and returns its id. Same flags and rules as /opc:${sub}.`,
    annotations: STATEFUL,
    inputSchema: object({ prompt: text('Prompt text, passed verbatim to OpenCode.'), ...MODEL_FLAGS }),
    timeoutMs: waitTimeout,
    // resume → --resume-id (F2a TURN_FLAGS): the bare --resume form would silently become --resume-last for an unknown ref.
    toArgv: (a) => new ArgvBuilder(sub).str('model', a.model).str('variant', a.variant).str('tier', a.tier).str('resume-id', a.resume)
      .bool('resume-last', a.resumeLast).bool('fresh', a.fresh).num('timeout', a.timeoutSec).wait(a).tail([a.prompt]).build(),
  };
}

function sessionTool(name, title, action, description) {
  return {
    name,
    title,
    description,
    annotations: READ_ONLY,
    inputSchema: object({ sessionId: ident('OpenCode session id (ses_…).') }, ['sessionId']),
    toArgv: (a) => new ArgvBuilder('session', action).pos(a.sessionId).build(),
  };
}

export const TOOLS = Object.freeze([
  {
    name: 'opc_models',
    title: 'List OpenCode models',
    description: 'List models of connected providers with variants, limits and cost, with the opc policy applied. Same as /opc:models.',
    annotations: READ_ONLY,
    inputSchema: object({
      provider: ident('Only this provider id.'),
      allowed: bool('Hide models denied by the policy.'),
      all: bool('Include providers that are not connected.'),
      verbose: bool('Include details.'),
    }),
    toArgv: (a) => new ArgvBuilder('models').pos(a.provider).bool('allowed', a.allowed).bool('all', a.all).bool('verbose', a.verbose).build(),
  },
  {
    name: 'opc_providers',
    title: 'List OpenCode providers',
    description: 'List connected providers (all=true for the whole catalog) with the policy applied. Same as /opc:providers.',
    annotations: READ_ONLY,
    inputSchema: object({ all: bool('Include the whole provider catalog.') }),
    toArgv: (a) => new ArgvBuilder('providers').bool('all', a.all).build(),
  },
  {
    name: 'opc_agents',
    title: 'List OpenCode agents',
    description: 'List OpenCode agents. Same as /opc:agents.',
    annotations: READ_ONLY,
    inputSchema: object({
      mode: { type: 'string', enum: ['primary', 'subagent', 'all'], description: 'Agent mode filter.' },
      verbose: bool('Include details.'),
      allowed: bool('Hide agents denied by the policy.'),
    }),
    toArgv: (a) => new ArgvBuilder('agents').str('mode', a.mode).bool('verbose', a.verbose).bool('allowed', a.allowed).build(),
  },
  {
    name: 'opc_catalog',
    title: 'List OpenCode commands or skills',
    description: 'List OpenCode slash commands or skills. Same as /opc:catalog.',
    annotations: READ_ONLY,
    inputSchema: object({ kind: { type: 'string', enum: ['commands', 'skills'], description: 'What to list.' } }, ['kind']),
    toArgv: (a) => new ArgvBuilder('catalog').pos(a.kind).build(),
  },
  {
    name: 'opc_config_get',
    title: 'Read opc configuration',
    description: 'Read the effective opc configuration or one key (read-only). There is no MCP tool to change configuration: the user runs /opc:config or /opc:setup.',
    annotations: READ_ONLY,
    inputSchema: object({ key: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]*$', maxLength: 200, description: 'Dotted key, e.g. policy.approver.' } }),
    toArgv: (a) => new ArgvBuilder('config', 'get').pos(a.key).build(),
  },
  {
    name: 'opc_task',
    title: 'Run an OpenCode task',
    description: 'Delegate a task to OpenCode. Read-only unless write=true (write profile: destructive shell commands still ask the user). Starts a background job by default and returns its id. Same flags and rules as /opc:task.',
    annotations: MAY_WRITE,
    inputSchema: object({
      prompt: text('Task prompt, passed verbatim to OpenCode. Optional only when resuming.'),
      ...MODEL_FLAGS,
      agent: ident('OpenCode agent.'),
      write: bool('Allow edits (write permission profile).'),
      profile: ident('Permission profile: read-only, write or custom:<name>.'),
    }),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('task').str('model', a.model).str('agent', a.agent).str('variant', a.variant).str('tier', a.tier)
      .bool('write', a.write).str('profile', a.profile).str('resume-id', a.resume).bool('resume-last', a.resumeLast).bool('fresh', a.fresh)
      .num('timeout', a.timeoutSec).wait(a).tail([a.prompt]).build(),
  },
  readOnlyTurnTool('opc_ask', 'Ask OpenCode', 'ask', 'Ask OpenCode a question or analysis about the code (concise answer with file:line).'),
  readOnlyTurnTool('opc_plan', 'Plan with OpenCode', 'plan', 'Ask OpenCode for an implementation plan (files, order, trade-offs, risks, tests).'),
  {
    name: 'opc_subagent',
    title: 'Run OpenCode subagents in parallel',
    description: 'Run the same prompt on N OpenCode agents (and optional models) in parallel as one job group. Background by default. Same as /opc:subagent.',
    annotations: STATEFUL,
    inputSchema: object({
      prompt: text('Prompt text, passed verbatim.'),
      agents: { type: 'array', minItems: 1, maxItems: 8, items: ident('Agent name.'), description: 'Agents, one job per agent.' },
      models: { type: 'array', minItems: 1, maxItems: 8, items: modelId('Model.'), description: 'Optional models, matched by position with agents.' },
      wait: WAIT,
      waitTimeoutSec: WAIT_TIMEOUT,
    }, ['prompt', 'agents']),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('subagent').list('agent', a.agents).list('model', a.models).wait(a).tail([a.prompt]).build(),
  },
  {
    name: 'opc_orchestrate',
    title: 'Orchestrate a task with OpenCode',
    description: 'Decompose a task into parallel subtasks run by OpenCode models and synthesize the result. Write subtasks only with write=true. Background by default. Same as /opc:orchestrate.',
    annotations: MAY_WRITE,
    inputSchema: object({
      task: text('Task description, passed verbatim.'),
      planner: modelId('Planner model.'),
      maxSubtasks: int('Maximum subtasks (--max).', 2, 20),
      synthesizer: modelId('"claude" or a model.'),
      write: bool('Allow write subtasks (run one at a time).'),
      wait: WAIT,
      waitTimeoutSec: WAIT_TIMEOUT,
    }, ['task']),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('orchestrate').str('planner', a.planner).num('max', a.maxSubtasks).str('synthesizer', a.synthesizer)
      .bool('write', a.write).wait(a).tail([a.task]).build(),
  },
  {
    name: 'opc_conclave',
    title: 'Run a conclave of models',
    description: 'Ask several models the same question in parallel (opinion, debate or review) and get a structured synthesis. Background by default. Same as /opc:conclave.',
    annotations: STATEFUL,
    inputSchema: object({
      question: text('Question, passed verbatim.'),
      models: { type: 'array', minItems: 2, maxItems: 8, items: modelId('Model.'), description: 'Members (use this or pool).' },
      pool: ident('Configured pool name.'),
      mode: { type: 'string', enum: ['opinion', 'review', 'debate'], description: 'Conclave mode.' },
      rounds: int('Rounds (debate implies >= 2).', 1, 3),
      judge: modelId('"claude" or a model.'),
      quorum: int('Minimum valid answers.', 2, 8),
      allowJudgeMember: bool('Allow the judge to also be a member.'),
      wait: WAIT,
      waitTimeoutSec: WAIT_TIMEOUT,
    }, ['question']),
    timeoutMs: waitTimeout,
    toArgv: (a) => new ArgvBuilder('conclave').list('models', a.models).str('pool', a.pool).str('mode', a.mode).num('rounds', a.rounds)
      .str('judge', a.judge).num('quorum', a.quorum).bool('allow-judge-member', a.allowJudgeMember).wait(a).tail([a.question]).build(),
  },
  {
    name: 'opc_session_list',
    title: 'List OpenCode sessions',
    description: 'List the OPC: sessions of this workspace (all=true for every session). Same as /opc:sessions.',
    annotations: READ_ONLY,
    inputSchema: object({ all: bool('List every session, not only OPC: ones.') }),
    toArgv: (a) => new ArgvBuilder('sessions').bool('all', a.all).build(),
  },
  sessionTool('opc_session_show', 'Show an OpenCode session', 'show', 'Show a session with its recent messages. Same as /opc:session show.'),
  {
    name: 'opc_session_new',
    title: 'Create an OpenCode session',
    description: 'Create a new OPC: session. Same as /opc:session new.',
    annotations: STATEFUL,
    inputSchema: object({ title: text('Session title (must not start with "-").', 200), agent: ident('Agent.'), model: modelId('Model.') }),
    toArgv: (a) => new ArgvBuilder('session', 'new').str('title', a.title).str('agent', a.agent).str('model', a.model).build(),
  },
  {
    name: 'opc_session_fork',
    title: 'Fork an OpenCode session',
    description: 'Fork a session, optionally at a message. Same as /opc:session fork.',
    annotations: STATEFUL,
    inputSchema: object({ sessionId: ident('Session id.'), messageId: ident('Fork at this message id.') }, ['sessionId']),
    toArgv: (a) => new ArgvBuilder('session', 'fork').pos(a.sessionId).pos(a.messageId).build(),
  },
  {
    name: 'opc_session_summarize',
    title: 'Summarize an OpenCode session',
    description: 'Compact/summarize a session with a model (policy applies). Same as /opc:session summarize.',
    annotations: STATEFUL,
    inputSchema: object({ sessionId: ident('Session id.'), model: modelId('Summarize model.') }, ['sessionId']),
    toArgv: (a) => new ArgvBuilder('session', 'summarize').pos(a.sessionId).str('model', a.model).build(),
  },
  sessionTool('opc_session_children', 'List child sessions', 'children', 'List child sessions (subagents) of a session. Same as /opc:session children.'),
  sessionTool('opc_session_diff', 'Show session diff', 'diff', 'Show the file diff produced by a session. Same as /opc:session diff.'),
  sessionTool('opc_session_todo', 'Show session todo', 'todo', 'Show the todo list of a session. Same as /opc:session todo.'),
  {
    name: 'opc_job_status',
    title: 'opc job status',
    description: 'Status of one job or the recent jobs of this Claude session. wait=true (requires jobId) waits up to timeoutSec. Same as /opc:status.',
    annotations: READ_ONLY,
    inputSchema: object({
      jobId: ident('Job id or unique prefix.'),
      all: bool('Jobs of every Claude session.'),
      wait: bool('Wait for the job to finish or need a permission.'),
      timeoutSec: int(`Wait timeout in seconds (default ${DEFAULT_STATUS_WAIT_SEC}).`, 1, MAX_WAIT_SEC),
    }),
    timeoutMs: (a) => (a.wait === true ? ((a.timeoutSec ?? DEFAULT_STATUS_WAIT_SEC) + 60) * 1000 : undefined),
    toArgv: (a) => {
      const builder = new ArgvBuilder('status').pos(a.jobId).bool('all', a.all);
      if (a.wait === true) builder.bool('wait', true).num('timeout-ms', (a.timeoutSec ?? DEFAULT_STATUS_WAIT_SEC) * 1000);
      return builder.build();
    },
  },
  {
    name: 'opc_job_result',
    title: 'opc job result',
    description: 'Final result of a finished job (error while it is still running). For a job group (subagent, orchestrate, conclave) the data is { group, members }, with the group package in group.result. Same as /opc:result.',
    annotations: READ_ONLY,
    inputSchema: object({ jobId: ident('Job id or unique prefix.') }),
    toArgv: (a) => new ArgvBuilder('result').pos(a.jobId).build(),
  },
  {
    name: 'opc_job_cancel',
    title: 'Cancel an opc job',
    description: 'Cancel a job (without jobId: the only active job of this Claude session). Same as /opc:cancel.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: object({ jobId: ident('Job id or unique prefix.') }),
    toArgv: (a) => new ArgvBuilder('cancel').pos(a.jobId).build(),
  },
  {
    name: 'opc_permissions_list',
    title: 'List pending OpenCode permission requests',
    description: 'List pending permission requests and questions of opc jobs. Same as /opc:permissions list.',
    annotations: READ_ONLY,
    inputSchema: object({}),
    toArgv: () => new ArgvBuilder('permissions', 'list').build(),
  },
  {
    name: 'opc_permissions_reply',
    title: 'Reply to an OpenCode permission request',
    description: [
      'Reply "once" or "reject" to a pending permission request ("always" does not exist). Same rules as /opc:permissions reply:',
      'with approver "user" (default) present the request to the user with AskUserQuestion before replying;',
      'destructive commands, external_directory and sensitive paths always require the user, whatever the approver.',
      'Set confirmedByUser=true ONLY after the user explicitly approved this exact request in this conversation; never on your own judgment.',
      'opc-worker and opc-rescue agents must never call this tool.',
    ].join(' '),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: object({
      requestId: { type: 'string', pattern: '^per[A-Za-z0-9_]*$', maxLength: 200, description: 'Permission request id (per_…).' },
      reply: { type: 'string', enum: ['once', 'reject'], description: 'once or reject.' },
      message: text('Optional message sent with a reject.', 2000),
      confirmedByUser: bool('True only after the user explicitly approved this request (AskUserQuestion).'),
    }, ['requestId', 'reply']),
    toArgv: (a) => {
      if (a.reply !== 'once' && a.reply !== 'reject') {
        throw new OpcError('INVALID_ARGUMENTS', 'reply must be "once" or "reject"', { exitCode: ExitCode.USAGE });
      }
      return new ArgvBuilder('permissions', 'reply').pos(a.requestId).pos(a.reply).bool('confirmed-by-user', a.confirmedByUser).tail([a.message]).build();
    },
  },
  {
    name: 'opc_permissions_answer',
    title: 'Answer an OpenCode question',
    description: 'Answer a pending OpenCode question request, one entry per question in order (same encoding as /opc:permissions answer). Ask the user when the answer is theirs to give.',
    annotations: STATEFUL,
    inputSchema: object({
      requestId: { type: 'string', pattern: '^que[A-Za-z0-9_]*$', maxLength: 200, description: 'Question request id (que_…).' },
      answers: { type: 'array', minItems: 1, maxItems: 20, items: text('Answer label or free text.', 2000), description: 'Answers in question order.' },
    }, ['requestId', 'answers']),
    toArgv: (a) => new ArgvBuilder('permissions', 'answer').pos(a.requestId).tail(a.answers).build(),
  },
]);

export const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

export function resolveClaudeSessionId({ env, cwd, ppid }, deps = {}) {
  if (env.OPC_COMPANION_SESSION_ID) return env.OPC_COMPANION_SESSION_ID;
  const d = { resolveDataDir, resolveWorkspaceRoot, workspaceStateDir, loadState, getProcessIdentity, ...deps };
  try {
    const identity = d.getProcessIdentity(ppid);
    if (!identity) return null;
    const stateDir = d.workspaceStateDir(d.resolveDataDir(env), d.resolveWorkspaceRoot(cwd));
    const matches = d.loadState(stateDir).claudeSessions.filter((s) => s.pid === ppid && s.pidStartTime === identity.startTime);
    matches.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return matches[0]?.sessionId ?? null;
  } catch {
    return null;
  }
}

export function createCaptureStream({ maxChars = MAX_OUTPUT_CHARS } = {}) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const piece = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (size + piece.length > maxChars) truncated = true;
      if (size < maxChars) chunks.push(piece.slice(0, maxChars - size));
      size += piece.length;
      callback();
    },
  });
  stream.isTTY = false;
  stream.text = () => chunks.join('');
  stream.truncated = () => truncated;
  return stream;
}

export function emptyStdin() {
  const stream = Readable.from([]);
  stream.isTTY = false;
  return stream;
}

export function buildEnvelope({ exitCode, stdout = '', stderr = '', error = null, truncated = false }) {
  const envelope = { exitCode, state: EXIT_STATE[exitCode] ?? 'error' };
  const out = String(stdout).trim();
  if (out) {
    try {
      envelope.data = redact(JSON.parse(out));
    } catch {
      envelope.data = redactText(out);
    }
  }
  if (truncated) envelope.truncated = true;
  const isError = !NON_ERROR_EXITS.has(exitCode);
  if (error) {
    envelope.error = { code: error.code ?? 'INTERNAL', message: redactText(String(error.message ?? error)) };
  } else if (isError) {
    const tail = redactText(String(stderr).trim()).slice(-2000);
    if (tail) envelope.error = { code: 'COMMAND_FAILED', message: tail };
  }
  return { envelope, isError };
}

export function toolResult({ envelope, isError }) {
  return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], isError };
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new OpcError('MCP_CALL_TIMEOUT', `Tool call exceeded ${Math.round(ms / 1000)} s; the command may still be running`, { exitCode: ExitCode.CONNECTION }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createToolCaller({ dispatch, env = process.env, defaultCwd = env.CLAUDE_PROJECT_DIR || process.cwd(), ppid = process.ppid, resolveSessionId = resolveClaudeSessionId, callTimeoutMs = CALL_TIMEOUT_MS, log = () => {} }) {
  return async function callTool(tool, args) {
    const input = args ?? {};
    const errors = validateInput(tool.inputSchema, input);
    if (errors.length > 0) {
      return toolResult(buildEnvelope({ exitCode: ExitCode.USAGE, error: { code: 'INVALID_ARGUMENTS', message: errors.join('; ') } }));
    }
    let argv;
    try {
      argv = tool.toArgv(input);
    } catch (err) {
      return toolResult(buildEnvelope({ exitCode: toExitCode(err), error: err }));
    }
    const cwd = input.cwd ?? defaultCwd;
    if (!path.isAbsolute(cwd) || !isDirectory(cwd)) {
      return toolResult(buildEnvelope({ exitCode: ExitCode.USAGE, error: { code: 'INVALID_CWD', message: `cwd must be an existing absolute directory: ${cwd}` } }));
    }
    const callEnv = { ...env };
    const sessionId = resolveSessionId({ env: callEnv, cwd, ppid });
    if (sessionId) callEnv.OPC_COMPANION_SESSION_ID = sessionId;
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    let captured = null;
    let exitCode;
    try {
      exitCode = await withTimeout(
        Promise.resolve(dispatch(argv, { env: callEnv, cwd, stdin: emptyStdin(), stdout, stderr, onError: (err) => { captured = err; } })),
        tool.timeoutMs?.(input) ?? callTimeoutMs,
      );
    } catch (err) {
      captured = err;
      exitCode = toExitCode(err);
    }
    await new Promise((resolve) => setImmediate(resolve));
    log(`[opc] mcp ${tool.name} → exit ${exitCode}`);
    return toolResult(buildEnvelope({ exitCode, stdout: stdout.text(), stderr: stderr.text(), error: captured, truncated: stdout.truncated() }));
  };
}
```

- [x] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/mcp-tools.test.mjs`
Expected: PASS (13 testes).

- [x] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/mcp-tools.mjs tests/unit/mcp-tools.test.mjs
git commit -m "feat: add opc MCP tool catalog mapped onto the CLI dispatcher"
```

---

### Task 5: Entry point `mcp-server.mjs`, declaração no plugin e handshake de ponta a ponta

**Files:**
- Create: `plugins/opc/scripts/mcp-server.mjs`
- Modify: `plugins/opc/.claude-plugin/plugin.json` (chave `mcpServers`)
- Test: `tests/integration/mcp-server.test.mjs`

**Interfaces:**
- Consumes: `createMcpServer`, `serveStdio` (Task 2); `TOOLS`, `createToolCaller`, `SERVER_INSTRUCTIONS` (Task 4); `main` do companion (F0, importado como `dispatch`); helpers `startMcpClient`, `cliJson`, `MCP_SERVER`, `PLUGIN_ROOT`, `testEnv`, `makeWorkspace`, `stopAllServers`.
- Produces: processo MCP stdio `node ${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`; `serverInfo = { name: 'opc', title, version: <plugin.json version> }`; sai com 0 quando o stdin fecha.

- [x] **Step 1: Escrever o teste que falha**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { cliJson, makeWorkspace, MCP_SERVER, PLUGIN_ROOT, registerStopper, startMcpClient, testEnv } from '../helpers.mjs';

function setup(t, scenario = 'ok') {
  const env = testEnv(t, { scenario });
  const ws = makeWorkspace(t);
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  return { env, ws, mcpEnv };
}

function client(t, { mcpEnv, ws }, options = {}) {
  const c = startMcpClient({ env: mcpEnv, cwd: ws, ...options });
  registerStopper(t, () => c.close()); // MCP server closed before the F0 cleanup stops servers and removes dirs
  return c;
}

test('plugin.json declares the stdio MCP server through CLAUDE_PLUGIN_ROOT', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.mcpServers, { opc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs'] } });
  assert.equal(manifest.mcpServers.opc.args[0].replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT), MCP_SERVER);
});

test('handshake: refusal before initialize, negotiation, capabilities, instructions and ping', async (t) => {
  const c = client(t, setup(t));
  const early = await c.request('tools/list');
  assert.equal(early.error.code, -32600);
  const init = await c.initialize('2025-06-18');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'opc');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.match(init.result.instructions, /confirmedByUser/);
  assert.deepEqual((await c.request('ping')).result, {});
});

test('initialize negotiates older and unknown protocol versions', async (t) => {
  const ctx = setup(t);
  for (const [asked, expected] of [['2024-11-05', '2024-11-05'], ['2025-03-26', '2025-03-26'], ['2099-01-01', '2025-06-18']]) {
    const c = startMcpClient({ env: ctx.mcpEnv, cwd: ctx.ws });
    const init = await c.initialize(asked);
    assert.equal(init.result.protocolVersion, expected, asked);
    assert.equal(await c.close(), 0);
  }
});

test('tools/list returns the 25 opc tools with object JSON Schemas', async (t) => {
  const c = client(t, setup(t));
  await c.initialize();
  const res = await c.request('tools/list');
  assert.deepEqual(res.result.tools.map((tool) => tool.name), [...TOOL_NAMES]);
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  assert.equal(res.result.nextCursor, undefined);
});

test('protocol errors: parse error with id null, unknown method, unknown tool, silent notifications', async (t) => {
  const c = client(t, setup(t));
  await c.initialize();
  c.sendRaw('{this is not json\n');
  const parse = await c.waitFor((m) => m.id === null && m.error?.code === -32700);
  assert.ok(parse);
  assert.equal((await c.request('resources/list')).error.code, -32601);
  const unknown = await c.request('tools/call', { name: 'opc_config_set', arguments: { key: 'policy.approver', value: 'claude' } });
  assert.equal(unknown.error.code, -32602);
  c.notify('notifications/cancelled', { requestId: 999, reason: 'test' });
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal(c.messages.filter((m) => !('id' in m)).length, 0, 'the server never sends notifications');
});

test('read-only tools return exactly what the CLI returns (same dispatcher, same rules)', async (t) => {
  const ctx = setup(t);
  const c = client(t, ctx);
  await c.initialize();
  const pairs = [
    ['opc_models', {}, ['models']],
    ['opc_models', { allowed: true }, ['models', '--allowed']],
    ['opc_providers', {}, ['providers']],
    ['opc_agents', { mode: 'all' }, ['agents', '--mode', 'all']],
    ['opc_catalog', { kind: 'commands' }, ['catalog', 'commands']],
    ['opc_config_get', {}, ['config', 'get']],
    ['opc_config_get', { key: 'policy.approver' }, ['config', 'get', 'policy.approver']],
  ];
  for (const [name, args, cliArgs] of pairs) {
    const mcp = await c.callTool(name, args);
    const cli = await cliJson(cliArgs, { env: ctx.env, cwd: ctx.ws });
    assert.equal(mcp.envelope.exitCode, cli.code, `${name} exit code`);
    assert.equal(mcp.isError, cli.code !== 0, `${name} isError`);
    assert.deepEqual(mcp.envelope.data, cli.data, `${name} output`);
  }
});

test('stdout carries only JSON-RPC frames even when a library prints to stdout', async (t) => {
  const ctx = setup(t);
  const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-noise-'));
  t.after(() => fs.rmSync(preloadDir, { recursive: true, force: true }));
  const preload = path.join(preloadDir, 'noise.mjs');
  fs.writeFileSync(preload, "setTimeout(() => { console.log('NOISE-FROM-LIB'); process.stdout.write('RAW-NOISE\\n'); }, 1000);\n");
  const c = startMcpClient({ env: ctx.mcpEnv, cwd: ctx.ws, nodeArgs: ['--import', pathToFileURL(preload).href] });
  await c.initialize();
  await c.callTool('opc_models', {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal(await c.close(), 0);
  for (const line of c.rawLines) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
  assert.match(c.stderr, /NOISE-FROM-LIB/);
  assert.match(c.stderr, /RAW-NOISE/);
});

test('the server exits 0 when its stdin closes', async (t) => {
  const ctx = setup(t);
  const c = startMcpClient({ env: ctx.mcpEnv, cwd: ctx.ws });
  await c.initialize();
  assert.equal(await c.close(), 0);
});
```

- [x] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/mcp-server.test.mjs`
Expected: FAIL — `plugin.json` sem `mcpServers` e o processo MCP inexistente (`Cannot find module .../mcp-server.mjs` no stderr; requisições com timeout).

- [x] **Step 3: Implementar `plugins/opc/scripts/mcp-server.mjs`**

```js
#!/usr/bin/env node
// opc MCP server (stdio). Protocol frames go to the real stdout; everything else written to
// process.stdout by any module is redirected to stderr so it can never corrupt the channel.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`[opc] mcp: Node >= 20 required (found ${process.versions.node})\n`);
  process.exit(1);
}

// Dynamic imports on purpose: static imports would run before the stdout redirection above.
const { createMcpServer, serveStdio } = await import('./lib/mcp-protocol.mjs');
const { createToolCaller, SERVER_INSTRUCTIONS, TOOLS } = await import('./lib/mcp-tools.mjs');
// The F0 entry point `main(argv, io)` is the dispatcher (importing it has no side effect: it only runs under invokedDirectly()).
const { main: dispatch } = await import('./opc-companion.mjs');

function pluginVersion() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const log = (line) => process.stderr.write(`${line}\n`);
const server = createMcpServer({
  serverInfo: { name: 'opc', title: 'opc — OpenCode for Claude Code', version: pluginVersion() },
  instructions: SERVER_INSTRUCTIONS,
  tools: TOOLS,
  callTool: createToolCaller({ dispatch, env: process.env, log }),
  log,
});

await serveStdio({ server, input: process.stdin, write: protocolWrite, log });
process.exit(0);
```

Tornar executável (coerente com `bin/opc`): `chmod 755 plugins/opc/scripts/mcp-server.mjs`.

- [x] **Step 4: Declarar o servidor no `plugin.json`**

Acrescentar a chave preservando o restante do manifesto:

```bash
node -e 'const fs=require("fs");const f="plugins/opc/.claude-plugin/plugin.json";const m=JSON.parse(fs.readFileSync(f,"utf8"));m.mcpServers={opc:{command:"node",args:["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]}};fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n")'
```

Resultado esperado no arquivo (demais chaves inalteradas):

```json
  "mcpServers": {
    "opc": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]
    }
  }
```

- [x] **Step 5: Rodar e ver passar**

Run: `node --test tests/integration/mcp-server.test.mjs`
Expected: PASS (8 testes). Em especial, os pares CLI × MCP têm `exitCode` e `data` idênticos.

- [x] **Step 6: Commit**

```bash
git add plugins/opc/scripts/mcp-server.mjs plugins/opc/.claude-plugin/plugin.json tests/integration/mcp-server.test.mjs
git commit -m "feat: add opc MCP stdio server and declare it in the plugin manifest"
```

---

### Task 6: Ferramentas de execução, jobs e sessões pelo MCP (integração)

Os comportamentos já vêm das Tasks 1–5 e dos comandos de F2a–F4c; esta tarefa prova, contra o fake, que eles valem pelo MCP. Se algum teste falhar, o defeito está no código (mapeamento, envelope ou comando), **não** no teste: corrigir `mcp-tools.mjs` ou o comando e registrar no relatório.

**Files:**
- Test: `tests/integration/mcp-jobs.test.mjs`
- Modify (só se um teste revelar defeito): `plugins/opc/scripts/lib/mcp-tools.mjs`

**Interfaces:**
- Consumes: `readJob(stateDir, id)` (`jobs`); `EXIT_STATE` (Task 4); `getProcessIdentity`; `ensurePrivateDir`, `resolveWorkspaceRoot`, `updateState`, `workspaceStateDir`; helpers `startMcpClient`, `cliJson`, `findJobId`, `readFakeState`, `writeTestConfig`, `testEnv`, `makeWorkspace`, `stopAllServers`; cenários `ok` e `slow` (F2a).
- Produces: evidência dos itens de aceite "cada ferramenta chama a mesma função" (execução, jobs, sessões) e dos itens 1 e 3 do Review Focus.

- [x] **Step 1: Escrever o teste**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { EXIT_STATE } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { ensurePrivateDir, resolveWorkspaceRoot, updateState, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { cliJson, findJobId, makeWorkspace, readFakeState, registerStopper, startMcpClient, testEnv, writeTestConfig } from '../helpers.mjs';

const EVIL = '--write\n$(touch pwned) `touch pwned2` "double" \'single\' ção ✓';
const JOB_RE = (kind) => new RegExp(`${kind}-[0-9a-z]+-[0-9a-z]{6}`); // F2a newJobId shape

function setup(t, scenario = 'ok', extraEnv = {}) {
  const env = testEnv(t, { scenario });
  const ws = makeWorkspace(t);
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws, ...extraEnv };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  const c = startMcpClient({ env: mcpEnv, cwd: ws });
  registerStopper(t, () => c.close()); // MCP server closed before the F0 cleanup stops servers and removes dirs
  return { env, ws, mcpEnv, c };
}

function jobIdIn(envelope, kind) {
  return findJobId(envelope.data, kind) ?? JSON.stringify(envelope).match(JOB_RE(kind))?.[0] ?? null;
}

test('opc_task defaults to a read-only background job and the prompt reaches OpenCode verbatim', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const started = await c.callTool('opc_task', { prompt: EVIL });
  assert.equal(started.isError, false, JSON.stringify(started.envelope));
  assert.equal(started.envelope.exitCode, 0);
  const jobId = jobIdIn(started.envelope, 'task');
  assert.ok(jobId, JSON.stringify(started.envelope));
  const done = await c.callTool('opc_job_status', { jobId, wait: true, timeoutSec: 60 });
  assert.equal(done.envelope.exitCode, 0, JSON.stringify(done.envelope));
  const state = readFakeState(env);
  const prompt = state.requests.find((r) => r.method === 'POST' && /\/session\/[^/]+\/prompt_async$/.test(r.path));
  assert.ok(prompt.body.parts.some((part) => typeof part.text === 'string' && part.text.includes(EVIL)), 'prompt text intact');
  const created = state.requests.find((r) => r.method === 'POST' && r.path === '/session');
  assert.deepEqual(created.body.permission[0], { permission: '*', pattern: '*', action: 'deny' }, 'read-only profile');
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(ws, 'pwned2')), false);
});

test('opc_job_result returns exactly the CLI result for the same job', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const jobId = jobIdIn((await c.callTool('opc_ask', { prompt: 'say ok' })).envelope, 'ask');
  await c.callTool('opc_job_status', { jobId, wait: true, timeoutSec: 60 });
  const mcp = await c.callTool('opc_job_result', { jobId });
  const cli = await cliJson(['result', jobId], { env, cwd: ws });
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.deepEqual(mcp.envelope.data, cli.data);
  const statusMcp = await c.callTool('opc_job_status', { jobId });
  const statusCli = await cliJson(['status', jobId], { env, cwd: ws });
  assert.equal(statusMcp.envelope.exitCode, statusCli.code);
});

test('wait=true is bounded: a slow job returns wait_timeout, keeps running, and other requests are served meanwhile', async (t) => {
  const { env, ws, c } = setup(t, 'slow');
  await c.initialize();
  let settled = false;
  const waiting = c.callTool('opc_task', { prompt: 'slow work', wait: true, waitTimeoutSec: 2 }).finally(() => { settled = true; });
  const ping = await c.request('ping');
  assert.deepEqual(ping.result, {});
  assert.equal(settled, false, 'ping answered while the tool call is still waiting');
  const waited = await waiting;
  assert.equal(waited.envelope.exitCode, 6, JSON.stringify(waited.envelope));
  assert.equal(waited.envelope.state, 'wait_timeout');
  assert.equal(waited.isError, false);
  const jobId = jobIdIn(waited.envelope, 'task');
  assert.ok(jobId, JSON.stringify(waited.envelope));
  const cancelled = await c.callTool('opc_job_cancel', { jobId });
  assert.equal(cancelled.envelope.exitCode, 0, JSON.stringify(cancelled.envelope));
  const status = await cliJson(['status', jobId], { env, cwd: ws });
  assert.match(JSON.stringify(status.data), /cancelled/);
});

test('policy denials are identical through MCP and the CLI', async (t) => {
  const { env, ws, c } = setup(t);
  writeTestConfig(env, { policy: { models: { allow: [], deny: ['*'] }, providers: { allow: [], deny: ['*'] } } });
  await c.initialize();
  const mcp = await c.callTool('opc_task', { prompt: 'x', model: 'example-provider/example/model-a' });
  const cli = await cliJson(['task', '--model', 'example-provider/example/model-a', '--background', '--', 'x'], { env, cwd: ws });
  assert.notEqual(cli.code, 0);
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.equal(mcp.envelope.state, EXIT_STATE[cli.code]);
  assert.equal(mcp.isError, true);
});

test('the recursion guard (OPC_INSIDE_SERVER) refuses every job-creating tool with exit 4, exactly as in the CLI', async (t) => {
  const { env, ws, c } = setup(t, 'ok', { OPC_INSIDE_SERVER: '1' });
  await c.initialize();
  const cliEnv = { ...env, OPC_INSIDE_SERVER: '1' };
  const cases = [
    ['opc_task', { prompt: 'x' }, ['task', '--background', '--', 'x']],
    ['opc_ask', { prompt: 'x' }, ['ask', '--background', '--', 'x']],
    ['opc_plan', { prompt: 'x' }, ['plan', '--background', '--', 'x']],
    ['opc_subagent', { prompt: 'x', agents: ['build'] }, ['subagent', '--agent', 'build', '--background', '--', 'x']],
    ['opc_orchestrate', { task: 'x' }, ['orchestrate', '--background', '--', 'x']],
    ['opc_conclave', { question: 'x', models: ['fixture-a/m', 'fixture-b/m'] }, ['conclave', '--models', 'fixture-a/m,fixture-b/m', '--background', '--', 'x']],
  ];
  for (const [name, args, cliArgs] of cases) {
    const mcp = await c.callTool(name, args);
    const cli = await cliJson(cliArgs, { env: cliEnv, cwd: ws });
    assert.equal(cli.code, 4, `${cliArgs[0]} CLI: ${cli.stderr}`);
    assert.equal(mcp.envelope.exitCode, 4, `${name}: ${JSON.stringify(mcp.envelope)}`);
    assert.equal(mcp.envelope.state, 'policy_denied', name);
    assert.equal(mcp.envelope.error?.code, 'INSIDE_SERVER', name);
    assert.equal(mcp.isError, true, name);
  }
  let requests = [];
  try {
    requests = readFakeState(env).requests ?? [];
  } catch {
    requests = []; // the guard runs before any server contact: the fake may never have started
  }
  assert.equal(requests.filter((r) => r.method === 'POST' && r.path === '/session').length, 0, 'no session created');
});

test('jobs started through MCP carry the Claude session registered for the parent process', async (t) => {
  const env = testEnv(t, { scenario: 'ok' });
  const ws = makeWorkspace(t);
  const stateDir = workspaceStateDir(env.OPC_DATA_DIR, resolveWorkspaceRoot(ws));
  ensurePrivateDir(stateDir);
  const identity = getProcessIdentity(process.pid);
  await updateState(stateDir, (state) => {
    state.claudeSessions.push({ sessionId: 'claude-mcp-parent', pid: process.pid, pidStartTime: identity.startTime, startedAt: new Date().toISOString() });
  });
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  const c = startMcpClient({ env: mcpEnv, cwd: ws });
  registerStopper(t, () => c.close()); // MCP server closed before the F0 cleanup stops servers and removes dirs
  await c.initialize();
  const started = await c.callTool('opc_task', { prompt: 'x' });
  const jobId = jobIdIn(started.envelope, 'task');
  assert.equal(readJob(stateDir, jobId).claudeSessionId, 'claude-mcp-parent');
});

test('session tools return exactly what the session commands return', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const created = await c.callTool('opc_session_new', { title: 'MCP session' });
  assert.equal(created.envelope.exitCode, 0, JSON.stringify(created.envelope));
  const sessionId = JSON.stringify(created.envelope.data).match(/\bses[_0-9A-Za-z]+/)[0];
  const pairs = [
    ['opc_session_show', 'show'],
    ['opc_session_children', 'children'],
    ['opc_session_diff', 'diff'],
    ['opc_session_todo', 'todo'],
  ];
  for (const [name, action] of pairs) {
    const mcp = await c.callTool(name, { sessionId });
    const cli = await cliJson(['session', action, sessionId], { env, cwd: ws });
    assert.equal(mcp.envelope.exitCode, cli.code, name);
    assert.deepEqual(mcp.envelope.data, cli.data, name);
  }
  const listMcp = await c.callTool('opc_session_list', {});
  const listCli = await cliJson(['sessions'], { env, cwd: ws });
  assert.deepEqual(listMcp.envelope.data, listCli.data);
});

test('subagent, orchestrate and conclave behave exactly like their CLI commands', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const cases = [
    ['opc_subagent', { prompt: 'x', agents: ['build'] }, ['subagent', '--agent', 'build', '--background', '--', 'x'], 'sub'],
    ['opc_orchestrate', { task: 'x' }, ['orchestrate', '--background', '--', 'x'], 'orch'],
    ['opc_conclave', { question: 'x', models: ['fixture-a/m', 'fixture-b/m'] }, ['conclave', '--models', 'fixture-a/m,fixture-b/m', '--background', '--', 'x'], 'conc'],
  ];
  for (const [name, args, cliArgs, kind] of cases) {
    const mcp = await c.callTool(name, args);
    const cli = await cliJson(cliArgs, { env, cwd: ws });
    assert.equal(mcp.envelope.exitCode, cli.code, `${name}: ${JSON.stringify(mcp.envelope)} vs ${cli.stderr}`);
    if (cli.code === 0) {
      assert.ok(findJobId(mcp.envelope.data, kind), `${name} returns a ${kind} job id`);
      assert.ok(findJobId(cli.data, kind));
    }
  }
});
```

- [x] **Step 2: Rodar**

Run: `node --test tests/integration/mcp-jobs.test.mjs`
Expected: PASS (8 testes). Falha → diagnosticar com `superpowers:systematic-debugging`; o `stderr` do cliente MCP (`c.stderr`) e o `jobs/<id>.log` do estado mostram o que o comando fez.

- [x] **Step 3: Commit**

```bash
git add tests/integration/mcp-jobs.test.mjs
git commit -m "test: cover MCP execution, job and session tools against the CLI"
```

(Incluir `plugins/opc/scripts/lib/mcp-tools.mjs` no commit se um defeito foi corrigido; nesse caso usar `fix: …` com a descrição do defeito.)

---

### Task 7: Regras do aprovador, confirmações e ausência de escrita de config pelo MCP (integração)

**Files:**
- Create: `tests/fixtures/scenarios/mcp-pending-permission.mjs`
- Test: `tests/integration/mcp-permissions.test.mjs`

**Interfaces:**
- Consumes: cenário por arquivo (`setup(fake)` do mestre) com `fake.state.permissions` (mapa id → `PermissionRequest` da OpenAPI: `{id, sessionID, permission, patterns, metadata, always}`); rota `GET /permission` e `POST /permission/:id/reply` do fake (F2a); `checkReply`/`requiresUser` via o comando `permissions` (F2a); helpers.
- Produces: evidência dos itens de aceite "regras do aprovador e confirmações valem no MCP" e "sem escrita de config via MCP".

- [ ] **Step 1: Criar o cenário**

`tests/fixtures/scenarios/mcp-pending-permission.mjs`:

```js
// F5: three pending permission requests seeded at boot, for the MCP approver/confirmation tests.
export const SESSION_ID = 'ses_mcpfixture0001';
export const DESTRUCTIVE_ID = 'per_mcpdestructive0001';
export const SAFE_ID = 'per_mcpsafe0001';
export const SENSITIVE_ID = 'per_mcpsensitive0001';

export default {
  setup(fake) {
    const base = { sessionID: SESSION_ID, metadata: {}, always: [] };
    fake.state.permissions[DESTRUCTIVE_ID] = { ...base, id: DESTRUCTIVE_ID, permission: 'bash', patterns: ['rm -rf build'] };
    fake.state.permissions[SAFE_ID] = { ...base, id: SAFE_ID, permission: 'bash', patterns: ['npm test'] };
    fake.state.permissions[SENSITIVE_ID] = { ...base, id: SENSITIVE_ID, permission: 'read', patterns: ['config/.env'] };
  },
};
```

- [ ] **Step 2: Escrever o teste**

```js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { DESTRUCTIVE_ID, SAFE_ID, SENSITIVE_ID } from '../fixtures/scenarios/mcp-pending-permission.mjs';
import { cliJson, makeWorkspace, readFakeState, registerStopper, startMcpClient, testEnv, writeTestConfig } from '../helpers.mjs';

function setup(t, approver) {
  const env = testEnv(t, { scenario: 'mcp-pending-permission' });
  const ws = makeWorkspace(t);
  writeTestConfig(env, { policy: { approver } });
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  const c = startMcpClient({ env: mcpEnv, cwd: ws });
  registerStopper(t, () => c.close()); // MCP server closed before the F0 cleanup stops servers and removes dirs
  return { env, ws, c };
}

function replies(env) {
  return readFakeState(env).requests.filter((r) => r.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(r.path));
}

test('opc_permissions_list returns the same pending requests as the CLI', async (t) => {
  const { env, ws, c } = setup(t, 'user');
  await c.initialize();
  const mcp = await c.callTool('opc_permissions_list', {});
  const cli = await cliJson(['permissions', 'list'], { env, cwd: ws });
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.deepEqual(mcp.envelope.data, cli.data);
  assert.match(JSON.stringify(mcp.envelope.data), new RegExp(DESTRUCTIVE_ID));
});

for (const [label, id] of [['destructive bash', DESTRUCTIVE_ID], ['sensitive path', SENSITIVE_ID]]) {
  test(`approver claude: ${label} without confirmedByUser is refused exactly like the CLI and nothing is sent`, async (t) => {
    const { env, ws, c } = setup(t, 'claude');
    await c.initialize();
    const cli = await cliJson(['permissions', 'reply', id, 'once'], { env, cwd: ws });
    const mcp = await c.callTool('opc_permissions_reply', { requestId: id, reply: 'once' });
    assert.notEqual(cli.code, 0, cli.stderr);
    assert.equal(mcp.envelope.exitCode, cli.code);
    assert.equal(mcp.isError, true);
    assert.equal(replies(env).length, 0, 'no reply reached OpenCode');
  });

  test(`approver claude: ${label} with confirmedByUser is sent as "once"`, async (t) => {
    const { env, c } = setup(t, 'claude');
    await c.initialize();
    const mcp = await c.callTool('opc_permissions_reply', { requestId: id, reply: 'once', confirmedByUser: true });
    assert.equal(mcp.envelope.exitCode, 0, JSON.stringify(mcp.envelope));
    const sent = replies(env);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, `/permission/${id}/reply`);
    assert.equal(sent[0].body.reply, 'once');
  });
}

test('approver claude: a non-destructive request can be answered without the user', async (t) => {
  const { env, c } = setup(t, 'claude');
  await c.initialize();
  const mcp = await c.callTool('opc_permissions_reply', { requestId: SAFE_ID, reply: 'reject', message: '--not now' });
  assert.equal(mcp.envelope.exitCode, 0, JSON.stringify(mcp.envelope));
  const sent = replies(env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.reply, 'reject');
  assert.equal(sent[0].body.message, '--not now');
});

test('approver user: MCP applies exactly the CLI rule for a reply without confirmedByUser', async (t) => {
  const cliSide = setup(t, 'user');
  const cli = await cliJson(['permissions', 'reply', SAFE_ID, 'once'], { env: cliSide.env, cwd: cliSide.ws });
  const mcpSide = setup(t, 'user');
  await mcpSide.c.initialize();
  const mcp = await mcpSide.c.callTool('opc_permissions_reply', { requestId: SAFE_ID, reply: 'once' });
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.equal(replies(mcpSide.env).length, replies(cliSide.env).length);
});

test('"always" never leaves the MCP server', async (t) => {
  const { env, c } = setup(t, 'claude');
  await c.initialize();
  const mcp = await c.callTool('opc_permissions_reply', { requestId: SAFE_ID, reply: 'always', confirmedByUser: true });
  assert.equal(mcp.isError, true);
  assert.equal(mcp.envelope.exitCode, 2);
  assert.equal(mcp.envelope.error.code, 'INVALID_ARGUMENTS');
  assert.equal(replies(env).filter((r) => r.body.reply === 'always').length, 0);
  assert.equal(replies(env).length, 0);
});

test('no MCP call can write the configuration', async (t) => {
  const { env, c } = setup(t, 'user');
  const configFile = path.join(env.OPC_DATA_DIR, 'config.json');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
  const before = hash();
  await c.initialize();
  for (const name of ['opc_config_set', 'opc_config_unset', 'opc_config_add', 'opc_config_remove', 'opc_setup']) {
    const res = await c.request('tools/call', { name, arguments: { key: 'policy.approver', value: 'claude' } });
    assert.equal(res.error.code, -32602, name);
  }
  const injected = await c.callTool('opc_config_get', { key: '--tty-confirm' });
  assert.equal(injected.envelope.error.code, 'INVALID_ARGUMENTS');
  await c.callTool('opc_config_get', { key: 'policy' });
  assert.equal(hash(), before);
});
```

- [ ] **Step 3: Rodar**

Run: `node --test tests/integration/mcp-permissions.test.mjs`
Expected: PASS (9 testes). A semeadura em `fake.state.permissions` é a estrutura que a rota `GET /permission` do fake da F2a lê (`Object.values(state.permissions)`); se `opc_permissions_list` vier vazio, o defeito está no carregamento do cenário (nome do arquivo/`setup(fake)`), não na rota.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/scenarios/mcp-pending-permission.mjs tests/integration/mcp-permissions.test.mjs
git commit -m "test: enforce approver rules, confirmations and no config writes over MCP"
```

---

### Task 8: Núcleo do transfer — caminho seguro, conversão do JSONL, ids e forma do export

**Files:**
- Create: `plugins/opc/scripts/lib/transfer.mjs`
- Create: `tests/fixtures/data/export-sample.json` (export real higienizado)
- Create: `tests/fixtures/data/claude-transcript-sample.jsonl` (sintético)
- Test: `tests/unit/transfer.test.mjs`

**Interfaces:**
- Consumes: `expandAlias`, `parseFullId` (`models`); `ExitCode`, `OpcError`; `assertAllowed` (`policy`); `redactText`; `compareVersions`, `MIN_OPENCODE_VERSION` (`server`); `ensurePrivateDir` (`state`).
- Produces: todas as exportações de `lib/transfer.mjs` listadas em "Interfaces novas".

A fixture `export-sample.json` saiu de `opencode export ses_f246e5370ffeRHyqkGfyUsIYTQ` (sessão de sondagem de 25/09/2026) com diretório, provider, modelo, textos, `callID` e `itemId` substituídos (script em `scratchpad/plancheck-F5/scrub.mjs`); ids, tipos de parte e estrutura são os reais.

- [ ] **Step 1: Criar as fixtures**

`tests/fixtures/data/export-sample.json`:

```json
{
  "info": {
    "id": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
    "slug": "brave-eagle",
    "projectID": "global",
    "directory": "/tmp/opc-fixture/proj",
    "path": "tmp/opc-fixture/proj",
    "title": "fixture session",
    "agent": "build",
    "model": {
      "id": "example/model-a",
      "providerID": "example-provider",
      "variant": "default"
    },
    "version": "1.18.32",
    "summary": {
      "additions": 0,
      "deletions": 0,
      "files": 0
    },
    "cost": 0,
    "tokens": {
      "input": 50108,
      "output": 58,
      "reasoning": 16,
      "cache": {
        "read": 74368,
        "write": 0
      }
    },
    "permission": [
      {
        "permission": "bash",
        "pattern": "*",
        "action": "ask"
      }
    ],
    "time": {
      "created": 1790390152335,
      "updated": 1790390192005
    }
  },
  "messages": [
    {
      "info": {
        "role": "user",
        "time": {
          "created": 1790390153047
        },
        "agent": "build",
        "model": {
          "providerID": "example-provider",
          "modelID": "example/model-a"
        },
        "summary": {
          "diffs": []
        },
        "id": "msg_0db91af57001HXhiu4QNpx5GLd",
        "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ"
      },
      "parts": [
        {
          "type": "text",
          "text": "Run a harmless command and report the output.",
          "id": "prt_0db91af5b00155t8DFEPYPzZy0",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db91af57001HXhiu4QNpx5GLd"
        }
      ]
    },
    {
      "info": {
        "parentID": "msg_0db91af57001HXhiu4QNpx5GLd",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/opc-fixture/proj",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "total": 62244,
          "input": 49913,
          "output": 37,
          "reasoning": 6,
          "cache": {
            "write": 0,
            "read": 12288
          }
        },
        "modelID": "example/model-a",
        "providerID": "example-provider",
        "time": {
          "created": 1790390153466,
          "completed": 1790390173909
        },
        "finish": "tool-calls",
        "id": "msg_0db91b0fa001dcTw4BzZ1lB5ae",
        "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ"
      },
      "parts": [
        {
          "type": "step-start",
          "id": "prt_0db91ffc10012MKX6ts9fD6fF8",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db91b0fa001dcTw4BzZ1lB5ae"
        },
        {
          "type": "reasoning",
          "text": "Plan the step.",
          "time": {
            "start": 1790390173636,
            "end": 1790390173640
          },
          "metadata": {
            "openai": {
              "itemId": "item_fixture_1",
              "reasoningEncryptedContent": null
            }
          },
          "id": "prt_0db91ffc40016AXfYvZM1p12kt",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db91b0fa001dcTw4BzZ1lB5ae"
        },
        {
          "type": "tool",
          "tool": "bash",
          "callID": "call_fixture_1",
          "state": {
            "status": "error",
            "input": {
              "command": "echo fixture"
            },
            "error": "fixture rejection",
            "time": {
              "start": 1790390173762,
              "end": 1790390173893
            }
          },
          "metadata": {
            "openai": {
              "itemId": "item_fixture_2"
            }
          },
          "id": "prt_0db91ffcd001JhoQIgbP9J8bc2",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db91b0fa001dcTw4BzZ1lB5ae"
        },
        {
          "reason": "tool-calls",
          "type": "step-finish",
          "tokens": {
            "total": 62244,
            "input": 49913,
            "output": 37,
            "reasoning": 6,
            "cache": {
              "write": 0,
              "read": 12288
            }
          },
          "cost": 0,
          "id": "prt_0db9200c8001H4wcDL7Y9Pg2vA",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db91b0fa001dcTw4BzZ1lB5ae"
        }
      ]
    },
    {
      "info": {
        "parentID": "msg_0db91af57001HXhiu4QNpx5GLd",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/opc-fixture/proj",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "total": 62306,
          "input": 195,
          "output": 21,
          "reasoning": 10,
          "cache": {
            "write": 0,
            "read": 62080
          }
        },
        "modelID": "example/model-a",
        "providerID": "example-provider",
        "time": {
          "created": 1790390173913,
          "completed": 1790390191993
        },
        "finish": "stop",
        "id": "msg_0db9200d90013z5ewXcn0B3pOJ",
        "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ"
      },
      "parts": [
        {
          "type": "step-start",
          "id": "prt_0db9246650017QAd6vUjOEYNw8",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db9200d90013z5ewXcn0B3pOJ"
        },
        {
          "type": "reasoning",
          "text": "The command was rejected: fixture rejection.",
          "time": {
            "start": 1790390191721,
            "end": 1790390191753
          },
          "metadata": {
            "openai": {
              "itemId": "item_fixture_3",
              "reasoningEncryptedContent": null
            }
          },
          "id": "prt_0db9246690013WhFgrwLGJfjIP",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db9200d90013z5ewXcn0B3pOJ"
        },
        {
          "type": "text",
          "text": "Summarize the outcome.",
          "time": {
            "start": 1790390191755,
            "end": 1790390191919
          },
          "metadata": {
            "openai": {
              "itemId": "item_fixture_4"
            }
          },
          "id": "prt_0db92468b001NBlnQAYUTskYi5",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db9200d90013z5ewXcn0B3pOJ"
        },
        {
          "reason": "stop",
          "type": "step-finish",
          "tokens": {
            "total": 62306,
            "input": 195,
            "output": 21,
            "reasoning": 10,
            "cache": {
              "write": 0,
              "read": 62080
            }
          },
          "cost": 0,
          "id": "prt_0db92476d001E0ZDMLAtz8R0p0",
          "sessionID": "ses_f246e5370ffeRHyqkGfyUsIYTQ",
          "messageID": "msg_0db9200d90013z5ewXcn0B3pOJ"
        }
      ]
    }
  ]
}
```

`tests/fixtures/data/claude-transcript-sample.jsonl` (16 linhas; a linha `this line is not json` é proposital):

```text
{"type":"custom-title","customTitle":"Fixture transfer","sessionId":"11111111-2222-4333-8444-555555555555"}
{"type":"user","isSidechain":false,"uuid":"u-1","parentUuid":null,"timestamp":"2026-09-26T10:00:00.000Z","sessionId":"11111111-2222-4333-8444-555555555555","cwd":"/tmp/opc-fixture/proj","message":{"role":"user","content":"List the files in src and explain main.mjs."}}
{"type":"assistant","isSidechain":false,"uuid":"a-1","parentUuid":"u-1","timestamp":"2026-09-26T10:00:01.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"id":"msg_fixture_a1","role":"assistant","model":"claude-fixture","content":[{"type":"thinking","thinking":"Plan the listing.","signature":"sig-fixture"}]}}
{"type":"assistant","isSidechain":false,"uuid":"a-2","parentUuid":"a-1","timestamp":"2026-09-26T10:00:02.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"id":"msg_fixture_a1","role":"assistant","model":"claude-fixture","content":[{"type":"text","text":"I'll look at the directory first."}]}}
{"type":"assistant","isSidechain":false,"uuid":"a-3","parentUuid":"a-2","timestamp":"2026-09-26T10:00:03.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"id":"msg_fixture_a1","role":"assistant","model":"claude-fixture","content":[{"type":"tool_use","id":"toolu_fixture_1","name":"Bash","input":{"command":"ls src"}}]}}
{"type":"user","isSidechain":false,"uuid":"u-2","parentUuid":"a-3","timestamp":"2026-09-26T10:00:04.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fixture_1","content":"main.mjs\nutil.mjs","is_error":false}]},"toolUseResult":{"stdout":"main.mjs\nutil.mjs","stderr":"","interrupted":false}}
{"type":"assistant","isSidechain":false,"uuid":"a-4","parentUuid":"u-2","timestamp":"2026-09-26T10:00:05.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"id":"msg_fixture_a2","role":"assistant","model":"claude-fixture","content":[{"type":"text","text":"src has main.mjs and util.mjs. main.mjs is the entry point."}]}}
{"type":"user","isSidechain":false,"isMeta":true,"uuid":"u-3","parentUuid":"a-4","timestamp":"2026-09-26T10:01:00.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":"<local-command-caveat>Caveat: fixture meta message.</local-command-caveat>"}}
{"type":"user","isSidechain":true,"uuid":"s-1","parentUuid":null,"timestamp":"2026-09-26T10:01:01.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":"Sidechain prompt that must not be transferred."}}
{"type":"user","isSidechain":false,"uuid":"u-4","parentUuid":"a-4","timestamp":"2026-09-26T10:01:02.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":"<command-name>/opc:status</command-name>\n<command-message>opc:status</command-message>"}}
{"type":"file-history-snapshot","messageId":"u-4","snapshot":{"messageId":"u-4","trackedFileBackups":{},"timestamp":"2026-09-26T10:01:02.000Z"},"isSnapshotUpdate":false}
this line is not json
{"type":"user","isSidechain":false,"uuid":"u-5","parentUuid":"u-4","timestamp":"2026-09-26T10:02:00.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":[{"type":"text","text":"Now add a --verbose flag. Keep `$(echo hi)` and \"quotes\" intact: ção ✓"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}}
{"type":"assistant","isSidechain":false,"uuid":"a-5","parentUuid":"u-5","timestamp":"2026-09-26T10:02:01.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"id":"msg_fixture_a3","role":"assistant","model":"claude-fixture","content":[{"type":"tool_use","id":"toolu_fixture_2","name":"Edit","input":{"file_path":"src/main.mjs","old_string":"a","new_string":"b"}}]}}
{"type":"user","isSidechain":false,"uuid":"u-6","parentUuid":"a-5","timestamp":"2026-09-26T10:02:02.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fixture_2","content":[{"type":"text","text":"File has not been read yet"}],"is_error":true}]}}
{"type":"assistant","isSidechain":false,"uuid":"a-6","parentUuid":"u-6","timestamp":"2026-09-26T10:02:03.000Z","sessionId":"11111111-2222-4333-8444-555555555555","message":{"id":"msg_fixture_a4","role":"assistant","model":"claude-fixture","content":[{"type":"text","text":"Added the flag."}]}}
```

- [ ] **Step 2: Escrever o teste que falha**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildExport,
  buildTitle,
  convertClaudeRecords,
  createIdGenerator,
  detectOpencodeVersion,
  MAX_TRANSCRIPT_BYTES,
  parseImportOutput,
  parseJsonlLines,
  readTranscript,
  resolveTranscriptPath,
  resolveTransferModel,
  runImport,
  transferHeader,
  truncateText,
  validateExportShape,
  writeExportFile,
} from '../../plugins/opc/scripts/lib/transfer.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const SAMPLE_JSONL = path.join(DATA, 'claude-transcript-sample.jsonl');
const EXPORT_SAMPLE = JSON.parse(fs.readFileSync(path.join(DATA, 'export-sample.json'), 'utf8'));
const MODEL = { providerID: 'example-provider', modelID: 'example/model-a', full: 'example-provider/example/model-a' };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function projectsRoot(t) {
  const home = tempDir(t);
  const root = path.join(home, '.claude', 'projects', '-tmp-ws');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'session.jsonl');
  fs.copyFileSync(SAMPLE_JSONL, file);
  return { home, root: path.join(home, '.claude', 'projects'), file };
}

async function sampleConversion() {
  const { records } = await readTranscript(SAMPLE_JSONL);
  return convertClaudeRecords(records, { now: 0 });
}

test('resolveTranscriptPath uses OPC_COMPANION_TRANSCRIPT_PATH by default and --source when given', (t) => {
  const { home, file } = projectsRoot(t);
  assert.equal(resolveTranscriptPath({ env: { OPC_COMPANION_TRANSCRIPT_PATH: file }, cwd: home, home }), file);
  const other = path.join(path.dirname(file), 'other.jsonl');
  fs.writeFileSync(other, '{}\n');
  assert.equal(resolveTranscriptPath({ source: other, env: { OPC_COMPANION_TRANSCRIPT_PATH: file }, cwd: home, home }), other);
  assert.equal(resolveTranscriptPath({ source: '~/.claude/projects/-tmp-ws/session.jsonl', env: {}, cwd: '/', home }), file);
});

test('resolveTranscriptPath rejects missing source, non-jsonl, missing file and oversized file', (t) => {
  const { home, root, file } = projectsRoot(t);
  assert.throws(() => resolveTranscriptPath({ env: {}, cwd: home, home }), (e) => e.code === 'NO_TRANSCRIPT' && e.exitCode === 2);
  const txt = path.join(root, 'notes.txt');
  fs.writeFileSync(txt, 'x');
  assert.throws(() => resolveTranscriptPath({ source: txt, env: {}, cwd: home, home }), (e) => e.code === 'NOT_JSONL' && e.exitCode === 2);
  assert.throws(() => resolveTranscriptPath({ source: path.join(root, 'missing.jsonl'), env: {}, cwd: home, home }), (e) => e.code === 'NOT_FOUND' && e.exitCode === 2);
  const big = path.join(path.dirname(file), 'big.jsonl');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_TRANSCRIPT_BYTES + 1);
  assert.throws(() => resolveTranscriptPath({ source: big, env: {}, cwd: home, home }), (e) => e.code === 'TRANSCRIPT_TOO_LARGE' && e.exitCode === 2);
});

test('resolveTranscriptPath refuses files outside the allowed root, including symlinks and ".." paths', (t) => {
  const { home, root, file } = projectsRoot(t);
  const outsideDir = tempDir(t);
  const outside = path.join(outsideDir, 'x.jsonl');
  fs.writeFileSync(outside, '{}\n');
  const isPolicy = (e) => e.code === 'TRANSCRIPT_OUTSIDE_ALLOWED_ROOT' && e.exitCode === 4;
  assert.throws(() => resolveTranscriptPath({ source: outside, env: {}, cwd: home, home }), isPolicy);
  const link = path.join(root, 'link.jsonl');
  fs.symlinkSync(outside, link);
  assert.throws(() => resolveTranscriptPath({ source: link, env: {}, cwd: home, home }), isPolicy);
  const traversal = path.join(root, '-tmp-ws', '..', '..', '..', path.relative(home, outside));
  assert.throws(() => resolveTranscriptPath({ source: traversal, env: {}, cwd: home, home }), isPolicy);
  assert.equal(resolveTranscriptPath({ source: outside, env: { OPC_TRANSFER_ALLOWED_ROOT: outsideDir }, cwd: home, home }), outside);
  assert.equal(resolveTranscriptPath({ source: file, env: {}, cwd: home, home }), file);
});

test('parseJsonlLines counts invalid lines and ignores blanks', () => {
  const { records, invalid } = parseJsonlLines(['{"type":"user"}', '', 'not json', '[1,2]', '  {"type":"assistant"}  ']);
  assert.equal(records.length, 2);
  assert.equal(invalid, 2);
});

test('convertClaudeRecords turns the sample transcript into user/assistant turns with tool summaries', async () => {
  const { invalid } = await readTranscript(SAMPLE_JSONL);
  const conversion = await sampleConversion();
  assert.equal(invalid, 1);
  assert.equal(conversion.title, 'Fixture transfer');
  assert.equal(conversion.claudeSessionId, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(conversion.turns.map((turn) => [turn.role, turn.texts]), [
    ['user', ['List the files in src and explain main.mjs.']],
    ['assistant', [
      "I'll look at the directory first.",
      '[tool call: Bash] {"command":"ls src"}',
      '[tool result: ok] main.mjs\nutil.mjs',
      'src has main.mjs and util.mjs. main.mjs is the entry point.',
    ]],
    ['user', ['Now add a --verbose flag. Keep `$(echo hi)` and "quotes" intact: ção ✓', '[image omitted]']],
    ['assistant', [
      '[tool call: Edit] {"file_path":"src/main.mjs","old_string":"a","new_string":"b"}',
      '[tool result: error] File has not been read yet',
      'Added the flag.',
    ]],
  ]);
  assert.deepEqual(conversion.stats.skipped, { meta: 1, sidechain: 1, command: 1, thinking: 1, other: 1 });
  assert.equal(conversion.turns[0].createdAt, Date.parse('2026-09-26T10:00:00.000Z'));
  assert.equal(conversion.turns[1].completedAt, Date.parse('2026-09-26T10:00:05.000Z'));
});

test('long texts and tool payloads are truncated with an explicit marker', () => {
  assert.equal(truncateText('abc', 5), 'abc');
  assert.match(truncateText('x'.repeat(10), 4), /^xxxx\n…\[truncated 6 chars\]$/);
  const records = [
    { type: 'user', message: { content: 'y'.repeat(100) }, timestamp: '2026-09-26T10:00:00.000Z' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'z'.repeat(100) } }] } },
  ];
  const conversion = convertClaudeRecords(records, { maxTextChars: 10, maxToolChars: 20 });
  assert.match(conversion.turns[0].texts[0], /^y{10}\n…\[truncated 90 chars\]$/);
  assert.ok(conversion.turns[1].texts[0].startsWith('[tool call: Bash] {"'));
  assert.match(conversion.turns[1].texts[0], /…\[truncated \d+ chars\]$/);
});

test('createIdGenerator follows the OpenCode identifier format and ordering', () => {
  let clock = 1_790_000_000_000;
  const nextId = createIdGenerator({ now: () => clock });
  const a = nextId('msg', 'ascending');
  const b = nextId('msg', 'ascending');
  clock += 1000;
  const c = nextId('msg', 'ascending');
  assert.match(a, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(a < b && b < c, 'ascending ids sort by creation order');
  const s1 = nextId('ses', 'descending');
  clock += 1000;
  const s2 = nextId('ses', 'descending');
  assert.match(s1, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(s2 < s1, 'descending ids put the newest first');
});

test('createIdGenerator reproduces real OpenCode 1.18.32 id prefixes', () => {
  // Vectors from `opencode export`: msg_0db91501c001… created at 1790390128668, ses_f246eb45fffe… at 1790390127520.
  assert.ok(createIdGenerator({ now: () => 1790390128668 })('msg', 'ascending').startsWith('msg_0db91501c001'));
  assert.ok(createIdGenerator({ now: () => 1790390127520 })('ses', 'descending').startsWith('ses_f246eb45fffe'));
});

test('buildExport produces a valid export with a synthetic header and linked parents', async () => {
  const conversion = await sampleConversion();
  const exported = buildExport(conversion, { model: MODEL, directory: '/tmp/opc-fixture/proj', version: '1.18.32' });
  assert.deepEqual(validateExportShape(exported), []);
  assert.equal(exported.info.title, 'OPC: transfer: Fixture transfer');
  assert.equal(exported.messages.length, 4);
  const [u1, a1, u2, a2] = exported.messages;
  assert.equal(u1.parts[0].synthetic, true);
  assert.equal(u1.parts[0].text, transferHeader('11111111-2222-4333-8444-555555555555'));
  assert.equal(u1.parts[1].text, 'List the files in src and explain main.mjs.');
  assert.equal(a1.info.parentID, u1.info.id);
  assert.equal(a2.info.parentID, u2.info.id);
  assert.deepEqual(u1.info.model, { providerID: 'example-provider', modelID: 'example/model-a' });
  assert.equal(a1.info.providerID, 'example-provider');
  assert.equal(a1.info.path.cwd, '/tmp/opc-fixture/proj');
  assert.equal(exported.info.time.created, Date.parse('2026-09-26T10:00:00.000Z'));
  assert.equal(exported.info.time.updated, Date.parse('2026-09-26T10:02:03.000Z'));
  const ids = exported.messages.map((m) => m.info.id);
  assert.deepEqual([...ids].sort(), ids, 'message ids ascend in conversation order');
});

test('buildExport inserts an empty user turn when the transcript starts with the assistant', () => {
  const conversion = convertClaudeRecords([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, timestamp: '2026-09-26T10:00:00.000Z' }]);
  const exported = buildExport(conversion, { model: MODEL, directory: '/w', version: '1.18.32' });
  assert.deepEqual(validateExportShape(exported), []);
  assert.equal(exported.messages[0].info.role, 'user');
  assert.equal(exported.messages[0].parts.length, 1);
  assert.equal(exported.messages[1].info.parentID, exported.messages[0].info.id);
});

test('buildExport refuses an empty conversion and buildTitle truncates to 56 chars', () => {
  assert.throws(() => buildExport({ turns: [], title: null, claudeSessionId: null }, { model: MODEL, directory: '/w', version: '1.18.32' }), (e) => e.code === 'EMPTY_TRANSCRIPT' && e.exitCode === 2);
  const title = buildTitle({ title: null, turns: [{ role: 'user', texts: [`${'word '.repeat(30)}\nend`] }] });
  assert.equal(title.length, 'OPC: transfer: '.length + 56);
});

test('validateExportShape accepts the real (scrubbed) export and rejects malformed ones', () => {
  assert.deepEqual(validateExportShape(EXPORT_SAMPLE), []);
  const broken = structuredClone(EXPORT_SAMPLE);
  delete broken.info.slug;
  broken.info.extra = true;
  broken.messages[0].info.id = 'bad_1';
  broken.messages[1].info.parentID = 'msg_unknown';
  broken.messages[2].parts[0].messageID = 'msg_other';
  const errors = validateExportShape(broken);
  assert.ok(errors.includes('info.slug: required'));
  assert.ok(errors.includes('info.extra: not an export key'));
  assert.ok(errors.includes('messages[0].info.id: must start with "msg"'));
  assert.ok(errors.includes('messages[1].info.parentID: must reference an earlier user message'));
  assert.ok(errors.includes('messages[2].parts[0].messageID: must equal the message id'));
  assert.deepEqual(validateExportShape([]), ['$: expected { info: object, messages: array }']);
});

test('resolveTransferModel expands aliases, needs a full id and applies the policy', () => {
  const config = { defaultModel: 'fast', aliases: { fast: 'example-provider/example/model-a' }, policy: { providers: { deny: ['blocked'] }, models: { allow: [], deny: [] } } };
  assert.deepEqual(resolveTransferModel({ config }), MODEL);
  assert.equal(resolveTransferModel({ flag: 'other/x', config }).full, 'other/x');
  assert.throws(() => resolveTransferModel({ config: { policy: {} } }), (e) => e.code === 'NO_MODEL' && e.exitCode === 2);
  assert.throws(() => resolveTransferModel({ flag: 'shortname', config }), (e) => e.code === 'MODEL_NEEDS_FULL_ID');
  assert.throws(() => resolveTransferModel({ flag: 'blocked/m', config }), (e) => e.exitCode === 4);
});

test('parseImportOutput reads the success line printed by opencode import', () => {
  assert.equal(parseImportOutput('Imported session: ses_f246e5370ffeRHyqkGfyUsIYTQ\n'), 'ses_f246e5370ffeRHyqkGfyUsIYTQ');
  assert.equal(parseImportOutput('noise\nImported session: ses_abc123\nmore'), 'ses_abc123');
  assert.equal(parseImportOutput('Failed to read session data\n'), null);
});

function fakeExec(result) {
  const calls = [];
  const impl = (file, args, options, cb) => {
    calls.push({ file, args, options });
    setImmediate(() => cb(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
  };
  return { impl, calls };
}

test('runImport returns the session id and maps failures to exit 7 / 5', async () => {
  const ok = fakeExec({ stdout: 'Imported session: ses_abc123\n', stderr: '[autotitle] Module loaded\n' });
  assert.deepEqual(await runImport({ file: '/f.json', cwd: '/w', env: {}, execFileImpl: ok.impl }), { sessionID: 'ses_abc123', exitCode: 0 });
  assert.deepEqual(ok.calls[0].args, ['import', '/f.json']);
  assert.equal(ok.calls[0].options.cwd, '/w');
  const soft = fakeExec({ stdout: 'Failed to read session data\n' });
  await assert.rejects(runImport({ file: '/f.json', cwd: '/w', execFileImpl: soft.impl }), (e) => e.code === 'IMPORT_FAILED' && e.exitCode === 7 && /Failed to read session data/.test(e.message));
  const crash = fakeExec({ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Error: boom' });
  await assert.rejects(runImport({ file: '/f.json', cwd: '/w', execFileImpl: crash.impl }), (e) => e.code === 'IMPORT_FAILED' && /exit 1/.test(e.message));
  const missing = fakeExec({ error: Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(runImport({ file: '/f.json', cwd: '/w', execFileImpl: missing.impl }), (e) => e.code === 'OPENCODE_NOT_FOUND' && e.exitCode === 5);
});

test('detectOpencodeVersion enforces the minimum OpenCode version', async () => {
  assert.equal(await detectOpencodeVersion({ execFileImpl: fakeExec({ stdout: '1.18.32\n' }).impl }), '1.18.32');
  await assert.rejects(detectOpencodeVersion({ execFileImpl: fakeExec({ stdout: '1.17.9\n' }).impl }), (e) => e.code === 'UNSUPPORTED_VERSION' && e.exitCode === 5);
});

test('writeExportFile writes a 0600 file inside a 0700 transfer directory', (t) => {
  const stateDir = tempDir(t);
  const file = writeExportFile(stateDir, { info: { id: 'ses_abc' }, messages: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { info: { id: 'ses_abc' }, messages: [] });
});
```

(Sem teste de `shellQuote` aqui: o helper é o de `lib/args.mjs` da F3, já coberto lá; o `resumeCommand` do comando é conferido na Task 9.)

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/transfer.test.mjs`
Expected: FAIL com `Cannot find module '.../scripts/lib/transfer.mjs'`.

- [ ] **Step 4: Implementar `plugins/opc/scripts/lib/transfer.mjs`**

```js
// Claude Code JSONL transcript -> `opencode export` JSON -> `opencode import` (spec §4, §13.3 F5).
// Export format verified against OpenCode 1.18.32 (`opencode export`, OpenAPI Session/UserMessage/AssistantMessage/TextPart).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { expandAlias, parseFullId } from './models.mjs';
import { ExitCode, OpcError } from './opc-error.mjs';
import { assertAllowed } from './policy.mjs';
import { redactText } from './redact.mjs';
import { compareVersions, MIN_OPENCODE_VERSION } from './server.mjs';
import { ensurePrivateDir } from './state.mjs';

export const TRANSCRIPT_PATH_ENV = 'OPC_COMPANION_TRANSCRIPT_PATH';
export const ALLOWED_ROOT_ENV = 'OPC_TRANSFER_ALLOWED_ROOT';
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_CHARS = 65536;
export const MAX_TOOL_CHARS = 2000;
export const TITLE_PREFIX = 'OPC: transfer: ';
export const IMPORT_SUCCESS_RE = /^Imported session: (ses_[0-9A-Za-z]+)\s*$/m;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LOCAL_COMMAND_RE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

export const EXPORT_SHAPE = Object.freeze({
  session: {
    required: ['id', 'slug', 'projectID', 'directory', 'title', 'version', 'time'],
    allowed: ['id', 'slug', 'projectID', 'workspaceID', 'directory', 'path', 'parentID', 'summary', 'cost', 'tokens', 'share', 'title', 'agent', 'model', 'version', 'metadata', 'time', 'permission', 'revert'],
  },
  user: {
    required: ['id', 'sessionID', 'role', 'time', 'agent', 'model'],
    allowed: ['id', 'sessionID', 'role', 'time', 'format', 'summary', 'agent', 'model', 'system', 'tools'],
  },
  assistant: {
    required: ['id', 'sessionID', 'role', 'time', 'parentID', 'modelID', 'providerID', 'mode', 'agent', 'path', 'cost', 'tokens'],
    allowed: ['id', 'sessionID', 'role', 'time', 'error', 'parentID', 'modelID', 'providerID', 'mode', 'agent', 'path', 'summary', 'cost', 'tokens', 'structured', 'variant', 'finish'],
  },
  partBase: ['id', 'sessionID', 'messageID', 'type'],
  parts: {
    text: {
      required: ['id', 'sessionID', 'messageID', 'type', 'text'],
      allowed: ['id', 'sessionID', 'messageID', 'type', 'text', 'synthetic', 'ignored', 'time', 'metadata'],
    },
    reasoning: { required: ['id', 'sessionID', 'messageID', 'type', 'text', 'time'] },
    tool: { required: ['id', 'sessionID', 'messageID', 'type', 'callID', 'tool', 'state'] },
    'step-start': { required: ['id', 'sessionID', 'messageID', 'type'] },
    'step-finish': { required: ['id', 'sessionID', 'messageID', 'type', 'reason', 'cost', 'tokens'] },
  },
});

function usage(code, message) {
  return new OpcError(code, message, { exitCode: ExitCode.USAGE });
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function resolveTranscriptPath({ source = null, env = process.env, cwd = process.cwd(), home = env.HOME || os.homedir() } = {}) {
  const requested = source || env[TRANSCRIPT_PATH_ENV];
  if (!requested) {
    throw usage('NO_TRANSCRIPT', 'Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.');
  }
  const candidate = path.resolve(cwd, expandHome(String(requested), home));
  if (path.extname(candidate) !== '.jsonl') throw usage('NOT_JSONL', `Claude session source must be a .jsonl file: ${candidate}`);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new OpcError('NOT_FOUND', `Claude session file not found: ${candidate}`, { exitCode: ExitCode.USAGE });
  }
  if (path.extname(real) !== '.jsonl') throw usage('NOT_JSONL', `Claude session source must resolve to a .jsonl file: ${real}`);
  const rootInput = env[ALLOWED_ROOT_ENV] || path.join(home, '.claude', 'projects');
  let root;
  try {
    root = fs.realpathSync(rootInput);
  } catch {
    throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', `Allowed transcript root does not exist: ${rootInput}`, { exitCode: ExitCode.POLICY });
  }
  if (!isInside(root, real)) {
    throw new OpcError('TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', `opc imports Claude sessions only from ${root}: ${real}`, { exitCode: ExitCode.POLICY });
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw usage('NOT_A_FILE', `Claude session source is not a regular file: ${real}`);
  if (stat.size > MAX_TRANSCRIPT_BYTES) throw usage('TRANSCRIPT_TOO_LARGE', `Claude session file exceeds ${MAX_TRANSCRIPT_BYTES} bytes: ${real}`);
  return real;
}

export function parseJsonlLines(lines) {
  const records = [];
  let invalid = 0;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { records, invalid };
}

export async function readTranscript(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return parseJsonlLines(lines);
}

export function truncateText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block?.type === 'text' ? String(block.text ?? '') : `[${block?.type ?? 'content'} omitted]`)).join('\n');
  }
  return compactJson(content ?? '');
}

function timestampMs(record, fallback) {
  const ms = Date.parse(record.timestamp ?? '');
  return Number.isFinite(ms) ? ms : fallback;
}

export function convertClaudeRecords(records, { maxTextChars = MAX_TEXT_CHARS, maxToolChars = MAX_TOOL_CHARS, now = Date.now() } = {}) {
  const turns = [];
  const stats = { records: records.length, skipped: { meta: 0, sidechain: 0, command: 0, thinking: 0, other: 0 } };
  let title = null;
  let claudeSessionId = null;
  let lastTime = now;
  let current = null;

  const pushUser = (texts, createdAt) => {
    turns.push({ role: 'user', createdAt, texts });
    current = null;
  };
  const assistant = (createdAt) => {
    if (!current) {
      current = { role: 'assistant', createdAt, completedAt: createdAt, texts: [] };
      turns.push(current);
    }
    current.completedAt = Math.max(current.completedAt, createdAt);
    return current;
  };

  for (const record of records) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      title = record.customTitle;
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') {
      stats.skipped.other += 1;
      continue;
    }
    if (record.isSidechain === true) {
      stats.skipped.sidechain += 1;
      continue;
    }
    if (record.isMeta === true) {
      stats.skipped.meta += 1;
      continue;
    }
    if (claudeSessionId === null && typeof record.sessionId === 'string') claudeSessionId = record.sessionId;
    const createdAt = timestampMs(record, lastTime);
    lastTime = createdAt;
    const content = record.message?.content;

    if (record.type === 'user') {
      if (typeof content === 'string') {
        if (LOCAL_COMMAND_RE.test(content.trim())) stats.skipped.command += 1;
        else if (!content.trim()) stats.skipped.other += 1;
        else pushUser([truncateText(content, maxTextChars)], createdAt);
        continue;
      }
      if (!Array.isArray(content)) {
        stats.skipped.other += 1;
        continue;
      }
      const results = content.filter((block) => block?.type === 'tool_result');
      if (results.length > 0) {
        const turn = assistant(createdAt);
        for (const block of results) {
          turn.texts.push(truncateText(`[tool result: ${block.is_error ? 'error' : 'ok'}] ${toolResultText(block.content)}`, maxToolChars));
        }
        continue;
      }
      const texts = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && !LOCAL_COMMAND_RE.test(block.text.trim())) {
          texts.push(truncateText(block.text, maxTextChars));
        } else if (block?.type === 'image') texts.push('[image omitted]');
        else if (block?.type === 'document') texts.push('[document omitted]');
      }
      if (texts.length > 0) pushUser(texts, createdAt);
      else stats.skipped.command += 1;
      continue;
    }

    if (typeof content === 'string') {
      if (content.trim()) assistant(createdAt).texts.push(truncateText(content, maxTextChars));
      continue;
    }
    if (!Array.isArray(content)) {
      stats.skipped.other += 1;
      continue;
    }
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim()) assistant(createdAt).texts.push(truncateText(block.text, maxTextChars));
      } else if (block?.type === 'tool_use') {
        assistant(createdAt).texts.push(truncateText(`[tool call: ${block.name ?? 'unknown'}] ${compactJson(block.input ?? {})}`, maxToolChars));
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        stats.skipped.thinking += 1;
      } else if (block?.type) {
        assistant(createdAt).texts.push(`[${block.type} omitted]`);
      }
    }
  }
  return { turns: turns.filter((turn) => turn.texts.length > 0), title, claudeSessionId, stats };
}

export function createIdGenerator({ now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  let lastMs = 0;
  let counter = 0;
  return function nextId(prefix, direction = 'ascending') {
    const ms = now();
    if (ms !== lastMs) {
      lastMs = ms;
      counter = 0;
    }
    counter += 1;
    let value = BigInt(ms) * 4096n + BigInt(counter);
    if (direction === 'descending') value = ~value;
    const bytes = Buffer.alloc(6);
    for (let i = 0; i < 6; i += 1) bytes[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
    const random = randomBytes(14);
    let suffix = '';
    for (let i = 0; i < 14; i += 1) suffix += BASE62[random[i] % 62];
    return `${prefix}_${bytes.toString('hex')}${suffix}`;
  };
}

export function buildTitle(conversion) {
  const firstUser = conversion.turns.find((turn) => turn.role === 'user')?.texts[0] ?? '';
  const base = String(conversion.title || firstUser || 'Claude session').replace(/\s+/g, ' ').trim();
  return `${TITLE_PREFIX}${base.slice(0, 56)}`;
}

export function transferHeader(claudeSessionId) {
  return `[opc transfer] Conversa importada da sessão ${claudeSessionId ?? 'desconhecida'} do Claude Code. Chamadas de ferramenta aparecem resumidas como texto.`;
}

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

export function buildExport(conversion, { model, agent = 'build', directory, version, nextId = createIdGenerator() }) {
  if (conversion.turns.length === 0) {
    throw usage('EMPTY_TRANSCRIPT', 'The Claude transcript has no user or assistant text to transfer.');
  }
  const sessionID = nextId('ses', 'descending');
  const first = conversion.turns[0];
  const turns = first.role === 'user' ? conversion.turns : [{ role: 'user', createdAt: first.createdAt, texts: [] }, ...conversion.turns];
  const messages = [];
  let lastUserId = null;
  let updated = turns[0].createdAt;
  turns.forEach((turn, index) => {
    const id = nextId('msg', 'ascending');
    const parts = [];
    if (index === 0) {
      parts.push({ id: nextId('prt', 'ascending'), sessionID, messageID: id, type: 'text', text: transferHeader(conversion.claudeSessionId), synthetic: true });
    }
    for (const text of turn.texts) parts.push({ id: nextId('prt', 'ascending'), sessionID, messageID: id, type: 'text', text });
    updated = Math.max(updated, turn.completedAt ?? turn.createdAt);
    if (turn.role === 'user') {
      lastUserId = id;
      messages.push({
        info: { id, sessionID, role: 'user', time: { created: turn.createdAt }, agent, model: { providerID: model.providerID, modelID: model.modelID } },
        parts,
      });
      return;
    }
    messages.push({
      info: {
        id,
        sessionID,
        role: 'assistant',
        time: { created: turn.createdAt, completed: turn.completedAt ?? turn.createdAt },
        parentID: lastUserId,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: agent,
        agent,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: structuredClone(ZERO_TOKENS),
        finish: 'stop',
      },
      parts,
    });
  });
  return {
    info: {
      id: sessionID,
      slug: `transfer-${sessionID.slice(-6).toLowerCase()}`,
      projectID: 'global',
      directory,
      title: buildTitle(conversion),
      agent,
      model: { id: model.modelID, providerID: model.providerID },
      version,
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: structuredClone(ZERO_TOKENS),
      time: { created: turns[0].createdAt, updated },
    },
    messages,
  };
}

function checkKeys(obj, shape, where, errors) {
  for (const key of shape.required) if (obj[key] === undefined) errors.push(`${where}.${key}: required`);
  if (shape.allowed) for (const key of Object.keys(obj)) if (!shape.allowed.includes(key)) errors.push(`${where}.${key}: not an export key`);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateExportShape(data) {
  const errors = [];
  if (!isObject(data) || !isObject(data.info) || !Array.isArray(data.messages)) return ['$: expected { info: object, messages: array }'];
  const info = data.info;
  checkKeys(info, EXPORT_SHAPE.session, 'info', errors);
  if (typeof info.id !== 'string' || !info.id.startsWith('ses')) errors.push('info.id: must start with "ses"');
  if (!isObject(info.time) || typeof info.time.created !== 'number' || typeof info.time.updated !== 'number') errors.push('info.time: created/updated must be numbers');
  const userIds = new Set();
  data.messages.forEach((message, i) => {
    const where = `messages[${i}]`;
    if (!isObject(message) || !isObject(message.info) || !Array.isArray(message.parts)) {
      errors.push(`${where}: expected { info: object, parts: array }`);
      return;
    }
    const m = message.info;
    const shape = EXPORT_SHAPE[m.role];
    if (m.role !== 'user' && m.role !== 'assistant') {
      errors.push(`${where}.info.role: must be user or assistant`);
      return;
    }
    checkKeys(m, shape, `${where}.info`, errors);
    if (typeof m.id !== 'string' || !m.id.startsWith('msg')) errors.push(`${where}.info.id: must start with "msg"`);
    if (m.sessionID !== info.id) errors.push(`${where}.info.sessionID: must equal info.id`);
    if (!isObject(m.time) || typeof m.time.created !== 'number') errors.push(`${where}.info.time.created: must be a number`);
    if (m.role === 'user') {
      if (!isObject(m.model) || typeof m.model.providerID !== 'string' || typeof m.model.modelID !== 'string') errors.push(`${where}.info.model: needs providerID and modelID`);
      userIds.add(m.id);
    } else if (!userIds.has(m.parentID)) {
      errors.push(`${where}.info.parentID: must reference an earlier user message`);
    }
    message.parts.forEach((part, j) => {
      const pw = `${where}.parts[${j}]`;
      if (!isObject(part)) {
        errors.push(`${pw}: expected object`);
        return;
      }
      checkKeys(part, EXPORT_SHAPE.parts[part.type] ?? { required: EXPORT_SHAPE.partBase }, pw, errors);
      if (typeof part.id !== 'string' || !part.id.startsWith('prt')) errors.push(`${pw}.id: must start with "prt"`);
      if (part.sessionID !== info.id) errors.push(`${pw}.sessionID: must equal info.id`);
      if (part.messageID !== m.id) errors.push(`${pw}.messageID: must equal the message id`);
      if (part.type === 'text' && typeof part.text !== 'string') errors.push(`${pw}.text: must be a string`);
    });
  });
  return errors;
}

export function resolveTransferModel({ flag = null, config }) {
  const raw = flag ?? config.defaultModel ?? null;
  if (!raw) {
    throw usage('NO_MODEL', 'No model to record in the transferred session. Pass --model <provider/model> or set defaultModel with /opc:setup.');
  }
  const full = expandAlias(String(raw), config.aliases ?? {});
  if (!full.includes('/')) throw usage('MODEL_NEEDS_FULL_ID', `Transfer needs a full model id (provider/model) or an alias: ${full}`);
  const { providerID, modelID } = parseFullId(full);
  assertAllowed('provider', providerID, config.policy ?? {});
  assertAllowed('model', full, config.policy ?? {});
  return { providerID, modelID, full };
}

function execFileResult(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ error, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function notFound(error) {
  return error?.code === 'ENOENT'
    ? new OpcError('OPENCODE_NOT_FOUND', 'opencode executable not found in PATH; run /opc:setup', { exitCode: ExitCode.CONNECTION })
    : null;
}

export async function detectOpencodeVersion({ opencodeBin = 'opencode', env = process.env, execFileImpl = execFile } = {}) {
  const r = await execFileResult(execFileImpl, opencodeBin, ['--version'], { env, timeout: 15000, encoding: 'utf8' });
  const missing = notFound(r.error);
  if (missing) throw missing;
  const match = /(\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!match) throw new OpcError('UNSUPPORTED_VERSION', `Could not read the OpenCode version: ${redactText(r.stdout.trim()).slice(0, 200)}`, { exitCode: ExitCode.CONNECTION });
  if (compareVersions(match[1], MIN_OPENCODE_VERSION) < 0) {
    throw new OpcError('UNSUPPORTED_VERSION', `OpenCode ${match[1]} is older than ${MIN_OPENCODE_VERSION}`, { exitCode: ExitCode.CONNECTION });
  }
  return match[1];
}

export function writeExportFile(stateDir, exported) {
  const dir = path.join(stateDir, 'transfer');
  ensurePrivateDir(dir);
  const file = path.join(dir, `export-${exported.info.id}.json`);
  fs.writeFileSync(file, JSON.stringify(exported), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return file;
}

export function parseImportOutput(stdout) {
  const match = IMPORT_SUCCESS_RE.exec(String(stdout ?? ''));
  return match ? match[1] : null;
}

export async function runImport({ opencodeBin = 'opencode', file, cwd, env = process.env, timeoutMs = 120000, execFileImpl = execFile }) {
  const r = await execFileResult(execFileImpl, opencodeBin, ['import', file], { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const missing = notFound(r.error);
  if (missing) throw missing;
  const sessionID = parseImportOutput(r.stdout);
  if (!sessionID) {
    const tail = redactText(`${r.stdout}\n${r.stderr}`.trim()).slice(-2000);
    throw new OpcError('IMPORT_FAILED', `opencode import failed (exit ${r.code})${tail ? `: ${tail}` : ''}`, { exitCode: ExitCode.JOB_FAILED });
  }
  return { sessionID, exitCode: r.code };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/transfer.test.mjs`
Expected: PASS (17 testes), inclusive `createIdGenerator reproduces real OpenCode 1.18.32 id prefixes`.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/transfer.mjs tests/unit/transfer.test.mjs tests/fixtures/data/export-sample.json tests/fixtures/data/claude-transcript-sample.jsonl
git commit -m "feat: convert Claude Code transcripts into the opencode export format"
```

---

### Task 9: Subcomando `transfer`, `/opc:transfer` e `opencode import` no binário falso

**Files:**
- Create: `plugins/opc/scripts/commands/transfer.mjs`
- Modify: `plugins/opc/scripts/lib/render.mjs` (acrescentar `renderTransfer`)
- Create: `plugins/opc/commands/transfer.md`
- Create: `tests/fixtures/fake-import.mjs`
- Modify: `tests/fixtures/bin/opencode` (ramo `import`)
- Test: `tests/integration/transfer.test.mjs`

**Interfaces:**
- Consumes: `lib/transfer.mjs` (Task 8); `parseArgs`; `ensurePrivateDir`; contexto (`ctx.env`, `ctx.cwd`, `ctx.config`, `ctx.workspaceRoot`, `ctx.stateDir`, `ctx.json`, `ctx.out`); helpers `cliJson`, `runCli`, `readFakeState`, `writeTestConfig`, `testEnv`, `makeWorkspace`, `REPO_ROOT`, `PLUGIN_ROOT`.
- Produces: `opc transfer [--source <jsonl>] [--model <m>] [--json]`; `execute(ctx, { source, model })`; `renderTransfer(result)`; `/opc:transfer`; fake `opencode import <file>` com `FAKE_OPENCODE_IMPORT=ok|fail|crash` gravando `state.imports[] = { file, cwd, mode, errors, sessionID, title, messageCount, partCount, texts }` no `FAKE_OPENCODE_STATE`.

Exit codes do `transfer`: 0 ok; 2 uso (`NO_TRANSCRIPT`, `NOT_JSONL`, `NOT_FOUND`, `NOT_A_FILE`, `TRANSCRIPT_TOO_LARGE`, `EMPTY_TRANSCRIPT`, `NO_MODEL`, `MODEL_NEEDS_FULL_ID`); 4 política (`TRANSCRIPT_OUTSIDE_ALLOWED_ROOT`, modelo/provider negado); 5 OpenCode ausente ou antigo; 7 `IMPORT_FAILED`/`EXPORT_SHAPE_INVALID`.

- [ ] **Step 1: Escrever o teste que falha**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import { cliJson, makeWorkspace, PLUGIN_ROOT, readFakeState, REPO_ROOT, runCli, testEnv, writeTestConfig } from '../helpers.mjs';

const SAMPLE = path.join(REPO_ROOT, 'tests', 'fixtures', 'data', 'claude-transcript-sample.jsonl');
const MODEL = 'example-provider/example/model-a';

function setup(t, extra = {}) {
  const env = testEnv(t, { extra });
  delete env.OPC_COMPANION_TRANSCRIPT_PATH;
  const ws = makeWorkspace(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-projects-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '-tmp-ws'));
  const source = path.join(root, '-tmp-ws', 'session.jsonl');
  fs.copyFileSync(SAMPLE, source);
  env.OPC_TRANSFER_ALLOWED_ROOT = root;
  return { env, ws, wsReal: fs.realpathSync(ws), root, source };
}

function imports(env) {
  try {
    return readFakeState(env).imports ?? [];
  } catch {
    return [];
  }
}

test('transfer converts the transcript, imports it with opencode import and prints the resume command', async (t) => {
  const { env, ws, wsReal, source } = setup(t);
  const r = await cliJson(['transfer', '--source', source, '--model', MODEL], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  const [imp] = imports(env);
  assert.deepEqual(imp.errors, [], 'export JSON has the opencode export shape');
  assert.equal(imp.mode, '600');
  assert.equal(imp.cwd, wsReal);
  assert.equal(fs.existsSync(imp.file), false, 'temporary export removed');
  assert.match(r.data.sessionID, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(r.data.sessionID, imp.sessionID);
  assert.equal(r.data.title, 'OPC: transfer: Fixture transfer');
  assert.equal(imp.title, r.data.title);
  assert.deepEqual(r.data.messages, { total: 4, user: 2, assistant: 2 });
  assert.deepEqual(r.data.skipped, { meta: 1, sidechain: 1, command: 1, thinking: 1, other: 1, invalidLines: 1 });
  assert.equal(r.data.model, MODEL);
  assert.equal(r.data.resumeCommand, `cd ${shellQuote(wsReal)} && opencode -s ${r.data.sessionID}`);
  assert.ok(imp.texts.includes('List the files in src and explain main.mjs.'));
  assert.ok(imp.texts.includes('Now add a --verbose flag. Keep `$(echo hi)` and "quotes" intact: ção ✓'));
  assert.ok(imp.texts.includes('[tool call: Bash] {"command":"ls src"}'));
  assert.ok(!imp.texts.some((text) => text.includes('Sidechain prompt')));
});

test('transfer reads OPC_COMPANION_TRANSCRIPT_PATH by default and renders Markdown without --json', async (t) => {
  const { env, ws, source } = setup(t);
  const r = await runCli(['transfer', '--model', MODEL], { env: { ...env, OPC_COMPANION_TRANSCRIPT_PATH: source }, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^# opc transfer/m);
  assert.match(r.stdout, /opencode -s ses_[0-9A-Za-z]+/);
  assert.equal(imports(env).length, 1);
});

test('a transcript outside the allowed root is refused with exit 4 and nothing is imported', async (t) => {
  const { env, ws } = setup(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const file = path.join(outside, 'x.jsonl');
  fs.copyFileSync(SAMPLE, file);
  const r = await runCli(['transfer', '--source', file, '--model', MODEL], { env, cwd: ws });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /TRANSCRIPT_OUTSIDE_ALLOWED_ROOT/);
  assert.equal(imports(env).length, 0);
});

test('usage errors: no transcript, non-jsonl source, no model', async (t) => {
  const { env, ws, root, source } = setup(t);
  writeTestConfig(env, { defaultModel: null });
  assert.equal((await runCli(['transfer', '--model', MODEL], { env, cwd: ws })).code, 2);
  const txt = path.join(root, '-tmp-ws', 'notes.txt');
  fs.writeFileSync(txt, 'x');
  assert.equal((await runCli(['transfer', '--source', txt, '--model', MODEL], { env, cwd: ws })).code, 2);
  const noModel = await runCli(['transfer', '--source', source], { env, cwd: ws });
  assert.equal(noModel.code, 2);
  assert.match(noModel.stderr, /NO_MODEL/);
  assert.equal(imports(env).length, 0);
});

test('a model denied by the policy is refused with exit 4', async (t) => {
  const { env, ws, source } = setup(t);
  writeTestConfig(env, { policy: { providers: { allow: [], deny: ['blocked'] } } });
  const r = await runCli(['transfer', '--source', source, '--model', 'blocked/model-x'], { env, cwd: ws });
  assert.equal(r.code, 4);
  assert.equal(imports(env).length, 0);
});

for (const mode of ['fail', 'crash']) {
  test(`opencode import ${mode} → exit 7 with the redacted output and the temporary file removed`, async (t) => {
    const { env, ws, source } = setup(t, { FAKE_OPENCODE_IMPORT: mode });
    const r = await runCli(['transfer', '--source', source, '--model', MODEL], { env, cwd: ws });
    assert.equal(r.code, 7);
    assert.match(r.stderr, /IMPORT_FAILED/);
    if (mode === 'fail') assert.match(r.stderr, /Failed to read session data/);
    const [imp] = imports(env);
    assert.equal(fs.existsSync(imp.file), false);
  });
}

test('/opc:transfer is user-only and passes arguments through a quoted heredoc', () => {
  const md = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'transfer.md'), 'utf8');
  assert.match(md, /^disable-model-invocation: true$/m);
  assert.match(md, /^allowed-tools: Bash\(opc:\*\)$/m);
  assert.match(md, /opc transfer --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\$ARGUMENTS\nOPC_ARGS/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/transfer.test.mjs`
Expected: FAIL — `transfer` é subcomando desconhecido (exit 2 em todos) e `commands/transfer.md` não existe.

- [ ] **Step 3: Criar `tests/fixtures/fake-import.mjs`**

```js
// `opencode import <file>` for the fake binary. Independent oracle: the required keys and id prefixes
// below are copied from the OpenCode 1.18.32 OpenAPI (Session, UserMessage, AssistantMessage, parts),
// not imported from the plugin, so a plugin bug cannot hide itself.
import fs from 'node:fs';

const REQUIRED = {
  session: ['id', 'slug', 'projectID', 'directory', 'title', 'version', 'time'],
  user: ['id', 'sessionID', 'role', 'time', 'agent', 'model'],
  assistant: ['id', 'sessionID', 'role', 'time', 'parentID', 'modelID', 'providerID', 'mode', 'agent', 'path', 'cost', 'tokens'],
  text: ['id', 'sessionID', 'messageID', 'type', 'text'],
  part: ['id', 'sessionID', 'messageID', 'type'],
};

export function checkImportShape(data) {
  const errors = [];
  const info = data?.info;
  if (!info || !Array.isArray(data?.messages)) return ['expected { info, messages[] }'];
  for (const key of REQUIRED.session) if (info[key] === undefined) errors.push(`info.${key} missing`);
  if (!String(info.id).startsWith('ses')) errors.push('info.id must start with ses');
  data.messages.forEach((message, i) => {
    const m = message?.info ?? {};
    const required = REQUIRED[m.role];
    if (!required) {
      errors.push(`messages[${i}].info.role invalid`);
      return;
    }
    for (const key of required) if (m[key] === undefined) errors.push(`messages[${i}].info.${key} missing`);
    if (!String(m.id).startsWith('msg')) errors.push(`messages[${i}].info.id must start with msg`);
    if (m.sessionID !== info.id) errors.push(`messages[${i}].info.sessionID mismatch`);
    (message.parts ?? []).forEach((part, j) => {
      for (const key of part.type === 'text' ? REQUIRED.text : REQUIRED.part) if (part[key] === undefined) errors.push(`messages[${i}].parts[${j}].${key} missing`);
      if (!String(part.id).startsWith('prt')) errors.push(`messages[${i}].parts[${j}].id must start with prt`);
      if (part.messageID !== m.id) errors.push(`messages[${i}].parts[${j}].messageID mismatch`);
    });
  });
  return errors;
}

function recordImport(entry) {
  const stateFile = process.env.FAKE_OPENCODE_STATE;
  if (!stateFile) return;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    state = {};
  }
  state.imports = [...(state.imports ?? []), entry];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export async function runFakeImport(args) {
  process.stderr.write('[autotitle] Module loaded\n');
  const file = args.find((arg) => !arg.startsWith('-'));
  if (!file) {
    process.stderr.write('Not enough non-option arguments: got 0, need at least 1\n');
    return 1;
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    process.stderr.write(`Error: File not found: ${file}\n`);
    return 1;
  }
  const entry = { file, cwd: process.cwd(), mode: (stat.mode & 0o777).toString(8), errors: [], sessionID: null, messageCount: 0, partCount: 0, texts: [] };
  const mode = process.env.FAKE_OPENCODE_IMPORT ?? 'ok';
  if (mode === 'fail') {
    recordImport(entry);
    process.stdout.write('Failed to read session data\n');
    return 0;
  }
  if (mode === 'crash') {
    recordImport(entry);
    process.stderr.write('Error: fake import crashed\n');
    return 1;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    entry.errors.push(`Invalid JSON in ${file}: ${err.message}`);
    recordImport(entry);
    process.stderr.write(`Error: Invalid JSON in ${file}\n`);
    return 1;
  }
  entry.errors = checkImportShape(data);
  entry.sessionID = data?.info?.id ?? null;
  entry.title = data?.info?.title ?? null;
  entry.messageCount = data?.messages?.length ?? 0;
  entry.partCount = (data?.messages ?? []).reduce((n, m) => n + (m.parts?.length ?? 0), 0);
  entry.texts = (data?.messages ?? []).flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text));
  recordImport(entry);
  if (entry.errors.length > 0) {
    process.stderr.write(`Error: session decode failed: ${entry.errors[0]}\n`);
    return 1;
  }
  process.stdout.write(`Imported session: ${data.info.id}\n`);
  return 0;
}
```

- [ ] **Step 4: Acrescentar o ramo `import` ao binário falso `tests/fixtures/bin/opencode`**

O binário da F0 é ESM com `await` de topo (variáveis `here`, `argv`, `path` e `pathToFileURL` já definidas). Âncora exata: inserir o ramo abaixo **imediatamente antes** da linha `if (argv[0] !== 'serve') {` (depois do ramo `--version`), sem mexer no resto. O `await` garante que nenhum ramo seguinte rode antes do `process.exit`:

```js
if (argv[0] === 'import') {
  const { runFakeImport } = await import(pathToFileURL(path.join(here, '..', 'fake-import.mjs')).href);
  process.exit(await runFakeImport(argv.slice(1)));
}

```

- [ ] **Step 5: Acrescentar `renderTransfer` ao fim de `plugins/opc/scripts/lib/render.mjs`**

```js
export function renderTransfer(result) {
  const s = result.skipped;
  const lines = [
    '# opc transfer',
    '',
    `Sessão OpenCode criada: \`${result.sessionID}\``,
    `Título: ${result.title}`,
    `Modelo registrado: ${result.model}`,
    `Mensagens importadas: ${result.messages.total} (${result.messages.user} do usuário, ${result.messages.assistant} do assistente)`,
    `Origem: ${result.source}`,
    `Ignorados: ${s.meta} meta, ${s.sidechain} sidechain, ${s.command} comandos locais, ${s.thinking} blocos de raciocínio, ${s.other} outros, ${s.invalidLines} linhas inválidas`,
  ];
  for (const warning of result.warnings) lines.push(`Aviso: ${warning}`);
  lines.push('', 'Para retomar no terminal:', '', `    ${result.resumeCommand}`, '');
  return lines.join('\n');
}
```

- [ ] **Step 6: Criar `plugins/opc/scripts/commands/transfer.mjs`**

```js
// opc transfer: Claude Code JSONL transcript → OpenCode session through `opencode import` (spec §4, §13.3 F5).
import fs from 'node:fs';

import { parseArgs, shellQuote } from '../lib/args.mjs';
import { ExitCode, OpcError } from '../lib/opc-error.mjs';
import { renderTransfer } from '../lib/render.mjs';
import { ensurePrivateDir } from '../lib/state.mjs';
import {
  buildExport,
  convertClaudeRecords,
  detectOpencodeVersion,
  readTranscript,
  resolveTranscriptPath,
  resolveTransferModel,
  runImport,
  validateExportShape,
  writeExportFile,
} from '../lib/transfer.mjs';

const SPEC = {
  flags: {
    source: { type: 'string' },
    model: { type: 'string', alias: 'm' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
};

export async function execute(ctx, { source = null, model = null } = {}) {
  const transcript = resolveTranscriptPath({ source, env: ctx.env, cwd: ctx.cwd });
  const resolvedModel = resolveTransferModel({ flag: model, config: ctx.config });
  const version = await detectOpencodeVersion({ env: ctx.env });
  const { records, invalid } = await readTranscript(transcript);
  const conversion = convertClaudeRecords(records);
  const exported = buildExport(conversion, { model: resolvedModel, directory: ctx.workspaceRoot, version });
  const shapeErrors = validateExportShape(exported);
  if (shapeErrors.length > 0) {
    throw new OpcError('EXPORT_SHAPE_INVALID', `Generated export is invalid: ${shapeErrors.slice(0, 5).join('; ')}`, { exitCode: ExitCode.JOB_FAILED });
  }
  ensurePrivateDir(ctx.stateDir);
  const file = writeExportFile(ctx.stateDir, exported);
  let imported;
  try {
    imported = await runImport({ file, cwd: ctx.workspaceRoot, env: ctx.env });
  } finally {
    fs.rmSync(file, { force: true });
  }
  const warnings = [];
  if (imported.sessionID !== exported.info.id) warnings.push(`opencode reported ${imported.sessionID}, expected ${exported.info.id}`);
  if (imported.exitCode !== 0) warnings.push(`opencode import exited with code ${imported.exitCode} after importing`);
  const user = exported.messages.filter((message) => message.info.role === 'user').length;
  return {
    sessionID: imported.sessionID,
    title: exported.info.title,
    model: resolvedModel.full,
    source: transcript,
    workspaceRoot: ctx.workspaceRoot,
    messages: { total: exported.messages.length, user, assistant: exported.messages.length - user },
    skipped: { ...conversion.stats.skipped, invalidLines: invalid },
    resumeCommand: `cd ${shellQuote(ctx.workspaceRoot)} && opencode -s ${imported.sessionID}`,
    warnings,
  };
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, SPEC);
  const result = await execute(ctx, { source: flags.source ?? null, model: flags.model ?? null });
  if (flags.json) ctx.json(result);
  else ctx.out(renderTransfer(result));
  return ExitCode.OK;
}
```

- [ ] **Step 7: Criar `plugins/opc/commands/transfer.md`**

````markdown
---
description: Transfere a conversa atual do Claude Code para uma sessão OpenCode retomável
argument-hint: "[--source <claude-jsonl>] [--model <provider/model|alias>]"
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Transfira a conversa para o OpenCode executando exatamente:

```bash
opc transfer --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Regras:

- Apresente a saída ao usuário exatamente como retornada, preservando o id da sessão e a linha `cd … && opencode -s <id>`.
- Em erro, mostre o código e a mensagem (`TRANSCRIPT_OUTSIDE_ALLOWED_ROOT`, `NO_MODEL`, `IMPORT_FAILED`…) sem tentar contornar.
- Sem `--source`, o comando usa o transcript desta sessão (`OPC_COMPANION_TRANSCRIPT_PATH`, exportado pelo hook SessionStart).
- Não rode `opencode` você mesmo e não altere a configuração.
````

- [ ] **Step 8: Rodar e ver passar**

Run: `node --test tests/integration/transfer.test.mjs`
Expected: PASS (8 testes).

Run: `npm test`
Expected: PASS (suíte inteira).

- [ ] **Step 9: Commit**

```bash
git add plugins/opc/scripts/commands/transfer.mjs plugins/opc/scripts/lib/render.mjs plugins/opc/commands/transfer.md tests/fixtures/fake-import.mjs tests/fixtures/bin/opencode tests/integration/transfer.test.mjs
git commit -m "feat: add opc transfer and /opc:transfer via opencode import"
```

---

### Task 10: Skill e documentação da fase (MCP e transfer)

Documentação faz parte do portão (spec §12). Os exemplos de saída são **reais**: o Step 5 da Task 11 substitui os ids de exemplo abaixo pelos da execução ao vivo, redigidos.

**Files:**
- Modify: `plugins/opc/skills/opc-result-handling/SKILL.md` (acrescentar seção)
- Modify: `docs/architecture.md` (seção "Servidor MCP (F5)")
- Modify: `docs/commands.md` (seção "/opc:transfer" e subseção "Ferramentas MCP")
- Modify: `docs/troubleshooting.md` (seção "MCP e transfer")
- Modify: `README.md` (seção "Servidor MCP")
- Test: `tests/unit/docs-f5.test.mjs`

**Interfaces:**
- Consumes: `TOOL_NAMES` (Task 4).
- Produces: documentação de todas as 25 ferramentas e do `/opc:transfer`; regra do Claude para as ferramentas MCP na skill.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/docs-f5.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { PLUGIN_ROOT, REPO_ROOT } from '../helpers.mjs';

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('architecture.md documents the MCP server and every tool', () => {
  const doc = read(REPO_ROOT, 'docs', 'architecture.md');
  assert.match(doc, /^## Servidor MCP \(F5\)$/m);
  for (const name of TOOL_NAMES) assert.ok(doc.includes(`\`${name}\``), name);
  assert.match(doc, /2025-06-18/);
});

test('commands.md documents /opc:transfer with its exit codes and the MCP tools', () => {
  const doc = read(REPO_ROOT, 'docs', 'commands.md');
  assert.match(doc, /^## `\/opc:transfer`$/m);
  for (const code of ['TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', 'NO_MODEL', 'IMPORT_FAILED', 'OPC_TRANSFER_ALLOWED_ROOT']) assert.ok(doc.includes(code), code);
  assert.match(doc, /^### Ferramentas MCP$/m);
});

test('README and troubleshooting mention MCP; the skill carries the MCP rules', () => {
  assert.match(read(REPO_ROOT, 'README.md'), /^## Servidor MCP$/m);
  assert.match(read(REPO_ROOT, 'docs', 'troubleshooting.md'), /^## MCP e transfer$/m);
  const skill = read(PLUGIN_ROOT, 'skills', 'opc-result-handling', 'SKILL.md');
  assert.match(skill, /^## Ferramentas MCP \(`opc_\*`\)$/m);
  assert.match(skill, /confirmedByUser/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/docs-f5.test.mjs`
Expected: FAIL (seções ausentes).

- [ ] **Step 3: Acrescentar a seção à skill `plugins/opc/skills/opc-result-handling/SKILL.md`**

```markdown
## Ferramentas MCP (`opc_*`)

As ferramentas do servidor MCP `opc` seguem exatamente as regras dos comandos `/opc:` — são o mesmo código.

- **Jobs longos** (`opc_task`, `opc_ask`, `opc_plan`, `opc_subagent`, `opc_orchestrate`, `opc_conclave`) voltam com o id do job em background. Acompanhe com `opc_job_status` (use `wait: true` só com `jobId`) e apresente `opc_job_result` como apresentaria `/opc:result`.
- **`state: "waiting_permission"`** num resultado MCP é o mesmo que o exit 3: liste com `opc_permissions_list` e trate o pedido.
- **`opc_permissions_reply`:**
  - com o aprovador `user` (padrão), sempre pergunte ao usuário com AskUserQuestion antes de responder;
  - pedidos destrutivos, de `external_directory` ou de caminhos sensíveis exigem o usuário, qualquer que seja o aprovador;
  - `confirmedByUser: true` só depois de o usuário aprovar **aquele** pedido nesta conversa; nunca por decisão própria;
  - `always` não existe.
- **`state: "wait_timeout"`** não é erro: o job continua; informe o id.
- **Não há ferramenta MCP** para mudar configuração, `revert`/`unrevert`, parar o servidor, review ou transfer. Oriente o usuário a rodar `/opc:config`, `/opc:session revert`, `/opc:setup --stop-server`, `/opc:review` ou `/opc:transfer`.
- Agentes `opc-worker` e `opc-rescue` nunca chamam `opc_permissions_reply`.
```

- [ ] **Step 4: Acrescentar ao fim de `docs/architecture.md`**

````markdown
## Servidor MCP (F5)

O plugin declara um servidor MCP stdio no `plugin.json`:

```json
"mcpServers": { "opc": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"] } }
```

O Claude Code sobe o processo com `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` e `CLAUDE_PROJECT_DIR` no ambiente. Sem dependências: o protocolo (JSON-RPC 2.0, uma mensagem por linha) está em `scripts/lib/mcp-protocol.mjs`. Versão implementada: **2025-06-18**; `2025-03-26` e `2024-11-05` são aceitas por negociação.

### Fluxo de uma chamada

```
Claude Code ──stdio──▶ mcp-server.mjs
                        └─ mcp-protocol.mjs   initialize · ping · tools/list · tools/call
                            └─ mcp-tools.mjs  valida o inputSchema → monta o argv (texto livre após "--")
                                └─ opc-companion.mjs main(argv, io)   ← o mesmo que o bin/opc executa
                                    └─ commands/<sub>.mjs run(ctx, argv) → lib/*
```

- **Mesmas regras:** o MCP não tem lógica de negócio. Política, aprovador, confirmações, limites de jobs, perfis de permissão e exit codes vêm dos comandos.
- **stdout reservado:** o `mcp-server.mjs` guarda o `write` original do stdout para o protocolo e desvia qualquer outra escrita em `process.stdout` para o stderr.
- **stdin isolado:** cada comando recebe um stdin vazio (não TTY) e stdout/stderr capturados (até 200 000 caracteres; excesso → `truncated: true`).
- **Timeout por chamada:** 300 s; com `wait: true`, `waitTimeoutSec + 300 s`. Estouro → `MCP_CALL_TIMEOUT` (o comando pode continuar).
- **Sessão do Claude:** o MCP não recebe `OPC_COMPANION_SESSION_ID`. A cada chamada, procura em `claudeSessions` a entrada mais recente cujo `pid` é o processo pai do MCP (o Claude) com `pidStartTime` conferido, e a repassa ao comando. Sem correspondência, o job fica sem sessão do Claude.

### Resultado

`content[0].text` é um JSON:

| Campo | Conteúdo |
|---|---|
| `exitCode` | exit code do comando (§4.1) |
| `state` | `ok`, `usage_error`, `waiting_permission`, `policy_denied`, `connection_error`, `wait_timeout`, `job_failed`, `cancelled` |
| `data` | o JSON que a CLI imprimiria com `--json` (redigido) |
| `error` | `{ code, message }` (redigido), quando houver |
| `truncated` | `true` se a saída passou do limite |

`isError` é `false` para `ok`, `waiting_permission` e `wait_timeout`. Argumentos inválidos → `isError` com `INVALID_ARGUMENTS`. Ferramenta inexistente → erro JSON-RPC `-32602`.

### Ferramentas

| Ferramenta | Comando equivalente | Notas |
|---|---|---|
| `opc_models` | `/opc:models` | read-only |
| `opc_providers` | `/opc:providers` | read-only |
| `opc_agents` | `/opc:agents` | read-only |
| `opc_catalog` | `/opc:catalog` | read-only |
| `opc_config_get` | `/opc:config get` | read-only; única ferramenta de config |
| `opc_task` | `/opc:task` | background por padrão; `write: true` usa o perfil `write` |
| `opc_ask` | `/opc:ask` | background por padrão |
| `opc_plan` | `/opc:plan` | background por padrão |
| `opc_subagent` | `/opc:subagent` | job-grupo |
| `opc_orchestrate` | `/opc:orchestrate` | job-grupo; escrita só com `write: true` |
| `opc_conclave` | `/opc:conclave` | job-grupo |
| `opc_session_list` | `/opc:sessions` | read-only |
| `opc_session_show` | `/opc:session show` | read-only |
| `opc_session_new` | `/opc:session new` | |
| `opc_session_fork` | `/opc:session fork` | |
| `opc_session_summarize` | `/opc:session summarize` | |
| `opc_session_children` | `/opc:session children` | read-only |
| `opc_session_diff` | `/opc:session diff` | read-only |
| `opc_session_todo` | `/opc:session todo` | read-only |
| `opc_job_status` | `/opc:status` | `wait` exige `jobId` |
| `opc_job_result` | `/opc:result` | |
| `opc_job_cancel` | `/opc:cancel` | |
| `opc_permissions_list` | `/opc:permissions list` | |
| `opc_permissions_reply` | `/opc:permissions reply` | `once`/`reject`; `confirmedByUser` só após AskUserQuestion |
| `opc_permissions_answer` | `/opc:permissions answer` | |

### Não expostos (de propósito)

| Comando | Motivo |
|---|---|
| `/opc:session revert` / `unrevert` | Mudam arquivos e histórico; exigem confirmação do usuário no fluxo do comando |
| `/opc:setup` (inclui `--stop-server`, instalação) | Ação de operador |
| `/opc:config set/unset/add/remove`, `opc config init` | Sem escrita de config via MCP; chaves travadas só pelo terminal |
| `/opc:review`, `/opc:adversarial-review`, `/opc:transfer` | `disable-model-invocation` |
| `/opc:command` | Rota síncrona arbitrária, fora do framework de jobs |
| `/opc:attach`, `opc monitor`, `opc gc`, `/opc:rescue` | Terminal/usuário ou fluxo de agente |
````

- [ ] **Step 5: Acrescentar a `docs/commands.md`**

````markdown
## `/opc:transfer`

Transfere a conversa atual do Claude Code para uma sessão OpenCode que pode ser retomada com `opencode -s <id>`. Só o usuário invoca (`disable-model-invocation: true`).

```
/opc:transfer [--source <arquivo.jsonl>] [--model <provider/model|alias>]
opc transfer  [--source <arquivo.jsonl>] [--model <provider/model|alias>] [--json]
```

- **Origem:** `--source` ou, por padrão, o transcript desta sessão (`OPC_COMPANION_TRANSCRIPT_PATH`, exportado pelo hook SessionStart). O `realpath` precisa estar sob `~/.claude/projects`. `OPC_TRANSFER_ALLOWED_ROOT` troca essa raiz — **só para testes**.
- **Modelo registrado:** `--model` (alias ou id completo `provider/model`) → `defaultModel`. Passa pela política (provider e modelo). É o modelo que o OpenCode usa ao retomar; o modelo original do Claude não é preservado.
- **Conversão:** cada prompt do usuário vira uma mensagem `user`; a resposta do assistente até o próximo prompt vira uma mensagem `assistant` com o texto, as chamadas de ferramenta como `[tool call: <nome>] <input>` e os resultados como `[tool result: ok|error] <saída>` (até 2000 caracteres cada). Blocos de raciocínio, sidechains, mensagens meta e comandos locais são ignorados e contados. Imagens viram `[image omitted]`. Textos acima de 64 KiB são truncados com marcador.
- **Importação:** o JSON (formato do `opencode export`) é gravado com modo 600 em `<estado>/transfer/`, importado com `opencode import <arquivo>` no diretório do workspace e removido em seguida.
- **Título:** `OPC: transfer: <título da sessão ou primeiro prompt>`, visível em `/opc:sessions`.

Exit codes:

| Código | Casos |
|---|---|
| 0 | Sessão importada |
| 2 | `NO_TRANSCRIPT`, `NOT_JSONL`, `NOT_FOUND`, `NOT_A_FILE`, `TRANSCRIPT_TOO_LARGE` (> 64 MiB), `EMPTY_TRANSCRIPT`, `NO_MODEL`, `MODEL_NEEDS_FULL_ID` |
| 4 | `TRANSCRIPT_OUTSIDE_ALLOWED_ROOT`, provider ou modelo negado |
| 5 | `OPENCODE_NOT_FOUND`, `UNSUPPORTED_VERSION` |
| 7 | `IMPORT_FAILED` (o `opencode import` não imprimiu `Imported session: <id>`), `EXPORT_SHAPE_INVALID` |

Exemplo (execução ao vivo da F5, caminhos redigidos):

```
# opc transfer

Sessão OpenCode criada: `ses_0000000000000000000000000000`
Título: OPC: transfer: live transfer OPC-F5-0000000000000
Modelo registrado: omniroute-personal/opencode-go/qwen3.8-max
Mensagens importadas: 4 (2 do usuário, 2 do assistente)
Origem: ~/.claude/projects/<projeto>/<sessão>.jsonl
Ignorados: 0 meta, 0 sidechain, 0 comandos locais, 0 blocos de raciocínio, 1 outros, 0 linhas inválidas

Para retomar no terminal:

    cd '<workspace>' && opencode -s ses_0000000000000000000000000000
```

### Ferramentas MCP

O servidor MCP `opc` expõe 25 ferramentas `opc_*` equivalentes aos comandos invocáveis pelo modelo, com as mesmas regras. A lista completa, o formato do resultado e o que não é exposto estão em [`architecture.md`](architecture.md#servidor-mcp-f5).
````

(Na Task 11, Step 5, trocar o bloco de exemplo pela saída real, com `~` e `<workspace>` no lugar dos caminhos pessoais.)

- [ ] **Step 6: Acrescentar a `docs/troubleshooting.md`**

```markdown
## MCP e transfer

- **O servidor `opc` não aparece em `/mcp`:** rode `/reload-plugins`; confira `node --version` (≥ 20) no PATH do Claude Code; rode `node <plugin>/scripts/mcp-server.mjs < /dev/null` no terminal — deve sair com código 0 sem imprimir nada no stdout.
- **Ferramenta devolve `MCP_CALL_TIMEOUT`:** o comando passou de 300 s (ou `waitTimeoutSec + 300 s`), em geral no primeiro boot do servidor OpenCode. Rode `/opc:status`; o job pode ter sido criado.
- **Jobs do MCP não aparecem em `/opc:status` da sessão:** o MCP não achou a sessão do Claude pelo processo pai; use `/opc:status --all`.
- **`TRANSCRIPT_OUTSIDE_ALLOWED_ROOT`:** o arquivo (ou o destino do symlink) não está sob `~/.claude/projects`.
- **`IMPORT_FAILED`:** a mensagem traz o fim da saída do `opencode import`. Rode `opencode import --help` para conferir a versão e repita com `--source` apontando para o JSONL.
- **A sessão transferida não aparece em `opencode session list`:** a lista é por projeto; rode o comando dentro do mesmo workspace em que o `/opc:transfer` foi executado.
```

- [ ] **Step 7: Acrescentar ao `README.md`, depois do mapa de comandos**

```markdown
## Servidor MCP

O plugin também registra o servidor MCP `opc` (stdio, sem dependências). Com ele, o Claude chama as ferramentas `opc_*` — modelos, providers, agentes, task/ask/plan, subagentes, orquestração, conclave, sessões, jobs e permissões — sem passar pelo Bash, com as mesmas regras dos comandos `/opc:`. Jobs longos rodam em background e devolvem o id. Não há ferramenta MCP para mudar configuração, `revert`, parar o servidor, review ou transfer. Detalhes em [`docs/architecture.md`](docs/architecture.md#servidor-mcp-f5).

Para levar a conversa atual para o OpenCode: `/opc:transfer` e depois `opencode -s <id>` no terminal ([`docs/commands.md`](docs/commands.md)).
```

- [ ] **Step 8: Rodar e ver passar**

Run: `node --test tests/unit/docs-f5.test.mjs && node scripts/scan-secrets.mjs docs/ README.md`
Expected: PASS (3 testes) e scanner sem achados.

- [ ] **Step 9: Commit (docs de dia a dia vão na branch da fase)**

```bash
git add plugins/opc/skills/opc-result-handling/SKILL.md docs/architecture.md docs/commands.md docs/troubleshooting.md README.md tests/unit/docs-f5.test.mjs
git commit -m "docs: document the opc MCP server and /opc:transfer"
```

---

### Task 11: Portão da F5

Checklist comum do mestre + testes ao vivo da fase + procedimentos manuais do operador. Modelos ao vivo (rodízio): `deepseek-v4.1-flash` + `kimi-k3` no conclave via MCP; `qwen3.8-max` registrado no transfer.

**Files:**
- Create: `tests/live/f5-mcp.mjs`, `tests/live/f5-transfer.mjs`
- Create: `docs/phases/F5-report.md`
- Modify: `CHANGELOG.md`, `docs/commands.md` (exemplo real), `docs/superpowers/plans/2026-09-26-opc-00-master.md` (seção "Interfaces novas da F5", conforme a regra de ajuste)

**Interfaces:**
- Consumes: tudo das Tasks 1–10; `validateExportShape` (Task 8) como detector de deriva do formato real do `opencode export`.
- Produces: evidência de aceite ao vivo, relatório, CHANGELOG, resposta do §15 item 10.

- [ ] **Step 1: Escrever os testes ao vivo**

`tests/live/f5-mcp.mjs`:

```js
// F5 live: the MCP server driven over stdio against the real OpenCode. Run only with OPC_LIVE=1.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { redact } from '../../plugins/opc/scripts/lib/redact.mjs';
import { cliJson, findJobId, runCli, startMcpClient } from '../helpers.mjs';

const LIVE = process.env.OPC_LIVE === '1';
const MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-personal/opencode-go/deepseek-v4.1-flash';
const SECOND = process.env.OPC_LIVE_MODEL_2 ?? 'omniroute-personal/opencode-go/kimi-k3';
const KEEP = process.env.OPC_LIVE_KEEP === '1';

function liveWorkspace(t) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f5-mcp-')));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f5-data-')));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 'opc-live@example.invalid'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 'opc live'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'README.md'), '# live f5\n\nA CLI prints progress to stderr and results to stdout.\n');
  execFileSync('git', ['add', '.'], { cwd: ws });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: ws });
  const env = { ...process.env, OPC_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: ws };
  delete env.OPC_COMPANION_SESSION_ID;
  delete env.OPC_COMPANION_TRANSCRIPT_PATH;
  t.after(async () => {
    await runCli(['setup', '--stop-server', '--force', '--confirmed-by-user'], { env, cwd: ws });
    if (!KEEP) {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  return { ws, env };
}

test('F5 live: MCP handshake, opc_models and a small conclave through opc_conclave', { skip: !LIVE && 'set OPC_LIVE=1', timeout: 30 * 60 * 1000 }, async (t) => {
  const { ws, env } = liveWorkspace(t);
  const setModel = await runCli(['config', 'set', 'defaultModel', MODEL], { env, cwd: ws });
  assert.equal(setModel.code, 0, setModel.stderr);

  const client = startMcpClient({ env, cwd: ws, timeoutMs: 15 * 60 * 1000 });
  t.after(() => client.close());
  const init = await client.initialize();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [...TOOL_NAMES]);

  const models = await client.callTool('opc_models', { allowed: true });
  assert.equal(models.isError, false, JSON.stringify(models.envelope));
  assert.ok(JSON.stringify(models.envelope.data).includes(MODEL.split('/').at(-1)), 'live model listed');

  const conclave = await client.callTool('opc_conclave', {
    question: 'In one short paragraph: should a command-line tool print progress to stderr or to stdout? State your position.',
    models: [MODEL, SECOND],
    quorum: 2,
    rounds: 1,
    judge: 'claude',
  });
  assert.equal(conclave.envelope.exitCode, 0, JSON.stringify(conclave.envelope));
  const jobId = findJobId(conclave.envelope.data, 'conc');
  assert.ok(jobId, JSON.stringify(conclave.envelope));

  let status = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    status = await client.callTool('opc_job_status', { jobId, wait: true, timeoutSec: 540 }, { timeout: 11 * 60 * 1000 });
    if (status.envelope.state !== 'wait_timeout') break;
  }
  assert.equal(status.envelope.exitCode, 0, JSON.stringify(status.envelope));

  const result = await client.callTool('opc_job_result', { jobId });
  assert.equal(result.isError, false, JSON.stringify(result.envelope));
  const cli = await cliJson(['result', jobId], { env, cwd: ws });
  assert.deepEqual(result.envelope.data, cli.data, 'MCP result equals the CLI result');
  assert.equal(result.envelope.data.group.id, jobId, 'group result shape (F3): { group, members }');
  assert.ok(Array.isArray(result.envelope.data.members) && result.envelope.data.members.length >= 2, 'conclave members listed');

  process.stdout.write(`${JSON.stringify(redact({ jobId, models: [MODEL, SECOND], result: result.envelope }), null, 2)}\n`);
});
```

`tests/live/f5-transfer.mjs`:

```js
// F5 live: transfer a synthetic Claude transcript into the real OpenCode and read it back. Run only with OPC_LIVE=1.
// Note: this creates a real session in the operator's OpenCode storage, scoped to a throwaway git workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateExportShape } from '../../plugins/opc/scripts/lib/transfer.mjs';
import { cliJson } from '../helpers.mjs';

const LIVE = process.env.OPC_LIVE === '1';
const MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-personal/opencode-go/qwen3.8-max';
const KEEP = process.env.OPC_LIVE_KEEP === '1';

function record(type, uuid, timestamp, message, extra = {}) {
  return JSON.stringify({ type, uuid, timestamp, isSidechain: false, sessionId: 'live-f5-transfer', message, ...extra });
}

test('F5 live: transfer → opencode session list → opencode export round trip', { skip: !LIVE && 'set OPC_LIVE=1', timeout: 10 * 60 * 1000 }, async (t) => {
  const marker = `OPC-F5-${Date.now()}`;
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f5-transfer-')));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f5-data-')));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-live-f5-projects-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (!KEEP) fs.rmSync(ws, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 'opc-live@example.invalid'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 'opc live'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'notes.md'), `${marker}\n`);
  execFileSync('git', ['add', '.'], { cwd: ws });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: ws });

  fs.mkdirSync(path.join(root, '-live'));
  const source = path.join(root, '-live', 'session.jsonl');
  fs.writeFileSync(source, [
    JSON.stringify({ type: 'custom-title', customTitle: `live transfer ${marker}`, sessionId: 'live-f5-transfer' }),
    record('user', 'u1', '2026-09-26T10:00:00.000Z', { role: 'user', content: `Remember the code word ${marker}.` }),
    record('assistant', 'a1', '2026-09-26T10:00:01.000Z', { id: 'm1', role: 'assistant', model: 'claude-live', content: [{ type: 'text', text: `Noted: ${marker}.` }] }),
    record('assistant', 'a2', '2026-09-26T10:00:02.000Z', { id: 'm1', role: 'assistant', model: 'claude-live', content: [{ type: 'tool_use', id: 'toolu_live', name: 'Read', input: { file_path: 'notes.md' } }] }),
    record('user', 'u2', '2026-09-26T10:00:03.000Z', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live', content: marker }] }),
    record('user', 'u3', '2026-09-26T10:00:04.000Z', { role: 'user', content: 'What is the code word?' }),
    record('assistant', 'a3', '2026-09-26T10:00:05.000Z', { id: 'm2', role: 'assistant', model: 'claude-live', content: [{ type: 'text', text: `The code word is ${marker}.` }] }),
  ].join('\n') + '\n');

  const env = { ...process.env, OPC_DATA_DIR: dataDir, OPC_TRANSFER_ALLOWED_ROOT: root };
  delete env.OPC_COMPANION_TRANSCRIPT_PATH;
  const r = await cliJson(['transfer', '--source', source, '--model', MODEL], { env, cwd: ws, timeoutMs: 180000 });
  assert.equal(r.code, 0, r.stderr);
  const { sessionID } = r.data;
  assert.match(sessionID, /^ses_/);

  const listed = JSON.parse(execFileSync('opencode', ['session', 'list', '--format', 'json'], { cwd: ws, env, encoding: 'utf8', timeout: 120000 }));
  const entry = listed.find((s) => s.id === sessionID);
  assert.ok(entry, `session ${sessionID} appears in opencode session list`);
  assert.equal(entry.title, `OPC: transfer: live transfer ${marker}`);
  assert.equal(entry.directory, ws);

  const exported = JSON.parse(execFileSync('opencode', ['export', sessionID], { cwd: ws, env, encoding: 'utf8', timeout: 120000 }));
  assert.deepEqual(validateExportShape(exported), [], 'real export still matches the shape the converter targets');
  assert.equal(exported.messages.length, 4);
  const texts = exported.messages.flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text));
  assert.ok(texts.includes(`Remember the code word ${marker}.`));
  assert.ok(texts.includes(`The code word is ${marker}.`));

  process.stdout.write(`\nTransferred session: ${sessionID}\nManual check (operator): ${r.data.resumeCommand}\n` +
    `Then ask: "Qual é a palavra-código?" — expected answer contains ${marker}.\n` +
    (KEEP ? '' : 'Re-run with OPC_LIVE_KEEP=1 to keep the workspace for the manual resume.\n'));
});
```

Conferir que ficam fora do CI: `node --test tests/live/f5-mcp.mjs tests/live/f5-transfer.mjs` sem `OPC_LIVE` → 2 testes `skipped`.

- [ ] **Step 2: Suíte completa**

Run: `npm test 2>&1 | tee /tmp/opc-f5-npm-test.txt`
Expected: 100% verde (F0–F5). Anexar o resumo (`# tests`, `# pass`, `# fail`) ao relatório.

- [ ] **Step 3: Testes ao vivo (operador presente; criam uma sessão real no storage do OpenCode, num workspace git descartável)**

```bash
for i in 1 2 3; do OPC_LIVE=1 node --test tests/live/f5-mcp.mjs 2>&1 | tee -a /tmp/opc-f5-live-mcp.txt; done
OPC_LIVE=1 OPC_LIVE_KEEP=1 node --test tests/live/f5-transfer.mjs 2>&1 | tee /tmp/opc-f5-live-transfer.txt
OPC_LIVE=1 node tests/live/contract.mjs 2>&1 | tee /tmp/opc-f5-contract.txt
```

Expected: `f5-mcp` passa em ≥ 2 de 3 (depende do modelo); `f5-transfer` passa e imprime a linha `Manual check (operator): cd … && opencode -s ses_…` (caminho entre aspas só quando precisa — `shellQuote` da F3); `contract.mjs` sem divergência (ou divergência registrada e fake atualizado). Redigir caminhos pessoais antes de anexar.

- [ ] **Step 4: Procedimentos manuais do operador (registrar cada resultado no relatório)**

**4a. O Claude usa as ferramentas MCP numa sessão real:**

1. Instalar/atualizar o plugin a partir do marketplace local do repositório e rodar `/reload-plugins`.
2. `/mcp` → servidor do plugin `opc` conectado com 25 ferramentas. Anotar o nome exato com que as ferramentas aparecem (esperado `mcp__plugin_opc_opc__opc_models`; A CONFIRMAR).
3. Pedir: "Usando as ferramentas MCP do opc (não o Bash), liste os modelos permitidos." → o Claude chama `opc_models` com `allowed: true`; a lista bate com `/opc:models --allowed`.
4. Pedir: "Via MCP, rode um conclave com deepseek-v4.1-flash e kimi-k3 sobre 'progresso deve ir para stderr ou stdout?', espere o resultado e sintetize." → `opc_conclave` → `opc_job_status` → `opc_job_result`; síntese apresentada.
5. `/opc:status` na mesma sessão lista o job do conclave → confirma a resolução da sessão do Claude pelo processo pai (§15 item 9 no MCP). Se não listar, registrar e usar `/opc:status --all`.
6. Com `approver: "user"`, num repositório descartável, pedir: "Via MCP, rode uma task com write que execute `rm -rf build`." → job em `waiting_permission`; o Claude **precisa** perguntar com AskUserQuestion antes de `opc_permissions_reply`. Responder "rejeitar". Conferir que a chamada saiu com `reply: "reject"` e sem `confirmedByUser` indevido.

**4b. Sessão transferida retomável:**

1. Com o workspace mantido pelo `OPC_LIVE_KEEP=1`, rodar a linha `cd … && opencode -s ses_…` impressa no Step 3.
2. Na TUI, perguntar "Qual é a palavra-código?" → a resposta contém o marcador `OPC-F5-…` (histórico transferido chegou ao modelo).
3. Numa sessão real do Claude num repositório descartável, trocar duas mensagens, rodar `/opc:transfer --model omniroute-personal/opencode-go/qwen3.8-max`, retomar com o `opencode -s` impresso e conferir o histórico na TUI.
4. Remover os workspaces descartáveis depois da conferência (pedido explícito do operador; as sessões importadas continuam no storage do OpenCode, pois o plugin não apaga sessões — D15).

- [ ] **Step 5: Exemplo real na documentação**

Substituir o bloco de exemplo do `/opc:transfer` em `docs/commands.md` pela saída Markdown real do Step 4b.3 (rodar o mesmo `opc transfer` sem `--json`), com `~`, `<projeto>`, `<sessão>` e `<workspace>` no lugar dos caminhos pessoais. Rodar `node scripts/scan-secrets.mjs docs/ README.md` → sem achados.

- [ ] **Step 6: Relatório `docs/phases/F5-report.md`**

Criar com esta estrutura, preenchendo cada item com `PASSOU` / `N/A` (justificado) / `NÃO VALIDADO` (motivo) e a evidência (arquivo de saída, trecho redigido):

```markdown
# F5 — Servidor MCP e transfer · Relatório de fase

- **Data:** <data da execução>
- **Branch / PR:** feat/opc-f5 / <link>
- **Ambiente:** Node <versão>; OpenCode <versão>; Claude Code <versão>; Linux
- **Modelos ao vivo:** deepseek-v4.1-flash, kimi-k3 (conclave via MCP); qwen3.8-max (transfer)

## 1. `npm test`

<resumo # tests / # pass / # fail e duração>

## 2. Aceite (integração)

| Item (spec §13.3 F5) | Teste | Resultado |
|---|---|---|
| Handshake e `tools/list` | `mcp-server.test.mjs` (handshake, negociação, tools/list, erros de protocolo) | |
| Cada ferramenta chama a mesma função de `lib/` | `mcp-tools.test.mjs` (argv exato por ferramenta, dispatch espião); pares CLI × MCP em `mcp-server`, `mcp-jobs`, `mcp-permissions` | |
| Regras do aprovador e confirmações no MCP | `mcp-permissions.test.mjs` | |
| Sem escrita de config via MCP | `mcp-tools.test.mjs` (allowlist) + `mcp-permissions.test.mjs` (hash do config.json) | |
| Transfer gera JSON válido contra o formato do `opencode export` | `transfer.test.mjs` (unit, `validateExportShape` sobre o export real higienizado) + `transfer.test.mjs` (integração, oráculo independente do fake) | |
| Review Focus 1–5 | ver seção "Review Focus" do plano | |

## 3. Aceite (ao vivo)

| Item | Evidência | Resultado |
|---|---|---|
| MCP dirigido por cliente stdio contra o OpenCode real: listar modelos e conclave via `opc_conclave` (3 execuções, ≥ 2) | `/tmp/opc-f5-live-mcp.txt` | |
| Sessão transferida aparece em `opencode session list` | `/tmp/opc-f5-live-transfer.txt` | |
| Export real ainda casa com `validateExportShape` (deriva de formato) | idem | |
| `contract.mjs` | `/tmp/opc-f5-contract.txt` | |

## 4. Procedimentos manuais do operador

| Procedimento | Resultado | Observações |
|---|---|---|
| 4a.2 `/mcp` com 25 ferramentas; nome exato das ferramentas no Claude | | |
| 4a.3 Claude usa `opc_models` | | |
| 4a.4 Claude roda conclave via MCP | | |
| 4a.5 Job do MCP aparece em `/opc:status` da sessão | | |
| 4a.6 Permissão destrutiva via MCP perguntada ao usuário | | |
| 4b.2 `opencode -s` retoma a sessão transferida com o histórico | | |
| 4b.3 `/opc:transfer` numa sessão real do Claude | | |

## 5. Itens A CONFIRMAR

- **§15 item 10 — formato de `opencode export`/`import`:** <resposta; ver texto-base abaixo>
- **Nome das ferramentas MCP de plugin no Claude Code:** <resposta do 4a.2>
- **§15 item 9 aplicado ao MCP (ppid = processo do Claude):** <resposta do 4a.5>

Texto-base do §15 item 10 (evidência do planejamento, confirmar com o Step 3):
`opencode export <id>` imprime `{ info: Session, messages: [{ info: Message, parts: Part[] }] }` (só JSON em stdout). `opencode import <arquivo>` decodifica `Session.Info` sobrescrevendo `projectID`, `directory` e `path` com os do diretório onde roda, faz upsert da sessão pelo `info.id` do arquivo, insere mensagens e partes sem sobrescrever existentes e imprime `Imported session: <id>`; falhas podem sair com exit 0 (`Failed to read session data`). O conversor gera ids novos no formato `Identifier` do OpenCode (sessão `descending`, mensagens/partes `ascending`), só com partes `text`, e o round trip ao vivo (`transfer` → `session list` → `export` → `validateExportShape`) confirma a compatibilidade.

## 6. Desvios

- `opc_catalog` exposto além da lista da spec (read-only).
- `revert`/`unrevert`, `setup`, config, review, transfer, `command`, `attach`, `monitor`, `gc`, `rescue` não expostos via MCP (decisão de segurança).
- `transfer` não valida o modelo no catálogo (não sobe servidor); só política.
- <outros encontrados na execução>

## 7. Documentação e segredos

- Docs: architecture (MCP), commands (transfer + ferramentas MCP), troubleshooting, README, skill `opc-result-handling`.
- `node scripts/scan-secrets.mjs docs/ README.md`: <resultado>

## 8. Git

- Commits: <lista `git log --oneline main..feat/opc-f5`>
- PR: <link>; merge: <após aviso ao operador>
```

- [ ] **Step 7: `CHANGELOG.md`**

Acrescentar sob `## [Unreleased]` (criar os subtítulos que faltarem):

```markdown
### Added
- F5: servidor MCP `opc` (stdio, MCP 2025-06-18, sem dependências) com 25 ferramentas `opc_*` que passam pelo mesmo despachante da CLI; jobs longos em background por padrão, com `wait` limitado a 540 s.
- F5: `/opc:transfer` e `opc transfer [--source <jsonl>] [--model <m>]`: converte o JSONL do Claude Code para o formato do `opencode export`, importa com `opencode import` e imprime `opencode -s <id>`.

### Changed
- `resolveArgv` ignora `--args-stdin` e `readRawArgs` ignora `--raw-args-stdin` depois de `--` (texto livre após `--` nunca aciona leitura do stdin); sem `--`, comportamento igual.

### Security
- Via MCP não há escrita de configuração, `revert`/`unrevert`, `--stop-server`, review nem transfer; `opc_permissions_reply` aceita só `once`/`reject` e repassa `--confirmed-by-user` apenas quando o Claude declara a aprovação do usuário.
- `transfer` só lê transcripts sob `~/.claude/projects` (realpath) e grava o JSON temporário com modo 600.
```

- [ ] **Step 8: Registrar as interfaces novas no mestre**

Em `docs/superpowers/plans/2026-09-26-opc-00-master.md`, acrescentar ao fim do "Contrato de interfaces" a subseção `### Acréscimos da F5` com o bloco "Interfaces novas" deste plano (copiado sem alteração) e, em "Estrutura de arquivos", os arquivos novos da tabela "Estrutura de arquivos da fase".

- [ ] **Step 9: Aviso, commit, push e PR (com autorização)**

Avisar o operador com o resumo do relatório. Com autorização explícita:

```bash
git add tests/live/f5-mcp.mjs tests/live/f5-transfer.mjs docs/phases/F5-report.md CHANGELOG.md docs/commands.md docs/superpowers/plans/2026-09-26-opc-00-master.md
git commit -m "docs: add F5 gate report, live tests and changelog"
git push -u origin feat/opc-f5
gh pr create --base main --head feat/opc-f5 --title "feat: F5 MCP server and transfer" --body-file docs/phases/F5-report.md
```

Reler cada mensagem antes do commit: sem `Co-Authored-By`, `Signed-off-by` ou "Generated with". O corpo do PR é o relatório, sem assinatura de ferramenta. Merge só depois de avisar o operador.

- [ ] **Step 10: Gravação dupla**

1. `.ai-data/decisions-<DDMMYY>.md` no repositório (não versionado): decisões da F5 (mesma função via `main` do companion da F0; o que não é exposto; envelope; modelo do transfer; resposta do §15 item 10).
2. Colmeia, banco `myprojects`, via `mnemosyne_remember`: um fato por item, prefixado `[DD/MM/AAAA]`, sem segredos — (a) formato do export/import do OpenCode 1.18.32; (b) algoritmo de ids do OpenCode; (c) decisão de exposição MCP; (d) nome real das ferramentas MCP de plugin no Claude Code (do 4a.2).
3. Avisar o operador com a contagem por banco.

---

## Autorrevisão

**1. Cobertura da spec (F5):**

| Requisito | Onde |
|---|---|
| `scripts/mcp-server.mjs` stdio, zero deps, declarado no plugin | Tasks 2, 5 |
| Ferramentas espelhando os comandos invocáveis, com as mesmas regras | Task 4 (catálogo + allowlist), Task 1/5 (mesmo `main` da F0, injetado como `dispatch`) |
| `opc_models/providers/agents/config_get/task/ask/plan/subagent/orchestrate/conclave/session_*/job_*/permissions_*` | Task 4 (25 ferramentas; `opc_catalog` extra) |
| Nada que exija o usuário exposto sem as mesmas confirmações | Decisão 3 (não expostos) + Task 7 |
| Long-running em background com `wait` limitado | Task 4 (argv), Task 6 (`wait=true is bounded`) |
| Erros → `isError` com mensagem redigida e código tipo exit | Task 4 (`buildEnvelope`), Task 6 (política) |
| `/opc:transfer` (JSONL → export → import), `disable-model-invocation` | Tasks 8, 9 |
| `OPC_COMPANION_TRANSCRIPT_PATH` por padrão; realpath sob `~/.claude/projects`; `OPC_TRANSFER_ALLOWED_ROOT` só para testes | Task 8 (`resolveTranscriptPath`), Task 9 |
| Temp 600, `opencode import`, parse do id, dica `opencode -s` | Tasks 8, 9 |
| Fixtures `export-sample.json` (real higienizado) e `claude-transcript-sample.jsonl` | Task 8 |
| Fake `opencode import` validando a forma e imprimindo a linha real | Task 9 |
| Aceite integração: handshake/tools/list; mesma função; aprovador/confirmações; sem escrita de config; JSON válido contra o export | Tasks 5, 4+5+6+7, 7, 4+7, 8+9 |
| Aceite ao vivo: Claude usa as ferramentas; sessão transferida em `session list` e retomável | Task 11 (Steps 3–4) |
| §15 item 10 | Evidências + Task 11 (relatório) |
| Docs: `commands` (transfer), `architecture` (MCP), README | Task 10 |
| §14.3 desvio do transfer (paridade entregue na F5) | Task 9 + relatório |

**2. Placeholders:** os únicos valores em aberto são dados de execução (ids, versões, links) que o relatório e o exemplo da doc recebem no portão; nenhum passo de código depende deles.

**3. Consistência de tipos:** o `main(argv, { env, cwd, stdin, stdout, stderr, onError })` da F0 é importado como `dispatch` e usado igual nas Tasks 1 (teste do contrato), 4 (espião com a mesma forma) e 5 (`mcp-server.mjs`); `createToolCaller` recebe `dispatch` com esse formato; `findJobId(value, kind)`, `cliJson(args, { env, cwd })`, `writeTestConfig(env, patch)` e `startMcpClient({ env, cwd, timeoutMs, nodeArgs })` têm a mesma assinatura em todos os testes; `execute(ctx, { source, model })` do `transfer` devolve os campos que `renderTransfer` e os testes leem.

**4. Review Focus:** cada uma das 5 linhas tem teste na tarefa dona (ver colchetes na seção).


---

## Progresso / achados (atualizado em 02/10/2026)

**Estado:** F5 em andamento, branch `feat/opc-f5`. Tasks 1–6 de 11 concluídas, com todos os passos marcados acima. Suíte da branch: 1871 pass, 0 fail, 1 skipped (o cenário cross-UID, que exige root). A `main` trouxe os PRs #10 (execuções de teste sempre terminam) e #11 (cancelamento durante a criação da sessão), já mergeados e incorporados à branch.

### Achados de revisão por task e resolução

Cada task passou por revisão independente e por rodadas de correção até todos os achados ficarem `ADDRESSED`. Os commits de correção estão entre parênteses.

| Task | Achado | Resolução |
|---|---|---|
| 1 | Teste de compatibilidade do `conclave` com um único modelo (exige ≥ 2 membros) e `configuredEnv` ignorando o cenário | Dois modelos do fixture e cenário repassado (`1ba556a`, `0a09904`) |
| 1 | Faltavam testes de `normalizeResumeFlag` após `--` e do dispatcher com `commandLoader`/`contextFactory` injetados | Testes acrescentados (`1ba556a`) |
| 1 | Cauda de stderr sem máscara no erro de timeout de `startMcpClient`; helper sem tratar `error`/saída do filho; bloco de helpers fora do delimitador F5 | Cauda redigida, falha rápida no `error`/`exit`, bloco F5 delimitado (`1ba556a`) |
| 1 | Rodada 3 (controlador): `orchestrate` precisa de `decompose-ok`, e `--wait-timeout 1` pode sair com exit 6 (spec, códigos de saída) | Teste usa o fixture de orquestração e aceita exit 6 com job id (`fcef045`) |
| 2 | Crítico: nome de ferramenta que é segredo registrado vazava o prefixo (truncava antes de redigir) | Redigir antes de truncar, com teste (`6329b22`) |
| 2 | Linha acima do limite: o resto da mesma linha virava nova requisição; falha síncrona de `write` era engolida | Descarta até o próximo `\n`; a falha de escrita rejeita `serveStdio` (`6329b22`) |
| 3 | `additionalProperties: false` devolvia `$.extra…` (sufixo em nome curto) | Caminho exato para nomes curtos (`fe6697a`) |
| 4 | Crítico: `maskInputEcho` devolvia os 12 primeiros caracteres da entrada | Máscara integral (`7bdf8ec`) |
| 4 | `opc_conclave.mode` admitia `review` (envia o diff a terceiros sem confirmação) | Enum só `opinion`/`debate`, com teste de rejeição (`7bdf8ec`) |
| 4 | Envelope só com `redactText`; `data.error` sem `error`; `maxSubtasks` 2..20; faltava aviso de `data` em Markdown nas permissões | `redactOutput`/`safeOutputText`, `error` preenchido, faixa 2..10, descrições corrigidas (`7bdf8ec`) |
| 5 | Versão fictícia `0.0.0` quando o `plugin.json` não podia ser lido (handshake enganoso) | Falha explícita e comparação da versão exata (`6497a6b`) |
| 6 | Teste de paridade não comparava `status`/`result`/`errorCode`; teste de timeout não provava job ativo antes do cancel; permissão read-only checava só a primeira regra | Comparação completa, estado ativo antes do cancel, varredura de todas as regras (`eaa87eb`) |
| 6 | Falhas 183 e 187 na suíte: cenário `slow` com prazo fixo e fake sem a rota `todo` | Prazo configurável e rota `todo` no fake (`10b9063`) |
| 6 | Flake real restante (ping esperava atrás de `tools/call` longo) | Ver "Riscos e observações" (`ee35930`) |

Observação aceita na Task 3: nomes desconhecidos com mais de 12 caracteres continuam truncados no caminho do erro (comportamento anterior à correção, sem vazamento de valor; não corrigido).

### Pendências abertas

- [ ] Task 7: regras do aprovador, confirmações e ausência de escrita de config pelo MCP.
- [ ] Task 8: núcleo do transfer.
- [ ] Task 9: `transfer`, `/opc:transfer` e `opencode import` no binário falso.
- [ ] Task 10: skill e documentação (MCP e transfer): README, CHANGELOG, `docs/architecture.md`, `docs/commands.md`, `docs/troubleshooting.md`.
- [ ] Task 11: portão. Inclui verificação ao vivo (`f5-mcp`, `f5-transfer`), procedimentos manuais do operador, relatório `docs/phases/F5-report.md` e registro das interfaces no mestre.
- [ ] PR `feat/opc-f5` → `main`, com autorização do operador, e gravação dupla (`.ai-data` + colmeia).
- [ ] Revisão da branch inteira da F5 antes do PR.

### Riscos e observações

- **Flake corrigido (Task 6).** `serveStdio` processava as requisições em série, então um `ping` esperava atrás de um `tools/call` longo e o teste `espera de tarefa lenta tem limite e atende outras requisições` falhava de forma intermitente. A correção (`ee35930`) serve as requisições de forma concorrente (`inFlight` no lugar da fila serial) e acrescenta teste unitário. Isso satisfaz o item 3 do "Review Focus" (um `ping` é respondido enquanto outra chamada espera). Após a correção: suíte 1871/0 e `mcp-jobs` 10/10. Três rodadas automáticas de correção não a resolveram (o implementador recebeu a falha sem nome nem diagnóstico); o supervisor parou após a terceira e o diagnóstico e a correção vieram do controlador.
- **Roteador e modelos.** Implementador e revisor rodam no Codex pela rota `mix/gpt-6.1-sol` (a única rota 6.1 permitida), com fallback `gpt-6-<tier>` → `gpt-5.6-<tier>` quando o gateway recusa. Houve indisponibilidades 503 do roteador durante a execução.
- **Janela ociosa.** Cerca de 4 h sem progresso em 01/10 (03:31–07:46), por falta de notificação e outages 503 do roteador.
- **Sandbox.** Testes com socket e subprocesso falham no sandbox do implementador (`listen EPERM`); por isso a suíte completa é sempre rodada pelo controlador, fora dele, antes de cada marca de "concluída".
- **Pendente de validação humana.** Uso real das ferramentas MCP numa sessão do Claude Code e retomada de sessão transferida com `opencode -s <id>` seguem `NÃO VALIDADO` até o portão (Task 11, passo 4).
