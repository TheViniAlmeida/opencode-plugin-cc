# F9 — backlog do CHECKLIST · relatório de fase

- **Data:** 08/10/2026 (America/Belem).
- **Branch:** `feat/opc-f9-backlog`.
- **Contrato:** OpenCode ≥ 2.0.22; somente `/api/*`. A F9 triou os "Riscos em aberto" do
  [CHECKLIST](../superpowers/plans/2026-09-26-opc-CHECKLIST.md), corrigiu dois deles e atualizou a spec com as
  respostas ao vivo da [F8](F8-report.md).

## Portão

| Item | Evidência | Resultado |
|---|---|---|
| Suíte completa | `node scripts/run-tests.mjs`: 2103 testes, 2102 aprovados, 0 falhas, 0 cancelados (1 ignorado) | PASSOU |
| `npm run scan-secrets` | `scan-secrets: nenhum achado.` | PASSOU |
| `git diff --check` | Saída vazia, exit 0 | PASSOU |
| Servidores falsos órfãos | `ps -eo ppid=,args= \| awk '$1==1 && $3 ~ /tests\/fixtures\/bin\/opencode$/' \| wc -l`: 0 | PASSOU |

## O que mudou

- **Config (3075d1f):** o `.opc.json` com `{"delegation":{"auto":false}}` desliga o lembrete de delegação sem aviso;
  `true` é ignorado com o aviso `.opc.json: o workspace só pode desligar (false); ignorado` (caminho `delegation.auto`). Antes, o aviso enganoso "não
  pode ser substituída no workspace; ignorado" saía mesmo quando o valor valia. `docs/configuration.md` foi atualizado
  em 4d8743a.
- **Permissões (72ab1df):** `permissions reply` e `answer` limpam o pedido em todos os jobs que o espelham (membro e
  grupo), e a dica do `/opc:status` aponta para o membro. Teste em `tests/unit/permissions-answers.test.mjs`.
- **Teste (22691f4):** o fallback cancelado pina `errorCode: 'cancelled'`.
- **Docs:** CHANGELOG (`Corrigido — F9`), triagem e seção F9 do CHECKLIST, spec (nota "V2 (F8)" na tabela de fatos,
  "Respostas (F8)" no §15 e rev. 4) e a convenção dos modelos do fixture no cabeçalho de `tests/helpers.mjs`.

## Riscos triados

| Item | Veredito | Nota |
|---|---|---|
| Testes de integração F2a–F5 | RESOLVIDO | rodam na suíte (`scripts/run-tests.mjs` coleta `tests/{unit,integration}`) |
| `permissions` em grupo limpa só o primeiro job | CORRIGIDO | 72ab1df |
| `runJobTurn` × updater serial | ACEITO | `updateJob` roda sob o lock de estado; só a fase exibida pode ficar defasada (`tests/unit/jobs-attempts.test.mjs`) |
| Cancelamento durante o fallback | RESOLVIDO | o stop só vale sem cancelamento; pinado por teste (22691f4) |
| `delegation` no `.opc.json` | CORRIGIDO | 3075d1f; a chave é aceita e o workspace só desliga |
| F5 endurece `resolveArgv`/`readRawArgs` | RESOLVIDO | `splitAtTerminator` (`tests/unit/args-terminator.test.mjs`) |
| Timeout de 20 s explícito na F2a | ACEITO | teto de espera, não sleep; revisitar só se houver flake |
| `stopAllServers` lento | ACEITO | cerca de 0,08 s por chamada sem servidor (~0,1 s por teste) |
| Probes da F1 com divergência falsa | RESOLVIDO | `tests/fixtures/contract-shapes.mjs` só diverge com o campo nos dois lados e tipo diferente (`tests/unit/contract-shapes.test.mjs`) |
| Fixture `fake-provider/…` fora do catálogo | ACEITO | testes que resolvem modelo gravam `defaultModel`; convenção no cabeçalho de `tests/helpers.mjs` |
| Paridade MCP × CLI | ACEITO | `mcp-server.test.mjs` compara 7 leituras no caminho de sucesso; recusas em `mcp-jobs.test.mjs` |
| Janela entre criar a filha e o PATCH | OBSOLETO | no V2 a filha herda as permissões e `dispatchSubagent` cria a sessão já com `permissions` (`runner.mjs`) |

## Pendências

Herdadas da F8, sem mudança:

- NÃO VALIDADO (operador): instalação real do plugin no Claude Code (§15, item 8).
- NÃO VALIDADO (operador): `/clear` numa sessão interativa (§15, item 9, parte manual).
- A CONFIRMAR (operador): `opc-worker` num time real, Agent Teams (§15, item 11).
- NÃO VALIDADO (operador): `/opc:attach --pane`.
- NÃO VALIDADO: TUI independente no mesmo projeto junto com o servidor gerenciado (§15, item 12, parte do storage
  concorrente).
- Inconclusivos ao vivo: §15, itens 2 e 4.
- macOS e Windows seguem indisponíveis.
