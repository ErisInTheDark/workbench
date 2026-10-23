<docs tools="subagent_create subagent_list subagent_profiles subagent_stop subagent_settle subagent_wait">
## Subagents

Subagents require **Feature Activation**. 

<!-- MCP-only agents cannot `cd` before a call, so a cwd-only rule was impossible for them to follow; `workdir` is their equivalent of the CLI cwd. -->
A subagent's directory is its creating call's cwd, or `workdir` when given; target the intended project directory.

### managing subagents

<docs tools="subagent_list">
- <tool id="subagent_list" /> lists unsettled direct children. Set `settled: true` for settled history and use its cursor and limit fields for pagination.
</docs>
<docs tools="subagent_profiles">
- <tool id="subagent_profiles" /> lists profiles available to this thread. Use a profile ID only as the machine value. Tell the user the profile's display name.
</docs>
<docs tools="subagent_create">
- <tool id="subagent_create" /> creates and starts a direct child. Supply `profileId`, a unique person-like `name`, task `title`, self-contained `message`, and `userVisibleSimpleVersion`: one or two plain sentences summarising the task for the user without technical detail.
</docs>
<docs tools="subagent_stop">
- <tool id="subagent_stop" /> stops selected direct children.
</docs>
<docs tools="subagent_settle">
- <tool id="subagent_settle" /> settles completed or stopped direct children and releases their names. `handover: true` first adopts each child's claims and stash and moves its todos to you; children it cannot fully hand over stay unsettled and untouched.
</docs>

<docs tools="subagent_create">
Let the active agent identity influence child names. Do not use task slugs, role labels, operation codenames, or version suffixes for names. The title owns the task description.
</docs>

<docs tools="subagent_wait">
### waiting

<tool id="subagent_wait" /> accepts any number of `names` and `threadIds` and returns when the first selected child needs attention, completes, or stops.

Pass every active child in one wait call. Treat it as a Workbench Long Wait. Do not use separate concurrent waits.

DO NOT USE <tool id="message_wait" /> TO WAIT FOR SUBAGENTS; IT MISSES SUBAGENT EVENTS.
</docs>

### notes

<docs tools="subagent_create">
- Subagents are isolated and do not inherit parent or sibling context. Give each child a self-contained message, including sibling names it may message.
- Without explicit instruction, child commentary is not visible to the parent.
- The returned subagent ID is its thread ID and can be used with Thread Recall.
</docs>
- A thread may operate only on direct children it owns. Sideways (except sibling messages) and grandchild access fails closed.
- Do not blindly trust subagent output. The parent owns verification and scope control.
- When orchestrating reviews, prevent infinite review loops and scope creep. The parent owns the acceptance threshold.
</docs>

<docs tools="subagent_queue subagent_dequeue">
## subagent queues

Use queues instead of messages to order contended work.

- A parent declares or inspects a queue with <tool id="subagent_queue" />. A child joins or resumes with its assigned description.
- `after` and `before` place the caller. Only a parent may move another named member.
- <tool id="subagent_dequeue" /> releases the caller's hold. Only a parent may remove another named member.
- Holds last until dequeue. Queue work pauses if its holder becomes inactive.
- Queues order agents, not processes.
</docs>
