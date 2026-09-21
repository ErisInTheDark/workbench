<available:messages>
## thread messages

<harness:codex>
- `mcp__wbex__message` sends a message to one same-project thread. Select exactly one of `threadId`, `name`, or `parent`.
</harness:codex>
<harness:opencode>
- `tools.wb.message` sends a message to one same-project thread. Select exactly one of `threadId`, `name`, or `parent`.
</harness:opencode>
- `threadId` may target any admitted Workbench thread in the caller's cwd-derived project. `name` targets an unsettled direct child; `parent` targets a subagent's direct parent.
- Messaging steers an active turn or starts an idle one. Use it only when the assignment calls for cross-thread coordination.
</available:messages>
