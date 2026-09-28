# opc F4c — Conclave · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o `/opc:conclave` (e `opc conclave`): consulta paralela a N ≥ 2 modelos do OpenCode nos modos `opinion`, `debate` e `review`, com rótulos aleatórios, anonimização, quorum por rodada, agrupamento de achados com concordância `k/N` e síntese por juiz modelo ou pelo Claude (skill `opc-conclave`).

**Architecture:** `lib/conclave.mjs` concentra a lógica pura e testável — composição (`composeMembers`), anonimização (`anonymize`), agrupamento (`clusterFindings`), veredito (`conclaveVerdict`) e a orquestração das rodadas (`runConclave`), que recebe o turno por injeção (`deps.turn`) e nunca fala HTTP (spec §3.1). O subcomando `scripts/commands/conclave.mjs` resolve a composição contra o catálogo e a política, registra um job-grupo `conc-…` com um job por membro (e juiz) por `createGroup` (F3) e dispara **um** worker coordenador; o worker (`runWorker`, despachado pelo `task-worker` via `WORKER_DELEGATES.conclave`) liga `deps.turn` ao `runTurn` da F2a com uma única `EventHub` compartilhada (`openApi(ctx, { withHub: true, respawn: false })`), grava o pacote em `job.result` e o Markdown de `renderConclave` em `job.rendered`.

**Tech Stack:** Node.js ≥ 20 (ESM `.mjs`, `node:test`), zero dependências, OpenCode 1.18.32 (API v1, `format: {type:"json_schema"}`), servidor falso `tests/fixtures/fake-opencode.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3) — §11 inteiro, §4 (linha `/opc:conclave`), §6.5, §8.1, §9.1, §13.3 (F4c). **Mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` (estrutura, contrato de interfaces, convenções de teste, regras de git e portão — congelados). Quem executa lê os três.

**Depende de:** F4a entregue exatamente conforme o contrato do mestre (e, portanto, F0–F3). F4b não é pré-requisito.

---

## Global Constraints

- Node ≥ 20; ESM `.mjs`; zero dependências de runtime e de desenvolvimento; testes só com `node:test`.
- Código, identificadores, prompts enviados aos modelos, mensagens de commit e nomes de arquivo em inglês; docs e textos voltados ao usuário (render, skill, slash command) em PT-BR.
- Só a API v1 do OpenCode; servidor em `127.0.0.1`; nenhuma escrita em `~/.config/opencode/` nem no `auth.json`.
- Todo modelo usado pelo conclave (membros e juiz) passa pela política efetiva (spec §6.5); lista com entrada negada → pula com aviso; valor único negado → exit 4.
- Membros e juiz rodam **sempre** no perfil `read-only` (spec §8.1); qualquer pedido de permissão ou pergunta recebe `reject` imediato.
- `always` nunca é enviado; nenhuma flag de bypass.
- Exit codes da spec §4.1: `0, 2, 3, 4, 5, 6, 7, 130`.
- Ids de job com prefixo `conc-` (spec §9.1); títulos de sessão com prefixo `OPC: `.
- Mínimo de 2 membros; `2 ≤ quorum ≤ membros`; `1 ≤ rounds ≤ 3`; `debate` ⇒ `rounds ≥ 2` (padrão 2).
- O mapeamento rótulo → modelo só existe nos registros de job e na seção final "Composição" (último campo do pacote JSON).
- Toda saída passa por `ctx.out`/`ctx.json`/`ctx.err` (redação do F0).
- Testes ao vivo só com `OPC_LIVE=1`, nunca no CI, em diretório descartável; pool `omniroute-personal/opencode-go/{deepseek-v4.1-flash,qwen3.8-max,kimi-k3}` + 1 extra escolhido do catálogo em runtime e filtrado pela política.
- Git: branch `feat/opc-f4c`; Conventional Commits; **sem** `Co-Authored-By`, `Signed-off-by` ou "Generated with"; commit, push e PR só com autorização explícita do operador na sessão de execução (pedir antes do primeiro commit se ela não existir); nada de `--no-verify`, `push --force`, `reset --hard`.

## Review Focus

Entradas que a spec implica, que nenhum teste de aceite da §13.3 cobre diretamente e que mais
provavelmente quebram o uso real. Cada linha tem teste na tarefa dona.

1. **Membro que se identifica com variações de caixa e de versão** (`QWEN3.8-max`, `Qwen3`, `kimi-k3 from Moonshot`, `ChatGPT`) ou cita outro vendor → tudo vira `[redacted]` antes do debate e do juiz, sem apagar prosa comum (`flash`, `max`, `code`). [Tarefa 4, testes `self-identification is scrubbed…` e `ordinary prose…`]
2. **Pergunta com crases, `$()`, aspas, quebra de linha e unicode** → chega idêntica a todos os membros e nada é expandido pelo shell. [Tarefa 7, teste `user question passes through verbatim…`; Tarefa 11, teste `the question reaches every member intact…`]
3. **Pool com aliases, duplicatas (mesmo modelo por alias e por ID), entradas inexistentes e negadas** → deduplica e pula com aviso; menos de 2 válidos → exit 2 listando os motivos; todos negados → exit 4. [Tarefa 3, testes `denied, unknown and duplicate…`, `fewer than 2…`, `every member denied…`]
4. **Saída estruturada que é JSON mas viola o schema** (`confidence: 1.7`, campo extra, campo faltando) **ou vazia** → membro descartado como `InvalidStructuredOutput`/`MissingStructuredOutput`, nunca crash. [Tarefa 7, testes `structured output that violates…`, `a completed turn without structured output…`, `a turn that throws…`]
5. **Achados de review com localização malformada** (intervalo invertido, linha em string ou `null`, caminho com `./` ou `\`, `file` = `"N/A"`/`"-"`/vazio, schema estrito que exige `file`) → normaliza, nunca quebra, pseudo-arquivos nunca agrupam. [Tarefa 5, testes `malformed line numbers…` e `findings without file…`; Tarefa 8, teste `findings without a location pass validation…`]

---

## Premissas sobre F0–F4a

O mestre congela nomes e assinaturas, mas alguns detalhes de comportamento que este plano
consome foram definidos dentro dos planos das fases anteriores. Estas são as premissas; a
**Tarefa 0** confere cada uma (P1–P14) e registra o resultado no relatório. Premissa que não se confirma
segue a coluna "Se divergir" — e, se isso exigir mudar interface congelada, **para e escala ao
operador** (regra do mestre).

| # | Premissa | Onde se confere | Se divergir |
|---|---|---|---|
| P1 | **Confirmada (F0 Task 4, `coerce`/`parseArgs`):** `type: 'list'` divide por vírgula, apara e acumula repetições (`--models a,b --models c` → `['a','b','c']`); **ausente → `[]`** (não `undefined`), por isso a Tarefa 11 normaliza `flags.models.length ? flags.models : null` | `lib/args.mjs` | — (se a F0 mudar, trocar para `type: 'string'` + `split(',')`) |
| P2 | **Ajustada (F2a `KIND_PREFIX` + F3 `createGroup`, reconciliação D4.1/D4.6):** o id é gerado pelo `kind` — `conclave`, `conclave-member` e `conclave-judge` → prefixo `conc-` — e ninguém passa `id:`; o grupo e os membros nascem juntos por `createGroup(stateDir, groupFields, members, { maxActive })` (grupo com `role: GROUP_ROLE` e `memberIds`; membro com `kind` próprio via `fields.kind`), sob `withServerLock` (F2b) | `lib/jobs.mjs` | — |
| P3 | **Ajustada (F3 Task 9, D4.6):** o `task-worker` despacha por `WORKER_DELEGATES[stored.kind]` logo após ler o job e antes do turno; a F4c só acrescenta `conclave: './conclave.mjs'` ao literal, e `conclave.mjs` exporta `runWorker(ctx, job)`. `request.type: 'conclave'` fica apenas como discriminador do payload | `scripts/commands/task-worker.mjs` | — |
| P4 | **Confirmada (F3 Task 10, `resultForGroupOrCommand`):** `result` de job-grupo imprime `job.rendered` (ou `renderGroupResult`) e, com `--json`, `{ group, members }` — o pacote fica em `group.result`; nenhum ramo próprio no `result.mjs` | `scripts/commands/result.mjs` | — |
| P5 | `runTurn` chama `onPermission(req)`/`onQuestion(q)` com o objeto do evento (`req.id`/`q.id`); timeout → `{status:'failed', errorType:'Timeout'}` após `POST /session/:id/abort`; `StructuredOutputError` → `status:'failed'`, `errorType:'StructuredOutputError'`, `finalText` com o texto bruto | `lib/runner.mjs`, `lib/errors.mjs` | Ajustar só as strings esperadas nos testes de integração (`'Timeout'`) e na doc; a lib não depende desses nomes |
| P6 | Fake: cenário `{ onPromptAsync(fake, sessionID, body) }`; `fake.emitTurn(sessionID, { text, structured, error, delayMs })`; rota `POST /session/:id/abort`; `state.requests[]` com `{method, path (sem query), query, body}` | `tests/fixtures/fake-opencode.mjs` | Adaptar só `tests/fixtures/scenarios/_conclave-common.mjs` (ponto único) |
| P7 | A fixture de `/provider` tem `omniroute-personal` **conectado** com `opencode-go/deepseek-v4.1-flash`, `opencode-go/qwen3.8-max` e `opencode-go/kimi-k3` | `tests/fixtures/data/` | Parar e escalar (mudar fixture compartilhada afeta F1–F4a) |
| P8 | **Ajustada (F2b Task 5):** `prompts/review.md` usa `{TARGET_LABEL, PROJECT_CONTEXT, REVIEW_COLLECTION_GUIDANCE, REVIEW_INPUT}` — **sem** `USER_FOCUS` (só o `adversarial-review.md` tem) — e começa com um comentário de atribuição que `loadPrompt` (F2b) remove. A Tarefa 8 preenche também `PROJECT_CONTEXT` (o `fillTemplate` estrito falharia sem ele) e, quando o template não tem `{{USER_FOCUS}}`, anexa a pergunta como bloco `<user_focus>` (A19); `loadConclaveAssets` lê o review por `loadPrompt`. `schemas/review-output.schema.json` no formato do codex (`verdict`, `summary`, `findings[{severity, title, body, file, line_start, line_end, confidence, recommendation}]`, `next_steps`) | `plugins/opc/prompts/review.md`, `plugins/opc/schemas/` | Se a F2b mudar os placeholders, o teste `the review prompt shipped by F2b…` acusa; acrescentar o nome em `reviewTemplateVars` |
| P9 | `DEFAULT_CONFIG.conclave` existe com os valores da spec §3.2 e config parcial em `config.json` é mesclada sobre o padrão | `lib/config.mjs` | Parar e escalar (é entrega da F1) |
| P10 | `redact()` casa **nomes exatos** de chave (`key_points` não vira `***`) | `lib/redact.mjs` | Parar e escalar (bug do F0 que corromperia o pacote) |
| P11 | `waitForJob(ctx, id, { waitTimeoutMs: undefined, onLog })` espera sem limite e entrega linhas do log a `onLog` | `lib/jobs.mjs` | Passar o padrão que a F2a usa no `task` foreground |
| P12 | `buildPermissionRules('read-only', …)[0]` é `{ permission: '*', pattern: '*', action: 'deny' }` (a Tarefa 11 obtém as regras por `profileRules(ctx, 'read-only')`, F3, que só embrulha `buildPermissionRules`) | `lib/policy.mjs` | Ajustar as asserções de integração ao formato real (a regra continua sendo a 1ª) |
| P13 | **Confirmada (F3 Task 10):** `status`, `result` e `cancel` tratam como grupo o job com `role: GROUP_ROLE` e listam os membros por `memberIds`/`groupId` (`status --json`/`result --json` → `{ group, members }`); o `refreshGroup` da F3 só é chamado pelo coordenador de `sub`, então o conclave grava `status`/`result`/`rendered` do grupo por conta própria | `scripts/commands/status.mjs`, `result.mjs`, `cancel.mjs` | — |
| P14 | **Confirmada (F0 `main`/`extractCwd`):** o dispatcher remove `--cwd` do `argv` antes do subcomando e `ctx.cwd` já o reflete (por isso o `SPEC` da Tarefa 11 **não** declara `cwd`); `--json` chega intacto ao subcomando. `--args-stdin` é resolvido no dispatcher, mas `--raw-args-stdin` não: o comando o trata com `readRawArgs` (F2a) | `scripts/opc-companion.mjs`, `lib/args.mjs` | — |

---

## Interfaces novas

Acrescentadas por esta fase (nada congelado é renomeado ou alterado).

**`plugins/opc/scripts/lib/conclave.mjs`** — além dos nomes congelados (`composeMembers`,
`anonymize`, `clusterFindings`, `conclaveVerdict`, `runConclave`):

```js
export const CONCLAVE_MODES            // ['opinion', 'review', 'debate']
export const LABEL_ALPHABET            // 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const REDACTED_NAME             // '[redacted]'
export const PEER_RESPONSE_MAX_CHARS   // 16384 (por resposta repassada no debate/juiz)
export const RAW_TEXT_MAX_CHARS        // 4096 (texto bruto guardado em failures[].rawText)
export const CLUSTER_LINE_GAP          // 3
export const CLUSTER_TITLE_THRESHOLD   // 0.3
export const SEVERITY_ORDER            // ['low', 'medium', 'high', 'critical']
export function validateSchema(value, schema)                 // → Array<{ path, message }> (subconjunto de JSON Schema)
export function buildMemberSchema(memberSchemaFile)           // → schema sem $schema/$defs
export function buildDebateSchema(memberSchemaFile, peerLabels = [])   // → schema 'ConclaveDebate' (+critiques, +changed; target ∈ peerLabels)
export function buildSynthesisSchema(synthesisSchemaFile, labels = []) // → schema com members ∈ labels
export function loadConclaveAssets(pluginRoot?)               // → { prompts: {member, debate, judge, review}, schemas: {member, synthesis, review} }
export function validateConclaveOptions({ mode, models, pool, quorum, rounds, config }) // → { rounds } ; UsageError-equivalente (exit 2)
export function buildKnownNames(catalog, { extraModels = [] } = {})     // → { exact: string[], families: string[] }
export function anonymizeValue(value, knownNames)             // anonymize em todas as strings de um objeto/array
export function titleTokens(title)                            // → Set<string>
export function titleSimilarity(a, b)                         // → Jaccard 0..1
```

Assinaturas detalhadas dos congelados:

```js
composeMembers({ models = null, pool = null, config = {}, catalog, policy = config.policy, quorum = null, rounds = null,
                 mode = 'opinion', judge = null, allowJudgeMember = false, rng = Math.random })
  // → { mode, members: [{ label, providerID, modelID, full, source }], quorum, rounds,
  //     judge: { type: 'claude' } | { type: 'model', providerID, modelID, full }, warnings: string[], skipped: [{ entry, reason, denied }] }
anonymize(text, knownNames)            // knownNames: { exact, families } | string[] → string
clusterFindings(findingsByMember, { validCount = null } = {})
  // findingsByMember: { [label]: Finding[] } (inclui membros válidos sem achados)
  // → [{ id:'C1', file|null, line_start, line_end, severity, title, body, recommendation,
  //      agreement: { k, n, text: 'k/n' }, labels[], meanConfidence|null, bestLabel, findings[] }]
conclaveVerdict(clusters, memberVerdicts)   // memberVerdicts: { [label]: 'approve'|'needs-attention' }
  // → { verdict: 'approve'|'needs-attention', reasons: [{ code: 'SEVERE_FINDING_AGREED', clusterId, severity, agreement } | { code: 'MAJORITY_NEEDS_ATTENTION', count, of }] }
runConclave({ ctx = {}, question = '', flags, deps })
  // flags: { mode, rounds, quorum, members, judge, maxParallel?, warnings? }
  // deps:  { turn(spec) → TurnResult, assets?, knownNames?, now?, onEvent?, collectReview? }
  //   spec: { role: 'member'|'judge', label, round|null, member, sessionID|null, prompt, schema, title }
  //   TurnResult: o retorno de runTurn (status, sessionID, structured, finalText, errorType, errorClass, errorMessage)
  // → pacote (ver Tarefa 7): { schemaVersion, kind, status, failure, mode, question, rounds, quorum, startedAt, endedAt,
  //     durationMs, warnings, failures, roundsData, final, review, judge, synthesisInput, composition }
```

**`plugins/opc/scripts/lib/render.mjs`:** `renderConclave(pkg)` → Markdown (nome já previsto no mestre).

**`plugins/opc/scripts/commands/conclave.mjs`:** `run(ctx, argv)` (contrato da CLI) e
`runWorker(ctx, job)` → exit code (corpo do worker coordenador; nome exigido pelo
`WORKER_DELEGATES` da F3).

**Helpers de texto consumidos (não redefinidos):** `fillTemplate(template, vars, { strict: true })`,
`projectContextBlock(project)` (formato `goal:`/`scope:`/`task types:`) e `loadPrompt(name, { dir })`
de `lib/prompts.mjs` (F2b, reconciliação D10).

**Registros de job e request do grupo** (via `createGroup` da F3, sem mudar assinatura):

```js
// grupo: { id: 'conc-…' /* gerado pelo kind */, kind: 'conclave', role: GROUP_ROLE, memberIds,
//          title: 'OPC: conclave: <mode>', permissionProfile: 'read-only',
//          request: { type: 'conclave' /* discriminador do payload; o despacho é por kind */, question, mode, rounds, quorum,
//                     members: [{ label, providerID, modelID, full, source, jobId }],
//                     judge: { type: 'claude', jobId: null } | { type: 'model', providerID, modelID, full, jobId },
//                     warnings, target /* resolveReviewTarget ou null */, reviewCwd },
//          result: { jobId, ...pacote }, rendered: string }
// membro: { kind: 'conclave-member', groupId, role: 'member:<rótulo>', model, sessionID }
// juiz:   { kind: 'conclave-judge',  groupId, role: 'judge', model, sessionID }
```

O `task-worker` despacha para `runWorker` de `conclave.mjs` por `WORKER_DELEGATES[job.kind]`
(`conclave: './conclave.mjs'`, acrescentado ao literal da F3). `opc result <conc-id> --json`
devolve `{ group, members }` (F3) com o pacote em `group.result`.

**Só de teste:** `tests/fixtures/scenarios/_conclave-common.mjs` (`HANG`, `textOf`, `kindOf`,
`familyOf`, `tagList`, `memberAnswer`, `debateAnswer`, `synthesisFor`, `reviewAnswer`,
`STRUCTURED_ERROR`, `makeConclaveScenario`), `tests/unit/_conclave-fixtures.mjs`,
`tests/integration/_conclave-helpers.mjs`, `tests/live/_f4c-lib.mjs`.

---

## Ambiguidades resolvidas

| # | Ambiguidade na spec | Decisão |
|---|---|---|
| A1 | `opinion` com `--rounds > 1` | Permitido: roda as rodadas 2..N como no debate (spec §11.1.3 vale para qualquer modo). `debate` = rodadas ≥ 2 com padrão 2 (`max(2, conclave.rounds)`); `review` = sempre 1 (outro valor é erro de uso), porque a §11.2 não define debate de review |
| A2 | Membro descartado numa rodada volta na seguinte? | Não. Sem resposta válida, não há posição para debater |
| A3 | Quorum não atingido: roda o juiz? | Não. Grupo `failed` (exit 7), `judge.status: 'skipped'`, `synthesisInput: null`, respostas parciais em `final` e `roundsData` |
| A4 | Juiz modelo falha | Conclave continua `completed` (exit 0) com aviso; `judge.status: 'failed'`; o Claude sintetiza de `synthesisInput` |
| A5 | Anonimizar a pergunta do usuário? | Não: só o texto produzido pelos membros é anonimizado (a pergunta é do usuário e vai igual para todos). Documentado em `docs/conclave.md` |
| A6 | Lista de nomes conhecidos | Exatos: IDs de provider (e suas palavras), IDs de modelo completos/parciais, namespaces (`opencode-go`), nomes de exibição. Famílias: prefixo alfabético dos tokens do ID/nome (`qwen3.8` → `qwen`), ≥ 3 letras, fora de uma lista de palavras genéricas; casam com sufixos de versão. Vendors: mapa fixo família → vendor (`kimi` → `moonshot`…). Substituição por `[redacted]` |
| A7 | Linhas ausentes em achados do mesmo arquivo | Dois sem linhas → próximos; um com e outro sem → não agrupam. Intervalo invertido é normalizado |
| A8 | Método de agrupamento | Ligação simples (union-find) sobre todos os pares; achados repetidos do mesmo membro podem cair no mesmo cluster, mas `k` conta rótulos distintos |
| A9 | "Confiança média" | Média das confianças dos achados do cluster (ignora ausentes; nenhum → `null`), com 2 casas |
| A10 | N de `k/N` | Membros com resposta de review válida, inclusive os que não acharam nada |
| A11 | Achado sem `file` quando o schema do review exige `file` | Membros recebem o schema estrito da F2b; a **validação** local usa uma cópia que aceita `file`/linhas ausentes ou nulos. `""`, `N/A`, `-`, `none`, `(none)`, `null`, `unknown`, `general`, `global`, `*` contam como "sem arquivo" |
| A12 | Saída estruturada que não bate com o schema | Descartada como `InvalidStructuredOutput` (validação local com `validateSchema`) |
| A13 | Onde fica a extensão de debate do schema | Em `$defs.debateExtension` do próprio `conclave-member.schema.json`; `buildDebateSchema` a aplica e injeta `enum` com os rótulos dos colegas; `$schema`/`$defs` nunca vão ao provider |
| A14 | Membros com problema na lista | Entrada inválida, desconectada, negada ou duplicada → pula com aviso (§6.5, listas). Sobrar < 2 → exit 2; **todas** negadas pela política → exit 4. Juiz (valor único) inexistente → exit 2; negado → exit 4 |
| A15 | `conclave.quorum` da config maior que os membros | Erro de uso (não há clamp silencioso) |
| A16 | Timeout do juiz e flag de timeout | `conclave.memberTimeoutSec` vale para membros e juiz; sem flag nova. `--wait-timeout` (espera do foreground) segue a semântica da F2a |
| A17 | Fallback de modelo nos membros | Nunca: cada membro é um modelo específico (§6.6) |
| A18 | Respostas muito grandes no debate | Cada resposta repassada (debate e juiz) é cortada em 16 KB com marcador `…[truncated N chars]` |
| A19 | `--base`/`--scope` fora do review; pergunta no review | `--base`/`--scope` só no `review` (erro de uso fora dele); no `review` a pergunta é opcional e vira o foco (`USER_FOCUS`) |
| A20 | Idioma do Markdown renderizado | PT-BR (texto voltado ao usuário); pacote JSON com chaves em inglês |
| A21 | Registros de job | 1 grupo `kind:'conclave'` + 1 por membro (`kind:'conclave-member'`, `role:'member:<rótulo>'`, `model`) + 1 juiz (`kind:'conclave-judge'`, `role:'judge'`) quando o juiz é modelo, todos por um único `createGroup` (F3) sob `withServerLock`; só o grupo conta em `jobs.maxActive` |
| A22 | Ponte de pedidos da F2a nos turnos do conclave | Escolha consciente: os turnos de membro e juiz chamam `runTurn` direto (sem `runJobTurn`/fallback, A17) e rejeitam permissão/pergunta **na hora** nos próprios `onPermission`/`onQuestion` — é o que a ponte `createRequestBridge` da F2a faz em `read-only`, sem `pendingRequest` nem espera, por isso não se passa `onRequestResolved` |

---

## Estrutura de arquivos da fase

| Ação | Caminho | Responsabilidade |
|---|---|---|
| Create | `plugins/opc/schemas/conclave-member.schema.json` | Resposta de membro + `$defs.debateExtension` |
| Create | `plugins/opc/schemas/conclave-synthesis.schema.json` | Síntese do juiz modelo |
| Create | `plugins/opc/prompts/conclave-member.md` | Prompt da rodada 1 (cega) |
| Create | `plugins/opc/prompts/conclave-debate.md` | Prompt das rodadas 2..N |
| Create | `plugins/opc/prompts/conclave-judge.md` | Prompt do juiz modelo |
| Create | `plugins/opc/scripts/lib/conclave.mjs` | Lógica do conclave (sem HTTP) |
| Modify | `plugins/opc/scripts/lib/render.mjs` (fim do arquivo) | `renderConclave` |
| Create | `plugins/opc/scripts/commands/conclave.mjs` | Subcomando + worker coordenador |
| Modify | `plugins/opc/scripts/commands/task-worker.mjs` (literal `WORKER_DELEGATES` da F3) | Entrada `conclave: './conclave.mjs'` |
| Create | `plugins/opc/commands/conclave.md` | Slash command `/opc:conclave` |
| Create | `plugins/opc/skills/opc-conclave/SKILL.md` | Skill de síntese |
| Create | `tests/unit/_conclave-fixtures.mjs` | Fixtures compartilhadas dos testes unitários |
| Create | `tests/unit/conclave-schema.test.mjs`, `conclave-assets.test.mjs`, `conclave-compose.test.mjs`, `conclave-anonymize.test.mjs`, `conclave-cluster.test.mjs`, `conclave-verdict.test.mjs`, `conclave-run.test.mjs`, `conclave-review.test.mjs`, `render-conclave.test.mjs`, `conclave-scenarios.test.mjs`, `conclave-plugin-files.test.mjs` | Testes unitários (o módulo é grande; um arquivo por responsabilidade, prefixo `conclave-`) |
| Create | `tests/fixtures/scenarios/_conclave-common.mjs` + `conclave-opinion.mjs`, `conclave-debate.mjs`, `conclave-member-timeout.mjs`, `conclave-member-structured-error.mjs`, `conclave-self-identify.mjs`, `conclave-review.mjs`, `judge-ok.mjs` | Cenários do fake |
| Create | `tests/integration/_conclave-helpers.mjs`, `conclave.test.mjs`, `conclave-acceptance.test.mjs` | Integração (CLI real × fake) |
| Create | `tests/live/_f4c-lib.mjs`, `f4c-opinion.mjs`, `f4c-debate.mjs`, `f4c-review.mjs`, `f4c-judge.mjs` | Ao vivo (`OPC_LIVE=1`) |
| Create | `docs/conclave.md` | Guia completo |
| Modify | `docs/commands.md`, `docs/configuration.md`, `CHANGELOG.md` | Seções do conclave |
| Create | `docs/phases/F4c-report.md` | Relatório da fase |

## Mapa aceite → teste (spec §13.3, F4c)

| Aceite | Teste (arquivo › nome) | Tarefa |
|---|---|---|
| Validações de composição (1 membro, quorum inválido) | `conclave-acceptance` › `composition: 1 member, invalid quorum…`; `conclave-compose` › vários | 12, 3 |
| Anonimização (inclusive autoidentificação) | `conclave-acceptance` › `anonymization: no model, vendor or provider name…`; `conclave-anonymize`; `conclave-run` › `debate: rounds 2..N…` | 12, 4, 7 |
| Quorum atingido e não atingido | `conclave-acceptance` › `quorum met…` e `quorum not met…`; `conclave-run` › `quorum not met…` | 12, 7 |
| `conclave-member-timeout` descartado | `conclave-acceptance` › `member timeout…` | 12 |
| `StructuredOutputError` de membro descartado | `conclave-acceptance` › `quorum met: a StructuredOutputError member…`; `conclave-run` › `StructuredOutputError is discarded…` | 12, 7 |
| Dedupe e concordância com fixtures sobrepostas | `conclave-acceptance` › `review: overlapping findings…`; `conclave-cluster` | 12, 5 |
| Findings sem `file` | idem (`noFile`); `conclave-cluster` › `findings without file…` | 12, 5 |
| Veredito | idem (`verdict`, `reasons`); `conclave-verdict` | 12, 6 |
| `--allow-judge-member` | `conclave-acceptance` › `--allow-judge-member…`; `conclave-compose` › `judge that is also a member…` | 12, 3 |
| Ao vivo: opinion 3 modelos | `tests/live/f4c-opinion.mjs` | 15 |
| Ao vivo: debate 2 rodadas com `changed` | `tests/live/f4c-debate.mjs` | 15 |
| Ao vivo: review cruzado com `k/N` | `tests/live/f4c-review.mjs` | 15 |
| Ao vivo: juiz modelo e juiz Claude | `tests/live/f4c-judge.mjs` + síntese manual no portão | 15 |

---

## Tarefas

### Task 0: Pré-voo — branch e conferência das premissas

Nenhum código de produto. Cria a branch, confere P1–P14 e abre o relatório da fase com os
resultados. Se alguma premissa exigir mudar interface congelada, **pare aqui e escale**.

**Files:**
- Create: `docs/phases/F4c-report.md` (esqueleto completo; a seção 1 é preenchida aqui, o resto no portão — Tarefa 15)

**Interfaces:**
- Consumes: todo o contrato do mestre (F0–F4a).
- Produces: a lista de premissas confirmadas/ajustadas, usada pelas Tarefas 7–12.

- [ ] **Step 1: Confirmar autorização de git e criar a branch**

Se o operador ainda não autorizou commits nesta sessão, pergunte antes (regras de git do mestre).

```bash
git status --short
git switch main && git pull --ff-only
git switch -c feat/opc-f4c
```

Expected: `Switched to a new branch 'feat/opc-f4c'`; `npm test` na `main` já verde (rode `npm test` e confirme 0 falhas antes de continuar).

- [ ] **Step 2: Conferir P1–P14**

Rode cada comando e anote o resultado na seção 1 do relatório (Passo 3).

```bash
# P1 — parseArgs 'list'
grep -n "'list'" plugins/opc/scripts/lib/args.mjs
node --input-type=module -e "import('./plugins/opc/scripts/lib/args.mjs').then(m=>console.log(JSON.stringify(m.parseArgs(['--models','a,b','q'],{flags:{models:{type:'list'}},allowPositionals:true})), JSON.stringify(m.parseArgs([],{flags:{models:{type:'list'}}}).flags)))"
# esperado: {"flags":{"models":["a","b"]},"positionals":["q"]} {"models":[]}

# P2 — ids pelo kind, createGroup e lock de registro
grep -n "KIND_PREFIX\|export function newJobId\|export async function createJob\|export async function createGroup\|export async function withServerLock\|export function assertNotInsideServer" plugins/opc/scripts/lib/jobs.mjs
node --input-type=module -e "import('./plugins/opc/scripts/lib/jobs.mjs').then(m=>console.log(m.newJobId('conclave'), m.newJobId('conclave-member'), m.newJobId('conclave-judge')))"
# esperado: três ids conc-<base36>-<6 chars>

# P3 — despacho por kind no task-worker
grep -n "WORKER_DELEGATES" plugins/opc/scripts/commands/task-worker.mjs

# P4 — result de grupo (F3)
grep -n "resultForGroupOrCommand\|GROUP_ROLE\|rendered\|{ group" plugins/opc/scripts/commands/result.mjs

# P5 — runTurn: onPermission, Timeout, StructuredOutputError
grep -n "onPermission\|onQuestion\|Timeout\|finalText\|abort" plugins/opc/scripts/lib/runner.mjs plugins/opc/scripts/lib/errors.mjs

# P6 — API do fake
grep -n "requests.push" tests/fixtures/fake-opencode.mjs
grep -n "emitTurn\|onPromptAsync\|abort" tests/fixtures/fake-session-api.mjs

# P7 — modelos na fixture de /provider
ls tests/fixtures/data/
node --input-type=module -e "import fs from 'node:fs'; const f=fs.readdirSync('tests/fixtures/data').find(n=>/provider/.test(n)); const p=JSON.parse(fs.readFileSync('tests/fixtures/data/'+f,'utf8')); const pr=(p.all??[]).find(x=>x.id==='omniroute-personal'); console.log(f, (p.connected??[]).includes('omniroute-personal'), Object.keys(pr?.models??{}).filter(k=>/deepseek-v4.1-flash|qwen3.8-max|kimi-k3/.test(k)))"
# esperado: <arquivo> true [ 'opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3' ]

# P8 — placeholders do review.md e forma do review-output
grep -o "{{[A-Z0-9_]*}}" plugins/opc/prompts/review.md | sort -u
node -e "const s=require('./plugins/opc/schemas/review-output.schema.json'); console.log(JSON.stringify({required:s.required, finding:s.properties.findings.items.required}))"

# P9 — conclave no DEFAULT_CONFIG
node --input-type=module -e "import('./plugins/opc/scripts/lib/config.mjs').then(m=>console.log(JSON.stringify(m.DEFAULT_CONFIG.conclave)))"

# P10 — redact por nome exato
node --input-type=module -e "import('./plugins/opc/scripts/lib/redact.mjs').then(m=>console.log(JSON.stringify(m.redact({key_points:['x'],key:'y'}))))"
# esperado: {"key_points":["x"],"key":"***"}

# P11 — waitForJob
grep -n "export async function waitForJob" -A25 plugins/opc/scripts/lib/jobs.mjs

# P12 — primeira regra do read-only
node --input-type=module -e "import('./plugins/opc/scripts/lib/policy.mjs').then(m=>console.log(JSON.stringify(m.buildPermissionRules('read-only',{policy:{},permissionProfiles:{},deniedAgentGlobs:[]})[0])))"
# esperado: {"permission":"*","pattern":"*","action":"deny"}

# P13 — grupos em status/result/cancel
grep -n "GROUP_ROLE\|listGroupMembers" plugins/opc/scripts/commands/status.mjs plugins/opc/scripts/commands/result.mjs plugins/opc/scripts/commands/cancel.mjs

# P14 — --cwd removido pelo dispatcher; --json e --raw-args-stdin chegam ao subcomando
grep -n "extractCwd\|resolveArgv\|wantsJson" plugins/opc/scripts/opc-companion.mjs
grep -n "export async function readRawArgs\|RAW_ARGS_FLAG" plugins/opc/scripts/lib/args.mjs
```

- [ ] **Step 3: Abrir o relatório da fase**

Crie `docs/phases/F4c-report.md` com o conteúdo abaixo e preencha a seção 1 (P1–P14) com
resultado, evidência e ajuste. As demais seções são preenchidas no portão (Tarefa 15).

````markdown
# Relatório da fase F4c — Conclave

- **Data:** DD/MM/AAAA
- **Branch:** `feat/opc-f4c`
- **OpenCode:** versão do `opencode --version` no portão
- **Modelos ao vivo:** `omniroute-personal/opencode-go/{deepseek-v4.1-flash,qwen3.8-max,kimi-k3}` + extra escolhido em runtime
- **Legenda:** `PASSOU` · `N/A` (com justificativa) · `NÃO VALIDADO` (com motivo)

## 1. Premissas sobre F0–F4a (Tarefa 0)

| # | Premissa | Resultado | Evidência (arquivo:linha ou saída) | Ajuste feito |
|---|---|---|---|---|
| P1 | `parseArgs` tipo `list` divide por vírgula; ausente → `[]` | | | |
| P2 | Ids pelo `kind` (`conclave*` → `conc-…`); `createGroup(…, { maxActive })` e `withServerLock` disponíveis | | | |
| P3 | `task-worker` despacha por `WORKER_DELEGATES[kind]` (entrada `conclave` acrescentada) | | | |
| P4 | `result` de grupo imprime `job.rendered`; com `--json`, `{ group, members }` (pacote em `group.result`) | | | |
| P5 | `runTurn`: `onPermission(req)` com `req.id`; timeout → `errorType: 'Timeout'`; `StructuredOutputError` com `finalText` | | | |
| P6 | Fake: `onPromptAsync(fake, sessionID, body)`, `fake.emitTurn`, rota de abort, `requests[].body` | | | |
| P7 | Fixture `/provider` com os três modelos do `omniroute-personal` conectados | | | |
| P8 | `prompts/review.md` usa `TARGET_LABEL`, `PROJECT_CONTEXT`, `REVIEW_COLLECTION_GUIDANCE`, `REVIEW_INPUT` (sem `USER_FOCUS`); `review-output` no formato do codex | | | |
| P9 | `DEFAULT_CONFIG.conclave` com os valores do §3.2 e config parcial mesclada | | | |
| P10 | `redact()` casa nomes de chave exatos (`key_points` preservado) | | | |
| P11 | `waitForJob` sem `waitTimeoutMs` espera sem limite; `onLog` recebe linhas | | | |
| P12 | `buildPermissionRules('read-only')[0]` = `{permission:'*', pattern:'*', action:'deny'}` | | | |
| P13 | `status`/`result`/`cancel` tratam `role: GROUP_ROLE` como grupo (F3) | | | |
| P14 | `--cwd` removido pelo dispatcher (`ctx.cwd`); `--json` e `--raw-args-stdin` chegam ao subcomando | | | |

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
| Modelo extra | escolhido: `…` (ou "nenhum disponível" → `NÃO VALIDADO`) | — | |

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

- [ ] **Step 4: Commit**

```bash
git add docs/phases/F4c-report.md
git commit -m "docs: start F4c report with premise check"
```

---

### Task 1: Schemas do conclave e validação local

**Files:**
- Create: `plugins/opc/schemas/conclave-member.schema.json`
- Create: `plugins/opc/schemas/conclave-synthesis.schema.json`
- Create: `plugins/opc/scripts/lib/conclave.mjs` (cabeçalho + seção de schemas)
- Create: `tests/unit/_conclave-fixtures.mjs`
- Test: `tests/unit/conclave-schema.test.mjs`

**Interfaces:**
- Consumes: `OpcError`, `ExitCode` (`lib/opc-error.mjs`); `normalizeModelId` (`lib/models.mjs`) e `evaluate` (`lib/policy.mjs`) são importados já no cabeçalho, para uso a partir da Tarefa 3.
- Produces: `validateSchema(value, schema) → [{path, message}]`, `buildMemberSchema(file)`, `buildDebateSchema(file, peerLabels)`, `buildSynthesisSchema(file, labels)` e as constantes do cabeçalho (`CONCLAVE_MODES`, `LABEL_ALPHABET`, `REDACTED_NAME`, `PEER_RESPONSE_MAX_CHARS`, `RAW_TEXT_MAX_CHARS`, `CLUSTER_LINE_GAP`, `CLUSTER_TITLE_THRESHOLD`, `SEVERITY_ORDER`).

- [ ] **Step 1: Criar as fixtures compartilhadas dos testes**

`tests/unit/_conclave-fixtures.mjs` (não é arquivo de teste; o runner só coleta `*.test.mjs`):

```js
// Shared fixtures for conclave unit tests (not a test file).
export const PROVIDER = 'omniroute-personal';
export const DS = `${PROVIDER}/opencode-go/deepseek-v4.1-flash`;
export const QW = `${PROVIDER}/opencode-go/qwen3.8-max`;
export const KM = `${PROVIDER}/opencode-go/kimi-k3`;
export const EQ = 'omniroute-work/opencode-go/deepseek-v4-flash'; // same id as the F1 provider.json fixture

const MODEL_ROWS = [
  { full: DS, name: 'DeepSeek V4.1 Flash' },
  { full: QW, name: 'Qwen3.8 Max' },
  { full: KM, name: 'Kimi K3' },
  { full: EQ, name: 'DeepSeek V4 Flash (EQ)' },
];

export function makeCatalog(rows = MODEL_ROWS, connected = [PROVIDER, 'omniroute-work']) {
  const models = rows.map(({ full, name }) => {
    const i = full.indexOf('/');
    return { providerID: full.slice(0, i), modelID: full.slice(i + 1), full, name, variants: [], limit: {}, cost: {} };
  });
  return { connected: new Set(connected), models, byFull: new Map(models.map((m) => [m.full, m])) };
}

export function member(label, full) {
  const i = full.indexOf('/');
  return { label, providerID: full.slice(0, i), modelID: full.slice(i + 1), full, source: '--models' };
}

export const MEMBERS = [member('A', DS), member('B', QW), member('C', KM)];

export function answer(overrides = {}) {
  return {
    position: 'Use a write-ahead log.',
    confidence: 0.8,
    key_points: ['Durability matters more than latency.'],
    risks: ['Extra disk writes.'],
    evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: 'writes happen in place' }],
    would_change_mind_if: 'Benchmarks show the log doubles latency.',
    ...overrides,
  };
}

export function debateAnswer(target, overrides = {}) {
  return { ...answer(), critiques: [{ target, point: 'No numbers behind the latency claim.' }], changed: false, ...overrides };
}

export function synthesis(labels, overrides = {}) {
  return {
    consensus: ['Durability is the main concern.'],
    disagreements: [{ topic: 'Mechanism', positions: [{ members: [labels[0]], stance: 'write-ahead log' }, { members: labels.slice(1), stance: 'backups' }] }],
    weighted_position: 'Use a write-ahead log.',
    confidence: 0.7,
    recommendation: 'Prototype the log and measure latency.',
    minority_reports: [{ members: [labels.at(-1)], summary: 'Backups may be enough for low write volume.' }],
    ...overrides,
  };
}

export function ok(structured, sessionID) {
  return { status: 'completed', sessionID, structured, finalText: '', errorType: undefined };
}

export function failed(errorType, { sessionID = null, finalText = '', errorClass = 'recoverable' } = {}) {
  return { status: 'failed', sessionID, structured: null, finalText, errorType, errorClass, errorMessage: `${errorType} happened` };
}
```

- [ ] **Step 2: Escrever o teste que falha**

`tests/unit/conclave-schema.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, buildMemberSchema, buildDebateSchema, buildSynthesisSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { answer, debateAnswer, synthesis } from './_conclave-fixtures.mjs';

const SCHEMAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/opc/schemas');
const memberFile = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'conclave-member.schema.json'), 'utf8'));
const synthesisFile = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'conclave-synthesis.schema.json'), 'utf8'));

test('member schema accepts a complete answer, including null evidence lines', () => {
  const schema = buildMemberSchema(memberFile);
  assert.deepEqual(validateSchema(answer(), schema), []);
  const wholeFile = answer({ evidence: [{ file: 'README.md', line_start: null, line_end: null, note: 'whole file' }] });
  assert.deepEqual(validateSchema(wholeFile, schema), []);
});

test('member schema rejects out-of-range confidence, missing and extra fields', () => {
  const schema = buildMemberSchema(memberFile);
  const paths = (v) => validateSchema(v, schema).map((e) => e.path);
  assert.deepEqual(paths(answer({ confidence: 1.7 })), ['$.confidence']);
  const missing = answer();
  delete missing.risks;
  assert.deepEqual(paths(missing), ['$.risks']);
  assert.deepEqual(paths(answer({ model: 'x' })), ['$.model']);
  assert.deepEqual(paths(answer({ evidence: [{ file: 'a.js', line_start: 0, line_end: 2, note: '' }] })), ['$.evidence[0].line_start']);
});

test('member schema sent to providers has no $schema or $defs', () => {
  const schema = buildMemberSchema(memberFile);
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$defs, undefined);
  assert.equal(schema.title, 'ConclaveMember');
  assert.ok(memberFile.$defs.debateExtension, 'source file keeps the debate extension');
});

test('debate schema extends the member schema with critiques and changed, target limited to peers', () => {
  const schema = buildDebateSchema(memberFile, ['B', 'C']);
  assert.equal(schema.title, 'ConclaveDebate');
  assert.ok(schema.required.includes('critiques'));
  assert.ok(schema.required.includes('changed'));
  assert.deepEqual(validateSchema(debateAnswer('B'), schema), []);
  assert.deepEqual(validateSchema(debateAnswer('A'), schema).map((e) => e.path), ['$.critiques[0].target']);
  const noChanged = debateAnswer('B');
  delete noChanged.changed;
  assert.deepEqual(validateSchema(noChanged, schema).map((e) => e.path), ['$.changed']);
  assert.deepEqual(validateSchema(answer(), schema).map((e) => e.path).sort(), ['$.changed', '$.critiques']);
});

test('debate schema does not mutate the source schema', () => {
  buildDebateSchema(memberFile, ['B']);
  assert.equal(memberFile.$defs.debateExtension.properties.critiques.items.properties.target.enum, undefined);
  assert.equal(memberFile.properties.critiques, undefined);
});

test('synthesis schema validates judge output and restricts members to labels', () => {
  const schema = buildSynthesisSchema(synthesisFile, ['A', 'B', 'C']);
  assert.equal(schema.title, 'ConclaveSynthesis');
  assert.deepEqual(validateSchema(synthesis(['A', 'B', 'C']), schema), []);
  const bad = synthesis(['A', 'B', 'C'], { minority_reports: [{ members: ['Z'], summary: 'x' }] });
  assert.deepEqual(validateSchema(bad, schema).map((e) => e.path), ['$.minority_reports[0].members[0]']);
  assert.deepEqual(validateSchema(synthesis(['A', 'B', 'C'], { confidence: 1.5 }), schema).map((e) => e.path), ['$.confidence']);
});

test('validateSchema handles type unions, enums and integer vs number', () => {
  assert.deepEqual(validateSchema(3, { type: 'integer' }), []);
  assert.equal(validateSchema(3.5, { type: 'integer' }).length, 1);
  assert.deepEqual(validateSchema(3, { type: 'number' }), []);
  assert.deepEqual(validateSchema(null, { type: ['integer', 'null'], minimum: 1 }), []);
  assert.equal(validateSchema('x', { enum: ['a', 'b'] }).length, 1);
  assert.equal(validateSchema([], { type: 'array', minItems: 1 }).length, 1);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-schema.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (não existe `plugins/opc/scripts/lib/conclave.mjs`).

- [ ] **Step 4: Criar os schemas**

`plugins/opc/schemas/conclave-member.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ConclaveMember",
  "description": "Structured answer of one conclave member. Rounds 2..N add $defs.debateExtension.",
  "type": "object",
  "additionalProperties": false,
  "required": ["position", "confidence", "key_points", "risks", "evidence", "would_change_mind_if"],
  "properties": {
    "position": { "type": "string", "minLength": 1 },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "key_points": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "risks": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["file", "line_start", "line_end", "note"],
        "properties": {
          "file": { "type": "string", "minLength": 1 },
          "line_start": { "type": ["integer", "null"], "minimum": 1 },
          "line_end": { "type": ["integer", "null"], "minimum": 1 },
          "note": { "type": "string" }
        }
      }
    },
    "would_change_mind_if": { "type": "string" }
  },
  "$defs": {
    "debateExtension": {
      "required": ["critiques", "changed"],
      "properties": {
        "critiques": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["target", "point"],
            "properties": {
              "target": { "type": "string", "minLength": 1 },
              "point": { "type": "string", "minLength": 1 }
            }
          }
        },
        "changed": { "type": "boolean" }
      }
    }
  }
}
```

`plugins/opc/schemas/conclave-synthesis.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ConclaveSynthesis",
  "description": "Synthesis of a conclave produced by a judge model that sees members only by label.",
  "type": "object",
  "additionalProperties": false,
  "required": ["consensus", "disagreements", "weighted_position", "confidence", "recommendation", "minority_reports"],
  "properties": {
    "consensus": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "disagreements": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["topic", "positions"],
        "properties": {
          "topic": { "type": "string", "minLength": 1 },
          "positions": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["members", "stance"],
              "properties": {
                "members": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
                "stance": { "type": "string", "minLength": 1 }
              }
            }
          }
        }
      }
    },
    "weighted_position": { "type": "string", "minLength": 1 },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "recommendation": { "type": "string", "minLength": 1 },
    "minority_reports": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["members", "summary"],
        "properties": {
          "members": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
          "summary": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Criar `lib/conclave.mjs` com o cabeçalho e a seção de schemas**

`plugins/opc/scripts/lib/conclave.mjs`:

```js
// Conclave: composition, anonymization, rounds, review clustering and synthesis package.
// Composes runner turns through injected deps; never talks HTTP directly (spec §3.1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpcError, ExitCode } from './opc-error.mjs';
import { normalizeModelId } from './models.mjs';
import { evaluate } from './policy.mjs';
// Single home of the prompt helpers (F2b); conclave never redefines them.
import { fillTemplate, loadPrompt, projectContextBlock } from './prompts.mjs';

export const CONCLAVE_MODES = Object.freeze(['opinion', 'review', 'debate']);
export const LABEL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const REDACTED_NAME = '[redacted]';
export const PEER_RESPONSE_MAX_CHARS = 16 * 1024;
export const RAW_TEXT_MAX_CHARS = 4 * 1024;
export const CLUSTER_LINE_GAP = 3;
export const CLUSTER_TITLE_THRESHOLD = 0.3;
export const SEVERITY_ORDER = Object.freeze(['low', 'medium', 'high', 'critical']);

const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Schema validation (subset of JSON Schema used by opc schemas)
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function walkSchema(value, schema, at, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push({ path: at, message: `expected ${types.join('|')}, got ${typeOf(value)}` });
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `must be <= ${schema.maximum}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path: at, message: `must have length >= ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path: at, message: `must have length <= ${schema.maxLength}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path: at, message: `must have >= ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path: at, message: `must have <= ${schema.maxItems} items` });
    if (schema.items) value.forEach((item, i) => walkSchema(item, schema.items, `${at}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: `${at}.${key}`, message: 'is required' });
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) walkSchema(value[key], sub, `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push({ path: `${at}.${key}`, message: 'is not allowed' });
      }
    }
  }
}

export function validateSchema(value, schema) {
  const errors = [];
  walkSchema(value, schema, '$', errors);
  return errors;
}

function stripMeta(schema) {
  const copy = structuredClone(schema);
  delete copy.$schema;
  delete copy.$defs;
  return copy;
}

export function buildMemberSchema(memberSchemaFile) {
  return stripMeta(memberSchemaFile);
}

export function buildDebateSchema(memberSchemaFile, peerLabels = []) {
  const extension = memberSchemaFile?.$defs?.debateExtension;
  if (!extension) throw new OpcError('CONCLAVE_SCHEMA', 'conclave-member schema has no $defs.debateExtension');
  const schema = stripMeta(memberSchemaFile);
  const extra = structuredClone(extension.properties);
  if (peerLabels.length > 0) extra.critiques.items.properties.target.enum = [...peerLabels];
  schema.title = 'ConclaveDebate';
  schema.properties = { ...schema.properties, ...extra };
  schema.required = [...schema.required, ...extension.required];
  return schema;
}

export function buildSynthesisSchema(synthesisSchemaFile, labels = []) {
  const schema = stripMeta(synthesisSchemaFile);
  if (labels.length > 0) {
    schema.properties.disagreements.items.properties.positions.items.properties.members.items.enum = [...labels];
    schema.properties.minority_reports.items.properties.members.items.enum = [...labels];
  }
  return schema;
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/unit/conclave-schema.test.mjs`
Expected: PASS (7 testes).

- [ ] **Step 7: Commit**

```bash
git add plugins/opc/schemas/conclave-member.schema.json plugins/opc/schemas/conclave-synthesis.schema.json plugins/opc/scripts/lib/conclave.mjs tests/unit/_conclave-fixtures.mjs tests/unit/conclave-schema.test.mjs
git commit -m "feat(conclave): add member and synthesis schemas with local validation"
```

---

### Task 2: Prompts, templates e carga de assets

Os prompts são texto original (nada copiado do swarm-code). Nenhum deles cita marca de modelo,
vendor ou provider, e os de debate e juiz expõem os rótulos em tags que o fake e os testes
leem (`<self_label>`, `<peer_labels>`, `<labels>`).

**Files:**
- Create: `plugins/opc/prompts/conclave-member.md`
- Create: `plugins/opc/prompts/conclave-debate.md`
- Create: `plugins/opc/prompts/conclave-judge.md`
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (acrescentar ao fim)
- Test: `tests/unit/conclave-assets.test.mjs`

**Interfaces:**
- Consumes: `OpcError` (Tarefa 1); `fillTemplate(template, vars, { strict })`, `loadPrompt(name, { dir })`, `projectContextBlock(project)` de `lib/prompts.mjs` (F2b, D10 — não redefinidos aqui); `prompts/review.md` e `schemas/review-output.schema.json` (F2b).
- Produces: `loadConclaveAssets(pluginRoot?) → { prompts: {member, debate, judge, review}, schemas: {member, synthesis, review} }`. Os testes abaixo fixam também o comportamento do `fillTemplate` estrito e do `projectContextBlock` de que o conclave depende (contrato com a F2b).

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-assets.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConclaveAssets } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { fillTemplate, projectContextBlock } from '../../plugins/opc/scripts/lib/prompts.mjs';

test('strict fillTemplate (F2b) replaces every placeholder and keeps $ sequences literal', () => {
  const out = fillTemplate('Q: {{QUESTION}} / {{QUESTION}} by {{SELF_LABEL}}', { QUESTION: 'cost $& of `x` $(y)', SELF_LABEL: 'B' }, { strict: true });
  assert.equal(out, 'Q: cost $& of `x` $(y) / cost $& of `x` $(y) by B');
});

test('strict fillTemplate (F2b) fails fast on placeholders without a value', () => {
  assert.throws(() => fillTemplate('{{QUESTION}} {{MISSING}}', { QUESTION: 'q' }, { strict: true }), (err) => err.code === 'TEMPLATE_UNFILLED');
});

test('strict fillTemplate (F2b) does not re-scan inserted values', () => {
  assert.equal(fillTemplate('<q>{{QUESTION}}</q>', { QUESTION: 'what is {{ROUND}}?' }, { strict: true }), '<q>what is {{ROUND}}?</q>');
});

test('conclave prompts carry exactly the placeholders the runtime fills', () => {
  const { prompts } = loadConclaveAssets();
  const names = (t) => [...new Set([...t.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(names(prompts.member), ['PROJECT_CONTEXT', 'QUESTION', 'SELF_LABEL']);
  assert.deepEqual(names(prompts.debate), ['PEER_LABELS', 'PEER_RESPONSES', 'QUESTION', 'ROUND', 'SELF_LABEL', 'TOTAL_ROUNDS']);
  assert.deepEqual(names(prompts.judge), ['DEBATE_NOTE', 'LABELS', 'MODE', 'QUESTION', 'RESPONSES', 'REVIEW_SUMMARY']);
});

test('conclave prompts never name a model vendor or provider', () => {
  const { prompts } = loadConclaveAssets();
  for (const text of [prompts.member, prompts.debate, prompts.judge]) {
    assert.doesNotMatch(text, /deepseek|qwen|kimi|claude|anthropic|openai|gpt|gemini|omniroute|opencode/i);
  }
});

test('debate and judge prompts expose labels in machine-readable tags', () => {
  const { prompts } = loadConclaveAssets();
  assert.match(prompts.debate, /<self_label>\{\{SELF_LABEL\}\}<\/self_label>/);
  assert.match(prompts.debate, /<peer_labels>\{\{PEER_LABELS\}\}<\/peer_labels>/);
  assert.match(prompts.judge, /<labels>\{\{LABELS\}\}<\/labels>/);
});

test('loadConclaveAssets reads the schemas as objects', () => {
  const { schemas } = loadConclaveAssets();
  assert.equal(schemas.member.title, 'ConclaveMember');
  assert.equal(schemas.synthesis.title, 'ConclaveSynthesis');
  assert.equal(typeof schemas.review, 'object');
});

test('projectContextBlock (F2b) renders only configured fields, in the goal:/scope:/task types: format', () => {
  assert.equal(projectContextBlock(null), '');
  assert.equal(projectContextBlock({ goal: '', scope: [], taskTypes: [] }), '');
  assert.equal(projectContextBlock({ goal: 'Ship opc', scope: ['plugins/'], taskTypes: [] }), '<project_context>\ngoal: Ship opc\nscope: plugins/\n</project_context>');
  assert.equal(projectContextBlock({ taskTypes: ['bugfix'] }), '<project_context>\ntask types: bugfix\n</project_context>');
});

test('the review prompt is loaded through loadPrompt, without the attribution comment', () => {
  const { prompts } = loadConclaveAssets();
  assert.doesNotMatch(prompts.review, /^\s*<!--/);
  assert.match(prompts.review, /\{\{REVIEW_INPUT\}\}/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-assets.test.mjs`
Expected: FAIL com `SyntaxError: The requested module '../../plugins/opc/scripts/lib/conclave.mjs' does not provide an export named 'loadConclaveAssets'`.

- [ ] **Step 3: Criar os prompts**

`plugins/opc/prompts/conclave-member.md`:

```markdown
<role>
You are member {{SELF_LABEL}} of a conclave: several independent reviewers answer the same question without seeing each other. Later, the answers are compared by label only.
</role>

<task>
Answer the question below on its merits. You work in read-only mode: you may read, search and list files in the workspace to ground your answer, but you must not edit files or run commands.
</task>

{{PROJECT_CONTEXT}}

<question>
{{QUESTION}}
</question>

<rules>
- Take a clear position. If the honest answer is "it depends", say on what, and pick the option you would choose under the most likely conditions.
- confidence is a calibrated number between 0 and 1: 0.5 means a coin toss, 0.9 means you would be surprised to be wrong.
- key_points: the few arguments that actually carry your position, most important first.
- risks: what could go wrong if your position is followed.
- evidence: references you actually checked, as file, line_start, line_end and note. Use null lines when the evidence is a whole file. Leave the list empty rather than inventing references.
- would_change_mind_if: the specific fact or argument that would make you switch.
- Do not say who or what you are: no model, vendor, product or provider names. Refer to yourself only as member {{SELF_LABEL}}.
- Reply only through the structured output.
</rules>
```

`plugins/opc/prompts/conclave-debate.md`:

```markdown
<role>
You are member {{SELF_LABEL}} of a conclave, now in round {{ROUND}} of {{TOTAL_ROUNDS}}. Your previous answer is earlier in this conversation.
</role>

<question>
{{QUESTION}}
</question>

<self_label>{{SELF_LABEL}}</self_label>
<peer_labels>{{PEER_LABELS}}</peer_labels>

<peer_answers>
{{PEER_RESPONSES}}
</peer_answers>

<task>
The other members answered the same question in the previous round. They appear only by label; identifying names were removed on purpose and show up as [redacted].
1. Critique the peer arguments that matter: where they are wrong, unsupported, or stronger than yours. Each critique targets exactly one peer label.
2. State your position for this round. Keep it if it still holds; change it if a peer gave you a better argument or better evidence. Changing your mind for a good reason is a strength.
3. Set changed to true only when your position itself (not just its wording) differs from your previous round.
</task>

<rules>
- Same fields as before (position, confidence, key_points, risks, evidence, would_change_mind_if), plus critiques and changed.
- Weigh arguments and evidence, never the presumed identity of a peer.
- Read-only: you may read files to verify a peer's evidence; do not edit files or run commands.
- Do not mention model, vendor, product or provider names.
- Reply only through the structured output.
</rules>
```

`plugins/opc/prompts/conclave-judge.md`:

```markdown
<role>
You are the judge of a conclave. Several members answered the same question independently{{DEBATE_NOTE}}. You see them only by label.
</role>

<question>
{{QUESTION}}
</question>

<mode>{{MODE}}</mode>
<labels>{{LABELS}}</labels>

<member_answers>
{{RESPONSES}}
</member_answers>

<review_summary>
{{REVIEW_SUMMARY}}
</review_summary>

<task>
Write the synthesis:
- consensus: statements that a majority of members support, phrased neutrally.
- disagreements: each real point of contention as a topic, with every position taken and the labels that hold it.
- weighted_position: the position that follows when each member's view is weighted by its stated confidence and by the quality of its evidence. Verifiable file references weigh more than bare assertions.
- confidence: your own confidence in the weighted position, between 0 and 1.
- recommendation: what the user should do next, concretely.
- minority_reports: minority views that are well argued and worth keeping in mind even though they did not prevail, with their labels and a short summary.
</task>

<rules>
- Do not count votes blindly: one well-evidenced answer can outweigh several unsupported ones; say so when it happens.
- You may read files to check cited evidence; do not edit files or run commands.
- Refer to members only by label. Do not guess or mention which model, vendor or provider wrote an answer.
- Reply only through the structured output.
</rules>
```

- [ ] **Step 4: Acrescentar a seção de templates ao fim de `lib/conclave.mjs`**

```js
// ---------------------------------------------------------------------------
// Assets (fillTemplate and projectContextBlock come from lib/prompts.mjs, F2b)
// ---------------------------------------------------------------------------

export function loadConclaveAssets(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf8');
  const json = (...parts) => JSON.parse(read(...parts));
  return {
    prompts: {
      member: read('prompts', 'conclave-member.md'),
      debate: read('prompts', 'conclave-debate.md'),
      judge: read('prompts', 'conclave-judge.md'),
      // F2b's loader strips the leading attribution comment (it names a vendor).
      review: loadPrompt('review', { dir: path.join(pluginRoot, 'prompts') }),
    },
    schemas: {
      member: json('schemas', 'conclave-member.schema.json'),
      synthesis: json('schemas', 'conclave-synthesis.schema.json'),
      review: json('schemas', 'review-output.schema.json'),
    },
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/conclave-assets.test.mjs tests/unit/conclave-schema.test.mjs`
Expected: PASS (16 testes).

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/prompts/conclave-member.md plugins/opc/prompts/conclave-debate.md plugins/opc/prompts/conclave-judge.md plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-assets.test.mjs
git commit -m "feat(conclave): add member, debate and judge prompts"
```

---

### Task 3: Composição dos membros (`composeMembers`)

Regras (spec §11.1.1, §6.5; A1, A14, A15): `--models` **ou** `--pool` (sem os dois, a
`conclave.defaultPool`); cada entrada é normalizada (`normalizeModelId` com aliases e
`defaultProvider`), exige provider conectado e passa pela política de provider e de modelo;
inválidas/negadas/duplicadas são puladas com aviso; mínimo 2; quorum entre 2 e o total;
rodadas por modo; juiz resolvido e checado; juiz membro só com `allowJudgeMember`; rótulos
`A`, `B`, `C`… depois de embaralhar com `rng` (Fisher–Yates). Todos os erros de uso saem como
`OpcError` com `exitCode: 2` e `code` específico; política, `exitCode: 4` e `code: 'POLICY_DENIED'`.

**Files:**
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (acrescentar ao fim)
- Test: `tests/unit/conclave-compose.test.mjs`

**Interfaces:**
- Consumes: `normalizeModelId(input, { catalog, defaultProvider, aliases }) → { providerID, modelID, full }` (F1; lança erro com `message` para inexistente/ambíguo); `evaluate(kind, value, policy) → { allowed, rule? }` (F1); catálogo de `buildCatalog` (`{ connected: Set, models: [...], byFull: Map }`).
- Produces: `validateConclaveOptions({ mode, models, pool, quorum, rounds, config }) → { rounds }` (checagens sem catálogo, usadas pelo comando **antes** de subir o servidor) e `composeMembers(...)` (assinatura em "Interfaces novas").

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-compose.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMembers, validateConclaveOptions } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { makeCatalog, DS, QW, KM, EQ, PROVIDER } from './_conclave-fixtures.mjs';

const catalog = makeCatalog();
const baseConfig = {
  defaultProvider: PROVIDER,
  aliases: { fast: DS, strong: QW, k3: KM },
  policy: { providers: { allow: [], deny: ['omniroute-work'] }, models: { allow: [], deny: [] } },
  conclave: { pools: { default: ['fast', 'strong', 'k3'], duo: ['fast', 'strong'] }, defaultPool: 'default', judge: 'claude', rounds: 1, quorum: 2 },
};
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const compose = (opts) => composeMembers({ config: baseConfig, catalog, rng: seq(0), ...opts });
const usageCode = (code) => (err) => err.exitCode === 2 && err.code === code;

test('uses the default pool with aliases and assigns labels A, B, C', () => {
  const out = compose({});
  assert.deepEqual(out.members.map((m) => m.label), ['A', 'B', 'C']);
  assert.deepEqual(new Set(out.members.map((m) => m.full)), new Set([DS, QW, KM]));
  assert.equal(out.quorum, 2);
  assert.equal(out.rounds, 1);
  assert.deepEqual(out.judge, { type: 'claude' });
  assert.ok(out.members.every((m) => m.source === 'pool:default'));
});

test('labels are assigned after a random shuffle driven by rng', () => {
  const a = compose({ models: [DS, QW, KM], rng: seq(0.99, 0.99) });
  const b = compose({ models: [DS, QW, KM], rng: seq(0, 0) });
  assert.notDeepEqual(a.members.map((m) => m.full), b.members.map((m) => m.full));
  assert.deepEqual(a.members.map((m) => m.label), ['A', 'B', 'C']);
});

test('--models and --pool are mutually exclusive; unknown pool is a usage error', () => {
  assert.throws(() => compose({ models: [DS, QW], pool: 'duo' }), usageCode('CONCLAVE_MODELS_AND_POOL'));
  assert.throws(() => compose({ pool: 'nope' }), usageCode('CONCLAVE_UNKNOWN_POOL'));
});

test('a single member is a usage error (exit 2)', () => {
  assert.throws(() => compose({ models: [DS] }), usageCode('CONCLAVE_TOO_FEW_MEMBERS'));
  assert.throws(() => compose({ models: [DS, DS] }), usageCode('CONCLAVE_TOO_FEW_MEMBERS'));
});

test('quorum must be between 2 and the number of members', () => {
  assert.throws(() => compose({ quorum: 1 }), usageCode('CONCLAVE_INVALID_QUORUM'));
  assert.throws(() => compose({ quorum: 4 }), usageCode('CONCLAVE_INVALID_QUORUM'));
  assert.throws(() => compose({ quorum: 2.5 }), usageCode('CONCLAVE_INVALID_QUORUM'));
  assert.equal(compose({ quorum: 3 }).quorum, 3);
});

test('rounds: 1..3; debate implies >= 2 with default 2; review is single-round', () => {
  assert.equal(compose({ mode: 'debate' }).rounds, 2);
  assert.equal(compose({ mode: 'debate', rounds: 3 }).rounds, 3);
  assert.throws(() => compose({ mode: 'debate', rounds: 1 }), usageCode('CONCLAVE_DEBATE_ROUNDS'));
  assert.throws(() => compose({ rounds: 4 }), usageCode('CONCLAVE_INVALID_ROUNDS'));
  assert.throws(() => compose({ rounds: 0 }), usageCode('CONCLAVE_INVALID_ROUNDS'));
  assert.equal(compose({ rounds: 2 }).rounds, 2);
  assert.equal(compose({ mode: 'review' }).rounds, 1);
  assert.throws(() => compose({ mode: 'review', rounds: 2 }), usageCode('CONCLAVE_REVIEW_ROUNDS'));
  assert.throws(() => compose({ mode: 'vote' }), usageCode('CONCLAVE_INVALID_MODE'));
});

test('debate default uses conclave.rounds when it is already >= 2', () => {
  const config = { ...baseConfig, conclave: { ...baseConfig.conclave, rounds: 3 } };
  assert.equal(composeMembers({ config, catalog, mode: 'debate', rng: seq(0) }).rounds, 3);
});

test('denied, unknown and duplicate members are skipped with warnings', () => {
  const out = compose({ models: [DS, 'strong', QW, EQ, 'nope-model', KM] });
  assert.deepEqual(out.members.map((m) => m.full).sort(), [DS, KM, QW].sort());
  assert.equal(out.warnings.length, 3);
  assert.ok(out.warnings.some((w) => w.includes(EQ) && /denied by policy/.test(w)));
  assert.ok(out.warnings.some((w) => w.includes('nope-model')));
  assert.ok(out.warnings.some((w) => /duplicate/.test(w)));
});

test('fewer than 2 members left after the policy is a usage error listing reasons', () => {
  const config = { ...baseConfig, policy: { models: { allow: [], deny: ['*kimi*', '*qwen*'] } } };
  assert.throws(
    () => composeMembers({ config, catalog, models: [DS, QW, KM], rng: seq(0) }),
    (err) => err.exitCode === 2 && /kimi/.test(err.message) && /qwen/.test(err.message),
  );
});

test('every member denied by policy is a policy error (exit 4)', () => {
  const config = { ...baseConfig, policy: { models: { allow: [], deny: ['*'] } } };
  assert.throws(() => composeMembers({ config, catalog, models: [DS, QW], rng: seq(0) }), (err) => err.exitCode === 4 && err.code === 'POLICY_DENIED');
});

test('judge model is resolved and checked against policy', () => {
  const out = compose({ models: [DS, QW], judge: 'k3' });
  assert.deepEqual(out.judge, { type: 'model', providerID: PROVIDER, modelID: 'opencode-go/kimi-k3', full: KM });
  assert.throws(() => compose({ models: [DS, QW], judge: EQ }), (err) => err.exitCode === 4);
  assert.throws(() => compose({ models: [DS, QW], judge: 'nope' }), usageCode('CONCLAVE_INVALID_JUDGE'));
});

test('judge that is also a member requires --allow-judge-member', () => {
  assert.throws(() => compose({ models: [DS, QW], judge: DS }), usageCode('CONCLAVE_JUDGE_IS_MEMBER'));
  const out = compose({ models: [DS, QW], judge: DS, allowJudgeMember: true });
  assert.equal(out.judge.full, DS);
});

test('validateConclaveOptions checks flags before any server call', () => {
  assert.throws(() => validateConclaveOptions({ mode: 'opinion', models: [DS] }), usageCode('CONCLAVE_TOO_FEW_MEMBERS'));
  assert.throws(() => validateConclaveOptions({ quorum: 1 }), usageCode('CONCLAVE_INVALID_QUORUM'));
  assert.throws(() => validateConclaveOptions({ mode: 'debate', rounds: 1 }), usageCode('CONCLAVE_DEBATE_ROUNDS'));
  assert.deepEqual(validateConclaveOptions({ mode: 'debate' }), { rounds: 2 });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-compose.test.mjs`
Expected: FAIL com `does not provide an export named 'composeMembers'`.

- [ ] **Step 3: Acrescentar a seção de composição ao fim de `lib/conclave.mjs`**

```js
// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function usage(code, message, details) {
  return new OpcError(code, message, { exitCode: ExitCode.USAGE, details });
}

function checkRoundsValue(value, source) {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw usage('CONCLAVE_INVALID_ROUNDS', `${source} must be an integer between 1 and 3 (got ${value})`);
  }
}

function resolveRounds(mode, flagRounds, configRounds) {
  if (flagRounds != null) checkRoundsValue(flagRounds, '--rounds');
  if (configRounds != null) checkRoundsValue(configRounds, 'conclave.rounds');
  if (mode === 'review') {
    if (flagRounds != null && flagRounds !== 1) {
      throw usage('CONCLAVE_REVIEW_ROUNDS', '--mode review runs a single round; drop --rounds');
    }
    return 1;
  }
  if (mode === 'debate') {
    const rounds = flagRounds ?? Math.max(2, configRounds ?? 2);
    if (rounds < 2) throw usage('CONCLAVE_DEBATE_ROUNDS', '--mode debate needs --rounds 2 or 3');
    return rounds;
  }
  return flagRounds ?? configRounds ?? 1;
}

export function validateConclaveOptions({ mode = 'opinion', models = null, pool = null, quorum = null, rounds = null, config = {} } = {}) {
  if (!CONCLAVE_MODES.includes(mode)) {
    throw usage('CONCLAVE_INVALID_MODE', `invalid --mode "${mode}" (expected: ${CONCLAVE_MODES.join(', ')})`);
  }
  const hasModels = Array.isArray(models) && models.length > 0;
  if (hasModels && pool) throw usage('CONCLAVE_MODELS_AND_POOL', '--models and --pool are mutually exclusive');
  if (hasModels) {
    const distinct = new Set(models.map((m) => String(m).trim()).filter(Boolean));
    if (distinct.size < 2) throw usage('CONCLAVE_TOO_FEW_MEMBERS', 'a conclave needs at least 2 members (--models a,b)');
  }
  if (quorum != null && (!Number.isInteger(quorum) || quorum < 2)) {
    throw usage('CONCLAVE_INVALID_QUORUM', `--quorum must be an integer >= 2 (got ${quorum})`);
  }
  return { rounds: resolveRounds(mode, rounds, config.conclave?.rounds ?? null) };
}

function policyDenial(resolved, policy) {
  const provider = evaluate('provider', resolved.providerID, policy ?? {});
  if (!provider.allowed) return `provider denied by policy (${provider.rule ?? 'policy'})`;
  const model = evaluate('model', resolved.full, policy ?? {});
  if (!model.allowed) return `model denied by policy (${model.rule ?? 'policy'})`;
  return null;
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function resolveJudge(value, { catalog, config, policy }) {
  if (value === 'claude') return { type: 'claude' };
  let resolved;
  try {
    resolved = normalizeModelId(value, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {} });
  } catch (err) {
    throw usage('CONCLAVE_INVALID_JUDGE', `invalid --judge "${value}": ${err.message}`);
  }
  if (!catalog.connected.has(resolved.providerID)) {
    throw usage('CONCLAVE_INVALID_JUDGE', `invalid --judge "${value}": provider "${resolved.providerID}" is not connected`);
  }
  const denial = policyDenial(resolved, policy);
  if (denial) {
    throw new OpcError('POLICY_DENIED', `conclave judge "${value}": ${denial}`, { exitCode: ExitCode.POLICY });
  }
  return { type: 'model', providerID: resolved.providerID, modelID: resolved.modelID, full: resolved.full };
}

export function composeMembers({
  models = null, pool = null, config = {}, catalog, policy = config.policy, quorum = null, rounds = null,
  mode = 'opinion', judge = null, allowJudgeMember = false, rng = Math.random,
} = {}) {
  const { rounds: effectiveRounds } = validateConclaveOptions({ mode, models, pool, quorum, rounds, config });
  const conclaveCfg = config.conclave ?? {};
  let entries;
  let source;
  if (Array.isArray(models) && models.length > 0) {
    entries = models;
    source = '--models';
  } else {
    const poolName = pool ?? conclaveCfg.defaultPool ?? 'default';
    const list = conclaveCfg.pools?.[poolName];
    if (!Array.isArray(list) || list.length === 0) {
      throw usage('CONCLAVE_UNKNOWN_POOL', `conclave pool "${poolName}" is not defined (conclave.pools.${poolName}); pass --models a,b`);
    }
    entries = list;
    source = `pool:${poolName}`;
  }

  const warnings = [];
  const skipped = [];
  const accepted = [];
  const seen = new Set();
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) continue;
    let resolved;
    try {
      resolved = normalizeModelId(entry, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {} });
    } catch (err) {
      skipped.push({ entry, reason: err.message, denied: false });
      warnings.push(`conclave: skipping "${entry}": ${err.message}`);
      continue;
    }
    if (!catalog.connected.has(resolved.providerID)) {
      const reason = `provider "${resolved.providerID}" is not connected`;
      skipped.push({ entry, reason, denied: false });
      warnings.push(`conclave: skipping "${entry}": ${reason}`);
      continue;
    }
    const denial = policyDenial(resolved, policy);
    if (denial) {
      skipped.push({ entry, reason: denial, denied: true });
      warnings.push(`conclave: skipping "${entry}": ${denial}`);
      continue;
    }
    if (seen.has(resolved.full)) {
      warnings.push(`conclave: duplicate member "${entry}" (${resolved.full}) ignored`);
      continue;
    }
    seen.add(resolved.full);
    accepted.push({ providerID: resolved.providerID, modelID: resolved.modelID, full: resolved.full, source });
  }

  const listing = skipped.map((s) => `${s.entry}: ${s.reason}`).join('; ');
  if (accepted.length === 0 && skipped.length > 0 && skipped.every((s) => s.denied)) {
    throw new OpcError('POLICY_DENIED', `conclave: every member was denied by policy (${listing})`, { exitCode: ExitCode.POLICY, details: { skipped } });
  }
  if (accepted.length < 2) {
    throw usage('CONCLAVE_TOO_FEW_MEMBERS', `a conclave needs at least 2 valid members, got ${accepted.length}${listing ? ` (${listing})` : ''}`, { skipped });
  }
  if (accepted.length > LABEL_ALPHABET.length) {
    throw usage('CONCLAVE_TOO_MANY_MEMBERS', `a conclave supports at most ${LABEL_ALPHABET.length} members`);
  }

  const effectiveQuorum = quorum ?? conclaveCfg.quorum ?? 2;
  if (!Number.isInteger(effectiveQuorum) || effectiveQuorum < 2 || effectiveQuorum > accepted.length) {
    throw usage('CONCLAVE_INVALID_QUORUM', `quorum must be an integer between 2 and ${accepted.length} (got ${effectiveQuorum})`);
  }

  const effectiveJudge = resolveJudge(judge ?? conclaveCfg.judge ?? 'claude', { catalog, config, policy });
  if (effectiveJudge.type === 'model' && seen.has(effectiveJudge.full) && !allowJudgeMember) {
    throw usage('CONCLAVE_JUDGE_IS_MEMBER', `judge ${effectiveJudge.full} is also a member; pass --allow-judge-member to allow it`);
  }

  const members = shuffle(accepted, rng).map((m, i) => ({ label: LABEL_ALPHABET[i], ...m }));
  return { mode, members, quorum: effectiveQuorum, rounds: effectiveRounds, judge: effectiveJudge, warnings, skipped };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/conclave-compose.test.mjs`
Expected: PASS (13 testes). Se algum teste de "unknown model" falhar porque o `normalizeModelId` real aceita a entrada `nope-model` de outra forma, confira o comportamento documentado da F1 (`UNKNOWN_MODEL`) antes de mexer no teste.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-compose.test.mjs
git commit -m "feat(conclave): compose members with policy, quorum and rounds"
```

---

### Task 4: Anonimização (`buildKnownNames`, `anonymize`, `anonymizeValue`)

Decisão A6. Duas expressões regulares compiladas uma vez por lista (cache em `WeakMap`):
**exatos** (com fronteira de palavra Unicode nos dois lados, mais longos primeiro) e **famílias**
(fronteira à esquerda e sufixo de versão `[\p{L}\p{N}_-]` ou `.` seguido de letra/dígito, para
pegar `Qwen3.8-max` sem comer o ponto final da frase). Tudo vira `[redacted]`.

**Files:**
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (acrescentar ao fim)
- Test: `tests/unit/conclave-anonymize.test.mjs`

**Interfaces:**
- Consumes: catálogo (`connected`, `models[{providerID, modelID, full, name}]`).
- Produces: `buildKnownNames(catalog, { extraModels }) → { exact, families }`, `anonymize(text, knownNames) → string`, `anonymizeValue(value, knownNames)`, `REDACTED_NAME`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-anonymize.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, anonymizeValue, buildKnownNames, REDACTED_NAME } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { makeCatalog, DS, QW, KM } from './_conclave-fixtures.mjs';

const catalog = makeCatalog([
  { full: DS, name: 'DeepSeek V4.1 Flash' },
  { full: QW, name: 'Qwen3.8 Max' },
  { full: KM, name: 'Kimi K3' },
  { full: 'openai/gpt-5.2-mini', name: 'GPT-5.2 Mini' },
  { full: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
], ['omniroute-personal', 'openai', 'anthropic']);
const known = buildKnownNames(catalog);
const FORBIDDEN = /deepseek|qwen|kimi|omniroute|mvalmeida|opencode-go|alibaba|moonshot|openai|chatgpt|gpt|anthropic|claude/i;

test('buildKnownNames collects provider ids, model ids, names, families and vendors', () => {
  for (const name of ['omniroute-personal', 'omniroute', 'mvalmeida', DS, 'opencode-go/qwen3.8-max', 'kimi-k3', 'opencode-go', 'Qwen3.8 Max', 'alibaba', 'moonshot', 'anthropic', 'openai', 'chatgpt']) {
    assert.ok(known.exact.includes(name), `exact should include ${name}`);
  }
  assert.deepEqual([...known.families].sort(), ['claude', 'deepseek', 'gpt', 'kimi', 'qwen', 'sonnet'].sort());
});

test('generic words from model ids never become family words', () => {
  for (const generic of ['flash', 'max', 'mini', 'pro', 'go', 'opencode']) {
    assert.ok(!known.families.includes(generic), `${generic} must not be a family word`);
  }
});

test('self-identification is scrubbed, with case and version variants', () => {
  const text = 'I am DeepSeek V4.1 Flash via omniroute-personal. As QWEN3.8-max (by Alibaba) and kimi-k3 from Moonshot, we agree; ChatGPT and gpt-5 disagree, Claude too.';
  const out = anonymize(text, known);
  assert.doesNotMatch(out, FORBIDDEN);
  assert.ok(out.includes(REDACTED_NAME));
  assert.ok(out.endsWith('too.'), 'sentence punctuation is kept');
});

test('full ids with slashes are removed as a whole', () => {
  assert.equal(anonymize(`member model: ${KM}!`, known), `member model: ${REDACTED_NAME}!`);
});

test('ordinary prose with generic words is left intact', () => {
  const text = 'The flash storage has a max size of 2 GB; go read the code, it is open and pro-grade.';
  assert.equal(anonymize(text, known), text);
});

test('family words inside unrelated identifiers are not matched mid-word', () => {
  assert.equal(anonymize('the variable mydeepseekcache stays', known), 'the variable mydeepseekcache stays');
});

test('anonymize accepts a plain array of exact names', () => {
  assert.equal(anonymize('Hello Acme-Model and acme-model', ['Acme-Model']), `Hello ${REDACTED_NAME} and ${REDACTED_NAME}`);
});

test('anonymize tolerates empty inputs', () => {
  assert.equal(anonymize('', known), '');
  assert.equal(anonymize(undefined, known), '');
  assert.equal(anonymize('nothing to hide', { exact: [], families: [] }), 'nothing to hide');
});

test('anonymizeValue walks nested objects and arrays, keeping keys and non-strings', () => {
  const value = { position: 'Kimi says yes', confidence: 0.4, evidence: [{ file: 'src/a.js', note: 'checked by qwen3.8-max', line_start: 1 }], critiques: [{ target: 'B', point: 'DeepSeek is wrong' }] };
  const out = anonymizeValue(value, known);
  assert.doesNotMatch(JSON.stringify(out), FORBIDDEN);
  assert.equal(out.confidence, 0.4);
  assert.equal(out.evidence[0].line_start, 1);
  assert.equal(out.evidence[0].file, 'src/a.js');
  assert.equal(out.critiques[0].target, 'B');
});

test('extra models are covered even when missing from the catalog', () => {
  const names = buildKnownNames(makeCatalog([], []), { extraModels: [{ providerID: 'acme', modelID: 'zeta-9-pro', full: 'acme/zeta-9-pro', name: 'Zeta 9 Pro' }] });
  assert.equal(anonymize('I am Zeta-9 from acme', names), `I am ${REDACTED_NAME} from ${REDACTED_NAME}`);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-anonymize.test.mjs`
Expected: FAIL com `does not provide an export named 'anonymize'`.

- [ ] **Step 3: Acrescentar a seção de anonimização ao fim de `lib/conclave.mjs`**

```js
// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

const GENERIC_NAME_WORDS = new Set([
  'air', 'alpha', 'api', 'app', 'audio', 'auto', 'base', 'beta', 'big', 'chat', 'cli', 'cloud', 'code', 'coder',
  'codex', 'command', 'deep', 'default', 'dev', 'edge', 'embed', 'embedding', 'exp', 'experimental', 'fast', 'final',
  'flash', 'free', 'high', 'hyper', 'image', 'instant', 'instruct', 'large', 'latest', 'light', 'lite', 'local', 'low',
  'max', 'medium', 'micro', 'mini', 'model', 'models', 'nano', 'new', 'next', 'old', 'omni', 'online', 'open', 'plus',
  'preview', 'pro', 'realtime', 'reasoner', 'reasoning', 'release', 'research', 'sdk', 'search', 'server', 'small',
  'speech', 'stable', 'super', 'test', 'text', 'the', 'thinking', 'turbo', 'ultra', 'version', 'vision', 'web', 'with',
]);

const VENDOR_ALIASES = Object.freeze({
  claude: ['anthropic'],
  deepseek: ['deepseek'],
  gemini: ['google', 'deepmind'],
  gemma: ['google', 'deepmind'],
  glm: ['zhipu', 'zhipuai'],
  gpt: ['openai', 'chatgpt'],
  grok: ['xai'],
  kimi: ['moonshot', 'moonshotai'],
  llama: ['meta'],
  minimax: ['minimax'],
  mistral: ['mistralai'],
  codestral: ['mistral', 'mistralai'],
  phi: ['microsoft'],
  qwen: ['alibaba', 'tongyi'],
});

function familyWordsOf(text) {
  const words = [];
  for (const token of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const lead = token.match(/^\p{L}+/u)?.[0];
    if (lead && lead.length >= 3 && !GENERIC_NAME_WORDS.has(lead)) words.push(lead);
  }
  return words;
}

export function buildKnownNames(catalog, { extraModels = [] } = {}) {
  const exact = new Set();
  const families = new Set();
  const addExact = (value) => {
    const v = String(value ?? '').trim();
    if (v.length >= 3) exact.add(v);
  };
  const providers = new Set(catalog?.connected ?? []);
  for (const m of [...(catalog?.models ?? []), ...extraModels]) {
    if (!m?.modelID) continue;
    if (m.providerID) providers.add(m.providerID);
    addExact(m.full);
    addExact(m.modelID);
    const segments = String(m.modelID).split('/');
    addExact(segments.at(-1));
    for (const namespace of segments.slice(0, -1)) addExact(namespace);
    addExact(m.name);
    for (const w of familyWordsOf(segments.at(-1))) families.add(w);
    for (const w of familyWordsOf(m.name)) families.add(w);
  }
  for (const p of providers) {
    addExact(p);
    for (const token of String(p).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token.length >= 3 && !GENERIC_NAME_WORDS.has(token)) exact.add(token);
    }
  }
  for (const family of families) {
    for (const vendor of VENDOR_ALIASES[family] ?? []) exact.add(vendor);
  }
  return { exact: [...exact], families: [...families] };
}

const compiledNames = new WeakMap();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileNames(knownNames) {
  const cacheable = knownNames && typeof knownNames === 'object';
  if (cacheable && compiledNames.has(knownNames)) return compiledNames.get(knownNames);
  const spec = Array.isArray(knownNames) ? { exact: knownNames, families: [] } : (knownNames ?? {});
  const prepare = (list) => [...new Set((list ?? []).map((s) => String(s).trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const exact = prepare(spec.exact);
  const families = prepare(spec.families);
  const before = '(?<![\\p{L}\\p{N}_])';
  const after = '(?![\\p{L}\\p{N}_])';
  const compiled = {
    exact: exact.length ? new RegExp(`${before}(?:${exact.join('|')})${after}`, 'giu') : null,
    family: families.length
      ? new RegExp(`${before}(?:${families.join('|')})(?:[\\p{L}\\p{N}_-]|\\.(?=[\\p{L}\\p{N}]))*`, 'giu')
      : null,
  };
  if (cacheable) compiledNames.set(knownNames, compiled);
  return compiled;
}

export function anonymize(text, knownNames) {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  const { exact, family } = compileNames(knownNames);
  let out = text;
  if (exact) out = out.replace(exact, REDACTED_NAME);
  if (family) out = out.replace(family, REDACTED_NAME);
  return out;
}

export function anonymizeValue(value, knownNames) {
  if (typeof value === 'string') return anonymize(value, knownNames);
  if (Array.isArray(value)) return value.map((v) => anonymizeValue(v, knownNames));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymizeValue(v, knownNames)]));
  }
  return value;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/conclave-anonymize.test.mjs`
Expected: PASS (10 testes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-anonymize.test.mjs
git commit -m "feat(conclave): anonymize model, vendor and provider names"
```

---

### Task 5: Agrupamento de achados (`clusterFindings`)

Spec §11.2 e decisões A7–A11: mesmo arquivo normalizado **e** linhas sobrepostas ou a até 3
**e** Jaccard de tokens de título ≥ 0,3; achados sem arquivo nunca agrupam; cluster com
severidade máxima, `k/N`, confiança média, rótulos e corpo/recomendação do achado de maior
confiança; ordenação estável por severidade, `k`, confiança, local e título; ids `C1..Cn`.

**Files:**
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (acrescentar ao fim)
- Test: `tests/unit/conclave-cluster.test.mjs`

**Interfaces:**
- Consumes: achados no formato do `review-output` (F2b).
- Produces: `clusterFindings(findingsByMember, { validCount }) → Cluster[]`, `titleTokens(title) → Set`, `titleSimilarity(a, b) → number`; função interna `severityRank(severity)` usada pela Tarefa 6.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-cluster.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterFindings, titleSimilarity, titleTokens } from '../../plugins/opc/scripts/lib/conclave.mjs';

const f = (file, line_start, line_end, title, severity = 'medium', confidence = 0.5, extra = {}) => ({
  severity, title, body: `${title} body`, file, line_start, line_end, confidence, recommendation: `fix ${title}`, ...extra,
});

test('titleTokens lowercases, strips accents, drops stopwords and 1-char tokens', () => {
  assert.deepEqual([...titleTokens('Division by zero when count is 0')].sort(), ['count', 'division', 'zero']);
  assert.deepEqual([...titleTokens('Divisão por zero na função')].sort(), ['divisao', 'funcao', 'zero']);
});

test('titleSimilarity is token Jaccard', () => {
  assert.equal(titleSimilarity('Division by zero when count is 0', 'Possible division by zero on empty count'), 3 / 5);
  assert.equal(titleSimilarity('Off-by-one in loop bound', 'Null pointer in parser'), 0);
  assert.equal(titleSimilarity('', 'anything'), 0);
});

test('same file, nearby lines and similar titles form one cluster with k/N agreement', () => {
  const clusters = clusterFindings({
    A: [f('src/calc.js', 10, 12, 'Division by zero when count is 0', 'high', 0.9)],
    B: [f('src/calc.js', 13, 14, 'Possible division by zero on empty count', 'critical', 0.7)],
    C: [],
  });
  assert.equal(clusters.length, 1);
  const [c] = clusters;
  assert.equal(c.id, 'C1');
  assert.deepEqual(c.agreement, { k: 2, n: 3, text: '2/3' });
  assert.deepEqual(c.labels, ['A', 'B']);
  assert.equal(c.severity, 'critical');
  assert.equal(c.meanConfidence, 0.8);
  assert.equal(c.bestLabel, 'A');
  assert.equal(c.title, 'Division by zero when count is 0');
  assert.equal(c.body, 'Division by zero when count is 0 body');
  assert.equal(c.line_start, 10);
  assert.equal(c.line_end, 14);
  assert.equal(c.findings.length, 2);
});

test('lines more than 3 apart are not clustered even with identical titles', () => {
  const clusters = clusterFindings({
    A: [f('src/calc.js', 10, 14, 'Division by zero when count is 0')],
    B: [f('src/calc.js', 18, 20, 'Division by zero when count is 0')],
  });
  assert.equal(clusters.length, 2);
  const within = clusterFindings({
    A: [f('src/calc.js', 10, 14, 'Division by zero when count is 0')],
    B: [f('src/calc.js', 17, 20, 'Division by zero when count is 0')],
  });
  assert.equal(within.length, 1, 'a gap of exactly 3 lines still clusters');
});

test('dissimilar titles at the same place are not clustered', () => {
  const clusters = clusterFindings({
    A: [f('src/list.js', 5, 5, 'Off-by-one in loop bound')],
    B: [f('src/list.js', 5, 6, 'Null pointer in parser')],
  });
  assert.equal(clusters.length, 2);
});

test('different files are never clustered', () => {
  const clusters = clusterFindings({
    A: [f('src/a.js', 1, 2, 'Missing input validation')],
    B: [f('src/b.js', 1, 2, 'Missing input validation')],
  });
  assert.equal(clusters.length, 2);
});

test('findings without file are never clustered and count as k=1', () => {
  const clusters = clusterFindings({
    A: [f('', 1, 1, 'Missing tests for calc module', 'low'), f('N/A', 1, 1, 'Missing tests for calc module', 'low')],
    B: [f(null, 1, 1, 'Missing tests for calc module', 'low'), f(' - ', 1, 1, 'Missing tests for calc module', 'low'), { severity: 'low', title: 'Missing tests for calc module', body: 'x', confidence: 0.3 }],
  });
  assert.equal(clusters.length, 5);
  assert.ok(clusters.every((c) => c.file === null && c.agreement.k === 1 && c.agreement.text === '1/2'));
});

test('malformed line numbers are normalized instead of crashing', () => {
  const clusters = clusterFindings({
    A: [f('./src/x.js', 20, 10, 'Race condition on cache refresh')],
    B: [f('src\\x.js', '12', null, 'Cache refresh race condition')],
    C: [f('src/x.js', null, undefined, 'Race condition on cache refresh')],
  });
  const joined = clusters.find((c) => c.labels.length === 2);
  assert.ok(joined, 'A (10-20 inverted) and B (12) cluster after path normalization');
  assert.deepEqual(joined.labels, ['A', 'B']);
  assert.equal(joined.line_start, 10);
  assert.equal(joined.line_end, 20);
  const lineless = clusters.find((c) => c.labels.includes('C'));
  assert.equal(lineless.agreement.k, 1, 'a finding without lines never joins one with lines');
});

test('two findings without lines in the same file cluster when titles match', () => {
  const clusters = clusterFindings({
    A: [f('README.md', null, null, 'Outdated install instructions')],
    B: [f('README.md', undefined, undefined, 'Install instructions are outdated')],
  });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].line_start, null);
});

test('clusters are sorted by severity, agreement, confidence, then location', () => {
  const clusters = clusterFindings({
    A: [f('z.js', 1, 1, 'Low thing', 'low', 0.9), f('a.js', 1, 1, 'High thing', 'high', 0.2), f('m.js', 1, 1, 'Medium thing', 'medium', 0.9)],
    B: [f('m.js', 1, 1, 'Medium thing', 'medium', 0.9)],
  });
  assert.deepEqual(clusters.map((c) => c.title), ['High thing', 'Medium thing', 'Low thing']);
  assert.deepEqual(clusters.map((c) => c.id), ['C1', 'C2', 'C3']);
});

test('N comes from validCount when given', () => {
  const clusters = clusterFindings({ A: [f('a.js', 1, 1, 'Something wrong')] }, { validCount: 4 });
  assert.equal(clusters[0].agreement.text, '1/4');
});

test('a member repeating the same finding still counts once', () => {
  const clusters = clusterFindings({
    A: [f('a.js', 1, 2, 'SQL injection in query builder', 'high', 0.6), f('a.js', 2, 3, 'SQL injection in the query builder', 'high', 0.8)],
    B: [],
  });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement.k, 1);
  assert.equal(clusters[0].meanConfidence, 0.7);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-cluster.test.mjs`
Expected: FAIL com `does not provide an export named 'clusterFindings'`.

- [ ] **Step 3: Acrescentar a seção de agrupamento ao fim de `lib/conclave.mjs`**

```js
// ---------------------------------------------------------------------------
// Review clustering and verdict
// ---------------------------------------------------------------------------

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'no', 'not', 'of', 'on',
  'or', 'the', 'this', 'that', 'to', 'when', 'with',
  'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'nos', 'o', 'os', 'para', 'por', 'que', 'sem', 'um', 'uma',
]);

function severityRank(severity) {
  return SEVERITY_ORDER.indexOf(String(severity ?? '').toLowerCase());
}

export function titleTokens(title) {
  return new Set(
    String(title ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2 && !TITLE_STOPWORDS.has(t)),
  );
}

export function titleSimilarity(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const NO_FILE_VALUES = new Set(['', '-', 'n/a', 'na', 'none', '(none)', 'null', 'unknown', 'general', 'global', '*']);

function normalizeFile(file) {
  if (typeof file !== 'string') return null;
  const f = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return NO_FILE_VALUES.has(f.toLowerCase()) ? null : f;
}

function toLine(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function lineRange(finding) {
  const start = toLine(finding.line_start);
  const end = toLine(finding.line_end);
  if (start === null && end === null) return null;
  const a = start ?? end;
  const b = end ?? start;
  return a <= b ? [a, b] : [b, a];
}

function rangesNear(r1, r2) {
  if (!r1 && !r2) return true;
  if (!r1 || !r2) return false;
  return Math.max(r1[0], r2[0]) - Math.min(r1[1], r2[1]) <= CLUSTER_LINE_GAP;
}

function confidenceOf(finding) {
  return typeof finding.confidence === 'number' && Number.isFinite(finding.confidence) ? finding.confidence : null;
}

export function clusterFindings(findingsByMember, { validCount = null } = {}) {
  const labels = Object.keys(findingsByMember ?? {}).sort();
  const n = validCount ?? labels.length;
  const items = [];
  for (const label of labels) {
    for (const finding of findingsByMember[label] ?? []) {
      if (!finding || typeof finding !== 'object') continue;
      items.push({ label, finding, file: normalizeFile(finding.file), range: lineRange(finding), confidence: confidenceOf(finding), order: items.length });
    }
  }
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.file === null || b.file === null || a.file !== b.file) continue;
      if (!rangesNear(a.range, b.range)) continue;
      if (titleSimilarity(a.finding.title, b.finding.title) < CLUSTER_TITLE_THRESHOLD) continue;
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  const clusters = [...groups.values()].map((group) => {
    const memberLabels = [...new Set(group.map((g) => g.label))].sort();
    const best = [...group].sort((x, y) => ((y.confidence ?? -1) - (x.confidence ?? -1)) || (x.order - y.order))[0];
    let severity = String(group[0].finding.severity ?? '').toLowerCase() || null;
    for (const g of group) {
      if (severityRank(g.finding.severity) > severityRank(severity)) severity = String(g.finding.severity).toLowerCase();
    }
    const ranges = group.map((g) => g.range).filter(Boolean);
    const confidences = group.map((g) => g.confidence).filter((c) => c !== null);
    const mean = confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : null;
    return {
      id: null,
      file: group[0].file,
      line_start: ranges.length ? Math.min(...ranges.map((r) => r[0])) : null,
      line_end: ranges.length ? Math.max(...ranges.map((r) => r[1])) : null,
      severity,
      title: String(best.finding.title ?? ''),
      body: String(best.finding.body ?? ''),
      recommendation: String(best.finding.recommendation ?? ''),
      agreement: { k: memberLabels.length, n, text: `${memberLabels.length}/${n}` },
      labels: memberLabels,
      meanConfidence: mean === null ? null : Math.round(mean * 100) / 100,
      bestLabel: best.label,
      findings: group.map((g) => ({
        label: g.label,
        title: String(g.finding.title ?? ''),
        severity: g.finding.severity ?? null,
        confidence: g.confidence,
        line_start: g.range ? g.range[0] : null,
        line_end: g.range ? g.range[1] : null,
      })),
    };
  });
  clusters.sort((x, y) => (severityRank(y.severity) - severityRank(x.severity))
    || (y.agreement.k - x.agreement.k)
    || ((y.meanConfidence ?? -1) - (x.meanConfidence ?? -1))
    || (x.file === null) - (y.file === null)
    || String(x.file ?? '').localeCompare(String(y.file ?? ''))
    || ((x.line_start ?? 0) - (y.line_start ?? 0))
    || x.title.localeCompare(y.title));
  clusters.forEach((c, i) => { c.id = `C${i + 1}`; });
  return clusters;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/conclave-cluster.test.mjs`
Expected: PASS (12 testes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-cluster.test.mjs
git commit -m "feat(conclave): cluster review findings by location and title"
```

---

### Task 6: Veredito do review (`conclaveVerdict`)

Spec §11.2: `needs-attention` se algum cluster com severidade ≥ `high` tiver concordância ≥ 2,
**ou** se mais da metade dos membros válidos der `needs-attention`. Os motivos saem como
códigos (o render traduz).

**Files:**
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (acrescentar ao fim)
- Test: `tests/unit/conclave-verdict.test.mjs`

**Interfaces:**
- Consumes: `Cluster[]` (Tarefa 5), `severityRank` (Tarefa 5).
- Produces: `conclaveVerdict(clusters, memberVerdicts) → { verdict, reasons }`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-verdict.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conclaveVerdict } from '../../plugins/opc/scripts/lib/conclave.mjs';

const cluster = (id, severity, k, n = 3) => ({ id, severity, agreement: { k, n, text: `${k}/${n}` } });

test('needs-attention when a high or critical cluster has agreement >= 2', () => {
  const out = conclaveVerdict([cluster('C1', 'high', 2)], { A: 'approve', B: 'approve', C: 'approve' });
  assert.equal(out.verdict, 'needs-attention');
  assert.deepEqual(out.reasons, [{ code: 'SEVERE_FINDING_AGREED', clusterId: 'C1', severity: 'high', agreement: '2/3' }]);
  assert.equal(conclaveVerdict([cluster('C1', 'critical', 3)], { A: 'approve', B: 'approve', C: 'approve' }).verdict, 'needs-attention');
});

test('a severe finding seen by a single member does not flip the verdict alone', () => {
  assert.equal(conclaveVerdict([cluster('C1', 'critical', 1)], { A: 'needs-attention', B: 'approve', C: 'approve' }).verdict, 'approve');
});

test('medium clusters never flip the verdict, whatever the agreement', () => {
  assert.equal(conclaveVerdict([cluster('C1', 'medium', 3)], { A: 'approve', B: 'approve', C: 'approve' }).verdict, 'approve');
});

test('needs-attention when more than half of valid members say so', () => {
  const out = conclaveVerdict([], { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
  assert.equal(out.verdict, 'needs-attention');
  assert.deepEqual(out.reasons, [{ code: 'MAJORITY_NEEDS_ATTENTION', count: 2, of: 3 }]);
});

test('exactly half is not a majority', () => {
  assert.equal(conclaveVerdict([], { A: 'needs-attention', B: 'needs-attention', C: 'approve', D: 'approve' }).verdict, 'approve');
});

test('both reasons are reported together', () => {
  const out = conclaveVerdict([cluster('C1', 'high', 2)], { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
  assert.deepEqual(out.reasons.map((r) => r.code), ['SEVERE_FINDING_AGREED', 'MAJORITY_NEEDS_ATTENTION']);
});

test('no members and no clusters approves', () => {
  assert.deepEqual(conclaveVerdict([], {}), { verdict: 'approve', reasons: [] });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-verdict.test.mjs`
Expected: FAIL com `does not provide an export named 'conclaveVerdict'`.

- [ ] **Step 3: Acrescentar ao fim de `lib/conclave.mjs`**

```js
export function conclaveVerdict(clusters, memberVerdicts) {
  const verdicts = Object.values(memberVerdicts ?? {});
  const reasons = [];
  for (const c of clusters ?? []) {
    if (severityRank(c.severity) >= severityRank('high') && c.agreement.k >= 2) {
      reasons.push({ code: 'SEVERE_FINDING_AGREED', clusterId: c.id, severity: c.severity, agreement: c.agreement.text });
    }
  }
  const needs = verdicts.filter((v) => v === 'needs-attention').length;
  if (verdicts.length > 0 && needs > verdicts.length / 2) {
    reasons.push({ code: 'MAJORITY_NEEDS_ATTENTION', count: needs, of: verdicts.length });
  }
  return { verdict: reasons.length > 0 ? 'needs-attention' : 'approve', reasons };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/conclave-verdict.test.mjs tests/unit/conclave-cluster.test.mjs`
Expected: PASS (19 testes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-verdict.test.mjs
git commit -m "feat(conclave): compute review verdict from clusters"
```

---

### Task 7: `runConclave` — rodadas, quorum, juiz e pacote

Fluxo (spec §11.1.2–5; A1–A4, A12, A18):

1. Rodada 1: todos os membros em paralelo (`mapLimit` com `maxParallel`), sessão nova
   (`sessionID: null`), prompt `conclave-member.md`, schema do membro.
2. Rodadas 2..N: só os membros ativos; mesma sessão (`sessionID` devolvido na rodada
   anterior); prompt `conclave-debate.md` com as respostas **anonimizadas** dos colegas
   (rodada anterior, cortadas em 16 KB); schema de debate com `target ∈ colegas`.
3. Cada turno é validado (`checkTurn`): falha, cancelamento, sem `structured` ou fora do
   schema → descartado, listado em `failures` e inativo dali em diante. Exceção lançada pelo
   `deps.turn` vira falha (não derruba o conclave).
4. Abaixo do quorum numa rodada → `failed` com `failure: { code: 'QUORUM_NOT_MET', round, valid, quorum }`, sem juiz.
5. Juiz: `claude` → `{ type: 'claude', status: 'pending' }`; modelo → sessão nova com
   `conclave-judge.md` (só rótulos, respostas anonimizadas), schema de síntese com
   `members ∈ rótulos`; falha → `completed` + aviso.
6. Pacote com `composition` como **último** campo e `synthesisInput` anonimizado.

`runConclave` chama `deps.turn(spec)` e nada mais de I/O: o worker (Tarefa 11) liga isso ao
`runTurn`. `runReview` entra na Tarefa 8; aqui `runConclave` usa só `runDiscussion`.

**Files:**
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (acrescentar ao fim)
- Test: `tests/unit/conclave-run.test.mjs`

**Interfaces:**
- Consumes: Tarefas 1–4 (`validateSchema`, `buildMemberSchema`, `buildDebateSchema`, `buildSynthesisSchema`, `loadConclaveAssets`, `anonymizeValue`); `fillTemplate(…, { strict: true })` e `projectContextBlock` de `lib/prompts.mjs` (F2b).
- Produces: `runConclave({ ctx, question, flags, deps }) → pacote`; funções internas `mapLimit`, `safeTurn`, `checkTurn`, `failureRecord`, `formatLabeled`, `collectRound`, `quorumFailure`, `reviewForJudge`, `runJudge`, `synthesisInputOf` — usadas pela Tarefa 8.

Formato do pacote:

```js
{
  schemaVersion: 1, kind: 'conclave',
  status: 'completed' | 'failed',
  failure: null | { code: 'QUORUM_NOT_MET', round, valid, quorum } | { code: 'REVIEW_CONTEXT_FAILED', message },
  mode, question, rounds: { requested, completed }, quorum,
  startedAt, endedAt, durationMs,
  warnings: string[],
  failures: [{ label, round, role, errorType, errorClass, message, rawText }],
  roundsData: [{ round, responses: [{ label, response }], failures: [...] }],   // respostas originais
  final: { round, responses: [{ label, response }] },
  review: null | { target, truncated, validMembers, memberVerdicts, verdict, reasons, clusters },  // Tarefa 8
  judge: { type: 'claude', status: 'pending' } | { type: 'model', model, status: 'completed', sessionID, synthesis }
       | { type: 'model', model, status: 'failed', sessionID, error: { errorType, message } } | { type, model?, status: 'skipped' },
  synthesisInput: null | { question, mode, labels, rounds, responses: [{ label, response }] /* anonimizadas */, review },
  composition: [{ label, model }],   // sempre o último campo
}
```

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-run.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConclave, buildKnownNames, loadConclaveAssets, validateSchema, REDACTED_NAME } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { makeCatalog, MEMBERS, KM, answer, debateAnswer, synthesis, ok, failed } from './_conclave-fixtures.mjs';

const assets = loadConclaveAssets();
const knownNames = buildKnownNames(makeCatalog());
const FORBIDDEN = /deepseek|qwen|kimi|omniroute|mvalmeida|opencode-go|alibaba|moonshot/i;

function harness(respond, { members = MEMBERS, rounds = 1, quorum = 2, mode = 'opinion', judge = { type: 'claude' }, maxParallel = 4 } = {}) {
  const calls = [];
  const events = [];
  let clock = 1_000;
  const deps = {
    assets,
    knownNames,
    now: () => (clock += 500),
    onEvent: (e) => events.push(e),
    turn: async (spec) => {
      calls.push(spec);
      return respond(spec, calls);
    },
  };
  const flags = { mode, rounds, quorum, members, judge, maxParallel, warnings: [] };
  return { calls, events, run: (question = 'Should we add a write-ahead log?') => runConclave({ ctx: { config: {} }, question, flags, deps }) };
}

const peerOf = (spec) => spec.schema.properties.critiques.items.properties.target.enum[0];
const byRound = (calls, round) => calls.filter((c) => c.round === round);

test('round 1 is blind: one new session per member, member schema, no peer text', async () => {
  const h = harness((spec) => ok(answer(), `ses_${spec.label}`));
  const pkg = await h.run('Q?');
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.equal(call.sessionID, null);
    assert.equal(call.role, 'member');
    assert.equal(call.schema.title, 'ConclaveMember');
    assert.match(call.prompt, new RegExp(`member ${call.label}`));
    assert.match(call.prompt, /<question>\nQ\?\n<\/question>/);
    assert.doesNotMatch(call.prompt, /<peer /);
  }
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.final.responses.map((r) => r.label), ['A', 'B', 'C']);
  assert.deepEqual(pkg.rounds, { requested: 1, completed: 1 });
});

test('package puts the label to model composition last and synthesis input anonymized', async () => {
  const h = harness((spec) => ok(answer({ position: `As kimi-k3 I say yes (${spec.label})` }), `ses_${spec.label}`));
  const pkg = await h.run();
  const keys = Object.keys(pkg);
  assert.equal(keys.at(-1), 'composition');
  assert.deepEqual(pkg.composition, MEMBERS.map((m) => ({ label: m.label, model: m.full })));
  assert.deepEqual(pkg.judge, { type: 'claude', status: 'pending' });
  assert.doesNotMatch(JSON.stringify(pkg.synthesisInput), FORBIDDEN);
  assert.equal(pkg.synthesisInput.responses.length, 3);
  assert.equal(pkg.durationMs, 500);
  assert.equal(pkg.schemaVersion, 1);
});

test('debate: rounds 2..N reuse each member session and receive anonymized peers only', async () => {
  const h = harness((spec) => {
    if (spec.round === 1) return ok(answer({ position: `I am ${spec.member.modelID} by Moonshot or Alibaba`, key_points: ['DeepSeek style point'] }), `ses_${spec.label}`);
    return ok(debateAnswer(peerOf(spec), { changed: spec.label === 'A' }), spec.sessionID);
  }, { mode: 'debate', rounds: 2 });
  const pkg = await h.run();
  const round2 = byRound(h.calls, 2);
  assert.equal(round2.length, 3);
  for (const call of round2) {
    assert.equal(call.sessionID, `ses_${call.label}`);
    assert.equal(call.schema.title, 'ConclaveDebate');
    assert.doesNotMatch(call.prompt, FORBIDDEN);
    assert.ok(call.prompt.includes(REDACTED_NAME));
    assert.doesNotMatch(call.prompt, new RegExp(`<peer label="${call.label}">`));
    const peers = ['A', 'B', 'C'].filter((l) => l !== call.label);
    for (const p of peers) assert.match(call.prompt, new RegExp(`<peer label="${p}">`));
    assert.match(call.prompt, new RegExp(`<peer_labels>${peers.join(', ')}</peer_labels>`));
    assert.match(call.prompt, /round 2 of 2/);
  }
  assert.equal(pkg.rounds.completed, 2);
  assert.deepEqual(pkg.roundsData[1].responses.map((r) => r.response.changed), [true, false, false]);
});

test('a failed member is discarded, listed in failures and excluded from later rounds', async () => {
  const h = harness((spec) => {
    if (spec.label === 'C') return failed('Timeout', { sessionID: 'ses_C' });
    return spec.round === 1 ? ok(answer(), `ses_${spec.label}`) : ok(debateAnswer(peerOf(spec)), spec.sessionID);
  }, { mode: 'debate', rounds: 2 });
  const pkg = await h.run();
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(byRound(h.calls, 2).map((c) => c.label).sort(), ['A', 'B']);
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.round, f.errorType]), [['C', 1, 'Timeout']]);
  for (const call of byRound(h.calls, 2)) assert.doesNotMatch(call.prompt, /<peer label="C">/);
  assert.ok(h.events.some((e) => e.type === 'member-failed' && e.label === 'C'));
});

test('StructuredOutputError is discarded and keeps the raw text for the report', async () => {
  const h = harness((spec) => (spec.label === 'B' ? failed('StructuredOutputError', { finalText: 'not json at all' }) : ok(answer(), `ses_${spec.label}`)));
  const pkg = await h.run();
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.errorType, f.rawText]), [['B', 'StructuredOutputError', 'not json at all']]);
  assert.deepEqual(pkg.final.responses.map((r) => r.label), ['A', 'C']);
});

test('structured output that violates the schema is discarded as InvalidStructuredOutput', async () => {
  const h = harness((spec) => (spec.label === 'A' ? ok(answer({ confidence: 1.7, extra: true }), 'ses_A') : ok(answer(), `ses_${spec.label}`)));
  const pkg = await h.run();
  assert.equal(pkg.failures[0].errorType, 'InvalidStructuredOutput');
  assert.match(pkg.failures[0].message, /\$\.confidence/);
});

test('a completed turn without structured output is discarded', async () => {
  const h = harness((spec) => (spec.label === 'A' ? { status: 'completed', sessionID: 'ses_A', structured: null, finalText: 'hi' } : ok(answer(), `ses_${spec.label}`)));
  const pkg = await h.run();
  assert.equal(pkg.failures[0].errorType, 'MissingStructuredOutput');
});

test('a turn that throws is recorded as a failure instead of crashing the conclave', async () => {
  const h = harness((spec) => {
    if (spec.label === 'A') throw Object.assign(new Error('socket closed'), { code: 'SERVER_DOWN' });
    return ok(answer(), `ses_${spec.label}`);
  });
  const pkg = await h.run();
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.errorType, f.message]), [['A', 'SERVER_DOWN', 'socket closed']]);
});

test('quorum not met in round 1: failed, partial responses kept, no judge, no later rounds', async () => {
  const h = harness((spec) => (spec.label === 'A' ? ok(answer(), 'ses_A') : failed('Timeout')), { mode: 'debate', rounds: 2, quorum: 2, judge: { type: 'model', full: KM, providerID: 'x', modelID: 'y' } });
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.deepEqual(pkg.failure, { code: 'QUORUM_NOT_MET', round: 1, valid: 1, quorum: 2 });
  assert.equal(h.calls.length, 3);
  assert.deepEqual(pkg.final.responses.map((r) => r.label), ['A']);
  assert.deepEqual(pkg.judge, { type: 'model', model: KM, status: 'skipped' });
  assert.equal(pkg.synthesisInput, null);
  assert.deepEqual(pkg.rounds, { requested: 2, completed: 0 });
});

test('quorum not met in round 2 keeps round 1 as completed', async () => {
  const h = harness((spec) => {
    if (spec.round === 1) return ok(answer(), `ses_${spec.label}`);
    return spec.label === 'A' ? ok(debateAnswer(peerOf(spec)), spec.sessionID) : failed('APIError');
  }, { mode: 'debate', rounds: 2, quorum: 3 });
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.equal(pkg.failure.round, 2);
  assert.deepEqual(pkg.rounds, { requested: 2, completed: 1 });
});

test('members run in parallel up to maxParallel', async () => {
  let active = 0;
  let peak = 0;
  const h = harness(async (spec) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return ok(answer(), `ses_${spec.label}`);
  }, { maxParallel: 2 });
  await h.run();
  assert.equal(peak, 2);
  const h3 = harness(async (spec) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return ok(answer(), `ses_${spec.label}`);
  }, { maxParallel: 4 });
  peak = 0;
  await h3.run();
  assert.equal(peak, 3);
});

test('huge peer answers are truncated in the debate prompt', async () => {
  const h = harness((spec) => (spec.round === 1
    ? ok(answer({ position: 'x'.repeat(40_000) }), `ses_${spec.label}`)
    : ok(debateAnswer(peerOf(spec)), spec.sessionID)), { mode: 'debate', rounds: 2 });
  await h.run();
  const prompt = byRound(h.calls, 2)[0].prompt;
  assert.match(prompt, /…\[truncated \d+ chars\]/);
  assert.ok(prompt.length < 40_000);
});

test('judge model sees only labels and its synthesis is validated', async () => {
  const judge = { type: 'model', providerID: 'omniroute-personal', modelID: 'opencode-go/kimi-k3', full: KM };
  const h = harness((spec) => {
    if (spec.role === 'judge') return ok(synthesis(['A', 'B']), 'ses_judge');
    return ok(answer({ position: `I am ${spec.member.full}` }), `ses_${spec.label}`);
  }, { members: MEMBERS.slice(0, 2), judge });
  const pkg = await h.run();
  const judgeCall = h.calls.find((c) => c.role === 'judge');
  assert.equal(judgeCall.sessionID, null);
  assert.equal(judgeCall.schema.title, 'ConclaveSynthesis');
  assert.match(judgeCall.prompt, /<labels>A, B<\/labels>/);
  assert.doesNotMatch(judgeCall.prompt, FORBIDDEN);
  assert.match(judgeCall.prompt, /Not a review conclave\./);
  assert.equal(pkg.judge.status, 'completed');
  assert.deepEqual(validateSchema(pkg.judge.synthesis, judgeCall.schema), []);
  assert.equal(pkg.judge.model, KM);
});

test('judge failure keeps the conclave completed with a warning', async () => {
  const judge = { type: 'model', providerID: 'omniroute-personal', modelID: 'opencode-go/kimi-k3', full: KM };
  const h = harness((spec) => (spec.role === 'judge' ? failed('StructuredOutputError', { finalText: 'raw' }) : ok(answer(), `ses_${spec.label}`)), { members: MEMBERS.slice(0, 2), judge });
  const pkg = await h.run();
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.judge.status, 'failed');
  assert.equal(pkg.judge.error.errorType, 'StructuredOutputError');
  assert.ok(pkg.warnings.some((w) => /opc-conclave/.test(w)));
  assert.ok(pkg.synthesisInput);
});

test('debate note tells the judge how many extra rounds happened', async () => {
  const judge = { type: 'model', providerID: 'omniroute-personal', modelID: 'opencode-go/kimi-k3', full: KM };
  const h = harness((spec) => {
    if (spec.role === 'judge') return ok(synthesis(['A', 'B']), 'ses_judge');
    return spec.round === 1 ? ok(answer(), `ses_${spec.label}`) : ok(debateAnswer(peerOf(spec)), spec.sessionID);
  }, { members: MEMBERS.slice(0, 2), judge, mode: 'debate', rounds: 3 });
  await h.run();
  assert.match(h.calls.find((c) => c.role === 'judge').prompt, /debated for 2 more round\(s\)/);
});

test('user question passes through verbatim, including shell metacharacters', async () => {
  const q = 'Is `rm -rf $(pwd)` "safe"? \'no\' — ção 🚀\nline2';
  const h = harness((spec) => ok(answer(), `ses_${spec.label}`));
  const pkg = await h.run(q);
  assert.ok(h.calls.every((c) => c.prompt.includes(q)));
  assert.equal(pkg.question, q);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-run.test.mjs`
Expected: FAIL com `does not provide an export named 'runConclave'`.

- [ ] **Step 3: Acrescentar a seção de rodadas ao fim de `lib/conclave.mjs`**

```js
// ---------------------------------------------------------------------------
// Rounds, judge and package
// ---------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit || 1, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

function truncateText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function byLabel(a, b) {
  return a.label.localeCompare(b.label);
}

async function safeTurn(deps, spec) {
  try {
    return await deps.turn(spec);
  } catch (err) {
    return {
      status: 'failed', sessionID: spec.sessionID ?? null, structured: null, finalText: '',
      errorType: err?.code ?? err?.name ?? 'Error', errorClass: 'fatal', errorMessage: err?.message ?? String(err),
    };
  }
}

function checkTurn(turn, schema) {
  if (!turn || turn.status !== 'completed') {
    const errorType = turn?.status === 'cancelled' ? 'Cancelled' : (turn?.errorType ?? 'Failed');
    return { ok: false, errorType, message: turn?.errorMessage ?? `turn ended with status ${turn?.status ?? 'unknown'}` };
  }
  if (turn.structured === null || turn.structured === undefined) {
    return { ok: false, errorType: 'MissingStructuredOutput', message: 'the turn finished without structured output' };
  }
  const errors = validateSchema(turn.structured, schema);
  if (errors.length > 0) {
    return { ok: false, errorType: 'InvalidStructuredOutput', message: errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ') };
  }
  return { ok: true };
}

function failureRecord({ label, round, role, turn, check }) {
  return {
    label,
    round,
    role,
    errorType: check.errorType,
    errorClass: turn?.errorClass ?? null,
    message: check.message,
    rawText: turn?.finalText ? truncateText(String(turn.finalText), RAW_TEXT_MAX_CHARS) : null,
  };
}

function formatLabeled(entries, knownNames, tag) {
  return entries.map((e) => {
    const body = truncateText(JSON.stringify(anonymizeValue(e.response, knownNames), null, 2), PEER_RESPONSE_MAX_CHARS);
    return `<${tag} label="${e.label}">\n${body}\n</${tag}>`;
  }).join('\n\n');
}

function memberSpecPrompt(run, state, round, previous) {
  const { flags, assets } = run;
  const label = state.member.label;
  if (round === 1) {
    return {
      schema: buildMemberSchema(assets.schemas.member),
      prompt: fillTemplate(assets.prompts.member, { SELF_LABEL: label, QUESTION: run.question, PROJECT_CONTEXT: run.projectContext }, { strict: true }),
    };
  }
  const peers = previous.responses.filter((r) => r.label !== label);
  const peerLabels = peers.map((p) => p.label);
  return {
    schema: buildDebateSchema(assets.schemas.member, peerLabels),
    prompt: fillTemplate(assets.prompts.debate, {
      SELF_LABEL: label,
      ROUND: round,
      TOTAL_ROUNDS: flags.rounds,
      QUESTION: run.question,
      PEER_LABELS: peerLabels.join(', '),
      PEER_RESPONSES: formatLabeled(peers, run.knownNames, 'peer'),
    }, { strict: true }),
  };
}

function collectRound(run, round, outcomes) {
  const entry = { round, responses: [], failures: [] };
  for (const { label, sessionID, turn, check } of outcomes) {
    if (check.ok) {
      entry.responses.push({ label, response: turn.structured });
      run.emit({ type: 'member-done', role: 'member', label, round, sessionID: sessionID ?? null });
    } else {
      const failure = failureRecord({ label, round, role: 'member', turn, check });
      entry.failures.push(failure);
      run.failures.push(failure);
      run.emit({ type: 'member-failed', ...failure });
    }
  }
  entry.responses.sort(byLabel);
  entry.failures.sort(byLabel);
  return entry;
}

function quorumFailure(entry, quorum) {
  return { code: 'QUORUM_NOT_MET', round: entry.round, valid: entry.responses.length, quorum };
}

async function runDiscussion(run) {
  const { flags, deps, emit } = run;
  const states = flags.members.map((member) => ({ member, sessionID: null, active: true }));
  const roundsData = [];
  let completedRounds = 0;
  for (let round = 1; round <= flags.rounds; round += 1) {
    const active = states.filter((s) => s.active);
    const previous = roundsData.at(-1);
    emit({ type: 'round-start', round, labels: active.map((s) => s.member.label) });
    const outcomes = await mapLimit(active, run.maxParallel, async (state) => {
      const label = state.member.label;
      const { schema, prompt } = memberSpecPrompt(run, state, round, previous);
      emit({ type: 'member-start', role: 'member', label, round });
      const turn = await safeTurn(deps, {
        role: 'member', label, round, member: state.member, sessionID: state.sessionID, prompt, schema,
        title: `OPC: conclave: ${label}: ${run.question.slice(0, 48)}`,
      });
      if (turn?.sessionID) state.sessionID = turn.sessionID;
      return { label, sessionID: state.sessionID, turn, check: checkTurn(turn, schema) };
    });
    const entry = collectRound(run, round, outcomes);
    for (const failure of entry.failures) {
      const state = states.find((s) => s.member.label === failure.label);
      if (state) state.active = false;
    }
    roundsData.push(entry);
    if (entry.responses.length < flags.quorum) {
      return { ok: false, roundsData, completedRounds, review: null, failure: quorumFailure(entry, flags.quorum) };
    }
    completedRounds = round;
  }
  return { ok: true, roundsData, completedRounds, review: null, failure: null };
}

function reviewForJudge(review) {
  return {
    verdict: review.verdict,
    validMembers: review.validMembers,
    clusters: review.clusters.map((c) => ({
      id: c.id, file: c.file, line_start: c.line_start, line_end: c.line_end, severity: c.severity, title: c.title,
      body: c.body, recommendation: c.recommendation, agreement: c.agreement.text, labels: c.labels, meanConfidence: c.meanConfidence,
    })),
  };
}

async function runJudge(run, finalResponses, review) {
  const { flags, assets, deps, emit, knownNames } = run;
  if (flags.judge.type === 'claude') return { type: 'claude', status: 'pending' };
  const labels = finalResponses.map((r) => r.label);
  const schema = buildSynthesisSchema(assets.schemas.synthesis, labels);
  const question = run.question || (review ? `Code review of ${review.target ?? 'the current changes'}` : '');
  const prompt = fillTemplate(assets.prompts.judge, {
    QUESTION: question,
    MODE: flags.mode,
    LABELS: labels.join(', '),
    DEBATE_NOTE: flags.rounds > 1 ? ` and then debated for ${flags.rounds - 1} more round(s)` : '',
    RESPONSES: formatLabeled(finalResponses, knownNames, 'answer'),
    REVIEW_SUMMARY: review ? JSON.stringify(anonymizeValue(reviewForJudge(review), knownNames), null, 2) : 'Not a review conclave.',
  }, { strict: true });
  emit({ type: 'judge-start', model: flags.judge.full });
  const turn = await safeTurn(deps, {
    role: 'judge', label: 'judge', round: null, member: flags.judge, sessionID: null, prompt, schema, title: 'OPC: conclave: judge',
  });
  const check = checkTurn(turn, schema);
  if (!check.ok) {
    run.warnings.push(`judge ${flags.judge.full} failed (${check.errorType}); synthesize from synthesisInput with the opc-conclave skill`);
    emit({ type: 'judge-failed', errorType: check.errorType, message: check.message });
    return { type: 'model', model: flags.judge.full, status: 'failed', sessionID: turn?.sessionID ?? null, error: { errorType: check.errorType, message: check.message } };
  }
  emit({ type: 'judge-done', sessionID: turn.sessionID ?? null });
  return { type: 'model', model: flags.judge.full, status: 'completed', sessionID: turn.sessionID ?? null, synthesis: turn.structured };
}

function synthesisInputOf(run, phase, finalResponses) {
  return {
    question: run.question,
    mode: run.flags.mode,
    labels: finalResponses.map((r) => r.label),
    rounds: phase.completedRounds,
    responses: finalResponses.map((r) => ({ label: r.label, response: anonymizeValue(r.response, run.knownNames) })),
    review: phase.review ? anonymizeValue(reviewForJudge(phase.review), run.knownNames) : null,
  };
}

export async function runConclave({ ctx = {}, question = '', flags, deps }) {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const run = {
    question: String(question ?? ''),
    flags,
    deps,
    assets: deps.assets ?? loadConclaveAssets(),
    knownNames: deps.knownNames ?? { exact: [], families: [] },
    emit: deps.onEvent ?? (() => {}),
    maxParallel: flags.maxParallel ?? ctx.config?.jobs?.maxParallel ?? 4,
    projectContext: projectContextBlock(ctx.config?.project),
    failures: [],
    warnings: [...(flags.warnings ?? [])],
  };
  const phase = await runDiscussion(run);
  const lastRound = phase.roundsData.at(-1);
  const finalResponses = lastRound?.responses ?? [];
  const status = phase.ok ? 'completed' : 'failed';
  const judge = phase.ok
    ? await runJudge(run, finalResponses, phase.review)
    : { type: flags.judge.type, ...(flags.judge.type === 'model' ? { model: flags.judge.full } : {}), status: 'skipped' };
  const endedAt = now();
  return {
    schemaVersion: 1,
    kind: 'conclave',
    status,
    failure: phase.failure,
    mode: flags.mode,
    question: run.question,
    rounds: { requested: flags.rounds, completed: phase.completedRounds },
    quorum: flags.quorum,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    warnings: run.warnings,
    failures: run.failures,
    roundsData: phase.roundsData,
    final: { round: lastRound?.round ?? 0, responses: finalResponses },
    review: phase.review,
    judge,
    synthesisInput: phase.ok ? synthesisInputOf(run, phase, finalResponses) : null,
    composition: flags.members.map((m) => ({ label: m.label, model: m.full })),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/conclave-run.test.mjs`
Expected: PASS (16 testes).

- [ ] **Step 5: Rodar todos os unitários do conclave**

Run: `node --test tests/unit/conclave-*.test.mjs`
Expected: PASS (74 testes).

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-run.test.mjs
git commit -m "feat(conclave): run blind and debate rounds with quorum and judge"
```

---

### Task 8: `runConclave` — modo review

Spec §11.2 e A10, A11, A19: o diff é coletado **uma vez** (`deps.collectReview()`), todos os
membros recebem o mesmo prompt (`prompts/review.md` da F2b) e o schema estrito
`review-output`; a validação local usa a cópia leniente (achado sem localização é aceito);
depois `clusterFindings` (com `validCount` = respostas válidas) e `conclaveVerdict`. Falha na
coleta → `failed` com `REVIEW_CONTEXT_FAILED`, sem nenhum turno. O juiz modelo recebe os
clusters anonimizados em `REVIEW_SUMMARY` e, sem pergunta, `Code review of <alvo>`.

**Files:**
- Modify: `plugins/opc/scripts/lib/conclave.mjs` (uma linha em `runConclave` + seção nova ao fim)
- Test: `tests/unit/conclave-review.test.mjs`

**Interfaces:**
- Consumes: internos da Tarefa 7; `clusterFindings`, `conclaveVerdict`; `deps.collectReview() → { label, summary, content, truncated, files }` (o worker monta a partir de `collectReviewContext` + `target.label`).
- Produces: `runConclave` com `flags.mode === 'review'`; `pkg.review` preenchido.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-review.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConclave, buildKnownNames, loadConclaveAssets } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { fillTemplate } from '../../plugins/opc/scripts/lib/prompts.mjs';
import { makeCatalog, MEMBERS, KM, synthesis, ok, failed } from './_conclave-fixtures.mjs';

const realAssets = loadConclaveAssets();
const assets = { ...realAssets, prompts: { ...realAssets.prompts, review: 'Review {{TARGET_LABEL}}\nFocus: {{USER_FOCUS}}\n{{REVIEW_INPUT}}\n{{REVIEW_COLLECTION_GUIDANCE}}' } };
const knownNames = buildKnownNames(makeCatalog());

const finding = (file, line_start, line_end, title, severity, confidence) => ({
  severity, title, body: `${title} explained`, file, line_start, line_end, confidence, recommendation: `Fix: ${title}`,
});
const REVIEWS = {
  A: { verdict: 'needs-attention', summary: 'Two issues.', findings: [finding('src/calc.js', 10, 12, 'Division by zero when count is 0', 'high', 0.9), finding('', 0, 0, 'Missing tests for calc module', 'low', 0.5)], next_steps: ['Add a guard.'] },
  B: { verdict: 'needs-attention', summary: 'One issue.', findings: [finding('src/calc.js', 13, 14, 'Possible division by zero on empty count', 'critical', 0.7)], next_steps: ['Guard count.'] },
  C: { verdict: 'approve', summary: 'Looks fine.', findings: [], next_steps: [] },
};
const CONTEXT = { label: 'working tree diff', summary: '1 file changed', content: 'diff --git a/src/calc.js b/src/calc.js', truncated: false, files: ['src/calc.js'] };

function harness(respond, { judge = { type: 'claude' }, quorum = 2, collectReview = async () => CONTEXT, promptAssets = assets } = {}) {
  const calls = [];
  let collected = 0;
  const deps = {
    assets: promptAssets,
    knownNames,
    now: () => 0,
    collectReview: async () => { collected += 1; return collectReview(); },
    turn: async (spec) => { calls.push(spec); return respond(spec); },
  };
  const flags = { mode: 'review', rounds: 1, quorum, members: MEMBERS, judge, maxParallel: 4, warnings: [] };
  return { calls, deps, collected: () => collected, run: (q = '') => runConclave({ ctx: { config: {} }, question: q, flags, deps }) };
}

test('review mode collects the diff once and sends the same review prompt and schema to every member', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`));
  await h.run('focus on math');
  assert.equal(h.collected(), 1);
  assert.equal(h.calls.length, 3);
  const prompts = new Set(h.calls.map((c) => c.prompt));
  assert.equal(prompts.size, 1);
  const [prompt] = prompts;
  assert.match(prompt, /Review working tree diff/);
  assert.match(prompt, /Focus: focus on math/);
  assert.match(prompt, /diff --git a\/src\/calc\.js/);
  assert.match(prompt, /The complete diff is included above\./);
  assert.doesNotMatch(prompt, /<user_focus>/);
  assert.ok(h.calls.every((c) => c.schema.properties.findings && c.schema.$schema === undefined));
});

test('with the real F2b review prompt (no {{USER_FOCUS}}) the question still reaches the members as <user_focus>', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`), { promptAssets: realAssets });
  await h.run('focus on math');
  const [prompt] = new Set(h.calls.map((c) => c.prompt));
  assert.ok(prompt.includes('focus on math'));
  assert.ok(prompt.includes('diff --git a/src/calc.js'));
  assert.doesNotMatch(prompt, /\{\{[A-Z0-9_]+\}\}/);
});

test('review mode clusters findings, computes k/N over valid members and the verdict', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`));
  const pkg = await h.run();
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.review.validMembers, 3);
  assert.equal(pkg.review.clusters.length, 2);
  const [top, noFile] = pkg.review.clusters;
  assert.deepEqual([top.severity, top.agreement.text, top.labels, top.meanConfidence], ['critical', '2/3', ['A', 'B'], 0.8]);
  assert.deepEqual([noFile.file, noFile.agreement.text], [null, '1/3']);
  assert.equal(pkg.review.verdict, 'needs-attention');
  assert.deepEqual(pkg.review.reasons.map((r) => r.code), ['SEVERE_FINDING_AGREED', 'MAJORITY_NEEDS_ATTENTION']);
  assert.deepEqual(pkg.review.memberVerdicts, { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
});

test('a failed reviewer shrinks N instead of counting as a silent approval', async () => {
  const h = harness((spec) => (spec.label === 'C' ? failed('Timeout') : ok(REVIEWS[spec.label], `ses_${spec.label}`)));
  const pkg = await h.run();
  assert.equal(pkg.review.validMembers, 2);
  assert.equal(pkg.review.clusters[0].agreement.text, '2/2');
  assert.deepEqual(pkg.failures.map((f) => f.label), ['C']);
});

test('findings without a location pass validation even when the review schema requires one', async () => {
  const strictAssets = structuredClone(assets);
  const item = strictAssets.schemas.review.properties.findings.items;
  item.properties.file = { type: 'string', minLength: 1 };
  item.properties.line_start = { type: 'integer', minimum: 1 };
  item.properties.line_end = { type: 'integer', minimum: 1 };
  const noLocation = { severity: 'low', title: 'Missing tests', body: 'No tests cover calc.', confidence: 0.4, recommendation: 'Add tests.' };
  const h = harness((spec) => ok({ ...REVIEWS[spec.label], findings: [...REVIEWS[spec.label].findings, noLocation] }, `ses_${spec.label}`));
  h.deps.assets = strictAssets;
  const pkg = await h.run();
  assert.equal(pkg.failures.length, 0);
  assert.equal(h.calls[0].schema.properties.findings.items.properties.file.minLength, 1, 'members still get the strict schema');
  assert.equal(pkg.review.clusters.filter((c) => c.file === null).length, 4);
});

test('review quorum not met fails without clusters', async () => {
  const h = harness((spec) => (spec.label === 'A' ? ok(REVIEWS.A, 'ses_A') : failed('StructuredOutputError')));
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.equal(pkg.failure.code, 'QUORUM_NOT_MET');
  assert.equal(pkg.review, null);
});

test('review context failure fails the conclave before any turn', async () => {
  const h = harness(() => { throw new Error('must not run'); }, { collectReview: async () => { throw new Error('not a git repository'); } });
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.deepEqual(pkg.failure, { code: 'REVIEW_CONTEXT_FAILED', message: 'not a git repository' });
  assert.equal(h.calls.length, 0);
});

test('truncated diffs tell reviewers to read the changed files', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`), { collectReview: async () => ({ ...CONTEXT, truncated: true }) });
  await h.run();
  assert.match(h.calls[0].prompt, /truncated to fit/);
});

test('judge model in review mode receives anonymized clusters', async () => {
  const judge = { type: 'model', providerID: 'omniroute-personal', modelID: 'opencode-go/kimi-k3', full: KM };
  const reviews = { ...REVIEWS, A: { ...REVIEWS.A, findings: [finding('src/calc.js', 10, 12, 'Division by zero when count is 0 (qwen3.8-max agrees)', 'high', 0.9)] } };
  const h = harness((spec) => (spec.role === 'judge' ? ok(synthesis(['A', 'B', 'C']), 'ses_j') : ok(reviews[spec.label], `ses_${spec.label}`)), { judge });
  const pkg = await h.run();
  const judgeCall = h.calls.find((c) => c.role === 'judge');
  assert.match(judgeCall.prompt, /<mode>review<\/mode>/);
  assert.match(judgeCall.prompt, /<question>\nCode review of working tree diff\n<\/question>/);
  assert.match(judgeCall.prompt, /"agreement": "2\/3"/);
  assert.doesNotMatch(judgeCall.prompt, /qwen/i);
  assert.equal(pkg.judge.status, 'completed');
  assert.doesNotMatch(JSON.stringify(pkg.synthesisInput.review), /qwen/i);
});

test('the review prompt shipped by F2b is compatible with the variables conclave fills', () => {
  const vars = { TARGET_LABEL: 't', REVIEW_INPUT: 'i', REVIEW_SUMMARY: 's', USER_FOCUS: 'f', REVIEW_COLLECTION_GUIDANCE: 'g', PROJECT_CONTEXT: '' };
  assert.doesNotThrow(() => fillTemplate(realAssets.prompts.review, vars, { strict: true }));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-review.test.mjs`
Expected: FAIL — o modo review ainda roda o fluxo de opinião: `collectReview` nunca é chamado (`Expected values to be strictly equal: 0 !== 1`) e os membros recebem o schema `ConclaveMember`.

- [ ] **Step 3: Despachar o modo review em `runConclave`**

Em `plugins/opc/scripts/lib/conclave.mjs`, troque:

```js
  const phase = await runDiscussion(run);
```

por:

```js
  const phase = flags.mode === 'review' ? await runReview(run) : await runDiscussion(run);
```

- [ ] **Step 4: Acrescentar a seção de review ao fim de `lib/conclave.mjs`**

```js
// ---------------------------------------------------------------------------
// Review mode
// ---------------------------------------------------------------------------

function reviewTemplateVars(context, question, projectContext = '') {
  return {
    PROJECT_CONTEXT: projectContext,
    TARGET_LABEL: context.label ?? 'the current changes',
    REVIEW_INPUT: context.content ?? '',
    REVIEW_SUMMARY: context.summary ?? '',
    USER_FOCUS: question.trim() || 'No extra focus was given; review for correctness, security and maintainability.',
    REVIEW_COLLECTION_GUIDANCE: context.truncated
      ? 'The diff above was truncated to fit. Read the changed files listed in the summary with the read tool before concluding.'
      : 'The complete diff is included above.',
  };
}

// Members receive the strict review schema; validation accepts findings without a location,
// which then become singleton clusters (spec §11.2).
function lenientReviewSchema(reviewSchemaFile) {
  const schema = stripMeta(reviewSchemaFile);
  const item = schema?.properties?.findings?.items;
  if (!item?.properties) return schema;
  const locationKeys = ['file', 'line_start', 'line_end'];
  for (const key of locationKeys) {
    const prop = item.properties[key];
    if (!prop) continue;
    const types = Array.isArray(prop.type) ? prop.type : (prop.type ? [prop.type] : []);
    const relaxed = { ...prop };
    if (types.length) relaxed.type = [...new Set([...types, 'null'])];
    delete relaxed.minLength;
    delete relaxed.minimum;
    item.properties[key] = relaxed;
  }
  if (Array.isArray(item.required)) item.required = item.required.filter((k) => !locationKeys.includes(k));
  return schema;
}

async function runReview(run) {
  const { flags, deps, emit, assets } = run;
  let context;
  try {
    if (typeof deps.collectReview !== 'function') throw new Error('review mode needs deps.collectReview');
    context = await deps.collectReview();
  } catch (err) {
    return { ok: false, roundsData: [], completedRounds: 0, review: null, failure: { code: 'REVIEW_CONTEXT_FAILED', message: err?.message ?? String(err) } };
  }
  const schema = stripMeta(assets.schemas.review);
  const validation = lenientReviewSchema(assets.schemas.review);
  let prompt = fillTemplate(assets.prompts.review, reviewTemplateVars(context, run.question, run.projectContext), { strict: true });
  // F2b's review.md has no {{USER_FOCUS}} (only adversarial-review.md does): the question (review
  // focus, A19) is appended instead of silently dropped.
  const focus = run.question.trim();
  if (focus && !assets.prompts.review.includes('{{USER_FOCUS}}')) prompt = `${prompt}\n\n<user_focus>\n${focus}\n</user_focus>`;
  emit({ type: 'round-start', round: 1, labels: flags.members.map((m) => m.label) });
  const outcomes = await mapLimit(flags.members, run.maxParallel, async (member) => {
    emit({ type: 'member-start', role: 'member', label: member.label, round: 1 });
    const turn = await safeTurn(deps, {
      role: 'member', label: member.label, round: 1, member, sessionID: null, prompt, schema,
      title: `OPC: conclave: review ${member.label}`,
    });
    return { label: member.label, sessionID: turn?.sessionID ?? null, turn, check: checkTurn(turn, validation) };
  });
  const entry = collectRound(run, 1, outcomes);
  if (entry.responses.length < flags.quorum) {
    return { ok: false, roundsData: [entry], completedRounds: 0, review: null, failure: quorumFailure(entry, flags.quorum) };
  }
  const findingsByMember = Object.fromEntries(entry.responses.map((r) => [r.label, Array.isArray(r.response.findings) ? r.response.findings : []]));
  const memberVerdicts = Object.fromEntries(entry.responses.map((r) => [r.label, r.response.verdict]));
  const clusters = clusterFindings(findingsByMember, { validCount: entry.responses.length });
  const { verdict, reasons } = conclaveVerdict(clusters, memberVerdicts);
  return {
    ok: true,
    roundsData: [entry],
    completedRounds: 1,
    failure: null,
    review: { target: context.label ?? null, truncated: Boolean(context.truncated), validMembers: entry.responses.length, memberVerdicts, verdict, reasons, clusters },
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/conclave-review.test.mjs tests/unit/conclave-run.test.mjs`
Expected: PASS (26 testes). Se `the review prompt shipped by F2b is compatible…` falhar com `TEMPLATE_UNFILLED`, a F2b mudou os placeholders do `review.md` (premissa P8): acrescente em `reviewTemplateVars` o nome que a mensagem listar, mapeado para `context.label`, `context.content`, `context.summary`, o foco, o contexto do projeto ou a orientação de coleta, e rode de novo.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/conclave.mjs tests/unit/conclave-review.test.mjs
git commit -m "feat(conclave): add cross review mode with clustering and verdict"
```

---

### Task 9: Render do pacote (`renderConclave`)

Spec §11.3 e A20. Cabeçalho (status, rodadas concluídas/pedidas, quorum, válidos/membros,
duração, job), falha do grupo, avisos, tabela de falhas, pergunta, corpo por modo (respostas
por rótulo ou veredito + clusters), síntese e, **por último**, a composição. As respostas são
mostradas a partir de `synthesisInput.responses` (a cópia anonimizada), para que um membro que
se identificou não revele a marca a quem vai sintetizar; num conclave que falhou (sem
`synthesisInput`) mostra as respostas parciais como vieram.

**Files:**
- Modify: `plugins/opc/scripts/lib/render.mjs` (acrescentar ao fim)
- Test: `tests/unit/render-conclave.test.mjs`

**Interfaces:**
- Consumes: `renderTable(headers, rows)` (F0, mesmo arquivo); pacote da Tarefa 7/8 (com `jobId` opcional acrescentado pelo worker).
- Produces: `renderConclave(pkg) → string` (Markdown).

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/render-conclave.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConclave } from '../../plugins/opc/scripts/lib/render.mjs';
import { answer, debateAnswer, synthesis, DS, QW, KM } from './_conclave-fixtures.mjs';

const base = () => ({
  schemaVersion: 1, kind: 'conclave', jobId: 'conc-abc-123456', status: 'completed', failure: null, mode: 'opinion',
  question: 'Should we add a WAL?\nSecond line', rounds: { requested: 1, completed: 1 }, quorum: 2, durationMs: 61_500,
  warnings: [], failures: [], roundsData: [],
  final: { round: 1, responses: [{ label: 'A', response: answer() }, { label: 'B', response: answer({ position: 'No | never', confidence: 0.3 }) }] },
  review: null, judge: { type: 'claude', status: 'pending' }, synthesisInput: {},
  composition: [{ label: 'A', model: DS }, { label: 'B', model: QW }],
});

test('header carries status, rounds, quorum, valid members, duration and job id', () => {
  const out = renderConclave(base());
  assert.match(out, /^# opc conclave · opinion/);
  assert.match(out, /\*\*Status:\*\* concluído · \*\*Rodadas:\*\* 1\/1 · \*\*Quorum:\*\* 2 · \*\*Válidos:\*\* 2\/2 · \*\*Duração:\*\* 1 min 2 s · \*\*Job:\*\* `conc-abc-123456`/);
  assert.match(out, /> Should we add a WAL\?\n> Second line/);
});

test('member answers are rendered by label only and composition comes last', () => {
  const out = renderConclave(base());
  assert.match(out, /### Membro A · confiança 0\.80/);
  assert.match(out, /`src\/store\.js:10-20` — writes happen in place/);
  const body = out.slice(0, out.indexOf('## Composição'));
  assert.doesNotMatch(body, /deepseek|qwen|omniroute/i);
  assert.ok(out.indexOf('## Composição') > out.indexOf('## Síntese'));
  assert.match(out, /\| A \| omniroute-personal\/opencode-go\/deepseek-v4\.1-flash \|/);
});

test('answers are rendered from the anonymized synthesis input when available', () => {
  const pkg = base();
  pkg.final.responses[0] = { label: 'A', response: answer({ position: 'I am kimi-k3 and I say yes' }) };
  pkg.synthesisInput = { responses: [{ label: 'A', response: answer({ position: 'I am [redacted] and I say yes' }) }, pkg.final.responses[1]] };
  const out = renderConclave(pkg);
  assert.match(out, /\*\*Posição:\*\* I am \[redacted\] and I say yes/);
  assert.doesNotMatch(out.slice(0, out.indexOf('## Composição')), /kimi/i);
});

test('claude judge asks for the opc-conclave skill', () => {
  assert.match(renderConclave(base()), /Juiz: Claude\. Sintetize com a skill `opc-conclave`/);
});

test('model judge synthesis is rendered with all fields', () => {
  const pkg = { ...base(), judge: { type: 'model', model: KM, status: 'completed', synthesis: synthesis(['A', 'B']) } };
  const out = renderConclave(pkg);
  assert.match(out, /Juiz: `omniroute-personal\/opencode-go\/kimi-k3` · confiança 0\.70/);
  assert.match(out, /\*\*Consenso:\*\*\n- Durability is the main concern\./);
  assert.match(out, /- Mechanism\n  - A: write-ahead log\n  - B: backups/);
  assert.match(out, /\*\*Posição ponderada:\*\* Use a write-ahead log\./);
  assert.match(out, /\*\*Relatórios minoritários:\*\*\n- B: Backups may be enough/);
});

test('failed judge and failures table are shown', () => {
  const pkg = { ...base(), judge: { type: 'model', model: KM, status: 'failed', error: { errorType: 'StructuredOutputError', message: 'bad' } }, failures: [{ label: 'C', round: 1, role: 'member', errorType: 'Timeout', message: 'timed out | late' }], warnings: ['judge failed'] };
  const out = renderConclave(pkg);
  assert.match(out, /O juiz `omniroute-personal\/opencode-go\/kimi-k3` falhou \(StructuredOutputError: bad\)/);
  assert.match(out, /\| C \| 1 \| Timeout \| timed out \\\| late \|/);
  assert.match(out, /\*\*Avisos:\*\*\n- judge failed/);
});

test('quorum failure is explained and synthesis is skipped', () => {
  const pkg = { ...base(), status: 'failed', failure: { code: 'QUORUM_NOT_MET', round: 2, valid: 1, quorum: 2 }, judge: { type: 'claude', status: 'skipped' }, rounds: { requested: 2, completed: 1 } };
  const out = renderConclave(pkg);
  assert.match(out, /\*\*Status:\*\* falhou/);
  assert.match(out, /quorum não atingido na rodada 2 \(1 válidas de 2 exigidas\)/);
  assert.match(out, /Sem síntese/);
});

test('debate answers show changed and critiques', () => {
  const pkg = { ...base(), mode: 'debate', rounds: { requested: 2, completed: 2 }, final: { round: 2, responses: [{ label: 'A', response: debateAnswer('B', { changed: true }) }, { label: 'B', response: debateAnswer('A') }] } };
  const out = renderConclave(pkg);
  assert.match(out, /## Respostas \(rodada 2\)/);
  assert.match(out, /### Membro A · confiança 0\.80 · mudou de posição: sim/);
  assert.match(out, /→ B: No numbers behind the latency claim\./);
});

test('review mode renders verdict, reasons, clusters with k/N and member verdicts', () => {
  const pkg = {
    ...base(), mode: 'review', question: '',
    final: { round: 1, responses: [{ label: 'A', response: {} }, { label: 'B', response: {} }] },
    review: {
      target: 'working tree', truncated: false, validMembers: 2, memberVerdicts: { A: 'needs-attention', B: 'approve' }, verdict: 'needs-attention',
      reasons: [{ code: 'SEVERE_FINDING_AGREED', clusterId: 'C1', severity: 'high', agreement: '2/2' }],
      clusters: [{ id: 'C1', file: 'src/calc.js', line_start: 10, line_end: 14, severity: 'high', title: 'Division by zero', body: 'Count may be 0.', recommendation: 'Guard it.', agreement: { k: 2, n: 2, text: '2/2' }, labels: ['A', 'B'], meanConfidence: 0.8, bestLabel: 'A', findings: [] }],
    },
  };
  const out = renderConclave(pkg);
  assert.match(out, /## Veredito: needs-attention/);
  assert.match(out, /- C1: severidade high com concordância 2\/2/);
  assert.match(out, /\| C1 \| high \| 2\/2 \| 0\.8 \| src\/calc\.js:10-14 \| Division by zero \| A, B \|/);
  assert.match(out, /\*\*Recomendação:\*\* Guard it\./);
  assert.match(out, /\| A \| needs-attention \|/);
  assert.doesNotMatch(out, /## Pergunta/);
});

test('review without findings says so', () => {
  const pkg = { ...base(), mode: 'review', review: { target: null, truncated: true, validMembers: 2, memberVerdicts: { A: 'approve', B: 'approve' }, verdict: 'approve', reasons: [], clusters: [] } };
  const out = renderConclave(pkg);
  assert.match(out, /Nenhum achado relevante\./);
  assert.match(out, /diff truncado/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/render-conclave.test.mjs`
Expected: FAIL com `does not provide an export named 'renderConclave'`.

- [ ] **Step 3: Acrescentar ao fim de `plugins/opc/scripts/lib/render.mjs`**

```js
// ---------------------------------------------------------------------------
// F4c: conclave
// ---------------------------------------------------------------------------

const CONCLAVE_STATUS_PT = { completed: 'concluído', failed: 'falhou', cancelled: 'cancelado' };
const CONCLAVE_FAILURE_PT = {
  QUORUM_NOT_MET: (f) => `quorum não atingido na rodada ${f.round} (${f.valid} válidas de ${f.quorum} exigidas)`,
  REVIEW_CONTEXT_FAILED: (f) => `falha ao coletar o diff: ${f.message}`,
};
const CONCLAVE_REASON_PT = {
  SEVERE_FINDING_AGREED: (r) => `${r.clusterId}: severidade ${r.severity} com concordância ${r.agreement}`,
  MAJORITY_NEEDS_ATTENTION: (r) => `${r.count} de ${r.of} membros válidos deram needs-attention`,
};

function formatConclaveDuration(ms) {
  const seconds = Math.max(0, Math.round((ms ?? 0) / 100) / 10);
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

function conclaveLocation(file, start, end) {
  if (!file) return '(sem arquivo)';
  if (start == null) return file;
  return end != null && end !== start ? `${file}:${start}-${end}` : `${file}:${start}`;
}

function bulletList(items) {
  return (items ?? []).map((i) => `- ${String(i).replace(/\n+/g, ' ')}`).join('\n');
}

function renderMemberResponse({ label, response }) {
  const lines = [];
  const changed = typeof response.changed === 'boolean' ? ` · mudou de posição: ${response.changed ? 'sim' : 'não'}` : '';
  lines.push(`### Membro ${label} · confiança ${Number(response.confidence).toFixed(2)}${changed}`, '');
  lines.push(`**Posição:** ${response.position}`, '');
  if (response.key_points?.length) lines.push('**Pontos-chave:**', bulletList(response.key_points), '');
  if (response.risks?.length) lines.push('**Riscos:**', bulletList(response.risks), '');
  if (response.evidence?.length) {
    lines.push('**Evidências:**', bulletList(response.evidence.map((e) => `\`${conclaveLocation(e.file, e.line_start, e.line_end)}\` — ${e.note}`)), '');
  }
  if (response.would_change_mind_if) lines.push(`**Mudaria de ideia se:** ${response.would_change_mind_if}`, '');
  if (response.critiques?.length) lines.push('**Críticas:**', bulletList(response.critiques.map((c) => `→ ${c.target}: ${c.point}`)), '');
  return lines.join('\n');
}

function renderConclaveReview(review) {
  const lines = [`## Veredito: ${review.verdict}`, ''];
  if (review.reasons.length) lines.push(bulletList(review.reasons.map((r) => (CONCLAVE_REASON_PT[r.code] ?? ((x) => x.code))(r))), '');
  lines.push(`Membros válidos: ${review.validMembers}${review.truncated ? ' · diff truncado (membros leram os arquivos)' : ''}`, '');
  lines.push('## Achados agrupados', '');
  if (review.clusters.length === 0) {
    lines.push('Nenhum achado relevante.', '');
  } else {
    lines.push(renderTable(
      ['#', 'Severidade', 'Concordância', 'Confiança média', 'Local', 'Título', 'Rótulos'],
      review.clusters.map((c) => [c.id, c.severity ?? '-', c.agreement.text, c.meanConfidence ?? '-', conclaveLocation(c.file, c.line_start, c.line_end), c.title, c.labels.join(', ')]),
    ));
    for (const c of review.clusters) {
      lines.push(`### ${c.id} · ${c.severity ?? '-'} · ${c.agreement.text} · \`${conclaveLocation(c.file, c.line_start, c.line_end)}\``, '', c.body, '');
      if (c.recommendation) lines.push(`**Recomendação:** ${c.recommendation}`, '');
    }
  }
  lines.push('## Veredito por membro', '');
  lines.push(renderTable(['Rótulo', 'Veredito'], Object.entries(review.memberVerdicts).map(([label, v]) => [label, v])));
  return lines.join('\n');
}

function renderConclaveSynthesis(pkg) {
  const judge = pkg.judge ?? {};
  const lines = ['## Síntese', ''];
  if (judge.status === 'skipped') {
    lines.push('Sem síntese: o conclave falhou antes do juiz.', '');
    return lines.join('\n');
  }
  if (judge.type === 'claude') {
    lines.push('Juiz: Claude. Sintetize com a skill `opc-conclave` a partir das respostas acima, só pelos rótulos; a composição está no fim e só entra depois da síntese.', '');
    return lines.join('\n');
  }
  if (judge.status === 'failed') {
    lines.push(`O juiz \`${judge.model}\` falhou (${judge.error?.errorType}: ${judge.error?.message}). Sintetize com a skill \`opc-conclave\`.`, '');
    return lines.join('\n');
  }
  const s = judge.synthesis;
  lines.push(`Juiz: \`${judge.model}\` · confiança ${Number(s.confidence).toFixed(2)}`, '');
  lines.push('**Consenso:**', s.consensus.length ? bulletList(s.consensus) : '- (nenhum)', '');
  lines.push('**Divergências:**');
  if (s.disagreements.length === 0) lines.push('- (nenhuma)');
  for (const d of s.disagreements) {
    lines.push(`- ${d.topic}`);
    for (const p of d.positions) lines.push(`  - ${p.members.join(', ')}: ${p.stance}`);
  }
  lines.push('', `**Posição ponderada:** ${s.weighted_position}`, '', `**Recomendação:** ${s.recommendation}`, '');
  if (s.minority_reports.length) lines.push('**Relatórios minoritários:**', bulletList(s.minority_reports.map((m) => `${m.members.join(', ')}: ${m.summary}`)), '');
  return lines.join('\n');
}

export function renderConclave(pkg) {
  const lines = [];
  const valid = pkg.final?.responses?.length ?? 0;
  lines.push(`# opc conclave · ${pkg.mode}`, '');
  const header = [
    `**Status:** ${CONCLAVE_STATUS_PT[pkg.status] ?? pkg.status}`,
    `**Rodadas:** ${pkg.rounds.completed}/${pkg.rounds.requested}`,
    `**Quorum:** ${pkg.quorum}`,
    `**Válidos:** ${valid}/${pkg.composition.length}`,
    `**Duração:** ${formatConclaveDuration(pkg.durationMs)}`,
  ];
  if (pkg.jobId) header.push(`**Job:** \`${pkg.jobId}\``);
  lines.push(header.join(' · '), '');
  if (pkg.failure) lines.push(`**Falha:** ${(CONCLAVE_FAILURE_PT[pkg.failure.code] ?? ((f) => f.code))(pkg.failure)}`, '');
  if (pkg.warnings?.length) lines.push('**Avisos:**', bulletList(pkg.warnings), '');
  if (pkg.failures?.length) {
    lines.push('### Falhas', '');
    lines.push(renderTable(['Rótulo', 'Rodada', 'Tipo', 'Mensagem'], pkg.failures.map((f) => [f.label, f.round ?? '-', f.errorType, f.message ?? ''])));
  }
  if (pkg.question) lines.push('## Pergunta', '', pkg.question.split('\n').map((l) => `> ${l}`).join('\n'), '');
  if (pkg.mode === 'review' && pkg.review) {
    lines.push(renderConclaveReview(pkg.review));
  } else if (valid > 0) {
    // Prefer the anonymized copy handed to the synthesis, so a self-identifying member does not
    // reveal its brand to whoever synthesizes; fall back to the raw answers of a failed conclave.
    const shown = pkg.synthesisInput?.responses?.length ? pkg.synthesisInput.responses : pkg.final.responses;
    lines.push(`## Respostas (rodada ${pkg.final.round})`, '');
    for (const entry of shown) lines.push(renderMemberResponse(entry));
  }
  lines.push(renderConclaveSynthesis(pkg));
  lines.push('## Composição', '');
  lines.push(renderTable(['Rótulo', 'Modelo'], pkg.composition.map((c) => [c.label, c.model])));
  return lines.join('\n');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/render-conclave.test.mjs`
Expected: PASS (10 testes). Se `renderTable` do F0 escapar `|` de outro jeito (por exemplo com `&#124;`), ajuste só a regex do teste `failed judge and failures table are shown` ao formato real e registre.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/render.mjs tests/unit/render-conclave.test.mjs
git commit -m "feat(render): render conclave package"
```

---

### Task 10: Cenários do servidor falso

Sete cenários (um por arquivo, como manda o mestre) sobre um módulo comum. O comportamento é
decidido por requisição: o tipo vem do `title` do `json_schema` que o plugin manda
(`ConclaveMember`, `ConclaveDebate`, `ConclaveSynthesis`; sem título = review) e o membro vem
da família em `body.model.modelID` (`deepseek`, `qwen`, `kimi`). Os rótulos que o juiz e os
debatedores precisam citar são lidos das tags do próprio prompt. `HANG` = nunca emitir o turno
(o timeout do plugin aborta). Toda a dependência da API do fake (premissa P6) fica em
`_conclave-common.mjs`.

**Files:**
- Create: `tests/fixtures/scenarios/_conclave-common.mjs`
- Create: `tests/fixtures/scenarios/conclave-opinion.mjs`
- Create: `tests/fixtures/scenarios/conclave-debate.mjs`
- Create: `tests/fixtures/scenarios/conclave-member-timeout.mjs`
- Create: `tests/fixtures/scenarios/conclave-member-structured-error.mjs`
- Create: `tests/fixtures/scenarios/conclave-self-identify.mjs`
- Create: `tests/fixtures/scenarios/conclave-review.mjs`
- Create: `tests/fixtures/scenarios/judge-ok.mjs`
- Test: `tests/unit/conclave-scenarios.test.mjs`

**Interfaces:**
- Consumes: API de cenário do fake — `{ onPromptAsync(fake, sessionID, body) }` e `fake.emitTurn(sessionID, { text, structured, error, delayMs })` (mestre, F2a); schemas da Tarefa 1.
- Produces: os nomes de cenário usados pelas Tarefas 11 e 12 via `FAKE_OPENCODE_SCENARIO`.

| Cenário | Membros | Debate | Juiz | Review |
|---|---|---|---|---|
| `conclave-opinion` | respostas distintas por família | padrão (`changed:false`) | **falha** (`StructuredOutputError`) | padrão (aprova) |
| `conclave-debate` | padrão | `deepseek` com `changed:true`; demais `false` | síntese válida | padrão |
| `conclave-member-timeout` | `kimi` nunca responde | `kimi` nunca responde | síntese válida | padrão |
| `conclave-member-structured-error` | `qwen` devolve `StructuredOutputError` com texto bruto | padrão | síntese válida | padrão |
| `conclave-self-identify` | cada membro cita o próprio modelo, provider e vendor | idem | síntese válida | padrão |
| `conclave-review` | padrão | padrão | síntese válida | achados sobrepostos (ver arquivo) |
| `judge-ok` | padrão | padrão | síntese válida com os rótulos do prompt | padrão (aprova) |

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-scenarios.test.mjs` (usa um fake mínimo que só registra `emitTurn`; valida
que toda saída dos cenários é aceita pelos schemas reais, para que um erro de fixture não vire
um falso "membro descartado" na integração):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConclaveAssets, buildMemberSchema, buildDebateSchema, buildSynthesisSchema, validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';

const assets = loadConclaveAssets();
const SCENARIOS = ['conclave-opinion', 'conclave-debate', 'conclave-member-timeout', 'conclave-member-structured-error', 'conclave-self-identify', 'conclave-review', 'judge-ok'];
const MODELS = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3'];

function body(modelID, schema, text) {
  return { model: { providerID: 'omniroute-personal', modelID }, format: { type: 'json_schema', schema }, parts: [{ type: 'text', text }] };
}

async function emitted(name, requestBody) {
  const { default: scenario } = await import(`../fixtures/scenarios/${name}.mjs`);
  const turns = [];
  scenario.onPromptAsync({ emitTurn: (sessionID, turn) => turns.push(turn) }, 'ses_test', requestBody);
  return turns[0] ?? null;
}

test('every conclave scenario answers members, debate and judge with schema-valid output or an explicit failure', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const synthesis = buildSynthesisSchema(assets.schemas.synthesis, ['A', 'B']);
  for (const name of SCENARIOS.filter((n) => n !== 'conclave-review')) {
    for (const modelID of MODELS) {
      for (const [schema, text] of [[member, 'q'], [debate, '<peer_labels>A, C</peer_labels>']]) {
        const turn = await emitted(name, body(modelID, schema, text));
        if (turn === null) { assert.equal(name, 'conclave-member-timeout'); continue; }
        if (turn.error) { assert.equal(turn.error.name, 'StructuredOutputError'); continue; }
        assert.deepEqual(validateSchema(turn.structured, schema), [], `${name} ${modelID} ${schema.title}`);
      }
    }
    const judgeTurn = await emitted(name, body(MODELS[2], synthesis, '<labels>A, B</labels>'));
    if (judgeTurn.error) assert.equal(name, 'conclave-opinion');
    else assert.deepEqual(validateSchema(judgeTurn.structured, synthesis), [], `${name} judge`);
  }
});

test('debate scenario flips changed only for the deepseek member', async () => {
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const changed = [];
  for (const modelID of MODELS) changed.push((await emitted('conclave-debate', body(modelID, debate, '<peer_labels>A, C</peer_labels>'))).structured.changed);
  assert.deepEqual(changed, [true, false, false]);
});

test('review scenario returns review-shaped output per family', async () => {
  const reviewSchema = structuredClone(assets.schemas.review);
  for (const modelID of MODELS) {
    const turn = await emitted('conclave-review', body(modelID, reviewSchema, 'diff'));
    assert.ok(['approve', 'needs-attention'].includes(turn.structured.verdict));
    assert.ok(Array.isArray(turn.structured.findings));
  }
});

test('self-identify scenario really names model, provider and vendor', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const turn = await emitted('conclave-self-identify', body(MODELS[1], member, 'q'));
  const text = JSON.stringify(turn.structured);
  assert.match(text, /qwen3\.8-max/);
  assert.match(text, /omniroute-personal/);
  assert.match(text, /Alibaba/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-scenarios.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `../fixtures/scenarios/conclave-opinion.mjs`.

- [ ] **Step 3: Criar o módulo comum**

`tests/fixtures/scenarios/_conclave-common.mjs`:

```js
// Shared behavior for the conclave scenarios (not a scenario by itself).
// Every scenario decides per request: member (round 1), debate (rounds 2..N), judge or review,
// using the json_schema title sent by the plugin and the model family in body.model.modelID.

export const HANG = Symbol('hang');

export function textOf(body) {
  return (body?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export function kindOf(body) {
  const title = body?.format?.schema?.title ?? null;
  if (title === 'ConclaveMember') return 'member';
  if (title === 'ConclaveDebate') return 'debate';
  if (title === 'ConclaveSynthesis') return 'judge';
  return 'review';
}

export function familyOf(body) {
  const id = String(body?.model?.modelID ?? '').toLowerCase();
  for (const family of ['deepseek', 'qwen', 'kimi']) if (id.includes(family)) return family;
  return 'other';
}

export function tagList(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const POSITIONS = {
  deepseek: { position: 'Add a write-ahead log before applying changes.', confidence: 0.8 },
  qwen: { position: 'Apply changes in place and rely on nightly backups.', confidence: 0.6 },
  kimi: { position: 'Add a write-ahead log, but batch fsync calls.', confidence: 0.7 },
  other: { position: 'Measure first, then decide.', confidence: 0.5 },
};

export function memberAnswer(family, overrides = {}) {
  const base = POSITIONS[family] ?? POSITIONS.other;
  return {
    position: base.position,
    confidence: base.confidence,
    key_points: ['Durability matters more than raw latency here.'],
    risks: ['More disk writes per change.'],
    evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: 'writes happen in place' }],
    would_change_mind_if: 'Benchmarks show the log doubles write latency.',
    ...overrides,
  };
}

export function debateAnswer(family, body, { changed = false, overrides = {} } = {}) {
  const peers = tagList(textOf(body), 'peer_labels');
  return {
    ...memberAnswer(family),
    ...(changed ? { position: 'After the debate: add a write-ahead log with batched fsync.', confidence: 0.75 } : {}),
    critiques: peers.slice(0, 1).map((target) => ({ target, point: 'The latency argument has no numbers behind it.' })),
    changed,
    ...overrides,
  };
}

export function synthesisFor(body) {
  const labels = tagList(textOf(body), 'labels');
  return {
    consensus: ['Durability is the main concern.'],
    disagreements: [{
      topic: 'How to guarantee durability',
      positions: [{ members: labels.slice(0, 1), stance: 'write-ahead log' }, { members: labels.slice(1), stance: 'in-place writes plus backups' }],
    }],
    weighted_position: 'Add a write-ahead log.',
    confidence: 0.7,
    recommendation: 'Prototype the log and measure write latency.',
    minority_reports: [{ members: labels.slice(-1), summary: 'Backups may be enough for low write volume.' }],
  };
}

export function reviewAnswer() {
  return { verdict: 'approve', summary: 'No material issues.', findings: [], next_steps: [] };
}

export const STRUCTURED_ERROR = { name: 'StructuredOutputError', data: { message: 'Model did not produce valid structured output', retries: 2 } };

const DEFAULTS = {
  member: ({ family }) => ({ structured: memberAnswer(family) }),
  debate: ({ family, body }) => ({ structured: debateAnswer(family, body) }),
  judge: ({ body }) => ({ structured: synthesisFor(body) }),
  review: () => ({ structured: reviewAnswer() }),
};

export function makeConclaveScenario(handlers = {}) {
  return {
    onPromptAsync(fake, sessionID, body) {
      const kind = kindOf(body);
      const handler = handlers[kind] ?? DEFAULTS[kind];
      const outcome = handler({ fake, sessionID, body, family: familyOf(body) });
      if (outcome === HANG) return;
      fake.emitTurn(sessionID, { delayMs: 20, text: '', ...outcome });
    },
  };
}
```

- [ ] **Step 4: Criar os sete cenários**

`tests/fixtures/scenarios/conclave-opinion.mjs`:

```js
// Three members answer with distinct structured positions. A model judge, if asked, fails with
// StructuredOutputError so tests can check that the conclave still completes with a warning.
import { makeConclaveScenario, STRUCTURED_ERROR } from './_conclave-common.mjs';

export default makeConclaveScenario({
  judge: () => ({ error: STRUCTURED_ERROR, text: 'The members mostly agree.' }),
});
```

`tests/fixtures/scenarios/conclave-debate.mjs`:

```js
// Round 2 answers carry critiques and `changed`: the deepseek member changes its position,
// the others keep theirs.
import { makeConclaveScenario, debateAnswer } from './_conclave-common.mjs';

export default makeConclaveScenario({
  debate: ({ body, family }) => ({ structured: debateAnswer(family, body, { changed: family === 'deepseek' }) }),
});
```

`tests/fixtures/scenarios/conclave-member-timeout.mjs`:

```js
// The kimi member never answers (no turn is emitted), so the plugin's memberTimeoutSec aborts it.
import { makeConclaveScenario, memberAnswer, debateAnswer, HANG } from './_conclave-common.mjs';

export default makeConclaveScenario({
  member: ({ family }) => (family === 'kimi' ? HANG : { structured: memberAnswer(family) }),
  debate: ({ body, family }) => (family === 'kimi' ? HANG : { structured: debateAnswer(family, body) }),
});
```

`tests/fixtures/scenarios/conclave-member-structured-error.mjs`:

```js
// The qwen member fails with StructuredOutputError (raw text only); the others answer normally.
import { makeConclaveScenario, memberAnswer, STRUCTURED_ERROR } from './_conclave-common.mjs';

export default makeConclaveScenario({
  member: ({ family }) => (family === 'qwen'
    ? { error: STRUCTURED_ERROR, text: 'I think the log is a good idea, but I cannot format it.' }
    : { structured: memberAnswer(family) }),
});
```

`tests/fixtures/scenarios/conclave-self-identify.mjs`:

```js
// Members name themselves, their vendor and their provider in free text; the plugin must scrub
// all of it before debate and judge prompts.
import { makeConclaveScenario, memberAnswer, debateAnswer } from './_conclave-common.mjs';

const VENDOR = { deepseek: 'DeepSeek', qwen: 'Alibaba', kimi: 'Moonshot', other: 'Acme' };

function identity(body, family) {
  return `I am ${body.model.modelID} served by ${body.model.providerID}, a ${family.toUpperCase()} model from ${VENDOR[family]}.`;
}

export default makeConclaveScenario({
  member: ({ body, family }) => ({
    structured: memberAnswer(family, {
      position: `${identity(body, family)} ${memberAnswer(family).position}`,
      key_points: [`As ${family}, I trust durability.`, `${body.model.providerID}/${body.model.modelID} says: measure first.`],
      evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: `checked by ${body.model.modelID}` }],
    }),
  }),
  debate: ({ body, family }) => ({
    structured: debateAnswer(family, body, { overrides: { position: `${identity(body, family)} Still the same view.` } }),
  }),
});
```

`tests/fixtures/scenarios/conclave-review.mjs`:

```js
// Review mode with overlapping findings (spec §11.2):
// - deepseek + qwen report the same division by zero in src/calc.js at 10-12 and 13-14 → one cluster, 2/3;
// - kimi reports the same title at 30-31 (more than 3 lines away) → its own cluster;
// - deepseek and qwen report "Off-by-one" in src/list.js at 5 and 40 → two clusters;
// - deepseek ('') and qwen ('N/A') report findings without file → never clustered.
import { makeConclaveScenario } from './_conclave-common.mjs';

const finding = (file, line_start, line_end, title, severity, confidence) => ({
  severity, title, body: `${title}.`, file, line_start, line_end, confidence, recommendation: `Fix: ${title.toLowerCase()}.`,
});

export const REVIEWS = {
  deepseek: {
    verdict: 'needs-attention',
    summary: 'Division by zero and an off-by-one.',
    findings: [
      finding('src/calc.js', 10, 12, 'Division by zero when count is 0', 'high', 0.9),
      finding('src/list.js', 5, 5, 'Off-by-one in loop bound', 'medium', 0.6),
      finding('', 1, 1, 'Missing tests for calc module', 'low', 0.5),
    ],
    next_steps: ['Guard the division.'],
  },
  qwen: {
    verdict: 'needs-attention',
    summary: 'Unsafe division.',
    findings: [
      finding('src/calc.js', 13, 14, 'Possible division by zero on empty count', 'critical', 0.7),
      finding('src/list.js', 40, 41, 'Off-by-one in loop bound', 'medium', 0.8),
      finding('N/A', 1, 1, 'Missing tests for calc module', 'low', 0.4),
    ],
    next_steps: ['Check count before dividing.'],
  },
  kimi: {
    verdict: 'approve',
    summary: 'Minor concern only.',
    findings: [finding('src/calc.js', 30, 31, 'Division by zero when count is 0', 'high', 0.5)],
    next_steps: [],
  },
};

export default makeConclaveScenario({
  review: ({ family }) => ({ structured: REVIEWS[family] ?? REVIEWS.kimi }),
});
```

`tests/fixtures/scenarios/judge-ok.mjs`:

```js
// Members answer normally and the model judge returns a valid synthesis that uses the labels
// listed in the judge prompt (<labels>A, B</labels>).
import { makeConclaveScenario } from './_conclave-common.mjs';

export default makeConclaveScenario({});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/conclave-scenarios.test.mjs`
Expected: PASS (4 testes).

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/scenarios/_conclave-common.mjs tests/fixtures/scenarios/conclave-opinion.mjs tests/fixtures/scenarios/conclave-debate.mjs tests/fixtures/scenarios/conclave-member-timeout.mjs tests/fixtures/scenarios/conclave-member-structured-error.mjs tests/fixtures/scenarios/conclave-self-identify.mjs tests/fixtures/scenarios/conclave-review.mjs tests/fixtures/scenarios/judge-ok.mjs tests/unit/conclave-scenarios.test.mjs
git commit -m "test(conclave): add fake scenarios for opinion, debate, review and failures"
```

---

### Task 11: Comando `opc conclave` e worker coordenador

Fluxo do comando (`run`):

1. `readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin })` (F2a; texto livre por
   `--raw-args-stdin`, reconciliação D3) → `parseArgs`; `validateConclaveOptions` **antes** de
   qualquer servidor (erros de uso rápidos); pergunta obrigatória fora do review;
   `--base`/`--scope` só no review; no review, `resolveReviewTarget(ctx.cwd, …)` também antes do
   servidor.
2. `assertNotInsideServer(ctx.env)` (F2a; exit 4 `INSIDE_SERVER`) → `openApi(ctx)` (F3) →
   `buildCatalog(await api.providers())` → `composeMembers` (política, quorum, rodadas, juiz);
   avisos em stderr com prefixo `[opc]`.
3. Sob `withServerLock(ctx, …, { purpose: 'register-job:conclave' })` (F2b), um único
   `createGroup` (F3) registra o grupo `conc-…` (`kind: 'conclave'`, `role: GROUP_ROLE`), um job
   por membro (`kind: 'conclave-member'`, `role: 'member:<rótulo>'`, `model`) e, com juiz modelo,
   um job `judge` (`kind: 'conclave-judge'`), com `{ maxActive: ctx.config?.jobs?.maxActive ?? 8 }`
   (só o grupo conta no limite). Depois grava o `request` no grupo (`type: 'conclave'`,
   composição com os `jobId`s dos membros devolvidos). Falha na criação: o `createGroup` marca os
   registros criados como `failed/group_create_failed`; falha ao gravar o `request`: o comando
   marca grupo e membros como `failed/not_started`.
4. `spawnWorker(ctx, groupId)`; `--background` devolve o id; foreground acompanha com
   `waitForJob` e imprime `job.rendered` (ou `job.result` com `--json`). Exit por
   `exitCodeForJob(job)` (F2a): `completed` → 0, `failed` → 7, `cancelled` → 130.

Worker (`runWorker`, chamado pelo `task-worker` via `WORKER_DELEGATES.conclave`, F3):
`openApi(ctx, { withHub: true, respawn: false })` (F3; reaproveita o servidor, nunca sobe outro
no meio do turno) dá **uma** `EventHub`; monta `knownNames` a partir do catálogo (+ membros e
juiz), as regras `profileRules(ctx, 'read-only')` (F3) e o `deps.turn` sobre `runTurn` (sessão
nova com as regras na primeira vez; mesma sessão nas rodadas seguintes; `format: json_schema`;
`timeoutMs = memberTimeoutSec × 1000`; permissão/pergunta → `reject` imediato, A22); atualiza os
jobs dos membros pelos eventos; no fim grava `result = { jobId, ...pacote }` e
`rendered = renderConclave(result)` no grupo e fecha os membros e o juiz.

**Files:**
- Create: `plugins/opc/scripts/commands/conclave.mjs`
- Modify: `plugins/opc/scripts/commands/task-worker.mjs` (literal `WORKER_DELEGATES` da F3)
- Create: `tests/integration/_conclave-helpers.mjs`
- Test: `tests/integration/conclave.test.mjs`

**Interfaces:**
- Consumes: `parseArgs` (F0); `readRawArgs` (F2a, `lib/args.mjs`); `OpcError`, `ExitCode`, `toExitCode` (F0); `redactText` (F0); `openApi`, `profileRules` (F3, `lib/context.mjs`; o `api` traz `providers`, `replyPermission`, `rejectQuestion`); `buildCatalog` (F1); `runTurn`, `newMessageId` (F2a); `ACTIVE_STATUSES`, `updateJob`, `readJob`, `appendJobLog`, `spawnWorker`, `waitForJob`, `assertNotInsideServer` (F2a); `withServerLock` (F2b); `createGroup` (F3); `exitCodeForJob` (F2a, `commands/task.mjs`); `WORKER_DELEGATES` (F3, `task-worker.mjs`); `resolveReviewTarget`, `collectReviewContext` (F2b); tudo de `lib/conclave.mjs`; `renderConclave` (Tarefa 9).
- Produces: subcomando `conclave` (`run(ctx, argv)`) e `runWorker(ctx, job) → exit code`; entrada `conclave: './conclave.mjs'` no `WORKER_DELEGATES`.

- [ ] **Step 1: Criar os helpers de integração**

`tests/integration/_conclave-helpers.mjs`:

```js
// Helpers for the conclave integration tests (not a test file; the runner only collects *.test.mjs).
// Phase module: adds conclave-specific helpers only; canonical names come from ../helpers.mjs (fakeRequests is
// re-exported from there, never redefined).
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, testEnv, runCli, fakeRequests, writeGlobalConfig } from '../helpers.mjs';

export { fakeRequests };

export const PREFIX = 'omniroute-personal/opencode-go/';
export const DS = `${PREFIX}deepseek-v4.1-flash`;
export const QW = `${PREFIX}qwen3.8-max`;
export const KM = `${PREFIX}kimi-k3`;
export const TRIO = `${DS},${QW},${KM}`;
export const FORBIDDEN_NAMES = ['deepseek', 'qwen', 'kimi', 'omniroute', 'mvalmeida', 'opencode-go', 'alibaba', 'moonshot'];

// Servers are stopped by the F0 per-test cleanup (testEnv/makeWorkspace) before the temp dirs are removed.
export function setupConclave(t, { scenario, config = null, git = true } = {}) {
  const cwd = makeWorkspace(t, { git });
  const env = testEnv(t, { scenario });
  if (config) writeGlobalConfig(env, config);
  return { env, cwd };
}

export async function conclave(args, { env, cwd, stdin = '', timeoutMs = 90_000 } = {}) {
  const res = await runCli(['conclave', ...args], { env, cwd, stdin, timeoutMs });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { ...res, json };
}

export function promptRequests(env) {
  return fakeRequests(env).filter((r) => r.method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(r.path));
}

export function sessionOfRequest(request) {
  return request.path.split('/')[2];
}

export function requestsBySchema(env, title) {
  return promptRequests(env).filter((r) => (r.body?.format?.schema?.title ?? null) === title);
}

export function reviewRequests(env) {
  const conclaveTitles = new Set(['ConclaveMember', 'ConclaveDebate', 'ConclaveSynthesis']);
  return promptRequests(env).filter((r) => !conclaveTitles.has(r.body?.format?.schema?.title));
}

export function textOf(body) {
  return (body?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export function section(text, tag) {
  const start = text.indexOf(`<${tag}>`);
  const end = text.indexOf(`</${tag}>`);
  return start >= 0 && end > start ? text.slice(start, end) : '';
}

export function labelOf(pkg, full) {
  return pkg.composition.find((c) => c.model === full)?.label ?? null;
}

export function writeReviewChanges(cwd) {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'calc.js'), 'export function mean(values) {\n  const count = values.length;\n  return values.reduce((a, b) => a + b, 0) / count;\n}\n');
  fs.writeFileSync(path.join(cwd, 'src', 'list.js'), 'export function last(items) {\n  for (let i = 0; i <= items.length; i++) {}\n  return items[items.length];\n}\n');
}
```

- [ ] **Step 2: Escrever o teste que falha**

`tests/integration/conclave.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, readFakeState } from '../helpers.mjs';
import { setupConclave, conclave, requestsBySchema, fakeRequests, textOf, DS, QW, KM, TRIO } from './_conclave-helpers.mjs';

const Q = 'Should the storage layer add a write-ahead log?';

test('opinion: three members answer blind in read-only sessions; --json returns the full package', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const res = await conclave(['--models', TRIO, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  assert.match(pkg.jobId, /^conc-/);
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.mode, 'opinion');
  assert.deepEqual(pkg.rounds, { requested: 1, completed: 1 });
  assert.equal(pkg.final.responses.length, 3);
  assert.deepEqual(pkg.failures, []);
  assert.equal(Object.keys(pkg).at(-1), 'composition');
  assert.deepEqual(pkg.composition.map((c) => c.label), ['A', 'B', 'C']);
  assert.deepEqual(new Set(pkg.composition.map((c) => c.model)), new Set([DS, QW, KM]));
  assert.deepEqual(pkg.judge, { type: 'claude', status: 'pending' });

  const members = requestsBySchema(env, 'ConclaveMember');
  assert.equal(members.length, 3);
  assert.ok(members.every((r) => r.body.format.type === 'json_schema' && textOf(r.body).includes(Q)));
  assert.equal(new Set(members.map((r) => r.body.model.modelID)).size, 3);

  const created = readFakeState(env).requests.filter((r) => r.method === 'POST' && r.path === '/session');
  assert.equal(created.length, 3);
  for (const s of created) {
    assert.match(s.body.title, /^OPC: conclave: /);
    assert.deepEqual(s.body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
    assert.ok(!s.body.permission.some((rule) => rule.permission === 'bash' && rule.action === 'allow'));
  }
});

test('opinion without --json renders markdown with the composition after the synthesis', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const res = await conclave(['--models', `${DS},${QW}`, Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^# opc conclave · opinion/m);
  assert.match(res.stdout, /### Membro A · confiança/);
  assert.match(res.stdout, /Juiz: Claude\. Sintetize com a skill `opc-conclave`/);
  assert.ok(res.stdout.indexOf('## Composição') > res.stdout.indexOf('## Síntese'));
  const beforeComposition = res.stdout.slice(0, res.stdout.indexOf('## Composição'));
  assert.doesNotMatch(beforeComposition, /omniroute-personal\/opencode-go/);
  assert.match(res.stderr, /\[opc\] conclave conc-/);
});

test('background: returns the id at once; status --wait and result --json (F3 group shape) deliver the package', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const started = await conclave(['--models', TRIO, '--background', '--json', Q], { env, cwd });
  assert.equal(started.code, 0, started.stderr);
  const { jobId } = started.json;
  assert.match(jobId, /^conc-/);
  const waited = await runCli(['status', jobId, '--wait', '--timeout-ms', '60000'], { env, cwd });
  assert.equal(waited.code, 0, waited.stderr);
  const result = await runCli(['result', jobId, '--json'], { env, cwd });
  assert.equal(result.code, 0, result.stderr);
  const { group, members } = JSON.parse(result.stdout);
  assert.equal(members.length, 3);
  const pkg = group.result;
  assert.equal(pkg.jobId, jobId);
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.final.responses.length, 3);
  const rendered = await runCli(['result', jobId], { env, cwd });
  assert.match(rendered.stdout, /# opc conclave · opinion/);
});

test('member job records carry role, model and session; the group links them', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const res = await conclave(['--models', TRIO, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const jobsDir = path.join(env.OPC_DATA_DIR, 'state');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\/jobs\/[^/]+\.json$/.test(full)) files.push(full);
    }
  };
  walk(jobsDir);
  const jobs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const members = jobs.filter((j) => j.groupId === res.json.jobId);
  assert.equal(members.length, 3);
  for (const m of members) {
    assert.match(m.role, /^member:[ABC]$/);
    assert.equal(m.status, 'completed');
    assert.ok(m.sessionID);
    assert.equal(res.json.composition.find((c) => `member:${c.label}` === m.role).model, m.model);
  }
});

test('the question reaches every member intact through --raw-args-stdin, without shell expansion', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const question = "Is `rm -rf $(pwd)` \"safe\"? don't\n$(touch pwned) — ção 🚀";
  const stdin = `--models ${DS},${QW} --json ${question}\n`;
  const res = await runCli(['conclave', '--raw-args-stdin'], { env, cwd, stdin });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
  for (const r of requestsBySchema(env, 'ConclaveMember')) assert.ok(textOf(r.body).includes(question));
  assert.equal(JSON.parse(res.stdout).question, question);
});

test('inside the OpenCode server (OPC_INSIDE_SERVER=1) conclave refuses with exit 4 before connecting', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const res = await conclave(['--models', TRIO, Q], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd });
  assert.equal(res.code, 4, res.stderr);
  assert.match(res.stderr, /INSIDE_SERVER|inside the OpenCode server/);
  assert.equal(fakeRequests(env).length, 0);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/integration/conclave.test.mjs`
Expected: FAIL — o dispatcher não conhece o subcomando: exit 2 (`unknown subcommand`/equivalente) em vez de 0.

- [ ] **Step 4: Criar o subcomando e o worker**

`plugins/opc/scripts/commands/conclave.mjs`:

```js
// opc conclave: composes the members, registers the job group and spawns one coordinator worker.
// runWorker is the coordinator body, dispatched by task-worker through WORKER_DELEGATES.conclave.
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { OpcError, ExitCode, toExitCode } from '../lib/opc-error.mjs';
import { redactText } from '../lib/redact.mjs';
import { openApi, profileRules } from '../lib/context.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { runTurn, newMessageId } from '../lib/runner.mjs';
import {
  ACTIVE_STATUSES, createGroup, updateJob, readJob, appendJobLog, spawnWorker, waitForJob,
  assertNotInsideServer, withServerLock,
} from '../lib/jobs.mjs';
import { resolveReviewTarget, collectReviewContext } from '../lib/git.mjs';
import { composeMembers, validateConclaveOptions, runConclave, buildKnownNames, loadConclaveAssets } from '../lib/conclave.mjs';
import { renderConclave } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';

// --cwd never reaches here (the F0 dispatcher strips it; ctx.cwd reflects it).
const SPEC = {
  flags: {
    models: { type: 'list' },
    pool: { type: 'string' },
    mode: { type: 'string', default: 'opinion' },
    rounds: { type: 'number' },
    judge: { type: 'string' },
    quorum: { type: 'number' },
    'allow-judge-member': { type: 'boolean', default: false },
    background: { type: 'boolean', default: false },
    'wait-timeout': { type: 'number' },
    base: { type: 'string' },
    scope: { type: 'string' },
    json: { type: 'boolean', default: false },
    'raw-args-stdin': { type: 'boolean' },
  },
  allowPositionals: true,
};

function usage(code, message) {
  return new OpcError(code, message, { exitCode: ExitCode.USAGE });
}

async function createConclaveJobs(ctx, { question, composition, target }) {
  const summary = (question || `review ${target?.label ?? ''}`).trim().slice(0, 120);
  const common = { summary, permissionProfile: 'read-only' };
  const memberFields = composition.members.map((m) => ({
    ...common, kind: 'conclave-member', title: `OPC: conclave: member ${m.label}`, role: `member:${m.label}`, model: m.full,
  }));
  if (composition.judge.type === 'model') {
    memberFields.push({ ...common, kind: 'conclave-judge', title: 'OPC: conclave: judge', role: 'judge', model: composition.judge.full });
  }
  // Ids come from the kind (conclave* → conc-…); only the group counts toward jobs.maxActive.
  const { group, members: created } = await withServerLock(ctx, () => createGroup(ctx.stateDir, {
    ...common, kind: 'conclave', title: `OPC: conclave: ${composition.mode}`, status: 'queued',
    workspaceRoot: ctx.workspaceRoot, claudeSessionId: ctx.claudeSessionId ?? null,
  }, memberFields, { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: 'register-job:conclave' });
  const idByRole = new Map(created.map((job) => [job.role, job.id]));
  try {
    const request = {
      type: 'conclave', question, mode: composition.mode, rounds: composition.rounds, quorum: composition.quorum,
      members: composition.members.map((m) => ({ ...m, jobId: idByRole.get(`member:${m.label}`) })),
      judge: { ...composition.judge, jobId: idByRole.get('judge') ?? null },
      warnings: composition.warnings, target, reviewCwd: ctx.cwd,
    };
    return await updateJob(ctx.stateDir, group.id, { request });
  } catch (err) {
    const completedAt = new Date().toISOString();
    for (const id of [group.id, ...created.map((job) => job.id)]) {
      await updateJob(ctx.stateDir, id, { status: 'failed', errorCode: 'not_started', errorMessage: err.message, completedAt });
    }
    throw err;
  }
}

function emitResult(ctx, job, asJson) {
  const pkg = job.result ?? null;
  if (asJson) {
    ctx.json(pkg ?? { jobId: job.id, status: job.status, errorCode: job.errorCode ?? null, errorMessage: job.errorMessage ?? null });
  } else {
    ctx.out(job.rendered ?? `# opc conclave\nJob \`${job.id}\`: ${job.status}${job.errorMessage ? `\n${job.errorCode}: ${job.errorMessage}` : ''}\n`);
  }
  return exitCodeForJob(job);
}

export async function run(ctx, argv) {
  const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, SPEC);
  if (raw.text && positionals.length) throw usage('CONFLICT', 'pass the question either inline or through --raw-args-stdin');
  const mode = flags.mode;
  const question = (raw.text ?? positionals.join(' ')).trim();
  // parseArgs gives [] for an absent list flag (F0); null means "use the pool".
  const models = flags.models.length > 0 ? flags.models : null;
  validateConclaveOptions({ mode, models, pool: flags.pool ?? null, quorum: flags.quorum ?? null, rounds: flags.rounds ?? null, config: ctx.config });
  if (mode !== 'review' && !question) {
    throw usage('CONCLAVE_NO_QUESTION', 'conclave needs a question: opc conclave "<question>" [--models a,b | --pool name]');
  }
  if (mode !== 'review' && (flags.base || flags.scope)) {
    throw usage('CONCLAVE_REVIEW_FLAGS', '--base and --scope only apply to --mode review');
  }
  const target = mode === 'review'
    ? resolveReviewTarget(ctx.cwd, { base: flags.base ?? null, scope: flags.scope ?? 'auto' })
    : null;

  assertNotInsideServer(ctx.env); // recursion guard (F2a): exit 4 before any connection
  const { api } = await openApi(ctx);
  const catalog = buildCatalog(await api.providers());
  const composition = composeMembers({
    models, pool: flags.pool ?? null, config: ctx.config, catalog, policy: ctx.config.policy,
    quorum: flags.quorum ?? null, rounds: flags.rounds ?? null, mode, judge: flags.judge ?? null,
    allowJudgeMember: flags['allow-judge-member'],
  });
  for (const warning of composition.warnings) ctx.err(`[opc] ${warning}\n`);

  const group = await createConclaveJobs(ctx, { question, composition, target });
  await spawnWorker(ctx, group.id);
  ctx.err(`[opc] conclave ${group.id}: ${composition.members.length} members, ${composition.rounds} round(s), quorum ${composition.quorum}\n`);

  if (flags.background) {
    if (flags.json) ctx.json({ jobId: group.id, status: 'queued', background: true });
    else ctx.out(`Conclave \`${group.id}\` iniciado em background.\nAcompanhe com \`/opc:status ${group.id}\` e veja o resultado com \`/opc:result ${group.id}\`.\n`);
    return ExitCode.OK;
  }
  const waitTimeoutMs = flags['wait-timeout'] != null ? flags['wait-timeout'] * 1000 : undefined;
  const done = await waitForJob(ctx, group.id, {
    waitTimeoutMs,
    onLog: (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`),
  });
  return emitResult(ctx, readJob(ctx.stateDir, done.id) ?? done, flags.json);
}

function phaseOf(spec) {
  return spec.role === 'judge' ? 'judging' : `round-${spec.round}`;
}

export async function runWorker(ctx, job) {
  const { stateDir } = ctx;
  const req = job.request;
  const now = () => new Date().toISOString();
  const log = (line) => appendJobLog(stateDir, job.id, `[opc] conclave: ${line}`);
  const memberJobs = new Map(req.members.map((m) => [m.label, m.jobId]));
  const pending = [];
  const track = (promise) => pending.push(promise.catch((err) => log(`state update failed: ${redactText(err.message)}`)));
  let conn = null;
  await updateJob(stateDir, job.id, { status: 'running', phase: 'starting', startedAt: now() });
  try {
    // Coordinator: reuse the running server, never spawn another mid-turn; one shared EventHub.
    conn = await openApi(ctx, { withHub: true, respawn: false });
    const { api, hub } = conn;
    const catalog = buildCatalog(await api.providers());
    const knownNames = buildKnownNames(catalog, { extraModels: [...req.members, ...(req.judge.type === 'model' ? [req.judge] : [])] });
    const rules = profileRules(ctx, 'read-only');
    const timeoutMs = (ctx.config.conclave?.memberTimeoutSec ?? 900) * 1000;

    const turn = async (spec) => {
      const jobId = spec.role === 'judge' ? req.judge.jobId : memberJobs.get(spec.label);
      if (jobId) await updateJob(stateDir, jobId, { status: 'running', phase: phaseOf(spec), ...(spec.sessionID ? {} : { startedAt: now() }) });
      const request = {
        ...(spec.sessionID ? { sessionID: spec.sessionID } : { newSession: { title: spec.title, permission: rules } }),
        parts: [{ type: 'text', text: spec.prompt }],
        model: { providerID: spec.member.providerID, modelID: spec.member.modelID },
        format: { type: 'json_schema', schema: spec.schema },
        messageID: newMessageId(),
        timeoutMs,
        fallbackCfg: ctx.config.routing?.fallback ?? {},
      };
      const result = await runTurn({
        api,
        hub,
        request,
        onProgress: (p) => log(`${spec.label} ${phaseOf(spec)}: ${typeof p === 'string' ? p : (p?.phase ?? 'running')}`),
        // A22: read-only members/judge reject at once (what the F2a bridge does for read-only),
        // so there is no pendingRequest to release and no onRequestResolved.
        onPermission: async (permission) => {
          await api.replyPermission(permission.id, { reply: 'reject', message: 'opc: conclave sessions are read-only' });
        },
        onQuestion: async (question) => {
          await api.rejectQuestion(question.id);
        },
      });
      if (jobId && result.sessionID) await updateJob(stateDir, jobId, { sessionID: result.sessionID });
      return result;
    };

    const onEvent = (e) => {
      if (e.type === 'round-start') {
        log(`round ${e.round}: ${e.labels.join(', ')}`);
        track(updateJob(stateDir, job.id, { phase: `round-${e.round}` }));
      } else if (e.type === 'member-done') {
        log(`round ${e.round}: ${e.label} answered`);
      } else if (e.type === 'member-failed') {
        log(`round ${e.round}: ${e.label} discarded (${e.errorType})`);
        const id = memberJobs.get(e.label);
        if (id) track(updateJob(stateDir, id, { status: 'failed', errorCode: e.errorType, errorClass: e.errorClass, errorMessage: e.message, completedAt: now() }));
      } else if (e.type === 'judge-start') {
        log('judge started');
        track(updateJob(stateDir, job.id, { phase: 'judging' }));
      } else if (e.type === 'judge-failed') {
        log(`judge failed (${e.errorType})`);
      } else if (e.type === 'judge-done') {
        log('judge answered');
      }
    };

    const pkg = await runConclave({
      ctx: { config: ctx.config, workspaceRoot: ctx.workspaceRoot },
      question: req.question,
      flags: {
        mode: req.mode, rounds: req.rounds, quorum: req.quorum, members: req.members, judge: req.judge,
        warnings: req.warnings ?? [], maxParallel: ctx.config.jobs?.maxParallel ?? 4,
      },
      deps: {
        turn,
        knownNames,
        assets: loadConclaveAssets(),
        onEvent,
        collectReview: req.mode === 'review'
          ? () => ({ ...collectReviewContext(req.reviewCwd ?? ctx.cwd, req.target), label: req.target?.label ?? null })
          : null,
      },
    });
    await Promise.all(pending);

    const completedAt = now();
    const failed = new Set(pkg.failures.filter((f) => f.role === 'member').map((f) => f.label));
    for (const m of req.members) {
      if (!failed.has(m.label)) await updateJob(stateDir, m.jobId, { status: 'completed', phase: 'done', completedAt });
    }
    if (req.judge.jobId) {
      const judgeStatus = { completed: 'completed', failed: 'failed', skipped: 'cancelled' }[pkg.judge.status] ?? 'failed';
      await updateJob(stateDir, req.judge.jobId, {
        status: judgeStatus, phase: 'done', completedAt,
        ...(pkg.judge.status === 'skipped' ? { errorCode: 'skipped' } : {}),
        ...(pkg.judge.error ? { errorCode: pkg.judge.error.errorType, errorMessage: pkg.judge.error.message } : {}),
      });
    }
    const result = { jobId: job.id, ...pkg };
    await updateJob(stateDir, job.id, {
      status: pkg.status,
      phase: 'done',
      completedAt,
      result,
      rendered: renderConclave(result),
      errorCode: pkg.failure ? pkg.failure.code.toLowerCase() : null,
      errorMessage: pkg.failure ? JSON.stringify(pkg.failure) : null,
    });
    log(`finished: ${pkg.status}`);
    return pkg.status === 'completed' ? ExitCode.OK : ExitCode.JOB_FAILED;
  } catch (err) {
    await Promise.allSettled(pending);
    const completedAt = now();
    const message = redactText(err?.message ?? String(err));
    log(`failed: ${message}`);
    await updateJob(stateDir, job.id, { status: 'failed', phase: 'done', completedAt, errorCode: err?.code ?? 'conclave_error', errorMessage: message });
    for (const id of [...memberJobs.values(), req.judge?.jobId].filter(Boolean)) {
      const member = readJob(stateDir, id);
      if (member && ACTIVE_STATUSES.includes(member.status)) {
        await updateJob(stateDir, id, { status: 'failed', errorCode: 'group_failed', errorMessage: message, completedAt });
      }
    }
    return toExitCode(err);
  } finally {
    conn?.close();
  }
}
```

- [ ] **Step 5: Registrar o conclave no `WORKER_DELEGATES` do `task-worker`**

Em `plugins/opc/scripts/commands/task-worker.mjs`, edite o literal da F3 (o despacho por
`WORKER_DELEGATES[stored.kind]` já roda logo após `if (!stored?.request) throw …` e antes de
qualquer uso de `request.parts`/`request.model`, e recusa membros de grupo). Acrescente a
entrada `conclave`; a entrada `orch` é da F4b — se a F4b ainda não foi aplicada nesta branch,
ela não existe no literal e não deve ser criada aqui:

```js
export const WORKER_DELEGATES = Object.freeze({
  sub: './subagent.mjs', cmd: './command.mjs', orch: './orchestrate.mjs', conclave: './conclave.mjs',
});
```

Só o grupo (`kind: 'conclave'`) tem worker; os jobs `conclave-member`/`conclave-judge` rodam
dentro do coordenador (o `task-worker` os recusa com `GROUP_MEMBER_WORKER`).

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/integration/conclave.test.mjs`
Expected: PASS (6 testes).

O `result.mjs` não muda: a F3 (`resultForGroupOrCommand`) já imprime `job.rendered` do grupo e,
com `--json`, `{ group, members }` — o teste `background:` lê o pacote em `group.result`.

- [ ] **Step 7: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS, 0 falhas (nenhum teste de fase anterior quebrado pelo novo subcomando).

- [ ] **Step 8: Commit**

```bash
git add plugins/opc/scripts/commands/conclave.mjs plugins/opc/scripts/commands/task-worker.mjs tests/integration/_conclave-helpers.mjs tests/integration/conclave.test.mjs
git commit -m "feat(conclave): add opc conclave command and coordinator worker"
```

---

### Task 12: Testes de integração de todos os itens de aceite da F4c

Um teste (ou grupo) por item da spec §13.3 (F4c), contra a CLI real e o fake. Não há código de
produto novo: se algum teste falhar, a correção vai no módulo dono (Tarefas 3–11), com o teste
unitário correspondente reforçado.

**Files:**
- Test: `tests/integration/conclave-acceptance.test.mjs`

**Interfaces:**
- Consumes: helpers da Tarefa 11; cenários da Tarefa 10; `loadConclaveAssets`, `buildSynthesisSchema`, `validateSchema` (Tarefas 1–2); `readFakeState` (mestre).
- Produces: evidência de aceite para o relatório (seção 3).

- [ ] **Step 1: Escrever os testes**

`tests/integration/conclave-acceptance.test.mjs`:

```js
// One test (or group) per F4c acceptance item of spec §13.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFakeState } from '../helpers.mjs';
import { loadConclaveAssets, buildSynthesisSchema, validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import {
  setupConclave, conclave, promptRequests, requestsBySchema, reviewRequests, sessionOfRequest, textOf, section,
  labelOf, writeReviewChanges, DS, QW, KM, TRIO, FORBIDDEN_NAMES,
} from './_conclave-helpers.mjs';

const Q = 'Should the storage layer add a write-ahead log?';
const FAST_TIMEOUT = { conclave: { memberTimeoutSec: 2 } };

// --- Composition validations -------------------------------------------------

test('composition: 1 member, invalid quorum, conflicting flags and bad rounds exit 2 without prompting', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const cases = [
    ['--models', DS, Q],
    ['--models', `${DS},${DS}`, Q],
    ['--models', `${DS},${QW}`, '--quorum', '1', Q],
    ['--models', `${DS},${QW}`, '--quorum', '3', Q],
    ['--models', `${DS},${QW}`, '--pool', 'default', Q],
    ['--models', `${DS},${QW}`, '--mode', 'debate', '--rounds', '1', Q],
    ['--models', `${DS},${QW}`, '--rounds', '4', Q],
    ['--models', `${DS},${QW}`, '--mode', 'vote', Q],
    ['--models', `${DS},${QW}`, '--mode', 'review', '--rounds', '2'],
    ['--models', `${DS},${QW}`, '--base', 'main', Q],
    ['--models', `${DS},${QW}`],
  ];
  for (const args of cases) {
    const res = await conclave(args, { env, cwd });
    assert.equal(res.code, 2, `${args.join(' ')} → exit ${res.code}\n${res.stdout}${res.stderr}`);
  }
  assert.equal(promptRequests(env).length, 0);
});

test('composition: pool from config; denied member skipped with a warning', async (t) => {
  const config = { conclave: { pools: { trio: [DS, QW, KM] }, defaultPool: 'trio' }, policy: { models: { allow: [], deny: ['*kimi*'] } } };
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion', config });
  const res = await conclave(['--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.json.composition.map((c) => c.model).sort(), [DS, QW].sort());
  assert.match(res.stderr, /skipping "omniroute-personal\/opencode-go\/kimi-k3": model denied by policy/);
  assert.ok(requestsBySchema(env, 'ConclaveMember').every((r) => !r.body.model.modelID.includes('kimi')));
});

test('composition: every member denied → exit 4; denied judge → exit 4', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion', config: { policy: { models: { allow: [], deny: ['*kimi*', '*qwen*', '*deepseek*'] } } } });
  const allDenied = await conclave(['--models', TRIO, Q], { env, cwd });
  assert.equal(allDenied.code, 4, allDenied.stderr);
  const other = setupConclave(t, { scenario: 'conclave-opinion', config: { policy: { models: { allow: [], deny: ['*kimi*'] } } } });
  const judgeDenied = await conclave(['--models', `${DS},${QW}`, '--judge', KM, Q], other);
  assert.equal(judgeDenied.code, 4, judgeDenied.stderr);
  assert.equal(promptRequests(env).length + promptRequests(other.env).length, 0);
});

// --- Anonymization -----------------------------------------------------------

test('anonymization: no model, vendor or provider name reaches debate or judge prompts, even when members self-identify', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-self-identify' });
  const res = await conclave(['--models', `${DS},${QW}`, '--mode', 'debate', '--rounds', '2', '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  assert.match(JSON.stringify(pkg.roundsData[0]), /deepseek/i, 'sanity: members did self-identify in round 1');
  assert.match(JSON.stringify(pkg.roundsData[0]), /alibaba/i);

  const debate = requestsBySchema(env, 'ConclaveDebate');
  const judge = requestsBySchema(env, 'ConclaveSynthesis');
  assert.equal(debate.length, 2);
  assert.equal(judge.length, 1);
  for (const r of [...debate, ...judge]) {
    const text = textOf(r.body).toLowerCase();
    for (const name of FORBIDDEN_NAMES) assert.ok(!text.includes(name), `"${name}" leaked into a ${r.body.format.schema.title} prompt`);
  }
  for (const r of debate) assert.ok(section(textOf(r.body), 'peer_answers').includes('[redacted]'));
  assert.ok(section(textOf(judge[0].body), 'member_answers').includes('[redacted]'));
  const handedToClaude = JSON.stringify(pkg.synthesisInput).toLowerCase();
  for (const name of FORBIDDEN_NAMES) assert.ok(!handedToClaude.includes(name), `"${name}" leaked into synthesisInput`);
  assert.equal(pkg.judge.status, 'completed');
});

// --- Quorum ------------------------------------------------------------------

test('quorum met: a StructuredOutputError member is discarded and listed; the rest synthesize', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-structured-error' });
  const res = await conclave(['--models', TRIO, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const qwen = labelOf(pkg, QW);
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.round, f.errorType]), [[qwen, 1, 'StructuredOutputError']]);
  assert.match(pkg.failures[0].rawText, /cannot format it/);
  assert.deepEqual(pkg.final.responses.map((r) => r.label).sort(), pkg.composition.filter((c) => c.label !== qwen).map((c) => c.label).sort());
  assert.ok(pkg.synthesisInput);
});

test('member timeout: the silent member is aborted, discarded and left out of the debate', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-timeout', config: FAST_TIMEOUT });
  const res = await conclave(['--models', TRIO, '--mode', 'debate', '--json', Q], { env, cwd, timeoutMs: 120_000 });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const kimi = labelOf(pkg, KM);
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.round, f.errorType]), [[kimi, 1, 'Timeout']]);
  const debate = requestsBySchema(env, 'ConclaveDebate');
  assert.equal(debate.length, 2);
  for (const r of debate) assert.ok(!textOf(r.body).includes(`<peer label="${kimi}">`));
  const kimiSession = sessionOfRequest(requestsBySchema(env, 'ConclaveMember').find((r) => r.body.model.modelID.includes('kimi')));
  assert.ok(readFakeState(env).requests.some((r) => r.method === 'POST' && r.path === `/session/${kimiSession}/abort`));
  assert.equal(pkg.rounds.completed, 2);
});

test('quorum not met: exit 7, group failed, partial answers kept and no judge', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-timeout', config: FAST_TIMEOUT });
  const res = await conclave(['--models', TRIO, '--quorum', '3', '--judge', `${DS}`, '--allow-judge-member', '--json', Q], { env, cwd, timeoutMs: 120_000 });
  assert.equal(res.code, 7, res.stderr);
  const pkg = res.json;
  assert.equal(pkg.status, 'failed');
  assert.deepEqual(pkg.failure, { code: 'QUORUM_NOT_MET', round: 1, valid: 2, quorum: 3 });
  assert.equal(pkg.final.responses.length, 2);
  assert.equal(pkg.judge.status, 'skipped');
  assert.equal(pkg.synthesisInput, null);
  assert.equal(requestsBySchema(env, 'ConclaveSynthesis').length, 0);
});

// --- Debate ------------------------------------------------------------------

test('debate: round 2 runs in each member own session and records changed per member', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-debate' });
  const res = await conclave(['--models', TRIO, '--mode', 'debate', '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  assert.deepEqual(pkg.rounds, { requested: 2, completed: 2 });
  const round1 = requestsBySchema(env, 'ConclaveMember');
  const round2 = requestsBySchema(env, 'ConclaveDebate');
  assert.equal(round2.length, 3);
  for (const r of round2) {
    const own = round1.find((m) => m.body.model.modelID === r.body.model.modelID);
    assert.equal(sessionOfRequest(r), sessionOfRequest(own));
  }
  const round2Answers = pkg.roundsData[1].responses;
  assert.ok(round2Answers.every((a) => typeof a.response.changed === 'boolean'));
  assert.equal(round2Answers.find((a) => a.label === labelOf(pkg, DS)).response.changed, true);
  assert.deepEqual(round2Answers.filter((a) => a.response.changed).length, 1);
  for (const a of round2Answers) assert.ok(a.response.critiques.every((c) => c.target !== a.label));
});

// --- Review mode -------------------------------------------------------------

test('review: overlapping findings dedupe into clusters with k/N agreement; findings without file stay alone; verdict', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-review' });
  writeReviewChanges(cwd);
  const res = await conclave(['--models', TRIO, '--mode', 'review', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const reviews = reviewRequests(env);
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every((r) => textOf(r.body).includes('src/calc.js')), 'the collected diff is in every review prompt');

  const { clusters, verdict, reasons, validMembers } = pkg.review;
  assert.equal(validMembers, 3);
  assert.equal(clusters.length, 6);
  assert.ok(clusters.every((c) => c.agreement.n === 3 && c.agreement.text === `${c.agreement.k}/3`));

  const merged = clusters.find((c) => c.agreement.k === 2);
  assert.equal(merged.file, 'src/calc.js');
  assert.deepEqual([merged.line_start, merged.line_end, merged.severity, merged.meanConfidence], [10, 14, 'critical', 0.8]);
  assert.deepEqual(merged.labels, [labelOf(pkg, DS), labelOf(pkg, QW)].sort());
  assert.equal(merged.bestLabel, labelOf(pkg, DS));
  assert.equal(clusters.filter((c) => c.agreement.k === 2).length, 1);

  const farCalc = clusters.filter((c) => c.file === 'src/calc.js' && c.agreement.k === 1);
  assert.deepEqual(farCalc.map((c) => [c.line_start, c.labels]), [[30, [labelOf(pkg, KM)]]]);
  assert.equal(clusters.filter((c) => c.file === 'src/list.js').length, 2);

  const noFile = clusters.filter((c) => c.file === null);
  assert.equal(noFile.length, 2, 'findings without file are never clustered');
  assert.ok(noFile.every((c) => c.agreement.text === '1/3'));

  assert.equal(verdict, 'needs-attention');
  assert.deepEqual(reasons.map((r) => r.code), ['SEVERE_FINDING_AGREED', 'MAJORITY_NEEDS_ATTENTION']);
});

test('review: members without findings approve and produce no clusters', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok' });
  writeReviewChanges(cwd);
  const res = await conclave(['--models', TRIO, '--mode', 'review', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.review.validMembers, 3);
  assert.equal(res.json.review.verdict, 'approve');
  assert.deepEqual(res.json.review.clusters, []);
});

test('review: outside a git repository the command fails with a usage error before any session', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok', git: false });
  const res = await conclave(['--models', TRIO, '--mode', 'review', '--json'], { env, cwd });
  assert.notEqual(res.code, 0);
  assert.equal(promptRequests(env).length, 0);
});

// --- Judge -------------------------------------------------------------------

test('judge model: read-only session sees only labels; synthesis validated against conclave-synthesis', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok' });
  const res = await conclave(['--models', `${DS},${QW}`, '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  assert.equal(pkg.judge.type, 'model');
  assert.equal(pkg.judge.model, KM);
  assert.equal(pkg.judge.status, 'completed');
  const schema = buildSynthesisSchema(loadConclaveAssets().schemas.synthesis, ['A', 'B']);
  assert.deepEqual(validateSchema(pkg.judge.synthesis, schema), []);
  const [judgeReq] = requestsBySchema(env, 'ConclaveSynthesis');
  assert.match(textOf(judgeReq.body), /<labels>A, B<\/labels>/);
  const judgeSession = readFakeState(env).requests.filter((r) => r.method === 'POST' && r.path === '/session').find((s) => s.body.title === 'OPC: conclave: judge');
  assert.deepEqual(judgeSession.body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('judge failure keeps the conclave completed with a warning for Claude', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const res = await conclave(['--models', `${DS},${QW}`, '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.judge.status, 'failed');
  assert.equal(res.json.judge.error.errorType, 'StructuredOutputError');
  assert.ok(res.json.warnings.some((w) => /opc-conclave/.test(w)));
});

test('--allow-judge-member: required when the judge is also a member', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok' });
  const refused = await conclave(['--models', `${DS},${QW}`, '--judge', DS, '--json', Q], { env, cwd });
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(`${refused.stdout}${refused.stderr}`, /--allow-judge-member/);
  const allowed = await conclave(['--models', `${DS},${QW}`, '--judge', DS, '--allow-judge-member', '--json', Q], { env, cwd });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.json.judge.model, DS);
  assert.equal(allowed.json.judge.status, 'completed');
});
```

- [ ] **Step 2: Rodar**

Run: `node --test tests/integration/conclave-acceptance.test.mjs`
Expected: PASS (14 testes). Tempo esperado: os dois testes de timeout levam alguns segundos cada (`memberTimeoutSec: 2`).

Se falhar:
- `Timeout` com outro nome em `errorType` → premissa P5 (ajuste a string esperada e a doc);
- `abort` sem registro no fake → premissa P6;
- `permission[0]` diferente → premissa P12;
- anonimização vazando um nome → corrija `buildKnownNames`/`anonymize` (Tarefa 4) e acrescente o caso ao teste unitário antes.

- [ ] **Step 3: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS, 0 falhas.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/conclave-acceptance.test.mjs
git commit -m "test(conclave): cover every F4c acceptance item against the fake server"
```

---

### Task 13: Slash command `/opc:conclave` e skill `opc-conclave`

O comando é invocável pelo modelo (spec §4: "Modelo invoca? sim"), passa os argumentos por
heredoc com delimitador entre aspas e, quando o juiz é o Claude, manda aplicar a skill. A
skill (texto original) ensina a sintetizar consenso, divergências, posição ponderada pela
confiança e pela evidência, confiança, recomendação e relatórios minoritários — e proíbe viés
de marca: a composição só é lida depois da síntese.

**Files:**
- Create: `plugins/opc/commands/conclave.md`
- Create: `plugins/opc/skills/opc-conclave/SKILL.md`
- Test: `tests/unit/conclave-plugin-files.test.mjs`

**Interfaces:**
- Consumes: subcomando `conclave` (Tarefa 11); `opc result <id> --json`.
- Produces: `/opc:conclave` e a skill `opc-conclave` (referenciada pelo render da Tarefa 9 e pelos avisos da Tarefa 7).

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/conclave-plugin-files.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/opc');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8');

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'file starts with YAML frontmatter');
  return Object.fromEntries(m[1].split('\n').filter((l) => /^[a-z-]+:/.test(l)).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
}

test('/opc:conclave is model-invocable and passes arguments through a quoted heredoc', () => {
  const text = read('commands', 'conclave.md');
  const fm = frontmatter(text);
  assert.ok(fm.description);
  assert.match(fm['argument-hint'], /--mode opinion\|review\|debate/);
  assert.match(fm['argument-hint'], /--allow-judge-member/);
  assert.match(fm['allowed-tools'], /Bash\(opc:\*\)/);
  assert.equal(fm['disable-model-invocation'], undefined);
  assert.match(text, /opc conclave --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\$ARGUMENTS\nOPC_ARGS/);
  assert.match(text, /opc-conclave/);
  assert.doesNotMatch(text, /opc conclave \$ARGUMENTS/);
});

test('opc-conclave skill covers the synthesis parts and forbids brand bias', () => {
  const text = read('skills', 'opc-conclave', 'SKILL.md');
  const fm = frontmatter(text);
  assert.equal(fm.name, 'opc-conclave');
  assert.ok(fm.description.length > 40);
  for (const heading of ['Consenso', 'Divergências', 'Posição ponderada', 'Recomendação', 'Relatórios minoritários', 'Composição']) {
    assert.ok(text.includes(heading), `skill mentions ${heading}`);
  }
  assert.match(text, /Nunca dê mais ou menos peso a uma resposta por causa do modelo, do vendor ou do provider/);
  assert.match(text, /confidence/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /Não corrija nada/);
  assert.doesNotMatch(text, /deepseek|qwen|kimi|gpt|gemini|anthropic|openai/i);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/conclave-plugin-files.test.mjs`
Expected: FAIL com `ENOENT` para `plugins/opc/commands/conclave.md`.

- [ ] **Step 3: Criar o slash command**

`plugins/opc/commands/conclave.md`:

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

- [ ] **Step 4: Criar a skill**

`plugins/opc/skills/opc-conclave/SKILL.md`:

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

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/conclave-plugin-files.test.mjs`
Expected: PASS (2 testes).

- [ ] **Step 6: Conferir que os testes de estrutura do plugin (fases anteriores) seguem verdes**

Run: `npm test`
Expected: PASS, 0 falhas (se a F0/F2b tiver teste que exige, por exemplo, `argument-hint` em todo comando ou lista de skills conhecidas, o novo arquivo já atende ou a lista precisa do nome `opc-conclave` — acrescente-o nesse caso).

- [ ] **Step 7: Commit**

```bash
git add plugins/opc/commands/conclave.md plugins/opc/skills/opc-conclave/SKILL.md tests/unit/conclave-plugin-files.test.mjs
git commit -m "feat(conclave): add /opc:conclave command and opc-conclave skill"
```

---

### Task 14: Documentação e CHANGELOG

Spec §12 (F4c: `conclave`, `commands`, `configuration`). O guia completo vai em
`docs/conclave.md`; os exemplos executados de verdade entram no portão (Tarefa 15), no lugar
dos marcadores `<!-- F4C-LIVE-OUTPUT: … -->`.

**Files:**
- Create: `docs/conclave.md`
- Modify: `docs/commands.md` (nova seção `## /opc:conclave`, depois da seção do `/opc:orchestrate` se existir; senão, ao fim)
- Modify: `docs/configuration.md` (nova seção `## conclave`, depois da seção `orchestrate` se existir; senão, ao fim)
- Modify: `CHANGELOG.md` (seção `## [Unreleased]`)

**Interfaces:**
- Consumes: comportamento das Tarefas 3–13.
- Produces: documentação da fase.

- [ ] **Step 1: Criar `docs/conclave.md`**

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

- [ ] **Step 2: Acrescentar a seção em `docs/commands.md`**

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

- [ ] **Step 3: Acrescentar a seção em `docs/configuration.md`**

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
````

- [ ] **Step 4: Atualizar o `CHANGELOG.md`**

Dentro de `## [Unreleased]` (crie a seção no topo, logo abaixo do título, se não existir),
acrescente — mesclando com um `### Added` já existente, sem duplicar o cabeçalho:

```markdown
### Added

- `/opc:conclave` e `opc conclave`: consulta paralela a N ≥ 2 modelos nos modos `opinion`,
  `debate` (2–3 rodadas anônimas na mesma sessão de cada membro) e `review` (review cruzado do
  diff com agrupamento de achados e concordância `k/N`).
- Composição com política por membro, rótulos aleatórios, quorum por rodada e descarte de
  membros com timeout, `StructuredOutputError` ou saída fora do schema.
- Anonimização de nomes de modelo, vendor e provider antes do debate e do juiz.
- Síntese por juiz modelo (schema `conclave-synthesis`, `--allow-judge-member`) ou pelo Claude
  com a nova skill `opc-conclave`.
- Schemas `conclave-member` e `conclave-synthesis`; prompts `conclave-member.md`,
  `conclave-debate.md` e `conclave-judge.md`.
- Documentação: `docs/conclave.md`, seção do conclave em `docs/commands.md` e
  `docs/configuration.md`.
```

- [ ] **Step 5: Conferir links, âncoras e segredos**

```bash
grep -n "conclave.md#exemplos-executados\|configuration.md#conclave" docs/*.md
grep -n "^## Exemplos executados" docs/conclave.md
grep -n "^## conclave" docs/configuration.md
node scripts/scan-secrets.mjs docs/
```

Expected: os três `grep` acham as linhas; o scanner sai com 0 e sem achados.

- [ ] **Step 6: Commit**

```bash
git add docs/conclave.md docs/commands.md docs/configuration.md CHANGELOG.md
git commit -m "docs: document conclave modes, synthesis and configuration"
```

---

### Task 15: Portão da F4c

Checklist comum do mestre, com os testes ao vivo da fase. Nada aqui é "sucesso parcial": o
que não pôde ser verificado vai como `NÃO VALIDADO` com motivo; o que não se aplica, `N/A`
com justificativa.

**Files:**
- Create: `tests/live/_f4c-lib.mjs`
- Create: `tests/live/f4c-opinion.mjs`
- Create: `tests/live/f4c-debate.mjs`
- Create: `tests/live/f4c-review.mjs`
- Create: `tests/live/f4c-judge.mjs`
- Modify: `docs/phases/F4c-report.md` (preenchido)
- Modify: `docs/conclave.md` (exemplos executados no lugar dos marcadores)

**Interfaces:**
- Consumes: tudo da fase; `makeTempDir`, `makeWorkspace`, `runCli`, `trackEnv`, `trackTempDir` (F0), `writeGlobalConfig` (F1) (`tests/helpers.mjs`); `opc models <provider> --allowed --json` (F1) para escolher o modelo extra.
- Produces: relatório da fase, PR.

- [ ] **Step 1: Conferir o relatório aberto na Tarefa 0**

```bash
grep -n "^## " docs/phases/F4c-report.md
```

Expected: as seções `1. Premissas` a `9. Pendências para a F5`, com a seção 1 já preenchida.

- [ ] **Step 2: Escrever os testes ao vivo**

`tests/live/_f4c-lib.mjs` (setup compartilhado: workspace descartável, `OPC_DATA_DIR`
temporário com a política de mundo do operador, escolha do modelo extra filtrada pela
política, repetição 3× com aprovação por ≥ 2):

```js
// Shared setup for the F4c live tests (not a test file). Only runs with OPC_LIVE=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir, makeWorkspace, runCli, trackEnv, trackTempDir, writeGlobalConfig } from '../helpers.mjs';
import { loadConclaveAssets, buildMemberSchema, buildDebateSchema, buildSynthesisSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';

export const LIVE = process.env.OPC_LIVE === '1';
export const SKIP = LIVE ? false : 'set OPC_LIVE=1 to run live tests';
export const PROVIDER = 'omniroute-personal';
export const PREFIX = `${PROVIDER}/opencode-go/`;
export const BASE_POOL = (process.env.OPC_LIVE_POOL ?? `${PREFIX}deepseek-v4.1-flash,${PREFIX}qwen3.8-max,${PREFIX}kimi-k3`)
  .split(',').map((s) => s.trim()).filter(Boolean);
export const EXTRA_PREFERENCE = [`${PREFIX}deepseek-v4-pro`];
export const LIVE_TIMEOUT_MS = 60 * 60 * 1000;
export const QUESTION = 'For a small Node.js CLI with zero runtime dependencies, should user configuration be stored as JSON or TOML? Consider parsing without dependencies, comments, and hand editing.';

// Mirrors the operator's world profile (spec §3.2): only the personal provider, no EQ models or agents.
export const WORLD_POLICY = {
  providers: { allow: [], deny: ['omniroute-work'] },
  models: { allow: [`${PREFIX}*`], deny: [] },
  agents: { allow: [], deny: ['work-*'] },
  tools: { deny: [] },
};

// F0 per-test cleanup stops env × cwd servers before removing cwd and dataDir (a t.after registered here would
// run after makeWorkspace's dir removal → ENOENT and a leaked server).
export function liveSetup(t, { git = true } = {}) {
  const cwd = makeWorkspace(t, { git, name: 'f4c-live' });
  const dataDir = trackTempDir(t, makeTempDir('opc-live-f4c-data-'));
  fs.chmodSync(dataDir, 0o700);
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir });
  delete env.OPC_SERVER_URL;
  delete env.CLAUDE_PLUGIN_DATA;
  writeGlobalConfig(env, { defaultProvider: PROVIDER, policy: WORLD_POLICY, conclave: { memberTimeoutSec: 600 } });
  return { env, cwd, dataDir };
}

export async function liveConclave(args, { env, cwd }) {
  const res = await runCli(['conclave', ...args], { env, cwd, timeoutMs: LIVE_TIMEOUT_MS });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { ...res, json };
}

export async function pickExtraModel({ env, cwd }, exclude = BASE_POOL) {
  const res = await runCli(['models', PROVIDER, '--allowed', '--json'], { env, cwd, timeoutMs: 300_000 });
  if (res.code !== 0) return null;
  const ids = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith(PREFIX) && !/\s/.test(value)) ids.add(value);
      else if (value.startsWith('opencode-go/') && !/\s/.test(value)) ids.add(`${PROVIDER}/${value}`);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(JSON.parse(res.stdout));
  const candidates = [...ids].filter((id) => !exclude.includes(id)).sort();
  return EXTRA_PREFERENCE.find((id) => candidates.includes(id)) ?? candidates[0] ?? null;
}

export async function attempts(n, fn) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    try {
      results.push({ run: i + 1, ok: true, detail: await fn(i) });
    } catch (err) {
      results.push({ run: i + 1, ok: false, detail: String(err?.message ?? err).slice(0, 2000) });
    }
  }
  return results;
}

export function schemas() {
  const assets = loadConclaveAssets();
  return {
    member: buildMemberSchema(assets.schemas.member),
    debate: (peerLabels) => buildDebateSchema(assets.schemas.member, peerLabels),
    synthesis: (labels) => buildSynthesisSchema(assets.schemas.synthesis, labels),
  };
}

export function familyWords(models) {
  const words = new Set([PROVIDER, 'omniroute', 'mvalmeida', 'opencode-go']);
  for (const full of models) {
    const last = full.split('/').at(-1).toLowerCase();
    const lead = last.match(/^[a-z]+/)?.[0];
    if (lead && lead.length >= 3) words.add(lead);
  }
  return [...words];
}
```

`tests/live/f4c-opinion.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, QUESTION, liveSetup, liveConclave, attempts, schemas } from './_f4c-lib.mjs';

test('F4c live: opinion with 3 models, every answer schema-valid (3 runs, >= 2 pass)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const { member } = schemas();
  const results = await attempts(3, async () => {
    const res = await liveConclave(['--models', BASE_POOL.join(','), '--json', QUESTION], ctx);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const pkg = res.json;
    assert.deepEqual(pkg.failures, []);
    assert.equal(pkg.final.responses.length, BASE_POOL.length);
    for (const r of pkg.final.responses) assert.deepEqual(validateSchema(r.response, member), [], `member ${r.label}`);
    return { jobId: pkg.jobId, durationMs: pkg.durationMs, confidences: pkg.final.responses.map((r) => [r.label, r.response.confidence]) };
  });
  t.diagnostic(`opinion: ${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});
```

`tests/live/f4c-debate.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, QUESTION, liveSetup, liveConclave, attempts, schemas, pickExtraModel } from './_f4c-lib.mjs';

test('F4c live: debate with 2 rounds, round-2 answers valid with changed recorded (3 runs, >= 2 pass)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const extra = await pickExtraModel(ctx);
  const members = extra ? [...BASE_POOL, extra] : BASE_POOL;
  t.diagnostic(`debate members: ${members.join(', ')} (extra: ${extra ?? 'none available'})`);
  const { debate } = schemas();
  const results = await attempts(3, async () => {
    const res = await liveConclave(['--models', members.join(','), '--mode', 'debate', '--rounds', '2', '--json', QUESTION], ctx);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const pkg = res.json;
    assert.deepEqual(pkg.rounds, { requested: 2, completed: 2 });
    const round1Labels = pkg.roundsData[0].responses.map((r) => r.label);
    const round2 = pkg.roundsData[1].responses;
    assert.ok(round2.length >= pkg.quorum);
    for (const r of round2) {
      const peers = round1Labels.filter((l) => l !== r.label);
      assert.deepEqual(validateSchema(r.response, debate(peers)), [], `round 2 member ${r.label}`);
      assert.equal(typeof r.response.changed, 'boolean');
    }
    return { jobId: pkg.jobId, changed: round2.map((r) => [r.label, r.response.changed]), failures: pkg.failures.map((f) => [f.label, f.round, f.errorType]) };
  });
  t.diagnostic(`debate: ${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});
```

`tests/live/f4c-review.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, liveSetup, liveConclave, attempts } from './_f4c-lib.mjs';

// Planted bugs: off-by-one read past the end, division by zero on empty input, eval of user input.
const BUGGY = `export function average(values) {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}

export function runUserFormula(formula) {
  return eval(formula);
}
`;

test('F4c live: cross review on a real diff with k/N agreement (3 runs, >= 2 with a cluster k >= 2)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  fs.mkdirSync(path.join(ctx.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ctx.cwd, 'src', 'stats.js'), BUGGY);
  const results = await attempts(3, async () => {
    const res = await liveConclave(['--models', BASE_POOL.join(','), '--mode', 'review', '--json', 'Focus on correctness and security.'], ctx);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const { review } = res.json;
    assert.ok(review.validMembers >= 2);
    for (const c of review.clusters) {
      assert.equal(c.agreement.n, review.validMembers);
      assert.equal(c.agreement.text, `${c.agreement.k}/${review.validMembers}`);
    }
    const agreed = review.clusters.filter((c) => c.agreement.k >= 2);
    assert.ok(agreed.length >= 1, `no cluster with k >= 2: ${JSON.stringify(review.clusters.map((c) => [c.title, c.agreement.text]))}`);
    return { jobId: res.json.jobId, verdict: review.verdict, clusters: review.clusters.map((c) => [c.severity, c.agreement.text, c.file, c.line_start, c.title]) };
  });
  t.diagnostic(`review: ${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});
```

`tests/live/f4c-judge.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, QUESTION, liveSetup, liveConclave, attempts, schemas, pickExtraModel, familyWords } from './_f4c-lib.mjs';

test('F4c live: judge by model returns a schema-valid synthesis (3 runs, >= 2 pass)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const extra = await pickExtraModel(ctx);
  const judgeArgs = extra ? ['--judge', extra] : ['--judge', BASE_POOL[1], '--allow-judge-member'];
  t.diagnostic(`judge: ${judgeArgs.join(' ')}`);
  const { synthesis } = schemas();
  const results = await attempts(3, async () => {
    const res = await liveConclave(['--models', BASE_POOL.join(','), ...judgeArgs, '--json', QUESTION], ctx);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const pkg = res.json;
    assert.equal(pkg.judge.type, 'model');
    assert.equal(pkg.judge.status, 'completed', JSON.stringify(pkg.judge.error ?? null));
    const labels = pkg.final.responses.map((r) => r.label);
    assert.deepEqual(validateSchema(pkg.judge.synthesis, synthesis(labels)), []);
    return { jobId: pkg.jobId, confidence: pkg.judge.synthesis.confidence, recommendation: pkg.judge.synthesis.recommendation.slice(0, 200) };
  });
  t.diagnostic(`judge-model: ${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});

test('F4c live: judge Claude receives an anonymized package ready for the opc-conclave skill', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const res = await liveConclave(['--models', BASE_POOL.join(','), '--judge', 'claude', '--json', QUESTION], ctx);
  assert.equal(res.code, 0, res.stderr.slice(-2000));
  const pkg = res.json;
  assert.deepEqual(pkg.judge, { type: 'claude', status: 'pending' });
  assert.ok(pkg.synthesisInput.responses.length >= pkg.quorum);
  const handed = JSON.stringify(pkg.synthesisInput).toLowerCase();
  for (const word of familyWords(BASE_POOL)) assert.ok(!handed.includes(word), `"${word}" leaked into synthesisInput`);
  t.diagnostic(`judge-claude jobId: ${pkg.jobId} (run: opc result ${pkg.jobId} and synthesize with the opc-conclave skill)`);
});
```

Confira que, sem `OPC_LIVE`, eles pulam:

Run: `node --test tests/live/f4c-opinion.mjs tests/live/f4c-debate.mjs tests/live/f4c-review.mjs tests/live/f4c-judge.mjs`
Expected: `# skipped 5`, `# fail 0`.

- [ ] **Step 3: `npm test` completo**

```bash
S=/tmp/opc-f4c-gate; mkdir -p "$S"
npm test 2>&1 | tee "$S/npm-test.txt"
```

Expected: `# fail 0`. Cole a saída na seção 2 do relatório.

- [ ] **Step 4: Testes ao vivo**

```bash
OPC_LIVE=1 node --test --test-reporter=spec tests/live/f4c-opinion.mjs tests/live/f4c-debate.mjs tests/live/f4c-review.mjs tests/live/f4c-judge.mjs 2>&1 | sed "s#$HOME#~#g" | tee "$S/f4c-live.txt"
```

Expected: 5 testes `✔` (cada um com ≥ 2 de 3 execuções válidas onde se aplica). Preencha a
seção 4 do relatório com as linhas de diagnóstico (`opinion:`, `debate:`, `review:`,
`judge-model:`, `judge-claude jobId:`, modelo extra). Se nenhum modelo extra estiver disponível
na política, o debate roda com 3 membros e o item "Modelo extra" vai como `NÃO VALIDADO`.

- [ ] **Step 5: Juiz Claude ao vivo (síntese feita por você)**

Rode um conclave real com juiz Claude num workspace descartável e sintetize a saída com a
skill `opc-conclave`:

```bash
R=$(pwd); C="node $R/plugins/opc/scripts/opc-companion.mjs"
W=$(mktemp -d /tmp/opc-f4c-ws-XXXX) && D=$(mktemp -d /tmp/opc-f4c-data-XXXX) && chmod 700 "$D"
git -C "$W" init -q && git -C "$W" -c user.email=live@example.invalid -c user.name="opc live" commit --allow-empty -qm init
printf '{"defaultProvider":"omniroute-personal","policy":{"providers":{"allow":[],"deny":["omniroute-work"]},"models":{"allow":["omniroute-personal/opencode-go/*"],"deny":[]},"agents":{"allow":[],"deny":["work-*"]},"tools":{"deny":[]}}}\n' > "$D/config.json" && chmod 600 "$D/config.json"
( cd "$W" && OPC_DATA_DIR="$D" $C conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max,omniroute-personal/opencode-go/kimi-k3 --judge claude "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?" ) 2>&1 | sed "s#$HOME#~#g" | tee "$S/judge-claude.md"
```

Leia `$S/judge-claude.md`, aplique a skill `opc-conclave` (composição só no fim) e cole na
seção 5 do relatório: o id do job, a síntese e a conferência de que nenhuma marca entrou no
raciocínio. Depois encerre o servidor:

```bash
( cd "$W" && OPC_DATA_DIR="$D" $C setup --stop-server --force --confirmed-by-user )
```

(`W` e `D` são temporários criados por este passo; deixe-os para o sistema limpar ou peça ao
operador para removê-los — remoção é comando destrutivo pelas regras dele.)

- [ ] **Step 6: Contrato**

```bash
OPC_LIVE=1 node tests/live/contract.mjs 2>&1 | sed "s#$HOME#~#g" | tee "$S/contract.txt"
```

Expected: sem divergência, ou divergência registrada na seção 6 com o fake atualizado.

- [ ] **Step 7: Exemplos executados na documentação**

No mesmo workspace descartável do Passo 5 (mesmas variáveis `R`, `C`, `W`, `D` e `S`), rode os três
exemplos de `docs/conclave.md` e substitua cada marcador pela saída real (entre cercas de
código, com `sed "s#$HOME#~#g"`):

```bash
P=omniroute-personal/opencode-go
Q="Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
( cd "$W" && OPC_DATA_DIR="$D" $C conclave --models $P/deepseek-v4.1-flash,$P/qwen3.8-max,$P/kimi-k3 "$Q" ) 2>&1 | sed "s#$HOME#~#g" > "$S/ex-opinion.md"
( cd "$W" && OPC_DATA_DIR="$D" $C conclave --models $P/deepseek-v4.1-flash,$P/qwen3.8-max --mode debate --rounds 2 --judge $P/kimi-k3 "$Q" ) 2>&1 | sed "s#$HOME#~#g" > "$S/ex-debate.md"
mkdir -p "$W/src" && printf 'export function average(values) {\n  let total = 0;\n  for (let i = 0; i <= values.length; i++) total += values[i];\n  return total / values.length;\n}\n\nexport function runUserFormula(formula) {\n  return eval(formula);\n}\n' > "$W/src/stats.js"
( cd "$W" && OPC_DATA_DIR="$D" $C conclave --models $P/deepseek-v4.1-flash,$P/qwen3.8-max,$P/kimi-k3 --mode review "Foque em correção e segurança" ) 2>&1 | sed "s#$HOME#~#g" > "$S/ex-review.md"
( cd "$W" && OPC_DATA_DIR="$D" $C setup --stop-server --force --confirmed-by-user )
```

Cole `ex-opinion.md`, `ex-debate.md` e `ex-review.md` no lugar de
`<!-- F4C-LIVE-OUTPUT: opinion -->`, `debate` e `review`, respectivamente. Rode também os dois
exemplos de `opc config set` da seção `conclave` de `docs/configuration.md` contra `OPC_DATA_DIR="$D"`
e confirme que saem com 0. Depois:

```bash
grep -c "F4C-LIVE-OUTPUT" docs/conclave.md
node scripts/scan-secrets.mjs docs/
```

Expected: `0` marcadores; scanner sem achados. Preencha a seção 7 do relatório.

- [ ] **Step 8: Fechar o relatório**

Preencha as seções 3 (aceite de integração, com os nomes dos testes e `PASSOU`), 8 (desvios:
inclua os ajustes de premissa da Tarefa 0 e qualquer mudança de string esperada) e 9
(pendências para a F5, como a ferramenta MCP `opc_conclave`). Cada linha com `PASSOU`, `N/A`
(com justificativa) ou `NÃO VALIDADO` (com motivo). Confira o `CHANGELOG.md` (Tarefa 14).

- [ ] **Step 9: Commit dos testes ao vivo, docs e relatório**

```bash
git add tests/live/_f4c-lib.mjs tests/live/f4c-opinion.mjs tests/live/f4c-debate.mjs tests/live/f4c-review.mjs tests/live/f4c-judge.mjs docs/phases/F4c-report.md docs/conclave.md
git commit -m "test(conclave): add F4c live tests and phase report"
```

Releia a mensagem: sem `Co-Authored-By`, `Signed-off-by` ou "Generated with".

- [ ] **Step 10: Aviso ao operador, push e PR (com autorização)**

Resuma ao operador: testes (contagens), ao vivo (execuções válidas por item), desvios e
pendências. Só com autorização explícita:

```bash
git push -u origin feat/opc-f4c
gh pr create --base main --head feat/opc-f4c --title "feat: F4c conclave" --body-file docs/phases/F4c-report.md
```

Sem trailer de atribuição no corpo do PR. Merge só depois de avisar o operador.

- [ ] **Step 11: Gravação dupla**

Conforme o kernel do operador (§3.3), grave os fatos relevantes da fase:

1. `.ai-data/decisions-<DDMMYY>.md` no repo (não versionado) — por exemplo: decisões A1–A21
   que mudaram algo na prática, premissas que divergiram e como foram ajustadas, resultado ao
   vivo por item;
2. colmeia, banco `myprojects`, via `mnemosyne_remember`: 1 fato por registro, prefixado
   `[DD/MM/AAAA]`, sem segredos;
3. avise o operador com a contagem por banco (ou diga explicitamente que nada foi gravado).
