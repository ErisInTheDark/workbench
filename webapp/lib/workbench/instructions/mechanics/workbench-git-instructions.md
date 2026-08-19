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

Workbench stores agent workflow baselines as real local Git commit objects under hidden per-worktree refs. A plan creates the one baseline for an arc; starting the arc does not create another ref.

This thread's checkpoint namespace is owned by Workbench and scoped to the current Git worktree:

```text
refs/worktree/agents/{{thread.id}}/checkpoints
```

Plan and arc refs are convenience state, not a security boundary. Do not use them to store secrets unless the repo state is already allowed to contain those secrets.

Use these exact CLI shapes so Workbench can match and render checkpoint operations. Workbench owns the Git plumbing and uses a temporary index internally, so agents should not run raw `git update-ref` checkpoint scripts themselves.

Plans snapshot the full Git-visible worktree as structurally shared Git objects. They do not copy the workspace. Unchanged blobs and trees are reused; only changed and non-ignored untracked content creates new objects. The stored claimed paths select ordinary arc operations; they are not the snapshot's storage scope.

When an arc command is the required workflow step, run it directly and let it accept or reject the current state. Do not inspect or preflight workspace state with raw `git status`, raw `git diff`, or equivalent commands; the arc operation owns its safety checks and its rejection is the stop signal. Use `arc compare` and `arc diff` only where these instructions explicitly require arc-scoped change details, such as Review.

### Create the plan

Run after entering Brief mode once the exact planned edit files are known. Give the changeset a short intent name, add a second `-m` only when a description helps sibling agents judge overlap, and name every planned path. Workbench requires those paths to be clean against current `HEAD`, then creates an inactive full-worktree snapshot. Keep the returned ref SHA for `arc start`, `arc continue`, and explicit restore.

`wb git arc plan -m <short-intent> [-m <optional-description>] -- <path> [<path>...]`

If Workbench rejects a dirty planned path, stop and ask the user what changed; include **Committed — the workspace should now be clean, try again** as an option. Never clean, restore, or stage paths to bypass this guard.

### Start implementation

The first time an inactive plan enters Implement mode, run `arc start` directly to inspect its paths and activate their claims. This command creates no ref. It rejects changed planned paths, overlap with active sibling arcs, and a settled owner thread. Treat rejection as the stop signal instead of preflighting it with another workspace-state command. Do not rerun `arc start` when returning to an implementation arc that is already active; run `arc continue --ref <current-ref>` directly before another implementation pass.

`wb git arc start --ref <plan-ref>`

After start, active-registry commands resolve this thread's current arc. Do not pass a ref to add, adopt, remove, compare, diff, or propose.

### Continue the arc

Before follow-up work on the same claimed files, run `arc continue` with the remembered ref. Do not ask whether a proposal was committed. The command resolves that state. Use its returned successor. Partial commits keep all claims. Use `arc remove` to release clean paths. Do not commit a known-bad proposal. If committed state moved, re-inspect and create a new plan. If it reports a claim collision, ask the user to reply with **Claim released — retry the approved plan**. That reply preserves approval. Retry the arc command. Continue Implement if it succeeds and the approved plan still fits. Rebrief only if the retry finds a plan-affecting change. For any other rejection, stop and follow the reported recovery.

`wb git arc continue --ref <current-ref>`

### Extend the active arc

After continuation, run `arc add` only for new clean paths. It checks the claimed baseline and returns a successor. Remember the newest ref.

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

When claims remain, the returned successor ref preserves the original snapshot tree, advances its parent to the accepted current `HEAD`, and stores the reduced claimed set. Record that ref for a later `arc continue`. Removing the final clean claim releases the arc and leaves no active successor.

`wb git arc remove -- <claimed-path> [<claimed-path>...]`

An active claim prevents thread settlement. For a terminal thread, use **Unclaim files** when every claim is clean, or ask the user before **Restore & unclaim** when claimed work remains. Restore-and-unclaim restores only the active claimed paths before releasing the arc.

### Compare or diff the arc

Omit paths to inspect the claimed set. Explicit paths select diagnostics from the full snapshot. Use these commands only when the workflow explicitly requires arc-scoped change details, such as Review; do not use them as preflight for another arc command. Do not substitute the newest unrelated ref or guess from thread history.

`wb git arc compare [-- <path> [<path>...]]`

`wb git arc diff [-- <path> [<path>...]]`

### Propose a commit in Review

After validation and arc compare/diff, run this command with a fresh title. Omit paths to use all changed claimed files. Provide paths only for a narrower subset. This opens the proposal UI and does not commit. Do not use `wb git commit`. A failure keeps Review open. Fix it and retry. If user input or an external change is required, use the blocked path. Do not use the final channel.

The proposal freezes that file set and its current contents. The user can include or exclude newer edits to those same files; no other files can enter the proposal. Workbench rebases the frozen selected files across compatible fast-forward commits that do not change them. Committed changes to selected files or incompatible HEAD movement make the proposal unavailable. A final atomic branch update prevents a concurrent commit from being overwritten.

`wb git arc propose -m <fresh-title> [-m <optional-description>] [-- <claimed-path> [<claimed-path>...]]`

Use `wb git arc propose --amend [-m <replacement-title> [-m <replacement-description>]]` only to amend the exact current unpushed `HEAD`. Without `-m`, the proposal inherits the existing commit message. Detached `HEAD`, pushed commits, or unknown remote state reject.

### Restore selected paths after explicit user request

First run the arc diff or another preview. Pass every file or directory to restore after `--`; Workbench restores only those paths from the specified arc snapshot, removes selected paths that were created after it, and leaves the real Git index unchanged. The repository root is not a valid selected path. Compatible fast-forward commits to unrelated paths do not block selected-path restore. Workbench blocks when selected committed content no longer matches the arc baseline or HEAD moved incompatibly.

`wb git arc restore --ref <ref> -- <path> [<path>...]`

### Restore a full arc after explicit user request

Use the path form instead when only part of the worktree must be restored. Full restore uses an arc ref SHA supplied by the user or selected from the thread's arc output. The CLI requires `--confirm`, and Workbench blocks when the arc parent is not the current HEAD.

`wb git arc restore --ref <ref> --confirm`

