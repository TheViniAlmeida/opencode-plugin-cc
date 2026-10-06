# F5 — Servidor MCP e transfer · Relatório de fase

- **Data:** 03/10/2026 (America/Belem).
- **Branch:** `feat/opc-f5`; continuação após `441c8ff`, com commit, push e PR em rascunho autorizados pelo operador.
- **Ambiente:** Linux; Node 22.22.1 e 24.21.0; OpenCode 1.18.34; Claude Code 2.1.287 instalado.
- **Estado:** PR #12 mergeado na `main` em 06/10/2026 (`64000ec`). Implementação das Tasks 1–10 concluída; portão da Task 11 parcial, com aceite no Claude Code, inferência real pelo MCP e retomada interativa NÃO VALIDADO.

## 1. Suíte de testes

As suítes unitárias e de integração usam OpenCode falso, sem requests a providers.
O comando de cada versão é `<node> scripts/run-tests.mjs`, equivalente ao script `npm test`.

| Ambiente | Resultado | Evidência |
|---|---|---|
| Node 22.22.1, código final | PASSOU | 1939 testes, 1938 pass, 0 fail, 1 skipped; 207,1 s |
| Node 24.21.0, código final | PASSOU | 1939 testes, 1938 pass, 0 fail, 1 skipped; 142,7 s |
| Node 20 | NÃO VALIDADO | Versão não disponível localmente; continua na matriz do CI |
| CI remoto | PASSOU | Checks do PR #12 passaram em Node 20 e 22 no commit `a9a0422`; Node 20 não foi rodado localmente |

**Limitação do runner (histórica, corrigida).** Nas rodadas desta fase, o `--test-force-exit` do runner às vezes
encerrava o processo do arquivo antes de entregar todos os resultados (por exemplo,
`tests/unit/policy-profiles.test.mjs` reportava 43, 46 ou 63 casos com exit 0; reproduzido no Node 24.21.0).
Foi corrigida depois do merge, em `bd53bf4` (branch `fix/test-runner-lost-results`): o runner passa
`--import=scripts/test-exit-after-grace.mjs` no lugar da flag, e o processo só é encerrado à força 3 s depois do fim
dos testes se um handle vazado o prender. Evidência: 63/63 em 8/8 rodadas e suíte completa com 1940 testes, 1939 pass,
0 fail, 1 skipped, em duas rodadas. Os números das tabelas acima são anteriores à correção.

O skip preexistente é o cenário cross-UID, que exige fixture com outro proprietário.
O runner não inclui `tests/live/` nesta suíte. Sem `OPC_LIVE=1`, os dois testes novos da F5 são pulados explicitamente (2 skipped, 0 fail).

## 2. Aceite de integração

| Item da spec §13.3 F5 | Evidência | Resultado |
|---|---|---|
| Handshake, negociação e catálogo das 25 ferramentas | `tests/integration/mcp-server.test.mjs`, `tests/unit/mcp-protocol.test.mjs` | PASSOU nos testes focados |
| Mesmas funções e resultados da CLI | `mcp-tools.test.mjs`, `mcp-compat.test.mjs`, pares CLI × MCP em `mcp-server`, `mcp-jobs`, `mcp-permissions` | PASSOU nas suítes finais |
| Aprovação, confirmações, `always` recusado e ausência de escrita de configuração | `tests/integration/mcp-permissions.test.mjs` | PASSOU nas suítes finais |
| Texto livre preservado após `--`; stdin do protocolo isolado | `args-terminator`, `mcp-tools`, `mcp-jobs` | PASSOU nas suítes finais |
| Espera limitada e `ping` concorrente | `mcp-protocol`, `mcp-jobs` | PASSOU nos testes focados |
| EOF com backpressure sem frames truncados | `mcp-server.test.mjs`: 101 respostas, mais de 1 MiB, consumidor pausado e `write(false)` observado | PASSOU; regressão falhava antes da correção |
| Falha no callback de drenagem e erro assíncrono de stdout | Dois casos de `mcp-server.test.mjs`; processo retorna 1, sem mensagem bruta do erro | PASSOU |
| Conversão e validade do export | `tests/unit/transfer.test.mjs`, oráculo independente em `tests/fixtures/fake-import.mjs` | PASSOU |
| Texto/anexos misturados a resultados de ferramentas | `transfer.test.mjs`: conteúdo, ordem dos turnos, contagens e `parentID` | PASSOU; regressão falhava antes da correção |
| Origem, política, flags, erros, IDs e modos 600/700 do transfer | `tests/integration/transfer.test.mjs`: 26 casos; `render-transfer`, `commands-md` | PASSOU, 43 testes focados |
| Export temporário removido no sucesso e nas falhas de importação | `transfer.test.mjs`: falha exit 0, crash, sucesso com exit não zero e ID divergente | PASSOU |
| Aceite MCP executa três rodadas e preserva grupos concluídos | `tests/integration/f5-live-harness.test.mjs`, com fake e relatório temporário | PASSOU, 3/3 rodadas; nenhum provider externo |

## 3. Aceite com OpenCode real

Comando executado:

```bash
OPC_LIVE=1 OPC_LIVE_MODEL=isolated/transfer-fixture node --test --test-reporter=tap tests/live/f5-transfer.mjs
```

O ID de modelo acima é apenas metadado sintético da sessão; o teste não solicita inferência.
O teste usa HOME e diretórios XDG próprios, workspace descartável e transcript sintético;
não importa histórico real do operador nem grava no armazenamento OpenCode habitual.

| Item | Evidência | Resultado |
|---|---|---|
| `transfer` importa e sessão aparece em `opencode session list` | [F5-live-output.md](F5-live-output.md), OpenCode 1.18.34 | PASSOU |
| `opencode export` devolve quatro mensagens e preserva texto/chamada/resultado | Mesmo teste; 1 pass, 0 fail; 6,1 s | PASSOU |
| Export real compatível com `validateExportShape` | `exportShapeValid: true` na evidência | PASSOU |
| MCP com descoberta real e conclave de dois modelos, ≥ 2/3 rodadas | `tests/live/f5-mcp.mjs` pronto; `OPC_LIVE_MODEL` e `_2` não informados | NÃO VALIDADO |
| Contrato completo da API ao vivo (`tests/live/contract.mjs`) | Não executado nesta continuação | NÃO VALIDADO |

O teste de transferência remove seus diretórios isolados ao terminar. O aceite de retomada
na TUI precisa de uma execução própria num workspace mantido pelo operador.

## 4. Procedimentos manuais

Todos seguem **NÃO VALIDADO** nesta sessão. Os passos detalhados estão na Task 11 do
[plano da F5](../superpowers/plans/2026-09-26-opc-F5-mcp-transfer.md).

- Instalar/atualizar o plugin e confirmar em `/mcp` as 25 ferramentas e seus nomes efetivos.
- Solicitar `opc_models` e conclave pela superfície MCP numa sessão real do Claude Code.
- Conferir se `/opc:status` da sessão lista o job e valida a associação pelo processo pai.
- Conferir uma recusa humana de permissão sensível via `opc_permissions_reply`.
- Executar `/opc:transfer` numa conversa descartável e verificar o histórico e a palavra-código na TUI com `opencode -s <id>`.

## 5. Formato e desvios

O round trip em OpenCode 1.18.34 confirmou o envelope `{ info, messages: [{ info, parts }] }`,
o ID gerado pelo conversor, título, diretório e textos. O produto exige exit 0 e
`Imported session: <id>` com ID idêntico ao exportado. A falha silenciosa exit 0 do import
é coberta pelo fake; não foi provocada no storage real.

- `opc_catalog` é exposto além da lista inicial da spec.
- Configuração de escrita, revert/unrevert, setup, review, transfer, command, attach, monitor, gc e rescue permanecem fora do catálogo MCP.
- O transfer verifica a política do modelo, sem consultar catálogo ou iniciar servidor.
- O caminho do transcript é omitido do resumo público; erros omitem caminhos pessoais e saída bruta dos subprocessos.
- Texto, imagem e documento numa entrada com `tool_result` formam o próximo turno do usuário; resultados permanecem no turno do assistente.
- O exemplo de saída em `docs/commands.md` é ilustrativo. Uma saída real de conversa do Claude aguarda o procedimento manual.

## 6. Revisão e documentação

Revisões independentes das Tasks 8 e 9 e dos ajustes MCP concluídas sem achados pendentes.
Os achados encontrados nesta continuação foram corrigidos e têm regressões:
perda de prompt misto, limpeza do GC, truncamento de frames no EOF e cancelamento indevido no aceite.

README, arquitetura, comandos, troubleshooting, skill de resultados e CHANGELOG atualizados.
Interfaces novas da F5 registradas no plano mestre, com assinatura `readTranscript(file, options)`
e omissão de `source` no resultado público do comando.

- `npm run scan-secrets`: PASSOU, nenhum achado na execução após as alterações de código e documentação.
- `git diff --check`: PASSOU, sem erros de whitespace.
- Node 20, macOS, Windows, Claude Code real e inferência MCP: NÃO VALIDADO nesta continuação.

## 7. Git e memória

O operador autorizou explicitamente commit, push de `feat/opc-f5` e abertura de PR em
rascunho para `main` de `TheViniAlmeida/opencode-plugin-cc`. A fase continua em validação
até os itens pendentes do portão; o merge depende de autorização própria.

Registro local em `.ai-data/`; **PENDENTE-COLMEIA** porque as ferramentas `mnemosyne_*`
do mundo `myprojects` não estão disponíveis nesta sessão. Nenhum fato gravado na colmeia.
