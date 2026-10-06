# opc F6 — Migração para o OpenCode V2 · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o opc falar só com o OpenCode V2 (mínimo 2.0.22), preservando o comportamento dos comandos, da política, dos jobs, do MCP e do transfer.

**Architecture:** A camada de integração muda; as regras de produto ficam. `lib/http.mjs` + `lib/api.mjs` passam a falar `/api/*` com `x-opencode-directory` e devolvem formas internas normalizadas (pedido de permissão, pergunta, status, filhas), de modo que `policy`, `jobs`, `task-worker`, `conclave`, `orchestrate` e o MCP mudem pouco. `lib/sse.mjs` lê o envelope V2 (`{id,type,location,data}`, heartbeat em comentário). `lib/runner.mjs` reescreve a detecção de turno (fim por `session.execution.*` e mensagem `idle`), mantendo a forma do `TurnResult`. O servidor falso dos testes passa a emitir o formato V2 por baixo dos mesmos helpers de cenário.

**Tech Stack:** Node.js ≥ 20 (ESM, `node:test`), zero dependências, OpenCode 2.0.22 (API HTTP `/api/*`, SSE `/api/event`).

**Spec:** `docs/superpowers/specs/2026-10-06-opc-opencode-v2-assessment.md` (matriz V1 → V2, riscos, decisões) e, para as regras de produto que não mudam, `docs/superpowers/specs/2026-09-25-opc-plugin-design.md`.
**Plano mestre:** `docs/superpowers/plans/2026-09-26-opc-00-master.md` (convenções de teste, git e portão).

## Decisões do operador (06/10/2026)

1. **V2 apenas.** Sem suporte a V1. Versão mínima `2.0.22`; V1 detectado vira `UNSUPPORTED_VERSION` com orientação de atualização.
2. **`session todo` removido** (subcomando, ferramenta MCP `opc_session_todo`, docs), porque o V2 não tem todo.
3. **`/opc:attach`** imprime e abre `opencode --server <url> -s <sessionID>` (senha por `OPENCODE_SERVER_PASSWORD`), no lugar de `opencode attach`.

## Fatos do V2 confirmados ao vivo (06/10/2026, servidor próprio, modelos do operador)

Capturados com `opencode serve` 2.0.22 isolado e com dois modelos reais (`deepseek-v4-flash`, `Qwen3.7-Flash` do gateway pessoal). Valem como contrato; a Task 1 os grava em fixture.

1. `opencode serve --hostname 127.0.0.1 --port P` sobe e loga `server listening on http://127.0.0.1:P`. Sem `OPENCODE_SERVER_PASSWORD`, gera senha e a imprime no log: o opc **sempre** passa a senha.
2. Auth Basic com usuário fixo `opencode`; `OPENCODE_SERVER_USERNAME` é ignorado. 401 vem como `{"_tag":"UnauthorizedError","message":"Authentication required"}`.
3. Rotas sem `/api` devolvem a SPA (HTML 200, inclusive sem auth). Toda resposta JSON útil vem em `{ data, location? }` (listas paginadas: `{ data, cursor }`).
4. `GET /api/info` → `{version, pid, urls, paths}`. Não há `/global/health`.
5. Workspace por header `x-opencode-directory: <abs>` (ou query `location[directory]`).
6. `POST /api/session {title, agent, model:{id,providerID,variant?}, permissions[], parentID?}` → `{data:{id:'ses_…', projectID, agent, model, permissions, outcome?, time, title, location, cost, tokens}}`. Modelo inexistente **não** falha na criação.
7. `PATCH /api/session/{id} {permissions}` → 204 e **substitui** a lista inteira (confirmado relendo a sessão).
8. `POST /api/session/{id}/model {model:{id,providerID,variant?}}` → 204 (gera mensagem `model-switched`); `POST …/agent {agent}` análogo.
9. `POST /api/session/{id}/prompt {id?, text, files?, agents?, skills?, delivery?, resume?}` é assíncrono e devolve a mensagem do usuário. Aceita `id` gerado pelo cliente no formato `msg_` + 12 hex + 14 base62 (o mesmo do `newMessageId` atual). **Repetir o mesmo `id` é idempotente** (devolve o original, não reenfileira). Não há `model`, `agent`, `variant`, `parts` nem `format` no prompt.
10. Não existe saída estruturada (`json_schema`) no V2.
11. `GET /api/session/active` → `{data:{"ses_…":{type:"running"}}}`; sessão ociosa fica ausente (`{}`).
12. `GET /api/session/{id}/message?order=asc&limit=N` → lista plana por `type`: `user {id,time,text}`, `assistant {id,time{created,completed},agent,model,content[],finish,cost,tokens,error?}`, `model-switched`, `idle {outcome: succeeded|failed|interrupted}`, `shell`, `synthetic`… Mensagens não têm `parentID`: o turno são as mensagens depois da mensagem do usuário até o `idle` seguinte.
13. `assistant.content[]`: `{type:'text', text}`, `{type:'reasoning', text}`, `{type:'tool', id, name, state:{status: streaming|running|completed|error, input, content[], metadata, error?}}`. Nomes de tool vistos: `read`, `glob`, `shell`, `subagent`, `question`.
14. Eventos SSE em `GET /api/event` (todas as locations; filtrar por `sessionID`): linhas `data: {json}` sem `event:`; heartbeat é a linha de comentário `: heartbeat` a cada 15 s. Envelope `{id, created, type, location:{directory}, data, durable?}`. Primeiro evento `server.connected`.
15. Eventos do turno: `session.created {sessionID, parentID?}`, `session.execution.started|succeeded|failed {sessionID, error?}`, `session.execution.interrupted`, `session.step.started {assistantMessageID, agent, model}`, `session.step.ended {finish, cost, tokens}`, `session.text.delta|ended {assistantMessageID, text}`, `session.reasoning.*`, `session.tool.called {id, input}`, `session.tool.success {id, content}`, `session.tool.failed {id, error:{type,message}}`, `session.tool.input.started {id, name}`, `session.usage.updated {cost, tokens}`, `permission.asked|replied`, `form.created|replied|cancelled`.
16. Falha de execução: `session.execution.failed {sessionID, error:{type:'provider.no-route', message}}` + mensagem `idle {outcome:'failed'}`, sem assistant.
17. Permissão: `permission.asked {id:'per_…', sessionID, action, resources[], save[], source:{type:'tool', messageID, id}}`. Lista por sessão `GET /api/session/{id}/permission`; resposta `POST /api/session/{id}/permission/{requestID}/reply {decision:'once'|'always'|'reject', message?}` → 204. Recusa vira `session.tool.failed` com `error.type:'permission.rejected'`.
18. Pergunta = form: `form.created` / `GET /api/session/{id}/form` → `{id:'frm_…', sessionID, title, metadata:{kind:'question'}, fields:[{key, title, description, type, options:[{value,label,description}], custom}]}`; resposta `POST …/form/{formID}/reply {answer:{<key>: valor}}` → 204; cancelar `DELETE …/form/{formID}`.
19. Subagente: tool `subagent` (`input:{agent, description, prompt}`); cria sessão filha com `parentID`, que **herda as `permissions` da pai** e o modelo da pai.
20. Filhas: `GET /api/session?parentID=<id>`. Interrupção: `POST /api/session/{id}/interrupt` → `{interrupted: bool}`.
21. Catálogos: `/api/provider` (`{id,name,activation}`), `/api/model` (`{id, modelID, providerID, name, capabilities, variants:[{id}]}`), `/api/agent` (`{id,name,mode,hidden,description,permissions[]}`), `/api/command`, `/api/skill`. `GET /api/config` devolve uma **lista de fontes** (`{type:'document', path?, info}` / `{type:'directory', path}`), não a config mesclada.
22. Export/import: `opencode session export <id>` → `{info, messages}` (mensagens planas); `opencode session import [--directory D] <file>` imprime `Imported session: ses_…` e preserva o id; formato V1 é recusado.
23. Ações de permissão nos agentes nativos: `*`, `read`, `edit`, `grep`, `glob`, `webfetch`, `websearch`, `question`, `subagent`, `external_directory`, `browser`, `shell`.

## Global Constraints

- Node ≥ 20; zero dependências (runtime e dev).
- Código, identificadores e commits em inglês; docs e textos ao usuário em PT-BR.
- **OpenCode mínimo `2.0.22`; só a API `/api/*`.** Nenhum caminho V1 (`/session`, `/event`, `/global/health`, `prompt_async`, `/question`, `/permission/{id}/reply`) permanece no código de produção.
- Toda resposta HTTP de sucesso precisa ser JSON; HTML ou corpo não-JSON em rota de API é `RequestError('NOT_JSON')` (evita o falso positivo da SPA).
- Toda sessão criada pelo opc leva `permissions` explícitas e `model` explícito (nunca o default do servidor).
- A senha do servidor e chaves de provider nunca aparecem em stdout, stderr, logs, docs ou fixtures.
- O plugin nunca escreve em `~/.config/opencode/` nem em dados do OpenCode.
- `always` nunca é enviado em resposta de permissão.
- Exit codes da spec §4.1 inalterados: `0, 2, 3, 4, 5, 6, 7, 130`.
- Títulos de sessão com prefixo `OPC: `; namespace `/opc:`.
- Testes ao vivo só com `OPC_LIVE=1`, diretório descartável, modelos por ambiente (`OPC_LIVE_MODEL`, `OPC_LIVE_MODEL_2`).
- Fixtures commitadas sanitizadas: provider `omniroute-personal`, caminhos `<workspace>`/`<tmp>`, nenhum id de sessão real do operador.
- Testes com socket e subprocesso rodam fora do sandbox, pelo controlador.

## Review Focus

1. **Sessão sem regras.** Qualquer caminho que crie sessão (task, ask, plan, review, subagent, orchestrate, conclave, command, session new, transfer) sem `permissions` e `model` explícitos executaria com o agente `build` (`*: allow`) e o modelo default gratuito. Esperado: impossível por construção; `api.createSession` recusa corpo sem `permissions` não-vazio e sem `model`. Teste na Task 3.
2. **SPA no lugar da API.** Um servidor V1, um proxy ou uma rota errada devolvendo HTML 200 deve falhar como versão/forma inválida, nunca como sucesso. Teste na Task 3 (cliente) e Task 4 (health).
3. **Heartbeat só em comentário.** Um stream que só envia `: heartbeat` não pode ser dado como morto pelo liveness de 30 s. Teste na Task 5.
4. **Turno sem assistant.** Execução que falha antes de qualquer assistant (`execution.failed` + `idle failed`, modelo sem rota) deve virar falha classificada com a mensagem do provider, não `NO_ASSISTANT_MESSAGE` nem timeout. Teste na Task 6.
5. **Binário V1 primeiro no PATH.** Na máquina do operador o primeiro `opencode` do PATH é 1.18.34. Esperado: erro claro de versão citando `server.opencodeBin`/`OPC_OPENCODE_BIN`, e o opc usa o binário configurado. Teste na Task 4.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `tests/fixtures/contract/opencode-2.0.22/*.json` | Amostras reais sanitizadas (info, session, messages, eventos, permission, form, model, agent, config, export) | 1 |
| `tests/fixtures/contract-shapes.mjs` | Formas V2 esperadas, usadas pelo fake e pelo contrato ao vivo | 1 |
| `tests/live/contract.mjs` | Contrato ao vivo V2 (servidor próprio, sem inferência) | 1 |
| `tests/fixtures/fake-opencode.mjs` | Servidor falso V2: `/api/*`, auth, `x-opencode-directory`, SSE V2 | 2 |
| `tests/fixtures/fake-session-api.mjs`, `f3-fake.mjs`, `scenarios/*.mjs` | Helpers de cenário emitindo V2 | 2 |
| `tests/fixtures/bin/opencode` | Binário falso: `--version` → `opencode v2.0.22`, `serve`, `session import` | 2 |
| `plugins/opc/scripts/lib/http.mjs` | Cliente: prefixo, header de diretório, desembrulho `{data}`, JSON obrigatório | 3 |
| `plugins/opc/scripts/lib/api.mjs` | Operações de domínio V2 + normalizadores | 3 |
| `plugins/opc/scripts/lib/opencode-v2.mjs` (novo) | Normalizadores puros V2 → formas internas | 3 |
| `plugins/opc/scripts/lib/server.mjs` | Ciclo de vida V2, versão mínima, binário configurável, world check | 4 |
| `plugins/opc/scripts/lib/sse.mjs` | Hub SSE V2 | 5 |
| `plugins/opc/scripts/lib/runner.mjs`, `session-messages.mjs` | Motor de turno V2 | 6 |
| `plugins/opc/scripts/lib/structured-text.mjs` (novo) | Instrução de JSON + validador por schema | 7 |
| `plugins/opc/scripts/lib/policy.mjs` | Regras `{action,resource,effect}`, nomes V2, troca de perfil por substituição | 8 |
| `plugins/opc/scripts/commands/task-worker.mjs`, `permissions.mjs`, `conclave.mjs`, `command.mjs` | Pontes de permissão e form | 8 |
| `plugins/opc/scripts/lib/runner.mjs#dispatchSubagent` | Subagente V2 | 9 |
| `plugins/opc/scripts/commands/session.mjs`, `sessions.mjs`, `providers`/`models`/`agents`/`catalog`, `lib/models.mjs` | Sessões e catálogos V2; `todo` removido | 10 |
| `plugins/opc/scripts/lib/transfer.mjs`, `commands/transfer.mjs`, `commands/attach.mjs` | Transfer V2 e attach | 11 |
| `README.md`, `CHANGELOG.md`, `docs/*.md`, `docs/phases/F6-report.md` | Docs e portão | 12 |

---

### Task 1: Contrato V2 (fixtures reais + contrato ao vivo)

**Responsável:** controlador (exige servidor real fora do sandbox). Os fatos acima já foram capturados; esta task os grava sanitizados.

**Files:**
- Create: `tests/fixtures/contract/opencode-2.0.22/info.json`, `session.json`, `messages-turn.json`, `messages-failed.json`, `events-turn.jsonl`, `events-permission.jsonl`, `events-form.jsonl`, `permission-request.json`, `form.json`, `model.json`, `agent.json`, `provider.json`, `config.json`, `export.json`
- Modify: `tests/fixtures/contract-shapes.mjs` (acrescentar `V2_SHAPES`, `assertShape`, `loadContractSample`; manter `shapeOf`/`diffShapes`/`lookup`; trocar `EVENT_TYPES` por `['server.connected']` e `PROBES` pelas rotas `/api/*`)
- Delete: `tests/fixtures/contract/opencode-1.18.32.shapes.json` (substituído pelas amostras 2.0.22)
- Modify: `tests/live/contract.mjs` (contrato V2)
- Test: `tests/unit/contract-v2-fixtures.test.mjs`

**Interfaces:**
- Produces: `V2_SHAPES` (objeto `{ info, session, message: {user, assistant, idle}, event, permissionRequest, form, model, agent }`, cada um com a lista de chaves obrigatórias) e `assertShape(name, value)` em `tests/fixtures/contract-shapes.mjs`; `loadContractSample(name)` que lê `tests/fixtures/contract/opencode-2.0.22/<name>`.

- [ ] **Step 1: Teste que falha**

```js
// tests/unit/contract-v2-fixtures.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertShape, loadContractSample, V2_SHAPES } from '../fixtures/contract-shapes.mjs';

test('V2 contract samples match the recorded shapes', () => {
  assertShape('info', loadContractSample('info.json'));
  assertShape('session', loadContractSample('session.json').data);
  const turn = loadContractSample('messages-turn.json').data;
  assert.deepEqual(turn.map((m) => m.type), ['user', 'assistant', 'assistant', 'idle']);
  for (const m of turn) assertShape(`message.${m.type}`, m);
  assert.equal(turn.at(-1).outcome, 'succeeded');
  const failed = loadContractSample('messages-failed.json').data;
  assert.deepEqual(failed.map((m) => [m.type, m.outcome ?? null]), [['user', null], ['idle', 'failed']]);
  assertShape('permissionRequest', loadContractSample('permission-request.json'));
  assertShape('form', loadContractSample('form.json'));
});

test('V2 contract samples carry no operator data', () => {
  for (const name of Object.keys(V2_SHAPES.files)) {
    const text = JSON.stringify(loadContractSample(name));
    assert.doesNotMatch(text, /omniroute-(?!personal)|\/home\/|\/storage\/|\/tmp\//i, name);
  }
});
```

- [ ] **Step 2:** `node --test tests/unit/contract-v2-fixtures.test.mjs` → FAIL (`assertShape` não exportado).
- [ ] **Step 3: Gravar as amostras.** A partir das capturas do controlador (servidor próprio, 06/10/2026), copie as respostas reais para os arquivos listados, aplicando a sanitização: id do provider real do operador → `omniroute-personal`; ids reais dos dois modelos → `opencode-go/deepseek-v4.1-flash` e `opencode-go/qwen3.8-max` (os mesmos de `tests/fixtures/f3-fake.mjs`); diretórios → `<workspace>`; `pid` → `12345`; `urls` → `["http://127.0.0.1:4096"]`; textos de reasoning reduzidos a uma frase neutra. Ordem das mensagens sempre `asc`.
- [ ] **Step 4: Formas.** Em `contract-shapes.mjs`, defina `V2_SHAPES` com as chaves obrigatórias de cada forma conforme os "Fatos do V2" (itens 4, 6, 12, 13, 17, 18, 21) e `V2_SHAPES.files` (mapa nome do arquivo → forma). `assertShape(name, value)` lança `AssertionError` citando a chave ausente.
- [ ] **Step 5: Contrato ao vivo.** Reescreva `tests/live/contract.mjs` para: subir `opencode serve` (binário de `OPC_OPENCODE_BIN` ou `opencode`) em HOME/XDG temporários com senha própria; checar `GET /api/info` contra `V2_SHAPES.info` e versão ≥ 2.0.22; checar 401 sem senha; checar HTML em `/global/health`; criar sessão com `permissions` e `model` fixos; `PATCH` de permissões e releitura (substituição); `prompt` com `resume:false` e `id` cliente, repetido (idempotência); `GET /api/session/active`; `interrupt`; encerrar com SIGTERM e provar que o processo saiu. Sem inferência.
- [ ] **Step 6:** `node --test tests/unit/contract-v2-fixtures.test.mjs` → PASS. Controlador: `OPC_LIVE=1 OPC_OPENCODE_BIN=~/.opencode/bin/opencode node tests/live/contract.mjs` → PASS.
- [ ] **Step 7: Commit** `test(contract): record OpenCode 2.0.22 shapes and live contract`.

---

### Task 2: Servidor falso V2

**Files:**
- Modify: `tests/fixtures/fake-opencode.mjs`, `tests/fixtures/fake-session-api.mjs`, `tests/fixtures/f3-fake.mjs`, `tests/fixtures/bin/opencode`, `tests/fixtures/scenarios/*.mjs`, `tests/fixtures/data/*.json`
- Test: `tests/unit/fake-opencode-v2.test.mjs`; a suíte inteira continua sendo a prova de compatibilidade dos helpers.

**Interfaces:**
- Consumes: `V2_SHAPES`, `loadContractSample` (Task 1).
- Produces (mesmos nomes de hoje, saída V2): `startFake(opts)` (instala a API de sessão por `registerFakeExtension`, como hoje); `fake.emit({ type, data })` monta o envelope `{id, created, type, location:{directory}, data}`; `fake.emitTurn(sessionID, { text, tools, delayMs, error, tokens, cost })` (a opção `structured` sai — Task 7); `fake.createSession(body, directory)`; `fake.createChildSession(parentID, { title, agent })` (copia `permissions` e `model` da pai — Fato 19); `fake.setStatus(sessionID, { type: 'busy'|'idle' })` (alimenta `/api/session/active`); `fake.abortSession(sessionID)` (emite `session.execution.interrupted` + `idle interrupted`); `fake.waitFor`, `fake.isAborted`, `fake.state`; `installSessionApi(fake)`; `withF3(scenario)`; `DEFAULT_VERSION = '2.0.22'`.
- Assinaturas que mudam: `fake.askPermission(sessionID, { action, resources, save = [] })` → `Promise<decision>` (registra `per_…`, emite `permission.asked`); `fake.askQuestion(sessionID, fields)` → `Promise<answer>` (registra `frm_…` com `metadata.kind:'question'`, emite `form.created`). Novo: `fake.failExecution(sessionID, { type, message })` (emite `session.execution.failed` e grava `idle failed`, sem assistant).

Regras do fake (todas conforme "Fatos do V2"):
- Rotas sob `/api`; qualquer rota sem `/api` devolve `200 text/html` com `<!doctype html>`. Auth Basic `opencode:<senha>`; 401 com `{"_tag":"UnauthorizedError","message":"Authentication required"}`.
- `x-opencode-directory` registrado em cada request (`state.requests[].directory`).
- `/api/event`: `data: <json>\n\n` sem `event:`; primeiro `server.connected`; heartbeat como `: heartbeat\n\n` a cada `FAKE_HEARTBEAT_MS` (padrão 15000; testes de liveness usam 200).
- `emitTurn` grava mensagens planas (`user`, `assistant` com `content[]`, `idle {outcome}`) e emite `session.execution.started`, `session.step.started`, `session.tool.called/success|failed`, `session.text.delta/ended`, `session.step.ended`, `session.usage.updated`, `session.execution.succeeded|failed`.
- `prompt` com `id` repetido devolve a mensagem original sem novo turno.
- `PATCH /api/session/:id` substitui `permissions`.
- `bin/opencode`: `--version` imprime `opencode v2.0.22`; `serve --hostname H --port P` imprime `server listening on http://H:P`; `session import [--directory D] <file>` valida a forma V2 (`info.cost`, `info.tokens`, `info.time`, `info.location`, `messages[]` planas) e imprime `Imported session: <info.id>`.

- [ ] **Step 1: Teste que falha**

```js
// tests/unit/fake-opencode-v2.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';

const RULES = [{ action: '*', resource: '*', effect: 'deny' }];
const MODEL = { providerID: 'p', id: 'm' };

test('fake V2 serves /api with auth, JSON envelopes and the SPA fallback', async (t) => {
  const fake = await startFake({ password: 'pw' });
  t.after(() => fake.close());
  const auth = { authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}` };
  assert.equal((await fetch(`${fake.url}/api/info`)).status, 401);
  const info = await (await fetch(`${fake.url}/api/info`, { headers: auth })).json();
  assert.equal(info.version, '2.0.22');
  const spa = await fetch(`${fake.url}/global/health`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-type'), /text\/html/);
  const created = await (await fetch(`${fake.url}/api/session`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-opencode-directory': '/w' }, body: JSON.stringify({ title: 'OPC: t', model: MODEL, permissions: RULES }) })).json();
  assert.match(created.data.id, /^ses_/);
  assert.equal(fake.state.requests.at(-1).directory, '/w');
});

function memoryFake() {
  const fake = { state: {}, scenario: {}, events: [], persist() {}, emit(event) { this.events.push(event); } };
  installSessionApi(fake);
  return fake;
}

test('fake V2 turn ends with execution.succeeded and an idle message', async () => {
  const fake = memoryFake();
  const session = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: RULES }, '/w');
  await fake.emitTurn(session.id, { text: 'ok', tools: [{ tool: 'read', input: { path: 'a' } }], delayMs: 1 });
  const types = fake.events.map((e) => e.type);
  assert.ok(types.includes('session.tool.success'));
  assert.equal(types.at(-1), 'session.execution.succeeded');
  assert.ok(fake.events.every((e) => e.data && !('properties' in e)));
  assert.deepEqual(fake.state.messages[session.id].map((m) => m.type).slice(-2), ['assistant', 'idle']);
});

test('fake V2 child sessions inherit the parent permissions and model', () => {
  const fake = memoryFake();
  const parent = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: RULES }, '/w');
  const child = fake.createChildSession(parent.id, { agent: 'explore' });
  assert.deepEqual(child.permissions, RULES);
  assert.deepEqual(child.model, MODEL);
  assert.equal(child.parentID, parent.id);
});

test('fake V2 failExecution leaves no assistant and an idle failed', () => {
  const fake = memoryFake();
  const session = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: RULES }, '/w');
  fake.failExecution(session.id, { type: 'provider.no-route', message: 'Model unavailable: p/m' });
  assert.deepEqual(fake.state.messages[session.id].map((m) => [m.type, m.outcome ?? null]), [['idle', 'failed']]);
  assert.equal(fake.events.at(-1).type, 'session.execution.failed');
});
```

- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** reescrever o núcleo do fake e `fake-session-api.mjs` em V2 (rotas da tabela "Fatos do V2", itens 3–22). Leia os módulos atuais antes: preserve `freshState`, `readStateFile`/`writeStateFile`, `loadScenario`, `matchRoute`, `routeSpecificity`, `registerFakeExtension`, `loadFixtureData`.
- [ ] **Step 4:** migrar cada cenário em `tests/fixtures/scenarios/` para os helpers V2. Cenários que testavam comportamento V1 sem equivalente (`instance-disposed`, `structured`, `structured-error`, `subagent-mode-refused`, `review-dropped-events` se dependente de `message.part.updated`) são removidos ou reescritos para a regra V2 equivalente; registre cada remoção no relatório da task.
- [ ] **Step 5:** `node --test tests/unit/fake-opencode-v2.test.mjs` → PASS.
- [ ] **Step 6: Commit** `test(fixtures): fake OpenCode speaks the 2.0.22 API`.

> A suíte de integração fica vermelha entre a Task 2 e a Task 10 (o produto ainda fala V1). Cada task de produto lista os arquivos de teste que precisa deixar verdes; a suíte inteira volta a ser obrigatória a partir da Task 10.

---

### Task 3: Cliente HTTP e API V2

**Files:**
- Modify: `plugins/opc/scripts/lib/http.mjs`, `plugins/opc/scripts/lib/api.mjs`
- Create: `plugins/opc/scripts/lib/opencode-v2.mjs`
- Test: `tests/unit/http.test.mjs`, `tests/unit/api-v2.test.mjs` (novo), `tests/unit/opencode-v2.test.mjs` (novo)

**Interfaces:**
- `createClient({ baseUrl, password, directory, requestTimeoutMs, fetchImpl, onServerDown })` — sem `username` (fixo `opencode`); envia `x-opencode-directory` quando há `directory`; prefixa nada (os caminhos já começam com `/api`); devolve `body.data` quando o corpo é objeto com `data`, senão o corpo; corpo não-JSON em 2xx → `RequestError('NOT_JSON', '<MÉTODO> <caminho>: resposta não é JSON (servidor não é OpenCode V2?)')`; 204 → `null`. Mantém os mapeamentos 401/404/5xx/4xx, timeout, retry de GET.
- `lib/opencode-v2.mjs` (puro, sem I/O):
  - `toPermissionRequest(v2) → { id, sessionID, permission: v2.action, patterns: v2.resources ?? [], metadata: { command: v2.action === 'shell' ? v2.resources?.[0] : undefined, save: v2.save ?? [] }, source: v2.source ?? null }`
  - `toQuestion(form) → { id, sessionID, questions: form.fields.map((f) => ({ key: f.key, header: f.title ?? '', question: f.description ?? f.title ?? '', options: (f.options ?? []).map((o) => ({ label: o.label ?? String(o.value), value: o.value })), multiple: f.type === 'multiselect', custom: f.custom === true })) }` (só forms com `metadata.kind === 'question'`; outros forms → `null`).
  - `toFormAnswer(question, answers: string[][]) → { answer: { [key]: valor } }` (multiselect → array; demais → primeiro valor; label é mapeado para `value` da opção quando casar).
  - `toSessionStatus(active) → { [sessionID]: { type: 'busy' } }` (ausente = idle).
- `createApi(client)` (nomes antigos mantidos quando o significado é o mesmo):
  - `info()` → `GET /api/info`; `health` removido (chamadores migram para `info`).
  - `getConfigSources()` → `GET /api/config`; `providers()` → `/api/provider`; `models()` → `/api/model`; `defaultModel()` → `/api/model/default`; `agents()` → `/api/agent`; `commands()` → `/api/command`; `skills()` → `/api/skill`.
  - `listSessions({ parentID, limit })` → `GET /api/session`; `children(id)` → `listSessions({ parentID: id })`; `getSession(id)` → `GET /api/session/{id}`; `sessionStatus()` → `toSessionStatus(GET /api/session/active)`.
  - `messages(id, { limit = 200 })` → `GET /api/session/{id}/message?order=asc&limit=`; `message(id, messageID)`.
  - `createSession(body)` → `POST /api/session`; **lança `UsageError('UNSAFE_SESSION', …)` se `body.permissions` não for lista não-vazia ou `body.model` não tiver `providerID` e `id`**.
  - `setPermissions(id, rules)` → `PATCH /api/session/{id} {permissions}`; `setModel(id, model)` → `POST …/model`; `setAgent(id, agent)` → `POST …/agent`.
  - `prompt(id, { id: messageID, text, agents })` → `POST …/prompt`.
  - `interrupt(id)` → `POST …/interrupt` → `true|false` (lê `interrupted`).
  - `listPermissions(sessionID)` → `GET /api/session/{id}/permission` mapeado com `toPermissionRequest`; `replyPermission(sessionID, requestID, { reply, message })` → `POST …/permission/{requestID}/reply {decision}`; `reply` só `once|reject` (mantém `INVALID_REPLY`).
  - `listQuestions(sessionID)` → `GET /api/session/{id}/form` → `toQuestion` (filtra `null`); `replyQuestion(sessionID, question, answers)` → `POST …/form/{id}/reply` com `toFormAnswer`; `rejectQuestion(sessionID, formID)` → `DELETE …/form/{id}`.
  - `diff(id)`, `fork(id, { before })`, `revertStage(id, { messageID })`, `revertCommit(id)`, `revertClear(id)`, `compact(id)`, `runCommand(id, { name, text })` → rotas V2 correspondentes.
  - Removidos: `todo`, `dispose`, `promptAsync`, `abort`, `patchSession`, `unrevert`, `summarize`.
- `client.delete(path, opts)` novo.

- [ ] **Step 1: Testes que falham**

```js
// tests/unit/api-v2.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';

function fakeFetch(routes, seen = []) {
  return async (url, init) => {
    const u = new URL(url);
    seen.push({ method: init.method, path: u.pathname, search: u.search, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const hit = routes[`${init.method} ${u.pathname}`];
    if (!hit) return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(hit.status === 204 ? null : JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
}

test('client sends the directory header, unwraps data and refuses the SPA', async () => {
  const seen = [];
  const client = createClient({ baseUrl: 'http://x', password: 'pw', directory: '/w', fetchImpl: fakeFetch({ 'GET /api/info': { body: { version: '2.0.22' } }, 'GET /api/agent': { body: { data: [{ id: 'build' }] } } }, seen) });
  const api = createApi(client);
  assert.deepEqual(await api.agents(), [{ id: 'build' }]);
  assert.equal(seen[0].headers['x-opencode-directory'], '/w');
  assert.equal((await api.info()).version, '2.0.22');
  await assert.rejects(client.get('/global/health'), { code: 'NOT_JSON' });
});

test('createSession refuses a body without explicit permissions and model', async () => {
  const api = createApi(createClient({ baseUrl: 'http://x', password: 'pw', fetchImpl: fakeFetch({}) }));
  await assert.rejects(api.createSession({ title: 'OPC: t' }), { code: 'UNSAFE_SESSION' });
  await assert.rejects(api.createSession({ title: 'OPC: t', permissions: [], model: { providerID: 'p', id: 'm' } }), { code: 'UNSAFE_SESSION' });
  await assert.rejects(api.createSession({ title: 'OPC: t', permissions: [{ action: '*', resource: '*', effect: 'deny' }] }), { code: 'UNSAFE_SESSION' });
});

test('permission replies go to the session route with a decision', async () => {
  const seen = [];
  const api = createApi(createClient({ baseUrl: 'http://x', password: 'pw', fetchImpl: fakeFetch({ 'POST /api/session/ses_a/permission/per_b/reply': { status: 204 } }, seen) }));
  await api.replyPermission('ses_a', 'per_b', { reply: 'reject', message: 'no' });
  assert.deepEqual(seen[0].body, { decision: 'reject', message: 'no' });
  await assert.rejects(api.replyPermission('ses_a', 'per_b', { reply: 'always' }), { code: 'INVALID_REPLY' });
});
```

```js
// tests/unit/opencode-v2.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { toFormAnswer, toPermissionRequest, toQuestion, toSessionStatus } from '../../plugins/opc/scripts/lib/opencode-v2.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

test('normalizes the recorded permission request and form', () => {
  const req = toPermissionRequest(loadContractSample('permission-request.json'));
  assert.equal(req.permission, 'shell');
  assert.deepEqual(req.patterns, ['echo opc-probe']);
  assert.equal(req.metadata.command, 'echo opc-probe');
  const q = toQuestion(loadContractSample('form.json'));
  assert.equal(q.questions[0].key, 'q0');
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Red', 'Blue']);
  assert.deepEqual(toFormAnswer(q, [['Blue']]), { answer: { q0: 'Blue' } });
  assert.deepEqual(toSessionStatus({ ses_a: { type: 'running' } }), { ses_a: { type: 'busy' } });
  assert.deepEqual(toSessionStatus({}), {});
});
```

- [ ] **Step 2:** rodar os dois arquivos → FAIL.
- [ ] **Step 3:** implementar `opencode-v2.mjs`, depois `http.mjs` (header, desembrulho, `NOT_JSON`, `delete`) e `api.mjs`.
- [ ] **Step 4:** atualizar `tests/unit/http.test.mjs` para a forma V2 (remover asserts de `?directory=` e de `username`).
- [ ] **Step 5:** `node --test tests/unit/http.test.mjs tests/unit/api-v2.test.mjs tests/unit/opencode-v2.test.mjs` → PASS.
- [ ] **Step 6: Commit** `feat(api): speak the OpenCode 2.0.22 HTTP API`.

---

### Task 4: Ciclo de vida do servidor V2

**Files:**
- Modify: `plugins/opc/scripts/lib/server.mjs`, `plugins/opc/scripts/lib/config.mjs` (chave `server.opencodeBin`), `plugins/opc/scripts/commands/setup.mjs`, `plugins/opc/scripts/lib/jobs.mjs` (`serverContext`)
- Test: `tests/unit/server.test.mjs`, `tests/integration/f0-server.test.mjs` (ou o arquivo de integração do servidor existente), `tests/integration/setup.test.mjs`

**Interfaces:**
- `MIN_OPENCODE_VERSION = '2.0.22'`.
- `resolveOpencodeBin({ env, config }) → string`: `env.OPC_OPENCODE_BIN` → `config.server.opencodeBin` → `'opencode'`. Usado por `ensureServer`, `setup`, `transfer`, `attach`.
- `LISTENING_RE = /\bserver listening on (https?:\/\/\S+)/` (V2 não prefixa `opencode`).
- `serverMatcher(port)` aceita o binário `opencode` resolvido (basename `opencode` ou caminho igual a `resolveOpencodeBin`) com `serve` e `--port N`.
- Health: `api.info()` com JSON obrigatório; `version` < mínimo → `UNSUPPORTED_VERSION`, mensagem: `OpenCode <v> é anterior ao mínimo suportado 2.0.22. Instale o OpenCode V2 ou aponte server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário V2.`
- Env do filho: `OPENCODE_SERVER_PASSWORD` sempre; `OPENCODE_SERVER_USERNAME` removido; `OPENCODE_CONFIG_CONTENT` mantido.
- World check: lê `api.getConfigSources()`, junta os `info` dos documentos em ordem (o último vence por chave de topo) e aplica a regra atual de `share` / `model` / `small_model` sobre o resultado.
- Warm-up: `api.agents()`.

- [ ] **Step 1: Testes que falham**

```js
// em tests/unit/server.test.mjs
test('V2 readiness line, matcher and minimum version', () => {
  assert.equal(MIN_OPENCODE_VERSION, '2.0.22');
  assert.equal('server listening on http://127.0.0.1:4096'.match(LISTENING_RE)[1], 'http://127.0.0.1:4096');
  assert.ok(serverMatcher(4096)(['/home/u/.opencode/bin/opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4096']));
  assert.ok(!serverMatcher(4096)(['/usr/bin/node', 'x.mjs', 'serve', '--port', '4096']));
});

test('resolveOpencodeBin prefers the env override, then config, then PATH', () => {
  assert.equal(resolveOpencodeBin({ env: { OPC_OPENCODE_BIN: '/a/opencode' }, config: { server: { opencodeBin: '/b/opencode' } } }), '/a/opencode');
  assert.equal(resolveOpencodeBin({ env: {}, config: { server: { opencodeBin: '/b/opencode' } } }), '/b/opencode');
  assert.equal(resolveOpencodeBin({ env: {}, config: {} }), 'opencode');
});
```

E na integração: cenário `old-version` (fake responde `version: '1.18.34'`) → `opc setup --json` sai com exit 3 e a mensagem cita `server.opencodeBin`; cenário `spa-only` (fake só serve HTML) → `UNSUPPORTED_VERSION` ou `NOT_JSON`, nunca sucesso.

- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar; `export` de `LISTENING_RE` para o teste. `server.opencodeBin` entra no schema de config como string opcional, só global.
- [ ] **Step 4:** `setup` reporta a versão e o caminho do binário usado; com V1, orienta a instalar o V2 ou configurar `server.opencodeBin`.
- [ ] **Step 5:** testes do servidor e do setup → PASS.
- [ ] **Step 6: Commit** `feat(server): boot and verify an OpenCode 2.0.22 server`.

---

### Task 5: Hub SSE V2

**Files:**
- Modify: `plugins/opc/scripts/lib/sse.mjs`
- Test: `tests/unit/sse.test.mjs`, `tests/integration/sse.test.mjs` (o existente)

**Interfaces:**
- `createSSEParser().push(text) → { events: object[], comments: number }` — linhas que começam com `:` contam como comentário (heartbeat) e não geram evento.
- `eventSessionID(event) → event?.data?.sessionID ?? null`.
- `EventHub` conecta em `client.buildUrl('/api/event')` com os headers do cliente (inclui `x-opencode-directory`); considera o stream aberto no primeiro evento **ou** comentário; qualquer evento ou comentário rearma o liveness; `server.connected` não é exigido depois de reconectar. `session.created` com `data.parentID` rastreado passa a rotear a filha (`data.sessionID`). Handlers recebem o envelope V2 inteiro.

- [ ] **Step 1: Testes que falham**

```js
test('parser counts heartbeat comments and parses data frames', () => {
  const parser = createSSEParser();
  const out = parser.push(': heartbeat\n\ndata: {"type":"server.connected","data":{}}\n\n: heartbeat\n\n');
  assert.equal(out.comments, 2);
  assert.deepEqual(out.events.map((e) => e.type), ['server.connected']);
});

test('heartbeat comments keep the stream alive past the liveness window', async (t) => {
  const fake = await startFake({ password: 'pw', heartbeatMs: 50 });
  t.after(() => fake.close());
  const client = createClient({ baseUrl: fake.url, password: 'pw', directory: '/w' });
  const hub = new EventHub({ client, livenessMs: 200 });
  t.after(() => hub.stop());
  hub.track('ses_none', () => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fake.state.sseConnections, 1);
});

test('eventSessionID reads data.sessionID from the V2 envelope', () => {
  assert.equal(eventSessionID({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } }), 'ses_a');
  assert.equal(eventSessionID({ type: 'server.connected', data: {} }), null);
});
```

Imports do arquivo: `startFake` de `../fixtures/fake-opencode.mjs`, `createClient` de `lib/http.mjs`, `EventHub`/`createSSEParser`/`eventSessionID` de `lib/sse.mjs`. O fake só envia `: heartbeat` (sem `server.heartbeat` como evento) depois da Task 2.

- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** `node --test tests/unit/sse.test.mjs` e o teste de integração do hub → PASS.
- [ ] **Step 5: Commit** `feat(sse): consume the OpenCode 2.0.22 event stream`.

---

### Task 6: Motor de turno V2

**Files:**
- Modify: `plugins/opc/scripts/lib/runner.mjs`, `plugins/opc/scripts/lib/session-messages.mjs`, `plugins/opc/scripts/lib/errors.mjs`
- Test: `tests/unit/runner.test.mjs`, `tests/unit/errors.test.mjs`, `tests/integration/f2a-*.test.mjs` (os que exercitam turnos)

**Interfaces (mantidas):** `runTurn({ api, hub, request, onProgress, onSession, onPermission, onQuestion, onRequestResolved, isCancelled, signal }) → TurnResult` com as mesmas chaves (`sessionID, messageID, assistantMessageIDs, childSessionIDs, status, finalText, structured, structuredSource, error, errorClass, errorType, errorCode, errorMessage, touchedFiles, toolsRan, toolNames, usage`). `newMessageId` mantido.

**Mudanças:**
- `request.model` é `{ providerID, modelID }`; `request.variant` opcional. Sessão nova: `api.createSession({ ...request.newSession, model: { providerID, id: modelID, variant }, agent: request.agent ?? request.newSession.agent ?? 'build', permissions })` — `request.newSession.permission` (nome antigo) vira `permissions`. Sessão existente: `setPermissions` se `request.patchPermission`, depois `setModel` e `setAgent` só quando diferem do que `getSession` devolve.
- Prompt: `api.prompt(sessionID, { id: messageID, text })`, onde `text` é a junção dos `parts` de texto. Timeout no prompt → reenviar com o mesmo `id` (idempotente; Fato 9), sem ler mensagens.
- Eventos tratados: `session.created` (filha), `session.execution.started` (busy), `session.execution.succeeded` → `finish('idle')`, `session.execution.failed` → `finish('session-error', { error: data.error })`, `session.execution.interrupted` → `finish('interrupted')`, `session.step.started` (registra `assistantMessageID`), `session.tool.input.started` / `session.tool.called` / `session.tool.success` / `session.tool.failed` (progresso, fase, `toolsRanLive`), `session.text.delta` (fase `running`), `session.retry.scheduled` (se vier: `handleRetryStatus({ attempt, message, next })`), `permission.asked` → `toPermissionRequest`, `form.created` → `toQuestion` (ignora `null`), `permission.replied`, `form.replied` / `form.cancelled` → `onRequestResolved`.
- Fases por nome de tool V2: `read|grep|glob|webfetch|websearch` → `investigating`; `edit|write|apply_patch|patch` → `editing`; `subagent` → `subagent`; `shell` → `verifying` (se `VERIFY_RE` casar com `input.command`) ou `running`; demais → `running`.
- Resync (poll e reconexão): `sessionStatus()`, `children(sessionID)`, `listPermissions(id)` e `listQuestions(id)` para a sessão e cada filha rastreada, e, se a sessão não estiver ativa, ler `messages()` e terminar quando houver `idle` depois da mensagem `messageID` (`outcome` succeeded → idle; failed → session-error com o `error` do último assistant ou `{type:'execution.failed'}`; interrupted → interrupted).
- `turnMessages(messages, messageID)`: mensagens depois da que tem `id === messageID`, até a primeira `idle` (inclusive). `extractTurn(turn, { childMessages, diffs })`: `finalText` = texto do último `assistant` com `content` `text`; ferramentas = `content` `tool` com `state.status === 'completed'` (nome `name`); arquivos tocados por `EDIT_TOOLS` via `state.input.path|filePath`; `usage` somando `tokens`/`cost` dos assistants; `error` = `error` do último assistant (`{type, message}`) mapeado para `{ name: type, data: { message } }`.
- `errors.mjs#classifyError`: aceitar os tipos V2 (`provider.no-route` → fatal "modelo indisponível"; `aborted` → cancelado; `permission.rejected` em tool não falha o turno; `provider.rate-limit`/HTTP 429 → recuperável). Mantém os nomes V1 que ainda chegam dos testes antigos só até a Task 10, depois remova.
- Cancelamento/timeout: `api.interrupt` no lugar de `abort`; `waitIdle` usa `sessionStatus()`.
- `session-messages.mjs`: remover o contorno do bug de listagem do V1 (`usePerMessageReads`, `rememberMessage`, `isPerMessageSession`); `readSessionMessages(api, id, { limit })` passa a ser `api.messages(id, { limit })`.
- `request.childPermission`: não é mais aplicado (a filha herda — Fato 19). O teste prova a herança com o fake.

- [ ] **Step 1: Testes que falham** (em `tests/unit/runner.test.mjs`, com um `api` e `hub` falsos em memória):

```js
test('a V2 turn completes on execution.succeeded and reads the idle-bounded messages', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  api.messagesFor(sessionID, [
    { id: api.lastPromptId(), type: 'user', text: 'hi' },
    { id: 'msg_a', type: 'assistant', content: [{ type: 'tool', name: 'read', state: { status: 'completed', input: { path: 'a.txt' } } }], cost: 0, tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    { id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'done' }], cost: 0.01, tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 1, write: 0 } } },
    { id: 'msg_c', type: 'idle', outcome: 'succeeded' },
  ]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'done');
  assert.deepEqual(result.toolNames, ['read']);
  assert.equal(result.usage.input, 12);
  assert.equal(api.createdBody.permissions.length, 1);
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm' });
});

test('execution.failed before any assistant is a classified provider failure', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'missing' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user', text: 'hi' }, { id: 'msg_i', type: 'idle', outcome: 'failed' }]);
  emit({ type: 'session.execution.failed', data: { sessionID, error: { type: 'provider.no-route', message: 'Model unavailable: p/missing' } } });
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.notEqual(result.errorCode, 'NO_ASSISTANT_MESSAGE');
  assert.match(result.errorMessage, /Model unavailable/);
});

test('a prompt timeout resends with the same id instead of reading messages', async () => {
  const { api, hub, emit } = memoryV2({ promptFailsOnce: 'TIMEOUT' });
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  await api.promptSettled;
  assert.equal(api.promptCalls.length, 2);
  assert.equal(api.promptCalls[0].id, api.promptCalls[1].id);
  assert.equal(api.messageReadsBeforeEnd, 0);
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user', text: 'hi' }, { id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'ok' }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, { id: 'msg_c', type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  assert.equal((await pending).finalText, 'ok');
});
```

`memoryV2({ promptFailsOnce } = {})` mora no próprio arquivo de teste e devolve `{ api, hub, emit }`:
- `api.created`: promise resolvida com o `sessionID` (`ses_mem1`) quando `createSession` é chamado; `api.createdBody` guarda o corpo.
- `api.prompt(id, body)` registra `body` em `api.promptCalls`; com `promptFailsOnce: 'TIMEOUT'` a primeira chamada rejeita `new RequestError('TIMEOUT', 'timeout')` (de `lib/http.mjs`); `api.promptSettled` resolve quando uma chamada sucede; `api.lastPromptId()` devolve `promptCalls.at(-1).id`.
- `api.messagesFor(id, list)` define o que `api.messages(id)` devolve; `api.messageReadsBeforeEnd` conta leituras de `messages` antes do primeiro evento `session.execution.*`.
- `sessionStatus()` → `{ [id]: { type: 'busy' } }` até um `execution.*` ser emitido, depois `{}`; `children()` → `[]`; `listPermissions()`/`listQuestions()` → `[]`; `interrupt()` → `true`; `diff()` → `[]`; `getSession(id)` → `{ id, model: createdBody.model, agent: createdBody.agent, permissions: createdBody.permissions }`; `setPermissions`/`setModel`/`setAgent` registram em `api.calls`.
- `hub.track(id, handler)` guarda o handler por sessão; `hub.onReconnect(fn)` guarda e devolve um unsubscribe; `emit(event)` entrega ao handler da `event.data.sessionID`.

- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** implementar o motor V2 conforme "Mudanças".
- [ ] **Step 4:** unitários do runner e erros → PASS; controlador roda `tests/integration/f2a-*.test.mjs` fora do sandbox e registra os que dependem de Tasks posteriores.
- [ ] **Step 5: Commit** `feat(runner): run turns on the OpenCode 2.0.22 execution model`.

---

### Task 7: Saída estruturada por texto

**Files:**
- Create: `plugins/opc/scripts/lib/structured-text.mjs`
- Modify: `plugins/opc/scripts/lib/runner.mjs` (só a montagem do prompt e do `textJson`), `plugins/opc/scripts/commands/review.mjs`, `plugins/opc/scripts/commands/conclave.mjs`, `plugins/opc/scripts/lib/orchestrator.mjs`, `plugins/opc/scripts/lib/config.mjs`
- Test: `tests/unit/structured-text.test.mjs`, `tests/unit/config.test.mjs`, integrações de review/conclave/orchestrate

**Interfaces:**
- `jsonInstruction(schema) → string` (inglês, como os demais prompts de modelo): `"Reply with only one JSON object, no prose and no code fence, that validates against this JSON Schema:\n<schema JSON>"`.
- `schemaValidator(schema) → (value) => null | string` usando `validateInput(schema, value)` de `lib/mcp-schema.mjs` (`null` aceita; string = primeiro erro).
- No runner: `request.format = { type: 'json_schema', schema }` passa a significar "acrescentar `jsonInstruction(schema)` ao texto do prompt e usar `schemaValidator(schema)` como `textJson`"; a extração continua sendo `extractTextJson(finalText, textJson)` de `lib/text-json.mjs` (já usada no fim do turno); `structuredSource` é sempre `'text'` quando aceito. `body.format`, `usePerMessageReads` e o caminho de tool `StructuredOutput` saem do runner.
- Config: `review.structuredOutput`, `conclave.structuredOutput`, `orchestrate.structuredOutput` aceitam só `'text'`; valor `'tool'` em config existente → aviso `structuredOutput "tool" não existe no OpenCode V2; usando "text".` e segue como `'text'` (sem quebrar config antiga).

- [ ] **Step 1: Testes que falham**

```js
// tests/unit/structured-text.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonInstruction, schemaValidator } from '../../plugins/opc/scripts/lib/structured-text.mjs';

const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false };

test('instruction embeds the schema and the validator enforces it', () => {
  assert.match(jsonInstruction(schema), /only one JSON object/);
  assert.match(jsonInstruction(schema), /"required":\["files"\]/);
  const validate = schemaValidator(schema);
  assert.equal(validate({ files: ['a'] }), null);
  assert.equal(typeof validate({ files: 'a' }), 'string');
  assert.equal(typeof validate({ files: [], extra: 1 }), 'string');
});
```

- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar e ligar. **Step 4:** testes → PASS (integrações pelo controlador). **Step 5: Commit** `feat(structured): request JSON in text since OpenCode 2 has no json_schema output`.

---

### Task 8: Política e pontes de permissão/pergunta

**Files:**
- Modify: `plugins/opc/scripts/lib/policy.mjs`, `plugins/opc/scripts/commands/task-worker.mjs`, `plugins/opc/scripts/commands/permissions.mjs`, `plugins/opc/scripts/commands/conclave.mjs`, `plugins/opc/scripts/commands/command.mjs`, `tests/fixtures/expected-rules-f2a.mjs`
- Test: `tests/unit/policy-profiles.test.mjs`, `tests/unit/policy.test.mjs`, `tests/integration/permissions*.test.mjs`, `tests/integration/f2a-permission*.test.mjs`

**Interfaces:**
- Regra: `{ action, resource, effect }` (`effect: 'allow'|'deny'|'ask'`). Helper `r(action, resource, effect)`.
- Nomes V2: `bash` → `shell`, `task` → `subagent`. Removidos: `list`, `lsp`, `todowrite`, `doom_loop` (sem ação V2). `READ_ONLY_ALLOW = ['read', 'glob', 'skill', 'question']` — `question` só se a política permitir perguntas (hoje: perguntas vão à ponte; manter permitido). `SENSITIVE_PATH_PERMISSIONS = ['read', 'grep', 'glob']`.
- Invariantes V2: `external_directory * deny`; fora de `write`, `grep * deny`; caminhos sensíveis negados em `read|grep|glob`; `subagent <glob> deny` para agentes negados; `<tool> * deny` para `policy.tools.deny`; `shell <padrão destrutivo> ask` (28 padrões); `browser * deny` sempre (não há perfil que o libere).
- `requiresUser(request, policy)` lê `request.permission` (`shell`/`edit`/`external_directory`/caminho sensível) e `request.metadata.command ?? request.patterns[0]` para `shell` — mesma regra de hoje, nomes novos.
- `PATCH_PERMISSION_MODE = 'replace'`; `planPermissionSwitch(current, desired)` devolve `{ kind: 'none' }` quando iguais e `{ kind: 'replace', rules: desired }` caso contrário; o erro `PROFILE_SWITCH_UNSUPPORTED` deixa de existir. `endsWithRules` vira `sameRules(current, desired)` (igualdade de lista).
- Pontes: `task-worker`, `permissions`, `conclave`, `command` passam `sessionID` em `replyPermission(sessionID, requestID, …)` e `replyQuestion(sessionID, question, answers)`; `rejectQuestion(sessionID, formID)`. `permissions list` lista pedidos e perguntas de **todas as sessões ativas do workspace** (`listSessions` filtrado por `OPC: ` + `listPermissions`/`listQuestions` de cada), já que o V2 não tem lista global de perguntas; pedidos de permissão podem usar `GET /api/permission/request`.

- [ ] **Step 1: Testes que falham** (substituem as expectativas V1 em `policy-profiles.test.mjs`):

```js
test('read-only V2: deny-all, allows, invariants — exact order', () => {
  const rules = buildPermissionRules('read-only', { policy: {} });
  assert.deepEqual(rules.slice(0, 5), [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'skill', resource: '*', effect: 'allow' },
    { action: 'question', resource: '*', effect: 'allow' },
  ]);
  assert.ok(rules.some((x) => x.action === 'external_directory' && x.effect === 'deny'));
  assert.ok(rules.some((x) => x.action === 'browser' && x.effect === 'deny'));
  assert.ok(!rules.some((x) => ['bash', 'task', 'list', 'lsp', 'todowrite', 'doom_loop'].includes(x.action)));
});

test('write V2: destructive shell asks; no V1 action names', () => {
  const rules = buildPermissionRules('write', { policy: {} });
  assert.ok(rules.some((x) => x.action === 'shell' && x.resource === 'rm *' && x.effect === 'ask'));
});

test('requiresUser on a recorded V2 shell request', () => {
  const req = toPermissionRequest(loadContractSample('permission-request.json'));
  assert.equal(requiresUser({ ...req, metadata: { command: 'rm -rf /' } }, {}), true);
  assert.equal(requiresUser(req, {}), false);
});

test('profile switch on resume is a replace', () => {
  const a = buildPermissionRules('read-only', { policy: {} });
  const b = buildPermissionRules('write', { policy: {} });
  assert.deepEqual(planPermissionSwitch(a, a), { kind: 'none' });
  assert.deepEqual(planPermissionSwitch(a, b), { kind: 'replace', rules: b });
});
```

Ajuste `tests/fixtures/expected-rules-f2a.mjs` para as listas V2 exatas (é a fonte de verdade do teste "F2a expected read-only fixtures exactly match the profile builder").

- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar política e pontes. **Step 4:** unitários → PASS; integrações de permissão pelo controlador (cenários `permission-ask`, `child-permission-ask`, `question-ask`, `reject-siblings`, `mcp-pending-permission`). **Step 5: Commit** `feat(policy): express permission rules and bridges in OpenCode 2 terms`.

---

### Task 9: Subagente V2

**Files:**
- Modify: `plugins/opc/scripts/lib/runner.mjs` (`dispatchSubagent`, `extractTaskOutput`), `plugins/opc/scripts/commands/subagent.mjs`
- Test: `tests/unit/runner-subagent.test.mjs` (ou o arquivo existente de subagente), `tests/integration/subagent*.test.mjs`

**Interfaces:**
- `SUBAGENT_MECHANISMS = ['child-session', 'subagent-tool']` (`subtask` → `subagent-tool`; o valor antigo `subtask` em config/flag vira `subagent-tool` com aviso).
- `child-session`: `api.createSession({ parentID, title, agent: member.agent, model: { providerID, id: modelID, variant }, permissions: rules })` e turno com o prompt. Se o servidor recusar o agente (400 citando agent/mode), cai para `subagent-tool` quando `allowFallback`.
- `subagent-tool`: sessão portadora com `permissions: [...rules, { action: 'subagent', resource: member.agent, effect: 'allow' }]` e modelo do membro; prompt em inglês: `Use the subagent tool with agent "<agent>" to do the task below, then reply with the subagent's final answer only.\n\n<prompt>` e `agents: [member.agent]` no corpo do prompt. `extractTaskOutput(messages)` lê o último `content` `tool` com `name === 'subagent'` e `state.status === 'completed'` (texto de `state.content[].text`).
- Herança: a filha herda `permissions` e modelo da portadora (Fato 19); o teste afirma que a filha criada pelo fake tem as regras da portadora.

- [ ] **Step 1: Testes que falham** (em `tests/unit/runner-subagent.test.mjs`; copie `memoryV2` da Task 6 para `tests/unit/_memory-v2.mjs` e importe dos dois arquivos)

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchSubagent, extractTaskOutput } from '../../plugins/opc/scripts/lib/runner.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/http.mjs';
import { memoryV2 } from './_memory-v2.mjs';

const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }];
const member = { agent: 'explore', model: { providerID: 'p', modelID: 'm' } };

test('child-session creates a child with explicit rules and model', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'child-session', allowFallback: false });
  const sessionID = await api.created;
  assert.equal(api.createdBody.parentID, 'ses_parent');
  assert.equal(api.createdBody.agent, 'explore');
  assert.deepEqual(api.createdBody.permissions, RULES);
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm' });
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user', text: 'find x' }, { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: 'found' }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, { id: 'msg_i', type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  const result = await pending;
  assert.equal(result.mechanism, 'child-session');
  assert.equal(result.finalText, 'found');
});

test('subagent-tool allows only the member agent and asks for it by name', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'subagent-tool' });
  const sessionID = await api.created;
  assert.deepEqual(api.createdBody.permissions.at(-1), { action: 'subagent', resource: 'explore', effect: 'allow' });
  await api.promptSettled;
  assert.deepEqual(api.promptCalls[0].agents, ['explore']);
  assert.match(api.promptCalls[0].text, /Use the subagent tool with agent "explore"/);
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user', text: 'x' }, { id: 'msg_a', type: 'assistant', content: [{ type: 'tool', name: 'subagent', state: { status: 'completed', input: { agent: 'explore' }, content: [{ type: 'text', text: 'sub answer' }] } }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, { id: 'msg_i', type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  const result = await pending;
  assert.equal(result.mechanism, 'subagent-tool');
  assert.equal(result.finalText, 'sub answer');
});

test('a refused child agent falls back to the subagent tool', async () => {
  const { api, hub } = memoryV2({ createFailsOnce: new RequestError('BAD_REQUEST', 'agent "explore" is a subagent') });
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'child-session', allowFallback: true });
  await api.created;
  assert.deepEqual(api.createdBody.permissions.at(-1), { action: 'subagent', resource: 'explore', effect: 'allow' });
  api.finishAll('ok');
  const result = await pending;
  assert.equal(result.fellBack, true);
  assert.equal(result.mechanism, 'subagent-tool');
});

test('extractTaskOutput reads the last completed subagent tool', () => {
  assert.equal(extractTaskOutput([{ type: 'assistant', content: [{ type: 'tool', name: 'subagent', state: { status: 'completed', content: [{ type: 'text', text: 'a' }] } }, { type: 'tool', name: 'subagent', state: { status: 'error', error: { message: 'x' } } }] }]), 'a');
});
```

`memoryV2` ganha duas opções para esta task: `createFailsOnce` (a primeira `createSession` rejeita com o erro dado e `api.created` só resolve na segunda) e `api.finishAll(text)` (grava user/assistant `text`/idle succeeded na sessão criada e emite `session.execution.succeeded`). A assinatura de `dispatchSubagent({ api, hub, parentSessionID, member, prompt, rules, mechanism, allowFallback, ... })` não muda (`runner.mjs:639`); o retorno mantém `mechanism`, `fellBack` e `finalText`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS. **Step 5: Commit** `feat(subagent): dispatch members through OpenCode 2 sessions and the subagent tool`.

---

### Task 10: Sessões, catálogos e remoção do todo

**Files:**
- Modify: `plugins/opc/scripts/commands/session.mjs`, `sessions.mjs`, `catalog.mjs`, `agents.mjs`, `providers.mjs`, `models.mjs` (comando), `command.mjs`, `config.mjs` (comando); `plugins/opc/scripts/lib/models.mjs` (`buildCatalog`), `lib/context.mjs`, `lib/routing.mjs`, `lib/config.mjs#validateAgainstServer`; `plugins/opc/scripts/lib/mcp-tools.mjs` (remover `opc_session_todo`; ajustar a contagem de ferramentas e testes que a fixam); `plugins/opc/commands/session.md`
- Test: `tests/unit/models.test.mjs`, `tests/integration/f3-*.test.mjs`, `tests/integration/mcp-*.test.mjs`, `tests/unit/mcp-tools.test.mjs`

**Interfaces:**
- `buildCatalog({ providers, models, defaultModel })` (antes recebia a resposta de `/provider`): `providers` de `/api/provider` (conectado = `activation !== 'disabled'`), `models` de `/api/model` (`variants` vira a lista de `id`), default de `/api/model/default`. A forma de saída do catálogo (`entries`, `byFullId`, `connected`, `defaults`) não muda.
- Agentes: `{ id, name, mode, hidden, description, permissions }` → forma interna `{ name: id, description, mode, native, hidden, model, variant }` (`native` = `id ∈ {build, plan, general, explore}`; `model` do agente quando houver).
- `session show|new|fork|children|diff` sobre as rotas V2; `fork` aceita `--before <messageID>`; `revert <sessionID> <messageID>` = `revertStage` + `revertCommit`; `unrevert` = `revertClear`; `summarize` = `compact`. `todo` removido (o subcomando responde `UNKNOWN_SUBCOMMAND`).
- `sessions --refresh`: sem equivalente a `instance/dispose`; a flag passa a só reler a lista (documentar).
- `command <name> [args]`: `POST …/command {name, text: args}` (204) e o resultado vem pelo turno (usar `runTurn` com o evento `session.execution.*`).
- MCP: 24 ferramentas `opc_*` (sem `opc_session_todo`).

- [ ] **Step 1: Testes que falham**

```js
// tests/unit/models.test.mjs (novo teste)
test('buildCatalog reads the V2 provider, model and default lists', () => {
  const catalog = buildCatalog({
    providers: loadContractSample('provider.json').data,
    models: loadContractSample('model.json').data,
    defaultModel: loadContractSample('model-default.json').data,
  });
  const entry = catalog.byFullId.get('omniroute-personal/opencode-go/deepseek-v4.1-flash');
  assert.ok(entry);
  assert.deepEqual(entry.variants, ['low', 'medium', 'high', 'max']);
  assert.ok(catalog.connected.includes('omniroute-personal'));
});
```

```js
// tests/unit/mcp-tools.test.mjs (substitui a lista fixa)
assert.ok(!TOOL_NAMES.includes('opc_session_todo'));
assert.equal(TOOL_NAMES.length, 24);
```

```js
// tests/integration/session-todo-removed.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeWorkspace, parseJsonOutput, runCli, testEnv } from '../helpers.mjs';

test('session todo is gone in V2', async (t) => {
  const result = await runCli(['session', 'todo', 'ses_x', '--json'], { env: testEnv(t), cwd: makeWorkspace(t) });
  assert.equal(result.code, 2);
  assert.equal(parseJsonOutput(result.stdout).error.code, 'UNKNOWN_SUBCOMMAND');
});
```

A Task 1 grava também `model-default.json` (`GET /api/model/default`) e o modelo da amostra com as variants reais. Confira em `tests/helpers.mjs` o nome do campo de exit code devolvido por `runCli` (`code` ou `status`) e use o existente.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** a **suíte inteira** volta a ser obrigatória: `npm test` → 0 falhas (controlador, fora do sandbox). **Step 5: Commit** `feat(sessions): sessions and catalogs on OpenCode 2; drop session todo`.

---

### Task 11: Transfer V2 e attach

**Files:**
- Modify: `plugins/opc/scripts/lib/transfer.mjs`, `plugins/opc/scripts/commands/transfer.mjs`, `plugins/opc/scripts/commands/attach.mjs`, `plugins/opc/scripts/attach-pane.sh` (se existir), `tests/fixtures/fake-import.mjs`, `tests/fixtures/data/export-sample.json`
- Test: `tests/unit/transfer.test.mjs`, `tests/integration/transfer.test.mjs`, `tests/unit/attach.test.mjs`, `tests/live/f5-transfer.mjs`

**Interfaces:**
- `buildExport(conversion, { model, agent = 'build', directory, nextId })` → `{ info: { id, title, projectID: 'global', agent, model: { id, providerID, variant: 'default' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created, updated }, location: { directory } }, messages: [...] }` com mensagens planas: `{ id, type: 'user', time: { created }, text }` e `{ id, type: 'assistant', time: { created, completed }, agent, model: { id, providerID, variant: 'default' }, content: [{ type: 'text', text }], finish: 'stop', cost: 0, tokens }`. A primeira mensagem é `{ type: 'synthetic', text: transferHeader(...) }` se o V2 aceitar `synthetic` na importação; senão o cabeçalho vai como primeira mensagem `user` (o controlador confirma com o binário real e registra no relatório da task).
- `EXPORT_SHAPE`/`validateExportShape` para a forma V2 (`fake-import.mjs` é o oráculo independente).
- `runImport({ opencodeBin, file, cwd })` → `opencode session import --directory <cwd> <file>`; `IMPORT_SUCCESS_RE` inalterada.
- `resumeCommand(sessionID)` → `opencode -s <sessionID>` (V2 mantém `-s`).
- `buildAttachArgs({ url, sessionID, directory })` → `['--server', url, ...(sessionID ? ['-s', sessionID] : [])]` (o V2 não tem `attach` nem `--dir`; o pane faz `cd <directory>` antes de executar). O `PANE_SCRIPT` segue lendo a senha do arquivo 0600 para `OPENCODE_SERVER_PASSWORD`; o texto impresso nunca contém a senha.

- [ ] **Step 1: Testes que falham**

```js
// tests/unit/transfer.test.mjs (novos testes)
test('buildExport emits the OpenCode 2 export shape', () => {
  const conversion = convertClaudeRecords([
    { type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-10-06T10:00:00Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, timestamp: '2026-10-06T10:00:01Z' },
  ], { now: 1 });
  const out = buildExport(conversion, { model: { providerID: 'omniroute-personal', modelID: 'opencode-go/deepseek-v4.1-flash' }, directory: '/w' });
  assert.equal(validateExportShape(out), null);
  assert.deepEqual(Object.keys(out.info.tokens).sort(), ['cache', 'input', 'output', 'reasoning']);
  assert.deepEqual(out.info.location, { directory: '/w' });
  assert.ok(out.messages.every((m) => typeof m.type === 'string' && !('info' in m) && !('parts' in m)));
  assert.equal(out.messages.at(-1).content[0].text, 'hi');
});

test('the import oracle refuses the V1 shape', () => {
  assert.ok(checkImportShape({ info: { id: 'ses_x', title: 't' }, messages: [] }).some((e) => /info\.cost missing/.test(e)));
});
```

```js
// tests/unit/attach-f3.test.mjs (substitui o teste de argumentos)
test('attach builds the V2 TUI command', () => {
  assert.deepEqual(buildAttachArgs({ url: 'http://127.0.0.1:4096', sessionID: 'ses_a', directory: '/w' }), ['--server', 'http://127.0.0.1:4096', '-s', 'ses_a']);
  assert.deepEqual(buildAttachArgs({ url: 'http://127.0.0.1:4096', directory: '/w' }), ['--server', 'http://127.0.0.1:4096']);
});
```

`convertClaudeRecords` e `checkImportShape` (de `tests/fixtures/fake-import.mjs`, devolve a lista de erros; reescrita nesta task para a forma V2) já existem; ajuste os registros de entrada para o formato aceito hoje por `parseJsonlLines`/`convertClaudeRecords` se o exemplo acima divergir. Na integração existente de attach, afirme que a saída `--json` não contém a senha do servidor.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS; controlador roda `OPC_LIVE=1 OPC_OPENCODE_BIN=… node tests/live/f5-transfer.mjs` (HOME/XDG isolados, sem inferência). **Step 5: Commit** `feat(transfer): import Claude Code transcripts into OpenCode 2`.

---

### Task 12: Docs e portão da F6

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/architecture.md`, `docs/commands.md`, `docs/troubleshooting.md`, `docs/permissions.md`, `plugins/opc/skills/*/SKILL.md`, `plugins/opc/commands/*.md` que citem V1, `docs/superpowers/plans/2026-09-26-opc-00-master.md`, `docs/superpowers/plans/2026-09-26-opc-CHECKLIST.md`
- Create: `docs/phases/F6-report.md`, `docs/phases/F6-live-output.md`
- Modify: `tests/live/*.mjs` (rodar contra V2), `tests/unit/docs-f5.test.mjs` → `docs-f6.test.mjs`

- [ ] **Step 1:** teste de docs que falha: nenhum doc publicado cita `opencode attach`, `/global/health`, `prompt_async`, `OpenCode 1.18`, `session todo`; README declara "OpenCode ≥ 2.0.22" e documenta `server.opencodeBin`/`OPC_OPENCODE_BIN`.
- [ ] **Step 2:** atualizar docs (PT-BR), CHANGELOG `### Alterado — F6 (OpenCode V2)` com as quebras (V1 sem suporte, `session todo` removido, attach novo, `structuredOutput: tool` sem efeito, troca de perfil no resume permitida).
- [ ] **Step 3: Portão (controlador):** `npm test` 0 falhas; `npm run scan-secrets`; `git diff --check`; ao vivo com `OPC_LIVE=1 OPC_OPENCODE_BIN=~/.opencode/bin/opencode OPC_LIVE_MODEL=<deepseek> OPC_LIVE_MODEL_2=<qwen>`: `tests/live/contract.mjs`, `f5-mcp.mjs`, `f5-transfer.mjs`, e os testes ao vivo de task/review/subagent/conclave que existirem; saída sanitizada em `docs/phases/F6-live-output.md`; serves do operador comparados antes/depois.
- [ ] **Step 4:** relatório `F6-report.md` (PASSOU / NÃO VALIDADO por item, incluindo os procedimentos manuais no Claude Code/TUI que seguem com o operador).
- [ ] **Step 5: Commit** `docs: document the OpenCode 2 migration and F6 gate`.
