---
description: Gerencia sessões do OpenCode (new, show, fork, revert, unrevert, summarize, children, diff, todo)
argument-hint: '<new|show|fork|revert|unrevert|summarize|children|diff|todo> [sessionID] [messageID] [--title t] [--agent a] [--model m] [--write]'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Execute exatamente com a ferramenta Bash (use `timeout: 600000`). Os argumentos do usuário passam por um heredoc entre aspas, portanto o shell não os expande; não os edite, cite nem escape.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc session --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Regras:
- Apresente a saída ao usuário sem resumir. Em `show`, preserve os IDs de mensagem (são eles que `fork` e `revert` usam).
- Código de saída 2 com "confirmação necessária" (`revert`/`unrevert`) **não é erro**: siga a skill `opc-result-handling`. Mostre o diff afetado, pergunte com AskUserQuestion ("Reverter" / "Cancelar") e, só se o usuário escolher reverter, rode o comando impresso, que já traz `--confirmed-by-user`.
- Nunca acrescente `--confirmed-by-user` por conta própria, nem reaproveite uma confirmação anterior para outra sessão ou mensagem.
