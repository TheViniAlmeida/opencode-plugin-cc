---
description: Mostra como abrir uma sessão do opc na TUI do OpenCode; --pane abre num split do tmux
argument-hint: '[sessionID] [--pane] [--json]'
disable-model-invocation: true
allowed-tools: Bash(opc:*), Bash(tmux:*)
---

Execute exatamente com a ferramenta Bash (use `timeout: 600000`). Os argumentos do usuário passam por um heredoc entre aspas, portanto o shell não os expande; não os edite, cite nem escape.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc attach --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Apresente a saída como veio. A linha impressa lê a senha de um arquivo de modo 600 para a variável de ambiente; nunca peça, mostre ou copie a senha.
- `--pane` precisa do tmux; se falhar, mostre a linha impressa para o usuário rodar num terminal.
