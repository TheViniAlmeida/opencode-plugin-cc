# opc — OpenCode inside Claude Code

Portuguese: [README.md](README.md)

A Claude Code plugin that uses [OpenCode](https://opencode.ai) as an executor: Claude delegates
analyses, reviews and tasks to OpenCode models, through a per-workspace managed server and
permissions enforced by the plugin.

> Documentation language: this README is the English entry point. The detailed documentation under
> [docs/](docs/) (installation, commands, configuration, permissions, troubleshooting, architecture and
> phase reports) is written in Brazilian Portuguese (PT-BR) and is linked below.

## Status

**F7 merged — OpenCode V2 (>= 2.0.22) only.** The F6 migration and the F7 hardening (catalog, sessions, fork,
summarize, transfer, pagination) are integrated. Discovery, onboarding, turns, reviews, sessions, delegation,
jobs, orchestration, conclave, the MCP server and transfer are available.

- Validated live (Linux, OpenCode 2.0.22): session operations (new, show, fork, revert/unrevert, diff, summarize,
  children), the transfer import, and the automated test suite. See [docs/phases/F7-report.md](docs/phases/F7-report.md)
  for each item and its evidence.
- NOT VALIDATED: manual procedures in Claude Code and the TUI (plugin installation, `/mcp`, permissions,
  `/opc:attach`, `--pane`, resuming after a transfer), the catalog wait in attach mode, and macOS/Windows.

## Requirements

- Claude Code with plugin support.
- Node.js 20 or newer (`opc` checks the version on startup).
- OpenCode >= 2.0.22 (V2 only). If another `opencode` comes first in `PATH`, set `server.opencodeBin` in the
  global configuration or the `OPC_OPENCODE_BIN` environment variable to the V2 executable.
- At least one provider connected in OpenCode (`opencode auth login`).
- Linux is validated; macOS and Windows: portable code, not validated.

## Installation

Inside Claude Code:

```text
/plugin marketplace add <path-or-url-of-this-repository>
/plugin install opc@opencode-plugin-cc
/opc:setup
```

The marketplace is named `opencode-plugin-cc` and the plugin `opc`. `/opc:setup` checks Node and OpenCode,
resolves directories, starts or reuses the workspace `opencode serve` on a free `127.0.0.1` port protected by a
random password, and prints a terminal alias so that Claude and the terminal share the same data directory.
Details (PT-BR): [docs/installation.md](docs/installation.md).

Data directory resolution, with no fallback to `$TMPDIR`: `OPC_DATA_DIR`, then `CLAUDE_PLUGIN_DATA`, then the
plugin default under `~/.claude/plugins/data/` if it exists; otherwise `DATA_DIR_UNRESOLVED` (exit 2).

External server (attach mode): set `OPC_SERVER_URL` (`http://127.0.0.1`, `http://localhost` or `https://`) and
`OPC_SERVER_PASSWORD`. Any other HTTP address fails with `INSECURE_SERVER_URL`. In this mode opc does not start,
stop or override the external server.

## Quick start

1. Run `/opc:setup` and answer the onboarding: provider, default model, policy, project and aliases.
2. Check `/opc:models --allowed` and `/opc:agents` to see what opc may use.
3. For non-interactive changes use `/opc:config set ...`. Policy changes are made in the terminal with
   `opc config init`.
4. Make a change and run `/opc:review`.

## Commands

Every command exists in the terminal as `opc ...` and in Claude Code as `/opc:...`. `--json` returns the
structured view, and credentials are redacted from all output. Exit codes: 0 success, 2 invalid usage or value,
3 pending permission, 4 policy or locked key, 5 server or connection, 6 wait timeout (the job keeps running),
7 job failed, 130 cancelled.

| Command | Purpose |
| --- | --- |
| `/opc:setup` | Diagnostics, guided install and onboarding; `--reconfigure`, `--stop-server [--force]`, `--enable-review-gate` / `--disable-review-gate` |
| `/opc:config` | `get`, `set`, `unset`, `add`, `remove`, `show [--effective]`, `validate`, `path` |
| `/opc:providers`, `/opc:models`, `/opc:agents`, `/opc:catalog` | List providers, models, agents, and OpenCode commands or skills, with the opc policy applied |
| `/opc:review` | Review local changes (working tree or branch); `--wait` / `--background`, `--base`, `--scope`, `--model`, `--variant` |
| `/opc:adversarial-review` | Review that challenges the approach and design choices, with optional focus text |
| `/opc:rescue` | Delegates an investigation or fix to OpenCode, resuming or starting a session (`--resume`, `--fresh`) |
| `/opc:task`, `/opc:ask`, `/opc:plan` | Standalone write, question and plan turns; `task` is read-only unless `--write` or `--profile <name>` |
| `/opc:orchestrate` | Splits a task into parts run by several models and hands the results over for synthesis |
| `/opc:conclave` | Queries several models in parallel for opinion, debate or cross review (`--models`, `--pool`, `--mode`, `--rounds`, `--judge`, `--quorum`) |
| `/opc:status`, `/opc:result`, `/opc:cancel` | Follow, read and cancel jobs |
| `opc monitor` | Terminal view of the workspace jobs; read-only, never changes state |
| `/opc:sessions`, `/opc:session` | List and manage sessions: new, show, fork, revert/unrevert, summarize, children, diff |
| `/opc:subagent` | Runs agents or models in parallel as a job group |
| `/opc:command` | Runs an OpenCode slash command as its own job |
| `/opc:attach` | Shows how to open a session in the OpenCode TUI; `--pane` opens a tmux split; invoked by the user only |
| `/opc:permissions` | `list`, `reply <id> once\|reject`, `answer <id> ...` for OpenCode permission requests and questions |
| `/opc:transfer` | Converts the current Claude Code conversation into a resumable OpenCode session |

Every turn runs in a detached worker registered as a job. In the foreground the command follows the job; with
`--background` it returns the job ID, which `/opc:status`, `/opc:result` and `/opc:cancel` accept (unique
prefixes work). Full synopsis and examples (PT-BR): [docs/commands.md](docs/commands.md).

First review: `/opc:setup`, make a change, `/opc:review`.

Hooks: `SessionStart` and `SessionEnd` manage the server lifecycle; `Stop` runs the optional review gate.

## MCP server

The plugin registers an `opc` MCP server (stdio, no dependencies) that exposes 24 `opc_*` tools for discovery,
turns, subagents, orchestration, conclave, sessions, jobs and permissions. Claude calls the same dispatcher as
the `/opc:` commands, with the same policies and confirmations. Long jobs return their ID in the background.
Configuration is read-only through MCP; revert/unrevert, stopping the server, review and transfer remain user
commands. See the [catalog and result format](docs/architecture.md#servidor-mcp-f5) (PT-BR).

To carry the current conversation into OpenCode, run `/opc:transfer`, then resume in the terminal with
`opencode --server <url> -s <id>`, with the server password available through the environment. The resume
command printed by opc already names the password source. Real use inside Claude and interactive resume of the
transferred session are NOT VALIDATED (manual operator procedure; see [F7](docs/phases/F7-report.md)).

## Configuration

Two layers: a global `config.json` in the data directory (mode 0600) and a versionable `.opc.json` in the
workspace, which must not contain secrets. `opc config path` shows the locations in use. Keys such as
`policy.*`, `permissionProfiles` and `server.opencodeBin` are locked: a workspace can only restrict them, and
changing them requires confirmation in the terminal. Routing, fallback, conclave and orchestration have their own keys. The full
key table (PT-BR) is in [docs/configuration.md](docs/configuration.md).

## Safety and permissions model

- opc never changes the global OpenCode configuration. Each session it creates gets its own rule profile; the
  last matching rule wins, and session rules override agent and global ones.
- Profiles: `read-only` (default; used by `task` without `--write`, `ask` and `plan`), `write` (`--write`) and
  `custom:<name>` (`--profile <name>`, from `permissionProfiles`). No profile or flag allows everything.
- Invariants are applied last in every profile: `external_directory` is denied, sensitive paths (such as `.env`
  files, private keys and SSH directories) cannot be read, denied agents and tools stay denied, destructive shell
  commands always ask, and `browser` is denied.
- Destructive shell commands are analysed, including wrapped ones (`bash -c`, `eval`, `sudo`); anything that
  cannot be analysed safely goes to the user (fail-safe), which can produce benign false positives.
- In `read-only`, permission requests are rejected immediately. In `write` and `custom`, the job waits in
  `waiting_permission` (exit 3). By default the user approves (`policy.approver`); `once` and `reject` are the
  only replies, and `always` is refused.
- The `opc-worker` and `opc-rescue` agents never answer permissions.
- Servers are bound to `127.0.0.1` with a random password; credentials are redacted from output and must not be
  passed as arguments or stored in configuration.
- The stop review gate is optional and off by default; when on, it runs a read-only OpenCode turn on each stop and
  infrastructure failures allow the stop with a warning.

Details (PT-BR): [docs/permissions.md](docs/permissions.md).

## Troubleshooting

Common errors (`DATA_DIR_UNRESOLVED`, `V1_SERVER_ACTIVE`, `TIMEOUT` in attach mode, MCP and
transfer problems) are covered in [docs/troubleshooting.md](docs/troubleshooting.md) (PT-BR).

## Development

```sh
npm test
npm run scan-secrets
```

There are no runtime dependencies; do not run `npm install`.

## Documentation (PT-BR)

- [Installation](docs/installation.md)
- [Commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Permissions](docs/permissions.md)
- [Architecture](docs/architecture.md)
- [Swarm: routing, fallback, monitor and orchestration](docs/swarm.md)
- [Conclave](docs/conclave.md)
- [Troubleshooting](docs/troubleshooting.md)
- [F7 report and gate](docs/phases/F7-report.md)
- [CHANGELOG](CHANGELOG.md)

## License and credits

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Structure inspired by
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). The swarm capabilities are
inspired by [apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin), reimplemented without
copying code or text.
