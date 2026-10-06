# F6 — saída ao vivo

**NÃO VALIDADO em 06/10/2026.** Os testes com `OPC_LIVE=1` não foram executados nesta rodada: a tarefa proíbe testes ao vivo no sandbox. Este arquivo reserva a saída sanitizada para o controlador, após execução fora do sandbox com binário V2 e modelos explícitos.

O controlador informou `GATE: FAIL` na entrada da rodada 2, com cinco falhas de transfer na suíte completa. A correção ainda requer reexecução fora do sandbox; nenhum resultado da suíte substitui o portão ao vivo.

| Verificação ao vivo | Resultado desta rodada |
|---|---|
| Contratos V2 (`contract-v2.mjs`, `contract.mjs`) | NÃO VALIDADO |
| Sondas V2 (`f2a-probes.mjs`, `probe-permission-precedence.mjs`) | NÃO VALIDADO |
| MCP com dois modelos e transferência (`f5-mcp.mjs`, `f5-transfer.mjs`) | NÃO VALIDADO |
| Task, review, subagent e conclave disponíveis em `tests/live/` | NÃO VALIDADO |
| Servidores do operador antes/depois; Claude Code e TUI | NÃO VALIDADO |

Para o controlador: definir `OPC_LIVE=1`, `OPC_OPENCODE_BIN`, `OPC_LIVE_MODEL` e `OPC_LIVE_MODEL_2` no ambiente e executar os arquivos acima fora do sandbox. Anexar aqui apenas saída sanitizada, status e data no fuso America/Belem. A senha do servidor permanece somente no ambiente de execução.
