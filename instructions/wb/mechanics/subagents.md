<docs tools="subagent_create subagent_list subagent_profiles subagent_stop subagent_settle subagent_wait subagent_queue subagent_dequeue">
## Subagents

Subagents require **Feature Activation**. 

Every subagent call must run in the intended project cwd; this is the directory subagents will have access to.

<docs tools="subagent_list subagent_profiles subagent_create subagent_stop subagent_settle">
### managing subagents

- <tool id="subagent_list" /> lists unsettled direct children. Set `settled: true` for settled history and use its cursor and limit fields for pagination.
- <tool id="subagent_profiles" /> lists profiles available to this thread. Use a profile ID only as the machine value. Tell the user the profile's display name.
- <tool id="subagent_create" /> creates and starts a direct child. Supply `profileId`, a unique person-like `name`, task `title`, self-contained `message`, and `userVisibleSimpleVersion`: one or two plain sentences summarising the task for the user without technical detail.
- <tool id="subagent_stop" /> stops selected direct children.
- <tool id="subagent_settle" /> settles completed or stopped direct children and releases their names.

Let the active agent identity influence child names. Do not use task slugs, role labels, operation codenames, or version suffixes for names. The title owns the task description.
</docs>

<docs tools="subagent_wait">
### waiting

<tool id="subagent_wait" /> accepts any number of `names` and `threadIds` and returns when the first selected child needs attention, completes, or stops.

Pass every active child in one wait call. Treat it as a Workbench Long Wait. Do not use separate concurrent waits.

DO NOT USE <tool id="message_wait" /> TO WAIT FOR SUBAGENTS; IT MISSES SUBAGENT EVENTS.
</docs>

<docs tools="subagent_queue subagent_dequeue">
### queues

Use queues instead of messages to order contended work (builds, test suites, shared files).

- Declare with <tool id="subagent_queue" /> `{ queue }` (also shows status); give children the exact name and what work needs it. You may join too; children reference you as `parent`.
- Holds last until <tool id="subagent_dequeue" />. A holder's turn end, task completion or block pauses the queue; resolve by messaging the child or kicking with <tool id="subagent_dequeue" /> `{ queue, name }`. Your own inactivity freezes all your queues.
- Reorder with <tool id="subagent_queue" /> `{ queue, name, after | before }`.
- Queues order agents, not processes: never queue work a process lock already serializes.
</docs>

### notes

- Subagents are isolated and do not inherit parent or sibling context. Give each child a self-contained message, including sibling names it may message.
- Without explicit instruction, child commentary is not visible to the parent.
- The returned subagent ID is its thread ID and can be used with Thread Recall.
- A thread may operate only on direct children it owns. Sideways (except sibling messages) and grandchild access fails closed.
- Do not blindly trust subagent output. The parent owns verification and scope control.
- When orchestrating reviews, prevent infinite review loops and scope creep. The parent owns the acceptance threshold.
</docs>
