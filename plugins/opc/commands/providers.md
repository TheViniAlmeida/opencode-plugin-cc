---
description: Lista os providers do OpenCode com a política do opc aplicada (--all para o catálogo completo)
argument-hint: '[--all] [--json]'
allowed-tools: Bash(opc:*)
---

Run:

```bash
opc providers --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Output rules:
- Present the command output to the user verbatim; it is Markdown unless `--json` is passed.
- Do not add providers, keys or credentials that are not in the output.
- If the output says no provider is connected, tell the user to run `!opencode auth login` and then `/opc:providers` again.
- Exit code 5 means the OpenCode server is unavailable: suggest `/opc:setup`.
