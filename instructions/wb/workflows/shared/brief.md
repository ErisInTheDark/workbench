In Brief mode:

- state what you think the approver wants
- summarize what inspection showed
- recommend a different route only when it better fits the approver's goal
<!-- Prevent path-only edit lists from hiding unexplained work in claimed files. -->
- present the approver a concrete plan, not only an outcome: for every claimed file, explain its exact planned changes in current-source terms, including changed and preserved behavior or structure. State settled choices, risks, tradeoffs, and validation. Path-only lists or summaries leaving any claimed file unexplained are not concrete plans
- if the plan adds or changes tests and project guidance does not provide an approved command that executes them, the brief must also propose adding a project-owned test command and durable validation instructions, and ask the approver for permission to add them; do not propose tests as validation while leaving them unexecutable
- include focused samples when they would make the plan meaningfully easier to approve: existing file excerpts around relevant insertions/deletions/replacements, proposed text for instruction or note changes, and usage examples for new APIs, systems, or workflows
- when multiple plausible implementation shapes exist, state the chosen shape and at least one rejected alternative enough that the approver can correct the route before work starts
- for non-trivial work, list the major existing behaviors and structures affected by the plan and mark each as changed, preserved, removed, or unknown. These can include UI surfaces, APIs, routes, data models, persistence, state and lifecycle boundaries, validation semantics, background processes, generated/source boundaries, and user workflows.
- if any major existing behavior or structure is unknown, if the implementation route is still ambiguous, or if the plan does not say whether it is preserved or changed, return to Inspect or Brief before asking for implementation approval.
- include any needed project hygiene
- if the approver distinguished two code shapes or architectures, restate that exact distinction before planning
- make every revised plan complete and recoverable on its own. Do not present an addendum that depends on an older plan remaining in context.
- do not edit files, except for requested plan-document iteration described above
- do not ask for approval or decisions until the plan is visible

Before presenting a plan that edits files:

<workspace:multi-root>
- For multi-root work, name every root/file in one logical plan. Ordinary operations resolve registered members; preserve explicit refs only for historical inspection/restoration. Propose one commit per root.
</workspace:multi-root>

- Name the exact files you intend to edit.
- Publish exact scope with <tool id="git_plan_claims" /> before approval. Review reported drift before briefing; prior inspection covers only changes already inspected. Stop if arc safety fails. Prose-only revisions need no publication.
- Do not include arc-ref details in the plan unless the approver asks or a file-state problem needs to be explained.
- If the exact edit set is still unknown, the plan must be for further inspection or diagnostics, not implementation.
- If the exact edit set is known but the implementation mechanics, ownership, or chosen route are still unknown, the plan must also be for further inspection or diagnostics instead of implementation approval.
