# F6 — saída ao vivo

Executado em 06/10/2026 (America/Belem) pelo controlador, fora do sandbox, com o OpenCode 2.0.22
(`OPC_OPENCODE_BIN` apontando para o binário V2) e dois modelos explícitos do gateway pessoal:
`omniroute-personal/cmd/deepseek/deepseek-v4-flash` (`OPC_LIVE_MODEL`) e
`omniroute-personal/cmd/Qwen/Qwen3.7-Flash` (`OPC_LIVE_MODEL_2`). Cada teste sobe o próprio servidor gerenciado,
com porta e senha próprias. A senha fica só no ambiente de execução.

## Resumo

| Teste | Resultado | Observação |
|---|---|---|
| `tests/live/contract-v2.mjs` | PASSOU (12/12) | Servidor isolado (HOME/XDG temporários); sem inferência |
| `tests/live/contract.mjs` | PASSOU | "Sem divergências nos campos usados" entre o OpenCode 2.0.22 e o fake |
| `tests/live/f2a-jobs.mjs` | PASSOU (3/3) | Fundo + `status --wait` + resultado; cancelamento de turno longo; `--resume` mantém o `sessionID` |
| `tests/live/f2b-review.mjs` | PASSOU (1/1) | 3 de 3 execuções com JSON válido no schema |
| `tests/live/f3-subagents.mjs` | PASSOU (2/2) | Subagentes paralelos, um por modelo; grupo em segundo plano |
| `tests/live/f4c-opinion.mjs` | PASSOU (1/1) | Rodado com `OPC_LIVE_POOL` dos dois modelos; 2 de 3 execuções válidas |
| `tests/live/f5-mcp.mjs` | PASSOU (1/1) | Descoberta MCP e conclave de dois modelos; 2 de 3 execuções válidas |
| `tests/live/f5-transfer.mjs` | PASSOU (1/1) | Importação com armazenamento isolado; nenhuma requisição ao provider |
| Serves do operador antes/depois | PASSOU | Mesmos PIDs e portas (13371, 13373, 13374, 34975) antes e depois |

## Achados do portão

1. **Catálogo incompleto logo após o boot (corrigido).** A primeira rodada falhou em `f2a-jobs`, `f2b-review`,
   `f3-subagents` e `f4c-opinion` com `UNKNOWN_MODEL ... não encontrado em /api/model`. No V2, o catálogo carrega
   enquanto a instância faz o bootstrap. Na máquina do operador, os providers do gateway só apareceram em
   `/api/provider` e `/api/model` cerca de 11 s após o boot. Os providers embutidos apareceram antes, então
   "lista não vazia" não indicava catálogo pronto. O sinal confiável é o evento `model.updated`, emitido no fim
   do bootstrap. O boot do servidor gerenciado agora assina `/api/event` antes da primeira requisição e espera
   esse evento por até 30 s. Sem o evento, cai na verificação de lista não vazia (`lib/server.mjs`,
   `watchCatalogBootstrap`). Depois da correção, todos os testes acima passaram.
2. **Conclave com três modelos.** `f4c-opinion` espera três modelos distintos. Com dois, o terceiro cai no
   primeiro, o conclave descarta o membro duplicado e a contagem fica 2 ≠ 3. É limitação da configuração do
   portão, não defeito; o teste passou com o pool dos dois modelos.
3. **Execuções instáveis dentro do critério.** Em uma execução de `f4c-opinion`, um membro terminou o turno sem
   o JSON pedido (`MissingStructuredOutput`) e o conclave saiu com código 7. Uma execução de `f5-mcp` também saiu
   com código 7, mas o teste não registrou o motivo (A CONFIRMAR). Os critérios de "2 de 3 execuções" absorveram
   as duas. Sem `json_schema` no V2, a validação local é o único caminho; o risco já constava na avaliação.
4. **Servidor órfão no teste de transfer (corrigido).** `f5-transfer.mjs` não registrava o próprio ambiente para
   limpeza e deixava um `opencode serve` vivo (ppid 1) depois de remover o diretório temporário. O teste agora usa
   `trackEnv`; a reexecução passou sem órfãos.

## Evidência sanitizada

### MCP: descoberta e conclave de dois modelos

```json
[
  { "run": 1, "ok": false, "error": "exit 7, sem detalhe registrado" },
  { "run": 2, "ok": true, "members": 2 },
  { "run": 3, "ok": true, "members": 2 }
]
```

### Transfer: importação e consulta de sessão com armazenamento isolado

```json
{
  "messages": 5,
  "sessionLoaded": true,
  "importShapeValid": true,
  "storage": "isolated",
  "providerRequests": 0
}
```

## Não validado aqui

Os procedimentos manuais no Claude Code (instalação, `/mcp`, permissões, associação de sessão) e na TUI
(`/opc:attach`, `--pane`, retomada após transfer) seguem com o operador. macOS e Windows não foram testados.
