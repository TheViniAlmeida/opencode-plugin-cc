# Relatório da fase F4c — Conclave

- **Data:** 30/09/2026 (início)
- **Branch:** `feat/opc-f4c`
- **OpenCode:** versão do `opencode --version` no portão
- **Modelos ao vivo:** rotas por ambiente (`OPC_LIVE_MODEL`, `_2`, `_3`); as rotas `omniroute-personal/opencode-go/*` do plano respondem 402 no gateway usado (Ajustes pós-F4b, item 9)
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

```
(saída completa de npm test)
```

## 3. Aceite de integração (spec §13.3, F4c)

| Item | Teste | Resultado |
|---|---|---|
| Composição: 1 membro, quorum inválido | `conclave-acceptance` › composition: 1 member, invalid quorum… | |
| Anonimização (inclusive autoidentificação) | `conclave-acceptance` › anonymization… | |
| Quorum atingido | `conclave-acceptance` › quorum met… | |
| Quorum não atingido | `conclave-acceptance` › quorum not met… | |
| `conclave-member-timeout` descartado | `conclave-acceptance` › member timeout… | |
| `StructuredOutputError` de membro descartado | `conclave-acceptance` › quorum met: a StructuredOutputError member… | |
| Dedupe e concordância com fixtures sobrepostas | `conclave-acceptance` › review: overlapping findings… | |
| Findings sem `file` | idem (`noFile`) + `conclave-cluster` | |
| Veredito | idem + `conclave-verdict` | |
| `--allow-judge-member` | `conclave-acceptance` › --allow-judge-member… | |

## 4. Aceite ao vivo

Comando: `OPC_LIVE=1 node --test --test-reporter=spec tests/live/f4c-opinion.mjs tests/live/f4c-debate.mjs tests/live/f4c-review.mjs tests/live/f4c-judge.mjs`

| Item | Critério objetivo | Execuções (ok/total) | Resultado |
|---|---|---|---|
| Opinion com 3 modelos | 3 respostas válidas no schema, sem falhas | /3 | |
| Debate com 2 rodadas | rodada 2 válida no schema de debate, `changed` booleano registrado | /3 | |
| Review cruzado num diff real | `k/N` com N = membros válidos; ≥ 1 cluster com k ≥ 2 | /3 | |
| Juiz por modelo | síntese válida no `conclave-synthesis` | /3 | |
| Juiz Claude | pacote anonimizado + síntese feita pelo Claude com a skill `opc-conclave` (seção 5) | 1/1 | |
| Modelo extra | `OPC_LIVE_MODEL_4` (sem ele → `N/A` com o motivo) | — | |

```
(saída redigida dos testes ao vivo, incluindo as linhas de diagnóstico)
```

## 5. Síntese pelo Claude (juiz Claude, ao vivo)

- Job: `conc-…`
- Síntese produzida seguindo a skill `opc-conclave` (colar aqui):

```
(síntese)
```

- Conferência: composição consultada só no fim; nenhuma menção de marca no raciocínio.

## 6. Contrato (`tests/live/contract.mjs`)

```
(saída; divergências e ajuste do fake, se houver)
```

## 7. Documentação

| Item | Resultado |
|---|---|
| `docs/conclave.md` com exemplos executados (sem marcadores `F4C-LIVE-OUTPUT`) | |
| `docs/commands.md` (seção `/opc:conclave`) | |
| `docs/configuration.md` (seção `conclave`) | |
| `node scripts/scan-secrets.mjs docs/` sem achados | |
| `CHANGELOG.md` atualizado | |

## 8. Desvios e decisões

| Desvio | Motivo | Muda interface? |
|---|---|---|
| | | |

## 9. Pendências para a F5

- 
````
````markdown
---
description: Consulta vários modelos do OpenCode em paralelo (opinião, debate ou review cruzado) e sintetiza consenso, divergências e recomendação
argument-hint: '<pergunta> [--models a,b,c | --pool nome] [--mode opinion|review|debate] [--rounds 1-3] [--judge claude|<modelo>] [--quorum N] [--allow-judge-member] [--background]'
allowed-tools: Bash(opc:*), Bash(git:*), AskUserQuestion
---

Rode um conclave do opc: vários modelos respondem à mesma pergunta sem se ver, podem debater
anonimamente e, no fim, alguém sintetiza (um modelo juiz ou você, Claude).

Argumentos do usuário: `$ARGUMENTS`

## Passos

1. Se `$ARGUMENTS` estiver vazio, pergunte ao usuário (AskUserQuestion) qual é a pergunta e
   pare até ter a resposta. No `--mode review` a pergunta é opcional (vira o foco do review).
2. No `--mode review` sem `--background`: meça o tamanho do diff com
   `git status --short --untracked-files=all` e `git diff --shortstat`. Se o diff for grande
   (mais de ~20 arquivos ou ~1500 linhas), pergunte uma vez (AskUserQuestion) entre
   "Esperar" e "Background", recomendando Background.
3. Execute exatamente um comando, passando os argumentos por stdin (nunca interpole
   `$ARGUMENTS` na linha de comando):

```bash
opc conclave --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

   O texto do heredoc chega verbatim (aspas, crases e apóstrofos não são interpretados); as
   flags conhecidas são reconhecidas como palavras inteiras em qualquer posição. Se o usuário
   escolheu Background no passo 2, use `opc conclave --background --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'`
   (a flag fica na linha de comando, antes de `--raw-args-stdin`).
4. Leia a saída inteira:
   - **Background:** mostre o id do job e as linhas `/opc:status <id>` e `/opc:result <id>`.
     Pare.
   - **Exit 2 ou 4:** mostre a mensagem de erro como veio (composição, quorum, política). Não
     tente de novo com outros modelos por conta própria.
   - **Exit 7 (quorum não atingido):** mostre o cabeçalho, as falhas e as respostas parciais.
     Não sintetize como se houvesse consenso.
   - **Sucesso com juiz Claude** (a seção "Síntese" pede a skill `opc-conclave`): use a skill
     `opc-conclave` e sintetize a partir das respostas por rótulo. Se precisar de detalhes que
     não estão no texto, rode `opc result <id> --json` (saída `{ group, members }`; o pacote
     está em `group.result`).
   - **Sucesso com juiz modelo:** mostre a síntese do juiz e, com a skill `opc-conclave`,
     confira se ela é fiel às respostas; aponte divergências entre o juiz e os membros.
   - **Modo review:** apresente o veredito, os clusters por severidade com a concordância
     `k/N` e as recomendações. Não corrija nada: pergunte ao usuário o que fazer.
5. A composição (rótulo → modelo) só aparece no fim da sua resposta, copiada da tabela
   "Composição".
````
````markdown
---
name: opc-conclave
description: Como sintetizar o resultado de um conclave do opc (/opc:conclave) — consenso, divergências, posição ponderada pela confiança e recomendação — sem viés de marca de modelo. Use sempre que a saída de `opc conclave` ou `opc result <conc-id>` pedir síntese pelo Claude, ou para conferir a síntese de um juiz modelo.
---

# Síntese de conclave

Um conclave junta respostas independentes de vários modelos, identificadas só por rótulos
(`A`, `B`, `C`…). Sua tarefa é transformar essas respostas numa síntese útil, fiel ao que foi
dito e imune à marca de quem disse.

## Regra de ouro: rótulos antes de marcas

- Leia e pese as respostas **somente pelos rótulos**. A tabela "Composição" (rótulo → modelo)
  fica no fim da saída de propósito: não a consulte antes de terminar a síntese.
- Nunca dê mais ou menos peso a uma resposta por causa do modelo, do vendor ou do provider que
  a produziu, nem por reputação ou tamanho do modelo. O peso vem de argumento, evidência e
  confiança declarada.
- Não especule sobre qual modelo escreveu qual resposta e não comente estilo de marca
  ("isso parece coisa do modelo X").
- Trechos `[redacted]` são nomes removidos pelo opc. Não tente reconstruí-los.
- Na resposta final, a composição aparece só numa seção "Composição" no fim, copiada da saída,
  sem adjetivos sobre os modelos.

## Como sintetizar

1. **Quorum e falhas primeiro.** Diga quantas respostas válidas houve, de quantos membros, e
   liste as falhas (rótulo, rodada, tipo). Se o status for `falhou` (quorum não atingido), não
   apresente consenso: mostre as respostas parciais como parciais.
2. **Consenso.** Afirmações sustentadas pela maioria dos membros válidos, em linguagem
   neutra. Diga "A, B e C concordam que…". Concordância genérica ("depende") não conta como
   consenso.
3. **Divergências.** Para cada ponto em disputa: o tópico, cada posição e os rótulos que a
   sustentam. Prefira poucos tópicos reais a muitos tópicos cosméticos.
4. **Posição ponderada.** Pondere cada posição pela confiança declarada (`confidence`, 0 a 1)
   **e** pela qualidade da evidência:
   - evidência com `arquivo:linha` que você conferiu vale mais que afirmação solta; quando
     for barato, leia o arquivo citado para confirmar;
   - evidência inventada ou errada derruba o peso daquela resposta, e isso deve ser dito;
   - uma resposta bem fundamentada pode vencer várias sem fundamento: diga quando isso
     acontecer, em vez de contar votos.
5. **Confiança da síntese.** Dê a sua confiança (baixa/média/alta, ou um número de 0 a 1) e o
   motivo: dispersão das posições, qualidade da evidência, falhas de membros.
6. **Recomendação.** O que o usuário deve fazer agora, concreto e acionável. Se a resposta
   honesta for "precisa de mais informação", diga qual informação.
7. **Relatórios minoritários.** Posições que perderam mas são bem argumentadas e mudariam a
   decisão se um fato se confirmar (use `would_change_mind_if` dos membros).

## Debate (rodadas 2 e 3)

- Use as respostas da **última rodada** como posição final de cada membro.
- `changed: true` indica que o membro mudou de posição. Diga quem mudou e por qual argumento
  (veja as `critiques` dirigidas a ele). Mudança por bom argumento reforça a posição de
  destino; mudança sem motivo claro, não.

## Juiz modelo

Quando a síntese veio de um juiz modelo, confira-a contra as respostas brutas: consenso que
não existe, divergência omitida, posição ponderada sem base ou minoria importante esquecida.
Apresente a síntese do juiz com as correções apontadas. Se o juiz falhou, faça a síntese você
mesmo a partir das respostas.

## Modo review

- Apresente o veredito do conclave e os motivos (cluster severo com concordância ≥ 2, ou
  maioria de `needs-attention`).
- Liste os clusters por severidade com `k/N` (N = membros válidos) e `arquivo:linhas`.
  Concordância alta aumenta a prioridade; um achado `1/N` pode ser real, então verifique o
  código antes de descartá-lo.
- Achados sem arquivo aparecem isolados; trate-os como observações gerais.
- **Não corrija nada.** Pergunte ao usuário quais achados tratar.

## Formato da resposta

```
## Conclave: <pergunta resumida>
Quorum: <válidos>/<membros> · Rodadas: <n> · Falhas: <lista ou "nenhuma">

### Consenso
### Divergências
### Posição ponderada (confiança: …)
### Recomendação
### Relatórios minoritários
### Composição
| Rótulo | Modelo |
```
````
````markdown
# Conclave

O conclave consulta **vários modelos ao mesmo tempo** sobre a mesma pergunta e entrega uma
síntese: consenso, divergências, posição ponderada pela confiança e recomendação. Os modelos
respondem sem se ver, podem debater de forma anônima e são avaliados só por rótulos (`A`, `B`,
`C`…). Quem sintetiza é um modelo juiz ou o próprio Claude.

- Comando no Claude: `/opc:conclave`
- Terminal: `opc conclave`
- Fase de entrega: F4c

## Início rápido

```bash
# Opinião de três modelos (pool padrão da config), síntese pelo Claude
opc conclave "Devemos guardar a config do CLI em JSON ou TOML?"

# Modelos explícitos e debate de 2 rodadas
opc conclave --models fast,strong,k3 --mode debate "Vale a pena um write-ahead log aqui?"

# Review cruzado do diff atual, com juiz modelo
opc conclave --mode review --judge strong "Foque em segurança"
```

No Claude, use `/opc:conclave <pergunta> [flags]`. O comando roda o conclave e, quando o juiz é
o Claude, aplica a skill `opc-conclave` para sintetizar.

## Modos

| Modo | O que faz | Rodadas |
|---|---|---|
| `opinion` (padrão) | Cada membro responde à pergunta, às cegas | `--rounds` ou `conclave.rounds` (padrão 1); com 2 ou 3, roda também as rodadas de debate |
| `debate` | Rodada 1 às cegas, depois rodadas em que cada membro vê as respostas anônimas dos outros | padrão 2; aceita 2 ou 3; `--rounds 1` é erro |
| `review` | Cada membro faz o review do mesmo diff; os achados são agrupados e contados | sempre 1; `--rounds` diferente de 1 é erro |

`--rounds` aceita de 1 a 3. Acima disso, erro de uso (exit 2).

## Composição

- **Membros:** `--models a,b,c` (aliases, IDs completos ou nomes curtos no `defaultProvider`)
  **ou** `--pool nome` (lista em `conclave.pools`). Sem nenhum dos dois, vale
  `conclave.defaultPool`. As duas flags juntas são erro de uso.
- **Política:** cada membro passa pela política (provider e modelo). Entradas negadas,
  inexistentes, de provider desconectado ou duplicadas (o mesmo modelo por alias e por ID) são
  **puladas com aviso** no stderr (`[opc] conclave: skipping ...`).
- **Mínimo de 2 membros válidos.** Com menos, erro de uso (exit 2) listando cada entrada e o
  motivo. Se **todas** as entradas foram negadas pela política, o erro é de política (exit 4).
- **Rótulos:** os membros são embaralhados e recebem `A`, `B`, `C`… O mapeamento rótulo →
  modelo fica só no job e aparece no **fim** da saída, na seção "Composição".
- **Quorum:** `--quorum N` ou `conclave.quorum` (padrão 2). Precisa ficar entre 2 e o número de
  membros válidos; fora disso, erro de uso.

## Rodadas e anonimização

1. **Rodada 1 (cega):** mesma pergunta para todos, cada membro na sua sessão, em paralelo
   (até `jobs.maxParallel`). Perfil `read-only`: o membro pode ler, buscar e listar arquivos
   do workspace, mas não edita nem roda comandos. Resposta no schema `conclave-member`:
   `position`, `confidence` (0 a 1), `key_points`, `risks`, `evidence`
   (`file`, `line_start`, `line_end`, `note`) e `would_change_mind_if`.
2. **Rodadas 2 e 3:** cada membro continua **na mesma sessão** e recebe as respostas da rodada
   anterior dos outros membros, por rótulo. Devolve o mesmo schema mais `critiques`
   (`target`, `point`, com `target` restrito aos rótulos dos colegas) e `changed` (se mudou de
   posição).
3. **Anonimização:** antes de repassar respostas a outro membro ou ao juiz, o opc remove do
   texto os nomes conhecidos e põe `[redacted]` no lugar. A lista vem do catálogo `/provider`:
   - IDs de provider (`omniroute-personal`) e as palavras que os compõem;
   - IDs de modelo completos e parciais (`opencode-go/kimi-k3`, `kimi-k3`, `opencode-go`);
   - nomes de exibição dos modelos (`Kimi K3`);
   - a família de cada modelo (`kimi`, `qwen`, `deepseek`), inclusive com sufixos de versão
     (`Qwen3.8`, `KIMI-k3`);
   - os vendors conhecidos dessas famílias (por exemplo `moonshot`, `alibaba`, `openai`).

   Palavras genéricas que aparecem em IDs (`flash`, `max`, `pro`, `mini`, `code`…) **não** são
   removidas.

**Limites da anonimização** (documentados de propósito):

- A **pergunta do usuário** vai igual para todos. Se você citar um modelo na pergunta, ele
  aparece.
- O estilo de escrita de um modelo não é disfarçado.
- Uma palavra comum que também seja nome de provider conectado (ex.: um provider chamado
  `opencode`) é removida das respostas repassadas.

## Quorum e falhas

- Um membro é **descartado da rodada** e listado em "Falhas" quando:
  - o turno falha (erro do provider, servidor, cancelamento do membro);
  - estoura `conclave.memberTimeoutSec` (o opc aborta a sessão; tipo `Timeout`);
  - devolve `StructuredOutputError` (o texto bruto fica em `rawText`, até 4 KB);
  - devolve saída estruturada fora do schema (`InvalidStructuredOutput`) ou nenhuma
    (`MissingStructuredOutput`).
- Membro descartado **não volta** nas rodadas seguintes.
- Membros não têm fallback de modelo: cada membro é um modelo específico.
- Se as respostas válidas de uma rodada ficarem **abaixo do quorum**, o grupo termina `failed`
  (exit 7), sem juiz, entregando as respostas parciais e as falhas.

## Síntese

| Juiz | Como funciona |
|---|---|
| `claude` (padrão) | O pacote traz `synthesisInput` (respostas anonimizadas, por rótulo). A skill `opc-conclave` orienta o Claude a sintetizar consenso, divergências, posição ponderada, confiança, recomendação e relatórios minoritários, sem viés de marca |
| `<modelo>` | Uma sessão `read-only` com o prompt `conclave-judge.md` e o schema `conclave-synthesis`. O juiz vê só rótulos |

- Juiz que também é membro exige `--allow-judge-member` (senão, erro de uso).
- O juiz modelo passa pela política; negado → exit 4.
- Se o juiz modelo falhar, o conclave continua `completed`, com aviso, e o Claude sintetiza a
  partir de `synthesisInput`.

Schema `conclave-synthesis`: `consensus[]`, `disagreements[{topic, positions[{members[],
stance}]}]`, `weighted_position`, `confidence` (0 a 1), `recommendation`,
`minority_reports[{members[], summary}]`.

## Modo review

- O opc coleta o diff uma vez (mesma regra do `/opc:review`: `--base`, `--scope`, staged,
  unstaged e untracked; diff grande em partes) e manda o mesmo prompt e o schema
  `review-output` a todos os membros.
- A pergunta é opcional e vira o foco do review.
- **Agrupamento (dedupe):** dois achados entram no mesmo cluster quando:
  1. estão no **mesmo arquivo** (caminhos normalizados: `./` e `\` não importam);
  2. as linhas **se sobrepõem ou distam até 3** (um achado sem linhas só se junta a outro sem
     linhas);
  3. os títulos têm similaridade (Jaccard de tokens, sem acentos e sem palavras vazias)
     **≥ 0,3**.
- **Achados sem arquivo** (vazio, `N/A`, `-`, `none`…) nunca são agrupados: cada um vira um
  cluster próprio com concordância `1/N`.
- **Cluster:** severidade máxima, concordância `k/N` (N = membros válidos, inclusive os que não
  acharam nada), confiança média, rótulos que o encontraram e o título, corpo e recomendação do
  achado de maior confiança.
- **Veredito:** `needs-attention` se algum cluster com severidade `high` ou `critical` tiver
  concordância ≥ 2, **ou** se mais da metade dos membros válidos der `needs-attention`. Senão,
  `approve`. Um review com `needs-attention` sai com exit 0.
- O conclave não corrige nada.

## Saída

**Markdown** (padrão):

1. Cabeçalho: status, rodadas concluídas/pedidas, quorum, válidos/membros, duração e id do job.
2. Falha do grupo (se houver), avisos e tabela de falhas.
3. Pergunta.
4. Corpo: respostas da rodada final por rótulo (opinion/debate) ou veredito e clusters
   (review).
5. Síntese (juiz modelo) ou a instrução para o Claude sintetizar.
6. **Composição** (rótulo → modelo), sempre por último.

**`--json`** devolve o pacote completo:

| Campo | Conteúdo |
|---|---|
| `jobId`, `schemaVersion`, `kind`, `status`, `failure` | Identificação e resultado (`failure.code`: `QUORUM_NOT_MET` ou `REVIEW_CONTEXT_FAILED`) |
| `mode`, `question`, `rounds{requested, completed}`, `quorum` | Parâmetros efetivos |
| `startedAt`, `endedAt`, `durationMs` | Tempo |
| `warnings[]`, `failures[{label, round, role, errorType, errorClass, message, rawText}]` | Avisos e membros descartados |
| `roundsData[{round, responses[{label, response}], failures[]}]` | Todas as rodadas, respostas originais (não anonimizadas) |
| `final{round, responses[]}` | Respostas válidas da última rodada |
| `review` | Só no modo review: `validMembers`, `memberVerdicts`, `verdict`, `reasons[]`, `clusters[]` |
| `judge` | `{type:"claude", status:"pending"}` ou `{type:"model", model, status, synthesis \| error}`; `status:"skipped"` quando o grupo falhou |
| `synthesisInput` | Pacote anonimizado para a síntese pelo Claude (`null` se o grupo falhou) |
| `composition[{label, model}]` | Mapeamento rótulo → modelo (último campo) |

## Jobs

- O conclave é um **job-grupo** (`conc-…`) com um job por membro (`role: member:A`…) e, com
  juiz modelo, um job `judge`. Um único worker coordena tudo, com uma conexão SSE
  compartilhada.
- `--background` devolve o id na hora; acompanhe com `/opc:status <id>` e veja com
  `/opc:result <id>` (`--json` devolve `{ group, members }`, com o pacote em `group.result`).
- `/opc:cancel <id>` cancela o grupo; cancelar o job de um membro aborta só a sessão dele (o
  membro vira falha e o quorum decide).
- Limites: cada conclave ocupa **1** vaga em `jobs.maxActive` (só o grupo conta; membros e juiz
  não); os turnos
  simultâneos respeitam `jobs.maxParallel`.

## Configuração

```json
{
  "conclave": {
    "pools": { "default": ["fast", "strong", "k3"], "duo": ["fast", "strong"] },
    "defaultPool": "default",
    "judge": "claude",
    "rounds": 1,
    "quorum": 2,
    "memberTimeoutSec": 900
  }
}
```

Detalhes de cada chave em [configuration.md](configuration.md#conclave). O `.opc.json` do
workspace pode sobrescrever essas preferências, mas todo modelo continua passando pela política.

## Custos e tempo

Um conclave custa aproximadamente `membros × rodadas` turnos, mais um turno de juiz modelo.
Controles: `--rounds` (máximo 3), `--quorum`, `jobs.maxParallel`, `jobs.maxActive` e
`conclave.memberTimeoutSec`.

## Exit codes

| Código | Quando |
|---|---|
| 0 | Conclave concluído (inclusive review com `needs-attention` e juiz modelo que falhou) |
| 2 | Composição inválida (menos de 2 membros, quorum, rodadas, modo, flags conflitantes, juiz membro sem `--allow-judge-member`) |
| 4 | Todos os membros negados pela política, juiz negado, ou execução de dentro do servidor OpenCode (`OPC_INSIDE_SERVER=1`: delegação não recursa) |
| 5 | Servidor OpenCode indisponível |
| 6 | `--wait-timeout` estourou (o conclave continua em background) |
| 7 | Quorum não atingido ou falha ao coletar o diff |
| 130 | Conclave cancelado |

## Exemplos executados

Saídas reais do portão da F4c (redigidas: caminhos pessoais trocados por `~`).

### Opinião com três modelos

```bash
opc conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max,omniroute-personal/opencode-go/kimi-k3 "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
```

<!-- F4C-LIVE-OUTPUT: opinion -->

### Debate de duas rodadas com juiz modelo

```bash
opc conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max --mode debate --rounds 2 --judge omniroute-personal/opencode-go/kimi-k3 "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
```

<!-- F4C-LIVE-OUTPUT: debate -->

### Review cruzado

```bash
opc conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max,omniroute-personal/opencode-go/kimi-k3 --mode review "Foque em correção e segurança"
```

<!-- F4C-LIVE-OUTPUT: review -->

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `a conclave needs at least 2 valid members` | Entradas negadas, inexistentes ou duplicadas | Leia os avisos `skipping` no stderr; ajuste `--models` ou a pool |
| `quorum must be an integer between 2 and N` | `--quorum` (ou `conclave.quorum`) maior que os membros válidos | Diminua o quorum ou acrescente membros |
| Exit 7 com `QUORUM_NOT_MET` | Membros estouraram o tempo ou falharam no schema | Veja a tabela de falhas; aumente `conclave.memberTimeoutSec` ou troque o modelo |
| Membro com `InvalidStructuredOutput` | O modelo devolveu JSON fora do schema | Troque o membro; modelos sem suporte a `json_schema` não servem para o conclave |
| `judge ... failed` nos avisos | O juiz modelo falhou | O Claude sintetiza a partir do pacote; ou rode de novo com outro `--judge` |
| `[redacted]` em trechos das respostas | Anonimização de nomes de modelo/vendor/provider | Esperado; a composição está no fim da saída |
````
````markdown
## /opc:conclave

Consulta vários modelos em paralelo e sintetiza consenso, divergências e recomendação. Guia
completo: [conclave.md](conclave.md).

- **Fase:** F4c · **Modelo invoca:** sim · **Terminal:** `opc conclave`
- **Uso:** `/opc:conclave <pergunta> [--models a,b,c | --pool nome] [--mode opinion|review|debate] [--rounds 1-3] [--judge claude|<modelo>] [--quorum N] [--allow-judge-member] [--background]`

| Flag | Padrão | Descrição |
|---|---|---|
| `<pergunta>` | — | Obrigatória em `opinion` e `debate`; no `review`, vira o foco |
| `--models a,b,c` | — | Membros (aliases, IDs completos ou nomes curtos). Exclusiva com `--pool` |
| `--pool nome` | `conclave.defaultPool` | Pool definida em `conclave.pools` |
| `--mode` | `opinion` | `opinion`, `debate` (rodadas ≥ 2) ou `review` (diff atual, 1 rodada) |
| `--rounds N` | `opinion`: `conclave.rounds`; `debate`: 2 | De 1 a 3 |
| `--judge` | `conclave.judge` (`claude`) | `claude` ou um modelo (passa pela política) |
| `--quorum N` | `conclave.quorum` (2) | Respostas válidas mínimas por rodada; entre 2 e o número de membros |
| `--allow-judge-member` | desligado | Permite que o juiz seja também membro |
| `--background` | desligado | Devolve o id do job na hora |
| `--wait-timeout s` | sem limite | Tempo máximo de espera em foreground (exit 6; o job continua) |
| `--base ref`, `--scope auto\|working-tree\|branch` | `auto` | Só no `--mode review` (mesma regra do `/opc:review`) |
| `--json` | desligado | Pacote completo em JSON |

**Exit codes:** 0 concluído (inclusive review `needs-attention`) · 2 composição inválida ·
4 política (ou chamado de dentro do servidor OpenCode) · 5 servidor · 6 `--wait-timeout` · 7 quorum não atingido · 130 cancelado.

**Exemplos:**

```bash
opc conclave "JSON ou TOML para a config do CLI?"
opc conclave --models fast,strong,k3 --mode debate --rounds 2 --judge strong "Vale um write-ahead log?"
opc conclave --mode review --quorum 2 "Foque em segurança"
opc conclave --pool duo --background "Qual estratégia de cache?"
```

Saídas reais: seção "Exemplos executados" do [conclave.md](conclave.md#exemplos-executados).
````
````markdown
## conclave

Preferências do `/opc:conclave` ([guia](conclave.md)). Podem ser sobrescritas no `.opc.json`;
todo modelo citado continua passando pela política (`policy.*`).

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `conclave.pools` | objeto `{nome: [modelos]}` | `{}` | Listas de membros; cada entrada aceita alias, ID completo ou nome curto |
| `conclave.defaultPool` | string | `"default"` | Pool usada quando não há `--models` nem `--pool` |
| `conclave.judge` | `"claude"` ou modelo | `"claude"` | Juiz padrão da síntese |
| `conclave.rounds` | inteiro 1–3 | `1` | Rodadas do modo `opinion`; o `debate` usa o maior entre 2 e este valor |
| `conclave.quorum` | inteiro ≥ 2 | `2` | Respostas válidas mínimas por rodada (não pode passar do número de membros) |
| `conclave.memberTimeoutSec` | inteiro | `900` | Tempo máximo de cada turno de membro ou juiz; ao estourar, a sessão é abortada e o membro descartado |

Relacionadas: `jobs.maxParallel` (turnos simultâneos do conclave) e `jobs.maxActive` (cada
conclave ocupa 1 vaga — só o job-grupo conta).

```bash
opc config set conclave.judge omniroute-personal/opencode-go/qwen3.8-max
opc config set conclave.memberTimeoutSec 600 --workspace
```
