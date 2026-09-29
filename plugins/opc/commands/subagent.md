---
description: Dispara subagentes do OpenCode em paralelo (um por agente/modelo) como um grupo de jobs
argument-hint: '--agent a[,b,c] [--model m[,m2,m3]] [--write] [--background] [--mechanism child-session|subtask] <prompt>'
allowed-tools: Bash(opc:*)
---

Execute exatamente com a ferramenta Bash (use `timeout: 600000`). Os argumentos do usuário passam por um heredoc entre aspas, portanto o shell não os expande; não os edite, cite nem escape.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc subagent --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Apresente o resultado de **cada** membro separadamente (agente, modelo, sessão, texto ou erro); não funda as respostas numa só sem avisar.
- Exit 3: um membro pediu permissão ou fez pergunta. Siga a skill `opc-result-handling` (pergunte ao usuário antes de qualquer `/opc:permissions reply`).
- `--write` roda os membros em série e pode editar arquivos: só use se o usuário pediu escrita.
