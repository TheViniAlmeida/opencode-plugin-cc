# F11 — Correções da revisão dupla do opc · plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 23 achados das duas revisões independentes da `main` em `e873fa0`, feitas depois da F10:

- Codex `gpt-6.1-sol` · high: 10 achados.
- Claude Sonnet 5.5: 13 achados.

Cada achado foi conferido no código pelo orquestrador antes de entrar aqui.

**Architecture:**
- **Agrupamento:** as correções vão por superfície, não por revisor. O mesmo arquivo nunca aparece em duas tarefas que mudam a mesma função.
- **Ordem:** primeiro o que decide segurança, isto é, a ordem das regras de permissão e o classificador de comando destrutivo. Depois vêm as barreiras de vazamento, o ciclo de vida de turnos e servidor, o MCP e os contratos menores.
- **Testes:** cada tarefa abre com os testes que reproduzem o achado e falham hoje.
- **Fechamento:** a fase termina com docs, CHANGELOG, relatório e portão, como nas F6 a F10.

**Tech Stack:** Node ≥ 20, ESM, `node:test`, sem dependências de runtime. OpenCode ≥ 2.0.22.

**Spec:**
- Spec de base: [`docs/superpowers/specs/2026-09-25-opc-plugin-design.md`](../specs/2026-09-25-opc-plugin-design.md).
- Contratos já documentados: [`docs/permissions.md`](../../permissions.md), em que vence a última regra que casa, e [`docs/configuration.md`](../../configuration.md), com as chaves travadas e o merge de workspace.
- Achados: a seção "Origem de cada tarefa" abaixo. Os relatórios brutos não ficam no repo; o resumo de cada achado, com o local, está na tabela.
- Onde um achado pede uma decisão de produto, ela está em "Decisões", com o custo caso esteja errada.

## Origem de cada tarefa

Prefixo `X-` = relatório Codex; `S-` = relatório Sonnet. "Conferido" = o orquestrador leu o
trecho citado e o defeito se sustenta.

| # | Achado | Sev. | Local principal | Conferido | Tarefa |
|---|---|---|---|---|---|
| 1 | X-SEC-3 — `policy.tools.deny` vem antes dos `shell … ask` destrutivos; carrier do subagente adiciona `allow` depois das invariantes | Alta | `lib/policy.mjs:166-167`, `lib/runner.mjs:485` | sim | 1 |
| 2 | X-SEC-5 — agente implícito `build` escapa de `policy.agents` | Alta | `commands/task.mjs:224`, `lib/runner.mjs:151` | sim | 1 |
| 3 | X-SEC-4 / S-SEC-2 — opções globais e ordem de argumentos do git (`git -C x reset --hard`, `git push origin main --force`, `git clean -df`) escapam do classificador | Alta | `lib/policy.mjs:108-115`, `405-466` | sim | 2 |
| 4 | S-SEC-1 — `requiresUser` só olha `metadata.command ?? patterns[0]` | Média | `lib/policy.mjs:197-200` | sim | 2 |
| 5 | S-SEC-2 (c, d) — `shell` que lê caminho sensível (`cat .env`) e `webfetch`/`websearch` não exigem o usuário com aprovador `claude` | Média | `lib/policy.mjs:193-206` | sim | 2 |
| 6 | S-LOG-1 — `**/id_rsa*` não casa `id_rsa` na raiz; defaults não cobrem `.npmrc`, `.git-credentials`, `.netrc`, `.aws/credentials`, `kubeconfig` | Baixa | `lib/models.mjs:7-10`, `lib/policy.mjs:118`, `lib/config.mjs:55` | sim | 2 |
| 7 | X-SEC-2 — `assertCanCreateSessions` nunca é chamada: `share: "auto"` ou config ilegível não bloqueiam a criação de sessões; checagem de mundo sem `x-opencode-directory` | Alta | `lib/server.mjs:266`, `383`, `566`, `576`; `lib/context.mjs:120` | sim | 3 |
| 8 | X-SEC-1 — `conclave --mode review` coleta contexto sem `excludeGlobs` | Alta | `commands/conclave.mjs:127` | sim | 4 |
| 9 | X-SEC-6 — corpo de erro HTTP vai para `--json` só com `redact` (mascara por chave, não por padrão em texto livre) | Alta | `lib/http.mjs:110`, `opc-companion.mjs:98` | sim | 4 |
| 10 | S-SEC-4 — `transfer` envia o histórico sem `maskSecretPatterns` (só o título é mascarado) | Média | `lib/transfer.mjs:173-293` | sim | 4 |
| 11 | S (NÃO VALIDADO) — cliente HTTP segue redirecionamento com `Authorization` | — | `lib/http.mjs` (sem `redirect`) | A CONFIRMAR | 4 |
| 12 | X-OPS-1 — no timeout, falha de `interrupt` é engolida e o `waitIdle` é descartado: fallback roda com a sessão anterior ainda ocupada | Alta | `lib/runner.mjs:387-390` | sim | 5 |
| 13 | X-LOG-1 — subagente envia o prompt depois de cancelado (`dispatchSubagent` sem `isCancelled`/`signal`) | Alta | `commands/subagent.mjs:169-171`, `lib/runner.mjs:469-476` | sim | 5 |
| 14 | S-OPS-1 — `ensureServer` mata o servidor "travado" (health > 2 s) sem checar jobs ativos | Alta | `lib/server.mjs:584-586` | sim | 6 |
| 15 | S-OPS-2 — um `jobs/*.json` corrompido derruba `listJobs`/`createJob`/`status`/`gc` | Média | `lib/jobs.mjs:192-210` | sim | 6 |
| 16 | S-OPS-3 — `gc` usa `serverMatcher(port)` sem o binário configurado | Baixa | `commands/gc.mjs:74-77` | sim | 6 |
| 17 | S-MCP-1 — `maskInputEcho` monta uma `RegExp` com o prompt inteiro: > ~150 KB lança depois do dispatch; mascara trechos de 1 caractere | Média | `lib/mcp-tools.mjs:489-501`, `538-540` | sim | 7 |
| 18 | X-CON-1 — `opc_permissions_answer` exige `que…`; o V2 usa `frm_…` | Média | `lib/mcp-tools.mjs:389` | sim | 7 |
| 19 | S-SEC-5 — ferramentas MCP aceitam `cwd` absoluto arbitrário | Média | `lib/mcp-tools.mjs:516-519` | sim | 7 |
| 20 | X-CON-2 — `opc result` de revisão sem JSON válido sai 0; o foreground sai 7 | Média | `commands/result.mjs:36-39`, `commands/review.mjs:76-78` | sim | 8 |
| 21 | S-LOG-2 — `subagent --prompt-file` ignora `--cwd` | Baixa | `commands/subagent.mjs:66` | sim | 8 |
| 22 | S-QA-1 — `mergeDeep` aceita `__proto__` vindo do `.opc.json` | Baixa | `lib/config.mjs:251-256` | sim | 8 |
| 23 | S-SEC-6 — `.opc.json` amplia limites numéricos (`maxAttempts`, `rounds`, `maxSubtasks`…) | Baixa | `lib/config.mjs:130`, `288-298` | sim | 8 |
| 24 | S-SEC-3 — `--tty-confirm` é atravessado por um agente que aloca pty (`script -qec`) | Média | `commands/config.mjs:73-89` | sim | 9 |

Achados que **não** viram código (ver "Decisões"): `confirmedByUser` declarado pelo próprio
modelo (S-SEC-5, segunda metade) e a troca da lista de negação por uma allowlist de comandos
(S-SEC-2 a).

## Decisões

Cada decisão segue o formato `Decisão — por quê — custo se estiver errada`. O operador pode
reverter qualquer uma antes da execução.

1. **Ordem final das regras.** A ordem passa a ser:
   1. perfil;
   2. `allow` extras do chamador, como o carrier do subagente;
   3. invariantes, nesta ordem:
      - `external_directory deny`;
      - `grep deny` (só leitura);
      - `shell <destrutivo> ask`;
      - `read/grep/glob <sensível> deny`;
      - `subagent <agente negado> deny`;
      - `<policy.tools.deny> * deny`;
      - `browser deny`.

   Por quê: vence a última regra que casa, e uma negação explícita do operador nunca pode ser rebaixada para `ask` ou `allow`.

   Custo se errado: um perfil customizado que contava com o `ask` destrutivo depois de um `deny` de ferramenta passa a ver `deny`, o que é mais restritivo. Aceitável.
2. **Carrier com `subagent` negado.** Se `policy.tools.deny` contém `subagent`, ou se o agente casa com `policy.agents.deny`, o mecanismo `subagent-tool` é recusado com `PolicyError('SUBAGENT_DENIED')` antes de criar a sessão. Não há queda silenciosa para `child-session`.

   Por quê: o operador negou a ferramenta.

   Custo se errado: o usuário precisa escolher `--mechanism child-session` explicitamente.
3. **Classificador continua sendo lista de negação**, agora normalizada. A allowlist de comandos somente leitura sugerida em S-SEC-2 (a) fica de fora.

   Por quê: com `approver = claude`, que é opt-in, uma allowlist tornaria o modo inútil, e a normalização fecha os bypasses demonstrados.

   Custo se errado: um padrão destrutivo novo e não listado passa sem o usuário. A mitigação é `policy.destructiveBash`.
4. **Com aprovador `claude`, também exigem o usuário:**
   - `webfetch` e `websearch`;
   - qualquer permissão desconhecida (falha fechada);
   - `shell` cujo argumento casa com `sensitivePaths`.

   As permissões conhecidas e seguras são `read`, `glob`, `grep`, `list`, `edit`, `skill`, `question`, `todowrite`, `task` e `shell` não destrutivo, sempre fora de caminho sensível.

   Por quê: é o canal de exfiltração por prompt injection.

   Custo se errado: mais perguntas ao usuário no modo `claude`.
5. **Glob `**/` aceita zero diretórios.** `globToRegExp` passa a traduzir `**/` como `(?:.*/)?`, e `*` continua casando `/`, como hoje.

   Por quê: `id_rsa` na raiz precisa casar.

   Custo se errado: nenhum caminho que casava deixa de casar; só passam a casar mais caminhos.
6. **Bloqueio de share no ponto único de criação.** Um wrapper `guardSessionCreation(api, server)` faz `createSession` e `fork` lançarem `SHARE_AUTO`. Ele é aplicado em todo lugar que monta a API a partir de `ensureServer`: `connectApi`, `withServer` em `context.mjs`, `task-worker`, e `transfer` antes do import.

   Por quê: não depende de lembrar de chamar a guarda em cada comando.

   Custo se errado: um comando só de leitura que usa `fork` passa a falhar com share auto, o que é o desejado.
7. **Timeout com interrupção não confirmada vira `AbortUnconfirmed` fatal.** O fallback é bloqueado e `toolsRan` permanece o que se observou.

   Por quê: rodar o próximo candidato com o anterior ainda ativo duplica efeitos.

   Custo se errado: rotas com servidor lento perdem o fallback nesse caso específico. O usuário vê `ABORT_UNCONFIRMED` e pode tentar de novo.
8. **Servidor "travado" com jobs ativos não é derrubado.** O opc refaz o health até 3 vezes com timeout de 5 s. Se continuar sem resposta, lança `ConnectionError('SERVER_UNRESPONSIVE')`, que orienta `/opc:status`, `/opc:cancel` ou `opc setup --stop-server --force`.

   Por quê: matar o servidor derruba edições em curso.

   Custo se errado: com o servidor realmente morto e um job "ativo" zumbi, o usuário precisa cancelar. O reaper e o `reconcile` já tratam workers perdidos.
9. **`cwd` das ferramentas MCP fica restrito** ao `defaultCwd` do servidor MCP, que é o projeto do Claude Code, ou a um descendente dele, comparados por `realpath`. Não há opt-in novo.

   Por quê: o MCP é a superfície que o modelo dirige, e outro repo pode ser alcançado pela CLI no terminal.

   Custo se errado: quem usava `cwd` de outro repo pelo MCP passa a receber `INVALID_CWD` e usa a CLI.
10. **`confirmedByUser` no MCP continua declarativo.** Nenhum código consegue provar que um humano respondeu dentro do processo MCP. A barreira real é o prompt de permissão do Claude Code para a ferramenta (`destructiveHint`). Só a doc muda (Tarefa 10).

    Custo se errado: nenhum além do atual.
11. **Barreira TTY.** `--tty-confirm` passa a recusar quando algum ancestral do processo é o Claude Code (`claude` no `argv0` ou no `cmdline`), usando o `getParentPid` da F8, e quando `CLAUDECODE` está no env. A doc deixa de chamar isso de prova de humano: é uma barreira de conveniência que um processo com `setsid -f` ainda atravessa.

    Por quê: fecha o caso demonstrado (`script -qec` filho do Bash do Claude) sem prometer o impossível.

    Custo se errado: quem roda `opc config set … --tty-confirm` num terminal aberto *dentro* do Claude Code (`!` no prompt) é recusado e precisa usar um terminal próprio.
12. **Limites numéricos do workspace são só de aperto.** São eles: `routing.fallback.maxAttempts`, `routing.fallback.maxProviderRetries`, `routing.fallback.maxRetryWaitSec`, `conclave.rounds`, `conclave.memberTimeoutSec` e `orchestrate.maxSubtasks`. O valor efetivo é `min(global ou default, workspace)`; o que é ignorado gera um aviso com o mesmo texto da F9 ("o workspace só pode apertar"). As listas de modelos do workspace continuam passando pela política (`allow`/`deny`), como hoje.

    Custo se errado: um repo que queria mais rodadas precisa que o operador suba o valor no global.
13. **`transfer` mascara padrões de segredo em todo o texto exportado**: usuário, assistente, `tool_use` e `tool_result`. A saída informa quantos trechos foram mascarados. Não há flag para desligar (YAGNI).

    Custo se errado: um trecho que parece segredo, mas não é, chega mascarado ao OpenCode.
14. **O cliente HTTP usa `redirect: 'error'`.** A API do OpenCode V2 não redireciona, e um redirecionamento é tratado como erro de conexão (`UNEXPECTED_REDIRECT`).

    Por quê: elimina a dúvida sobre `Authorization` entre origens sem depender do comportamento do `fetch`.

    Custo se errado: um proxy reverso que redireciona `http`→`https` deixa de funcionar e passa a exigir a URL final na config.

## Global Constraints

- OpenCode mínimo: `MIN_OPENCODE_VERSION = '2.0.22'`; só rotas `/api/*`.
- Sem dependências novas, nem de runtime nem de dev.
- Prosa de docs, mensagens de usuário e relatórios em português brasileiro; código, identificadores e comentários em inglês.
- Repo público: nada de caminho pessoal, e-mail, senha, token ou ID real de provider; provider pessoal só como `omniroute-personal`. Valide com `npm run scan-secrets`.
- Toda sessão criada pelo opc nasce com `permissions` e `model` explícitos (`UNSAFE_SESSION` continua valendo).
- Nenhuma tarefa sobe servidor OpenCode real; os testes usam os fakes existentes (`tests/helpers.mjs`, `tests/f2b-helpers.mjs`, `tests/fixtures/`). Testes ao vivo ficam fora desta fase.
- Nunca tocar nos serves do operador (portas 13371–13375 e 34975) nem em `~/.config/opencode/`.
- Commits: Conventional Commits, sem trailer de co-autoria ou atribuição. Uma branch `feat/f11-review-fixes` a partir da `main`.
- Validação de cada tarefa: `node --test <arquivos da tarefa>` e `git diff --check`. No fim: `node scripts/run-tests.mjs` (0 falhas), `npm run scan-secrets` e 0 processos órfãos.

## Review Focus

1. **Perfil `write` com `policy.tools.deny: ["shell"]`:** nenhum comando de shell, destrutivo ou não, pode terminar em `ask` ou `allow`. O teste está na Tarefa 1.
2. **Comando composto com aprovador `claude`:** `echo ok && git -C . push origin main --force` em um único `metadata.command`, e o mesmo comando dividido em dois `patterns`. Os dois exigem o usuário (teste na Tarefa 2).
3. **Servidor lento, não morto, com job `--write` em curso:** outro `opc task` no mesmo workspace não pode derrubar o servidor. Ele espera e, se o servidor não responder, falha com erro explícito (teste na Tarefa 6).
4. **Cancelamento durante `createSession` de um membro de subagente:** nenhum `prompt` é enviado à sessão criada, e ela é interrompida (teste na Tarefa 5).
5. **Prompt MCP de 300 KB:** o envelope volta `ok` com o `jobId`, sem `-32603` (teste na Tarefa 7).

---

### Task 1: Ordem das regras de permissão e agente implícito

**Files:**
- Modify: `plugins/opc/scripts/lib/policy.mjs:157-187` (`invariantRules`, `buildPermissionRules`)
- Modify: `plugins/opc/scripts/lib/runner.mjs:466-490` (`dispatchSubagent` / `viaSubagentTool`)
- Modify: `plugins/opc/scripts/commands/task.mjs:224-226`, `plugins/opc/scripts/lib/routing.mjs:186-196` (`validateSelection`)
- Modify: demais criadores de sessão com agente implícito: `commands/command.mjs:123`, `commands/subagent.mjs:147`, `commands/session.mjs:51` (conferir cada um)
- Test: `tests/unit/policy-v2.test.mjs`, `tests/unit/runner-subagent.test.mjs`, `tests/unit/f2a-gate-jobs.test.mjs` (ou o teste de seleção existente)

**Interfaces:**
- Produces: `buildPermissionRules(profile, { policy, permissionProfiles, deniedAgentGlobs, extraAllow = [] })` — `extraAllow` entra entre as regras do perfil e as invariantes.
- Produces: `DEFAULT_AGENT = 'build'` exportado de `lib/runner.mjs`; `validateSelection` passa a validar `agentName ?? DEFAULT_AGENT`.
- Produces: `PolicyError('SUBAGENT_DENIED')` em `dispatchSubagent` quando o mecanismo é `subagent-tool` e a política nega.

- [ ] **Step 1: Testes que falham**

```js
// tests/unit/policy-v2.test.mjs
import { globToRegExp } from '../../plugins/opc/scripts/lib/models.mjs';
// Avaliador "última regra vence" (docs/permissions.md).
const lastMatch = (rules, action, resource) => rules.filter((r) => (r.action === '*' || r.action === action)
  && globToRegExp(r.resource).test(resource)).at(-1)?.effect;

test('tools.deny shell beats destructive ask (write profile)', () => {
  const rules = buildPermissionRules('write', { policy: { tools: { deny: ['shell'] } } });
  assert.equal(lastMatch(rules, 'shell', 'rm -rf x'), 'deny');
  assert.equal(lastMatch(rules, 'shell', 'ls'), 'deny');
});

test('extraAllow sits before invariants', () => {
  const rules = buildPermissionRules('write', { policy: { tools: { deny: ['subagent'] } }, extraAllow: [{ action: 'subagent', resource: 'general', effect: 'allow' }] });
  assert.equal(lastMatch(rules, 'subagent', 'general'), 'deny');
});
```

```js
// tests/unit/runner-subagent.test.mjs
test('subagent-tool is refused when the policy denies the subagent tool', async () => {
  await assert.rejects(dispatchSubagent({ /* fake api do arquivo */ mechanism: 'subagent-tool', policy: { tools: { deny: ['subagent'] } }, member: { agent: 'general', title: 't', full: 'p/m' } /* … */ }),
    (err) => err.code === 'SUBAGENT_DENIED');
});
```

```js
// seleção: build implícito negado
test('implicit build agent is checked against policy.agents', () => {
  assert.throws(() => validateSelection({ candidate: { full: 'p/m' }, agentName: null, agents: [{ name: 'build', mode: 'primary' }], catalog: { byFull: new Map() }, policy: { agents: { deny: ['build'] } } }),
    (err) => err.code === 'AGENT_DENIED' || err.name === 'PolicyError');
});
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test tests/unit/policy-v2.test.mjs tests/unit/runner-subagent.test.mjs`.

- [ ] **Step 3: Implementação**
  - `invariantRules`: reordenar para `external_directory`, `grep` (não-write), `shell <destrutivo> ask`, `read/grep/glob <sensível> deny`, `subagent <glob> deny`, `<tools.deny> * deny`, `browser deny` (Decisão 1).
  - `buildPermissionRules`: aceitar `extraAllow` e montar `[...perfil, ...extraAllow, ...invariantes]`.
  - `dispatchSubagent`: receber `policy`; se `mechanism === 'subagent-tool'` e (`policy.tools?.deny` inclui `subagent` ou `matchesAny(member.agent, policy.agents?.deny ?? [])`), lançar `PolicyError('SUBAGENT_DENIED', …)` antes de `createSession`. O carrier passa a criar a sessão com `buildPermissionRules(..., { extraAllow: [carrierAllow] })` em vez de anexar ao fim — se o chamador só tem `rules` prontas, recebe também `ruleInputs` (perfil + opções) para remontar.
  - `validateSelection`: `const effective = agentName ?? DEFAULT_AGENT;` carregar `agents` sempre (remover o atalho `agentName ? await api.agents() : []` em `task.mjs:225`) e chamar `assertAgentUsable`. Se `build` não existir no servidor, manter o comportamento atual (sem `UNKNOWN_AGENT` para o implícito).
  - Repetir a checagem nos outros criadores listados que usam o agente implícito.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/policy*.test.mjs tests/unit/runner*.test.mjs tests/integration/f2a-profiles.test.mjs tests/integration/subagent.test.mjs`.

- [ ] **Step 5: Commit** — `fix(policy): explicit tool denies win over destructive asks and carrier allows; check the implicit build agent`.

---

### Task 2: Classificador de comando destrutivo e `requiresUser`

**Files:**
- Modify: `plugins/opc/scripts/lib/policy.mjs:108-119`, `193-206`, `405-466` (`bashRequiresUser` / `inspectWords`)
- Modify: `plugins/opc/scripts/lib/models.mjs:7-10` (`globToRegExp`)
- Modify: `plugins/opc/scripts/lib/config.mjs:55` (default de `policy.sensitivePaths`, mesmo conjunto de `DEFAULT_SENSITIVE_PATHS`)
- Test: `tests/unit/policy-v2.test.mjs`, `tests/unit/policy.test.mjs`, `tests/unit/config.test.mjs`

**Interfaces:**
- Produces: `normalizeGitWords(words) → words | null` (interno). Remove as opções globais conhecidas do git: `-C <v>`, `-c <v>`, `--git-dir[=v]`, `--work-tree[=v]`, `--namespace[=v]`, `--no-pager`, `-p`, `--paginate`, `--bare`, `--no-replace-objects`, `--literal-pathspecs` e `--exec-path[=v]`. Devolve `null` para opção global não reconhecida, e quem chama então exige o usuário.
- Produces: `DEFAULT_SENSITIVE_PATHS` ampliado: `'**/.npmrc', '**/.netrc', '**/.git-credentials', '**/.aws/credentials', '**/kubeconfig', '**/.kube/config'`, além dos atuais.

- [ ] **Step 1: Testes que falham**

```js
const claude = (command, policy = {}) => requiresUser({ permission: 'shell', patterns: [command], metadata: { command } }, policy);

test('git global options and argument order do not hide destructive subcommands', () => {
  for (const command of [
    'git -C /repo reset --hard', 'git -c core.hooksPath=/dev/null push --force', 'git --no-pager reset --hard HEAD~3',
    'git push origin main --force', 'git push origin +main', 'git push origin :feature', 'git push --force-with-lease',
    'git clean -df', 'git clean -xdf', 'git branch --delete --force x', 'git --git-dir=.git reset --hard',
    'git --weird-global reset --soft',  // opção global desconhecida → falha fechada
  ]) assert.equal(claude(command), true, command);
  for (const command of ['git status', 'git -C /repo log --oneline', 'git push origin main', 'git clean -n']) assert.equal(claude(command), false, command);
});

test('every shell resource is inspected', () => {
  assert.equal(requiresUser({ permission: 'shell', patterns: ['echo ok', 'rm -rf /x'], metadata: { command: 'echo ok' } }), true);
  assert.equal(claude('echo ok && git -C . push origin main --force'), true);
});

test('shell reading a sensitive path, webfetch and unknown permissions need the user', () => {
  assert.equal(claude('cat .env'), true);
  assert.equal(claude('cat src/app.js'), false);
  assert.equal(requiresUser({ permission: 'webfetch', patterns: ['https://x'] }), true);
  assert.equal(requiresUser({ permission: 'websearch', patterns: ['q'] }), true);
  assert.equal(requiresUser({ permission: 'something-new', patterns: ['*'] }), true);
  assert.equal(requiresUser({ permission: 'todowrite', patterns: ['*'] }), false);
});

test('**/ matches zero directories and the new defaults', () => {
  for (const p of ['id_rsa', 'a/id_rsa', '/abs/id_ed25519', '.npmrc', 'home/.git-credentials', '.aws/credentials'])
    assert.equal(requiresUser({ permission: 'read', patterns: [p] }), true, p);
  assert.equal(matchesAny('id_rsa', ['**/id_rsa*']), true);
  assert.equal(matchesAny('src/main.js', ['**/id_rsa*']), false);
});

test('checkReply refuses claude approval for the bypasses', () => {
  const request = { permission: 'shell', patterns: ['git -C /w reset --hard'], metadata: { command: 'git -C /w reset --hard' } };
  assert.equal(checkReply({ approver: 'claude', request, reply: 'once' }).code, 'NEEDS_USER');
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação**
  - `requiresUser` (`shell`): `commands = unique([metadata.command, ...patterns])` filtrando strings; `some(bashRequiresUser)`. Depois, `shellTouchesSensitive(command, sensitivePathsOf(policy))`: tokenizar com o mesmo `words` de `inspectWords` e testar cada palavra não-opção (e o `basename`) contra os globs.
  - `requiresUser` (demais): conjunto `USER_FREE_PERMISSIONS = ['read','glob','grep','list','edit','skill','question','todowrite','task']`; `read/grep/glob/list/edit` continuam checando caminho sensível; qualquer permissão fora do conjunto → `true` (Decisão 4).
  - `inspectWords`, ramo git: quando `executable === 'git'`, aplicar `normalizeGitWords` (null → `return true`). Depois da normalização, classificar o subcomando:
    - `push`: destrutivo se algum argumento for `--force`, `-f`, `--force-with-lease*`, `--delete`, `-d`, `--mirror`, `--prune`, ou uma refspec que comece com `+` ou `:`.
    - `reset`: destrutivo com `--hard`, `--merge` ou `--keep`.
    - `clean`: destrutivo com `-f*`, `-d*` combinado com `-f`, `-x*` ou `--force`. `-n` ou `--dry-run` sozinhos não contam.
    - `branch`: destrutivo com `-D`, ou com `--delete` junto de `--force`/`-f`.
    - `tag`: destrutivo com `-d` ou `--delete`.
    - `checkout` e `restore`: destrutivos com `--` seguido de caminho, ou com `.`.
    - `stash`: destrutivo com `drop` ou `clear`.
    - `filter-branch` e `update-ref -d`: sempre destrutivos.
    - Por fim, casar `['git', subcomando, ...resto]` normalizado contra `destructiveBashOf(policy)`, para que os padrões do usuário (`policy.destructiveBash`) também enxerguem a forma normalizada.
  - `globToRegExp`: trocar `**/` por um marcador antes do split e emitir `(?:.*/)?` (Decisão 5).
  - `DEFAULT_SENSITIVE_PATHS` e o default em `config.mjs:55`: o mesmo conjunto ampliado (fonte única: `config.mjs` importa de `policy.mjs`, ou vice-versa, sem duplicar a lista).
  - Regras de sessão (`shell <destrutivo> ask`) que vão ao servidor continuam por padrão de prefixo — o servidor não normaliza. Documentar na Tarefa 10 que a garantia forte com aprovador `claude` vem de `checkReply`; com aprovador `user`, todo pedido já chega ao usuário.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/policy*.test.mjs tests/unit/config*.test.mjs tests/integration/f2a-permissions.test.mjs tests/integration/mcp-permissions.test.mjs`.

- [ ] **Step 5: Commit** — `fix(policy): normalize git global options and inspect every shell resource before auto-approval`.

---

### Task 3: Bloqueio de share na criação de sessões

**Files:**
- Modify: `plugins/opc/scripts/lib/server.mjs:231-273` (`worldCheck`, `assertCanCreateSessions`), `:383`, `:566`, `:576` (clientes da checagem de mundo sem `directory`)
- Modify: `plugins/opc/scripts/lib/context.mjs:120-128` (`connectApi`), `:175-190` (helper com `ensureServer`)
- Modify: `plugins/opc/scripts/commands/task-worker.mjs:167+`, `plugins/opc/scripts/commands/transfer.mjs:52`
- Test: `tests/integration/server-boot.test.mjs`, `tests/integration/setup-gate.test.mjs` (ou novo `tests/integration/share-guard.test.mjs`)

**Interfaces:**
- Produces: `guardSessionCreation(api, server) → api` exportado de `lib/server.mjs`. Devolve um objeto com os mesmos métodos; `createSession` e `fork` chamam `assertCanCreateSessions(server)` antes de delegar.

- [ ] **Step 1: Testes que falham**

```js
// tests/integration/share-guard.test.mjs — fake V2 de tests/helpers.mjs com GET /api/config = [{ type: 'document', info: { share: 'auto' } }]
test('task refuses to create a session when the server has share auto', async () => {
  const { code, stderr, calls } = await runCli(['task', '--model', 'p/m', 'oi'], { fakeConfig: { share: 'auto' } });
  assert.equal(code, ExitCode.POLICY);         // código do PolicyError
  assert.match(stderr, /share "auto"/);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/api/session').length, 0);
});
test('unreadable config also blocks creation (config-unavailable)', async () => { /* GET /api/config → 500 */ });
test('read-only commands still work with share auto', async () => { /* opc models → exit 0 */ });
test('worldCheck sends x-opencode-directory in attach and reuse', async () => { /* assert header na chamada GET /api/config */ });
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação**
  - `guardSessionCreation` em `server.mjs`, junto da guarda.
  - Aplicar em todos os pontos que transformam o retorno de `ensureServer` em API: `connectApi`, o helper de `context.mjs:180-188`, `task-worker` (via `makeApi`) e `transfer` (chamar `assertCanCreateSessions(server)` antes do `opencode import`).
  - `existingServerApi` (`jobs.mjs:468`) é usado só para cancelar e responder permissões, e não cria sessões, então fica sem a guarda. Registrar isso num comentário de uma linha.
  - `worldCheck`: os três clientes (attach `:383`, reuse `:566`/`:576`) passam a usar o `directory` resolvido por `serverDirectory(...)`, o mesmo das operações.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/integration/server-*.test.mjs tests/integration/setup*.test.mjs tests/integration/f2a-task.test.mjs tests/integration/transfer.test.mjs tests/integration/remote-attach.test.mjs`.

- [ ] **Step 5: Commit** — `fix(server): enforce the share guard on every session-creating path`.

---

### Task 4: Barreiras de vazamento (conclave, erros HTTP, transfer, redirect)

**Files:**
- Modify: `plugins/opc/scripts/commands/conclave.mjs:127`
- Modify: `plugins/opc/scripts/lib/http.mjs:~60-115` (fetch options; `details.body`)
- Modify: `plugins/opc/scripts/opc-companion.mjs:96-99` (serialização de erro `--json`)
- Modify: `plugins/opc/scripts/lib/transfer.mjs:173-266` (`convertClaudeRecords`), `commands/transfer.mjs` (aviso de contagem)
- Test: `tests/unit/conclave-review.test.mjs`, `tests/unit/redact.test.mjs`, `tests/integration/cli.test.mjs`, `tests/unit/transfer.test.mjs`

**Interfaces:**
- Consumes: `redactOutput`, `safeOutputText`, `maskSecretPatterns` de `lib/redact.mjs`.
- Produces: `convertClaudeRecords(...)` passa a devolver também `maskedCount`.

- [ ] **Step 1: Testes que falham**

```js
// conclave: o collectReview recebe os globs sensíveis
test('conclave review collects context without sensitive files', async () => {
  let seen;
  // injetar collectReviewContext via deps (adicionar o seam se não existir) e capturar o 3º argumento
  assert.deepEqual(seen.excludeGlobs, config.policy.sensitivePaths);
});

// HTTP: credencial sintética em campo textual não sensível
test('--json error output masks secret patterns in free text', async () => {
  const fake = 'sk-' + 'A'.repeat(40);
  const { stdout } = await runMain(['models', '--json'], { fetchImpl: async () => new Response(JSON.stringify({ message: `bad key ${fake}` }), { status: 500, headers: { 'content-type': 'application/json' } }) });
  assert.doesNotMatch(stdout, new RegExp(fake));
});

test('http client refuses redirects', async () => {
  await assert.rejects(client.get('/api/info'), (e) => e.code === 'UNEXPECTED_REDIRECT'); // fetchImpl devolve 302
});

// transfer
test('transfer masks secrets in every exported text block', () => {
  const out = convertClaudeRecords([/* user msg com 'Bearer abc…', tool_result com 'sk-…' */]);
  assert.doesNotMatch(JSON.stringify(out), /sk-A{20}|Bearer abc/);
  assert.ok(out.maskedCount >= 2);
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação**
  - `conclave.mjs:127`: `collectReviewContext(request.reviewCwd ?? ctx.cwd, request.target, { excludeGlobs: ctx.config?.policy?.sensitivePaths ?? [] })`. Se a revisão comum tiver mais alguma proteção de entrada em `collectReviewPrompt` (`review.mjs:48`), reutilizá-la em vez de duplicar.
  - `http.mjs`: `details = { status, body: redactOutput(parsed) }`; `fetch(..., { redirect: 'manual' })` e status 3xx → `ConnectionError('UNEXPECTED_REDIRECT', '<label>: o servidor respondeu com redirecionamento; configure a URL final.')`. Usar `manual` porque `error` vira `TypeError` genérico e perde o status.
  - `opc-companion.mjs:98`: `redactOutput({ error: { code, message: safeOutputText(err.message), details: err.details } })`.
  - `transfer.mjs`: aplicar `maskSecretPatterns` a todo texto de bloco (user, assistant, thinking quando exportado, `tool_use.input` serializado, `tool_result`), contando substituições; `commands/transfer.mjs` imprime `[opc] aviso: N trecho(s) com aparência de segredo mascarado(s) no histórico exportado.` quando N > 0.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/conclave*.test.mjs tests/unit/redact*.test.mjs tests/unit/transfer.test.mjs tests/integration/transfer.test.mjs tests/integration/cli.test.mjs tests/integration/secrets.test.mjs`.

- [ ] **Step 5: Commit** — `fix(security): exclude sensitive files from conclave review, mask free-text secrets in errors and transfers, refuse redirects`.

---

### Task 5: Turnos — timeout sem interrupção confirmada e cancelamento antes do prompt

**Files:**
- Modify: `plugins/opc/scripts/lib/runner.mjs:126-134` (`waitIdle`), `:140-240` (checagem antes do prompt), `:386-390` (timeout/cancel), `:466-520` (`dispatchSubagent`)
- Modify: `plugins/opc/scripts/commands/subagent.mjs:160-180`
- Test: `tests/unit/runner-safety-v2.test.mjs`, `tests/unit/runner-subagent.test.mjs`, `tests/unit/jobs-cancel-preprompt.test.mjs`, `tests/integration/fallback.test.mjs`

**Interfaces:**
- Produces: `dispatchSubagent({ ..., isCancelled = () => false, signal })` repassados em `common` para `runTurn`.
- Produces: `runTurn` verifica `signal?.aborted || isCancelled()` **depois** de criar/obter a sessão e **antes** de `sendPrompt`; se verdadeiro, interrompe a sessão (melhor esforço) e retorna `status: 'cancelled'` sem `api.prompt`.

- [ ] **Step 1: Testes que falham**

```js
test('timeout with failed interrupt is AbortUnconfirmed and blocks fallback', async () => {
  // fake api: prompt ok, sessionStatus sempre ocupado, interrupt lança RequestError('SERVER_ERROR')
  const result = await runTurn({ api, hub, request: { ...base, timeoutMs: 50, idleWaitMs: 100 } });
  assert.equal(result.errorType, 'AbortUnconfirmed');
  assert.equal(result.errorClass, 'fatal');
});
test('timeout with interrupt ok but session still busy is AbortUnconfirmed', async () => { /* interrupt → true, status ocupado */ });
test('fallback stops on AbortUnconfirmed', async () => { /* routing com 2 candidatos → attempts.length === 1, stopReason 'fatal' */ });

test('cancelled before the prompt: no prompt is sent', async () => {
  let prompts = 0;
  const api = fakeApi({ prompt: async () => { prompts += 1; } });
  const result = await runTurn({ api, hub, request: base, isCancelled: () => true });
  assert.equal(prompts, 0);
  assert.equal(result.status, 'cancelled');
});

test('subagent member cancelled during createSession never prompts', async () => {
  // dispatchSubagent com createSession que resolve depois de isCancelled virar true
  assert.equal(promptCalls, 0);
  assert.ok(interrupts >= 1);
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação**
  - Ramo `timeout`/`cancelled` (`runner.mjs:387`): reunir `[sessionID, ...children]`, interromper cada uma e guardar `confirmed = interrupt ok && await waitIdle(...)` por sessão. Erro de servidor fora do ar continua indo para `serverLost()`. Se alguma não confirmar, `forcedError = { name: 'AbortUnconfirmed', data: { message: 'Não foi possível confirmar a interrupção da sessão; fallback bloqueado.' } }`, e o retorno já existente em `:422` cuida do resto. A mensagem `'… e foi interrompido'` só vale quando confirmado.
  - `runTurn`: inserir a checagem de cancelamento antes de `sendPrompt` (há também um caminho de `command`; cobrir os dois).
  - `dispatchSubagent`: aceitar e repassar `isCancelled` e `signal` em `common`; checar `isCancelled()` logo após `createSession` do carrier/child (antes de `runTurnImpl`).
  - `subagent.mjs`: passar `isCancelled: () => { const j = readJob(stateDir, memberId); return Boolean(j?.cancelRequestedAt) || j?.status === 'cancelled'; }` (e o mesmo para o grupo); manter `attemptInFlight: true` até a limpeza da sessão criada.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/runner*.test.mjs tests/unit/jobs-cancel-preprompt.test.mjs tests/integration/fallback.test.mjs tests/integration/subagent.test.mjs tests/integration/groups.test.mjs`.

- [ ] **Step 5: Commit** — `fix(runner): block fallback when the timeout abort is unconfirmed; never prompt after cancellation`.

---

### Task 6: Servidor e estado — servidor lento com jobs, job corrompido, `gc`

**Files:**
- Modify: `plugins/opc/scripts/lib/server.mjs:21` (constantes), `:552-587` (`ensureServer`, reuso)
- Modify: `plugins/opc/scripts/lib/jobs.mjs:192-210` (`listJobs`)
- Modify: `plugins/opc/scripts/commands/gc.mjs:74-77`
- Test: `tests/integration/server-lifecycle.test.mjs`, `tests/unit/jobs.test.mjs`, `tests/unit/gc.test.mjs`

**Interfaces:**
- Produces: `HEALTH_BUSY_RETRIES = 3`, `HEALTH_BUSY_TIMEOUT_MS = 5000` em `server.mjs`.
- Produces: `ConnectionError('SERVER_UNRESPONSIVE', …)`.
- Produces: `listJobs` ignora arquivo ilegível e o move para `jobs/<id>.json.corrupt-<epochMs>` (mesma pasta, 0600), registrando aviso via `onWarning` opcional (`listJobs(stateDir, { …, onWarning })`).

- [ ] **Step 1: Testes que falham**

```js
// server-lifecycle: cenário hung-server existente + um job ativo no estado
test('hung server with active jobs is not killed', async () => {
  const before = recordedPid();
  const { code, stderr } = await runCli(['task', '--model', 'p/m', 'oi'], { hungServer: true, activeJob: true });
  assert.equal(isAlive(before), true);
  assert.match(stderr, /SERVER_UNRESPONSIVE|não respondeu/);
  assert.notEqual(code, 0);
});
test('hung server without jobs is still replaced (current behavior)', async () => { /* teste existente continua verde */ });

test('a corrupt job file does not break listJobs/createJob', () => {
  writeFileSync(join(jobsDir, 'task-abc123-abcdef.json'), '');
  const jobs = listJobs(stateDir, { all: true });
  assert.ok(Array.isArray(jobs));
  assert.ok(readdirSync(jobsDir).some((n) => n.startsWith('task-abc123-abcdef.json.corrupt-')));
});

test('gc recognizes a live server with a custom opencode binary', () => {
  assert.equal(serverMatcher(4100, '/opt/oc/bin/oc-v2')(['/opt/oc/bin/oc-v2', 'serve', '--port', '4100']), true);
  // e gc.mjs passa resolveOpencodeBin({ env, config }) ao matcher
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação**
  - `ensureServer`, ramo "travado" (health sem resposta, sem `ok`): se `hasActiveJobs()`, repetir `probeHealth` até `HEALTH_BUSY_RETRIES` vezes com `HEALTH_BUSY_TIMEOUT_MS`; respondeu → seguir o fluxo normal de reuso; não respondeu → `throw new ConnectionError('SERVER_UNRESPONSIVE', 'O servidor gerenciado não respondeu e há jobs ativos; aguarde (/opc:status), cancele (/opc:cancel) ou pare com opc setup --stop-server --force.')`. Sem jobs ativos: comportamento atual.
  - `listJobs`: `try { job = readJob(...) } catch (err) { if (err.code !== 'INVALID_JSON' && err.code !== 'READ_FAILED') throw err; quarantine(...); onWarning?.(...) }`. Não fazer `fsync` agora (custo e escopo; registrar como não feito no relatório).
  - `gc.mjs`: `serverMatcher(fallback.port, resolveOpencodeBin({ env: ctx.env, config: ctx.config }))`.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/integration/server-*.test.mjs tests/unit/jobs*.test.mjs tests/unit/gc.test.mjs tests/integration/f2a-gc.test.mjs`.

- [ ] **Step 5: Commit** — `fix(server): never kill a slow managed server with active jobs; quarantine corrupt job files; gc uses the configured binary`.

---

### Task 7: MCP — eco de entrada, IDs de formulário e `cwd`

**Files:**
- Modify: `plugins/opc/scripts/lib/mcp-tools.mjs:43` (`CWD`), `:384-392` (`opc_permissions_answer`), `:489-501` (`maskInputEcho`), `:512-541`
- Modify: `plugins/opc/scripts/lib/mcp-schema.mjs` se o padrão de ID for compartilhado
- Test: `tests/unit/mcp-tools.test.mjs`, `tests/integration/mcp-permissions.test.mjs`, `tests/integration/mcp-jobs.test.mjs`

**Interfaces:**
- Produces: `maskInputEcho(message, input)` sem `RegExp`: para cada valor string de `input` com `length >= 8`, em ordem decrescente de tamanho, `text = text.split(value).join('***')`; valores com mais de 4096 caracteres são mascarados por uma janela dos primeiros 64 caracteres (prefixo) — suficiente para não ecoar o prompt e com custo linear.
- Produces: `requestId` de `opc_permissions_answer` com o mesmo padrão aceito pela CLI (`^frm_[A-Za-z0-9]+$`, conferir `opencode-v2.mjs:29` / `permissions.mjs:148`) e descrição `ID do formulário (frm_…)`.
- Produces: `INVALID_CWD` também quando `realpath(cwd)` não é `realpath(defaultCwd)` nem descendente dele.

- [ ] **Step 1: Testes que falham**

```js
test('a 300 KB prompt returns the envelope, not an internal error', async () => {
  const call = createToolCaller({ dispatch: async (argv, io) => { io.stderr.write('model p/m failed\n'); io.stdout.write('{"jobId":"task-abc123-abcdef"}'); return 0; }, defaultCwd: tmp });
  const res = await call('opc_task', { prompt: 'x'.repeat(300_000) });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /task-abc123-abcdef/);
});
test('short input values are not masked inside unrelated text', () => {
  assert.equal(maskInputEcho('model a failed', { prompt: 'a' }), 'model a failed');
});
test('opc_permissions_answer accepts frm_ ids', async () => {
  const res = await call('opc_permissions_answer', { requestId: 'frm_example', answers: ['sim'] });
  assert.notEqual(JSON.parse(res.content[0].text).error?.code, 'INVALID_ARGUMENTS');
});
test('cwd outside the project is refused', async () => {
  const res = await call('opc_status', { cwd: os.tmpdir() });   // defaultCwd = projeto fake
  assert.equal(JSON.parse(res.content[0].text).error.code, 'INVALID_CWD');
});
test('cwd inside the project is accepted', async () => { /* subpasta do defaultCwd */ });
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação** — como em Interfaces; montar o envelope dentro de `try/catch` para que uma falha de mascaramento nunca troque um resultado já executado por `-32603` (cair para `stdout` sem eco de entrada e `stderr` vazio, com aviso no log do servidor MCP).

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/mcp*.test.mjs tests/integration/mcp-*.test.mjs`.

- [ ] **Step 5: Commit** — `fix(mcp): linear input-echo masking, frm_ form ids and project-scoped cwd`.

---

### Task 8: Contratos e config — `result` de revisão, `--prompt-file`, `__proto__`, limites do workspace

**Files:**
- Modify: `plugins/opc/scripts/commands/result.mjs:36-39`, `plugins/opc/scripts/commands/review.mjs:70-78` (extrair a classificação)
- Modify: `plugins/opc/scripts/commands/subagent.mjs:65-66`
- Modify: `plugins/opc/scripts/lib/config.mjs:251-256` (`mergeDeep`), `validateConfigShape`, `mergeConfig` (`:269-340`)
- Test: `tests/unit/task10-result-cancel.test.mjs` ou `tests/unit/review-attempts-json.test.mjs`, `tests/integration/subagent.test.mjs`, `tests/unit/config.test.mjs`, `tests/unit/config-delegation.test.mjs`

**Interfaces:**
- Produces: `reviewExitCode(job) → ExitCode` exportado de `commands/review.mjs`, usado por `review` (foreground/wait) e por `result` para `job.kind === 'review'` (e `adversarial-review`, se compartilhar o tipo).
- Produces: `WORKSPACE_TIGHTEN_ONLY = ['routing.fallback.maxAttempts', 'routing.fallback.maxProviderRetries', 'routing.fallback.maxRetryWaitSec', 'conclave.rounds', 'conclave.memberTimeoutSec', 'orchestrate.maxSubtasks']` em `config.mjs`.

- [ ] **Step 1: Testes que falham**

```js
test('result of a review without valid JSON exits 7 like the foreground', async () => {
  const job = { id: 'review-abc123-abcdef', kind: 'review', status: 'completed', result: { structured: null, finalText: 'prosa' } };
  assert.equal(reviewExitCode(job), ExitCode.JOB_FAILED);
  // e via cmdResult com o job gravado → 7
});

test('subagent --prompt-file resolves against --cwd', async () => { /* cwd = tmp com prompt.md; process.cwd() diferente */ });

test('mergeDeep ignores __proto__/constructor/prototype', () => {
  const ws = JSON.parse('{"routing":{"tasks":{"__proto__":["x/y"]}}}');
  const { config, warnings } = mergeConfig({}, ws);
  assert.equal(Object.getPrototypeOf(config.routing.tasks), Object.prototype);
  assert.ok(warnings.some((w) => /__proto__/.test(w)));
});

test('workspace can only tighten numeric limits', () => {
  const { config, warnings } = mergeConfig({ routing: { fallback: { maxAttempts: 2 } } }, { routing: { fallback: { maxAttempts: 10 } }, conclave: { rounds: 1 } });
  assert.equal(config.routing.fallback.maxAttempts, 2);
  assert.equal(config.conclave.rounds, 1);
  assert.ok(warnings.some((w) => /maxAttempts/.test(w) && /apertar/.test(w)));
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação**
  - `reviewExitCode`: a regra de `review.mjs:77` (`completed` + estrutura ausente/inválida → `JOB_FAILED`; senão `exitCodeForJob`). Opcional e preferível: persistir no worker `errorType: 'InvalidReviewOutput'` quando a revisão termina sem JSON válido, para `status` mostrar o mesmo — fazer só se couber sem mudar o formato do job (campo já existe).
  - `subagent.mjs:66`: `readFileSync(resolvePath(ctx.cwd, flags['prompt-file']), 'utf8')`, igual a `task.mjs:152`.
  - `mergeDeep`: `if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;` e `validateConfigShape` emite aviso `UNKNOWN_KEY` para essas chaves.
  - `mergeConfig`: para cada chave de `WORKSPACE_TIGHTEN_ONLY` presente no workspace, efetivo = `Math.min(globalOuDefault, workspace)`; se o workspace for maior, aviso `"<chave>": o workspace só pode apertar (global/padrão = N); valor do workspace ignorado.` (Decisão 12).

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/config*.test.mjs tests/unit/review*.test.mjs tests/unit/task10-result-cancel.test.mjs tests/integration/review.test.mjs tests/integration/subagent.test.mjs tests/integration/config-cli.test.mjs`.

- [ ] **Step 5: Commit** — `fix(contracts): consistent review exit codes, subagent prompt-file cwd, safe workspace merge`.

---

### Task 9: Barreira `--tty-confirm` sob o Claude Code

**Files:**
- Modify: `plugins/opc/scripts/commands/config.mjs:73-89` (`confirmLocked`)
- Modify: `plugins/opc/scripts/lib/process.mjs` (reutilizar `getParentPid`, `readProcStat`/cmdline da F8)
- Test: `tests/integration/config-tty.test.mjs`, `tests/unit/process.test.mjs`

**Interfaces:**
- Produces: `hasClaudeAncestor(pid = process.pid, { parentOf, identityOf, maxDepth = 32 }) → boolean` em `lib/process.mjs`. Verdadeiro se algum ancestral tem `basename(argv0)` igual a `claude` ou um `cmdline` que contenha o entrypoint do Claude Code (`/claude` ou `@anthropic-ai/claude-code`). Para em `pid <= 1`.

- [ ] **Step 1: Testes que falham**

```js
test('hasClaudeAncestor walks the parent chain', () => {
  const tree = { 50: { ppid: 40, cmd: ['node', 'opc'] }, 40: { ppid: 30, cmd: ['script', '-qec'] }, 30: { ppid: 20, cmd: ['bash'] }, 20: { ppid: 1, cmd: ['claude'] } };
  assert.equal(hasClaudeAncestor(50, { parentOf: (p) => tree[p]?.ppid, identityOf: (p) => ({ cmdline: tree[p]?.cmd }) }), true);
  delete tree[20]; tree[30].ppid = 1;
  assert.equal(hasClaudeAncestor(50, { parentOf: (p) => tree[p]?.ppid, identityOf: (p) => ({ cmdline: tree[p]?.cmd }) }), false);
});
test('--tty-confirm is refused under Claude Code even with a TTY', async () => {
  // injetar deps de confirmLocked: stdin isTTY true, hasClaudeAncestor → true → LOCKED_KEY com mensagem "terminal próprio"
});
test('--tty-confirm is refused when CLAUDECODE is set', async () => { /* env CLAUDECODE=1 */ });
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementação** — em `confirmLocked`, antes do prompter: `if (ctx.env.CLAUDECODE || hasClaudeAncestor()) throw new PolicyError('LOCKED_KEY', '--tty-confirm não é aceito dentro de uma sessão do Claude Code; rode no seu próprio terminal: <comando>')`. Injetável via deps para o teste.

- [ ] **Step 4: Rodar e ver passar** + `node --test tests/unit/process.test.mjs tests/integration/config-tty.test.mjs tests/integration/config-cli.test.mjs`.

- [ ] **Step 5: Commit** — `fix(config): refuse --tty-confirm inside a Claude Code process tree`.

---

### Task 10: Docs, CHANGELOG, relatório da F11 e portão

**Files:**
- Modify: `docs/permissions.md`, que passa a cobrir:
  - a ordem final das regras;
  - `extraAllow`;
  - o que exige o usuário com aprovador `claude`: normalização do git, `shell` em caminho sensível, `webfetch`/`websearch` e permissão desconhecida;
  - o limite das regras de sessão por prefixo.
- Modify: `docs/configuration.md`, que passa a cobrir:
  - as chaves só de aperto no workspace;
  - o `__proto__` ignorado;
  - os novos `sensitivePaths` padrão;
  - a barreira TTY descrita como conveniência, sem prova de humano.
- Modify: `docs/commands.md`, que passa a cobrir:
  - o `transfer` mascarando segredos;
  - o `cwd` do MCP restrito ao projeto;
  - `confirmedByUser` como declaração, em que o portão real é o prompt do Claude Code;
  - o exit code do `result` de revisão.
- Modify: `docs/troubleshooting.md`, com `SERVER_UNRESPONSIVE`, `ABORT_UNCONFIRMED`, `SHARE_AUTO`, `UNEXPECTED_REDIRECT`, `SUBAGENT_DENIED` e os arquivos `*.corrupt-*`.
- Modify: `CHANGELOG.md`, seção "Corrigido — F11" com uma linha por achado e o número da tabela.
- Create: `docs/phases/F11-report.md`, com a tabela de origem, o status de cada achado (PASSOU / NÃO VALIDADO / N/A, com evidência), as decisões e os itens não feitos (o `fsync`).
- Create: `tests/unit/docs-f11.test.mjs`, no padrão de `docs-f10.test.mjs`: as docs citam os códigos novos e as decisões.

- [ ] **Step 1:** Escrever o teste de docs, que deve falhar.
- [ ] **Step 2:** Atualizar as docs e o CHANGELOG e escrever o relatório.
- [ ] **Step 3: Portão**
  - `node scripts/run-tests.mjs`, com 0 falhas;
  - `npm run scan-secrets`;
  - `git diff --check`;
  - nenhum processo órfão: `pgrep -af 'opencode serve'` mostra só os serves do operador.
- [ ] **Step 4: Commit:** `docs: document the F11 review fixes`.
- [ ] **Step 5:** Revisão final da branch inteira, com o modelo mais capaz disponível. Depois, PR para a `main`, com push, PR e merge só com o "sim" do operador.

---

## Self-review

- **Cobertura:** os 24 itens da tabela têm tarefa. O 11 é endurecimento e não um defeito provado. Os dois não-código têm decisão (10 e 3).
- **Interfaces:** `buildPermissionRules({ extraAllow })` (T1) é consumido só dentro do runner (T1). `requiresUser`/`checkReply` (T2) são consumidos pelo MCP (T7) sem mudança de assinatura. `guardSessionCreation` (T3) é independente de T5. `dispatchSubagent` é tocado em T1 (`policy`, `extraAllow`) e T5 (`isCancelled`, `signal`): mesma função em duas tarefas, mas em parâmetros diferentes, e a T5 roda depois da T1. Registrar no ledger.
- **Arquivos compartilhados:**
  - `policy.mjs`: T1 cuida da ordem e T2 do classificador, em funções diferentes.
  - `runner.mjs`: T1 cuida do carrier e T5 do timeout e do pré-prompt.
  - `subagent.mjs`: T5 cuida do cancelamento e T8 do `--prompt-file`.
  - `server.mjs`: T3 cuida da guarda e de `worldCheck`, e T6 do reuso travado. O ramo de reuso em `:566`/`:576` aparece nas duas; a T6 roda depois da T3 e preserva o `directory`.
  - `config.mjs`: T2 cuida do default de `sensitivePaths` e T8 do merge.
- **Sem placeholders de comportamento.** Os testes de integração citam o fake existente, porque cada arquivo de teste tem o seu harness. O implementador usa o do arquivo indicado.
