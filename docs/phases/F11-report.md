# F11 — correções da revisão dupla · relatório de fase

- **Data original:** 09/10/2026; retomada local em 07/11/2026 (America/Belem).
- **Branch:** `feat/opc-f11-review-fixes`.
- **Recorte:** Tarefa 10, documentação, teste de docs e relatório; código de `plugins/` preservado.
- **Base documentada:** `7bb52b5` (Tarefas 1–9, rodadas 2–5 da T2 e ajustes finais integrados).
- **Situação:** fechamento local APROVADO na revisão independente, com nota documental corrigida e verificada abaixo. Não certifica OpenCode real nem autoriza operações Git.

## Fontes e alcance

A tabela de origem e as decisões vêm do [plano](../superpowers/plans/2026-10-09-opc-F11-review-fixes.md).
O ledger local `.superpowers/sdd/2026-10-09-opc-F11-review-fixes/` contém `progress.md`,
`task-N-report.md`, `task-N-*review*.md` e `polish-*.md`; os relatórios brutos não são
artefatos públicos. As afirmações de comportamento foram conferidas no código atual em
`plugins/opc/scripts/` e nos testes citados. Resultado de worktree não é aprovação deste checkout.

O relatório original foi produzido antes da integração das rodadas finais. A base atual
inclui os ajustes de núcleo em `0d1b966` e de política em `7bb52b5`. A retomada atualiza
somente documentação; as suítes locais usam fixtures, sem inferência de compatibilidade ao vivo.
Os limites consolidados estão abaixo e em [Permissões](../permissions.md).

## Portão da Tarefa 10

As linhas desta tabela preservam a execução original de 09/10. A execução da retomada
está em seção própria ao fim do relatório e substitui os totais como evidência da base atual.

| Item | Evidência | Resultado |
|---|---|---|
| TDD de docs, fase vermelha | `node --test tests/unit/docs-f11.test.mjs`: 0 pass, 9 fail esperados, 0 skip; faltavam extraAllow, decisões e F11-report | PASSOU |
| Teste focado de docs | `node --test tests/unit/docs-f11.test.mjs`: 9 pass, 0 fail, 0 skip | PASSOU |
| Suíte unit | `node scripts/run-tests.mjs unit`: 2078 testes, 2077 pass, 0 fail, 1 skip preexistente (UID estrangeiro sem chown) | PASSOU |
| Suíte integration | `node scripts/run-tests.mjs integration`: 559 pass, 0 fail, 0 skip; harness F5 com três execuções de fixtures passou | PASSOU |
| Scanner | `npm run scan-secrets`: nenhum achado | PASSOU |
| Diff | `git diff --check`: saída vazia, exit 0 | PASSOU |
| Processos remanescentes | Inspeção de /proc: zero fixtures, workers/reapers do opc e servidores serve visíveis | PASSOU |
| Serves do operador no host | `pgrep -af 'opencode serve'` conferido por identidade sem publicar cmdline; nenhum serve visível neste namespace, sem confirmar a lista do host | NÃO VALIDADO |
| OpenCode real | Proibido nesta tarefa; integração usa fixtures | NÃO VALIDADO |
| macOS / Windows reais | Ambiente Linux; sem execução nessas plataformas | NÃO VALIDADO |
| Commit / push / PR / merge | Não autorizados para este implementador; portão e operações finais pertencem ao orquestrador | N/A |
| `.ai-data` / colmeia | Registro delegado ao orquestrador por instrução explícita | N/A |

Na rodada intermediária do teste de docs: 8 pass, 1 fail, `AssertionError: rule order:
browser * deny`. A busca considerava também a descrição anterior do perfil; foi limitada
à seção de invariantes, sem mudar a ordem correta das docs. Resultado final: 9/9.

## Origem e status por achado

PASSOU significa cobertura automatizada executada nesta base; não valida OpenCode real.
A evidência por achado é o teste do comportamento, além do teste de presença dos contratos em docs.
A coluna de origem preserva os 24 itens do plano.

| # | Achado | Sev. | Local de origem (relativo a plugins/opc/scripts/) | Tarefa | Status | Evidência / alcance |
|---|---|---|---|---|---|---|
| 1 | X-SEC-3 — `policy.tools.deny` vem antes dos `shell … ask` destrutivos; carrier do subagente adiciona `allow` depois das invariantes | Alta | `lib/policy.mjs:166-167`, `lib/runner.mjs:485` | 1 | PASSOU | `tests/unit/policy-v2.test.mjs`: última regra vence, deny shell e extraAllow; `tests/unit/runner-subagent.test.mjs`: carrier negado. |
| 2 | X-SEC-5 — agente implícito `build` escapa de `policy.agents` | Alta | `commands/task.mjs:224`, `lib/runner.mjs:151` | 1 | PASSOU | `tests/unit/routing-turn-model.test.mjs`, `tests/unit/conclave-worker.test.mjs`, `tests/unit/orchestrate-command.test.mjs`: build implícito negado; `tests/integration/f2a-profiles.test.mjs`: zero criação. |
| 3 | X-SEC-4 / S-SEC-2 — opções globais e ordem de argumentos do git (`git -C x reset --hard`, `git push origin main --force`, `git clean -df`) escapam do classificador | Alta | `lib/policy.mjs:108-115`, `405-466` | 2 | PASSOU | `tests/unit/policy-v2.test.mjs`: opções globais, flags agrupadas, abreviações, refspecs, env, allowlists, canais dinâmicos, shells adicionais e comandos benignos; inclui fix5 e final fix. |
| 4 | S-SEC-1 — `requiresUser` só olha `metadata.command ?? patterns[0]` | Média | `lib/policy.mjs:197-200` | 2 | PASSOU | `tests/unit/policy-v2.test.mjs`: every shell resource is inspected, incluindo metadata e patterns compostos. |
| 5 | S-SEC-2 (c, d) — `shell` que lê caminho sensível (`cat .env`) e `webfetch`/`websearch` não exigem o usuário com aprovador `claude` | Média | `lib/policy.mjs:193-206` | 2 | PASSOU | `tests/unit/policy-v2.test.mjs`: shell sensível, webfetch/websearch, desconhecida e checkReply. |
| 6 | S-LOG-1 — `**/id_rsa*` não casa `id_rsa` na raiz; defaults não cobrem `.npmrc`, `.git-credentials`, `.netrc`, `.aws/credentials`, `kubeconfig` | Baixa | `lib/models.mjs:7-10`, `lib/policy.mjs:118`, `lib/config.mjs:55` | 2 | PASSOU | `tests/unit/models.test.mjs`, `tests/unit/config.test.mjs`, `tests/unit/policy-v2.test.mjs`: **/ opcional, defaults e caminhos na raiz. |
| 7 | X-SEC-2 — `assertCanCreateSessions` nunca é chamada: `share: "auto"` ou config ilegível não bloqueiam a criação de sessões; checagem de mundo sem `x-opencode-directory` | Alta | `lib/server.mjs:266`, `383`, `566`, `576`; `lib/context.mjs:120` | 3 | PASSOU | `tests/integration/share-guard.test.mjs`: create/fork, guards cedo, resume e directory; `tests/integration/review.test.mjs`: background sem jobs/POST; `tests/integration/stop-gate.test.mjs`: SHARE_AUTO. |
| 8 | X-SEC-1 — `conclave --mode review` coleta contexto sem `excludeGlobs` | Alta | `commands/conclave.mjs:127` | 4 | PASSOU | `tests/unit/conclave-review.test.mjs`: excludeGlobs recebido pelo coletor; `tests/unit/git.test.mjs`: conteúdo sensível excluído da coleta. |
| 9 | X-SEC-6 — corpo de erro HTTP vai para `--json` só com `redact` (mascara por chave, não por padrão em texto livre) | Alta | `lib/http.mjs:110`, `opc-companion.mjs:98` | 4 | PASSOU | `tests/unit/http.test.mjs`, `tests/unit/redact.test.mjs`, `tests/integration/cli.test.mjs`: corpo e envelope JSON mascarados; `tests/unit/redact-patterns.test.mjs`: limiar Bearer. |
| 10 | S-SEC-4 — `transfer` envia o histórico sem `maskSecretPatterns` (só o título é mascarado) | Média | `lib/transfer.mjs:173-293` | 4 | PASSOU | `tests/unit/transfer.test.mjs`, `tests/integration/transfer.test.mjs`: máscara e contagem em todas as origens de texto exportado. |
| 11 | S (NÃO VALIDADO) — cliente HTTP segue redirecionamento com `Authorization` | — | `lib/http.mjs` (sem `redirect`) | 4 | PASSOU | `tests/unit/redact.test.mjs`, `tests/unit/sse.test.mjs`: redirect manual, 3xx recusado e código preservado na reconexão. Endurecimento passou; o vazamento alegado não foi demonstrado. |
| 12 | X-OPS-1 — no timeout, falha de `interrupt` é engolida e o `waitIdle` é descartado: fallback roda com a sessão anterior ainda ocupada | Alta | `lib/runner.mjs:387-390` | 5 | PASSOU | `tests/unit/runner-safety-v2.test.mjs`: interrupt falho/ocupado/status falho e filhas; `tests/integration/fallback.test.mjs`: AbortUnconfirmed fatal sem próxima tentativa. |
| 13 | X-LOG-1 — subagente envia o prompt depois de cancelado (`dispatchSubagent` sem `isCancelled`/`signal`) | Alta | `commands/subagent.mjs:169-171`, `lib/runner.mjs:469-476` | 5 | PASSOU | `tests/unit/runner-subagent.test.mjs`, `tests/unit/jobs-cancel-preprompt.test.mjs`: cancelamento antes/durante criação, nenhum prompt, interrupt e logs com IDs órfãos. |
| 14 | S-OPS-1 — `ensureServer` mata o servidor "travado" (health > 2 s) sem checar jobs ativos | Alta | `lib/server.mjs:584-586` | 6 | PASSOU | `tests/integration/server-lifecycle.test.mjs`: três health retries com job write, recuperação e READ_FAILED preservando servidor. |
| 15 | S-OPS-2 — um `jobs/*.json` corrompido derruba `listJobs`/`createJob`/`status`/`gc` | Média | `lib/jobs.mjs:192-210` | 6 | PASSOU | `tests/unit/jobs.test.mjs`: quarentena, READ_FAILED preservado e poda >30 dias; `tests/unit/gc.test.mjs`: prévia e limpeza; `tests/integration/server-lifecycle.test.mjs`: ilegíveis potencialmente ativos; `tests/unit/stop-gate-safety.test.mjs`: (ilegível). |
| 16 | S-OPS-3 — `gc` usa `serverMatcher(port)` sem o binário configurado | Baixa | `commands/gc.mjs:74-77` | 6 | PASSOU | `tests/unit/gc.test.mjs`: identidade reconhecida por server.opencodeBin ou OPC_OPENCODE_BIN. |
| 17 | S-MCP-1 — `maskInputEcho` monta uma `RegExp` com o prompt inteiro: > ~150 KB lança depois do dispatch; mascara trechos de 1 caractere | Média | `lib/mcp-tools.mjs:489-501`, `538-540` | 7 | PASSOU | `tests/unit/mcp-tools.test.mjs`: envelope com prompt 300 KB, eco completo/janelas e fallback sem relançar. |
| 18 | X-CON-1 — `opc_permissions_answer` exige `que…`; o V2 usa `frm_…` | Média | `lib/mcp-tools.mjs:389` | 7 | PASSOU | `tests/unit/mcp-tools.test.mjs`, `tests/integration/mcp-permissions.test.mjs`: frm_f3_1 e IDs com hífen, rejeição de que_ e envio V2. |
| 19 | S-SEC-5 — ferramentas MCP aceitam `cwd` absoluto arbitrário | Média | `lib/mcp-tools.mjs:516-519` | 7 | PASSOU | `tests/unit/mcp-tools.test.mjs`: realpath, raiz/descendente, symlink externo e irmão com prefixo parecido recusados antes do dispatch. |
| 20 | X-CON-2 — `opc result` de revisão sem JSON válido sai 0; o foreground sai 7 | Média | `commands/result.mjs:36-39`, `commands/review.mjs:76-78` | 8 | PASSOU | `tests/unit/review-attempts-json.test.mjs`, `tests/integration/mcp-jobs.test.mjs`: result/status wait, CLI/MCP, JSON ausente/inválido retorna 7; outros jobs continuam 0. |
| 21 | S-LOG-2 — `subagent --prompt-file` ignora `--cwd` | Baixa | `commands/subagent.mjs:66` | 8 | PASSOU | `tests/integration/subagent.test.mjs`: prompt-file relativo ao --cwd com diretório de lançamento diferente. |
| 22 | S-QA-1 — `mergeDeep` aceita `__proto__` vindo do `.opc.json` | Baixa | `lib/config.mjs:251-256` | 8 | PASSOU | `tests/unit/config.test.mjs`: __proto__ ignorado em todos os níveis, objetos novos e arrays; protótipos preservados. |
| 23 | S-SEC-6 — `.opc.json` amplia limites numéricos (`maxAttempts`, `rounds`, `maxSubtasks`…) | Baixa | `lib/config.mjs:130`, `288-298` | 8 | PASSOU | `tests/unit/config.test.mjs`, `tests/integration/config-cli.test.mjs`: seis chaves, global/default, valor maior gravado com aviso stderr, efetivo mínimo e valores igual/menor. |
| 24 | S-SEC-3 — `--tty-confirm` é atravessado por um agente que aloca pty (`script -qec`) | Média | `commands/config.mjs:73-89` | 9 | PASSOU | `tests/unit/process.test.mjs`, `tests/unit/config-command.test.mjs`, `tests/integration/config-tty.test.mjs`: sinais de Claude, runtime flags, motivo da recusa, TTY e arquivo preservado. Plataformas reais abaixo. |

## Decisões

Mantidas as 14 decisões do plano, com diferenças do código registradas:

1. Perfil → `extraAllow` → invariantes; negação explícita de ferramenta vence o ask destrutivo.
2. Carrier negado retorna `SUBAGENT_DENIED`, sem queda silenciosa para child-session.
3. Classificador permanece lista de negação normalizada; allowlist geral de comandos só de
   leitura fica **N/A**, por decisão de produto. Allowlists locais de opções não substituem isso.
4. Com approver=claude, webfetch/websearch, desconhecidas e shell sensível exigem o usuário.
5. `**/` aceita zero diretórios; `*` segue casando `/`.
6. Guarda única bloqueia create/fork com share auto/config indisponível; CLI recusa cedo,
    exceto resume existente. Review foreground, --wait e background recusam antes da fila.
7. Timeout sem interrupt e idle confirmados vira `ABORT_UNCONFIRMED` fatal, sem fallback.
8. Servidor sem resposta com jobs ativos/ilegíveis é preservado; três health checks de 5 s.
9. `cwd` MCP restrito por realpath ao projeto/descendente; outro repo fica acessível pela CLI.
10. `confirmedByUser` é declarativo; o portão real é o prompt de permissão do Claude Code.
    Prova de humano dentro do MCP é **N/A**: impossível pelo contrato, sem mudança de código.
11. --tty-confirm recusa CLAUDECODE/ancestral Claude, como conveniência; não prova humano.
12. Seis limites do workspace usam `min(global ou default, workspace)` e avisam quando ignorados.
13. Transfer mascara todo texto exportado e informa quantos trechos foram mascarados, sem opt-out.
14. Redirect é recusado. **Desvio:** a decisão dizia `redirect: 'error'`; HTTP/SSE atuais usam
    `redirect: 'manual'` e rejeitam explicitamente 3xx com `UNEXPECTED_REDIRECT`. Documentado
    o comportamento real, sem editar plugins. Nenhum vazamento original foi comprovado.

## Review Focus e polimento

| Cenário | Evidência automatizada |
|---|---|
| write com tools.deny shell nunca termina em ask/allow | `tests/unit/policy-v2.test.mjs`: tools.deny shell beats destructive ask e extraAllow |
| shell composto e patterns múltiplos exigem usuário | `tests/unit/policy-v2.test.mjs`: every shell resource is inspected |
| Servidor lento com job write não é derrubado | `tests/integration/server-lifecycle.test.mjs`: hung server with active write jobs |
| Cancelamento durante criação não envia prompt e interrompe | `tests/unit/jobs-cancel-preprompt.test.mjs`, `tests/unit/runner-subagent.test.mjs` |
| MCP prompt 300 KB retorna envelope/jobId | `tests/unit/mcp-tools.test.mjs`: a 300 KB prompt returns the envelope |

O polimento também cobre SSE sem redirect, critério Bearer, cancelamento antes da sessão,
IDs órfãos em logs, review background com share auto (exit 4 antes da fila), runtimes com
flags antes do entrypoint Claude e hook-stop com `(ilegível)`. Evidências nas linhas #7,
#9, #11, #13, #15 e #24. Nenhum conteúdo de prompt entra no aviso de sessão órfã.

## Limitações conhecidas

### Política e classificação (LIMITES_T2)

- Lista de negação de melhor esforço, sem executar/expandir shell; não é fronteira de segurança.
  Expansões dinâmicas, `$(…)`, aliases, funções, source e here-docs falham fechado onde
  detectáveis. Protege de erro do agente; aliases de ~/.gitconfig e de shell não são visíveis.
- Regras de sessão casam por prefixo; somente pedidos que chegam à ponte passam por
  requiresUser/checkReply. Para garantia forte use approver=user (padrão) ou
  policy.destructiveBash/profile restritivo; approver=claude é conveniência.
- Defaults não cobrem diretórios fora de sensitivePaths, como `.gnupg`; amplie a política.
  `.env.example` permanece sensível pelo padrão `*.env.*`.
- `export LD_PRELOAD`/`export PATH` sem valor não exige usuário. `git format-patch`
  `--output-directory`/`-o` e outras opções de escrita fora de `--output` também não.
- Nameref, trap/source/eval, enable/alias e configurações inseguras de shell associadas
  a git recebem falha fechada. Ações de trap/eval são inspecionadas recursivamente;
  cabeçalho dinâmico de eval com argumentos exige o usuário. Eval dinâmico isolado
  continua permitido, e não há análise completa de shell nem garantia contra adversário.
- Shells adicionais incluem ash/rbash/mksh/hush/fish/csh/tcsh e wrappers conhecidos.
  --norc/--noprofile/--posix preservam git benigno; --login não está na allowlist longa.
- Cache LRU de 4096 globs integrado: acima de 4096 padrões distintos perde desempenho,
  mantendo correção. Ledger histórico mede 600 padrões × 2000 palavras em 0,23–0,76 s.
  O teste-benchmark integra a suíte unitária (gate <1 s) e passou na retomada;
  a reexecução focada mediu 214,74 ms.
- Endurecimento de GIT_* integrado (exceto GIT_TERMINAL_PROMPT/GIT_TRACE*), com overrides
  HOME/XDG_CONFIG_HOME e escritas git config fora da allowlist;
  inclui ruído como GIT_AUTHOR_NAME=x git commit. `set -a` sem git/destrutivo e env
  repassado por comando não-git para um git filho ficam fora da garantia.
- confirmedByUser é declarativo; prompt de permissão do Claude Code é o portão real.

### Persistência, mascaramento e plataformas

- **Não feito: fsync na escrita de jobs.** Renomeação atômica não garante durabilidade
  em queda de energia. Adiado, fora do escopo das correções selecionadas.
- Janela TOCTOU leitura→rename na quarentena: o arquivo pode mudar no intervalo.
- READ_FAILED não move arquivos e conta como potencialmente ativo, bloqueando operações
  que exigem ociosidade e o reaper até corrigir permissões ou parada forçada. INVALID_JSON
  fica em `*.json.corrupt-<ms>` e é podado após 30 dias, na criação de jobs.
- Eco parcial do meio de entrada >4 KB (4096 caracteres), sem as janelas de 64 do início/fim,
  não é mascarado pelo MCP. Valores <8 chars não são mascarados como eco; padrões de segredo
  continuam mascarados. O valor inteiro é substituído literalmente.
- Bearer só mascara valores ≥16 caracteres com dígito/símbolo; tokens curtos ou só com
  letras escapam desse padrão. Padrões próprios (JWT, provider etc.) e registerSecret
  continuam mascarando quando aplicáveis.
- --tty-confirm pode ser atravessado por setsid/daemonização/tmux/screen/systemd-run/
  ssh localhost/at/cron e namespaces de PID. Windows só verifica CLAUDECODE. macOS não
  validado: isClaudeCmdline divide a saída de ps por espaços e pode truncar caminho com
  espaço, gerando falso negativo. Windows e macOS reais: NÃO VALIDADO.
- Detector de entrypoint de runtime pode interpretar texto de `node -e/-p/--eval/--print`
  como caminho, gerando falso positivo raro (polish-review, item 2); não corrigido nesta tarefa.
- Review foreground/--wait/background recusam SHARE_AUTO antes da fila (exit 4),
  cobertos por `tests/integration/review.test.mjs` para review e adversarial-review.
- Registro terminal cancelado é congelado: sessão criada numa corrida pode não entrar no
  sessionID do membro, mas é interrompida e seu ID fica no log do grupo após o polimento.
  attemptInFlight residual terminal não bloqueia leitores (task-5-review).
- Aviso de sessão órfã do pai também pode sair em grupos failed/partial normais; só adiciona log.
- Config set em modo texto pode repetir aviso de aperto em stdout e stderr; comportamento aceito.

## Não realizados e fechamento

Não foram executados OpenCode real, sondas tests/live diretamente, testes reais macOS/Windows,
commit, push, PR ou merge. As duas suítes por tipo substituem a invocação agregada
`node scripts/run-tests.mjs`, com os mesmos arquivos unit/integration, uma vez cada.
O harness `tests/integration/f5-live-harness.test.mjs` é permitido e usa fixtures.
A revisão final da branch e as operações Git do brief pertencem ao orquestrador; este
  implementador não amplia a tarefa para código, dependências ou política gerenciada.
O registro em memória também fica com o orquestrador, conforme a instrução da sessão.

## Retomada local — 07/11/2026

Base revisada: `7bb52b5`, incluindo o ajuste de núcleo `0d1b966`. Escopo autorizado:
atualizar documentação, executar testes locais e revisar a F11, sem commit, push, PR ou merge.
Não houve alteração em código executável nesta retomada.

| Verificação | Resultado observado | Estado |
|---|---|---|
| `node scripts/run-tests.mjs unit` | 3416 testes: 3415 pass, 0 fail, 1 skip (cross-UID exige chown) | PASSOU |
| `node scripts/run-tests.mjs integration` | 575 pass, 0 fail, 0 skip; fixtures locais | PASSOU |
| `node --test tests/unit/docs-f11.test.mjs` após atualizar docs | 9 pass, 0 fail; rodada inicial 8/1 por caixa do termo nameref, corrigida sem mudar o teste | PASSOU |
| `node --test tests/unit/models.test.mjs` | 24 pass, 0 fail; benchmark 600 globs × 2000 palavras: 214,74 ms, gate <1 s | PASSOU |
| `npm run scan-secrets` | Nenhum achado | PASSOU |
| `git diff --check` | Exit 0, saída vazia | PASSOU |
| Inspeção limitada de processos do projeto | Zero candidatos a fixtures/workers/reapers remanescentes; não é inventário do host | PASSOU |
| OpenCode real, inferência, API externa, Windows/macOS e semântica real dos shells adicionais | Fora da execução local autorizada | NÃO VALIDADO |
| Commit, push, PR e merge | Não executados; proibidos pelo escopo | N/A |

As suítes completas precederam a edição documental; testes focados de documentação e modelos
foram executados depois. As evidências locais e caminhos dos logs do harness ficam na memória
local do projeto, fora deste relatório público.

### Parecer independente

**Veredito recebido: APROVADO**, com uma nota Menor não bloqueante, corrigida nesta retomada.
Revisor independente: subagente `revisor` no OpenCode, sessão
`ses_e479c735cffeejGAL9JeSFcxdW`. Modelo configurado: combo pessoal `role/reviewer`;
backend efetivo não confirmado pelo revisor. Não se atribui o parecer a um modelo real
deduzido do nome do combo.

O revisor conferiu o diff não commitado de `docs/permissions.md`, `CHANGELOG.md` e deste
relatório contra o código, e os ajustes finais `0d1b966`/`7bb52b5`. Não apontou falha
material de segurança ou correção no recorte revisado. Evidências principais:

- Guardas de criação atualizadas após recuperação: `lib/server.mjs:688-691`, com o mesmo
  objeto capturado por `guardSessionCreation` (`284-296`).
- Review foreground/--wait/background recusa antes da fila: `commands/review.mjs:115,128`
  e `tests/integration/review.test.mjs:19-30`.
- Interrupção de todas as sessões rastreadas antes de fallback: `lib/runner.mjs:189-204,415-419`
  e `tests/integration/fallback.test.mjs` (filho ocupado impede fallback concorrente).
- Env, canais dinâmicos, allowlists e shells adicionais: `lib/policy.mjs:439,476-489,722,734,742-748,792-813`.
- Cache LRU: `lib/models.mjs:6-15,39-40`.

As referências `lib/` e `commands/` acima são relativas a `plugins/opc/scripts/`.
O revisor declarou reexecuções próprias: `policy-v2.test.mjs` 1580 pass/0 fail,
`docs-f11.test.mjs` 9/9, `models.test.mjs` 24/24 e diff check limpo. Não reexecutou as
suítes completas: os totais completos são da execução do orquestrador, não do revisor.

**Nota Menor corrigida:** a documentação dizia que o benchmark não fora reexecutado,
mas ele integra `tests/unit/models.test.mjs:100-112` e rodou na suíte unitária. O texto foi
alinhado ao teste e a uma nova execução focada (24/24; 214,74 ms), sem alteração de código.
Essa correção textual foi conferida pelo orquestrador; não houve segunda revisão independente
do delta textual pós-parecer. Permanecem as limitações de validação ao vivo e de plataformas.

O parecer encerra o recorte local de documentação/testes/revisão. Publicação, integração Git
e qualquer validação ao vivo continuam fora do escopo e dependem de nova autorização.
