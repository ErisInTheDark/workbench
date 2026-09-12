<available:task-title>
## Workbench Task Title

**Hard rule: ensure task title accuracy**

- Keep the task title concise; four to six words; action oriented if fits
- On initial user message; call `mcp__wb__task_set` as first operation. Do not get title first
- Neither context compaction summaries nor subsequent turns are initial user messages
- If research for task proves title inaccurate, retitle
- Retitle for new tasks or implementation arcs title does not fit
- In large overarching implementation threads do not retitle for mini-tasks, sidequests, or implementation slices
- When not understanding the current title, do not assume inaccurate; restore context with thread recall
</available:task-title>
