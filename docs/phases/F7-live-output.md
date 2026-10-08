# F7 — saída ao vivo

Executado em 08/10/2026 (America/Belem) pelo controlador, com o OpenCode 2.0.22 (`OPC_OPENCODE_BIN`).
`f7-contract.mjs` roda num servidor isolado (HOME/XDG temporários, provider fechado em `127.0.0.1:9`), sem
inferência. `f7-inference.mjs` usa um servidor gerenciado pelo opc com snapshots ligados e os modelos
`omniroute-personal/cmd/deepseek/deepseek-v4-flash` e `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`.

## f7-contract (sem inferência)

| Fato | Resultado |
|---|---|
| `P1-precedence` | `{"documents":[{"providerID":"omniroute-personal","model":"probe/model-global"},{"providerID":"omniroute-personal","model":"probe/model-project"},{"providerID":"omniroute-personal","model":"probe/model-env"}],"serverPicked":"status 200","opcMerge":{"providerID":"omniroute-personal","model":"probe/model-env"},"verdict":"unknown"}` |
| `P2-children-cursor` | `{"firstPage":2,"nextCursor":true,"withParentID":{"status":200,"onlyChildren":true},"cursorOnly":{"status":200,"onlyChildren":true},"verdict":"cursor-keeps-filter"}` |
| `P3-fork` | `{"permissions":null,"model":null,"verdict":"missing"}` |
| `P4-model-updated` | `"860 ms"` |

## f7-inference

| Fato | Resultado |
|---|---|
| `I2-pending-revert` | `{"afterStage":["original","ALPHA"],"afterPrompt":["original","ALPHA"],"promptExit":0,"revertAfterPrompt":"none","betaMessageKept":false,"verdict":"consolidates"}` |
| `I1-compaction` | `{"postMs":8,"firstPoll":{"ms":110,"active":false,"compacting":null},"settledMs":110,"polls":1,"messageTypes":["agent-switched","user","assistant","assistant","assistant","idle","user","assistant","idle","model-switched","compaction","idle"],"verdict":"sync"}` |

## Leitura dos fatos

- **`P1-precedence`:** o `GET /api/config` lista as fontes em ordem crescente de precedência: arquivo global,
  arquivo do projeto e `OPENCODE_CONFIG_CONTENT`. O merge do opc, em que a última fonte vence, escolheu a do
  `OPENCODE_CONFIG_CONTENT`. A sessão criada sem modelo voltou sem `model`, então o servidor não confirmou o
  vencedor (`verdict: unknown`). Achado novo: no V2, `model` vem normalizado como objeto
  `{providerID, model}`, não como texto `provider/model`.
- **`P2-children-cursor`:** o cursor mantém o filtro `parentID`, e mandar o `parentID` junto não dá erro.
- **`P3-fork`:** o fork volta sem `permissions` e sem `model`. Sem correção, a sessão bifurcada perde as regras
  do opc.
- **`P4-model-updated`:** o evento chegou em menos de 1 s num servidor só com provider customizado.
- **`I1-compaction`:** o `POST /compact` respondeu em 8 ms, e a sessão já estava ociosa na primeira leitura, sem
  `time.compacting`. A mensagem `compaction` vem com `payload` vazio. Fica A CONFIRMAR se o resumo é gerado
  nesse momento ou só no próximo turno.
- **`I2-pending-revert`:** um prompt novo consolida o revert pendente. As mensagens revertidas somem, o revert
  deixa de existir e os arquivos continuam no estado revertido.
