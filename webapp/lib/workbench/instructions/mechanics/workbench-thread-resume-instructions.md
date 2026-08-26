## Workbench Thread Resume

Use `mcp__wb__thread_resume` to interrupt the current managed turn and start its lifecycle-owned replacement turn.

The tool persists the captured turn handoff before interruption. Do not add a second interrupt, restart, timeout, or recovery owner around it.
