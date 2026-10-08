### attach: catálogo, providers V2 e linha de retomada

```json
{
  "providerShape": {
    "providersKey": [
      "providers"
    ],
    "disabledValue": null,
    "catalogHasProbe": false,
    "catalogHasGhost": false,
    "catalogHasDisabled": false
  },
  "attachCatalog": {
    "exit": 0,
    "ms": 2254,
    "warnsGhost": true,
    "hasProbe": true,
    "stderr": "[opc] aviso: Providers declarados ainda sem modelos no catálogo: ghost-gw, disabled-gw. Confira credenciais e o gateway, ou se estão desligados por disabled_providers/enabled_providers (o GET /api/config do OpenCode V2 não expõe essas listas).\n"
  },
  "attachResume": {
    "transferExit": 0,
    "sessionID": "ses_ee465690effeBibVmCvNVO3W4Z",
    "usesEnvReference": true,
    "leaksPassword": false,
    "tuiShowsTitle": true,
    "tuiAuthError": false,
    "ptyEnd": "SIGKILL",
    "transferStderr": ""
  }
}
```

#### TUI (attach): linha visível com o título

```text
[>0qP+q4d73\ ┃ ┃ Code word F8-1791464478310. OPC: transfer: resume F8- ┃ 1791464478310 Build · probe-gw/probe/a · 1.0s ┃ ┃ ┃ ┃ ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

### gerenciado: linha de retomada

```json
{
  "transferExit": 0,
  "usesSecretFile": true,
  "leaksPassword": false,
  "tuiShowsTitle": true,
  "tuiAuthError": false,
  "ptyEnd": "SIGKILL",
  "transferStderr": ""
}
```

#### TUI (gerenciado): linha visível com o título

```text
[>0qP+q4d73\ OPC: transfer: resume F8M-179 + ┃ ┃ Code word F8M-1791464492693. OPC: transfer: resume F8M- ┃ 1791464492693 Build · probe-gw/probe/a · 1.0s ┃ ┃ ┃ ┃ ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

### precedência e permissões (com inferência)

```json
{
  "P1-bare-session-model": {
    "createStatus": 200,
    "promptStatus": 200,
    "idle": true,
    "documents": 3,
    "globalDeclaresModel": true,
    "globalIsProjectOrEnv": "other",
    "answeredBy": [
      "env"
    ],
    "sessionModel": "other",
    "assistantKeys": [
      "agent",
      "content",
      "error",
      "finish",
      "id",
      "model",
      "time",
      "type"
    ],
    "verdict": "env-wins"
  },
  "item3-patch-permissions": {
    "rulesAfter": [
      {
        "action": "glob",
        "resource": "*",
        "effect": "allow"
      }
    ],
    "verdict": "replaces"
  },
  "item1-session-rules": {
    "idle": true,
    "leakedFileContent": false,
    "toolStates": [],
    "messageTypes": [
      "user",
      "assistant",
      "idle"
    ],
    "verdict": "session-rules-win (file not read)"
  }
}
```

### Claude Code headless (`claude -p --plugin-dir`)

```json
{
  "claudeHeadless": {
    "claudeExit": 0,
    "mcpTool": "opc_models",
    "isError": false,
    "listsProbeModel": true,
    "permissionDenials": 0,
    "hooks": { "sessionStart": "reaper.log start", "sessionEnd": "sessions.log end" },
    "mcpServerParent": "claude -p",
    "hookParentBeforeFix": { "pidComm": "sh", "aliveAfterHook": false },
    "hookOwnerAfterFix": { "pidComm": "claude", "alive": true, "sameAsMcpParent": true }
  }
}
```

