---
description: Diagnostica o OpenCode, oferece a instalação e conduz o onboarding guiado do opc (provider, modelos, política, projeto)
argument-hint: '[--reconfigure] [--stop-server [--force]]'
allowed-tools: Bash(opc:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
opc setup --json --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Read the JSON. The diagnostic fields come from the server check; the `onboarding` object drives everything below. Follow the first branch that applies.

## A. Stop server (`--stop-server` in the arguments)

- Without `--force`: present the output. If it refuses because of active jobs, show the list and stop.
- With `--force`: before anything else, use `AskUserQuestion` once: "Encerrar o servidor do OpenCode mesmo com jobs ativos? Os jobs serão interrompidos." Options: `Encerrar agora`, `Cancelar`. Only on `Encerrar agora` run:

```bash
opc setup --stop-server --force --confirmed-by-user --json
```

## B. OpenCode not installed (`onboarding.opencodeInstalled` is false)

- If `onboarding.npmAvailable` is true, use `AskUserQuestion` exactly once: "O OpenCode não está instalado. Instalar agora com `npm install -g opencode-ai`?" Options, in this order: `Instalar o OpenCode (Recomendado)`, `Agora não`.
- On install, run the command below and then rerun the first command of this file:

```bash
npm install -g opencode-ai
```

- If the user skips or npm is not available, present the setup output, explain how to install OpenCode (<https://opencode.ai>) and stop.

## C. No connected provider (`onboarding.connectedProviders` is empty and `onboarding.serverError` is null)

Tell the user to run `!opencode auth login` and then `/opc:setup` again. Stop.

If `onboarding.serverError` is set, present it with the diagnostic output and stop.

## D. Nothing to do (`onboarding.needed` is false and `onboarding.draft.exists` is false)

Present the diagnostic output (including the terminal alias line), then run `opc config show --effective` and show a short summary: default provider, default model, review model, allowed models/agents. Mention `/opc:setup --reconfigure` to change it. Stop.

## E. Onboarding

1. If `onboarding.draft.exists` is true, use `AskUserQuestion`: "Existe um onboarding pela metade (próxima etapa: `<nextStep>`). Retomar?" Options: `Retomar (Recomendado)`, `Recomeçar do zero`. On `Recomeçar do zero`, run `opc setup discard --json` and then rerun the first command of this file.
2. Start at `onboarding.nextStep`. Ask **one** `AskUserQuestion` per step, build the JSON payload described below and apply it:

```bash
opc setup apply --json --stdin <<'OPC_JSON_5f1d0c7a_EOF'
{"defaultProvider":"<id>"}
OPC_JSON_5f1d0c7a_EOF
```

   The result carries the next `nextStep`. Continue until `nextStep` is `null`. Text typed by the user goes **only** inside the heredoc, never on the command line.
3. Steps (`AskUserQuestion` always offers "Other" for free text; use it as the "Outro" option):

| Step | Question (PT-BR) | Options | Payload |
|---|---|---|---|
| `scope` | "Onde gravar a config?" | `Global — todas as pastas (Recomendado)`, `Só este workspace (.opc.json)` | `{"scope":"global"}` or `{"scope":"workspace"}` |
| `defaultProvider` | "Qual provider padrão?" | `onboarding.providerChoices` (label `<id> (<modelCount> modelos)`, from `connectedProviders`) | `{"defaultProvider":"<id>"}` |
| `defaultModel` | "Qual modelo padrão?" | the 3 `suggestions` of `opc setup models` (below); label = model ID, description = name + variants | `{"defaultModel":"<full id>"}` |
| `reviewModels` | "Modelo do review?" then "Modelo do stop gate?" (two separate calls) | `Mesmo do padrão (Recomendado)`, the `aliases.strong` suggestion, one more suggestion | `{"reviewModel":<id or null>,"stopGate":{"model":<id or null>}}` |
| `defaultVariant` | "Variant padrão?" | `Nenhuma (Recomendado)` + up to 3 variants of the chosen model (skip the question and send `null` when the model has none) | `{"defaultVariant":<name or null>}` |
| `allowedModels` | "Quais modelos o opc pode usar?" | `Todos do provider padrão (<provider>/*)`, `Só <families[0].glob>`, `Sem restrição` | `{"policy":{"models":{"allow":[...]}}}`; in "Other", comma-separated globs, and entries starting with `!` go to `deny` |
| `allowedAgents` | "Quais agentes do OpenCode o opc pode usar?" | `Todos`, `Só os built-in (build, plan, general, explore)` | `{"policy":{"agents":{"allow":[...]}}}`; "Other" as above (`!work-*` → `deny`) |
| `approver` | "Quem aprova os pedidos de permissão do OpenCode?" | `Eu aprovo (Recomendado)`, `O Claude aprova (destrutivos e caminhos sensíveis continuam comigo)` | `{"policy":{"approver":"user"}}` or `"claude"` |
| `behaviour` | "Ligar o stop gate (review antes de encerrar)?" then "Ligar a delegação automática?" | `Não (Recomendado)`, `Sim` | `{"stopGate":{"enabled":<bool>},"delegation":{"auto":<bool>}}` |
| `project` | "Objetivo do projeto?", then (multiSelect) "Quais diretórios fazem parte do escopo?", then (multiSelect) "Quais tipos de tarefa você vai delegar?" | goal: a one-line goal you infer from the README, `Sem objetivo`; scope: up to 3 of `onboarding.projectDirs` + `Todos`; task types: `ask`, `plan`, `review`, `task` | `{"project":{"goal":<text or null>,"scope":[...],"taskTypes":[...]}}` |
| `aliases` | (multiSelect) "Criar os aliases sugeridos?" | `fast → <aliases.fast>`, `strong → <aliases.strong>` (only the non-null ones) | `{"aliases":{"fast":"<id>","strong":"<id>"}}` (only the selected ones; `{}` when none) |

4. Model suggestions for `defaultModel` and `reviewModels`:

```bash
opc setup models --json --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--provider <defaultProvider> --top 3
OPC_ARGS_5f1d0c7a_EOF
```

   When the user types a name or glob in "Other", search it and confirm the match with one more `AskUserQuestion` (up to 4 matches as options):

```bash
opc setup models --json --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
--provider <defaultProvider> --query <typed text>
OPC_ARGS_5f1d0c7a_EOF
```

5. Errors while applying: exit code 2 (invalid, unknown or ambiguous model, invalid variant) → show the message and ask the same step again. Exit code 4 with `POLICY_DENIED` → explain the rule and ask again. Exit code 4 with `LOCKED_KEY` (reconfigure) → show the terminal command from the message and move on to the next step.
6. When `nextStep` is `null`, commit:

```bash
opc setup commit --json
```

   On success run `opc config show --effective` and present a short summary. On exit code 2 or 4, show the message, re-apply the offending step (the message names the key) and commit again. If the user stops in the middle, only the draft remains; `/opc:setup` resumes it.

## Reconfigure and locked keys

With `--reconfigure`, the locked keys (`policy.*`, `permissionProfiles`, `server.configOverride`) are skipped. If the user wants to change them, tell them to run, in their own terminal (alias from the diagnostic output), `opc config init` or `opc config set <key> <value> --tty-confirm`. Never pass `--tty-confirm` yourself and never edit the config files by hand.

## Output rules

- Present the final setup output, including the terminal alias line.
- If OpenCode is installed but no provider is connected, preserve the guidance to run `!opencode auth login`.
