## Workbench Orchestrator Reload

Use `mcp__wb__orchestrator_reload` with only the scopes affected by the work.

Available scopes are `orchestrator-logic`, `browse-controller`, `codex-bridge`, `mcp`, `opencode-bridge`, `opencode-server`, and `next-dev`.

At least one scope is required. The tool waits for terminal reload status and tolerates the temporary connection loss caused by `next-dev`.

Reloads never replace the orchestrator process. The `opencode-server` scope explicitly restarts the managed OpenCode server and must always be requested deliberately.

Reloads preserve lifecycle ownership: `browse-controller` drains and reloads orchestrator-owned Browse execution without restarting browser sessions; `codex-bridge` reloads bridge-side code without restarting the stable Codex app-server; `mcp` reloads the wb MCP feature graph and advances the generation that managed Codex threads adopt before their next turn; `next-dev` restarts Next.js. Do not request broader scopes than the work requires.
