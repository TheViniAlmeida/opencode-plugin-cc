---
description: Lista os commands ou as skills do OpenCode disponíveis neste workspace
argument-hint: 'commands|skills [--json]'
allowed-tools: Bash(opc:*)
---

Run:

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc catalog --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Output rules:
- Present the command output to the user verbatim.
- If no argument was given, the command fails with a usage error: ask the user whether they want `commands` or `skills`.
- A command marked `negado` pins a model or agent blocked by the policy; running it later (`/opc:command`) will be refused.
