---
description: Cancela uma tarefa ativa do opc (sem id: a única tarefa ativa desta sessão)
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Execute exatamente isto com a ferramenta Bash. Os argumentos devem passar pelo heredoc entre aspas; não os edite.

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc cancel --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Apresente a saída sem alterações. Se várias tarefas estiverem ativas, o comando as lista e termina com código `2`: mostre a lista e pergunte qual deve ser cancelada.
