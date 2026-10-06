# F6 — migração para OpenCode V2 · relatório de fase

- **Data:** 06/10/2026 (America/Belem).
- **Branch:** `feat/opc-f6-opencode-v2`.
- **Contrato:** OpenCode ≥ 2.0.22; somente `/api/*`. O V1 deixa de ter suporte.
- **Base:** [avaliação](../superpowers/specs/2026-10-06-opc-opencode-v2-assessment.md) e
  [plano](../superpowers/plans/2026-10-06-opc-F6-opencode-v2.md).

## Portão

| Item | Evidência | Resultado |
|---|---|---|
| Suíte completa | `npm test`: 1986 testes, 1985 aprovados, 0 falhas, 0 cancelados (1 ignorado) | PASSOU |
| `npm run scan-secrets` | `scan-secrets: nenhum achado` | PASSOU |
| `git diff --check` | Saída vazia, exit 0 | PASSOU |
| Referências V1 fora dos docs publicados | `tests/unit/docs-f6.test.mjs` | PASSOU |
| Ferramentas MCP documentadas conforme o catálogo | Teste de docs compara a tabela com `TOOL_NAMES` (24 ferramentas) | PASSOU |
| Contrato V2 ao vivo (`contract-v2.mjs`) e paridade com o fake (`contract.mjs`) | [saída ao vivo](F6-live-output.md) | PASSOU |
| Jobs, review, subagentes, conclave, MCP e transfer ao vivo com dois modelos | [saída ao vivo](F6-live-output.md) | PASSOU |
| Serves do operador antes/depois | Mesmos PIDs e portas | PASSOU |
| Instalação, `/mcp`, permissões e associação de sessão no Claude Code | Procedimento manual do operador | NÃO VALIDADO |
| TUI: `/opc:attach`, `--pane` e retomada após transfer (`opencode --server <url> -s <id>`) | Procedimento manual do operador | NÃO VALIDADO |
| macOS e Windows | Ambientes indisponíveis | NÃO VALIDADO |

## O que mudou

- Camada de integração reescrita para o V2: rotas `/api/*` com envelope `{data}`, header
  `x-opencode-directory` absoluto, health por `/api/info` com JSON obrigatório e versão mínima 2.0.22.
- Eventos V2 (`session.execution.*`, `session.retry.scheduled`, heartbeat em comentário). O fim de turno vem da
  mensagem `idle{outcome}`.
- Permissões no formato `{action, resource, effect}`, com pedidos e forms por sessão. Toda sessão nasce com
  regras e modelo explícitos.
- Saída estruturada passou a ser JSON no texto, validado localmente (review, conclave, orchestrate).
- Sessões: interromper com `interrupt`, revert por stage/commit, summarize por `compact`. `session todo` foi
  removido.
- Transfer no formato V2 (`opencode session import`). A retomada usa `opencode --server <url> -s <id>`.
- Boot do servidor gerenciado: espera o evento `model.updated` antes de confiar no catálogo (achado do portão ao
  vivo; detalhes na saída ao vivo).

## Pendências e achados

- Sessões de sonda `OPC: v2 probe*` criadas durante a avaliação seguem no banco V2 do operador. A remoção depende
  de autorização explícita.
- `f4c-opinion.mjs` exige três modelos distintos; o portão rodou com dois (`OPC_LIVE_POOL`).
- Modo attach (`OPC_SERVER_URL`): a espera por `model.updated` só vale para servidores gerenciados. Um servidor
  existente que abre um diretório novo pode responder com o catálogo ainda incompleto (A CONFIRMAR).
- O vazamento de servidores falsos visto numa medição intermediária não se reproduziu: os seis arquivos de
  integração suspeitos passam e deixam zero órfãos.
