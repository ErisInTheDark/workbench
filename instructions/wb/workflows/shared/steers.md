## Steers And Recovery

Steer: any approver direction during active workflow; messages, questionnaire answers

### Classify steers against approval

Choose mode from remaining work and requested target, not current dirt.

- Treat exact approver instruction as approval for exact action
- Merge complete approver addendum into current approval; continue without reapproval
- Return to Inspect or Brief if agent must choose material change or direction unclear, conflicting, impossible, unsafe
- Material changes: architecture, ownership, lifecycle, behavior, dependencies, contracts, persistence, interaction, validation, mechanics
- Infer no hidden scope

### Approver stops implementation due to incorrectness or lacking approval

- End goal known: Inspect as needed, then Brief concrete plan covering dirt recovery
- End goal and recovery direction unknown: restore exact pre-Implement state through Git arc; preserve prior claimed dirt; remove claims added for stopped work; ask end goal

<docs tools="git_arc_propose">
### Commit before continuing an addendum

If user asks to commit completed work before Inspect addendum:

- Diff current arc
- Give short Review
- Create proposal
- Send single-option resume questionnaire
- Resume Inspect
</docs>

### Unexpected file edits

Treat unexpected edits as user or agent work. Path overlap alone does not affect plan.

Before editing after pause, approval, questionnaire, wait, compaction, or interruption:

- Keep mutation safety checks; inspect reported drift, not every previously touched file by default
- If approval boundary unchanged, preserve edits; continue
- If edits affect approval boundary, return to Brief
- Never revert unexpected edits without exact user request

### Resume after compaction or delay

Restore current request, approval boundary, and file state before risky work.

On follow-ups, call <tool id="git_arc_status" /> before rereading prior work. Retained claims: reuse known context. Lost claims: inspect the reported changes and reread affected files only when needed or the baseline is unavailable. Status does not replace approval recovery or mutation safety checks.

- After other resume or delay, verify newest request
- If exact approval boundary known, keep approval; stale or missing arc ref alone does not invalidate it
- If approval boundary missing or ambiguous, return to Brief
- Use registered lifecycle defaults rather than copied refs
- Require explicit approval for degraded arc safety

### Report rollbacks

After rollback, state:

- what was undone
- what remains changed
- what was pre-existing or user-owned
- what comes next

Keep states distinct.

### Handle temporary exits

Handle clear bounded direct request; resume interrupted workflow. Ask only if target unknown.
