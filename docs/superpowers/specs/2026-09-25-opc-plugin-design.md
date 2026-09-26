# opc — Plugin Claude Code para OpenCode · Design

- **Data:** 25/09/2026
- **Status:** aprovado em conversa (rev. 2); rev. 3 incorpora a revisão dupla independente e
  aguarda revisão do operador
- **Mundo:** `myprojects`
- **Namespace:** `/opc:` · executável `opc` (via `bin/` do plugin)
- **Alvo testado:** OpenCode 1.18.32 (Linux)

### Registro de revisões

| Rev. | Data | Mudança |
|---|---|---|
| 1 | 25/09/2026 | Design inicial (abordagem A, conexão, permissões, jobs, fases F0–F4) |
| 2 | 26/09/2026 | Onboarding/config, swarm, conclave, documentação, fases F0–F5 |
| 3 | 26/09/2026 | Revisão dupla (fidelidade à API 1.18.32 + coerência/segurança): perfis de permissão refeitos, `always`→`once`, reaper do SessionEnd, classificação de erros pela união real, travas de política, `.opc.json` só restringe, lacunas de paridade, exit codes, fases divididas (F2a/F2b, F4a/F4b/F4c), cortes (`share`, `--auto-approve`, sync de agentes) |

---

## 1. Contexto e objetivo

Construir um plugin Claude Code que usa o OpenCode como executor, no molde do
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), mas com integração
máxima com o que o OpenCode oferece: providers, modelos, variants, agentes, subagentes,
sessões e permissões. O plugin também cobre as capacidades do
[`apoapps/swarm-code-plugin`](https://github.com/apoapps/swarm-code-plugin) e adiciona o
**conclave**: consulta simultânea a vários modelos com síntese.

- **Mínimo (obrigatório):** paridade funcional com o `codex-plugin-cc` — review,
  adversarial-review, rescue/task, status, result, cancel, setup, stop review gate e hooks
  de sessão. O `transfer` é paridade, mas fica na F5 (desvio registrado, §14.3).
- **Desejado:**
  - Configuração guiada no início: provider e modelo padrão, modelos e agentes permitidos e
    toda a config, também via CLI.
  - Listar e escolher providers, modelos, variants e agentes.
  - Disparar subagentes, inclusive em paralelo.
  - Criar e gerenciar sessões (new, fork, revert, summarize, children, diff, todo).
  - Rodar commands do OpenCode; ponte de permissões e perguntas; `attach` na TUI.
  - Swarm: delegação automática, modos ask/plan, orquestração, worker para Agent Teams,
    roteamento com fallback, monitor.
  - Conclave.
  - Servidor MCP; transfer Claude → OpenCode.
  - Documentação completa.

### 1.1 Por que não fazer fork do `tasict/opencode-plugin-cc`

Análise de 25/09/2026 sobre o HEAD da v1.1.0:

- `--model` é lido mas nunca enviado (confirmado no código; PR #10 aberto).
- O stop gate sai com código 1, que não bloqueia.
- Reescreve silenciosamente o `~/.config/opencode/opencode.json` global para `allow`.
- Detecta o fim do turno por polling com `lsof`/`pgrep`, sem usar SSE.
- Porta 4096 fixa no código.

Decisão: **reescrita**. Reaproveitamos a estrutura de comandos, prompts e schema do
`codex-plugin-cc`, com a atribuição Apache-2.0 (LICENSE + NOTICE).

### 1.2 O que vem do `swarm-code-plugin`

Análise de 26/09/2026 sobre o HEAD `1f1f2ae` (05/04/2026):

- **Licença:** o repositório **não tem arquivo LICENSE**. O README e o `package.json`
  declaram MIT, mas o GitHub não detecta licença. Decisão: reproduzir **capacidades**,
  **sem copiar código nem texto**.
- **Capacidades adotadas** (§10): delegação automática com Claude como líder; modos
  ask/plan/review; worker compatível com Agent Teams; orquestração com decomposição em
  subtarefas paralelas; prioridade de modelos por tipo de tarefa com fallback; perfil do
  projeto no init; monitor de jobs.
- **Não adotado:** o gatilho por palavra-chave que lê a saída do Claude via
  `tmux pipe-pane` (frágil e intrusivo), substituído por `/opc:attach --pane`; e o
  "smart router" por pontuação heurística, substituído por tiers explícitos.

### 1.3 Decisões registradas

| # | Decisão | Escolha |
|---|---|---|
| D1 | Base | Reescrita inspirada no codex-plugin-cc |
| D2 | Transporte | Servidor `opencode serve` gerenciado pelo plugin (abordagem A), HTTP + SSE. Um servidor por workspace, compartilhado pelas sessões do Claude abertas nele e encerrado pelo reaper quando a última termina (§9.3) |
| D3 | Dependências | Zero dependências de runtime; Node ≥ 20 (checado em runtime), ESM, `fetch` nativo |
| D4 | Superfície | Slash commands + hooks + executável `opc` (F0–F4); servidor MCP sobre o mesmo núcleo (F5) |
| D5 | Namespace | `/opc:` (não colide com `/opencode:` do tasict) |
| D6 | Mundo / política | O plugin sai sem restrição; allow/deny configurável para providers, modelos, agentes e ferramentas MCP. A config global do operador é o "perfil de mundo"; o `.opc.json` do repo só restringe (§3.2) |
| D7 | Integridade da conexão | Requisito de primeira classe, com critérios de aceite e testes próprios (§5) |
| D8 | Permissões | Perfis por sessão com invariantes sempre anexadas; `always` convertido em `once`; o plugin nunca altera config global do OpenCode; aprovador padrão = usuário; destrutivos sempre com o usuário (§8) |
| D9 | Validação | Portão ao fim de cada fase: `npm test` + checklist ao vivo com modelo real + teste de contrato + documentação + relatório (§13) |
| D10 | Configuração | Onboarding duplo (guiado no Claude + assistente no terminal) + `opc config` não interativo; chaves de política travadas após o bootstrap (§3.3) |
| D11 | Swarm | Capacidades do swarm-code reimplementadas sobre o núcleo do opc (§10) |
| D12 | Conclave | Consulta paralela a N ≥ 2 modelos, debate opcional anonimizado, síntese por juiz ou pelo Claude; modo review com deduplicação e concordância (§11) |
| D13 | Documentação | README, `docs/` e CHANGELOG em PT-BR; faz parte do portão de cada fase (§12) |
| D14 | Fases | F0 · F1 · F2a · F2b · F3 · F4a · F4b · F4c · F5 (§13.3) |
| D15 | Cortes (YAGNI/segurança) | Sem `share`/`unshare` (publica a sessão), sem `--auto-approve`, sem exclusão de sessão; sincronização de agentes vai para o backlog (§2) |

### 1.4 Fatos verificados

**Ao vivo** (sondagem de 25/09/2026, `deepseek-v4.1-flash`):

| Fato | Evidência | Impacto |
|---|---|---|
| `format: {type:"json_schema"}` funciona e devolve `info.structured` | `structured={"verdict":"approve","count":3}` | Review, conclave e orquestração com schema nativo |
| Saída estruturada termina com `finish: "tool-calls"` (é uma ferramenta) | parts `step-start,reasoning,tool,step-finish` | Fim de turno **não** pode depender de `finish == "stop"` |
| SSE `/event` emite `session.idle` e `session.status` (idle) | contagem de eventos | Fim de turno por evento |
| `GET /session/status` devolve `{}` quando tudo está ocioso | resposta | Sessão ausente no mapa = idle |
| Regra de sessão `bash: ask` gera `permission.asked`; `reply:"reject"` com `message` funciona | ida-e-volta | Ponte de permissões viável |
| `serve --port 0` subiu na 4096 | log | O plugin escolhe a porta |
| `serve` ignorou SIGTERM duas vezes; só SIGKILL no grupo encerrou | sondagens | Encerramento em escala |
| Primeira sessão num diretório: cerca de 23 s | timestamps | Aquecimento e timeouts longos |

**Por código/spec** (revisão de 26/09/2026: OpenAPI 1.18.32 salva, `strings` do binário
1.18.32, docs do Claude Code):

| Fato | Fonte | Impacto |
|---|---|---|
| Permissões avaliadas por `findLast` sobre `merge(agent.permission, session.permission)` e, **depois**, as aprovações `always` em memória da instância | binário `Permission.ask/reply` | Regras da sessão vencem agente/global; **`always` vence a sessão e vale para o diretório inteiro** → nunca usar `always` (§8.3) |
| Chaves de permissão: `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop, skill` (+ curinga de nome) | OpenAPI `PermissionConfig`; binário mapeia `edit`/`write`/`apply_patch` → `edit` | Não existem chaves `write`/`patch` |
| Padrão do OpenCode: `"*":allow`, `doom_loop:ask`, `external_directory:ask`, `question:deny`, `read` com `*.env`/`*.env.*` em `ask` | binário | O perfil read-only precisa sobrescrever esses `ask` |
| `reject` de um pedido rejeita também os outros pendentes da mesma sessão | binário `Permission.reply` | A ponte trata irmãos sumindo |
| `server.heartbeat` é evento `data:` a cada 10 s (fora da união OpenAPI); o stream fecha em `server.instance.disposed` | binário | Liveness de 30 s adequada; ressincronizar no disposed |
| União de erros de `AssistantMessage.error`: `ProviderAuthError`, `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`, `APIError{statusCode?, isRetryable, …}`; também via evento `session.error` | OpenAPI | Classificação de erros (§7.1) |
| O OpenCode repete sozinho erros com `isRetryable` (408/409/429/5xx), sinalizando `session.status{type:"retry",attempt,message,next}` | binário | Fallback precisa de teto de retries (§10.2) |
| Default global de modelo: `GET /config` → `model`; `/provider.default` é mapa por provider; `models` e `variants` são mapas | OpenAPI | Resolução de modelo (§6) |
| `POST /session` aceita `parentID, title, agent, model, metadata, permission` (`additionalProperties:false`); `PATCH /session/:id` aceita `permission` | OpenAPI | Sessões filhas controladas pelo plugin; troca de perfil em resume |
| `prompt_async` aceita `messageID` do cliente | OpenAPI | Deduplicação em reenvio (§5.2) |
| `summarize` exige `providerID`/`modelID`; `revert` exige `messageID`; `command` recebe `model` como string e `arguments` obrigatório, resposta síncrona | OpenAPI | Catálogo de comandos (§4) |
| `question/{id}/reply` recebe `answers: string[][]`; existe `question/{id}/reject` | OpenAPI | Ponte de perguntas (§8.2) |
| SessionEnd: orçamento total de **1,5 s**, não ampliável por plugin; `reason` pode ser `clear`/`resume` | docs de hooks | Reaper destacado (§9.3) |
| `bin/` do plugin entra no PATH **da ferramenta Bash** (não do terminal do usuário) | docs de plugins | Comandos chamam `opc`; terminal usa alias (§3.2) |
| `CLAUDE_PLUGIN_DATA` = `~/.claude/plugins/data/<id>/`, presente em hooks e MCP, **ausente** no Bash (exportado via `CLAUDE_ENV_FILE` no SessionStart) | docs de plugins; codex | Resolução do diretório de dados (§3.2) |
| Stop hook recebe `stop_hook_active` e `last_assistant_message`; bloqueio por `{"decision":"block"}` com exit 0; timeout padrão 600 s | docs de hooks | Stop gate (§9.3) |
| `skills:` de agente não se aplica a teammate de Agent Teams | docs de agent teams | `opc-worker` com regras inline (§10.4) |
| Tipos v1 do SDK instalado estão defasados (sem `json_schema`/`permission.asked`); `dist/v2/gen` bate com a OpenAPI | SDK local | Fixtures e contratos derivados da OpenAPI |
| `PATCH /session/:id {permission}` **anexa** as regras às existentes (o `merge` concatena), não substitui | binário (plano F2a) | Resume: trocar para `read-only`/`custom` funciona, porque as regras novas vêm por último; trocar para `write` é recusado (exit 2) antes do PATCH (§7) |
| Sessões filhas herdam do pai só as regras `deny` e `external_directory` | binário (plano F2a) | O runner reaplica o perfil do job a cada filha assim que ela é criada (§8.1). Resta uma janela curta entre a criação e o PATCH, documentada |
| A saída estruturada é uma ferramenta chamada `StructuredOutput` | binário (plano F2a) | Não conta como "ferramenta executada" (§7.1, §10.2) |
| `messageID` do OpenCode: `msg_` + 12 hex + 14 base62, ascendente | binário (plano F2a) | `newMessageId` replica o formato (§5.2) |
| `next` do `session.status{type:"retry"}` é um instante absoluto (epoch ms) | binário (planos F2a/F4a) | O teto usa `next - agora` (§10.2) |

---

## 2. Não-objetivos e backlog

**Fora de escopo:**

- PTY/WebSocket; controle da TUI além do `attach`.
- Login e gestão de credenciais de providers (continua em `opencode auth login`).
- Worktrees e workspaces experimentais, `sync/*`.
- API v2 (`/api/*`), salvo desvio registrado.
- `share`/`unshare` (publica a conversa numa URL pública), exclusão de sessões,
  `--auto-approve`/"libera tudo".
- Roteamento por heurística automática de complexidade; gatilhos que leem o terminal do
  Claude.
- Suporte validado a Windows/macOS (código portátil; validação só Linux — §14).

**Backlog (fora deste plano):**

- Sincronização de agentes do OpenCode como subagentes Claude.
- README em inglês para publicação.

---

## 3. Arquitetura

```
.claude-plugin/marketplace.json
plugins/opc/
  .claude-plugin/plugin.json
  bin/opc                            # wrapper → node ../scripts/opc-companion.mjs "$@"
  commands/*.md
  agents/opc-rescue.md  agents/opc-worker.md
  skills/opc-runtime/  skills/opc-result-handling/  skills/opc-prompting/
  skills/opc-delegation/  skills/opc-conclave/
  hooks/hooks.json
  prompts/   review.md, adversarial-review.md, stop-review-gate.md, ask.md, plan.md,
             continue.md, orchestrate-decompose.md, orchestrate-synthesize.md,
             conclave-member.md, conclave-debate.md, conclave-judge.md
  schemas/   review-output, orchestrate-plan, conclave-member, conclave-synthesis (.schema.json)
  scripts/opc-companion.mjs          # CLI única: comandos, hooks, reaper, wizard, monitor
  scripts/mcp-server.mjs             # F5
  scripts/lib/
    args.mjs        parse de argv; leitura de argumentos por stdin (--args-stdin)
    http.mjs        fetch + auth + ?directory; erros tipados; timeout; redação de segredos
    sse.mjs         parser /event; heartbeat; reconexão; roteamento por sessão (inclui filhas)
    server.mjs      ciclo de vida do opencode serve (porta, spawn, log, health, versão, kill, attach)
    api.mjs         operações de domínio sobre a API v1
    runner.mjs      executa um turno (prompt_async + SSE) até o fim
    errors.mjs      classificação da união de erros do OpenCode
    models.mjs      parse de IDs, aliases, variants, resolução
    routing.mjs     listas por tipo de tarefa, tiers, fallback
    policy.mjs      allow/deny; perfis de permissão; invariantes; aprovador; destrutivos
    config.mjs      config global + workspace (merge restritivo, esquema, chaves travadas)
    onboarding.mjs  lógica do onboarding (rascunho + commit atômico)
    tty.mjs         prompts de terminal (listas numeradas + filtro), streams injetáveis
    orchestrator.mjs decomposição → jobs → síntese
    conclave.mjs    rodadas, anonimização, dedupe, síntese
    locks.mjs       lock por arquivo O_EXCL com dono verificável e quebra de lock órfão
    state.mjs       diretório de dados/estado, escrita atômica, permissões 700/600, reparo
    jobs.mjs        registros de job, worker, grupos, cancel, limites
    git.mjs         coleta de diff (porte do codex)
    render.mjs      saída Markdown/JSON
    process.mjs     spawn destacado, identidade de processo (cmdline + start time), kill em escala
docs/  README.md  CHANGELOG.md  NOTICE  LICENSE
tests/unit/  tests/integration/  tests/live/  tests/fixtures/fake-opencode.mjs
```

### 3.1 Regras de fronteira entre módulos

- `http` não conhece domínio; `api` não conhece CLI; `runner` não conhece comandos nem
  renderização; `render` não faz I/O de rede.
- `orchestrator` e `conclave` compõem `runner` + `jobs`; não falam HTTP diretamente.
- `onboarding` produz um objeto de config; o fluxo guiado e o `tty` são só interfaces.
- Toda entrada passa por `opc-companion.mjs <subcomando>` (via `opc`). Hooks e o servidor MCP
  chamam as mesmas funções de `lib/`.
- Saída: resultado final em stdout; progresso em stderr com o prefixo `[opc]`; `--json` em
  todo subcomando. **Todo JSON e todo log passam por redação**: `key`, `options.apiKey`,
  `options.headers`, `responseHeaders`, `authorization` e a senha do servidor são
  substituídos por `***`.
- Nenhum módulo escreve no `~/.config/opencode/` nem no `auth.json` do OpenCode.

### 3.2 Dados, estado e configuração

**Diretório de dados** (`OPC_DATA_DIR`), resolvido nesta ordem, sem fallback para `$TMPDIR`:

1. `OPC_DATA_DIR`, se definido.
2. `CLAUDE_PLUGIN_DATA` (hooks, MCP e, via `CLAUDE_ENV_FILE`, o Bash do Claude).
3. `~/.claude/plugins/data/<id-do-plugin>/`, se existir (id confirmado na F0, §15).
4. Senão: erro orientando a rodar `/opc:setup` no Claude.

O `/opc:setup` imprime a linha de alias para o terminal com o caminho embutido
(`alias opc='OPC_DATA_DIR=<dir> node <plugin>/scripts/opc-companion.mjs'`), para que Claude e
terminal vejam **o mesmo** estado.

**Estado por workspace:** `<dataDir>/state/<slug>-<sha256(realpath(workspaceRoot))[:16]>/`
(o `workspaceRoot` é `git rev-parse --show-toplevel` ou o cwd). Diretórios com modo 700;
arquivos com modo 600. O dono é conferido a cada uso (dono diferente → erro).

- `server.json`: `{schemaVersion:1, pid, startTime, port, url, version, password, startedAt,
  spawnedBy:"opc", cmdline}`. A senha fica só aqui e nunca é impressa.
- `server.log`: stdout/stderr do servidor (truncado no spawn se > 5 MB).
- `server.lock`, `state.lock`, `session-<sessionID>.lock` (§9.2).
- `state.json`: `{version:1, claudeSessions:[{sessionId, pid, pidStartTime, startedAt}], jobs:[...]}`.
  Corrompido → cópia `state.json.corrupt-<ts>` e reconstrução a partir de `jobs/*.json`.
- `jobs/<id>.json`, `jobs/<id>.log` (log limitado a 5 MB, descartando o início).
- `opc gc` (só sob comando explícito) remove estados de workspaces sem uso há mais de 30 dias,
  listando antes o que vai remover e pedindo confirmação.

**Config global:** `<dataDir>/config.json`. **Override por workspace:** `<workspaceRoot>/.opc.json`
(versionável, sem segredos). O `.opc.json` é conteúdo não confiável (pode vir de um repo
clonado) e **só restringe**:

- `deny` (providers, modelos, agentes, ferramentas): **união** com o global.
- `allow`: **interseção** com o global (allow global vazio = tudo; allow do workspace vazio =
  não restringe).
- Chaves travadas (§3.3) são **só globais**; no `.opc.json` são ignoradas com aviso.
- Escalares de preferência (`defaultModel`, `aliases`, `routing`, `conclave`, `orchestrate`,
  `project`, `reviewModel`, `stopGate.model`) podem ser sobrescritos, mas todo valor passa
  pela política efetiva.
- `config validate` avisa sobre chaves com cara de segredo (`*token*`, `*password*`,
  `*secret*`, `*apikey*`) em qualquer arquivo de config.

**Esquema:**

```json
{
  "defaultProvider": "omniroute-mvalmeida",
  "defaultModel": "omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash",
  "defaultVariant": null,
  "defaultAgent": null,
  "aliases": {
    "fast":   "omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash",
    "strong": "omniroute-mvalmeida/opencode-go/qwen3.8-max",
    "k3":     "omniroute-mvalmeida/opencode-go/kimi-k3"
  },
  "reviewModel": "strong",
  "stopGate": { "enabled": false, "model": null },
  "project": {
    "goal": "Plugin Claude Code para OpenCode",
    "scope": ["plugins/", "tests/"],
    "taskTypes": ["review", "plan", "ask"]
  },
  "policy": {
    "providers": { "allow": [], "deny": ["omniroute-work"] },
    "models":    { "allow": ["omniroute-mvalmeida/opencode-go/*", "anthropic/*"], "deny": [] },
    "agents":    { "allow": [], "deny": ["work-*"] },
    "tools":     { "deny": [] },
    "sensitivePaths": ["*.env", "*.env.*", "**/.ssh/**", "*.pem", "*.key", "**/id_rsa*", "**/id_ed25519*", "**/secrets.env"],
    "destructiveBash": [],
    "approver": "user",
    "permissionTimeoutSec": 600
  },
  "permissionProfiles": {
    "npm-test-only": [ { "permission": "bash", "pattern": "npm test", "action": "allow" } ]
  },
  "routing": {
    "tasks": {
      "ask":    ["fast", "k3"],
      "plan":   ["strong", "k3"],
      "review": ["strong", "k3"],
      "task":   ["fast", "strong"]
    },
    "tiers": { "light": ["fast"], "heavy": ["strong", "k3"] },
    "fallback": { "enabled": true, "maxAttempts": 3, "maxProviderRetries": 3, "maxRetryWaitSec": 60 }
  },
  "conclave": {
    "pools": { "default": ["fast", "strong", "k3"] },
    "defaultPool": "default",
    "judge": "claude",
    "rounds": 1,
    "quorum": 2,
    "memberTimeoutSec": 900
  },
  "orchestrate": { "planner": "strong", "maxSubtasks": 5, "synthesizer": "claude" },
  "delegation": { "auto": false },
  "jobs": { "maxActive": 8, "maxParallel": 4 },
  "server": {
    "bootTimeoutSec": 60,
    "requestTimeoutSec": 30,
    "configOverride": { "share": "disabled" }
  }
}
```

- **IDs de modelo:** a config grava sempre o ID completo normalizado. Na entrada:
  - se o primeiro segmento é um provider **conectado**, o valor é um ID completo;
  - senão, recebe o prefixo `defaultProvider`;
  - se as duas leituras forem válidas, é erro, e o ID completo passa a ser exigido.
- **Globs:** `*` casa qualquer sequência, **inclusive `/`**.
- **`server.configOverride`:** vai para o servidor que o plugin sobe via
  `OPENCODE_CONFIG_CONTENT` (o merge com a config do usuário é A CONFIRMAR, §15). O padrão
  desliga o `share` automático; o operador pode desligar MCPs (`mcp.<nome>.enabled:false`) ou
  trocar o `small_model` só para o servidor do plugin.
- **`policy.destructiveBash`:** padrões **adicionais** à lista embutida (§8.1).

### 3.3 Configuração guiada (D10)

**Chaves travadas:** `policy.*`, `permissionProfiles` e `server.configOverride`. Elas definem o
mundo e as travas; o modelo não pode afrouxá-las.

- **Bootstrap:** quando ainda não existe config global, o onboarding guiado (no Claude) pode
  gravá-las.
- **Depois disso:** só o assistente de terminal (`opc config init`, que exige TTY) ou
  `opc config set ... --tty-confirm` (pede confirmação digitada no TTY) as alteram. No Claude,
  `/opc:setup --reconfigure` ajusta as chaves não travadas e, para as travadas, imprime o
  comando exato a rodar no terminal.
- **Limitação documentada:** o plugin não impede que alguém edite o `config.json` à mão; a
  trava protege contra mudança acidental ou induzida via companion.

**1. `/opc:setup` dentro do Claude.** Roda na primeira execução ou com `--reconfigure`:

1. `opc setup --json` → estado atual (OpenCode instalado? versão? servidor? providers
   conectados? config existente?).
2. OpenCode ausente: pergunta uma vez (AskUserQuestion) se deve instalar
   (`npm install -g opencode-ai`, com `Bash(npm:*)`, como no codex) e reexecuta o setup.
   Nenhum provider conectado: orienta `!opencode auth login`.
3. Perguntas, uma por vez, acumuladas num **rascunho** (`<dataDir>/config.draft.json`):
   1. escopo (global ou workspace);
   2. provider padrão (conectados, ordenados por total de modelos; mais de 3 → os 3 maiores
      + "Outro");
   3. modelo padrão (`opc setup models --provider X --top 3 --json` para as sugestões;
      "Outro" aceita nome ou glob, e o companion devolve os resultados para confirmar);
   4. modelo de review e do stop gate;
   5. variant padrão (as do modelo);
   6. modelos permitidos (atalhos "todos do provider padrão", "só `<família>/*`",
      "sem restrição", "Outro" com globs) — só no bootstrap;
   7. agentes permitidos ("todos", "só built-in", "Outro" com globs) — só no bootstrap;
   8. aprovador (só no bootstrap), stop gate, delegação automática;
   9. perfil do projeto (objetivo, escopo pelos diretórios de `git ls-files`, tipos de tarefa);
   10. aliases sugeridos (`fast`, `strong`).
4. `opc setup commit --json`: valida o rascunho inteiro contra o servidor e a política e
   grava de forma atômica; `config show --effective` no final. Interrupção no meio → só o
   rascunho fica, e `/opc:setup` retoma de onde parou.

**2. `opc config init` no terminal.** Mesmas etapas, com listas numeradas, filtro por texto e
seleção múltipla por números/intervalos (sem dependências). Stdin sem TTY → recusa e orienta.

**3. Não interativo:**

```
opc config get [chave]
opc config set <chave> <valor> [--workspace] [--tty-confirm]
opc config unset <chave> [--workspace] [--tty-confirm]
opc config add|remove <chave-lista> <valor> [--workspace] [--tty-confirm]
opc config show [--effective] [--json]
opc config validate [--json]
opc config path
```

---

## 4. Catálogo de comandos

**Invocação:** todo comando chama o executável `opc` (no PATH do Bash via `bin/`) e passa os
argumentos do usuário **por stdin, em heredoc com delimitador entre aspas**, para que nada
seja expandido pelo shell. São três formas, conforme o tipo de argumento:

- **Texto livre** (`task`, `ask`, `plan`, `review`/`adversarial-review` com foco, `subagent`,
  `command`, `orchestrate`, `conclave`, e os agentes `opc-rescue`/`opc-worker`):
  `--raw-args-stdin`. As flags conhecidas são extraídas como palavras inteiras; o resto é o
  texto **verbatim**, inclusive aspas e apóstrofos; um `--` isolado encerra as flags.
  ```bash
  opc task --raw-args-stdin <<'OPC_ARGS'
  $ARGUMENTS
  OPC_ARGS
  ```
  Os agentes põem as próprias flags na linha de comando e abrem o heredoc com uma linha
  `--`, para que nada do texto recebido vire flag.
- **Só flags e ids** (`setup`, `config`, `providers`, `models`, `agents`, `catalog`,
  `status`, `result`, `cancel`, `sessions`, `session`, `attach`, `transfer`, `permissions`):
  `--args-stdin`, com divisão tipo shell sem expansão (apóstrofo entre letras é literal).
- **JSON** (só `setup apply`): `--stdin` com heredoc `<<'OPC_JSON'`.

**Flags comuns a todos:** `--json`, `--cwd <dir>`, `-m` (alias de `--model`).

**Modelo invoca?:** "não" = `disable-model-invocation: true`.

| Comando | Fase | Modelo invoca? | Função e flags |
|---|---|---|---|
| `/opc:setup` | F0 (diagnóstico), F1 (onboarding) | sim | Diagnóstico, instalação guiada e onboarding. `--reconfigure`, `--stop-server [--force]`, `--enable-review-gate`, `--disable-review-gate` (F2b) |
| `/opc:config` | F1 | não | `get`, `set`, `unset`, `add`, `remove`, `show`, `validate`, `path` (§3.3) |
| `/opc:providers` | F1 | sim | Providers conectados (`--all` para o catálogo), com a política aplicada |
| `/opc:models` | F1 | sim | `[provider] [--verbose] [--allowed] [--all]`: variants, limites, custo |
| `/opc:agents` | F1 | sim | `[--mode primary\|subagent\|all] [--verbose] [--allowed]` |
| `/opc:catalog` | F1 | sim | `commands` ou `skills` do OpenCode |
| `/opc:task` | F2a | sim | `[prompt] --model m --agent a --variant v --effort e --tier t --write --profile nome --resume [id] --resume-last --fresh --background --prompt-file f --timeout s --wait-timeout s`. Prompt também por stdin |
| `/opc:ask` | F2a | sim | Pergunta/análise read-only (`ask.md`, rota `routing.tasks.ask`) |
| `/opc:plan` | F2a | sim | Plano read-only (`plan.md`, rota `routing.tasks.plan`) |
| `/opc:status` | F2a | não | `[job-id] [--wait] [--timeout-ms 240000] [--poll-interval-ms 2000] [--all]`. `--wait` exige id |
| `/opc:result` | F2a | não | `[job-id]`; job ativo → erro "ainda em execução" (inclui `waiting_permission`) |
| `/opc:cancel` | F2a | não | `[job-id]`; sem id → o único job ativo da sessão do Claude, ou erro se houver vários |
| `/opc:permissions` | F2a | sim | `list`, `reply <id> once\|reject [msg]`, `answer <id> <resposta...>` |
| `/opc:rescue` | F2b | sim | Delegação via agente `opc-rescue` (UX do `/codex:rescue`, com a pergunta de continuar ou começar sessão) |
| `/opc:review` | F2b | não | `[--wait\|--background] [--base ref] [--scope auto\|working-tree\|branch] [--model] [--variant]` |
| `/opc:adversarial-review` | F2b | não | Igual ao review, mais o texto livre de foco |
| `/opc:sessions` | F3 | sim | Lista as sessões `OPC:` do workspace (`--all` para todas) |
| `/opc:session` | F3 | sim | `new [--title] [--agent] [--model]`, `show <id>`, `fork <id> [messageID]`, `revert <id> <messageID>`, `unrevert <id>`, `summarize <id> [--model]`, `children <id>`, `diff <id>`, `todo <id>` |
| `/opc:subagent` | F3 | sim | `--agent a[,b,c] [--model m[,m2,m3]] <prompt>`: N jobs paralelos, um por agente/modelo |
| `/opc:command` | F3 | sim | `<cmd> [args] [--agent] [--model]` — roda um slash command do OpenCode |
| `/opc:attach` | F3 | não | Imprime `opencode attach <url> -s <id> --dir <ws>`; `--pane` abre num split do tmux |
| `/opc:orchestrate` | F4b | sim | `<tarefa> [--planner m] [--max N] [--synthesizer claude\|<modelo>] [--write]` |
| `/opc:conclave` | F4c | sim | `<pergunta> [--models a,b,c \| --pool nome] [--mode opinion\|review\|debate] [--rounds 1-3] [--judge claude\|<modelo>] [--quorum N] [--allow-judge-member]` |
| `opc monitor` (terminal) | F4a | — | Acompanhamento ao vivo de todos os jobs do workspace |
| `opc gc` (terminal) | F2a | — | Limpeza de estados antigos (§3.2) |
| `/opc:transfer` | F5 | não | Claude JSONL → sessão OpenCode (`opencode import`) |

**Regras transversais:**

- `--effort` é alias de `--variant` (validado contra as variants do modelo).
- `--resume` e `--fresh` juntos → erro de uso. `--resume` sem prompt usa `prompts/continue.md`.
- `revert`/`unrevert` mostram o diff afetado e exigem `--confirmed-by-user`, que a skill
  `opc-result-handling` só passa após AskUserQuestion. O mesmo vale para
  `--stop-server --force`.
- `/opc:setup --stop-server` com jobs ativos (de qualquer sessão) → recusa, listando-os.

### 4.1 Exit codes (todos os subcomandos)

| Código | Significado |
|---|---|
| 0 | Sucesso (inclui review com veredito `needs-attention`) |
| 2 | Erro de uso (flags inválidas, conflito, id ausente, limite de jobs) |
| 3 | Aguardando permissão ou resposta (job vivo em `waiting_permission`) |
| 4 | Negado pela política (modelo, agente, provider, ferramenta ou chave travada) |
| 5 | Conexão/servidor (`ServerDown`, `AuthFailed`, `UnsupportedVersion`, boot falhou) |
| 6 | Timeout de espera do comando (`--wait-timeout`; o job continua, e o id é impresso) |
| 7 | Job terminou em `failed` |
| 130 | Job `cancelled` |

---

## 5. Integridade da conexão (D7)

### 5.1 `ensureServer()`: subir ou reaproveitar

1. Obtém o `server.lock` (§5.6). Serializa spawns do mesmo workspace.
2. **Modo attach** (`OPC_SERVER_URL`): exige `http://127.0.0.1`/`localhost` ou `https://`;
   valida o health com `OPC_SERVER_PASSWORD` e retorna. O plugin nunca sobe nem derruba esse
   servidor; o `configOverride` e o plano B do §15 não se aplicam (limitação documentada).
3. Se `server.json` existir, confere a **identidade do processo**: pid vivo, cmdline contendo
   `opencode` + `serve` + `--port <porta>`, e `startTime` igual ao registrado
   (Linux: `/proc/<pid>/stat`; macOS: `ps -o lstart=`).
   - **Identidade não confere:** o registro está velho; apaga `server.json` sem sinalizar
     ninguém.
   - **Identidade confere e o health responde** `healthy:true` em até 2 s com a versão
     registrada: reaproveita.
   - **Identidade confere, mas o health falha** (servidor travado): encerra (§5.5) e sobe
     outro.
   - **Identidade confere, versão diferente** (OpenCode atualizado): encerra se não houver
     jobs ativos; senão reaproveita e avisa.
4. **Escolha de porta:** abre um socket em `127.0.0.1:0`, lê a porta e fecha.
5. **Spawn:** `opencode serve --port N --hostname 127.0.0.1`, com `detached: true`, cwd no
   workspace e stdout/stderr redirecionados para `server.log` (nunca por pipe para o processo
   pai, que é de vida curta). Ambiente:
   - `OPENCODE_SERVER_PASSWORD` = 24 bytes aleatórios (hex);
   - `OPENCODE_CONFIG_CONTENT` = `server.configOverride`;
   - `OPC_INSIDE_SERVER=1` (§9.1).
6. **Espera** a linha `opencode server listening on http://127.0.0.1:<N>` no `server.log`,
   **com N igual à porta pedida**, até `bootTimeoutSec`; em paralelo, faz polling de
   `/global/health` como fallback caso o formato do log mude.
   - Falha (porta diferente, `EADDRINUSE`, processo morto, timeout) → encerra (§5.5) e
     tenta outra porta, até **3 tentativas**.
7. **Versão:** `/global/health.version` ≥ `1.18.0`; abaixo disso, `UnsupportedVersion`.
8. **Registro:** grava `server.json` (escrita atômica: tmp + rename, modo 600).
9. **Aquecimento:** `GET /agent?directory=<workspace>` com timeout de `bootTimeoutSec`.
10. **Checagens de mundo:**
    - `GET /config`: se `small_model` ou `model` forem negados pela política, emite aviso
      (sugerindo `server.configOverride`);
    - se `share` for `auto` e o override não o desligar, recusa criar sessões até o
      operador ajustar.

### 5.2 HTTP (`http.mjs`)

- Cada request usa um timeout (`requestTimeoutSec`); rotas longas (aquecimento, `/command`
  síncrono) passam timeout explícito. Todos os prazos usam relógio monotônico
  (`performance.now()`).
- Erros tipados: `ServerDown` (ECONNREFUSED/ECONNRESET/socket fechado), `AuthFailed` (401),
  `NotFound` (404), `BadRequest` (400, com o corpo redigido), `Timeout`, `ServerError` (5xx).
- `ServerDown` → um único `ensureServer()` e repetição, **só** para GET e para requests com
  chave de deduplicação.
- `prompt_async` sempre leva um `messageID` gerado pelo cliente (formato `msg…`, A CONFIRMAR
  §15). Reenvio só depois de conferir, nas mensagens da sessão, que esse `messageID` não
  chegou.
- `AuthFailed` falha na hora, sem retry.
- Nenhuma mensagem de erro inclui headers, a senha ou URL com credencial.

### 5.3 SSE (`sse.mjs`)

- **Uma** conexão `GET /event?directory=...` por processo; conecta **antes** do primeiro prompt
  e distribui os eventos aos turnos acompanhados.
- **Parser:** frames `data:`; ignora comentários. `server.heartbeat` (a cada 10 s) e
  `server.connected` são eventos normais.
- **Liveness:** qualquer evento renova o prazo; 30 s sem nenhum evento = conexão morta.
- **Reconexão:** backoff de 0,5 / 1 / 2 / 4 / 8 s, até 5 tentativas; depois `ServerDown`.
  `server.instance.disposed` também dispara reconexão.
- **Ressincronização obrigatória** após reconectar: `GET /session/status` (ausente = idle),
  as últimas mensagens de cada sessão acompanhada e `GET /permission` + `GET /question`
  (pedidos perdidos durante a queda).
- **Sessões filhas:** um `session.created` com `parentID` de sessão acompanhada inclui a filha
  no roteamento, para que pedidos de permissão e pergunta dela cheguem ao job (§8.2).

### 5.4 Queda do servidor no meio de um turno

O job termina `failed` com `errorCode: "server_lost"`, preservando `sessionID`, e a mensagem
orienta `--resume`. Nada é reexecutado sozinho, e isso **não** dispara fallback de modelo.

### 5.5 Encerramento

Ordem: `POST /global/dispose` (3 s) → SIGTERM no grupo (`kill(-pid)`) → 3 s → SIGKILL no grupo.
Antes de **cada** sinal, a identidade do processo (§5.1.3) é conferida de novo. Processo que
não seja o servidor registrado **nunca** recebe sinal.

Gatilhos:
- o reaper (§9.3);
- `/opc:setup --stop-server` (sem jobs ativos, ou `--force` confirmado pelo usuário);
- falha de boot (§5.1.6);
- servidor travado ou com versão trocada (§5.1.3).

### 5.6 Locks (`locks.mjs`)

- **Criação:** arquivo com `O_EXCL`, contendo `{pid, startTime, acquiredAt, purpose}`.
- **Quebra de lock órfão:** quando a identidade do dono não confere (pid morto ou
  reutilizado), o lock é quebrado. A quebra é atômica: renomeia para `*.stale-<ts>` e tenta
  de novo.
- **Timeouts:**
  - espera por `server.lock`: `4 × bootTimeoutSec` (cobre 3 boots + aquecimento);
  - espera por `state.lock`: 10 s;
  - espera por `session-<id>.lock`: nenhuma (falha imediata, §9.2).

---

## 6. Resolução de modelo, agente e variant

1. **Níveis, em ordem.** Vale o primeiro nível não vazio:
   1. `--model` explícito (alias, ID completo ou nome curto no `defaultProvider`);
   2. `--tier` → `routing.tiers.<tier>` (lista);
   3. o modelo específico do tipo, se não for nulo: `reviewModel`, `stopGate.model`,
      `orchestrate.planner`, `orchestrate.synthesizer` (se modelo), `conclave.judge`
      (se modelo), modelo do `summarize`;
   4. a rota do tipo de tarefa (`routing.tasks.<kind>`, lista);
   5. `defaultModel`;
   6. o default global do OpenCode (`GET /config` → `model`);
   7. nenhum → erro pedindo `--model`.
2. **Parse:** conforme §3.2 (ID completo normalizado). Aliases são expandidos antes, com no
   máximo 1 nível.
3. **Validação:**
   - modelo: contra `/provider` (`all[p].models[modelID]` existe e `p` está em `connected`);
   - variant: contra as chaves de `models[modelID].variants`;
   - agente: contra `/agent` (existe; o modo é compatível com o uso).
4. **Modelos fixados:** se o agente escolhido (ou o command do OpenCode, no `/opc:command`)
   fixa um `model`/`agent` na própria config, esse valor também passa pela política. Negado
   → recusa, exit 4.
5. **Política:**
   - aplicada a **todo** modelo que o plugin usa: turnos, juiz, sintetizador, planner,
     summarize, stop gate, membros do conclave e subtarefas;
   - nas listas (tier/rota), entradas inválidas ou negadas são **puladas com aviso**; se não
     sobrar nenhuma, erro listando cada entrada e o motivo;
   - valor único negado → exit 4.
6. **Fallback:** só as listas (níveis 2 e 4) participam (§10.2). `--model` explícito e os
   níveis de valor único nunca têm fallback.
7. **Momento:** tudo isso ocorre **antes** de criar sessão.

---

## 7. Fluxo de um turno (`runner.mjs`, `errors.mjs`)

**Entrada:** `{workspace, prompt|parts, model, agent?, variant?, profile, sessionID?, format?,
title, kind, projectContext?}`.

1. **Sessão:**
   - nova: `POST /session {title:"OPC: <kind>: <resumo 56>", permission: <regras do perfil §8>}`;
   - resume: sessão existente. Com perfil diferente, `PATCH /session/:id {permission}`. Pelo
     código, o PATCH **anexa** as regras, então trocar para `read-only` ou `custom` funciona
     (as regras novas vencem por serem as últimas), e trocar para `write` é recusado com
     exit 2 antes do PATCH. A F2a confirma ao vivo (§15).
2. **Contexto do projeto:** bloco `<project_context>` (objetivo, escopo, tipos de tarefa), se
   configurado.
3. **SSE** ativo e com a sessão registrada no roteamento (§5.3).
4. **Envio:** `POST /session/:id/prompt_async {messageID, model:{providerID,modelID}, agent,
   variant, format?, parts}` → 204. Uma resposta 400 é erro fatal com o corpo redigido.
5. **Progresso:** `message.part.updated`/`delta` viram fases:
   - `starting`, `running`;
   - `investigating` (read/grep/glob/list);
   - `editing` (edit/write/apply_patch);
   - `verifying` (bash com test/lint/build);
   - `subagent` (tool `task`);
   - `retrying` (`session.status{type:"retry"}`, com attempt e motivo);
   - `finalizing`.

   As fases vão para stderr e para o log do job.
6. **Permissões e perguntas:** §8.2.
7. **Fim:** `session.idle` ou `session.status{type:"idle"}` da sessão, ou ressincronização.
   Depois, `GET /session/:id/message` extrai:
   - texto final;
   - `info.structured`;
   - `info.error`;
   - arquivos tocados (partes `tool` concluídas de edit/write/apply_patch, mais o
     `session.diff`);
   - ferramentas executadas (qualquer parte `tool` concluída);
   - sessões filhas;
   - `tokens`/`cost`.

   Um `session.error` da sessão também encerra o turno com o erro recebido.

### 7.1 Classificação de erros (`errors.mjs`)

| Erro | Classe |
|---|---|
| `APIError` com `isRetryable: true`, ou `statusCode` 404 (modelo indisponível) | `recoverable` |
| Retry do OpenCode acima do teto: `attempt` > `maxProviderRetries` ou `next` > `maxRetryWaitSec` → o plugin aborta a sessão | `recoverable` |
| Timeout do turno (`--timeout`, padrão 30 min) → abort | `recoverable` |
| `StructuredOutputError` sem nenhuma ferramenta executada | `recoverable` |
| `StructuredOutputError` com ferramentas executadas | `fatal` |
| `ContextOverflowError` | `recoverable` só para um candidato com `limit.context` maior; senão `fatal` |
| `ProviderAuthError`, `MessageAbortedError`, `ContentFilterError`, `MessageOutputLengthError`, `UnknownError`, `APIError` não repetível (e ≠ 404), `BadRequest` | `fatal` |
| `server_lost`, cancelamento | nunca dispara fallback |

`StructuredOutputError` gera ainda a saída degradada (texto bruto), qualquer que seja a classe.

**Saída do runner:** `{status, errorClass?, errorType?, sessionID, model, finalText, structured,
error, touchedFiles, toolsRan, childSessionIDs, usage}`.

---

## 8. Permissões (D8)

### 8.1 Perfis e invariantes (aplicados no `POST /session`)

Regras no formato `{permission, pattern, action}`. O OpenCode avalia "última que casa vence",
então a ordem abaixo é a ordem de envio.

**`read-only`** (review, adversarial-review, stop gate, ask, plan, conclave,
decomposição/síntese, `task` sem `--write`):

1. `{"*","*","deny"}` — nega tudo por padrão.
2. `allow`: `read *`, `glob *`, `grep *`, `list *`, `lsp *`, `skill *`, `todowrite *`.
3. Nada de bash (a coleta de diff é sempre feita pelo companion, §9.4), edit, task,
   webfetch, websearch, question ou doom_loop.
4. Invariantes (abaixo).

**`write`** (`task --write`, `rescue`, subtarefas de escrita da orquestração): herda o agente
(`build`) e as regras do usuário, mais as invariantes.

**`custom:<nome>`**: base `read-only` + as regras de `permissionProfiles.<nome>` + as
invariantes.

**Invariantes**, sempre anexadas **por último**, em todos os perfis:

1. `external_directory *` → `deny`.
2. Para cada padrão de `policy.sensitivePaths`: `read <padrão>` → `deny`. Também
   `grep`/`list`/`glob`, se os padrões dessas chaves forem caminhos (A CONFIRMAR, §15).
3. Para cada agente negado: `task <glob>` → `deny`, para que o OpenCode não dispare por conta
   própria um subagente fora do mundo.
4. Para cada padrão de `policy.tools.deny`: `<padrão> *` → `deny` (ferramentas MCP do
   usuário, pelo nome; A CONFIRMAR, §15).
5. Só no `write`: `bash <padrão>` → `ask` para a lista destrutiva embutida (espelho do §2.2 do
   operador), mais `policy.destructiveBash`:
   `rm -rf*`, `rm -r *`, `rm -fr*`, `git push --force*`, `git push -f*`, `git push --delete*`,
   `git reset --hard*`, `git clean -f*`, `git branch -D*`, `git tag -d*`, `docker rm*`,
   `docker rmi*`, `docker volume rm*`, `docker system prune*`, `docker compose down -v*`,
   `kubectl delete*`, `mkfs*`, `dd *of=*`, `shred*`, `truncate -s 0*`, `find * -delete*`,
   `shutdown*`, `reboot*`, `poweroff*`, `systemctl stop*`, `*DROP DATABASE*`, `*DROP TABLE*`,
   `*TRUNCATE*`. Esses pedidos vão **sempre** ao usuário, qualquer que seja o aprovador.
6. `doom_loop *` → `ask` no `write` (via ponte); `deny` no `read-only`.

- Não existe perfil ou flag "libera tudo".
- **Sessões filhas:** herdam do pai só `deny` e `external_directory`. Por isso o runner
  aplica o perfil completo do job (via `PATCH`) a cada filha assim que recebe o
  `session.created` dela.
- Se as invariantes 2 e 4 não funcionarem como descrito (§15), o plano B é injetar um agente
  `opc-readonly` via `server.configOverride`.

### 8.2 Ponte de pedidos (`permission.asked` / `question.asked`)

- **Execução em worker:** todo turno roda num worker (§9.1). O comando em foreground só
  espera.
- **Foreground:**
  1. Surge um pedido (da sessão ou de uma filha): o job vai para `waiting_permission` com
     `pendingRequest`.
  2. O comando sai com exit 3, imprimindo id, ferramenta, padrões, sessão, job e as linhas
     prontas `/opc:permissions reply <id> once|reject` e `/opc:status <job> --wait`.
  3. O worker continua vivo até a resposta ou até `permissionTimeoutSec`.
- **Background:** mesmo estado. Sem resposta dentro do prazo → `reject` com a mensagem
  "opc: no approver available".
- **`read-only` e stop gate:** qualquer pedido recebe `reject` imediato (defesa em
  profundidade; o perfil não deveria gerar pedidos).
- **Irmãos:** um `reject` rejeita os outros pendentes da mesma sessão. O job remove esses
  pedidos do `pendingRequest` ao receber `permission.replied`.
- **Perguntas:**
  - `/opc:permissions answer <id> <resposta...>` → `POST /question/:id/reply
    {answers: string[][]}`, uma lista de rótulos por pergunta, na ordem de
    `questions[]`;
  - suporta várias perguntas e `multiple`;
  - com `custom`, o texto livre vira o rótulo;
  - timeout → `POST /question/:id/reject`.

### 8.3 Aprovador e `always`

- **`always` nunca é usado.** No OpenCode 1.18.32, o `always` fica em memória para o
  diretório inteiro, vale para todas as sessões e passa por cima do `deny` da sessão.
  `reply` só aceita `once` ou `reject`.
- **`approver: "user"` (padrão):** a skill `opc-result-handling` obriga o Claude a apresentar
  o pedido e perguntar ao usuário (AskUserQuestion) antes de qualquer `reply`.
- **`approver: "claude"`:** o Claude pode responder `once`/`reject` sozinho, **exceto** em
  pedidos que casem com a lista destrutiva (§8.1, invariante 5), com `external_directory` ou
  com `sensitivePaths`. Esses exigem o usuário: o companion recusa sem `--confirmed-by-user`.
- **Worker e rescue:** `opc-worker` e `opc-rescue` **nunca** respondem permissões; devolvem o
  pedido ao líder.

### 8.4 Lado Claude Code

- `allowed-tools` mínimos: `Bash(opc:*)`; `Bash(git:*)` onde o codex usa; `AskUserQuestion`
  onde há pergunta; `Agent` no `/opc:rescue`; `Bash(npm:*)` só no `/opc:setup`;
  `Bash(tmux:*)` só no `/opc:attach`.
- Nenhuma flag de bypass (`--no-verify`, `--dangerously-*`).
- O `/opc:rescue` traz a nota do codex: não chamar a skill `rescue` a partir do próprio
  comando (evita travar).

---

## 9. Jobs, background, hooks e review

### 9.1 Jobs (`jobs.mjs`)

- **Registro:** `{id, kind, title, summary, workspaceRoot, claudeSessionId, groupId?, role?,
  status, phase, createdAt, updatedAt, startedAt, completedAt, pid, pidStartTime, logFile,
  serverUrlRef, sessionID, parentSessionID, childSessionIDs, model, attempts[], agent, variant,
  permissionProfile, pendingRequest, errorCode, errorClass, errorType, errorMessage, request?,
  result?, rendered?}`.
  - `serverUrlRef` é só `host:port`.
  - `attempts[]` guarda `{model, sessionID, status, errorClass, startedAt, endedAt}`.
- **Status:** `queued | running | waiting_permission | completed | failed | cancelled`.
- **Id:** `<task|review|ask|plan|sub|orch|conc|gate>-<base36(ms)>-<rand6>`.
- **Grupos** (`orchestrate`, `conclave`, `subagent` com N): um job-grupo (`groupId`) + N
  membros (`role`: `planner`, `worker:<n>`, `member:<rótulo>`, `judge`, `synthesizer`).
  `status`, `result` e `cancel` do grupo agregam os membros; cancelar um membro aborta só a
  sessão dele.
- **Limites:**
  - `jobs.maxActive` (padrão 8): acima disso, novos jobs são recusados (exit 2 com a lista
    dos ativos);
  - `jobs.maxParallel` (padrão 4): turnos simultâneos dentro de um grupo.
- **Poda:** mantém no máximo 50 jobs **terminais** (um grupo conta como um). Jobs ativos
  nunca são podados.
- **Execução uniforme:** todo turno roda num worker `opc task-worker --job-id <id>` com
  `detached`, `stdio: ignore` e `unref`. O worker relê o `request` do arquivo do job, chama
  `ensureServer()` e roda o runner.
  - Um grupo tem **um** worker coordenador, que dispara os membros como turnos concorrentes no
    mesmo processo, com a conexão SSE compartilhada.
  - **Foreground:** o comando acompanha o log do job em stderr até o fim, até exit 3 ou até
    `--wait-timeout`. No `--wait-timeout`, o comando sai com exit 6 e o job **continua**.
    Já o `--timeout` do turno **aborta** o job.
  - **Background:** retorna na hora com o id.
- **Cancel:**
  1. `POST /session/:id/abort`;
  2. espera o idle por até 10 s;
  3. encerra o worker, conferindo antes a identidade (cmdline contendo
     `opc-companion.mjs task-worker --job-id <id>` e `pidStartTime` igual);
  4. marca `cancelled`.

  Pid cuja identidade não confere nunca recebe sinal; o job é só marcado.
- **Recursão:** o servidor roda com `OPC_INSIDE_SERVER=1`, e o companion recusa criar jobs
  quando essa variável está presente (evita que um bash do OpenCode chame o `opc` de volta).

### 9.2 Resume e concorrência por sessão

- **`--resume <id>`:** usa a sessão do job ou a sessão dada.
- **`--resume-last`:** o último job terminado **do mesmo kind** e da sessão do Claude atual.
  Sem sessão do Claude, exige id explícito (não adivinha pelo título).
- **`opc task-resume-candidate --json`:** devolve `{available, sessionId, candidate}`. É o que
  o `/opc:rescue` usa para perguntar "continuar ou começar nova".
- **Concorrência:** um job ativo por sessão OpenCode (`session-<id>.lock`). Um segundo resume
  na mesma sessão falha na hora (exit 2).

### 9.3 Hooks

- **`SessionStart`:**
  - exporta `OPC_COMPANION_SESSION_ID`, `OPC_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA`
    e `OPC_DATA_DIR` via `$CLAUDE_ENV_FILE`;
  - registra `{sessionId, pid: ppid, pidStartTime, startedAt}` em `claudeSessions` (se o
    `ppid` é o processo do Claude: A CONFIRMAR, §15; fallback: entrada órfã após 24 h);
  - com `delegation.auto`, devolve `hookSpecificOutput.additionalContext` com o lembrete de
    delegação (§10.4).
- **`SessionEnd`** (orçamento de 1,5 s): só registra o fim e dispara um **reaper destacado**
  (`opc reap --session <id> --reason <reason>`, `detached`, `unref`), saindo em menos de 1 s.
  O reaper:
  1. cancela, em paralelo e com teto total de 15 s, os jobs ativos dessa sessão;
  2. remove a sessão de `claudeSessions`;
  3. com `reason` = `clear` ou `resume`, **não** encerra o servidor (uma nova sessão vem em
     seguida);
  4. caso contrário, espera uma carência de 60 s e, **sob `server.lock`**, encerra o
     servidor (§5.5) se: foi o plugin que o subiu, não sobrou sessão viva no registro (vivas
     = pid com identidade conferida, ou entrada com menos de 24 h) e não há jobs ativos.
- **Reaproveitamento sob lock:** "reaproveitar o servidor e registrar o job" também ocorre sob
  `server.lock`, o que fecha a corrida com o reaper.
- **`Stop`** (timeout explícito de 900 s no `hooks.json`):
  - Sempre: se houver jobs ativos da sessão, escreve em stderr a nota "job X ainda em
    execução" (paridade com o codex).
  - Gate desligado → permite.
  - `stop_hook_active: true` → permite.
  - OpenCode ausente, servidor que não sobe, modelo negado ou qualquer erro de execução →
    **permite**, com `systemMessage` de aviso (não bloqueia o usuário por falha de
    infraestrutura).
  - Caso contrário, roda um turno kind `stop-gate` (perfil `read-only`, modelo
    `stopGate.model` → `defaultModel`) com `stop-review-gate.md` preenchido com
    `last_assistant_message`. Se esse campo faltar, usa a última mensagem do assistente em
    `transcript_path`.
  - Resultado: primeira linha `ALLOW:` → permite; `BLOCK: <motivo>` →
    `{"decision":"block","reason":...}` com exit 0; saída que não siga o formato → permite,
    com aviso.

### 9.4 Review e adversarial-review

- **Coleta, sempre pelo companion** (porte de `git.mjs` do codex):
  - seleção de alvo com `--base`/`--scope` (auto/working-tree/branch);
  - inclui staged, unstaged e untracked;
  - diff até 400 KB vai inline;
  - acima disso, entra o `--stat` completo mais os diffs por arquivo em ordem de tamanho
    crescente até o limite, e o agente lê os arquivos alterados com a ferramenta `read`
    (permitida; bash não).
- **Fluxo do comando** (paridade com o `review.md` do codex): sem `--wait`/`--background`, o
  comando mede o tamanho do diff (`git status --short --untracked-files=all`,
  `git diff --shortstat`) e pergunta uma vez "Esperar" ou "Background", recomendando
  background para diffs grandes.
  - Background → `opc review --background` devolve o id do job.
  - Foreground → acompanha o job.
  - O comando não corrige nada (a skill manda parar e perguntar).
- **`/opc:review`:** `review.md` + `format.json_schema` com `review-output.schema.json` (o
  schema do codex).
- **`/opc:adversarial-review`:** `adversarial-review.md` com o foco; mesmo schema.
- **Render:** como no codex:
  - findings por severidade, com `file:start-end`;
  - "No material findings." quando vazio;
  - status compacto (no máximo 8 jobs recentes, 4 linhas de progresso);
  - `StructuredOutputError` → texto bruto.

---

## 10. Swarm (D11)

### 10.1 Modos ask e plan

- `/opc:ask`: perfil read-only; `ask.md` (resposta concisa, `file:line`, sem preâmbulo); rota
  `routing.tasks.ask`.
- `/opc:plan`: perfil read-only; `plan.md` (arquivos, ordem, trade-offs, riscos, testes);
  rota `routing.tasks.plan`.
- Os dois aceitam as flags de modelo, `--background` e `--resume`, como o `task`.

### 10.2 Roteamento e fallback

- As listas são tentadas em ordem, pulando entradas negadas ou inválidas (§6, item 5).
- **Fallback** (`routing.fallback.enabled`): um turno que termina com `errorClass:
  recoverable` (§7.1) gera uma **nova sessão** com o próximo candidato e o mesmo prompt, até
  `maxAttempts`, com backoff de 2 s / 4 s / 8 s. Cada tentativa vai para `attempts[]`.
- **Sem fallback quando:**
  - houve `--model` explícito ou nível de valor único;
  - o erro é `fatal`;
  - houve `server_lost` ou cancelamento;
  - é um turno `--write` em que **qualquer ferramenta rodou** (evita duplicar efeitos). Nesse
    caso, falha listando arquivos tocados e ferramentas executadas.
- **Teto de retries do OpenCode:** como o OpenCode repete erros repetíveis sozinho, o runner
  aborta a sessão quando `attempt` > `maxProviderRetries` ou `next` > `maxRetryWaitSec`, e
  classifica como `recoverable` para o fallback agir.

### 10.3 Orquestração (`/opc:orchestrate`)

1. **Decomposição:** o planner, numa sessão read-only, recebe tarefa, contexto do projeto e
   `orchestrate-decompose.md`. O schema `orchestrate-plan` pede
   `{subtasks:[{id, title, prompt, kind: ask|plan|review|task, tier?: light|heavy, agent?,
   files?: [], dependsOn:[]}], rationale}`, com de 2 a `maxSubtasks` itens.
2. **Validação do plano:**
   - sem ciclos;
   - `task` (escrita) só se a chamada tiver `--write`;
   - agentes pela política;
   - plano inválido → falha com o motivo e o plano bruto.
3. **Execução:**
   - subtarefas prontas (dependências concluídas) rodam em paralelo até `jobs.maxParallel`;
   - **subtarefas de escrita rodam uma de cada vez**, em série (sem worktrees);
   - a rota de cada subtarefa: `tier` presente → `routing.tiers.<tier>`; senão
     `routing.tasks.<kind>`;
   - modelos espalhados: o primeiro candidato ainda não usado no grupo, senão rodízio;
   - o resultado de cada dependência (truncado em 8 KB) entra no prompt da dependente como
     `<dependency id="…">`.
4. **Síntese:**
   - `claude` (padrão): o resultado entrega o pacote estruturado, e a skill `opc-delegation`
     orienta o Claude a validar e sintetizar;
   - `<modelo>`: uma sessão read-only com `orchestrate-synthesize.md`, e o Claude recebe a
     síntese e os brutos.
5. **Falhas:** dependentes de uma subtarefa que falhou → `cancelled/dependency_failed`;
   independentes continuam. `StructuredOutputError` no planner → falha do grupo; numa
   subtarefa → falha da subtarefa. O grupo termina `completed` com avisos, ou `failed` se
   todas falharem.

### 10.4 Delegação automática e worker para Agent Teams

- **Skill `opc-delegation`:**
  - delegar análise, perguntas sobre o código, review, planejamento e investigação
    (`ask`/`plan`/`review`/`orchestrate`);
  - não delegar tarefa trivial nem edição pequena;
  - validar o retorno antes de apresentar;
  - respeitar política e aprovador;
  - nunca encadear delegação (um job não dispara outro via Claude sem pedido do usuário).
- **`delegation.auto`:** ligado → o SessionStart injeta um lembrete curto; desligado → a skill
  só é usada quando o usuário pede.
- **Agente `opc-worker`** (ferramentas: Bash; em Agent Teams, SendMessage/Task* são
  adicionadas pelo Claude Code). As regras vão **inline** no corpo do agente, porque `skills:`
  não se aplica a teammates. Protocolo:
  1. `⚡ opc | <resumo>` ao líder;
  2. **um** `opc ask|plan|review|task …` com as flags recebidas, via heredoc;
  3. `✓ opc done` + resultado, ou `✗ opc failed` + erro, sem fazer a tarefa por conta própria;
  4. próxima tarefa.
  - Pedido de permissão → devolve ao líder (§8.3).
  - Sem ferramenta Agent (não cria subagentes).
  - Sem Agent Teams habilitado, funciona como subagente comum.
- **Agente `opc-rescue`:** como o `codex-rescue`: Bash-only; usa `--write` por padrão, salvo
  pedido de read-only; retorna a saída verbatim e **nada** em caso de falha.

### 10.5 Monitor

- `opc monitor [--job id]` (terminal): atualiza a cada 1 s a partir de `state.json` e dos logs
  (fase, modelo, tentativa, pedidos pendentes); texto simples com cor opcional.
- `/opc:attach --pane`, **só por invocação do usuário**: dentro do tmux, abre um split que
  executa `opencode attach …` com `OPENCODE_SERVER_PASSWORD` lido, dentro do próprio pane, de
  um arquivo de modo 600. A senha nunca aparece em argv visível. O mecanismo exato de leitura
  (arquivo de senha dedicado ou extração curta do `server.json`) é definido na F3.

---

## 11. Conclave (D12)

### 11.1 Fluxo

1. **Composição:**
   - `--models` ou `--pool`;
   - cada membro passa pela política, e os negados são removidos com aviso;
   - **mínimo de 2 membros**; `quorum` deve estar entre 2 e o total de membros (erro de uso,
     exit 2);
   - rótulos aleatórios `A`, `B`, `C`…; o mapeamento rótulo → modelo fica só no job;
   - `--mode debate` implica `rounds ≥ 2` (padrão 2); `rounds` fica entre 1 e 3.
2. **Rodada 1 (cega):** mesmo contexto e pergunta para todos, cada um numa sessão read-only,
   em paralelo, com `conclave-member.md`. Schema `conclave-member`:
   `{position, confidence (0..1), key_points[], risks[], evidence:[{file, line_start, line_end,
   note}], would_change_mind_if}`.
3. **Rodadas 2..N:**
   - cada membro recebe as respostas dos outros **anonimizadas**, na mesma sessão dele, com
     `conclave-debate.md`;
   - devolve o mesmo schema + `critiques:[{target, point}]` + `changed: bool`;
   - antes do repasse, nomes de modelos, vendors e providers conhecidos são **removidos** do
     texto (lista montada a partir do `/provider`).
4. **Quorum:** membro que falha, estoura `memberTimeoutSec` ou devolve `StructuredOutputError`
   é descartado da rodada e listado em "falhas". Respostas válidas abaixo do `quorum` → grupo
   `failed`, entregando o que houver.
5. **Síntese:**
   - `judge: "claude"` (padrão): pacote estruturado; a skill `opc-conclave` orienta a síntese
     (consenso, divergências, posição ponderada pela confiança, recomendação).
   - `judge: <modelo>`: sessão read-only com `conclave-judge.md` e o schema
     `conclave-synthesis`:
     `{consensus[], disagreements:[{topic, positions:[{members[], stance}]}],
     weighted_position, confidence, recommendation, minority_reports[]}`.
     O juiz vê só rótulos. Juiz que também seja membro exige `--allow-judge-member`.

### 11.2 Modo review

- Cada membro roda o review (§9.4) com `review-output`, sobre o mesmo alvo git.
- **Deduplicação:** findings entram no mesmo cluster quando estão no mesmo `file`, com linhas
  que se sobrepõem ou distam até 3, **e** com similaridade de título (Jaccard de tokens)
  ≥ 0,3. Findings sem `file` nunca são agrupados.
- **Cluster:** severidade máxima, concordância `k/N` (N = membros válidos), confiança média,
  rótulos que o encontraram, e corpo/recomendação do membro de maior confiança.
- **Veredito:** `needs-attention` se algum cluster com severidade ≥ high tiver concordância
  ≥ 2, ou se mais da metade dos membros válidos der `needs-attention`.

### 11.3 Saída

- **Cabeçalho:** composição (rótulos → modelos, no fim), rodadas, quorum, falhas e duração.
- **Corpo:** conforme o modo.
- `--json` devolve o pacote completo.

---

## 12. Documentação (D13)

- **Idioma:** PT-BR (código, comandos e identificadores em inglês).
- **Arquivos:**
  - `README.md`: o que é, requisitos, instalação, início rápido (onboarding → primeiro
    review), mapa de comandos;
  - `docs/installation.md`: marketplace local, `bin/opc`, alias de terminal, versões;
  - `docs/configuration.md`: todas as chaves do §3.2, merge restritivo, chaves travadas,
    onboarding, exemplos de perfil de mundo;
  - `docs/commands.md`: referência de cada comando, flags, exit codes, exemplos e saídas
    reais. Inclui ask/plan (F2a);
  - `docs/permissions.md`: perfis, invariantes, lista destrutiva, ponte, aprovador, por que
    não há `always`;
  - `docs/swarm.md`: roteamento/fallback, orquestração, worker, delegação, monitor;
  - `docs/conclave.md`: modos, rodadas, juiz, quorum, dedupe;
  - `docs/architecture.md`: módulos, turno, ciclo de vida do servidor, estado, reaper,
    MCP (F5);
  - `docs/troubleshooting.md`: boot lento, porta, 401, servidor órfão, versão, SSE, locks;
  - `docs/phases/F<n>-report.md`;
  - `CHANGELOG.md` (Keep a Changelog), `NOTICE`, `LICENSE`.
- **Regra de portão:**
  - os comandos da fase estão documentados, com exemplos **executados de verdade**;
  - o CHANGELOG está atualizado;
  - o scanner de segredos passou em `docs/`, procurando a senha do servidor e padrões de
    token;
  - caminhos pessoais nos exemplos foram redigidos.

---

## 13. Estratégia de testes e portões por fase (D9)

### 13.1 Camadas (todas com `node:test`)

1. **`tests/unit`:**
   - `args` (inclui `--args-stdin`);
   - `models` (parse, ambiguidade, aliases, glob com `/`);
   - `routing`, `errors` (cada tipo da união → classe);
   - `policy` (merge restritivo, invariantes, ordem das regras, lista destrutiva, aprovador);
   - `config` (esquema, chaves travadas, segredos);
   - `orchestrator`, `conclave`;
   - `render` (redação de segredos), `git`, `locks`, `state`, parser SSE.
2. **`tests/integration`:** a CLI real contra `tests/fixtures/fake-opencode.mjs`:
   - é um servidor HTTP+SSE com o subconjunto usado da API v1, derivado da OpenAPI 1.18.32,
     inclusive o `server.heartbeat` de 10 s;
   - tem cenários por variável de ambiente e comportamento **por modelo**;
   - um `opencode` falso no PATH sobe o servidor falso no `serve` e grava a linha
     `listening on` no stdout.

   Cenários mínimos:
   - `ok`, `structured`, `structured-error`, `slow`;
   - `permission-ask`, `child-permission-ask`, `question-ask` (várias perguntas),
     `reject-siblings`;
   - `server-dies-mid-turn`, `sse-drop`, `no-heartbeat`, `instance-disposed`;
   - `auth-401`, `port-mismatch`, `eaddrinuse`, `boot-slow`, `hung-server`,
     `version-changed`;
   - `ignores-sigterm`, `stale-lock`, `stale-worker-pid`, `stale-server-pid`;
   - `retry-status`, `retry-over-cap`, `children`;
   - `model-429`, `model-fatal`, `write-then-fail`, `session-error-event`;
   - `decompose-cycle`, `conclave-member-timeout`;
   - `share-auto`, `pinned-denied-model`.
3. **`tests/live`:** só com `OPC_LIVE=1`; modelo via `OPC_LIVE_MODEL` (ou `OPC_LIVE_POOL`);
   diretório descartável; nunca no CI.
   - **`tests/live/contract.mjs`** grava as formas reais (respostas e eventos usados) do
     servidor 1.18.32 e compara com as do fake. Roda em todo portão.
   - **`tests/live/probe-permission-precedence.mjs`** (F0) é um script isolado: sessão com
     regras de perfil contra o config do usuário, pedidos reais e conferência de
     precedência, `always`, grep/list com caminhos e curinga de nome para MCP.

**CI:** GitHub Actions, matriz Node 20 e 22, `npm test` (unit + integração, sem OpenCode
real). `engines` no `package.json` e checagem de versão do Node em runtime.

**Testes de TTY:** `tty.mjs` recebe streams injetáveis (com `isTTY`); os testes usam entrada
roteirizada. Sem pseudo-terminal.

### 13.2 Portão de fase

Uma fase só fecha com os cinco itens:

1. `npm test` 100% verde (saída anexada).
2. Checklist ao vivo executado com modelo real (saída anexada). Itens que dependem do
   comportamento do modelo têm critério objetivo (schema válido, contagem, arquivo inalterado)
   e são repetidos 3 vezes quando instáveis (passa com ≥ 2).
3. `tests/live/contract.mjs` sem divergência, ou com divergência registrada e o fake
   atualizado.
4. Documentação da fase (§12).
5. Relatório `docs/phases/F<n>-report.md`: `PASSOU`, `N/A` (justificado), `NÃO VALIDADO`
   (motivo) e desvios. Desvio que muda interface volta para aprovação.

### 13.3 Fases, entregas e critérios de aceite

Prefixo dos modelos: `omniroute-mvalmeida/opencode-go/`, com rodízio entre as fases.

**F0 — Fundação e conexão** (ao vivo: `deepseek-v4.1-flash`)

- **Entrega:**
  - estrutura (marketplace, plugin.json, `bin/opc`, package.json com `engines`,
    LICENSE/NOTICE, README inicial, CHANGELOG);
  - módulos `args`, `http` (com redação), `sse`, `server`, `process`, `locks`, `state`,
    `config` (carga, esquema, merge restritivo);
  - `render` básico, `fake-opencode`, CI;
  - `/opc:setup` (diagnóstico, `--stop-server`), probe de precedência, `contract.mjs`.
- **Aceite (integração):**
  - sobe, reaproveita e encerra;
  - `stale-server-pid`: descartado sem sinal;
  - `hung-server`: encerrado e trocado;
  - `version-changed`: comportamento do §5.1.3;
  - dois `setup` simultâneos → um único spawn;
  - `stale-lock`: quebrado;
  - `port-mismatch`/`eaddrinuse` → nova tentativa (até 3);
  - `ignores-sigterm` → SIGKILL;
  - `sse-drop`, `no-heartbeat` e `instance-disposed` → ressincroniza;
  - `auth-401` → exit 5, sem retry;
  - versão abaixo da mínima → `UnsupportedVersion`;
  - **o spawner sai e o servidor segue reaproveitável** (sem EPIPE);
  - nenhuma saída ou log contém a senha (varredura);
  - `.opc.json` que tenta ampliar allow ou mudar chave travada → ignorado com aviso;
  - `OPC_SERVER_URL` não-loopback em http → recusado;
  - diretório de dados: o mesmo estado visto com `CLAUDE_PLUGIN_DATA` e com `OPC_DATA_DIR`;
  - permissões 700/600 conferidas;
  - `share-auto` → recusa.
- **Aceite (ao vivo):**
  - `/opc:setup` real;
  - servidor numa porta ≠ 4096, reaproveitado e encerrado sem órfão (identidade conferida);
  - os `opencode serve` preexistentes do usuário seguem vivos;
  - probe de precedência executado, com os resultados registrados nos itens do §15;
  - `contract.mjs` executado.
- **Docs:** README inicial, `installation`, `troubleshooting` (servidor, locks),
  `architecture` (conexão).

**F1 — Descoberta, configuração e onboarding** (ao vivo: `kimi-k3`)

- **Entrega:** `api` (leitura), `models`, `policy` (allow/deny), `config` completo com chaves
  travadas, `onboarding` (rascunho + commit), `tty`, `/opc:setup` (instalação guiada +
  onboarding), `opc config init`, `/opc:config`, `/opc:providers`, `/opc:models`,
  `/opc:agents`, `/opc:catalog`, perfil do projeto.
- **Aceite (integração):**
  - listagens a partir de fixtures, sem nenhuma chave de provider na saída JSON;
  - `--allowed` esconde e o uso bloqueia (exit 4);
  - merge restritivo;
  - aliases, nome curto e ambiguidade;
  - `config validate` (modelo inexistente, variant inválida, alias quebrado, chave com cara
    de segredo);
  - `setup commit` recusa um default negado;
  - interrupção do onboarding deixa só o rascunho;
  - chave travada recusada sem TTY;
  - TTY com entrada roteirizada;
  - `pinned-denied-model` → recusa;
  - `/opc:catalog` lista commands e skills.
- **Aceite (ao vivo):**
  - `/opc:models --all` bate com `opencode models` por provider;
  - `/opc:agents` bate com `opencode agent list`;
  - onboarding guiado completo nesta sessão grava a config esperada;
  - `opc config init`: validação **manual do usuário**;
  - com a config de mundo do operador, `omniroute-work/*` e `work-*` não aparecem com
    `--allowed`, e o uso explícito é recusado;
  - variant válida do `kimi-k3` aceita; inválida recusada antes da sessão.
- **Docs:** `configuration`, `commands` (descoberta/config), README (início rápido).

**F2a — Núcleo de execução** (ao vivo: `deepseek-v4.1-flash`)

- **Entrega:** `runner`, `errors`, `routing` (resolução, sem fallback), perfis e invariantes,
  aprovador, `jobs` (limites, grupos básicos, cancel com identidade), resume/concorrência;
  comandos `task`, `ask`, `plan`, `status`, `result`, `cancel`, `permissions`
  (list/reply/answer), `opc gc`; `task-resume-candidate`.
- **Aceite (integração):**
  - turno ok e estruturado;
  - background → status → result;
  - `result` de job ativo → erro;
  - `cancel` sem id (um ativo / vários ativos);
  - `cancel` durante `slow`;
  - `stale-worker-pid` → sem sinal;
  - `server-dies-mid-turn` → `server_lost`;
  - `permission-ask` foreground (exit 3) e background (espera → reply → conclui; timeout →
    reject);
  - `child-permission-ask` chega ao job;
  - `reject-siblings`;
  - `question-ask` com várias perguntas → answer; timeout → question reject;
  - `reply always` recusado;
  - destrutivo com `approver: claude` sem `--confirmed-by-user` → recusado;
  - regras do perfil enviadas exatamente como no §8.1 (asserção no fake);
  - `--model` com barras intacto;
  - `--effort` como variant;
  - `--resume` + `--fresh` → exit 2;
  - segundo resume na mesma sessão → exit 2;
  - `jobs.maxActive`;
  - `session-error-event` e `retry-status` → fases corretas;
  - `$(touch pwned)` no prompt não executa;
  - `OPC_INSIDE_SERVER=1` → recusa;
  - `<project_context>` injetado;
  - exit codes conforme o §4.1.
- **Aceite (ao vivo):**
  - `/opc:ask` e `/opc:plan` em read-only;
  - `task --write` cria um arquivo;
  - `task` read-only mandado editar → checksum inalterado;
  - read-only mandado ler `.env` de teste → negado;
  - read-only sem bash (tentativa → negada);
  - no `write`, um `rm -rf` de teste gera pedido que vai ao usuário;
  - `--background` + `status --wait` + `result`;
  - `cancel` de turno longo;
  - `--resume` mantém a `sessionID`;
  - `PATCH` de permissão em resume (§15);
  - `contract.mjs`.
- **Docs:** `commands` (task/ask/plan/status/result/cancel/permissions), `permissions`.

**F2b — Paridade Codex: review, gate, rescue, hooks** (ao vivo: `qwen3.8-max`)

- **Entrega:** `git`, `review`, `adversarial-review` (com o fluxo de pergunta), stop gate,
  `rescue` + `opc-rescue`, hooks `SessionStart`/`SessionEnd` (reaper)/`Stop`, skills
  `opc-runtime`, `opc-result-handling`, `opc-prompting`, prompts, schema.
- **Aceite (integração):**
  - review com saída no schema;
  - diff grande → modo em partes;
  - stop gate: `BLOCK:` bloqueia, `ALLOW:` permite, `stop_hook_active` permite, servidor
    indisponível permite com aviso, saída fora do formato permite com aviso, nota de jobs
    ativos;
  - SessionEnd sai em < 1 s e dispara o reaper;
  - reaper: `clear`/`resume` mantêm o servidor;
  - duas sessões do Claude: o fim da primeira mantém o servidor, o da segunda o encerra após
    a carência;
  - corrida reaper × novo job sob lock → servidor mantido;
  - `--stop-server` com jobs ativos → recusa.
- **Aceite (ao vivo):**
  - `/opc:review` num diff real → JSON válido no schema (3 execuções, ≥ 2 válidas);
  - `/opc:adversarial-review` com foco;
  - stop gate real: verdito parseado corretamente em 3 execuções com erro plantado
    (≥ 2 `BLOCK`);
  - `/opc:rescue` com a pergunta de continuar ou começar sessão;
  - `/clear` no Claude não derruba o servidor.
- **Docs:** `commands` (review/rescue/setup gate), `permissions` (stop gate), README (mapa do
  mínimo).

**F3 — Sessões, subagentes, commands, attach** (ao vivo: os três modelos)

- **Entrega:** `sessions`, `session new/show/fork/revert/unrevert/summarize/children/diff/todo`,
  `subagent` (job-grupo), `command`, `attach` (e `--pane`).
- **Subagente:** por padrão, uma sessão filha criada pelo plugin (`POST /session {parentID,
  agent}` + `prompt_async`). Se o agente em modo `subagent` não puder ser o agente da sessão
  (§15), usa a parte `subtask` (com `description` obrigatório).
- **Aceite (integração):**
  - cada ação chama o endpoint com o corpo certo (`summarize` com modelo, `revert` com
    `messageID`, `command` com `model` em string e `arguments`);
  - `revert` sem `--confirmed-by-user` → recusa;
  - grupo com N membros (status, result e cancel agregados);
  - `attach --pane` sem a senha em argv;
  - modo attach (`OPC_SERVER_URL`) de ponta a ponta no fake.
- **Aceite (ao vivo):**
  - `session new`;
  - `fork` e `revert`/`unrevert` conferidos no histórico e no arquivo;
  - `summarize`, `diff`, `todo`;
  - 3 subagentes em paralelo (`deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3`), cada um com
    resultado próprio;
  - `/opc:command` roda um command do OpenCode;
  - `attach`/`--pane`: validação **manual do usuário**;
  - `contract.mjs`.
- **Docs:** `commands` (sessões, subagentes, command, attach).

**F4a — Roteamento, fallback, delegação, worker, monitor** (ao vivo: `deepseek-v4.1-flash` + `kimi-k3`)

- **Entrega:** fallback e tiers, teto de retries, `opc-delegation`, injeção no SessionStart,
  `opc-worker`, `opc monitor`.
- **Aceite (integração):**
  - `model-429` → sucesso no 2º candidato com `attempts[]`;
  - `retry-over-cap` → abort + fallback;
  - `model-fatal` e `write-then-fail` → sem fallback;
  - `--model` explícito sem fallback;
  - entrada negada pulada com aviso;
  - SessionStart com e sem `delegation.auto`;
  - texto do `opc-worker` (protocolo inline, sem Agent) e execução do comando.
- **Aceite (ao vivo):**
  - fallback real, se houver um modelo do catálogo que falhe em runtime; senão
    `NÃO VALIDADO`, com o fake `model-429` como evidência;
  - `opc-worker` num time real (Agent Teams disponível; senão `N/A` com motivo);
  - `opc monitor` (validação **manual do usuário**).
- **Docs:** `swarm` (roteamento, delegação, worker, monitor), `configuration` (routing,
  delegation, jobs).

**F4b — Orquestração** (ao vivo: `qwen3.8-max` como planner)

- **Entrega:** `orchestrator`, `/opc:orchestrate`, prompts e schema.
- **Aceite (integração):**
  - plano válido;
  - `decompose-cycle` → rejeitado;
  - escrita sem `--write` → rejeitada;
  - escrita em série;
  - resultados de dependência injetados;
  - `dependency_failed`;
  - espalhamento de modelos;
  - síntese Claude e síntese por modelo.
- **Aceite (ao vivo):** tarefa real com plano válido de ≥ 2 subtarefas (o prompt pede ≥ 3)
  executadas com modelos diferentes; síntese pelos dois modos.
- **Docs:** `swarm` (orquestração), `commands`.

**F4c — Conclave** (ao vivo: pool `deepseek-v4.1-flash`, `qwen3.8-max`, `kimi-k3` + 1 extra)

- **Entrega:** `conclave`, `/opc:conclave` (opinion, debate, review), `opc-conclave`, prompts
  e schemas.
- **Aceite (integração):**
  - validações de composição (1 membro, quorum inválido);
  - anonimização (nenhum nome de modelo, vendor ou provider nos prompts de debate e juiz,
    inclusive quando um membro se identifica no texto);
  - quorum atingido e não atingido;
  - `conclave-member-timeout` descartado;
  - `StructuredOutputError` de membro → descartado;
  - dedupe e concordância com fixtures sobrepostas;
  - findings sem `file`;
  - veredito;
  - `--allow-judge-member`.
- **Aceite (ao vivo):**
  - opinion com 3 modelos (respostas válidas no schema);
  - debate com 2 rodadas (resposta da rodada 2 válida, com `changed` registrado);
  - review cruzado num diff real com concordância `k/N`;
  - juiz por modelo e juiz Claude.
- **Docs:** `conclave`, `commands`, `configuration` (conclave).

**F5 — MCP e transfer** (ao vivo: rodízio)

- **Entrega:** `scripts/mcp-server.mjs` (stdio MCP, sem dependências), declarado no plugin.
  - As ferramentas espelham os comandos invocáveis pelo modelo, com as **mesmas** regras:
    `opc_models`, `opc_providers`, `opc_agents`, `opc_config_get`, `opc_task`, `opc_ask`,
    `opc_plan`, `opc_subagent`, `opc_orchestrate`, `opc_conclave`, `opc_session_*`,
    `opc_job_status`, `opc_job_result`, `opc_job_cancel`, `opc_permissions_*`.
  - Nada que exija o usuário (review com `disable-model-invocation`, revert, `--stop-server`,
    config) é exposto sem as mesmas confirmações.
  - Também entra `/opc:transfer` (JSONL do Claude → formato `opencode export` →
    `opencode import`).
- **Aceite (integração):**
  - handshake e `tools/list`;
  - cada ferramenta chama a mesma função de `lib/`;
  - regras do aprovador e confirmações valem no MCP;
  - sem escrita de config via MCP;
  - transfer gera JSON válido contra o formato exportado por `opencode export`.
- **Aceite (ao vivo):**
  - o Claude usa as ferramentas MCP numa sessão real (listar modelos, rodar um conclave);
  - uma sessão transferida aparece em `opencode session list` e é retomada com
    `opencode -s <id>`.
- **Docs:** `commands` (transfer), `architecture` (MCP), README.

---

## 14. Riscos e mitigação

### 14.1 Riscos técnicos

| Risco | Mitigação |
|---|---|
| Churn da API (v1/v2, `experimental/*`, docs e SDK v1 defasados) | Só v1; versão mínima; fake derivado da OpenAPI 1.18.32; `contract.mjs` em todo portão |
| Boot lento (cerca de 23 s) | Servidor longo por workspace; aquecimento; reaper não derruba em `clear`/`resume` |
| `serve` ignora SIGTERM | Escala para SIGKILL; identidade conferida antes de cada sinal |
| Colisão de porta | Porta escolhida pelo plugin + confirmação na linha `listening on` |
| EPIPE no servidor destacado | stdout/stderr para arquivo |
| Lock órfão | Dono verificável; quebra atômica |
| SessionEnd de 1,5 s | Reaper destacado |
| Acesso concorrente ao storage do OpenCode (TUI do usuário + servidor do plugin no mesmo projeto) | A CONFIRMAR (§15); documentado em troubleshooting |
| Agent Teams experimental | `opc-worker` degrada para subagente comum |
| Windows/macOS | Código portátil; `NÃO VALIDADO` |

### 14.2 Riscos de segurança e mundo

| Risco | Mitigação |
|---|---|
| `always` com alcance de instância | Nunca usado (§8.3) |
| Read-only escrevendo ou executando via bash | Read-only sem bash; nega tudo por padrão |
| Leitura de segredos enviada ao provider | Invariante `sensitivePaths` em todos os perfis |
| Destrutivos no perfil `write` | Invariante `ask` com a lista destrutiva, sempre com o usuário |
| Mistura de mundos | Política em todo modelo usado; `task` negado para agentes fora do mundo; ferramentas MCP negáveis; modelos fixados checados; `small_model`/`model` avisados; `.opc.json` só restringe |
| Modelo afrouxando as travas | Chaves travadas só via TTY após o bootstrap; sem `--auto-approve`; confirmações exigidas |
| Vazamento da senha ou de chaves de provider | Arquivos 600; redação em JSON/log; varredura em testes e docs; `attach --pane` sem argv |
| Injeção de shell | Argumentos via heredoc com aspas; teste dedicado |
| Recursão de delegação | `OPC_INSIDE_SERVER`; worker sem Agent; skill proíbe encadear |
| Publicação de sessões | Sem `share`; `share:auto` recusado |
| Sinal em processo alheio | Identidade (cmdline + start time) antes de qualquer sinal |
| Custo e tempo de conclave/orquestração | `maxParallel`, `maxActive`, timeouts, `quorum`, `maxSubtasks`, `rounds` ≤ 3 |
| Licença do swarm-code ausente | Só capacidades reimplementadas |

### 14.3 Desvios conhecidos de paridade com o codex

| Codex | opc | Motivo |
|---|---|---|
| `review/start` nativo | Review por prompt + schema | O OpenCode não tem reviewer nativo |
| `transfer` no conjunto básico | F5 | Depende de conversão para o formato do `opencode export` |
| `--effort` com valores fixos | Alias de `--variant`, validado por modelo | As variants variam por modelo no OpenCode |
| Stop gate bloqueia em timeout ou saída inválida | Permite com aviso | Não bloquear o usuário por falha de infraestrutura; só `BLOCK:` explícito bloqueia |

---

## 15. Itens A CONFIRMAR (com teste marcado)

1. **Precedência (F0, probe).** Pelo código, as regras de sessão vencem as do agente e do
   global; falta confirmar ao vivo, inclusive com o config real do usuário.
2. **`always`** (F0, probe). Pelo código, vale para a instância e vence o `deny`. O plugin já
   não usa; o probe só documenta.
3. **`PATCH /session/:id {permission}`: substitui ou anexa?** Pelo código, **anexa**; a F2a
   confirma ao vivo.
4. **Padrões de `grep`/`list`/`glob` são caminhos?** E o curinga de nome de permissão funciona
   para ferramentas MCP (`gitlab_* *` → deny)? (F0, probe; plano B no §8.1)
5. **Merge de `OPENCODE_CONFIG_CONTENT`** com a config do usuário (F0): define se o
   `configOverride` desliga MCPs, `share` e troca o `small_model`.
6. **Formato aceito de `messageID` do cliente** em `prompt_async`. Pelo código, é
   `msg_` + 12 hex + 14 base62; a F2a confirma ao vivo.
7. **Agente em modo `subagent` como agente de sessão filha** (F3); plano B: parte `subtask`.
8. **Id do plugin em `~/.claude/plugins/data/<id>/`** (F0).
9. **`ppid` do hook é o processo do Claude?** (F2b); fallback de 24 h.
10. **Formato de `opencode export`/`import` para o `transfer`** (F5).
11. **Nomes das ferramentas de Agent Teams** (SendMessage/Task*) disponíveis ao teammate
    (F4a).
12. **Acesso concorrente ao storage** do OpenCode entre a TUI do usuário e o servidor do
    plugin (F3).

---

## 16. Licença e atribuição

- Licença do projeto: Apache-2.0.
- `NOTICE` credita o `openai/codex-plugin-cc` (estrutura de comandos, schema de review,
  prompts adaptados, `git.mjs`). Se algum prompt do `tasict/opencode-plugin-cc` (Apache-2.0)
  for reaproveitado, ele também.
- Arquivos derivados levam um aviso de modificação no cabeçalho.
- `swarm-code-plugin`: nenhuma cópia (sem licença detectável); citado só como inspiração no
  README.
