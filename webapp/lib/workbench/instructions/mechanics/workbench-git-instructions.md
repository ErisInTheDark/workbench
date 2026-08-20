## Workbench Git Commits

When workflows or the user explicitly authorize a commit, use Workbench's bounded, thread-owned commit-selection workflow instead:

`wb git add -- <path> [<path>...]`

`wb git unstage -- <path> [<path>...]`

`wb git commit --message <message>`

`wb git commit --amend <commit-sha> --message <message>`

When the control-plane project owns the thread but the files belong to another registered worktree of the same repository, keep the command cwd in the control-plane project and add `--worktree <absolute-path>` to each add, unstage, and commit command. The explicit worktree selects the Git execution root and the thread's per-worktree selection namespace; it does not reinterpret thread identity.

`wb git add` records the exact files that are currently changed beneath the requested paths. It does not snapshot their contents or modify the repository's ordinary Git index. Later edits to a selected file are included when `wb git commit` reads that file's current contents. `wb git unstage` removes exact selected files or selected descendants of a requested directory; use `.` to clear the thread's selection.

Each managed thread owns an isolated selection list for each Git worktree. `wb git commit` runs host-side `git add` for the selected files followed by a path-limited `git commit --only`, then clears the selection after success. Unrelated ordinary staged files remain staged and excluded. Failures retain the selection; because the add is real, a later commit failure may leave the selected files staged in the ordinary Git index.

Use `--amend <commit-sha>` only for an exact unpushed commit on the current branch's linear first-parent stack. Workbench builds replacement commits and remaps affected arc refs with Git plumbing without checking out intermediate history. Merge ranges, signed commits, conflicts, detached HEAD, pushed targets, and unknown remote state reject before ref publication. Old checkpoint SHAs resolve through the Workbench rewrite map. The plumbing amend path does not run commit hooks.

## Workbench Git Plans and Arcs

Workbench stores agent workflow baselines as real local Git commit objects under hidden per-worktree refs. The registry keeps one current per-thread entry whose phase is `plan`, `active`, or `resolved`. A missing phase reads as `active` for compatibility without migration.

This thread's checkpoint namespace is owned by Workbench and scoped to the current Git worktree:

```text
refs/worktree/agents/<thread-id>/checkpoints
```

Plan and arc refs are convenience state, not a security boundary. Do not use them to store secrets unless the repo state is already allowed to contain those secrets.

Use these exact CLI shapes so Workbench can match and render checkpoint operations. Workbench owns the Git plumbing and uses a temporary index internally, so agents should not run raw `git update-ref` checkpoint scripts themselves.

Plans snapshot the full Git-visible worktree as structurally shared Git objects. They do not copy the workspace. Unchanged blobs and trees are reused; only changed and non-ignored untracked content creates new objects. The stored claimed paths select ordinary arc operations; they are not the snapshot's storage scope.

When an arc command is the required workflow step, run it directly and let it accept or reject the current state. Do not inspect or preflight workspace state with raw `git status`, raw `git diff`, or equivalent commands; the arc operation owns its safety checks and its rejection is the stop signal. Use `arc compare` and `arc diff` only where these instructions explicitly require arc-scoped change details, such as Review.

### Create the plan

Run after entering Brief mode once the exact planned edit files are known. Give the changeset a short intent name and add a second `-m` only when a description helps sibling agents judge overlap. An empty plan is valid while the edit set is still being refined, but it cannot start.

`wb git arc plan -m <short-intent> [-m <optional-description>] [--adopt <dirty-path>...] [-- <path>...]`

Ordinary dirty paths are valid only while an active arc owns that dirt. Any active arc can publish a replacement plan; an accepted proposal is not a prerequisite. A replacement plan must cover every dirty file under this thread's previous claim set. Publishing the plan releases clean previous claims immediately and keeps only covered dirty files live through the retained arc. Dirty unclaimed paths reject unless each is named with `--adopt <dirty-path>`. Adopted paths must be dirty and unclaimed. Plan creation does not claim fresh paths.

Extend an active arc's scope during Brief with `plan add`. It creates an inactive successor containing the active scope plus the new paths, retains only dirty old claims, and does not claim the new paths. The same command revises a current inactive plan without remembering its ref:

`wb git arc plan add -- <path> [<path>...]`

`wb git arc plan remove -- <path> [<path>...]`

`wb git arc plan adopt -- <dirty-path> [<dirty-path>...]`

Each revision creates an immutable successor ref and moves the per-thread current-plan pointer. `plan remove` and `plan adopt` require an inactive plan. Removing a path that would uncover retained dirty work rejects. Old refs remain available for diagnostics.

### Start implementation

The first time an inactive plan enters Implement mode, run `arc start` directly. It resolves the current plan unless `--ref` selects an exact historical plan. Start rejects empty plans, changed adopted or retained snapshots, unexplained dirt, sibling claim collisions, and settled owner threads. Successful start creates a new active baseline from current `HEAD`, preserves adopted and retained work as visible diff, and reports released and acquired claims.

`wb git arc start [--ref <plan-ref>]`

If start reports drift, run its exact scoped diagnostic before raw Git or whole-file rereads:

`wb git arc diff --ref <plan-ref> -- <reported-path> [<reported-path>...]`

Snapshot drift alone does not invalidate approval. Run the scoped diagnostic. Compare the current source to the user-visible plan. If the approved paths, behavior, structure, ownership, mechanics, and validation are unchanged, use the atomic route:

`wb git arc plan start -m <intent> [-m <description>] [--adopt <dirty-path>...] -- <path> [...]`

Do not return through Brief or ask for approval only because the snapshot or ref changed. If the plan changed, use ordinary `wb git arc plan`, return through Brief and Decision, then start it after approval.

After start, active-registry commands resolve this thread's current arc. Do not pass a ref to add, adopt, remove, compare, diff, or propose.

### Continue the arc

Before follow-up work on the same claimed files, run `arc continue` with the remembered ref. Proposal acceptance releases every clean claim immediately. When dirty work remains, acceptance creates a narrowed successor and continuation returns it from the remembered ref without resurrecting released claims.

When no dirty claims remain, continuation exits nonzero before generic HEAD-drift checks and prints all proposal IDs and commit SHAs under `Accepted commit proposals`. The receipt states that the arc is resolved with no live claims. When the approved plan is unchanged, run `wb git arc plan start -m <intent> -- <explicit-next-path> [...]`. When it changed, run `wb git arc plan -m <intent> -- <path> [...]` and return through approval. Legacy accepted arcs with historical claims fail closed and name those claims instead of guessing a successor.

`wb git arc continue --ref <current-ref>`

### Extend the active arc

After approval and continuation in Implement mode, run `arc add` only for new clean paths already named by the approved plan. Never use it during Brief or Decision to claim proposed files. It checks the claimed baseline and returns a successor. Remember the newest ref.

`wb git arc add -- <additional-clean-path> [<additional-clean-path>...]`

Use `arc adopt` only for existing dirty workspace paths that must join the active arc. It preserves their worktree and index content while creating a successor baseline.

`wb git arc adopt -- <dirty-path> [<dirty-path>...]`

### Move paths within the active arc

Use `arc mv` for approved path moves. It keeps the ordinary Git index unchanged, adds the minimal source and destination claims, and returns a successor ref that you must remember.

`wb git arc mv <source> <destination>`

`wb git arc mv <source>... <existing-destination-directory>`

`wb git arc mv --map <source> <destination> [--map <source> <destination>...]`

Regex mode previews at most 200 sorted mappings. Review the preview, repeat it with `--confirm`, then preview again when the command reports more matches.

`wb git arc mv --regex <pattern> --replace <replacement> -- <root> [<root>...]`

`wb git arc mv --confirm --regex <pattern> --replace <replacement> -- <root> [<root>...]`

### Remove clean claims

Run `arc remove` only when the active arc no longer owns exact claimed entries. Workbench rejects requested entries with working-tree changes, non-exact claims, incompatible HEAD movement, or changed committed content under retained claims. It changes no working-tree or index content.

When claims remain, the returned successor ref preserves the original snapshot tree, advances its parent to current `HEAD`, and stores the reduced claimed set. Removing the final clean claim creates a zero-claim `resolved` lifecycle entry. Resolved entries preserve proposal history, do not collide, and do not block settlement.

`wb git arc remove -- <claimed-path> [<claimed-path>...]`

An active claim prevents thread settlement. For a terminal thread, use **Unclaim files** when every claim is clean, or ask the user before **Restore & unclaim** when claimed work remains. Restore-and-unclaim restores only the active claimed paths before releasing the arc.

### Compare or diff the arc

Omit paths to inspect the claimed set. Explicit paths select diagnostics from the full snapshot. Use these commands only when the workflow explicitly requires arc-scoped change details, such as Review; do not use them as preflight for another arc command. Do not substitute the newest unrelated ref or guess from thread history.

For the initial Review inspection, choose one command. Use compare when changed paths and counts are enough. Use diff when unified details are already needed, and do not run compare first in that case. A later diff is valid when compare reveals that detailed inspection is needed. At least one of compare or diff is required before Review completion and proposal creation.

`wb git arc compare [-- <path> [<path>...]]`

`wb git arc diff [-- <path> [<path>...]]`

Use `wb git arc diff --ref <plan-ref> -- <reported-path> [...]` only for inactive or historical plan diagnostics owned by this thread.

### Propose a commit in Review

After validation and the required compare-or-diff inspection, run this command with a fresh title. Omit paths to use all changed claimed files. Provide paths only for a narrower subset. This opens the proposal UI and does not commit. Do not use `wb git commit`. A failure keeps Review open. Fix it and retry. If user input or an external change is required, use the blocked path. Do not use the final channel.

The proposal freezes that file set and its current contents. Ordinary proposals are independent and append their durable IDs to the current arc. The user can accept compatible disjoint proposals in either order. Overlapping pending proposals become unavailable after accepted history changes their selected paths.

`wb git arc propose -m <fresh-title> [-m <optional-description>] [-- <claimed-path> [<claimed-path>...]]`

Replace exactly one pending proposal atomically:

`wb git arc propose --replace <proposal-id> -m <replacement-title> [-m <replacement-description>] [-- <claimed-path>...]`

Rescind exactly one pending proposal:

`wb git arc rescind --proposal <proposal-id>`

Replacement and rescission reject a target that is already committed and direct the agent to targeted amend.

Use `wb git arc propose --amend <proposal-id> [-m <replacement-title> [-m <replacement-description>]]` to amend that exact committed proposal when it is an unpushed commit on the current branch's linear first-parent chain. Omit the proposal ID only for the compatible exact-current-`HEAD` form. Targeted amend reuses the history rewriter and remaps proposal IDs and commit SHAs, checkpoint refs, outcomes, retained arcs, and aliases atomically.

Proposal acceptance changes branch `HEAD`, proposal metadata, the ordered accepted receipt ledger, and live claims in one atomic publication. It creates an immutable active successor scoped to outstanding dirt, or changes the lifecycle to resolved when no dirty claims remain. Proposal IDs and excluded newer work remain preserved.

### Restore selected paths after explicit user request

First run the arc diff or another preview. Pass every file or directory to restore after `--`. After accepted proposals, restore uses the latest accepted branch tip, preserves accepted commits, and discards only outstanding uncommitted work. Restore-and-unclaim marks every pending proposal unavailable and leaves a zero-claim resolved lifecycle summary.

`wb git arc restore --ref <ref> -- <path> [<path>...]`

### Restore a full arc after explicit user request

Use the path form instead when only part of the worktree must be restored. Full restore uses an arc ref SHA supplied by the user or selected from the thread's arc output. The CLI requires `--confirm`, and Workbench blocks when the arc parent is not the current HEAD.

`wb git arc restore --ref <ref> --confirm`
