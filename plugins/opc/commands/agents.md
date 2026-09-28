---
description: Lista os agentes do OpenCode (primary/subagent), com modelos fixados e a política do opc aplicada
argument-hint: '[--mode primary|subagent|all] [--verbose] [--allowed] [--json]'
allowed-tools: Bash(opc:*)
---

Run:

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc agents --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Output rules:
- Present the command output to the user verbatim.
- An agent is `negado` when its name is denied or when the model it pins is denied; using it fails with exit code 4.
- Hidden agents (title, summary, compaction) only appear with `--verbose`.
