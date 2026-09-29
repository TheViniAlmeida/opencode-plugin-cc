# Relatório da fase F4a — Roteamento, fallback, delegação, worker, monitor

- **Data:** 29/09/2026
- **Branch / PR:** `feat/opc-f4a` / PR #7
- **OpenCode:** 1.18.32
- **Modelos ao vivo:** `omniroute-personal/cmd/deepseek/deepseek-v4-flash`, `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`, `omniroute-personal/cmd/moonshotai/Kimi-K2.6`

## 1. `npm test`

**PASSOU** — `# tests 1402`, `# pass 1401`, `# fail 0`, `# skipped 1`.

## 2. Aceite de integração

| Item | Teste | Resultado |
|---|---|---|
| `model-429` com `attempts[]` | `fallback.test.mjs` | PASSOU |
| Retry acima do teto avança | `fallback.test.mjs`; `retry-cap.test.mjs` | PASSOU |
| Erro fatal não avança | `fallback.test.mjs` | PASSOU |
| Escrita após ferramenta não avança | `fallback.test.mjs` | PASSOU |
| `--model` explícito não avança | `fallback.test.mjs` | PASSOU |
| Entrada negada gera aviso | `routing-lists.test.mjs` | PASSOU |
| `SessionStart` com e sem delegação | `session-start-delegation.test.mjs` | PASSOU |
| `opc-worker` e seu comando único | `worker-agent.test.mjs` | PASSOU |
| Focus de cancelamento, resume, hostil, monitor e workspace | testes F4a correspondentes | PASSOU |

## 3. Aceite ao vivo

Saídas sanitizadas: [F4a-live-output.md](F4a-live-output.md).

| Item | Evidência | Resultado |
|---|---|---|
| Lista, `--tier heavy`, entrada negada e inválida | `f4a-routing.mjs` | PASSOU |
| Comando prescrito pelo `opc-worker` | `f4a-worker.mjs` | PASSOU |
| Fallback real | `probe-failing-model.mjs` | NÃO VALIDADO — nenhuma rota apresentou falha recuperável |
| `opc-worker` em Agent Team real | passo manual | A CONFIRMAR (operador) |
| `opc-worker` como subagente comum | `f4a-worker.mjs` | PASSOU |
| Inspeção visual de `opc monitor` | passo manual | A CONFIRMAR (operador) |
| Contrato real × fake | `contract.mjs` | PASSOU — sem divergências |

A rodada ao vivo inicial fez 4/7: dois problemas de regex nos testes expuseram avisos de roteamento truncados e duplicados. Após a correção de gate, a rodada final fez 6 PASSOU e 1 skip (fallback). Os processos `opencode serve` preexistentes do operador permaneceram intactos.

## 4. A CONFIRMAR da fase

- Ferramentas disponíveis ao `opc-worker` em Agent Teams reais: **A CONFIRMAR (operador)**.
- Inspeção visual interativa de `opc monitor`: **A CONFIRMAR (operador)**.
- Semântica de `next` em `session.status retry`: epoch ms, conforme OpenCode 1.18.32; confirmação adicional em ambiente do operador é **A CONFIRMAR**.

## 5. Premissas e desvios

As premissas P1–P10 foram conferidas no ledger da fase. O contrato permaneceu compatível com o fake, sem divergências. Desvios corrigidos no gate: confirmação de abort antes do fallback, backoff cancelável, persistência atômica da tentativa final, roteamento do stop gate, `attempts[]` em JSON de review/result, flags do worker no heredoc e contexto somente leitura do monitor.

Revisão final: gpt-6-sol (high) retornou Não; correção do gate por gpt-6-astra (high); re-review; duas correções de C2 pelo controlador (tentativa encerrada não depende do abort da sessão; exceção para aborts não confirmados — `AbortUnconfirmed` ou `abortConfirmed: false`); re-review final: todos os achados resolvidos. Residual menor: avisos de roteamento já impressos no foreground não entram no log de progresso; permanecem em `request.routingWarnings`.

## 6. Documentação

**PASSOU** — `docs/swarm.md`, `docs/configuration.md`, `docs/commands.md`, `docs/troubleshooting.md`, `docs/architecture.md`, `README.md`, este relatório e `CHANGELOG.md` atualizados. `docs/phases/F4a-live-output.md` foi preservado. Scanner de segredos: **PASSOU** (sem achados). Exemplos de documentação: **PASSOU** — `opc config set/add` de `routing`, `delegation.auto`, `jobs.maxActive`, `config show --effective`, `opc monitor --once` e `--json` executados contra o servidor falso num diretório descartável (os exemplos de `routing` exigem os aliases citados). Plano mestre atualizado com as interfaces do portão.

## 7. Gravação dupla

`.ai-data` gravada (não versionada); colmeia `myprojects` **PENDENTE-COLMEIA** (MCP indisponível na sessão).
