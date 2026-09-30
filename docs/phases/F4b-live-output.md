# F4b — saída dos testes ao vivo

Saída sanitizada (id de provedor neutro, caminhos como `<tmp>`/`~`). OpenCode 1.18.32; rotas `omniroute-personal/cmd/deepseek/deepseek-v4-flash` (OPC_LIVE_MODEL), `omniroute-personal/cmd/Qwen/Qwen3.7-Flash` (OPC_LIVE_MODEL_2) e `omniroute-personal/cmd/moonshotai/Kimi-K2.6` (OPC_LIVE_MODEL_3, também planner). As rotas do plano (`opencode-go/*`) respondem 402 (fatal) no gateway usado, por isso o teste usa rotas definidas por ambiente.

As duas primeiras execuções (antes da correção do portão) terminaram 0/2: o planner com `format: json_schema` falhou com `StructuredOutputError` ("Model did not produce structured output"), sem subtarefas. Com o planner em modo texto (`orchestrate.structuredOutput: text`, padrão), as três execuções abaixo passaram 2/2 cada, com 3 subtarefas em 3 modelos distintos por orquestração. Os processos `opencode serve` preexistentes do operador ficaram intactos.

## Execução 1

### claude-synthesis

```
[f4b-live] claude-synthesis: job=orch-munm925e-bshn0s outcome=completed planner=omniroute-personal/cmd/moonshotai/Kimi-K2.6 subtasks=3 synthesis=claude/pending duration=132.8s
  - list-exports (ask) omniroute-personal/cmd/deepseek/deepseek-v4-flash completed
  - review-math-bugs (review) omniroute-personal/cmd/moonshotai/Kimi-K2.6 completed
  - propose-test-plan (plan) omniroute-personal/cmd/Qwen/Qwen3.7-Flash completed
```

### model-synthesis

```
[f4b-live] model-synthesis: job=orch-munmdh0g-ocps2t outcome=completed planner=omniroute-personal/cmd/moonshotai/Kimi-K2.6 subtasks=3 synthesis=model/completed duration=297.5s
  - list-exports (ask) omniroute-personal/cmd/deepseek/deepseek-v4-flash completed
  - review-math (review) omniroute-personal/cmd/Qwen/Qwen3.7-Flash completed
  - plan-tests (plan) omniroute-personal/cmd/moonshotai/Kimi-K2.6 completed
```

## Execução 2

### claude-synthesis

```
[f4b-live] claude-synthesis: job=orch-munmlfi9-uutgow outcome=completed planner=omniroute-personal/cmd/moonshotai/Kimi-K2.6 subtasks=3 synthesis=claude/pending duration=218.2s
  - list-functions (ask) omniroute-personal/cmd/deepseek/deepseek-v4-flash completed
  - review-math (review) omniroute-personal/cmd/Qwen/Qwen3.7-Flash completed
  - test-plan (plan) omniroute-personal/cmd/moonshotai/Kimi-K2.6 completed
```

### model-synthesis

```
[f4b-live] model-synthesis: job=orch-munmro81-odgk5w outcome=completed planner=omniroute-personal/cmd/moonshotai/Kimi-K2.6 subtasks=3 synthesis=model/completed duration=262.5s
  - list-exports (ask) omniroute-personal/cmd/deepseek/deepseek-v4-flash completed
  - review-math (review) omniroute-personal/cmd/Qwen/Qwen3.7-Flash completed
  - test-plan (plan) omniroute-personal/cmd/moonshotai/Kimi-K2.6 completed
```

## Execução 3

### claude-synthesis

```
[f4b-live] claude-synthesis: job=orch-munmyv4k-c9jrc0 outcome=completed planner=omniroute-personal/cmd/moonshotai/Kimi-K2.6 subtasks=3 synthesis=claude/pending duration=154.3s
  - list-exports (ask) omniroute-personal/cmd/deepseek/deepseek-v4-flash completed
  - review-math (review) omniroute-personal/cmd/moonshotai/Kimi-K2.6 completed
  - plan-tests (plan) omniroute-personal/cmd/Qwen/Qwen3.7-Flash completed
```

### model-synthesis

```
[f4b-live] model-synthesis: job=orch-munn3qp1-e7bg3p outcome=completed planner=omniroute-personal/cmd/moonshotai/Kimi-K2.6 subtasks=3 synthesis=model/completed duration=282.0s
  - list-functions (ask) omniroute-personal/cmd/deepseek/deepseek-v4-flash completed
  - review-math-bugs (review) omniroute-personal/cmd/moonshotai/Kimi-K2.6 completed
  - plan-unit-tests (plan) omniroute-personal/cmd/Qwen/Qwen3.7-Flash completed
```
