## Workbench Thread Recall

After context compaction, run this Workbench CLI command before continuing:

`wb thread recall`

Current-thread recall commands use the managed caller identity. Add `--thread <id>` only when you intentionally target a different thread.

The default command returns the newest bounded page of chronological narrative history. Filter it with repeatable `--kind <kind>` flags; the emitted HTML tag names are the exact available kinds: `user-message`, `user-steer`, `questionnaire`, `commentary`, `final-answer`, `agent-message`, and `plan`. Pages walk backward from the end, and oversized records are split at stable newline-preferred boundaries. When older evidence exists, the output provides the exact filtered `--before <cursor>` command for the previous non-overlapping page. Historical pages intentionally omit newer evidence; never infer the current objective or approval state from a historical page alone.

For targeted lookup across the complete visible narrative transcript:

`wb thread recall search --query "<text>" [--kind <kind>...] [--limit <count>] [--before <ref>]`

Search results are newest-first pages with stable refs and an exact older-results command. Read the complete content of one result through fixed-budget pages with:

`wb thread recall expand --ref <ref> [--cursor <cursor>]`

Recall includes user messages, steers, questionnaire responses, assistant commentary and final answers, phase-less assistant messages, and plans. When a selected assistant message already contains an embedded plan, the derived plan record is suppressed rather than emitted twice. Recall does not include reasoning, raw commands, tool output, Browse data, hooks, or compaction markers. `wb thread context` remains a temporary compatibility alias, but use `wb thread recall` going forward.

Run only one Thread Recall command at a time. History, search, and expansion cursors are relative to the exact page and filters that emitted them; do not launch recall calls in parallel or guess follow-up cursors. Read the current result, then run the exact continuation command it provides.

The returned Markdown is chronological source evidence, not a current-task specification. Treat the post-compaction summary as a compressed working hypothesis, then reconcile both sources with newer live user messages, the active workflow mode, explicit approvals, and the current workspace.

Before speaking or acting, privately form a concise current working set: the current objective, newest constraints, active mode, approval boundary, completed and remaining work, and relevant files. Classify recovered material as active, completed, superseded or rejected, historical background, or uncertain. Follow chronology and **Newest Instruction Wins**; do not revive old work merely because it appears in the recovered context. If relevance or approval is uncertain, inspect or ask instead of guessing.

The base history command is required after compaction; search and paginated expansion may also be used when targeted historical recall would help. These commands do not replace approval, relevant-file inspection, or arc-ref checks.
