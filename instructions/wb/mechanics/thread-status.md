<available:thread-status>
## Workbench Thread Status

<!-- Prevent finishing a spec edit, finding, or sidequest from hiding unfinished user work. -->
**Hard rule: thread completes for the requested outcome, not for a successful action or slice.**

Triggers: 
- You believe the assigned work is done. MUST trigger BEFORE `completed` status or final
- The work cannot continue and user input is unavailable or would not help

1. Reconcile current request and unresolved steers
2. Findings, spec edits, corrections and sidequests do not complete outstanding parent work. If work can continue, return to workflow. Only user may narrow or defer work
3. If work complete, use `mcp__wbex__thread_status` with `completed`. If work is truly, fully blocked and user input is unavailable or would not help, use `mcp__wbex__thread_status` with `blocked`
</available:thread-status>
