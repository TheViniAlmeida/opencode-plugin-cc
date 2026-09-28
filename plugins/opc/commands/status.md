---
description: Mostra as tarefas do opc (ativas e recentes) neste repositório
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Execute exatamente isto com a ferramenta Bash (use `timeout: 600000` quando `--wait` estiver presente). Os argumentos devem passar pelo heredoc entre aspas; não os edite.

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc status --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Se o usuário não informou um identificador de tarefa, apresente a saída em uma tabela Markdown compacta com as tarefas atuais e recentes; mantenha identificador, tipo, estado, fase, tempo, resumo e comandos seguintes, sem texto adicional.

Se o usuário informou um identificador, apresente toda a saída sem resumir. O código `3` significa que a tarefa aguarda uma decisão: mostre a solicitação como impressa e siga a skill `opc-result-handling`. O código `6` significa que o tempo de espera terminou e a tarefa continua em execução.
