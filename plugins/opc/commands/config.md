---
description: Lê e altera a config do opc (get, set, unset, add, remove, show, validate, path)
argument-hint: 'get [chave] | set <chave> <valor> [--workspace] | unset <chave> | add|remove <chave-lista> <valor> | show [--effective] | validate | path'
allowed-tools: Bash(opc:*)
disable-model-invocation: true
---

Run:

If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` (or `OPC_JSON_5f1d0c7a_EOF` where used), do not run anything; tell the user the arguments contain the reserved delimiter.

```bash
opc config --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Output rules:
- Present the command output to the user verbatim.
- Exit code 4 with `LOCKED_KEY`: the key is a locked policy key (`policy.*`, `permissionProfiles`, `server.configOverride`). Explain that it can only be changed in the user's own terminal and show the exact command printed in the message (it ends with `--tty-confirm`), or `opc config init` for the full wizard. Never retry the command yourself and never add `--tty-confirm`.
- Exit code 4 with `POLICY_DENIED`: the value is denied by the current policy; show the rule from the message.
- Exit code 2 with `AMBIGUOUS_MODEL`: show both candidates from the message and ask which one the user wants; prefix the full ID with `=` (for example `=opencode/big-pickle`) to force the full reading.
- `init` needs an interactive terminal: tell the user to run `opc config init` in their terminal (the alias line is printed by `/opc:setup`).
- Never edit `config.json` or `.opc.json` by hand.
