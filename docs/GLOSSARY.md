| Term | Definition |
|---|---|
| Workbench instructions | The project-owned prompt, workflow, injection, agent, and bundled skill Markdown sources under `instructions/`, mirrored into the Workbench Library by daemon-owned instruction code |
| Workbench Library | An external user-owned folder, defaulting to `~/.workbench`, that stores Workbench-wide skills, agents, and instruction material outside any selected project |
| Workbench Skill | A harness-neutral skill package surfaced to supported harnesses through a compact manifest that tells the harness when and where to read the full skill instructions. Workbench Skills can come from the Workbench Library or the selected project |
| Project Skill | A skill package stored inside the selected project and surfaced to supported harnesses for that project |
| Project Agent | An agent prompt stored inside `.agents/agents` in the selected project and surfaced in the composer agent selector for that project |
| Skill Load | The act of reading a skill's instruction file so the agent can apply that skill's workflow to the current task |
| thread state | Durable sidebar state owned by `WorkbenchThreadStateController`. It includes project thread and draft records, project display order, new-thread profile selection, home display order, and pinned layout |
| thread priority | Sidebar placement state: pinned, main, or snoozed. Settled is lifecycle, not priority. |
| thread attention | Amber when unsnoozed; purple when snoozed. Existing snooze wake rules apply. |
| thread display order | Durable manual ordering for pinned, snoozed, and settled sidebar sections. Main remains automatically ordered by claims, lifecycle, and activity. |
| dependent snooze | Durable thread state that wakes only when its target thread is completed and has no live Git claims. |
| profile | The exact composer settings snapshot held by a thread or draft. If tied to a stored profile, it also keeps that profile id |
| stored profile | A named reusable profile. A tied thread copies its latest settings whenever it starts a new turn |
| profile ribbon | The composer controls immediately to the left of the send button, regardless of their visual treatment |
| mosaic | A desktop-only Workbench route/view that renders a URL-encoded split tree of file and thread panels, separate from normal single file/thread routes so the single-route app shell and scroll behavior remain stable fallback paths |
| steer admittance | The point when Workbench or the underlying harness accepts a steer for an active turn. Admittance associates the steer with that turn, but does not mean that the running agent has received it in model context |
| steer delivery | The later point when an admitted steer is supplied to the running agent at an input boundary. Delivery makes the steer available to the agent's reasoning and can occur after a pending tool call completes |
| transcripts | Actual thread data instead of just the visible narrative. `wb transcript --help` for looking through them |
| logs | The persisted Workbench runtime logs under `.workbench/logs/`. Includes both orchestrator/daemon logs, and app server logs. |
| layered sort | A sort where each layer orders only ties from earlier layers. A user override replaces later layers within its slot. |
| daemon/orchestrator | The workbench harness, applied on top of existing harnesses. |
| orchestrator runner | The standalone supervisor process under `runner/`. It starts and stops the daemon, owns launcher logs and silence recovery, and may expose runner-only control HTTP. It imports shared contracts but never daemon implementation code. |
| codex app-server | Codex's harness. |
| provider | A harness integrated by Workbench, such as Codex, OpenCode or Copilot. Provider and harness are interchangeable here; Workbench is the enclosing harness. |
| app | Sometimes "app server". NOT "codex app-server", which is codex's harness. May be referring to the backend or frontend of a workbench *app*. The backend has thin responsibilities related to serving the SPA, providing the tray features, and storing settings. The frontend is thinner, solely responsible for rendering and interaction. |
| Git transition | A worktree-keyed shared-read/exclusive-write lease that coordinates Git arc and thread-state decisions across reload generations |
| workspace search | Full-screen command/search dialog backed by SQLite rows and projections for projects, current-project settings/files, threads, and registered actions. |
| usage stats | Durable Workbench usage facts and bounded global/project aggregates for tokens, estimated API cost, account rate limits, and claim traffic; missing facts hydrate into SQLite from retained Workbench journals, never provider history APIs; import state, checkpoints, and reads remain SQLite-owned |
| claim traffic | Distinct managed threads whose active Git arc checkpoints declared each file in a selected period; directory scopes expand to contained files, including unchanged files, while inactive plan scope does not count. Unambiguous committed rename chains within one root combine under their latest path; reused names remain separate. |
