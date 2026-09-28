# Relatório da fase F2a — Núcleo de execução

- **Data do portão:** 28/09/2026
- **Branch / PR:** `feat/opc-f2a` → `main`
- **OpenCode:** 1.18.32
- **Node:** v22.22.1 (CI: 20 e 22) · **SO:** Linux
- **Modelo ao vivo:** `omniroute-personal/opencode-go/deepseek-v4.1-flash`
- **Legenda:** `PASSOU` · `N/A` · `NÃO VALIDADO` · `DESVIO`

## 1. `npm test`

| Total | Pass | Fail | Duração |
| --- | --- | --- | --- |
| 750 | 749 (+1 pulado) | 0 | 80 s |

O único pulado é o cenário cross-UID de `gc`, que exige root.

## 2. Checklist ao vivo (spec §13.3, F2a)

| # | Item | Teste | Resultado | Evidência |
| --- | --- | --- | --- | --- |
| 1 | `/opc:ask` read-only | `f2a-ask-plan.mjs` | PASSOU | Ledger: ask/plan PASSOU |
| 2 | `/opc:plan` read-only | `f2a-ask-plan.mjs` | PASSOU | Ledger: ask/plan PASSOU |
| 3 | `task --write` cria arquivo | `f2a-write.mjs` | PASSOU | 2/2 |
| 4 | read-only editar; checksum inalterado | `f2a-readonly.mjs` | PASSOU | 3/3 |
| 5 | read-only ler `.env`; negado | `f2a-readonly.mjs` | PASSOU | 2/2 |
| 6 | grep por conteúdo de `.env`; sem vazamento | `f2a-readonly.mjs` | PASSOU | 2/2; `grep` negado |
| 7 | read-only sem bash | `f2a-readonly.mjs` | PASSOU | 3/3 |
| 8 | `rm -rf` pede usuário; reject | `f2a-destructive.mjs` | PASSOU | 2/2 após esclarecimento do prompt |
| 9 | background + status wait + result | `f2a-jobs.mjs` | PASSOU | jobs 3/3 |
| 10 | cancel de turno longo | `f2a-jobs.mjs` | PASSOU | jobs 3/3 |
| 11 | resume mantém `sessionID` | `f2a-jobs.mjs` | PASSOU | jobs 3/3 |
| 12 | PATCH de permissão em resume | `f2a-probes.mjs` | PASSOU | `LIVE-ANSWER §15.3`: append |
| 13 | `messageID` do cliente | `f2a-probes.mjs` | PASSOU | `LIVE-ANSWER §15.6`: aceito; malformado também aceito |
| 14 | contrato | `tests/live/contract.mjs` | PASSOU | 1/1 |

## 3. Itens A CONFIRMAR da fase (spec §15)

| Item | Resposta | Evidência | Consequência |
| --- | --- | --- | --- |
| 3 — PATCH substitui ou anexa? | **Anexa** | `LIVE-ANSWER §15.3`; D1 confirmado | Mantido `PATCH_PERMISSION_MODE = 'append'` e a regra de troca de perfil |
| 6 — `messageID` aceito | O `messageID` do cliente foi aceito; identificador malformado também foi aceito | `LIVE-ANSWER §15.6` | Não houve correção; validação do servidor é permissiva |
| 4 — grep respeita sensíveis? | PASSOU | Item 6 do checklist, 2/2 | Mantido `grep` negado no read-only |

## 4. Teste de contrato

| Resultado | Divergências | Fake atualizado? |
| --- | --- | --- |
| PASSOU | Nenhuma | Não foi preciso |

## 5. Decisões e desvios

| # | Desvio | Motivo | Muda interface? | Aprovado por |
| --- | --- | --- | --- | --- |
| 1 | Primeiro ensaio destrutivo: 0/3 | O modelo recusou pela regra global do operador carregada pelo OpenCode | Não | Ledger; prompt esclarecido |
| 2 | Reexecução destrutiva: 2/2 | Prompt passou a esclarecer alvo descartável e que o portão decide; `scratch` preservado | Não | Ledger |
| 3 | Heredoc T15 | Delimitador isolado nos argumentos é recusado para evitar injeção | Sim, documentado | Ledger |
| 4 | IDs completos | IDs de servidor/opc válidos não são truncados | Não | Revisão final |
| 5 | Entrada de job privada | Entrada bruta vai a arquivo privado e é consumida atomicamente; registro persistido é redigido | Não | Revisão final |

### Revisão final e correções

A revisão final encontrou 3 críticos (registros sem redação, bypass destrutivo por `bash -c`/`eval`, sessões vivas após falha de PATCH), 2 importantes (órfão em falha de identidade do worker e truncamento de IDs) e 1 menor (log incorreto na corrida cancel/conclusão). Todos foram corrigidos. Rodadas posteriores corrigiram ciclo de vida da entrada privada, symlink, consumo atômico, temporário de escrita, FIFO e descoberta não destrutiva do GC.

## 6. Documentação

- `docs/commands.md` — seção "Execução (F2a)": PASSOU.
- `docs/permissions.md`: PASSOU.
- Exemplos: saídas reais sanitizadas; caminhos como `<tmp>`: PASSOU.
- `node scripts/scan-secrets.mjs docs/`: PASSOU — nenhum achado.

## 7. CHANGELOG

- Entrada F2a em `[Unreleased]`: PASSOU.

## 8. Gravação dupla

- `.ai-data` (fora do repositório versionado): gravada.
- Colmeia `myprojects`: PENDENTE-COLMEIA (MCP indisponível na sessão do portão).

## 9. Pendências para a próxima fase

- Residual: o analisador de shell é intencionalmente conservador e pode pedir confirmação em comando benigno.
