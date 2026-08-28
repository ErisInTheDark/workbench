## Workbench Git Commits

When the workflow or user explicitly authorizes a commit, use the typed wb MCP commit-selection tools. Do not use raw Git staging or commit commands.

- `mcp__wb__git_add` selects the exact currently changed files beneath `paths` for this thread.
- `mcp__wb__git_unstage` removes exact files or descendants from this thread's selection. Pass `paths: ["."]` to clear it.
- `mcp__wb__git_commit` commits selected files using `title` and optional `description`, then clears the selection. Use `amendTarget` only for a supported unpushed linear commit.
- Use `targetWorktree` when the control-plane project owns the thread but the files belong to another registered worktree of the same repository.

Selections are thread- and worktree-isolated but do not snapshot contents. The commit reads later edits while excluding unrelated ordinary staged files.

## Workbench Git Plans and Arcs

Workbench stores workflow baselines as local Git objects under hidden per-worktree refs. The registry keeps one current lifecycle entry in `plan`, `active`, or `resolved` phase.

<available:multi-root>
### multi-root workspace arcs

A multi-root workspace still gives one managed thread one logical Git arc. The logical arc contains one repo-local member for each participating Git repository. Each member keeps its own ref because unrelated Git object databases cannot share one checkpoint SHA.

Create the full plan in one `mcp__wb__git_arc_plan` call. Put each project edit set in `roots` as `{ rootId, paths, adoptPaths? }`. Use the root ids from Workbench Workspace Roots. Do not create unrelated per-project arcs.

Read and preserve the complete `members` or root/ref set returned by start, continuation, compare, and diff. Pass `refs` back for exact multi-root continuation, inspection, and restore. A successful member can remain visible when another repository fails. Re-run the same logical operation to complete unfinished members. Do not roll back a successful repository automatically.

In Review, inspect the whole logical arc. Then call `mcp__wb__git_arc_propose` once per workspace root and pass that proposal's `rootId`. A proposal cannot cross root boundaries. Omit `paths` to select that root's changed claims, or pass a narrower subset from that root. Never combine files from different roots into one proposed commit.

The terminal lifecycle card aggregates every project proposal and every live claim. If the user chooses restore or unclaim instead of committing, use the aggregate card so all remaining repo members stay visible and recoverable.
</available:multi-root>

Plan and arc refs are not security boundaries. Store no secrets there unless the repository already permits them.

<!-- Failure: agents use raw Git when arc tools already cover the job. -->
Use Workbench Git arc tools when they can do the job. They own parallel-workspace safety. Before using raw Git, state why no arc tool can do that job.

Call required arc tools directly. Do not preflight or supplement them with raw `git status`, raw `git diff`, or equivalents. The arc owns safety checks. Rejection is the stop signal.

### create or revise an inactive plan

Use `mcp__wb__git_arc_plan` after entering Brief mode when the exact edit paths are known. Provide `intentName`, optional `intentDescription`, `paths`, and only intentional dirty unclaimed `adoptPaths`.

The plan snapshots the Git-visible worktree through shared objects. Its paths select arc operations, not snapshot storage.

Dirty active-claimed paths can remain ordinary plan paths. A replacement plan must cover every dirty path retained from this thread's previous claim set. Dirty unclaimed paths require explicit adoption.

Use these successor tools to revise the current inactive plan without publishing an unrelated replacement:

- `mcp__wb__git_arc_plan_add`
- `mcp__wb__git_arc_plan_remove`
- `mcp__wb__git_arc_plan_adopt`

Adding paths re-snapshots every requested path, including already covered paths. Removing a path that would uncover retained dirty work rejects. Old refs remain available for diagnostics.

If a plan operation reports preserved baseline drift, run the printed scoped `mcp__wb__git_arc_diff` request. Re-add only paths whose current versions are the intended baselines.

### start implementation

For an inactive plan's first Implement pass, call `mcp__wb__git_arc_start`. Pass `ref` only to select an exact historical plan. Successful start creates the active baseline and reports released and acquired claims.

If start reports planned-path drift, run its exact scoped diagnostic. Drift alone does not invalidate approval. When paths, behavior, ownership, mechanics, and validation remain unchanged, use `mcp__wb__git_arc_plan_start` with the same approved paths. Return to Brief only when the plan changed.

`mcp__wb__git_arc_wait` waits until the current or selected plan can start, then acquires its claims. Treat it as a Workbench Long Wait.

### continue or extend an active arc

Before follow-up work on the same claimed files, call `mcp__wb__git_arc_continue` with the remembered ref.

Proposal acceptance releases clean claims. When dirty work remains, continuation returns the narrowed successor. When no dirty claims remain, continuation reports every accepted proposal ID and commit SHA and resolves the arc.

After approval and continuation, use:

- `mcp__wb__git_arc_add` for approved new clean paths.
- `mcp__wb__git_arc_adopt` for approved existing dirty workspace paths.
- `mcp__wb__git_arc_remove` for exact clean claims the active arc no longer owns.

Use `mcp__wb__git_arc_release` to release every live claim without changing workspace or Git content. It rejects dirty claims by default. Set `disown: true` only after explicit user direction to release dirty ownership. Releasing retained claims keeps the current inactive plan.

Never use these active-arc tools during Brief or Decision mode. Remember every returned successor ref.

Use `mcp__wb__git_arc_mv` for approved path moves. Its `move` value accepts explicit operands, explicit source/destination mappings, or regex preview/confirmation. Regex mode previews at most 200 sorted mappings. Confirm the preview, then preview again when more matches remain.

### compare or diff an arc

Use `mcp__wb__git_arc_compare` when paths and change counts are enough. Use `mcp__wb__git_arc_diff` when unified details are needed. Omit `paths` to inspect the claimed set. Omit `ref` for the current active arc. An explicit `ref` can identify that same current active arc or an inactive or historical plan owned by this thread. Do not use a superseded arc ref.

In Review, choose one initial arc-scoped inspection. Do not run compare first when unified details are already required. At least one compare or diff is required before proposal creation.

### propose, replace, rescind, or amend

<!-- Failure: long arcs forget outcomes; titles hide changes; descriptions hide work. -->
Track all arc outcomes. Reconcile the list with the full selected diff. New proposals call `mcp__wb__git_arc_propose` with `title`, optional `description`, and no `paths` for all changed claims. It opens the UI without committing. Make `title` a simple symptom or outcome encompassing the full changeset. Use `description` for concrete work beyond that summary. Identify every distinct or unrelated bundled item, why included, and its additional technical changes. Do not repeat `title` or present expected constituent work as an unrelated "also."

Set `replaceProposalId` to replace exactly one pending proposal. Use `mcp__wb__git_arc_rescind` to rescind exactly one pending proposal.

<!-- Failure: corrective amends rewrite history; additive amends hide scope. -->
Compare the amended commit with its `title` and `description`. When changes only make the stated outcome work, omit both fields to inherit them. Update both fields for added functionality, scope, and all distinct or unrelated fixes. Set `amend: true` and, when needed, `amendProposalId`. Targeted amend supports linear unpushed history and atomically remaps proposal metadata and arc refs.

Proposal acceptance atomically changes branch history, proposal metadata, the accepted receipt ledger, and live claims. It preserves excluded newer work.

### restore after explicit user approval

Preview the affected paths first. Call `mcp__wb__git_arc_restore` with `paths` to discard only selected outstanding work. Full restore requires `confirmRestore: true` and preserves accepted commits.

Restore-and-unclaim marks pending proposals unavailable and leaves a zero-claim resolved lifecycle entry.
