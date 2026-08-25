## Workbench Orchestrator Reload

Use `mcp__wb__orchestrator_reload` with only the scopes affected by the work.

Use the scopes exposed by the live MCP tool schema. The active topology owns the scope catalog.

You can group scopes from one namespace. For example, use `server:core+browse+mcp`. Workbench expands groups to atomic scopes before reload state is created.

At least one scope is required. The tool waits for terminal reload status and tolerates the temporary connection loss caused by `client:all`. A safe reload can wait for other active Git arcs. Do not retry or bypass a waiting reload.

Reload scopes select concrete nodes. Workbench replaces every transitive dependant exactly once. For example, `server:core` also replaces MCP, provider bridges, and Browse execution. A direct bridge scope preserves its provider parent.

Reloads preserve lifecycle ownership. `server:browse` drains and reloads orchestrator-owned Browse execution without restarting browser sessions. `server:codex` reloads bridge-side code without restarting the Codex app-server. `server:opencode` reloads bridge-side code without restarting the OpenCode server. `server:mcp` replaces only the wb MCP node and advances the generation that managed Codex threads adopt before their next turn. `server:topology` replaces graph definitions and queue code while preserving live waiters. `client:all` restarts the client development server. Do not request broader scopes than the work requires.
