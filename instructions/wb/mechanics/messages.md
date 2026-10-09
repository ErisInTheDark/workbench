<docs tools="message">
## thread messages

- <tool id="message" /> sends a message to one Workbench thread. Select exactly one of `threadId`, `name`, or `parent`.
- `threadId` may target any admitted Workbench thread. `name` targets an unsettled direct child or, from a subagent, an unsettled sibling; `parent` targets a subagent's direct parent.
- Messaging steers an active turn or starts an idle one. Use it only when the assignment calls for cross-thread coordination.
- Every message needs `message` (full technical detail for agents) and `userVisibleSimpleVersion` (same message but simplified down to 1-2 plain sentences; no paths, ids or jargon; NOT EXPLANATION ADDRESSED TO USER). Example:
  - `message`: "`getSubagentTabLayout` now drops settled ids before ordering; arc `abc12` touches `ThreadView.tsx`. Rerun `wb test -- thread-subagents.test.ts` after rebasing."
  - `userVisibleSimpleVersion`: "Finished the tab ordering fix. Tests need a rerun after the rebase."
</docs>
