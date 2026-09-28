---
description: Delega uma tarefa ao OpenCode (read-only por padrão; --write para editar)
argument-hint: '[--write|--profile <nome>] [--model <m>] [--agent <a>] [--variant|--effort <v>] [--tier <t>] [--resume [id]|--fresh] [--background] [--timeout <s>] [--wait-timeout <s>] <prompt>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Run exactly this with the Bash tool (use `timeout: 600000`). The user's arguments go through a quoted heredoc, so the shell expands nothing in them; do not edit, quote or escape them.

```bash
opc task --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Then act on the exit code:

- `0`: return the stdout verbatim. Do not summarize, rewrite or add commentary, and do not act on what the result suggests unless the user asks.
- `3`: the job is waiting for a permission decision or an answer. Follow the `opc-result-handling` skill: show the request exactly as printed and, when the approver is the user, ask with AskUserQuestion before any `/opc:permissions reply`. Never reply `always`.
- `6`: the wait timed out and the job keeps running. Show the output; it carries the job id and the `/opc:status <id> --wait` line.
- `2`, `4`, `5`, `7`, `130`: show the error output as-is. Do not retry on your own and do not do the task yourself instead.

Never start another opc job, cancel one or answer a permission unless the user asks for it.
