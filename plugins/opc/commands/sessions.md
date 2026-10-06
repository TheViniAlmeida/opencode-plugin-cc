---
description: Lista as sessões OPC do OpenCode neste workspace (--all para todas)
argument-hint: '[--all] [--limit N] [--refresh] [--json]'
allowed-tools: Bash(opc:*)
---

Execute exatamente com a ferramenta Bash (use `timeout: 600000`). Os argumentos do usuário passam por um heredoc entre aspas, portanto o shell não os expande; não os edite, cite nem escape.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc sessions --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Apresente a saída como veio (tabela Markdown), sem resumir.
- `--refresh` relê a lista de sessões; não reinicia nem descarta o servidor.
