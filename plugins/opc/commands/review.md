---
description: Executa uma revisão de código OpenCode sobre o estado local do git
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model>] [--variant <variant>]'
disable-model-invocation: true
allowed-tools: Bash(opc:*), Bash(git:*), AskUserQuestion
---

<!-- Adapted from openai/codex-plugin-cc (Apache-2.0); modified -->

Execute uma revisão OpenCode das alterações locais do git pelo companion opc.

Argumentos brutos do comando:
`$ARGUMENTS`

Restrições:
- Este comando serve somente para revisão.
- Não corrija problemas, aplique patches nem sugira que fará alterações.
- Execute a revisão e devolva a saída do companion verbatim.
- Se o usuário pedir correções depois, siga a skill `opc-result-handling` e pergunte quais achados devem ser corrigidos antes de tocar em qualquer arquivo.

Sempre passe os argumentos do usuário por stdin com `--raw-args-stdin` e heredoc entre aspas, exatamente como nos comandos abaixo, para que o shell não os expanda. O companion reconhece as opções conhecidas e trata o restante como texto livre; em `/opc:review`, qualquer texto livre é recusado com indicação de `/opc:adversarial-review`.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

<!-- shared:review-flow -->
Execução:
- Se os argumentos brutos incluírem `--wait` ou `--background`, não pergunte. Execute diretamente. Para primeiro plano, use Bash com `timeout: 600000`:

```bash
opc review --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Caso contrário, estime primeiro:

```bash
opc review --estimate --json --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

  - O JSON contém `files`, `insertions`, `deletions` e `recommendation` (`nothing`, `wait` ou `background`). Se `recommendation` for `nothing`, informe que não há nada para revisar nesse alvo e encerre.
  - Se a estimativa falhar, execute a revisão pelo companion com as opções no heredoc (o companion chama git com argumentos separados) ou pergunte ao usuário como prosseguir.
- Quando o modo não vier nos argumentos, use `AskUserQuestion` exatamente uma vez com duas opções, colocando primeiro a recomendada e acrescentando ` (Recomendado)`:
  - `Aguardar o resultado`
  - `Rodar em background`
- Primeiro plano (usuário escolheu aguardar):

```bash
opc review --wait --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

  Devolva stdout verbatim, sem paráfrase, resumo ou comentário. Exit code 6 significa que a espera expirou, mas a tarefa continua; informe `/opc:status <job-id> --wait` com o id impresso.
- Background (usuário escolheu executar em segundo plano):

```bash
opc review --background --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

  Devolva stdout verbatim, que inclui o id e as linhas `/opc:status` e `/opc:result`.
- Preserve os argumentos exatamente; não acrescente instruções nem reescreva a intenção. Exit code 4 significa que a política opc negou o modelo de revisão; exit code 5 significa que o servidor OpenCode está indisponível: indique `/opc:setup`.
<!-- /shared:review-flow -->

Tratamento específico: `/opc:review` não recebe texto livre de foco; qualquer texto livre é recusado com indicação de `/opc:adversarial-review`. Para revisão focada ou de contestação, use `/opc:adversarial-review`.
