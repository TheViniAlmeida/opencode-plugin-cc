# opc — Checklist de execução

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

- [ ] Task 1: Esqueleto do repositório, runner de testes e helpers
- [ ] Task 2: Scanner de segredos e CI
- [ ] Task 3: Erros tipados e redação (`opc-error`, `redact`)
- [ ] Task 4: Argumentos sem expansão (`args`), com o caso do apóstrofo
- [ ] Task 5: Identidade de processo, spawn destacado e kill em grupo (`process`)
- [ ] Task 6: Locks com dono verificável (`locks`)
- [ ] Task 7: Diretório de dados e estado por workspace (`state`)
- [ ] Task 8: Config base e merge restritivo (`config`)
- [ ] Task 9: Cliente HTTP tipado (`http`)
- [ ] Task 10: Servidor OpenCode falso e binário falso (com `registerFakeExtension`)
- [ ] Task 11: SSE — parser e `EventHub`
- [ ] Task 12: Ciclo de vida do servidor (`server`)
- [ ] Task 13: Contexto da CLI e renderização (`context`, `render`)
- [ ] Task 14: CLI `opc` (despacho dinâmico), `/opc:setup` e manifestos do plugin
- [ ] Task 15: Portão da F0
  - [ ] `npm test` verde, também em Node 20 (hoje só validado no 22)
  - [ ] ao vivo: `f0-connection` (porta ≠ 4096, reaproveitamento, parada, sem órfão, serves do operador intactos)
  - [ ] `probe-permission-precedence` → responde os itens 1, 2, 4 e 5 do §15
  - [ ] `contract.mjs`
  - [ ] **manual (operador):** instalar o plugin no Claude e confirmar o id do diretório de dados (§15, item 8)
  - [ ] docs: README inicial, `installation`, `troubleshooting`, `architecture`
  - [ ] `docs/phases/F0-report.md` + CHANGELOG + scan de segredos
  - [ ] **[PAUSA-APROVAÇÃO]** push + PR · aviso ao operador · gravação dupla
- [ ] Ajustar o plano da F1 com as respostas do §15 (itens 1, 2, 4, 5 e 8)

## F1 — Descoberta, configuração e onboarding · `2026-09-26-opc-F1-discovery-config.md` · branch `feat/opc-f1`

Ao vivo: `kimi-k3`

- [ ] Task 1: API de leitura e `connectApi`
- [ ] Task 2: Fixtures, rotas de dados do servidor falso e helpers de teste
- [ ] Task 3: `models.mjs` — catálogo, IDs, aliases, variants e globs
- [ ] Task 4: `policy.mjs` — allow/deny e modelos fixados
- [ ] Task 5: `config.mjs` (parte A) — esquema completo, segredos, chaves travadas, merge restritivo
- [ ] Task 6: `config.mjs` (parte B) — edição, coerção, normalização, validação contra o servidor
- [ ] Task 7: `tty.mjs` — prompts de terminal com streams injetáveis
- [ ] Task 8: `onboarding.mjs` — etapas, rascunho e commit atômico
- [ ] Task 9: Renderizadores da F1
- [ ] Task 10: `providers`, `models`, `agents`, `catalog`
- [ ] Task 11: Comando `config` (get/set/unset/add/remove/show/validate/path, `--tty-confirm`)
- [ ] Task 12: Assistente `opc config init` e confirmação por TTY
- [ ] Task 13: Onboarding pelo `setup` (inclui o teste `no-config-first-run`)
- [ ] Task 14: Slash commands da F1
- [ ] Task 15: Portão da F1
  - [ ] ao vivo: `f1-discovery`, `f1-fixture-coverage`, `contract.mjs`
  - [ ] **manual (operador):** onboarding guiado completo no Claude (com `OPC_DATA_DIR` descartável)
  - [ ] **manual (operador):** `opc config init` no terminal
  - [ ] política de mundo: `omniroute-work/*` e `work-*` escondidos e recusados
  - [ ] docs `configuration`, `commands` (descoberta e config), README (início rápido) · relatório · CHANGELOG
  - [ ] **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] Ajustar o plano da F2a

## F2a — Núcleo de execução · `2026-09-26-opc-F2a-execution-core.md` · branch `feat/opc-f2a`

Ao vivo: `deepseek-v4.1-flash`

- [ ] Task 1: `lib/errors.mjs` — classificação de erros
- [ ] Task 2: `lib/policy.mjs` — perfis, invariantes, destrutivos, aprovador
- [ ] Task 3: `lib/routing.mjs` — resolução de modelo, variant e agente
- [ ] Task 4: `lib/args.mjs` — `parsePromptArgs` e `readRawArgs`
- [ ] Task 5: `lib/runner.mjs` — turno completo (inclui reaplicar o perfil às filhas)
- [ ] Task 6: `lib/api.mjs` — operações de escrita
- [ ] Task 7: `lib/jobs.mjs` — registros, limites, worker, espera, cancel
- [ ] Task 8: `lib/render.mjs` — status, lista, resultado e pedidos
- [ ] Task 9: Servidor falso — sessões, prompt, permissões, perguntas e cenários
- [ ] Task 10: `task`, `ask`, `plan` e o worker (inclui `prompt-roundtrip`)
- [ ] Task 11: `status`, `result`, `cancel`
- [ ] Task 12: Resume, concorrência por sessão e `task-resume-candidate`
- [ ] Task 13: `/opc:permissions` — list, reply, answer
- [ ] Task 14: `opc gc`
- [ ] Task 15: Skill `opc-result-handling`, frontmatter e exit codes
- [ ] Task 16: Portão da F2a
  - [ ] ao vivo:
    - [ ] read-only mandado editar → checksum inalterado
    - [ ] `.env` negado
    - [ ] bash negado
    - [ ] `rm -rf` no perfil `write` → pedido que vai ao usuário
    - [ ] background + `status --wait` + `result`
    - [ ] cancel
    - [ ] resume
  - [ ] §15, item 3 (PATCH anexa?) e item 6 (formato do `messageID`) confirmados ao vivo
  - [ ] teste de grep em `.env` (§15, item 4). Se vazar: registrar `NÃO VALIDADO` e abrir o plano B do §8.1
  - [ ] docs `commands`, `permissions` · relatório · CHANGELOG
  - [ ] **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] Ajustar o plano da F2b

## F2b — Review, gate, rescue, hooks · `2026-09-26-opc-F2b-review-gate-hooks.md` · branch `feat/opc-f2b`

Ao vivo: `qwen3.8-max`

- [ ] Task 1: Premissas da F2a, branch e infraestrutura de teste
- [ ] Task 2: Adaptador de jobs e coordenação por `server.lock`
- [ ] Task 3: Prompts, schema e `lib/prompts.mjs`
- [ ] Task 4: `lib/git.mjs` — alvo, coleta inline/em partes, estimativa (inclui `huge-diff`)
- [ ] Task 5: Renderização do review
- [ ] Task 6: `resolveTurnModel` em `routing.mjs`
- [ ] Task 7: `review` e `adversarial-review` (+ `result` de jobs de review)
- [ ] Task 8: Registro de sessões do Claude, entrada de hook e contexto por `cwd`
- [ ] Task 9: Hooks `SessionStart`/`SessionEnd`, reaper e `hooks.json`
- [ ] Task 10: Stop gate (`hook-stop`)
- [ ] Task 11: `setup --enable/--disable-review-gate` e `--stop-server` com jobs ativos
- [ ] Task 12: Slash commands `review`, `adversarial-review`, `rescue` e agente `opc-rescue`
- [ ] Task 13: Skills `opc-runtime`, `opc-result-handling`, `opc-prompting`
- [ ] Task 14: Portão
  - [ ] ao vivo:
    - [ ] review com schema válido (3 execuções, ≥ 2 válidas)
    - [ ] adversarial-review com foco
    - [ ] stop gate (3 execuções, ≥ 2 `BLOCK`)
    - [ ] rescue
  - [ ] **manual (operador):** `/clear` no Claude não derruba o servidor; o `ppid` do hook é o Claude (§15, item 9)
  - [ ] docs `commands`, `permissions` (stop gate), README (mapa do mínimo) · relatório · CHANGELOG
  - [ ] **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] **Marco: mínimo (paridade com o codex) entregue** — data: ____
- [ ] Ajustar o plano da F3

## F3 — Sessões, subagentes, commands, attach · `2026-09-26-opc-F3-sessions-subagents.md` · branch `feat/opc-f3`

Ao vivo: `deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3`

- [ ] Task 0: Pontos de encaixe e branch
- [ ] Task 1: Servidor falso F3, tmux falso e helpers de teste
- [ ] Task 2: Operações de sessão na `lib/api.mjs`
- [ ] Task 3: Renderizadores F3 e `shellQuote`
- [ ] Task 4: Conexão, descoberta e política em `context.mjs`; comando `sessions`
- [ ] Task 5: `session new | show | fork | children | diff | todo`
- [ ] Task 6: `session revert | unrevert | summarize`, com confirmação, lock e diff afetado
- [ ] Task 7: Grupos de jobs em `lib/jobs.mjs`
- [ ] Task 8: `dispatchSubagent` (sessão filha com fallback para `subtask`)
- [ ] Task 9: Comando `subagent` e worker coordenador
- [ ] Task 10: `status`, `result`, `cancel` cientes de grupos
- [ ] Task 11: Comando `command`
- [ ] Task 12: `attach.secret` e comando `attach` (inclusive `--pane`)
- [ ] Task 13: Slash commands e skill `opc-result-handling`
- [ ] Task 14: Documentação da fase
- [ ] Task 15: Testes ao vivo da F3
- [ ] Task 16: Portão da F3
  - [ ] ao vivo:
    - [ ] `session new`
    - [ ] fork e revert conferidos no arquivo
    - [ ] 3 subagentes em paralelo
    - [ ] `/opc:command`
  - [ ] §15, item 7 (agente `subagent` como agente de sessão filha) e item 12 (storage concorrente)
  - [ ] **manual (operador):** `attach` e `--pane` abrem a TUI; TUI rodando junto com um job do opc
  - [ ] relatório · CHANGELOG · **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] Ajustar o plano da F4a

## F4a — Roteamento, fallback, delegação, worker, monitor · `2026-09-26-opc-F4a-routing-delegation.md` · branch `feat/opc-f4a`

Ao vivo: `deepseek-v4.1-flash` + `kimi-k3`

- [ ] Task 1: Branch, linha de base e helpers da fase
- [ ] Task 2: Teto de retries e `RetryCapExceeded`
- [ ] Task 3: Tiers, campos de roteamento do job e backoff
- [ ] Task 4: `runWithFallback` e descrição da parada
- [ ] Task 5: Cenários `model-429`, `retry-over-cap`, `model-fatal`, `write-then-fail`
- [ ] Task 6: Runner aborta a sessão no teto de retries (reuso da F2a)
- [ ] Task 7: `recordAttempt` e `runJobTurn`
- [ ] Task 8: Fallback no caminho de execução dos jobs
- [ ] Task 9: Listas de rota ponta a ponta
- [ ] Task 10: Tentativas na saída de `result` e do foreground
- [ ] Task 11: Render do monitor
- [ ] Task 12: Comando `opc monitor`
- [ ] Task 13: Lembrete de delegação no SessionStart
- [ ] Task 14: Skill `opc-delegation`
- [ ] Task 15: Agente `opc-worker`
- [ ] Task 16: Portão da F4a
  - [ ] fallback real (`probe-failing-model.mjs`). Sem modelo que falhe em runtime → `NÃO VALIDADO`, com o fake como evidência
  - [ ] **manual (operador):** `opc-worker` num time real (Agent Teams) → §15, item 11
  - [ ] **manual (operador):** `opc monitor`
  - [ ] docs `swarm`, `configuration` · relatório · CHANGELOG · **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] Ajustar os planos da F4b e da F4c

## F4b — Orquestração · `2026-09-26-opc-F4b-orchestrate.md` · branch `feat/opc-f4b`

Ao vivo: planner `qwen3.8-max`

- [ ] Task 1: Schema do plano e `validatePlan`
- [ ] Task 2: Prompts do planner e do sintetizador
- [ ] Task 3: Rota por subtarefa e espalhamento de modelos
- [ ] Task 4: Agendador (prontas, paralelismo, escrita em série, propagação de falhas)
- [ ] Task 5: `runOrchestration` com dependências injetáveis
- [ ] Task 6: `renderOrchestration`
- [ ] Task 7: Cenários do servidor falso e helpers
- [ ] Task 8: Subcomando `orchestrate`, coordenador e despacho no worker
- [ ] Task 9: Testes de integração de cada item de aceite
- [ ] Task 10: `/opc:orchestrate` e skill `opc-delegation` (inclui `orchestrate` em `DELEGATION_COMMANDS`)
- [ ] Task 11: Portão da F4b
  - [ ] ao vivo: plano com ≥ 2 subtarefas em modelos diferentes; síntese pelo Claude e por modelo
  - [ ] docs `swarm`, `commands` · relatório · CHANGELOG · **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla

## F4c — Conclave · `2026-09-26-opc-F4c-conclave.md` · branch `feat/opc-f4c`

Ao vivo: pool `deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3` + 1 extra

- [ ] Task 0: Pré-voo — branch e premissas P1–P14
- [ ] Task 1: Schemas do conclave e validação local
- [ ] Task 2: Prompts, templates e carga de assets
- [ ] Task 3: `composeMembers`
- [ ] Task 4: Anonimização (`buildKnownNames`, `anonymize`, `anonymizeValue`)
- [ ] Task 5: `clusterFindings`
- [ ] Task 6: `conclaveVerdict`
- [ ] Task 7: `runConclave` — rodadas, quorum, juiz e pacote
- [ ] Task 8: `runConclave` — modo review
- [ ] Task 9: `renderConclave`
- [ ] Task 10: Cenários do servidor falso
- [ ] Task 11: Comando `opc conclave` e worker coordenador
- [ ] Task 12: Testes de integração de todos os itens de aceite
- [ ] Task 13: `/opc:conclave` e skill `opc-conclave`
- [ ] Task 14: Documentação e CHANGELOG
- [ ] Task 15: Portão da F4c
  - [ ] ao vivo:
    - [ ] opinion com 3 modelos
    - [ ] debate com 2 rodadas
    - [ ] review cruzado com concordância `k/N`
    - [ ] juiz por modelo e juiz Claude
  - [ ] relatório · **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] Ajustar o plano da F5

## F5 — MCP e transfer · `2026-09-26-opc-F5-mcp-transfer.md` · branch `feat/opc-f5`

Ao vivo: rodízio

- [ ] Task 1: Contrato do companion, argumentos só antes de `--` e compatibilidade dos comandos longos
- [ ] Task 2: Núcleo do protocolo MCP (JSON-RPC 2.0 por stdio)
- [ ] Task 3: Validação dos argumentos (subconjunto de JSON Schema)
- [ ] Task 4: Catálogo de ferramentas MCP, mapeamento para argv e envelope
- [ ] Task 5: `mcp-server.mjs`, declaração no plugin e handshake
- [ ] Task 6: Execução, jobs e sessões pelo MCP
- [ ] Task 7: Regras do aprovador, confirmações, sem escrita de config
- [ ] Task 8: Núcleo do transfer
- [ ] Task 9: `transfer`, `/opc:transfer` e `opencode import` no binário falso
- [ ] Task 10: Skill e documentação (MCP e transfer)
- [ ] Task 11: Portão da F5
  - [ ] ao vivo: `f5-mcp` (listar modelos, conclave via MCP) e `f5-transfer`
  - [ ] **manual (operador):** Claude usando as ferramentas MCP numa sessão real; sessão transferida retomada com `opencode -s <id>` (§15, item 10)
  - [ ] docs `architecture` (MCP), `commands` (transfer), README · relatório · CHANGELOG
  - [ ] **[PAUSA-APROVAÇÃO]** push + PR · aviso · gravação dupla
- [ ] **Marco: integração máxima entregue** — data: ____

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
| | Primeiro commit | |
| | F0 … F5 | |
