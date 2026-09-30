# Solução de problemas

Comece por `/opc:setup` ou `opc setup --json`. Para a invocação do slash command, os argumentos são repassados pelo heredoc `OPC_ARGS_5f1d0c7a_EOF`:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

## Servidor

### OpenCode não encontrado

- Sintoma: `opencode: não encontrado`, exit 5.
- Solução: `npm install -g opencode-ai` e rode `/opc:setup` novamente.

### Versão antiga (`UNSUPPORTED_VERSION`)

- Sintoma: exit 5, versão anterior ao mínimo 1.18.0.
- Solução: atualize o OpenCode. Se um servidor antigo estiver registrado, o próximo setup detecta a troca e o substitui quando não houver jobs ativos.

### Boot lento ou falho (`BOOT_FAILED`)

- O primeiro boot pode levar cerca de 20 s; cada tentativa espera `server.bootTimeoutSec` (padrão 60 s) e há até três portas candidatas.
- Consulte `server.log` no diretório de estado indicado pelo setup.
- Se necessário, ajuste a configuração global: `{"server":{"bootTimeoutSec":120}}`.

O portão ao vivo registrou o primeiro setup em cerca de 42 s; não foi publicada uma amostra de log porque ela não é necessária para diagnosticar o fluxo e evita expor dados locais.

### Porta, autenticação ou processo travado

- Porta divergente ou `EADDRINUSE`: a tentativa é encerrada e outra porta é testada, até três vezes.
- `AUTH_FAILED` (401): encerre o servidor do workspace com `/opc:setup --stop-server` e execute o setup novamente. Em attach, confira `OPC_SERVER_PASSWORD`.
- Processo vivo sem resposta a `/global/health` em 2 s: o próximo comando o substitui. Registro morto é descartado sem sinalizar processos não pertencentes ao opc.

### Servidor órfão e encerramento

O opc só sinaliza uma identidade que corresponda a `opencode serve --port <porta>` e ao start time registrado. Servidores iniciados manualmente não são tocados. Use `/opc:setup --stop-server`; com jobs ativos, `--force` exige confirmação explícita do usuário. A sequência é dispose, SIGTERM e, após 3 s, SIGKILL no grupo.

### Sessões bloqueadas (`share-auto`)

Se o setup retornar exit 4 e sessões bloqueadas, configure `{"server":{"configOverride":{"share":"disabled"}}}` no opc, ou `share: "manual"` no OpenCode.

## Locks

| Lock | Espera | Timeout |
|---|---|---|
| `server.lock` | spawn/encerramento do servidor | 4 × `bootTimeoutSec` |
| `state.lock` | escrita de `state.json` | 10 s |

Locks órfãos — dono morto ou PID reaproveitado — são quebrados automaticamente e renomeados para `*.stale-<ts>-<pid>`. Em `TIMEOUT`, a mensagem informa PID e propósito: confirme que o processo ainda existe antes de agir.

## Configuração e diretório de dados

- `CONFIG_INVALID` (exit 2): JSON inválido ou tipo errado; a mensagem lista os caminhos.
- `.opc.json` inválido ou que tente afrouxar a política é ignorado com aviso.
- `DATA_DIR_UNRESOLVED` (exit 2): rode `/opc:setup` no Claude ou defina `OPC_DATA_DIR`.
- `UNSAFE_DIR` (exit 2): o diretório pertence a outro usuário.

## Servidor que não encerra (reaper)

O `SessionEnd` tem orçamento curto; o opc dispara `opc reap` destacado. Cada decisão fica em `<estado do workspace>/reaper.log`, uma linha JSON por evento.

- `keep:reason-clear` / `keep:reason-resume`: `/clear` ou `/resume` mantêm o servidor, pois outra sessão vem em seguida.
- `keep:live-sessions`: há outra sessão Claude registrada no mesmo workspace. Até o §15 item 9 ser confirmado, entrada com menos de 24 h conta como viva mesmo com PID morto.
- `keep:active-jobs`: há jobs ativos; o próximo fim de sessão ou `/opc:setup --stop-server` encerra.
- `stop`: encerrou após carência de 60 s.

Variáveis de diagnóstico: `OPC_REAP_GRACE_MS` (padrão 60000), `OPC_REAP_CANCEL_CAP_MS` (padrão 15000) e `OPC_STOP_GATE_WAIT_MS` (padrão 840000).

## Gate permite por falha de infraestrutura

O stop gate nunca bloqueia por infraestrutura. O `systemMessage` traz o código e a causa redigida, limitada; corrija a causa e tente a próxima parada. Casos conhecidos: OpenCode ausente ou que não sobe, modelo negado pela política, limite de jobs, timeout, resposta fora de `ALLOW:`/`BLOCK:` e erro de preparação do companion. `stop_hook_active: true` é uma permissão deliberada para evitar laço após um bloqueio.

## Review estruturado e OpenCode 1.18.32

Em 1.18.32, após `prompt_async` com `format.json_schema`, `GET /session/:id/message` pode retornar 400 `Expected OutputFormatJsonSchema`; a leitura por mensagem individual funciona. Por isso `review.structuredOutput` é `text` por padrão: nenhum `format` é enviado, o modelo retorna um objeto em cerca `json` e o opc faz extração e validação estritas. `tool` é opt-in e usa schema/per-message reads com espera limitada.

## Orquestração

### Planner falhou com `planner_structured_output`

Mantenha ou configure `orchestrate.structuredOutput` como `text`. Nesse modo o planner recebe
o contrato de retornar um único JSON em cerca `json`, sem `format: json_schema`; o opc extrai e
valida o objeto. `tool` é opt-in para ambientes onde o formato estruturado do OpenCode funciona.

```bash
opc config set orchestrate.structuredOutput text
```

### Planner falhou com `planner_failed` em modo `text`

O turno do planner falhou ou a resposta não trouxe um objeto JSON extraível. O texto recebido
fica como plano bruto em `opc result orch-<id>`. Tente outro planner (`--planner <modelo>`) ou
reformule a tarefa com partes mais explícitas.

### Plano recusado com `invalid_plan`

Leia `planErrors` e o plano bruto em `opc result orch-<id>` ou na saída `--json`. Corrija a
tarefa ou o limite: o plano precisa conter de 2 a `maxSubtasks` itens, ids válidos e únicos,
dependências existentes sem ciclo e agentes permitidos. Uma subtarefa `task` exige repetir a
orquestração com `--write` depois da autorização apropriada.

### Cancelamento durante a criação da sessão de membro

Se o cancelamento chegar enquanto a sessão do membro está sendo criada, ele é adiado e é
honrado antes de o prompt ser enviado: `opc cancel` informa o cancelamento como **pendente**
(`--json`: `pending: true`, `deferredMembers`), a sessão
recém-criada é abortada e o grupo termina `cancelled` (exit 130). O cenário é coberto por teste
de integração com o servidor falso.

## Erros do provider

Erro 402, como `This model requires an opencode API key`, vem do provider/credencial, não do opc. Verifique o provider conectado e a política de modelo; não grave nem exponha a credencial. No gate, o erro permite com aviso; em review/rescue, o comando informa a falha.

## Roteamento e fallback

Somente erros recuperáveis avançam para o próximo candidato de uma rota em lista: `APIError` recuperável, 404, timeout, teto de retries do provider e alguns casos de saída estruturada ou contexto. As respostas 400 e 402 são fatais e não acionam fallback. O `AbortUnconfirmed` também bloqueia fallback, pois a sessão anterior não foi confirmada como encerrada.

Para investigar uma rota ao vivo, use `OPC_LIVE_FAILING_MODEL` com o probe da fase. A sonda disponível não encontrou rota com falha recuperável: modelos inexistentes foram recusados antes do job, e as respostas observadas 400/402 foram fatais. Portanto, fallback ao vivo permanece **NÃO VALIDADO**; os cenários recuperáveis são cobertos pelo servidor falso de teste.

Se a configuração for inválida no `SessionStart`, o lembrete de delegação é desativado e o hook imprime uma única linha em stderr com `CONFIG_INVALID`; o início da sessão continua.

## TUI do OpenCode e o servidor do opc no mesmo projeto (storage concorrente)

O OpenCode guarda sessões em storage compartilhado. A TUI (`opencode`) e o servidor gerenciado (`opencode serve`) podem usá-lo no mesmo projeto.

- Sintoma: uma sessão não aparece. Rode `opc sessions --all`; se necessário, `opc sessions --all --refresh` quando não houver jobs ativos. `--refresh` é recusado com `OPC_SERVER_URL`.
- Sintoma: `SQLITE_BUSY` ou `database is locked` no `server.log`. Evite escrever simultaneamente na mesma sessão pela TUI e pelo opc. Para inspecionar uma sessão do opc, prefira `/opc:attach`, pois usa o mesmo servidor.

Resultado automatizado do §15 item 12: um `opencode run` concorrente e um job do opc terminaram com exit 0; o log do servidor não continha `SQLITE_BUSY` nem `database is locked`. A observação de visibilidade da sessão não-OPC no servidor do plugin foi `false` antes e depois de `opc sessions --all --refresh --json`. Isso é uma observação, não prova de sincronização da TUI. A checagem manual TUI × opc é `NÃO VALIDADO`.

## Diff de sessão vazio no OpenCode 1.18.32

Em 1.18.32, `GET /session/:id/diff` pode devolver uma lista vazia porque o resumo de diff da sessão não foi calculado. O opc usa como fallback `GET /session/:id/diff?messageID=…` para cada mensagem de usuário e indica `source: "per-message"`. Se a listagem de mensagens também estiver indisponível, use `opc session diff <sessionID> --message <messageID>`.

## Listagem de mensagens indisponível

Em algumas respostas estruturadas do OpenCode 1.18.32, `GET /session/:id/message` falha na listagem. `opc session show` informa `messagesUnavailable: true` e mantém diff e filhas disponíveis. Para a prévia de revert, o opc busca a mensagem alvo diretamente; como não consegue enumerar os turnos posteriores, avisa que a prévia cobre apenas aquela mensagem. Se o alvo não existir, retorna `UNKNOWN_MESSAGE`.

## `/opc:attach --pane` não abre

- `$TMUX` vazio: `--pane` retorna exit 2. Use a linha impressa por `/opc:attach` em um terminal ou execute dentro do tmux.
- `tmux split-window` falhou: confira `tmux -V` e se há servidor tmux acessível.
- O attach pede senha: gere novamente a linha com `/opc:attach`; no servidor gerenciado ela lê `<stateDir>/attach.secret`, que é regravado para a identidade atual. Não copie a senha para o shell ou logs.
- Com `OPC_SERVER_URL`, `--pane` é recusado por desenho: o opc não possui nem grava o segredo do servidor externo.

## Conclave

### Exit 7: `QUORUM_NOT_MET`

Uma rodada terminou com menos respostas válidas que `--quorum` ou `conclave.quorum`. O grupo
não chama o juiz; use as respostas parciais e a tabela de falhas para identificar timeout,
provider, cancelamento ou saída inválida. Ajuste os membros, o quorum ou
`conclave.memberTimeoutSec` e execute novamente.

### Saída estruturada ausente ou inválida

- `MissingStructuredOutput` em `conclave.structuredOutput: "text"`: o turno terminou, mas a resposta não trouxe um objeto JSON extraível. O modo `text` pede uma única cerca `json` e valida localmente.
- `StructuredOutputError` em `conclave.structuredOutput: "tool"`: o gateway não produziu a saída do protocolo `format: json_schema`. Use `text`, que é o padrão por esse motivo, ou um ambiente compatível.
- `InvalidStructuredOutput`: havia JSON, mas ele não atende ao schema esperado. Reformule a tarefa ou troque o membro; a falha não recebe fallback automático.
- `MissingSession`: uma rodada posterior não recebeu a sessão criada na rodada anterior. Reexecute e, se persistir, preserve as falhas para investigar o servidor.

### Composição e juiz

Se todos os membros forem negados pela política, o comando retorna exit 4. Com menos de dois
membros válidos por entradas inválidas, desconectadas ou duplicadas, retorna exit 2. Leia os
avisos no stderr para cada entrada pulada.

Se o juiz modelo falhar, o conclave continua concluído, inclui o aviso e preserva
`synthesisInput`; o Claude sintetiza com a skill `opc-conclave`. Não trate essa falha como
consenso criado pelo juiz.
