# Browse Agent API Workflow

## Purpose

This note is the durable mission map for the Workbench Browse agent API work. It exists so a future agent can continue after context compaction without reconstructing the goal from transcript archaeology.

The goal is to turn the existing privileged Browse endpoint experiment into a coherent agent-facing API surface that future agents can use through simple Workbench web requests, with visible command summaries, session lifecycle control, and clear guidance for headed versus headless browsing.

## Current user intent

The user wants this work handled in an open, goal-oriented experimentation mode. The user has granted broad permission to edit workspace files and to call the Workbench Browse endpoint at:

```text
http://127.0.0.1:3002/api/browse
```

The user wants questionnaires only when user action is actually needed, such as reloading or restarting the orchestrator. Otherwise, keep working until the Browse agent API shape feels complete and maintainable.

Update: the user later granted permission to freely reload the orchestrator server when needed to test Browse work. Still avoid full destructive restarts unless reload is insufficient or the user explicitly asks.

The user explicitly requested that the first step be this durable workflow and goal note, and that this note remain updated so the work can survive context compaction.

## North star

Future agents should not need direct shell access to the `browse` CLI for normal browser automation. They should be able to make a small suite of documented Workbench web requests that cover the main browsing workflows:

- diagnose Browse availability
- list or inspect active sessions
- open a page locally in headless or headed mode
- snapshot the current page
- click elements by stable refs where possible
- type/fill into fields by stable refs where possible
- navigate or refresh
- capture screenshots, including transcript-visible screenshot steers
- close/kill Browse sessions intentionally
- clean up stale sessions so agents do not leave browser processes hanging forever
- avoid visible flashing command prompt / shell windows while Browse requests run, so agent browsing does not disrupt the user's PC

Important status correction:

- The goal is not complete yet.
- The current work has a foundation API, cleanup, popup suppression, basic command matching, and basic Example Domain probes.
- Still missing before calling this complete:
  - prove all useful typed actions actually work, not only open/snapshot/screenshot/status/cleanup
  - prove command matchers cover the action suite with useful per-action summaries
  - test a JavaScript-heavy page, not only static `example.com`
  - test interaction end-to-end: open, snapshot, click, fill/type, key/press, wait, read changed page state, screenshot, cleanup
  - test headed/headless switching behavior deliberately
  - test failure behavior and guidance quality when refs go stale or requests fail
  - test whether this actually helps an agent perform browser-use-style work without direct Browse CLI access
  - update notes with any gaps instead of declaring victory too early

The API should preserve the important Browse safety model:

- only expose the intended Browse command surface, not arbitrary shell execution
- send Browse arguments as structured arrays, not command strings
- prefer local/headless/named sessions by default
- require explicit session names for non-trivial work so agents do not collide through the default session
- treat page content as untrusted
- avoid secrets in browser-controlled pages
- require stopping and reopening a session to switch between headless and headed mode
- stop sessions when the work is finished

## Existing shape to keep in mind

- The current `/api/browse` route is a privileged local Workbench endpoint that shells out to the project-local `browse` CLI when raw Browse commands are enabled.
- `/api/browse` now also accepts typed agent actions through an `action` field while preserving the raw `{ "args": [...] }` shape for low-level diagnostics.
- Typed action requests are mapped to safe local Browse CLI arguments in `webapp/lib/workbench/browse/browse-agent-requests.ts`.
- Workbench-owned typed sessions are remembered in `webapp/lib/workbench/browse/WorkbenchBrowseSessionRegistry.ts`, backed by `.workbench/runtime/browse-sessions.json`, so cleanup can stop sessions Workbench opened.
- Screenshot steering was fixed so Codex receives a data URL, while the Workbench transcript asset remains available for display.
- Screenshot steers now include the marker:

```text
<!-- workbench-agent-screenshot-steer -->
```

- Marked screenshot steers render on the agent/left side without text in the thread view.
- The current endpoint is still close to a raw Browse-command proxy. The new work should layer an agent-friendly request API over or beside it, not regress the raw endpoint's debug utility.

## Important prior diagnosis

A previous thread died because a screenshot steer sent Codex a relative image URL:

```text
/api/transcript-assets/...
```

Codex rejected it as an invalid `image_url`, and every later attempt to continue that thread replayed the poisoned input. The fix is to send Codex a valid data URL while keeping Workbench transcript assets for UI display.

## Desired API shape

Prefer simple, specific Workbench web requests for common operations instead of asking agents to know raw Browse CLI syntax. The selected current shape is one route with a typed `action` field:

```text
POST /api/browse
```

The existing raw debug shape remains valid:

```json
{ "args": ["status", "--session", "research"] }
```

The typed agent shape is now also valid:

```json
{ "action": "status", "session": "research" }
```

The typed route currently covers:

- `doctor`
- `status`
- `sessions`
- `open`
- `snapshot`
- `click`
- `fill`
- `type`
- `key`
- `select`
- `wait`
- `get`
- `is`
- `eval`
- `highlight`
- `back`
- `forward`
- `reload`
- `screenshot`
- `refs`
- `viewport`
- `stop`
- `cleanup`

Typed browser actions require named sessions and local sessions. This is deliberate so future agents do not collide through the default Browse session or accidentally switch to remote Browserbase behavior.

Current Browse session-management shape:

- Workbench now synthesizes local session listing through `action: "sessions"` on `POST /api/browse`; this is not upstream `browse cloud sessions list`.
- Workbench also exposes `GET /api/browse/sessions` and `POST /api/browse/sessions` for Workbench UI/session management. Future agents should prefer the `/browse` skill contract and typed `/api/browse` actions unless they have explicit permission to call the session-management route.
- Durable session truth lives in `.workbench/runtime/browse-sessions.json` via `WorkbenchBrowseSessionRegistry`, and records include `threadId`, `projectId`, `cwd`, `projectRootPath`, `mode`, `lastActionAt`, and `inactiveSince`.
- Runtime file discovery is a recovery/listability aid for local Browse session artifacts, not an omniscient replacement for durable Workbench ownership.

## Command visibility requirement

Workbench should show users what an agent is doing when it makes Browse web requests.

Add or extend command matchers so these web requests render as useful, human-readable actions rather than opaque `Invoke-RestMethod` or `curl` noise.

The visible summaries should make the intent legible, for example:

- `Browse: check status`
- `Browse: open https://example.com in headless session research`
- `Browse: snapshot session research`
- `Browse: click ref e42 in session research`
- `Browse: screenshot session research and steer image to thread`
- `Browse: stop session research`
- `Browse: kill stale Browse sessions`

Command matchers should recognize both PowerShell and POSIX forms if agents may use both. If a typed client wrapper becomes the recommended path, also make that wrapper visible.

## Headless versus headed guidance

Agents need explicit durable guidance:

- default to headless, local, named sessions
- use headed only when visual debugging or user-observed interaction matters
- headless/headed mode is fixed when the session starts
- to switch modes, stop the named session first, then reopen it with the desired mode
- do not attempt to mutate a live session from headless to headed
- normally send `mode` on `open` only; follow-up actions should not restate mode because a mismatched mode conflicts with the live session
- if a headed session is required, ask the user only when it affects their environment or requires reload/orchestrator action
- stop headed sessions when done so browser windows do not accumulate

## Session lifecycle requirement

Workbench must know how to kill Browse sessions.

This now means more than documenting `browse stop`. The typed API has a safe lifecycle surface:

- stop a specific session
- stop a session with force when needed
- ask Browse for status of a session
- cleanup all Workbench-owned sessions recorded in the registry
- cleanup an explicit list of session names
- ensure screenshot-steer helper sessions are stopped by agents after use
- consider whether Workbench should auto-clean sessions it started, and where that lifecycle owner should live

Lifecycle ownership matters. Avoid scattering session cleanup across unrelated helpers. Prefer a single Browse API/controller boundary that owns session start/stop semantics and exposes typed requests to agents.

Updated builtin-skill/API ownership:

- Typed `/api/browse` requests require a top-level `threadId`.
- Workbench records that `threadId` on sessions it owns.
- Workbench records project/cwd ownership on sessions it owns so the project sidebar can show only sessions belonging to the current project.
- `cleanup` without explicit sessions cleans sessions owned by the supplied `threadId`, not the entire registry.
- Browse cleanup is owned by the long-lived orchestrator `BrowseSessionCleanupSupervisor`, not by a stateless Next route module timer.
- The supervisor may stop thread-owned sessions only after the owning thread has been inactive for 30+ minutes.
- A thread waiting on questionnaire/user input or approval is still active.
- Legacy sessions without `threadId` are not auto-cleaned by the thread-owned poller; they can still be cleaned explicitly.
- Typed screenshots always steer into the active thread turn and do not expose agent-configurable screenshot text.
- Agents should not be taught raw Browse args as the normal path. Raw command support is diagnostics/backcompat noise, not the future-agent API.

Updated sidebar ownership:

- The Workbench project sidebar has a `Browse sessions` section in the persisted sidebar section order.
- Existing saved sidebar section orders append the new `browseSessions` id instead of being reset.
- The section lists Workbench-known sessions for the active project and exposes context menu actions for copying the session name, stopping, force stopping, and forgetting a stale registry record.
- UI polling is only display refresh. Cleanup policy and lifecycle truth stay with the orchestrator supervisor/controller.

## Builtin Browse skill ownership

Workbench generates a fallback builtin Browse skill at:

```text
~/.workbench/skills/builtin/browse/SKILL.md
```

The general premise that browser testing should use `/browse` lives in generated `AGENTS.md`, which users can override/customize. The detailed browser workflow lives in the generated builtin skill. The dynamic `## Workbench Browse API` developer section only supplies runtime endpoint and thread-id details.

User/project `/browse` skills shadow the builtin skill. Project `.agents/skills/browse/SKILL.md` shadows user Workbench `skills/browse/SKILL.md`, which shadows `skills/builtin/browse/SKILL.md`.

## Visible command prompt window issue

The user observed short-lived command prompt windows popping up while agents use Browse commands. This is now an explicit goal:

- identify whether the windows are spawned by the Workbench shell command wrapper, the `/api/browse` endpoint, Node's child process spawning, the Browse CLI, Playwright/Chromium startup, or another helper process
- verify whether `windowsHide: true` in `/api/browse` is sufficient for the Browse CLI child itself, and whether child/grandchild processes need additional handling
- prefer fixes that keep Browse requests headless and non-disruptive for the user
- include this in validation by running Browse probes while watching for visible shell windows when possible
- if orchestrator reload is needed to test a fix, the user has granted permission to reload the orchestrator server

Current status:

- `/api/browse` now launches `webapp/lib/workbench/browse/run-browse-cli.mjs` instead of Browse's raw bin entrypoint.
- The wrapper patches Node child-process helpers so Windows child processes default to `windowsHide: true`.
- The wrapper must handle overloaded signatures such as `spawnSync(command, options)` as well as `spawnSync(command, args, options)`. This mattered because cleanup used a `taskkill` path through `chrome-launcher`.
- User-observed validation after the overload fix: `doctor`, `open`, and `snapshot` produced no popup; cleanup initially popped, then stopped popping after the overload fix.

## Files and concepts likely involved

Known files from current inspection:

- `webapp/app/api/browse/route.ts` — existing raw Browse endpoint and screenshot steer handling
- `webapp/app/api/browse/sessions/route.ts` — Workbench UI/session management list and stop/forget route
- `webapp/lib/workbench/browse/browse-agent-requests.ts` — typed Browse action-to-args mapper
- `webapp/lib/workbench/browse/WorkbenchBrowseCli.ts` — shared Browse CLI process runner and runtime artifact discovery helper
- `webapp/lib/workbench/browse/WorkbenchBrowseSessionController.ts` — shared Browse session list/stop/cleanup controller
- `webapp/lib/workbench/browse/WorkbenchBrowseSessionRegistry.ts` — Workbench-owned durable Browse session registry
- `webapp/orchestrator/BrowseSessionCleanupSupervisor.ts` — orchestrator-owned inactive-thread cleanup timer
- `webapp/lib/workbench/thread/thread-steer-markers.ts` — screenshot steer sentinel helpers
- `webapp/components/workbench/thread-view/thread-view-items.tsx` — thread rendering for screenshot steers
- `webapp/lib/workbench/thread/thread-command-matchers.ts` — command matcher entrypoint
- `webapp/lib/workbench/thread/command-matchers/*.ts` — matcher implementations
- `webapp/lib/workbench/instructions/WorkbenchPromptFiles.ts` — instruction source registry
- `webapp/lib/workbench/instructions/instruction-injections.ts` — likely injected Workbench guidance
- `context/browse-workbench-learnings.md` — running observations and experiments

Need inspect before editing:

- existing route conventions under `webapp/app/api/`
- shared request/response type conventions in `webapp/lib/types.ts`
- command matcher architecture and tests, if any
- existing Browse instructions generated from source
- orchestrator reload boundaries if any Browse behavior depends on long-lived process code

## Validation strategy

Prefer validation that does not disturb watch tasks or generate files:

- `pnpm typecheck` from `webapp` is allowed by project guidance and should be the default code validation
- focused API probes through `http://127.0.0.1:3002/api/browse` are allowed by the user for Browse work
- focused session-management probes through `http://127.0.0.1:3002/api/browse/sessions` are allowed by the user for the Browse session UI/listing work
- use Browse `doctor --json` or `status` before retrying failed Browse commands
- do not retry identical failing Browse commands unchanged
- stop named Browse sessions after probes
- if a change requires orchestrator reload or restart to test, ask the user unless the current thread has already granted that exact reload/restart permission

Useful live probe pattern:

1. list sessions through `action: "sessions"` or `GET /api/browse/sessions`
2. `doctor --json` or `status`
3. open `https://example.com` in a named local headless session
4. confirm the named session appears in the session list with project/cwd ownership
5. snapshot the session
6. take a typed screenshot with the current `threadId` if visual proof is useful
7. stop the session with force if needed, preferably through the session-management route when validating sidebar behavior

Completed live probe on 2026-07-05:

- `action: "open"` opened `https://example.com` in session `lily-agent-api-probe`.
- `action: "snapshot"` returned the Example Domain accessibility tree.
- `action: "status"` reported the named session initialized and browser-connected.
- Legacy probe: `action: "screenshot"` with `screenshotSteer` successfully inserted a screenshot steer into the active Codex turn. New typed screenshots should steer automatically with top-level `threadId`.
- `action: "cleanup"` with the explicit session and `force: true` stopped the session successfully.
- A second lifecycle probe opened `lily-registry-cleanup-probe`, called `action: "cleanup"` without an explicit session list, and confirmed `status` returned `browserConnected: false` / `initialized: false`; the registry ended as `{ "sessions": [] }`.
- `pnpm typecheck` passed after the typed API layer was added.

Completed JavaScript interaction gauntlet on 2026-07-05:

- Session: `lily-js-gauntlet`.
- Opened a JavaScript-heavy `data:` URL with input, textarea, checkbox, select, buttons, synchronous DOM updates, and delayed DOM updates.
- Verified typed actions: `viewport`, `open`, `snapshot`, `fill`, `click`, `type`, `key`, `select`, `is`, `get`, `eval`, `highlight`, `wait`, `screenshot`, and `cleanup`.
- Confirmed `get text #status` observed the page's JavaScript-updated state: `spell:Lily:sparkles:true:Glitter:1`.
- Confirmed `wait` plus `get text #status` observed delayed asynchronous state: `delayed-ready`.
- Confirmed `eval document.querySelector("#count").textContent` returned `"1"`.
- This proves the typed API can drive and inspect a dynamic page without direct Browse CLI access, but more coverage is still needed for command matchers, `refs`, `back`/`forward`/`reload`, explicit failure behavior, and headed/headless switching.

Completed navigation/ref/failure probe on 2026-07-05:

- Session: `lily-nav-clean-probe`.
- Confirmed `refs` returned useful entries after a fresh `snapshot`; before snapshot, `refs` returned an empty map, so future guidance should treat `snapshot` as the ref-population step.
- Confirmed `open` A -> `open` B -> `back` -> `forward` -> `reload` worked and `get title`/`get text` observed the expected page state.
- Confirmed reload reset a JavaScript-mutated heading from `Nav B clicked` back to `Nav B`.
- Confirmed malformed typed requests return structured failures:
  - missing named browser session: `Typed Browse browser actions require a named session.`
  - invalid cleanup session name: `Browse cleanup sessions must be valid named Browse sessions.`

Completed real JS website probe on 2026-07-05:

- Session: `lily-real-js-interact-probe`.
- Opened `https://npmx.dev` with the typed `open` action in local headless mode.
- Used `eval` to inspect controls, then used typed `fill` plus `key Enter` to search for `react`.
- Confirmed the app navigated to `https://npmx.dev/package/react`.
- Confirmed `eval` read hydrated package content including `react - npmx` and package details.
- This proves the API can perform browser-use-style work against a real JavaScript site, not just a static site or hand-built `data:` page.

Completed command matcher runtime probe on 2026-07-05:

- Used `getThreadCommandDisplay` through a local Node/TypeScript transpile harness, not a duplicated parser.
- Found and fixed a real bug where PowerShell hashtable bodies beginning with `@{ action = ... }` rendered as `Browse: request`.
- Confirmed all typed actions plus raw `press` are claimed by `browse.web-request`, count as one web request, and render non-opaque summaries:
  - `doctor`, `status`, `open`, `snapshot`, `click`, `fill`, `type`, `key`, `select`, `wait`, `get`, `is`, `eval`, `highlight`, `back`, `forward`, `reload`, `screenshot`, `refs`, `viewport`, `stop`, `cleanup`, and raw `press`.
  - Example summaries include `Browse: open https://example.com in session research`, `Browse: read #status in session research`, `Browse: wait #done in session research`, and `Browse: clean up sessions research`.

Completed headed/headless switching probe on 2026-07-05:

- Session: `lily-headed-switch-probe-2`.
- `open` with `mode: "headed"` succeeded.
- Follow-up `get title` succeeded while the session was headed.
- Attempting to reopen the live headed session with `mode: "headless"` failed with Browse's expected compatibility error: `Session "lily-headed-switch-probe-2" is already running in managed-local mode. Run browse stop --session lily-headed-switch-probe-2 before changing modes.`
- `stop` succeeded.
- Reopening the same session with `mode: "headless"` succeeded.
- Follow-up `get title` succeeded while headless.
- `cleanup` stopped the session.

Important bug found and fixed during this probe:

- Typed follow-up actions originally defaulted to `--headless`, which broke headed sessions.
- The fix keeps `open` default-headless but stops follow-up actions from restating mode unless explicitly requested.
- Guidance now says to provide `mode` on `open` only under normal use.
- A later visible-headed probe found that the popup-suppression wrapper was also hiding headed Chrome windows.
- The wrapper now detects headed Browse intent and does not apply `windowsHide` to likely browser executables (`chrome.exe`, `msedge.exe`, etc.) while still hiding helper/daemon/shell processes.
- User-observed validation after that fix: headed Example Domain window was visible, and no console popup was noticed.
- Final visible headed session `lily-visible-headed-check-2` returned `get title` = `Example Domain` and cleaned up successfully.

Completion status:

- The core goal is complete enough to hand to future agents: typed action suite, command matchers, guidance, session cleanup, screenshot steering, popup suppression, headed/headless switching, JS page interaction, real JS website interaction, route smoke, and durable notes are in place.
- Known boundary: direct manual `browse` CLI runs can still show upstream/harness noise; the no-popup fix applies to Workbench `/api/browse` by running Browse through the Workbench wrapper.
- Recommended final hygiene before merging/committing remains reviewing the full diff for unrelated pre-existing worktree changes.

## Open questions to resolve by inspection

- Should typed Browse web requests be implemented as a new endpoint or as typed actions on the existing `/api/browse` endpoint? Current answer: typed actions on existing `/api/browse`, preserving raw command mode.
- How should command matchers parse structured request bodies without becoming fragile string soup?
- What is causing the transient visible command prompt windows during Browse request execution, and can Workbench suppress them reliably?
- Is there already a shared type home for Workbench local endpoint request bodies?
- Does Browse expose a reliable status/list sessions command, or only stop/session-scoped commands? Current answer: `status` and `stop` are session-scoped; no obvious `list all sessions` command was found in `browse --help`.
- Can Workbench safely kill all Browse sessions, or only named sessions it knows about? Current answer: Workbench can safely clean up typed sessions it recorded, plus explicit session lists supplied by agents; runtime-only orphan candidates can be surfaced for diagnosis but should be treated more carefully than durable owned records.
- Where should durable agent guidance live so future agents see it without editing generated instruction output?
- Should the raw Browse endpoint stay disabled behind the same setting while typed safe requests are allowed separately, or should all Browse routes share the same setting?

## Working rules for future agents

- Read this file and `context/browse-workbench-learnings.md` after every compaction or reorientation.
- Keep this file updated when the goal, route shape, lifecycle owner, or validation strategy changes.
- Do not bury durable decisions only in chat.
- Keep `context/browse-workbench-learnings.md` for observations and experiments; keep this file for the stable mission/workflow.
- Preserve the screenshot-steer data URL fix and sentinel rendering.
- Prefer typed request/response objects and shared types over ad hoc `any`.
- Prefer registries for command matching rather than hardcoding one-off display logic.
- Do not broaden endpoint permissions into arbitrary webapp calls.
- Ask the user before requiring orchestrator reload/restart.
- Stop Browse sessions that probes create.
