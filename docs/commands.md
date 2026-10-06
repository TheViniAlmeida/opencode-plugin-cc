# Comandos do opc

Os comandos abaixo existem no terminal como `opc …` e, no Claude Code, como `/opc:…`. `--json` entrega a visão estruturada; saídas passam por redação de credenciais. Exit 0 é sucesso, 2 é uso/valor inválido, 3 é permissão pendente, 4 é política/chave travada, 5 é servidor ou conexão, 6 é fim da espera, 7 é falha do job e 130 é cancelamento.

## `/opc:setup`

Sinopse: `/opc:setup [--reconfigure]`; apoio de terminal: `opc setup [--json]`, `opc setup models`, `opc setup apply --stdin`, `opc setup commit` e `opc setup discard`.

Diagnostica dependências, oferece a instalação do OpenCode e conduz o onboarding. O rascunho pode ser retomado; `--reconfigure` inicia uma reconfiguração controlada. Use o heredoc canônico para payload JSON:

```bash
opc setup apply --stdin <<'OPC_JSON_5f1d0c7a_EOF'
{"aliases":{"rapido":"<provider-pessoal>/modelo-exemplo"}}
OPC_JSON_5f1d0c7a_EOF
```

## `/opc:config`

Sinopse: `opc config get [chave]`, `set <chave> <valor>`, `unset <chave>`, `add|remove <lista> <valor>`, `show [--effective]`, `validate`, `path` e `init`.

`--workspace` altera o `.opc.json` apenas onde ele pode restringir; `--global` seleciona a leitura global; `--tty-confirm` confirma no terminal uma chave travada. `init` exige terminal interativo. `set`, `unset`, `add` e `remove` retornam 2 para chave/valor inválido, 4 para política e 5 quando precisam de catálogo e o servidor não está acessível.

Exemplo realmente executado offline (caminhos redigidos):

```text
# opc config set

`project.goal` (global) → `<data-dir>/config.json`

Valor: `"Documentação local"`
```

E a consulta JSON correspondente:

```json
{"kind":"get","setting":"project.goal","source":"effective","value":"Documentação local"}
```

## `/opc:providers`

Sinopse: `opc providers [--all] [--json]`.

Lista providers conectados; `--all` inclui os não conectados. A coluna de política informa se cada provider é permitido. Requer servidor e retorna 5 se ele estiver inacessível.

## `/opc:models`

Sinopse: `opc models [provider] [--verbose] [--allowed] [--all] [--json]`.

Por padrão mostra modelos conectados. `--all` inclui catálogo desconectado, `--allowed` mantém apenas os permitidos e `--verbose` acrescenta detalhes. Provider desconhecido, ou não conectado sem `--all`, retorna 2; indisponibilidade do servidor retorna 5. O portão ao vivo confirmou que `--all` corresponde à listagem do OpenCode por provider.

## `/opc:agents`

Sinopse: `opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json]`.

`--mode` filtra a modalidade, `--verbose` inclui agentes ocultos e `--allowed` aplica a política. O valor inválido de `--mode` retorna 2; servidor indisponível retorna 5. A listagem é ordenada alfabeticamente.

## `/opc:catalog`

Sinopse: `opc catalog commands|skills [--json]`.

Lista commands ou skills expostos pelo servidor. Para commands, inclui a decisão de política; para skills, nome, descrição e local. Argumento diferente de `commands` ou `skills` retorna 2; servidor inacessível retorna 5.

## Saídas e segurança

Use `--json` em integrações. O portão F1 verificou as respostas JSON de providers, modelos e onboarding e não encontrou credenciais. Evite passar segredo como argumento ou gravá-lo na configuração.

## Execução (F2a)

Todo turno roda num **worker destacado** (`opc task-worker`), registrado como job em `<estado>/jobs/<id>.json`. Em primeiro plano acompanha o job; com `--background`, devolve o id. IDs seguem `<tipo>-<base36(ms)>-<rand6>` e aceitam prefixo único.

### Códigos de saída

| Código | Quando |
| --- | --- |
| 0 | Sucesso |
| 2 | Uso inválido, id ausente/ambíguo, limite de jobs, sessão ocupada ou troca de perfil não suportada no resume |
| 3 | Job em `waiting_permission`, com pedido de permissão ou pergunta pendente |
| 4 | Negado por política, aprovador ou recursão (`OPC_INSIDE_SERVER=1`) |
| 5 | Falha de conexão/servidor |
| 6 | `--wait-timeout` ou `status --timeout-ms` expirou; o job continua e o id é impresso |
| 7 | Job terminou em `failed` |
| 130 | Job terminou em `cancelled` |

### `/opc:task`

```text
/opc:task [--write | --profile <nome>] [--model <m>] [--agent <a>] [--variant <v> | --effort <v>]
          [--tier <t>] [--resume [id] | --resume-last | --fresh] [--background]
          [--prompt-file <arquivo>] [--timeout <s>] [--wait-timeout <s>] <prompt>
```

Sem `--write`, usa `read-only`; `--write` usa `write`; `--profile <nome>` usa `custom:<nome>`. `--model` aceita alias, id completo (`provider/modelo`) ou nome curto no provider padrão. `--effort` é alias de `--variant`; `--tier` aceita somente `light` ou `heavy` e usa `routing.tiers.<tier>`; tier desconhecido ou vazio retorna exit 2. Agentes são validados contra a política; agentes apenas-subagente são recusados.

`--resume [id]` continua job ou sessão (`ses_…`); sem id equivale a `--resume-last`. `--fresh` conflita com `--resume`. `--timeout` limita o turno (padrão 1800 s); `--wait-timeout` limita só a espera (padrão 540 s). Prompt pode vir por argumento, stdin ou `--prompt-file` (bytes intactos); resume sem prompt usa `prompts/continue.md`.

Texto livre (`task`, `ask`, `plan`) usa `--raw-args-stdin`; comandos só de flags/ids usam `--args-stdin`. No heredoc, use uma linha `--` antes do texto. O corpo é preservado, flags são reconhecidas somente nas sequências inicial e final e delimitador que apareça isolado nos argumentos é recusado. Se houver `project`, inclui `<project_context>`; `OPC_INSIDE_SERVER=1` recusa job (exit 4).

```text
$ opc ask --raw-args-stdin
`src/math.js:1`

---
Tarefa: ask-mukvemmb-nvmj2z · Sessão: ses_f1948c840ffeVGPURNfoPmSNav · Modelo: omniroute-personal/opencode-go/deepseek-v4.1-flash
Continuar: /opc:ask --resume ask-mukvemmb-nvmj2z

$ opc task --background --raw-args-stdin
Tarefa opc task-mukvg8io-6ih238 na fila em segundo plano (task, omniroute-personal/opencode-go/deepseek-v4.1-flash).
- Acompanhar: /opc:status task-mukvg8io-6ih238
- Aguardar: /opc:status task-mukvg8io-6ih238 --wait
- Resultado: /opc:result task-mukvg8io-6ih238
- Cancelar: /opc:cancel task-mukvg8io-6ih238
```

### `/opc:ask` e `/opc:plan`

| Comando | Prompt | Rota | Saída esperada |
| --- | --- | --- | --- |
| `/opc:ask <pergunta>` | `prompts/ask.md` | `routing.tasks.ask` | Resposta direta com `arquivo:linha` |
| `/opc:plan <tarefa>` | `prompts/plan.md` | `routing.tasks.plan` | Goal, Files, Steps, Trade-offs, Risks, Tests, Open questions |

Aceitam flags de modelo, `--background`, `--resume`/`--fresh`, `--timeout` e `--wait-timeout`; `--write` e `--profile` retornam exit 2.

### `/opc:status`, `/opc:result` e `/opc:cancel`

```text
/opc:status [job-id] [--wait] [--timeout-ms 240000] [--poll-interval-ms 2000] [--all]
/opc:result [job-id]
/opc:cancel [job-id]
```

`status` sem id lista jobs desta sessão; `--all` inclui todas. Com id, mostra fase, modelo, sessão, filhas, erro, pedidos e log; com `--json`, inclui `attempts[]`. `--wait` retorna 0 (`completed`), 3 (`waiting_permission`), 7 (`failed`), 130 (`cancelled`) ou 6 sem parar o job. `result` mostra texto final, saída estruturada, arquivos tocados, continuação e `## Tentativas (N)` quando houve fallback; `result --json` também inclui `attempts[]`. Job ativo retorna 2. `cancel` aborta sessão principal e filhas, espera idle por até 10 s e encerra worker somente após conferir identidade.

### `opc monitor`

```text
opc monitor [--job <id|prefixo>] [--once] [--json] [--color auto|always|never] [--interval <ms>]
```

Leitor puro de `state.json`, jobs e logs do workspace. Mostra fase, modelo, tentativa, pedidos pendentes e linhas recentes de log. `--job` foca um job ou grupo; `--once` desenha um quadro e sai; `--json` imprime o snapshot e sai. O intervalo padrão é 1000 ms e o mínimo é 100 ms. Ctrl+C encerra com exit 0.

### `/opc:permissions`

```text
/opc:permissions list
/opc:permissions reply <id> once|reject [mensagem] [--confirmed-by-user]
/opc:permissions answer <id-da-pergunta> <resposta...>
```

`list` mostra pedidos pendentes com job dono. `user` exige `--confirmed-by-user` em `once`; `claude` também o exige para destrutivo, `external_directory` ou caminho sensível. `reject` é sempre permitido e rejeita irmãos. `always` retorna 2; veja [Permissões](permissions.md#por-que-nunca-always).

### `opc gc`

```text
opc gc [--days 30] [--confirmed-by-user]
```

Lista estados sem uso, sem jobs ativos ou servidor vivo; o atual nunca entra. A remoção pede confirmação. Sem TTY, só remove com `--confirmed-by-user`; sem a flag, retorna 2.

```text
$ opc gc
opc gc: nada a remover; nenhum estado de workspace sem uso há mais de 30 dias.
```

### `opc task-resume-candidate --json` (interno)

Usado por `/opc:rescue` (F2b): `{available, sessionId, candidate: {id, kind, status, title, summary, sessionID, completedAt, updatedAt}}`; `--kind task|ask|plan` (padrão `task`).

## Review, gate e rescue (F2b)

### `/opc:review`

Revisa as mudanças locais com modelo do OpenCode, perfil `read-only` e saída validada no schema `review-output`. Só o usuário invoca (`disable-model-invocation`).

Uso: `/opc:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--variant <v>]`

- **Alvo:** `auto` revisa o working tree quando há mudanças; sem elas, revisa a branch contra `origin/HEAD`, `main`, `master` ou `trunk`. `--base` força a ref; `--scope` escolhe o modo.
- **Espera:** sem `--wait`/`--background`, mede com `opc review --estimate --json` e pergunta entre aguardar ou rodar em segundo plano. Só recomenda aguardar para até 2 arquivos e 300 linhas alteradas.
- **Diff grande:** até 400 KB vai inteiro; acima disso, envia `--stat` completo e diffs menores primeiro. O modelo pode ler os omitidos com `read`; o perfil não libera Bash.
- **Segredos:** `policy.sensitivePaths` nunca tem conteúdo enviado e aparece apenas em "Excluded Files"; symlink não rastreado não é seguido.
- **Modelo:** `--model` → `reviewModel` → `routing.tasks.review` → `defaultModel` → padrão do OpenCode.
- **Correções:** o comando somente revisa. Depois dos achados, o Claude pergunta quais corrigir antes de editar.
- **Exit codes:** 0 (qualquer veredito), 2 (uso ou fora de Git), 4 (modelo negado), 5 (servidor), 6 (espera expirou; job continua), 7 (falha, inclusive saída inválida; texto bruto impresso), 130 (cancelado).

Exemplo ao vivo redigido:

```text
$ opc review --wait
# OPC Revisão

Alvo: diff da árvore de trabalho
Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Job: review-<id>

Veredito: needs-attention

O novo src/math.js contém defeitos críticos: sum lê além do array e divide ignora o divisor.

Achados:
- [critical] sum itera além do último índice e retorna NaN (src/math.js:3)
  O loop usa `i <= values.length`; a última leitura é `undefined`.
  Recomendação: Trocar a condição por `i < values.length` e cobrir com testes.
- [critical] divide retorna a / 0 e ignora o divisor b (src/math.js:12)
  A função retorna `a / 0`, descartando `b`.
  Recomendação: Retornar `a / b` e definir o caso `b === 0`.
- [high] average não trata array vazio e propaga NaN (src/math.js:7-9)
  Recomendação: Validar `values.length === 0`.

Próximos passos:
- Corrigir o limite de sum, divide e a entrada vazia de average; adicionar testes.
```

```text
$ opc review --background
# OPC Revisão

Revisão iniciada em segundo plano: review-<id>
- Progresso: /opc:status review-<id>
- Aguardar: /opc:status review-<id> --wait
- Resultado: /opc:result review-<id>
```

### `/opc:adversarial-review`

Usa o mesmo fluxo e flags de `/opc:review`, porém procura razões para não publicar a mudança: limites de confiança, perda de dados, corridas, rollback e falhas parciais. Texto após as flags vira foco literal.

```text
$ opc adversarial-review --wait foco em entradas vazias e divisão por zero
# OPC Revisão Adversarial

Alvo: diff da árvore de trabalho
Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Job: review-<id>

Veredito: needs-attention

Bloquear entrega: sum retorna NaN, average não trata entrada vazia e divide ignora o divisor.

Achados:
- [critical] Off-by-one em sum faz a função retornar NaN (src/math.js:3)
- [critical] divide ignora o divisor e sempre divide por zero (src/math.js:12)
- [high] average não trata array vazio (divisão por zero) (src/math.js:8)
```

### `/opc:rescue`

Delega investigação, correção pedida ou continuação ao OpenCode pelo subagente `opc-rescue`, que chama `opc task` uma vez e devolve a saída sem comentários.

Uso: `/opc:rescue [--background|--wait] [--resume|--fresh] [--model <m>] [--variant <v>|--effort <v>] [--agent <a>] <pedido>`

- Sem `--resume`/`--fresh`, consulta `opc task-resume-candidate --json`; se houver candidata da sessão Claude, pergunta entre continuar a sessão atual (primeira opção) e começar outra.
- Por padrão roda com `--write`; peça "somente leitura" para diagnóstico sem edição.
- `--background` é repassado a `opc task`; acompanhe com `/opc:status` e leia com `/opc:result`.
- O subagente não responde permissões; o Claude principal segue o aprovador configurado.

### `/opc:setup` — stop review gate

`/opc:setup --enable-review-gate` e `/opc:setup --disable-review-gate` gravam `stopGate.enabled` somente na configuração global. Exigem onboarding já concluído; sem config global, saem com exit 2 e orientam executar `/opc:setup`.

```text
$ opc setup --enable-review-gate
# opc setup

Status: pronto

## Verificações

- node: ok (22.22.1)
- opencode: ok (1.18.32)
- diretório de dados: <tmp>
- workspace: <tmp>

## Servidor

- estado: rodando
- versão: 1.18.32
- reaproveitado: não (subiu agora)

Gate de parada: ativado (atualizado)
```

`/opc:setup --stop-server` recusa com exit 2 enquanto houver jobs ativos e os lista. `--force` exige confirmação do usuário (`--confirmed-by-user`).

### Hooks

| Hook | O que faz |
| --- | --- |
| `SessionStart` | Exporta `OPC_COMPANION_SESSION_ID`, `OPC_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA` e `OPC_DATA_DIR`; registra a sessão e, com `delegation.auto`, injeta lembrete de delegação. |
| `SessionEnd` | Registra o fim e dispara `opc reap` destacado, saindo em menos de 1 s. |
| `Stop` | Avisa em stderr sobre jobs ativos; com o gate ligado, executa o stop review gate. |

## Sessões, subagentes, commands e attach (F3)

### `/opc:sessions`

```text
/opc:sessions [--all] [--limit N] [--refresh] [--json]
```

Por padrão lista somente sessões raiz deste workspace cujo título começa com `OPC: `, da mais recente para a mais antiga. `--all` inclui filhas e sessões que o servidor conhece; `--limit` vale 30 por padrão e nunca mostra menos de uma linha. A resposta JSON é `{ sessions, total, filtered }`.

`--refresh` chama o descarte da instância para que o servidor releia o storage. É recusado com jobs de topo ativos e em modo de servidor externo (`OPC_SERVER_URL`). Uma TUI anexada ao servidor gerenciado é desconectada e precisará reconectar.

```bash
opc sessions
opc sessions --all --limit 10 --json
```

### `/opc:session`

| Ação | Uso | Resultado |
| --- | --- | --- |
| `new` | `new [--title t] [--agent a] [--model m] [--write]` | Cria sessão `OPC: session: <t>` com perfil `read-only` ou `write`. |
| `show` | `show <sessionID> [--limit N]` | Mostra sessão, estado e mensagens; os IDs de mensagem servem para `fork` e `revert`. |
| `fork` | `fork <sessionID> [messageID]` | Cria fork com o histórico anterior à mensagem indicada. |
| `revert` | `revert <sessionID> <messageID> [--part partID] [--confirmed-by-user]` | Exige confirmação e então aplica o revert. |
| `unrevert` | `unrevert <sessionID> [--confirmed-by-user]` | Exige confirmação e restaura o revert ativo. |
| `summarize` | `summarize <sessionID> [--model m] [--timeout s]` | Resume sincronamente; o timeout padrão é 600 s. |
| `children` | `children <sessionID>` | Lista sessões filhas. |
| `diff` | `diff <sessionID> [--message messageID]` | Mostra diff da sessão ou de uma mensagem. |
| `todo` | `todo <sessionID>` | Lista tarefas da sessão. |

IDs de sessão, mensagem e parte são validados antes de conectar. `revert`, `unrevert` e `summarize` recusam a sessão ocupada por job ou ativa no servidor. A resolução de modelo de `new` e `summarize` segue a política; uma recusa de política retorna exit 4.

Sem `--confirmed-by-user`, `revert` e `unrevert` retornam exit 2, exibem a prévia do diff e não mudam nada. No slash command, depois da confirmação explícita do usuário, repasse a linha de confirmação pelo heredoc, sem pôr IDs na linha de comando:

```bash
opc session --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
revert ses_<id> msg_<id> --confirmed-by-user
OPC_ARGS_5f1d0c7a_EOF
```

Para `unrevert`, o corpo é `unrevert ses_<id> --confirmed-by-user`. Nunca acrescente a flag sem a confirmação daquela ação e daquele alvo.

Em OpenCode 1.18.32, o endpoint de diff da sessão pode devolver uma lista vazia. Sem `--message`, o opc então tenta o diff de cada mensagem de usuário e informa `source: "per-message"`; se as mensagens não puderem ser listadas, use `--message <id>`.

```bash
opc session new --title "investigar login" --model fast
opc session show ses_<id>
opc session fork ses_<id> msg_<id>
opc session diff ses_<id>
opc session todo ses_<id>
```

Saída real (portão F3, 29/09/2026):

```text
$ opc session diff ses_<id>
{"sessionID":"ses_<id>","messageID":null,"source":"per-message","notices":["O OpenCode não calculou o diff agregado da sessão; mostrando o diff de cada mensagem do usuário (da mais antiga para a mais recente)."],"diffs":[{"file":"notes.txt","status":"modified","messageID":"msg_<id>"}]}

$ opc session summarize ses_<id> --model omniroute-personal/cmd/Qwen/Qwen3.7-Flash --json
{"sessionID":"ses_<id>","model":"omniroute-personal/cmd/Qwen/Qwen3.7-Flash","summarized":true}
```

### `/opc:subagent`

```text
/opc:subagent --agent a[,b,c] [--model m[,m2,m3]] [--variant v|--effort v] [--write] [--background]
[--mechanism child-session|subtask] [--prompt-file f] [--timeout s] [--wait-timeout s] <prompt>
```

Cria um grupo `sub-…` e um membro por par agente/modelo. Uma lista de um lado expande sobre a outra; listas com o mesmo tamanho pareiam por posição; o máximo é oito membros. Os agentes aceitos têm modo `subagent` ou `all`, e agentes/modelos passam pela política antes de qualquer sessão.

O mecanismo padrão é `child-session`: cria uma sessão pai e uma filha por membro. Se o servidor recusar o agente de subagente na sessão filha, o membro usa `subtask` numa sessão portadora; o resultado registra `mechanism` e `fellBack`. O worker coordenador executa até `jobs.maxParallel` (4 por padrão); `--write` serializa os membros. O grupo conta como um job para `jobs.maxActive`.

```bash
opc subagent --agent general --model fast,strong,k3 "Liste os riscos deste módulo em 3 itens"
opc subagent --agent explore,general "Onde a configuração é carregada?" --background
```

Saída real (portão F3, 29/09/2026):

```text
Status: completed · 3 membro(s): 3 completed
#1 general · omniroute-personal/cmd/deepseek/deepseek-v4-flash — child-session
#2 general · omniroute-personal/cmd/Qwen/Qwen3.7-Flash — child-session
#3 general · omniroute-personal/cmd/moonshotai/Kimi-K2.6 — child-session
```

### `/opc:status`, `/opc:result` e `/opc:cancel` para grupos

```text
/opc:status [job-id] [--wait] [--timeout-ms N] [--poll-interval-ms N] [--all] [--json]
/opc:result [job-id] [--json]
/opc:cancel [job-id] [--json]
```

Para um grupo, `status` e `result` retornam ou renderizam `{ group, members }`. O estado agregado é `waiting_permission` se algum membro aguarda decisão, `running` se algum está ativo, `completed` se algum concluiu e os demais não impedem a conclusão, ou `failed`/`cancelled` conforme os membros. `status <grupo> --wait` acompanha o coordenador.

`cancel <grupo>` solicita cancelamento de todos os membros ativos e informa `cancelledMembers` e `failedMembers`; falha de cancelamento retorna exit 5 com `CANCEL_FAILED`. `cancel <membro>` aborta somente a sessão daquele membro. Sem id, a resolução ignora membros de grupo.

```bash
opc status sub_<id> --wait
opc result sub_<id>
opc cancel sub_<id>
opc cancel sub_<member-id>
```

Saída real (portão F3, 29/09/2026):

```text
# Resultado do grupo sub_<id>

Status: completed · 2 membro(s): 2 completed

## #1 general · omniroute-personal/cmd/deepseek/deepseek-v4-flash — completed
## #2 general · omniroute-personal/cmd/moonshotai/Kimi-K2.6 — completed
```

### `/opc:command`

```text
/opc:command <cmd> [args...] [--agent a] [--model m] [--variant v] [--write] [--background]
[--timeout s] [--wait-timeout s] [--json]
```

Consulta `GET /command`; comando desconhecido retorna exit 2 com até 20 nomes disponíveis. Cria um job `cmd-…` e uma sessão `OPC: command: /<cmd>`, com perfil `read-only` por padrão. `--write` escolhe o perfil `write`. Os argumentos vazios seguem como string vazia e a chamada usa o timeout do job, de 30 minutos por padrão.

O modelo é `--model`, depois o fixado pelo command e por fim a rota `task`; o agente é `--agent`, depois o fixado, `defaultAgent` e o padrão do OpenCode. A política é aplicada ao command e às escolhas fixadas; negação retorna exit 4. Permissões e perguntas usam a mesma ponte de jobs (exit 3).

```bash
opc catalog commands
opc command check-updates --model omniroute-personal/cmd/moonshotai/Kimi-K2.6
```

Saída real (portão F3, 29/09/2026):

```text
# opc command /check-updates

Status: completed
Argumentos: (nenhum)
Sessão: ses_<id> · modelo omniroute-personal/cmd/moonshotai/Kimi-K2.6 · agente (padrão)
```

### `/opc:attach` (somente usuário)

```text
/opc:attach [sessionID] [--pane] [--json]
```

Sem `sessionID`, usa a sessão do job mais recente da sessão atual do Claude; sem job, abre o seletor da TUI. A linha normal lê a senha do arquivo privado e a entrega somente por variável de ambiente:

```bash
OPENCODE_SERVER_PASSWORD="$(cat '<stateDir>/attach.secret')" opencode attach http://127.0.0.1:<porta> -s ses_<id> --dir '<workspace>'
```

No servidor gerenciado, `attach.secret` é modo 600 e contém apenas a senha vigente. `--pane` requer tmux, cria `attach-pane.sh` modo 700 e lê o segredo dentro do pane; senha nenhuma é posta em argv. Fora do tmux, retorna exit 2. Em servidor externo (`OPC_SERVER_URL`), a linha usa `OPC_SERVER_PASSWORD` e `--pane` é recusado porque o opc não grava o segredo externo.

Com `--json`, `authSource` substitui qualquer campo de credencial: no servidor gerenciado é `{ "type": "file", "path": "<stateDir>/attach.secret" }`; no externo é `{ "type": "env", "name": "OPC_SERVER_PASSWORD" }`. A resposta também traz `url`, `sessionID`, `directory`, `attached` e `argv`, nunca a senha.

```bash
opc attach ses_<id>
opc attach --pane ses_<id>
```

Saída real: `NÃO VALIDADO` — a validação manual de attach e `--pane` não foi executada no portão F3.

## `/opc:orchestrate`

Decompõe uma tarefa em subtarefas executadas por modelos do OpenCode e entrega os resultados
para síntese. O modelo pode invocar este comando; o fluxo está em
[swarm.md](swarm.md#orquestração-opcorchestrate).

```text
/opc:orchestrate <tarefa> [--planner <modelo>] [--max N] [--synthesizer claude|<modelo>] [--write] [--background]
opc orchestrate <tarefa> [mesmas flags] [--timeout s] [--wait-timeout s] [--json] [--cwd dir]
opc orchestrate [flags] --raw-args-stdin
```

Com `--raw-args-stdin`, ponha as flags dentro do corpo quoted do heredoc, antes da linha `--`;
a tarefa fica depois dessa linha. Isso preserva o texto verbatim.

```bash
opc orchestrate --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--max 3 --synthesizer claude --background
--
Mapeie as rotas HTTP, revise a validação de entrada e proponha testes.
OPC_ARGS_5f1d0c7a_EOF
```

| Flag | Padrão | Efeito |
|---|---|---|
| `--planner <m>` (`-m`) | `orchestrate.planner` | Modelo único do planner, sem fallback |
| `--max N` | `orchestrate.maxSubtasks` (5) | Máximo de subtarefas, de 2 a 20 |
| `--synthesizer claude\|<m>` | `orchestrate.synthesizer` (`claude`) | Responsável pela síntese |
| `--write` | desligado | Permite subtarefas `task`, serializadas entre si e com perfil `write` |
| `--background` | desligado | Retorna imediatamente o id do grupo |
| `--timeout s` | 1800 | Limite de cada turno do planner, subtarefa ou sintetizador |
| `--wait-timeout s` | sem limite | Só limita o foreground; o grupo continua |
| `--json` | desligado | Emite `jobId`, `status`, `errorCode` e o pacote `orchestration` |

**Exit codes:** 0 concluída, inclusive com avisos; 2 uso; 3 subtarefa aguardando permissão;
4 planner/sintetizador negado ou `OPC_INSIDE_SERVER=1`; 5 conexão; 6 `--wait-timeout`; 7
`invalid_plan`, `planner_failed`, `planner_structured_output`, `all_subtasks_failed` ou
`coordinator_error`; 130 cancelada.

Planner e sintetizador passam pela política antes de criar o job. As rotas de subtarefa são
resolvidas durante a execução: entrada negada é apenas avisada e rota sem candidato falha a
subtarefa. Para acompanhar ou recuperar resultado de um grupo em background:

```bash
opc orchestrate --synthesizer omniroute-personal/cmd/<modelo> --background "Revise src/cache"
opc status orch-<id> --wait
opc result orch-<id>
```

## `/opc:conclave`

Consulta vários modelos em paralelo e sintetiza consenso, divergências e recomendação. Guia
completo: [conclave.md](conclave.md).

- **Fase:** F4c · **Modelo invoca:** sim · **Terminal:** `opc conclave`
- **Uso:** `/opc:conclave <pergunta> [--models a,b,c | --pool nome] [--mode opinion|review|debate] [--rounds 1-3] [--judge claude|<modelo>] [--quorum N] [--allow-judge-member] [--background]`

Com `--raw-args-stdin`, ponha as flags e a pergunta dentro do corpo quoted do heredoc; não as
passe na linha de comando. O parser reconhece flags conhecidas como palavras inteiras dentro do
corpo.

```bash
opc conclave --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--models fast,strong,k3 --mode debate --rounds 2
Vale um write-ahead log?
OPC_ARGS_5f1d0c7a_EOF
```

| Flag | Padrão | Descrição |
|---|---|---|
| `<pergunta>` | — | Obrigatória em `opinion` e `debate`; em `review`, vira o foco |
| `--models a,b,c` | — | Membros; exclusiva com `--pool` |
| `--pool nome` | `conclave.defaultPool` | Pool definida em `conclave.pools` |
| `--mode` | `opinion` | `opinion`, `debate` (2–3 rodadas) ou `review` (diff atual, 1 rodada) |
| `--rounds N` | `opinion`: `conclave.rounds`; `debate`: 2 | Inteiro de 1 a 3 |
| `--judge` | `conclave.judge` (`claude`) | `claude` ou modelo sujeito à política |
| `--quorum N` | `conclave.quorum` (2) | Respostas válidas mínimas; de 2 ao total de membros |
| `--allow-judge-member` | desligado | Permite juiz que também é membro |
| `--base ref`, `--scope auto\|working-tree\|branch` | `auto` | Apenas em `--mode review` |
| `--background` | desligado | Devolve o id do job imediatamente |
| `--wait-timeout s` | sem limite | Limite do foreground; exit 6, o job continua |
| `--json` | desligado | Pacote completo em JSON |

**Exit codes:** 0 concluído, inclusive review `needs-attention`; 2 composição ou uso inválidos;
4 política ou `OPC_INSIDE_SERVER=1`; 5 servidor; 6 `--wait-timeout`; 7 quorum não atingido ou
coleta de diff falhou; 130 cancelado.

```bash
opc conclave "JSON ou TOML para a config do CLI?"
opc conclave --models fast,strong,k3 --mode debate --rounds 2 --judge strong "Vale um write-ahead log?"
opc conclave --mode review --quorum 2 "Foque em segurança"
opc conclave --pool duo --background "Qual estratégia de cache?"
```

Saídas reais: [Exemplos executados](conclave.md#exemplos-executados).

## `/opc:transfer`

Converte uma conversa do Claude Code para uma nova sessão OpenCode, retomável no
terminal com `opencode -s <id>`. O slash command é invocado pelo usuário
(`disable-model-invocation: true`); não há ferramenta MCP de transfer.

```text
/opc:transfer [--source <arquivo.jsonl>] [--model <provider/model|alias>]
opc transfer [--source <arquivo.jsonl>] [--model <provider/model|alias>] [--json]
```

- **Origem:** `--source` ou `OPC_COMPANION_TRANSCRIPT_PATH`, exportado pelo hook
  SessionStart. O arquivo e seu `realpath` precisam ser `.jsonl` sob `~/.claude/projects`;
  symlinks para fora são recusados. O limite é 64 MiB por transcript.
  `OPC_TRANSFER_ALLOWED_ROOT` substitui a raiz para testes; não é um contorno de política
  no uso normal.
- **Modelo:** `--model` (ID completo `provider/model` ou alias) → `defaultModel` →
  `NO_MODEL`. Provider e modelo passam pela política. A transferência não consulta o
  catálogo nem inicia `opencode serve`; a existência do modelo é conferida pelo OpenCode
  ao retomar. O modelo original do Claude não é preservado.
- **Conversão:** cada prompt real vira uma mensagem `user`; o texto do assistente até
  o próximo prompt vira uma mensagem `assistant`. Chamadas e resultados de ferramentas
  ficam como texto resumido: `[chamada de ferramenta: <nome>] <input JSON>` e
  `[resultado da ferramenta: sucesso|erro] <saída>`, com até 2.000 caracteres por parte.
  Textos têm limite de 65.536 caracteres, com marcador de truncamento. Imagens e
  documentos recebem marcadores de conteúdo omitido. Blocos de raciocínio, sidechains,
  mensagens meta e comandos locais são ignorados e contados; linhas JSONL inválidas
  também são contadas. Se a conversa começa pelo assistente, é criada uma mensagem
  sintética de usuário para manter o encadeamento.
- **Importação:** a conversão gera IDs novos e valida a estrutura do formato
  `opencode export`. O JSON temporário é gravado com modo 600 em `<estado>/transfer/`
  (diretório 700), importado com `opencode import <arquivo>` no workspace e removido
  ao fim da tentativa. O sucesso exige exit 0 e a linha `Imported session: <id>` com
  o mesmo ID exportado.
- **Título e saída:** a sessão tem prefixo `OPC: transfer:`. A saída mostra ID, título,
  modelo, contagem de mensagens/itens ignorados e comando para retomar. O resumo passa
  por redação; o conteúdo do histórico é preservado no arquivo importado.
  O caminho da origem não é incluído no resumo público.

Com `--json`, o resumo contém `sessionID`, `title`, `model`, `workspaceRoot`,
`messages` (`total`, `user`, `assistant`), `skipped` (`meta`, `sidechain`, `command`,
`thinking`, `other`, `invalidLines`), `resumeCommand` e `warnings`.

| Exit code | Casos |
|---|---|
| 0 | Sessão importada |
| 2 | `NO_TRANSCRIPT`, `NOT_JSONL`, `NOT_FOUND`, `NOT_A_FILE`, `TRANSCRIPT_TOO_LARGE` (> 64 MiB), `EMPTY_TRANSCRIPT`, `NO_MODEL`, `MODEL_NEEDS_FULL_ID` |
| 4 | `TRANSCRIPT_OUTSIDE_ALLOWED_ROOT` ou `POLICY_DENIED` para provider/modelo |
| 5 | `OPENCODE_NOT_FOUND`, `UNSUPPORTED_VERSION` |
| 7 | `IMPORT_FAILED` (falha do processo, marcador ausente ou ID divergente), `EXPORT_SHAPE_INVALID` |

Exemplo **ilustrativo**, com IDs, modelo e workspace fictícios; não é evidência de
execução ao vivo. O round trip com OpenCode real e histórico sintético passou em armazenamento
isolado; a transferência numa conversa real do Claude e a retomada interativa seguem
**NÃO VALIDADO**. Evidências e pendências: [relatório da F5](phases/F5-report.md).

```text
# opc transfer

Sessão OpenCode criada: `ses_EXAMPLE`
Título: OPC: transfer: Planejar uma alteração
Modelo registrado: example-provider/example-model
Mensagens importadas: 4 (2 do usuário, 2 do assistente)
Ignorados: 0 meta, 0 sidechain, 0 comandos locais, 0 blocos de raciocínio, 1 outros, 0 linhas inválidas

Para retomar no terminal:

    cd '<workspace>' && opencode -s ses_EXAMPLE
```

### Ferramentas MCP

O servidor MCP `opc` expõe 25 ferramentas `opc_*`, usando o mesmo despachante da CLI.
Consultas e ações seguem a política e as confirmações do comando equivalente;
`opc_config_get` permite apenas leitura. `opc_conclave` aceita `opinion` e `debate`;
review fica no slash command. A [arquitetura](architecture.md#servidor-mcp-f5) contém o
catálogo completo, os limites e o envelope de resultado. As respostas de
`opc_permissions_reply` e `opc_permissions_answer` podem entregar `data` como Markdown.
