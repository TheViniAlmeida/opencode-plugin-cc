---
description: Executa uma revisão OpenCode que contesta a abordagem e as escolhas de design
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model>] [--variant <variant>] [focus ...]'
disable-model-invocation: true
allowed-tools: Bash(opc:*), Bash(git:*), AskUserQuestion
---

<!-- Adapted from openai/codex-plugin-cc (Apache-2.0); modified -->

Execute uma revisão adversarial OpenCode pelo companion opc. Questione a implementação escolhida, decisões de design, concessões e premissas; avalie se a abordagem atual é adequada e onde pode falhar em condições reais.

Argumentos brutos do comando:
`$ARGUMENTS`

Restrições:
- Este comando serve somente para revisão.
- Não corrija problemas, aplique patches nem sugira que fará alterações.
- Execute a revisão e devolva a saída do companion verbatim.
- Se o usuário pedir correções depois, siga a skill `opc-result-handling` e pergunte quais achados devem ser corrigidos antes de tocar em qualquer arquivo.

Sempre passe os argumentos do usuário por stdin com `--raw-args-stdin` e heredoc entre aspas, exatamente como nos comandos abaixo, para que o shell não os expanda (o foco pode conter aspas, apóstrofos, crases ou `$()`). O companion reconhece as opções conhecidas e preserva o restante como foco, verbatim.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

<!-- shared:review-flow -->
Execução:
- Se os argumentos brutos incluírem `--wait` ou `--background`, não pergunte. Execute diretamente. Para primeiro plano, use Bash com `timeout: 600000`:

```bash
opc adversarial-review --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Caso contrário, estime primeiro:

```bash
opc adversarial-review --estimate --json --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
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
opc adversarial-review --wait --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

  Devolva stdout verbatim, sem paráfrase, resumo ou comentário. Exit code 6 significa que a espera expirou, mas a tarefa continua; informe `/opc:status <job-id> --wait` com o id impresso.
- Background (usuário escolheu executar em segundo plano):

```bash
opc adversarial-review --background --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

  Devolva stdout verbatim, que inclui o id e as linhas `/opc:status` e `/opc:result`.
- Preserve os argumentos exatamente; não acrescente instruções nem reescreva a intenção. Exit code 4 significa que a política opc negou o modelo de revisão; exit code 5 significa que o servidor OpenCode está indisponível: indique `/opc:setup`.
<!-- /shared:review-flow -->

Tratamento específico: ao contrário de `/opc:review`, este comando recebe texto livre de foco depois das opções e deve preservar o foco verbatim, sem enfraquecer a revisão adversarial. A seleção do alvo aceita working tree, branch ou `--base <ref>`; não aceita escopos staged-only ou unstaged-only.
