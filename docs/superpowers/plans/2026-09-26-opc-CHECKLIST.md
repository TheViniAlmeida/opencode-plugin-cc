# opc — Checklist de execução

> As fases F0–F5 abaixo são histórico. Na F6, OpenCode V2 (≥ 2.0.22) substitui a API V1. Consulte [o relatório da F6](../../phases/F6-report.md) para o portão atual.

Checklist mestre para retomar o trabalho em qualquer sessão. Marque os itens conforme concluídos
(`- [x]`) e registre a data ao lado dos marcos.

- **Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3 + fatos do binário)
- **Plano mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md`
- **Planos por fase:** `docs/superpowers/plans/2026-09-26-opc-F*.md`
- **Modo de execução escolhido:** **subagent-driven** (26/09/2026)
- **Mundo:** `myprojects` · **Repo:** `github.com/TheViniAlmeida/opencode-plugin-cc`

---

## Como retomar numa sessão nova

1. Ler este checklist, o mestre (seções "Contrato de interfaces", "Convenções de teste", "Regras
   de git", "Portão", "Registro de reconciliação") e o plano da próxima fase pendente.
2. Carregar a skill `superpowers:subagent-driven-development` e executar a fase tarefa por
   tarefa: um implementador novo por tarefa, um revisor novo antes da próxima, e uma revisão
   da branch inteira no fim da fase.
3. Instruções obrigatórias para **todo** subagente, implementador ou revisor:
   - nunca rodar comando destrutivo (`rm`, `rm -rf`, `find -delete`, `git reset/clean`,
     `push --force`…); precisando de diretório limpo, criar um novo;
   - nunca fazer operação git que mude estado sem a autorização da fase (ver Pré-execução);
   - nunca rodar teste ao vivo (`OPC_LIVE=1`, `scripts/run-tests.mjs live`) fora da tarefa
     Portão;
   - commits em Conventional Commits, **sem** `Co-Authored-By`, `Signed-off-by` ou
     "Generated with";
   - nunca sinalizar processo sem conferir a identidade; os `opencode serve` preexistentes do
     operador não podem ser tocados.
4. Ao fechar cada portão, antes da fase seguinte:
   - revisar o plano da próxima fase com as respostas dos itens A CONFIRMAR;
   - commitar como `docs: adjust <fase> plan after <fase anterior> gate`.

---

## Pré-execução

- [ ] Operador revisou os planos (mestre + fases) e confirmou que capturam o pedido.
- [ ] **[PAUSA-APROVAÇÃO]** Autorização para o primeiro commit na `main`:
      `docs: add opc design spec and implementation plans`, contendo `docs/superpowers/**`.
- [ ] **[PAUSA-APROVAÇÃO]** Push da `main`, e confirmação de que o remoto
      `TheViniAlmeida/opencode-plugin-cc` é o destino certo (hoje sem commits).
- [ ] Decidir sobre os diretórios vazios deixados pela escrita do plano da F0:
      `/tmp/opc-env-pc7uYs` e `/tmp/opc-env-wocZJU`. Remover só com ordem explícita.
- [ ] Gravação dupla da fase de design (§3.3 do kernel):
  - [ ] `.ai-data/decisions-260926.md`: decisões D1–D15 da spec, abordagem A, cortes,
        convenção de argumentos, subagent-driven;
  - [ ] colmeia `myprojects`, fatos do binário do OpenCode 1.18.32:
    - `always` vale para a instância e passa por cima do `deny`;
    - PATCH de permissão anexa as regras;
    - filhas herdam só `deny`;
    - `StructuredOutput` é uma ferramenta;
    - SessionEnd tem 1,5 s;
    - `serve --port 0` sobe na 4096;
    - `serve` ignora SIGTERM;
  - [ ] avisar o operador com a contagem por banco.
- [ ] Definir a autorização de git válida para a execução: branch `feat/opc-<fase>`, commits
      por tarefa e um PR por fase. Merge só depois de avisar o operador.

---

## F0 — Fundação e conexão · `2026-09-26-opc-F0-foundation.md` · branch `feat/opc-f0`

Ao vivo: `omniroute-personal/opencode-go/deepseek-v4.1-flash`

- [x] Task 1: Esqueleto do repositório, runner de testes e helpers
- [x] Task 2: Scanner de segredos e CI
- [x] Task 3: Erros tipados e redação (`opc-error`, `redact`)
- [x] Task 4: Argumentos sem expansão (`args`), com o caso do apóstrofo
- [x] Task 5: Identidade de processo, spawn destacado e kill em grupo (`process`)
- [x] Task 6: Locks com dono verificável (`locks`)
- [x] Task 7: Diretório de dados e estado por workspace (`state`)
- [x] Task 8: Config base e merge restritivo (`config`)
- [x] Task 9: Cliente HTTP tipado (`http`)
- [x] Task 10: Servidor OpenCode falso e binário falso (com `registerFakeExtension`)
- [x] Task 11: SSE — parser e `EventHub`
- [x] Task 12: Ciclo de vida do servidor (`server`)
- [x] Task 13: Contexto da CLI e renderização (`context`, `render`)
- [x] Task 14: CLI `opc` (despacho dinâmico), `/opc:setup` e manifestos do plugin
- [x] Task 15: Portão da F0
  - [ ] `npm test` verde, também em Node 20 (hoje só validado no 22) — Node 22: 218/218; Node 20 NÃO VALIDADO (relatório)
  - [x] ao vivo: `f0-connection` (porta ≠ 4096, reaproveitamento, parada, sem órfão, serves do operador intactos)
  - [x] `probe-permission-precedence` → responde os itens 1, 2, 4 e 5 do §15 (itens 2 e 4b inconclusivos ao vivo; ver relatório)
  - [x] `contract.mjs`
  - [ ] **manual (operador):** instalar o plugin no Claude e confirmar o id do diretório de dados (§15, item 8) — NÃO VALIDADO (depende do operador; ver relatório)
  - [x] docs: README inicial, `installation`, `troubleshooting`, `architecture`
  - [x] `docs/phases/F0-report.md` + CHANGELOG + scan de segredos
  - [x] **[PAUSA-APROVAÇÃO]** push + PR (#1, mergeado em 26/09/2026) · aviso ao operador · gravação dupla (sem registro no relatório)
- [x] Ajustar o plano da F1 com as respostas do §15 (itens 1, 2, 4, 5 e 8)

## F1 — Descoberta, configuração e onboarding · `2026-09-26-opc-F1-discovery-config.md` · branch `feat/opc-f1`

Ao vivo: `kimi-k3`

- [x] Task 1: API de leitura e `connectApi`
- [x] Task 2: Fixtures, rotas de dados do servidor falso e helpers de teste
- [x] Task 3: `models.mjs` — catálogo, IDs, aliases, variants e globs
- [x] Task 4: `policy.mjs` — allow/deny e modelos fixados
- [x] Task 5: `config.mjs` (parte A) — esquema completo, segredos, chaves travadas, merge restritivo
- [x] Task 6: `config.mjs` (parte B) — edição, coerção, normalização, validação contra o servidor
- [x] Task 7: `tty.mjs` — prompts de terminal com streams injetáveis
- [x] Task 8: `onboarding.mjs` — etapas, rascunho e commit atômico
- [x] Task 9: Renderizadores da F1
- [x] Task 10: `providers`, `models`, `agents`, `catalog`
- [x] Task 11: Comando `config` (get/set/unset/add/remove/show/validate/path, `--tty-confirm`)
- [x] Task 12: Assistente `opc config init` e confirmação por TTY
- [x] Task 13: Onboarding pelo `setup` (inclui o teste `no-config-first-run`)
- [x] Task 14: Slash commands da F1
- [x] Task 15: Portão da F1
  - [x] ao vivo: `f1-discovery`, `f1-fixture-coverage`, `contract.mjs`
  - [ ] **manual (operador):** onboarding guiado completo no Claude (com `OPC_DATA_DIR` descartável) — NÃO VALIDADO (depende do operador; ver relatório)
  - [ ] **manual (operador):** `opc config init` no terminal — NÃO VALIDADO (depende do operador; ver relatório)
  - [x] política de mundo: `omniroute-work/*` e `work-*` escondidos e recusados
  - [x] docs `configuration`, `commands` (descoberta e config), README (início rápido) · relatório · CHANGELOG
  - [x] **[PAUSA-APROVAÇÃO]** push + PR (#2, mergeado em 26/09/2026) · aviso · gravação dupla (N/A no relatório)
- [x] Ajustar o plano da F2a

## F2a — Núcleo de execução · `2026-09-26-opc-F2a-execution-core.md` · branch `feat/opc-f2a`

Ao vivo: `deepseek-v4.1-flash`

- [x] Task 1: `lib/errors.mjs` — classificação de erros
- [x] Task 2: `lib/policy.mjs` — perfis, invariantes, destrutivos, aprovador
- [x] Task 3: `lib/routing.mjs` — resolução de modelo, variant e agente
- [x] Task 4: `lib/args.mjs` — `parsePromptArgs` e `readRawArgs`
- [x] Task 5: `lib/runner.mjs` — turno completo (inclui reaplicar o perfil às filhas)
- [x] Task 6: `lib/api.mjs` — operações de escrita
- [x] Task 7: `lib/jobs.mjs` — registros, limites, worker, espera, cancel
- [x] Task 8: `lib/render.mjs` — status, lista, resultado e pedidos
- [x] Task 9: Servidor falso — sessões, prompt, permissões, perguntas e cenários
- [x] Task 10: `task`, `ask`, `plan` e o worker (inclui `prompt-roundtrip`)
- [x] Task 11: `status`, `result`, `cancel`
- [x] Task 12: Resume, concorrência por sessão e `task-resume-candidate`
- [x] Task 13: `/opc:permissions` — list, reply, answer
- [x] Task 14: `opc gc`
- [x] Task 15: Skill `opc-result-handling`, frontmatter e exit codes
- [x] Task 16: Portão da F2a
  - [x] ao vivo:
    - [x] read-only mandado editar → checksum inalterado
    - [x] `.env` negado
    - [x] bash negado
    - [x] `rm -rf` no perfil `write` → pedido que vai ao usuário
    - [x] background + `status --wait` + `result`
    - [x] cancel
    - [x] resume
  - [x] §15, item 3 (PATCH anexa?) e item 6 (formato do `messageID`) confirmados ao vivo
  - [x] teste de grep em `.env` (§15, item 4). Se vazar: registrar `NÃO VALIDADO` e abrir o plano B do §8.1
  - [x] docs `commands`, `permissions` · relatório · CHANGELOG
  - [x] **[PAUSA-APROVAÇÃO]** push + PR (#3, mergeado em 28/09/2026) · aviso · gravação dupla (colmeia: PENDENTE-COLMEIA no relatório)
- [ ] Ajustar o plano da F2b (premissas conferidas na Task 1 da F2b; sem commit `docs: adjust` dedicado)

## F2b — Review, gate, rescue, hooks · `2026-09-26-opc-F2b-review-gate-hooks.md` · branch `feat/opc-f2b`

Ao vivo: `qwen3.8-max`

- [x] Task 1: Premissas da F2a, branch e infraestrutura de teste
- [x] Task 2: Adaptador de jobs e coordenação por `server.lock`
- [x] Task 3: Prompts, schema e `lib/prompts.mjs`
- [x] Task 4: `lib/git.mjs` — alvo, coleta inline/em partes, estimativa (inclui `huge-diff`)
- [x] Task 5: Renderização do review
- [x] Task 6: `resolveTurnModel` em `routing.mjs`
- [x] Task 7: `review` e `adversarial-review` (+ `result` de jobs de review)
- [x] Task 8: Registro de sessões do Claude, entrada de hook e contexto por `cwd`
- [x] Task 9: Hooks `SessionStart`/`SessionEnd`, reaper e `hooks.json`
- [x] Task 10: Stop gate (`hook-stop`)
- [x] Task 11: `setup --enable/--disable-review-gate` e `--stop-server` com jobs ativos
- [x] Task 12: Slash commands `review`, `adversarial-review`, `rescue` e agente `opc-rescue`
- [x] Task 13: Skills `opc-runtime`, `opc-result-handling`, `opc-prompting`
- [x] Task 14: Portão
  - [x] ao vivo:
    - [x] review com schema válido (3 execuções, ≥ 2 válidas)
    - [x] adversarial-review com foco
    - [x] stop gate (3 execuções, ≥ 2 `BLOCK`)
    - [x] rescue (companion; a pergunta no Claude real é NÃO VALIDADO)
  - [ ] **manual (operador):** `/clear` no Claude não derruba o servidor; o `ppid` do hook é o Claude (§15, item 9) — NÃO VALIDADO (depende do operador; ver relatório)
  - [x] docs `commands`, `permissions` (stop gate), README (mapa do mínimo) · relatório · CHANGELOG
  - [x] **[PAUSA-APROVAÇÃO]** push + PR (#4, mergeado em 28/09/2026) · aviso · gravação dupla (NÃO VALIDADO no relatório)
- [x] **Marco: mínimo (paridade com o codex) entregue** — data: 28/09/2026 (merge da F2b; itens manuais do operador seguem NÃO VALIDADOS)
- [x] Ajustar o plano da F3

## F3 — Sessões, subagentes, commands, attach · `2026-09-26-opc-F3-sessions-subagents.md` · branch `feat/opc-f3`

Ao vivo: `deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3`

- [x] Task 0: Pontos de encaixe e branch
- [x] Task 1: Servidor falso F3, tmux falso e helpers de teste
- [x] Task 2: Operações de sessão na `lib/api.mjs`
- [x] Task 3: Renderizadores F3 e `shellQuote`
- [x] Task 4: Conexão, descoberta e política em `context.mjs`; comando `sessions`
- [x] Task 5: `session new | show | fork | children | diff | todo`
- [x] Task 6: `session revert | unrevert | summarize`, com confirmação, lock e diff afetado
- [x] Task 7: Grupos de jobs em `lib/jobs.mjs`
- [x] Task 8: `dispatchSubagent` (sessão filha com fallback para `subtask`)
- [x] Task 9: Comando `subagent` e worker coordenador
- [x] Task 10: `status`, `result`, `cancel` cientes de grupos
- [x] Task 11: Comando `command`
- [x] Task 12: `attach.secret` e comando `attach` (inclusive `--pane`)
- [x] Task 13: Slash commands e skill `opc-result-handling`
- [x] Task 14: Documentação da fase
- [x] Task 15: Testes ao vivo da F3
- [x] Task 16: Portão da F3
  - [x] ao vivo:
    - [x] `session new`
    - [x] fork e revert conferidos no arquivo
    - [x] 3 subagentes em paralelo
    - [x] `/opc:command`
  - [x] §15, item 7 (agente `subagent` como agente de sessão filha) e item 12 (storage concorrente) — item 12: parte automatizada PASSOU; com TUI manual NÃO VALIDADO
  - [ ] **manual (operador):** `attach` e `--pane` abrem a TUI; TUI rodando junto com um job do opc — NÃO VALIDADO (depende do operador; ver relatório)
  - [x] relatório · CHANGELOG · **[PAUSA-APROVAÇÃO]** push + PR (#5 e #6, mergeados em 28/09 e 29/09/2026) · aviso · gravação dupla (sem registro no relatório)
- [x] Ajustar o plano da F4a

## F4a — Roteamento, fallback, delegação, worker, monitor · `2026-09-26-opc-F4a-routing-delegation.md` · branch `feat/opc-f4a`

Ao vivo: `deepseek-v4.1-flash` + `kimi-k3`

- [x] Task 1: Branch, linha de base e helpers da fase
- [x] Task 2: Teto de retries e `RetryCapExceeded`
- [x] Task 3: Tiers, campos de roteamento do job e backoff
- [x] Task 4: `runWithFallback` e descrição da parada
- [x] Task 5: Cenários `model-429`, `retry-over-cap`, `model-fatal`, `write-then-fail`
- [x] Task 6: Runner aborta a sessão no teto de retries (reuso da F2a)
- [x] Task 7: `recordAttempt` e `runJobTurn`
- [x] Task 8: Fallback no caminho de execução dos jobs
- [x] Task 9: Listas de rota ponta a ponta
- [x] Task 10: Tentativas na saída de `result` e do foreground
- [x] Task 11: Render do monitor
- [x] Task 12: Comando `opc monitor`
- [x] Task 13: Lembrete de delegação no SessionStart
- [x] Task 14: Skill `opc-delegation`
- [x] Task 15: Agente `opc-worker`
- [x] Task 16: Portão da F4a
  - [x] fallback real (`probe-failing-model.mjs`). Sem modelo que falhe em runtime → `NÃO VALIDADO`, com o fake como evidência — resultado: NÃO VALIDADO ao vivo (nenhuma rota falhou); evidência do fake
  - [ ] **manual (operador):** `opc-worker` num time real (Agent Teams) → §15, item 11 — A CONFIRMAR (operador)
  - [ ] **manual (operador):** `opc monitor` — A CONFIRMAR (operador)
  - [x] docs `swarm`, `configuration` · relatório · CHANGELOG · **[PAUSA-APROVAÇÃO]** push + PR (#7, mergeado em 29/09/2026) · aviso · gravação dupla (colmeia: PENDENTE-COLMEIA no relatório)
- [x] Ajustar os planos da F4b e da F4c

## F4b — Orquestração · `2026-09-26-opc-F4b-orchestrate.md` · branch `feat/opc-f4b`

Ao vivo: planner `qwen3.8-max`

- [x] Task 1: Schema do plano e `validatePlan`
- [x] Task 2: Prompts do planner e do sintetizador
- [x] Task 3: Rota por subtarefa e espalhamento de modelos
- [x] Task 4: Agendador (prontas, paralelismo, escrita em série, propagação de falhas)
- [x] Task 5: `runOrchestration` com dependências injetáveis
- [x] Task 6: `renderOrchestration`
- [x] Task 7: Cenários do servidor falso e helpers
- [x] Task 8: Subcomando `orchestrate`, coordenador e despacho no worker
- [x] Task 9: Testes de integração de cada item de aceite
- [x] Task 10: `/opc:orchestrate` e skill `opc-delegation` (inclui `orchestrate` em `DELEGATION_COMMANDS`)
- [x] Task 11: Portão da F4b
  - [x] ao vivo: plano com ≥ 2 subtarefas em modelos diferentes; síntese pelo Claude e por modelo
  - [x] docs `swarm`, `commands` · relatório · CHANGELOG · **[PAUSA-APROVAÇÃO]** push + PR (#8, mergeado em 30/09/2026) · aviso · gravação dupla (sem registro no relatório) — `/opc:orchestrate` numa sessão real do Claude segue A CONFIRMAR (operador)

## F4c — Conclave · `2026-09-26-opc-F4c-conclave.md` · branch `feat/opc-f4c`

Ao vivo: pool `deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3` + 1 extra

- [x] Task 0: Pré-voo — branch e premissas P1–P14
- [x] Task 1: Schemas do conclave e validação local
- [x] Task 2: Prompts, templates e carga de assets
- [x] Task 3: `composeMembers`
- [x] Task 4: Anonimização (`buildKnownNames`, `anonymize`, `anonymizeValue`)
- [x] Task 5: `clusterFindings`
- [x] Task 6: `conclaveVerdict`
- [x] Task 7: `runConclave` — rodadas, quorum, juiz e pacote
- [x] Task 8: `runConclave` — modo review
- [x] Task 9: `renderConclave`
- [x] Task 10: Cenários do servidor falso
- [x] Task 11: Comando `opc conclave` e worker coordenador
- [x] Task 12: Testes de integração de todos os itens de aceite
- [x] Task 13: `/opc:conclave` e skill `opc-conclave`
- [x] Task 14: Documentação e CHANGELOG
- [x] Task 15: Portão da F4c
  - [x] ao vivo:
    - [x] opinion com 3 modelos
    - [x] debate com 2 rodadas
    - [x] review cruzado com concordância `k/N`
    - [x] juiz por modelo e juiz Claude
  - [x] relatório · **[PAUSA-APROVAÇÃO]** push + PR (#9, mergeado em 30/09/2026) · aviso · gravação dupla (colmeia: PENDENTE-COLMEIA no relatório)
- [x] Ajustar o plano da F5

## F5 — MCP e transfer · `2026-09-26-opc-F5-mcp-transfer.md` · branch `feat/opc-f5`

Ao vivo: rodízio

Estado (06/10/2026): mergeada na `main` pelo PR #12; Tasks 1–11 concluídas, com o portão parcial (itens abaixo seguem NÃO VALIDADO). Achados de revisão e pendências: seção "Progresso / achados" do plano da F5 e `docs/phases/F5-report.md`.

- [x] Task 1: Contrato do companion, argumentos só antes de `--` e compatibilidade dos comandos longos
- [x] Task 2: Núcleo do protocolo MCP (JSON-RPC 2.0 por stdio)
- [x] Task 3: Validação dos argumentos (subconjunto de JSON Schema)
- [x] Task 4: Catálogo de ferramentas MCP, mapeamento para argv e envelope
- [x] Task 5: `mcp-server.mjs`, declaração no plugin e handshake
- [x] Task 6: Execução, jobs e sessões pelo MCP
- [x] Task 7: Regras do aprovador, confirmações, sem escrita de config
- [x] Task 8: Núcleo do transfer
- [x] Task 9: `transfer`, `/opc:transfer` e `opencode import` no binário falso
- [x] Task 10: Skill e documentação (MCP e transfer)
- [x] Task 11: Portão da F5 (parcial; ver itens)
  - [x] ao vivo: `f5-transfer` (round trip com OpenCode 1.18.34, armazenamento isolado)
  - [ ] ao vivo: `f5-mcp` (listar modelos, conclave via MCP com dois modelos, `OPC_LIVE_MODEL`/`OPC_LIVE_MODEL_2`) — NÃO VALIDADO
  - [ ] ao vivo: contrato completo da API (`tests/live/contract.mjs`) — NÃO VALIDADO
  - [ ] **manual (operador):** ferramentas MCP numa sessão real do Claude Code, associação de jobs à sessão, confirmação de permissões e sessão transferida retomada com `opencode -s <id>` (§15, item 10) — NÃO VALIDADO
  - [ ] macOS e Windows — NÃO VALIDADO
  - [x] docs `architecture` (MCP), `commands` (transfer), README · relatório · CHANGELOG
  - [x] **[PAUSA-APROVAÇÃO]** push + PR (#12, mergeado em 06/10/2026) · aviso · gravação dupla (colmeia: PENDENTE-COLMEIA)
- [ ] **Marco: integração máxima entregue** — F5 mergeada em 06/10/2026 (PR #12); marco completo só com os itens NÃO VALIDADO acima. Data: ____

---

## Itens A CONFIRMAR da spec (§15)

| # | Item | Fase | Resposta |
|---|---|---|---|
| 1 | Precedência das regras de sessão sobre agente/global | F0 | pelo código: sessão vence; ao vivo: ____ |
| 2 | Alcance do `always` | F0 | pelo código: vale para a instância e vence o `deny` (o plugin não usa); ao vivo: ____ |
| 3 | PATCH `permission` substitui ou anexa | F2a | pelo código: anexa; ao vivo: ____ |
| 4 | grep/list/glob usam caminhos? curinga de nome para MCP? | F0 | ____ |
| 5 | Merge do `OPENCODE_CONFIG_CONTENT` | F0 | ____ |
| 6 | Formato do `messageID` | F2a | pelo código: `msg_` + 12 hex + 14 base62; ao vivo: ____ |
| 7 | Agente em modo `subagent` como agente de sessão filha | F3 | ____ |
| 8 | Id do plugin em `~/.claude/plugins/data/` | F0 | esperado: `opc-opencode-plugin-cc`; real: ____ |
| 9 | `ppid` do hook é o processo do Claude | F2b | ____ |
| 10 | Formato do export/import para o transfer | F5 | pelo plano: linha `Imported session: <id>` (o exit code não indica sucesso); ao vivo: ____ |
| 11 | Ferramentas de Agent Teams disponíveis ao teammate | F4a | ____ |
| 12 | Storage concorrente (TUI + servidor do plugin) | F3 | ____ |

---

## Riscos em aberto (herdados da reconciliação)

Acompanhar durante a execução; detalhes no "Registro de reconciliação" do mestre.

- [ ] Testes de integração próprios de F2a–F5 ainda não validados: só rodam com o código real.
- [ ] `permissions` em grupo limpa só o primeiro job que contém o pedido; o grupo se corrige no refresh do coordenador.
- [ ] `runJobTurn` chama `updateJob` direto enquanto o worker usa o updater serial; só a fase exibida pode ficar desatualizada.
- [ ] Cancelamento durante o fallback: `errorCode`/`errorMessage` podem ser sobrescritos pela parada (o status segue `cancelled`).
- [ ] `delegation` no `.opc.json`: conferir se o `loadConfig` da F1 aceita a chave (o "workspace só desliga" da F4a).
- [ ] A F5 endurece `resolveArgv` (F0) e `readRawArgs` (F2a); a F4b altera um teste da F4a. Conferir nas revisões de branch.
- [ ] Timeout de 20 s explícito em esperas da F2a (ajuste de julgamento do revisor de testes).
- [ ] `stopAllServers` por par env × workspace deixa a suíte mais lenta; medir e otimizar se incomodar.
- [ ] Probes da F1 no contrato podem dar divergência falsa (campos em `optionalUsed`).
- [ ] `config.json` da fixture da F0 tem `fake-provider/fake-model`, que não existe no catálogo; testes que resolvem modelo gravam `defaultModel`.
- [ ] O teste de paridade MCP × CLI da F5 cobre só o caminho de erro (modelos inexistentes), de propósito.
- [ ] Janela curta entre a criação de uma sessão filha e o PATCH do perfil (documentada na F2a).

## Backlog e sugestões (fora deste plano)

- [ ] Sincronização de agentes do OpenCode como subagentes Claude (cortada da F5).
- [ ] README em inglês para publicação.
- [ ] Validar em macOS e Windows (hoje `NÃO VALIDADO`).
- [ ] Reavaliar `share`/`unshare` só se houver necessidade real (cortado por risco de exfiltração).
- [ ] Contribuir de volta ao `tasict/opencode-plugin-cc` os achados de bug (`--model` morto, stop gate com exit 1, reescrita do config global) — opcional.
- [ ] Atualizar a spec a cada portão com as respostas do §15 (registro de revisões).

## Registro de marcos

| Data | Marco | Observação |
|---|---|---|
| 25/09/2026 | Análise + spec rev. 1 | abordagem A aprovada |
| 26/09/2026 | Spec rev. 2 e rev. 3 | revisão dupla independente aplicada |
| 26/09/2026 | Planos mestre + 9 fases | reconciliação R1–R35 (runtime) e T1–T14 (testes) |
| 26/09/2026 | Modo de execução | subagent-driven |
| 26/09/2026 | Primeiro commit | `docs: add opc design spec and implementation plans` |
| 26/09/2026 | F0 mergeada | PR #1 |
| 26/09/2026 | F1 mergeada | PR #2 |
| 28/09/2026 | F2a e F2b mergeadas | PRs #3 e #4; marco do mínimo (paridade com o codex) |
| 28/09/2026 | F3 parte 1 mergeada | PR #5 |
| 29/09/2026 | F3 parte 2 e F4a mergeadas | PRs #6 e #7 |
| 30/09/2026 | F4b e F4c mergeadas | PRs #8 e #9 |
| 01/10/2026 | Correções avulsas mergeadas | PRs #10 (execuções de teste sempre terminam) e #11 (cancelamento durante a criação da sessão) |
| 01/10/2026 | F5: Tasks 1–6 concluídas | branch `feat/opc-f5`; flake do `ping` no `serveStdio` corrigido (concorrência) |
| 03/10/2026 | F5: Tasks 7–11 concluídas | portão parcial; relatório `docs/phases/F5-report.md` |
| 06/10/2026 | F5 mergeada | PR #12 (merge `64000ec`); última fase do plano; portão parcial, itens NÃO VALIDADO seguem no checklist |
| 06/10/2026 | Correção do runner de testes | `bd53bf4` na branch `fix/test-runner-lost-results`: sem `--test-force-exit`, saída após período de graça |
