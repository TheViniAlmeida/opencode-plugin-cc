# F8 — fechamento ao vivo · relatório de fase

- **Data:** 08/10/2026 (America/Belem).
- **Branch:** `feat/opc-f8-live-closure`.
- **Contrato:** OpenCode ≥ 2.0.22; somente `/api/*`. A F8 fecha, ao vivo, os NÃO VALIDADO e A CONFIRMAR da
  [F7](F7-report.md) que um servidor isolado permitia exercitar.
- **Fatos ao vivo:** [F8-live-output.md](F8-live-output.md) (sondas de attach, linhas de retomada e precedência).

## Portão

| Item | Evidência | Resultado |
|---|---|---|
| Suíte completa | preenchido no portão | A CONFIRMAR |
| `npm run scan-secrets` | preenchido no portão | A CONFIRMAR |
| `git diff --check` | preenchido no portão | A CONFIRMAR |
| Servidores falsos órfãos | preenchido no portão | A CONFIRMAR |
| Guarda de docs da F8 | `tests/unit/docs-f8.test.mjs` | A CONFIRMAR |
| Claude Code headless (`claude -p --plugin-dir`, `--model haiku`) | servidor V2 isolado em attach e `OPC_DATA_DIR` temporário, sem tocar nas settings: a ferramenta MCP `opc_models` respondeu (`is_error` falso, `probe/a` na lista, 0 negações); os hooks `SessionStart` e `SessionEnd` gravaram `reaper.log` e `sessions.log` | PASSOU |
| §15, item 9: `ppid` do hook | não é o Claude: o hook roda sob um `sh -c` transitório, já morto ao fim do hook; o servidor MCP é filho direto do `claude`. Depois da correção (c946a54), o registro guarda o `claude` (`pidComm` `claude`, vivo, mesmo pid que o pai do servidor MCP) | PASSOU |
| Attach (`OPC_SERVER_URL`): catálogo e aviso de providers sem modelos | `opc models` com exit 0 em cerca de 2,3 s; o aviso no stderr cita `ghost-gw` e `disabled-gw` | PASSOU |
| Linha de retomada do transfer em attach | pty (`script -qfec`): `"$OPC_SERVER_PASSWORD"` na linha, a TUI mostrou o título da sessão importada, sem erro de autenticação e sem senha na linha | PASSOU |
| Linha de retomada do transfer no gerenciado | pty: `$(cat '<stateDir>/attach.secret')` na linha, mesmo resultado da TUI | PASSOU |
| P1 (§15, item 5): precedência das fontes de config | global, projeto e `OPENCODE_CONFIG_CONTENT` com `model`; a sessão sem modelo foi respondida pelo modelo do env (`env-wins`) | PASSOU |
| §15, item 3: `PATCH /api/session/:id {permissions}` | `replaces`: o PATCH substitui as regras | PASSOU |
| §15, item 1: regras da sessão contra o arquivo | regras da sessão negando `read`: arquivo não lido, sem chamada de ferramenta (`session-rules-win`) | PASSOU |
| §15, item 6: formato do `messageID` | observado `msg_` + 12 hex + 14 base62, como no código | PASSOU |
| §15, item 10: import do transfer | `f5-transfer.mjs` (F7) e as linhas de retomada da F8 | PASSOU |
| §15, item 12: TUI e servidor gerenciado | a TUI se anexou ao servidor gerenciado do opc enquanto ele rodava (pty) | PASSOU |
| Troca de servidor V1 registrado | o `serve` do V1 1.18.34 isolado não imprime nada em 25 s e o opc antigo deu `BOOT_FAILED` 3 vezes em 60 s; coberto por `tests/unit/server-v1-record.test.mjs` | N/A |

### Fatos ao vivo (resumo de F8-live-output.md)

| Fato | Leitura |
|---|---|
| `attachCatalog` | exit 0; o aviso no stderr nomeia os providers declarados sem modelos (`ghost-gw`, `disabled-gw`) |
| `attachResume` | `usesEnvReference` verdadeiro, `leaksPassword` falso; a TUI mostrou o título e nenhum erro de autenticação |
| `P1-bare-session-model` | `env-wins`: o modelo respondente veio do `OPENCODE_CONFIG_CONTENT` (a última fonte vence) |
| `item3-patch-permissions` | `replaces` |
| `item1-session-rules` | `session-rules-win (file not read)` |
| `GET /api/config` do V2 | omite `disabled_providers` e `enabled_providers` (traz só share, mcp, plugins, providers e experimental); o catálogo `/api/model` respeita as duas listas |

## O que mudou

- **Avisos (c586f4b):** os avisos do servidor (`surfaceServerWarnings` em `context.mjs`) saem no stderr da CLI como
  `[opc] aviso: …`, deduplicados e silenciosos dentro de hooks; o `transfer` os inclui em `warnings`. O texto do aviso
  de providers sem modelos cita `disabled_providers`/`enabled_providers`, porque o `GET /api/config` do V2 não expõe
  essas listas.
- **README (c504a09):** README em inglês (`README.en.md`) e status do README atualizado.
- **Hooks (c946a54):** o `SessionStart` registrava o pid do `sh -c` transitório que o Claude Code usa para rodar
  hooks. Com isso a associação MCP → sessão (`resolveClaudeSessionId`, que casa o pai do servidor MCP) nunca casava e
  a vida da sessão caía sempre no fallback de 24 h. `resolveHookOwner` (em `process.mjs`) sobe um nível quando o pai
  do hook é um shell e registra o processo do Claude.
- **Sondas ao vivo (23db9a7):** attach, linhas de retomada e precedência de config.
- **Docs:** CHANGELOG, `troubleshooting.md`, nota de atualização no [relatório da F7](F7-report.md), checklist
  (§15 e backlog) e a guarda `tests/unit/docs-f8.test.mjs`.

## Pendências e achados

- NÃO VALIDADO (operador): instalação real do plugin no Claude Code (§15, item 8), que altera as settings; segue
  manual.
- NÃO VALIDADO (operador): `/clear` numa sessão interativa não derrubar o servidor (§15, item 9, parte manual). O
  `ppid` foi medido e corrigido (ver o portão).
- A CONFIRMAR (operador): `opc-worker` num time real, Agent Teams (§15, item 11).
- Inconclusivos ao vivo: §15, itens 2 (alcance do `always`) e 4 (grep/list/glob e curinga de nome para MCP).
- NÃO VALIDADO: `/opc:attach --pane` (manual do operador).
- Limitação: nas ferramentas MCP o stderr é descartado em caso de sucesso, então o aviso de providers sem modelos
  não aparece lá; use a CLI.
- N/A ao vivo: a troca de um servidor V1 registrado (ver o portão).
- macOS e Windows seguem indisponíveis.
