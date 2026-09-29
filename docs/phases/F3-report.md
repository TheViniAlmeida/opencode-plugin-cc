# Relatório da fase F3 — Sessões, subagentes, commands, attach

- Data do portão: 29/09/2026
- Branch / PR: `feat/opc-f3` / #5 (parte 1, mergeado) e PR da parte 2
- OpenCode: 1.18.32
- Modelos ao vivo: `omniroute-personal/cmd/deepseek/deepseek-v4-flash`, `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`, `omniroute-personal/cmd/moonshotai/Kimi-K2.6`

Legenda: `PASSOU` foi executado e conferido; `N/A` não se aplica; `NÃO VALIDADO` não teve evidência de execução. As rotas `omniroute-personal/opencode-go/...` previstas inicialmente retornaram 402, `This model requires an opencode API key`; isso é problema de credencial do provider, não do opc. Modelos de fronteira não foram usados.

## 1. `npm test`

| Item | Status | Evidência |
| --- | --- | --- |
| Suíte completa (unit + integração) | PASSOU | `# tests 1197`, `# pass 1196`, `# skipped 1`; o teste de id neutro fica verde após sanitizar a saída ao vivo. |

## 2. Aceite de integração (spec §13.3 F3)

| Item | Status | Evidência |
| --- | --- | --- |
| Corpos de `summarize`, `revert` e `command` | PASSOU | Suítes de ações, revert e command; a rodada de gate corrigiu os itens apontados. |
| `revert` sem confirmação recusa com diff | PASSOU | Saída ao vivo registra exit 2, prévia de `notes.txt` e linha de confirmação. |
| Grupo com membros: status, result e cancel agregados | PASSOU | Saída ao vivo registra grupo em background, `status --wait` e `result`; cobertura de grupo integra cancelamento. |
| `attach --pane` sem segredo em argv | PASSOU | Cobertura de integração e unitária do pane; validação manual permanece separada abaixo. |
| Modo externo (`OPC_SERVER_URL`) | PASSOU | Cobertura de integração de attach; `--pane` é recusado nesse modo. |

## 3. Aceite ao vivo

| Item | Modelo | Status | Evidência |
| --- | --- | --- | --- |
| `session new`, fork e histórico | deepseek-v4-flash | PASSOU | `f3-sessions`, execução 3; fork criado antes do turno BETA. |
| Revert/unrevert no histórico e arquivo | deepseek-v4-flash | PASSOU | `f3-sessions`, execução 3; prévia, confirmação, revert e restauração registrados. |
| Diff, todo e children | deepseek-v4-flash | PASSOU | `f3-sessions`, execução 3; todo retornou 2 itens e children retornou lista vazia. |
| Summarize | Qwen3.7-Flash | PASSOU | `f3-sessions`, execução 3; `summarized: true`. |
| Três subagentes em paralelo, resultado por membro | os três modelos | PASSOU | `f3-subagents`, execução 1; 3/3 concluídos com rotas distintas. |
| Command read-only `/check-updates` | Kimi-K2.6 | PASSOU | `f3-command`, execução 1; job completed e sem argumentos. |
| `attach` manual | — | NÃO VALIDADO | Não há execução manual do operador no output. |
| `attach --pane` manual | — | NÃO VALIDADO | Não há execução manual do operador no output. |
| `contract.mjs` e formas F3 | — | PASSOU | Execução 2; contrato real × fake passou após corrigir `directory` no fake. |

As sete verificações ao vivo passaram ao longo de três execuções: 4/7 na primeira (falhas de teste/fake corrigidas no gate), concorrência e contrato na segunda, e fluxo de sessões na terceira após o fallback de diff. Processos `opencode serve` preexistentes do operador foram preservados.

## 4. Itens A CONFIRMAR (spec §15)

| Item | Resposta | Evidência |
| --- | --- | --- |
| 7 — agente `subagent` como agente de sessão filha | PASSOU: `explore` foi aceito como agente efetivo de sessão filha, sem fallback. | `f3-probe-subagent-mode`: `child-session`, `fellBack: false`, `effectiveAgent: "explore"`. |
| 7b — regras da sessão portadora valem para a neta de `subtask`? | PASSOU no probe: a neta foi criada e tinha regras de permissão. | `f3-probe-subagent-mode`: `grandchildren: 1`, `grandchildHasPermissionRules: true`. |
| 12 — storage concorrente TUI × servidor do opc | Parte automatizada PASSOU: ambos processos exit 0 e sem erro SQLite. A visibilidade da sessão não-OPC foi `false` antes e depois de refresh. Validação com TUI manual: NÃO VALIDADO. | `f3-concurrent-storage`. |
| Diff por mensagem cobre revert | PASSOU | O fallback por mensagem devolveu os dois diffs de `notes.txt`. |
| `session.revert.diff` presente | PASSOU | Prévia de unrevert foi registrada e o contrato foi aprovado. |

## 5. Pontos de encaixe com F0–F2b

| Premissa | Conferida? | Ajuste feito |
| --- | --- | --- |
| Persistência segura de jobs F2a/F2b | PASSOU | Erros e saídas de grupos são redigidos antes de persistir e de retornar JSON. |
| Ciclo de servidor F0 | PASSOU | `attach.secret` é publicado após `server.json`, removido no encerramento e limpo em rollback. |
| Ponte de permissões F2a | PASSOU | Coordenador mantém uma ponte por membro e agrega pedidos no grupo. |
| Resultado e cancelamento F2a | PASSOU | Grupo agrega membros; `CANCEL_FAILED` não transforma conclusão posterior em cancelamento. |

## 6. Desvios e mudanças de comportamento

- `jobs.maxActive` e poda contam o grupo como um job; membros não contam contra o limite.
- `workerLost` não marca membro isolado; a perda do grupo marca os membros ativos.
- `resolveJobRef` sem id ignora membros de grupo.
- `attach.secret` é criado no boot gerenciado e removido ao encerrar; a saída JSON usa `authSource`, não um campo de credencial.
- OpenCode 1.18.32 pode devolver diff agregado vazio; `opc session diff` faz fallback para diffs por mensagem e avisa a origem.

## 7. Documentação e revisão

| Item | Status | Evidência |
| --- | --- | --- |
| Comandos, troubleshooting, arquitetura, README e changelog | PASSOU | Documentação F3 atualizada nesta entrega. |
| Saídas reais sanitizadas | PASSOU | `docs/phases/F3-live-output.md`; caminhos usam `<tmp>` e credenciais são redigidas. |
| Scanner de segredos da documentação | PASSOU | `npm run scan-secrets`: nenhum achado (docs, README, CHANGELOG, plugins). |
| Revisão final | PASSOU | Revisão final `gpt-6-sol` em xhigh: No; correção de gate `gpt-6-astra`; re-revisão: todos os achados endereçados. |
