---
description: Consulta modelos em paralelo, conduz debate ou revisa alterações atuais
argument-hint: '[--mode opinion|debate|review] [--models a,b] [pergunta]'
allowed-tools: Bash(opc:*), Read, Grep, Glob, AskUserQuestion
---

Consulta paralela via opc. Os argumentos seguem sem alteração pelo heredoc citado.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

Execute exatamente um comando:

```bash
opc conclave --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- **0** — apresente o relatório. Se a síntese estiver a cargo do Claude, siga a skill `opc-conclave`.
- **3** — apresente o pedido e siga `opc-result-handling`; não aprove pelo usuário.
- **6** — informe o id e `/opc:status <id> --wait`.
- **7** — apresente a falha e o resultado parcial, se houver.
- **2 / 4 / 5 / 130** — apresente o erro emitido pelo comando.
