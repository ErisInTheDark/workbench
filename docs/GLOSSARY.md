| Term | Definition |
|---|---|
| Workbench instructions | The project-owned prompt, workflow, injection, agent, and bundled skill Markdown sources under `instructions/`, mirrored into the Workbench Library by daemon-owned instruction code |
| Workbench Library | An external user-owned folder, defaulting to `~/.workbench`, that stores Workbench-wide skills, agents, and instruction material outside any selected project |
| Workbench data root | Per-user OS data directory resolved by `resolveWorkbenchDataRoot`, overridable with `WORKBENCH_DATA_ROOT`. Distinct from the user-editable Workbench Library. |
| Workbench Skill | A harness-neutral skill package surfaced to supported harnesses through a compact manifest that tells the harness when and where to read the full skill instructions. Workbench Skills can come from the Workbench Library or the selected project |
| Project Skill | A skill package stored inside the selected project and surfaced to supported harnesses for that project |
| Project Agent | An agent prompt stored inside `.agents/agents` in the selected project and surfaced in the composer agent selector for that project |
| Local Overlay | Gitignored `.agents.local` beside a project's `.agents`; its `skills/<name>/` replace same-named skills at every layer and its `agents/<name>.md` replace same-named project agents. `<name>.tombstone` in either folder hides `<name>` from the project |
| Skill Load | The act of reading a skill's instruction file so the agent can apply that skill's workflow to the current task |
| Active Skill | A skill recorded for one thread after user activation or agent Skill Load, until the user deactivates it |
| Keyed delta | Upserted/removed items plus changed field names against an observation's previous revision; see `shared/workbench/workspace/observation-patch.ts` |
| thread status row | Row under a thread's transcript: live title plus skills, vis, Git arc and todo pills, each opening one shared animated panel area; `ThreadStatusRow`, composed by `ThreadStatusArea` |
| activity card (activity run card, activity card status) | Tinted transcript card summarising consecutive agent work (reasoning, commands, edits, searches, sleeps) as counted chips plus duration; opens into its steps. Its status, while live, is the step actually running (else the last done) drawn as its own row under the chips. A lone step shows bare instead; `ThreadActivityRun` |
| thread state | Durable daemon thread state owned by `WorkbenchThreadStateController`: thread records, new-thread profile selection, legacy drafts and legacy project display order. Pins, snoozes, folders and layout are app presentation state |
| thread priority | App-owned sidebar placement: pinned, main, or snoozed. Settled is lifecycle, not priority. |
| arc edit session | Per-thread previewable, revertible batch of ordered moves/regex replacements run via `wb git arc edit`; claims Git-visible touched files in the active arc; stored at the thread's `edit-session` ref |
| thread attention | Amber when unsnoozed; purple when snoozed. Existing snooze wake rules apply. |
| thread display order | Durable manual ordering for pinned, snoozed, and settled sidebar sections. Main remains automatically ordered by claims, lifecycle, and activity. |
| dependent snooze | App-owned thread state containing one or more target threads on any daemon. Each target clears only after completion with no live Git claims. The source wakes when none remain. |
| profile | Composer settings plus optional stored-profile id. Saved settings provide a fallback, not a frozen composer preview |
| stored profile | Named reusable settings. Linked composers and new turns resolve its current definition |
| profile ribbon | The composer controls immediately to the left of the send button, regardless of their visual treatment |
| steer admittance | The point when Workbench or the underlying harness accepts a steer for an active turn. Admittance associates the steer with that turn, but does not mean that the running agent has received it in model context |
| steer delivery | The later point when an admitted steer is supplied to the running agent at an input boundary. Delivery makes the steer available to the agent's reasoning and can occur after a pending tool call completes |
| held steer | An admitted steer awaiting delivery (pending) or never delivered (undelivered). Stored outside the transcript and shown as an overlay at the thread bottom until delivered, dismissed, or resent |
| compaction queue | User messages sent while a thread compacts. Held as pending steers on the latest turn, delivered as one merged message when compaction ends |
| virtual steer | Pending held steer on an ended turn while its thread holds a pending questionnaire. Never sent to the provider; delivered after the answer in the continuation's first user message |
| transcripts | Actual thread data instead of just the visible narrative. `wb transcript --help` for looking through them |
| history index | FTS index over transcript item text and retained narrative; serves Thread Recall, wb transcript and workspace search; `WorkbenchHistoryIndex` |
| workbench item | A transcript item Workbench records itself (compaction, steers, user vis ends) via a `kind: "item"` observation with `source: "workbench"`. Non-core types store as generic payloads and render through `thread-generic-item-matchers.ts` |
| layered sort | A sort where each layer orders only ties from earlier layers. A user override replaces later layers within its slot. |
| daemon | The Workbench harness, applied on top of existing harnesses. Server source lives in `daemon/server/`. |
| daemon host | Lightweight service under `daemon/host/`. Owns networking, durable daemon identity and supervised daemon startup independently of the app. |
| daemon project | A daemon's own catalogue entry (`kind: "daemon"`), rooted at a hidden Workbench workspace folder; threads read anywhere, edit machine files through machine Git arc roots, and escalate outside the sandbox through the thread's approval mode |
| machine Git arc root | Daemon-project Git arc root over a filesystem root (`C:/`, `/`), backed by a Workbench-internal Git dir; agents see absolute paths, raw Git sees no repository |
| approval mode | Per-thread daemon-project policy for outside-sandbox requests: approvals on, skip approvals, or auto-approve via the selected reviewer; stored beside the profile selection |
| codex app-server | Codex's harness. |
| provider | A harness integrated by Workbench, such as Codex, OpenCode or Copilot. Provider and harness are interchangeable here; Workbench is the enclosing harness. |
| provider runtime | Workbench-installed Claude Code or OpenCode executable pinned to the checkout's SDK version, under the data root; installed from Settings › Agents › Providers. |
| app | Sometimes "app server"; not the Codex harness. App server owns SPA serving, app-local state, cross-daemon workspace subscriptions and routing. Daemons own local data and execution; browser owns rendering and interaction. |
| Git transition | A worktree-keyed shared-read/exclusive-write lease that coordinates Git arc and thread-state decisions across reload generations |
| active claim | A thread’s current editable file ownership. It may overlap the thread’s baseline claims. |
| baseline claim | A collision guard for a path represented by the thread’s pending sealed proposals. It is hidden from default status and ends only when no pending layer or transferred owner still guards the path. |
| stack layer | Titled seal of a thread's pending Git arc proposals; its synthetic tip commit becomes the arc baseline for later work. |
| workspace search | Full-screen command/search dialog grouping ranked threads, current-project files/settings, projects and registered actions into sections; thread text comes from the writer connection's FTS narrative index (`WorkbenchSearchNarrativeIndex`). |
| usage stats | Durable Workbench usage facts and bounded global/project aggregates for tokens, estimated API cost, account rate limits, and claim traffic; missing facts hydrate into SQLite from retained Workbench journals, never provider history APIs; import state, checkpoints, and reads remain SQLite-owned |
| agent feedback | Agent-submitted friction report (channel `wb`/`project`, category `bug`/`waste`/`confusion`/`opportunity`) stored with the author's model and effort; importance is computed on read from the hand-maintained trust registry `daemon/server/stats/feedback-model-trust.ts`; shown in usage stats and `wb stats feedback`; resolved reports leave agent reads and stay in the stats Resolved view for 7 days before retention deletes them |
| claim traffic | Distinct managed threads whose active Git arc checkpoints declared each file in a selected period; directory scopes expand to contained files, including unchanged files, while inactive plan scope does not count. Unambiguous committed rename chains within one root combine under their latest path; reused names remain separate. |
| questionnaire | A form delivered to the user via request_user_input, appearing within the same UI as the composer |
| approval questionnaire | A questionnaire form shown due to an agent attempting to escalate a tool call outside the sandbox. |
| interrupt | Ends the live turn but keeps its pending questionnaire; the thread needs attention. |
| stop | Interrupts the live turn, dismisses its pending questionnaire and sets status to stopped. |
| held questionnaire | A questionnaire form that is no longer attached to a request_user_input tool call due to an interruption; the thread is stopped, but the form remains answerable by the user. (Response admitted via normal user message) |
| mark tag | Suggest-mode review label on words, saved as `<u data-mark="name">`; names, colours and Alt+digit order come from the `markTags` setting, global with logical-project overrides |
| tool docs | `<docs tools="a b">` instruction regions for specific wb tools; render only when a listed tool is visible to the caller; Stats → Tools charges their tokens evenly to those tools |
| MCP server | User-configured external MCP server (http, npm or cli), global or scoped to one project; agents reach its allowed tools only through `mcp_tools`/`mcp_call`, identically across providers |
| thread MCP server | MCP server URL an agent connected with `mcp_connect` after user approval; only its thread sees it, until the turn ends |
