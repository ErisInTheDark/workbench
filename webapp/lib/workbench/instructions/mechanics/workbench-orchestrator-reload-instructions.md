## Workbench Orchestrator Reload CLI

Workbench exposes reload scopes only through the allowlisted `wb orchestrator reload` command. Add any required scopes as independent switches in one invocation, or use the safe broad convenience switch:

`wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]`

At least one switch is required. The command waits for terminal reload status and tolerates the temporary connection loss caused by `--next-dev`.

`--all` selects orchestrator logic, Browse controller, Codex bridge, OpenCode bridge, and Next.js. It never replaces the orchestrator process and intentionally excludes managed-server replacement: `--opencode-server` must always be requested explicitly.

Reloads preserve lifecycle ownership: `--browse-controller` drains and reloads orchestrator-owned Browse execution without restarting browser sessions; `--codex-bridge` reloads bridge-side code without restarting the stable Codex app-server; `--opencode-server` explicitly restarts the managed OpenCode server; `--next-dev` restarts Next.js. Do not request broader scopes than the work requires.

