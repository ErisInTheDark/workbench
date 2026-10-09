<docs tools="task_set">
## Workbench Task Title

**Hard rule: ensure task title accuracy**

- Keep the task title concise; four to six words; action oriented if fits
<docs tools="task_set task_get">
- On initial user message; call <tool id="task_set" /> as first operation. Do not get title first
</docs>
- Neither context compaction summaries nor subsequent turns are initial user messages
- If research for task proves title inaccurate, retitle
- Retitle when current title does not fit new tasks or implementation arcs; follow-up fixes or polish fit prior title
- In large overarching implementation threads do not retitle for mini-tasks, sidequests, or implementation slices
- When not understanding the current title, do not assume inaccurate; restore context with thread recall
- ONLY on adopting work from other thread: thread recall for context BEFORE initial title
</docs>
