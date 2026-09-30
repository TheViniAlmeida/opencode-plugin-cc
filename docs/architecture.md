# Arquitetura do opc

## Visão geral

```text
Claude Code ──(slash command / hook)──> bin/opc ──> opc-companion.mjs ──> commands/<sub>.mjs
                                                                         │
                                                         scripts/lib/*.mjs (núcleo)
                                                                         │ HTTP + SSE (API v1)
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
6. Aquece `/agent` e verifica `/config`: `share: auto` bloqueia sessões; defaults de modelo negados viram aviso.

Resultado ao vivo do portão: primeiro setup em aproximadamente 42 s, porta 40405 e health positivo; reaproveitamento em aproximadamente 8,6 s; encerramento em aproximadamente 3,5 s com fallback para SIGKILL previsto. O reaproveitamento lento inclui a checagem de mundo e aquecimento; investigação fica para F1.

## Encerramento e eventos

`stopServer` tenta `POST /global/dispose`, SIGTERM no grupo e, após 3 s, SIGKILL; a identidade é conferida antes de cada sinal. SSE usa `GET /event?directory=…`, liveness de 30 s e reconexão com esperas de 0,5/1/2/4/8 s.

## Segurança

- O servidor escuta somente em `127.0.0.1` e recebe senha aleatória a cada boot, guardada apenas no `server.json` privado.
- Chaves de provider e senha não aparecem em saída, log ou documentação.
- O plugin não escreve na configuração nem na autenticação do OpenCode.
- Nenhum sinal é enviado a processo cuja identidade não confira.

## Grupos de jobs e subagentes (F3)

Um grupo é um job com `role: "group"` e `memberIds`; cada membro tem `groupId` e `role: "member:<n>"`. Apenas o grupo conta em `jobs.maxActive` e na poda. Membros herdam a identidade do processo do coordenador, mas o matcher de worker não confunde o membro com esse processo; cancelar um membro aborta somente sua sessão.

`opc task-worker --job-id <grupo>` escolhe o worker por `kind`: `sub` delega para `subagent.mjs` e `cmd` para `command.mjs`. Para subagentes, o coordenador abre um único `EventHub`, cria a sessão pai e executa os membros com `runWithConcurrency(memberIds, jobs.maxParallel, …)`. Cada membro chama `dispatchSubagent`: normalmente cria uma sessão filha com o agente; se o servidor a recusar, usa uma sessão portadora e uma parte `subtask`.

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
