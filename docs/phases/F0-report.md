# Relatório de fase — F0 · Fundação e conexão

- **Data do portão:** 26/09/2026
- **Branch / PR:** `feat/opc-f0` / PR não informado
- **OpenCode:** 1.18.32, reportado por `/global/health` no teste ao vivo
- **Node:** 22.22.1 local; Node 20 **NÃO VALIDADO** localmente (CI do PR roda Node 20 e 22)
- **Modelo ao vivo:** provider pessoal do operador

Legenda: `PASSOU` (executado e verde), `N/A` (não se aplica, com motivo), `NÃO VALIDADO` (não foi possível verificar, com motivo) e `FALHOU` (com a saída).

## 1. `npm test`

```text
npm test (Node 22.22.1): 218/218 pass, 0 fail
# tests: 218
# pass: 218
# fail: 0
# duration_ms: não registrado no resultado do portão
```

CI em Node 20 e 22: **NÃO VALIDADO** neste relatório; o link e o status da execução não foram fornecidos. A validação local em Node 20 também ficou **NÃO VALIDADO**.

## 2. Aceite de integração (spec §13.3 F0)

| # | Critério | Teste | Status |
|---|---|---|---|
| 1 | Sobe, reaproveita e encerra | `server-lifecycle`; `setup-server` | PASSOU |
| 2 | `stale-server-pid`: descartado sem sinal | `server-lifecycle` | PASSOU |
| 3 | `hung-server`: encerrado e trocado | `server-lifecycle` | PASSOU |
| 4 | `version-changed` | `server-lifecycle` | PASSOU |
| 5 | Dois `setup` simultâneos → um spawn | `setup-server`; `server-lifecycle` | PASSOU |
| 6 | `stale-lock`: quebrado | `locks`; `server-lifecycle` | PASSOU |
| 7 | `port-mismatch` / `eaddrinuse` → nova tentativa | `server-boot` | PASSOU |
| 8 | `ignores-sigterm` → SIGKILL | `server-lifecycle`; `process` | PASSOU |
| 9 | SSE cai, sem heartbeat ou instância descartada → ressincroniza | `sse-hub` | PASSOU |
| 10 | `auth-401` → exit 5, sem retry | `server-boot`; `setup`; `http` | PASSOU |
| 11 | Versão abaixo da mínima → `UnsupportedVersion` | `server-boot`; `setup` | PASSOU |
| 12 | Spawner sai e servidor segue reaproveitável | `setup-server` | PASSOU |
| 13 | Saída e log não contêm senha | `secrets` | PASSOU |
| 14 | `.opc.json` não amplia allow nem altera chave travada | `config`; `setup` | PASSOU |
| 15 | `OPC_SERVER_URL` HTTP não-loopback é recusado | `server-boot`; `setup` | PASSOU |
| 16 | Mesmo estado com `CLAUDE_PLUGIN_DATA` e `OPC_DATA_DIR` | `setup` | PASSOU |
| 17 | Permissões 700/600 | `setup`; `state` | PASSOU |
| 18 | `share-auto` → recusa | `server-boot`; `setup` | PASSOU |
| RF1 | Argumentos com aspas, crases, `$()`, quebras e Unicode intactos | `args`; `cli` | PASSOU |
| RF2 | Workspace com espaços | `state`; `setup-server` | PASSOU |
| RF4 | Servidor encerrado externamente | `server-lifecycle` | PASSOU |

## 3. Aceite ao vivo

| Critério | Evidência | Status |
|---|---|---|
| Modelo no teste `f0-connection` | teste somente de servidor | N/A — modelo não usado |
| `/opc:setup` real no Claude | instalação no Claude Code ainda não realizada | NÃO VALIDADO — depende do operador |
| Porta ≠ 4096, reaproveitamento e encerramento sem órfão | `tests/live/f0-connection.mjs` | PASSOU |
| `opencode serve` preexistentes continuam vivos | contagem antes/depois: 5/5 | PASSOU |
| Probe de precedência executado | `tests/live/probe-permission-precedence.mjs` | PASSOU — vereditos abaixo |
| Contrato executado | `tests/live/contract.mjs --write` | PASSOU |

```text
[live] setup #1: exit 0 em ~42 s; porta 40405; versão 1.18.32
[live] health: healthy=true
[live] setup #2: exit 0 em ~8,6 s; reaproveitado=true
[live] stop: exit 0 em ~3,5 s; {"stopped":true,"reason":"killed"}
[live] opencode serve preexistentes intactos: 5/5
```

## 4. Contrato (`tests/live/contract.mjs`)

- Snapshot: `tests/fixtures/contract/opencode-1.18.32.shapes.json`.
- Divergências nos campos usados: nenhuma (**PASSOU**).
- O snapshot tem apenas formas e allowlist de chaves; a varredura de identificadores e o scanner de segredos passaram.

## 5. Respostas dos itens A CONFIRMAR (spec §15)

| Item | Resposta e evidência | Impacto no plano |
|---|---|---|
| §15.1 | **CONFIRMADO por evidência indireta**: deny na sessão removeu edit/bash do conjunto e nada foi alterado; o controle com `bash:ask` usou bash normalmente. | Sessão vence; sem plano B por esse motivo. |
| §15.2 | **INCONCLUSIVO ao vivo**: a sessão B não tentou a ferramenta. Pelo código, `always` vale para a instância e vence deny; o plugin não usa `always`. | Documentar em permissions.md na F2a. |
| §15.4a | Padrões de grep/glob/list são termo ou glob, **não caminhos**; `sensitivePaths` só protege read e grep pode ler `.env`. | Aplicar plano B no perfil read-only da F2a: negar grep ou equivalente. |
| §15.4b | **INCONCLUSIVO**: a ferramenta MCP injetada não apareceu. | Manter plano B para `policy.tools.deny`. |
| §15.5 | **MERGE na prática**: override desligou share e uma MCP do usuário; as 7 MCPs do usuário permaneceram. Veredito automático **INCONCLUSIVO** porque não confirmou uma chave específica. | Valida `server.configOverride` para a F1. |
| §15.8 | **PENDENTE**: requer instalação do plugin no Claude Code pelo operador. | Confirmar o nome do diretório de dados antes de congelar o id. |

## 6. Desvios e decisões

| Desvio/decisão | Motivo | Muda interface? |
|---|---|---|
| Saídas do portão no scratchpad privado, não em diretório temporário compartilhado | Evitar exposição de dados locais | Não |
| Heredoc `OPC_ARGS_5f1d0c7a_EOF` | Delimitador canônico para argumentos literais | Não |
| Reaproveitamento levou ~8,6 s | Inclui GET `/config` da checagem de mundo e aquecimento; investigar na F1 | Não |
| Primeira versão do snapshot descartada | Vazava chaves de mapas de configuração; não foi commitada; gerador passou a usar allowlist | Não |
| Testes com socket foram executados pelo controlador fora do sandbox | Limitação do sandbox | Não |
| Commit | Commits realizados pelo controlador após a entrega no sandbox; mensagem: `docs: add F0 docs, phase report and changelog` | Não |

## 7. Interfaces novas entregues

Foram entregues as interfaces F0 do plano: núcleo de erros, redação, argumentos, processos, locks, estado, configuração, HTTP, SSE e servidor; `createContext`, CLI e `setup`; helpers e fake; runner e scanner; além de `tests/fixtures/contract-shapes.mjs` com `MAP_PATHS`, `shapeOf`, `lookup` e `diffShapes`. Não há ajuste de assinatura registrado neste portão.

## 8. Documentação

README, instalação, arquitetura, solução de problemas e este relatório usam somente evidência do portão e caminhos redigidos. A varredura final desta entrega é registrada no relatório de tarefa privado.

## Itens pendentes do operador

1. Instalar o plugin no Claude Code e executar `/opc:setup`.
2. Informar o nome do diretório criado em `~/.claude/plugins/data/` para fechar o §15.8.
3. Executar os itens manuais ainda não validados: saída do `/opc:setup` no Claude e o status/link da CI em Node 20 e 22.

## 9. Pendências para a F1

- Investigar o reaproveitamento lento observado no teste ao vivo.
- Revisar o plano da F1 à luz das respostas do §15, especialmente o plano B do perfil read-only.
