---
description: Pergunta ou análise read-only feita pelo OpenCode, com referências file:line
argument-hint: '[--model <m>] [--agent <a>] [--variant|--effort <v>] [--tier <t>] [--resume [id]|--fresh] [--background] [--timeout <s>] [--wait-timeout <s>] <pergunta>'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Run exactly this with the Bash tool (use `timeout: 600000`). The user's arguments go through a quoted heredoc, so the shell expands nothing in them; do not edit, quote or escape them.

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc ask --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Then act on the exit code:

- `0`: return the stdout verbatim, keeping every `file:line` reference exactly as printed.
- `3`: a request is pending (read-only jobs reject permissions on their own, so this is rare). Follow the `opc-result-handling` skill.
- `6`: the wait timed out and the job keeps running. Show the output with the `/opc:status <id> --wait` line.
- `2`, `4`, `5`, `7`, `130`: show the error output as-is. Do not answer the question yourself instead.
