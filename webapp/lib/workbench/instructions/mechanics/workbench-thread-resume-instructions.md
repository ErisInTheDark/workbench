## Workbench Thread Resume

<!-- Prevent task continuation from forcing a new turn. -->
Use `mcp__wbex__thread_resume` only when the user says a forced new turn should supply new instructions or MCP tools.

It persists the handoff and owns interruption and replacement. Add no second interrupt, restart, timeout, or recovery owner.
