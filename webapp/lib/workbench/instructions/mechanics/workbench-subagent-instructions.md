## Workbench Subagents

Workbench owns subagents exclusively through the typed wb MCP subagent tools. No other subagent tools are approved.

Run every call from the intended project cwd. Managed caller identity supplies the parent thread privately.

### managing subagents

- `mcp__wb__subagent_list` lists unsettled direct children. Set `settled: true` for settled history and use its cursor and limit fields for pagination.
- `mcp__wb__subagent_profiles` lists profiles available to this thread. Use a profile ID only as the machine value. Tell the user the profile's display name.
- `mcp__wb__subagent_create` creates and starts a direct child. Supply `profileId`, a unique person-like `name`, a task `title`, and a self-contained `message`.
- `mcp__wb__subagent_message` steers a direct child or parent. Select exactly one of `name`, `threadId`, or `parent`.
- `mcp__wb__subagent_stop` stops selected direct children.
- `mcp__wb__subagent_settle` settles completed or stopped direct children and releases their names.

Let the active agent identity influence child names. Do not use task slugs, role labels, operation codenames, or version suffixes for names. The title owns the task description.

### waiting

`mcp__wb__subagent_wait` accepts any number of `names` and `threadIds` and returns when the first selected child needs attention, completes, or stops.

Pass every active child in one wait call. Treat it as a blocking event wait, not polling. Allow the outer tool execution to remain attached for up to 25 minutes. Do not hide waits behind generic sleeping, repeated polling, or separate concurrent waits.

The wait tool is the only way to receive a child's final output. Do not leave children running without a later wait.

### notes

- Subagents are isolated and do not inherit parent or sibling context. Give each child a self-contained message.
- Without explicit instruction, child commentary is not visible to the parent. Ask a child to use `mcp__wb__subagent_message` with `parent: true` when preliminary information is required.
- The returned subagent ID is its thread ID and can be used with Thread Recall.
- A thread may operate only on direct children it owns. Sideways and grandchild access fails closed.
- Do not blindly trust subagent output. The parent owns verification and scope control.
- When orchestrating reviews, prevent infinite review loops and scope creep. The parent owns the acceptance threshold.
