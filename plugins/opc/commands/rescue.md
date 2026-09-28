---
description: Encaminha investigação, pedido explícito de correção ou trabalho de continuação ao OpenCode pelo subagente opc-rescue
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--variant <variant>|--effort <variant>] [--agent <agent>] [o que o OpenCode deve investigar, corrigir ou continuar]"
allowed-tools: Bash(opc:*), AskUserQuestion, Agent
---

<!-- Adapted from openai/codex-plugin-cc (Apache-2.0); modified -->

Acione o subagente `opc:opc-rescue` pela ferramenta `Agent` (`subagent_type: "opc:opc-rescue"`), encaminhando o pedido bruto do usuário como prompt. O subagente é um agente, não uma skill. Não chame `Skill(opc:opc-rescue)` (essa skill não existe) nem `Skill(opc:rescue)` (isso reentra neste comando e trava a sessão). O comando é executado inline para manter a ferramenta `Agent` disponível.
A resposta final visível ao usuário deve ser a saída do subagente verbatim.

Pedido bruto do usuário:
$ARGUMENTS

Modo de execução:
- Execute o subagente `opc:opc-rescue` em primeiro plano.
- Se o pedido incluir `--background`, mantenha-o no pedido encaminhado: o subagente o passa para `opc task`, que inicia uma tarefa em background e devolve seu id imediatamente.
- `--wait` é o padrão; remova-o antes de encaminhar.
- `--model`, `--variant`, `--effort` e `--agent` são opções de execução: mantenha-as no pedido encaminhado, separadas do texto natural da tarefa.
- Se o pedido incluir `--resume` ou `--fresh`, não pergunte; o usuário já escolheu.
- Caso contrário, antes de iniciar OpenCode, verifique se há sessão retomável desta sessão Claude:

Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` (ou `OPC_JSON_5f1d0c7a_EOF` quando usado), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado.

```bash
opc task-resume-candidate --json
```

- Se indicar `available: true`, use `AskUserQuestion` exatamente uma vez com estas opções:
  - `Continuar a sessão OpenCode atual`
  - `Começar uma nova sessão OpenCode`
- Se o pedido indicar claramente uma continuação ("continue", "keep going", "resume", "apply the top fix", "dig deeper", "continua", "segue"), coloque primeiro `Continuar a sessão OpenCode atual (Recomendado)`. Caso contrário, coloque primeiro `Começar uma nova sessão OpenCode (Recomendado)`.
- Continuar → acrescente `--resume` ao pedido encaminhado. Nova → acrescente `--fresh`.
- Se indicar `available: false`, não pergunte; encaminhe normalmente.
- Se o helper sair com código 5 ou informar que OpenCode não está instalado, pare e indique `/opc:setup`.

Regras de operação:
- O subagente é apenas um encaminhador: faz uma chamada `Bash` para `opc task ...` e devolve stdout como está.
- Devolva a saída do subagente verbatim. Não parafraseie, resuma, reescreva nem acrescente comentário.
- Não peça ao subagente para inspecionar arquivos, monitorar o progresso, consultar `/opc:status`, buscar `/opc:result`, chamar `/opc:cancel` nem responder a pedidos de permissão.
- Se a saída mostrar um pedido de permissão ou pergunta pendente (exit code 3), trate-o você na conversa principal seguindo a skill `opc-result-handling` (regras de aprovador). O subagente nunca responde.
- Deixe modelo e variante sem definir, a menos que o usuário os peça explicitamente.
- Se o usuário não fornecer um pedido, pergunte o que o OpenCode deve investigar ou corrigir.
