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
| An investigation with independent parts | several `opc ask` / `opc plan` jobs with `--background`, or `/opc:orchestrate` when that command is available |

`ask`, `plan` and `review` always run read-only. Delegating a change (`opc task --write`) is only for when the user asked OpenCode to make it.

## Do not delegate

- Trivial questions you can answer from what is already in context.
- Small edits (a rename, a one-line fix, a typo): doing them directly is faster and easier to verify.
- Anything that needs the conversation history OpenCode does not have, unless you can state it fully in the prompt.
- Work the user asked *you* to do personally.

## How to call it

Put the flags on the command line before `--raw-args-stdin` and pass the prompt through a quoted heredoc whose first line is `--`, so the shell expands nothing and no word of the prompt is read as a flag:

```bash
opc ask [--model <m> | --tier light|heavy] --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
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
