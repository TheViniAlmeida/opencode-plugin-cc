# F4a — saída dos testes ao vivo

Saída sanitizada (id de provedor neutro, caminhos como `<tmp>`/`~`). OpenCode 1.18.32; rotas `omniroute-personal/cmd/deepseek/deepseek-v4-flash` (OPC_LIVE_MODEL), `omniroute-personal/cmd/Qwen/Qwen3.7-Flash` (OPC_LIVE_MODEL_2) e `omniroute-personal/cmd/moonshotai/Kimi-K2.6` (OPC_LIVE_MODEL_3). Rodada final: 6 passaram, 1 pulado (fallback: NÃO VALIDADO). Contrato OpenCode 1.18.32 × fake: sem divergências nos campos usados.

### probe-failing-model

```
omniroute-personal/cmd/does-not-exist-f4a	sem-job	-	-
omniroute-personal/cmd/MiniMaxAI/MiniMax-M2.7	failed	fatal	APIError
omniroute-personal/opencode-go/deepseek-v4.1-flash	failed	fatal	APIError
omniroute-personal/cmd/deepseek/deepseek-v4-flash	completed	-	-
Primeiro modelo com falha recuperável: nenhum
```

O modelo inexistente é recusado antes de criar o job (catálogo `/provider`); MiniMax responde 400 e `opencode-go` responde 402, ambos `APIError` fatal (sem `isRetryable`), portanto sem fallback. Nenhuma rota disponível produziu falha recuperável: o fallback ao vivo fica NÃO VALIDADO e segue coberto pelos testes de integração com o servidor falso.

### routing-first

```
exit=0
model=omniroute-personal/cmd/deepseek/deepseek-v4-flash
status=completed
attempts=[{"model":"omniroute-personal/cmd/deepseek/deepseek-v4-flash","status":"completed","errorClass":null,"errorType":null}]
[opc] tarefa ask-muml2cu7-57x2r5 iniciada (omniroute-personal/cmd/deepseek/deepseek-v4-flash); acompanhe com /opc:status ask-muml2cu7-57x2r5
[opc] Na fila: ask (omniroute-personal/cmd/deepseek/deepseek-v4-flash, perfil read-only).
[opc] tentativa 1/2: omniroute-personal/cmd/deepseek/deepseek-v4-flash
[opc] Sessão ses_f131c8790ffeaaztWAiBObr0sB
[opc] Turno concluído.
[opc] Saída final

```

### routing-tier-heavy

```
exit=0
model=omniroute-personal/cmd/moonshotai/Kimi-K2.6
status=completed
attempts=[{"model":"omniroute-personal/cmd/moonshotai/Kimi-K2.6","status":"completed","errorClass":null,"errorType":null}]
[opc] tarefa ask-muml4ad4-bn53d6 iniciada (omniroute-personal/cmd/moonshotai/Kimi-K2.6); acompanhe com /opc:status ask-muml4ad4-bn53d6
[opc] Na fila: ask (omniroute-personal/cmd/moonshotai/Kimi-K2.6, perfil read-only).
[opc] Sessão ses_f131b2660ffeobSccM8FuUYIrk
[opc] Turno concluído.
[opc] Saída final

```

### routing-denied-entry

```
exit=0
model=omniroute-personal/cmd/Qwen/Qwen3.7-Flash
status=completed
attempts=[{"model":"omniroute-personal/cmd/Qwen/Qwen3.7-Flash","status":"completed","errorClass":null,"errorType":null}]
[opc] aviso: ignorado omniroute-personal/cmd/deepseek/deepseek-v4-flash: modelo omniroute-personal/cmd/deepseek/deepseek-v4-flash negado pela política (regra: policy.models.deny: *deepseek-v4-flash*)
[opc] tarefa ask-muml6cnh-ghw8kc iniciada (omniroute-personal/cmd/Qwen/Qwen3.7-Flash); acompanhe com /opc:status ask-muml6cnh-ghw8kc
[opc] Na fila: ask (omniroute-personal/cmd/Qwen/Qwen3.7-Flash, perfil read-only).
[opc] Sessão ses_f1319ae96ffe2Qp8lIyKGpeShg
[opc] Turno concluído.
[opc] Saída final

```

### routing-invalid-entry

```
exit=0
model=omniroute-personal/cmd/deepseek/deepseek-v4-flash
status=completed
attempts=[{"model":"omniroute-personal/cmd/deepseek/deepseek-v4-flash","status":"completed","errorClass":null,"errorType":null}]
[opc] aviso: ignorado omniroute-personal/does-not-exist-f4a: modelo desconhecido "omniroute-personal/does-not-exist-f4a": não encontrado em /provider
[opc] tarefa ask-muml899j-abn68d iniciada (omniroute-personal/cmd/deepseek/deepseek-v4-flash); acompanhe com /opc:status ask-muml899j-abn68d
[opc] Na fila: ask (omniroute-personal/cmd/deepseek/deepseek-v4-flash, perfil read-only).
[opc] Sessão ses_f13185489ffencawZcRs9i4VjX
[opc] Turno concluído.
[opc] Saída final

```

### worker-ask

```
exit=0
jobs=1
stdout=`Demo` (README.md:1). The trailing `$(touch pwned)` / `id` text was ignored as literal data.

---
Tarefa: ask-mumla5bg-vwqyey · Sessão: ses_f1316fb0dffeigHmZx7V8Oa7Rj · Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Continuar: /opc:ask --resume ask-mumla5bg-vwqyey

stderr=[opc] tarefa ask-mumla5bg-vwqyey iniciada (omniroute-personal/cmd/deepseek/deepseek-v4-flash); acompanhe com /opc:status ask-mumla5bg-vwqyey
[opc] Na fila: ask (omniroute-personal/cmd/deepseek/deepseek-v4-flash, perfil read-only).
[opc] Sessão ses_f1316fb0dffeigHmZx7V8Oa7Rj
[opc] glob
[opc] read
[opc] Turno concluído.
[opc] Saída final

```

### worker-plan

```
exit=0
jobs=1
stdout=## 1. Goal

Add a `CONTRIBUTING.md` at the repo root that tells contributors how to propose changes to this project (setup, branch/commit conventions, PR flow), and link it from the `README.md`.

## 2. Files

- **Create** `CONTRIBUTING.md` — new contributor guide.
- **Modify** `README.md:1-3` — append a one-line link to `CONTRIBUTING.md` under the intro.

## 3. Steps

1. Write `CONTRIBUTING.md` with these sections:
   - **Getting started** — prerequisites and how to run the project. *Project has no build/tooling checked in yet* (only `README.md`, which says "prints hello"), so state this as "T
stderr=[opc] tarefa plan-mumlcgtj-6n8ria iniciada (omniroute-personal/cmd/deepseek/deepseek-v4-flash); acompanhe com /opc:status plan-mumlcgtj-6n8ria
[opc] Na fila: plan (omniroute-personal/cmd/deepseek/deepseek-v4-flash, perfil read-only).
[opc] Sessão ses_f13155483ffeAJg23xwoj4BqDD
[opc] read
[opc] glob
[opc] read
[opc] glob
[opc] Turno concluído.
[opc] Saída final

```
