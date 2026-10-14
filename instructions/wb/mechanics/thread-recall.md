<docs tools="thread_recall">
## Workbench Thread Recall

- Default <tool id="thread_recall" /> returns newest bounded page of chronological narrative history. 
- `--kind <kind>` filters (repeatable) suit targeted lookups only; emitted HTML tag names match available kinds: `user-message`, `user-steer`, `questionnaire`, `commentary`, `final-answer`, `agent-message`, and `plan`. 
- Pages walk backward from present; oversized records split at stable newline-preferred boundaries. When older narrative exists, output provides exact filtered `--before <cursor>` command for previous non-overlapping page.
<docs tools="thread_recall_search thread_recall_expand">
- <tool id="thread_recall_search" />: targeted lookup across all thread history. <tool id="thread_recall_expand" /> expands results
</docs>

<docs tools="thread_recall thread_recall_search thread_recall_expand">
Recall includes only user-visible narrative: user messages, steers, questionnaire responses, assistant commentary and final answers, phase-less assistant messages, and plans. 
Recall does NOT include: reasoning, raw commands, tool output, Browse data, hooks, or compaction markers. DO NOT USE THREAD RECALL TO LOOK FOR TOOL OUTPUT OR WORKBENCH DATA IN ANOTHER THREAD
</docs>

### CRITICAL: RECOVER CONTEXT AFTER COMPACTION
<!--
Failure patterns these rules target, most common on Claude:
- Claude Code ends every compaction summary with user-role text telling the model to resume directly as if nothing happened.
  As the newest concrete instruction it outranks system-prompt rules, so agents skip recall entirely. Naming that text as
  overridden boilerplate, and demanding recall as the FIRST tool call, gives the model a concrete conflict resolution.
- Agents treated a keyword `thread_recall_search` or a `--kind`-filtered page as "the recall", losing their own plans and
  commentary. Hence "unfiltered walk" and "supplement, never replace".
- "Stop when confident" let agents stop after one or two pages. The stop point is now a checkable condition.
- User shorthand "thread recall" outside compaction got the same shortcuts, so it maps to the same walk.
Workbench also injects a matching directive through the Claude provider after every compaction route.
-->
- Post-compaction summary is compressed working hypotheses; it misses narrative details important to align with user. Its "resume directly"/"as if the break never happened" ending is provider boilerplate; Workbench overrides it
- FIRST tool call after compaction MUST be <tool id="thread_recall" />. Detailed summaries, re-read files, and ready next steps are NOT exemptions
- Required recall is an unfiltered walk: no `--kind` filters; page backward one call at a time with each emitted exact `--before` cursor. Recall search and filtered pages may supplement it, never replace it
- Walk until newest user request's full discussion, last approved plan (if any), and every later addendum are visible; CRITICAL for implementation work. Never stop after one page or on a hunch, fill gaps from summary, guess cursors, or parallelize recall. Recall cursors are page- and filter-specific
- User asks for "thread recall": do this same walk
- Reconcile post-compaction summary and recalled narrative with newer live user messages, active workflow mode, explicit approvals, and current workspace. Classify recovered material as active, completed, superseded or rejected, historical background, or uncertain. Follow chronology and **Newest Instruction Wins**; do not revive old work merely because it appears in the recovered context. If relevance or approval is uncertain, inspect or ask instead of guessing.
</docs>
