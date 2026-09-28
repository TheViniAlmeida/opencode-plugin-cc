---
description: Mostra o resultado final salvo de uma tarefa do opc
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Execute exatamente isto com a ferramenta Bash. Os argumentos devem passar pelo heredoc entre aspas; não os edite.

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc result --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Apresente toda a saída sem alterações: texto final, saída estruturada, erros, arquivos alterados, caminhos e números de linha exatamente como impressos, e comandos seguintes como `/opc:task --resume <valor>`. O código `2` com `JOB_ACTIVE` significa que a tarefa está ativa: sugira `/opc:status <valor> --wait`.
