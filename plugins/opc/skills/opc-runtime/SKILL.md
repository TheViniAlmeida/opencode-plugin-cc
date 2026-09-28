---
name: opc-runtime
description: Contrato interno para chamar o runtime de tarefas opc a partir do subagente opc-rescue
user-invocable: false
---

<!-- Adapted from openai/codex-plugin-cc (Apache-2.0); modified -->

# Runtime opc

Use esta skill somente dentro do subagente `opc:opc-rescue`.

O auxiliar principal é `opc task`. O executável `opc` está no PATH do Bash por meio de `bin/` do plugin.

Regras de execução:
- O subagente de resgate é um encaminhador, não um orquestrador. Sua única função é invocar `task` uma vez e devolver o stdout sem alterações.
- Use `--write` somente quando o usuário pedir edições; pedidos de planejamento, análise e revisão nunca usam `--write`.
- Faça exatamente uma invocação de `task` por encaminhamento de resgate, seja para diagnóstico, planejamento, pesquisa ou pedido explícito de correção.
- Prefira o auxiliar a comandos `git` feitos à mão, comandos `opencode` diretos ou qualquer outra atividade no Bash.
- Não chame `setup`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `permissions` ou `session` a partir de `opc:opc-rescue`.
- Você pode usar a skill `opc-prompting` para ajustar o texto da tarefa antes da única chamada `task`. Esse é o único trabalho permitido do lado do Claude.

Formato do comando (as opções escolhidas ficam nas primeiras linhas do bloco; o texto da tarefa vem depois de `--`, para que o shell não expanda aspas, apóstrofos, crases ou `$()` e não interprete o texto como opções):

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando aplicável), não execute nada; informe que os argumentos contêm o delimitador reservado.

```bash
opc task --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
<opções de execução, uma por linha>
--wait-timeout 540
--
<texto da tarefa exatamente como recebido>
OPC_ARGS_5f1d0c7a_EOF
```

Execute com a ferramenta Bash usando `timeout: 600000`; `--wait-timeout 540` faz o companion retornar (exit 6, job ainda em execução) antes desse limite.

Mapeamento de opções:

| No pedido encaminhado | Opção de `opc task` |
|---|---|
| (padrão) | `--write` somente quando o usuário pediu edições |
| planejamento, análise ou revisão | remover `--write` |
| `--resume` | `--resume-last` |
| `--fresh` | `--fresh` |
| `--background` | `--background` |
| `--wait` | remover; execução em primeiro plano é o padrão |
| `--model <m>` | `--model` e `<m>` em linhas separadas no bloco |
| `--variant <v>` ou `--effort <v>` | `--variant` e `<v>` em linhas separadas no bloco |
| `--agent <a>` | `--agent` e `<a>` em linhas separadas no bloco |

- Deixe modelo, variante e agente sem valor, a menos que o usuário os peça explicitamente. O roteamento do opc escolhe o modelo.
- `--resume` sempre significa `--resume-last`, mesmo se o texto estiver ambíguo; `--fresh` sempre inicia uma nova sessão, mesmo se o texto parecer continuação.
- Remova todas as opções do texto da tarefa e coloque-as no início do bloco; preserve as demais palavras do usuário depois da linha `--`.

Códigos de saída (devolva o stdout sem alterações em todos os casos em que houver saída):
- `0`: tarefa concluída; `3`: aguardando resposta a uma permissão ou pergunta; `6`: tempo de espera esgotado e job continua.
- `2`: erro de uso; `4`: negado pela política do opc; `5`: problema com servidor ou conexão; `7`: tarefa falhou; `130`: cancelada.

Regras de segurança:
- Nunca execute `opc permissions reply` nem `opc permissions answer`. Nunca passe `--confirmed-by-user`. Nunca responda `always`. Solicitações de permissão voltam à conversa principal.
- Nunca execute `opc setup --stop-server`, `opc session revert` ou `opc config set`.
- Não exporte nem altere variáveis de ambiente `OPC_*`.
- Não inspecione o repositório, leia arquivos, use grep, monitore progresso, consulte status, busque resultados, cancele jobs, resuma a saída nem faça trabalho posterior próprio.
- Se a chamada Bash falhar sem stdout ou `opc` não puder ser invocado, retorne um diagnóstico curto com o código de saída, as primeiras linhas de stderr e a frase `nenhum resultado do OpenCode foi produzido`. Não retorne uma resposta vazia nesse caso.
