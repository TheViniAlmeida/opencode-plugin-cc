# F7 — endurecimento do OpenCode V2 · relatório de fase

- **Data:** 08/10/2026 (America/Belem).
- **Branch:** `feat/opc-f7-v2-hardening`.
- **Contrato:** OpenCode ≥ 2.0.22; somente `/api/*`. A F7 fecha os A CONFIRMAR da [F6](F6-report.md) que a
  sonda ao vivo ou o código permitiam resolver.
- **Fatos ao vivo:** [F7-live-output.md](F7-live-output.md) (sondas `f7-contract.mjs` e `f7-inference.mjs`).

## Portão

| Item | Evidência | Resultado |
|---|---|---|
| Suíte completa | `node scripts/run-tests.mjs`: 2088 testes, 2087 aprovados, 0 falhas, 0 cancelados (1 ignorado) | PASSOU |
| `npm run scan-secrets` | `scan-secrets: nenhum achado` | PASSOU |
| `git diff --check` | Saída vazia, exit 0 | PASSOU |
| Servidores falsos órfãos | `ps -eo ppid=,args= \| awk '$1==1 && $3 ~ /tests\/fixtures\/bin\/opencode$/' \| wc -l`: 0 | PASSOU |
| Guarda de docs da F7 | `tests/unit/docs-f7.test.mjs` | PASSOU |
| `tests/live/f3-sessions.mjs` (new, show, fork, revert/unrevert, diff, summarize, children) | 1/1 em cerca de 87 s, OpenCode 2.0.22 | PASSOU |
| `tests/live/f5-transfer.mjs` (importação isolada, 5 mensagens, `sessionLoaded`, `providerRequests` 0) | 1/1 em cerca de 1,6 s | PASSOU |
| Fork ao vivo: regras e modelo | A origem tinha 54 regras e o modelo `cmd/deepseek/deepseek-v4-flash` (provider `omniroute-personal`, variant `default`); o fork devolvido por `opc session fork` tem as mesmas 54 regras (lista idêntica) e o mesmo modelo com variant | PASSOU |
| Summarize ao vivo | Exit 0, `summarized: true`, `compactionMessageID` presente | PASSOU |
| Linha de retomada do transfer (`resumeCommand` renderizado) | `f5-transfer.mjs` não a exercita; cobertura só por testes unitários e de integração | NÃO VALIDADO |
| Instalação, `/mcp`, permissões e associação de sessão no Claude Code | Procedimento manual do operador | NÃO VALIDADO |
| Espera do catálogo em attach (`OPC_SERVER_URL`) e com providers declarados (chave `providers`) | Nenhum teste ao vivo usa `OPC_SERVER_URL`, e a correção da chave `providers` veio depois da rodada ao vivo; cobertura só por fakes e pelos fixtures V2 capturados | NÃO VALIDADO |
| Substituição de um servidor registrado anterior à 2.0.22 (Tarefa 4) | Não havia servidor antigo real; coberto só por processo falso e `/api/info` simulado | NÃO VALIDADO |
| TUI: `/opc:attach`, `--pane` e retomada após transfer | Procedimento manual do operador | NÃO VALIDADO |

Os testes ao vivo rodaram por conta do controlador, em servidores isolados, com os modelos
`omniroute-personal/cmd/deepseek/deepseek-v4-flash` e `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`, e nunca em
paralelo com a suíte completa. Eles reescreveram `F3-live-output.md` e `F6-live-output.md` (outras fases); os dois
arquivos foram restaurados e não entram nesta fase.

### Fatos ao vivo (resumo de F7-live-output.md)

| Fato | Leitura |
|---|---|
| `P1-precedence` | `unknown`: o servidor lista as fontes na ordem global, projeto, `OPENCODE_CONFIG_CONTENT`, mas não revela o vencedor sem inferência. O opc mantém "a última vence". `model` chega como objeto `{providerID, model}` |
| `P2-children-cursor` | `cursor-keeps-filter`: o cursor mantém o filtro `parentID` |
| `P3-fork` | `missing`: o fork volta sem `permissions` e sem `model` |
| `P4-model-updated` | 418 ms até o evento `model.updated`, num servidor só com provider customizado |
| `I1-compaction` | `marker-only` (o script desta rodada classificou `filled-on-post`; o critério foi corrigido): a compactação é só uma mensagem marcador, o POST respondeu em 7 ms e a sessão já estava ociosa |
| `I2-pending-revert` | `consolidates`: um prompt novo consolida o revert pendente e as mensagens revertidas somem |

## O que mudou

- **Config (Tarefa 2):** `model` e `small_model` da config do OpenCode, quando objetos, são normalizados para
  `provider/modelo`. A precedência das fontes (a última vence) foi fixada por teste; sem a Variante B (P1 ficou
  `unknown`).
- **Catálogo (Tarefa 3):** os providers declarados são lidos da chave `providers` da config V2 (fixtures
  capturados ao vivo), com a chave `provider` do V1 como reserva. Com providers declarados, o catálogo está pronto
  quando eles carregam e `model.updated` só encurta a espera; sem providers declarados, vale a regra da F6 (esperar o
  evento até o teto). Em attach, a espera vai até 15 s com o catálogo vazio e até 2 s depois do primeiro catálogo
  não vazio; o aviso nomeia os faltantes e o `TIMEOUT` informa o teto e o próximo passo.
- **Servidor V1 registrado (Tarefa 4):** um servidor do opc que responde como anterior à 2.0.22 é substituído; com
  jobs ativos nele, o erro é `V1_SERVER_ACTIVE`.
- **Paginação (Tarefa 5):** as páginas seguintes de `children` enviam só `cursor` e `limit` (P2).
- **Runner (Tarefa 6):** a interrupção é confirmada pela ociosidade da sessão.
- **Sessões (Tarefas 7 e 8):** `session show` lista as mensagens mais recentes; `session fork` reaplica e verifica
  regras e modelo (P3) e falha com `FORK_INHERITANCE_FAILED` sem apagar o fork; `summarize` espera a compactação
  em um único `--timeout` (`TIMEOUT`, exit 5, "a compactação continua no servidor"); `task --resume` e
  `summarize` avisam de revert pendente (I2); a prévia do `revert` avisa quando o estado dos snapshots é
  desconhecido.
- **Transfer (Tarefa 9):** o `resumeCommand` usa o binário configurado e uma fonte de senha fora do argv
  (`"$(cat '<stateDir>/attach.secret')"` no gerenciado, `"$OPC_SERVER_PASSWORD"` em attach). Se o segredo não puder
  ser gravado depois da importação, o comando devolve o ID da sessão, `resumeCommand: null` e um aviso para usar
  `/opc:attach`, em vez de falhar e induzir uma segunda importação.
- **Limpeza (Tarefa 10):** removidos os ramos `StructuredOutputError` e `planner_structured_output` do OpenCode 1.
- **Docs (Tarefa 11):** `commands.md`, `troubleshooting.md`, `configuration.md`, os comandos
  `session.md` e `transfer.md`, o CHANGELOG e os A CONFIRMAR resolvidos no [relatório da F6](F6-report.md).

## Pendências e achados

- A CONFIRMAR (P1): a precedência entre a config global, a do projeto e `OPENCODE_CONFIG_CONTENT` no servidor. A
  ordem do opc segue a documentação do OpenCode; só uma sessão com inferência sem modelo explícito revelaria o
  vencedor.
- NÃO VALIDADO ao vivo: a espera do catálogo em attach (nenhum teste ao vivo usa `OPC_SERVER_URL`) e com providers
  declarados pela chave `providers` (corrigida após a rodada ao vivo).
- NÃO VALIDADO ao vivo: a substituição de um servidor registrado anterior à 2.0.22 (Tarefa 4).
- A CONFIRMAR: a forma V2 de `enabled_providers` e `disabled_providers`; o opc os trata como listas de ids, como na
  documentação do V1, e isso não foi observado ao vivo.
- NÃO VALIDADO ao vivo: a linha de retomada do transfer (`resumeCommand`) renderizada, nas duas formas de senha.
- NÃO VALIDADO: testes manuais do operador no Claude Code e na TUI (`/opc:attach`, `--pane`, retomada após
  transfer, instalação, `/mcp`, permissões). macOS e Windows seguem indisponíveis.
- Se a compactação do V2 é síncrona ou assíncrona segue indeterminado (7 ms de resposta, sem inferência no POST); o
  opc trata a compactação como marcador e espera a sessão ociosa. `contract/opencode-2.0.22/compact.json` segue
  sintético.
- Sessões criadas pelos testes ao vivo seguem nos bancos isolados dos servidores de teste.

### Atualização F8

A [F8](F8-report.md) resolveu, ao vivo no OpenCode 2.0.22, parte do que ficou pendente aqui (os vereditos acima
seguem como foram registrados na F7): a espera do catálogo e o aviso em attach, a linha de retomada do transfer nas
duas formas de senha, a precedência P1 (`env-wins`: a última fonte vence) e o fato de o `GET /api/config` do V2
omitir `enabled_providers` e `disabled_providers` (o catálogo `/api/model` os respeita). A substituição de um
servidor V1 registrado ficou N/A ao vivo (o `serve` do V1 isolado não responde); segue coberta por testes unitários.
