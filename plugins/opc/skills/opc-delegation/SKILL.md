---
name: opc-delegation
description: Use when deciding whether to hand analysis, codebase questions, planning, code review or a multi-part investigation to OpenCode through opc (ask, plan, review, orchestrate), and when a delegated result comes back and must be checked before it is shown to the user.
---

# Delegating work to OpenCode with opc

You (Claude) stay the lead. OpenCode is a second engine you can hand self-contained pieces of work to. Delegation pays off when the work is large, read-heavy or benefits from another model; it costs time, tokens and a round of validation, so do not delegate by reflex.

## Delegate

| Situation | Command |
|---|---|
| A question about the codebase that needs reading several files, tracing a flow or finding a root cause | `opc ask` (`/opc:ask`) |
| An implementation plan: files to touch, order, trade-offs, risks, tests | `opc plan` (`/opc:plan`) |
| A review of the current diff or branch | `opc review --wait` (`/opc:review`) |
| An investigation with independent parts | several `opc ask` / `opc plan` jobs with `--background`, or `/opc:orchestrate` |

`ask`, `plan` and `review` always run read-only. Delegating a change (`opc task --write`) is only for when the user asked OpenCode to make it.

## Do not delegate

- Trivial questions you can answer from what is already in context.
- Small edits (a rename, a one-line fix, a typo): doing them directly is faster and easier to verify.
- Anything that needs the conversation history OpenCode does not have, unless you can state it fully in the prompt.
- Work the user asked *you* to do personally.

## How to call it

Put all flags in the first line of the quoted heredoc body, followed by a line containing only `--`; put the task after that line. The shell command line contains only the command, `--raw-args-stdin` and the quoted heredoc delimiter. `parsePromptArgs` extracts known leading flags before `--` and treats everything after it as task text:

```bash
opc ask --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--model <m>
--
<self-contained question: goal, relevant paths, what a good answer contains>
OPC_ARGS_5f1d0c7a_EOF
```

- Write a self-contained prompt: goal, relevant paths, constraints and the expected shape of the answer.
- Prefer the configured routing (no `--model`) so fallback can work; use `--tier heavy` for hard problems and `--tier light` for quick lookups. An explicit `--model` disables fallback.
- For long work, use `--background` and follow with `opc status <job> --wait` and `opc result <job>`.

## Validate before presenting

A delegated answer is evidence, not truth.

- Spot-check cited `file:line` references with your own reads before repeating them.
- Check that the answer addresses the question that was asked, and flag gaps.
- When the job used fallback, say which model produced the answer (see the attempts list).
- If the result is wrong or thin, say so; do not silently redo the whole task.
- Present review findings as reported by OpenCode, then give your own assessment separately.

## Policy and approver

- Never try to work around an opc policy denial (exit 4) by switching to a model, agent or provider the policy forbids.
- Permission requests (exit 3) follow the `opc-result-handling` rules: with `approver: "user"`, show the request and ask the user before any `opc permissions reply`; destructive commands, `external_directory` and sensitive paths always go to the user.
- Never pass `--confirmed-by-user` unless the user actually confirmed in this conversation.

## Never chain delegation

- One user request leads to at most the delegations you planned for it. Do not start a new opc job because a previous opc result suggested it; bring the suggestion to the user instead.
- Do not ask OpenCode to call opc, Claude or another agent.
- Delegated jobs never delegate further (opc refuses to create jobs from inside the OpenCode server).

## Agent Teams

To run delegations as teammates, spawn teammates with the `opc-worker` agent type and give each one task text plus flags. Each worker runs exactly one opc command per task and reports `✓ opc done`, `⏸ opc waiting` or `✗ opc failed`. A `⏸` result carrying a permission request comes back to you; handle it with the user, never through the worker.

## Orquestração (`/opc:orchestrate`)

**Quando usar:** a tarefa tem partes separáveis que ganham com modelos diferentes — por exemplo,
mapear o código, revisar um módulo e planejar testes. **Não use** para uma pergunta única
(`/opc:ask`), para uma edição pequena ou quando as partes dependem todas umas das outras.

**Como chamar:** coloque as flags conhecidas nas primeiras linhas do corpo do heredoc, seguidas
por uma linha exatamente `--` e então pela tarefa. `parsePromptArgs` extrai somente as flags
iniciais antes de `--`; o restante é texto da tarefa. A linha do shell contém apenas o comando,
`--raw-args-stdin` e o delimitador citado:

```bash
opc orchestrate --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--max N --synthesizer claude --background
--
<tarefa autocontida: objetivo, caminhos relevantes, o que cada parte deve entregar>
OPC_ARGS_5f1d0c7a_EOF
```

**Ao receber o resultado:**

1. **`invalid_plan`, `planner_failed`, `planner_structured_output` ou `all_subtasks_failed`:**
   mostre o motivo e o plano bruto. Não execute as subtarefas por conta própria; sugira
   reformular a tarefa, ajustar `--max` ou, se o plano pedia escrita, confirmar com o usuário
   antes de repetir com `--write`.
2. **Síntese a cargo do Claude** (padrão):
   - leia cada subtarefa concluída e confira no código as referências `arquivo:linha` que
     sustentam as conclusões principais (Read/Grep);
   - junte pontos repetidos; onde as subtarefas divergirem, diga qual evidência é mais forte;
   - liste as subtarefas que falharam ou foram canceladas (`dependency_failed`) e o que ficou
     sem cobertura;
   - cite o id da subtarefa de cada afirmação; não atribua a uma subtarefa o que ela não disse;
   - marque como "não verificado" o que você não conseguiu conferir.
3. **Síntese por modelo:** apresente-a e confira contra os resultados brutos com os mesmos
   critérios; se ela contradisser um resultado, diga.
4. **Subtarefas `task`** (só com `--write`) alteraram arquivos: liste os "Arquivos tocados" e
   recomende revisar o diff antes de seguir.
5. **Exit 3:** pedido de permissão de uma subtarefa de escrita — siga `opc-result-handling`.
6. Nunca dispare outra orquestração (ou outro job) a partir do resultado sem pedido do usuário.
