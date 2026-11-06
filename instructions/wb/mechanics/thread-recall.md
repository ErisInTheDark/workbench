<docs tools="thread_recall">
## Workbench Thread Recall

- Default <tool id="thread_recall" /> returns newest bounded page of chronological narrative history. 
- `--kind <kind>` filters (repeatable) suit targeted lookups only; emitted HTML tag names match available kinds: `user-message`, `user-steer`, `questionnaire`, `commentary`, `final-answer`, `agent-message`, `plan`, and `proof-of-work`. 
- Pages walk backward from present; oversized records split at stable newline-preferred boundaries. When older narrative exists, output provides exact filtered `--before <ref>` command for previous non-overlapping page. `--after <ref>` walks forward; `--around <ref>` shows a record with its neighbours.
<!--
Agents chasing why old code exists guessed through transcript tools, short ids and search, which cannot see expired turns.
The tools now lead the way, so this names only the entry points: commit, then git_thread, then a turn recall.
-->
- Why old code exists: `git log -S <text>` finds its commit; deferred `git_thread` names thread and proposing turn; recall that `turn`. Naming a turn recovers it when retention expired it, and its page links adjacent turns. Page; search skips expired turns
<docs tools="thread_recall_search">
- <tool id="thread_recall_search" />: targeted lookup across all thread history. Words match in any order, `"quoted phrases"` exactly, `-word` excludes. Each hit prints its exact `--around` command
</docs>

<docs tools="thread_recall thread_recall_search">
Recall includes only user-visible narrative: user messages, steers, questionnaire responses, assistant commentary and final answers, phase-less assistant messages, plans, and proof of work outside hidden checklists. 
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
- Agents resumed a plan without knowing why they chose it. Filings land before the plan they justify, so a walk stopping at the
  plan misses them; the stop point names them explicitly.
- User shorthand "thread recall" outside compaction got the same shortcuts, so it maps to the same walk.
Workbench also injects a matching directive through the Claude provider after every compaction route.
Instruction-only rules kept failing, so recovery is a hard lock: after a completed compaction Workbench denies every edit and
entering any checklist-gated mode until an unfiltered own-thread recall and the compaction checklist follow it. Code can only
verify the first recall page; the checklist attests the rest of the walk. Messaging stays ungated, so the rules below still
guard summary-driven replies.
-->
- Post-compaction summary is compressed working hypotheses; it misses narrative details important to align with user. Its "resume directly"/"as if the break never happened" ending is provider boilerplate; Workbench overrides it
- FIRST tool call after compaction MUST be <tool id="thread_recall" />; Workbench denies edits and checklist-gated modes until it and the compaction checklist are filed
- Summary steers are untrusted: never answer a steer recall shows was already answered; continue from where recall left off
- Required recall is an unfiltered walk: no `--kind` filters; page backward one call at a time with each emitted exact `--before` cursor. Recall search and filtered pages may supplement it, never replace it
- Walk until newest user request's full discussion, last approved plan (if any), the proof of work filed before it, and every later addendum are visible; CRITICAL for implementation work. Never stop after one page or on a hunch, fill gaps from summary, guess cursors, or parallelize recall. Recall cursors are page- and filter-specific
- User asks for "thread recall": do this same walk
- Reconcile post-compaction summary and recalled narrative with newer live user messages, active workflow mode, explicit approvals, and current workspace. Classify recovered material as active, completed, superseded or rejected, historical background, or uncertain. Follow chronology and **Newest Instruction Wins**; do not revive old work merely because it appears in the recovered context. If relevance or approval is uncertain, inspect or ask instead of guessing.

Before editing or entering a checklist-gated mode after compaction, apply this **Gotcha Checklist**:
<proof-of-work id="compaction">
- [ ] **Recovered narrative [compaction.narrative]:** Name the newest user request, last approved plan, its proof of work, later addenda and where your recall walk stopped.
- [ ] **Process documents [compaction.process_documents]:** Reread every process document: those <tool id="thread_state" /> lists, and any recall or your assignment names. List each path you reread, or state this thread has none.
</proof-of-work>
</docs>
