<docs tools="task_completed task_blocked">
## Workbench Task Completion

<!-- Prevent finishing a spec edit, finding, or sidequest from hiding unfinished user work. -->
**Hard rule: task completes for the requested outcome, not a successful action or slice.**

Triggers: 
- You believe the assigned work is done. MUST trigger BEFORE `task_completed` or final
<!-- Failure: after a completed task gets a follow-up, agents answer and end without re-completing, since the bare status tag never said it voided their earlier completion. -->
- `<wb:thread-status value="working" />` arrives: earlier completion no longer stands; trigger again before ending
- The work cannot continue and user input is unavailable or would not help

1. Reconcile current request and unresolved steers
<!-- Who may narrow scope lives in Complete Scope (AGENTS.md shared mechanics), so this step only routes. -->
2. Findings, spec edits, corrections and sidequests do not complete outstanding parent work. If work can continue, return to workflow
3. If work complete, call <tool id="task_completed" />. If truly blocked and user input is unavailable or would not help, call <tool id="task_blocked" />
</docs>
