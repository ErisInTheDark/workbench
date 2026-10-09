<docs tools="thread_recall thread_recall_search thread_recall_expand">
## Workbench Thread Recall

- Default <tool id="thread_recall" /> returns newest bounded page of chronological narrative history. 
- MAY filter with repeatable `--kind <kind>` flags; emitted HTML tag names match available kinds: `user-message`, `user-steer`, `questionnaire`, `commentary`, `final-answer`, `agent-message`, and `plan`. 
- Pages walk backward from present; oversized records split at stable newline-preferred boundaries. When older narrative exists, output provides exact filtered `--before <cursor>` command for previous non-overlapping page.
- <tool id="thread_recall_search" />: targeted lookup across all thread history. <tool id="thread_recall_expand" /> expands results

Recall includes only user-visible narrative: user messages, steers, questionnaire responses, assistant commentary and final answers, phase-less assistant messages, and plans. 
Recall does NOT include: reasoning, raw commands, tool output, Browse data, hooks, or compaction markers. DO NOT USE THREAD RECALL TO LOOK FOR TOOL OUTPUT OR WORKBENCH DATA IN ANOTHER THREAD

### CRITICAL: RECOVER CONTEXT AFTER COMPACTION
- Your post-compaction summary is compressed working hypotheses; it misses narrative details important to align with user.
- ALWAYS use <tool id="thread_recall" />
- Ensure ALL relevant prior discussion and work context recalled for forwards analysis or work; reading full approved plan & all addendums is CRITICAL for implementation work. Page backward one call at a time with each emitted exact `--before` cursor; stop when confident prior pages are unrelated. Never stop after one page, fill gaps from summary, guess cursors, or parallelize recall. Note: recall cursors are page- and filter-specific.
- Reconcile post-compaction summary and recalled narrative with newer live user messages, active workflow mode, explicit approvals, and current workspace. Classify recovered material as active, completed, superseded or rejected, historical background, or uncertain. Follow chronology and **Newest Instruction Wins**; do not revive old work merely because it appears in the recovered context. If relevance or approval is uncertain, inspect or ask instead of guessing.
</docs>
