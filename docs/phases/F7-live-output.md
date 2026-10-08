# F7 — saída ao vivo

Executado em 08/10/2026 (America/Belem) pelo controlador, com o OpenCode 2.0.22 (`OPC_OPENCODE_BIN`).
`f7-contract.mjs` roda num servidor isolado (HOME/XDG temporários, provider fechado em `127.0.0.1:9`), sem
inferência. `f7-inference.mjs` usa um servidor gerenciado pelo opc com snapshots ligados e os modelos
`omniroute-personal/cmd/deepseek/deepseek-v4-flash` e `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`.

## f7-contract (sem inferência)

| Fato | Resultado |
|---|---|
| `P1-precedence` | `{"documents":["omniroute-personal/probe/model-global","omniroute-personal/probe/model-project","omniroute-personal/probe/model-env"],"bareSession":"no-model (status 200)","defaultModel":"opencode/longcat-2.5-preview-free","opcMerge":"omniroute-personal/probe/model-env","verdict":"unknown"}` |
| `P2-children-cursor` | `{"firstPage":2,"nextCursor":true,"withParentID":{"status":200,"length":1,"onlyChildren":true},"cursorOnly":{"status":200,"length":1,"onlyChildren":true},"verdict":"cursor-keeps-filter"}` |
| `P3-fork` | `{"parent":{"permissions":true,"model":"omniroute-personal/probe/model-env"},"fork":{"permissions":null,"model":null},"verdict":"missing"}` |
| `P4-model-updated` | `"418 ms"` |

## f7-inference

| Fato | Resultado |
|---|---|
| `I2-pending-revert` | `{"afterStage":["original","ALPHA"],"revertBeforePrompt":"pending","afterPrompt":["original","ALPHA"],"promptExit":0,"revertAfterPrompt":"none","betaMessageKept":false,"verdict":"consolidates"}` |
| `I1-compaction` | `{"postMs":7,"firstPoll":{"ms":109,"active":false,"compacting":null},"settledMs":109,"polls":1,"followUpExit":0,"afterSettle":{"payloadKeys":[],"payloadBytes":4,"messageTypes":["agent-switched","user","assistant","assistant","assistant","assistant","idle","user","assistant","idle","model-switched","compaction","idle"]},"afterTurn":{"payloadKeys":[],"payloadBytes":4,"messageTypes":["agent-switched","user","assistant","assistant","assistant","assistant","idle","user","assistant","idle","model-switched","compaction","idle","user","assistant","idle"]},"verdict":"filled-on-post"}` (critério antigo; leitura correta: `marker-only`, ver abaixo) |

## Leitura dos fatos

- **`P1-precedence`:** o `GET /api/config` lista as fontes na ordem arquivo global, arquivo do projeto e
  `OPENCODE_CONFIG_CONTENT`, que é crescente segundo a documentação do OpenCode (não confirmado pelo servidor). O merge do opc (a última vence) escolheu
  `OPENCODE_CONFIG_CONTENT`, como na precedência documentada do OpenCode. O servidor não revela o vencedor sem
  inferência: a sessão criada sem modelo volta sem `model`, e `GET /api/model/default` ignora o `model` da
  config e devolve o modelo gratuito embutido. Veredito: `unknown`, com a ordem do opc mantida (A CONFIRMAR).
  Achado novo: no V2, `model` vem normalizado como objeto `{providerID, model}`, não como texto
  `provider/model`.
- **`P2-children-cursor`:** o cursor mantém o filtro `parentID`. A segunda página, com ou sem `parentID`, trouxe
  só o filho que faltava, e mandar o `parentID` junto não deu erro.
- **`P3-fork`:** o pai tem regras e modelo, mas o fork volta sem `permissions` e sem `model`. Sem correção, a
  sessão bifurcada perde as regras do opc.
- **`P4-model-updated`:** o evento chegou em menos de 0,5 s depois da assinatura, num servidor só com provider
  customizado.
- **`I1-compaction`:** o `POST /compact` respondeu em 7 ms, e a sessão já estava ociosa na primeira leitura,
  sem `time.compacting`. A mensagem `compaction` tem `payload: null` logo depois e também depois de um turno
  seguinte. O script desta rodada classificou o fato como `filled-on-post`, porque contou os 4 bytes de `null`
  como conteúdo. O critério foi corrigido no script, e a leitura correta é `marker-only`: o V2 registra um
  marcador de compactação sem resumo visível pela API. A resposta do POST traz `payload: {}`; a mensagem listada
  depois traz `payload: null`. Com 7 ms de resposta não houve inferência no POST, então síncrono ou assíncrono
  não se decide por aqui: o opc deve tratar a compactação como marcador e esperar a sessão ociosa.
- **`I2-pending-revert`:** o revert estava pendente antes do prompt. O prompt novo o consolidou: o revert
  deixou de existir, a mensagem revertida sumiu e os arquivos continuaram no estado revertido.
