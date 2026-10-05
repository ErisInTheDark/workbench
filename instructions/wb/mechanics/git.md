<available:remote-repos>
## Remote Git Repo Inspection
- <tool id="git_repo" /> warms a readonly copy of a public remote repository. Not a real clone.
- Favour it and normal shell calls over web searches and reads.
- Assume user does not want to contribute to remote repositories by default.
</available:remote-repos>
<available:thread-git>
## Workbench Git Plans and Arcs

### lifecycle and claims
scope and phases:
- Registry owns current scope, including empty plans; a missing phase means active.
- Do not assume claims were acquired from a successful call; read the returned phases, claims and accepted IDs/SHAs.

claims and safety:
<!-- Failure: agents ask permission to edit ignored files after arc tools correctly skip them. -->
- Arc-managed edits require claims. Gitignored files need none.
- Adopt intentional command-caused dirt for inclusion in proposals.
- Plan creation requires usable HEAD. Missing mechanics or failed commands do not authorise bypassing arc safety.
- Stashes own no live claims. Resume saved work only with user agreement.
- After final claim loss, ref-free compare/diff use that boundary while claims remain absent, including during planning; explicit plan refs still inspect planning drift. Reads never refresh the boundary.
- Plan and arc refs are not security boundaries. Store no secrets there unless the repository already permits them.

### using arc tools
<!-- Failure: agents use raw Git when arc tools already cover the job. -->
- Use Workbench Git arc tools when they can do the job; they own parallel-workspace safety.
- Before using raw Git, state why no arc tool can do that job.
- Call required arc tools directly, without raw `git status`/`git diff` or equivalent preflights; rejection is the stop signal.

### create or revise an inactive plan
publishing scope:
- <tool id="git_plan_claims" /> publishes inactive scope. Provide a short `intentName` and `addPaths`.
- Without `inherit`, supplied scope replaces the plan.
- With `inherit: true`, reuse scope and intent, applying `addPaths`, exact `removePaths`, and explicit dirty unclaimed `adoptPaths` together.
<!-- Failure: agents erase planning drift by repeating already-planned paths. -->
- Publishing refreshes baselines and reports drift against the previous ref; repeating paths refreshes their baselines too.
- A replacement plan must cover every dirty path retained from this thread's previous claim set.
- Dirty active-claimed paths may remain ordinary plan paths. Dirty unclaimed paths require explicit adoption.
<!-- Failure: agents release active work before revising scope. -->
- Inherited planning can publish an inactive successor from an active arc: it retains covered dirty claims, releases clean claims, and leaves additions unclaimed. Removing dirty coverage rejects.

### start an inactive plan
activating:
- <tool id="git_arc_start" /> activates an inactive plan; omit `ref` for registered lifecycle, or pass an explicit `ref` to select a historical plan.
- Empty plans cannot start.
- Drift rejects activation and reports plan-intersecting counts. <tool id="git_arc_diff" /> reads against a supplied ref.
- <tool id="git_plan_start" /> with `{ inherit: true }` refreshes baselines and activates inherited scope.

waiting:
- <tool id="git_arc_wait" /> waits for sibling claims, then activates the inactive plan. Do not republish that plan for collisions; if requested scope has no inactive plan, publish it first.
- Waiting never refreshes baselines. Treat it as a Workbench Long Wait.

### continue or extend an active arc
continuing or editing claims:
- Before another implementation pass without scope changes, call <tool id="git_arc_continue" /> with no ref. Unchanged continuation need not publish a successor.
- Acceptance releases clean claims. Continuation uses the narrowed live set and reports accepted proposal IDs/commit SHAs. Resolved continuation succeeds without acquiring anything.
- <tool id="git_arc_claims" /> with `inherit: true` and the scope arrays edits active claims, including continuation checks and accepted-outcome reconciliation: do not continue first. Omit unused arrays.

follow-up scope:
- After resolution, explicit approved additions/adoptions begin follow-up scope with stored intent, never old claims. Exact removals cannot expose dirty owned work.
- Folder paths are shorthand: activation claims their current files, so claim new files under them separately; removing a folder drops its file claims. Removing final clean scope resolves lifecycle.
- Never use claim expansion to excuse vague planning. Never restore, release, unclaim, or discard only to change scope.

### adopt claims from another thread
- <tool id="git_arc_adopt" /> transfers a source's complete live claims and stash. Use `threadId` only on explicit user instruction, or `name` for an owned subagent.
- Adopt preserves caller claims, proposals and worktree; plans stay with the source. Source proposals covering moved files become unavailable and are reported. Reject stash transfer if the caller has one.

### stash or restore claimed work
- <tool id="git_arc_stash" /> saves all claimed work and releases live claims. <tool id="git_arc_unstash" /> restores it alongside current claims. Neither accepts paths.
- Stash and unstash preserve pending plans and the frozen merge base; reject stash replacement.
- Text conflicts are editable worktree markers, not a Git operation, so no Git continue/abort is required. Unsupported conflicts reject and preserve the stash.

### release or hand off claims
- <tool id="git_arc_release" /> releases clean claims without changing workspace or Git content; `disown: true` releases dirty ownership only on explicit user direction.
- `toSubagent` plus exact `paths` atomically gives selected live claims to an owned child, including dirty claims, without moving stash or files. Releasing retained claims keeps the current inactive plan.
- Active claim edits mutate ownership; inactive planning publishes scope. Recover a lost proposal response with <tool id="git_arc_status" /> before retrying, never as a preflight.

### move paths
- <tool id="git_arc_mv" /> performs approved path moves; source and destination stay claimed and the ordinary Git index stays unchanged.
- Its `move` value accepts explicit operands, explicit source/destination mappings, or regex preview/confirmation. Confirm a regex preview, then preview again when more matches remain.

### compare or diff an arc
- Use <tool id="git_arc_compare" /> for counts or <tool id="git_arc_diff" /> for unified details. Omit paths and refs for the caller's registered scope.
- Explicit refs select historical snapshots/proposals, never a guessed "latest" ref.
- Explicit paths return complete unpaged data; do not page them.
- Unscoped results report the next page or end. Follow returned cursors with the same target.

<available:git-proposals>
### proposals
proposing:
- Proposal creation requires prior arc comparison or diff inspection.
<!-- Failure: long arcs forget outcomes; titles hide changes; descriptions hide work. -->
- Track all arc outcomes against the full selected diff.
- <tool id="git_arc_propose" /> with `title`, optional `description`, and no `paths` proposes all changed claims in the UI without committing.
- Title names a simple symptom/outcome for the whole changeset.
- Description identifies every distinct/unrelated bundled item, its reason and technical changes; never repeat the title or label expected constituent work "also".

replacing or rescinding:
- Set `replace: proposalId` to replace one pending proposal; use <tool id="git_arc_rescind" /> to rescind one. Do not combine replacement and amendment.

amending:
<!-- Failure: corrective amends rewrite history; additive amends hide scope. -->
<!-- Failure: agents avoided amend proposals or pre-checked HEAD/push state. Amend proposals carry both amend and fresh-commit choices, and Workbench converts impossible amends (e.g. pushed targets) into fresh-commit proposals, so the agent never needs to judge amendability. -->
- Default to amend proposals for fixes/minor addendums to committed work. Set `amend: proposalId` for committed proposals or `amend: true` for HEAD; do not pre-check targets.
- The user chooses amend or fresh; Workbench handles impossible amends. Compare against the target.
- Update title/description for changed scope, or omit both to inherit.
- Content amendments require `freshTitle` and optional `freshDescription`.
- For message-only proposals use <tool id="git_arc_reword" /> with `{ proposalId, title, description? }`, not immediate commit.

acceptance:
- Preserve excluded newer work when a proposal is accepted.

### stack proposals
sealing a layer:
<!-- Failure: agents kept editing files with pending proposals, so later proposals overlapped or swallowed work the user had not committed yet. Stacking seals pending proposals into a layer whose result becomes the arc baseline. -->
- <tool id="git_arc_stack" /> with `title` seals all pending unsealed proposals as one layer; their result becomes the arc baseline. Claims stay.
- Compare, diff, selected restore and new proposals measure from the top layer; the user commits layers bottom-up.
- Stack before further work building on pending proposals; call again per layer.

constraints:
- Sealed proposals cannot be replaced or rescinded. <tool id="git_arc_unstack" /> reopens your top layer when nothing builds on it.
- Amend proposals cannot build on a pending stack. Stash is unavailable while a stack is pending.
- Subagent claim transfers keep sealed proposals; children inherit the stack baseline.
</available:git-proposals>

### restore an arc
- Use <tool id="git_arc_restore" /> with exact ref and path list to restore selected paths to pre-patch state.
- Do not restore more than required.
- After restore, remove unneeded clean claims with <tool id="git_arc_claims" /> and `{ inherit: true, removePaths }`.
- Full arc: preview all affected paths first, get explicit user approval if missing, then reuse with `confirmRestore: true`.
- Tool cannot restore pre-commit state.

<available:multi-root>
### multi-root workspace arcs
planning:
- A multi-root workspace still gives one managed thread one logical Git arc, containing one repo-local member per participating Git repository.
- Create the full plan in one <tool id="git_plan_claims" /> call, putting each project scope in `roots`.
- Use Workbench Workspace Roots ids, not unrelated per-project arcs.
- Ordinary operations resolve registered members. Preserve root/ref pairs only for historical inspection, restoration or deliberate baseline selection.
- Partial failures report successful members: inspect the partial outcome and retry only unfinished edits. Do not repeat successful removals or roll back successful repositories.

<available:git-proposals>
- Call <tool id="git_arc_propose" /> once per root with `rootId`; omit `paths` for that root's changed claims or select a narrower subset. Never combine roots in one commit.
</available:git-proposals>

- Use the terminal lifecycle card for restore or unclaim so all remaining repo members stay visible and recoverable.
</available:multi-root>

## Workbench Git Commits
When workflow or user explicitly authorizes unsupervised agent commits:
- <tool id="git_add" /> selects the exact currently changed files beneath `paths`; selections are thread- and worktree-isolated but do not snapshot contents.
- <tool id="git_unstage" /> removes exact files or descendants from this thread's selection. Pass `paths: ["."]` to clear it.
- <tool id="git_commit" /> commits CURRENT versions of selected files using `title` and optional `description`, then clears selection.
- NO raw shell git usage for commits.
</available:thread-git>
