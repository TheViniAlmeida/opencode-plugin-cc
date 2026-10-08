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
- Solução: instale o OpenCode 2.0.22 ou mais novo conforme a documentação oficial (<https://opencode.ai>). Se o binário não estiver no PATH, aponte `server.opencodeBin` (ou a variável `OPC_OPENCODE_BIN`) para ele e rode `/opc:setup` novamente.

### Versão antiga (`UNSUPPORTED_VERSION`)

- Sintoma: exit 5, versão anterior ao mínimo 2.0.22.
- Solução: instale OpenCode V2 e configure `server.opencodeBin` ou `OPC_OPENCODE_BIN` se o primeiro binário no PATH for antigo. Sem jobs ativos, o próximo setup substitui o servidor registrado.

### Servidor registrado anterior à 2.0.22 (`V1_SERVER_ACTIVE`)

- Sintoma: exit 2 com `V1_SERVER_ACTIVE`. O servidor gerenciado registrado pelo opc responde como OpenCode anterior à 2.0.22 (o `/api/info` devolve a SPA, `NOT_JSON`, ou uma versão antiga) e ainda há jobs ativos nele.
- Sem jobs ativos, o opc encerra esse servidor e sobe um V2, com um aviso. Com jobs ativos, ele não o derruba: aguarde (`/opc:status`) ou cancele (`/opc:cancel`) e rode o comando de novo.
- A substituição só vale para o processo que o próprio opc registrou; processos de terceiros não recebem sinal.

### Providers declarados sem modelos no catálogo

- Sintoma: aviso `Providers declarados ainda sem modelos no catálogo: <providers>` ou `TIMEOUT` com a mensagem `O catálogo de modelos do OpenCode não carregou em <N> s`.
- Os providers declarados são lidos da chave `providers` da config V2 (o V1 usava `provider`, aceito como reserva). Com providers declarados, o catálogo é considerado pronto quando eles carregam e o evento `model.updated` só encurta a espera; sem providers declarados, vale a regra da F6 (esperar o evento até o teto). Em attach (`OPC_SERVER_URL`), a espera vai até 15 s enquanto o catálogo está vazio e, depois do primeiro catálogo não vazio, até 2 s pelos providers faltantes.
- O aviso diz: "Providers declarados ainda sem modelos no catálogo: <providers>. Confira credenciais e o gateway, ou se estão desligados por disabled_providers/enabled_providers (o GET /api/config do OpenCode V2 não expõe essas listas)." Ao vivo (2.0.22), o `GET /api/config` omite `disabled_providers` e `enabled_providers` (só traz share, mcp, plugins, providers e experimental), mas o catálogo `/api/model` respeita as duas listas; por isso um provider declarado e desligado por elas aparece no aviso como faltante.
- O aviso sai no stderr da CLI como `[opc] aviso: …` (deduplicado, silencioso dentro de hooks). Nas ferramentas MCP o stderr é descartado quando o comando tem sucesso, então o aviso não aparece lá; rode `opc models` na CLI para vê-lo.
- A espera do catálogo e o aviso em attach foram validados ao vivo na F8 (`opc models` com exit 0 e o aviso citando os providers faltantes).
- Providers que não carregam (chave inválida, gateway fora do ar) não bloqueiam os demais: o aviso os nomeia. Confira credenciais e o gateway; se o `TIMEOUT` persistir, deixe o servidor terminar de subir e tente de novo.

### Comandos falham com `TIMEOUT` em attach (catálogo vazio)

- Sintoma: em attach (`OPC_SERVER_URL`), todo comando que usa o servidor (inclusive `session show` e `status`) espera até 15 s e termina com `TIMEOUT`; a mensagem informa o teto e o próximo passo.
- Causa: o servidor externo está com o catálogo de modelos vazio, porque nenhum provider carregou (chave inválida, gateway fora do ar, diretório recém-aberto ainda subindo).
- Solução: corrija o provider no servidor externo (credencial, gateway) e confirme direto no servidor externo (TUI do OpenCode ou `GET /api/model`) que o catálogo tem modelos, porque `/opc:models` também passa pela mesma espera; depois rode o comando de novo.

### Boot lento ou falho (`BOOT_FAILED`)

- O primeiro boot pode levar cerca de 20 s; cada tentativa espera `server.bootTimeoutSec` (padrão 60 s) e há até três portas candidatas.
- Consulte `server.log` no diretório de estado indicado pelo setup.
- Se necessário, ajuste a configuração global: `{"server":{"bootTimeoutSec":120}}`.

O portão ao vivo registrou o primeiro setup em cerca de 42 s; não foi publicada uma amostra de log porque ela não é necessária para diagnosticar o fluxo e evita expor dados locais.

### Porta, autenticação ou processo travado

- Porta divergente ou `EADDRINUSE`: a tentativa é encerrada e outra porta é testada, até três vezes.
- `AUTH_FAILED` (401): encerre o servidor do workspace com `/opc:setup --stop-server` e execute o setup novamente. Em attach, confira `OPC_SERVER_PASSWORD`.
- Processo vivo sem resposta a `/api/info` em 2 s: o próximo comando o substitui. Registro morto é descartado sem sinalizar processos não pertencentes ao opc.

### Servidor órfão e encerramento

O opc só sinaliza uma identidade que corresponda a `opencode serve --port <porta>` e ao start time registrado. Servidores iniciados manualmente não são tocados. Use `/opc:setup --stop-server`; com jobs ativos, `--force` exige confirmação explícita do usuário. A sequência é SIGTERM e, após 3 s, SIGKILL no grupo.

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

## Saída estruturada no OpenCode V2

O V2 não oferece saída por `json_schema`. O opc pede um objeto em cerca `json` e valida localmente. As chaves `review.structuredOutput`, `orchestrate.structuredOutput` e `conclave.structuredOutput` usam `text`; valor antigo `tool` é tratado como `text` com aviso.

## Orquestração

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

## Diff de sessão vazio

Se o diff da sessão estiver vazio, o OpenCode 2 não oferece diff por mensagem, então não há como detalhar por mensagem. Confira o estado do workspace com o git.

## `SNAPSHOT_DISABLED` no revert

O OpenCode só registra diff e revert com snapshots ligados. Com `"snapshot": false` na config do OpenCode, o diff da sessão fica vazio e a reversão não restauraria nada, então `opc session revert` recusa com `SNAPSHOT_DISABLED`. Para usar o revert, ligue `snapshot` na config do OpenCode ou só no servidor gerenciado (`server.configOverride` do opc).

## Listagem de mensagens falhou

Se a listagem de mensagens da sessão falhar, `opc session show` e `opc session revert` falham com o erro da API; não há modo degradado. No `revert`, uma mensagem que não pertence à sessão retorna `UNKNOWN_MESSAGE`. Tente de novo e, se persistir, consulte `server.log`.

## `TIMEOUT` no `session summarize`

O `summarize` envia a compactação e espera a sessão terminar dentro de um único `--timeout` (padrão 600 s). Se o prazo estourar, o comando retorna `TIMEOUT` (exit 5) com a mensagem "a compactação continua no servidor": o opc não cancela nada. Confira depois com `opc session show <sessionID>` ou rode de novo com um `--timeout` maior. O V2 registra a compactação como uma mensagem marcador, sem texto de resumo na API.

## Revert pendente e `FORK_INHERITANCE_FAILED`

- `task --resume` e `summarize` avisam no stderr quando a sessão tem revert pendente: um prompt novo o consolida e as mensagens revertidas deixam de poder voltar com `unrevert`. Faça o `unrevert` antes, se quiser as mensagens.
- A prévia do `revert` avisa quando não foi possível confirmar se os snapshots estão ligados; nesse caso a reversão pode não restaurar arquivos.
- `FORK_INHERITANCE_FAILED`: o fork foi criado, mas as regras de permissão ou o modelo da origem não puderam ser reaplicados e verificados (o OpenCode 2.0.22 devolve o fork sem eles). O opc não apaga o fork. Apague-o no OpenCode e rode `session fork` de novo; não use o fork criado.

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
- `InvalidStructuredOutput`: havia JSON, mas ele não atende ao schema esperado. Reformule a tarefa ou troque o membro; a falha não recebe fallback automático.
- `MissingSession`: uma rodada posterior não recebeu a sessão criada na rodada anterior. Reexecute e, se persistir, preserve as falhas para investigar o servidor.

### Composição e juiz

Se todos os membros forem negados pela política, o comando retorna exit 4. Com menos de dois
membros válidos por entradas inválidas, desconectadas ou duplicadas, retorna exit 2. Leia os
avisos no stderr para cada entrada pulada.

Se o juiz modelo falhar, o conclave continua concluído, inclui o aviso e preserva
`synthesisInput`; o Claude sintetiza com a skill `opc-conclave`. Não trate essa falha como
consenso criado pelo juiz.

## MCP e transfer

- **O servidor `opc` não aparece em `/mcp`:** use `/reload-plugins` e confira
  `node --version` (≥ 20) no PATH do Claude Code. O teste de inicialização
  `node <plugin>/scripts/mcp-server.mjs < /dev/null` deve sair com código 0 e stdout
  vazio; um erro de inicialização aparece em stderr.
- **`MCP_CALL_TIMEOUT`:** a chamada passou do teto MCP (300 s normalmente;
  `waitTimeoutSec + 300 s` nos jobs longos com espera; `timeoutSec + 60 s` no status
  com espera). O comando pode continuar e o job pode ter sido criado. Consulte
  `/opc:status --all` antes de repetir a tarefa.
- **`state: "wait_timeout"`:** terminou a espera, não a execução do job. Use o ID
  retornado em `opc_job_status` ou `/opc:status <id> --wait` para acompanhar.
- **Jobs MCP ausentes no status desta sessão:** o processo MCP pode não ter encontrado
  a sessão do Claude pelo PID/horário de início do processo pai. Use
  `/opc:status --all` (ou `opc_job_status` com `all: true`). A associação real ao
  processo do Claude permanece **NÃO VALIDADO**.
- **`data` veio como texto:** `opc_permissions_reply` e `opc_permissions_answer` podem
  devolver Markdown. Leia o envelope de `content[0].text` e preserve o conteúdo
  de `data`; ele não precisa ser um objeto JSON.
- **`NO_TRANSCRIPT`:** o transcript não chegou pelo hook. Informe
  `--source ~/.claude/projects/<projeto>/<sessao>.jsonl` ao `/opc:transfer`.
- **`TRANSCRIPT_OUTSIDE_ALLOWED_ROOT`:** a origem ou o destino do symlink está fora
  de `~/.claude/projects`. Use um transcript dessa raiz; `OPC_TRANSFER_ALLOWED_ROOT`
  é destinado aos testes.
- **`NO_MODEL` ou `MODEL_NEEDS_FULL_ID`:** forneça `--model <provider/model>` ou um
  alias configurado, ou defina `defaultModel` no opc. O transfer não lê o `model` da configuração do
  OpenCode. O opc não usa o modelo padrão do servidor como fallback. A transferência exige ID completo após expandir o alias e
  respeita a política de provider/modelo.
- **`EMPTY_TRANSCRIPT`:** não restou texto transferível após filtrar meta, sidechains,
  raciocínio e comandos locais. Confira a origem indicada.
- **`IMPORT_FAILED`:** o processo falhou, não imprimiu `Imported session: <id>` ou
  informou um ID diferente do exportado. A mensagem não expõe stdout/stderr brutos
  do OpenCode. Confira `opencode --version` e `opencode session import --help`; antes de
  repetir, consulte as sessões no mesmo workspace, pois a importação pode ter
  produzido uma sessão mesmo sem confirmação de sucesso.
- **Sessão transferida ausente em `opencode session list`:** a lista é por projeto;
  execute dentro do workspace da transferência. Para retomar, use a linha
  `cd … && OPENCODE_SERVER_PASSWORD=… opencode --server <url> -s <id>` retornada. Ela usa o binário configurado (`server.opencodeBin` ou `OPC_OPENCODE_BIN`) e lê a senha fora do argv: do arquivo `attach.secret` no servidor gerenciado ou de `OPC_SERVER_PASSWORD` em servidor externo (a variável precisa estar no ambiente do terminal). Se o terminal pedir senha, gere a linha de novo com `/opc:transfer` ou `/opc:attach`. A execução dessa linha contra o OpenCode real ainda é **NÃO VALIDADO**.
