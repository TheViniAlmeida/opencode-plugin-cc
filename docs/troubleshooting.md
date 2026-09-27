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
