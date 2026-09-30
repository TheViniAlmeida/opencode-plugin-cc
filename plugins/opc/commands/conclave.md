---
description: Consulta vários modelos do OpenCode em paralelo (opinião, debate ou review cruzado) e sintetiza consenso, divergências e recomendação
argument-hint: '<pergunta> [--models a,b,c | --pool nome] [--mode opinion|review|debate] [--rounds 1-3] [--judge claude|<modelo>] [--quorum N] [--allow-judge-member] [--background]'
allowed-tools: Bash(opc:*), Bash(git:*), AskUserQuestion
---

Rode um conclave do opc: vários modelos respondem à mesma pergunta sem se ver, podem debater anonimamente e, no fim, alguém sintetiza (um modelo juiz ou você, Claude).

## Passos

1. Se `$ARGUMENTS` estiver vazio, pergunte ao usuário (AskUserQuestion) qual é a pergunta e pare até ter a resposta. No `--mode review` a pergunta é opcional (vira o foco do review).
2. No `--mode review` sem `--background`: meça o tamanho do diff com `git status --short --untracked-files=all` e `git diff --shortstat`. Se o diff for grande (mais de ~20 arquivos ou ~1500 linhas), pergunte uma vez (AskUserQuestion) entre "Esperar" e "Background", recomendando Background.
3. Execute exatamente um comando, passando os argumentos por stdin (nunca interpole `$ARGUMENTS` na linha de comando):

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc conclave --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

O texto do heredoc chega verbatim (aspas, crases e apóstrofos não são interpretados); as flags conhecidas são reconhecidas como palavras inteiras em qualquer posição. Se o usuário escolheu Background no passo 2, use `opc conclave --background --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'` (a flag fica na linha de comando, antes de `--raw-args-stdin`).

4. Leia a saída inteira:
   - **Background:** mostre o id do job e as linhas `/opc:status <id>` e `/opc:result <id>`. Pare.
   - **Exit 2 ou 4:** mostre a mensagem de erro como veio (composição, quorum, política). Não tente de novo com outros modelos por conta própria.
   - **Exit 7 (quorum não atingido):** mostre o cabeçalho, as falhas e as respostas parciais. Não sintetize como se houvesse consenso.
   - **Sucesso com juiz Claude** (a seção "Síntese" pede a skill `opc-conclave`): use a skill `opc-conclave` e sintetize a partir das respostas por rótulo. Se precisar de detalhes que não estão no texto, rode `opc result <id> --json` (saída `{ group, members }`; o pacote está em `group.result`).
   - **Sucesso com juiz modelo:** mostre a síntese do juiz e, com a skill `opc-conclave`, confira se ela é fiel às respostas; aponte divergências entre o juiz e os membros.
   - **Modo review:** apresente o veredito, os clusters por severidade com a concordância `k/N` e as recomendações. Não corrija nada: pergunte ao usuário o que fazer.
5. A composição (rótulo → modelo) só aparece no fim da sua resposta, copiada da tabela "Composição".
