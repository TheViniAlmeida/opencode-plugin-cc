# Relatório da fase F4c — Conclave

- **Data:** 30/09/2026
- **Branch:** `feat/opc-f4c`
- **OpenCode:** 1.18.32 (`opencode --version`)
- **Modelos ao vivo:** rotas por ambiente — `OPC_LIVE_MODEL=omniroute-personal/cmd/deepseek/deepseek-v4-flash`, `OPC_LIVE_MODEL_2=…/cmd/Qwen/Qwen3.7-Flash`, `OPC_LIVE_MODEL_3=…/cmd/moonshotai/Kimi-K2.6` (juiz modelo = `_3`); as rotas `omniroute-personal/opencode-go/*` do plano respondem 402 no gateway usado (Ajustes pós-F4b, item 9)
- **Legenda:** `PASSOU` · `N/A` (com justificativa) · `NÃO VALIDADO` (com motivo)

## 1. Premissas sobre F0–F4b (Tarefa 0)

Conferidas em 30/09/2026 contra a `main` com a F4b mergeada.

| # | Premissa | Resultado | Evidência (arquivo:linha ou saída) | Ajuste feito |
|---|---|---|---|---|
| P1 | `parseArgs` tipo `list` divide por vírgula; ausente → `[]` | PASSOU | `lib/args.mjs:150,201`; `parseArgs(['--models','a,b','q'])` → `{"models":["a","b"]}`, ausente → `[]` | — |
| P2 | Ids pelo `kind` (`conclave*` → `conc-…`); `createGroup(…, { maxActive })` e `withServerLock` disponíveis | PASSOU | `lib/jobs.mjs:24-27` (`conclave*` → `conc`); `newJobId` gerou três ids `conc-…`; `createGroup` `:755`, `withServerLock` `:561` | — |
| P3 | `task-worker` despacha por `WORKER_DELEGATES[kind]` (entrada `conclave` acrescentada) | PASSOU com ajuste | `commands/task-worker.mjs:16,145`; o delegado recebe `runWorker(ctx, job, request, options)` com a entrada privada já consumida | Ajustes pós-F4b, item 1 |
| P4 | `result` de grupo imprime `job.rendered`; com `--json`, `{ group, members }` (pacote em `group.result`) | PASSOU | `commands/result.mjs:46-55` (`job.rendered`; `--json` → `{ group, members }`) | — |
| P5 | `runTurn`: `onPermission(req)` com `req.id`; timeout → `errorType: 'Timeout'`; `StructuredOutputError` com `finalText` | PASSOU | `lib/runner.mjs:193-203,300,310,593`; `lib/errors.mjs:33` | Em `text`, sem JSON → `MissingStructuredOutput` (Ajustes pós-F4b, item 2) |
| P6 | Fake: `onPromptAsync(fake, sessionID, body)`, `fake.emitTurn`, rota de abort, `requests[].body` | PASSOU | `tests/fixtures/fake-session-api.mjs:102,153,229,236,252` | — |
| P7 | Fixture `/provider` com os três modelos do `omniroute-personal` conectados | PASSOU | `tests/fixtures/data/provider.json`: `opencode-go/deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3` conectados | — |
| P8 | `prompts/review.md` usa `TARGET_LABEL`, `PROJECT_CONTEXT`, `REVIEW_COLLECTION_GUIDANCE`, `REVIEW_INPUT` (sem `USER_FOCUS`); `review-output` no formato do codex | PASSOU | `prompts/review.md`: `PROJECT_CONTEXT`, `REVIEW_COLLECTION_GUIDANCE`, `REVIEW_INPUT`, `TARGET_LABEL`; `review-output` no formato do codex | — |
| P9 | `DEFAULT_CONFIG.conclave` com os valores do §3.2 e config parcial mesclada | PASSOU | `lib/config.mjs:62` `{pools:{},defaultPool:null,judge:'claude',rounds:1,quorum:2,memberTimeoutSec:900}` | Acrescentar `conclave.structuredOutput` (item 2) |
| P10 | `redact()` casa nomes de chave exatos (`key_points` preservado) | PASSOU | `redact({key_points:['x'],key:'k'})` → `{"key_points":["x"],"key":"***"}` | — |
| P11 | `waitForJob` sem `waitTimeoutMs` espera sem limite; `onLog` recebe linhas | PASSOU | `lib/jobs.mjs:523-545` (`waitTimeoutMs = null` → sem limite; `onLog`) | — |
| P12 | `buildPermissionRules('read-only')[0]` = `{permission:'*', pattern:'*', action:'deny'}` | PASSOU | `buildPermissionRules('read-only')[0]` → `{"permission":"*","pattern":"*","action":"deny"}` | — |
| P13 | `status`/`result`/`cancel` tratam `role: GROUP_ROLE` como grupo (F3) | PASSOU com ajuste | `commands/status.mjs:56`, `result.mjs:47`, `cancel.mjs:29` | Finalizar por `refreshGroup(..., { final: true, decorate })` (item 5) |
| P14 | `--cwd` removido pelo dispatcher (`ctx.cwd`); `--json` e `--raw-args-stdin` chegam ao subcomando | PASSOU | `opc-companion.mjs:57-67`; `lib/args.mjs:350-356` | — |

## 2. `npm test`

Resultado: **PASSOU** — `node scripts/run-tests.mjs` (o mesmo comando de `npm test`) fora do sandbox, no commit final do código (`fix(conclave): participant tokens, group start write and judge error type`):

```
1..1782
# tests 1782
# suites 0
# pass 1781
# fail 0
# cancelled 0
# skipped 1
# todo 0
```

O teste pulado é o preexistente `cross-UID exclusion cannot be exercised without permission to chown` (exige root para `chown`; sem mudança nesta fase). `git diff --check`: sem achados.

## 3. Aceite de integração (spec §13.3, F4c)

Todos em `tests/integration/conclave-acceptance.test.mjs`, na suíte da seção 2.

| Item | Teste | Resultado |
|---|---|---|
| Composição: 1 membro, quorum inválido | composition: 1 member, invalid quorum, conflicting flags and bad rounds exit 2 without prompting | PASSOU |
| Anonimização (inclusive autoidentificação) | anonymization: no model, vendor or provider name reaches debate or judge prompts, even when members self-identify | PASSOU |
| Quorum atingido | quorum met: text mode reports MissingStructuredOutput…; quorum met: tool mode discards and lists a StructuredOutputError member… | PASSOU |
| Quorum não atingido | quorum not met: exit 7, group failed, partial answers kept and no judge | PASSOU |
| `conclave-member-timeout` descartado | member timeout: the silent member is aborted, discarded and left out of the debate | PASSOU |
| `StructuredOutputError` de membro descartado | quorum met: tool mode discards and lists a StructuredOutputError member; the rest synthesize | PASSOU |
| Dedupe e concordância com fixtures sobrepostas | review: overlapping findings dedupe into clusters with k/N agreement; findings without file stay alone; verdict | PASSOU |
| Findings sem `file` | idem + `conclave-cluster` | PASSOU |
| Veredito | idem + `conclave-verdict` | PASSOU |
| `--allow-judge-member` | --allow-judge-member: required when the judge is also a member | PASSOU |

## 4. Aceite ao vivo

Comando: `OPC_LIVE=1 node --test --test-concurrency=1 --test-reporter=spec tests/live/f4c-opinion.mjs tests/live/f4c-debate.mjs tests/live/f4c-review.mjs tests/live/f4c-judge.mjs` — rodada 2, no commit `4866b01`, 5/5 testes, exit 0, `opencode serve` preexistentes do operador intactos (lista de PIDs e horários de início comparada antes e depois).

| Item | Critério objetivo | Execuções (ok/total) | Resultado |
|---|---|---|---|
| Opinion com 3 modelos | 3 respostas válidas no schema, sem falhas | 2/3 (run 3: um membro com `Timeout` de 600 s) | PASSOU |
| Debate com 2 rodadas | rodada 2 válida no schema de debate, `changed` booleano registrado | 3/3 (run 1: uma resposta da rodada 2 realmente fora do schema, descartada) | PASSOU |
| Review cruzado num diff real | `k/N` com N = membros válidos; ≥ 1 cluster com k ≥ 2 | 3/3 | PASSOU |
| Juiz por modelo | síntese válida no `conclave-synthesis` | 3/3 | PASSOU |
| Juiz Claude | pacote anonimizado + síntese feita pelo Claude com a skill `opc-conclave` (seção 5) | 1/1 | PASSOU |
| Modelo extra | `OPC_LIVE_MODEL_4` | — | N/A — só três rotas funcionais no gateway do portão |

Histórico: a rodada 1 (código anterior às correções do portão) falhou em opinion e juiz modelo. Um membro devolvia os valores no formato do schema (`{"title": …, "properties": {…}}` ou `title` ao lado dos valores), o que virava `InvalidStructuredOutput`. O catálogo real (8501 modelos) transformava palavras comuns em nomes conhecidos (`For a small … zero …` → `[redacted] a [[redacted]] …`). As duas coisas foram corrigidas (seção 8).

Depois da rodada 2, `088d4c3` e `a7005e9` só estreitaram os nomes conhecidos e corrigiram achados de revisão. A anonimização foi reconferida contra o catálogo real sem modelos: a prosa comum sai intacta e a autoidentificação continua redigida. Os três exemplos de `docs/conclave.md` foram executados ao vivo no código final (`a7005e9` + docs), com exit 0 nos três; no review, `NaN` aparece intacto.

Saída redigida dos testes ao vivo (`docs/phases/F4c-live-output.md`):

````
### debate (2 rodadas, 3 membros)

```
run 1: ok (217s) {"failures":[["B",2,"InvalidStructuredOutput","$.critiques é obrigatório; $.changed é obrigatório; $.title não é permitido"]],"jobId":"conc-muo3yyjh-yxeyu0","changed":[["A",false],["C",false]]}
run 2: ok (243s) {"failures":[],"jobId":"conc-muo42vea-5o0utq","changed":[["A",true],["B",false],["C",false]]}
run 3: ok (202s) {"failures":[],"jobId":"conc-muo482o8-l25fud","changed":[["A",true],["B",false],["C",false]]}
```

### juiz modelo (2 membros + juiz)

```
run 1: ok (263s) {"failures":[],"jobId":"conc-muo4d7rz-16rr0q","confidence":0.76,"recommendation":"Implement config storage as JSON using only JSON.parse and JSON.stringify. Ship an example config file with a .json.example extension containing inline documentation comments, plus a README section ex"}
run 2: ok (125s) {"failures":[],"jobId":"conc-muo4i4md-z6qdea","confidence":0.82,"recommendation":"Ship with JSON and a well-documented example config. Treat the 'zero runtime dependencies' constraint as absolute. Gather user feedback: if you receive repeated complaints about the lack of comments o"}
run 3: ok (166s) {"failures":[],"jobId":"conc-muo4ksxu-2xsjk1","confidence":0.8,"recommendation":"Use JSON for user configuration. Keep the config flat and small. Document every key and provide a commented example in the README so users rarely need inline comments in the file itself. If you must s"}
```

### juiz Claude (pacote anonimizado)

```
run 1: ok (82s) {"jobId":"conc-muo4p5tz-q27q80","responses":3,"failures":[]}
```

### opinion (3 membros)

```
run 1: ok (172s) {"failures":[],"jobId":"conc-muo4sb1m-5k32k7","durationMs":109683,"confidences":[["A",0.75],["B",0.72],["C",0.68]]}
run 2: ok (81s) {"failures":[],"jobId":"conc-muo4v8j1-4jw1xz","durationMs":53912,"confidences":[["A",0.85],["B",0.72],["C",0.85]]}
run 3: FAIL (626s) {"failures":[["A",1,"Timeout","O turno excedeu 600000 ms e foi interrompido"]],"error":"Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ [\n+   {\n+     errorClass: 'recoverable',\n+     errorType: 'Timeout',\n+     label: 'A',\n+     message: 'O turno excedeu 600000 ms e foi interrompido',\n+     rawText: null,\n+     role: 'member',\n+     round: 1\n+   }\n+ ]\n- []\n"}
```

### review cruzado (3 membros)

```
run 1: ok (138s) {"failures":[],"jobId":"conc-muo5b6lk-psiopo","verdict":"needs-attention","clusters":[["critical","2/3","src/stats.js",9,"Uso de eval permite execução arbitrária de código"],["critical","1/3","src/stats.js",12,"eval() com entrada não confiável permite RCE"],["high","3/3","src/stats.js",2,"Erro off-by-one no loop da função average"],["medium","2/3","src/stats.js",6,"Divisão por zero ao receber array vazio"]]}
run 2: ok (83s) {"failures":[],"jobId":"conc-muo5dfcv-rxabua","verdict":"needs-attention","clusters":[["critical","2/3","src/stats.js",8,"Uso de eval para executar fórmula arbitrária do usuário"],["critical","1/3","src/stats.js",9,"Execução de código arbitrário via eval em runUserFormula"],["high","2/3","src/stats.js",3,"Off-by-one causa corrupção silenciosa de resultado ([redacted])"],["high","1/3","src/stats.js",3,"Off-by-one no laço de average acessa índice fora do array"],["medium","2/3","src/stats.js",2,"Divisão por zero se average receber array vazio"],["medium","1/3","src/stats.js",2,"Sem tratamento de entrada nula/vazia em average"],["low","1/3","src/stats.js",1,"Ausência de testes para o comportamento introduzido"]]}
run 3: ok (67s) {"failures":[],"jobId":"conc-muo5f7ft-6x7rln","verdict":"needs-attention","clusters":[["critical","3/3","src/stats.js",9,"Injeção de código via eval() em entrada de usuário"],["high","1/3","src/stats.js",2,"Loop com condição de limite incorreta causa [redacted]"],["high","1/3","src/stats.js",3,"Erro off-by-one causa [redacted] em average()"],["high","1/3","src/stats.js",2,"Erro de limite no laço soma elemento undefined e retorna [redacted]"]]}
```
````

## 5. Síntese pelo Claude (juiz Claude, ao vivo)

- Job: `conc-muo4p5tz-q27q80` (opinion, 3 membros, 0 falhas); pacote lido de `synthesisInput`.
- Síntese produzida seguindo a skill `opc-conclave`:

```
## Conclave: JSON ou TOML para a config de um CLI Node.js sem dependências

### Consenso
- A, B e C: JSON. JSON.parse/JSON.stringify são nativos e cumprem "zero dependências" sem custo;
  TOML exigiria um parser próprio ou vendorizado, desproporcional para um CLI pequeno.
- A, B e C: a falta de comentários é o custo real do JSON, compensável com documentação,
  arquivo de exemplo ou uma chave `_comment`.

### Divergências
- Peso da edição manual: A e B a consideram tolerável numa config curta; C ressalta que o custo
  cresce com o tamanho da config e é o gatilho para reavaliar.
- Condição de mudança: A e C aceitariam TOML com um parser pequeno vendorizado no repositório;
  B só com necessidade documentada de comentários ou aninhamento acima de 3 níveis.

### Posição ponderada (confiança: 0.85)
JSON. Nenhuma resposta citou evidência verificável (listas `evidence` vazias), então o peso
vem da qualidade do argumento: C traz os pontos mais fortes (escrita programática com
JSON.stringify não destrói anotações do usuário; um parser JSONC caseiro reintroduz a
complexidade evitada).

### Recomendação
Use JSON com JSON.parse/JSON.stringify, mensagens de erro claras quando o usuário tentar
comentar o arquivo e um exemplo de config documentado. Reavalie TOML só se a config crescer e
virar muito editada à mão, vendorizando um parser pequeno e conforme a especificação.

### Relatórios minoritários
- C: evitar a dependência pode empurrar para um parser JSONC caseiro; JSON não distingue
  "ausente" de `null`, o que complica a mescla de defaults.

### Composição
A = omniroute-personal/cmd/moonshotai/Kimi-K2.6 · B = omniroute-personal/cmd/Qwen/Qwen3.7-Flash ·
C = omniroute-personal/cmd/deepseek/deepseek-v4-flash
```

- Conferência: a composição foi lida só depois da síntese escrita; o raciocínio usou apenas os rótulos.

## 6. Contrato (`tests/live/contract.mjs`)

Resultado: **PASSOU** — `OPC_LIVE=1 node tests/live/contract.mjs`:

```
# Contrato OpenCode 1.18.32 × fake

Sem divergências nos campos usados.
```

A F4c não passou a usar endpoints novos (sessões, prompt, mensagens e abort já vinham da F2/F4a); nenhum ajuste no fake.

## 7. Documentação

| Item | Resultado |
|---|---|
| `docs/conclave.md` com exemplos executados (sem marcadores `F4C-LIVE-OUTPUT`) | PASSOU — três saídas reais (opinion, debate com juiz modelo, review), `grep -c F4C-LIVE-OUTPUT` = 0 |
| `docs/commands.md` (seção `/opc:conclave`) | PASSOU |
| `docs/configuration.md` (seção `conclave`, incluindo `structuredOutput`) | PASSOU |
| `node scripts/scan-secrets.mjs docs/` sem achados | PASSOU — "scan-secrets: nenhum achado." |
| `CHANGELOG.md` atualizado | PASSOU |

Sem id pessoal de provider nem caminho pessoal nos arquivos versionados (`grep` por esses padrões: 0 ocorrências).

## 8. Desvios e decisões

| Desvio | Motivo | Muda interface? |
|---|---|---|
| Ajustes pós-F4b (itens 1–12) | Interfaces reais da F4b (assinatura de `runWorker`, `refreshGroup`, cancelamento diferido) e gateway sem `json_schema` | Sim, `conclave.structuredOutput` (novo, `text` padrão) |
| Falhas de persistência do coordenador → `coordinator_error` | Revisão final: gravação falha não é falha de membro | Não (novo `errorCode` de grupo) |
| Caminhos `file` citados por modelos anonimizados por componente | Revisão final: nomes vazavam por caminhos | Não |
| Texto livre do juiz (inclusive mensagem de erro) em cerca | Revisão final: texto podia forjar `## Composição` | Não |
| Um só contrato de saída por prompt; no review `tool`, instrução explícita que substitui a cerca `json` da F2b | Revisões: instruções conflitantes | Não |
| Nomes conhecidos: do catálogo só identificadores específicos; famílias do catálogo só da lista curada; nome de exibição só como frase; números, versões e tokens de código fora | Ao vivo: catálogo de 8501 modelos redigia prosa comum; provider `nan` redigia `NaN` | Não |
| Decisão: palavras do id de provider só contam quando específicas; o id completo sai sempre | Re-revisão: `omniroute-personal` redigia "personal"; o id nomeia a rota, não o modelo | Não |
| Tokens do id do próprio participante contam mesmo quando parecem código (`v0`); a primeira gravação do grupo e o `errorType` do juiz também protegidos | Segunda re-revisão | Não |
| Respostas no formato do schema aceitas quando validam (`properties`; `$schema`/`$id`/`title`/`type`/`description` ao lado dos valores) | Ao vivo: um membro perdido por execução | Não |
| Testes ao vivo com rotas por ambiente | `opencode-go/*` responde 402 no gateway | Não |

## 9. Pendências para a F5

- Agrupamento de achados usa similaridade de título: achados iguais com títulos em idiomas diferentes (`eval` em PT e EN, linhas 9-11 e 10-12) ficam em clusters separados. Candidato a melhoria (normalização por arquivo+linha com peso maior), fora do escopo da F4c.
- Modelo extra ao vivo (`OPC_LIVE_MODEL_4`): N/A neste gateway.
- Escrita na colmeia (`myprojects`) da F4c: PENDENTE-COLMEIA.
