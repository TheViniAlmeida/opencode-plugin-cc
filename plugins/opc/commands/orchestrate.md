---
description: Decompõe uma tarefa em subtarefas, executa cada uma com modelos do OpenCode (em paralelo quando possível) e entrega os resultados para síntese
argument-hint: '<tarefa> [--planner <modelo>] [--max N] [--synthesizer claude|<modelo>] [--write] [--background]'
allowed-tools: Bash(opc:*), Read, Grep, Glob, AskUserQuestion
---

Orquestração multi-modelo via opc. Os argumentos do usuário seguem **sem alteração** para o
companion, por heredoc com delimitador entre aspas (nada é expandido pelo shell); as flags
conhecidas são reconhecidas como palavras inteiras e o resto é a tarefa, verbatim.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

Execute exatamente um comando:

```bash
opc orchestrate --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Regras:

- Não reescreva, resuma nem complete os argumentos. Não acrescente `--write` por conta própria:
  só use se o usuário pediu mudanças em arquivos.
- Não execute as subtarefas você mesmo, nem antes nem depois do comando.
- Conforme o exit code:
  - **0** — mostre a saída. Se a seção "Síntese" disser que a síntese está a cargo do Claude,
    siga a seção "Orquestração" da skill `opc-delegation`: valide os resultados contra o código
    (Read/Grep nas referências citadas) e escreva a síntese, citando o id de cada subtarefa.
    Se já houver síntese por modelo, apresente-a e aponte onde ela contradiz os resultados brutos.
  - **3** — uma subtarefa de escrita pediu permissão. Apresente o pedido e siga a skill
    `opc-result-handling` (aprovador); nunca responda sozinho quando o aprovador for o usuário.
  - **6** — o job continua em execução; informe o id e `/opc:status <id> --wait`.
  - **7** — mostre o motivo (plano inválido, falha do planner ou de todas as subtarefas) e o
    plano bruto, se houver. Não tente cumprir a tarefa por outro caminho sem pedido do usuário.
  - **2 / 4 / 5** — erro de uso, política (inclusive `INSIDE_SERVER`: opc não delega de dentro do
    servidor OpenCode) ou conexão: mostre a mensagem e a correção sugerida.
  - **130** — a orquestração foi cancelada; mostre a saída de erro como está. Não tente novamente
    nem execute a tarefa por conta própria.
- Com `--background`: informe o id e os comandos `/opc:status <id> --wait` e `/opc:result <id>`.
- Subtarefas `task` alteram arquivos: liste os "Arquivos tocados" e recomende revisar o diff.
