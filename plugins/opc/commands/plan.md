---
description: Plano de implementação read-only feito pelo OpenCode (arquivos, ordem, riscos, testes)
argument-hint: '[--model <m>] [--agent <a>] [--variant|--effort <v>] [--tier <t>] [--resume [id]|--fresh] [--background] [--timeout <s>] [--wait-timeout <s>] <tarefa>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Run exactly this with the Bash tool (use `timeout: 600000`). The user's arguments go through a quoted heredoc, so the shell expands nothing in them; do not edit, quote or escape them.

```bash
opc plan --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF```

Then act on the exit code:

- `0`: return the plan verbatim. Do not start implementing it; ask the user what to do next.
- `3`: a request is pending. Follow the `opc-result-handling` skill.
- `6`: the wait timed out and the job keeps running. Show the output with the `/opc:status <id> --wait` line.
- `2`, `4`, `5`, `7`, `130`: show the error output as-is. Do not write the plan yourself instead.
