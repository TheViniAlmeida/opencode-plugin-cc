---
description: Roda um slash command do OpenCode (veja /opc:catalog commands) num job próprio
argument-hint: '<cmd> [args...] [--agent a] [--model m] [--write] [--background]'
allowed-tools: Bash(opc:*)
---

Execute exatamente com a ferramenta Bash (use `timeout: 600000`). Os argumentos do usuário passam por um heredoc entre aspas, portanto o shell não os expande; não os edite, cite nem escape.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc command --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Apresente a saída sem resumir.
- Exit 4: o command fixa um modelo ou agente negado pela política; explique e não tente contornar.
- Exit 3: pedido de permissão pendente; siga a skill `opc-result-handling`.
