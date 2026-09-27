# opc F2a — Núcleo de execução · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o núcleo de execução do `opc` — resolução de modelo, turno completo contra o OpenCode (prompt_async + SSE), classificação de erros, perfis de permissão com invariantes, ponte de permissões/perguntas com aprovador, jobs em worker destacado (limites, cancel com identidade, resume e concorrência por sessão) e os comandos `task`, `ask`, `plan`, `status`, `result`, `cancel`, `permissions`, `gc`, `task-worker` e `task-resume-candidate`.

**Architecture:** O comando em primeiro plano resolve modelo/agente/variant e o perfil de permissão, cria o registro do job e dispara um worker destacado (`opc task-worker --job-id <id>`); o worker sobe/reaproveita o servidor, conecta o `EventHub`, roda `runTurn` e grava o resultado no job. O primeiro plano só acompanha o arquivo do job e o log (exit 3 quando surge pedido de permissão, 6 quando o prazo de espera estoura). Pedidos de permissão e perguntas do OpenCode (sessão e filhas) passam por uma ponte no worker: rejeição imediata no perfil read-only; nos demais, `waiting_permission` até a resposta via `/opc:permissions` ou até o prazo.

**Tech Stack:** Node.js ≥ 20 (ESM `.mjs`, `fetch` nativo, `node:test`), zero dependências, OpenCode 1.18.32 (API v1).

**Spec:** `docs/superpowers/specs/2026-09-25-opc-plugin-design.md` (rev. 3) — §4, §4.1, §6, §7, §7.1, §8, §9.1, §9.2, §10.1, §13.3 (F2a), §15 itens 3 e 6. **Plano mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` (estrutura, contrato de interfaces, convenções de teste, regras de git e portão). Quem executa lê os três.

---

## Global Constraints

Copiadas do mestre; valem para toda tarefa desta fase.

- Node ≥ 20 (`engines: {"node": ">=20"}`); CI em Node 20 e 22.
- Zero dependências de runtime e de desenvolvimento (nada de `npm install`).
- Código, identificadores, mensagens de commit e nomes de arquivo em inglês; docs e textos voltados ao usuário em PT-BR.
- OpenCode mínimo `1.18.0`, alvo `1.18.32`; só a API v1 (`/session/*`, `/event`, `/permission`, `/question`), nunca `/api/*`.
- A senha do servidor e as chaves de provider nunca aparecem em stdout, stderr, logs, docs ou fixtures commitadas (todo `ctx.out`/`ctx.json`/log passa por redação).
- O plugin nunca escreve em `~/.config/opencode/` nem no `auth.json` do OpenCode.
- Nenhum sinal para um processo cuja identidade (cmdline + start time) não confira.
- Diretórios de estado com modo 700 e arquivos com modo 600.
- `always` nunca é enviado em `permission reply`.
- Exit codes conforme a spec §4.1: `0, 2, 3, 4, 5, 6, 7, 130`.
- Namespace `/opc:`; executável `opc`; título das sessões com o prefixo `OPC: `.
- Testes ao vivo só com `OPC_LIVE=1`, nunca no CI, sempre em diretório descartável; modelo desta fase: `omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash`.
- Arquivos derivados do codex-plugin-cc levam no cabeçalho `Adapted from openai/codex-plugin-cc (Apache-2.0); modified.`
- Git: branch `feat/opc-f2a`; Conventional Commits; **sem trailer de atribuição** (`Co-Authored-By`, `Signed-off-by`, "Generated with"); commit/push/PR só com autorização explícita do operador na sessão de execução (regra 1 do mestre). Reler cada mensagem antes de `git commit`.

## Review Focus

Entradas e condições que a spec implica e que mais provavelmente quebram o uso real nesta fase. Cada linha tem teste na tarefa dona.

1. **Prompt com aspas, apóstrofos (`don't`), crases, `$()`, `${}`, quebras de linha e unicode** chega byte a byte ao OpenCode e nada é executado. Texto livre nunca passa pela divisão tipo shell do `splitArgString` (F0): `task/ask/plan` usam `--raw-args-stdin` + `readRawArgs`/`parsePromptArgs` (convenção D4). [Tarefa 4 `args-prompt.test.mjs`; Tarefa 10 `f2a-prompt-roundtrip.test.mjs` (executa o bloco bash real de `commands/task.md`)]
2. **Resposta do modelo com mais de 1 MB**: o resultado é guardado e impresso inteiro; o log do job fica ≤ 5 MB, descartando o início. [Tarefa 7 `jobs.test.mjs` (cap do log); Tarefa 10 `f2a-task.test.mjs` (`large-output`)]
3. **Worker que morre ou pid reciclado**: o job não fica "ativo" para sempre (bloquearia `jobs.maxActive`) e nenhum sinal atinge processo alheio. [Tarefa 7 `jobs.test.mjs` (`worker_lost`, `identity-mismatch`); Tarefa 11 `f2a-jobs.test.mjs` (`stale-worker-pid`)]
4. **Servidor morto no meio do turno** (SSE cai e as requisições recusam): o job termina `failed/server_lost` com a sessão preservada, sem pendurar nem reexecutar. [Tarefa 5 `runner.test.mjs`; Tarefa 11 `f2a-jobs.test.mjs` (`server-dies-mid-turn`)]
5. **Pedido de permissão sem ninguém para responder** (background, usuário ausente): reject automático no prazo com "opc: no approver available", e o worker não fica vivo indefinidamente. [Tarefa 10 `worker-bridge.test.mjs`; Tarefa 13 `f2a-permissions.test.mjs`]

---

## Pré-requisitos consumidos de F0 e F1

Esta fase assume que F0 e F1 entregaram **exatamente** o contrato do mestre. Pontos usados (assinaturas do mestre):

- `opc-error.mjs`: `ExitCode`, `OpcError`, `UsageError`, `PolicyError`, `ConnectionError`, `NotFoundError`, `RequestError`. **Convenção de construção assumida:** todas as classes recebem `(code, message, opts)`, como `OpcError`, com o `exitCode` padrão da classe (ex.: `new UsageError('TOO_MANY_JOBS', 'msg', { details })`) — é a leitura coerente com `UsageError('AMBIGUOUS_MODEL')` no mestre.
- `redact.mjs` (`redact`, `redactText`), `args.mjs` (`parseArgs`, `readStdin`, `resolveArgv` no dispatcher), `process.mjs`, `locks.mjs` (`tryAcquireLock`), `state.mjs` (`readJson`, `writeFileAtomic`, `ensurePrivateDir`, `updateState`, `resolveWorkspaceRoot`, `workspaceStateDir`, **`ACTIVE_JOB_STATUSES`** — fonte única dos estados ativos, que `jobs.ACTIVE_STATUSES` reexporta —, e `listActiveJobs(stateDir)`, que o setup da F0 usa sobre o índice `state.json.jobs`; a F2a mantém esse índice atualizado em `createJob`/`updateJob`), `http.mjs` (`createClient`), `sse.mjs` (`EventHub`), `server.mjs` (`ensureServer`, `clientFor`, `readServerRecord`, `serverMatcher`), `context.mjs` (`ctx.out/err/json`, `ctx.claudeSessionId`, `ctx.config`, `ctx.stateDir`, `ctx.dataDir`, `ctx.workspaceRoot`, `ctx.cwd`, `ctx.stdin`, `ctx.stderr`), `render.mjs` (`renderTable`, `renderError`).
- F1: `api.mjs` (leitura: `providers`, `getConfig`, `agents`, `getSession`, `sessionStatus`, `messages(id, {limit})`, `children`, `diff`, `listPermissions`, `listQuestions`), `context.mjs` (`connectApi(ctx)` → `{ api, server, client }`; a Tarefa 7 troca o literal `serverCtx` dele por `serverContext(ctx)`), `models.mjs` (`buildCatalog`, `normalizeModelId`, `matchesAny`, `validateVariant(entry, variant)` → `UsageError('UNKNOWN_VARIANT')`), `policy.mjs` (`evaluate`, `assertAgentUsable(agentInfo, policy)` — nome do agente + provider e modelo fixados), `config.mjs` (`loadConfig` com o merge restritivo), `tty.mjs` (`createPrompter` → `confirm`, `close`).
- `ctx.out(text)` e `ctx.err(text)` escrevem o texto como recebido (o plano sempre passa texto terminado em `\n`).
- O dispatcher (`opc-companion.mjs`) resolve `scripts/commands/<sub>.mjs` dinamicamente; subcomandos novos não exigem mudança nele.
- Helpers de teste da F0: `REPO_ROOT`, `PLUGIN_ROOT`, `COMPANION`, `makeTempDir`, `makeWorkspace`, `testEnv`, `runCli`, `readFakeState`, `stopAllServers`; fake com `startFake(...)` e cenário `{ setup?, onPromptAsync?, routes? }`; cenário `auth-401` da F0.
- Fixture de `/provider` da F1 com o provider conectado `omniroute-mvalmeida` e o modelo `opencode-go/deepseek-v4.1-flash` com a variant `high` (a Tarefa 9 tem o teste de pré-condição e o trecho de fixture a acrescentar se faltar).

Se algum desses nomes divergir no código real, ajuste só a cola (imports/uma linha) e registre no relatório da fase; mudança de interface congelada exige atualizar o mestre e avisar o operador.

## Decisões desta fase (ambiguidades resolvidas)

| # | Tema | Decisão | Evidência |
|---|---|---|---|
| D1 | `PATCH /session/:id {permission}` (§15 item 3) | **Anexa** (não substitui). `PATCH_PERMISSION_MODE = 'append'`. No resume, trocar para um perfil que começa com `* * deny` (read-only, custom) é seguro via PATCH; trocar para `write` é recusado antes do PATCH (exit 2, `PROFILE_SWITCH_UNSUPPORTED`). O probe ao vivo confirma e, se divergir, a constante muda no ajuste pós-portão | binário 1.18.32: `setPermission({permission: merge(e.permission, payload.permission)})` com `merge(...j) = j.flat()` |
| D2 | Formato do `messageID` (§15 item 6) | `newMessageId()` replica `Identifier.ascending`: `msg_` + 12 hex (48 bits de `ms*4096+contador`) + 14 base62. Probe ao vivo confirma | binário 1.18.32, módulo `Identifier` |
| D3 | Ferramenta `StructuredOutput` | Não conta como "ferramenta executada" (senão todo `StructuredOutputError` viraria `fatal`); vira fase `finalizing` | binário: `le.StructuredOutput = createStructuredOutputTool(...)`; sondagem §1.4 (`parts: step-start,reasoning,tool,step-finish`) |
| D4 | Convenção única de passagem de argumentos | **Texto livre ⇒ `--raw-args-stdin`** + heredoc `<<'OPC_ARGS_5f1d0c7a_EOF'`, lido por `readRawArgs` (Tarefa 4) sobre `parsePromptArgs`: flags conhecidas só como palavras inteiras, texto verbatim, `--` isolado encerra as flags (agentes escrevem as flags na linha de comando e começam o heredoc com `--`). Aqui: `task`/`ask`/`plan`; nas fases seguintes, `review`/`adversarial-review`, `subagent`, `command`, `orchestrate`, `conclave` e os agentes `opc-rescue`/`opc-worker` usam o mesmo helper. **Só flags/ids ⇒ `--args-stdin`** (divisão tipo shell da F0): `status`, `result`, `cancel` e também `permissions` — exceção justificada pela fronteira por pergunta de `permissions answer` (um argumento por pergunta, aspas para respostas com espaço); apóstrofos em prosa (`don't`) já não quebram ali porque o `splitArgString` da F0 trata `'` entre letras/dígitos como literal | Texto livre não pode depender de aspas balanceadas nem virar flag; `permissions answer` precisa da divisão por argumento (spec §8.3) |
| D5 | Sessões filhas | O OpenCode só herda do pai as regras `deny` e `external_directory`; o runner aplica o perfil do job à filha (`PATCH`) no `session.created` (defesa em profundidade; janela curta documentada) | binário: `lt({parentSessionPermission})` filtra `external_directory` e `action==="deny"` |
| D6 | `pendingRequest` | É uma **lista** (pode haver irmãos e perguntas ao mesmo tempo); `null` quando vazia | spec §8.2 fala em "remover esses pedidos do `pendingRequest`" |
| D7 | Aprovador `user` | O companion também exige `--confirmed-by-user` para `reply once` (não só a skill); `reject` é sempre livre; `always` → exit 2; recusa do aprovador → exit 4 | spec §8.3 + defesa em profundidade |
| D8 | Perfil `custom` | É ponteado como `write` (não rejeita na hora) e, se liberar `bash`, recebe também a lista destrutiva como `ask` | spec §8.1 ("destrutivos sempre com o usuário") |
| D9 | Detecção de queda do servidor | O worker usa `createClient` **sem** `onServerDown` e o runner faz polling de `/session/status` (5 s; `OPC_STATUS_POLL_MS` só para teste) — `SERVER_DOWN` vira `server_lost`, sem subir outro servidor no meio do turno | spec §5.4 |
| D10 | `OPC_INSIDE_SERVER=1` | Recusa com exit 4 (`PolicyError('INSIDE_SERVER')`) antes de qualquer contato com servidor, via `assertNotInsideServer(env)` (Tarefa 7), que todo comando que cria job chama — aqui `task`/`ask`/`plan`; nas fases seguintes `review`, `adversarial-review`, `subagent`, `command`, `orchestrate`, `conclave` | spec §9.1 |
| D11 | Prazos | `--timeout` (turno) padrão 1800 s; `--wait-timeout` (espera em primeiro plano) padrão 540 s, abaixo do teto de 600 s da ferramenta Bash do Claude | spec §4, §7.1 |
| D12 | Exit dos comandos de leitura | `status` sem `--wait` sai 0; `status --wait` e `result` saem conforme o estado do job (0/3/7/130; 6 no prazo) | spec §4.1 |
| D13 | `--resume [id]` | O valor só é consumido quando parece id de job (`task-…`) ou de sessão (`ses…`); senão vira `--resume-last` | spec §4 ("`--resume [id]`") |
| D14 | `status --all` | Todas as sessões do Claude e sem o limite de 8 | spec §4 |
| D15 | `gc` sem TTY e sem flag | Lista e sai com 2, sem remover | spec §3.2 |
| D16 | Respostas de perguntas | Um argumento por pergunta, na ordem; `|` separa rótulos em `multiple`; texto livre aceito salvo `custom === false` | OpenAPI `QuestionInfo` (custom opcional) |
| D17 | Worker perdido | Job ativo com pid cuja identidade não confere, ou `queued` sem pid há mais de 60 s → `failed/worker_lost` (reconciliação em `createJob`, `status`, `result`, `waitForJob`) | spec §9.1 (limites) |
| D18 | Cancel e permissões sem servidor | `existingServerApi(ctx)` usa o `server.json` (ou `OPC_SERVER_URL`) e **nunca sobe** servidor | spec §9.1 |
| D19 | Registro do job sob `server.lock` (corrida com o reaper, §9.3) | Fica para a F2b, dona do reaper; a F2a registra o job logo após `ensureServer` | mestre, F2b |
| D20 | Log do worker | stdout/stderr do worker vão para `jobs/<id>.worker.log` (separado do log do job, que é truncado por rename) | spec §3.2 |


## Estrutura de arquivos da fase

```
plugins/opc/scripts/lib/
  errors.mjs            (novo)     classificação da união de erros do OpenCode (§7.1)
  routing.mjs           (novo)     resolução de candidatos níveis 1–7, validação de variant/agente (§6)
  runner.mjs            (novo)     um turno: sessão, SSE, fases, ponte, fim, extração (§7)
  jobs.mjs              (novo)     registros, limites, poda, worker, espera, cancel, locks (§9.1–9.2)
  policy.mjs            (anexar)   perfis, invariantes, destrutivos, aprovador, troca de perfil (§8)
  args.mjs              (anexar)   parsePromptArgs (prompt verbatim)
  api.mjs               (anexar)   operações de escrita (sessionWriteMethods)
  render.mjs            (anexar)   status, lista, resultado, pedido de permissão, cancel
plugins/opc/scripts/commands/
  task.mjs ask.mjs plan.mjs task-worker.mjs status.mjs result.mjs cancel.mjs
  permissions.mjs gc.mjs task-resume-candidate.mjs          (novos)
plugins/opc/prompts/ask.md plan.md continue.md               (novos)
plugins/opc/commands/task.md ask.md plan.md status.md result.md cancel.md permissions.md (novos)
plugins/opc/skills/opc-result-handling/SKILL.md              (novo; a F2b amplia)
tests/fixtures/fake-session-api.mjs                          (novo)
tests/fixtures/fake-opencode.mjs                             (bloco F2a no fim: registerFakeExtension)
tests/fixtures/scenarios/{structured,structured-error,slow,permission-ask,child-permission-ask,
  question-ask,reject-siblings,server-dies-mid-turn,retry-status,session-error-event,large-output}.mjs
tests/fixtures/expected-rules-f2a.mjs                        (novo)
tests/helpers.mjs                                            (anexar helpers F2a)
tests/unit/{errors,policy-profiles,routing,args-prompt,runner,api-write,jobs,render-jobs,
  task-helpers,worker-bridge,permissions-answers,gc}.test.mjs
tests/integration/f2a-{fixtures,task,prompt-roundtrip,profiles,jobs,resume,permissions,
  exit-codes,gc,commands-md}.test.mjs
tests/live/_f2a-helpers.mjs  tests/live/f2a-{ask-plan,write,readonly,destructive,jobs,probes}.mjs
docs/commands.md (anexar) docs/permissions.md (novo) docs/phases/F2a-report.md (novo) CHANGELOG.md
```

---

### Task 1: `lib/errors.mjs` — classificação de erros

**Files:**
- Create: `plugins/opc/scripts/lib/errors.mjs`
- Test: `tests/unit/errors.test.mjs`

**Interfaces:**
- Consumes: `redactText(text)` de `lib/redact.mjs`.
- Produces: `classifyError(error, { toolsRan = false, candidateHasLargerContext = false } = {})` → `{ errorClass: 'recoverable'|'fatal', errorType, message }`; `retryExceedsCap(status, fallbackCfg = {}, now = Date.now())` → `boolean` (`status.next` é epoch ms, como no binário: `next = now + delay`).

- [ ] **Step 1: Criar a branch da fase**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/opc-f2a
```

(Se o operador ainda não autorizou operações git nesta sessão, perguntar antes — regra 1 do mestre.)

- [ ] **Step 2: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, retryExceedsCap } from '../../plugins/opc/scripts/lib/errors.mjs';

const cases = [
  [{ name: 'APIError', data: { message: '429', isRetryable: true, statusCode: 429 } }, {}, 'recoverable'],
  [{ name: 'APIError', data: { message: 'no model', isRetryable: false, statusCode: 404 } }, {}, 'recoverable'],
  [{ name: 'APIError', data: { message: 'bad', isRetryable: false, statusCode: 400 } }, {}, 'fatal'],
  [{ name: 'RetryCapExceeded', data: { message: 'cap' } }, {}, 'recoverable'],
  [{ name: 'Timeout', data: { message: 't' } }, {}, 'recoverable'],
  [{ name: 'StructuredOutputError', data: { message: 's', retries: 1 } }, { toolsRan: false }, 'recoverable'],
  [{ name: 'StructuredOutputError', data: { message: 's', retries: 1 } }, { toolsRan: true }, 'fatal'],
  [{ name: 'ContextOverflowError', data: { message: 'c' } }, {}, 'fatal'],
  [{ name: 'ContextOverflowError', data: { message: 'c' } }, { candidateHasLargerContext: true }, 'recoverable'],
  [{ name: 'ProviderAuthError', data: { providerID: 'p', message: 'k' } }, {}, 'fatal'],
  [{ name: 'MessageAbortedError', data: { message: 'a' } }, {}, 'fatal'],
  [{ name: 'ContentFilterError', data: { message: 'f' } }, {}, 'fatal'],
  [{ name: 'MessageOutputLengthError', data: {} }, {}, 'fatal'],
  [{ name: 'UnknownError', data: { message: 'u' } }, {}, 'fatal'],
  [{ name: 'BadRequest', data: { message: 'b' } }, {}, 'fatal'],
  [{ name: 'ServerLost', data: { message: 'l' } }, {}, 'fatal'],
  [{ name: 'Cancelled', data: { message: 'x' } }, {}, 'fatal'],
];

for (const [error, opts, expected] of cases) {
  test(`classifyError ${error.name} ${JSON.stringify(opts)} → ${expected}`, () => {
    const r = classifyError(error, opts);
    assert.equal(r.errorClass, expected);
    assert.equal(r.errorType, error.name);
    assert.equal(typeof r.message, 'string');
  });
}

test('classifyError tolerates missing name and huge messages', () => {
  assert.equal(classifyError({}).errorType, 'UnknownError');
  assert.equal(classifyError(null).errorClass, 'fatal');
  const r = classifyError({ name: 'UnknownError', data: { message: 'x'.repeat(5000) } });
  assert.ok(r.message.length <= 2001);
});

test('retryExceedsCap: attempt above max or wait above max', () => {
  const cfg = { maxProviderRetries: 3, maxRetryWaitSec: 60 };
  const now = 1_000_000;
  assert.equal(retryExceedsCap({ attempt: 3, next: now + 1000 }, cfg, now), false);
  assert.equal(retryExceedsCap({ attempt: 4, next: now + 1000 }, cfg, now), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: now + 61_000 }, cfg, now), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: now + 60_000 }, cfg, now), false);
  assert.equal(retryExceedsCap({ attempt: 1 }, {}, now), false);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/errors.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`plugins/opc/scripts/lib/errors.mjs`).

- [ ] **Step 4: Implementar**

```js
// Classification of OpenCode errors (spec §7.1).
import { redactText } from './redact.mjs';

const MAX_MESSAGE_CHARS = 2000;

function messageOf(error) {
  let raw;
  if (typeof error === 'string') raw = error;
  else raw = error?.data?.message ?? error?.message ?? JSON.stringify(error ?? null);
  const text = redactText(String(raw));
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

export function classifyError(error, { toolsRan = false, candidateHasLargerContext = false } = {}) {
  const errorType = typeof error?.name === 'string' && error.name ? error.name : 'UnknownError';
  const message = messageOf(error);
  const as = (errorClass) => ({ errorClass, errorType, message });
  switch (errorType) {
    case 'APIError': {
      const data = error.data ?? {};
      return as(data.isRetryable === true || data.statusCode === 404 ? 'recoverable' : 'fatal');
    }
    case 'RetryCapExceeded':
    case 'Timeout':
      return as('recoverable');
    case 'StructuredOutputError':
      return as(toolsRan ? 'fatal' : 'recoverable');
    case 'ContextOverflowError':
      return as(candidateHasLargerContext ? 'recoverable' : 'fatal');
    default:
      // ProviderAuthError, MessageAbortedError, ContentFilterError, MessageOutputLengthError,
      // UnknownError, BadRequest, ServerLost, Cancelled and anything unknown.
      return as('fatal');
  }
}

export function retryExceedsCap(status, fallbackCfg = {}, now = Date.now()) {
  const maxRetries = fallbackCfg.maxProviderRetries ?? 3;
  const maxWaitSec = fallbackCfg.maxRetryWaitSec ?? 60;
  if (typeof status?.attempt === 'number' && status.attempt > maxRetries) return true;
  if (typeof status?.next === 'number' && (status.next - now) / 1000 > maxWaitSec) return true;
  return false;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/errors.test.mjs`
Expected: PASS (19 testes).

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/errors.mjs tests/unit/errors.test.mjs
git commit -m "feat(errors): classify the OpenCode error union"
```

---

### Task 2: `lib/policy.mjs` — perfis, invariantes, destrutivos, aprovador

**Files:**
- Modify: `plugins/opc/scripts/lib/policy.mjs` (anexar ao fim; manter `evaluate`/`assertAllowed` da F1)
- Test: `tests/unit/policy-profiles.test.mjs`

**Interfaces:**
- Consumes: `matchesAny(value, globs)` de `lib/models.mjs`; `UsageError` de `lib/opc-error.mjs`.
- Produces (contrato do mestre): `BUILTIN_DESTRUCTIVE_BASH`, `buildPermissionRules(profile, { policy, permissionProfiles, deniedAgentGlobs })`, `requiresUser(request, policy)`, `checkReply({ approver, request, reply, confirmedByUser, policy })` → `{ ok: true } | { ok: false, code: 'INVALID_REPLY'|'NEEDS_USER', reason }`.
- Produces (novos): `READ_ONLY_ALLOW`, `SENSITIVE_PATH_PERMISSIONS`, `DEFAULT_SENSITIVE_PATHS`, `PATCH_PERMISSION_MODE`, `sensitivePathsOf(policy)`, `destructiveBashOf(policy)`, `parseProfile(profile)` → `{ kind: 'read-only'|'write'|'custom', name }`, `invariantRules(profile, { policy, deniedAgentGlobs, bridged })`, `bridgeModeOf(profile)` → `'auto-reject'|'bridge'`, `planPermissionSwitch(current, desired, mode = PATCH_PERMISSION_MODE)` → `'none'|'patch'` (ou `UsageError('PROFILE_SWITCH_UNSUPPORTED')`), `endsWithRules(current, desired)`.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_DESTRUCTIVE_BASH, buildPermissionRules, checkReply, invariantRules, planPermissionSwitch, requiresUser, bridgeModeOf,
} from '../../plugins/opc/scripts/lib/policy.mjs';
import { UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const policy = {
  sensitivePaths: ['*.env', '**/.ssh/**'],
  tools: { deny: ['gitlab_*'] },
  destructiveBash: ['make nuke*'],
  agents: { deny: ['work-*'] },
};
const r = (permission, pattern, action) => ({ permission, pattern, action });
const INVARIANTS_RO = [
  r('external_directory', '*', 'deny'),
  r('read', '*.env', 'deny'), r('grep', '*.env', 'deny'), r('glob', '*.env', 'deny'), r('list', '*.env', 'deny'),
  r('read', '**/.ssh/**', 'deny'), r('grep', '**/.ssh/**', 'deny'), r('glob', '**/.ssh/**', 'deny'), r('list', '**/.ssh/**', 'deny'),
  r('task', 'work-*', 'deny'),
  r('gitlab_*', '*', 'deny'),
];

test('read-only: deny-all, allows, invariants, doom_loop deny — exact order', () => {
  const rules = buildPermissionRules('read-only', { policy, deniedAgentGlobs: ['work-*'] });
  assert.deepEqual(rules, [
    r('*', '*', 'deny'),
    r('read', '*', 'allow'), r('glob', '*', 'allow'), r('grep', '*', 'allow'), r('list', '*', 'allow'),
    r('lsp', '*', 'allow'), r('skill', '*', 'allow'), r('todowrite', '*', 'allow'),
    ...INVARIANTS_RO,
    r('doom_loop', '*', 'deny'),
  ]);
  assert.ok(!rules.some((x) => x.permission === 'bash' && x.action !== 'deny'));
});

test('write: only invariants + destructive asks (builtin then policy) + doom_loop ask', () => {
  const rules = buildPermissionRules('write', { policy, deniedAgentGlobs: ['work-*'] });
  const asks = [...BUILTIN_DESTRUCTIVE_BASH, 'make nuke*'].map((p) => r('bash', p, 'ask'));
  assert.deepEqual(rules, [...INVARIANTS_RO, ...asks, r('doom_loop', '*', 'ask')]);
  assert.equal(BUILTIN_DESTRUCTIVE_BASH.length, 28);
});

test('custom: read-only base + custom rules + invariants; bash allow brings destructive asks', () => {
  const permissionProfiles = { 'npm-test-only': [{ permission: 'bash', pattern: 'npm test', action: 'allow' }], docs: [{ permission: 'edit', pattern: 'docs/*', action: 'allow' }] };
  const rules = buildPermissionRules('custom:npm-test-only', { policy, permissionProfiles, deniedAgentGlobs: [] });
  assert.deepEqual(rules.slice(0, 9), [
    r('*', '*', 'deny'), r('read', '*', 'allow'), r('glob', '*', 'allow'), r('grep', '*', 'allow'), r('list', '*', 'allow'),
    r('lsp', '*', 'allow'), r('skill', '*', 'allow'), r('todowrite', '*', 'allow'), r('bash', 'npm test', 'allow'),
  ]);
  assert.ok(rules.some((x) => x.permission === 'bash' && x.pattern === 'rm -rf*' && x.action === 'ask'));
  assert.deepEqual(rules.at(-1), r('doom_loop', '*', 'deny'));
  const docs = buildPermissionRules('custom:docs', { policy, permissionProfiles });
  assert.ok(!docs.some((x) => x.permission === 'bash'));
});

test('unknown or malformed profiles are usage errors', () => {
  assert.throws(() => buildPermissionRules('everything', { policy }), UsageError);
  assert.throws(() => buildPermissionRules('custom:nope', { policy, permissionProfiles: {} }), UsageError);
  assert.throws(() => buildPermissionRules('custom:bad', { policy, permissionProfiles: { bad: [{ permission: 'bash', pattern: '*', action: 'always' }] } }), UsageError);
});

test('default sensitive paths apply when policy has none', () => {
  const rules = invariantRules('read-only', { policy: {} });
  assert.ok(rules.some((x) => x.permission === 'read' && x.pattern === '*.pem' && x.action === 'deny'));
});

test('bridgeModeOf: read-only auto-rejects, others bridge', () => {
  assert.equal(bridgeModeOf('read-only'), 'auto-reject');
  assert.equal(bridgeModeOf('write'), 'bridge');
  assert.equal(bridgeModeOf('custom:x'), 'bridge');
});

test('requiresUser: destructive bash, external_directory, sensitive paths', () => {
  assert.equal(requiresUser({ permission: 'bash', patterns: ['rm -rf build'] }, policy), true);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['make nuke all'] }, policy), true);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['psql -c "DROP TABLE x"'] }, policy), true);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['ls -la'] }, policy), false);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['ls'], metadata: { command: 'git push --force origin main' } }, policy), true);
  assert.equal(requiresUser({ permission: 'external_directory', patterns: ['/etc/*'] }, policy), true);
  assert.equal(requiresUser({ permission: 'read', patterns: ['/ws/app/.env'] }, policy), true);
  assert.equal(requiresUser({ permission: 'edit', patterns: ['/home/u/.ssh/config'] }, policy), true);
  assert.equal(requiresUser({ permission: 'edit', patterns: ['src/a.js'] }, policy), false);
  assert.equal(requiresUser(null, policy), true);
});

test('checkReply: never always; approver user needs confirmation; claude only for destructive', () => {
  const destructive = { permission: 'bash', patterns: ['rm -rf build'] };
  const benign = { permission: 'bash', patterns: ['ls'] };
  assert.deepEqual(checkReply({ approver: 'claude', request: benign, reply: 'always', policy }).code, 'INVALID_REPLY');
  assert.equal(checkReply({ approver: 'user', request: benign, reply: 'maybe', policy }).code, 'INVALID_REPLY');
  assert.equal(checkReply({ approver: 'user', request: destructive, reply: 'reject', policy }).ok, true);
  assert.equal(checkReply({ approver: 'user', request: benign, reply: 'once', policy }).code, 'NEEDS_USER');
  assert.equal(checkReply({ approver: 'user', request: benign, reply: 'once', confirmedByUser: true, policy }).ok, true);
  assert.equal(checkReply({ approver: 'claude', request: benign, reply: 'once', policy }).ok, true);
  assert.equal(checkReply({ approver: 'claude', request: destructive, reply: 'once', policy }).code, 'NEEDS_USER');
  assert.equal(checkReply({ approver: 'claude', request: destructive, reply: 'once', confirmedByUser: true, policy }).ok, true);
});

test('planPermissionSwitch: none when tail matches; patch only with leading catch-all under append', () => {
  const ro = buildPermissionRules('read-only', { policy });
  const wr = buildPermissionRules('write', { policy });
  assert.equal(planPermissionSwitch(ro, ro), 'none');
  assert.equal(planPermissionSwitch([...wr, ...ro], ro), 'none');
  assert.equal(planPermissionSwitch(wr, ro), 'patch');
  assert.throws(() => planPermissionSwitch(ro, wr), (err) => err.code === 'PROFILE_SWITCH_UNSUPPORTED' && err.exitCode === 2);
  assert.equal(planPermissionSwitch(ro, wr, 'replace'), 'patch');
  assert.equal(planPermissionSwitch(undefined, ro), 'patch');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/policy-profiles.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../../plugins/opc/scripts/lib/policy.mjs' does not provide an export named 'BUILTIN_DESTRUCTIVE_BASH'`.

- [ ] **Step 3: Implementar**

Garantir no topo de `policy.mjs` os imports (a F1 já deve ter o primeiro; acrescentar `UsageError` se faltar):

```js
import { matchesAny } from './models.mjs';
import { PolicyError, UsageError } from './opc-error.mjs';
```

Anexar ao fim do arquivo:

```js

// ---- F2a: permission profiles, invariants, approver (spec §8) ----

export const BUILTIN_DESTRUCTIVE_BASH = Object.freeze([
  'rm -rf*', 'rm -r *', 'rm -fr*', 'git push --force*', 'git push -f*', 'git push --delete*',
  'git reset --hard*', 'git clean -f*', 'git branch -D*', 'git tag -d*', 'docker rm*',
  'docker rmi*', 'docker volume rm*', 'docker system prune*', 'docker compose down -v*',
  'kubectl delete*', 'mkfs*', 'dd *of=*', 'shred*', 'truncate -s 0*', 'find * -delete*',
  'shutdown*', 'reboot*', 'poweroff*', 'systemctl stop*', '*DROP DATABASE*', '*DROP TABLE*',
  '*TRUNCATE*',
]);
export const READ_ONLY_ALLOW = Object.freeze(['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'todowrite']);
export const SENSITIVE_PATH_PERMISSIONS = Object.freeze(['read', 'grep', 'glob', 'list']);
export const DEFAULT_SENSITIVE_PATHS = Object.freeze([
  '*.env', '*.env.*', '**/.ssh/**', '*.pem', '*.key', '**/id_rsa*', '**/id_ed25519*', '**/secrets.env',
]);
export const PATCH_PERMISSION_MODE = 'append';
const RULE_ACTIONS = new Set(['allow', 'deny', 'ask']);

const rule = (permission, pattern, action) => ({ permission, pattern, action });

export function sensitivePathsOf(policy = {}) {
  return Array.isArray(policy.sensitivePaths) ? policy.sensitivePaths : [...DEFAULT_SENSITIVE_PATHS];
}

export function destructiveBashOf(policy = {}) {
  return [...BUILTIN_DESTRUCTIVE_BASH, ...(Array.isArray(policy.destructiveBash) ? policy.destructiveBash : [])];
}

export function parseProfile(profile) {
  if (profile === 'read-only' || profile === 'write') return { kind: profile, name: null };
  if (typeof profile === 'string' && profile.startsWith('custom:') && profile.length > 'custom:'.length) {
    return { kind: 'custom', name: profile.slice('custom:'.length) };
  }
  throw new UsageError('UNKNOWN_PROFILE', `unknown permission profile "${profile}" (use read-only, write or custom:<name>)`);
}

function customRulesOf(name, permissionProfiles = {}) {
  const rules = permissionProfiles?.[name];
  if (!Array.isArray(rules)) {
    throw new UsageError('UNKNOWN_PROFILE', `permissionProfiles.${name} is not defined in the global config`);
  }
  return rules.map((r, i) => {
    if (!r || typeof r.permission !== 'string' || typeof r.pattern !== 'string' || !RULE_ACTIONS.has(r.action)) {
      throw new UsageError('INVALID_PROFILE', `permissionProfiles.${name}[${i}] must be {permission, pattern, action: allow|deny|ask}`);
    }
    return rule(r.permission, r.pattern, r.action);
  });
}

export function invariantRules(profile, { policy = {}, deniedAgentGlobs = [], bridged = null } = {}) {
  const { kind } = parseProfile(profile);
  const withDestructive = bridged ?? kind === 'write';
  const rules = [rule('external_directory', '*', 'deny')];
  for (const pattern of sensitivePathsOf(policy)) {
    for (const permission of SENSITIVE_PATH_PERMISSIONS) rules.push(rule(permission, pattern, 'deny'));
  }
  for (const glob of deniedAgentGlobs) rules.push(rule('task', glob, 'deny'));
  for (const tool of policy.tools?.deny ?? []) rules.push(rule(tool, '*', 'deny'));
  if (withDestructive) for (const pattern of destructiveBashOf(policy)) rules.push(rule('bash', pattern, 'ask'));
  rules.push(rule('doom_loop', '*', kind === 'write' ? 'ask' : 'deny'));
  return rules;
}

export function buildPermissionRules(profile, { policy = {}, permissionProfiles = {}, deniedAgentGlobs = [] } = {}) {
  const { kind, name } = parseProfile(profile);
  const rules = [];
  let bridged = kind === 'write';
  if (kind !== 'write') {
    rules.push(rule('*', '*', 'deny'));
    for (const permission of READ_ONLY_ALLOW) rules.push(rule(permission, '*', 'allow'));
  }
  if (kind === 'custom') {
    const custom = customRulesOf(name, permissionProfiles);
    rules.push(...custom);
    bridged = custom.some((r) => r.permission === 'bash' && r.action !== 'deny');
  }
  rules.push(...invariantRules(profile, { policy, deniedAgentGlobs, bridged }));
  return rules;
}

export function bridgeModeOf(profile) {
  return parseProfile(profile).kind === 'read-only' ? 'auto-reject' : 'bridge';
}

export function requiresUser(request, policy = {}) {
  if (!request || typeof request.permission !== 'string') return true;
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : [];
  if (request.permission === 'external_directory') return true;
  if (request.permission === 'bash') {
    const commands = [...patterns];
    if (typeof request.metadata?.command === 'string') commands.push(request.metadata.command);
    const destructive = destructiveBashOf(policy);
    return commands.some((command) => matchesAny(command.trim(), destructive));
  }
  if (SENSITIVE_PATH_PERMISSIONS.includes(request.permission) || request.permission === 'edit') {
    const sensitive = sensitivePathsOf(policy);
    return patterns.some((pattern) => matchesAny(pattern, sensitive));
  }
  return false;
}

export function checkReply({ approver = 'user', request, reply, confirmedByUser = false, policy = {} }) {
  if (reply === 'always') {
    return { ok: false, code: 'INVALID_REPLY', reason: '"always" is never sent: in OpenCode it applies to the whole directory and overrides the session deny rules; use once or reject' };
  }
  if (reply !== 'once' && reply !== 'reject') {
    return { ok: false, code: 'INVALID_REPLY', reason: `invalid reply "${reply}" (use once or reject)` };
  }
  if (reply === 'reject') return { ok: true };
  if (approver !== 'claude' && !confirmedByUser) {
    return { ok: false, code: 'NEEDS_USER', reason: 'approver is "user": present the request, ask the user (AskUserQuestion) and pass --confirmed-by-user' };
  }
  if (approver === 'claude' && !confirmedByUser && requiresUser(request, policy)) {
    return { ok: false, code: 'NEEDS_USER', reason: 'destructive, external_directory or sensitive-path request: it always needs the user (--confirmed-by-user after AskUserQuestion)' };
  }
  return { ok: true };
}

function endsWithRules(current, desired) {
  if (desired.length > current.length) return false;
  const offset = current.length - desired.length;
  return desired.every((r, i) => {
    const c = current[offset + i];
    return c && c.permission === r.permission && c.pattern === r.pattern && c.action === r.action;
  });
}

export function planPermissionSwitch(current, desired, mode = PATCH_PERMISSION_MODE) {
  const existing = Array.isArray(current) ? current : [];
  if (endsWithRules(existing, desired)) return 'none';
  if (mode === 'replace') return 'patch';
  const first = desired[0];
  if (first && first.permission === '*' && first.pattern === '*') return 'patch';
  throw new UsageError('PROFILE_SWITCH_UNSUPPORTED', 'this session was created with another permission profile and OpenCode 1.18.32 appends (does not replace) session rules on PATCH, so switching to this profile would not take effect; start a new session with --fresh');
}

export { endsWithRules };
```

- [ ] **Step 4: Rodar e ver passar (e não quebrar a F1)**

Run: `node --test tests/unit/policy-profiles.test.mjs tests/unit/policy.test.mjs`
Expected: PASS (os testes da F1 continuam verdes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/policy.mjs tests/unit/policy-profiles.test.mjs
git commit -m "feat(policy): add permission profiles, invariants and approver checks"
```

---

### Task 3: `lib/routing.mjs` — resolução de modelo, variant e agente

**Files:**
- Create: `plugins/opc/scripts/lib/routing.mjs`
- Test: `tests/unit/routing.test.mjs`

**Interfaces:**
- Consumes: `normalizeModelId(input, { catalog, defaultProvider, aliases })`, `buildCatalog(providerResponse)`, `validateVariant(entry, variant)` (F1, `lib/models.mjs` — dona da validação de variant, `UsageError('UNKNOWN_VARIANT')`); `evaluate`, `assertAgentUsable(agentInfo, policy)` (F1, `lib/policy.mjs` — dona da política de agente: nome + provider e modelo fixados); `OpcError`, `PolicyError`, `UsageError`.
- Produces: `kindSpecificModel(kind, config)` → `string|null`; `resolveCandidates({ kind, flags = {}, config = {}, catalog, opencodeConfig = null })` → `{ candidates: Array<{ providerID, modelID, full, source: 'flag'|'tier'|'kind'|'route'|'default'|'opencode' }>, warnings: string[], fallbackEligible }` (listas de nível 2 e 4 com mais de um candidato); `validateSelection({ candidate, variant, agentName, agents, catalog, policy })` → `{ variant, agent }`.
- Ordem de checagem de cada candidato: política (provider, depois modelo) antes de "provider conectado", para que um modelo negado sempre dê exit 4.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindSpecificModel, resolveCandidates, validateSelection } from '../../plugins/opc/scripts/lib/routing.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { PolicyError, UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const P = 'omniroute-mvalmeida';
const catalog = buildCatalog({
  connected: [P, 'anthropic'],
  default: {},
  all: [
    { id: P, name: 'Omni', models: {
      'opencode-go/deepseek-v4.1-flash': { id: 'opencode-go/deepseek-v4.1-flash', providerID: P, name: 'DeepSeek', variants: { high: {}, low: {} }, limit: { context: 128000, output: 8192 } },
      'opencode-go/qwen3.8-max': { id: 'opencode-go/qwen3.8-max', providerID: P, name: 'Qwen', variants: {}, limit: { context: 256000, output: 8192 } },
      'opencode-go/kimi-k3': { id: 'opencode-go/kimi-k3', providerID: P, name: 'Kimi', variants: { thinking: {} }, limit: { context: 200000, output: 8192 } },
    } },
    { id: 'anthropic', name: 'Anthropic', models: { 'claude-x': { id: 'claude-x', providerID: 'anthropic', name: 'X', variants: {} } } },
    { id: 'omniroute-work', name: 'EQ', models: { 'm': { id: 'm', providerID: 'omniroute-work', name: 'm' } } },
    { id: 'ollama', name: 'Ollama', models: { 'llama9': { id: 'llama9', providerID: 'ollama', name: 'llama9' } } },
  ],
});
const FLASH = `${P}/opencode-go/deepseek-v4.1-flash`;
const QWEN = `${P}/opencode-go/qwen3.8-max`;
const KIMI = `${P}/opencode-go/kimi-k3`;
const baseConfig = {
  defaultProvider: P,
  aliases: { fast: FLASH, strong: QWEN, k3: KIMI },
  routing: { tasks: { ask: ['fast', 'k3'], task: ['fast', 'strong'] }, tiers: { light: ['fast'], heavy: ['strong', 'k3'] } },
  policy: { providers: { deny: ['omniroute-work'] }, models: { allow: [], deny: [] } },
};

test('level 1: --model (alias, full with slashes, short name) wins, no fallback', () => {
  for (const model of ['fast', FLASH, 'opencode-go/deepseek-v4.1-flash']) {
    const r = resolveCandidates({ kind: 'ask', flags: { model, tier: 'heavy' }, config: baseConfig, catalog });
    assert.deepEqual(r.candidates.map((c) => c.full), [FLASH]);
    assert.equal(r.candidates[0].modelID, 'opencode-go/deepseek-v4.1-flash');
    assert.equal(r.candidates[0].source, 'flag');
    assert.equal(r.fallbackEligible, false);
  }
});

test('level 2: --tier list, eligible for fallback', () => {
  const r = resolveCandidates({ kind: 'ask', flags: { tier: 'heavy' }, config: baseConfig, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [QWEN, KIMI]);
  assert.equal(r.fallbackEligible, true);
  assert.throws(() => resolveCandidates({ kind: 'ask', flags: { tier: 'nope' }, config: baseConfig, catalog }), (e) => e.code === 'UNKNOWN_TIER');
});

test('level 3: kind-specific model beats the route', () => {
  const config = { ...baseConfig, reviewModel: 'strong', routing: { ...baseConfig.routing, tasks: { review: ['fast'] } } };
  const r = resolveCandidates({ kind: 'review', config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [QWEN]);
  assert.equal(r.candidates[0].source, 'kind');
  assert.equal(kindSpecificModel('judge', { conclave: { judge: 'claude' } }), null);
  assert.equal(kindSpecificModel('stop-gate', { stopGate: { model: 'k3' } }), 'k3');
  assert.equal(kindSpecificModel('task', baseConfig), null);
});

test('level 4 route; level 5 defaultModel; level 6 OpenCode default; level 7 error', () => {
  assert.deepEqual(resolveCandidates({ kind: 'ask', config: baseConfig, catalog }).candidates.map((c) => c.full), [FLASH, KIMI]);
  const noRoute = { ...baseConfig, routing: {}, defaultModel: KIMI };
  assert.deepEqual(resolveCandidates({ kind: 'plan', config: noRoute, catalog }).candidates.map((c) => c.full), [KIMI]);
  const bare = { defaultProvider: P, policy: {} };
  const r6 = resolveCandidates({ kind: 'plan', config: bare, catalog, opencodeConfig: { model: QWEN } });
  assert.equal(r6.candidates[0].source, 'opencode');
  assert.throws(() => resolveCandidates({ kind: 'plan', config: bare, catalog, opencodeConfig: {} }), (e) => e instanceof UsageError && e.code === 'NO_MODEL');
});

test('lists skip denied/invalid entries with warnings; all denied → PolicyError', () => {
  const config = { ...baseConfig, policy: { models: { deny: [KIMI] } }, routing: { tasks: { ask: ['k3', 'ghost', 'fast'] } } };
  const r = resolveCandidates({ kind: 'ask', config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [FLASH]);
  assert.equal(r.warnings.length, 2);
  assert.equal(r.fallbackEligible, false);
  const allDenied = { ...baseConfig, policy: { models: { deny: ['*'] } } };
  assert.throws(() => resolveCandidates({ kind: 'ask', config: allDenied, catalog }), PolicyError);
  const allInvalid = { ...baseConfig, routing: { tasks: { ask: ['ghost1', 'ghost2'] } } };
  assert.throws(() => resolveCandidates({ kind: 'ask', config: allInvalid, catalog }), (e) => e.code === 'NO_VALID_CANDIDATE');
});

test('single value denied → PolicyError; disconnected provider → usage error', () => {
  assert.throws(() => resolveCandidates({ kind: 'task', flags: { model: 'omniroute-work/m' }, config: baseConfig, catalog }), PolicyError);
  assert.throws(() => resolveCandidates({ kind: 'task', flags: { model: 'ollama/llama9' }, config: baseConfig, catalog }), (e) => e instanceof UsageError && e.code === 'PROVIDER_NOT_CONNECTED');
});

test('validateSelection: variant (F1 validateVariant), agent existence, policy (F1 assertAgentUsable), mode and pinned model', () => {
  const candidate = { full: FLASH };
  const agents = [
    { name: 'build', mode: 'primary' },
    { name: 'explore', mode: 'subagent' },
    { name: 'work-deploy', mode: 'primary' },
    { name: 'pinned', mode: 'all', model: { providerID: 'omniroute-work', modelID: 'm' } },
  ];
  const policy = { agents: { deny: ['work-*'] }, providers: { deny: ['omniroute-work'] } };
  assert.deepEqual(validateSelection({ candidate, variant: 'high', agentName: 'build', agents, catalog, policy }), { variant: 'high', agent: 'build' });
  assert.throws(() => validateSelection({ candidate, variant: 'ultra', agents, catalog, policy }), (e) => e instanceof UsageError && e.code === 'UNKNOWN_VARIANT');
  assert.throws(() => validateSelection({ candidate: { full: 'ghost/none' }, variant: 'high', agents, catalog, policy }), (e) => e.code === 'UNKNOWN_VARIANT');
  assert.deepEqual(validateSelection({ candidate, variant: '', agents, catalog, policy }), { variant: null, agent: null });
  assert.throws(() => validateSelection({ candidate, agentName: 'ghost', agents, catalog, policy }), (e) => e.code === 'UNKNOWN_AGENT');
  assert.throws(() => validateSelection({ candidate, agentName: 'explore', agents, catalog, policy }), (e) => e.code === 'AGENT_MODE');
  assert.throws(() => validateSelection({ candidate, agentName: 'work-deploy', agents, catalog, policy }), (e) => e instanceof PolicyError && e.code === 'POLICY_DENIED');
  // pinned model whose provider is denied: F1 assertAgentUsable checks the provider before the model
  assert.throws(() => validateSelection({ candidate, agentName: 'pinned', agents, catalog, policy }), PolicyError);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/routing.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`lib/routing.mjs`).

- [ ] **Step 3: Implementar**

```js
// Model, agent and variant resolution (spec §6). Fallback execution is F4a; here we only
// compute the candidate list and whether it is eligible for fallback.
import { OpcError, PolicyError, UsageError } from './opc-error.mjs';
import { normalizeModelId, validateVariant } from './models.mjs';
import { assertAgentUsable, evaluate } from './policy.mjs';

const LIST_SOURCES = new Set(['tier', 'route']);

export function kindSpecificModel(kind, config = {}) {
  const pick = (value) => (typeof value === 'string' && value && value !== 'claude' ? value : null);
  switch (kind) {
    case 'review':
    case 'adversarial-review':
      return pick(config.reviewModel);
    case 'stop-gate':
      return pick(config.stopGate?.model);
    case 'planner':
      return pick(config.orchestrate?.planner);
    case 'synthesizer':
      return pick(config.orchestrate?.synthesizer);
    case 'judge':
      return pick(config.conclave?.judge);
    default:
      return null; // task, ask, plan, summarize (summarize takes --model)
  }
}

function pickLevel({ kind, flags, config, opencodeConfig }) {
  if (flags.model) return { source: 'flag', values: [flags.model] };
  if (flags.tier) {
    const list = config.routing?.tiers?.[flags.tier];
    if (!Array.isArray(list) || list.length === 0) {
      throw new UsageError('UNKNOWN_TIER', `routing.tiers.${flags.tier} is not configured`);
    }
    return { source: 'tier', values: list };
  }
  const specific = kindSpecificModel(kind, config);
  if (specific) return { source: 'kind', values: [specific] };
  const route = config.routing?.tasks?.[kind];
  if (Array.isArray(route) && route.length > 0) return { source: 'route', values: route };
  if (typeof config.defaultModel === 'string' && config.defaultModel) return { source: 'default', values: [config.defaultModel] };
  if (typeof opencodeConfig?.model === 'string' && opencodeConfig.model) return { source: 'opencode', values: [opencodeConfig.model] };
  throw new UsageError('NO_MODEL', 'no model resolved (no --model, --tier, route, defaultModel or OpenCode default model); pass --model <provider>/<model>');
}

function checkCandidate(value, { catalog, config }) {
  const parsed = normalizeModelId(value, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {} });
  const policy = config.policy ?? {};
  for (const [kind, subject] of [['provider', parsed.providerID], ['model', parsed.full]]) {
    const verdict = evaluate(kind, subject, policy);
    if (!verdict.allowed) {
      throw new PolicyError('POLICY_DENIED', `${kind} ${subject} is denied by policy${verdict.rule ? ` (${verdict.rule})` : ''}`);
    }
  }
  if (!catalog.connected.has(parsed.providerID)) {
    throw new UsageError('PROVIDER_NOT_CONNECTED', `provider ${parsed.providerID} is not connected (run: opencode auth login)`);
  }
  return parsed;
}

export function resolveCandidates({ kind, flags = {}, config = {}, catalog, opencodeConfig = null }) {
  const { source, values } = pickLevel({ kind, flags, config, opencodeConfig });
  if (!LIST_SOURCES.has(source)) {
    const candidate = checkCandidate(values[0], { catalog, config });
    return { candidates: [{ ...candidate, source }], warnings: [], fallbackEligible: false };
  }
  const candidates = [];
  const warnings = [];
  const problems = [];
  let denied = 0;
  for (const value of values) {
    try {
      const candidate = checkCandidate(value, { catalog, config });
      if (!candidates.some((c) => c.full === candidate.full)) candidates.push({ ...candidate, source });
    } catch (err) {
      if (!(err instanceof OpcError)) throw err;
      if (err instanceof PolicyError) denied += 1;
      problems.push(`${value}: ${err.message}`);
      warnings.push(`skipped ${value}: ${err.message}`);
    }
  }
  if (candidates.length === 0) {
    const where = source === 'tier' ? `routing.tiers.${flags.tier}` : `routing.tasks.${kind}`;
    const message = `no usable model in ${where}:\n- ${problems.join('\n- ')}`;
    if (denied === values.length) throw new PolicyError('POLICY_DENIED', message);
    throw new UsageError('NO_VALID_CANDIDATE', message);
  }
  return { candidates, warnings, fallbackEligible: candidates.length > 1 };
}

// Variant rules live in F1 validateVariant; agent policy (name + pinned provider/model) in F1
// assertAgentUsable. Here we only add existence and the "cannot drive a session" mode check.
export function validateSelection({ candidate, variant = null, agentName = null, agents = [], catalog, policy = {} }) {
  const entry = catalog.byFull.get(candidate.full) ?? { full: candidate.full, variants: [] };
  const checkedVariant = validateVariant(entry, variant);
  if (agentName) {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) throw new UsageError('UNKNOWN_AGENT', `unknown agent "${agentName}" (see /opc:agents)`);
    assertAgentUsable(agent, policy);
    if (agent.mode === 'subagent') {
      throw new UsageError('AGENT_MODE', `agent "${agentName}" is subagent-only and cannot drive a session`);
    }
  }
  return { variant: checkedVariant, agent: agentName || null };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/routing.test.mjs`
Expected: PASS (7 testes). Se a fixture inline não for aceita pelo `buildCatalog` da F1 (ex.: exige `cost`/`limit` completos), completar só os campos que ele exigir no objeto do teste.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/routing.mjs tests/unit/routing.test.mjs
git commit -m "feat(routing): resolve model candidates, variant and agent"
```

---

### Task 4: `lib/args.mjs` — `parsePromptArgs` (prompt verbatim) e `readRawArgs`

**Files:**
- Modify: `plugins/opc/scripts/lib/args.mjs` (anexar ao fim)
- Test: `tests/unit/args-prompt.test.mjs`

**Interfaces:**
- Consumes: `UsageError`; `readStdin(stream)` (F0, mesmo arquivo).
- Produces: `parsePromptArgs(raw, flagSpec)` → `{ argv: string[], prompt: string }`. `flagSpec` usa os tipos do `parseArgs` mais `'optional-string'` com `match: RegExp` (o valor só é consumido se casar). Flags reconhecidas apenas como palavras inteiras; valor pode vir entre aspas; `--flag=valor`; `--` isolado encerra as flags; o resto do texto é mantido byte a byte (só o início e o fim são aparados).
- Produces: `RAW_ARGS_FLAG = '--raw-args-stdin'`; `readRawArgs(argv, flagSpec, { stdin = process.stdin } = {})` → `Promise<{ argv: string[], text: string|null }>` — helper único de **todos** os comandos de texto livre (`task`/`ask`/`plan` aqui; `review`/`adversarial-review`, `subagent`, `command`, `orchestrate`, `conclave` nas fases seguintes). Sem `--raw-args-stdin` no `argv`: devolve uma cópia do `argv` e `text: null`, sem tocar no stdin. Com a flag: lê o stdin uma vez, extrai as flags conhecidas com `parsePromptArgs`, anexa-as ao `argv` (a própria flag fica, então o spec do `parseArgs` do comando declara `'raw-args-stdin': { type: 'boolean' }`) e devolve o texto verbatim.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { RAW_ARGS_FLAG, parsePromptArgs, readRawArgs } from '../../plugins/opc/scripts/lib/args.mjs';

const REF = /^(task|ask|plan)-[0-9a-z]+-[0-9a-z]{6}$|^ses[_0-9A-Za-z]+$/;
const SPEC = {
  model: { type: 'string', alias: 'm' }, write: { type: 'boolean' }, background: { type: 'boolean' },
  effort: { type: 'string' }, resume: { type: 'optional-string', match: REF }, fresh: { type: 'boolean' },
};

test('prompt kept verbatim: quotes, apostrophes, backticks, $(), ${}, unicode, newlines, backslash', () => {
  const raw = `--write -m omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash fix "it" don't \`whoami\` $(touch pwned) \${HOME} ção 🚀\nsecond line \\ end\n`;
  const r = parsePromptArgs(raw, SPEC);
  assert.deepEqual(r.argv, ['--write', '-m', 'omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash']);
  assert.equal(r.prompt, `fix "it" don't \`whoami\` $(touch pwned) \${HOME} ção 🚀\nsecond line \\ end`);
});

test('flags anywhere as whole words; quoted values; --flag=value; -- ends flag parsing', () => {
  const r = parsePromptArgs('explain the bug --background --effort "high" in src', SPEC);
  assert.deepEqual(r.argv, ['--background', '--effort', 'high']);
  assert.equal(r.prompt, 'explain the bug in src');
  const e = parsePromptArgs('--model=fast do it -- --write is literal here', SPEC);
  assert.deepEqual(e.argv, ['--model', 'fast']);
  assert.equal(e.prompt, 'do it --write is literal here');
  assert.deepEqual(parsePromptArgs('talk about --writers and -mild', SPEC).argv, []);
});

test('optional-string takes the next word only when it matches', () => {
  assert.deepEqual(parsePromptArgs('--resume task-abc123-x1y2z3 go on', SPEC), { argv: ['--resume', 'task-abc123-x1y2z3'], prompt: 'go on' });
  assert.deepEqual(parsePromptArgs('--resume ses_01ABC keep going', SPEC), { argv: ['--resume', 'ses_01ABC'], prompt: 'keep going' });
  assert.deepEqual(parsePromptArgs('--resume keep going', SPEC), { argv: ['--resume'], prompt: 'keep going' });
  assert.deepEqual(parsePromptArgs('--resume', SPEC), { argv: ['--resume'], prompt: '' });
});

test('value flag without a value is a usage error; empty input is empty', () => {
  assert.throws(() => parsePromptArgs('do it --model', SPEC), (e) => e.exitCode === 2);
  assert.deepEqual(parsePromptArgs('\n', SPEC), { argv: [], prompt: '' });
});

test('readRawArgs: without the flag returns a copy of argv and text null, never reading stdin', async () => {
  let touched = false;
  const stdin = { isTTY: false, [Symbol.asyncIterator]() { touched = true; throw new Error('stdin must not be read'); } };
  const argv = ['--write', 'fix', 'it'];
  const r = await readRawArgs(argv, SPEC, { stdin });
  assert.deepEqual(r, { argv: ['--write', 'fix', 'it'], text: null });
  assert.notEqual(r.argv, argv);
  assert.equal(touched, false);
});

test('readRawArgs: with the flag appends the extracted flags and returns the text verbatim', async () => {
  assert.equal(RAW_ARGS_FLAG, '--raw-args-stdin');
  const r = await readRawArgs(['--background', RAW_ARGS_FLAG], SPEC, { stdin: Readable.from(["--write don't touch `x` $(id) -m fast\n"]) });
  assert.deepEqual(r.argv, ['--background', '--raw-args-stdin', '--write', '-m', 'fast']);
  assert.equal(r.text, "don't touch `x` $(id)");
  // agent form: flags on the command line, heredoc starting with `--` → nothing in the text becomes a flag
  const agent = await readRawArgs(['--write', RAW_ARGS_FLAG], SPEC, { stdin: Readable.from(["--\n--model x is text, don't split\n"]) });
  assert.deepEqual(agent.argv, ['--write', RAW_ARGS_FLAG]);
  assert.equal(agent.text, "--model x is text, don't split");
  assert.deepEqual(await readRawArgs([RAW_ARGS_FLAG], SPEC, { stdin: Readable.from(['']) }), { argv: [RAW_ARGS_FLAG], text: '' });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/args-prompt.test.mjs`
Expected: FAIL — `does not provide an export named 'parsePromptArgs'`.

- [ ] **Step 3: Implementar**

Garantir `import { UsageError } from './opc-error.mjs';` no topo de `args.mjs` e anexar (o `readStdin` da F0 já está no mesmo arquivo):

```js

// ---- F2a: prompt-preserving argument parsing for free-text commands ----

const isSpaceChar = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

// Splits a raw argument string into known flags and a verbatim prompt. Unlike splitArgString it
// never interprets quotes or apostrophes in the prompt text ("don't" stays intact). Known flags
// are recognized only as whole words; everything after a standalone `--` is prompt.
// flagSpec: { [name]: { type: 'boolean'|'string'|'number'|'optional-string', alias?, match? } }
export function parsePromptArgs(raw, flagSpec) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const known = new Map();
  for (const [name, def] of Object.entries(flagSpec)) {
    known.set(`--${name}`, def);
    if (def.alias) known.set(`-${def.alias}`, def);
  }
  const argv = [];
  const kept = [];
  const dropTrailingSpace = () => {
    if (kept.length && /^\s+$/.test(kept.at(-1))) kept.pop();
  };
  let i = 0;
  while (i < text.length) {
    if (isSpaceChar(text[i])) {
      let j = i;
      while (j < text.length && isSpaceChar(text[j])) j += 1;
      kept.push(text.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < text.length && !isSpaceChar(text[j])) j += 1;
    const word = text.slice(i, j);
    if (word === '--') {
      let k = j;
      while (k < text.length && isSpaceChar(text[k])) k += 1;
      dropTrailingSpace();
      if (kept.length) kept.push(' ');
      kept.push(text.slice(k));
      break;
    }
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const head = eq > 0 ? word.slice(0, eq) : word;
    const def = known.get(head);
    if (!def) {
      kept.push(word);
      i = j;
      continue;
    }
    dropTrailingSpace();
    if (eq > 0) {
      argv.push(head, word.slice(eq + 1));
      i = j;
      continue;
    }
    if (def.type === 'boolean') {
      argv.push(head);
      i = j;
      continue;
    }
    let k = j;
    while (k < text.length && isSpaceChar(text[k])) k += 1;
    let value;
    let end = k;
    const quote = text[k];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, k + 1);
      if (close > k) {
        value = text.slice(k + 1, close);
        end = close + 1;
      }
    }
    if (value === undefined) {
      while (end < text.length && !isSpaceChar(text[end])) end += 1;
      value = text.slice(k, end);
    }
    if (def.type === 'optional-string') {
      if (value && def.match instanceof RegExp && def.match.test(value)) {
        argv.push(head, value);
        i = end;
      } else {
        argv.push(head);
        i = j;
      }
      continue;
    }
    if (!value) throw new UsageError('USAGE', `flag ${head} needs a value`);
    argv.push(head, value);
    i = end;
  }
  return { argv, prompt: kept.join('').trim() };
}

export const RAW_ARGS_FLAG = '--raw-args-stdin';

// Commands that take free text: with --raw-args-stdin in argv, reads stdin once, extracts the known
// flags with parsePromptArgs and returns the verbatim text (the flag itself stays in argv, so the
// command's parseArgs spec must declare 'raw-args-stdin': { type: 'boolean' }). Otherwise text is null.
export async function readRawArgs(argv, flagSpec, { stdin = process.stdin } = {}) {
  if (!argv.includes(RAW_ARGS_FLAG)) return { argv: [...argv], text: null };
  const { argv: flagArgv, prompt } = parsePromptArgs(await readStdin(stdin), flagSpec);
  return { argv: [...argv, ...flagArgv], text: prompt };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/args-prompt.test.mjs tests/unit/args.test.mjs`
Expected: PASS (6 testes novos; testes da F0 inalterados).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/args.mjs tests/unit/args-prompt.test.mjs
git commit -m "feat(args): parse flags around a verbatim prompt and add readRawArgs"
```


---

### Task 5: `lib/runner.mjs` — um turno completo

**Files:**
- Create: `plugins/opc/scripts/lib/runner.mjs`
- Test: `tests/unit/runner.test.mjs` (api e hub de mentira, sem HTTP)

**Interfaces:**
- Consumes: `classifyError`, `retryExceedsCap` (Tarefa 1); `endsWithRules` (Tarefa 2); `ConnectionError`, `OpcError`; um `api` com `createSession`, `patchSession`, `promptAsync`, `abort`, `sessionStatus`, `messages(id, {limit})`, `children`, `diff`, `listPermissions`, `listQuestions` (F1 + Tarefa 6); um `hub` com `track(sessionID, handler) → untrack` e `onReconnect(handler) → off` (contrato `EventHub` da F0).
- Produces (contrato do mestre): `phaseFromPart(part)`; `runTurn({ api, hub, request, onProgress, onPermission, onQuestion, signal })`; `newMessageId()`.
- Produces (acréscimos): parâmetro opcional `onRequestResolved({ type: 'permission'|'question', requestID, sessionID, outcome })`; campos opcionais de `request`: `childPermission` (regras aplicadas às filhas), `statusPollMs` (padrão 5000), `idleWaitMs` (padrão 10000); campos extras do resultado: `messageID`, `errorCode` (`turn_timeout`, `retry_cap`, `bad_request`, `server_lost`, `cancelled`, `model_error`); eventos de progresso `{ phase?, message?, sessionID?, childSessionID? }`; exports `EDIT_TOOLS`, `STRUCTURED_OUTPUT_TOOL`, `filesFromToolPart(part)`, `turnMessages(messages, messageID)`, `extractTurn(turn, { childMessages, diffs })`; `newMessageId(now = Date.now())`.

Regras do turno implementadas aqui (spec §7):

1. Sessão nova (`POST /session {title, permission}`) ou existente (com `patchPermission`: `PATCH` e conferência de que o resultado termina com as regras enviadas).
2. `hub.track` **antes** do `prompt_async`; o handler aceita eventos da sessão e das filhas (`session.created` com `parentID` acompanhado).
3. `prompt_async` com `messageID` do cliente; `Timeout` na requisição → confere nas mensagens se o `messageID` chegou e só reenvia se não chegou (§5.2); 400 → falha `BadRequest` (fatal).
4. Fases: `starting`, `running`, `investigating`, `editing`, `verifying`, `subagent`, `retrying`, `finalizing`.
5. `session.status{retry}` → `retrying` com tentativa e motivo; acima do teto (`retryExceedsCap`) aborta e classifica `RetryCapExceeded` (recuperável).
6. Fim: `session.idle`/`session.status{idle}` confirmados nas mensagens (idle antes de qualquer atividade do turno é ignorado), `session.error` da sessão, `--timeout` (aborta; `Timeout` recuperável), `signal` (aborta; `cancelled`) ou `SERVER_DOWN` em qualquer chamada (`server_lost`, sem extração).
7. Ressincronização a cada `statusPollMs` e em cada reconexão: `/session/status`, filhas, `/permission`, `/question` (pedidos perdidos) e checagem de fim.
8. Extração a partir das mensagens do turno (`parentID === messageID`): texto final, `info.structured`, `info.error`, arquivos tocados (edit/write/apply_patch + `session.diff`), ferramentas executadas (sem contar `StructuredOutput`), filhas, uso somado.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { newMessageId, phaseFromPart, runTurn, turnMessages, extractTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { ConnectionError, RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

function stubHub() {
  const handlers = new Map();
  const reconnects = new Set();
  return {
    track(sessionID, handler) { handlers.set(sessionID, handler); return () => handlers.delete(sessionID); },
    onReconnect(handler) { reconnects.add(handler); return () => reconnects.delete(handler); },
    emit(event) { for (const h of handlers.values()) h(event); },
    reconnect() { for (const h of reconnects) h(); },
    get tracked() { return [...handlers.keys()]; },
  };
}

function stubApi({ hub, onPrompt = () => {}, statusMap = {}, extra = {} } = {}) {
  const calls = [];
  const store = {};
  const api = {
    calls, store, statusMap,
    permissions: [], questions: [], childrenOf: {}, diffs: {},
    async createSession(body) { calls.push(['createSession', body]); store.ses_new = []; return { id: 'ses_new', permission: body.permission ?? [] }; },
    async patchSession(id, body) { calls.push(['patchSession', id, body]); return { id, permission: [...(extra.existingPermission ?? []), ...body.permission] }; },
    async promptAsync(id, body) { calls.push(['promptAsync', id, body]); (store[id] ??= []).push({ info: { id: body.messageID, role: 'user', sessionID: id }, parts: body.parts }); setImmediate(() => onPrompt(id, body)); return null; },
    async abort(id) { calls.push(['abort', id]); statusMap[id] = undefined; return true; },
    async sessionStatus() { calls.push(['sessionStatus']); return Object.fromEntries(Object.entries(statusMap).filter(([, v]) => v)); },
    async messages(id) { calls.push(['messages', id]); return store[id] ?? []; },
    async children(id) { return (api.childrenOf[id] ?? []).map((cid) => ({ id: cid })); },
    async diff(id) { return api.diffs[id] ?? []; },
    async listPermissions() { return api.permissions; },
    async listQuestions() { return api.questions; },
    ...extra.methods,
  };
  return api;
}

const MODEL = { providerID: 'p', modelID: 'm/x' };
const baseRequest = (over = {}) => ({ newSession: { title: 'OPC: task: t', permission: [] }, parts: [{ type: 'text', text: 'hi' }], model: MODEL, timeoutMs: 5000, statusPollMs: 50, idleWaitMs: 200, fallbackCfg: { maxProviderRetries: 3, maxRetryWaitSec: 60 }, ...over });

function assistant(sessionID, parentID, { text = 'done', structured, error, tools = [], completed = true, tokens } = {}) {
  return {
    info: { id: `msg_a${Math.random().toString(16).slice(2, 8)}`, role: 'assistant', sessionID, parentID, time: completed ? { created: 1, completed: 2 } : { created: 1 }, ...(structured !== undefined && { structured }), ...(error && { error }), ...(tokens && { tokens, cost: 0.5 }) },
    parts: [...tools.map((t, i) => ({ id: `prt_t${i}`, type: 'tool', tool: t.tool, callID: `c${i}`, state: { status: t.status ?? 'completed', input: t.input ?? {} } })), ...(text ? [{ id: 'prt_x', type: 'text', text }] : [])],
  };
}

function setStatus(hub, api, sessionID, status) {
  if (status.type === 'idle') delete api.statusMap[sessionID];
  else api.statusMap[sessionID] = status;
  hub.emit({ type: 'session.status', properties: { sessionID, status } });
}

function completeTurn(hub, api, sessionID, body, opts = {}) {
  setStatus(hub, api, sessionID, { type: 'busy' });
  api.store[sessionID].push(assistant(sessionID, body.messageID, opts));
  setStatus(hub, api, sessionID, { type: 'idle' });
  hub.emit({ type: 'session.idle', properties: { sessionID } });
}

test('newMessageId: msg_ + 26 chars, strictly ascending', () => {
  const ids = Array.from({ length: 50 }, () => newMessageId());
  for (const id of ids) assert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  for (let i = 1; i < ids.length; i += 1) assert.ok(ids[i - 1] < ids[i], `${ids[i - 1]} < ${ids[i]}`);
});

test('phaseFromPart maps tools to phases', () => {
  assert.equal(phaseFromPart({ type: 'tool', tool: 'grep', state: {} }), 'investigating');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'apply_patch', state: {} }), 'editing');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }), 'verifying');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }), 'running');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'task', state: {} }), 'subagent');
  assert.equal(phaseFromPart({ type: 'text', text: 'x' }), 'running');
  assert.equal(phaseFromPart({ type: 'step-finish' }), null);
  assert.equal(phaseFromPart({ type: 'tool', tool: 'StructuredOutput', state: {} }), 'finalizing');
});

test('completed turn: text, structured, tools, touched files, usage, body', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body, { text: 'final answer', structured: { ok: true }, tools: [{ tool: 'edit', input: { filePath: 'src/a.js' } }, { tool: 'read', input: { filePath: 'b.js' } }], tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } } }) });
  api.diffs.ses_new = [{ file: 'src/c.js', additions: 1, deletions: 0 }];
  const phases = [];
  const r = await runTurn({ api, hub, request: baseRequest({ agent: 'build', variant: 'high' }), onProgress: (e) => e.phase && phases.push(e.phase) });
  assert.equal(r.status, 'completed');
  assert.equal(r.finalText, 'final answer');
  assert.deepEqual(r.structured, { ok: true });
  assert.deepEqual(r.touchedFiles, ['src/a.js', 'src/c.js']);
  assert.equal(r.toolsRan, true);
  assert.equal(r.usage.input, 10);
  assert.equal(r.usage.cost, 0.5);
  const prompt = api.calls.find((c) => c[0] === 'promptAsync');
  assert.deepEqual(prompt[2].model, MODEL);
  assert.equal(prompt[2].agent, 'build');
  assert.equal(prompt[2].variant, 'high');
  assert.match(prompt[2].messageID, /^msg_/);
  assert.ok(phases.includes('starting'));
  assert.ok(phases.includes('running'));
});

test('stale idle before any activity is ignored', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    hub.emit({ type: 'session.idle', properties: { sessionID: sid } });
    setTimeout(() => completeTurn(hub, api, sid, body, { text: 'late' }), 120);
  } });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'completed');
  assert.equal(r.finalText, 'late');
});

test('session.error ends the turn with the received error', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'session.error', properties: { sessionID: sid, error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'bad key' } } } });
  } });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'ProviderAuthError');
  assert.equal(r.errorClass, 'fatal');
});

test('retry status reports retrying; over cap aborts and is recoverable', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    setStatus(hub, api, sid, { type: 'retry', attempt: 1, message: '429', next: Date.now() + 1000 });
    setStatus(hub, api, sid, { type: 'retry', attempt: 4, message: '429', next: Date.now() + 1000 });
    setTimeout(() => {
      api.store[sid].push(assistant(sid, body.messageID, { text: '', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }));
      setStatus(hub, api, sid, { type: 'idle' });
      hub.emit({ type: 'session.idle', properties: { sessionID: sid } });
    }, 50);
  } });
  const phases = [];
  const r = await runTurn({ api, hub, request: baseRequest(), onProgress: (e) => e.phase && phases.push(e.phase) });
  assert.ok(phases.includes('retrying'));
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'RetryCapExceeded');
  assert.equal(r.errorClass, 'recoverable');
});

test('turn timeout aborts and is recoverable', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => setStatus(hub, api, sid, { type: 'busy' }) });
  api.statusMap.ses_new = { type: 'busy' };
  const r = await runTurn({ api, hub, request: baseRequest({ timeoutMs: 150 }) });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'Timeout');
  assert.equal(r.errorCode, 'turn_timeout');
  assert.equal(r.errorClass, 'recoverable');
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
});

test('abort signal cancels the turn', async () => {
  const hub = stubHub();
  const controller = new AbortController();
  const api = stubApi({ hub, onPrompt: (sid) => { setStatus(hub, api, sid, { type: 'busy' }); setTimeout(() => controller.abort(), 30); } });
  const r = await runTurn({ api, hub, request: baseRequest(), signal: controller.signal });
  assert.equal(r.status, 'cancelled');
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
});

test('server down during polling → server_lost, session preserved', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => setStatus(hub, api, sid, { type: 'busy' }) });
  api.sessionStatus = async () => { throw new ConnectionError('SERVER_DOWN', 'connection refused'); };
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'server_lost');
  assert.equal(r.sessionID, 'ses_new');
  assert.match(r.errorMessage, /--resume/);
});

test('400 on prompt_async is a fatal BadRequest', async () => {
  const hub = stubHub();
  const api = stubApi({ hub });
  api.promptAsync = async () => { throw new RequestError('BAD_REQUEST', 'invalid body'); };
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'BadRequest');
  assert.equal(r.errorClass, 'fatal');
});

test('prompt_async timeout: resend only when the messageID did not arrive', async () => {
  for (const arrived of [true, false]) {
    const hub = stubHub();
    let attempts = 0;
    const api = stubApi({ hub });
    api.promptAsync = async (sid, body) => {
      attempts += 1;
      const deliver = () => {
        api.store[sid].push({ info: { id: body.messageID, role: 'user' }, parts: [] });
        setTimeout(() => completeTurn(hub, api, sid, body), 20);
      };
      if (attempts === 1) {
        if (arrived) deliver();
        throw new ConnectionError('TIMEOUT', 'timed out');
      }
      deliver();
      return null;
    };
    const r = await runTurn({ api, hub, request: baseRequest() });
    assert.equal(r.status, 'completed');
    assert.equal(attempts, arrived ? 1 : 2);
  }
});

test('permissions/questions from session and child reach callbacks; resync recovers missed ones', async () => {
  const hub = stubHub();
  const seen = [];
  const resolved = [];
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: sid } } });
    hub.emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_child', permission: 'bash', patterns: ['rm -rf x'], metadata: {}, always: [] } });
    hub.emit({ type: 'permission.asked', properties: { id: 'per_other', sessionID: 'ses_unrelated', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] } });
    api.questions.push({ id: 'que_1', sessionID: sid, questions: [{ question: 'Q?', header: 'Q', options: [] }] });
    setTimeout(() => hub.reconnect(), 20);
    setTimeout(() => {
      hub.emit({ type: 'permission.replied', properties: { sessionID: 'ses_child', requestID: 'per_1', reply: 'reject' } });
      completeTurn(hub, api, sid, body);
    }, 80);
  } });
  const r = await runTurn({
    api, hub, request: baseRequest({ childPermission: [{ permission: 'bash', pattern: 'rm -rf*', action: 'ask' }] }),
    onPermission: async (req) => seen.push(req.id),
    onQuestion: async (req) => seen.push(req.id),
    onRequestResolved: async (ev) => resolved.push(ev.requestID),
  });
  assert.equal(r.status, 'completed');
  assert.deepEqual(seen.sort(), ['per_1', 'que_1']);
  assert.deepEqual(resolved, ['per_1']);
  assert.deepEqual(r.childSessionIDs, ['ses_child']);
  assert.ok(api.calls.some((c) => c[0] === 'patchSession' && c[1] === 'ses_child'));
});

test('resume with patchPermission verifies the returned rules', async () => {
  const hub = stubHub();
  const rules = [{ permission: '*', pattern: '*', action: 'deny' }];
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body), extra: { existingPermission: [{ permission: 'x', pattern: '*', action: 'allow' }] } });
  api.store.ses_old = [];
  const r = await runTurn({ api, hub, request: baseRequest({ newSession: undefined, sessionID: 'ses_old', patchPermission: rules }) });
  assert.equal(r.status, 'completed');
  assert.equal(r.sessionID, 'ses_old');
  assert.ok(!api.calls.some((c) => c[0] === 'createSession'));
});

test('turnMessages falls back to messages after the user message', () => {
  const list = [{ info: { id: 'msg_u', role: 'user' } }, { info: { id: 'msg_a', role: 'assistant' }, parts: [] }];
  assert.equal(turnMessages(list, 'msg_u').length, 1);
  assert.equal(turnMessages(list, 'msg_missing').length, 0);
});

test('extractTurn: apply_patch files and structured error keeps raw text', () => {
  const turn = [{ info: { role: 'assistant', error: { name: 'StructuredOutputError', data: { message: 'bad', retries: 1 } } }, parts: [
    { type: 'tool', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '*** Begin Patch\n*** Update File: a/b.js\n*** Add File: c.txt\n*** End Patch' } } },
    { type: 'text', text: 'raw answer' },
  ] }];
  const r = extractTurn(turn);
  assert.deepEqual(r.touchedFiles, ['a/b.js', 'c.txt']);
  assert.equal(r.finalText, 'raw answer');
  assert.equal(r.error.name, 'StructuredOutputError');
});

test('StructuredOutput tool does not count as tools ran (StructuredOutputError stays recoverable)', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body, { text: 'raw', tools: [{ tool: 'StructuredOutput', input: { x: 1 } }], error: { name: 'StructuredOutputError', data: { message: 'invalid', retries: 1 } } }) });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.toolsRan, false);
  assert.equal(r.errorType, 'StructuredOutputError');
  assert.equal(r.errorClass, 'recoverable');
  assert.equal(r.finalText, 'raw');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/runner.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`lib/runner.mjs`).

- [ ] **Step 3: Implementar**

```js
// Runs one OpenCode turn (prompt_async + SSE) until it ends (spec §7). Knows nothing about
// commands, jobs or rendering: the caller wires progress, permissions and questions.
import { randomBytes } from 'node:crypto';
import { classifyError, retryExceedsCap } from './errors.mjs';
import { ConnectionError, OpcError } from './opc-error.mjs';
import { endsWithRules } from './policy.mjs';

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STATUS_POLL_MS = 5000;
const DEFAULT_IDLE_WAIT_MS = 10000;
const INVESTIGATE_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'lsp', 'webfetch', 'websearch', 'codesearch']);
export const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit']);
// OpenCode registers json_schema output as a tool named StructuredOutput (binary 1.18.32): it is
// the answer itself, not a side effect, so it never counts as "tools ran".
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const VERIFY_RE = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;
const ERROR_CODES = { Timeout: 'turn_timeout', RetryCapExceeded: 'retry_cap', BadRequest: 'bad_request' };

let lastIdMs = 0;
let idCounter = 0;

// Same layout as OpenCode's Identifier.ascending (binary 1.18.32): prefix_ + 12 hex + 14 base62.
export function newMessageId(now = Date.now()) {
  if (now !== lastIdMs) {
    lastIdMs = now;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(now) * 4096n + BigInt(idCounter);
  const head = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) head[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  const random = randomBytes(14);
  let tail = '';
  for (let i = 0; i < 14; i += 1) tail += ID_ALPHABET[random[i] % 62];
  return `msg_${head.toString('hex')}${tail}`;
}

export function phaseFromPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'tool') {
    const tool = String(part.tool ?? '');
    if (tool === STRUCTURED_OUTPUT_TOOL) return 'finalizing';
    if (INVESTIGATE_TOOLS.has(tool)) return 'investigating';
    if (EDIT_TOOLS.has(tool)) return 'editing';
    if (tool === 'task') return 'subagent';
    if (tool === 'bash') return VERIFY_RE.test(String(part.state?.input?.command ?? '')) ? 'verifying' : 'running';
    return 'running';
  }
  if (part.type === 'text' || part.type === 'reasoning' || part.type === 'step-start') return 'running';
  return null;
}

function toolArg(part) {
  const input = part.state?.input ?? {};
  const raw = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.description ?? '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export function filesFromToolPart(part) {
  const input = part.state?.input ?? {};
  const files = [];
  for (const key of ['filePath', 'path', 'file']) if (typeof input[key] === 'string') files.push(input[key]);
  const patch = input.patchText ?? input.patch;
  if (typeof patch === 'string') {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(match[1].trim());
  }
  const metaFiles = part.state?.metadata?.files;
  if (Array.isArray(metaFiles)) {
    for (const f of metaFiles) {
      if (typeof f === 'string') files.push(f);
      else if (typeof f?.filePath === 'string') files.push(f.filePath);
    }
  }
  return files;
}

export function turnMessages(messages, messageID) {
  const list = Array.isArray(messages) ? messages : [];
  const byParent = list.filter((m) => m?.info?.role === 'assistant' && m.info.parentID === messageID);
  if (byParent.length > 0) return byParent;
  const index = list.findIndex((m) => m?.info?.id === messageID);
  return index >= 0 ? list.slice(index + 1).filter((m) => m?.info?.role === 'assistant') : [];
}

function textOf(message) {
  return (message?.parts ?? [])
    .filter((p) => p?.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export function extractTurn(turn, { childMessages = [], diffs = [] } = {}) {
  let finalText = '';
  for (let i = turn.length - 1; i >= 0 && !finalText; i -= 1) finalText = textOf(turn[i]);
  let structured = null;
  for (const m of turn) if (m.info?.structured !== undefined && m.info.structured !== null) structured = m.info.structured;
  const error = [...turn].reverse().find((m) => m.info?.error)?.info.error ?? null;
  const toolParts = [...turn, ...childMessages].flatMap((m) => m?.parts ?? []).filter((p) => p?.type === 'tool' && p.tool !== STRUCTURED_OUTPUT_TOOL);
  const completed = toolParts.filter((p) => p.state?.status === 'completed');
  const touched = new Set();
  for (const part of completed) if (EDIT_TOOLS.has(part.tool)) for (const file of filesFromToolPart(part)) touched.add(file);
  for (const d of Array.isArray(diffs) ? diffs : []) if (typeof d?.file === 'string') touched.add(d.file);
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const m of turn) {
    const t = m.info?.tokens;
    if (t) {
      usage.input += t.input ?? 0;
      usage.output += t.output ?? 0;
      usage.reasoning += t.reasoning ?? 0;
      usage.cacheRead += t.cache?.read ?? 0;
      usage.cacheWrite += t.cache?.write ?? 0;
    }
    usage.cost += m.info?.cost ?? 0;
  }
  return { finalText, structured, error, touchedFiles: [...touched].sort(), toolsRan: completed.length > 0, usage };
}

const isServerDown = (err) => err instanceof ConnectionError && err.code === 'SERVER_DOWN';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPrompt(api, sessionID, body) {
  try {
    await api.promptAsync(sessionID, body);
  } catch (err) {
    if (!(err instanceof ConnectionError) || err.code !== 'TIMEOUT') throw err;
    // spec §5.2: resend only after confirming the messageID did not arrive
    const messages = await api.messages(sessionID, { limit: 50 });
    if (Array.isArray(messages) && messages.some((m) => m?.info?.id === body.messageID)) return;
    await api.promptAsync(sessionID, body);
  }
}

async function applyPermissionPatch(api, sessionID, rules) {
  const updated = await api.patchSession(sessionID, { permission: rules });
  if (!endsWithRules(updated?.permission ?? [], rules)) {
    throw new OpcError('PROFILE_SWITCH_FAILED', `PATCH /session/${sessionID} did not apply the permission rules`);
  }
}

async function waitIdle(api, sessionID, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    try {
      const statuses = await api.sessionStatus();
      const own = statuses?.[sessionID];
      if (!own || own.type === 'idle') return true;
    } catch (err) {
      if (isServerDown(err)) return false;
    }
    await sleep(250);
  }
  return false;
}

function buildBody(request, messageID) {
  const body = { messageID, model: { providerID: request.model.providerID, modelID: request.model.modelID }, parts: request.parts };
  if (request.agent) body.agent = request.agent;
  if (request.variant) body.variant = request.variant;
  if (request.format) body.format = request.format;
  return body;
}

export async function runTurn({
  api,
  hub,
  request,
  onProgress = () => {},
  onPermission = async () => {},
  onQuestion = async () => {},
  onRequestResolved = async () => {},
  signal,
} = {}) {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const statusPollMs = request.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  const idleWaitMs = request.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS;
  const messageID = request.messageID ?? newMessageId();
  const progress = (event) => {
    try {
      onProgress(event);
    } catch {
      // progress reporting must never break the turn
    }
  };

  let sessionID = request.sessionID ?? null;
  if (sessionID) {
    if (request.patchPermission) await applyPermissionPatch(api, sessionID, request.patchPermission);
  } else {
    const created = await api.createSession(request.newSession ?? {});
    sessionID = created.id;
  }
  progress({ phase: 'starting', sessionID, message: `session ${sessionID}` });

  const tracked = new Set([sessionID]);
  const children = new Set();
  const seenRequests = new Set();
  const loggedCalls = new Set();
  let sawBusy = false;
  let toolsRanLive = false;
  let lastPhase = 'starting';
  let forcedError = null;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = (reason, extra = {}) => {
    if (settled) return;
    settled = true;
    resolveDone({ reason, ...extra });
  };
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      if (isServerDown(err)) finish('server-lost');
      else progress({ message: `opc: event handling error: ${err.message}` });
    });
    return queue;
  };
  const setPhase = (phase, message) => {
    if (!phase || phase === lastPhase) {
      if (message) progress({ message });
      return;
    }
    lastPhase = phase;
    progress({ phase, message });
  };

  const addChild = (childID) => {
    if (!childID || tracked.has(childID)) return;
    tracked.add(childID);
    children.add(childID);
    lastPhase = 'subagent';
    progress({ phase: 'subagent', childSessionID: childID, message: `child session ${childID}` });
    if (request.childPermission) {
      api.patchSession(childID, { permission: request.childPermission }).catch((err) => {
        progress({ message: `opc: could not apply invariants to child session ${childID}: ${err.message}` });
      });
    }
  };

  const handlePermission = async (req) => {
    if (!req?.id || seenRequests.has(req.id) || !tracked.has(req.sessionID)) return;
    seenRequests.add(req.id);
    progress({ message: `permission asked (${req.id}): ${req.permission} ${(req.patterns ?? []).join(' ')}`.trim() });
    await onPermission(req);
  };
  const handleQuestion = async (req) => {
    if (!req?.id || seenRequests.has(req.id) || !tracked.has(req.sessionID)) return;
    seenRequests.add(req.id);
    progress({ message: `question asked (${req.id}): ${(req.questions ?? []).map((q) => q.header ?? q.question).join(' | ')}` });
    await onQuestion(req);
  };

  const checkFinished = async () => {
    if (settled) return;
    const messages = await api.messages(sessionID, { limit: 200 });
    const turn = turnMessages(messages, messageID);
    const last = turn.at(-1);
    if (last && (last.info?.time?.completed || last.info?.error)) return finish('idle');
    if (sawBusy) return finish('idle');
    // idle before any activity of this turn: stale status, keep waiting
  };

  const onEvent = (event) =>
    enqueue(async () => {
      if (settled || !event || typeof event.type !== 'string') return;
      const props = event.properties ?? {};
      switch (event.type) {
        case 'session.created':
          if (props.info?.parentID && tracked.has(props.info.parentID)) addChild(props.info.id ?? props.sessionID);
          return;
        case 'session.status': {
          if (props.sessionID !== sessionID) return;
          const status = props.status ?? {};
          if (status.type === 'busy') {
            sawBusy = true;
            if (lastPhase === 'starting') setPhase('running');
          } else if (status.type === 'retry') {
            sawBusy = true;
            lastPhase = 'retrying';
            progress({ phase: 'retrying', message: `retrying (attempt ${status.attempt}): ${status.message ?? ''}`.trim() });
            if (!forcedError && retryExceedsCap(status, request.fallbackCfg ?? {})) {
              forcedError = { name: 'RetryCapExceeded', data: { message: `provider retry over cap (attempt ${status.attempt}): ${status.message ?? ''}` } };
              progress({ message: 'opc: aborting session: provider retry over cap' });
              await api.abort(sessionID);
            }
          } else if (status.type === 'idle') {
            await checkFinished();
          }
          return;
        }
        case 'session.idle':
          if (props.sessionID === sessionID) await checkFinished();
          return;
        case 'session.error':
          if (props.sessionID === sessionID && props.error) finish('session-error', { error: props.error });
          return;
        case 'message.updated':
          if (props.sessionID === sessionID && props.info?.role === 'assistant' && props.info.parentID === messageID) {
            sawBusy = true;
            if (props.info.time?.completed) setPhase('finalizing');
          }
          return;
        case 'message.part.updated': {
          const part = props.part;
          const owner = props.sessionID ?? part?.sessionID;
          if (!part || !tracked.has(owner)) return;
          if (owner === sessionID) sawBusy = true;
          if (part.type === 'tool') {
            const status = part.state?.status;
            if (status === 'completed' && part.tool !== STRUCTURED_OUTPUT_TOOL) toolsRanLive = true;
            const key = String(part.callID ?? part.id);
            if (!loggedCalls.has(key)) {
              loggedCalls.add(key);
              const phase = phaseFromPart(part);
              const arg = toolArg(part);
              if (phase) lastPhase = phase;
              progress({ phase, message: `${part.tool}${arg ? `: ${arg}` : ''}` });
            } else if (status === 'error') {
              progress({ message: `${part.tool} failed: ${String(part.state?.error ?? '').slice(0, 200)}` });
            }
            return;
          }
          if (lastPhase === 'starting') setPhase(phaseFromPart(part));
          return;
        }
        case 'permission.asked':
          await handlePermission(props);
          return;
        case 'question.asked':
          await handleQuestion(props);
          return;
        case 'permission.replied':
          if (tracked.has(props.sessionID)) await onRequestResolved({ type: 'permission', requestID: props.requestID, sessionID: props.sessionID, outcome: props.reply });
          return;
        case 'question.replied':
        case 'question.rejected':
          if (tracked.has(props.sessionID)) await onRequestResolved({ type: 'question', requestID: props.requestID, sessionID: props.sessionID, outcome: event.type === 'question.replied' ? 'replied' : 'rejected' });
          return;
        default:
      }
    });

  const resync = async () => {
    if (settled) return;
    const statuses = await api.sessionStatus();
    const own = statuses?.[sessionID];
    if (own && own.type !== 'idle') sawBusy = true;
    for (const child of (await api.children(sessionID)) ?? []) addChild(child?.id);
    for (const req of (await api.listPermissions()) ?? []) await handlePermission(req);
    for (const req of (await api.listQuestions()) ?? []) await handleQuestion(req);
    if (!own || own.type === 'idle') await checkFinished();
  };

  const untrack = hub.track(sessionID, onEvent);
  const offReconnect = hub.onReconnect(() => enqueue(resync));
  const timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);
  let pollTimer = null;
  const onAbort = () => finish('cancelled');
  if (signal?.aborted) finish('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      await sendPrompt(api, sessionID, buildBody(request, messageID));
    } catch (err) {
      if (isServerDown(err)) finish('server-lost');
      else if (err instanceof OpcError && err.code === 'BAD_REQUEST') finish('prompt-failed', { error: { name: 'BadRequest', data: { message: err.message } } });
      else throw err;
    }
    pollTimer = setInterval(() => enqueue(resync), statusPollMs);
    const outcome = await done;
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    return await buildResult(outcome);
  } finally {
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', onAbort);
    untrack();
    offReconnect();
  }

  async function buildResult(outcome) {
    const base = { sessionID, messageID, childSessionIDs: [...children] };
    const serverLost = () => ({
      ...base,
      status: 'failed',
      errorClass: 'fatal',
      errorType: 'ServerLost',
      errorCode: 'server_lost',
      errorMessage: `OpenCode server was lost mid-turn; session ${sessionID} is preserved, continue with --resume`,
      finalText: '',
      structured: null,
      error: null,
      touchedFiles: [],
      toolsRan: toolsRanLive,
      usage: null,
    });
    if (outcome.reason === 'server-lost') return serverLost();
    if (outcome.reason === 'timeout' || outcome.reason === 'cancelled') {
      try {
        await api.abort(sessionID);
      } catch (err) {
        if (isServerDown(err)) return serverLost();
      }
      await waitIdle(api, sessionID, idleWaitMs);
    }
    let collected;
    try {
      const messages = await api.messages(sessionID, { limit: 200 });
      const childMessages = [];
      for (const child of children) childMessages.push(...((await api.messages(child, { limit: 200 })) ?? []));
      let diffs = [];
      try {
        diffs = (await api.diff(sessionID)) ?? [];
      } catch (err) {
        if (isServerDown(err)) throw err;
      }
      collected = extractTurn(turnMessages(messages, messageID), { childMessages, diffs });
    } catch (err) {
      if (isServerDown(err)) return serverLost();
      throw err;
    }
    const toolsRan = collected.toolsRan || toolsRanLive;
    const result = { ...base, ...collected, toolsRan };
    if (outcome.reason === 'cancelled') {
      return { ...result, status: 'cancelled', errorClass: 'fatal', errorType: 'Cancelled', errorCode: 'cancelled', errorMessage: 'cancelled' };
    }
    let error = collected.error;
    if (outcome.reason === 'timeout') error = { name: 'Timeout', data: { message: `turn exceeded ${timeoutMs} ms and was aborted` } };
    else if (outcome.reason === 'session-error' || outcome.reason === 'prompt-failed') error = outcome.error;
    else if (forcedError) error = forcedError;
    if (!error) return { ...result, status: 'completed', error: null };
    const classified = classifyError(error, { toolsRan });
    return {
      ...result,
      status: 'failed',
      error,
      errorClass: classified.errorClass,
      errorType: classified.errorType,
      errorMessage: classified.message,
      errorCode: ERROR_CODES[classified.errorType] ?? 'model_error',
    };
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/runner.test.mjs`
Expected: PASS (16 testes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/runner.mjs tests/unit/runner.test.mjs
git commit -m "feat(runner): run one OpenCode turn over prompt_async and SSE"
```

---

### Task 6: `lib/api.mjs` — operações de escrita

**Files:**
- Modify: `plugins/opc/scripts/lib/api.mjs` (anexar a função e espalhá-la no objeto de `createApi`)
- Test: `tests/unit/api-write.test.mjs`

**Interfaces:**
- Consumes: `client.post(path, body)`, `client.patch(path, body)` (contrato `http.mjs` da F0; 204 → `null`); `UsageError`.
- Produces (contrato do mestre): `createSession(body)`, `patchSession(id, body)`, `promptAsync(id, body)`, `abort(id)`, `replyPermission(requestID, { reply, message })`, `replyQuestion(id, answers)`, `rejectQuestion(id)` no objeto de `createApi(client)`.
- Produces (novo): `sessionWriteMethods(client)`.
- Defesa em profundidade: `replyPermission` recusa qualquer `reply` além de `once`/`reject` (nunca monta `always`); ids vão com `encodeURIComponent`.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

function recordingClient() {
  const calls = [];
  const record = (method) => async (path, body) => { calls.push([method, path, body]); return method === 'POST' && path.endsWith('/prompt_async') ? null : { ok: true }; };
  return { calls, get: record('GET'), post: record('POST'), patch: record('PATCH') };
}

test('write methods hit the OpenAPI 1.18.32 routes with the right bodies', async () => {
  const client = recordingClient();
  const api = createApi(client);
  await api.createSession({ title: 'OPC: task: x', permission: [] });
  await api.patchSession('ses_1', { permission: [{ permission: '*', pattern: '*', action: 'deny' }] });
  assert.equal(await api.promptAsync('ses_1', { messageID: 'msg_1', parts: [] }), null);
  await api.abort('ses_1');
  await api.replyPermission('per_1', { reply: 'reject', message: 'no' });
  await api.replyPermission('per_2', { reply: 'once' });
  await api.replyQuestion('que_1', [['A'], ['B', 'C']]);
  await api.rejectQuestion('que_2');
  assert.deepEqual(client.calls, [
    ['POST', '/session', { title: 'OPC: task: x', permission: [] }],
    ['PATCH', '/session/ses_1', { permission: [{ permission: '*', pattern: '*', action: 'deny' }] }],
    ['POST', '/session/ses_1/prompt_async', { messageID: 'msg_1', parts: [] }],
    ['POST', '/session/ses_1/abort', undefined],
    ['POST', '/permission/per_1/reply', { reply: 'reject', message: 'no' }],
    ['POST', '/permission/per_2/reply', { reply: 'once' }],
    ['POST', '/question/que_1/reply', { answers: [['A'], ['B', 'C']] }],
    ['POST', '/question/que_2/reject', undefined],
  ]);
});

test('replyPermission never sends "always"; bad answers and ids are refused', () => {
  const api = createApi(recordingClient());
  assert.throws(() => api.replyPermission('per_1', { reply: 'always' }), (e) => e.code === 'INVALID_REPLY');
  assert.throws(() => api.replyQuestion('que_1', ['A']), (e) => e.exitCode === 2);
  assert.throws(() => api.abort(''), (e) => e.exitCode === 2);
  const client = recordingClient();
  createApi(client).abort('ses/../x');
  assert.equal(client.calls[0][1], '/session/ses%2F..%2Fx/abort');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/api-write.test.mjs`
Expected: FAIL — `api.createSession is not a function`.

- [ ] **Step 3: Implementar**

Garantir `import { UsageError } from './opc-error.mjs';` no topo de `api.mjs`. Anexar ao fim:

```js

// ---- F2a: write operations (spec §7, §8.2) ----

const segment = (value, name) => {
  if (typeof value !== 'string' || !value) throw new UsageError('USAGE', `${name} is required`);
  return encodeURIComponent(value);
};

export function sessionWriteMethods(client) {
  return {
    createSession: (body) => client.post('/session', body),
    patchSession: (id, body) => client.patch(`/session/${segment(id, 'sessionID')}`, body),
    promptAsync: (id, body) => client.post(`/session/${segment(id, 'sessionID')}/prompt_async`, body),
    abort: (id) => client.post(`/session/${segment(id, 'sessionID')}/abort`, undefined),
    replyPermission: (requestID, { reply, message } = {}) => {
      if (reply !== 'once' && reply !== 'reject') throw new UsageError('INVALID_REPLY', `permission reply must be once or reject, got "${reply}"`);
      return client.post(`/permission/${segment(requestID, 'requestID')}/reply`, message ? { reply, message } : { reply });
    },
    replyQuestion: (id, answers) => {
      if (!Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) {
        throw new UsageError('USAGE', 'question answers must be string[][]');
      }
      return client.post(`/question/${segment(id, 'questionID')}/reply`, { answers });
    },
    rejectQuestion: (id) => client.post(`/question/${segment(id, 'questionID')}/reject`, undefined),
  };
}
```

E, no objeto devolvido por `createApi(client)` (F1), acrescentar o espalhamento como última entrada:

```js
    ...sessionWriteMethods(client),
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/api-write.test.mjs tests/unit/api.test.mjs`
Expected: PASS (os testes de leitura da F1 continuam verdes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/api.mjs tests/unit/api-write.test.mjs
git commit -m "feat(api): add session, prompt, permission and question writes"
```

---

### Task 7: `lib/jobs.mjs` — registros, limites, worker, espera, cancel

**Files:**
- Create: `plugins/opc/scripts/lib/jobs.mjs`
- Modify: `plugins/opc/scripts/lib/context.mjs` (uma linha em `connectApi`, Step 5)
- Test: `tests/unit/jobs.test.mjs`

**Interfaces:**
- Consumes: `ACTIVE_JOB_STATUSES`, `ensurePrivateDir`, `readJson`, `updateState`, `writeFileAtomic` (F0 `state.mjs`); `PolicyError` (F0); ajusta (não consome) `connectApi(ctx)` → `{ api, server, client }` (F1 `context.mjs`, Step 5); `tryAcquireLock` (F0 `locks.mjs`); `identityMatches`, `isPidAlive`, `spawnDetached`, `terminateProcessGroup` (F0 `process.mjs`); `readServerRecord` (F0 `server.mjs`); `createClient` (F0 `http.mjs`); `createApi` (F1 + Tarefa 6); `redactText`.
- Produces (contrato do mestre): `ACTIVE_STATUSES`, `newJobId(kind)`, `createJob(stateDir, fields)`, `updateJob(stateDir, id, patch)`, `readJob(stateDir, id)`, `listJobs(stateDir, { claudeSessionId, all })`, `resolveJobRef(stateDir, ref, { claudeSessionId, activeOnly })`, `appendJobLog(stateDir, id, line)`, `spawnWorker(ctx, jobId)`, `waitForJob(ctx, id, { waitTimeoutMs, pollMs, onLog })`, `cancelJob(ctx, id)`, `workerMatcher(jobId)`.
- Produces (acréscimos): `createJob(stateDir, fields, { maxActive = 8 })`; `updateJob` aceita `patch` objeto ou função `(job) => patch`; `spawnWorker` devolve `Promise<job>`; `cancelJob(ctx, id, { api, idleWaitMs, exitWaitMs, graceMs })` → `{ job, report: { jobId, aborted, idle, worker } }`; `TERMINAL_STATUSES`, `MAX_TERMINAL_JOBS`, `LOG_LIMIT_BYTES`, `COMPANION_PATH`, `isActive`, `isTerminal`, `jobsDir`, `jobLogPath`, `workerLogPath`, `reconcileJob(stateDir, job)`, `findResumeCandidate(stateDir, { kind, claudeSessionId })`, `groupStatus(members)`, `capLogFile(file, limit)`, `readJobProgress(stateDir, id, maxLines = 4)`, `acquireSessionLock(stateDir, sessionID)` → `release|null`, `serverContext(ctx)`, `existingServerApi(ctx)` → `api|null`, `assertNotInsideServer(env)` (lança `PolicyError('INSIDE_SERVER')`, exit 4, se `env.OPC_INSIDE_SERVER === '1'`); campo novo do job `cancelRequestedAt`; `pendingRequest` é lista ou `null`.
- `ACTIVE_STATUSES` **reexporta** `ACTIVE_JOB_STATUSES` da F0 (mesmo objeto congelado; ninguém redefine a lista). `KIND_PREFIX` cobre todos os kinds das fases (`task`, `review`/`adversarial-review`, `ask`, `plan`, `subagent`/`sub`, `cmd`, `orchestrate`/`orch`, `conclave`/`conclave-member`/`conclave-judge`, `stop-gate`) e `JOB_ID_RE` aceita os prefixos `task|review|ask|plan|sub|cmd|orch|conc|gate`; o id é sempre gerado por `createJob` a partir do `kind`.

Regras (spec §9.1–§9.2):

- Arquivos: `jobs/<id>.json` (fonte de verdade), `jobs/<id>.log` (≤ 5 MB), `jobs/<id>.worker.log`; `state.json.jobs` guarda o índice (id, kind, status, sessão do Claude, grupo) sob `state.lock`.
- `createJob` sob `state.lock`: reconcilia workers perdidos, aplica `jobs.maxActive` (`TOO_MANY_JOBS`, exit 2, com a lista), recusa uma segunda sessão ativa no mesmo `sessionID` (`SESSION_BUSY`, exit 2) e poda para 50 terminais de topo (grupo conta como um; ativos nunca).
- Estado terminal é congelado: depois de `completed/failed/cancelled`, `status` e `phase` não mudam (o cancel vence escritas atrasadas do worker).
- `waitForJob` devolve o job terminal ou em `waiting_permission` com pedido pendente; no prazo, `OpcError('WAIT_TIMEOUT')` com exit 6 e `details.jobId`.
- `cancelJob`: marca `cancelRequestedAt`, aborta a sessão e as filhas (via servidor existente, sem subir outro), espera o idle ≤ 10 s, espera o worker sair sozinho ≤ 2 s e só então sinaliza o grupo — conferindo a identidade antes; pid que não confere nunca recebe sinal.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_STATUSES, MAX_TERMINAL_JOBS, appendJobLog, cancelJob, createJob, findResumeCandidate, groupStatus, jobLogPath,
  listJobs, newJobId, readJob, readJobProgress, resolveJobRef, updateJob, waitForJob, workerMatcher, acquireSessionLock,
  assertNotInsideServer,
} from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ACTIVE_JOB_STATUSES } from '../../plugins/opc/scripts/lib/state.mjs';

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const base = (over = {}) => ({ kind: 'task', title: 'opc task', summary: 's', workspaceRoot: '/ws', claudeSessionId: 'c1', permissionProfile: 'read-only', ...over });

test('newJobId has the spec format per kind', () => {
  assert.match(newJobId('task'), /^task-[0-9a-z]+-[0-9a-z]{6}$/);
  assert.match(newJobId('adversarial-review'), /^review-/);
  assert.match(newJobId('subagent'), /^sub-/);
  assert.match(newJobId('stop-gate'), /^gate-/);
  const ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/;
  const prefixes = { sub: 'sub', cmd: 'cmd', orchestrate: 'orch', orch: 'orch', conclave: 'conc', 'conclave-member': 'conc', 'conclave-judge': 'conc' };
  for (const [kind, prefix] of Object.entries(prefixes)) {
    const id = newJobId(kind);
    assert.ok(id.startsWith(`${prefix}-`), `${kind} → ${id}`);
    assert.match(id, ID_RE);
  }
  assert.throws(() => newJobId('nope'), (e) => e.code === 'UNKNOWN_KIND');
});

test('ACTIVE_STATUSES is the F0 ACTIVE_JOB_STATUSES; assertNotInsideServer refuses OPC_INSIDE_SERVER=1', () => {
  assert.equal(ACTIVE_STATUSES, ACTIVE_JOB_STATUSES);
  assert.doesNotThrow(() => assertNotInsideServer({}));
  assert.doesNotThrow(() => assertNotInsideServer(undefined));
  assert.doesNotThrow(() => assertNotInsideServer({ OPC_INSIDE_SERVER: '0' }));
  assert.throws(() => assertNotInsideServer({ OPC_INSIDE_SERVER: '1' }), (e) => e.code === 'INSIDE_SERVER' && e.exitCode === 4);
});

test('a cmd job id is readable (JOB_ID_RE accepts cmd)', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base({ kind: 'cmd' }));
  assert.match(job.id, /^cmd-/);
  assert.equal(readJob(dir, job.id)?.id, job.id);
});

test('createJob writes a queued record with all spec fields; updateJob merges', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  for (const key of ['id', 'kind', 'title', 'summary', 'workspaceRoot', 'claudeSessionId', 'groupId', 'role', 'status', 'phase', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'pid', 'pidStartTime', 'logFile', 'serverUrlRef', 'sessionID', 'parentSessionID', 'childSessionIDs', 'model', 'attempts', 'agent', 'variant', 'permissionProfile', 'pendingRequest', 'errorCode', 'errorClass', 'errorType', 'errorMessage', 'request', 'result', 'rendered']) {
    assert.ok(key in job, key);
  }
  assert.equal(job.status, 'queued');
  assert.equal((statSync(join(dir, 'jobs', `${job.id}.json`)).mode & 0o777), 0o600);
  const updated = await updateJob(dir, job.id, { status: 'running', phase: 'starting' });
  assert.equal(updated.status, 'running');
  assert.equal(readJob(dir, job.id).phase, 'starting');
  assert.equal(readJob(dir, '../etc/passwd'), null);
});

test('terminal status is frozen (cancel wins over late worker writes)', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  await updateJob(dir, job.id, { status: 'cancelled', phase: 'cancelled' });
  const late = await updateJob(dir, job.id, { status: 'completed', phase: 'done', result: { finalText: 'x' } });
  assert.equal(late.status, 'cancelled');
  assert.equal(late.phase, 'cancelled');
  assert.equal(late.result.finalText, 'x');
});

test('jobs.maxActive refuses new jobs with the active list; SESSION_BUSY per session', async (t) => {
  const dir = stateDir(t);
  await createJob(dir, base({ sessionID: 'ses_a' }), { maxActive: 2 });
  await assert.rejects(createJob(dir, base({ sessionID: 'ses_a' }), { maxActive: 2 }), (e) => e.code === 'SESSION_BUSY' && e.exitCode === 2);
  await createJob(dir, base(), { maxActive: 2 });
  await assert.rejects(createJob(dir, base(), { maxActive: 2 }), (e) => e.code === 'TOO_MANY_JOBS' && e.exitCode === 2 && e.details.active.length === 2);
});

test('queued job without worker for 60 s is reconciled as worker_lost', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  const record = readJob(dir, job.id);
  record.createdAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(join(dir, 'jobs', `${job.id}.json`), JSON.stringify(record));
  await createJob(dir, base(), { maxActive: 1 });
  assert.equal(readJob(dir, job.id).errorCode, 'worker_lost');
});

test('prune keeps 50 terminal top-level jobs (group = one), never active ones', async (t) => {
  const dir = stateDir(t);
  const active = await createJob(dir, base(), { maxActive: 100 });
  const group = await createJob(dir, base({ kind: 'subagent' }), { maxActive: 100 });
  await updateJob(dir, group.id, { status: 'completed', completedAt: '2000-01-01T00:00:00.000Z' });
  const member = await createJob(dir, base({ kind: 'subagent', groupId: group.id, role: 'worker:1' }), { maxActive: 100 });
  await updateJob(dir, member.id, { status: 'completed', completedAt: '2000-01-01T00:00:00.000Z' });
  for (let i = 0; i < MAX_TERMINAL_JOBS; i += 1) {
    const j = await createJob(dir, base(), { maxActive: 100 });
    await updateJob(dir, j.id, { status: 'completed', completedAt: new Date(Date.now() + i).toISOString() });
  }
  await createJob(dir, base(), { maxActive: 100 });
  const ids = listJobs(dir, { all: true }).map((j) => j.id);
  assert.ok(ids.includes(active.id));
  assert.ok(!ids.includes(group.id));
  assert.ok(!ids.includes(member.id));
  assert.equal(listJobs(dir, { all: true }).filter((j) => j.status === 'completed').length, MAX_TERMINAL_JOBS);
});

test('listJobs filters by Claude session unless all', async (t) => {
  const dir = stateDir(t);
  await createJob(dir, base({ claudeSessionId: 'c1' }));
  await createJob(dir, base({ claudeSessionId: 'c2' }));
  assert.equal(listJobs(dir, { claudeSessionId: 'c1' }).length, 1);
  assert.equal(listJobs(dir, { claudeSessionId: 'c1', all: true }).length, 2);
  assert.equal(listJobs(dir).length, 2);
});

test('resolveJobRef: exact, unique prefix, ambiguous, single active in session, several active', async (t) => {
  const dir = stateDir(t);
  const a = await createJob(dir, base());
  assert.equal(resolveJobRef(dir, a.id).id, a.id);
  assert.equal(resolveJobRef(dir, a.id.slice(0, a.id.length - 3)).id, a.id);
  assert.equal(resolveJobRef(dir, null, { claudeSessionId: 'c1', activeOnly: true }).id, a.id);
  const b = await createJob(dir, base());
  assert.throws(() => resolveJobRef(dir, 'task-'), (e) => e.code === 'AMBIGUOUS_JOB');
  assert.throws(() => resolveJobRef(dir, null, { claudeSessionId: 'c1', activeOnly: true }), (e) => e.code === 'MULTIPLE_ACTIVE_JOBS' && e.exitCode === 2);
  await updateJob(dir, a.id, { status: 'completed' });
  await updateJob(dir, b.id, { status: 'completed' });
  assert.throws(() => resolveJobRef(dir, null, { claudeSessionId: 'c1', activeOnly: true }), (e) => e.code === 'NO_ACTIVE_JOB');
  assert.throws(() => resolveJobRef(dir, 'ask-zzz', {}), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => resolveJobRef(dir, '../x', {}), (e) => e.code === 'INVALID_JOB_ID');
});

test('findResumeCandidate: last terminal job of the same kind in this Claude session', async (t) => {
  const dir = stateDir(t);
  const ask = await createJob(dir, base({ kind: 'ask', sessionID: 'ses_ask' }));
  await updateJob(dir, ask.id, { status: 'completed' });
  const task = await createJob(dir, base({ sessionID: 'ses_task' }));
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: 'c1' }), null);
  await updateJob(dir, task.id, { status: 'failed' });
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: 'c1' }).sessionID, 'ses_task');
  assert.equal(findResumeCandidate(dir, { kind: 'ask', claudeSessionId: 'c1' }).sessionID, 'ses_ask');
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: null }), null);
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: 'other' }), null);
});

test('appendJobLog caps the log at 5 MB keeping the tail', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  const chunk = 'y'.repeat(1024 * 1024);
  for (let i = 0; i < 6; i += 1) appendJobLog(dir, job.id, `${i}:${chunk}`);
  appendJobLog(dir, job.id, 'LAST LINE');
  const size = statSync(jobLogPath(dir, job.id)).size;
  assert.ok(size <= 5 * 1024 * 1024, `size ${size}`);
  assert.match(readFileSync(jobLogPath(dir, job.id), 'utf8'), /LAST LINE\n$/);
  assert.deepEqual(readJobProgress(dir, job.id, 1), ['LAST LINE']);
});

test('readJobProgress returns the last N progress lines without timestamps', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  for (const l of ['a', 'b', 'c', 'd', 'e']) appendJobLog(dir, job.id, l);
  assert.deepEqual(readJobProgress(dir, job.id, 4), ['b', 'c', 'd', 'e']);
});

test('groupStatus aggregates members', () => {
  assert.equal(groupStatus([{ status: 'completed' }, { status: 'running' }]), 'running');
  assert.equal(groupStatus([{ status: 'waiting_permission' }, { status: 'running' }]), 'waiting_permission');
  assert.equal(groupStatus([{ status: 'cancelled' }, { status: 'cancelled' }]), 'cancelled');
  assert.equal(groupStatus([{ status: 'failed' }, { status: 'completed' }]), 'completed');
  assert.equal(groupStatus([{ status: 'failed' }, { status: 'cancelled' }]), 'failed');
  assert.deepEqual(ACTIVE_STATUSES, ['queued', 'running', 'waiting_permission']);
});

test('workerMatcher matches only the companion task-worker for that job id', () => {
  const m = workerMatcher('task-abc-123456');
  assert.equal(m(['/usr/bin/node', '/p/scripts/opc-companion.mjs', 'task-worker', '--job-id', 'task-abc-123456']), true);
  assert.equal(m(['/usr/bin/node', '/p/scripts/opc-companion.mjs', 'task-worker', '--job-id', 'task-abc-654321']), false);
  assert.equal(m(['sleep', '30']), false);
});

test('waitForJob returns terminal or waiting_permission, streams log, times out with exit 6', async (t) => {
  const dir = stateDir(t);
  const ctx = { stateDir: dir, env: {} };
  const job = await createJob(dir, base());
  await updateJob(dir, job.id, { status: 'running', pid: null });
  appendJobLog(dir, job.id, 'phase editing');
  const lines = [];
  setTimeout(() => updateJob(dir, job.id, { status: 'completed', phase: 'done' }), 150);
  const done = await waitForJob(ctx, job.id, { pollMs: 20, onLog: (l) => lines.push(l) });
  assert.equal(done.status, 'completed');
  assert.ok(lines.some((l) => l.endsWith('phase editing')));
  const w = await createJob(dir, base());
  await updateJob(dir, w.id, { status: 'waiting_permission', pendingRequest: [{ type: 'permission', id: 'per_1' }] });
  assert.equal((await waitForJob(ctx, w.id, { pollMs: 20 })).status, 'waiting_permission');
  const slow = await createJob(dir, base());
  await updateJob(dir, slow.id, { status: 'running' });
  await assert.rejects(waitForJob(ctx, slow.id, { waitTimeoutMs: 80, pollMs: 20 }), (e) => e.code === 'WAIT_TIMEOUT' && e.exitCode === 6 && e.details.jobId === slow.id);
});

test('cancelJob: aborts the session, never signals a pid whose identity does not match', async (t) => {
  const dir = stateDir(t);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill('SIGKILL'));
  const job = await createJob(dir, base({ sessionID: 'ses_x' }));
  await updateJob(dir, job.id, { status: 'running', pid: sleeper.pid, pidStartTime: 'bogus' });
  const calls = [];
  const api = { async abort(id) { calls.push(id); return true; }, async sessionStatus() { return {}; } };
  const { job: final, report } = await cancelJob({ stateDir: dir, env: {} }, job.id, { api });
  assert.equal(final.status, 'cancelled');
  assert.deepEqual(calls, ['ses_x']);
  assert.equal(report.worker, 'identity-mismatch');
  assert.equal(sleeper.exitCode, null);
  process.kill(sleeper.pid, 0);
  await assert.rejects(cancelJob({ stateDir: dir, env: {} }, job.id, { api }), (e) => e.code === 'NOT_ACTIVE');
});

test('acquireSessionLock is exclusive and validates the id', (t) => {
  const dir = stateDir(t);
  const release = acquireSessionLock(dir, 'ses_abc');
  assert.equal(typeof release, 'function');
  assert.equal(acquireSessionLock(dir, 'ses_abc'), null);
  release();
  assert.throws(() => acquireSessionLock(dir, '../x'), (e) => e.code === 'INVALID_SESSION_ID');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/jobs.test.mjs`
Expected: FAIL com `ERR_MODULE_NOT_FOUND` (`lib/jobs.mjs`).

- [ ] **Step 3: Implementar**

```js
// Job records, worker lifecycle, limits and cancel (spec §9.1–§9.2).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, NotFoundError, OpcError, PolicyError, UsageError } from './opc-error.mjs';
import { redactText } from './redact.mjs';
import { ACTIVE_JOB_STATUSES, ensurePrivateDir, readJson, updateState, writeFileAtomic } from './state.mjs';
import { tryAcquireLock } from './locks.mjs';
import { identityMatches, isPidAlive, spawnDetached, terminateProcessGroup } from './process.mjs';
import { readServerRecord } from './server.mjs';
import { createClient } from './http.mjs';
import { createApi } from './api.mjs';

// Single source of truth for the active states is F0 state.mjs (the setup already uses it).
export const ACTIVE_STATUSES = ACTIVE_JOB_STATUSES;
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const MAX_TERMINAL_JOBS = 50;
export const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
export const COMPANION_PATH = fileURLToPath(new URL('../opc-companion.mjs', import.meta.url));
// Every kind used by F2a..F4c; the id prefix is derived from the kind (callers never pass an id).
const KIND_PREFIX = Object.freeze({
  task: 'task', review: 'review', 'adversarial-review': 'review', ask: 'ask', plan: 'plan',
  subagent: 'sub', sub: 'sub', cmd: 'cmd', orchestrate: 'orch', orch: 'orch',
  conclave: 'conc', 'conclave-member': 'conc', 'conclave-judge': 'conc', 'stop-gate': 'gate',
});
const JOB_ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/;
const JOB_REF_RE = /^[0-9a-z-]+$/;
const SESSION_ID_RE = /^ses[_0-9A-Za-z]+$/;
const QUEUED_WITHOUT_WORKER_MS = 60_000;
const BLOCK_TITLES = new Set(['Final output']);

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isActive = (job) => ACTIVE_STATUSES.includes(job?.status);
export const isTerminal = (job) => TERMINAL_STATUSES.includes(job?.status);
export const jobsDir = (stateDir) => join(stateDir, 'jobs');
const jobPath = (stateDir, id) => join(jobsDir(stateDir), `${id}.json`);
export const jobLogPath = (stateDir, id) => join(jobsDir(stateDir), `${id}.log`);
export const workerLogPath = (stateDir, id) => join(jobsDir(stateDir), `${id}.worker.log`);

export function newJobId(kind) {
  const prefix = KIND_PREFIX[kind];
  if (!prefix) throw new UsageError('UNKNOWN_KIND', `unknown job kind "${kind}"`);
  const rand = Array.from(randomBytes(6), (b) => (b % 36).toString(36)).join('');
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function jobDefaults() {
  return {
    title: null, summary: null, workspaceRoot: null, claudeSessionId: null, groupId: null, role: null,
    startedAt: null, completedAt: null, pid: null, pidStartTime: null, serverUrlRef: null,
    sessionID: null, parentSessionID: null, childSessionIDs: [], model: null, attempts: [], agent: null,
    variant: null, permissionProfile: null, pendingRequest: null, errorCode: null, errorClass: null,
    errorType: null, errorMessage: null, cancelRequestedAt: null, request: null, result: null, rendered: null,
  };
}

function writeJob(stateDir, job) {
  writeFileAtomic(jobPath(stateDir, job.id), `${JSON.stringify(job, null, 2)}\n`);
}

function upsertIndex(state, job) {
  const entry = { id: job.id, kind: job.kind, status: job.status, claudeSessionId: job.claudeSessionId ?? null, groupId: job.groupId ?? null, updatedAt: job.updatedAt };
  state.jobs = [...(state.jobs ?? []).filter((j) => j.id !== job.id), entry];
}

export function readJob(stateDir, id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return null;
  return readJson(jobPath(stateDir, id), null);
}

export function listJobs(stateDir, { claudeSessionId = null, all = false } = {}) {
  let names;
  try {
    names = readdirSync(jobsDir(stateDir));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!JOB_ID_RE.test(id)) continue;
    const job = readJson(jobPath(stateDir, id), null);
    if (job?.id === id) jobs.push(job);
  }
  const visible = all || !claudeSessionId ? jobs : jobs.filter((j) => j.claudeSessionId === claudeSessionId);
  return visible.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
}

export function workerMatcher(jobId) {
  return (cmdline = []) => {
    const i = cmdline.indexOf('task-worker');
    return i > 0 && String(cmdline[i - 1]).endsWith('opc-companion.mjs') && cmdline[i + 1] === '--job-id' && cmdline[i + 2] === jobId;
  };
}

function workerLost(job, now = Date.now()) {
  if (!isActive(job)) return false;
  if (job.pid) return !identityMatches({ pid: job.pid, startTime: job.pidStartTime }, workerMatcher(job.id));
  return job.status === 'queued' && now - Date.parse(job.createdAt) > QUEUED_WITHOUT_WORKER_MS;
}

const lostPatch = () => ({
  status: 'failed', phase: 'failed', completedAt: nowIso(), pendingRequest: null, errorCode: 'worker_lost',
  errorClass: 'fatal', errorType: 'WorkerLost', errorMessage: 'the job worker exited without finishing the job',
});

function pruneTerminal(stateDir, state, jobs) {
  const topLevel = jobs.filter((j) => !j.groupId || j.groupId === j.id);
  const terminal = topLevel.filter((j) => isTerminal(j) && !jobs.some((m) => m.groupId === j.id && isActive(m)));
  terminal.sort((a, b) => String(b.completedAt ?? b.updatedAt).localeCompare(String(a.completedAt ?? a.updatedAt)));
  const doomed = terminal.slice(MAX_TERMINAL_JOBS);
  if (doomed.length === 0) return;
  const ids = new Set();
  for (const job of doomed) {
    ids.add(job.id);
    for (const member of jobs) if (member.groupId === job.id) ids.add(member.id);
  }
  for (const id of ids) {
    for (const file of [jobPath(stateDir, id), jobLogPath(stateDir, id), workerLogPath(stateDir, id)]) rmSync(file, { force: true });
  }
  state.jobs = (state.jobs ?? []).filter((entry) => !ids.has(entry.id));
}

export async function createJob(stateDir, fields, { maxActive = 8 } = {}) {
  ensurePrivateDir(jobsDir(stateDir));
  let created = null;
  await updateState(stateDir, (state) => {
    const jobs = listJobs(stateDir, { all: true });
    for (const job of jobs) {
      if (!workerLost(job)) continue;
      Object.assign(job, lostPatch(), { updatedAt: nowIso() });
      writeJob(stateDir, job);
      upsertIndex(state, job);
    }
    const active = jobs.filter(isActive);
    if (active.length >= maxActive) {
      throw new UsageError('TOO_MANY_JOBS', `jobs.maxActive (${maxActive}) reached; active jobs:\n${active.map((j) => `- ${j.id} (${j.kind}, ${j.status})`).join('\n')}`, {
        details: { active: active.map((j) => ({ id: j.id, kind: j.kind, status: j.status })) },
      });
    }
    if (fields.sessionID) {
      const busy = active.find((j) => j.sessionID === fields.sessionID);
      if (busy) {
        throw new UsageError('SESSION_BUSY', `session ${fields.sessionID} already has an active job (${busy.id}); wait for it or run /opc:cancel ${busy.id}`, { details: { jobId: busy.id } });
      }
    }
    const id = fields.id ?? newJobId(fields.kind);
    const now = nowIso();
    created = { ...jobDefaults(), ...fields, id, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now, logFile: jobLogPath(stateDir, id) };
    writeJob(stateDir, created);
    upsertIndex(state, created);
    pruneTerminal(stateDir, state, jobs);
    return state;
  });
  return created;
}

export async function updateJob(stateDir, id, patch) {
  let updated = null;
  await updateState(stateDir, (state) => {
    const job = readJob(stateDir, id);
    if (!job) throw new NotFoundError('NOT_FOUND', `job ${id} not found`);
    const changes = { ...((typeof patch === 'function' ? patch(job) : patch) ?? {}) };
    if (isTerminal(job)) {
      delete changes.status;
      delete changes.phase;
    }
    updated = { ...job, ...changes, id: job.id, updatedAt: nowIso() };
    writeJob(stateDir, updated);
    upsertIndex(state, updated);
    return state;
  });
  return updated;
}

export async function reconcileJob(stateDir, job) {
  if (!workerLost(job)) return job;
  return updateJob(stateDir, job.id, lostPatch());
}

export function resolveJobRef(stateDir, ref, { claudeSessionId = null, activeOnly = false } = {}) {
  const pool = listJobs(stateDir, { all: true }).filter((j) => !activeOnly || isActive(j));
  if (ref) {
    if (!JOB_REF_RE.test(ref)) throw new UsageError('INVALID_JOB_ID', `invalid job id "${ref}"`);
    const exact = pool.find((j) => j.id === ref);
    if (exact) return exact;
    const matches = pool.filter((j) => j.id.startsWith(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new UsageError('AMBIGUOUS_JOB', `job reference "${ref}" matches ${matches.length} jobs; use a longer id`);
    throw new NotFoundError('NOT_FOUND', activeOnly ? `no active job matches "${ref}"` : `no job matches "${ref}" (see /opc:status)`);
  }
  const scoped = pool.filter((j) => isActive(j) && (!claudeSessionId || j.claudeSessionId === claudeSessionId));
  if (scoped.length === 1) return scoped[0];
  if (scoped.length > 1) {
    throw new UsageError('MULTIPLE_ACTIVE_JOBS', `several jobs are active; pass a job id:\n${scoped.map((j) => `- ${j.id} (${j.kind}, ${j.status})`).join('\n')}`, {
      details: { active: scoped.map((j) => j.id) },
    });
  }
  throw new NotFoundError('NO_ACTIVE_JOB', claudeSessionId ? 'no active opc job in this Claude session' : 'no active opc job');
}

export function findResumeCandidate(stateDir, { kind, claudeSessionId }) {
  if (!claudeSessionId) return null;
  return listJobs(stateDir, { claudeSessionId }).find((j) => j.kind === kind && j.sessionID && isTerminal(j)) ?? null;
}

export function groupStatus(members) {
  if (members.some((m) => m.status === 'waiting_permission')) return 'waiting_permission';
  if (members.some(isActive)) return 'running';
  if (members.length > 0 && members.every((m) => m.status === 'cancelled')) return 'cancelled';
  if (members.some((m) => m.status === 'completed')) return 'completed';
  return 'failed';
}

export function capLogFile(file, limit = LOG_LIMIT_BYTES) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= limit) return;
  const keep = Math.floor(limit * 0.8);
  const buffer = Buffer.alloc(keep);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, keep, size - keep);
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString('utf8');
  const newline = text.indexOf('\n');
  if (newline >= 0 && newline < text.length - 1) text = text.slice(newline + 1);
  writeFileAtomic(file, `[${nowIso()}] [log truncated: kept the last ${keep} bytes]\n${text}`);
}

export function appendJobLog(stateDir, id, line) {
  const text = redactText(String(line ?? '')).replace(/\s+$/, '');
  if (!text) return;
  ensurePrivateDir(jobsDir(stateDir));
  const file = jobLogPath(stateDir, id);
  appendFileSync(file, `[${nowIso()}] ${text}\n`, { mode: 0o600 });
  capLogFile(file);
}

export function readJobProgress(stateDir, id, maxLines = 4) {
  let text;
  try {
    text = readFileTail(jobLogPath(stateDir, id), 64 * 1024);
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('['))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line && !BLOCK_TITLES.has(line))
    .slice(-maxLines);
}

function readFileTail(file, bytes) {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

export function acquireSessionLock(stateDir, sessionID) {
  if (!SESSION_ID_RE.test(String(sessionID))) throw new UsageError('INVALID_SESSION_ID', `invalid session id "${sessionID}"`);
  return tryAcquireLock(join(stateDir, `session-${sessionID}.lock`), { purpose: `job on session ${sessionID}` });
}

export function serverContext(ctx) {
  return {
    stateDir: ctx.stateDir,
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    env: ctx.env,
    hasActiveJobs: () => listJobs(ctx.stateDir, { all: true }).some(isActive),
  };
}

// Recursion guard (spec §9.1): every command that creates a job calls this before connecting.
export function assertNotInsideServer(env) {
  if (env?.OPC_INSIDE_SERVER === '1') {
    throw new PolicyError('INSIDE_SERVER', 'opc refuses to start jobs from inside the OpenCode server (OPC_INSIDE_SERVER=1): delegation cannot recurse');
  }
}

export function existingServerApi(ctx) {
  const env = ctx.env ?? {};
  let baseUrl = env.OPC_SERVER_URL || null;
  let password = env.OPC_SERVER_PASSWORD || null;
  if (!baseUrl) {
    const record = readServerRecord(ctx.stateDir);
    if (!record?.url) return null;
    baseUrl = record.url;
    password = record.password;
  }
  return createApi(createClient({ baseUrl, password, directory: ctx.workspaceRoot, requestTimeoutMs: 5000 }));
}

export async function spawnWorker(ctx, jobId) {
  ensurePrivateDir(jobsDir(ctx.stateDir));
  const { pid, startTime } = spawnDetached(process.execPath, [COMPANION_PATH, 'task-worker', '--job-id', jobId], {
    cwd: ctx.workspaceRoot,
    env: { ...ctx.env, OPC_DATA_DIR: ctx.dataDir },
    logFile: workerLogPath(ctx.stateDir, jobId),
  });
  return updateJob(ctx.stateDir, jobId, (job) => (job.pid ? {} : { pid, pidStartTime: startTime }));
}

function streamLog(file, offset, onLog) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return offset;
  }
  if (size < offset) offset = 0;
  if (size === offset) return offset;
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return offset;
  for (const line of text.slice(0, lastNewline).split('\n')) if (line) onLog(line);
  return offset + Buffer.byteLength(text.slice(0, lastNewline + 1));
}

export async function waitForJob(ctx, id, { waitTimeoutMs = null, pollMs = 500, onLog = null } = {}) {
  const deadline = waitTimeoutMs == null ? Infinity : performance.now() + waitTimeoutMs;
  const logFile = jobLogPath(ctx.stateDir, id);
  let offset = 0;
  for (;;) {
    if (onLog) offset = streamLog(logFile, offset, onLog);
    let job = readJob(ctx.stateDir, id);
    if (!job) throw new NotFoundError('NOT_FOUND', `job ${id} not found`);
    job = await reconcileJob(ctx.stateDir, job);
    if (!isActive(job) || (job.status === 'waiting_permission' && job.pendingRequest?.length)) {
      if (onLog) streamLog(logFile, offset, onLog);
      return job;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new OpcError('WAIT_TIMEOUT', `job ${id} is still ${job.status} (phase ${job.phase}); it keeps running. Follow it with: /opc:status ${id} --wait`, {
        exitCode: ExitCode.WAIT_TIMEOUT,
        details: { jobId: id, status: job.status, phase: job.phase },
      });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

async function waitSessionIdle(api, sessionID, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    const statuses = await api.sessionStatus();
    const own = statuses?.[sessionID];
    if (!own || own.type === 'idle') return true;
    await sleep(250);
  }
  return false;
}

async function waitWorkerExit(expected, matcher, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    if (!identityMatches(expected, matcher)) return true;
    await sleep(100);
  }
  return !identityMatches(expected, matcher);
}

export async function cancelJob(ctx, id, { api = undefined, idleWaitMs = 10000, exitWaitMs = 2000, graceMs = 3000 } = {}) {
  const current = readJob(ctx.stateDir, id);
  if (!current) throw new NotFoundError('NOT_FOUND', `job ${id} not found`);
  if (!isActive(current)) throw new UsageError('NOT_ACTIVE', `job ${id} is already ${current.status}`);
  const job = await updateJob(ctx.stateDir, id, { cancelRequestedAt: nowIso() });
  const report = { jobId: id, aborted: false, idle: false, worker: 'not-running' };
  const client = api === undefined ? existingServerApi(ctx) : api;
  if (client && job.sessionID) {
    try {
      for (const sessionID of [job.sessionID, ...(job.childSessionIDs ?? [])]) await client.abort(sessionID);
      report.aborted = true;
      report.idle = await waitSessionIdle(client, job.sessionID, idleWaitMs);
    } catch (err) {
      appendJobLog(ctx.stateDir, id, `abort request failed: ${err.message}`);
    }
  }
  if (job.pid) {
    const expected = { pid: job.pid, startTime: job.pidStartTime };
    const matcher = workerMatcher(id);
    if (!identityMatches(expected, matcher)) {
      report.worker = isPidAlive(job.pid) ? 'identity-mismatch' : 'not-running';
    } else if (await waitWorkerExit(expected, matcher, exitWaitMs)) {
      report.worker = 'exited';
    } else {
      report.worker = await terminateProcessGroup(expected, matcher, { graceMs });
    }
  }
  appendJobLog(ctx.stateDir, id, 'Cancelled by user.');
  const final = await updateJob(ctx.stateDir, id, {
    status: 'cancelled', phase: 'cancelled', completedAt: nowIso(), pendingRequest: null,
    errorCode: 'cancelled', errorClass: 'fatal', errorType: 'Cancelled', errorMessage: 'Cancelled by user.',
  });
  return { job: final, report };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/jobs.test.mjs`
Expected: PASS (18 testes; o de poda cria ~53 jobs e leva alguns segundos).

- [ ] **Step 5: `connectApi` (F1) passa a usar `serverContext`**

`serverContext(ctx)` é o único construtor do contexto do servidor (inclui `hasActiveJobs`, que o `ensureServer` da F0 consulta). Em `plugins/opc/scripts/lib/context.mjs`, dentro de `connectApi(ctx)` (F1 Task 1, que devolve `{ api, server, client }`), trocar só a linha do literal:

```js
  const serverCtx = { stateDir: ctx.stateDir, workspaceRoot: ctx.workspaceRoot, config: ctx.config, env: ctx.env };
```

por (import dinâmico, como os demais do bloco F1):

```js
  const { serverContext } = await import('./jobs.mjs');
  const serverCtx = serverContext(ctx);
```

O resto do corpo (`ensureServer(serverCtx)`, `clientFor(serverCtx, server)`, `createApi(client)` e o retorno `{ api, server, client }`) fica como está. A partir daqui, `runKindCommand` (Tarefa 10) e os comandos das fases seguintes conectam por `connectApi(ctx)`.

Run: `node --test tests/unit/jobs.test.mjs && npm test`
Expected: PASS — a suíte da F0/F1 (que usa `connectApi` contra o servidor falso) continua verde.

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/lib/jobs.mjs plugins/opc/scripts/lib/context.mjs tests/unit/jobs.test.mjs
git commit -m "feat(jobs): add job records, limits, worker lifecycle and cancel"
```

---

### Task 8: `lib/render.mjs` — status, lista, resultado e pedidos

**Files:**
- Modify: `plugins/opc/scripts/lib/render.mjs` (anexar ao fim)
- Test: `tests/unit/render-jobs.test.mjs`

**Interfaces:**
- Consumes: `renderTable(headers, rows)` (F0, mesmo arquivo).
- Produces (contrato do mestre): `renderJobStatus(job, { progress, now })`, `renderStatusList(jobs, { maxJobs = 8, progressById, now })` (até 8 recentes e 4 linhas de progresso por ativo), `renderTurnResult(job)`, `renderPermissionRequest(job, { timeoutSec })`.
- Produces (novos): `formatDuration(startIso, endIso, now)`, `renderQueuedJob(job)`, `renderCancel(job, report)`, `renderPermissionList(requests, jobs)`.
- Sem I/O: o progresso chega pronto (`readJobProgress` da Tarefa 7). Padrões de permissão vão num bloco de código com cerca mais longa que qualquer sequência de crases do conteúdo.

- [ ] **Step 1: Escrever o teste que falha**

`````js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration, renderCancel, renderJobStatus, renderPermissionList, renderPermissionRequest, renderQueuedJob, renderStatusList, renderTurnResult,
} from '../../plugins/opc/scripts/lib/render.mjs';

const job = (over = {}) => ({
  id: 'task-abc-123456', kind: 'task', status: 'running', phase: 'editing', model: 'p/m', permissionProfile: 'write',
  sessionID: 'ses_1', summary: 'fix the bug', createdAt: '2026-09-26T10:00:00.000Z', startedAt: '2026-09-26T10:00:00.000Z',
  childSessionIDs: [], logFile: '/state/jobs/task-abc-123456.log', ...over,
});

test('formatDuration', () => {
  assert.equal(formatDuration('2026-09-26T10:00:00Z', '2026-09-26T10:00:42Z'), '42s');
  assert.equal(formatDuration('2026-09-26T10:00:00Z', '2026-09-26T10:03:05Z'), '3m 5s');
  assert.equal(formatDuration('2026-09-26T10:00:00Z', '2026-09-26T12:10:00Z'), '2h 10m');
  assert.equal(formatDuration(null), '');
});

test('renderJobStatus: active job shows elapsed, progress and cancel', () => {
  const out = renderJobStatus(job(), { progress: ['read: a.js', 'edit: b.js'], now: Date.parse('2026-09-26T10:01:00Z') });
  assert.match(out, /Status: running \(phase: editing\)/);
  assert.match(out, /Elapsed: 1m 0s/);
  assert.match(out, /Progress:\n  read: a\.js\n  edit: b\.js/);
  assert.match(out, /\/opc:cancel task-abc-123456/);
  assert.doesNotMatch(out, /\/opc:result/);
});

test('renderJobStatus: failed job shows error and resume hint', () => {
  const out = renderJobStatus(job({ status: 'failed', phase: 'failed', errorType: 'ServerLost', errorClass: 'fatal', errorMessage: 'lost', completedAt: '2026-09-26T10:00:30.000Z' }));
  assert.match(out, /Error: ServerLost \(fatal\): lost/);
  assert.match(out, /Duration: 30s/);
  assert.match(out, /\/opc:task --resume task-abc-123456/);
});

test('renderStatusList: max 8 recent, active table, 4 progress lines', () => {
  const jobs = [job({ id: 'task-a-000001' }), ...Array.from({ length: 12 }, (_, i) => job({ id: `task-b-${String(i).padStart(6, '0')}`, status: 'completed', completedAt: '2026-09-26T10:00:10.000Z' }))];
  const out = renderStatusList(jobs, { progressById: { 'task-a-000001': ['1', '2', '3', '4', '5', '6'] } });
  assert.match(out, /Active jobs:/);
  assert.equal((out.match(/\/opc:result task-b-/g) ?? []).length, 8);
  assert.match(out, /- task-a-000001\n    3\n    4\n    5\n    6/);
  assert.equal(renderStatusList([]), '# opc status\n\nNo jobs recorded yet.\n');
  const all = renderStatusList(jobs, { maxJobs: Infinity });
  assert.equal((all.match(/\/opc:result task-b-/g) ?? []).length, 12);
});

test('renderTurnResult: completed text, structured, touched files, resume', () => {
  const out = renderTurnResult(job({ status: 'completed', result: { finalText: 'All good', structured: { ok: true }, touchedFiles: ['a.js'] } }));
  assert.match(out, /^All good\n\nStructured output:\n```json\n\{\n  "ok": true\n\}\n```/);
  assert.match(out, /Touched files: a\.js/);
  assert.match(out, /Continue: \/opc:task --resume task-abc-123456/);
});

test('renderTurnResult: structured error shows raw text; server_lost shows resume', () => {
  const s = renderTurnResult(job({ status: 'failed', errorType: 'StructuredOutputError', errorClass: 'recoverable', errorMessage: 'bad json', result: { finalText: 'raw words' } }));
  assert.match(s, /Raw output \(structured output failed\):\n\nraw words/);
  const l = renderTurnResult(job({ kind: 'ask', status: 'failed', errorType: 'ServerLost', errorCode: 'server_lost', errorMessage: 'lost', result: {} }));
  assert.match(l, /Continue with: \/opc:ask --resume task-abc-123456/);
});

test('renderTurnResult keeps a >1 MB final text intact', () => {
  const text = 'z'.repeat(1_200_000);
  const out = renderTurnResult(job({ status: 'completed', result: { finalText: text } }));
  assert.ok(out.includes(text));
});

test('renderPermissionRequest: ready-made reply lines, child session, needs-user flag, safe fence', () => {
  const out = renderPermissionRequest(job({
    status: 'waiting_permission',
    pendingRequest: [
      { type: 'permission', id: 'per_1', sessionID: 'ses_child', permission: 'bash', patterns: ['rm -rf build ```'], requiresUser: true },
      { type: 'question', id: 'que_1', sessionID: 'ses_1', questions: [{ header: 'DB', question: 'Which?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }, { header: 'F', question: 'Features?', options: [{ label: 'A' }], multiple: true }] },
    ],
  }), { timeoutSec: 600 });
  assert.match(out, /\/opc:permissions reply per_1 once/);
  assert.match(out, /\/opc:permissions reply per_1 reject "<reason>"/);
  assert.match(out, /Session: ses_child \(child session\)/);
  assert.match(out, /Needs the user: yes/);
  assert.match(out, /````text\nrm -rf build ```\n````/);
  assert.match(out, /\/opc:permissions answer que_1 "<answer 1>" "<answer 2>"/);
  assert.match(out, /Options: Postgres \| SQLite/);
  assert.match(out, /\/opc:status task-abc-123456 --wait/);
  assert.match(out, /after 600 s/);
});

test('renderQueuedJob, renderCancel, renderPermissionList', () => {
  assert.match(renderQueuedJob(job({ status: 'queued' })), /queued in background \(task, p\/m\)/);
  assert.match(renderCancel(job(), { aborted: true, idle: true, worker: 'exited' }), /Cancelled task-abc-123456/);
  const list = renderPermissionList([{ type: 'permission', id: 'per_9', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'] }], [job()]);
  assert.match(list, /\| per_9 \| permission \| bash: ls \| ses_1 \| task-abc-123456 \|/);
  assert.match(renderPermissionList([]), /No pending requests/);
});
`````

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/render-jobs.test.mjs`
Expected: FAIL — `does not provide an export named 'formatDuration'`.

- [ ] **Step 3: Implementar**

Anexar ao fim de `render.mjs`:

```js

// ---- F2a: jobs, turns and permission requests ----
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.

const ACTIVE = new Set(['queued', 'running', 'waiting_permission']);
const RESUMABLE_KINDS = new Set(['task', 'ask', 'plan']);

export function formatDuration(startIso, endIso = null, now = Date.now()) {
  const start = Date.parse(startIso ?? '');
  if (!Number.isFinite(start)) return '';
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(end) || end < start) return '';
  const total = Math.round((end - start) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fence(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function codeBlock(text, lang = 'text') {
  const f = fence(text);
  return [`${f}${lang}`, String(text), f];
}

function jobActions(job) {
  const actions = [`/opc:status ${job.id}`];
  if (ACTIVE.has(job.status)) actions.push(`/opc:status ${job.id} --wait`, `/opc:cancel ${job.id}`);
  else actions.push(`/opc:result ${job.id}`);
  return actions;
}

function resumeHint(job) {
  if (!job.sessionID || !RESUMABLE_KINDS.has(job.kind) || ACTIVE.has(job.status)) return null;
  return `/opc:${job.kind} --resume ${job.id}`;
}

export function renderQueuedJob(job) {
  return [
    `opc job ${job.id} queued in background (${job.kind}${job.model ? `, ${job.model}` : ''}).`,
    `- Status: /opc:status ${job.id}`,
    `- Wait: /opc:status ${job.id} --wait`,
    `- Result: /opc:result ${job.id}`,
    `- Cancel: /opc:cancel ${job.id}`,
    '',
  ].join('\n');
}

function pendingLines(job, { timeoutSec = null } = {}) {
  const lines = [];
  for (const req of job.pendingRequest ?? []) {
    if (req.type === 'question') {
      lines.push(`## Question ${req.id}`, '');
      if (req.sessionID && req.sessionID !== job.sessionID) lines.push(`- Session: ${req.sessionID} (child session)`);
      (req.questions ?? []).forEach((q, i) => {
        const options = (q.options ?? []).map((o) => o.label).join(' | ') || '(free text)';
        lines.push(`${i + 1}. [${q.header ?? ''}] ${q.question ?? ''}`, `   Options: ${options}${q.multiple ? ' · several allowed (separate with |)' : ''}${q.custom ? ' · free text allowed' : ''}`);
      });
      const placeholders = (req.questions ?? []).map((_, i) => `"<answer ${i + 1}>"`).join(' ');
      lines.push('', `- Answer: \`/opc:permissions answer ${req.id} ${placeholders}\``, `- Reject: \`/opc:permissions reply ${req.id} reject\``, '');
      continue;
    }
    lines.push(`## Request ${req.id}`, '');
    if (req.sessionID && req.sessionID !== job.sessionID) lines.push(`- Session: ${req.sessionID} (child session)`);
    lines.push(`- Tool: ${req.permission}`, '- Patterns:', ...codeBlock((req.patterns ?? []).join('\n') || '*'));
    if (req.requiresUser) lines.push('- Needs the user: yes (destructive command, external directory or sensitive path)');
    lines.push('- Reply:', `  - \`/opc:permissions reply ${req.id} once\``, `  - \`/opc:permissions reply ${req.id} reject "<reason>"\``, '');
  }
  lines.push(`Afterwards: \`/opc:status ${job.id} --wait\``);
  if (timeoutSec) lines.push(`Unanswered requests are rejected automatically after ${timeoutSec} s.`);
  return lines;
}

export function renderPermissionRequest(job, { timeoutSec = null } = {}) {
  const lines = [
    '# opc: waiting for a decision',
    '',
    `Job: ${job.id} (${job.kind}) · Session: ${job.sessionID ?? '-'}`,
    '',
    ...pendingLines(job, { timeoutSec }),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderJobStatus(job, { progress = [], now = Date.now() } = {}) {
  const active = ACTIVE.has(job.status);
  const lines = [`# opc job ${job.id}`, ''];
  lines.push(`- Status: ${job.status}${job.phase ? ` (phase: ${job.phase})` : ''}`);
  lines.push(`- Kind: ${job.kind} · Profile: ${job.permissionProfile ?? '-'}`);
  lines.push(`- Model: ${job.model ?? '-'}${job.agent ? ` · Agent: ${job.agent}` : ''}${job.variant ? ` · Variant: ${job.variant}` : ''}`);
  if (job.sessionID) lines.push(`- Session: ${job.sessionID}${job.childSessionIDs?.length ? ` (children: ${job.childSessionIDs.join(', ')})` : ''}`);
  if (job.summary) lines.push(`- Summary: ${job.summary}`);
  const time = active ? formatDuration(job.startedAt ?? job.createdAt, null, now) : formatDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt, now);
  if (time) lines.push(`- ${active ? 'Elapsed' : 'Duration'}: ${time}`);
  if (job.status === 'failed') lines.push(`- Error: ${job.errorType ?? 'error'} (${job.errorClass ?? 'fatal'}): ${job.errorMessage ?? ''}`);
  if (job.logFile) lines.push(`- Log: ${job.logFile}`);
  if (job.status === 'waiting_permission' && job.pendingRequest?.length) lines.push('', ...pendingLines(job));
  if (progress.length) lines.push('', 'Progress:', ...progress.map((line) => `  ${line}`));
  const hint = resumeHint(job);
  lines.push('', 'Actions:', ...jobActions(job).map((a) => `- ${a}`), ...(hint ? [`- ${hint}`] : []));
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderStatusList(jobs, { maxJobs = 8, progressById = {}, now = Date.now() } = {}) {
  const active = jobs.filter((j) => ACTIVE.has(j.status));
  const recent = jobs.filter((j) => !ACTIVE.has(j.status)).slice(0, Math.max(0, maxJobs));
  const lines = ['# opc status', ''];
  if (active.length === 0 && recent.length === 0) return '# opc status\n\nNo jobs recorded yet.\n';
  if (active.length) {
    lines.push('Active jobs:', '');
    lines.push(renderTable(
      ['Job', 'Kind', 'Status', 'Phase', 'Elapsed', 'Session', 'Summary', 'Actions'],
      active.map((j) => [j.id, j.kind, j.status, j.phase ?? '', formatDuration(j.startedAt ?? j.createdAt, null, now), j.sessionID ?? '', j.summary ?? '', jobActions(j).slice(1).map((a) => `\`${a}\``).join(' ')]),
    ));
    const withProgress = active.filter((j) => (progressById[j.id] ?? []).length);
    if (withProgress.length) {
      lines.push('', 'Live details:');
      for (const j of withProgress) lines.push(`- ${j.id}`, ...(progressById[j.id] ?? []).slice(-4).map((l) => `    ${l}`));
    }
    lines.push('');
  }
  if (recent.length) {
    lines.push('Recent jobs:', '');
    lines.push(renderTable(
      ['Job', 'Kind', 'Status', 'Duration', 'Summary', 'Actions'],
      recent.map((j) => [j.id, j.kind, j.status, formatDuration(j.startedAt ?? j.createdAt, j.completedAt ?? j.updatedAt, now), j.summary ?? '', `\`/opc:result ${j.id}\``]),
    ));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderTurnResult(job) {
  const r = job.result ?? {};
  const lines = [];
  if (job.status === 'completed') {
    if (r.finalText) lines.push(r.finalText);
    if (r.structured !== null && r.structured !== undefined) {
      if (r.finalText) lines.push('', 'Structured output:');
      lines.push(...codeBlock(JSON.stringify(r.structured, null, 2), 'json'));
    }
    if (!r.finalText && (r.structured === null || r.structured === undefined)) lines.push('(the model returned no final text)');
  } else if (job.status === 'cancelled') {
    lines.push(`# opc job ${job.id} cancelled`);
    if (r.finalText) lines.push('', 'Partial output:', '', r.finalText);
  } else {
    lines.push(`# opc job ${job.id} failed`, '', `- Error: ${job.errorType ?? 'error'} (${job.errorClass ?? 'fatal'}): ${job.errorMessage ?? ''}`);
    if (job.errorCode === 'server_lost' && job.sessionID) {
      lines.push(`- The OpenCode server was lost mid-turn; session ${job.sessionID} is preserved. Continue with: /opc:${RESUMABLE_KINDS.has(job.kind) ? job.kind : 'task'} --resume ${job.id}`);
    }
    if (r.finalText) {
      lines.push('', job.errorType === 'StructuredOutputError' ? 'Raw output (structured output failed):' : 'Partial output:', '', r.finalText);
    }
  }
  lines.push('', '---', `Job: ${job.id} · Session: ${job.sessionID ?? '-'} · Model: ${job.model ?? '-'}`);
  if (r.touchedFiles?.length) lines.push(`Touched files: ${r.touchedFiles.join(', ')}`);
  const hint = resumeHint(job);
  if (hint) lines.push(`Continue: ${hint}`);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderCancel(job, report) {
  return [
    `# opc cancel`,
    '',
    `Cancelled ${job.id} (${job.kind}).`,
    `- Session abort: ${report.aborted ? (report.idle ? 'aborted, session idle' : 'aborted, idle not confirmed in 10 s') : 'not sent (no session or server)'}`,
    `- Worker: ${report.worker}`,
    '- Check `/opc:status` for the updated list.',
    '',
  ].join('\n');
}

export function renderPermissionList(requests, jobs = []) {
  if (requests.length === 0) return '# opc permissions\n\nNo pending requests.\n';
  const jobFor = (sessionID) => jobs.find((j) => j.sessionID === sessionID || (j.childSessionIDs ?? []).includes(sessionID));
  const rows = requests.map((req) => {
    const job = jobFor(req.sessionID);
    const what = req.type === 'question'
      ? (req.questions ?? []).map((q) => q.header ?? q.question).join(' | ')
      : `${req.permission}: ${(req.patterns ?? []).join(' ')}`;
    return [req.id, req.type, what, req.sessionID, job?.id ?? '-'];
  });
  return `# opc permissions\n\n${renderTable(['Id', 'Type', 'Request', 'Session', 'Job'], rows)}\n`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/render-jobs.test.mjs tests/unit/render.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/render.mjs tests/unit/render-jobs.test.mjs
git commit -m "feat(render): render job status, lists, turn results and pending requests"
```


---

### Task 9: Servidor falso — sessões, prompt, permissões, perguntas e cenários

**Files:**
- Create: `tests/fixtures/fake-session-api.mjs`
- Modify: `tests/fixtures/fake-opencode.mjs` (acréscimo ao fim: extensão F2a via `registerFakeExtension` da F0)
- Create: `tests/fixtures/scenarios/structured.mjs`, `structured-error.mjs`, `slow.mjs`, `permission-ask.mjs`, `child-permission-ask.mjs`, `question-ask.mjs`, `reject-siblings.mjs`, `server-dies-mid-turn.mjs`, `retry-status.mjs`, `session-error-event.mjs`, `large-output.mjs`
- Create: `tests/fixtures/expected-rules-f2a.mjs`
- Modify: `tests/helpers.mjs` (anexar helpers F2a)
- Test: `tests/integration/f2a-fixtures.test.mjs`, `tests/integration/f2a-fake-session.test.mjs`

**Interfaces:**
- Consumes: `startFake({ port, password, scenario, stateFile })` e o objeto `fake` da F0 (`fake.state` com `requests`); cenário `{ setup?, onPromptAsync?(fake, sessionID, body) }`.
- Produces: `installSessionApi(fake)` → `{ handle(method, pathname, query, body) → { status, body } | null }`; métodos no `fake`: `event(type, properties)`, `setStatus(sessionID, status)`, `createSession(body, directory)`, `createChildSession(parentID, { title, agent })`, `askPermission(sessionID, { permission, patterns, metadata, always })` → `Promise<{ reply, message?, aborted? }>`, `askQuestion(sessionID, questions)` → `Promise<{ answers } | { rejected: true } | { aborted: true }>`, `emitTurn(sessionID, { text, structured, tools, error, delayMs, parentID, tokens, cost })`, `abortSession(sessionID)`; campos de estado persistidos: `sessions`, `messages`, `permissions`, `questions`, `statuses`, `diffs`, `permissionReplies`, `questionReplies`, `questionRejects`, `aborts`.
- Usa do fake da F0 (já existem, nada a colar): `fake.scenario` (default do cenário carregado), `fake.emit(event)` (SSE `data:` para todas as conexões `/event` abertas), `fake.persist()` (grava `fake.state` no `stateFile`) e `registerFakeExtension(install)`. `fake-session-api.mjs` também exporta `SESSION_API_ROUTES` (as 15 chaves que a extensão registra; `GET /session/status`, `GET /permission` e `GET /question` substituem os stubs da `DEFAULT_ROUTES` da F0).
- Produces (helpers de teste): `F2A_PROVIDER`, `F2A_MODEL_ID`, `F2A_MODEL`, `F2A_POLICY`, `stateDirFor(env, cwd)`, `jobsIn(env, cwd)` (leitura crua via `listJobs(…, { all: true })`, mais novo primeiro), `jobIn(env, cwd, id)`, `requestsTo(env, method, path)` (`path` string exata ou RegExp), `jobIdFrom(output)`, `setupF2a(t, { scenario, config, extraEnv, git })` → `{ cwd, env }`, `opc(ctx, args, { stdin, timeoutMs, env })`; `READ_ONLY_RULES`, `WRITE_RULES`, `NPM_TEST_ONLY_RULES` (literais do §8.1 para `F2A_POLICY`).

Formas seguem a OpenAPI 1.18.32: `POST /session` e `PATCH /session/:id` com `additionalProperties: false` (400 para chave extra), `prompt_async` → 204, `messageID` com prefixo `msg`, `reply` em `once|always|reject` (o fake aceita `always` para que o teste prove que é o **cliente** que nunca o envia), `answers: string[][]`, `PATCH` que **anexa** regras, `reject` que rejeita os irmãos da mesma sessão (com `permission.replied` para cada um), `abort` que encerra o turno com `MessageAbortedError`.

- [ ] **Step 1: Escrever os testes que falham**

`tests/integration/f2a-fixtures.test.mjs` (pré-condição de toda a integração da fase):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { F2A_MODEL_ID, F2A_PROVIDER, makeTempDir } from '../helpers.mjs';

// Precondition of every F2a integration test: the /provider fixture exposes the model and variant used.
test('fixture /provider has the F2a model connected, with variant "high"', async (t) => {
  const password = 'f2a-fixture-password-000000';
  const fake = await startFake({ port: 0, password, scenario: 'ok', stateFile: join(makeTempDir(), 'state.json') });
  t.after(() => fake.close());
  const res = await fetch(`${fake.url}/provider`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  const body = await res.json();
  assert.ok(body.connected.includes(F2A_PROVIDER));
  const provider = body.all.find((p) => p.id === F2A_PROVIDER);
  const model = provider.models[F2A_MODEL_ID];
  assert.ok(model, 'model present');
  assert.ok(Object.keys(model.variants ?? {}).includes('high'), 'variant high present');
});
```

`tests/integration/f2a-fake-session.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { makeTempDir } from '../helpers.mjs';

const PASSWORD = 'f2a-fake-session-password-0000';
const AUTH = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` };

async function openFake(t, scenario) {
  const fake = await startFake({ port: 0, password: PASSWORD, scenario, stateFile: join(makeTempDir(), 'state.json') });
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    fake.close();
  });
  const events = [];
  const response = await fetch(`${fake.url}/event`, { headers: AUTH, signal: controller.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })();
  const call = async (method, path, body) => {
    const res = await fetch(`${fake.url}${path}`, { method, headers: { ...AUTH, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const waitEvent = async (predicate, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = events.filter(predicate);
      if (found.length) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('event not seen');
  };
  return { fake, call, events, waitEvent };
}

test('fake session API: create, prompt_async (204), turn events, messages, status', async (t) => {
  const { call, waitEvent } = await openFake(t, 'ok');
  const bad = await call('POST', '/session', { title: 'x', share: true });
  assert.equal(bad.status, 400);
  const session = (await call('POST', '/session', { title: 'OPC: task: t', permission: [{ permission: '*', pattern: '*', action: 'deny' }] })).body;
  assert.match(session.id, /^ses_/);
  const prompt = await call('POST', `/session/${session.id}/prompt_async`, { messageID: 'msg_0000000000000000000000abcd', model: { providerID: 'p', modelID: 'm/x' }, parts: [{ type: 'text', text: 'hi' }] });
  assert.equal(prompt.status, 204);
  await waitEvent((e) => e.type === 'session.idle' && e.properties.sessionID === session.id);
  const messages = (await call('GET', `/session/${session.id}/message?limit=10`)).body;
  assert.equal(messages[0].info.id, 'msg_0000000000000000000000abcd');
  assert.equal(messages[1].info.parentID, 'msg_0000000000000000000000abcd');
  assert.equal(messages[1].parts.at(-1).text, 'fake-opencode: ok');
  assert.deepEqual((await call('GET', '/session/status')).body, {});
});

test('fake session API: PATCH appends permission rules (as OpenCode 1.18.32)', async (t) => {
  const { call } = await openFake(t, 'ok');
  const a = [{ permission: 'bash', pattern: '*', action: 'deny' }];
  const b = [{ permission: 'edit', pattern: '*', action: 'deny' }];
  const session = (await call('POST', '/session', { title: 't', permission: a })).body;
  const patched = (await call('PATCH', `/session/${session.id}`, { permission: b })).body;
  assert.deepEqual(patched.permission, [...a, ...b]);
});

test('fake session API: reject rejects the sibling; always stays accepted by the fake (the client refuses it)', async (t) => {
  const { call, waitEvent, fake } = await openFake(t, 'reject-siblings');
  const session = (await call('POST', '/session', { title: 't' })).body;
  await call('POST', `/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'go' }] });
  const asked = await waitEvent((e) => e.type === 'permission.asked' && e.properties.permission === 'edit');
  assert.equal(asked.length, 1);
  const pending = (await call('GET', '/permission')).body;
  assert.equal(pending.length, 2);
  assert.equal((await call('POST', `/permission/${pending[0].id}/reply`, { reply: 'reject' })).status, 200);
  const replied = await waitEvent((e) => e.type === 'permission.replied' && e.properties.requestID === pending[1].id);
  assert.equal(replied[0].properties.reply, 'reject');
  await waitEvent((e) => e.type === 'session.idle');
  assert.equal(fake.state.permissionReplies.length, 2);
});

test('fake session API: question reply validates string[][]; abort ends a busy turn with MessageAbortedError', async (t) => {
  const { call, waitEvent } = await openFake(t, 'question-ask');
  const session = (await call('POST', '/session', { title: 't' })).body;
  await call('POST', `/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'ask' }] });
  const [asked] = await waitEvent((e) => e.type === 'question.asked');
  assert.equal((await call('POST', `/question/${asked.properties.id}/reply`, { answers: ['Postgres'] })).status, 400);
  assert.equal((await call('POST', `/session/${session.id}/abort`)).status, 200);
  await waitEvent((e) => e.type === 'session.idle');
  const messages = (await call('GET', `/session/${session.id}/message`)).body;
  assert.equal(messages.at(-1).info.error.name, 'MessageAbortedError');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/f2a-fixtures.test.mjs tests/integration/f2a-fake-session.test.mjs`
Expected: `f2a-fake-session` FAIL (rotas `/session` inexistentes → 404; cenários ausentes). `f2a-fixtures` pode já passar; se falhar, acrescentar a variant na fixture de `/provider` da F1 (arquivo servido pela rota `GET /provider` em `tests/fixtures/data/`), dentro do modelo `opencode-go/deepseek-v4.1-flash` do provider `omniroute-mvalmeida`:

```json
"variants": { "high": {}, "low": {} }
```

(se o provider ou o modelo não existirem na fixture, copiar a entrada real de `opencode models --verbose` do operador, redigida, mantendo `connected` com `omniroute-mvalmeida`).

- [ ] **Step 3: Implementar a API de sessão do fake**

```js
// Session, prompt, permission and question routes of the fake OpenCode server (F2a).
// Shapes follow the OpenAPI of OpenCode 1.18.32; PATCH /session/:id appends permission rules,
// like the 1.18.32 binary (`merge(old, new)` = concatenation).
import { randomBytes } from 'node:crypto';

const SESSION_KEYS = new Set(['parentID', 'title', 'agent', 'model', 'metadata', 'permission', 'workspaceID']);
const PATCH_KEYS = new Set(['title', 'metadata', 'permission', 'time']);
const PROMPT_KEYS = new Set(['messageID', 'model', 'agent', 'noReply', 'tools', 'format', 'system', 'variant', 'parts']);
const REPLIES = new Set(['once', 'always', 'reject']);
const ACTIONS = new Set(['allow', 'deny', 'ask']);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const nextId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}${Array.from(randomBytes(14), (b) => BASE62[b % 62]).join('')}`;
const invalid = (message) => ({ status: 400, body: { _tag: 'InvalidRequestError', message } });
const notFound = (tag, message) => ({ status: 404, body: { _tag: tag, message } });
const ok = (body) => ({ status: 200, body });
const extraKeys = (body, allowed) => Object.keys(body ?? {}).filter((key) => !allowed.has(key));
const validRules = (rules) => Array.isArray(rules) && rules.every((r) => r && typeof r.permission === 'string' && typeof r.pattern === 'string' && ACTIONS.has(r.action) && Object.keys(r).length === 3);

export function installSessionApi(fake) {
  const state = fake.state;
  for (const key of ['sessions', 'messages', 'permissions', 'questions', 'statuses', 'diffs']) state[key] ??= {};
  for (const key of ['permissionReplies', 'questionReplies', 'questionRejects', 'aborts']) state[key] ??= [];
  const waiters = new Map();
  const turns = new Map();
  const persist = () => fake.persist();
  const event = (type, properties) => fake.emit({ id: nextId('evt'), type, properties });

  const settle = (requestID, outcome) => {
    const resolve = waiters.get(requestID);
    waiters.delete(requestID);
    resolve?.(outcome);
  };

  fake.event = event;

  fake.setStatus = (sessionID, status) => {
    if (status.type === 'idle') delete state.statuses[sessionID];
    else state.statuses[sessionID] = status;
    persist();
    event('session.status', { sessionID, status });
  };

  fake.createSession = (body = {}, directory = '') => {
    const time = Date.now();
    const session = {
      id: nextId('ses'), slug: `fake-${randomBytes(3).toString('hex')}`, projectID: 'prj_fake', directory,
      title: body.title ?? 'New session', version: '1.18.32', time: { created: time, updated: time },
      permission: body.permission ?? [],
      ...(body.parentID ? { parentID: body.parentID } : {}),
      ...(body.agent ? { agent: body.agent } : {}),
    };
    state.sessions[session.id] = session;
    state.messages[session.id] = [];
    persist();
    event('session.created', { sessionID: session.id, info: session });
    return session;
  };

  fake.createChildSession = (parentID, { title = 'child (@general subagent)', agent = 'general' } = {}) =>
    fake.createSession({ parentID, title, agent }, state.sessions[parentID]?.directory ?? '');

  fake.askPermission = (sessionID, { permission, patterns, metadata = {}, always = [] }) => {
    const request = { id: nextId('per'), sessionID, permission, patterns, metadata, always };
    state.permissions[request.id] = request;
    persist();
    event('permission.asked', request);
    return new Promise((resolve) => waiters.set(request.id, resolve));
  };

  fake.askQuestion = (sessionID, questions) => {
    const request = { id: nextId('que'), sessionID, questions };
    state.questions[request.id] = request;
    persist();
    event('question.asked', request);
    return new Promise((resolve) => waiters.set(request.id, resolve));
  };

  fake.emitTurn = async (sessionID, {
    text = 'fake-opencode: ok', structured, tools = [], error, delayMs = 20, parentID,
    tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost = 0,
  } = {}) => {
    const session = state.sessions[sessionID];
    const turn = { aborted: false, timers: new Set() };
    turns.set(sessionID, turn);
    const wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(() => { turn.timers.delete(timer); resolve(); }, ms);
      turn.timers.add(timer);
    });
    const info = {
      id: nextId('msg'), sessionID, role: 'assistant', parentID: parentID ?? session.lastUserMessageID,
      time: { created: Date.now() }, modelID: session.lastModel?.modelID ?? 'fake-model',
      providerID: session.lastModel?.providerID ?? 'fake', mode: 'build', agent: 'build',
      path: { cwd: session.directory, root: session.directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const message = { info, parts: [] };
    fake.setStatus(sessionID, { type: 'busy' });
    state.messages[sessionID].push(message);
    persist();
    event('message.updated', { sessionID, info });
    for (const tool of tools) {
      await wait(delayMs);
      if (turn.aborted) return;
      const start = Date.now();
      const part = { id: nextId('prt'), sessionID, messageID: info.id, type: 'tool', callID: nextId('call'), tool: tool.tool, state: { status: 'running', input: tool.input ?? {}, time: { start } } };
      message.parts.push(part);
      event('message.part.updated', { sessionID, part, time: Date.now() });
      await wait(delayMs);
      if (turn.aborted) return;
      part.state = { status: 'completed', input: tool.input ?? {}, output: tool.output ?? '', title: tool.tool, metadata: tool.metadata ?? {}, time: { start, end: Date.now() } };
      persist();
      event('message.part.updated', { sessionID, part, time: Date.now() });
    }
    await wait(delayMs);
    if (turn.aborted) return;
    if (text) {
      const part = { id: nextId('prt'), sessionID, messageID: info.id, type: 'text', text, time: { start: Date.now(), end: Date.now() } };
      message.parts.push(part);
      event('message.part.updated', { sessionID, part, time: Date.now() });
    }
    await wait(delayMs);
    if (turn.aborted) return;
    info.time.completed = Date.now();
    info.finish = structured === undefined ? 'stop' : 'tool-calls';
    info.tokens = tokens;
    info.cost = cost;
    if (structured !== undefined) info.structured = structured;
    if (error) info.error = error;
    persist();
    event('message.updated', { sessionID, info });
    if (error) event('session.error', { sessionID, error });
    turns.delete(sessionID);
    fake.setStatus(sessionID, { type: 'idle' });
    event('session.idle', { sessionID });
  };

  fake.abortSession = (sessionID) => {
    state.aborts.push(sessionID);
    const turn = turns.get(sessionID);
    if (turn) {
      turn.aborted = true;
      for (const timer of turn.timers) clearTimeout(timer);
      turns.delete(sessionID);
    }
    for (const [id, request] of [...Object.entries(state.permissions), ...Object.entries(state.questions)]) {
      if (request.sessionID !== sessionID) continue;
      delete state.permissions[id];
      delete state.questions[id];
      settle(id, { reply: 'reject', aborted: true });
    }
    if (state.statuses[sessionID]) {
      const messages = state.messages[sessionID] ?? [];
      let last = messages.at(-1);
      if (!last || last.info.role !== 'assistant' || last.info.time.completed) {
        last = { info: { id: nextId('msg'), sessionID, role: 'assistant', parentID: state.sessions[sessionID]?.lastUserMessageID, time: { created: Date.now() }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] };
        messages.push(last);
      }
      last.info.error = { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } };
      last.info.time.completed = Date.now();
      event('message.updated', { sessionID, info: last.info });
      fake.setStatus(sessionID, { type: 'idle' });
      event('session.idle', { sessionID });
    }
    persist();
  };

  const routes = [
    ['POST', /^\/session$/, (m, query, body) => {
      const extra = extraKeys(body, SESSION_KEYS);
      if (extra.length) return invalid(`unexpected keys: ${extra.join(', ')}`);
      if (body?.permission !== undefined && !validRules(body.permission)) return invalid('permission must be an array of {permission, pattern, action}');
      if (body?.parentID !== undefined && !/^ses/.test(body.parentID)) return invalid('parentID must start with ses');
      return ok(fake.createSession(body ?? {}, query.get('directory') ?? ''));
    }],
    ['GET', /^\/session$/, () => ok(Object.values(state.sessions))],
    ['GET', /^\/session\/status$/, () => ok({ ...state.statuses })],
    ['GET', /^\/session\/(ses[^/]+)$/, (m) => (state.sessions[m[1]] ? ok(state.sessions[m[1]]) : notFound('NotFoundError', `session ${m[1]} not found`))],
    ['PATCH', /^\/session\/(ses[^/]+)$/, (m, query, body) => {
      const session = state.sessions[m[1]];
      if (!session) return notFound('NotFoundError', `session ${m[1]} not found`);
      const extra = extraKeys(body, PATCH_KEYS);
      if (extra.length) return invalid(`unexpected keys: ${extra.join(', ')}`);
      if (body?.permission !== undefined) {
        if (!validRules(body.permission)) return invalid('permission must be an array of {permission, pattern, action}');
        session.permission = [...(session.permission ?? []), ...body.permission];
      }
      if (typeof body?.title === 'string') session.title = body.title;
      session.time.updated = Date.now();
      persist();
      event('session.updated', { sessionID: session.id, info: session });
      return ok(session);
    }],
    ['POST', /^\/session\/(ses[^/]+)\/prompt_async$/, (m, query, body) => {
      const session = state.sessions[m[1]];
      if (!session) return notFound('NotFoundError', `session ${m[1]} not found`);
      const extra = extraKeys(body, PROMPT_KEYS);
      if (extra.length) return invalid(`unexpected keys: ${extra.join(', ')}`);
      if (!Array.isArray(body?.parts)) return invalid('parts is required');
      if (body.messageID !== undefined && !/^msg/.test(body.messageID)) return invalid('messageID must start with msg');
      if (body.model !== undefined && (typeof body.model.providerID !== 'string' || typeof body.model.modelID !== 'string' || Object.keys(body.model).length !== 2)) return invalid('model must be {providerID, modelID}');
      const id = body.messageID ?? nextId('msg');
      state.messages[session.id].push({
        info: { id, sessionID: session.id, role: 'user', time: { created: Date.now() }, agent: body.agent ?? 'build', ...(body.model ? { model: body.model } : {}), ...(body.format ? { format: body.format } : {}) },
        parts: body.parts.map((part) => ({ id: nextId('prt'), sessionID: session.id, messageID: id, ...part })),
      });
      session.lastUserMessageID = id;
      session.lastModel = body.model ?? null;
      persist();
      setImmediate(() => {
        const hook = fake.scenario?.onPromptAsync;
        Promise.resolve(hook ? hook(fake, session.id, body) : fake.emitTurn(session.id)).catch((err) => {
          process.stderr.write(`fake-opencode scenario error: ${err.stack}\n`);
        });
      });
      return { status: 204, body: null };
    }],
    ['POST', /^\/session\/(ses[^/]+)\/abort$/, (m) => {
      fake.abortSession(m[1]);
      return ok(true);
    }],
    ['GET', /^\/session\/(ses[^/]+)\/message$/, (m, query) => {
      const messages = state.messages[m[1]];
      if (!messages) return notFound('NotFoundError', `session ${m[1]} not found`);
      const limit = Number(query.get('limit'));
      return ok(Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages);
    }],
    ['GET', /^\/session\/(ses[^/]+)\/children$/, (m) => ok(Object.values(state.sessions).filter((s) => s.parentID === m[1]))],
    ['GET', /^\/session\/(ses[^/]+)\/diff$/, (m) => ok(state.diffs[m[1]] ?? [])],
    ['GET', /^\/permission$/, () => ok(Object.values(state.permissions))],
    ['POST', /^\/permission\/(per[^/]+)\/reply$/, (m, query, body) => {
      const extra = extraKeys(body, new Set(['reply', 'message']));
      if (extra.length || !REPLIES.has(body?.reply)) return invalid('body must be {reply: once|always|reject, message?}');
      const request = state.permissions[m[1]];
      if (!request) return { status: 404, body: { _tag: 'PermissionNotFoundError', requestID: m[1], message: 'not found' } };
      delete state.permissions[m[1]];
      state.permissionReplies.push({ requestID: m[1], reply: body.reply, message: body.message ?? null });
      event('permission.replied', { sessionID: request.sessionID, requestID: m[1], reply: body.reply });
      settle(m[1], { reply: body.reply, message: body.message });
      if (body.reply === 'reject') {
        for (const sibling of Object.values(state.permissions)) {
          if (sibling.sessionID !== request.sessionID) continue;
          delete state.permissions[sibling.id];
          state.permissionReplies.push({ requestID: sibling.id, reply: 'reject', message: null, sibling: true });
          event('permission.replied', { sessionID: sibling.sessionID, requestID: sibling.id, reply: 'reject' });
          settle(sibling.id, { reply: 'reject' });
        }
      }
      persist();
      return ok(true);
    }],
    ['GET', /^\/question$/, () => ok(Object.values(state.questions))],
    ['POST', /^\/question\/(que[^/]+)\/reply$/, (m, query, body) => {
      const answers = body?.answers;
      if (extraKeys(body, new Set(['answers'])).length || !Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) {
        return invalid('body must be {answers: string[][]}');
      }
      const request = state.questions[m[1]];
      if (!request) return { status: 404, body: { _tag: 'QuestionNotFoundError', requestID: m[1], message: 'not found' } };
      delete state.questions[m[1]];
      state.questionReplies.push({ requestID: m[1], answers });
      persist();
      event('question.replied', { sessionID: request.sessionID, requestID: m[1], answers });
      settle(m[1], { answers });
      return ok(true);
    }],
    ['POST', /^\/question\/(que[^/]+)\/reject$/, (m) => {
      const request = state.questions[m[1]];
      if (!request) return { status: 404, body: { _tag: 'QuestionNotFoundError', requestID: m[1], message: 'not found' } };
      delete state.questions[m[1]];
      state.questionRejects.push({ requestID: m[1] });
      persist();
      event('question.rejected', { sessionID: request.sessionID, requestID: m[1] });
      settle(m[1], { rejected: true });
      return ok(true);
    }],
  ];

  return {
    handle(method, pathname, query, body) {
      for (const [routeMethod, pattern, handler] of routes) {
        if (routeMethod !== method) continue;
        const match = pattern.exec(pathname);
        if (match) return handler(match, query, body);
      }
      return null;
    },
  };
}

// Route keys served by installSessionApi; registered over the F0 DEFAULT_ROUTES stubs by the F2a extension
// at the end of tests/fixtures/fake-opencode.mjs.
export const SESSION_API_ROUTES = Object.freeze([
  'POST /session', 'GET /session', 'GET /session/status', 'GET /session/:id', 'PATCH /session/:id',
  'POST /session/:id/prompt_async', 'POST /session/:id/abort', 'GET /session/:id/message',
  'GET /session/:id/children', 'GET /session/:id/diff',
  'GET /permission', 'POST /permission/:id/reply',
  'GET /question', 'POST /question/:id/reply', 'POST /question/:id/reject',
]);
```

- [ ] **Step 4: Registrar a API de sessão como extensão do fake da F0**

Acrescentar ao **fim** de `tests/fixtures/fake-opencode.mjs` (depois do bloco da F1; o roteador da F0 não é editado). `installSessionApi` roda uma vez por `startFake`, antes do `setup` do cenário (os cenários podem chamar `fake.createSession`, `fake.emitTurn` etc. no `setup`); rotas de cenário continuam vencendo e, se devolverem `undefined`, caem nesta extensão:

```js

// ---- F2a: session, prompt, permission and question API (tests/fixtures/fake-session-api.mjs) ----
import { SESSION_API_ROUTES, installSessionApi } from './fake-session-api.mjs';

registerFakeExtension((fake) => {
  const api = installSessionApi(fake);
  const handler = (_fake, { method, path: pathname, query, body }) =>
    api.handle(method, pathname, new URLSearchParams(query), body)
    ?? { status: 404, body: { name: 'NotFoundError', data: { message: `no route ${method} ${pathname}` } } };
  return Object.fromEntries(SESSION_API_ROUTES.map((key) => [key, handler]));
});
// ---- end F2a ----
```

(O roteador da F0 escreve `204` sem corpo para `{ status: 204, body: null }` e JSON para os demais.) Conferido em cópia de rascunho: F0 + fixtures/extensão da F1 + este bloco → os 5 testes desta tarefa e toda a suíte da F0 verdes.

- [ ] **Step 5: Criar os cenários (um arquivo cada)**

`tests/fixtures/scenarios/structured.mjs`:

```js
// Structured output: OpenCode answers through the StructuredOutput tool and fills info.structured.
export default {
  async onPromptAsync(fake, sessionID) {
    const structured = { verdict: 'approve', count: 3 };
    await fake.emitTurn(sessionID, { text: '', structured, tools: [{ tool: 'StructuredOutput', input: structured, output: 'Structured output captured successfully.' }] });
  },
};
```

`tests/fixtures/scenarios/structured-error.mjs`:

```js
// Structured output failure without other tools: raw text + StructuredOutputError (recoverable).
export default {
  async onPromptAsync(fake, sessionID) {
    await fake.emitTurn(sessionID, {
      text: 'raw text answer that is not valid JSON',
      error: { name: 'StructuredOutputError', data: { message: 'model output did not match the schema', retries: 1 } },
    });
  },
};
```

`tests/fixtures/scenarios/slow.mjs`:

```js
// Long turn (~15 s) so tests can cancel, time out or run two jobs at once.
export default {
  async onPromptAsync(fake, sessionID) {
    await fake.emitTurn(sessionID, { text: 'slow turn finished', tools: [{ tool: 'read', input: { filePath: 'README.md' } }], delayMs: 3000 });
  },
};
```

`tests/fixtures/scenarios/permission-ask.mjs`:

```js
// The turn asks for bash (FAKE_PERMISSION_COMMAND, default "rm -rf build") and continues with the reply.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const command = process.env.FAKE_PERMISSION_COMMAND || 'rm -rf build';
    const outcome = await fake.askPermission(sessionID, { permission: 'bash', patterns: [command], metadata: { command }, always: [`${command.split(' ')[0]} *`] });
    if (outcome.aborted) return;
    if (outcome.reply === 'reject') {
      await fake.emitTurn(sessionID, { text: `rejected: ${outcome.message ?? ''}`.trim() });
      return;
    }
    await fake.emitTurn(sessionID, { text: `approved (${outcome.reply}) and ran: ${command}`, tools: [{ tool: 'bash', input: { command } }] });
  },
};
```

`tests/fixtures/scenarios/child-permission-ask.mjs`:

```js
// A subagent (child session) asks for a destructive bash command; the request must reach the job.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const child = fake.createChildSession(sessionID, { title: 'cleanup (@general subagent)', agent: 'general' });
    const outcome = await fake.askPermission(child.id, { permission: 'bash', patterns: ['rm -rf dist'], metadata: { command: 'rm -rf dist' }, always: ['rm *'] });
    if (outcome.aborted) return;
    await fake.emitTurn(sessionID, { text: `child ${child.id}: ${outcome.reply}`, tools: [{ tool: 'task', input: { description: 'cleanup', subagent_type: 'general' } }] });
  },
};
```

`tests/fixtures/scenarios/question-ask.mjs`:

```js
// Three questions (single choice, multiple choice, free text) in one question request.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const outcome = await fake.askQuestion(sessionID, [
      { question: 'Which database should the service use?', header: 'Database', options: [{ label: 'Postgres', description: 'Relational, server' }, { label: 'SQLite', description: 'Embedded' }], custom: false },
      { question: 'Which features are in scope?', header: 'Features', options: [{ label: 'A', description: 'Auth' }, { label: 'B', description: 'Billing' }, { label: 'C', description: 'Search' }], multiple: true, custom: false },
      { question: 'Name of the service?', header: 'Name', options: [{ label: 'default', description: 'Use the repository name' }], custom: true },
    ]);
    if (outcome.aborted) return;
    await fake.emitTurn(sessionID, { text: outcome.rejected ? 'question rejected' : `answers: ${JSON.stringify(outcome.answers)}` });
  },
};
```

`tests/fixtures/scenarios/reject-siblings.mjs`:

```js
// Two pending requests in the same session; rejecting one rejects the sibling (OpenCode 1.18.32).
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const first = fake.askPermission(sessionID, { permission: 'bash', patterns: ['rm -rf build'], metadata: { command: 'rm -rf build' }, always: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fake.askPermission(sessionID, { permission: 'edit', patterns: ['src/app.js'], metadata: {}, always: [] });
    const outcomes = await Promise.all([first, second]);
    if (outcomes.some((o) => o.aborted)) return;
    await fake.emitTurn(sessionID, { text: `outcomes: ${outcomes.map((o) => o.reply).join(',')}` });
  },
};
```

`tests/fixtures/scenarios/server-dies-mid-turn.mjs`:

```js
// The server process dies while the turn is busy (only usable through the fake binary).
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    setTimeout(() => process.exit(1), 300);
  },
};
```

`tests/fixtures/scenarios/retry-status.mjs`:

```js
// OpenCode retries a 429 by itself (session.status retry) and then completes.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    fake.setStatus(sessionID, { type: 'retry', attempt: 1, message: 'APIError 429: rate limited', next: Date.now() + 500 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    fake.setStatus(sessionID, { type: 'busy' });
    await fake.emitTurn(sessionID, { text: 'recovered after retry' });
  },
};
```

`tests/fixtures/scenarios/session-error-event.mjs`:

```js
// The turn fails through a session.error event (ProviderAuthError: fatal).
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.event('session.error', { sessionID, error: { name: 'ProviderAuthError', data: { providerID: 'omniroute-mvalmeida', message: 'invalid credentials for provider' } } });
    fake.setStatus(sessionID, { type: 'idle' });
    fake.event('session.idle', { sessionID });
  },
};
```

`tests/fixtures/scenarios/large-output.mjs`:

```js
// A final answer larger than 1 MB.
export default {
  async onPromptAsync(fake, sessionID) {
    const lines = Array.from({ length: 13000 }, (_, i) => `line ${i} ${'x'.repeat(90)}`);
    await fake.emitTurn(sessionID, { text: `${lines.join('\n')}\nEND-OF-LARGE-OUTPUT` });
  },
};
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/integration/f2a-fixtures.test.mjs tests/integration/f2a-fake-session.test.mjs`
Expected: PASS (5 testes). Rodar também `npm run test:integration` para confirmar que F0/F1 seguem verdes.

- [ ] **Step 7: Regras esperadas e helpers de teste**

`tests/fixtures/expected-rules-f2a.mjs` (literais do §8.1 para a política de teste; digitados, não calculados):

```js
// Literal permission rules expected for F2A_POLICY (tests/helpers.mjs), spec §8.1, in send order.
const r = (permission, pattern, action) => ({ permission, pattern, action });

const SENSITIVE = ['*.env', '**/.ssh/**'].flatMap((p) => ['read', 'grep', 'glob', 'list'].map((perm) => r(perm, p, 'deny')));
const INVARIANTS_HEAD = [r('external_directory', '*', 'deny'), ...SENSITIVE, r('task', 'work-*', 'deny'), r('gitlab_*', '*', 'deny')];
const DESTRUCTIVE = [
  'rm -rf*', 'rm -r *', 'rm -fr*', 'git push --force*', 'git push -f*', 'git push --delete*',
  'git reset --hard*', 'git clean -f*', 'git branch -D*', 'git tag -d*', 'docker rm*',
  'docker rmi*', 'docker volume rm*', 'docker system prune*', 'docker compose down -v*',
  'kubectl delete*', 'mkfs*', 'dd *of=*', 'shred*', 'truncate -s 0*', 'find * -delete*',
  'shutdown*', 'reboot*', 'poweroff*', 'systemctl stop*', '*DROP DATABASE*', '*DROP TABLE*',
  '*TRUNCATE*', 'make nuke*',
].map((p) => r('bash', p, 'ask'));
const READ_ONLY_BASE = [
  r('*', '*', 'deny'),
  r('read', '*', 'allow'), r('glob', '*', 'allow'), r('grep', '*', 'allow'), r('list', '*', 'allow'),
  r('lsp', '*', 'allow'), r('skill', '*', 'allow'), r('todowrite', '*', 'allow'),
];

export const READ_ONLY_RULES = [...READ_ONLY_BASE, ...INVARIANTS_HEAD, r('doom_loop', '*', 'deny')];
export const WRITE_RULES = [...INVARIANTS_HEAD, ...DESTRUCTIVE, r('doom_loop', '*', 'ask')];
export const NPM_TEST_ONLY_RULES = [...READ_ONLY_BASE, r('bash', 'npm test', 'allow'), ...INVARIANTS_HEAD, ...DESTRUCTIVE, r('doom_loop', '*', 'deny')];
```

Anexar ao fim de `tests/helpers.mjs` (usa `makeWorkspace`, `testEnv`, `runCli`, `readFakeState`, `registerStopper` e `waitFor` da F0 e `writeGlobalConfig` da F1, sem redefini-los; a parada dos servidores e a remoção dos temporários ficam com a limpeza por teste da F0, e o cancelamento de jobs ativos entra como `registerStopper`, que roda antes delas):

```js

// ---- F2a helpers (appended; F0/F1 helpers above stay unchanged) ----
import { resolveWorkspaceRoot as f2aResolveWorkspaceRoot, workspaceStateDir as f2aWorkspaceStateDir } from '../plugins/opc/scripts/lib/state.mjs';
import { listJobs as f2aListJobs, readJob as f2aReadJob } from '../plugins/opc/scripts/lib/jobs.mjs';

export const F2A_PROVIDER = 'omniroute-mvalmeida';
export const F2A_MODEL_ID = 'opencode-go/deepseek-v4.1-flash';
export const F2A_MODEL = `${F2A_PROVIDER}/${F2A_MODEL_ID}`;
export const F2A_POLICY = Object.freeze({
  providers: { allow: [], deny: ['omniroute-work'] },
  models: { allow: [], deny: [] },
  agents: { allow: [], deny: ['work-*'] },
  tools: { deny: ['gitlab_*'] },
  sensitivePaths: ['*.env', '**/.ssh/**'],
  destructiveBash: ['make nuke*'],
  approver: 'user',
  permissionTimeoutSec: 600,
});

export function stateDirFor(env, cwd) {
  return f2aWorkspaceStateDir(env.OPC_DATA_DIR, f2aResolveWorkspaceRoot(cwd));
}

export function jobsIn(env, cwd) {
  return f2aListJobs(stateDirFor(env, cwd), { all: true });
}

export function jobIn(env, cwd, id) {
  return f2aReadJob(stateDirFor(env, cwd), id);
}

export function requestsTo(env, method, path) {
  const requests = readFakeState(env).requests ?? [];
  return requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)));
}

export function jobIdFrom(output) {
  const match = /\b((?:task|ask|plan)-[0-9a-z]+-[0-9a-z]{6})\b/.exec(output);
  if (!match) throw new Error(`no job id in: ${output.slice(0, 500)}`);
  return match[1];
}

// Workspace + env + global config. Active jobs are cancelled by a registerStopper, which the F0 per-test
// cleanup runs BEFORE it stops the servers and removes the temp dirs.
export function setupF2a(t, { scenario = 'ok', config = {}, extraEnv = {}, git = true } = {}) {
  const ctx = {};
  ctx.cwd = makeWorkspace(t, { git });
  ctx.env = testEnv(t, { scenario, extra: { OPC_COMPANION_SESSION_ID: 'claude-f2a', OPC_STATUS_POLL_MS: '200', ...extraEnv } });
  registerStopper(t, async () => {
    for (const job of jobsIn(ctx.env, ctx.cwd)) {
      if (['queued', 'running', 'waiting_permission'].includes(job.status)) await runCli(['cancel', job.id], { env: ctx.env, cwd: ctx.cwd });
    }
  });
  writeGlobalConfig(ctx.env, { defaultProvider: F2A_PROVIDER, defaultModel: F2A_MODEL, policy: F2A_POLICY, ...config });
  return ctx;
}

export const opc = (ctx, args, { stdin = '', timeoutMs = 60000, env = {} } = {}) =>
  runCli(args, { env: { ...ctx.env, ...env }, cwd: ctx.cwd, stdin, timeoutMs });
```

Nenhum destes nomes existe na F0/F1 (conferido na reconciliação do passe #2; `writeGlobalConfig` é da F1 e a espera com timeout é o `waitFor` da F0 — os testes desta fase o importam de `../helpers.mjs` e passam `timeoutMs: 20000` quando o turno pode passar de 10 s). Os imports do snippet usam aliases `f2a*` para não colidir com os do topo.

Run: `node -e "import('./tests/helpers.mjs').then((m) => console.log(typeof m.setupF2a, typeof m.waitFor, typeof m.writeGlobalConfig))"`
Expected: `function function function`.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/fake-session-api.mjs tests/fixtures/fake-opencode.mjs tests/fixtures/scenarios tests/fixtures/expected-rules-f2a.mjs tests/helpers.mjs tests/integration/f2a-fixtures.test.mjs tests/integration/f2a-fake-session.test.mjs
git commit -m "test(fake): add session, permission and question routes with turn scenarios"
```

(Se a fixture de `/provider` mudou no Step 2, incluir o arquivo no `git add`.)

---

### Task 10: `task`, `ask`, `plan` e o worker

**Files:**
- Create: `plugins/opc/prompts/ask.md`, `plugins/opc/prompts/plan.md`, `plugins/opc/prompts/continue.md`
- Create: `plugins/opc/scripts/commands/task.mjs`, `ask.mjs`, `plan.mjs`, `task-worker.mjs`
- Create: `plugins/opc/commands/task.md`, `ask.md`, `plan.md`
- Test: `tests/unit/task-helpers.test.mjs`, `tests/unit/worker-bridge.test.mjs`, `tests/integration/f2a-task.test.mjs`, `tests/integration/f2a-prompt-roundtrip.test.mjs`, `tests/integration/f2a-profiles.test.mjs`

**Interfaces:**
- Consumes: Tarefas 1–8 (inclusive `readRawArgs` da Tarefa 4 e `assertNotInsideServer`/`serverContext` da Tarefa 7) e F0/F1 (`connectApi` no comando; `ensureServer`, `createClient`, `EventHub`, `createApi` no worker; `buildCatalog`, `getProcessIdentity`, `redact`, `parseArgs`, `readStdin`).
- Produces (`commands/task.mjs`): `run(ctx, argv)`; `runKindCommand(ctx, argv, kind)` (`kind`: `task|ask|plan`); `followJob(ctx, id, { waitTimeoutMs, pollMs, json, view: 'result'|'status', streamLog, permissionTimeoutSec })` → exit code; `exitCodeForJob(job)`; `TURN_FLAGS`; `normalizeResumeFlag(argv)`; `loadPrompt(name)`; `projectContextBlock(project)`; `buildPromptText({ userPrompt, template, project })`; `summarize(text, max = 56)`; `sessionTitle(kind, summary)`; `resolveProfile(flags, { readOnly })`; `JOB_ID_RE`; `SESSION_REF_RE`; `DEFAULT_TIMEOUT_SEC = 1800`; `DEFAULT_WAIT_TIMEOUT_SEC = 540`.
- Produces (`commands/task-worker.mjs`): `run(ctx, argv)` (subcomando interno `task-worker --job-id <id>`); `createRequestBridge({ update, api, profileKind, policy, timeoutMs, log })` → `{ onPermission, onQuestion, onResolved, dispose }`; `createSerialUpdater(stateDir, jobId)` → `{ update(patch|fn), flush() }` — ponte canônica que as fases seguintes (F3, F4b) importam deste módulo.
- Flag nova: `--raw-args-stdin` (task/ask/plan) — `parseTurnArgs` chama `readRawArgs(argv, RAW_TURN_FLAGS, { stdin: ctx.stdin })` (lê o texto cru do stdin e aplica `parsePromptArgs`). Variável `OPC_STATUS_POLL_MS` (só teste/diagnóstico): intervalo de polling do runner.
- `request` gravado no job: `{ kind, profileKind, sessionID? | newSession: { title, permission }, patchPermission?, childPermission, parts, model, agent, variant, format, messageID, timeoutMs, fallbackCfg, permissionTimeoutMs, statusPollMs? }`.

Fluxo do comando (spec §4, §6, §7, §9): parse (com `--raw-args-stdin` quando presente) → conflitos (`--resume`×`--fresh`, `--variant`×`--effort`, `--write`×`--profile`, `--write` em ask/plan) → recusa `OPC_INSIDE_SERVER=1` (`assertNotInsideServer`, exit 4) → prompt (inline, `--prompt-file`, stdin; `continue.md` no resume sem prompt) → `connectApi(ctx)` (sobe/reaproveita o servidor via `serverContext`) → catálogo, config do OpenCode → `resolveCandidates` (avisos em stderr) → `validateSelection` (variant padrão inválida para o modelo vira aviso) → `buildPermissionRules` → resume (`getSession` + `planPermissionSwitch`) → `createJob` (limites, sessão ocupada) → `spawnWorker` → background devolve o id; primeiro plano segue o log em stderr e sai por `exitCodeForJob` (6 no prazo de espera).

Worker (spec §8.2, §9.1): grava pid/identidade → trava `session-<id>.lock` no resume → `ensureServer` → cliente **sem** `onServerDown` (D9) → `EventHub.start()` → `runTurn` com a ponte → resultado final no job (`cancelRequestedAt` vence) → "Final output" no log (até 64 KB) → saída forçada em 2 s se algum socket segurar o processo.

- [ ] **Step 1: Escrever os testes unitários que falham**

`tests/unit/task-helpers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptText, exitCodeForJob, normalizeResumeFlag, projectContextBlock, resolveProfile, sessionTitle, summarize } from '../../plugins/opc/scripts/commands/task.mjs';

test('normalizeResumeFlag: id only when it looks like a job or session id', () => {
  assert.deepEqual(normalizeResumeFlag(['--resume', 'task-abc123-x1y2z3', 'more']), ['--resume-id', 'task-abc123-x1y2z3', 'more']);
  assert.deepEqual(normalizeResumeFlag(['--resume', 'ses_01ABC']), ['--resume-id', 'ses_01ABC']);
  assert.deepEqual(normalizeResumeFlag(['--resume', 'fix', 'this']), ['--resume-last', 'fix', 'this']);
  assert.deepEqual(normalizeResumeFlag(['--resume=task-abc123-x1y2z3']), ['--resume-id', 'task-abc123-x1y2z3']);
  assert.deepEqual(normalizeResumeFlag(['--json', '--', '--resume', 'x']), ['--json', '--', '--resume', 'x']);
});

test('buildPromptText: project context first, template with literal $ sequences', () => {
  const project = { goal: 'Ship opc', scope: ['plugins/'], taskTypes: ['ask'] };
  assert.equal(projectContextBlock(project), '<project_context>\ngoal: Ship opc\nscope: plugins/\ntask types: ask\n</project_context>');
  assert.equal(projectContextBlock({}), '');
  assert.equal(buildPromptText({ userPrompt: 'a $& b $1', template: 'Q:\n{{USER_REQUEST}}\n' }), 'Q:\na $& b $1\n');
  assert.equal(buildPromptText({ userPrompt: 'x', project }), `${projectContextBlock(project)}\n\nx`);
});

test('summarize and sessionTitle', () => {
  assert.equal(summarize('  fix\n the   bug  '), 'fix the bug');
  assert.equal(summarize('x'.repeat(80)).length, 56);
  assert.equal(sessionTitle('task', 'fix the bug'), 'OPC: task: fix the bug');
});

test('resolveProfile', () => {
  assert.equal(resolveProfile({}, { readOnly: false }), 'read-only');
  assert.equal(resolveProfile({ write: true }, { readOnly: false }), 'write');
  assert.equal(resolveProfile({ profile: 'npm-test-only' }, { readOnly: false }), 'custom:npm-test-only');
  assert.equal(resolveProfile({ profile: 'custom:x' }, { readOnly: false }), 'custom:x');
  assert.throws(() => resolveProfile({ write: true, profile: 'x' }, { readOnly: false }), (e) => e.code === 'CONFLICT');
  assert.throws(() => resolveProfile({ write: true }, { readOnly: true }), (e) => e.code === 'READ_ONLY_KIND');
  assert.equal(resolveProfile({}, { readOnly: true }), 'read-only');
});

test('exitCodeForJob maps job status to spec §4.1', () => {
  assert.equal(exitCodeForJob({ status: 'completed' }), 0);
  assert.equal(exitCodeForJob({ status: 'waiting_permission' }), 3);
  assert.equal(exitCodeForJob({ status: 'failed' }), 7);
  assert.equal(exitCodeForJob({ status: 'cancelled' }), 130);
});
```

`tests/unit/worker-bridge.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBridge } from '../../plugins/opc/scripts/commands/task-worker.mjs';

function harness({ profileKind = 'write', timeoutMs = 60000, policy = {} } = {}) {
  let job = { status: 'running', phase: 'editing', pendingRequest: null };
  const calls = [];
  const logs = [];
  const bridge = createRequestBridge({
    update: async (patch) => { job = { ...job, ...(typeof patch === 'function' ? patch(job) : patch) }; return job; },
    api: {
      async replyPermission(id, body) { calls.push(['reply', id, body]); return true; },
      async rejectQuestion(id) { calls.push(['rejectQuestion', id]); return true; },
    },
    profileKind, policy, timeoutMs, log: (l) => logs.push(l),
  });
  return { bridge, calls, logs, get job() { return job; } };
}
const perm = (id, patterns = ['rm -rf build'], sessionID = 'ses_1') => ({ id, sessionID, permission: 'bash', patterns, metadata: { command: patterns[0] }, always: [] });

test('read-only profile rejects permissions and questions immediately', async () => {
  const h = harness({ profileKind: 'read-only' });
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onQuestion({ id: 'que_1', sessionID: 'ses_1', questions: [] });
  assert.deepEqual(h.calls, [['reply', 'per_1', { reply: 'reject', message: 'opc: read-only profile; request rejected' }], ['rejectQuestion', 'que_1']]);
  assert.equal(h.job.status, 'running');
  h.bridge.dispose();
});

test('write profile: pending → waiting_permission with requiresUser; resolution returns to running', async () => {
  const h = harness();
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onPermission(perm('per_2', ['ls']));
  assert.equal(h.job.status, 'waiting_permission');
  assert.deepEqual(h.job.pendingRequest.map((r) => [r.id, r.requiresUser]), [['per_1', true], ['per_2', false]]);
  await h.bridge.onResolved({ requestID: 'per_1', outcome: 'reject' });
  assert.equal(h.job.status, 'waiting_permission');
  await h.bridge.onResolved({ requestID: 'per_2', outcome: 'reject' });
  assert.equal(h.job.status, 'running');
  assert.equal(h.job.pendingRequest, null);
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});

test('timeout rejects with "opc: no approver available"; questions get question reject', async () => {
  const h = harness({ timeoutMs: 30 });
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onQuestion({ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Q', header: 'Q', options: [] }] });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(h.calls, [['reply', 'per_1', { reply: 'reject', message: 'opc: no approver available' }], ['rejectQuestion', 'que_1']]);
  h.bridge.dispose();
});

test('resolution before the timeout cancels the automatic reject', async () => {
  const h = harness({ timeoutMs: 40 });
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onResolved({ requestID: 'per_1', outcome: 'once' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});
```

- [ ] **Step 2: Escrever os testes de integração que falham**

`tests/integration/f2a-task.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { F2A_MODEL_ID, F2A_PROVIDER, jobIdFrom, jobIn, opc, requestsTo, setupF2a } from '../helpers.mjs';
import { READ_ONLY_RULES } from '../fixtures/expected-rules-f2a.mjs';

test('task foreground: ok turn prints the final text, exit 0, read-only rules on POST /session', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'say hello\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^fake-opencode: ok\n/);
  assert.match(r.stderr, /\[opc\] job task-[0-9a-z]+-[0-9a-z]{6} started/);
  const [post] = requestsTo(ctx.env, 'POST', '/session');
  assert.deepEqual(post.body.permission, READ_ONLY_RULES);
  assert.match(post.body.title, /^OPC: task: say hello$/);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.match(prompt.body.messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'say hello' }]);
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
  assert.equal(job.status, 'completed');
  assert.equal(job.phase, 'done');
  assert.equal(job.permissionProfile, 'read-only');
});

test('task: structured result is stored and shown', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured' });
  const r = await opc(ctx, ['task', '--json', '--raw-args-stdin'], { stdin: 'give me json' });
  assert.equal(r.code, 0, r.stderr);
  const { job } = JSON.parse(r.stdout);
  assert.deepEqual(job.result.structured, { verdict: 'approve', count: 3 });
  assert.equal(job.result.toolsRan, false);
});

test('task: StructuredOutputError → exit 7 with the raw text', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured-error' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'give me json' });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stdout, /StructuredOutputError \(recoverable\)/);
  assert.match(r.stdout, /Raw output \(structured output failed\):\n\nraw text answer/);
});

test('--model with slashes reaches prompt_async intact; --effort is sent as variant', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--model ${F2A_PROVIDER}/${F2A_MODEL_ID} --effort high check` });
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.deepEqual(prompt.body.model, { providerID: F2A_PROVIDER, modelID: F2A_MODEL_ID });
  assert.equal(prompt.body.variant, 'high');
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'check' }]);
});

test('invalid --effort is refused before any session (exit 2)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--effort', 'ultra-max', 'check']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /UNKNOWN_VARIANT/);
  assert.equal(requestsTo(ctx.env, 'POST', '/session').length, 0);
});

test('--resume with --fresh is a usage error (exit 2) without contacting the server', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--resume', '--fresh', 'go']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /mutually exclusive/);
  assert.equal(existsSync(ctx.env.FAKE_OPENCODE_STATE), false);
});

test('OPC_INSIDE_SERVER=1 refuses to create jobs (exit 4) and never starts a server', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', 'anything'], { env: { OPC_INSIDE_SERVER: '1' } });
  assert.equal(r.code, 4);
  assert.match(r.stdout + r.stderr, /INSIDE_SERVER/);
  assert.equal(existsSync(ctx.env.FAKE_OPENCODE_STATE), false);
});

test('<project_context> from the workspace config is prepended to the prompt', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  writeFileSync(join(ctx.cwd, '.opc.json'), JSON.stringify({ project: { goal: 'Ship opc', scope: ['plugins/', 'tests/'], taskTypes: ['ask', 'plan'] } }));
  const r = await opc(ctx, ['ask', '--raw-args-stdin'], { stdin: 'where is the runner?' });
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  const text = prompt.body.parts[0].text;
  assert.ok(text.startsWith('<project_context>\ngoal: Ship opc\nscope: plugins/, tests/\ntask types: ask, plan\n</project_context>\n\n'), text.slice(0, 200));
  assert.ok(text.endsWith('Question:\nwhere is the runner?\n'), text.slice(-200));
});

test('ask and plan are read-only: --write is refused (exit 2); templates are applied', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const refused = await opc(ctx, ['plan', '--write', 'do it']);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout + refused.stderr, /READ_ONLY_KIND/);
  const r = await opc(ctx, ['plan', '--raw-args-stdin'], { stdin: 'add a cache' });
  assert.equal(r.code, 0, r.stderr);
  const [post] = requestsTo(ctx.env, 'POST', '/session');
  assert.deepEqual(post.body.permission, READ_ONLY_RULES);
  assert.match(post.body.title, /^OPC: plan: add a cache$/);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.match(prompt.body.parts[0].text, /\*\*Files\*\*/);
  assert.match(prompt.body.parts[0].text, /Task:\nadd a cache/);
});

test('large output (>1 MB): printed whole, job log stays under 5 MB', async (t) => {
  const ctx = setupF2a(t, { scenario: 'large-output' });
  const r = await opc(ctx, ['task', 'big'], { timeoutMs: 120000 });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.length > 1_000_000);
  assert.match(r.stdout, /END-OF-LARGE-OUTPUT/);
  const id = jobIdFrom(r.stderr);
  const job = jobIn(ctx.env, ctx.cwd, id);
  assert.ok(statSync(job.logFile).size <= 5 * 1024 * 1024);
  assert.match(readFileSync(job.logFile, 'utf8'), /final output truncated in the log/);
});
```

`tests/integration/f2a-prompt-roundtrip.test.mjs` (Review Focus 1: executa o bloco bash real de `commands/task.md` com o texto hostil no lugar de `$ARGUMENTS`, como o Claude Code faz):

````js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, opc, requestsTo, setupF2a } from '../helpers.mjs';

const HOSTILE = `fix "it" don't \`touch pwned-backtick\` $(touch pwned) \${HOME} $PATH ção 日本語 🚀\nsecond line \\ with backslash; rm -rf / && echo nope | cat`;

function assertNothingExecuted(cwd) {
  for (const name of ['pwned', 'pwned-backtick']) {
    assert.equal(existsSync(join(cwd, name)), false, `${name} must not exist in the workspace`);
    assert.equal(existsSync(join(process.cwd(), name)), false, `${name} must not exist in the test cwd`);
  }
}

function runCommandMarkdown(ctx, commandFile, userArguments) {
  const markdown = readFileSync(join(PLUGIN_ROOT, 'commands', commandFile), 'utf8');
  const block = /```bash\n([\s\S]*?)```/.exec(markdown)[1];
  const script = block.replace('$ARGUMENTS', () => userArguments);
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { cwd: ctx.cwd, env: { ...ctx.env, PATH: `${join(PLUGIN_ROOT, 'bin')}:${ctx.env.PATH}` } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('prompt-roundtrip: the /opc:task heredoc delivers the text verbatim and nothing executes', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await runCommandMarkdown(ctx, 'task.md', HOSTILE);
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.equal(prompt.body.parts[0].text, HOSTILE);
  assertNothingExecuted(ctx.cwd);
});

test('prompt-roundtrip: --prompt-file bytes arrive intact', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  writeFileSync(join(ctx.cwd, 'prompt.txt'), `${HOSTILE}\n\ttrailing tab line\n`);
  const r = await opc(ctx, ['task', '--prompt-file', 'prompt.txt']);
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.equal(prompt.body.parts[0].text, `${HOSTILE}\n\ttrailing tab line\n`);
  assertNothingExecuted(ctx.cwd);
});

test('prompt-roundtrip: ask template keeps $& and $1 literally', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['ask', '--raw-args-stdin'], { stdin: 'what does $& and $1 and $$ mean here?' });
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.match(prompt.body.parts[0].text, /Question:\nwhat does \$& and \$1 and \$\$ mean here\?/);
});
````

`tests/integration/f2a-profiles.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_POLICY, opc, requestsTo, setupF2a } from '../helpers.mjs';
import { NPM_TEST_ONLY_RULES, READ_ONLY_RULES, WRITE_RULES } from '../fixtures/expected-rules-f2a.mjs';

test('profile rules are sent to POST /session exactly as spec §8.1 (read-only, write, custom)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok', config: { permissionProfiles: { 'npm-test-only': [{ permission: 'bash', pattern: 'npm test', action: 'allow' }] } } });
  for (const [args, expected] of [
    [['task', 'read only please'], READ_ONLY_RULES],
    [['task', '--write', 'write please'], WRITE_RULES],
    [['task', '--profile', 'npm-test-only', 'tests only'], NPM_TEST_ONLY_RULES],
  ]) {
    const r = await opc(ctx, args);
    assert.equal(r.code, 0, r.stderr);
    const posts = requestsTo(ctx.env, 'POST', '/session');
    assert.deepEqual(posts.at(-1).body.permission, expected, args.join(' '));
  }
});

test('unknown custom profile and --write with --profile are usage errors', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  assert.equal((await opc(ctx, ['task', '--profile', 'ghost', 'x'])).code, 2);
  assert.equal((await opc(ctx, ['task', '--write', '--profile', 'ghost', 'x'])).code, 2);
  assert.equal(F2A_POLICY.approver, 'user');
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/unit/task-helpers.test.mjs tests/unit/worker-bridge.test.mjs tests/integration/f2a-task.test.mjs tests/integration/f2a-prompt-roundtrip.test.mjs tests/integration/f2a-profiles.test.mjs`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` para `commands/task.mjs` e `commands/task-worker.mjs`; a CLI responde "unknown subcommand" com exit 2).

- [ ] **Step 4: Prompts**

`plugins/opc/prompts/ask.md`:

```markdown
You are answering a question about the code in the current workspace for a developer who works in Claude Code. You run with a read-only permission profile: you can read, search and list files, but you cannot edit files, run shell commands, browse the web or start subagents. Do not try.

Rules:
- Answer the question directly. No preamble, no restating of the question, no closing summary.
- Ground every claim in the code and cite it as `path/to/file.ext:line` or `path/to/file.ext:start-end`.
- If the code does not answer the question, say so and list what you checked.
- Prefer short paragraphs and lists. Quote code only when a short excerpt is the answer.
- If the question is ambiguous, answer the most likely reading and state that assumption in one line.

Question:
{{USER_REQUEST}}
```

`plugins/opc/prompts/plan.md`:

```markdown
You are planning a change in the current workspace for a developer who works in Claude Code. You run with a read-only permission profile: read, search and list files freely; you cannot edit files, run shell commands or start subagents. Produce a plan, not the change.

Inspect the code the change touches before writing. Then answer with these sections, in this order:

1. **Goal**: one or two sentences, in your own words.
2. **Files**: every file to create or modify; for modifications give `path:line` anchors and one line on what changes.
3. **Steps**: numbered, in execution order, each small enough to review on its own.
4. **Trade-offs**: the alternatives you rejected and why.
5. **Risks**: what can break (behavior, data, compatibility, security) and how to detect it.
6. **Tests**: the tests to add or run, with the exact commands when the project defines them.
7. **Open questions**: only those that block the plan, each with the assumption you would make.

Be concrete: names, paths and commands, not generalities.

Task:
{{USER_REQUEST}}
```

`plugins/opc/prompts/continue.md`:

```markdown
Continue the task of this session. Re-read the last request and your last answer, check the current state of the files involved, and carry on from where you stopped. If the task is already complete, say so in one sentence and list what was done with `path:line` references. If you are blocked, say exactly what you need to proceed.
```

- [ ] **Step 5: `commands/task.mjs`**

```js
// /opc:task and the shared engine of /opc:ask and /opc:plan (spec §4, §6, §7, §8, §9, §10.1).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs, readRawArgs, readStdin } from '../lib/args.mjs';
import { ExitCode, OpcError, UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { resolveCandidates, validateSelection } from '../lib/routing.mjs';
import { buildPermissionRules, parseProfile, planPermissionSwitch } from '../lib/policy.mjs';
import { newMessageId } from '../lib/runner.mjs';
import { appendJobLog, assertNotInsideServer, createJob, findResumeCandidate, readJob, resolveJobRef, spawnWorker, waitForJob } from '../lib/jobs.mjs';
import { renderJobStatus, renderPermissionRequest, renderQueuedJob, renderTurnResult } from '../lib/render.mjs';

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
export const JOB_ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/;
export const SESSION_REF_RE = /^ses[_0-9A-Za-z]+$/;
const RESUME_REF_RE = /^((task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}|ses[_0-9A-Za-z]+)$/;
export const DEFAULT_TIMEOUT_SEC = 1800;
export const DEFAULT_WAIT_TIMEOUT_SEC = 540;
const KIND_SPECS = Object.freeze({
  task: { template: null, readOnly: false },
  ask: { template: 'ask.md', readOnly: true },
  plan: { template: 'plan.md', readOnly: true },
});

export const TURN_FLAGS = Object.freeze({
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  model: { type: 'string', alias: 'm' },
  agent: { type: 'string' },
  variant: { type: 'string' },
  effort: { type: 'string' },
  tier: { type: 'string' },
  write: { type: 'boolean' },
  profile: { type: 'string' },
  'resume-id': { type: 'string' },
  'resume-last': { type: 'boolean' },
  fresh: { type: 'boolean' },
  background: { type: 'boolean' },
  'prompt-file': { type: 'string' },
  timeout: { type: 'number' },
  'wait-timeout': { type: 'number' },
  'raw-args-stdin': { type: 'boolean' },
});

const RAW_TURN_FLAGS = Object.freeze({
  ...Object.fromEntries(Object.entries(TURN_FLAGS).filter(([name]) => !['resume-id', 'raw-args-stdin'].includes(name))),
  resume: { type: 'optional-string', match: RESUME_REF_RE },
});

export function normalizeResumeFlag(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      // everything after `--` is prompt text (MCP, F5): never rewrite it
      out.push(...argv.slice(i));
      break;
    }
    if (arg === '--resume') {
      if (RESUME_REF_RE.test(argv[i + 1] ?? '')) {
        out.push('--resume-id', argv[i + 1]);
        i += 1;
      } else {
        out.push('--resume-last');
      }
    } else if (arg.startsWith('--resume=')) {
      out.push('--resume-id', arg.slice('--resume='.length));
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function loadPrompt(name) {
  return readFileSync(new URL(name, PROMPTS_DIR), 'utf8');
}

export function projectContextBlock(project) {
  if (!project || typeof project !== 'object') return '';
  const lines = [];
  if (typeof project.goal === 'string' && project.goal.trim()) lines.push(`goal: ${project.goal.trim()}`);
  if (Array.isArray(project.scope) && project.scope.length) lines.push(`scope: ${project.scope.join(', ')}`);
  if (Array.isArray(project.taskTypes) && project.taskTypes.length) lines.push(`task types: ${project.taskTypes.join(', ')}`);
  return lines.length ? `<project_context>\n${lines.join('\n')}\n</project_context>` : '';
}

export function buildPromptText({ userPrompt, template = null, project = null }) {
  // function replacer: `$&`, `$1`… in the user prompt must stay literal
  const body = template ? template.replace('{{USER_REQUEST}}', () => userPrompt) : userPrompt;
  const context = projectContextBlock(project);
  return context ? `${context}\n\n${body}` : body;
}

export function summarize(text, max = 56) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function sessionTitle(kind, summary) {
  return `OPC: ${kind}: ${summary}`;
}

export function resolveProfile(flags, { readOnly }) {
  if (readOnly) {
    if (flags.write) throw new UsageError('READ_ONLY_KIND', 'this command is read-only: --write is not accepted (use /opc:task --write)');
    if (flags.profile && flags.profile !== 'read-only') throw new UsageError('READ_ONLY_KIND', 'this command is read-only: --profile is not accepted');
    return 'read-only';
  }
  if (flags.write && flags.profile && flags.profile !== 'write') throw new UsageError('CONFLICT', '--write and --profile are mutually exclusive');
  if (flags.write) return 'write';
  if (!flags.profile) return 'read-only';
  if (flags.profile === 'read-only' || flags.profile === 'write') return flags.profile;
  return `custom:${flags.profile.replace(/^custom:/, '')}`;
}

function positiveSeconds(value, flag) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new UsageError('USAGE', `${flag} expects a positive number of seconds`);
  return value;
}

export function exitCodeForJob(job) {
  switch (job?.status) {
    case 'completed':
      return ExitCode.OK;
    case 'waiting_permission':
      return ExitCode.WAITING;
    case 'cancelled':
      return ExitCode.CANCELLED;
    case 'failed':
      return ExitCode.JOB_FAILED;
    default:
      return ExitCode.OK;
  }
}

export async function followJob(ctx, id, { waitTimeoutMs, pollMs = 500, json = false, view = 'result', streamLog = true, permissionTimeoutSec = null } = {}) {
  const onLog = streamLog && !json
    ? (line) => {
        if (line.startsWith('[')) ctx.err(`[opc] ${line.replace(/^\[[^\]]+\]\s*/, '')}\n`);
      }
    : null;
  let job;
  try {
    job = await waitForJob(ctx, id, { waitTimeoutMs, pollMs, onLog });
  } catch (err) {
    if (!(err instanceof OpcError) || err.code !== 'WAIT_TIMEOUT') throw err;
    const current = readJob(ctx.stateDir, id);
    if (json) ctx.json({ job: current, waitTimedOut: true });
    else ctx.out(`${renderJobStatus(current)}\nStill ${current.status} after the wait timeout; the job keeps running. Follow it with: /opc:status ${id} --wait\n`);
    return ExitCode.WAIT_TIMEOUT;
  }
  if (json) ctx.json({ job });
  else if (job.status === 'waiting_permission') ctx.out(renderPermissionRequest(job, { timeoutSec: permissionTimeoutSec }));
  else ctx.out(view === 'status' ? renderJobStatus(job) : renderTurnResult(job));
  return exitCodeForJob(job);
}

async function readUserPrompt(ctx, flags, inlinePrompt, { resuming }) {
  if (flags['prompt-file'] && inlinePrompt) throw new UsageError('CONFLICT', 'pass the prompt inline or with --prompt-file, not both');
  if (flags['prompt-file']) {
    try {
      return { text: readFileSync(resolvePath(ctx.cwd, flags['prompt-file']), 'utf8'), isDefault: false };
    } catch (err) {
      throw new UsageError('PROMPT_FILE', `cannot read --prompt-file ${flags['prompt-file']}: ${err.code ?? err.message}`);
    }
  }
  if (inlinePrompt) return { text: inlinePrompt, isDefault: false };
  if (!flags['raw-args-stdin'] && ctx.stdin && !ctx.stdin.isTTY && !ctx.stdin.readableEnded) {
    const piped = await readStdin(ctx.stdin);
    if (piped.trim()) return { text: piped, isDefault: false };
  }
  if (resuming) return { text: loadPrompt('continue.md'), isDefault: true };
  throw new UsageError('NO_PROMPT', 'provide a prompt (inline, --prompt-file or stdin) or use --resume');
}

async function parseTurnArgs(ctx, argv) {
  const raw = await readRawArgs(argv, RAW_TURN_FLAGS, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(normalizeResumeFlag(raw.argv), { flags: TURN_FLAGS, allowPositionals: true });
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'pass the prompt either inline or through --raw-args-stdin');
  return { flags, inlinePrompt: raw.text || positionals.join(' ') };
}

function resolveResumeSession(ctx, flags, kind) {
  if (flags['resume-id']) {
    const ref = flags['resume-id'];
    if (SESSION_REF_RE.test(ref)) return ref;
    const job = resolveJobRef(ctx.stateDir, ref);
    if (!job.sessionID) throw new UsageError('NO_SESSION', `job ${job.id} has no OpenCode session to resume`);
    return job.sessionID;
  }
  if (flags['resume-last']) {
    if (!ctx.claudeSessionId) {
      throw new UsageError('RESUME_NEEDS_ID', '--resume without an id needs a Claude session (OPC_COMPANION_SESSION_ID); pass --resume <job-id|session-id>');
    }
    const candidate = findResumeCandidate(ctx.stateDir, { kind, claudeSessionId: ctx.claudeSessionId });
    if (!candidate) throw new UsageError('NOTHING_TO_RESUME', `no finished ${kind} job with a session in this Claude session`);
    return candidate.sessionID;
  }
  return null;
}

function statusPollOverride(env) {
  const value = Number(env?.OPC_STATUS_POLL_MS);
  return Number.isFinite(value) && value > 0 ? { statusPollMs: value } : {};
}

function hostPort(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function runKindCommand(ctx, argv, kind) {
  const spec = KIND_SPECS[kind];
  const { flags, inlinePrompt } = await parseTurnArgs(ctx, argv);
  const resuming = Boolean(flags['resume-id'] || flags['resume-last']);
  if (flags.fresh && resuming) throw new UsageError('CONFLICT', '--resume and --fresh are mutually exclusive');
  if (flags.variant && flags.effort && flags.variant !== flags.effort) throw new UsageError('CONFLICT', '--effort is an alias of --variant; pass only one of them');
  const profile = resolveProfile(flags, spec);
  assertNotInsideServer(ctx.env);
  const { text: userPrompt, isDefault } = await readUserPrompt(ctx, flags, inlinePrompt, { resuming });
  const turnTimeoutSec = positiveSeconds(flags.timeout, '--timeout') ?? DEFAULT_TIMEOUT_SEC;
  const waitTimeoutSec = positiveSeconds(flags['wait-timeout'], '--wait-timeout') ?? DEFAULT_WAIT_TIMEOUT_SEC;
  const config = ctx.config ?? {};
  const policy = config.policy ?? {};

  const { api, server } = await connectApi(ctx);
  const catalog = buildCatalog(await api.providers());
  const opencodeConfig = await api.getConfig();
  const { candidates, warnings } = resolveCandidates({ kind, flags: { model: flags.model, tier: flags.tier }, config, catalog, opencodeConfig });
  for (const warning of warnings) ctx.err(`[opc] warning: ${warning}\n`);
  const candidate = candidates[0];
  const agentName = flags.agent ?? config.defaultAgent ?? null;
  const agents = agentName ? await api.agents() : [];
  let variant = flags.variant ?? flags.effort ?? null;
  if (!variant && config.defaultVariant) {
    const available = catalog.byFull.get(candidate.full)?.variants ?? [];
    if (available.includes(config.defaultVariant)) variant = config.defaultVariant;
    else ctx.err(`[opc] warning: defaultVariant "${config.defaultVariant}" is not available for ${candidate.full}; ignored\n`);
  }
  const selection = validateSelection({ candidate, variant, agentName, agents, catalog, policy });
  const rules = buildPermissionRules(profile, { policy, permissionProfiles: config.permissionProfiles ?? {}, deniedAgentGlobs: policy.agents?.deny ?? [] });
  const sessionID = resolveResumeSession(ctx, flags, kind);
  let patchPermission = null;
  if (sessionID) {
    const session = await api.getSession(sessionID);
    if (planPermissionSwitch(session?.permission, rules) === 'patch') patchPermission = rules;
  }
  const template = spec.template ? loadPrompt(spec.template) : null;
  const text = buildPromptText({ userPrompt, template, project: config.project });
  const summary = isDefault ? 'continue' : summarize(userPrompt);
  const profileKind = parseProfile(profile).kind;
  const permissionTimeoutSec = policy.permissionTimeoutSec ?? 600;
  const request = {
    kind,
    profileKind,
    ...(sessionID ? { sessionID } : { newSession: { title: sessionTitle(kind, summary), permission: rules } }),
    ...(patchPermission ? { patchPermission } : {}),
    childPermission: profileKind === 'read-only' ? null : rules,
    parts: [{ type: 'text', text }],
    model: { providerID: candidate.providerID, modelID: candidate.modelID },
    agent: selection.agent,
    variant: selection.variant,
    format: null,
    messageID: newMessageId(),
    timeoutMs: turnTimeoutSec * 1000,
    fallbackCfg: config.routing?.fallback ?? {},
    permissionTimeoutMs: permissionTimeoutSec * 1000,
    ...statusPollOverride(ctx.env),
  };
  const job = await createJob(ctx.stateDir, {
    kind,
    title: `opc ${kind}`,
    summary,
    workspaceRoot: ctx.workspaceRoot,
    claudeSessionId: ctx.claudeSessionId ?? null,
    sessionID,
    model: candidate.full,
    agent: selection.agent,
    variant: selection.variant,
    permissionProfile: profile,
    serverUrlRef: hostPort(server.url),
    request,
  }, { maxActive: config.jobs?.maxActive ?? 8 });
  appendJobLog(ctx.stateDir, job.id, `Queued ${kind} (${candidate.full}, profile ${profile}${sessionID ? `, resuming ${sessionID}` : ''}).`);
  await spawnWorker(ctx, job.id);
  if (flags.background) {
    if (flags.json) ctx.json({ jobId: job.id, status: 'queued', kind, model: candidate.full });
    else ctx.out(renderQueuedJob(job));
    return ExitCode.OK;
  }
  ctx.err(`[opc] job ${job.id} started (${candidate.full}); follow it with /opc:status ${job.id}\n`);
  return followJob(ctx, job.id, { waitTimeoutMs: waitTimeoutSec * 1000, json: flags.json, permissionTimeoutSec });
}

export async function run(ctx, argv) {
  return runKindCommand(ctx, argv, 'task');
}
```

- [ ] **Step 6: `commands/ask.mjs` e `commands/plan.mjs`**

```js
// /opc:ask: read-only question or analysis (spec §10.1).
import { runKindCommand } from './task.mjs';

export async function run(ctx, argv) {
  return runKindCommand(ctx, argv, 'ask');
}
```

```js
// /opc:plan: read-only implementation plan (spec §10.1).
import { runKindCommand } from './task.mjs';

export async function run(ctx, argv) {
  return runKindCommand(ctx, argv, 'plan');
}
```

- [ ] **Step 7: `commands/task-worker.mjs`**

```js
// Internal subcommand: runs one job's turn in a detached process (spec §9.1). Users never call it.
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, NotFoundError, OpcError, UsageError } from '../lib/opc-error.mjs';
import { ensureServer } from '../lib/server.mjs';
import { createClient } from '../lib/http.mjs';
import { createApi } from '../lib/api.mjs';
import { EventHub } from '../lib/sse.mjs';
import { runTurn } from '../lib/runner.mjs';
import { requiresUser } from '../lib/policy.mjs';
import { getProcessIdentity } from '../lib/process.mjs';
import { redact } from '../lib/redact.mjs';
import { acquireSessionLock, appendJobLog, readJob, serverContext, updateJob } from '../lib/jobs.mjs';

const FINAL_LOG_LIMIT = 64 * 1024;
const METADATA_LIMIT = 4000;
const nowIso = () => new Date().toISOString();

function trimMetadata(metadata) {
  const safe = redact(metadata ?? {});
  return JSON.stringify(safe).length > METADATA_LIMIT ? { truncated: true } : safe;
}

export function createSerialUpdater(stateDir, jobId) {
  let chain = Promise.resolve();
  return {
    update(patch) {
      const next = chain.then(() => updateJob(stateDir, jobId, patch));
      chain = next.catch(() => {});
      return next;
    },
    flush() {
      return chain;
    },
  };
}

export function createRequestBridge({ update, api, profileKind, policy = {}, timeoutMs = 600000, log = () => {} }) {
  const timers = new Map();
  const autoReject = profileKind === 'read-only';
  const clearTimer = (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const addPending = (entry) => update((job) => ({
    status: 'waiting_permission',
    phase: 'waiting_permission',
    pendingRequest: [...(job.pendingRequest ?? []).filter((r) => r.id !== entry.id), entry],
  }));
  const removePending = (id) => update((job) => {
    const remaining = (job.pendingRequest ?? []).filter((r) => r.id !== id);
    if (job.status !== 'waiting_permission') return { pendingRequest: remaining.length ? remaining : null };
    return remaining.length ? { pendingRequest: remaining } : { pendingRequest: null, status: 'running', phase: 'running' };
  });
  const arm = (id, onTimeout) => {
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      log(`no answer for ${id} in ${Math.round(timeoutMs / 1000)} s: rejecting`);
      onTimeout().catch((err) => log(`automatic reject of ${id} failed: ${err.message}`));
    }, timeoutMs));
  };
  return {
    async onPermission(req) {
      if (autoReject) {
        log(`permission ${req.id} (${req.permission}) rejected automatically: read-only profile`);
        await api.replyPermission(req.id, { reply: 'reject', message: 'opc: read-only profile; request rejected' });
        return;
      }
      await addPending({
        type: 'permission', id: req.id, sessionID: req.sessionID, permission: req.permission,
        patterns: req.patterns ?? [], metadata: trimMetadata(req.metadata), always: req.always ?? [],
        requiresUser: requiresUser(req, policy), askedAt: nowIso(),
      });
      log(`waiting for a decision on ${req.id} (${req.permission})`);
      arm(req.id, () => api.replyPermission(req.id, { reply: 'reject', message: 'opc: no approver available' }));
    },
    async onQuestion(req) {
      if (autoReject) {
        log(`question ${req.id} rejected automatically: read-only profile`);
        await api.rejectQuestion(req.id);
        return;
      }
      await addPending({ type: 'question', id: req.id, sessionID: req.sessionID, questions: req.questions ?? [], askedAt: nowIso() });
      log(`waiting for an answer to ${req.id}`);
      arm(req.id, () => api.rejectQuestion(req.id));
    },
    async onResolved({ requestID, outcome }) {
      clearTimer(requestID);
      log(`request ${requestID} resolved: ${outcome}`);
      await removePending(requestID);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

function workerErrorCode(err) {
  if (err instanceof ConnectionError) return 'server_unavailable';
  if (err instanceof OpcError) return String(err.code).toLowerCase();
  return 'worker_error';
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, { flags: { 'job-id': { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' } } });
  const jobId = flags['job-id'];
  if (!jobId) throw new UsageError('USAGE', 'task-worker needs --job-id');
  const stored = readJob(ctx.stateDir, jobId);
  if (!stored?.request) throw new NotFoundError('NOT_FOUND', `job ${jobId} has no stored request`);
  const request = stored.request;
  const log = (line) => appendJobLog(ctx.stateDir, jobId, line);
  const jobUpdates = createSerialUpdater(ctx.stateDir, jobId);
  const identity = getProcessIdentity(process.pid);
  const startedAt = nowIso();
  await jobUpdates.update({ status: 'running', phase: 'starting', startedAt, pid: process.pid, pidStartTime: identity?.startTime ?? null });
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  let hub = null;
  let bridge = null;
  let releaseSession = null;
  let exitCode = 0;
  try {
    if (readJob(ctx.stateDir, jobId)?.cancelRequestedAt) controller.abort();
    if (request.sessionID) {
      releaseSession = acquireSessionLock(ctx.stateDir, request.sessionID);
      if (!releaseSession) throw new OpcError('SESSION_BUSY', `session ${request.sessionID} is locked by another job`, { exitCode: 2 });
    }
    const sctx = serverContext(ctx);
    const server = await ensureServer(sctx);
    const client = createClient({
      baseUrl: server.url,
      password: server.password,
      directory: ctx.workspaceRoot,
      requestTimeoutMs: (ctx.config?.server?.requestTimeoutSec ?? 30) * 1000,
    });
    const api = createApi(client);
    hub = new EventHub({ client });
    await hub.start();
    bridge = createRequestBridge({
      update: (patch) => jobUpdates.update(patch),
      api,
      profileKind: request.profileKind,
      policy: ctx.config?.policy ?? {},
      timeoutMs: request.permissionTimeoutMs ?? 600000,
      log,
    });
    let lastPhase = null;
    const childIDs = new Set(stored.childSessionIDs ?? []);
    const result = await runTurn({
      api,
      hub,
      request,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.message) log(event.message);
        const patch = {};
        if (event.sessionID) patch.sessionID = event.sessionID;
        if (event.childSessionID && !childIDs.has(event.childSessionID)) {
          childIDs.add(event.childSessionID);
          patch.childSessionIDs = [...childIDs];
        }
        if (event.phase && event.phase !== lastPhase) {
          lastPhase = event.phase;
          patch.phase = event.phase;
        }
        if (Object.keys(patch).length === 0) return;
        jobUpdates.update((job) => (job.status === 'waiting_permission' ? { ...patch, phase: job.phase } : patch));
      },
      onPermission: (req) => bridge.onPermission(req),
      onQuestion: (req) => bridge.onQuestion(req),
      onRequestResolved: (event) => bridge.onResolved(event),
    });
    await jobUpdates.flush();
    const cancelRequested = Boolean(readJob(ctx.stateDir, jobId)?.cancelRequestedAt);
    const status = cancelRequested ? 'cancelled' : result.status;
    const completedAt = nowIso();
    await updateJob(ctx.stateDir, jobId, {
      status,
      phase: status === 'completed' ? 'done' : status,
      completedAt,
      pendingRequest: null,
      sessionID: result.sessionID,
      childSessionIDs: result.childSessionIDs,
      errorCode: status === 'completed' ? null : cancelRequested ? 'cancelled' : result.errorCode ?? null,
      errorClass: status === 'completed' ? null : result.errorClass ?? null,
      errorType: status === 'completed' ? null : cancelRequested ? 'Cancelled' : result.errorType ?? null,
      errorMessage: status === 'completed' ? null : cancelRequested ? 'Cancelled by user.' : result.errorMessage ?? null,
      attempts: [...(stored.attempts ?? []), { model: stored.model, sessionID: result.sessionID, status, errorClass: result.errorClass ?? null, startedAt, endedAt: completedAt }],
      result: {
        finalText: result.finalText,
        structured: result.structured,
        touchedFiles: result.touchedFiles,
        toolsRan: result.toolsRan,
        childSessionIDs: result.childSessionIDs,
        usage: result.usage,
        error: result.error ?? null,
      },
    });
    log(`Turn ${status}${result.errorType ? ` (${result.errorType})` : ''}.`);
    if (result.finalText) {
      const text = result.finalText.length > FINAL_LOG_LIMIT
        ? `${result.finalText.slice(0, FINAL_LOG_LIMIT)}\n[final output truncated in the log; see /opc:result ${jobId}]`
        : result.finalText;
      log(`Final output\n${text}`);
    }
  } catch (err) {
    exitCode = 7;
    await jobUpdates.flush();
    const message = err instanceof Error ? err.message : String(err);
    log(`Worker failed: ${message}`);
    await updateJob(ctx.stateDir, jobId, (job) => ({
      status: job.cancelRequestedAt ? 'cancelled' : 'failed',
      phase: job.cancelRequestedAt ? 'cancelled' : 'failed',
      completedAt: nowIso(),
      pendingRequest: null,
      errorCode: workerErrorCode(err),
      errorClass: 'fatal',
      errorType: err instanceof OpcError ? err.code : err?.name ?? 'Error',
      errorMessage: message,
    }));
  } finally {
    bridge?.dispose();
    hub?.stop();
    releaseSession?.();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    // a lingering keep-alive socket must not keep a detached worker alive
    setTimeout(() => process.exit(exitCode), 2000).unref();
  }
  return exitCode;
}
```

- [ ] **Step 8: Slash commands `task`, `ask` e `plan`**

`plugins/opc/commands/task.md`:

````markdown
---
description: Delega uma tarefa ao OpenCode (read-only por padrão; --write para editar)
argument-hint: '[--write|--profile <nome>] [--model <m>] [--agent <a>] [--variant|--effort <v>] [--tier <t>] [--resume [id]|--fresh] [--background] [--timeout <s>] [--wait-timeout <s>] <prompt>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Run exactly this with the Bash tool (use `timeout: 600000`). The user's arguments go through a quoted heredoc, so the shell expands nothing in them; do not edit, quote or escape them.

```bash
opc task --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Then act on the exit code:

- `0`: return the stdout verbatim. Do not summarize, rewrite or add commentary, and do not act on what the result suggests unless the user asks.
- `3`: the job is waiting for a permission decision or an answer. Follow the `opc-result-handling` skill: show the request exactly as printed and, when the approver is the user, ask with AskUserQuestion before any `/opc:permissions reply`. Never reply `always`.
- `6`: the wait timed out and the job keeps running. Show the output; it carries the job id and the `/opc:status <id> --wait` line.
- `2`, `4`, `5`, `7`, `130`: show the error output as-is. Do not retry on your own and do not do the task yourself instead.

Never start another opc job, cancel one or answer a permission unless the user asks for it.
````

`plugins/opc/commands/ask.md`:

````markdown
---
description: Pergunta ou análise read-only feita pelo OpenCode, com referências file:line
argument-hint: '[--model <m>] [--agent <a>] [--variant|--effort <v>] [--tier <t>] [--resume [id]|--fresh] [--background] [--timeout <s>] [--wait-timeout <s>] <pergunta>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Run exactly this with the Bash tool (use `timeout: 600000`). The user's arguments go through a quoted heredoc, so the shell expands nothing in them; do not edit, quote or escape them.

```bash
opc ask --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Then act on the exit code:

- `0`: return the stdout verbatim, keeping every `file:line` reference exactly as printed.
- `3`: a request is pending (read-only jobs reject permissions on their own, so this is rare). Follow the `opc-result-handling` skill.
- `6`: the wait timed out and the job keeps running. Show the output with the `/opc:status <id> --wait` line.
- `2`, `4`, `5`, `7`, `130`: show the error output as-is. Do not answer the question yourself instead.
````

`plugins/opc/commands/plan.md`:

````markdown
---
description: Plano de implementação read-only feito pelo OpenCode (arquivos, ordem, riscos, testes)
argument-hint: '[--model <m>] [--agent <a>] [--variant|--effort <v>] [--tier <t>] [--resume [id]|--fresh] [--background] [--timeout <s>] [--wait-timeout <s>] <tarefa>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Run exactly this with the Bash tool (use `timeout: 600000`). The user's arguments go through a quoted heredoc, so the shell expands nothing in them; do not edit, quote or escape them.

```bash
opc plan --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Then act on the exit code:

- `0`: return the plan verbatim. Do not start implementing it; ask the user what to do next.
- `3`: a request is pending. Follow the `opc-result-handling` skill.
- `6`: the wait timed out and the job keeps running. Show the output with the `/opc:status <id> --wait` line.
- `2`, `4`, `5`, `7`, `130`: show the error output as-is. Do not write the plan yourself instead.
````

- [ ] **Step 9: Rodar e ver passar**

Run: `node --test tests/unit/task-helpers.test.mjs tests/unit/worker-bridge.test.mjs`
Expected: PASS (9 testes).

Run: `node --test --test-concurrency=4 tests/integration/f2a-task.test.mjs tests/integration/f2a-prompt-roundtrip.test.mjs tests/integration/f2a-profiles.test.mjs`
Expected: PASS (15 testes). Conferir que nenhum `task-worker` ficou vivo: `pgrep -af "opc-companion.mjs task-worker"` → nada.

- [ ] **Step 10: Commit**

```bash
git add plugins/opc/prompts plugins/opc/scripts/commands/task.mjs plugins/opc/scripts/commands/ask.mjs plugins/opc/scripts/commands/plan.mjs plugins/opc/scripts/commands/task-worker.mjs plugins/opc/commands/task.md plugins/opc/commands/ask.md plugins/opc/commands/plan.md tests/unit/task-helpers.test.mjs tests/unit/worker-bridge.test.mjs tests/integration/f2a-task.test.mjs tests/integration/f2a-prompt-roundtrip.test.mjs tests/integration/f2a-profiles.test.mjs
git commit -m "feat(task): run task, ask and plan turns in a detached worker"
```

---

### Task 11: `status`, `result` e `cancel`

**Files:**
- Create: `plugins/opc/scripts/commands/status.mjs`, `result.mjs`, `cancel.mjs`
- Create: `plugins/opc/commands/status.md`, `result.md`, `cancel.md`
- Test: `tests/integration/f2a-jobs.test.mjs`

**Interfaces:**
- Consumes: `resolveJobRef`, `reconcileJob`, `listJobs`, `readJobProgress`, `isActive`, `isTerminal`, `cancelJob` (Tarefa 7); `renderJobStatus`, `renderStatusList`, `renderTurnResult`, `renderCancel` (Tarefa 8); `followJob`, `exitCodeForJob` (Tarefa 10).
- Produces: subcomandos `status [job-id] [--wait] [--timeout-ms 240000] [--poll-interval-ms 2000] [--all] [--json]`, `result [job-id] [--json]`, `cancel [job-id] [--json]`.
- Semântica: `status --wait` sem id → exit 2; `status` sem `--wait` → 0; `status --wait` e `result` → código do estado (0/3/7/130; 6 no prazo); `result` de job ativo (inclusive `waiting_permission`) → exit 2 `JOB_ACTIVE`; `cancel` sem id → único ativo da sessão do Claude, ou exit 2 listando os ativos.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { jobIdFrom, jobIn, jobsIn, opc, requestsTo, setupF2a, stateDirFor, waitFor } from '../helpers.mjs';

async function startBackground(ctx, prompt, extra = []) {
  const r = await opc(ctx, ['task', '--background', '--json', ...extra, prompt]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).jobId;
}

async function waitRunning(ctx, id) {
  return waitFor(() => {
    const job = jobIn(ctx.env, ctx.cwd, id);
    return job?.status === 'running' && job.sessionID ? job : null;
  }, { timeoutMs: 20000, intervalMs: 100, message: `job ${id} running with a session` });
}

test('background → status → status --wait → result', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const bg = await opc(ctx, ['task', '--background', 'in the background']);
  assert.equal(bg.code, 0, bg.stderr);
  assert.match(bg.stdout, /queued in background/);
  const id = jobIdFrom(bg.stdout);
  const listed = await opc(ctx, ['status']);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(id));
  const waited = await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /Status: completed/);
  const result = await opc(ctx, ['result', id]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^fake-opencode: ok/);
});

test('result renders the structured output of a finished job', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured' });
  const r = await opc(ctx, ['task', 'give me json']);
  assert.equal(r.code, 0, r.stderr);
  const shown = await opc(ctx, ['result', jobIdFrom(r.stderr)]);
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /"verdict": "approve"/);
  const latest = await opc(ctx, ['result']);
  assert.equal(latest.stdout, shown.stdout);
});

test('result prints a >1 MB final text whole', async (t) => {
  const ctx = setupF2a(t, { scenario: 'large-output' });
  const r = await opc(ctx, ['task', '--background', '--json', 'big']);
  const { jobId } = JSON.parse(r.stdout);
  await waitFor(() => jobIn(ctx.env, ctx.cwd, jobId)?.status === 'completed', { timeoutMs: 60000, message: 'large job' });
  const shown = await opc(ctx, ['result', jobId], { timeoutMs: 60000 });
  assert.equal(shown.code, 0);
  assert.ok(shown.stdout.length > 1_000_000);
  assert.match(shown.stdout, /END-OF-LARGE-OUTPUT/);
});

test('status --wait without id is a usage error', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  assert.equal((await opc(ctx, ['status', '--wait'])).code, 2);
});

test('result of an active job → exit 2 "still running"', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const id = await startBackground(ctx, 'slow one');
  const r = await opc(ctx, ['result', id]);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /still (queued|running)/);
  const noId = await opc(ctx, ['result']);
  assert.equal(noId.code, 2);
});

test('cancel without id: one active job is cancelled; several → exit 2', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const first = await startBackground(ctx, 'first');
  const job = await waitRunning(ctx, first);
  const one = await opc(ctx, ['cancel']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, new RegExp(`Cancelled ${first}`));
  assert.equal(jobIn(ctx.env, ctx.cwd, first).status, 'cancelled');
  assert.ok(requestsTo(ctx.env, 'POST', `/session/${job.sessionID}/abort`).length >= 1);
  const a = await startBackground(ctx, 'a');
  const b = await startBackground(ctx, 'b');
  const many = await opc(ctx, ['cancel']);
  assert.equal(many.code, 2);
  assert.match(many.stdout + many.stderr, new RegExp(`${a}[\\s\\S]*${b}|${b}[\\s\\S]*${a}`));
  assert.equal((await opc(ctx, ['cancel', a])).code, 0);
  assert.equal((await opc(ctx, ['cancel', b])).code, 0);
});

test('cancel during a slow turn aborts the session and stops the worker', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const id = await startBackground(ctx, 'slow');
  const job = await waitRunning(ctx, id);
  const r = await opc(ctx, ['cancel', id, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.status, 'cancelled');
  assert.equal(payload.report.aborted, true);
  assert.ok(['exited', 'not-running', 'terminated', 'killed'].includes(payload.report.worker), payload.report.worker);
  await waitFor(() => {
    try {
      process.kill(job.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 20000, intervalMs: 100, message: 'worker exit' });
});

test('stale-worker-pid: a pid whose identity does not match never receives a signal', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => sleeper.kill('SIGKILL'));
  const stateDir = stateDirFor(ctx.env, ctx.cwd);
  const job = await createJob(stateDir, { kind: 'task', title: 'opc task', summary: 'stale', workspaceRoot: ctx.cwd, claudeSessionId: 'claude-f2a', permissionProfile: 'read-only' });
  await updateJob(stateDir, job.id, { status: 'running', pid: sleeper.pid, pidStartTime: '1' });
  const r = await opc(ctx, ['cancel', job.id, '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).report.worker, 'identity-mismatch');
  process.kill(sleeper.pid, 0);
  assert.equal(sleeper.signalCode, null);
});

test('jobs.maxActive refuses a new job with exit 2 and the active list', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow', config: { jobs: { maxActive: 1, maxParallel: 4 } } });
  const first = await startBackground(ctx, 'first');
  const r = await opc(ctx, ['task', '--background', 'second']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /jobs\.maxActive \(1\)/);
  assert.match(r.stdout + r.stderr, new RegExp(first));
});

test('server-dies-mid-turn → failed with server_lost, session kept, --resume hint (exit 7)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'server-dies-mid-turn' });
  const r = await opc(ctx, ['task', 'doomed'], { timeoutMs: 90000 });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stdout, /ServerLost/);
  assert.match(r.stdout, /--resume task-/);
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
  assert.equal(job.errorCode, 'server_lost');
  assert.match(job.sessionID, /^ses/);
});

test('retry-status → phase retrying in the log, then completed', async (t) => {
  const ctx = setupF2a(t, { scenario: 'retry-status' });
  const r = await opc(ctx, ['task', 'flaky provider']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\[opc\] retrying \(attempt 1\): APIError 429/);
  assert.match(r.stdout, /recovered after retry/);
});

test('session-error-event → failed with the event error (fatal), exit 7', async (t) => {
  const ctx = setupF2a(t, { scenario: 'session-error-event' });
  const r = await opc(ctx, ['task', 'bad credentials']);
  assert.equal(r.code, 7);
  assert.match(r.stdout, /ProviderAuthError \(fatal\): invalid credentials for provider/);
  const [job] = jobsIn(ctx.env, ctx.cwd);
  assert.equal(job.phase, 'failed');
  assert.equal(job.errorClass, 'fatal');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/f2a-jobs.test.mjs`
Expected: FAIL (subcomandos `status`, `result`, `cancel` inexistentes → exit 2).

- [ ] **Step 3: Implementar os subcomandos**

`plugins/opc/scripts/commands/status.mjs`:

```js
// /opc:status (spec §4, §9.1). Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { isActive, listJobs, readJobProgress, reconcileJob, resolveJobRef } from '../lib/jobs.mjs';
import { renderJobStatus, renderStatusList } from '../lib/render.mjs';
import { followJob } from './task.mjs';

const FLAGS = {
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  wait: { type: 'boolean' },
  'timeout-ms': { type: 'number', default: 240000 },
  'poll-interval-ms': { type: 'number', default: 2000 },
  all: { type: 'boolean' },
};

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: FLAGS, allowPositionals: true });
  const ref = positionals[0] ?? null;
  if (flags.wait && !ref) throw new UsageError('USAGE', '`status --wait` requires a job id');
  if (ref) {
    const job = await reconcileJob(ctx.stateDir, resolveJobRef(ctx.stateDir, ref));
    if (flags.wait) {
      return followJob(ctx, job.id, {
        waitTimeoutMs: flags['timeout-ms'],
        pollMs: Math.max(100, flags['poll-interval-ms']),
        json: flags.json,
        view: 'status',
        streamLog: false,
      });
    }
    const progress = readJobProgress(ctx.stateDir, job.id, 4);
    if (flags.json) ctx.json({ job, progress });
    else ctx.out(renderJobStatus(job, { progress }));
    return ExitCode.OK;
  }
  const jobs = [];
  for (const job of listJobs(ctx.stateDir, { claudeSessionId: ctx.claudeSessionId ?? null, all: flags.all })) {
    jobs.push(await reconcileJob(ctx.stateDir, job));
  }
  const progressById = Object.fromEntries(jobs.filter(isActive).map((j) => [j.id, readJobProgress(ctx.stateDir, j.id, 4)]));
  if (flags.json) ctx.json({ jobs, progress: progressById });
  else ctx.out(renderStatusList(jobs, { maxJobs: flags.all ? Infinity : 8, progressById }));
  return ExitCode.OK;
}
```

`plugins/opc/scripts/commands/result.mjs`:

```js
// /opc:result (spec §4). Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { NotFoundError, UsageError } from '../lib/opc-error.mjs';
import { isActive, isTerminal, listJobs, reconcileJob, resolveJobRef } from '../lib/jobs.mjs';
import { renderTurnResult } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';

const stillRunning = (job) => new UsageError('JOB_ACTIVE', `job ${job.id} is still ${job.status}${job.status === 'waiting_permission' ? ' (it needs a decision: /opc:permissions list)' : ''}; check /opc:status ${job.id}`);

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
  const ref = positionals[0] ?? null;
  let job;
  if (ref) {
    job = await reconcileJob(ctx.stateDir, resolveJobRef(ctx.stateDir, ref));
  } else {
    const jobs = listJobs(ctx.stateDir, { claudeSessionId: ctx.claudeSessionId ?? null });
    job = jobs.find(isTerminal) ?? null;
    if (!job) {
      const active = jobs.find(isActive);
      if (active) throw stillRunning(active);
      throw new NotFoundError('NO_FINISHED_JOB', 'no finished opc job in this Claude session yet');
    }
  }
  if (isActive(job)) throw stillRunning(job);
  if (flags.json) ctx.json({ job });
  else ctx.out(renderTurnResult(job));
  return exitCodeForJob(job);
}
```

`plugins/opc/scripts/commands/cancel.mjs`:

```js
// /opc:cancel (spec §4, §9.1). Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode } from '../lib/opc-error.mjs';
import { cancelJob, resolveJobRef } from '../lib/jobs.mjs';
import { renderCancel } from '../lib/render.mjs';

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
  const target = resolveJobRef(ctx.stateDir, positionals[0] ?? null, { claudeSessionId: ctx.claudeSessionId ?? null, activeOnly: true });
  const { job, report } = await cancelJob(ctx, target.id);
  if (flags.json) ctx.json({ jobId: job.id, status: job.status, report });
  else ctx.out(renderCancel(job, report));
  return ExitCode.OK;
}
```

- [ ] **Step 4: Slash commands**

`plugins/opc/commands/status.md`:

````markdown
---
description: Mostra os jobs do opc (ativos e recentes) neste repositório
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Run exactly this with the Bash tool (use `timeout: 600000` when `--wait` is present). The arguments go through a quoted heredoc; do not edit them.

```bash
opc status --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

If the user did not pass a job id, render the output as one compact Markdown table of the current and recent jobs; keep job id, kind, status, phase, time, summary and the follow-up commands, without extra prose.

If the user passed a job id, present the full output without condensing it. Exit code `3` means the job waits for a decision: show the request as printed and follow the `opc-result-handling` skill. Exit code `6` means the wait timed out while the job keeps running.
````

`plugins/opc/commands/result.md`:

````markdown
---
description: Mostra o resultado final guardado de um job do opc
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Run exactly this with the Bash tool. The arguments go through a quoted heredoc; do not edit them.

```bash
opc result --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Present the full output verbatim: the final text, structured output, errors, touched files, file paths and line numbers exactly as printed, and follow-up commands such as `/opc:task --resume <id>`. Exit code `2` with "still running" means the job is active: suggest `/opc:status <id> --wait`.
````

`plugins/opc/commands/cancel.md`:

````markdown
---
description: Cancela um job ativo do opc (sem id: o único job ativo desta sessão)
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Run exactly this with the Bash tool. The arguments go through a quoted heredoc; do not edit them.

```bash
opc cancel --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Present the output verbatim. If several jobs are active the command lists them and exits `2`: show the list and ask which one to cancel.
````

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test --test-concurrency=4 tests/integration/f2a-jobs.test.mjs`
Expected: PASS (12 testes).

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/commands/status.mjs plugins/opc/scripts/commands/result.mjs plugins/opc/scripts/commands/cancel.mjs plugins/opc/commands/status.md plugins/opc/commands/result.md plugins/opc/commands/cancel.md tests/integration/f2a-jobs.test.mjs
git commit -m "feat(jobs): add status, result and cancel commands"
```

---

### Task 12: Resume, concorrência por sessão e `task-resume-candidate`

**Files:**
- Create: `plugins/opc/scripts/commands/task-resume-candidate.mjs`
- Test: `tests/integration/f2a-resume.test.mjs`

**Interfaces:**
- Consumes: a lógica de resume já entregue na Tarefa 10 (`normalizeResumeFlag`, `resolveResumeSession` interno, `planPermissionSwitch`, `createJob` com `SESSION_BUSY`, `acquireSessionLock` no worker); `findResumeCandidate` (Tarefa 7).
- Produces: subcomando `task-resume-candidate [--kind task|ask|plan] [--json]` → `{ available, sessionId, candidate: { id, kind, status, title, summary, sessionID, completedAt, updatedAt } | null }`.

Esta tarefa fixa em teste o comportamento de §9.2: `--resume <job>` mantém a sessão; `--resume` sem id = último job terminado do mesmo tipo e da sessão do Claude atual (sem sessão do Claude → exit 2, não adivinha pelo título); `--resume` sem prompt usa `continue.md`; segundo job na mesma sessão OpenCode → exit 2; troca de perfil conforme D1.

- [ ] **Step 1: Escrever o teste que falha**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, jobIdFrom, jobIn, opc, requestsTo, setupF2a, waitFor } from '../helpers.mjs';
import { READ_ONLY_RULES, WRITE_RULES } from '../fixtures/expected-rules-f2a.mjs';

test('--resume <job> keeps the sessionID (no new POST /session); no prompt → continue.md', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const first = await opc(ctx, ['task', 'first turn']);
  assert.equal(first.code, 0, first.stderr);
  const a = jobIn(ctx.env, ctx.cwd, jobIdFrom(first.stderr));
  const second = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--resume ${a.id} second turn` });
  assert.equal(second.code, 0, second.stderr);
  const b = jobIn(ctx.env, ctx.cwd, jobIdFrom(second.stderr));
  assert.equal(b.sessionID, a.sessionID);
  assert.equal(requestsTo(ctx.env, 'POST', '/session').length, 1);
  assert.equal(requestsTo(ctx.env, 'POST', `/session/${a.sessionID}/prompt_async`).length, 2);
  const third = await opc(ctx, ['task', '--resume', a.id]);
  assert.equal(third.code, 0, third.stderr);
  const prompts = requestsTo(ctx.env, 'POST', `/session/${a.sessionID}/prompt_async`);
  assert.equal(prompts.at(-1).body.parts[0].text, readFileSync(join(PLUGIN_ROOT, 'prompts', 'continue.md'), 'utf8'));
  assert.equal(jobIn(ctx.env, ctx.cwd, jobIdFrom(third.stderr)).summary, 'continue');
});

test('--resume without id resumes the last finished job of the same kind in this Claude session', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const asked = await opc(ctx, ['ask', 'question one']);
  const askJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(asked.stderr));
  const tasked = await opc(ctx, ['task', 'task one']);
  const taskJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(tasked.stderr));
  const resumedAsk = await opc(ctx, ['ask', '--raw-args-stdin'], { stdin: '--resume and a follow-up' });
  assert.equal(resumedAsk.code, 0, resumedAsk.stderr);
  assert.equal(jobIn(ctx.env, ctx.cwd, jobIdFrom(resumedAsk.stderr)).sessionID, askJob.sessionID);
  assert.notEqual(askJob.sessionID, taskJob.sessionID);
  const noSession = await opc(ctx, ['task', '--resume', 'x'], { env: { OPC_COMPANION_SESSION_ID: '' } });
  assert.equal(noSession.code, 2);
  assert.match(noSession.stdout + noSession.stderr, /RESUME_NEEDS_ID/);
});

test('task-resume-candidate --json reports the last finished task of this Claude session', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const empty = await opc(ctx, ['task-resume-candidate', '--json']);
  assert.deepEqual(JSON.parse(empty.stdout), { available: false, sessionId: 'claude-f2a', candidate: null });
  const r = await opc(ctx, ['task', 'something']);
  const id = jobIdFrom(r.stderr);
  const payload = JSON.parse((await opc(ctx, ['task-resume-candidate', '--json'])).stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.id, id);
  assert.match(payload.candidate.sessionID, /^ses/);
});

test('a second job on the same OpenCode session fails immediately (exit 2)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const bg = await opc(ctx, ['task', '--background', '--json', 'long']);
  const id = JSON.parse(bg.stdout).jobId;
  const running = await waitFor(() => jobIn(ctx.env, ctx.cwd, id)?.sessionID, { timeoutMs: 20000, intervalMs: 100, message: 'session id' });
  const again = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--resume ${running} more` });
  assert.equal(again.code, 2);
  assert.match(again.stdout + again.stderr, /SESSION_BUSY/);
});

test('profile switch on resume: read-only → write refused; write → read-only patched (append)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const ro = await opc(ctx, ['task', 'read only first']);
  const roJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(ro.stderr));
  const refused = await opc(ctx, ['task', '--write', '--resume', roJob.id, 'now write']);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout + refused.stderr, /PROFILE_SWITCH_UNSUPPORTED/);
  assert.equal(requestsTo(ctx.env, 'PATCH', /^\/session\//).length, 0);
  const wr = await opc(ctx, ['task', '--write', 'write first']);
  const wrJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(wr.stderr));
  const back = await opc(ctx, ['task', '--resume', wrJob.id, 'now read only']);
  assert.equal(back.code, 0, back.stderr);
  const [patch] = requestsTo(ctx.env, 'PATCH', `/session/${wrJob.sessionID}`);
  assert.deepEqual(patch.body, { permission: READ_ONLY_RULES });
  const same = await opc(ctx, ['task', '--resume', wrJob.id, 'still read only']);
  assert.equal(same.code, 0, same.stderr);
  assert.equal(requestsTo(ctx.env, 'PATCH', `/session/${wrJob.sessionID}`).length, 1);
  assert.equal(WRITE_RULES.at(-1).action, 'ask');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/f2a-resume.test.mjs`
Expected: FAIL no teste de `task-resume-candidate` (subcomando inexistente → exit 2, stdout não é JSON). Os demais já devem passar com o código da Tarefa 10; se algum falhar, corrigir `task.mjs` antes de seguir.

- [ ] **Step 3: Implementar**

```js
// opc task-resume-candidate --json: what /opc:rescue uses to ask "continue or start new" (spec §9.2).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { findResumeCandidate } from '../lib/jobs.mjs';

const KINDS = new Set(['task', 'ask', 'plan']);

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' }, kind: { type: 'string', default: 'task' } } });
  if (!KINDS.has(flags.kind)) throw new UsageError('USAGE', '--kind must be task, ask or plan');
  const candidate = findResumeCandidate(ctx.stateDir, { kind: flags.kind, claudeSessionId: ctx.claudeSessionId ?? null });
  const payload = {
    available: Boolean(candidate),
    sessionId: ctx.claudeSessionId ?? null,
    candidate: candidate
      ? { id: candidate.id, kind: candidate.kind, status: candidate.status, title: candidate.title, summary: candidate.summary, sessionID: candidate.sessionID, completedAt: candidate.completedAt, updatedAt: candidate.updatedAt }
      : null,
  };
  if (flags.json) ctx.json(payload);
  else ctx.out(candidate ? `Resumable ${flags.kind} found: ${candidate.id} (${candidate.status}).\n` : `No resumable ${flags.kind} found for this Claude session.\n`);
  return ExitCode.OK;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test --test-concurrency=4 tests/integration/f2a-resume.test.mjs`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/commands/task-resume-candidate.mjs tests/integration/f2a-resume.test.mjs
git commit -m "feat(task): add resume candidate lookup and pin resume semantics"
```


---

### Task 13: `/opc:permissions` — list, reply e answer

**Files:**
- Create: `plugins/opc/scripts/commands/permissions.mjs`
- Create: `plugins/opc/commands/permissions.md`
- Test: `tests/unit/permissions-answers.test.mjs`, `tests/integration/f2a-permissions.test.mjs`

**Interfaces:**
- Consumes: `checkReply` (Tarefa 2); `existingServerApi`, `listJobs`, `updateJob` (Tarefa 7); `renderPermissionList` (Tarefa 8); `redact`; `api.listPermissions`, `api.listQuestions`, `api.replyPermission`, `api.replyQuestion`, `api.rejectQuestion`.
- Produces: subcomando `permissions list | reply <id> once|reject [mensagem] [--confirmed-by-user] | answer <id> <resposta...>`; `parseAnswers(questions, values)` → `string[][]`.
- Regras (§8.2, §8.3, D7, D16):
  - `reply` com qualquer valor além de `once`/`reject` (inclusive `always`) → exit 2, **antes** de falar com o servidor;
  - o pedido precisa estar pendente no servidor (`GET /permission`), senão exit 2 `NOT_FOUND`;
  - `checkReply` decide: `NEEDS_USER` → exit 4; `reject` sempre passa;
  - depois do `reply`, o job dono tem os pedidos removidos de `pendingRequest` (no `reject`, também os irmãos da mesma sessão) e volta a `running` quando não sobra nenhum;
  - `reply <que_…> reject` → `POST /question/:id/reject`;
  - `answer`: um argumento por pergunta, `|` em `multiple`, rótulos sem diferenciar maiúsculas, texto livre salvo `custom === false`.
  - Sem servidor registrado: `list` mostra "No pending requests"; `reply`/`answer` → exit 2 `NO_SERVER`. Nunca sobe servidor.

- [ ] **Step 1: Escrever os testes que falham**

`tests/unit/permissions-answers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswers } from '../../plugins/opc/scripts/commands/permissions.mjs';

const questions = [
  { question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }], custom: false },
  { question: 'Features?', header: 'Features', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }], multiple: true, custom: false },
  { question: 'Name?', header: 'Name', options: [{ label: 'default', description: '' }] },
];

test('parseAnswers builds string[][] in question order; case-insensitive labels; custom text', () => {
  assert.deepEqual(parseAnswers(questions, ['postgres', 'A|c', 'my-name']), [['Postgres'], ['A', 'C'], ['my-name']]);
  assert.deepEqual(parseAnswers(questions, ['SQLite', 'B', 'Default']), [['SQLite'], ['B'], ['default']]);
});

test('parseAnswers rejects wrong counts, empty and non-option answers when custom is false', () => {
  assert.throws(() => parseAnswers(questions, ['Postgres']), (e) => e.code === 'ANSWER_COUNT' && /1\. \[DB\]/.test(e.message));
  assert.throws(() => parseAnswers(questions, ['MySQL', 'A', 'x']), (e) => e.code === 'ANSWER_INVALID');
  assert.throws(() => parseAnswers(questions, ['Postgres', '|', 'x']), (e) => e.code === 'ANSWER_EMPTY');
});
```

`tests/integration/f2a-permissions.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_POLICY, jobIdFrom, jobIn, opc, readFakeState, setupF2a, waitFor } from '../helpers.mjs';

const permissionIdFrom = (text) => /reply (per_[0-9A-Za-z]+) once/.exec(text)?.[1];
const questionIdFrom = (text) => /answer (que_[0-9A-Za-z]+)/.exec(text)?.[1];

test('permission-ask foreground: exit 3 with ready lines; approver user needs --confirmed-by-user; then completes', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask' });
  const r = await opc(ctx, ['task', '--write', 'clean the build']);
  assert.equal(r.code, 3, r.stderr);
  const id = jobIdFrom(r.stderr);
  const perId = permissionIdFrom(r.stdout);
  assert.ok(perId, r.stdout);
  assert.match(r.stdout, /Tool: bash/);
  assert.match(r.stdout, /rm -rf build/);
  assert.match(r.stdout, /Needs the user: yes/);
  assert.match(r.stdout, new RegExp(`/opc:permissions reply ${perId} reject`));
  assert.match(r.stdout, new RegExp(`/opc:status ${id} --wait`));
  const job = jobIn(ctx.env, ctx.cwd, id);
  assert.equal(job.status, 'waiting_permission');
  assert.equal(job.pendingRequest[0].id, perId);
  const listed = await opc(ctx, ['permissions', 'list']);
  assert.match(listed.stdout, new RegExp(`${perId} \\| permission \\| bash: rm -rf build`));
  const refused = await opc(ctx, ['permissions', 'reply', perId, 'once']);
  assert.equal(refused.code, 4);
  assert.match(refused.stdout + refused.stderr, /NEEDS_USER/);
  const ok = await opc(ctx, ['permissions', 'reply', perId, 'once', '--confirmed-by-user']);
  assert.equal(ok.code, 0, ok.stderr);
  const waited = await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(waited.code, 0, waited.stdout);
  const result = await opc(ctx, ['result', id]);
  assert.match(result.stdout, /approved \(once\) and ran: rm -rf build/);
  assert.deepEqual(readFakeState(ctx.env).permissionReplies.map((x) => x.reply), ['once']);
});

test('permission-ask background: waits, reply reject with message, completes', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask' });
  const bg = JSON.parse((await opc(ctx, ['task', '--write', '--background', '--json', 'clean'])).stdout);
  const waiting = await opc(ctx, ['status', bg.jobId, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(waiting.code, 3, waiting.stdout);
  const perId = permissionIdFrom(waiting.stdout);
  const reply = await opc(ctx, ['permissions', 'reply', perId, 'reject', 'not', 'today']);
  assert.equal(reply.code, 0, reply.stderr);
  const done = await opc(ctx, ['status', bg.jobId, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(done.code, 0);
  assert.match((await opc(ctx, ['result', bg.jobId])).stdout, /rejected: not today/);
});

test('permission timeout in background → reject "opc: no approver available"', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask', config: { policy: { ...F2A_POLICY, permissionTimeoutSec: 1 } } });
  const bg = JSON.parse((await opc(ctx, ['task', '--write', '--background', '--json', 'clean'])).stdout);
  const done = await opc(ctx, ['status', bg.jobId, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.ok([0, 3].includes(done.code));
  await waitFor(() => jobIn(ctx.env, ctx.cwd, bg.jobId)?.status === 'completed', { timeoutMs: 20000, intervalMs: 100, message: 'completion after timeout' });
  assert.deepEqual(readFakeState(ctx.env).permissionReplies.map((x) => [x.reply, x.message]), [['reject', 'opc: no approver available']]);
  assert.match((await opc(ctx, ['result', bg.jobId])).stdout, /rejected: opc: no approver available/);
});

test('child-permission-ask reaches the job (child session marked)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'child-permission-ask' });
  const r = await opc(ctx, ['task', '--write', 'use a subagent']);
  assert.equal(r.code, 3, r.stderr);
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
  const [pending] = job.pendingRequest;
  assert.notEqual(pending.sessionID, job.sessionID);
  assert.match(r.stdout, /\(child session\)/);
  assert.equal((await opc(ctx, ['permissions', 'reply', pending.id, 'reject'])).code, 0);
  const done = await opc(ctx, ['status', job.id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(done.code, 0);
  assert.ok(jobIn(ctx.env, ctx.cwd, job.id).childSessionIDs.includes(pending.sessionID));
});

test('reject-siblings: rejecting one request clears both from the job', async (t) => {
  const ctx = setupF2a(t, { scenario: 'reject-siblings' });
  const r = await opc(ctx, ['task', '--write', 'two requests']);
  assert.equal(r.code, 3);
  const id = jobIdFrom(r.stderr);
  const job = await waitFor(() => {
    const current = jobIn(ctx.env, ctx.cwd, id);
    return current.pendingRequest?.length === 2 ? current : null;
  }, { timeoutMs: 20000, intervalMs: 100, message: 'two pending requests' });
  const reply = await opc(ctx, ['permissions', 'reply', job.pendingRequest[0].id, 'reject']);
  assert.equal(reply.code, 0, reply.stderr);
  assert.match(reply.stdout, new RegExp(`also rejected the other pending requests of that session: ${job.pendingRequest[1].id}`));
  const done = await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(done.code, 0);
  assert.equal(jobIn(ctx.env, ctx.cwd, id).pendingRequest, null);
  assert.match((await opc(ctx, ['result', id])).stdout, /outcomes: reject,reject/);
  assert.equal(readFakeState(ctx.env).permissionReplies.length, 2);
});

test('question-ask: answer with several questions (string[][]); multiple and custom', async (t) => {
  const ctx = setupF2a(t, { scenario: 'question-ask' });
  const r = await opc(ctx, ['task', '--write', 'ask me']);
  assert.equal(r.code, 3, r.stderr);
  const queId = questionIdFrom(r.stdout);
  assert.match(r.stdout, /Options: Postgres \| SQLite/);
  const bad = await opc(ctx, ['permissions', '--args-stdin'], { stdin: `answer ${queId} MySQL A svc` });
  assert.equal(bad.code, 2);
  const ok = await opc(ctx, ['permissions', '--args-stdin'], { stdin: `answer ${queId} postgres "A|C" "my service"` });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(readFakeState(ctx.env).questionReplies[0].answers, [['Postgres'], ['A', 'C'], ['my service']]);
  const id = jobIdFrom(r.stderr);
  assert.equal((await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200'])).code, 0);
  assert.match((await opc(ctx, ['result', id])).stdout, /answers: \[\["Postgres"\],\["A","C"\],\["my service"\]\]/);
});

test('question timeout → question reject', async (t) => {
  const ctx = setupF2a(t, { scenario: 'question-ask', config: { policy: { ...F2A_POLICY, permissionTimeoutSec: 1 } } });
  const bg = JSON.parse((await opc(ctx, ['task', '--write', '--background', '--json', 'ask me'])).stdout);
  await waitFor(() => jobIn(ctx.env, ctx.cwd, bg.jobId)?.status === 'completed', { timeoutMs: 20000, intervalMs: 100, message: 'completion after question timeout' });
  assert.equal(readFakeState(ctx.env).questionRejects.length, 1);
  assert.match((await opc(ctx, ['result', bg.jobId])).stdout, /question rejected/);
});

test('reply always is refused (exit 2) without contacting the server', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['permissions', 'reply', 'per_anything', 'always']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /never sent/);
});

test('approver claude: destructive needs --confirmed-by-user (exit 4); benign does not', async (t) => {
  const policy = { ...F2A_POLICY, approver: 'claude' };
  const destructive = setupF2a(t, { scenario: 'permission-ask', config: { policy } });
  const r1 = await opc(destructive, ['task', '--write', 'clean']);
  assert.equal(r1.code, 3);
  const refused = await opc(destructive, ['permissions', 'reply', permissionIdFrom(r1.stdout), 'once']);
  assert.equal(refused.code, 4);
  const benign = setupF2a(t, { scenario: 'permission-ask', config: { policy }, extraEnv: { FAKE_PERMISSION_COMMAND: 'ls -la' } });
  const r2 = await opc(benign, ['task', '--write', 'list']);
  assert.equal(r2.code, 3);
  const accepted = await opc(benign, ['permissions', 'reply', permissionIdFrom(r2.stdout), 'once']);
  assert.equal(accepted.code, 0, accepted.stderr);
});

test('read-only profile: any permission request is rejected immediately by the bridge', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask' });
  const r = await opc(ctx, ['task', 'read only']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rejected: opc: read-only profile; request rejected/);
  assert.deepEqual(readFakeState(ctx.env).permissionReplies.map((x) => x.reply), ['reject']);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/permissions-answers.test.mjs tests/integration/f2a-permissions.test.mjs`
Expected: FAIL (`commands/permissions.mjs` inexistente). O teste de "read-only rejeita na hora" já passa (é a ponte da Tarefa 10).

- [ ] **Step 3: Implementar**

```js
// /opc:permissions: list, reply once|reject, answer (spec §8.2, §8.3).
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, ExitCode, NotFoundError, PolicyError, UsageError } from '../lib/opc-error.mjs';
import { checkReply } from '../lib/policy.mjs';
import { redact } from '../lib/redact.mjs';
import { existingServerApi, listJobs, updateJob } from '../lib/jobs.mjs';
import { renderPermissionList } from '../lib/render.mjs';

const FLAGS = { json: { type: 'boolean' }, cwd: { type: 'string' }, 'confirmed-by-user': { type: 'boolean' } };
const USAGE = 'usage: permissions list | reply <id> once|reject [message] [--confirmed-by-user] | answer <question-id> <answer...>';

export function parseAnswers(questions, values) {
  const describe = () => questions.map((q, i) => `${i + 1}. [${q.header ?? ''}] ${q.question ?? ''} — options: ${(q.options ?? []).map((o) => o.label).join(' | ') || '(free text)'}`).join('\n');
  if (values.length !== questions.length) {
    throw new UsageError('ANSWER_COUNT', `expected ${questions.length} answer(s), one per question, in order (use | between labels for multiple choice):\n${describe()}`);
  }
  return questions.map((q, i) => {
    const raw = String(values[i]);
    const parts = q.multiple ? raw.split('|').map((s) => s.trim()).filter(Boolean) : [raw.trim()];
    if (parts.length === 0 || parts.some((p) => !p)) throw new UsageError('ANSWER_EMPTY', `answer ${i + 1} is empty`);
    return parts.map((part) => {
      const option = (q.options ?? []).find((o) => String(o.label).toLowerCase() === part.toLowerCase());
      if (option) return option.label;
      if (q.custom !== false) return part;
      throw new UsageError('ANSWER_INVALID', `answer ${i + 1} "${part}" is not an option of [${q.header ?? ''}]:\n${describe()}`);
    });
  });
}

function requireServerApi(ctx) {
  const api = existingServerApi(ctx);
  if (!api) throw new NotFoundError('NO_SERVER', 'no opc server is running for this workspace, so nothing is pending');
  return api;
}

async function clearPending(ctx, ids) {
  const job = listJobs(ctx.stateDir, { all: true }).find((j) => (j.pendingRequest ?? []).some((r) => ids.includes(r.id)));
  if (!job) return null;
  return updateJob(ctx.stateDir, job.id, (current) => {
    const remaining = (current.pendingRequest ?? []).filter((r) => !ids.includes(r.id));
    if (current.status !== 'waiting_permission') return { pendingRequest: remaining.length ? remaining : null };
    return remaining.length ? { pendingRequest: remaining } : { pendingRequest: null, status: 'running', phase: 'running' };
  });
}

async function list(ctx, flags) {
  const api = existingServerApi(ctx);
  let requests = [];
  if (api) {
    try {
      const [permissions, questions] = await Promise.all([api.listPermissions(), api.listQuestions()]);
      requests = [...(permissions ?? []).map((p) => ({ type: 'permission', ...p })), ...(questions ?? []).map((q) => ({ type: 'question', ...q }))];
    } catch (err) {
      if (!(err instanceof ConnectionError)) throw err;
    }
  }
  const jobs = listJobs(ctx.stateDir, { all: true });
  if (flags.json) ctx.json({ requests: redact(requests) });
  else ctx.out(renderPermissionList(requests, jobs));
  return ExitCode.OK;
}

async function reply(ctx, flags, id, rest) {
  const [decision, ...messageParts] = rest;
  if (!id || !decision) throw new UsageError('USAGE', USAGE);
  const policy = ctx.config?.policy ?? {};
  const approver = policy.approver ?? 'user';
  const syntax = checkReply({ approver, request: null, reply: decision, confirmedByUser: true, policy });
  if (!syntax.ok) throw new UsageError(syntax.code, syntax.reason);
  const message = messageParts.join(' ').trim();
  if (id.startsWith('que')) {
    if (decision !== 'reject') throw new UsageError('INVALID_REPLY', 'questions accept only "reject" here; answer them with: permissions answer <id> <answer...>');
    const api = requireServerApi(ctx);
    await api.rejectQuestion(id);
    const job = await clearPending(ctx, [id]);
    ctx.out(`Rejected question ${id}.${job ? `\nFollow the job: /opc:status ${job.id} --wait` : ''}\n`);
    return ExitCode.OK;
  }
  const api = requireServerApi(ctx);
  const pending = (await api.listPermissions()) ?? [];
  const request = pending.find((p) => p.id === id);
  if (!request) throw new NotFoundError('NOT_FOUND', `permission request ${id} is not pending (already answered, rejected together with a sibling, or timed out)`);
  const verdict = checkReply({ approver, request, reply: decision, confirmedByUser: Boolean(flags['confirmed-by-user']), policy });
  if (!verdict.ok) throw verdict.code === 'INVALID_REPLY' ? new UsageError(verdict.code, verdict.reason) : new PolicyError(verdict.code, verdict.reason);
  await api.replyPermission(id, decision === 'reject' ? { reply: 'reject', ...(message ? { message } : {}) } : { reply: 'once' });
  const siblings = decision === 'reject' ? pending.filter((p) => p.sessionID === request.sessionID && p.id !== id).map((p) => p.id) : [];
  const job = await clearPending(ctx, [id, ...siblings]);
  const lines = [`Replied ${decision} to ${id} (${request.permission}).`];
  if (siblings.length) lines.push(`OpenCode also rejected the other pending requests of that session: ${siblings.join(', ')}.`);
  if (job) lines.push(`Follow the job: /opc:status ${job.id} --wait`);
  ctx.out(`${lines.join('\n')}\n`);
  return ExitCode.OK;
}

async function answer(ctx, id, values) {
  if (!id || !id.startsWith('que') || values.length === 0) throw new UsageError('USAGE', USAGE);
  const api = requireServerApi(ctx);
  const request = ((await api.listQuestions()) ?? []).find((q) => q.id === id);
  if (!request) throw new NotFoundError('NOT_FOUND', `question ${id} is not pending (already answered or timed out)`);
  const answers = parseAnswers(request.questions ?? [], values);
  await api.replyQuestion(id, answers);
  const job = await clearPending(ctx, [id]);
  ctx.out(`Answered ${id}: ${answers.map((a) => a.join(' | ')).join(' ; ')}${job ? `\nFollow the job: /opc:status ${job.id} --wait` : ''}\n`);
  return ExitCode.OK;
}

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: FLAGS, allowPositionals: true });
  const [action = 'list', id, ...rest] = positionals;
  switch (action) {
    case 'list':
      return list(ctx, flags);
    case 'reply':
      return reply(ctx, flags, id, rest);
    case 'answer':
      return answer(ctx, id, rest);
    default:
      throw new UsageError('USAGE', USAGE);
  }
}
```

- [ ] **Step 4: Slash command**

`plugins/opc/commands/permissions.md`:

````markdown
---
description: Lista e responde pedidos de permissão e perguntas pendentes dos jobs do opc
argument-hint: 'list | reply <id> once|reject [mensagem] | answer <id> <resposta...>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Follow the `opc-result-handling` skill before replying to anything.

- `list` (or no arguments): run the command below and show the table.
- `reply <id> once`: only after the user approved it. When the approver is `user` (the default), ask with AskUserQuestion first (show tool, patterns, session and job), and add `--confirmed-by-user` only if the user chose to allow once. Requests marked "Needs the user: yes" always need that confirmation, whatever the approver.
- `reply <id> reject [message]`: allowed without confirmation; pass the user's reason as the message when there is one.
- `answer <id> <answer...>`: one argument per question, in order; quote answers with spaces; separate several labels of a multiple-choice question with `|`.
- Never reply `always`; opc refuses it.

Run with the Bash tool, passing the arguments (plus `--confirmed-by-user` when the user confirmed) through the quoted heredoc:

```bash
opc permissions --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Show the output verbatim, including the `/opc:status <job> --wait` line.
````

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test tests/unit/permissions-answers.test.mjs`
Expected: PASS (2 testes).

Run: `node --test --test-concurrency=4 tests/integration/f2a-permissions.test.mjs`
Expected: PASS (10 testes).

- [ ] **Step 6: Commit**

```bash
git add plugins/opc/scripts/commands/permissions.mjs plugins/opc/commands/permissions.md tests/unit/permissions-answers.test.mjs tests/integration/f2a-permissions.test.mjs
git commit -m "feat(permissions): list, reply and answer pending requests with approver checks"
```

---

### Task 14: `opc gc`

**Files:**
- Create: `plugins/opc/scripts/commands/gc.mjs`
- Test: `tests/unit/gc.test.mjs`, `tests/integration/f2a-gc.test.mjs`

**Interfaces:**
- Consumes: `listJobs`, `isActive` (Tarefa 7); `readServerRecord`, `serverMatcher` (F0); `identityMatches` (F0); `createPrompter` (F1 `tty.mjs`); `renderTable` (F0).
- Produces: subcomando `gc [--days 30] [--confirmed-by-user] [--json]`; `findStaleStates(dataDir, { olderThanMs, exclude, now })` → `Array<{ dir, name, lastUsed }>`.
- Regras (spec §3.2, D15): só diretórios diretamente sob `<dataDir>/state/` com nome `<slug>-<16 hex>`, do mesmo uid, sem jobs ativos, sem servidor vivo (identidade conferida) e sem uso há mais de N dias (mtime mais recente do diretório e de até dois níveis de conteúdo); o estado do workspace atual nunca entra; TTY → lista e pede confirmação; sem TTY → exige `--confirmed-by-user` (senão lista e sai com 2).

- [ ] **Step 1: Escrever os testes que falham**

`tests/unit/gc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStaleStates } from '../../plugins/opc/scripts/commands/gc.mjs';

function makeState(root, name, ageDays, { activeJob = false } = {}) {
  const dir = join(root, 'state', name);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{"version":1,"claudeSessions":[],"jobs":[]}');
  if (activeJob) writeFileSync(join(dir, 'jobs', 'task-abc-123456.json'), JSON.stringify({ id: 'task-abc-123456', status: 'running', createdAt: new Date().toISOString() }));
  const when = new Date(Date.now() - ageDays * 86400000);
  for (const p of [join(dir, 'state.json'), join(dir, 'jobs'), dir]) utimesSync(p, when, when);
  if (activeJob) utimesSync(join(dir, 'jobs', 'task-abc-123456.json'), when, when);
  return dir;
}

test('findStaleStates: only old, inactive, non-excluded state dirs with the slug-hash name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'opc-gc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = makeState(root, 'old-0123456789abcdef', 40);
  makeState(root, 'recent-0123456789abcdee', 5);
  makeState(root, 'busy-0123456789abcded', 40, { activeJob: true });
  const current = makeState(root, 'current-0123456789abcdec', 40);
  makeState(root, 'not-a-state-dir', 40);
  const stale = findStaleStates(root, { olderThanMs: 30 * 86400000, exclude: current });
  assert.deepEqual(stale.map((s) => s.dir), [old]);
});
```

`tests/integration/f2a-gc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opc, setupF2a } from '../helpers.mjs';

function oldState(env, name, days) {
  const dir = join(env.OPC_DATA_DIR, 'state', name);
  mkdirSync(join(dir, 'jobs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'state.json'), '{"version":1,"claudeSessions":[],"jobs":[]}', { mode: 0o600 });
  const when = new Date(Date.now() - days * 86400000);
  for (const p of [join(dir, 'state.json'), join(dir, 'jobs'), dir]) utimesSync(p, when, when);
  return dir;
}

test('gc: lists and refuses without confirmation outside a TTY; removes with --confirmed-by-user', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const stale = oldState(ctx.env, 'old-ws-0123456789abcdef', 45);
  const fresh = oldState(ctx.env, 'fresh-ws-0123456789abcdee', 2);
  const dry = await opc(ctx, ['gc']);
  assert.equal(dry.code, 2);
  assert.match(dry.stdout, /old-ws-0123456789abcdef/);
  assert.doesNotMatch(dry.stdout, /fresh-ws/);
  assert.ok(existsSync(stale));
  const done = await opc(ctx, ['gc', '--confirmed-by-user']);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(fresh));
  const nothing = await opc(ctx, ['gc']);
  assert.equal(nothing.code, 0);
  assert.match(nothing.stdout, /no workspace state unused/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/gc.test.mjs tests/integration/f2a-gc.test.mjs`
Expected: FAIL (`commands/gc.mjs` inexistente).

- [ ] **Step 3: Implementar**

```js
// opc gc: removes workspace states unused for more than N days, only on explicit command (spec §3.2).
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode } from '../lib/opc-error.mjs';
import { identityMatches } from '../lib/process.mjs';
import { readServerRecord, serverMatcher } from '../lib/server.mjs';
import { createPrompter } from '../lib/tty.mjs';
import { isActive, listJobs } from '../lib/jobs.mjs';
import { renderTable } from '../lib/render.mjs';

const STATE_DIR_RE = /^.+-[0-9a-f]{16}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function newestMtime(dir) {
  let newest = statSync(dir).mtimeMs;
  const visit = (path, depth) => {
    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      try {
        newest = Math.max(newest, lstatSync(full).mtimeMs);
      } catch {
        continue;
      }
      if (entry.isDirectory() && depth < 1) visit(full, depth + 1);
    }
  };
  visit(dir, 0);
  return newest;
}

function hasLiveServer(dir) {
  const record = readServerRecord(dir);
  if (!record?.pid) return false;
  return identityMatches({ pid: record.pid, startTime: record.startTime }, serverMatcher(record.port));
}

export function findStaleStates(dataDir, { olderThanMs, exclude = null, now = Date.now() } = {}) {
  const root = join(dataDir, 'state');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !STATE_DIR_RE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    if (exclude && resolve(dir) === resolve(exclude)) continue;
    if (uid !== null && lstatSync(dir).uid !== uid) continue;
    const lastUsed = newestMtime(dir);
    if (now - lastUsed <= olderThanMs) continue;
    if (listJobs(dir, { all: true }).some(isActive) || hasLiveServer(dir)) continue;
    stale.push({ dir, name: entry.name, lastUsed: new Date(lastUsed).toISOString() });
  }
  return stale.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, {
    flags: { json: { type: 'boolean' }, cwd: { type: 'string' }, days: { type: 'number', default: 30 }, 'confirmed-by-user': { type: 'boolean' } },
  });
  const days = Number.isFinite(flags.days) && flags.days > 0 ? flags.days : 30;
  const stale = findStaleStates(ctx.dataDir, { olderThanMs: days * DAY_MS, exclude: ctx.stateDir });
  if (stale.length === 0) {
    if (flags.json) ctx.json({ removed: [], candidates: [] });
    else ctx.out(`opc gc: no workspace state unused for more than ${days} days.\n`);
    return ExitCode.OK;
  }
  const table = renderTable(['State', 'Last used'], stale.map((s) => [s.name, s.lastUsed]));
  let confirmed = Boolean(flags['confirmed-by-user']);
  if (!confirmed) {
    if (!ctx.stdin?.isTTY) {
      if (flags.json) ctx.json({ removed: [], candidates: stale, needsConfirmation: true });
      else ctx.out(`# opc gc\n\nThese states would be removed:\n\n${table}\n\nNothing removed: re-run in a terminal, or with --confirmed-by-user after asking the user.\n`);
      return ExitCode.USAGE;
    }
    ctx.err(`# opc gc\n\n${table}\n\n`);
    const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
    try {
      confirmed = await prompter.confirm(`Remove these ${stale.length} state directories?`);
    } finally {
      prompter.close();
    }
    if (!confirmed) {
      ctx.out('opc gc: nothing removed.\n');
      return ExitCode.OK;
    }
  }
  for (const s of stale) rmSync(s.dir, { recursive: true, force: true });
  if (flags.json) ctx.json({ removed: stale.map((s) => s.name), candidates: stale });
  else ctx.out(`# opc gc\n\nRemoved ${stale.length} state directories:\n\n${table}\n`);
  return ExitCode.OK;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/unit/gc.test.mjs tests/integration/f2a-gc.test.mjs`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/commands/gc.mjs tests/unit/gc.test.mjs tests/integration/f2a-gc.test.mjs
git commit -m "feat(gc): remove stale workspace states on explicit confirmation"
```

---

### Task 15: Skill `opc-result-handling`, frontmatter dos comandos e exit codes

**Files:**
- Create: `plugins/opc/skills/opc-result-handling/SKILL.md` (conteúdo inicial; a F2b amplia com review/rescue)
- Test: `tests/integration/f2a-commands-md.test.mjs`, `tests/integration/f2a-exit-codes.test.mjs`

**Interfaces:**
- Consumes: todos os subcomandos da fase; cenário `auth-401` da F0.
- Produces: skill interna (`user-invocable: false`) com as regras de apresentação e de permissão (aprovador `user` → AskUserQuestion antes de qualquer `reply`; `claude` → livre salvo "Needs the user"; nunca `always`; `--confirmed-by-user` só com escolha explícita do usuário).

- [ ] **Step 1: Escrever os testes que falham**

`tests/integration/f2a-commands-md.test.mjs` (frontmatter do §4/§8.4 e heredoc com delimitador entre aspas):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from '../helpers.mjs';

function frontmatter(file) {
  const text = readFileSync(join(PLUGIN_ROOT, 'commands', file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file} has frontmatter`);
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }));
  return { fields, body: match[2] };
}

const EXPECT = {
  'task.md': { sub: 'task --raw-args-stdin', modelInvocable: true, ask: true },
  'ask.md': { sub: 'ask --raw-args-stdin', modelInvocable: true, ask: true },
  'plan.md': { sub: 'plan --raw-args-stdin', modelInvocable: true, ask: true },
  'status.md': { sub: 'status --args-stdin', modelInvocable: false, ask: false },
  'result.md': { sub: 'result --args-stdin', modelInvocable: false, ask: false },
  'cancel.md': { sub: 'cancel --args-stdin', modelInvocable: false, ask: false },
  'permissions.md': { sub: 'permissions --args-stdin', modelInvocable: true, ask: true },
};

for (const [file, expected] of Object.entries(EXPECT)) {
  test(`commands/${file}: frontmatter per spec §4/§8.4 and quoted heredoc invocation`, () => {
    const { fields, body } = frontmatter(file);
    assert.ok(fields.description, 'description');
    assert.ok(fields['argument-hint'] !== undefined, 'argument-hint');
    assert.equal(fields['disable-model-invocation'] === 'true', !expected.modelInvocable);
    assert.match(fields['allowed-tools'], /Bash\(opc:\*\)/);
    assert.equal(/AskUserQuestion/.test(fields['allowed-tools']), expected.ask);
    assert.doesNotMatch(fields['allowed-tools'], /Bash\(node|dangerously|no-verify/);
    assert.ok(body.includes(`opc ${expected.sub} <<'OPC_ARGS_5f1d0c7a_EOF'\n$ARGUMENTS\nOPC_ARGS`), `${file} heredoc`);
  });
}
```

`tests/integration/f2a-exit-codes.test.mjs` (§4.1 de ponta a ponta):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_POLICY, jobIn, jobsIn, opc, setupF2a, waitFor } from '../helpers.mjs';

test('exit codes (spec §4.1): 0, 2, 3, 4, 5, 6, 7, 130', async (t) => {
  const ok = setupF2a(t, { scenario: 'ok' });
  assert.equal((await opc(ok, ['task', 'fine'])).code, 0);
  assert.equal((await opc(ok, ['task', '--bogus-flag', 'x'])).code, 2);

  const perm = setupF2a(t, { scenario: 'permission-ask' });
  assert.equal((await opc(perm, ['task', '--write', 'clean'])).code, 3);

  const denied = setupF2a(t, { scenario: 'ok', config: { policy: { ...F2A_POLICY, models: { allow: [], deny: ['omniroute-mvalmeida/*'] } } } });
  assert.equal((await opc(denied, ['task', 'x'])).code, 4);

  const auth = setupF2a(t, { scenario: 'auth-401' });
  assert.equal((await opc(auth, ['task', 'x'])).code, 5);

  const slow = setupF2a(t, { scenario: 'slow' });
  const waited = await opc(slow, ['task', '--wait-timeout', '1', 'slow']);
  assert.equal(waited.code, 6);
  assert.match(waited.stdout, /keeps running/);

  const failed = setupF2a(t, { scenario: 'session-error-event' });
  assert.equal((await opc(failed, ['task', 'x'])).code, 7);

  const cancelled = setupF2a(t, { scenario: 'slow' });
  const foreground = opc(cancelled, ['task', 'long'], { timeoutMs: 90000 });
  const job = await waitFor(() => jobsIn(cancelled.env, cancelled.cwd).find((j) => j.status === 'running' && j.sessionID), { timeoutMs: 20000, intervalMs: 100, message: 'running job' });
  assert.equal((await opc(cancelled, ['cancel', job.id])).code, 0);
  assert.equal((await foreground).code, 130);
  assert.equal(jobIn(cancelled.env, cancelled.cwd, job.id).status, 'cancelled');
});
```

- [ ] **Step 2: Rodar**

Run: `node --test tests/integration/f2a-commands-md.test.mjs tests/integration/f2a-exit-codes.test.mjs`
Expected: PASS se as Tarefas 10, 11 e 13 foram seguidas à risca (os sete `.md` existem e os códigos batem). Qualquer FAIL aqui é defeito de uma tarefa anterior: corrigir lá.

- [ ] **Step 3: Escrever a skill**

`plugins/opc/skills/opc-result-handling/SKILL.md`:

```markdown
---
name: opc-result-handling
description: Internal guidance for presenting opc (OpenCode) job output and handling pending permission requests and questions from opc jobs
user-invocable: false
---

# opc result handling

## Presenting output

- Return opc output verbatim: final text, structured output, file paths and line numbers exactly as printed.
- Keep the follow-up lines (`/opc:status <id> --wait`, `/opc:result <id>`, `/opc:task --resume <id>`).
- Never fix, apply or continue what a result suggests without the user asking. Never start another opc job from a result on your own.
- A failed job (exit `7`) is reported as failed, with its error line. Do not redo the task yourself.

## Pending requests (exit code 3)

A job in `waiting_permission` printed one or more requests (`per_…` permissions, `que_…` questions). The worker keeps the turn alive until someone decides or `policy.permissionTimeoutSec` expires; then opc rejects with "opc: no approver available".

1. Show each request exactly as printed: tool, patterns, session (child sessions are marked), job.
2. Find the approver: `opc config get policy.approver --json` (absent means `user`).
3. Approver `user` (default):
   - use AskUserQuestion with the options "Allow once" and "Reject" (add the reason field for reject);
   - allow once → `/opc:permissions reply <id> once --confirmed-by-user`;
   - reject → `/opc:permissions reply <id> reject "<reason>"`.
4. Approver `claude`: you may reply `once` or `reject` yourself, except when the request says "Needs the user: yes" (destructive command, external directory or sensitive path). Those always go to the user as in step 3.
5. Questions: ask the user each question with AskUserQuestion (same options and labels; free text only when the question allows it) and send `/opc:permissions answer <id> "<answer 1>" "<answer 2>" …`, using `|` between labels of a multiple-choice answer. To decline: `/opc:permissions reply <id> reject`.
6. After replying, follow the job with `/opc:status <job> --wait`.

Rules:

- Never reply `always` (opc refuses it: in OpenCode it applies to the whole directory and overrides the session rules).
- Never pass `--confirmed-by-user` without the user's explicit choice in this conversation.
- Rejecting one permission makes OpenCode reject the other pending requests of the same session; the output lists them.
- Subagents and workers (`opc-rescue`, `opc-worker`) never answer permissions: they hand the request back to the lead.
```

- [ ] **Step 4: Suíte completa**

Run: `npm test`
Expected: 100% verde (F0 + F1 + F2a). Na referência de validação deste plano, as partes da F2a somam 150 testes (unit + integração) e rodam em ~25 s com `--test-concurrency=4`.

Run: `pgrep -af "opc-companion.mjs task-worker|fixtures/bin/opencode"`
Expected: nada (nenhum worker ou servidor falso órfão).

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/skills/opc-result-handling/SKILL.md tests/integration/f2a-commands-md.test.mjs tests/integration/f2a-exit-codes.test.mjs
git commit -m "feat(skills): add opc-result-handling permission rules and pin exit codes"
```


---

### Task 16: Portão da F2a — ao vivo, contrato, documentação, relatório, CHANGELOG

**Files:**
- Create: `tests/live/_f2a-helpers.mjs`, `tests/live/f2a-ask-plan.mjs`, `tests/live/f2a-write.mjs`, `tests/live/f2a-readonly.mjs`, `tests/live/f2a-destructive.mjs`, `tests/live/f2a-jobs.mjs`, `tests/live/f2a-probes.mjs`
- Modify: `docs/commands.md` (anexar a seção "Execução (F2a)")
- Create: `docs/permissions.md`
- Create: `docs/phases/F2a-report.md`
- Modify: `CHANGELOG.md` (entrada em `[Unreleased]`)
- Modify (só se o probe divergir): `plugins/opc/scripts/lib/policy.mjs` (`PATCH_PERMISSION_MODE`), `tests/fixtures/fake-session-api.mjs` (semântica do PATCH), `plugins/opc/scripts/lib/runner.mjs` (`newMessageId`)

**Interfaces:**
- Consumes: tudo o que a fase entregou; helpers `makeTempDir`, `makeWorkspace`, `runCli`, `trackEnv`, `trackTempDir` (F0); `readServerRecord`, `createClient`, `createApi`, `readJob`, `resolveWorkspaceRoot`, `workspaceStateDir`; `PATCH_PERMISSION_MODE`, `newMessageId`.
- Produces: `tests/live/_f2a-helpers.mjs` → `LIVE`, `LIVE_MODEL`, `LIVE_TIMEOUT_MS`, `liveSetup(t, { files })`, `opcLive(ctx, args, { stdin, timeoutMs })`, `sha256(path)`, `jobIdIn(text)`, `liveJob(ctx, id)`, `liveApi(ctx)`, `atLeast(need, of, label, fn)`, `report(label, passed, detail)`. Cada teste ao vivo imprime `LIVE-RESULT <item>: PASSOU|FALHOU` e os probes imprimem `LIVE-ANSWER §15.x …` (entrada do relatório).
- Regras dos testes ao vivo: só com `OPC_LIVE=1` (`{ skip }` caso contrário); workspace e `OPC_DATA_DIR` descartáveis; `HOME` real (credenciais do OpenCode do operador); servidor encerrado no `after`; o canário do `.env` é um valor fictício (`opc-f2a-canary-7f3a9c`), nunca um segredo real.

- [ ] **Step 1: Escrever os helpers e os testes ao vivo**

`tests/live/_f2a-helpers.mjs` (o nome com `_` fica fora do glob `f2a-*.mjs`):

```js
// Shared helpers of the F2a live tests (not a test file). Real OpenCode, real model, throwaway dirs.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, makeWorkspace, runCli, trackEnv, trackTempDir } from '../helpers.mjs';
import { resolveWorkspaceRoot, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { readServerRecord } from '../../plugins/opc/scripts/lib/server.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';

export const LIVE = process.env.OPC_LIVE === '1';
export const LIVE_MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash';
export const LIVE_TIMEOUT_MS = 10 * 60 * 1000;

// Servers are stopped (and the temp dirs removed) by the F0 per-test cleanup: workspace via makeWorkspace,
// the hand-built env via trackEnv, the data dir via trackTempDir.
export function liveSetup(t, { files = {} } = {}) {
  const ctx = {};
  ctx.cwd = makeWorkspace(t, { git: true, name: 'opc-f2a-live' });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(ctx.cwd, path, '..'), { recursive: true });
    writeFileSync(join(ctx.cwd, path), content);
  }
  const dataDir = trackTempDir(t, makeTempDir('opc-f2a-live-data-'));
  ctx.env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir, OPC_COMPANION_SESSION_ID: `live-f2a-${randomBytes(4).toString('hex')}` });
  delete ctx.env.OPC_SERVER_URL;
  delete ctx.env.OPC_INSIDE_SERVER;
  const providerID = LIVE_MODEL.split('/')[0];
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    defaultProvider: providerID,
    defaultModel: LIVE_MODEL,
    policy: { approver: 'user', permissionTimeoutSec: 600 },
  }, null, 2), { mode: 0o600 });
  return ctx;
}

export const opcLive = (ctx, args, { stdin = '', timeoutMs = LIVE_TIMEOUT_MS } = {}) => runCli(args, { env: ctx.env, cwd: ctx.cwd, stdin, timeoutMs });

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function jobIdIn(text) {
  return /\b((?:task|ask|plan)-[0-9a-z]+-[0-9a-z]{6})\b/.exec(text)?.[1] ?? null;
}

export function liveJob(ctx, id) {
  return readJob(workspaceStateDir(ctx.env.OPC_DATA_DIR, resolveWorkspaceRoot(ctx.cwd)), id);
}

export function liveApi(ctx) {
  const record = readServerRecord(workspaceStateDir(ctx.env.OPC_DATA_DIR, resolveWorkspaceRoot(ctx.cwd)));
  if (!record) throw new Error('no server record: run an opc command first');
  return createApi(createClient({ baseUrl: record.url, password: record.password, directory: resolveWorkspaceRoot(ctx.cwd), requestTimeoutMs: 60000 }));
}

// Model-dependent items: run up to `of` times, pass when `need` runs pass (spec §13.2).
export async function atLeast(need, of, label, fn) {
  const outcomes = [];
  for (let i = 0; i < of && outcomes.filter(Boolean).length < need; i += 1) {
    let passed = false;
    try {
      passed = Boolean(await fn(i));
    } catch (err) {
      console.log(`LIVE-DETAIL ${label} run ${i + 1}: ${err.message}`);
    }
    outcomes.push(passed);
    console.log(`LIVE-DETAIL ${label} run ${i + 1}: ${passed ? 'pass' : 'fail'}`);
  }
  const passes = outcomes.filter(Boolean).length;
  console.log(`LIVE-RESULT ${label}: ${passes >= need ? 'PASSOU' : 'FALHOU'} (${passes}/${outcomes.length})`);
  return passes >= need;
}

export function report(label, passed, detail = '') {
  console.log(`LIVE-RESULT ${label}: ${passed ? 'PASSOU' : 'FALHOU'}${detail ? ` — ${detail}` : ''}`);
}
```

`tests/live/f2a-ask-plan.mjs`:

```js
// F2a live: /opc:ask and /opc:plan run read-only; the session carries the read-only rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, jobIdIn, liveApi, liveJob, liveSetup, opcLive, report } from './_f2a-helpers.mjs';

const FILES = { 'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n' };

test('live: /opc:ask answers read-only with file:line', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const r = await opcLive(ctx, ['ask', '--raw-args-stdin'], { stdin: 'Where is the function add defined? Answer with file:line.' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /src\/math\.js/);
  const job = liveJob(ctx, jobIdIn(r.stderr));
  const session = await liveApi(ctx).getSession(job.sessionID);
  assert.deepEqual(session.permission[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.ok(session.permission.some((x) => x.permission === 'doom_loop' && x.action === 'deny'));
  report('ask read-only', true, `session ${job.sessionID}`);
});

test('live: /opc:plan returns a plan read-only', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const r = await opcLive(ctx, ['plan', '--raw-args-stdin'], { stdin: 'Plan adding a sub(a, b) function to src/math.js with tests.' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /src\/math\.js/);
  const job = liveJob(ctx, jobIdIn(r.stderr));
  assert.equal(job.permissionProfile, 'read-only');
  assert.equal(job.result.touchedFiles.length, 0);
  report('plan read-only', true);
});
```

`tests/live/f2a-write.mjs`:

```js
// F2a live: task --write creates a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE, atLeast, liveSetup, opcLive } from './_f2a-helpers.mjs';

test('live: task --write creates a file', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t);
  const target = join(ctx.cwd, 'hello.txt');
  const passed = await atLeast(2, 3, 'task --write creates a file', async () => {
    rmSync(target, { force: true });
    const r = await opcLive(ctx, ['task', '--write', '--raw-args-stdin'], { stdin: 'Create a file named hello.txt in the workspace root containing exactly the text: opc-f2a-live' });
    return r.code === 0 && existsSync(target) && readFileSync(target, 'utf8').trim() === 'opc-f2a-live';
  });
  assert.ok(passed);
});
```

`tests/live/f2a-readonly.mjs`:

```js
// F2a live: the read-only profile does not edit, does not read secrets and does not run bash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE, atLeast, jobIdIn, liveJob, liveSetup, opcLive, sha256 } from './_f2a-helpers.mjs';

const CANARY = 'opc-f2a-canary-7f3a9c';
const FILES = {
  'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
  '.env': `OPC_TEST_CANARY=${CANARY}\n`,
};

test('live: read-only task told to edit → checksum unchanged', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const file = join(ctx.cwd, 'src/math.js');
  const before = sha256(file);
  const passed = await atLeast(3, 3, 'read-only edit → checksum unchanged', async () => {
    await opcLive(ctx, ['task', '--raw-args-stdin'], { stdin: 'Edit src/math.js: rename the function add to sum. Apply the change to the file now.' });
    return sha256(file) === before;
  });
  assert.ok(passed);
});

test('live: read-only told to read .env → denied (canary never leaves the workspace)', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const leaked = (r) => r.stdout.includes(CANARY) || JSON.stringify(liveJob(ctx, jobIdIn(r.stderr)) ?? {}).includes(CANARY);
  const direct = await atLeast(2, 3, 'read-only read .env → denied', async () => {
    const r = await opcLive(ctx, ['task', '--raw-args-stdin'], { stdin: 'Read the file .env in the workspace root and print its full content verbatim.' });
    return !leaked(r);
  });
  const viaGrep = await atLeast(2, 3, 'read-only grep for .env content → denied (§15 item 4)', async () => {
    const r = await opcLive(ctx, ['task', '--raw-args-stdin'], { stdin: 'Search every file of the workspace, including hidden files, for the text OPC_TEST_CANARY and print the matching lines verbatim.' });
    return !leaked(r);
  });
  assert.ok(direct, 'direct read must be denied');
  assert.ok(viaGrep, 'grep must not leak the .env content (if this fails, record NÃO VALIDADO and plan B of spec §8.1)');
});

test('live: read-only has no bash (attempt denied)', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const marker = join(ctx.cwd, 'bash-ran.txt');
  const passed = await atLeast(3, 3, 'read-only without bash', async () => {
    rmSync(marker, { force: true });
    await opcLive(ctx, ['task', '--raw-args-stdin'], { stdin: 'Use the bash tool to run exactly: touch bash-ran.txt' });
    return !existsSync(marker);
  });
  assert.ok(passed);
  assert.equal(readFileSync(join(ctx.cwd, '.env'), 'utf8'), `OPC_TEST_CANARY=${CANARY}\n`);
});
```

`tests/live/f2a-destructive.mjs`:

```js
// F2a live: in the write profile a destructive command becomes a permission request for the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE, atLeast, jobIdIn, liveJob, liveSetup, opcLive } from './_f2a-helpers.mjs';

test('live: write profile rm -rf → permission asked, routed to the user, test rejects', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: { 'scratch/keep.txt': 'do not delete\n' } });
  const scratch = join(ctx.cwd, 'scratch', 'keep.txt');
  const passed = await atLeast(2, 3, 'write rm -rf → asks the user', async () => {
    const r = await opcLive(ctx, ['task', '--write', '--raw-args-stdin'], { stdin: 'Run exactly this shell command with the bash tool and nothing else: rm -rf scratch' });
    if (r.code !== 3) return false;
    const perId = /reply (per_[0-9A-Za-z]+) once/.exec(r.stdout)?.[1];
    const needsUser = /Needs the user: yes/.test(r.stdout);
    const reply = await opcLive(ctx, ['permissions', 'reply', perId, 'reject', 'live test: destructive command rejected']);
    const id = jobIdIn(r.stderr);
    await opcLive(ctx, ['status', id, '--wait', '--timeout-ms', '300000', '--poll-interval-ms', '1000']);
    const job = liveJob(ctx, id);
    return needsUser && reply.code === 0 && existsSync(scratch) && ['completed', 'failed'].includes(job.status);
  });
  assert.ok(passed);
  assert.ok(existsSync(scratch));
});
```

`tests/live/f2a-jobs.mjs`:

```js
// F2a live: background + status --wait + result; cancel of a long turn; --resume keeps the session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, jobIdIn, liveApi, liveJob, liveSetup, opcLive, report } from './_f2a-helpers.mjs';

const FILES = { 'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('live: --background + status --wait + result', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const bg = await opcLive(ctx, ['ask', '--background', '--json', '--raw-args-stdin'], { stdin: 'What does src/math.js export? One sentence.' });
  assert.equal(bg.code, 0, bg.stderr);
  const { jobId } = JSON.parse(bg.stdout);
  const waited = await opcLive(ctx, ['status', jobId, '--wait', '--timeout-ms', '600000', '--poll-interval-ms', '2000']);
  assert.equal(waited.code, 0, waited.stdout);
  const result = await opcLive(ctx, ['result', jobId]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /add/);
  report('background + status --wait + result', true, jobId);
});

test('live: cancel of a long turn', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const bg = await opcLive(ctx, ['task', '--background', '--json', '--raw-args-stdin'], { stdin: 'Write the numbers from 1 to 500, one per line, each followed by one full sentence about it.' });
  const { jobId } = JSON.parse(bg.stdout);
  let job = null;
  for (let i = 0; i < 120; i += 1) {
    job = liveJob(ctx, jobId);
    if (job?.status === 'running' && job.sessionID && job.phase !== 'starting') break;
    await sleep(1000);
  }
  assert.ok(job?.sessionID, 'job started');
  const cancel = await opcLive(ctx, ['cancel', jobId, '--json']);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, 'cancelled');
  const status = await liveApi(ctx).sessionStatus();
  const own = status[job.sessionID];
  assert.ok(!own || own.type === 'idle', JSON.stringify(own));
  report('cancel long turn', true, `session ${job.sessionID} idle`);
});

test('live: --resume keeps the sessionID', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t, { files: FILES });
  const first = await opcLive(ctx, ['ask', '--raw-args-stdin'], { stdin: 'Where is add defined?' });
  assert.equal(first.code, 0, first.stderr);
  const a = liveJob(ctx, jobIdIn(first.stderr));
  const second = await opcLive(ctx, ['ask', '--raw-args-stdin'], { stdin: `--resume ${a.id} And what does it return?` });
  assert.equal(second.code, 0, second.stderr);
  const b = liveJob(ctx, jobIdIn(second.stderr));
  assert.equal(b.sessionID, a.sessionID);
  report('resume keeps sessionID', true, a.sessionID);
});
```

`tests/live/f2a-probes.mjs` (responde §15 itens 3 e 6; falha se o modo do PATCH divergir da constante):

```js
// F2a live probes for spec §15: item 3 (PATCH permission: replace or append) and item 6 (client messageID).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, LIVE_MODEL, liveApi, liveSetup, opcLive, report } from './_f2a-helpers.mjs';
import { PATCH_PERMISSION_MODE } from '../../plugins/opc/scripts/lib/policy.mjs';
import { newMessageId } from '../../plugins/opc/scripts/lib/runner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bootServer(ctx) {
  const r = await opcLive(ctx, ['providers', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return liveApi(ctx);
}

test('live probe §15.3: PATCH /session/:id {permission} replaces or appends?', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t);
  const api = await bootServer(ctx);
  const first = [{ permission: 'bash', pattern: '*', action: 'deny' }];
  const second = [{ permission: 'edit', pattern: '*', action: 'deny' }];
  const session = await api.createSession({ title: 'OPC: probe: patch permission', permission: first });
  await api.patchSession(session.id, { permission: second });
  const after = await api.getSession(session.id);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mode = same(after.permission, second) ? 'replace' : same(after.permission, [...first, ...second]) ? 'append' : 'other';
  console.log(`LIVE-ANSWER §15.3 PATCH permission mode = ${mode}; stored = ${JSON.stringify(after.permission)}`);
  assert.notEqual(mode, 'other');
  assert.equal(mode, PATCH_PERMISSION_MODE, 'update PATCH_PERMISSION_MODE in lib/policy.mjs and the plan if this differs');
  report('PATCH permission probe', true, mode);
});

test('live probe §15.6: client messageID format accepted by prompt_async', { skip: !LIVE && 'OPC_LIVE=1 not set' }, async (t) => {
  const ctx = liveSetup(t);
  const api = await bootServer(ctx);
  const [providerID, ...rest] = LIVE_MODEL.split('/');
  const model = { providerID, modelID: rest.join('/') };
  const session = await api.createSession({ title: 'OPC: probe: messageID', permission: [{ permission: '*', pattern: '*', action: 'deny' }] });
  const messageID = newMessageId();
  await api.promptAsync(session.id, { messageID, model, parts: [{ type: 'text', text: 'Reply with the single word OK.' }] });
  let messages = [];
  for (let i = 0; i < 120; i += 1) {
    messages = await api.messages(session.id, { limit: 20 });
    const reply = messages.find((m) => m.info.role === 'assistant' && m.info.parentID === messageID && m.info.time?.completed);
    if (reply) break;
    await sleep(1000);
  }
  const user = messages.find((m) => m.info.id === messageID);
  const reply = messages.find((m) => m.info.role === 'assistant' && m.info.parentID === messageID);
  console.log(`LIVE-ANSWER §15.6 messageID ${messageID}: user message stored = ${Boolean(user)}; assistant parentID matches = ${Boolean(reply)}`);
  let malformed = 'accepted';
  try {
    const other = await api.createSession({ title: 'OPC: probe: bad messageID', permission: [{ permission: '*', pattern: '*', action: 'deny' }] });
    await api.promptAsync(other.id, { messageID: 'msg_not-a-real-id', model, parts: [{ type: 'text', text: 'Reply OK.' }] });
    await sleep(2000);
    await api.abort(other.id);
  } catch (err) {
    malformed = `rejected (${err.code ?? err.message})`;
  }
  console.log(`LIVE-ANSWER §15.6 malformed "msg_not-a-real-id": ${malformed}`);
  assert.ok(user, 'client messageID must be kept as the user message id');
  assert.ok(reply, 'assistant parentID must reference the client messageID');
  report('messageID probe', true, messageID);
});
```

Run (sem `OPC_LIVE`): `node --test tests/live/f2a-*.mjs`
Expected: todos `skipped` (nenhum OpenCode é chamado).

- [ ] **Step 2: `npm test` final**

Run: `npm test 2>&1 | tee "${TMPDIR:-/tmp}/opc-f2a-npm-test.txt"`
Expected: 100% verde. Guardar a saída para o relatório.

- [ ] **Step 3: Checklist ao vivo**

Pré-requisitos: OpenCode 1.18.32 instalado, provider `omniroute-mvalmeida` autenticado (`opencode auth list`), nenhum `opencode serve` do operador será tocado (o opc só sinaliza processos com identidade conferida).

Run:

```bash
OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f2a-*.mjs 2>&1 | tee "${TMPDIR:-/tmp}/opc-f2a-live.txt"
grep -E "LIVE-(RESULT|ANSWER|DETAIL)" "${TMPDIR:-/tmp}/opc-f2a-live.txt"
```

Expected: todas as linhas `LIVE-RESULT` com `PASSOU`; duas linhas `LIVE-ANSWER §15.3`/`§15.6`. Item que falhe por comportamento do modelo depois de 3 execuções → `NÃO VALIDADO` com o motivo; item que falhe por defeito do opc → corrigir (TDD na tarefa dona) e repetir.

- [ ] **Step 4: Aplicar as respostas do §15**

- `LIVE-ANSWER §15.3 … mode = append`: nada a mudar (D1 confirmada).
- `mode = replace`: em `plugins/opc/scripts/lib/policy.mjs` trocar `export const PATCH_PERMISSION_MODE = 'append';` por `'replace'`; em `tests/fixtures/fake-session-api.mjs` trocar `session.permission = [...(session.permission ?? []), ...body.permission];` por `session.permission = body.permission;`; em `tests/integration/f2a-resume.test.mjs` o caso "read-only → write" passa a esperar exit 0 e um `PATCH`; ajustar `f2a-fake-session.test.mjs` (PATCH substitui) e `docs/permissions.md` ("Troca de perfil"). Rodar `npm test` e o probe de novo.
- `§15.6` com "user message stored = false" ou "parentID matches = false": corrigir `newMessageId` conforme o formato observado e o teste `newMessageId` de `tests/unit/runner.test.mjs`; repetir o probe.
- Grep vazando o canário (item 6): registrar `NÃO VALIDADO` + plano B do §8.1 como pendência no relatório (não muda código nesta fase).

- [ ] **Step 5: Teste de contrato**

Run: `OPC_LIVE=1 node tests/live/contract.mjs`
Expected: sem divergência; ou divergência registrada no relatório e o fake atualizado (com teste) na mesma branch.

- [ ] **Step 6: Documentação**

Anexar ao fim de `docs/commands.md` (as saídas dos exemplos devem ser trocadas pelas saídas reais das execuções dos Steps 3 e 5, com caminhos pessoais redigidos para `~`):

`````markdown

## Execução (F2a)

Todo turno roda num **worker destacado** (`opc task-worker`), registrado como job em
`<estado>/jobs/<id>.json`. O comando em primeiro plano só acompanha o job; em segundo plano
(`--background`) ele devolve o id na hora.

Ids de job: `<tipo>-<base36(ms)>-<rand6>`, por exemplo `task-mfx3k2a1-9q7w2e`. Qualquer comando
que recebe um id aceita também um prefixo único.

### Códigos de saída

| Código | Quando |
|---|---|
| 0 | Sucesso |
| 2 | Uso inválido: flag desconhecida, conflito (`--resume` com `--fresh`), id ausente ou ambíguo, `jobs.maxActive` atingido, sessão já ocupada por outro job, troca de perfil não suportada no resume |
| 3 | O job está vivo em `waiting_permission`: há pedido de permissão ou pergunta pendente |
| 4 | Negado pela política (modelo, provider, agente, aprovador) ou recusa de recursão (`OPC_INSIDE_SERVER=1`) |
| 5 | Conexão/servidor (servidor não sobe, 401, versão não suportada) |
| 6 | `--wait-timeout` (ou `status --timeout-ms`) estourou; o job **continua** e o id é impresso |
| 7 | O job terminou em `failed` |
| 130 | O job terminou em `cancelled` |

### `/opc:task`

Delega uma tarefa ao OpenCode. Sem `--write`, o perfil é `read-only`.

```
/opc:task [--write | --profile <nome>] [--model <m>] [--agent <a>] [--variant <v> | --effort <v>]
          [--tier <t>] [--resume [id] | --resume-last | --fresh] [--background]
          [--prompt-file <arquivo>] [--timeout <s>] [--wait-timeout <s>] <prompt>
```

| Flag | Efeito |
|---|---|
| `--write` | Perfil `write`: herda o agente (`build`) e as regras do usuário, mais as invariantes; comandos destrutivos viram pedido ao usuário |
| `--profile <nome>` | Perfil `custom:<nome>` de `permissionProfiles` (base read-only + regras do perfil + invariantes) |
| `-m`, `--model` | Alias, ID completo (`provider/modelo`, com barras) ou nome curto no `defaultProvider` |
| `--agent` | Agente do OpenCode (validado contra `/agent` e a política; agentes só-subagente são recusados) |
| `--variant`, `--effort` | Variant do modelo; `--effort` é alias e passa pela mesma validação |
| `--tier` | Usa `routing.tiers.<tier>` (o primeiro candidato válido; fallback é da F4a) |
| `--resume [id]` | Continua a sessão de um job (id de job) ou uma sessão (`ses_…`). Sem id = `--resume-last` |
| `--resume-last` | Último job terminado do mesmo tipo nesta sessão do Claude |
| `--fresh` | Sessão nova (conflita com `--resume`) |
| `--background` | Devolve o id e sai |
| `--prompt-file` | Lê o prompt de um arquivo (bytes intactos) |
| `--timeout <s>` | Prazo do **turno** (padrão 1800 s). Estourou: o opc aborta a sessão e o job falha (`Timeout`, recuperável) |
| `--wait-timeout <s>` | Prazo da **espera** em primeiro plano (padrão 540 s). Estourou: exit 6 e o job continua |

- O prompt também pode vir por stdin (`echo "…" | opc task`).
- `--resume` sem prompt usa `prompts/continue.md`.
- O slash command passa os argumentos por `--raw-args-stdin` em heredoc com delimitador entre
  aspas: o texto chega ao OpenCode exatamente como digitado (aspas, apóstrofos, crases, `$()`,
  quebras de linha, unicode) e nada é expandido pelo shell. Flags só são reconhecidas como
  palavras inteiras; depois de um `--` isolado, tudo é prompt.
- Convenção de todos os comandos do opc: **texto livre** (`task`, `ask`, `plan` e, nas fases
  seguintes, `review`, `adversarial-review`, `subagent`, `command`, `orchestrate`, `conclave`)
  usa `--raw-args-stdin`; comandos **só de flags/ids** (`status`, `result`, `cancel`,
  `permissions`, …) usam `--args-stdin` (divisão tipo shell, sem expansão). Quem chama por
  script ou agente escreve as flags na linha de comando e começa o heredoc com uma linha `--`,
  para que nada do texto vire flag:

  ```
  opc task --write --wait-timeout 540 --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
  --
  <texto exatamente como recebido>
  OPC_ARGS_5f1d0c7a_EOF  ```
- Se `project` estiver configurado, o prompt começa com um bloco `<project_context>`.
- Dentro do servidor do plugin (`OPC_INSIDE_SERVER=1`) o opc recusa criar jobs (exit 4).

Exemplo (primeiro plano):

```
$ opc task "explique o que o runner faz quando o SSE cai"
[opc] job task-mfx3k2a1-9q7w2e started (omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash); follow it with /opc:status task-mfx3k2a1-9q7w2e
[opc] session ses_0dde6c1f9a2bQm8sX1LwZ0pR7c
[opc] read: plugins/opc/scripts/lib/runner.mjs
O runner ressincroniza depois de cada reconexão: consulta /session/status, as filhas, …

---
Job: task-mfx3k2a1-9q7w2e · Session: ses_0dde6c1f9a2bQm8sX1LwZ0pR7c · Model: omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash
Continue: /opc:task --resume task-mfx3k2a1-9q7w2e
```

Exemplo (escrita em segundo plano):

```
$ opc task --write --background "crie docs/exemplo.md com um parágrafo sobre o opc"
opc job task-mfx3m0c4-a81kd2 queued in background (task, omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash).
- Status: /opc:status task-mfx3m0c4-a81kd2
- Wait: /opc:status task-mfx3m0c4-a81kd2 --wait
- Result: /opc:result task-mfx3m0c4-a81kd2
- Cancel: /opc:cancel task-mfx3m0c4-a81kd2
```

### `/opc:ask` e `/opc:plan`

Modos read-only com prompt próprio e rota própria:

| Comando | Prompt | Rota | Saída esperada |
|---|---|---|---|
| `/opc:ask <pergunta>` | `prompts/ask.md` | `routing.tasks.ask` | Resposta direta com `arquivo:linha`, sem preâmbulo |
| `/opc:plan <tarefa>` | `prompts/plan.md` | `routing.tasks.plan` | Goal, Files, Steps, Trade-offs, Risks, Tests, Open questions |

Aceitam as mesmas flags de modelo, `--background`, `--resume`/`--fresh`, `--timeout` e
`--wait-timeout` do `task`. `--write` e `--profile` são recusados (exit 2).

```
$ opc ask "onde a política nega agentes?"
A negação de agentes vira regra `task <glob> deny` em `plugins/opc/scripts/lib/policy.mjs:73` …
```

### `/opc:status`

```
/opc:status [job-id] [--wait] [--timeout-ms 240000] [--poll-interval-ms 2000] [--all]
```

- Sem id: tabela compacta dos jobs desta sessão do Claude (ativos, com até 4 linhas de
  progresso, e até 8 recentes). `--all`: todas as sessões, sem limite.
- Com id: detalhes do job (fase, modelo, sessão, filhas, erro, pedidos pendentes, log).
- `--wait` exige id e espera o job terminar ou pedir permissão. Saída: 0 (`completed`),
  3 (`waiting_permission`), 7 (`failed`), 130 (`cancelled`), 6 (prazo estourou; o job continua).

```
$ opc status
# opc status

Active jobs:

| Job | Kind | Status | Phase | Elapsed | Session | Summary | Actions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task-mfx3m0c4-a81kd2 | task | running | editing | 12s | ses_0dde6c2… | crie docs/exemplo.md … | `/opc:status task-mfx3m0c4-a81kd2 --wait` `/opc:cancel task-mfx3m0c4-a81kd2` |
```

### `/opc:result`

```
/opc:result [job-id]
```

Mostra o resultado guardado: texto final, saída estruturada, arquivos tocados e a linha para
continuar. Sem id: o último job terminado desta sessão do Claude. Job ativo (inclusive
`waiting_permission`) → exit 2 "still running". A saída segue o estado do job: 0, 7 ou 130.
Quando a saída estruturada falha (`StructuredOutputError`), o texto bruto aparece em
"Raw output".

### `/opc:cancel`

```
/opc:cancel [job-id]
```

1. marca o pedido de cancelamento no job;
2. `POST /session/:id/abort` (e nas sessões filhas) e espera o idle por até 10 s;
3. encerra o worker **só** se a identidade confere (cmdline `opc-companion.mjs task-worker
   --job-id <id>` + horário de início); pid reciclado nunca recebe sinal;
4. marca `cancelled`.

Sem id: cancela o único job ativo desta sessão do Claude; com vários ativos, lista-os e sai
com 2.

### `/opc:permissions`

```
/opc:permissions list
/opc:permissions reply <id> once|reject [mensagem] [--confirmed-by-user]
/opc:permissions answer <id-da-pergunta> <resposta...>
```

- `list`: pedidos pendentes no servidor do workspace (permissões e perguntas), com o job dono.
- `reply … once`: com aprovador `user` (padrão), exige `--confirmed-by-user`, que o Claude só
  passa depois de perguntar ao usuário (AskUserQuestion). Com aprovador `claude`, a flag só é
  exigida para pedidos destrutivos, de `external_directory` ou de caminhos sensíveis.
- `reply … reject [mensagem]`: sempre permitido; o OpenCode rejeita junto os outros pedidos
  pendentes da mesma sessão, e a saída lista esses irmãos.
- `reply … always`: recusado (exit 2). Veja [permissões](permissions.md#por-que-nunca-always).
- `answer`: um argumento por pergunta, na ordem; várias opções de uma pergunta de múltipla
  escolha separadas por `|`; texto livre quando a pergunta permite.
- Um id de pergunta (`que_…`) aceita `reply <id> reject`.

````
$ opc task --write "limpe a pasta build"
# opc: waiting for a decision

Job: task-mfx3q7d1-0c2b9z (task) · Session: ses_0dde6c4…

## Request per_0dde6c4f00a1Xk2mQ9rT5vB8nL

- Tool: bash
- Patterns:
```text
rm -rf build
```
- Needs the user: yes (destructive command, external directory or sensitive path)
- Reply:
  - `/opc:permissions reply per_0dde6c4f00a1Xk2mQ9rT5vB8nL once`
  - `/opc:permissions reply per_0dde6c4f00a1Xk2mQ9rT5vB8nL reject "<reason>"`

Afterwards: `/opc:status task-mfx3q7d1-0c2b9z --wait`
Unanswered requests are rejected automatically after 600 s.
$ echo $?
3
$ opc permissions reply per_0dde6c4f00a1Xk2mQ9rT5vB8nL reject "sem apagar nada hoje"
Replied reject to per_0dde6c4f00a1Xk2mQ9rT5vB8nL (bash).
Follow the job: /opc:status task-mfx3q7d1-0c2b9z --wait
````

### `opc gc` (terminal)

```
opc gc [--days 30] [--confirmed-by-user]
```

Lista os estados de workspace sem uso há mais de `--days` dias (sem jobs ativos e sem servidor
vivo; o workspace atual nunca entra) e pede confirmação no terminal. Sem TTY, só remove com
`--confirmed-by-user`; sem a flag, lista e sai com 2.

### `opc task-resume-candidate --json` (interno)

Usado pelo `/opc:rescue` (F2b) para perguntar "continuar ou começar nova":
`{available, sessionId, candidate: {id, kind, status, title, summary, sessionID, completedAt, updatedAt}}`.
`--kind task|ask|plan` (padrão `task`).
`````

Criar `docs/permissions.md`:

````markdown
# Permissões

O opc nunca altera a configuração global do OpenCode. Cada sessão que ele cria recebe um
**perfil** de regras `{permission, pattern, action}`; o OpenCode avalia "a última regra que
casa vence", e as regras da sessão vencem as do agente e as da config global. Por isso a ordem
abaixo é a ordem de envio.

## Perfis

### `read-only` (padrão)

Usado por `task` sem `--write`, `ask`, `plan` e, nas próximas fases, review, stop gate,
conclave e decomposição.

1. `* * deny`: nega tudo;
2. `allow` para `read`, `glob`, `grep`, `list`, `lsp`, `skill` e `todowrite`;
3. as invariantes (abaixo), com `doom_loop * deny` no fim.

Nada de bash, edit, task (subagentes), webfetch, websearch ou question. Qualquer pedido que
ainda assim surja é rejeitado na hora pela ponte (defesa em profundidade).

### `write` (`--write`)

Herda o agente (`build`) e as regras do usuário; o opc só acrescenta as invariantes, incluindo
`bash <padrão> ask` para a lista destrutiva e `doom_loop * ask`.

### `custom:<nome>` (`--profile <nome>`)

Base `read-only` + as regras de `permissionProfiles.<nome>` (config global, chave travada) +
invariantes. Se o perfil liberar `bash`, a lista destrutiva também é anexada como `ask`.

```json
"permissionProfiles": {
  "npm-test-only": [ { "permission": "bash", "pattern": "npm test", "action": "allow" } ]
}
```

Não existe perfil nem flag "libera tudo".

## Invariantes (sempre por último, em todos os perfis)

1. `external_directory * deny`;
2. para cada padrão de `policy.sensitivePaths`: `read`, `grep`, `glob` e `list` → `deny`
   (padrão: `*.env`, `*.env.*`, `**/.ssh/**`, `*.pem`, `*.key`, `**/id_rsa*`, `**/id_ed25519*`,
   `**/secrets.env`);
3. para cada agente negado (`policy.agents.deny`): `task <glob> deny`;
4. para cada ferramenta negada (`policy.tools.deny`): `<padrão> * deny`;
5. só em `write` (e em `custom` com bash): `bash <padrão> ask` para a lista destrutiva;
6. `doom_loop *`: `ask` em `write`, `deny` nos demais.

Nos globs, `*` casa qualquer sequência, inclusive `/`.

### Lista destrutiva embutida

`rm -rf*`, `rm -r *`, `rm -fr*`, `git push --force*`, `git push -f*`, `git push --delete*`,
`git reset --hard*`, `git clean -f*`, `git branch -D*`, `git tag -d*`, `docker rm*`,
`docker rmi*`, `docker volume rm*`, `docker system prune*`, `docker compose down -v*`,
`kubectl delete*`, `mkfs*`, `dd *of=*`, `shred*`, `truncate -s 0*`, `find * -delete*`,
`shutdown*`, `reboot*`, `poweroff*`, `systemctl stop*`, `*DROP DATABASE*`, `*DROP TABLE*`,
`*TRUNCATE*`.

`policy.destructiveBash` acrescenta padrões (nunca remove). Esses pedidos vão **sempre** ao
usuário, qualquer que seja o aprovador.

### Sessões filhas

No OpenCode 1.18.32 uma sessão filha criada pela ferramenta `task` herda do pai só as regras
`deny` e as de `external_directory`. Para que um subagente não escape das perguntas
destrutivas, o opc aplica o perfil do job à filha (`PATCH /session/:filha`) assim que o
`session.created` chega. É defesa em profundidade: entre a criação da filha e o PATCH há uma
janela curta.

## Ponte de pedidos

Todo turno roda num worker. Quando surge `permission.asked` ou `question.asked` (da sessão ou
de uma filha):

- **read-only**: o worker responde `reject` na hora ("opc: read-only profile; request rejected");
- **write/custom**: o job vai para `waiting_permission` com o pedido em `pendingRequest`;
  - em primeiro plano, o comando sai com **exit 3** e imprime o pedido e as linhas prontas
    `/opc:permissions reply <id> once|reject` e `/opc:status <job> --wait`;
  - o worker continua vivo até a resposta ou até `policy.permissionTimeoutSec` (padrão 600 s);
    sem resposta, `reject` com a mensagem "opc: no approver available" (perguntas: `question reject`).
- **Irmãos**: rejeitar um pedido faz o OpenCode rejeitar os outros pendentes da mesma sessão;
  o job remove todos ao receber os `permission.replied`.

## Aprovador (`policy.approver`)

| Aprovador | `reply once` | `reply reject` |
|---|---|---|
| `user` (padrão) | exige `--confirmed-by-user`; a skill `opc-result-handling` faz o Claude perguntar ao usuário (AskUserQuestion) antes | livre |
| `claude` | livre, **exceto** destrutivo, `external_directory` e caminho sensível, que exigem `--confirmed-by-user` | livre |

Sem a confirmação exigida, o companion recusa com exit 4. Os agentes `opc-worker` e
`opc-rescue` nunca respondem permissões.

## Por que nunca `always`

No OpenCode 1.18.32, uma resposta `always` fica guardada em memória para o **diretório
inteiro**: vale para todas as sessões da instância e é avaliada depois das regras da sessão,
passando por cima de um `deny` do perfil. Por isso o opc só envia `once` ou `reject`, recusa
`reply … always` (exit 2) e a própria camada de API se recusa a montar esse corpo.

## Troca de perfil no `--resume`

O `PATCH /session/:id {permission}` do OpenCode 1.18.32 **anexa** as regras (não substitui).
Consequência:

- retomar com o mesmo perfil: nada é enviado;
- retomar em `read-only` (ou `custom`) uma sessão criada em `write`: o opc anexa o perfil novo;
  como ele começa com `* * deny`, as regras anteriores deixam de valer;
- retomar em `write` uma sessão criada em `read-only`: recusado (exit 2,
  `PROFILE_SWITCH_UNSUPPORTED`), porque o `* * deny` antigo continuaria valendo. Use `--fresh`.

(Resultado confirmado ao vivo pelo probe da F2a; ver `docs/phases/F2a-report.md`.)
````

Executar de verdade cada exemplo (com `opc` apontando para o estado de teste do Step 3 ou num workspace descartável) e colar as saídas reais no lugar das ilustrativas.

Run: `node scripts/scan-secrets.mjs docs/`
Expected: nenhum achado (exit 0).

- [ ] **Step 7: Relatório da fase**

Criar `docs/phases/F2a-report.md` com o modelo abaixo e preencher cada célula com o resultado real (Steps 2–6):

````markdown
# Relatório da fase F2a — Núcleo de execução

- **Data do portão:** —
- **Branch / PR:** `feat/opc-f2a` / —
- **OpenCode:** — (`opencode --version`; alvo 1.18.32)
- **Node:** — · **SO:** Linux
- **Modelo ao vivo:** `omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash`
- **Legenda:** `PASSOU` · `N/A` (com justificativa) · `NÃO VALIDADO` (com motivo) · `DESVIO`

## 1. `npm test`

| Total | Pass | Fail | Duração |
|---|---|---|---|
| — | — | — | — |

<details><summary>Saída completa (redigida)</summary>

```text
(colar aqui a saída de `npm test`)
```

</details>

## 2. Checklist ao vivo (spec §13.3, F2a)

Itens que dependem do modelo rodam até 3 vezes e passam com ≥ 2 (linhas `LIVE-DETAIL`).

| # | Item | Teste | Resultado | Evidência (linha `LIVE-RESULT`, ids) |
|---|---|---|---|---|
| 1 | `/opc:ask` em read-only | `f2a-ask-plan.mjs` | — | — |
| 2 | `/opc:plan` em read-only | `f2a-ask-plan.mjs` | — | — |
| 3 | `task --write` cria um arquivo | `f2a-write.mjs` | — | — |
| 4 | `task` read-only mandado editar → checksum inalterado | `f2a-readonly.mjs` | — | — |
| 5 | read-only mandado ler `.env` de teste → negado | `f2a-readonly.mjs` | — | — |
| 6 | read-only com `grep` pelo conteúdo do `.env` → sem vazamento (§15 item 4) | `f2a-readonly.mjs` | — | — |
| 7 | read-only sem bash (tentativa → negada) | `f2a-readonly.mjs` | — | — |
| 8 | `write`: `rm -rf` de teste vira pedido ao usuário (teste responde reject) | `f2a-destructive.mjs` | — | — |
| 9 | `--background` + `status --wait` + `result` | `f2a-jobs.mjs` | — | — |
| 10 | `cancel` de turno longo | `f2a-jobs.mjs` | — | — |
| 11 | `--resume` mantém a `sessionID` | `f2a-jobs.mjs` | — | — |
| 12 | `PATCH` de permissão em resume (§15 item 3) | `f2a-probes.mjs` | — | — |
| 13 | Formato do `messageID` do cliente (§15 item 6) | `f2a-probes.mjs` | — | — |
| 14 | `contract.mjs` | `tests/live/contract.mjs` | — | — |

<details><summary>Saída ao vivo (redigida)</summary>

```text
(colar aqui a saída de `OPC_LIVE=1 node --test --test-concurrency=1 tests/live/f2a-*.mjs`)
```

</details>

## 3. Itens A CONFIRMAR da fase (spec §15)

| Item | Resposta | Evidência | Consequência |
|---|---|---|---|
| 3 — `PATCH /session/:id {permission}` substitui ou anexa? | — | linha `LIVE-ANSWER §15.3` | `append` confirma D1. Se `replace`: `PATCH_PERMISSION_MODE = 'replace'`, fake com substituição, teste de troca de perfil ajustado (qualquer troca passa a ser permitida) |
| 6 — formato aceito do `messageID` do cliente | — | linhas `LIVE-ANSWER §15.6` | Se o id gerado não for aceito ou não virar o id da mensagem do usuário: corrigir `newMessageId` e o teste unitário |
| 4 (reconfirmação) — `grep` respeita os caminhos sensíveis? | — | item 6 da tabela 2 | Se vazar: registrar `NÃO VALIDADO` e abrir o plano B do §8.1 (agente `opc-readonly` via `server.configOverride`) para a próxima fase |

## 4. Teste de contrato

| Resultado | Divergências | Fake atualizado? |
|---|---|---|
| — | — | — |

## 5. Decisões e desvios

As decisões D1–D20 do plano da F2a valem como registradas lá. Desvios encontrados na execução:

| # | Desvio | Motivo | Muda interface? | Aprovado por |
|---|---|---|---|---|
| — | — | — | — | — |

## 6. Documentação

- `docs/commands.md` — seção "Execução (F2a)": —
- `docs/permissions.md`: —
- Exemplos trocados pelas saídas reais (caminhos pessoais redigidos): —
- `node scripts/scan-secrets.mjs docs/`: —

## 7. CHANGELOG

- Entrada "F2a — núcleo de execução" em `[Unreleased]`: —

## 8. Gravação dupla

- `.ai-data/<categoria>-<DDMMYY>.md`: —
- Colmeia `myprojects` (`mnemosyne_remember`, 1 fato por item, sem segredos): — fatos

## 9. Pendências para a próxima fase

- —
````

Run: `node scripts/scan-secrets.mjs docs/`
Expected: nenhum achado.

- [ ] **Step 8: CHANGELOG**

Em `CHANGELOG.md`, dentro de `## [Unreleased]`, acrescentar:

```markdown
### Added — F2a (núcleo de execução)

- `/opc:task`, `/opc:ask` e `/opc:plan`: turnos no OpenCode em worker destacado, com resolução de modelo (flag, tier, modelo do tipo, rota, `defaultModel`, default do OpenCode), `--effort` como alias de `--variant`, `--resume`/`--resume-last`/`--fresh`, `--background`, `--timeout` (turno) e `--wait-timeout` (espera), prompt por argumento, arquivo ou stdin, bloco `<project_context>`.
- Prompts `ask.md`, `plan.md` e `continue.md`.
- Perfis de permissão `read-only`, `write` e `custom:<nome>` com as invariantes (diretório externo, caminhos sensíveis, agentes e ferramentas negados, lista destrutiva, `doom_loop`), aplicados também às sessões filhas.
- Ponte de permissões e perguntas: `waiting_permission` com exit 3, reject automático no prazo (`policy.permissionTimeoutSec`), irmãos rejeitados juntos; `/opc:permissions list|reply|answer` com as regras do aprovador; `always` nunca é enviado.
- Jobs: `/opc:status` (com `--wait`), `/opc:result`, `/opc:cancel` (abort + identidade do worker), `jobs.maxActive`, poda de 50 terminais, um job por sessão OpenCode, `opc task-resume-candidate --json`.
- Classificação da união de erros do OpenCode (recuperável × fatal), teto de retries do provider, queda do servidor no meio do turno (`server_lost`).
- `opc gc` para estados de workspace sem uso, com confirmação.
- Skill interna `opc-result-handling` (apresentação e pedidos de permissão).
- Documentação: `docs/commands.md` (execução) e `docs/permissions.md`.
```

- [ ] **Step 9: Commit da documentação e dos testes ao vivo**

```bash
git add tests/live/_f2a-helpers.mjs tests/live/f2a-*.mjs docs/commands.md docs/permissions.md docs/phases/F2a-report.md CHANGELOG.md
git commit -m "docs: document F2a execution commands, permissions and gate report"
```

(Se o Step 4 mudou código, commitá-lo antes, separado: `fix(policy): apply live PATCH semantics` ou `fix(runner): match OpenCode messageID format`.)

- [ ] **Step 10: Checklist comum do portão (mestre)**

- [ ] `npm test` 100% verde; saída no relatório.
- [ ] Checklist ao vivo executado; saída redigida no relatório; instáveis com ≥ 2/3.
- [ ] `contract.mjs` sem divergência (ou registrada + fake atualizado).
- [ ] `docs/commands.md` e `docs/permissions.md` com exemplos executados; `scan-secrets` limpo.
- [ ] `docs/phases/F2a-report.md` com `PASSOU` / `N/A` / `NÃO VALIDADO` / desvios e as respostas de §15 itens 3 e 6.
- [ ] `CHANGELOG.md` atualizado.
- [ ] Aviso ao operador com o resumo (itens, respostas do §15, desvios). Push e PR (`feat/opc-f2a` → `main`, relatório no corpo, **sem** linha de atribuição) só com autorização explícita; merge só depois de avisar.
- [ ] Gravação dupla dos fatos relevantes (respostas do §15, decisões D1–D5, D9): `.ai-data/<categoria>-<DDMMYY>.md` e colmeia `myprojects` via `mnemosyne_remember` (1 fato por item, prefixo `[DD/MM/AAAA]`, sem segredos), com a contagem informada ao operador.
- [ ] Antes de iniciar a F2b: revisar o plano da F2b à luz das respostas (`docs: adjust F2b plan after F2a gate`).


---

## Cobertura da spec (F2a)

| Spec | Onde |
|---|---|
| §4 comandos F2a (`task`, `ask`, `plan`, `status`, `result`, `cancel`, `permissions`, `gc`) e regras transversais (`--effort`, `--resume`×`--fresh`, `continue.md`) | Tarefas 10–14; slash commands nas Tarefas 10, 11, 13 |
| §4.1 exit codes | `exitCodeForJob`, `followJob` (Tarefa 10); `f2a-exit-codes.test.mjs` (Tarefa 15) |
| §6 resolução níveis 1–7, validação, política, modelos fixados por agente, "antes de criar sessão" | Tarefa 3; uso na Tarefa 10 (tudo antes do `createJob`) |
| §7 turno (sessão, contexto, SSE, envio, fases, fim, extração) | Tarefa 5; `<project_context>` na Tarefa 10 |
| §7.1 classificação | Tarefa 1; teto de retries e timeout no runner (Tarefa 5) |
| §8.1 perfis e invariantes (ordem exata) | Tarefa 2; asserção no fake: `f2a-profiles.test.mjs` |
| §8.2 ponte (primeiro plano exit 3, background, read-only reject imediato, irmãos, perguntas `string[][]`, timeout) | runner (Tarefa 5), `createRequestBridge` (Tarefa 10), `permissions` (Tarefa 13) |
| §8.3 aprovador e `always` | `checkReply` (Tarefa 2), `api.replyPermission` (Tarefa 6), `permissions` (Tarefa 13), skill (Tarefa 15) |
| §8.4 lado Claude Code (`allowed-tools`, sem bypass) | slash commands; `f2a-commands-md.test.mjs` |
| §9.1 jobs (registro, status, id, grupos básicos, limites, poda, worker uniforme, foreground/background, cancel, recursão) | Tarefa 7; worker (Tarefa 10); status/result/cancel (Tarefa 11) |
| §9.2 resume e concorrência por sessão, `task-resume-candidate` | Tarefas 7, 10 e 12 |
| §10.1 ask/plan | Tarefa 10 (prompts, rotas `routing.tasks.ask|plan`, read-only) |
| §13.3 F2a — aceite de integração | Tarefas 9–15 (um teste por item; ver Review Focus) |
| §13.3 F2a — aceite ao vivo | Tarefa 16 |
| §15 itens 3 e 6 | D1, D2; `f2a-probes.mjs` (Tarefa 16) |
| §3.2 `opc gc` | Tarefa 14 |
| §12 documentação da fase | Tarefa 16 |

---

## Interfaces novas

Acréscimos ao contrato congelado do mestre (nenhuma assinatura existente muda; parâmetros novos são opcionais e ao fim).

### `lib/errors.mjs`

- `retryExceedsCap(status, fallbackCfg = {}, now = Date.now())` — terceiro parâmetro opcional e **posicional** (`status.next` é epoch ms). Forma canônica: a F4a mantém a assinatura (só acrescenta guardas).

### `lib/policy.mjs`

- Constantes: `READ_ONLY_ALLOW`, `SENSITIVE_PATH_PERMISSIONS` (`['read','grep','glob','list']`), `DEFAULT_SENSITIVE_PATHS`, `PATCH_PERMISSION_MODE` (`'append'`).
- `sensitivePathsOf(policy)`, `destructiveBashOf(policy)`, `parseProfile(profile)` → `{ kind, name }`, `invariantRules(profile, { policy, deniedAgentGlobs, bridged })`, `bridgeModeOf(profile)` → `'auto-reject'|'bridge'`, `planPermissionSwitch(current, desired, mode)` → `'none'|'patch'` (ou `UsageError('PROFILE_SWITCH_UNSUPPORTED')`), `endsWithRules(current, desired)`.
- `checkReply(...)` devolve também `code: 'INVALID_REPLY'|'NEEDS_USER'` quando `ok: false`.

### `lib/routing.mjs`

- `validateSelection({ candidate, variant, agentName, agents, catalog, policy })` → `{ variant, agent }`. Sem regra própria: variant por `validateVariant` (F1 `models.mjs`; erro `UsageError('UNKNOWN_VARIANT')`, exit 2 — o código antigo `INVALID_VARIANT` não existe); agente = existe? (`UNKNOWN_AGENT`) + `assertAgentUsable` (F1 `policy.mjs`: nome + provider e modelo fixados, `PolicyError('POLICY_DENIED')`) + recusa `mode === 'subagent'` (`AGENT_MODE`).
- `candidates[].source` ∈ `flag|tier|kind|route|default|opencode`.

### `lib/args.mjs`

- `parsePromptArgs(raw, flagSpec)` → `{ argv, prompt }`; tipo de flag `'optional-string'` com `match: RegExp`.
- `RAW_ARGS_FLAG = '--raw-args-stdin'` e `readRawArgs(argv, flagSpec, { stdin = process.stdin } = {})` → `{ argv, text: string|null }` — helper único dos comandos de texto livre (convenção D4). Uso típico numa fase posterior: `const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });` → `parseArgs(raw.argv, SPEC)` → `CONFLICT` se `raw.text` e positionals → `const text = raw.text ?? positionals.join(' ')`; o `SPEC.flags` declara `'raw-args-stdin': { type: 'boolean' }`.

### `lib/runner.mjs`

- `runTurn({ …, onRequestResolved })` — callback opcional `({ type, requestID, sessionID, outcome })`.
- `request.childPermission`, `request.statusPollMs` (padrão 5000), `request.idleWaitMs` (padrão 10000).
- Resultado com `messageID` e `errorCode` (`turn_timeout|retry_cap|bad_request|server_lost|cancelled|model_error`).
- Eventos de progresso `{ phase?, message?, sessionID?, childSessionID? }`.
- `newMessageId(now = Date.now())`; exports `EDIT_TOOLS`, `STRUCTURED_OUTPUT_TOOL`, `filesFromToolPart(part)`, `turnMessages(messages, messageID)`, `extractTurn(turn, { childMessages, diffs })`.

### `lib/api.mjs`

- `sessionWriteMethods(client)` (espalhada em `createApi`); `replyPermission` recusa tudo que não for `once`/`reject`.

### `lib/jobs.mjs`

- `createJob(stateDir, fields, { maxActive = 8 })`; `updateJob(stateDir, id, patch | (job) => patch)`; `spawnWorker(ctx, jobId)` → `Promise<job>`; `cancelJob(ctx, id, { api, idleWaitMs, exitWaitMs, graceMs })` → `{ job, report: { jobId, aborted, idle, worker } }`.
- `TERMINAL_STATUSES`, `MAX_TERMINAL_JOBS`, `LOG_LIMIT_BYTES`, `COMPANION_PATH`, `isActive(job)`, `isTerminal(job)`, `jobsDir(stateDir)`, `jobLogPath(stateDir, id)`, `workerLogPath(stateDir, id)`, `reconcileJob(stateDir, job)`, `findResumeCandidate(stateDir, { kind, claudeSessionId })`, `groupStatus(members)`, `capLogFile(file, limit)`, `readJobProgress(stateDir, id, maxLines = 4)`, `acquireSessionLock(stateDir, sessionID)` → `release|null`, `serverContext(ctx)`, `existingServerApi(ctx)` → `api|null`.
- `ACTIVE_STATUSES` = reexport de `ACTIVE_JOB_STATUSES` (F0 `state.mjs`); ninguém redefine a lista.
- `newJobId(kind)`: `KIND_PREFIX` cobre `task`, `review`/`adversarial-review` → `review`, `ask`, `plan`, `subagent`/`sub` → `sub`, `cmd`, `orchestrate`/`orch` → `orch`, `conclave`/`conclave-member`/`conclave-judge` → `conc`, `stop-gate` → `gate`; ids casam `/^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/` (mesma regex em `commands/task.mjs` `JOB_ID_RE`/`RESUME_REF_RE`). O id é gerado por `createJob` a partir do `kind` (nenhuma fase passa `id`).
- `assertNotInsideServer(env)` → lança `PolicyError('INSIDE_SERVER')` (exit 4) se `env.OPC_INSIDE_SERVER === '1'`; todo comando que cria job o chama antes de conectar.
- `serverContext(ctx)` é o único construtor do contexto do servidor (com `hasActiveJobs`); `connectApi(ctx)` (F1 `context.mjs`, `{ api, server, client }`) passa a usá-lo (Tarefa 7 Step 5). Comandos de primeiro plano conectam por `connectApi`; workers usam `ensureServer(serverContext(ctx))` + cliente sem `onServerDown`.
- Registro do job: campo novo `cancelRequestedAt`; `pendingRequest` é `Array<{ type: 'permission'|'question', id, sessionID, permission?, patterns?, metadata?, always?, questions?, requiresUser?, askedAt }> | null`; `errorCode` inclui `worker_lost`, `server_unavailable`, `session_busy`.

### `lib/render.mjs`

- `formatDuration(startIso, endIso, now)`, `renderQueuedJob(job)`, `renderCancel(job, report)`, `renderPermissionList(requests, jobs)`.
- Opções: `renderJobStatus(job, { progress, now })`, `renderStatusList(jobs, { maxJobs, progressById, now })`, `renderPermissionRequest(job, { timeoutSec })`.

### Subcomandos e CLI

- `scripts/commands/task.mjs`: `runKindCommand(ctx, argv, kind)`, `followJob(ctx, id, opts)`, `exitCodeForJob(job)`, `TURN_FLAGS`, `normalizeResumeFlag(argv)`, `loadPrompt(name)`, `projectContextBlock(project)`, `buildPromptText({ userPrompt, template, project })`, `summarize(text, max)`, `sessionTitle(kind, summary)`, `resolveProfile(flags, { readOnly })`, `JOB_ID_RE`, `SESSION_REF_RE`, `DEFAULT_TIMEOUT_SEC`, `DEFAULT_WAIT_TIMEOUT_SEC`. `exitCodeForJob(job)` é o dono único do mapa status → exit code (as fases seguintes importam daqui). A F2b move `loadPrompt`, `projectContextBlock`, `summarize` e `sessionTitle` para `lib/prompts.mjs` e `task.mjs` passa a reexportá-los.
- `scripts/commands/task-worker.mjs`: `createRequestBridge({ update, api, profileKind, policy, timeoutMs, log })` → `{ onPermission, onQuestion, onResolved, dispose }` e `createSerialUpdater(stateDir, jobId)` → `{ update(patch|fn), flush() }` — **a ponte canônica de pedidos**, importada pelos coordenadores/workers das fases seguintes (F3 `subagent`/`command`, F4b `orchestrate`), que embrulham o `update` para refletir no grupo. A liberação chega por `runTurn({ onRequestResolved: (event) => bridge.onResolved(event) })`: quem chama `runTurn` com a ponte sempre passa `onRequestResolved`. No worker, os nomes são `stored` (job lido), `jobUpdates` (updater serial) e `bridge`.
- `scripts/commands/permissions.mjs`: `parseAnswers(questions, values)`.
- `scripts/commands/gc.mjs`: `findStaleStates(dataDir, { olderThanMs, exclude, now })`.
- `scripts/commands/task-resume-candidate.mjs`: flag `--kind task|ask|plan`.
- Flag `--raw-args-stdin` em `task`/`ask`/`plan` (os slash commands desses três a usam no lugar de `--args-stdin`), lida por `readRawArgs(argv, RAW_TURN_FLAGS, { stdin: ctx.stdin })`. Convenção D4: texto livre → `--raw-args-stdin`; só flags/ids (`status`, `result`, `cancel`, `permissions`) → `--args-stdin`.
- Variável `OPC_STATUS_POLL_MS` (teste/diagnóstico): intervalo de polling do runner.
- Arquivo de estado novo: `jobs/<id>.worker.log`.

### Testes (infraestrutura)

- `tests/fixtures/fake-session-api.mjs`: `installSessionApi(fake)`, `SESSION_API_ROUTES` e os métodos do `fake` listados na Tarefa 9; registrada no fake da F0 por `registerFakeExtension` (bloco F2a no fim de `fake-opencode.mjs`), usando `fake.scenario`, `fake.emit(event)`, `fake.persist()` da F0.
- `tests/fixtures/expected-rules-f2a.mjs`: `READ_ONLY_RULES`, `WRITE_RULES`, `NPM_TEST_ONLY_RULES`.
- `tests/helpers.mjs`: `F2A_PROVIDER`, `F2A_MODEL_ID`, `F2A_MODEL`, `F2A_POLICY`, `stateDirFor`, `jobsIn`, `jobIn`, `requestsTo`, `jobIdFrom`, `setupF2a`, `opc`.
- `tests/live/_f2a-helpers.mjs`: `LIVE`, `LIVE_MODEL`, `LIVE_TIMEOUT_MS`, `liveSetup`, `opcLive`, `sha256`, `jobIdIn`, `liveJob`, `liveApi`, `atLeast`, `report`.
