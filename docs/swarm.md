# Swarm: roteamento, fallback, delegação, worker e monitor

Este guia cobre as capacidades de swarm entregues na F4a. A orquestração (`/opc:orchestrate`) entra na F4b e o conclave (`/opc:conclave`) na F4c.

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
