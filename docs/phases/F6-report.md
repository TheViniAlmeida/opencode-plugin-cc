# F6 — migração para OpenCode V2 · relatório de fase

- **Data:** 06/10/2026 (America/Belem).
- **Branch:** `feat/opc-f6-opencode-v2`.
- **Contrato:** OpenCode ≥ 2.0.22; somente `/api/*`.
- **Estado do portão:** **NÃO VALIDADO**. O controlador informou suíte completa com 0 falhas fora do sandbox; o aceite ao vivo e manual continua pendente.

| Item | Evidência | Resultado |
|---|---|---|
| Referências V1 removidas dos docs públicos principais | `tests/unit/docs-f6.test.mjs`: 3/3; busca pelos termos proibidos sem ocorrência | PASSOU |
| Ferramentas MCP documentadas conforme catálogo atual | Teste de documentação compara a tabela com `TOOL_NAMES` (24 ferramentas) | PASSOU |
| Suíte completa sem falhas | O controlador informou `GATE: PASS`, 0 falhas na suíte, fora do sandbox, antes desta rodada de correções. Neste sandbox, testes com socket podem falhar em `listen EPERM`. A suíte com as correções desta rodada requer nova execução fora do sandbox. | PASSOU na revisão anterior; nova rodada NÃO VALIDADA |
| `npm run scan-secrets` | `scan-secrets: nenhum achado` | PASSOU |
| `git diff --check` | Saída vazia, exit 0 | PASSOU |
| Contrato V2 ao vivo e paridade com fake | Não executado neste sandbox | NÃO VALIDADO |
| MCP com dois modelos, transfer, task, review, subagent e conclave ao vivo | Não executados; dependem do binário V2 e de modelos explícitos | NÃO VALIDADO |
| Servidores do operador antes/depois | Sem acesso neste sandbox; comparação pendente | NÃO VALIDADO |
| Instalação, `/mcp`, permissões e associação de sessão no Claude Code | Procedimentos manuais pendentes do operador | NÃO VALIDADO |
| TUI `/opc:attach`, `--pane` e retomada de transfer | Procedimentos manuais pendentes do operador | NÃO VALIDADO |
| macOS e Windows | Ambientes não disponíveis aqui | NÃO VALIDADO |

A [saída ao vivo](F6-live-output.md) permanece vazia de resultados para não atribuir um teste não executado. Os detalhes de implementação e das falhas do sandbox estão em `.superpowers/sdd/2026-10-06-opc-F6-opencode-v2/task-12-report.md`.
