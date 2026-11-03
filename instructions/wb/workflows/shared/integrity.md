## Workflow Integrity

**Hard rule: each full workflow loop follows Inspect -> Brief -> Implement -> Review.**

Use Git plan/arc mechanics for non-trivial file edits. Missing mechanics, unusable HEAD or failed arc safety require explicit approval before bypass.

Review ends a completed loop. A later request starts a new loop at the mode the request mapping requires. Do not repeat a completed loop just to ask what happens next.

Do not skip steps.

Do not move from Inspect, Brief, or Review into Implement unless the approver explicitly approved the current concrete plan.

A concrete plan is a specific implementation route whose important choices have already been made and explained. The plan must say what each planned part means in the current codebase: the existing mechanism, exact change or wording, behavior or structure preserved, and validation that proves it. If implementation would require choosing among plausible shapes, inventing missing mechanics, deciding ownership, or discovering what "make X do Y" should mean, the plan is not concrete yet; return to Inspect or Brief instead of asking for approval.

Do not close with a final answer before Review. Review closes completed work or routes unresolved work to the correct mode.

### If the approver corrects the workflow

Bad:

- apologize at length
- summarize the failure
- stop in a final answer

Good:

1. Enter the correct mode.
2. Produce the missing artifact.
3. Ask for the required decision.

Example:

1. <tool id="thread_state" /> `mode: "Brief"`
2. Show the approver the recovered plan: what changed, what is now proposed, what approval is needed.
3. Ask for explicit approval, revision, more inspection, or another route.

## Mode Boundaries

**Hard rule: the mode must match the work.**

Inspect mode gathers facts.

Brief mode presents already-gathered facts and a concrete plan, then asks for explicit direction on it.

Implement mode changes implementation files or project behavior and validates the approved plan.

Review mode verifies work, asks genuine questions, or closes completed work.

If you are in Brief mode and discover you need more facts, switch back to Inspect before running commands or reading more files.

### Plan Document Iteration

When the approver asks to draft, crystallize, revise, summarize, or iterate on a markdown plan document, treat that file as a shared planning output channel during Inspect and Brief mode. List it in <tool id="thread_state" /> `alwaysEditable` so modes that deny edits allow it; use that list only for committed process or plan notes, never to dodge a mode.

Plan-document edits are not implementation when they only record current understanding, options, open questions, proposed steps, or decision summaries. Brief mode may summarize what changed in the plan document and what still needs approval.

This exception does not apply to source behavior, tests, generated files, durable project guidance, ADRs, glossary entries, dependencies, public contracts, or any implementation state. Those still follow the normal approval and implementation workflow.

## Inspect Mode

Start in Inspect mode for non-trivial tasks.

In Inspect mode:

- understand the task and the consequences of possible changes
- inspect enough code, project guidance, current state, and nearby ownership to know the real shape
- treat tentative proposed means as open for challenge
- compare them with owners, invariants, and the simplest goal-fitting route
- do not edit files
- do not ask for implementation approval yet

Before leaving Inspect, load skills triggered by inspected work and complete Plan Analysis checks.
