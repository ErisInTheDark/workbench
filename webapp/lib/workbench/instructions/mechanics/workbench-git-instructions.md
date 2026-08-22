## Workbench Git Commits

When the workflow or user explicitly authorizes a commit, use the typed wb MCP commit-selection tools. Do not use raw Git staging or commit commands.

- `mcp__wb__git_add` selects the exact currently changed files beneath `paths` for this thread.
- `mcp__wb__git_unstage` removes exact files or descendants from this thread's selection. Pass `paths: ["."]` to clear it.
- `mcp__wb__git_commit` commits the selected files and clears the selection after success. Use `amendTarget` only for the exact supported unpushed linear commit.
- Use `targetWorktree` when the control-plane project owns the thread but the files belong to another registered worktree of the same repository.

Selections are isolated by managed thread and worktree. Selection does not snapshot file contents. Later edits to a selected file are included when the commit tool reads it. Unrelated ordinary staged files remain excluded.

## Workbench Git Plans and Arcs

Workbench stores workflow baselines as local Git objects under hidden per-worktree refs. The registry keeps one current lifecycle entry in `plan`, `active`, or `resolved` phase.

Plan and arc refs are convenience state, not a security boundary. Never store secrets there unless the repository state already permits them.

When an arc tool is the required workflow step, call it directly. Do not preflight it with raw `git status`, raw `git diff`, or an equivalent command. The arc operation owns safety checks and its rejection is the stop signal.

### create or revise an inactive plan

Use `mcp__wb__git_arc_plan` after entering Brief mode when the exact edit paths are known. Provide `intentName`, optional `intentDescription`, `paths`, and only intentional dirty unclaimed `adoptPaths`.

The plan snapshots the full Git-visible worktree through structurally shared objects. Its path list selects arc operations. It does not limit snapshot storage.

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

### continue or extend an active arc

Before follow-up work on the same claimed files, call `mcp__wb__git_arc_continue` with the remembered ref.

Proposal acceptance releases clean claims. When dirty work remains, continuation returns the narrowed successor. When no dirty claims remain, continuation reports every accepted proposal ID and commit SHA and resolves the arc.

After approval and continuation, use:

- `mcp__wb__git_arc_add` for approved new clean paths.
- `mcp__wb__git_arc_adopt` for approved existing dirty workspace paths.
- `mcp__wb__git_arc_remove` for exact clean claims the active arc no longer owns.

Never use these active-arc tools during Brief or Decision mode. Remember every returned successor ref.

Use `mcp__wb__git_arc_mv` for approved path moves. Its `move` value accepts explicit operands, explicit source/destination mappings, or regex preview/confirmation. Regex mode previews at most 200 sorted mappings. Confirm the preview, then preview again when more matches remain.

### compare or diff an arc

Use `mcp__wb__git_arc_compare` when paths and change counts are enough. Use `mcp__wb__git_arc_diff` when unified details are needed. Omit `paths` to inspect the claimed set. Use `ref` only for an inactive or historical plan owned by this thread.

In Review, choose one initial arc-scoped inspection. Do not run compare first when unified details are already required. At least one compare or diff is required before proposal creation.

### propose, replace, rescind, or amend

After validation and Review inspection, call `mcp__wb__git_arc_propose` with a fresh title. Omit `paths` to use all changed claimed files. A proposal opens the proposal UI and does not commit.

Set `replaceProposalId` to replace exactly one pending proposal. Use `mcp__wb__git_arc_rescind` to rescind exactly one pending proposal.

Set `amend: true` and, when needed, `amendProposalId` to amend an exact committed proposal supported by the linear unpushed-history rewriter. Targeted amend remaps affected proposal metadata and arc refs atomically.

Proposal acceptance atomically changes branch history, proposal metadata, the accepted receipt ledger, and live claims. It preserves excluded newer work.

### restore after explicit user approval

Preview the affected paths first. Call `mcp__wb__git_arc_restore` with `paths` to discard only selected outstanding work. Full restore requires `confirmRestore: true` and preserves accepted commits.

Restore-and-unclaim marks pending proposals unavailable and leaves a zero-claim resolved lifecycle entry.
