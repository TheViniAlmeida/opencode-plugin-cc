# Arquitetura do opc

## Visão geral

```text
Claude Code ──(slash command / hook)──> bin/opc ──> opc-companion.mjs ──> commands/<sub>.mjs
                                                                         │
                                                         scripts/lib/*.mjs (núcleo)
                                                                         │ HTTP + SSE (API V2 `/api/*`)
                                                                         ▼
                                                  opencode serve (127.0.0.1:<porta>, senha)
```

Um servidor `opencode serve` é gerenciado por workspace e compartilhado pelas sessões do Claude nele. A saída normal vai a stdout; progresso vai a stderr com prefixo `[opc]`; `--json` está disponível nos subcomandos e as saídas passam por redação.

O slash command de setup repassa argumentos sem interpretação por meio do delimitador canônico `OPC_ARGS_5f1d0c7a_EOF`:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

## Módulos da F0

| Módulo | Responsabilidade |
|---|---|
| `opc-error.mjs` | erros tipados e exit codes |
| `redact.mjs` | redação de chaves e segredos |
| `args.mjs` | argumentos sem expansão e `--args-stdin` |
| `process.mjs` | identidade, spawn destacado e kill em grupo |
| `locks.mjs` | locks `O_EXCL` com dono verificável |
| `state.mjs` | diretório de dados, estado por workspace e modos privados |
| `config.mjs` | config base e merge restritivo |
| `http.mjs` | HTTP com Basic auth, diretório e timeouts |
| `sse.mjs` | SSE, liveness, reconexão e roteamento |
| `server.mjs` | ciclo de vida do servidor |

## Ciclo de conexão (`ensureServer`)

1. Adquire `server.lock` para serializar spawn e encerramento.
2. Em attach (`OPC_SERVER_URL`), valida URL e health; nunca sobe ou derruba o servidor externo.
3. Reaproveita registro cuja identidade, health e versão conferem; registro inválido é descartado sem sinal.
4. Escolhe porta livre em `127.0.0.1`, inicia `opencode serve` destacado e registra stdout/stderr em `server.log`.
5. Aguarda `listening on` na porta pedida ou health; tenta até três portas, confirma versão mínima e grava `server.json` atomicamente em modo 600.
6. Aquece `/api/agent` e consulta `/api/config`; a versão é conferida em `/api/info`.

Resultado ao vivo do portão: primeiro setup em aproximadamente 42 s, porta 40405 e health positivo; reaproveitamento em aproximadamente 8,6 s; encerramento em aproximadamente 3,5 s com fallback para SIGKILL previsto. O reaproveitamento lento inclui a checagem de mundo e aquecimento; investigação fica para F1.

## Encerramento e eventos

`stopServer` envia SIGTERM ao grupo e, após 3 s, SIGKILL se necessário; a identidade é conferida antes de cada sinal. SSE usa `GET /api/event`, eventos por sessão e heartbeat em comentário; liveness de 30 s e reconexão com esperas de 0,5/1/2/4/8 s.

## Segurança

- O servidor escuta somente em `127.0.0.1` e recebe senha aleatória a cada boot, guardada apenas no `server.json` privado.
- Chaves de provider e senha não aparecem em saída, log ou documentação.
- O plugin não escreve na configuração nem na autenticação do OpenCode.
- Nenhum sinal é enviado a processo cuja identidade não confira.

## Grupos de jobs e subagentes (F3)

Um grupo é um job com `role: "group"` e `memberIds`; cada membro tem `groupId` e `role: "member:<n>"`. Apenas o grupo conta em `jobs.maxActive` e na poda. Membros herdam a identidade do processo do coordenador, mas o matcher de worker não confunde o membro com esse processo; cancelar um membro aborta somente sua sessão.

`opc task-worker --job-id <grupo>` escolhe o worker por `kind`: `sub` delega para `subagent.mjs` e `cmd` para `command.mjs`. Para subagentes, o coordenador abre um único `EventHub`, cria a sessão pai e executa os membros com `runWithConcurrency(memberIds, jobs.maxParallel, …)`. Cada membro chama `dispatchSubagent`: usa a ferramenta `subagent` do V2; a filha herda modelo e permissões da sessão pai.

Cada membro cria sua própria ponte de pedidos da F2a. A atualização do membro também recalcula o grupo: pedidos pendentes ficam identificados por `memberId`; ao resolver um pedido, o turno correspondente retoma. Um membro isolado não vira `worker_lost`; quando a reconciliação perde o grupo, os membros ativos também são perdidos.

## Attach e ciclo de vida do segredo (F3)

No boot gerenciado, `server.json` é publicado antes de `attach.secret`; o segredo tem modo 600 e é escrito sob `server.lock` somente se a identidade do registro ainda confere. Falha de publicação faz rollback do processo e dos arquivos. `stopServerUnlocked`, usado pelo encerramento normal, remove `attach.secret` inclusive quando encontra o registro órfão ou ausente.

`/opc:attach --pane` cria `<stateDir>/attach-pane.sh` com modo 700. O tmux recebe só o caminho desse script, do arquivo de segredo, do binário e dos argumentos de attach. Dentro do pane, o script lê o arquivo, exporta `OPENCODE_SERVER_PASSWORD` e executa o OpenCode; a senha não vai para argv. Em modo externo, `OPC_SERVER_URL` usa `OPC_SERVER_PASSWORD` do ambiente e não há arquivo local nem suporte a `--pane`.

## Roteamento, fallback e monitor (F4a)

`resolveCandidates` seleciona a origem do modelo; quando ela é uma lista elegível, `runJobTurn` compõe o turno com `runWithFallback`. Cada chamada de `runAttempt` abre uma sessão própria para o mesmo prompt e `recordAttempt` persiste seu resultado em `attempts[]` do job. Assim, uma falha recuperável não reutiliza uma sessão potencialmente incompleta e o resultado mantém o histórico de modelo, sessão, estado, erro e horários.

O runner limita retries anunciados pelo OpenCode. Se a interrupção não for confirmada, produz `AbortUnconfirmed` e bloqueia fallback; se for confirmada, `RetryCapExceeded` pode avançar ao próximo candidato. Cancelamento, falhas fatais, `--resume`, modelo explícito e turno de escrita que já executou ferramenta não fazem fallback.

`opc monitor` cria contexto somente leitura e lê diretamente `state.json`, `jobs/*.json` e os trechos finais dos logs. Ele não reconcilia jobs, não cria diretórios e não grava estado. O snapshot alimenta tanto o quadro de terminal quanto `--json`; cada item calcula tentativa atual/limite a partir de `attempts[]` e `attemptLimit`.

## Orquestração (F4b)

`lib/orchestrator.mjs` contém decomposição, validação, agendamento e síntese; suas dependências
são injetáveis, portanto o módulo não acessa HTTP diretamente. `scripts/commands/orchestrate.mjs`
monta essas dependências, cria um único grupo `orch-…` e despacha um worker coordenador.

O grupo conta uma vez em `jobs.maxActive`. Seus membros são criados sob demanda com os papéis
`planner`, `worker:<n>` e `synthesizer`, e o coordenador respeita `jobs.maxParallel`. Leituras
prontas rodam em paralelo; escritas são mutuamente exclusivas, mas podem coexistir com leituras.
O resultado de uma dependência concluída é injetado na próxima subtarefa com limite de 8 KB e
marcadores neutralizados. Rotas de subtarefas recebem espalhamento de modelos antes do fallback.

O coordenador atualiza membros e grupo por dependências injetadas, registra tentativas e usa
`refreshGroup` como único finalizador de estado agregado. Falhas de persistência tornam-se
`coordinator_error`; o cancelamento antes da criação/publicação da sessão é deferido e conferido
antes de enviar o prompt do membro.

## Conclave (F4c)

`lib/conclave.mjs` concentra lógica pura e testável: composição, anonimização, validação local
de schema, rodadas, agrupamento de achados, veredito e síntese. `runConclave` recebe o turno por
injeção em `deps.turn`; o módulo não acessa HTTP diretamente.

`scripts/commands/conclave.mjs` resolve membros contra catálogo e política, registra um único
job-grupo `conc-…` por `createGroup` e despacha um coordenador. Os filhos têm `role`
`member:<rótulo>` e, quando aplicável, `judge`; um único worker abre uma `EventHub` compartilhada
e conecta `deps.turn` a `runTurn`.

Antes de `composition`, toda string produzida por membro ou juiz é anonimizada. Os campos
estruturais e a pergunta do usuário permanecem literais; `composition` é deliberadamente o
mapeamento identificador, exibido por último. `refreshGroup(..., { final: true, decorate })` é o
único finalizador do grupo e preserva um grupo já cancelado.

Enquanto a sessão de membro ou juiz está sendo criada, `attemptInFlight` permite cancelamento
adiado. A sessão é publicada antes do prompt; se o cancelamento chegou nesse intervalo, ela é
abortada antes de enviar a pergunta. Falhas de persistência do coordenador são explícitas e
encerram o grupo como `coordinator_error`.

## Servidor MCP (F5)

O plugin declara o servidor MCP stdio `opc` no `plugin.json`:

```json
"mcpServers": { "opc": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"] } }
```

O processo usa `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` e `CLAUDE_PROJECT_DIR` do
ambiente do Claude Code. O protocolo em `scripts/lib/mcp-protocol.mjs` usa JSON-RPC 2.0,
uma mensagem por linha, sem dependências. Implementa **2025-06-18** e aceita
`2025-03-26` e `2024-11-05` por negociação. `initialize`, `ping`, `tools/list` e
`tools/call` são os métodos disponíveis; lotes JSON-RPC são recusados.

### Fluxo de uma chamada

```text
Claude Code ──stdio──> mcp-server.mjs
                        └─ mcp-protocol.mjs: initialize · ping · tools/list · tools/call
                            └─ mcp-tools.mjs: valida inputSchema → monta argv
                                └─ opc-companion.mjs: main(argv, io)
                                    └─ commands/<sub>.mjs: run(ctx, argv) → lib/*
```

- **Mesmo despachante:** a ferramenta chama `main(argv, io)`, como `bin/opc`. Política,
  aprovador, confirmações, limites de jobs e exit codes vêm dos comandos existentes.
  Texto livre é colocado após `--` no argv, sem interpretação por shell.
- **stdout reservado:** o servidor preserva o `write` original para os frames JSON-RPC
  e desvia outras escritas de `process.stdout` para stderr.
- **stdin isolado:** cada comando recebe stdin vazio, sem TTY, e stdout/stderr capturados
  com limite de 200.000 caracteres por stream. Excesso no stdout produz `truncated: true`.
- **Prazos:** chamadas comuns têm teto de 300 s. Os seis comandos longos com `wait: true`
  têm teto MCP de `waitTimeoutSec + 300 s` (espera padrão 120 s, máximo 540 s).
  `opc_job_status` com `wait` usa `timeoutSec + 60 s` (espera padrão 60 s, máximo 540 s).
  Estouro do teto MCP retorna `MCP_CALL_TIMEOUT`; o comando pode continuar.
- **Sessão do Claude:** se `OPC_COMPANION_SESSION_ID` estiver disponível, é reutilizada.
  Caso contrário, o MCP procura em `claudeSessions` a entrada mais recente com PID igual
  ao processo pai e `pidStartTime` conferido, e repassa o ID ao comando. Sem correspondência,
  os jobs ficam sem sessão do Claude; use `/opc:status --all` para encontrá-los.
  A associação numa sessão real do Claude Code segue **NÃO VALIDADO**.

### Resultado

`content[0].text` contém um JSON com o envelope do resultado:

| Campo | Conteúdo |
|---|---|
| `exitCode` | Código do comando: 0, 2, 3, 4, 5, 6, 7 ou 130 |
| `state` | `ok`, `usage_error`, `waiting_permission`, `policy_denied`, `connection_error`, `wait_timeout`, `job_failed`, `cancelled` |
| `data` | Saída da CLI com `--json`, redigida; pode ser string quando a CLI imprime texto |
| `error` | `{ code, message }`, redigido, quando houver erro capturado ou extraído da saída |
| `truncated` | `true` quando stdout excedeu o limite de captura |

`isError` é `false` para os códigos 0, 3 e 6. Isso inclui permissão pendente e fim da
espera; o job pode continuar. `opc_permissions_reply` e `opc_permissions_answer` imprimem
Markdown, portanto seu `data` pode ser string mesmo com sucesso. Resultados de grupos
contêm `{ group, members }` em `data`, com a saída agregada em `group.result`.

O timeout de espera pode trazer `{ job, waitTimedOut: true }` em `data` ou um erro
`WAIT_TIMEOUT` no caso de grupos. A falha de cancelamento pode trazer
`{ error, message, report }` em `data`, com exit 5. O envelope preserva essas saídas
e os erros reportados pelo comando. Argumentos inválidos retornam exit 2 com
`INVALID_ARGUMENTS` e `isError: true`; ferramenta inexistente é erro JSON-RPC `-32602`.

### Ferramentas

As ferramentas atuais estão listadas abaixo. A exposição permite operações de consulta e ações com as mesmas
confirmações do comando. As anotações MCP são indicações; a política do companion
continua valendo. Consultas podem iniciar o servidor gerenciado ou reconciliar o estado
dos jobs, conforme o comando equivalente.

| Ferramenta | Comando equivalente | Operação e limites |
|---|---|---|
| `opc_models` | `/opc:models` | Consulta de modelos e política |
| `opc_providers` | `/opc:providers` | Consulta de providers; `all` inclui catálogo completo |
| `opc_agents` | `/opc:agents` | Consulta; filtro `primary`, `subagent` ou `all` |
| `opc_catalog` | `/opc:catalog` | Consulta de `commands` ou `skills` |
| `opc_config_get` | `/opc:config get` | Somente leitura; única ferramenta de config |
| `opc_task` | `/opc:task` | Job em background; padrão somente leitura, `write`/`profile` conforme o comando |
| `opc_ask` | `/opc:ask` | Job em background com perfil somente leitura |
| `opc_plan` | `/opc:plan` | Job em background com perfil somente leitura |
| `opc_subagent` | `/opc:subagent` | Grupo em background; 1–8 agentes |
| `opc_orchestrate` | `/opc:orchestrate` | Grupo em background; `maxSubtasks` de 2 a 10; edição com `write: true` |
| `opc_conclave` | `/opc:conclave` | Grupo em background; `mode` apenas `opinion` ou `debate`, sem `review` |
| `opc_session_list` | `/opc:sessions` | Consulta; `all` inclui sessões sem prefixo `OPC:` |
| `opc_session_show` | `/opc:session show` | Consulta de sessão e mensagens |
| `opc_session_new` | `/opc:session new` | Cria sessão |
| `opc_session_fork` | `/opc:session fork` | Bifurca sessão, opcionalmente numa mensagem |
| `opc_session_summarize` | `/opc:session summarize` | Compacta sessão com modelo sujeito à política |
| `opc_session_children` | `/opc:session children` | Consulta de sessões filhas |
| `opc_session_diff` | `/opc:session diff` | Consulta de diff |
| `opc_job_status` | `/opc:status` | Consulta de jobs; `wait: true` exige `jobId` |
| `opc_job_result` | `/opc:result` | Consulta do resultado final; grupos incluem membros |
| `opc_job_cancel` | `/opc:cancel` | Cancela job ou grupo conforme o comando |
| `opc_permissions_list` | `/opc:permissions list` | Consulta de permissões e perguntas pendentes |
| `opc_permissions_reply` | `/opc:permissions reply` | `once`/`reject`; `confirmedByUser` só após aprovação explícita daquele pedido; `data` pode ser Markdown |
| `opc_permissions_answer` | `/opc:permissions answer` | Respostas na ordem das perguntas; `data` pode ser Markdown |

Com aprovador `user` (padrão), o Claude apresenta o pedido via AskUserQuestion antes
de responder. Pedidos destrutivos, `external_directory` e caminhos sensíveis exigem
o usuário com qualquer aprovador. `confirmedByUser: true` corresponde à confirmação
do comando e só vale após aquela aprovação. `always` é recusado; `opc-worker` e
`opc-rescue` devolvem os pedidos à conversa principal.

### Comandos sem ferramenta MCP

| Comando | Fluxo disponível |
|---|---|
| `/opc:session revert` / `unrevert` | Usuário vê o diff e confirma a sessão/mensagem |
| `/opc:setup`, incluindo `--stop-server` e instalação | Comando do usuário, com suas confirmações |
| `/opc:config set/unset/add/remove`, `opc config init` | Configuração pelo usuário; chaves travadas no terminal |
| `/opc:review`, `/opc:adversarial-review`, `/opc:transfer` | Invocação pelo usuário (`disable-model-invocation`) |
| `/opc:command` | Rota síncrona arbitrária fora da superfície MCP |
| `/opc:attach`, `opc monitor`, `opc gc`, `/opc:rescue` | Terminal/usuário ou fluxo de agente |
