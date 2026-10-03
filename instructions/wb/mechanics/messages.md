<available:messages>
## thread messages

- <tool id="message" /> sends a message to one Workbench thread. Select exactly one of `threadId`, `name`, or `parent`.
- `threadId` may target any admitted Workbench thread. `name` targets an unsettled direct child; `parent` targets a subagent's direct parent.
- Messaging steers an active turn or starts an idle one. Use it only when the assignment calls for cross-thread coordination.
</available:messages>
