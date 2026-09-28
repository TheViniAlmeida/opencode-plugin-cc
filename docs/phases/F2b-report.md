# F2b — Relatório de fase (paridade Codex: review, gate, rescue, hooks)

- **Data:** 28/09/2026
- **Branch/commit:** `feat/opc-f2b` @ `f08c0f1`
- **Ambiente:** Node `22.22.1`, OpenCode `1.18.32`, Linux
- **Modelo ao vivo:** `omniroute-personal/cmd/deepseek/deepseek-v4-flash`

## Premissas do F2a (Task 1)

| # | Resultado | Ajuste aplicado |
| --- | --- | --- |
| P1 | PASSOU — construtor de erro confirmou formato esperado | — |
| P2 | PASSOU — prefixos `review-` e `gate-` | — |
| P3 | PASSOU — `createJob` gera ID, separa entrada e aplica limite | — |
| P4 | PASSOU — módulos e contratos indicados presentes | — |
| P5 | PASSOU — `waitForJob` mapeia timeout para exit 6 | — |
| P6 | PASSOU — cancelamento não restringe kind | — |
| P7 | PASSOU — fake suporta saída estruturada, erro e atraso | — |
| P8 | PASSOU — catálogo contém provider conectado | — |
| P9 | PASSOU — setup usa `ensureServer` | — |
| P10 | PASSOU — ciclo de servidor compartilha `server.lock` | — |
| P11 | PASSOU — listagem global de jobs não filtra sessão | — |
| P12 | PASSOU — registro de servidor validado; inclui senha como requisito interno | Ressalva registrada |
| P13 | PASSOU — parser aceita stdin bruto e flags de turno | — |

## `npm test`

```text
1008 tests, 1007 pass, 1 skip
```

## Aceite de integração (spec §13.3 F2b)

| Item | Teste | Status |
| --- | --- | --- |
| Review com saída no schema | `review.test.mjs` › review --wait / --json | PASSOU |
| Diff grande → modo em partes | `git.test.mjs` › huge-diff; `review.test.mjs` › huge diff | PASSOU |
| Gate: `BLOCK:` bloqueia | `stop-gate.test.mjs` › BLOCK | PASSOU |
| Gate: `ALLOW:` permite | `stop-gate.test.mjs` › ALLOW | PASSOU |
| Gate: `stop_hook_active` permite | `stop-gate.test.mjs` › stop_hook_active | PASSOU |
| Gate: servidor indisponível permite com aviso | `stop-gate.test.mjs` › server unavailable | PASSOU |
| Gate: saída fora do formato permite com aviso | `stop-gate.test.mjs` › malformed | PASSOU |
| Nota de jobs ativos | `stop-gate.test.mjs` › active jobs | PASSOU |
| SessionEnd < 1 s e dispara o reaper | `hooks-lifecycle.test.mjs` › SessionEnd | PASSOU |
| Reaper: `clear`/`resume` mantêm o servidor | `hooks-lifecycle.test.mjs` › clear and resume | PASSOU |
| Duas sessões do Claude | `hooks-lifecycle.test.mjs` › two Claude sessions | PASSOU |
| Corrida reaper × novo job sob lock | `hooks-lifecycle.test.mjs` › reaper × new job; lock held | PASSOU |
| `--stop-server` com jobs ativos → recusa | `setup-gate.test.mjs` › --stop-server refuses | PASSOU |

## Aceite ao vivo

| Item | Critério | Execuções | Status |
| --- | --- | --- | --- |
| `/opc:review` num diff real | JSON válido no schema, ≥ 2 de 3 | 3/3 schema-valid | PASSOU |
| `/opc:adversarial-review` com foco | JSON válido, ≥ 2 de 3 | 2/3; critério atingido | PASSOU |
| Stop gate com erro plantado | ≥ 2 `BLOCK` de 3, 0 `INFRA` | `BLOCK` 3/3; `stop_hook_active` permitiu | PASSOU |
| `/opc:rescue` (companion) | candidato + resume mantém `sessionID` | resume | PASSOU |
| `/opc:rescue` (pergunta no Claude) | manual, Step 9.1 | Não executado com Claude Code | NÃO VALIDADO — requer operador |
| SessionEnd `clear` mantém o servidor | `f2b-session-end.mjs` | clear/stop | PASSOU |
| `/clear` no Claude real | manual, Step 9.2 | Não executado com Claude Code | NÃO VALIDADO — requer operador |
| `contract.mjs` | sem divergência | contract | PASSOU |

## §15 item 9 — `ppid` do hook é o processo do Claude?

- Saída da sonda (redigida): NÃO VALIDADO.
- Resposta: NÃO VALIDADO.
- Consequência: mantém o fallback de 24 h para sessão com PID morto; a F3 só poderá apertá-lo após sonda com Claude Code e plugin instalados (`tests/live/probe-hook-ppid.mjs`).

## Saídas reais redigidas

```text
$ opc review --wait
# OPC Revisão
Alvo: diff da árvore de trabalho
Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Job: review-<id>
Veredito: needs-attention
Achados: sum com off-by-one, divide ignora o divisor, average sem entrada vazia.
```

```text
$ opc adversarial-review --wait foco em entradas vazias e divisão por zero
# OPC Revisão Adversarial
Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Veredito: needs-attention
Achados: off-by-one em sum, divisão fixa por zero e average vazio.
```

```text
$ opc hook-stop
{"decision":"block","reason":"opc stop gate: src/math.js tem bugs bloqueadores introduzidos na resposta anterior."}
```

```text
$ opc task --wait
Tarefa: task-<id> · Sessão: ses_<id> · Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Continuar: /opc:task --resume task-<id>
```

## Desvios

| Desvio | Motivo | Muda interface? |
| --- | --- | --- |
| Modelo ao vivo diferente do planejado | `qwen3.8-max` estava com credenciais em cooldown; modelos `opencode-go` depois retornaram 402 | Não |
| `review.structuredOutput` padrão `text` | Bug de listagem do OpenCode 1.18.32 com `json_schema`; extração JSON estrita | Sim |

### Revisão final e correções

A revisão final da fase reprovou com 3 críticos (hooks saíam com erro quando a preparação do contexto falhava; o registro do job guardava o texto do pedido; o mascaramento por padrões não cobria prompts e respostas) e 6 importantes. Três rodadas de correção resolveram tudo, junto com os achados ao vivo: leitura das mensagens do turno uma a uma quando a listagem do OpenCode falha, extração estrita do JSON do texto, modo `text` como padrão, causa da falha no aviso do gate e prazo total do Stop hook.

## Documentação

- `docs/commands.md`, `docs/permissions.md`, `docs/troubleshooting.md`, `README.md` atualizados; exemplos reais redigidos de 28/09/2026.
- `node scripts/scan-secrets.mjs docs/ README.md`: PASSOU — sem achados.

## Gravação dupla

- `.ai-data/<categoria>-<DDMMYY>.md`: NÃO VALIDADO — fora do escopo desta documentação.
- Colmeia `myprojects`: NÃO VALIDADO — sem acesso nesta tarefa.
