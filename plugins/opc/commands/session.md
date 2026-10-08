---
description: Gerencia sessões do OpenCode (new, show, fork, revert, unrevert, summarize, children, diff)
argument-hint: '<new|show|fork|revert|unrevert|summarize|children|diff> [sessionID] [messageID] [--before messageID] [--title t] [--agent a] [--model m] [--write]'
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
- Apresente a saída ao usuário sem resumir. Em `show`, preserve os IDs de mensagem (são eles que `fork` e `revert` usam); a lista traz as mensagens mais recentes.
- `FORK_INHERITANCE_FAILED` no `fork`: o fork foi criado sem as regras ou o modelo da origem. Mostre a mensagem, não use esse fork e não tente de novo por conta própria; o usuário deve apagá-lo no OpenCode.
- `summarize` espera a compactação dentro de um único `--timeout`; com `TIMEOUT` a compactação continua no servidor. Avisos de revert pendente (stderr) devem ser repassados ao usuário.
- Código de saída 2 com "confirmação necessária" (`revert`/`unrevert`) **não é erro**: siga a skill `opc-result-handling`. Mostre a prévia impressa (no `revert`, o aviso de escopo do OpenCode 2; no `unrevert`, o diff do revert ativo, quando houver) e pergunte com AskUserQuestion ("Reverter" / "Cancelar"; em `unrevert`, "Desfazer o revert" / "Cancelar"). Só com a resposta afirmativa, confirme pelo mesmo heredoc: o corpo é a linha impressa **sem** o prefixo `opc session` (subcomando, IDs e `--confirmed-by-user`, sem alterar nada). Nunca passe IDs na linha de comando do `opc`.
- Nunca acrescente `--confirmed-by-user` por conta própria, nem reaproveite uma confirmação anterior para outra sessão ou mensagem.
- `SNAPSHOT_DISABLED` no `revert` não é falha do opc: a config do OpenCode tem `"snapshot": false`. Mostre a mensagem e não tente de novo.
