# F6 — saída ao vivo

**NÃO VALIDADO em 06/10/2026.** Os testes com `OPC_LIVE=1` não foram executados neste sandbox. Ele impede abrir sockets (`listen EPERM`), e a tarefa proíbe executar o binário real aqui. Este arquivo reserva a saída sanitizada para o controlador, após execução fora do sandbox com binário V2 e modelos explícitos.

Comandos previstos no portão: `tests/live/contract-v2.mjs`, `tests/live/contract.mjs`, `tests/live/f5-mcp.mjs`, `tests/live/f5-transfer.mjs` e os testes de task, review, subagent e conclave. Não há resultados para registrar ainda.
