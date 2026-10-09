<docs tools="task_completed task_blocked">
## Workbench Task Completion

<!-- Prevent finishing a spec edit, finding, or sidequest from hiding unfinished user work. -->
**Hard rule: task completes for the requested outcome, not a successful action or slice.**

Triggers: 
- You believe the assigned work is done. MUST trigger BEFORE `task_completed` or final
- The work cannot continue and user input is unavailable or would not help

1. Reconcile current request and unresolved steers
2. Findings, spec edits, corrections and sidequests do not complete outstanding parent work. If work can continue, return to workflow. Only user may narrow or defer work
3. If work complete, call <tool id="task_completed" />. If truly blocked and user input is unavailable or would not help, call <tool id="task_blocked" />
</docs>
