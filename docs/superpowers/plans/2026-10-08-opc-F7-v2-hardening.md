# F7 — Endurecimento V2 do opc · plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os itens A CONFIRMAR da F6 e da revisão final. Cada fato em aberto do OpenCode 2.0.22 passa a ser medido ao vivo ou a ter código robusto a ambos os resultados.

**Architecture:** Primeiro, duas sondas ao vivo registram os fatos em aberto. A primeira roda sem inferência, num servidor isolado; a segunda usa os dois modelos do gateway num servidor gerenciado pelo opc. As tarefas seguintes corrigem cada ponto com testes sobre fakes. Onde o fato ainda é incerto, o código cobre os dois comportamentos possíveis em vez de apostar num deles. A precedência de config é a única tarefa com duas variantes, escolhidas pelo resultado da sonda. A fase fecha com docs, CHANGELOG, relatório e portão, como na F6.

**Tech Stack:** Node ≥ 20, ESM, `node:test`, sem dependências de runtime. OpenCode ≥ 2.0.22 (`~/.opencode/bin/opencode`).

**Spec:** Não há spec novo; a base é a lista de pendências da F6:
- [`docs/phases/F6-report.md`](../../phases/F6-report.md), seção "Pendências e achados".
- [`docs/phases/F6-live-output.md`](../../phases/F6-live-output.md), achados 5 a 10.
- [plano da F6](2026-10-06-opc-F6-opencode-v2.md).

Os achados da revisão final da F6 estão resumidos na tabela abaixo.

## Origem de cada tarefa

| # | Item em aberto | Origem | Tarefa |
|---|---|---|---|
| 1 | Compactação síncrona ou assíncrona (`delivery: steer`) | F6-report | 1, 8 |
| 2 | `compact.json` sintético | F6-report | 1 |
| 3 | Ordem de precedência das fontes de `GET /api/config` | revisão final #4 | 1, 2 |
| 4 | Attach não espera o catálogo; boot espera 30 s sem `model.updated` | F6-report, revisão #6 | 1, 3 |
| 5 | Servidor gerenciado V1 registrado após o upgrade | F6-report | 4 |
| 6 | `children` pagina com `parentID` + `cursor` | revisão #5 | 1, 5 |
| 7 | `interrupted:false` com semânticas diferentes em `jobs.mjs` e `runner.mjs` | F6-report | 6 |
| 8 | Permissões e modelo de `session fork` | F6-report | 1, 7 |
| 9 | `session show --limit N` devolve as N **mais antigas** (o V1 devolvia as recentes) | levantamento F7 | 7 |
| 10 | Revert pendente e prompt novo; revert com config ilegível | revisão #7, #8 | 1, 8 |
| 11 | Retomada do transfer: senha sem origem e binário `opencode` fixo (na máquina do operador é o V1) | F6-report + levantamento F7 | 9 |
| 12 | Ramos mortos de `StructuredOutputError` (V1) | revisão #9 | 10 |

## Global Constraints

- OpenCode mínimo: `MIN_OPENCODE_VERSION = '2.0.22'`; só rotas `/api/*`. Nada de V1.
- Sem dependências novas, nem de runtime nem de dev.
- Prosa de docs, mensagens de usuário e relatórios em português brasileiro; código, identificadores e comentários em inglês.
- Repo público: provider pessoal só aparece como `omniroute-personal`. Nada de caminho pessoal, e-mail, senha, token ou `chatgpt-account-id` em arquivo versionado. Valide com `npm run scan-secrets`.
- Toda sessão criada pelo opc nasce com `permissions` e `model` explícitos. Isso inclui os forks (Tarefa 7).
- O opc nunca usa `/api/model/default` como modelo de execução.
- Testes ao vivo:
  - Só com `OPC_LIVE=1`, cada um com servidor próprio (porta e senha próprias).
  - Nunca tocar nos serves do operador (portas 13371–13375 e 34975) nem em `~/.config/opencode/`.
  - Nunca chamar `opencode session export/import/delete` sem `--server` ou `--standalone`.
  - A saída vai sanitizada para `docs/phases/F7-live-output.md`. Restaure os `docs/phases/F*-live-output.md` de outras fases que os testes alterarem.
- Commits: Conventional Commits, sem trailer de co-autoria ou atribuição.
- Validação de cada tarefa: `node --test <arquivos da tarefa>`, `git diff --check`. No fim: `node scripts/run-tests.mjs` (0 falhas) e `npm run scan-secrets`.

## Review Focus

1. **Sessão longa no `session show`:** a mudança para "as N mais recentes" não pode quebrar a busca de `messageID` dos testes ao vivo e da skill. Com `--limit` maior que a sessão, todas as mensagens aparecem em ordem cronológica (teste na Tarefa 7).
2. **Provider declarado e nunca carregado:** credencial errada ou gateway fora do ar. O boot não pode travar; espera no máximo o teto e segue com aviso (teste na Tarefa 3).
3. **Registro V1 com jobs ativos:** o opc não derruba o servidor nem reaproveita um servidor incompatível. Recusa com mensagem que manda esperar ou cancelar os jobs (teste na Tarefa 4).
4. **Fork de sessão sem `permissions` na resposta do servidor:** o opc aplica as regras da origem em vez de deixar o fork sem regras (teste na Tarefa 7).
5. **`summarize` em sessão que nunca fica ociosa dentro do prazo:** sai com `TIMEOUT` e diz que a compactação continua no servidor. Não declara `summarized: true` (teste na Tarefa 8).

---

### Task 1: Sondas ao vivo dos fatos em aberto

**Files:**
- Create: `tests/live/f7-contract.mjs` (servidor isolado, sem inferência)
- Create: `tests/live/f7-inference.mjs` (servidor gerenciado pelo opc, com os modelos do gateway)
- Create: `docs/phases/F7-live-output.md` (saída sanitizada; versionada)
- Modify: `tests/fixtures/contract/opencode-2.0.22/compact.json` (troca o sintético pelo real, sanitizado)
- Create: `tests/fixtures/contract/opencode-2.0.22/config-precedence.json` (fontes reais de `GET /api/config`, sanitizadas)

**Interfaces:**
- Produces, em `docs/phases/F7-live-output.md`, uma tabela "Fatos" com as linhas abaixo. As tarefas seguintes citam a linha pelo ID:
  - `P1-precedence`: `last-wins` ou `first-wins`. Diz qual documento de `GET /api/config` vence para `model`, a julgar pelo `model` com que o servidor cria uma sessão sem modelo.
  - `P2-children-cursor`: `cursor-keeps-filter`, `cursor-drops-filter` ou `400`.
  - `P3-fork`: se o fork herda `permissions` e `model` (`inherits` ou `missing`).
  - `P4-model-updated`: ms até o primeiro `model.updated`, ou `none-in-35s`. Medido num servidor só com provider customizado.
  - `I1-compaction`: `sync` (o POST só volta depois de compactar) ou `async`. A medição registra quanto tempo a sessão fica ativa ou com `time.compacting` depois do POST.
  - `I2-pending-revert`: o que um prompt novo faz com um revert pendente (`consolidates`, `keeps-pending` ou `clears`) e se os arquivos voltam.
- Produces: `compact.json` real e `config-precedence.json`.

Esta tarefa é ao vivo. **[PAUSA-APROVAÇÃO]** antes de rodar `f7-inference.mjs`: ela faz inferência nos modelos do gateway do operador (`OPC_LIVE_MODEL`, `OPC_LIVE_MODEL_2`). `f7-contract.mjs` não faz inferência e roda com `[AGENT-OK]`.

- [ ] **Step 1: Escrever `tests/live/f7-contract.mjs`**

O harness copia o de `tests/live/contract-v2.mjs`: `freePort`, HOME/XDG temporários, `OPENCODE_CONFIG_CONTENT` com um provider customizado apontando para `127.0.0.1:9` e `processesWithHome`, que limpa no fim tudo o que tiver o HOME isolado. Não exporta nada.

```js
#!/usr/bin/env node
// F7 live probes without inference: config precedence, children cursor, fork inheritance, model.updated timing.
// Run: OPC_LIVE=1 [OPC_OPENCODE_BIN=/path/to/opencode] node tests/live/f7-contract.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { mergeOpencodeConfigSources } from '../../plugins/opc/scripts/lib/opencode-config.mjs';
import { makeTempDir, removeTempDir, REPO_ROOT } from '../helpers.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('f7-contract: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

const PROVIDER = 'omniroute-personal';
const MODELS = ['probe/model-env', 'probe/model-project', 'probe/model-global'];
const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }];
const REPORT = path.join(REPO_ROOT, 'docs/phases/F7-live-output.md');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22/config-precedence.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function processesWithHome(home) {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) found.push(Number(pid));
    } catch { /* gone or not ours */ }
  }
  return found;
}

const base = makeTempDir('opc-f7-contract-');
const home = path.join(base, 'home');
const ws = path.join(base, 'workspace');
const xdgConfig = path.join(base, 'config');
for (const dir of [home, ws, path.join(xdgConfig, 'opencode'), path.join(base, 'data'), path.join(base, 'state'), path.join(base, 'cache')]) fs.mkdirSync(dir, { recursive: true });
const providerModels = Object.fromEntries(MODELS.map((full) => [full.split('/').slice(1).join('/'), { name: full }]));
const provider = { [PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: 'Probe provider', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-provider-key' }, models: { 'probe/model-env': { name: 'env' }, 'probe/model-project': { name: 'project' }, 'probe/model-global': { name: 'global' } } } };
// Three documents declare a different `model`: global config file, project file, and OPENCODE_CONFIG_CONTENT.
fs.writeFileSync(path.join(xdgConfig, 'opencode', 'opencode.json'), JSON.stringify({ model: `${PROVIDER}/probe/model-global` }));
fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify({ model: `${PROVIDER}/probe/model-project` }));
const password = crypto.randomBytes(18).toString('base64url');
const port = await freePort();
const env = {
  PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: path.join(base, 'data'),
  XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache'),
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', model: `${PROVIDER}/probe/model-env`, provider }),
};
const url = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
async function call(method, route, { body } = {}) {
  const res = await fetch(`${url}${route}`, {
    method,
    headers: { authorization: auth, 'x-opencode-directory': ws, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, data: json?.data ?? json };
}
const sanitize = (value) => JSON.parse(JSON.stringify(value).split(base).join('<tmp>').split(ws).join('<workspace>'));

const facts = {};
const bin = process.env.OPC_OPENCODE_BIN || 'opencode';
const started = performance.now();
const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
let exitCode = 0;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('servidor não ficou pronto em 30 s')), 30000);
    let out = '';
    const onData = (chunk) => { out += chunk; if (/\bserver listening on https?:\/\/\S+/.test(out)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`servidor saiu antes de ficar pronto (código ${code})`)); });
  });

  // P4: subscribe before the first workspace request and time the first model.updated.
  const events = new AbortController();
  const p4 = (async () => {
    const res = await fetch(`${url}/api/event`, { headers: { authorization: auth, 'x-opencode-directory': ws, accept: 'text/event-stream' }, signal: events.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'stream-ended';
      buffer += decoder.decode(value, { stream: true });
      if (/"type"\s*:\s*"model\.updated"/.test(buffer)) return `${Math.round(performance.now() - started)} ms`;
    }
  })().catch(() => 'none-in-35s');
  const p4Timeout = sleep(35000).then(() => 'none-in-35s');

  // P1: document order and the model the server picks for a session created without one.
  const config = await call('GET', '/api/config');
  const documents = (config.json ?? []).filter((s) => s?.type === 'document').map((s) => s.info?.model ?? null);
  fs.writeFileSync(FIXTURE, `${JSON.stringify(sanitize(config.json), null, 2)}\n`);
  const bare = await call('POST', '/api/session', { body: { title: 'OPC: f7 precedence', permissions: RULES } });
  const picked = bare.data?.model ? `${bare.data.model.providerID}/${bare.data.model.id}` : `status ${bare.status}`;
  const merged = mergeOpencodeConfigSources(config.json ?? []).model ?? null;
  facts['P1-precedence'] = { documents, serverPicked: picked, opcMerge: merged, verdict: picked === merged ? 'last-wins' : (picked === documents.find(Boolean) ? 'first-wins' : 'unknown') };

  // P2: children paging with parentID + cursor.
  const model = { providerID: PROVIDER, id: 'probe/model-env' };
  const parent = await call('POST', '/api/session', { body: { title: 'OPC: f7 parent', permissions: RULES, model } });
  for (let i = 0; i < 3; i += 1) await call('POST', '/api/session', { body: { parentID: parent.data.id, title: `OPC: f7 child ${i}`, permissions: RULES, model } });
  const first = await call('GET', `/api/session?parentID=${parent.data.id}&limit=2`);
  const next = first.json?.cursor?.next;
  const withFilter = next ? await call('GET', `/api/session?parentID=${parent.data.id}&limit=2&cursor=${encodeURIComponent(next)}`) : null;
  const withoutFilter = next ? await call('GET', `/api/session?limit=2&cursor=${encodeURIComponent(next)}`) : null;
  const onlyChildren = (r) => Array.isArray(r?.data) && r.data.every((s) => s.parentID === parent.data.id);
  facts['P2-children-cursor'] = {
    firstPage: first.data?.length ?? null,
    nextCursor: Boolean(next),
    withParentID: withFilter ? { status: withFilter.status, onlyChildren: onlyChildren(withFilter) } : null,
    cursorOnly: withoutFilter ? { status: withoutFilter.status, onlyChildren: onlyChildren(withoutFilter) } : null,
    verdict: !withFilter ? 'no-second-page' : withFilter.status === 400 ? '400' : onlyChildren(withoutFilter) ? 'cursor-keeps-filter' : 'cursor-drops-filter',
  };

  // P3: fork inheritance of permissions and model.
  const forked = await call('POST', `/api/session/${parent.data.id}/fork`, { body: {} });
  const fork = await call('GET', `/api/session/${forked.data.id}`);
  const samePermissions = JSON.stringify(fork.data?.permissions ?? null) === JSON.stringify(RULES);
  const sameModel = fork.data?.model?.id === model.id && fork.data?.model?.providerID === model.providerID;
  facts['P3-fork'] = { permissions: fork.data?.permissions ?? null, model: fork.data?.model ?? null, verdict: samePermissions && sameModel ? 'inherits' : 'missing' };

  facts['P4-model-updated'] = await Promise.race([p4, p4Timeout]);
  events.abort();
} catch (error) {
  exitCode = 1;
  facts.error = error.message;
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  for (const pid of processesWithHome(home)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  removeTempDir(base);
}

const lines = ['', '## f7-contract (sem inferência)', '', '| Fato | Resultado |', '|---|---|',
  ...Object.entries(facts).map(([key, value]) => `| \`${key}\` | \`${JSON.stringify(sanitize(value)).replaceAll('|', '\\|')}\` |`), ''];
fs.appendFileSync(REPORT, lines.join('\n'));
console.log(lines.join('\n'));
process.exit(exitCode);
```

- [ ] **Step 2: Criar o cabeçalho de `docs/phases/F7-live-output.md`**

```markdown
# F7 — saída ao vivo

Executado em DD/MM/AAAA (America/Belem) pelo controlador, com o OpenCode 2.0.22 (`OPC_OPENCODE_BIN`).
`f7-contract.mjs` roda num servidor isolado (HOME/XDG temporários, provider fechado em `127.0.0.1:9`), sem
inferência. `f7-inference.mjs` usa um servidor gerenciado pelo opc com snapshots ligados e os modelos
`omniroute-personal/cmd/deepseek/deepseek-v4-flash` e `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`.
```

- [ ] **Step 3: Rodar `f7-contract.mjs`** `[AGENT-OK]`

Run: `OPC_LIVE=1 OPC_OPENCODE_BIN=$HOME/.opencode/bin/opencode node tests/live/f7-contract.mjs`
Expected: exit 0. A tabela recebe uma linha para cada fato, de `P1` a `P4`. Depois, `ps -eo args | grep -c "opc-f7-contract"` deve dar 0.

- [ ] **Step 4: Escrever `tests/live/f7-inference.mjs`**

```js
// F7 live probes with inference (OPC_LIVE=1, OPC_LIVE_MODEL): compaction timing and pending revert + new prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { SKIP, MODELS, liveWorkspace, opc, fileLines, userText, appendSafeOutput } from './_f3-lib.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { readServerRecord } from '../../plugins/opc/scripts/lib/server.mjs';
import { REPO_ROOT } from '../helpers.mjs';

const REPORT = join(REPO_ROOT, 'docs/phases/F7-live-output.md');
const FIXTURE = join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22/compact.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fact = (key, value, dataDir) => appendSafeOutput(REPORT, `| \`${key}\` | \`${JSON.stringify(value).replaceAll('|', '\\|')}\` |\n`, dataDir);

test('F7 live: compaction timing and pending revert + new prompt', { skip: SKIP, timeout: 30 * 60_000 }, async (t) => {
  const { ws, env, dataDir, stateDir } = liveWorkspace(t);
  const notes = join(ws, 'notes.txt');
  const run = (args) => opc(args, { env, cwd: ws });
  appendSafeOutput(REPORT, '\n## f7-inference\n\n| Fato | Resultado |\n|---|---|\n', dataDir);

  let res = await run(['session', 'new', '--title', 'f7', '--model', MODELS.deepseek, '--write', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const sid = JSON.parse(res.stdout).session.id;
  for (const word of ['ALPHA', 'BETA']) {
    res = await run(['task', '--resume', sid, '--write', '--model', MODELS.deepseek, `Append a new line containing exactly ${word} to the end of notes.txt. Do not change anything else and do not run shell commands.`]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
  }
  const record = readServerRecord(stateDir());
  const api = createApi(createClient({ baseUrl: record.url, password: record.password, directory: ws }));

  // I2: stage a revert of the BETA turn, then send a new prompt and observe the revert and the files.
  const show = JSON.parse((await run(['session', 'show', sid, '--limit', '200', '--json'])).stdout);
  const beta = show.messages.filter((m) => m.type === 'user').find((m) => userText(m).includes('BETA')).id;
  res = await run(['session', 'revert', sid, beta, '--confirmed-by-user', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const afterStage = fileLines(notes);
  res = await run(['task', '--resume', sid, '--model', MODELS.deepseek, 'Reply with exactly OK.']);
  const session = await api.getSession(sid);
  const ids = (await api.messages(sid)).map((m) => m.id);
  fact('I2-pending-revert', {
    afterStage, afterPrompt: fileLines(notes), promptExit: res.code,
    revertAfterPrompt: session.revert ? 'pending' : 'none', betaMessageKept: ids.includes(beta),
    verdict: session.revert ? 'keeps-pending' : ids.includes(beta) ? 'clears' : 'consolidates',
  }, dataDir);

  // I1: raw compaction (captured for the contract fixture) and the session state right after it.
  await api.setModel(sid, { providerID: MODELS.qwen.split('/')[0], id: MODELS.qwen.split('/').slice(1).join('/') });
  const startedAt = performance.now();
  const compaction = await api.compact(sid, { timeoutMs: 600_000 });
  const postMs = Math.round(performance.now() - startedAt);
  fs.writeFileSync(FIXTURE, `${JSON.stringify({ data: compaction }, null, 2)}\n`);
  const timeline = [];
  for (let i = 0; i < 480; i += 1) {
    const active = Boolean((await api.sessionStatus())?.[sid]);
    const current = await api.getSession(sid);
    timeline.push({ ms: Math.round(performance.now() - startedAt), active, compacting: current?.time?.compacting ?? null });
    if (!active && !current?.time?.compacting) break;
    await sleep(250);
  }
  const types = (await api.messages(sid)).map((m) => m.type);
  const busyAfterPost = timeline[0]?.active || Boolean(timeline[0]?.compacting);
  fact('I1-compaction', {
    postMs, firstPoll: timeline[0], settledMs: timeline.at(-1)?.ms, polls: timeline.length, messageTypes: types,
    verdict: busyAfterPost ? 'async' : 'sync',
  }, dataDir);
});
```

- [ ] **Step 5: Rodar `f7-inference.mjs`** `[PAUSA-APROVAÇÃO]`

Peça o **sim** do operador para a inferência. Depois:

Run: `OPC_LIVE=1 OPC_OPENCODE_BIN=$HOME/.opencode/bin/opencode OPC_LIVE_MODEL=<modelo 1> OPC_LIVE_MODEL_2=<modelo 2> node --test tests/live/f7-inference.mjs`
Expected: `# pass 1`. A tabela recebe `I1` e `I2`, e `compact.json` sai real.

- [ ] **Step 6: Sanitizar e restaurar**

Run:
```bash
sed -i 's/omniroute-[a-z0-9-]*/omniroute-personal/g' docs/phases/F7-live-output.md tests/fixtures/contract/opencode-2.0.22/compact.json tests/fixtures/contract/opencode-2.0.22/config-precedence.json
git status --short docs/phases
```
Restaure com `git restore <arquivo>` qualquer `docs/phases/F*-live-output.md` modificado que não seja o da F7. Conferir que `npm run scan-secrets` está limpo e que `node --test tests/unit/contract-shapes*.test.mjs tests/unit/pagination-v2.test.mjs` passa com o `compact.json` real. Se a forma real divergir da sintética, ajuste `tests/fixtures/contract-shapes.mjs` (`assertShape('compact', …)`) e o fake (`tests/fixtures/f3-fake.mjs`, rota `POST /api/session/:id/compact`) para a forma real.

- [ ] **Step 7: Commit**

```bash
git add tests/live/f7-contract.mjs tests/live/f7-inference.mjs docs/phases/F7-live-output.md tests/fixtures/contract/opencode-2.0.22/compact.json tests/fixtures/contract/opencode-2.0.22/config-precedence.json tests/fixtures/contract-shapes.mjs tests/fixtures/f3-fake.mjs
git commit -m "test(live): probe OpenCode 2.0.22 facts left open by F6"
```

---

### Task 2: Precedência das fontes de config

**Files:**
- Modify: `plugins/opc/scripts/lib/opencode-config.mjs:8-11`
- Modify: `plugins/opc/scripts/lib/server.mjs:229-247` (`worldCheck` passa a usar `mergeOpencodeConfigSources`)
- Test: `tests/unit/opencode-config-precedence.test.mjs`

**Interfaces:**
- Consumes: `config-precedence.json` e o fato `P1-precedence` da Tarefa 1.
- Produces: `mergeOpencodeConfigSources(sources) → object`, com a mesma assinatura e a ordem confirmada ao vivo. `worldCheck` passa a usar essa função.

- [ ] **Step 1: Teste que fixa a ordem real**

```js
// tests/unit/opencode-config-precedence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeOpencodeConfigSources } from '../../plugins/opc/scripts/lib/opencode-config.mjs';
import { REPO_ROOT } from '../helpers.mjs';

const sources = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22/config-precedence.json'), 'utf8'));

test('the merged model is the one OpenCode 2.0.22 used for a session created without a model (F7 P1)', () => {
  // Captured live: env content declared probe/model-env, the project file probe/model-project and the
  // global file probe/model-global; the server created the bare session with SERVER_PICKED.
  const SERVER_PICKED = 'omniroute-personal/probe/model-env'; // copy P1-precedence.serverPicked from F7-live-output.md
  assert.equal(mergeOpencodeConfigSources(sources).model, SERVER_PICKED);
});
```

Antes de rodar, copie para `SERVER_PICKED` o valor real de `P1-precedence.serverPicked` registrado em `docs/phases/F7-live-output.md`.

- [ ] **Step 2: Rodar**

Run: `node --test tests/unit/opencode-config-precedence.test.mjs`
Expected: com `P1 = last-wins`, o teste passa e o Step 3 fica só com a troca no `worldCheck`. Com `P1 = first-wins`, o teste falha e o Step 3 aplica a Variante B.

- [ ] **Step 3: Implementar**

Variante A (`last-wins`): a função não muda. Variante B (`first-wins`): a primeira fonte vence.

```js
// Variant B — plugins/opc/scripts/lib/opencode-config.mjs
export function mergeOpencodeConfigSources(sources) {
  if (!Array.isArray(sources)) throw new UsageError('UNSUPPORTED_VERSION', 'A configuração do OpenCode V2 não é uma lista de fontes.');
  const documents = sources.filter((source) => source?.type === 'document' && source.info && typeof source.info === 'object' && !Array.isArray(source.info));
  // OpenCode 2.0.22 lists the winning document first (F7 P1): assign in reverse so the first one wins.
  return Object.assign({}, ...documents.reverse().map((source) => source.info));
}
```

Nas duas variantes, `worldCheck` deixa de ter merge próprio:

```js
// plugins/opc/scripts/lib/server.mjs — inside worldCheck, replacing the local filter/Object.assign
import { mergeOpencodeConfigSources } from './opencode-config.mjs';
// …
    const sources = await createApi(client).getConfigSources();
    if (!Array.isArray(sources) || !sources.some((source) => source?.type === 'document')) {
      throw new Error('Nenhuma fonte de configuração do OpenCode V2 foi encontrada.');
    }
    oc = mergeOpencodeConfigSources(sources);
```

Na Variante B, o teste existente `onboarding merges V2 config documents in order…` (`tests/unit/server-final-review.test.mjs:16`) e `V2 config documents merge in source order before share check` (`:89`) precisam inverter a ordem das fontes. O resultado esperado continua o mesmo.

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/opencode-config-precedence.test.mjs tests/unit/server-final-review.test.mjs tests/integration/opencode-default-model.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/opencode-config.mjs plugins/opc/scripts/lib/server.mjs tests/unit/opencode-config-precedence.test.mjs tests/unit/server-final-review.test.mjs
git commit -m "fix(config): pin OpenCode config source precedence to the live order"
```

---

### Task 3: Catálogo pronto pelos providers declarados (gerenciado e attach)

**Files:**
- Modify: `plugins/opc/scripts/lib/server.mjs` (`waitForModelCatalog`, `bootServer`, `attachServer`)
- Test: `tests/unit/server-catalog-ready.test.mjs`

**Interfaces:**
- Consumes: `mergeOpencodeConfigSources` (Tarefa 2).
- Produces: `expectedProviders(opencodeConfig) → string[]` e `waitForModelCatalog(api, { timeoutMs, pollMs, bootstrap, bootstrapTimeoutMs, expected }) → Promise<{ models, missing: string[] }>`. Antes a função devolvia só `models`; atualize os callers.

A regra: o catálogo está pronto quando todo provider declarado em `provider` da config aparece em `/api/model`, descontados `disabled_providers` e respeitado `enabled_providers`. `model.updated` só antecipa o fim da espera. Sem nenhum provider declarado, vale a regra da F6: esperar o evento até o teto. Assim o boot não espera 30 s quando há providers declarados e o evento não vem. O attach ganha a mesma garantia sem depender de SSE.

- [ ] **Step 1: Testes**

```js
// tests/unit/server-catalog-ready.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedProviders, waitForModelCatalog } from '../../plugins/opc/scripts/lib/server.mjs';

const model = (providerID, id = 'm') => ({ providerID, id });

test('expectedProviders honours provider, enabled_providers and disabled_providers', () => {
  assert.deepEqual(expectedProviders({ provider: { a: {}, b: {}, c: {} }, disabled_providers: ['b'] }), ['a', 'c']);
  assert.deepEqual(expectedProviders({ provider: { a: {}, b: {} }, enabled_providers: ['b'] }), ['b']);
  assert.deepEqual(expectedProviders({}), []);
});

test('catalog is ready as soon as every declared provider is listed, without waiting for model.updated', async () => {
  let calls = 0;
  const api = { models: async () => { calls += 1; return calls < 3 ? [model('opencode')] : [model('opencode'), model('gateway')]; } };
  const started = performance.now();
  const result = await waitForModelCatalog(api, { bootstrap: new Promise(() => {}), bootstrapTimeoutMs: 30_000, pollMs: 1, expected: ['gateway'] });
  assert.deepEqual(result.missing, []);
  assert.equal(calls, 3);
  assert.ok(performance.now() - started < 1000, 'did not wait for the bootstrap deadline');
});

test('a declared provider that never loads ends the wait at the deadline with missing providers', async () => {
  const api = { models: async () => [model('opencode')] };
  const result = await waitForModelCatalog(api, { timeoutMs: 50, pollMs: 5, expected: ['gateway'] });
  assert.deepEqual(result.missing, ['gateway']);
  assert.equal(result.models.length, 1);
});

test('without declared providers and without a bootstrap stream the first non-empty catalog is ready', async () => {
  const result = await waitForModelCatalog({ models: async () => [model('opencode')] }, { pollMs: 1, expected: [] });
  assert.deepEqual(result.missing, []);
});

test('without declared providers the managed boot still waits for model.updated (F6 behaviour)', async () => {
  let announce;
  const bootstrap = new Promise((resolve) => { announce = resolve; });
  let settled = false;
  const pending = waitForModelCatalog({ models: async () => [model('opencode')] }, { bootstrap, bootstrapTimeoutMs: 5_000, pollMs: 1, expected: [] })
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'returned before model.updated with no declared provider to check');
  announce(true);
  assert.deepEqual((await pending).missing, []);
});
```

Também em `tests/unit/server-final-review.test.mjs`, nos testes de "model warm-up":
- troque `(await pending).length` por `(await pending).models.length` e `models.length` por `result.models.length`;
- no teste `waits for the bootstrap model.updated before trusting a partial catalog`, apague a asserção `assert.equal(calls, 0, …)`: o laço novo lê o catálogo enquanto espera, e o que importa é não retornar antes do evento, o que a asserção final de 2 modelos já prova.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/server-catalog-ready.test.mjs`
Expected: FAIL, `expectedProviders is not a function`.

- [ ] **Step 3: Implementar em `server.mjs`**

```js
export function expectedProviders(opencodeConfig) {
  const declared = Object.keys(opencodeConfig?.provider ?? {});
  const enabled = Array.isArray(opencodeConfig?.enabled_providers) ? new Set(opencodeConfig.enabled_providers) : null;
  const disabled = new Set(Array.isArray(opencodeConfig?.disabled_providers) ? opencodeConfig.disabled_providers : []);
  return declared.filter((id) => !disabled.has(id) && (!enabled || enabled.has(id)));
}

// Ready when every declared provider is listed (the bootstrap event only shortens the wait). A provider that
// never loads (bad key, gateway down) ends the wait at the deadline and is reported in `missing`.
export async function waitForModelCatalog(api, { timeoutMs = 20_000, pollMs = 200, bootstrap = null, bootstrapTimeoutMs = 30_000, expected = [] } = {}) {
  let announced = false;
  bootstrap?.then((value) => { announced = value === true; });
  const bootstrapDeadline = performance.now() + bootstrapTimeoutMs;
  const deadline = performance.now() + Math.max(timeoutMs, bootstrap ? bootstrapTimeoutMs : 0);
  let models = [];
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      if (models.length === 0) throw new ConnectionError('TIMEOUT', 'O catálogo de modelos do OpenCode não carregou a tempo.');
      return { models, missing: expected.filter((id) => !models.some((m) => m.providerID === id)) };
    }
    try {
      models = await api.models({ timeoutMs: Math.max(1, Math.ceil(remaining)) });
    } catch (err) {
      if (err.code === 'TIMEOUT' && performance.now() >= deadline) throw new ConnectionError('TIMEOUT', 'O catálogo de modelos do OpenCode não carregou a tempo.');
      throw err;
    }
    if (!Array.isArray(models)) throw new ConnectionError('UNSUPPORTED_VERSION', 'O catálogo de modelos não tem o formato do OpenCode V2.');
    const missing = expected.filter((id) => !models.some((m) => m.providerID === id));
    // With declared providers, their presence is the signal. Without any, keep the F6 rule: wait for
    // model.updated until the bootstrap deadline (gateway providers can come from outside `provider`).
    const bootstrapOver = !bootstrap || performance.now() >= bootstrapDeadline;
    const ready = announced || (missing.length === 0 && (expected.length > 0 || bootstrapOver));
    if (models.length > 0 && ready) return { models, missing };
    const delay = Math.min(pollMs, deadline - performance.now());
    if (delay > 0) await sleep(delay);
  }
}
```

No `bootServer`, troque `await waitForModelCatalog(api, { bootstrap: bootstrap.ready });` por:

```js
        const opencodeConfig = await loadOpencodeConfig(api);
        const { missing } = await waitForModelCatalog(api, { bootstrap: bootstrap.ready, expected: expectedProviders(opencodeConfig) });
        if (missing.length) catalogWarnings.push(`Providers declarados ainda sem modelos no catálogo: ${missing.join(', ')}. Confira credenciais e o gateway.`);
```

Declare `const catalogWarnings = [];` antes do `try` e faça `warnings.push(...catalogWarnings)` logo depois de `const warnings = [];`. Importe `loadOpencodeConfig` de `./opencode-config.mjs`.

No `attachServer`, depois de `assertSupportedVersion(health)`:

```js
  const api = createApi(client);
  const { missing } = await waitForModelCatalog(api, { timeoutMs: 15_000, expected: expectedProviders(await loadOpencodeConfig(api)) });
```

Faça também `if (missing.length) warnings.push(...)`, com o mesmo texto, depois do `warnings.unshift(...)`.

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/server-catalog-ready.test.mjs tests/unit/server-final-review.test.mjs tests/integration/server-boot.test.mjs tests/integration/server-lifecycle.test.mjs`
Expected: PASS. Se algum teste de attach com `fetch` mockado reclamar de rota inesperada `/api/model`, acrescente ao mock a resposta `loadContractSample('model.json')`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/server.mjs tests/unit/server-catalog-ready.test.mjs tests/unit/server-final-review.test.mjs
git commit -m "fix(server): treat the catalog as ready when declared providers load, in managed and attach modes"
```

---

### Task 4: Servidor gerenciado V1 registrado após o upgrade

**Files:**
- Modify: `plugins/opc/scripts/lib/server.mjs` (`ensureServer`, bloco `if (record)`)
- Test: `tests/unit/server-v1-record.test.mjs`

**Interfaces:**
- Produces: nenhuma nova. `ensureServer` deixa de lançar `NOT_JSON`/`UNSUPPORTED_VERSION` para um processo **do próprio opc** (identidade conferida) que responde como V1. Sem jobs ativos, encerra esse processo e sobe um novo. Com jobs ativos, lança `UsageError('V1_SERVER_ACTIVE', …)`.

Hoje um V1 registrado responde `/api/info` com a SPA em HTML (`NOT_JSON`), e todo comando falha até um `opc setup --stop-server` manual.

- [ ] **Step 1: Teste**

```js
// tests/unit/server-v1-record.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { spawnDetached, terminateProcessGroup, isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { makeTempDir, registerStopper, trackTempDir } from '../helpers.mjs';

async function recordedV1(t) {
  const dir = trackTempDir(t, makeTempDir('opc-v1-record-'));
  const script = path.join(dir, 'opencode');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const proc = await spawnDetached(process.execPath, [script, 'serve', '--port', '43211'], { cwd: dir, env: process.env, logFile: path.join(dir, 'child.log') });
  registerStopper(t, async () => terminateProcessGroup(proc, (argv) => argv.includes(script), { graceMs: 500 }));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 1, ...proc, port: 43211, url: 'http://127.0.0.1:43211', version: '1.18.34', password: 'fixture-only' }));
  t.mock.method(globalThis, 'fetch', async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  return { dir, proc, script };
}

test('a recorded opc V1 server is shut down instead of failing every command with NOT_JSON', async (t) => {
  const { dir, proc, script } = await recordedV1(t);
  const config = { server: { opencodeBin: path.join(dir, 'missing-opencode'), bootTimeoutSec: 1 } };
  await assert.rejects(ensureServer({ stateDir: dir, workspaceRoot: dir, config, env: {}, opencodeBin: script }), (error) => {
    assert.notEqual(error.code, 'NOT_JSON');
    return true;
  });
  assert.equal(isPidAlive(proc.pid), false, 'the V1 server was stopped');
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test('with active jobs a recorded V1 server is kept and the command is refused', async (t) => {
  const { dir, proc, script } = await recordedV1(t);
  await assert.rejects(ensureServer({ stateDir: dir, workspaceRoot: dir, config: {}, env: {}, opencodeBin: script, hasActiveJobs: () => true }), { code: 'V1_SERVER_ACTIVE' });
  assert.equal(isPidAlive(proc.pid), true);
});
```

`opencodeBin: script` faz `serverMatcher` reconhecer o processo como do opc. O boot seguinte falha de propósito, porque o binário não existe; o teste só confere que o V1 saiu de cena.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/server-v1-record.test.mjs`
Expected: FAIL; o primeiro teste rejeita com `NOT_JSON`.

- [ ] **Step 3: Implementar**

Em `ensureServer`, substitua estas duas linhas:

```js
        if (health.ok) assertSupportedVersion(health);
        if (health.error?.code === 'UNSUPPORTED_VERSION' || health.error?.code === 'NOT_JSON') throw health.error;
```

por:

```js
        // The identity check above proved this is opc's own process: an old (V1) server answers /api/info with
        // the SPA (NOT_JSON) or an old version, so replace it instead of failing every command.
        const incompatible = health.error?.code === 'NOT_JSON' || health.error?.code === 'UNSUPPORTED_VERSION'
          || (health.ok && compareVersions(health.version, MIN_OPENCODE_VERSION) < 0);
        if (incompatible) {
          if (hasActiveJobs()) {
            throw new UsageError('V1_SERVER_ACTIVE', 'O servidor gerenciado registrado é anterior ao OpenCode 2.0.22 e há jobs ativos nele; aguarde (/opc:status) ou cancele (/opc:cancel) e rode o comando de novo.');
          }
          await shutdownRecorded(stateDir, record, full.opencodeBin);
          warnings.push('Servidor gerenciado anterior ao OpenCode 2.0.22 encerrado; um servidor V2 será iniciado.');
        } else {
```

Feche o `else` envolvendo o restante do bloco: o reaproveitamento por versão igual, o reaproveitamento com jobs ativos e o desligamento por versão mudada ou travamento. `hasActiveJobs` já está desestruturado no topo de `ensureServer`.

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/server-v1-record.test.mjs tests/unit/server-final-review.test.mjs tests/integration/server-lifecycle.test.mjs tests/integration/server-boot.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/server.mjs tests/unit/server-v1-record.test.mjs
git commit -m "fix(server): replace a recorded pre-2.0.22 managed server instead of failing with NOT_JSON"
```

---

### Task 5: Paginação de `children` sem `parentID` nas páginas de cursor

**Files:**
- Modify: `plugins/opc/scripts/lib/api.mjs` (`sessionsPage`)
- Test: `tests/unit/pagination-v2.test.mjs:111-130`

**Interfaces:**
- Produces: `sessionsPage({ parentID, limit, cursor })`. Com `cursor`, o `parentID` não vai na query, e o filtro local de `listSessions` segue garantindo só filhas. Esse formato funciona nos três resultados possíveis de `P2`.

- [ ] **Step 1: Ajustar o teste**

Em `tests/unit/pagination-v2.test.mjs`, troque a última asserção do teste `listSessions and children follow…` por:

```js
  // The cursor carries the query (as for messages): parentID only on the first page, local filter keeps children.
  assert.deepEqual(calls[0].query, { parentID: 'ses_p' });
  assert.deepEqual(calls[1].query, { cursor: '2' });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/pagination-v2.test.mjs`
Expected: FAIL; `calls[1].query` ainda traz `parentID`.

- [ ] **Step 3: Implementar**

```js
  // The first page carries the filter; cursor pages send only the cursor (and limit), as the message list requires.
  const sessionsPage = async ({ parentID, limit, cursor } = {}) => {
    const query = given(cursor)
      ? { ...(given(limit) ? { limit: pageLimit(limit) } : {}), cursor }
      : { ...(given(parentID) ? { parentID: assertId('ses', parentID) } : {}), ...(given(limit) ? { limit: pageLimit(limit) } : {}) };
    return toPage(await client.get('/api/session', { ...LIST_BODY, ...(Object.keys(query).length ? { query } : {}) }), 'GET /api/session');
  };
```

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/pagination-v2.test.mjs tests/integration/session-actions.test.mjs tests/unit/runner-safety-v2.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/api.mjs tests/unit/pagination-v2.test.mjs
git commit -m "fix(api): send only the cursor on later session list pages"
```

---

### Task 6: `interrupted: false` significa "já ociosa" também no runner

**Files:**
- Modify: `plugins/opc/scripts/lib/runner.mjs:235` e `:373`
- Test: `tests/unit/runner-safety-v2.test.mjs`

**Interfaces:**
- Produces: a interrupção conta como confirmada quando a chamada não lança **e** a sessão fica ociosa (`waitIdle`). O valor booleano de `interrupted` deixa de importar, como já acontece em `jobs.mjs:670`.

- [ ] **Step 1: Testes**

Acrescente ao laço `for (const mode of [...])` do teste `F4a C1` o modo `'false-idle'`: `interrupt` devolve `false` e a sessão fica ociosa. O resultado esperado é `RetryCapExceeded`.

```js
for (const mode of ['false', 'throws', 'busy', 'delayed-idle', 'false-idle']) {
  // …inside api.interrupt:
  //   if (mode === 'false-idle') { api.sessionStatus = async () => ({}); return false; }
  // …and in the assertions:
  //   if (mode === 'delayed-idle' || mode === 'false-idle') { …RetryCapExceeded… }
```

Teste novo, depois do C2:

```js
test('C2: an interrupt answered with interrupted:false on an idle session still confirms the abort', async () => {
  const { api, hub } = memoryV2();
  stubInterrupt(api, { result: false, idle: true });
  const result = await runTurn({ api, hub, request: request({ idleWaitMs: 50 }), onSession: async () => { throw new Error('storage failed'); } });
  assert.equal(result.errorType, 'CallbackFailed');
  assert.equal(result.abortConfirmed, true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/runner-safety-v2.test.mjs`
Expected: FAIL nos dois testes novos (`abortConfirmed` false; `AbortUnconfirmed`).

- [ ] **Step 3: Implementar**

```js
// runner.mjs:235 — handleRetryStatus
      await api.interrupt(sessionID); // V2: interrupted:false only means the session was already idle
      if (await waitIdle(api, sessionID, idleWaitMs)) forcedError = retryCapError(status);
```

```js
// runner.mjs:373 — safety failure loop
        try { await api.interrupt(id); aborted = true; } catch { /* Unconfirmed. */ }
```

A confirmação final continua sendo `entry.aborted && entry.idle`.

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/runner-safety-v2.test.mjs tests/unit/jobs.test.mjs tests/unit/orchestrate-gate.test.mjs`
Expected: PASS. O modo `'false'` sem ociosidade continua `AbortUnconfirmed`.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/runner.mjs tests/unit/runner-safety-v2.test.mjs
git commit -m "fix(runner): confirm interrupts by idleness, not by the interrupted flag"
```

---

### Task 7: `session show` com as mensagens recentes; `fork` herda regras e modelo

**Files:**
- Modify: `plugins/opc/scripts/lib/api.mjs` (novo `latestMessages`)
- Modify: `plugins/opc/scripts/lib/session-messages.mjs` (`readSessionMessages`)
- Modify: `plugins/opc/scripts/commands/session.mjs` (`actionShow`, `actionFork`)
- Modify: `tests/fixtures/f3-fake.mjs` (rota de fork herda `permissions`/`model`, como no fato `P3`)
- Test: `tests/unit/pagination-v2.test.mjs`, `tests/integration/session-actions.test.mjs`

**Interfaces:**
- Produces: `api.latestMessages(id, { limit }) → Promise<Message[]>`, com as `limit` mais recentes em ordem cronológica e `limit ≤ 200`. Usa a ordem padrão do V2 (`desc`) e inverte.
- Produces: `readSessionMessages(api, id, { limit, latest = false })`; `actionShow` passa `latest: true`.
- Produces: `actionFork` aplica `setPermissions`/`setModel` quando o fork volta sem as regras ou o modelo da origem.

- [ ] **Step 1: Testes**

```js
// tests/unit/pagination-v2.test.mjs
test('latestMessages returns the newest N in chronological order with a single desc page', async (t) => {
  const { api, messageReads } = await boot(t, { extraMessages: 30 });
  const all = await api.messages(SEED.session);
  const latest = await api.latestMessages(SEED.session, { limit: 5 });
  assert.deepEqual(latest.map((m) => m.id), all.slice(-5).map((m) => m.id));
  assert.equal(messageReads().at(-1).query.order, undefined, 'default V2 order (desc) on the single page');
  assert.equal(messageReads().at(-1).query.limit, '5');
});
```

```js
// tests/integration/session-actions.test.mjs
test('session show --limit N shows the newest N messages in chronological order', async (t) => {
  const { cwd, env } = await setup(t);
  const all = JSON.parse((await runCli(['session', 'show', SEED.session, '--limit', '200', '--json'], { env, cwd })).stdout).messages;
  const res = await runCli(['session', 'show', SEED.session, '--limit', '2', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).messages.map((m) => m.id), all.slice(-2).map((m) => m.id));
});

test('session fork re-applies the source rules and model when the fork comes back without them', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_FORK_DROPS_RULES: '1' } });
  const res = await runCli(['session', 'fork', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const forkId = JSON.parse(res.stdout).session.id;
  const state = readFakeState(env);
  assert.deepEqual(state.sessions[forkId].permissions, state.sessions[SEED.session].permissions);
  assert.deepEqual(state.sessions[forkId].model, state.sessions[SEED.session].model);
});
```

Confira se `messageReads()` expõe `query` como objeto de strings. O fake grava `requests` com `query`; caso contrário, adapte a leitura ao formato que o fake registra. Na rota `POST /api/session/:id/fork` de `tests/fixtures/f3-fake.mjs`, copie `permissions` e `model` da origem, como o V2 faz segundo `P3`. Com `process.env.FAKE_FORK_DROPS_RULES === '1'`, omita os dois. Para `GET /api/session/:id/message` sem `order`, o fake devolve a página em ordem `desc`, como o V2.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/unit/pagination-v2.test.mjs tests/integration/session-actions.test.mjs`
Expected: FAIL; `latestMessages` não existe e o show devolve as mais antigas.

- [ ] **Step 3: Implementar**

```js
// api.mjs — inside createApi, next to `messages`
  // The newest `limit` messages (one page in the V2 default desc order), returned oldest first.
  const latestMessages = async (id, { limit } = {}) => {
    const { data } = toPage(await client.get(`${sessionPath(id)}/message`, { ...LIST_BODY, query: { limit: pageLimit(limit) } }), 'GET /api/session/<id>/message');
    return [...data].reverse();
  };
  // …and export it in the returned object: latestMessages,
```

```js
// session-messages.mjs
export async function readSessionMessages(api, sessionID, { limit, latest = false } = {}) {
  if (latest && limit !== undefined && limit !== null) return api.latestMessages(sessionID, { limit: Math.min(limit, MAX_PAGE_LIMIT) });
  return api.messages(sessionID, limit === undefined || limit === null ? {} : { limit });
}
```

Importe `MAX_PAGE_LIMIT` de `./api.mjs`. Em `actionShow`: `readSessionMessages(api, sessionID, { limit: flags.limit, latest: true })`. Em `--limit` acima de 200, avise no texto (não no JSON): `Aviso: mostrando as 200 mensagens mais recentes (limite de página do OpenCode 2).`

```js
// session.mjs — actionFork
async function actionFork(ctx, api, { flags, sessionID }) {
  const messageID = flags.before ? assertId('msg', flags.before, 'mensagem') : undefined;
  const source = await api.getSession(sessionID);
  let forked = await api.fork(sessionID, { before: messageID });
  // Every opc session carries explicit rules and model; re-apply the source's when the fork lacks them.
  const sameRules = JSON.stringify(forked?.permissions ?? null) === JSON.stringify(source?.permissions ?? null);
  const sameModel = forked?.model?.id === source?.model?.id && forked?.model?.providerID === source?.model?.providerID;
  if (Array.isArray(source?.permissions) && source.permissions.length && !sameRules) await api.setPermissions(forked.id, source.permissions);
  if (source?.model?.id && source?.model?.providerID && !sameModel) await api.setModel(forked.id, { providerID: source.model.providerID, id: source.model.id });
  if (!sameRules || !sameModel) forked = await api.getSession(forked.id);
  // …render as before
```

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/pagination-v2.test.mjs tests/integration/session-actions.test.mjs tests/integration/f3-gate-sessions.test.mjs tests/unit/fake-f3.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/api.mjs plugins/opc/scripts/lib/session-messages.mjs plugins/opc/scripts/commands/session.mjs tests/fixtures/f3-fake.mjs tests/unit/pagination-v2.test.mjs tests/integration/session-actions.test.mjs
git commit -m "fix(session): show the newest messages and keep rules and model on forks"
```

---

### Task 8: `summarize` espera a compactação; avisos de revert

**Files:**
- Modify: `plugins/opc/scripts/commands/session.mjs` (`actionSummarize`, `actionRevert`)
- Modify: `plugins/opc/scripts/commands/task.mjs` (aviso de revert pendente no `--resume`)
- Modify: `tests/fixtures/f3-fake.mjs` (compactação assíncrona opcional)
- Test: `tests/integration/session-summarize.test.mjs`, `tests/integration/session-revert.test.mjs`

**Interfaces:**
- Consumes: os fatos `I1-compaction` e `I2-pending-revert` da Tarefa 1.
- Produces: `waitCompaction(api, sessionID, { timeoutMs, pollMs = 250 }) → Promise<boolean>`, exportada de `commands/session.mjs`. Devolve `true` quando a sessão não está em `/api/session/active` e `session.time.compacting` está vazio. Funciona com compactação síncrona ou assíncrona.
- Produces: o texto `PENDING_REVERT_NOTICE`, exportado de `commands/session.mjs`.

- [ ] **Step 1: Testes**

Na rota `POST /api/session/:id/compact` de `tests/fixtures/f3-fake.mjs`: com `process.env.FAKE_COMPACT_ASYNC_MS`, marque `session.time.compacting = Date.now()` e `fake.state.active[id] = { type: 'busy' }`. Depois de N ms, limpe os dois. Use o campo de status que o fake já usa para `/api/session/active`.

```js
// tests/integration/session-summarize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';

async function setup(t, extra = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions', extra });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  return { cwd, env };
}

test('summarize waits for an asynchronous compaction before reporting it done', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_COMPACT_ASYNC_MS: '600' });
  const started = Date.now();
  const res = await runCli(['session', 'summarize', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(Date.now() - started >= 500, 'returned before the compaction ended');
  assert.equal(JSON.parse(res.stdout).summarized, true);
});

test('summarize times out without claiming the session was summarized', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_COMPACT_ASYNC_MS: '60000' });
  const res = await runCli(['session', 'summarize', SEED.session, '--timeout', '1', '--json'], { env, cwd });
  assert.equal(res.code, 3);
  assert.match(res.stdout + res.stderr, /compactação continua no servidor/);
  assert.doesNotMatch(res.stdout, /"summarized":true/);
});
```

Confira o exit code de `TIMEOUT` em `plugins/opc/scripts/lib/opc-error.mjs` (`ExitCode`) e ajuste o `3` se for outro.

Em `tests/integration/session-revert.test.mjs`, acrescente:

```js
test('revert preview warns when snapshots cannot be confirmed (config unreadable)', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_CONFIG_FAILS: '1' } });
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /não foi possível confirmar se os snapshots estão ligados/);
});
```

No fake, `FAKE_CONFIG_FAILS=1` faz `GET /api/config` responder 500 depois do boot. Use um contador para deixar o boot e o `worldCheck` passarem; se o `worldCheck` bloquear a criação de sessões, o teste não cria sessões e continua válido.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/session-summarize.test.mjs tests/integration/session-revert.test.mjs`
Expected: FAIL nos três testes novos.

- [ ] **Step 3: Implementar**

```js
// session.mjs
export async function waitCompaction(api, sessionID, { timeoutMs, pollMs = 250 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const busy = Boolean((await api.sessionStatus())?.[sessionID]);
    const compacting = Boolean((await api.getSession(sessionID))?.time?.compacting);
    if (!busy && !compacting) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}
```

Em `actionSummarize`, depois de `api.compact(...)`:

```js
    const timeoutMs = (flags.timeout ?? DEFAULT_SUMMARIZE_TIMEOUT_SEC) * 1000;
    if (!(await waitCompaction(api, sessionID, { timeoutMs }))) {
      throw new OpcError('TIMEOUT', `A compactação da sessão ${safeOutputText(sessionID)} não terminou em ${timeoutMs / 1000} s; a compactação continua no servidor. Confira depois com opc session show.`, { exitCode: ExitCode.TIMEOUT });
    }
```

Use o mesmo `timeoutMs` no `api.compact`. Se `ExitCode.TIMEOUT` não existir, use o código que `opc-error.mjs` já atribui a timeouts.

No `actionRevert`, troque `snapshotsDisabled` por um estado com três valores:

```js
// 'disabled' | 'enabled' | 'unknown' (GET /api/config failed)
async function snapshotState(api) {
  const config = await loadOpencodeConfig(api);
  if (opencodeConfigUnavailable(config)) return 'unknown';
  return config.snapshot === false ? 'disabled' : 'enabled';
}
```

`disabled` continua lançando `SNAPSHOT_DISABLED`. `unknown` acrescenta à prévia a nota `Aviso: não foi possível confirmar se os snapshots estão ligados (GET /api/config falhou); a reversão pode não restaurar arquivos.` Use `REVERT_SCOPE_NOTICE + '\n' + essa nota` no campo `notice`. Importe `opencodeConfigUnavailable`. Ajuste os usos de `snapshotsDisabled` em `actionDiff` para `(await snapshotState(api)) === 'disabled'`.

Revert pendente, conforme `I2`:

```js
export const PENDING_REVERT_NOTICE = 'A sessão tem um revert pendente; um prompt novo o consolida e as mensagens revertidas deixam de poder voltar com unrevert.';
```

Esse é o texto para `I2 = consolidates`. Para `I2 = keeps-pending`, use `'A sessão tem um revert pendente; ele continua pendente depois deste prompt (unrevert segue disponível).'`. Para `I2 = clears`, use `'A sessão tem um revert pendente; um prompt novo o descarta e restaura as mensagens revertidas.'`.

Em `commands/task.mjs`, no caminho `--resume`, depois de carregar a sessão: `if (session.revert) warnings.push(PENDING_REVERT_NOTICE)`, usando o mecanismo de avisos que o comando já tem. Faça o mesmo em `actionSummarize`, antes do `compact`, com saída em stderr via `ctx.err`, se existir; senão, na saída de texto.

- [ ] **Step 4: Rodar**

Run: `node --test tests/integration/session-summarize.test.mjs tests/integration/session-revert.test.mjs tests/integration/session-actions.test.mjs tests/unit/pagination-v2.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/commands/session.mjs plugins/opc/scripts/commands/task.mjs tests/fixtures/f3-fake.mjs tests/integration/session-summarize.test.mjs tests/integration/session-revert.test.mjs
git commit -m "fix(session): wait for compaction and warn about pending reverts and unknown snapshots"
```

---

### Task 9: Linha de retomada do transfer com o binário configurado e a origem da senha

**Files:**
- Modify: `plugins/opc/scripts/commands/transfer.mjs:65`
- Modify: `plugins/opc/scripts/lib/render.mjs` (`renderTransfer`, linha de retomada)
- Test: `tests/integration/transfer.test.mjs:67,93`, `tests/unit/render-transfer.test.mjs`, `tests/unit/f6-review.test.mjs:34`

**Interfaces:**
- Consumes: `resolveOpencodeBin`, `attachSecretPath` (`lib/server.mjs`), `persistManagedAttachSecret` (`commands/attach.mjs`), `shellQuote`.
- Produces: `resumeCommand`, uma linha executável que não põe a senha em argv:
  - Gerenciado: `cd '<ws>' && OPENCODE_SERVER_PASSWORD="$(cat '<stateDir>/attach.secret')" '<bin>' --server '<url>' -s <id>`.
  - Attach (`OPC_SERVER_URL`): `cd '<ws>' && OPENCODE_SERVER_PASSWORD="$OPC_SERVER_PASSWORD" '<bin>' --server '<url>' -s <id>`.

- [ ] **Step 1: Atualizar os testes**

```js
// tests/integration/transfer.test.mjs:67
  const secret = path.join(stateDirFor(env, ws), 'attach.secret');
  assert.equal(r.data.resumeCommand, `cd ${shellQuote(ws)} && OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(secret)})" ${shellQuote(env.OPC_OPENCODE_BIN ?? 'opencode')} --server ${shellQuote(server.url)} -s ${r.data.sessionID}`);
  assert.equal(fs.readFileSync(secret, 'utf8'), server.password);
  assert.equal((fs.statSync(secret).mode & 0o777).toString(8), '600');
```

```js
// tests/integration/transfer.test.mjs:93 (attach mode with OPC_OPENCODE_BIN)
  assert.equal(result.data.resumeCommand, `cd ${shellQuote(ws)} && OPENCODE_SERVER_PASSWORD="$OPC_SERVER_PASSWORD" ${shellQuote(bin)} --server ${shellQuote(external.url)} -s ${result.data.sessionID}`);
```

O teste não pode encontrar a senha do servidor em `result.stdout`: acrescente `assert.doesNotMatch(r.stdout, new RegExp(server.password))`. Em `tests/unit/f6-review.test.mjs:34`, troque a regex por `/resumeCommand: `cd .*--server/`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/integration/transfer.test.mjs`
Expected: FAIL; o comando ainda é `opencode --server …`.

- [ ] **Step 3: Implementar**

```js
// commands/transfer.mjs
import { attachSecretPath, resolveOpencodeBin } from '../lib/server.mjs';
import { persistManagedAttachSecret } from './attach.mjs';
// …after the import succeeded, before building the result:
  const bin = shellQuote(resolveOpencodeBin({ env: ctx.env, config: ctx.config }));
  let passwordFrom;
  if (server.attached) passwordFrom = '"$OPC_SERVER_PASSWORD"';
  else {
    await persistManagedAttachSecret(ctx, server);
    passwordFrom = `"$(cat ${shellQuote(attachSecretPath(ctx.stateDir))})"`;
  }
  // …
    resumeCommand: `cd ${shellQuote(ctx.workspaceRoot)} && OPENCODE_SERVER_PASSWORD=${passwordFrom} ${bin} --server ${shellQuote(server.url)} -s ${imported.sessionID}`, // scan-secrets:allow (template, no secret)
```

Verifique se `transfer.mjs` tem acesso a `server` (o objeto de `openApi`/`ensureServer`) neste ponto; ele já usa `server.url`. Em `renderTransfer`, depois da linha do comando, acrescente: `'A linha lê a senha do servidor sem expô-la na linha de comando.'`

- [ ] **Step 4: Rodar**

Run: `node --test tests/integration/transfer.test.mjs tests/unit/render-transfer.test.mjs tests/unit/f6-review.test.mjs tests/integration/attach.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/commands/transfer.mjs plugins/opc/scripts/lib/render.mjs tests/integration/transfer.test.mjs tests/unit/render-transfer.test.mjs tests/unit/f6-review.test.mjs
git commit -m "fix(transfer): resume with the configured binary and a password source that stays out of argv"
```

---

### Task 10: Remover os ramos V1 de `StructuredOutputError`

**Files:**
- Modify: `plugins/opc/scripts/lib/errors.mjs:17,43-44`
- Modify: `plugins/opc/scripts/lib/orchestrator.mjs:502,517`
- Modify: `plugins/opc/scripts/lib/render.mjs:401,578-580,599`
- Modify: os testes que constroem `StructuredOutputError` sinteticamente: `tests/unit/errors.test.mjs:12-13`, `tests/unit/render-review.test.mjs:40-45,115-121`, `tests/unit/orchestrator-run.test.mjs:121,137-139`, `tests/unit/render-jobs.test.mjs:56`, `tests/unit/render-orchestration.test.mjs:56,65`, `tests/unit/render-conclave.test.mjs:68-70`, `tests/unit/conclave-run.test.mjs:68,79`, `tests/unit/conclave-review.test.mjs:153`

**Interfaces:**
- Produces: nenhum produtor de `StructuredOutputError` em `plugins/opc/scripts`. Os códigos `planner_structured_output` e `structured_output` saem. O planner sem plano válido cai em `planner_failed`; o turno, em `turn_failed`. A review sem JSON continua pelo caminho `status === 'completed'` sem `structured`.

- [ ] **Step 1: Provar que não há produtor**

Run: `grep -rn "StructuredOutputError" plugins/opc/scripts | grep -v "=== 'StructuredOutputError'\|StructuredOutputError:\|case 'StructuredOutputError'"`
Expected: saída vazia; só sobram comparações e o mapa de mensagens. Se aparecer um produtor, pare e devolva `ESCALAR`: o item deixa de ser código morto.

- [ ] **Step 2: Remover**

- `errors.mjs`: apague a entrada `StructuredOutputError` do mapa `fixed` e o `case 'StructuredOutputError'`. Um erro com esse nome passa ao `default` (`fatal`), o comportamento seguro.
- `orchestrator.mjs:502`: `const code = 'planner_failed';`.
- `orchestrator.mjs:517`: `st.errorCode = 'turn_failed';`.
- `render.mjs:401`: `lines.push('', 'Saída parcial:', '', r.finalText);`.
- `render.mjs:578-580`: apague o ramo `else if (result.errorType === 'StructuredOutputError' …)`.
- `render.mjs:599`: `if (result.status === 'completed') {`.

- [ ] **Step 3: Ajustar os testes**

- Testes que só existem para o ramo V1, como `renderReview degrades to raw text on StructuredOutputError` e `treats StructuredOutputError with structured approval as a failure`: apague-os. O caminho V2 equivalente já está coberto por `tests/integration/review.test.mjs:139`, `StructuredOutputError degrades to raw text and exits 7`. Renomeie esse teste para `a review reply without JSON degrades to raw text and exits 7`.
- Testes que usam o nome só como exemplo de erro (conclave, orchestrator-run:121, render-jobs, render-conclave): troque por `InvalidStructuredOutput` ou `MissingStructuredOutput`, que são os nomes V2 reais, e ajuste as mensagens esperadas.
- `orchestrator-run.test.mjs:137-139` e `render-orchestration.test.mjs:56,65`: o código esperado passa a ser `planner_failed`.
- `errors.test.mjs:12-13`: troque as duas linhas por `[{ name: 'StructuredOutputError', data: { message: 's' } }, { toolsRan: false }, 'fatal']`.

- [ ] **Step 4: Rodar**

Run: `node --test tests/unit/errors.test.mjs tests/unit/render-review.test.mjs tests/unit/orchestrator-run.test.mjs tests/unit/render-jobs.test.mjs tests/unit/render-orchestration.test.mjs tests/unit/render-conclave.test.mjs tests/unit/conclave-run.test.mjs tests/unit/conclave-review.test.mjs tests/integration/review.test.mjs tests/integration/orchestrate-acceptance.test.mjs`
Expected: PASS. Depois, `grep -rn "StructuredOutputError\|planner_structured_output" plugins/opc docs/*.md` deve dar vazio.

- [ ] **Step 5: Commit**

```bash
git add plugins/opc/scripts/lib/errors.mjs plugins/opc/scripts/lib/orchestrator.mjs plugins/opc/scripts/lib/render.mjs tests/unit tests/integration/review.test.mjs
git commit -m "refactor: drop OpenCode 1 StructuredOutputError branches"
```

---

### Task 11: Docs, CHANGELOG, relatório da F7 e portão

**Files:**
- Modify: `docs/commands.md` (show recentes, fork herda regras, summarize espera, aviso de revert pendente)
- Modify: `docs/troubleshooting.md` (`V1_SERVER_ACTIVE`, providers sem modelos no catálogo, `TIMEOUT` do summarize, retomada do transfer)
- Modify: `docs/configuration.md` (precedência das fontes de config, se a Tarefa 2 aplicou a Variante B)
- Modify: `plugins/opc/commands/session.md`, `plugins/opc/commands/transfer.md` (comportamento novo, quando citado)
- Modify: `CHANGELOG.md` (nova seção `### Corrigido — F7 (endurecimento V2)` sob `[Unreleased]`)
- Create: `docs/phases/F7-report.md`
- Modify: `docs/phases/F6-report.md` (cada A CONFIRMAR resolvido aponta para a F7)
- Test: `tests/unit/docs-f7.test.mjs`

**Interfaces:**
- Consumes: os fatos da Tarefa 1 e os comportamentos das Tarefas 2 a 10.

- [ ] **Step 1: Guarda de docs**

```js
// tests/unit/docs-f7.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('F7 report records every live fact and the gate rows', () => {
  const live = read('docs/phases/F7-live-output.md');
  for (const key of ['P1-precedence', 'P2-children-cursor', 'P3-fork', 'P4-model-updated', 'I1-compaction', 'I2-pending-revert']) assert.match(live, new RegExp(`\`${key}\``));
  assert.doesNotMatch(live, /omniroute-(?!personal)[a-z]/);
  const report = read('docs/phases/F7-report.md');
  assert.match(report, /\| Suíte completa \|.*\| PASSOU \|/);
  assert.match(report, /\| `npm run scan-secrets` \|.*\| PASSOU \|/);
});

test('docs describe the F7 behaviour', () => {
  assert.match(read('docs/commands.md'), /mais recentes/);
  assert.match(read('docs/troubleshooting.md'), /V1_SERVER_ACTIVE/);
  assert.match(read('CHANGELOG.md'), /### Corrigido — F7/);
  assert.doesNotMatch(read('docs/commands.md'), /StructuredOutputError/);
});
```

- [ ] **Step 2: Escrever as docs**

Uma linha por mudança no CHANGELOG, em PT-BR, no estilo das linhas da F6. `F7-report.md` segue o formato do `F6-report.md`, com as seções Portão, O que mudou e Pendências e achados, e cita a tabela de fatos de `F7-live-output.md`.

- [ ] **Step 3: Portão**

Run, sem nenhum teste ao vivo rodando em paralelo:
```bash
node scripts/run-tests.mjs
npm run scan-secrets
git diff --check
ps -eo ppid=,args= | awk '$1==1 && $3 ~ /tests\/fixtures\/bin\/opencode$/' | wc -l
```
Expected: 0 falhas; `scan-secrets: nenhum achado`; diff check vazio; 0 servidores falsos órfãos. Registre os números no `F7-report.md`. Rode também, ao vivo, `tests/live/f3-sessions.mjs` e `tests/live/f5-transfer.mjs` para confirmar show, fork e retomada contra o V2 real. A inferência nesses testes também exige **[PAUSA-APROVAÇÃO]**. Restaure os `F*-live-output.md` de outras fases.

- [ ] **Step 4: Commit**

```bash
git add docs CHANGELOG.md plugins/opc/commands tests/unit/docs-f7.test.mjs
git commit -m "docs: record F7 V2 hardening and live facts"
```

- [ ] **Step 5: Revisão final da branch inteira, PR e merge**

Revisor independente (Opus) sobre `git diff main...HEAD`, com veredito APROVADO ou REPROVADO. Com APROVADO: push, PR em PT-BR sem atribuição, CI por `mcp__ccd_pr__get_status` e merge depois do CI verde, informando o operador.
