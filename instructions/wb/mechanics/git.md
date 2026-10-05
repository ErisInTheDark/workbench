<available:remote-repos>
## Remote Git Repo Inspection
Use <tool id="git_repo" /> to warm a readonly copy of a public remote repository on disk. Not a real clone, implemented via vfs. Favour this tool and normal shell calls over web searches and reads. Assume user does not want to contribute to remote repositories by default.
</available:remote-repos>
<available:thread-git>
## Workbench Git Plans and Arcs

Workbench stores immutable plan/arc snapshots under local per-worktree Git refs. Registry owns current scope, including empty plans; missing phase means active. Plans snapshot the full worktree; arc refs preserve history. Ordinary stashes keep `stashed` phase and frozen claim-loss refs. Adopted stashes may coexist with live claims under caller-owned `arc-stash` refs.

Ordinary operations resolve registered lifecycle; omit refs. <tool id="git_arc_status" /> provides ownership, proposal and recovery facts.

`wb git arc status [--full=dirty,clean,unclaimed-dirt]`; MCP `full: ["dirty", "clean", "unclaimed-dirt"]`. Empty groups are omitted; file groups list up to five paths, otherwise counts. `full` expands selected groups. Pending proposals must remain valid; accepted proposals remain until the next implementation arc starts. Unclaimed dirt excludes all live owners, not older files.

Stashes own no live claims. Resume saved work only with user agreement.

Final claim loss atomically records its exact scope, HEAD and snapshot under the thread's Git refs. Status reports intersecting commits and per-file counts; ref-free compare/diff use that boundary while claims remain absent, including during planning. Explicit plan refs still inspect planning drift. Reads never refresh the boundary. Existing settled-history retention removes it with other thread refs.

<!-- Failure: agents ask permission to edit ignored files after arc tools correctly skip them. -->
Arc-managed edits require claims. Gitignored files need none. Adopt intentional command-caused dirt for inclusion in proposals.

Plan creation requires usable HEAD. Missing mechanics or failed commands do not authorise bypassing arc safety.

Read returned phases, claims and accepted proposal IDs/commit SHAs. Success does not imply claims were acquired.

<available:multi-root>
### multi-root workspace arcs

A multi-root workspace still gives one managed thread one logical Git arc. The logical arc contains one repo-local member for each participating Git repository. Each member keeps its own ref because unrelated Git object databases cannot share one checkpoint SHA.

Create the full plan in one <tool id="git_plan_claims" /> call. Put each project scope in `roots` as `{ rootId, addPaths, removePaths?, adoptPaths? }`. Use Workbench Workspace Roots ids, not unrelated per-project arcs.

Ordinary operations resolve registered members. Preserve root/ref pairs only for historical inspection, restoration or deliberate baseline selection. Partial failures report successful members. Inspect the partial outcome and retry only unfinished edits; do not repeat successful removals or roll back successful repositories.

<available:git-proposals>
Call <tool id="git_arc_propose" /> once per root with `rootId`. Omit `paths` for that root's changed claims, or select a narrower subset. Never combine roots in one commit.
</available:git-proposals>

The terminal lifecycle card aggregates every project proposal and every live claim. If the user chooses restore or unclaim instead of committing, use the aggregate card so all remaining repo members stay visible and recoverable.
</available:multi-root>

Plan and arc refs are not security boundaries. Store no secrets there unless the repository already permits them.

<!-- Failure: agents use raw Git when arc tools already cover the job. -->
Use Workbench Git arc tools when they can do the job. They own parallel-workspace safety. Before using raw Git, state why no arc tool can do that job.

Call required arc tools directly. Do not preflight or supplement them with raw `git status`, raw `git diff`, or equivalents. The arc owns safety checks. Rejection is the stop signal.

### create or revise an inactive plan

<tool id="git_plan_claims" /> publishes inactive scope. Provide short `intentName` and `addPaths`. Without `inherit`, supplied scope replaces the plan. With `inherit: true`, reuse scope and intent, applying `addPaths`, exact `removePaths`, and explicit dirty unclaimed `adoptPaths` together.

The plan snapshots the Git-visible worktree through shared objects. Its paths select arc operations, not snapshot storage.

Dirty active-claimed paths can remain ordinary plan paths. A replacement plan must cover every dirty path retained from this thread's previous claim set. Dirty unclaimed paths require explicit adoption.

<!-- Failure: agents erase planning drift by repeating already-planned paths. -->
Publishing refreshes baselines and reports drift against previous ref. Repeating paths refreshes their baselines too.

<!-- Failure: agents release active work before revising scope. -->
Inherited planning can publish an inactive successor from an active arc. It retains covered dirty claims, releases clean claims, and leaves additions unclaimed. Removing dirty coverage rejects.

CLI: `wb git plan claims -m "intent" -- new.ts`, then `wb git plan claims --inherit -- added.ts -removed.ts '*adopted.ts'`. Quote adoption operands. `./-literal.ts` and `'./*literal.ts'` add literal filenames. MCP arrays always contain literal paths.

### start implementation

<tool id="git_arc_start" /> activates an inactive plan. Omit `ref` for registered lifecycle; explicit `ref` selects a historical plan. Success reports released/acquired claims. Empty plans cannot start.

Drift rejects activation and reports plan-intersecting counts. <tool id="git_arc_diff" /> reads against supplied ref. <tool id="git_plan_start" /> with `{ inherit: true }` refreshes baselines and activates inherited scope.

<tool id="git_arc_wait" /> waits for sibling claims, then activates the inactive plan. Do not republish that plan for collisions. If requested scope has no inactive plan, publish it first. Waiting never refreshes baselines. Treat it as a Workbench Long Wait.

### continue or extend an active arc

Before another implementation pass without scope changes, call <tool id="git_arc_continue" /> with no ref. Unchanged continuation need not publish a successor.

Acceptance releases clean claims. Continuation uses the narrowed live set and reports accepted proposal IDs/commit SHAs. Resolved continuation succeeds without acquiring anything.

Edit active claims with <tool id="git_arc_claims" /> and `{ inherit: true, addPaths?, removePaths?, adoptPaths? }`. **Includes continuation checks and accepted-outcome reconciliation; do not continue first.** Omit unused arrays. CLI: `wb git arc claims --inherit -- added.ts -removed.ts '*adopted.ts'`.

<tool id="git_arc_adopt" /> transfers a source's complete live claims and stash. Use `threadId` only on explicit user instruction, or `name` for an owned subagent when needed. Preserve caller claims, proposals and worktree; plans stay with source; source proposals covering moved files become unavailable and are reported. Reject stash transfer if caller has one.

<tool id="git_arc_stash" /> saves all claimed work and releases live claims. <tool id="git_arc_unstash" /> restores it alongside current claims. Neither accepts paths. Preserve pending plans and frozen merge base; reject stash replacement. Text conflicts are editable worktree markers, not a Git operation; no Git continue/abort is required. Unsupported conflicts reject and preserve stash.

After resolution, explicit approved additions/adoptions begin follow-up scope with stored intent, never old claims. Exact removals cannot expose dirty owned work. Folder paths are shorthand: activation claims their current files, so claim new files under them separately; removing a folder drops its file claims. Removing final clean scope resolves lifecycle.

Never use claim expansion to excuse vague planning. Never restore, release, unclaim, or discard only to change scope.

Use <tool id="git_arc_release" /> to release clean claims without changing workspace or Git content; `disown: true` releases dirty ownership only on explicit user direction. `toSubagent` plus exact `paths` atomically gives selected live claims to an owned child, including dirty claims, without moving stash or files. Releasing retained claims keeps the current inactive plan.

Active claim edits mutate ownership; inactive planning publishes scope. Recover a lost proposal response with <tool id="git_arc_status" /> before retrying, never as a preflight. Updates report phase, outcome, counts and net changes.

Use <tool id="git_arc_mv" /> for approved path moves. Source and destination stay claimed; ordinary Git index stays unchanged. Its `move` value accepts explicit operands, explicit source/destination mappings, or regex preview/confirmation. Regex mode previews at most 200 sorted mappings. Confirm the preview, then preview again when more matches remain.

### compare or diff an arc

Use <tool id="git_arc_compare" /> for counts or <tool id="git_arc_diff" /> for unified details. Omit paths and refs for the caller's registered scope. Explicit refs select historical snapshots/proposals, never a guessed "latest" ref. Explicit paths return complete unpaged data; page 1 is redundant, higher pages reject. Unscoped results report next page or end. Follow returned cursors with the same target.

<available:git-proposals>
Proposal creation requires prior arc comparison or diff inspection.

### propose, replace, rescind, or amend

<!-- Failure: long arcs forget outcomes; titles hide changes; descriptions hide work. -->
Track all arc outcomes against the full selected diff. <tool id="git_arc_propose" /> with `title`, optional `description`, no `paths` proposes all changed claims in the UI without committing. Title names a simple symptom/outcome for the whole changeset. Description identifies every distinct/unrelated bundled item, reason and technical changes; never repeat title or label expected constituent work "also."

Set `replace: proposalId` to replace one pending proposal. Use <tool id="git_arc_rescind" /> to rescind one. Do not combine replacement and amendment.

<!-- Failure: corrective amends rewrite history; additive amends hide scope. -->
<!-- Failure: agents avoided amend proposals or pre-checked HEAD/push state. Amend proposals carry both amend and fresh-commit choices, and Workbench converts impossible amends (e.g. pushed targets) into fresh-commit proposals, so the agent never needs to judge amendability. -->
**Default to amend proposals for fixes/minor addendums to committed work.** User chooses amend or fresh; Workbench handles impossible amends. Set `amend: proposalId` for committed proposals or `amend: true` for HEAD; do not pre-check targets. Compare against target. Update title/description for changed scope, or omit both to inherit. Content amendments require `freshTitle` and optional `freshDescription`. For message-only proposals use <tool id="git_arc_reword" /> with `{ proposalId, title, description? }`, not immediate commit.

Proposal acceptance atomically changes branch history, proposal metadata, accepted receipts and live claims. Preserve excluded newer work.

### stack proposals

<!-- Failure: agents kept editing files with pending proposals, so later proposals overlapped or swallowed work the user had not committed yet. Stacking seals pending proposals into a layer whose result becomes the arc baseline. -->
<tool id="git_arc_stack" /> with `title` seals all pending unsealed proposals as one layer; their result becomes the arc baseline. Claims stay. Compare, diff, selected restore and new proposals measure from the top layer; user commits layers bottom-up. **Stack before further work building on pending proposals; call again per layer.** Sealed proposals cannot be replaced or rescinded; <tool id="git_arc_unstack" /> reopens your top layer when nothing builds on it. Amend proposals cannot build on a pending stack. Stash is unavailable while a stack is pending. Subagent claim transfers keep sealed proposals; children inherit the stack baseline.
</available:git-proposals>

### restore selected paths

- Use <tool id="git_arc_restore" /> with exact ref and path list to restore to pre-patch state
- Do not restore more than required
- After restore, remove unneeded clean claims with <tool id="git_arc_claims" /> and `{ inherit: true, removePaths }`

### restore full arc

1. Use <tool id="git_arc_restore" /> to preview all affected paths
2. Get explicit user approval if missing
3. Reuse with `confirmRestore: true`

Note: Tool cannot restore pre-commit state

## Workbench Git Commits

When workflow or user explicitly authorizes unsupervised agent commits:
- <tool id="git_add" /> selects the exact currently changed files beneath `paths` for this thread; Selections are thread- and worktree-isolated but do not snapshot contents
- <tool id="git_unstage" /> removes exact files or descendants from this thread's selection. Pass `paths: ["."]` to clear it
- <tool id="git_commit" /> commits CURRENT versions of selected files using `title` and optional `description`, then clears selection
- NO raw shell git usage for commits
</available:thread-git>
