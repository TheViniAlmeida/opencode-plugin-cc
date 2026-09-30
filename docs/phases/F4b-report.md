# Relatório da fase F4b — Orquestração

- **Data:** 30/09/2026
- **Branch / PR:** `feat/opc-f4b` / **A CONFIRMAR**
- **OpenCode:** 1.18.32 · **Node:** v22.22.1
- **Modelos ao vivo:** planner `omniroute-personal/cmd/…/Kimi-K2.6`; subtarefas
  `omniroute-personal/cmd/…/deepseek-v4-flash`, `omniroute-personal/cmd/…/Qwen3.7-Flash` e
  `omniroute-personal/cmd/…/Kimi-K2.6`; síntese por modelo concluída.

As Tasks 1–10 foram executadas pelo fluxo SDD, com implementador `gpt-6-luna` e revisor
`gpt-6-sol`. Nas Tasks 1–5, o gateway recusou `codex/gpt-6-*` para esta chave em 29/09 e parte
da execução usou `gpt-5.6-luna`/`gpt-5.6-sol`. O despacho passou a tentar GPT-6 primeiro e a
usar GPT-5.6 do mesmo tier somente em 403.

## 1. `npm test`

Resultado: **PASSOU** — suíte completa executada pelo controlador fora do sandbox, após as duas
correções do portão.

```text
# tests 1558
# pass 1557
# fail 0
# skipped 1
```

## 2. Aceite de integração (spec §13.3, F4b)

| Item | Teste | Resultado |
|---|---|---|
| Plano válido | `orchestrate-acceptance` › valid plan | PASSOU (SDD) |
| `decompose-cycle` → rejeitado | › decompose-cycle | PASSOU (SDD) |
| Escrita sem `--write` → rejeitada | › write subtask without --write | PASSOU (SDD) |
| Escrita em série | › write subtasks run in series | PASSOU (SDD) |
| Resultados de dependência injetados | › dependency results are injected | PASSOU (SDD) |
| `dependency_failed` | › failed subtask cancels dependents | PASSOU (SDD) |
| Espalhamento de modelos | › models are spread | PASSOU (SDD) |
| Síntese Claude | › Claude synthesis | PASSOU (SDD) |
| Síntese por modelo | › model synthesis | PASSOU (SDD) |
| `StructuredOutputError` no planner | › planner fails the group | PASSOU (SDD) |

## 3. Aceite ao vivo

As duas primeiras execuções produziram `outcome=failed`, 0/2 e nenhuma subtarefa porque o
planner recebeu `StructuredOutputError` com `format: json_schema`. O diagnóstico levou ao modo
textual do planner. Após essa correção, três de três execuções passaram, com 2/2 verificações em
cada execução; os processos `opencode serve` preexistentes do operador permaneceram intactos.
As saídas sanitizadas estão em [F4b-live-output.md](F4b-live-output.md), preservado sem edição.

| Item | Execuções (≥ 2 de 3) | Resultado | Evidência |
|---|---|---|---|
| Plano válido com ≥ 2 subtarefas | 1: PASSOU · 2: PASSOU · 3: PASSOU | PASSOU | planner textual, 3 subtarefas por execução |
| Subtarefas com modelos diferentes | 1: 3 · 2: 3 · 3: 3 | PASSOU | deepseek-v4-flash, Qwen3.7-Flash e Kimi-K2.6 |
| Síntese Claude (pacote validado) | 1: PASSOU · 2: PASSOU · 3: PASSOU | PASSOU | pacote `claude/pending` validado pelo teste ao vivo |
| Síntese por modelo | 1: PASSOU · 2: PASSOU · 3: PASSOU | PASSOU | síntese por modelo concluída |
| Arquivos inalterados (read-only) | 1: PASSOU · 2: PASSOU · 3: PASSOU | PASSOU | checksum SHA-256 igual antes e depois |

## 4. `tests/live/contract.mjs`

Resultado: **PASSOU** — `OPC_LIVE=1 node tests/live/contract.mjs`: "Contrato OpenCode 1.18.32 ×
fake: sem divergências nos campos usados". O fake não precisou de atualização.

## 5. Documentação

- `docs/swarm.md` (Orquestração), `docs/commands.md` (`/opc:orchestrate`) e README (mapa de
  comandos): PASSOU.
- Exemplos das docs executados contra o servidor falso (`config set` de `orchestrate.*`,
  heredoc com flags no corpo, síntese pelo Claude, síntese por modelo em background com
  `status --wait` e `result`, escrita exigindo `--write`): PASSOU (5/5). As saídas ao vivo
  sanitizadas estão em [F4b-live-output.md](F4b-live-output.md).
- `node scripts/scan-secrets.mjs docs/`: PASSOU (nenhum achado).

## 6. Itens A CONFIRMAR

- Invocação de `/opc:orchestrate` em uma sessão real do Claude Code: **A CONFIRMAR (operador)**.

## 7. Revisão final e correções

A revisão final por `gpt-6-sol` (esforço high) reprovou o portão. A correção do gate foi feita
por `gpt-6-astra` (esforço high); a re-revisão confirmou os achados anteriores, mas abriu um
novo item Important para cancelamento antes da publicação do id da sessão do membro. A segunda
correção (`gpt-6-astra`) confere o cancelamento depois de criar a sessão e antes do prompt, aborta
a sessão recém-criada e faz `cancelJob` adiar (sem retirar a intenção) o cancelamento de membro
de orquestração cuja sessão ainda não foi publicada; coberta por testes unitários e por um teste
de integração com a criação da sessão atrasada em 6 s. Re-revisão: achado resolvido, veredito **With fixes** por um ponto de apresentação (o cancelamento adiado aparecia como concluído); o controlador passou a mostrar o cancelamento adiado como **pendente** em `opc cancel` (texto e `--json`: `pending: true`, `deferredMembers`), com testes.

## 8. Desvios e decisões

| Decisão | Motivo |
|---|---|
| Subtarefa `review` usa `routing.tasks.review`, não `reviewModel` | A rota de subtarefa é por `tier` ou `kind` |
| Escritas mutuamente exclusivas; leituras podem rodar junto com uma escrita | Preserva paralelismo sem concorrência entre escritas |
| `-m/--model` seleciona o planner | É o único modelo de valor único do comando |
| Resultado de subtarefa é limitado a 64 KB no pacote | A íntegra permanece na sessão; evita crescimento descontrolado do job |
| Membros são criados sob demanda | Respeita `jobs.maxActive` |
| Falha da síntese por modelo retorna síntese ao Claude | Preserva resultados brutos e conclui com avisos |
| Coordenador usa `runWithFallback` e `attemptRequest` diretamente | `runJobTurn` exige job próprio; membro é opcional |
| Planner passou a usar texto por padrão | O gateway devolveu `StructuredOutputError` para `format: json_schema` no OpenCode 1.18.32 |
| Cancelamento durante a criação da sessão é deferido | Correção da janela de cancelamento durante a criação da sessão do membro |

## 9. Resumo para o operador

- PASSOU: implementação SDD das Tasks 1–10; validação ao vivo repetida 3/3, com três modelos
  distintos por execução e síntese por modelo concluída.
- PASSOU: suíte 1558 (1557 pass, 0 fail, 1 skip), contrato real × fake, exemplos das docs,
  scanner.
- A CONFIRMAR (operador): `/opc:orchestrate` invocado de uma sessão real do Claude Code.
