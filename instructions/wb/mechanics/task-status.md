<docs tools="thread_state">
## Workbench Task Completion

<!-- Prevent finishing a spec edit, finding, or sidequest from hiding unfinished user work. -->
**Hard rule: task completes for the requested outcome, not a successful action or slice.**

Triggers: 
- You believe the assigned work is done. MUST trigger BEFORE setting status completed or final
<!-- Failure: after a completed task gets a follow-up, agents answer and end without re-completing, since the bare status tag never said it voided their earlier completion. -->
- `<wb:thread-status value="working" />` arrives: earlier completion no longer stands; trigger again before ending
- The work cannot continue and user input is unavailable or would not help

1. Reconcile current request and unresolved steers
<!-- Who may narrow scope lives in Complete Scope (AGENTS.md shared mechanics), so this step only routes. -->
2. Findings, spec edits, corrections and sidequests do not complete outstanding parent work. If work can continue, return to workflow
<!-- Failure: a thread's asks arrived as an agent message; the agent filed them as optional todos, replied to the sender and re-completed, so the sidebar showed nothing needing the user. A brief ending in a questionnaire keeps the thread waiting on them. -->
3. Another thread's request for new work (not your parent's assignment) stays open until the user decides: run the workflow to a brief and ask. A todo, status note or reply to the sender never settles it
4. If work complete, set <tool id="thread_state" /> `status: "completed"`. If truly blocked and user input is unavailable or would not help, set `status: "blocked"`
</docs>
