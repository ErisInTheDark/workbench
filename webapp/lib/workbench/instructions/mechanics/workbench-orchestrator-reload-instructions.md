## Workbench Orchestrator Reload

Use `mcp__wb__orchestrator_reload` with only the scopes affected by the work. Group scopes under the same namespace via `server:core+browse+mcp`. At least one scope is required. 

To keep reloads safe, it waits for other active intersecting Git arcs. Do not retry or bypass a waiting reload.
