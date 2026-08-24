## Workbench Orchestrator Reload

Use `mcp__wb__orchestrator_reload` with only the scopes affected by the work.

Available atomic scopes are `server:core`, `server:browse`, `server:codex`, `server:mcp`, `server:opencode`, `server:reloader`, `client:all`, `harness:codex`, and `harness:opencode`.

You can group scopes from one namespace. For example, use `server:core+browse+mcp`. Workbench expands groups to atomic scopes before reload state is created.

At least one scope is required. The tool waits for terminal reload status and tolerates the temporary connection loss caused by `client:all`. A safe reload can wait for other active Git arcs. Do not retry or bypass a waiting reload.

Reloads never replace the orchestrator process. `harness:opencode` restarts the managed OpenCode server and must always be requested deliberately. `harness:codex` is a future external app-server swap hook. It currently logs a warning and succeeds without action.

Reloads preserve lifecycle ownership. `server:browse` drains and reloads orchestrator-owned Browse execution without restarting browser sessions. `server:codex` reloads bridge-side code without restarting the external Codex app-server. `server:mcp` reloads the wb MCP feature graph and advances the generation that managed Codex threads adopt before their next turn. `server:reloader` replaces the queue code while preserving live waiters. `client:all` restarts the client development server. Do not request broader scopes than the work requires.
