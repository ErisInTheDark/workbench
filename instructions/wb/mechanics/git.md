<available:thread-git>
## Workbench Git Commits

When the workflow or user explicitly authorizes a commit, use the typed wb MCP commit-selection tools. Do not use raw Git staging or commit commands.

- `mcp__wbex__git_add` selects the exact currently changed files beneath `paths` for this thread.
- `mcp__wbex__git_unstage` removes exact files or descendants from this thread's selection. Pass `paths: ["."]` to clear it.
- `mcp__wbex__git_commit` commits selected files using `title` and optional `description`, then clears the selection. Use `amendTarget` only for a supported unpushed linear commit.
- Use `targetWorktree` when the control-plane project owns the thread but the files belong to another registered worktree of the same repository.

Selections are thread- and worktree-isolated but do not snapshot contents. The commit reads later edits while excluding unrelated ordinary staged files.

## Workbench Git Plans and Arcs

Workbench stores workflow baselines as local Git objects under hidden per-worktree refs. The registry keeps one current lifecycle entry in `plan`, `active`, or `resolved` phase.

Plan ref: immutable full-worktree snapshot; registry owns current scope, including empty plans.

Arc ref: immutable historical snapshot.

Arc: registered changeset in plan, active or resolved phase. Missing phase means active.

Ordinary operations resolve registered lifecycle; omit refs. `git_arc_status` provides compact ownership and recovery facts; `git_arc_scope` provides full lifecycle inventory.

`wb git arc status [--full=dirty,clean,unclaimed-dirt]`; MCP `full: ["dirty", "clean", "unclaimed-dirt"]`. Empty groups are omitted; file groups list up to five paths, otherwise counts. `full` expands selected groups. Pending proposals must remain valid; accepted proposals remain until the next implementation arc starts. Unclaimed dirt excludes all live owners, not older files.

Final claim loss atomically records its exact scope, HEAD and snapshot under the thread's Git refs. Status reports intersecting commits and per-file counts; ref-free compare/diff use that boundary while claims remain absent, including during planning. Explicit plan refs still inspect planning drift. Reads never refresh the boundary. Existing settled-history retention removes it with other thread refs.

<!-- Failure: agents ask permission to edit ignored files after arc tools correctly skip them. -->
Arc-managed edits require claims. Gitignored files need none. Adopt intentional command-caused dirt for inclusion in proposals.

Plan creation requires usable HEAD. Missing mechanics or failed commands do not authorise bypassing arc safety.

Read returned phases, claims and accepted proposal IDs/commit SHAs. Success does not imply claims were acquired.

<available:multi-root>
### multi-root workspace arcs

A multi-root workspace still gives one managed thread one logical Git arc. The logical arc contains one repo-local member for each participating Git repository. Each member keeps its own ref because unrelated Git object databases cannot share one checkpoint SHA.

Create the full plan in one `git_plan_claims` call. Put each project scope in `roots` as `{ rootId, addPaths, removePaths?, adoptPaths? }`. Use Workbench Workspace Roots ids, not unrelated per-project arcs.

Ordinary operations resolve registered members. Preserve root/ref pairs only for historical inspection, restoration or deliberate baseline selection. Partial failures report successful members. Inspect the partial outcome and retry only unfinished edits; do not repeat successful removals or roll back successful repositories.

For multi-root proposals, call `mcp__wbex__git_arc_propose` once per workspace root and pass that proposal's `rootId`. A proposal cannot cross root boundaries. Omit `paths` to select that root's changed claims, or pass a narrower subset from that root. Never combine files from different roots into one proposed commit.

The terminal lifecycle card aggregates every project proposal and every live claim. If the user chooses restore or unclaim instead of committing, use the aggregate card so all remaining repo members stay visible and recoverable.
</available:multi-root>

Plan and arc refs are not security boundaries. Store no secrets there unless the repository already permits them.

<!-- Failure: agents use raw Git when arc tools already cover the job. -->
Use Workbench Git arc tools when they can do the job. They own parallel-workspace safety. Before using raw Git, state why no arc tool can do that job.

Call required arc tools directly. Do not preflight or supplement them with raw `git status`, raw `git diff`, or equivalents. The arc owns safety checks. Rejection is the stop signal.

### create or revise an inactive plan

`git_plan_claims` publishes inactive scope. Provide short `intentName` and `addPaths`. Without `inherit`, supplied scope replaces the plan. With `inherit: true`, reuse scope and intent, applying `addPaths`, exact `removePaths`, and explicit dirty unclaimed `adoptPaths` together.

The plan snapshots the Git-visible worktree through shared objects. Its paths select arc operations, not snapshot storage.

Dirty active-claimed paths can remain ordinary plan paths. A replacement plan must cover every dirty path retained from this thread's previous claim set. Dirty unclaimed paths require explicit adoption.

<!-- Failure: agents erase planning drift by repeating already-planned paths. -->
Publishing refreshes baselines and reports drift against previous ref. Repeating paths refreshes their baselines too.

<!-- Failure: agents release active work before revising scope. -->
Inherited planning can publish an inactive successor from an active arc. It retains covered dirty claims, releases clean claims, and leaves additions unclaimed. Removing dirty coverage rejects.

CLI: `wb git plan claims -m "intent" -- new.ts`, then `wb git plan claims --inherit -- added.ts -removed.ts '*adopted.ts'`. Quote adoption operands. `./-literal.ts` and `'./*literal.ts'` add literal filenames. MCP arrays always contain literal paths.

### start implementation

`git_arc_start` activates an inactive plan. Omit `ref` for registered lifecycle; explicit `ref` selects a historical plan. Success reports released/acquired claims. Empty plans cannot start.

Drift rejects activation and reports plan-intersecting comparison counts. `git_arc_diff` reads changes against supplied ref. `git_plan_start({ inherit: true })` refreshes baselines and activates inherited scope.

`git_arc_wait` waits for sibling claims, then activates the inactive plan. Do not republish that plan for collisions. If requested scope has no inactive plan, publish it first. Waiting never refreshes baselines. Treat it as a Workbench Long Wait.

### continue or extend an active arc

Before another implementation pass without scope changes, call `git_arc_continue` with no ref. Unchanged continuation need not publish a successor.

Acceptance releases clean claims. Continuation uses the narrowed live set and reports accepted proposal IDs/commit SHAs. Resolved continuation succeeds without acquiring anything.

Edit active claims with `git_arc_claims({ inherit: true, addPaths, removePaths, adoptPaths })`. **Continuation checks and accepted-outcome reconciliation are included; do not continue first.** Omit unused arrays. CLI uses `wb git arc claims --inherit -- added.ts -removed.ts '*adopted.ts'`.

After resolution, explicit approved additions/adoptions begin follow-up scope with stored intent, never old claims. Exact removals cannot expose dirty owned work; directory claims are not exclusion patterns. Removing final clean scope resolves lifecycle.

Never use claim expansion to excuse vague planning. Never restore, release, unclaim, or discard only to change scope.

Use `mcp__wbex__git_arc_release` to release every live claim without changing workspace or Git content. It rejects dirty claims by default. Set `disown: true` only after explicit user direction to release dirty ownership. Releasing retained claims keeps the current inactive plan.

Active claim edits mutate ownership; inactive planning publishes scope. Recover a lost proposal response with `git_arc_scope` before retrying, never as a preflight. Updates report phase, outcome, counts and net changes.

Use `mcp__wbex__git_arc_mv` for approved path moves. Source and destination stay claimed; ordinary Git index stays unchanged. Its `move` value accepts explicit operands, explicit source/destination mappings, or regex preview/confirmation. Regex mode previews at most 200 sorted mappings. Confirm the preview, then preview again when more matches remain.

### compare or diff an arc

Use `git_arc_compare` for counts or `git_arc_diff` for unified details. Omit paths and refs for the caller's registered scope. Explicit refs select historical snapshots/proposals, never a guessed "latest" ref. Explicit paths return complete unpaged data; page 1 is redundant, higher pages reject. Unscoped results report next page or end. Follow returned cursors with the same target.

Proposal creation requires prior arc comparison or diff inspection.

### propose, replace, rescind, or amend

<!-- Failure: long arcs forget outcomes; titles hide changes; descriptions hide work. -->
Track all arc outcomes. Reconcile the list with the full selected diff. New proposals call `mcp__wbex__git_arc_propose` with `title`, optional `description`, and no `paths` for all changed claims. It opens the UI without committing. Make `title` a simple symptom or outcome encompassing the full changeset. Use `description` for concrete work beyond that summary. Identify every distinct or unrelated bundled item, why included, and its additional technical changes. Do not repeat `title` or present expected constituent work as an unrelated "also."

Set `replace: proposalId` to replace one pending proposal. Use `git_arc_rescind` to rescind one. Do not combine replacement and amendment.

<!-- Failure: corrective amends rewrite history; additive amends hide scope. -->
Compare amendments against their target. Set `amend: proposalId` for a committed proposal or `amend: true` for HEAD. Update title/description for changed scope; omit both to inherit. Content amendments require `freshTitle` and optional `freshDescription` for the separate fresh-commit choice. Targets must be linear and unpushed. Use `git_arc_reword({ proposalId, title, description? })` for a message-only proposal, not an immediate commit.

Proposal acceptance atomically changes branch history, proposal metadata, the accepted receipt ledger, and live claims. It preserves excluded newer work.

### restore selected paths

- Use `mcp__wbex__git_arc_restore` with exact ref and path list to restore to pre-patch state
- Do not restore more than required
- After restore, remove unneeded clean claims with `git_arc_claims({ inherit: true, removePaths })`

### restore full arc

1. Use `mcp__wbex__git_arc_restore` to preview all affected paths
2. Get explicit user approval if missing
3. Reuse with `confirmRestore: true`

Note: Tool cannot restore pre-commit state
</available:thread-git>
