| Term | Definition |
|---|---|
| Workbench instructions | The project-owned prompt, workflow, injection, agent, and bundled skill Markdown sources under `instructions/`, mirrored into the Workbench Library by daemon-owned instruction code |
| Workbench Library | An external user-owned folder, defaulting to `~/.workbench`, that stores Workbench-wide skills, agents, and instruction material outside any selected project |
| Workbench Skill | A harness-neutral skill package surfaced to supported harnesses through a compact manifest that tells the harness when and where to read the full skill instructions. Workbench Skills can come from the Workbench Library or the selected project |
| Project Skill | A skill package stored inside the selected project and surfaced to supported harnesses for that project |
| Project Agent | An agent prompt stored inside `.agents/agents` in the selected project and surfaced in the composer agent selector for that project |
| Skill Load | The act of reading a skill's instruction file so the agent can apply that skill's workflow to the current task |
| Active Skill | A skill recorded for one thread after user activation or agent Skill Load, until the user deactivates it |
| Keyed delta | Upserted/removed items plus changed field names against an observation's previous revision; see `shared/workbench/workspace/observation-patch.ts` |
| thread state | Durable sidebar state owned by `WorkbenchThreadStateController`. It includes project thread and draft records, project display order, new-thread profile selection, home display order, and pinned layout |
| thread priority | Sidebar placement state: pinned, main, or snoozed. Settled is lifecycle, not priority. |
| thread attention | Amber when unsnoozed; purple when snoozed. Existing snooze wake rules apply. |
| thread display order | Durable manual ordering for pinned, snoozed, and settled sidebar sections. Main remains automatically ordered by claims, lifecycle, and activity. |
| dependent snooze | Durable thread state containing one or more target threads. Each target clears only after completion with no live Git claims. The source wakes when none remain. |
| profile | Composer settings plus optional stored-profile id. Saved settings provide a fallback, not a frozen composer preview |
| stored profile | Named reusable settings. Linked composers and new turns resolve its current definition |
| profile ribbon | The composer controls immediately to the left of the send button, regardless of their visual treatment |
| mosaic | A desktop-only Workbench route/view that renders a URL-encoded split tree of file and thread panels, separate from normal single file/thread routes so the single-route app shell and scroll behavior remain stable fallback paths |
| steer admittance | The point when Workbench or the underlying harness accepts a steer for an active turn. Admittance associates the steer with that turn, but does not mean that the running agent has received it in model context |
| steer delivery | The later point when an admitted steer is supplied to the running agent at an input boundary. Delivery makes the steer available to the agent's reasoning and can occur after a pending tool call completes |
| held steer | An admitted steer awaiting delivery (pending) or never delivered (undelivered). Stored outside the transcript and shown as an overlay at the thread bottom until delivered, dismissed, or resent |
| transcripts | Actual thread data instead of just the visible narrative. `wb transcript --help` for looking through them |
| logs | Persisted daemon and app server logs under `.workbench/logs/`. |
| socket spy | `wb socket spy`: search recent daemon and app WebSocket frames held in memory, or print one frame's exact payload. |
| layered sort | A sort where each layer orders only ties from earlier layers. A user override replaces later layers within its slot. |
| daemon | The Workbench harness, applied on top of existing harnesses. Server source lives in `daemon/server/`. |
| daemon host | Lightweight service under `daemon/host/`. Owns networking, durable daemon identity and supervised daemon startup independently of the app. |
| codex app-server | Codex's harness. |
| provider | A harness integrated by Workbench, such as Codex, OpenCode or Copilot. Provider and harness are interchangeable here; Workbench is the enclosing harness. |
| app | Sometimes "app server"; not the Codex harness. App server owns SPA serving, app-local state, cross-daemon workspace subscriptions and routing. Daemons own local data and execution; browser owns rendering and interaction. |
| Git transition | A worktree-keyed shared-read/exclusive-write lease that coordinates Git arc and thread-state decisions across reload generations |
| workspace search | Full-screen command/search dialog backed by SQLite rows and projections for projects, current-project settings/files, threads, and registered actions. |
| usage stats | Durable Workbench usage facts and bounded global/project aggregates for tokens, estimated API cost, account rate limits, and claim traffic; missing facts hydrate into SQLite from retained Workbench journals, never provider history APIs; import state, checkpoints, and reads remain SQLite-owned |
| claim traffic | Distinct managed threads whose active Git arc checkpoints declared each file in a selected period; directory scopes expand to contained files, including unchanged files, while inactive plan scope does not count. Unambiguous committed rename chains within one root combine under their latest path; reused names remain separate. |
| questionnaire | A form delivered to the user via request_user_input, appearing within the same UI as the composer |
| approval questionnaire | A questionnaire form shown due to an agent attempting to escalate a tool call outside the sandbox. |
| interrupt | Ends the live turn but keeps its pending questionnaire; the thread needs attention. |
| stop | Interrupts the live turn, dismisses its pending questionnaire and sets status to stopped. |
| held questionnaire | A questionnaire form that is no longer attached to a request_user_input tool call due to an interruption; the thread is stopped, but the form remains answerable by the user. (Response admitted via normal user message) |
