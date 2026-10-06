---
description: Transfere a conversa atual do Claude Code para uma sessão OpenCode retomável
argument-hint: '[--source <claude-jsonl>] [--model <provider/model|alias>]'
disable-model-invocation: true
allowed-tools: Bash(opc:*)
---

Transfira a conversa para o OpenCode executando exatamente isto com a ferramenta Bash (use `timeout: 180000`). Os argumentos devem passar pelo heredoc entre aspas; não os edite.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc transfer --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Apresente a saída ao usuário exatamente como retornada, preservando o ID da sessão e a linha `cd … && opencode --server <url> -s <id>`. Para conectar, o terminal precisa de `OPENCODE_SERVER_PASSWORD` no ambiente.
- Em erro, mostre o código e a mensagem (`TRANSCRIPT_OUTSIDE_ALLOWED_ROOT`, `NO_MODEL`, `IMPORT_FAILED`…) sem tentar contornar.
- Sem `--source`, o comando usa a transcrição desta sessão (`OPC_COMPANION_TRANSCRIPT_PATH`, exportado pelo hook SessionStart).
- Não rode `opencode` você mesmo e não altere a configuração.
