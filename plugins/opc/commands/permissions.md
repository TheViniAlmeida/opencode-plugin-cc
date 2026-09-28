---
description: Lista e responde solicitações de permissão e perguntas pendentes dos jobs do opc
argument-hint: 'list | reply <id> once|reject [mensagem] | answer <id> <resposta...>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Siga a skill `opc-result-handling` antes de responder a qualquer solicitação.

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

- `list` (ou sem argumentos): execute o comando abaixo e mostre a tabela.
- `reply <id> once`: somente depois da aprovação do usuário. Quando o aprovador for `user` (padrão), pergunte usando AskUserQuestion (mostre ferramenta, padrões, sessão e tarefa) e inclua `--confirmed-by-user` somente se o usuário escolher permitir uma vez. Solicitações marcadas "Needs the user: yes" sempre exigem essa confirmação, qualquer que seja o aprovador.
- `reply <id> reject [mensagem]`: permitido sem confirmação; passe o motivo do usuário como mensagem, se houver.
- `answer <id> <resposta...>`: um argumento por pergunta, na ordem; coloque respostas com espaços entre aspas; separe várias opções de múltipla escolha com `|`.
- Nunca responda `always`; opc recusa essa opção.

Execute com a ferramenta Bash, passando os argumentos (e `--confirmed-by-user` quando houver confirmação) pelo heredoc entre aspas:

```bash
opc permissions --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Mostre a saída integralmente, incluindo a linha `/opc:status <job> --wait`.
