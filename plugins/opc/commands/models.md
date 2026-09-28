---
description: Lista os modelos do OpenCode (variants, limites, custo) com a política do opc aplicada
argument-hint: '[provider] [--verbose] [--allowed] [--all] [--json]'
allowed-tools: Bash(opc:*)
---

Run:

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc models --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Output rules:
- Present the command output to the user verbatim.
- Model IDs are `provider/model` and the model part may contain more slashes (for example `omniroute-personal/opencode-go/kimi-k3`); never shorten or rewrite them.
- A model marked `negado` is blocked by the opc policy: using it fails with exit code 4. Do not suggest it as an alternative.
- Exit code 2 with `UNKNOWN_PROVIDER`: show the message (it lists the known providers).
