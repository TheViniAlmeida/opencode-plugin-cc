# Swarm: roteamento, fallback, delegação, worker e monitor

Este guia cobre as capacidades de swarm entregues na F4a e F4b. O conclave (`/opc:conclave`) entra na F4c.

## Roteamento de modelos

Cada comando usa o primeiro nível não vazio desta ordem:

| # | Nível | Exemplo | Fallback |
|---|---|---|---|
| 1 | `--model` explícito | `opc ask --model k3 "…"` | Não |
| 2 | `--tier light\|heavy` | `opc plan --tier heavy "…"` | Sim, lista |
| 3 | Modelo específico do tipo | `reviewModel: "strong"` | Não |
| 4 | `routing.tasks.<kind>` | `routing.tasks.ask: ["fast", "k3"]` | Sim, lista |
| 5 | `defaultModel` | — | Não |
| 6 | Default do OpenCode | `GET /config` → `model` | Não |

`--tier` aceita somente `light` e `heavy`; tier desconhecido ou vazio é erro de uso (exit 2). Entradas negadas pela política ou inexistentes são ignoradas com `[opc] aviso:` em stderr e ficam em `request.routingWarnings`. Se não sobrar candidato, o comando falha antes de criar sessão. `--resume` nunca usa fallback.

## Fallback

Para uma rota em lista, um erro recuperável abre sessão nova com o próximo candidato e o mesmo prompt. O máximo total é `routing.fallback.maxAttempts` (padrão 3) e o backoff fixo é 2 s, 4 s e 8 s. `routing.fallback.enabled: false` desliga esse comportamento.

São recuperáveis erros marcados como repetíveis, 404, timeout, teto de retries do OpenCode e casos elegíveis de saída estruturada ou contexto. Respostas 400/402, erro fatal, perda do servidor, cancelamento e `AbortUnconfirmed` não acionam fallback. Em `--write`, se alguma ferramenta já rodou, a falha usa `WRITE_NO_FALLBACK` e informa arquivos tocados e ferramentas executadas.

Cada tentativa pertence ao mesmo job em `attempts[]`, com modelo, sessão, estado, classe/tipo de erro e horários. `opc result` mostra `## Tentativas (N)` quando há mais de uma; `status --json` e `result --json` trazem o array.

## Orquestração (`/opc:orchestrate`)

A orquestração divide uma tarefa em subtarefas, executa cada uma em uma sessão do OpenCode e
entrega os resultados para síntese. Tudo roda como um job-grupo `orch-…`, com um worker
coordenador; planner, `worker:<n>` e sintetizador são membros visíveis em `/opc:status`.

1. O planner recebe a tarefa, o contexto de projeto configurado e `orchestrate-decompose.md`.
   Ele usa perfil `read-only`, gera de 2 a `maxSubtasks` subtarefas e o plano passa pelo schema
   `orchestrate-plan` e por validação adicional. O modelo vem de `--planner` (ou `-m`),
   `orchestrate.planner` ou da resolução normal de rota.
2. O plano é recusado como `invalid_plan` se tiver tamanho inválido, id inválido ou duplicado,
   dependência ausente, ciclo, `task` sem `--write`, ou agente inexistente/negado. Nenhuma
   subtarefa é executada; `planErrors` e o plano bruto ficam no resultado.
3. Uma subtarefa só inicia quando todas as dependências concluíram. Leituras (`ask`, `plan` e
   `review`) prontas ocupam até `jobs.maxParallel`; `task` usa perfil `write` e há no máximo
   uma escrita por vez, embora leituras possam continuar em paralelo. Falha ou cancelamento de
   uma dependência cancela a dependente com `dependency_failed`.
4. A rota de subtarefa é `routing.tiers.<tier>` quando há `tier`, senão
   `routing.tasks.<kind>` e, sem lista, a cadeia normal. O espalhamento prefere o primeiro
   modelo ainda não usado por outra subtarefa do grupo; depois usa rodízio. Entradas negadas ou
   inexistentes são ignoradas com aviso; uma rota sem candidato falha somente aquela subtarefa
   com `no_model`.
5. O resultado de uma dependência concluída entra na dependente em
   `<dependency id="…">…</dependency>`, limitado a 8 KB sem quebrar UTF-8. Marcadores no
   conteúdo são neutralizados e o prompt determina que esse conteúdo é dado, não instrução.
6. Com `--synthesizer claude` (padrão), Claude recebe o pacote estruturado e faz a síntese
   seguindo `opc-delegation`. Com um modelo, uma sessão `read-only` usa
   `orchestrate-synthesize.md`; se ela falhar, o grupo termina concluído com avisos e os
   resultados brutos voltam para Claude.

| Situação | Resultado |
|---|---|
| `StructuredOutputError` do planner (modo `tool`) | `planner_structured_output`, grupo falha |
| Falha do turno do planner ou nenhum objeto JSON extraído (modo `text`) | `planner_failed`, grupo falha |
| Plano inválido, inclusive saída estruturada que não é objeto | `invalid_plan`, grupo falha |
| Nenhuma subtarefa concluiu | `all_subtasks_failed`, grupo falha |
| Parte das subtarefas falha | `completed_with_warnings`, exit 0 |
| Cancelamento do grupo | Sessões são abortadas, pendentes são canceladas, exit 130 |
| Erro de persistência do coordenador | `coordinator_error`, grupo falha |

O planner usa `orchestrate.structuredOutput: "text"` por padrão: pede um único objeto JSON em
uma cerca `json` e o opc o extrai e valida. Isso evita o `StructuredOutputError` observado no
OpenCode 1.18.32 pelo gateway quando `format: json_schema` era enviado. O modo `tool` é opt-in.

```bash
# Leitura, síntese pelo Claude
opc orchestrate "Mapeie o tratamento de erros de scripts/lib, revise-o e proponha testes"

# Síntese por modelo, no máximo três subtarefas, em background
opc orchestrate --synthesizer omniroute-personal/cmd/<modelo> --max 3 --background \
  "Compare as estratégias de cache de src/cache e src/http"

# Escritas em série entre si
opc orchestrate --write "Adicione validação de entrada em src/math.mjs e escreva os testes"
```

Os exemplos de saída executada e redigida ficam no portão de validação da fase; a invocação
manual pelo slash command em uma sessão real do Claude Code permanece **A CONFIRMAR (operador)**.

## Delegação automática

A skill `opc-delegation` orienta Claude a delegar investigação e perguntas sobre código para `opc ask`, planos para `opc plan` e review de diff para `opc review --wait`. Resultados precisam ser validados, permissões nunca são respondidas sem o usuário e jobs delegados não devem encadear novas delegações.

Com `delegation.auto: true` na configuração global, o `SessionStart` injeta esse lembrete. O `.opc.json` do workspace pode desligá-lo com `false`, mas não ligá-lo.

```bash
opc config set delegation.auto true
```

## Worker para Agent Teams (`opc-worker`)

`opc-worker` é um relay com Bash: para cada tarefa, executa exatamente um `opc ask`, `opc plan`, `opc review` ou `opc task` e devolve a saída. Usa `--wait-timeout 540`, nunca usa `--background`, não responde permissões e não possui ferramenta Agent.

| Situação | Mensagem inicial |
|---|---|
| Antes de rodar | `⚡ opc \| <resumo>` |
| Exit 0 | `✓ opc done` |
| Exit 3 | `⏸ opc waiting` |
| Exit 6 | `⏸ opc waiting` |
| Outro exit | `✗ opc failed (exit N)` |

Flags e texto entram literalmente no heredoc citado; a linha `--` separa flags do texto da tarefa. A execução em um Agent Team real permanece **A CONFIRMAR (operador)**.

## Monitor

`opc monitor` acompanha todos os jobs do workspace no terminal, lendo somente estado e logs. Exibe fase, modelo, tentativa, pedidos pendentes e linhas recentes de log; nunca altera estado.

| Flag | Efeito |
|---|---|
| `--job <id\|prefixo>` | Foca job ou grupo, com tentativas e 10 linhas de log |
| `--once` | Desenha um quadro e sai |
| `--json` | Imprime snapshot JSON e sai |
| `--color auto\|always\|never` | Controla cor ANSI |
| `--interval <ms>` | Atualização; padrão 1000, mínimo 100 |

Ctrl+C sai com exit 0. A inspeção visual manual permanece **A CONFIRMAR (operador)**.
