# Browse / Workbench Integration Learnings

This note captures the current investigation and implementation state for adding `browse` support to Workbench agents. It is intentionally detailed so a future agent can recover the thread after context compaction.

## Current recovery state after screenshot-steer poisoning

Thread `019f2f6b-88b8-7a50-acfe-399008ad090d` became unusable after testing `screenshotSteer`.

Observed transcript facts:

- The failing turn was `019f2f8c-cfb5-7a01-9794-07ef077fa038`.
- `/api/browse` captured a screenshot and then sent a `turn/steer` image input with a relative Workbench asset URL:

```json
{
  "type": "image",
  "url": "/api/transcript-assets/codex/019f2f6b-88b8-7a50-acfe-399008ad090d/721a5c7a686b924d5c62fe9cc7ba8ce5d5b6407acf4e098857be9b0d1f20114c.png"
}
```

- Codex rejected that request with:

```text
Invalid 'input[1].content[2].image_url'. Expected a valid URL, but got a value with an invalid format.
```

- Later attempts to send more messages to the same thread failed before model output began because the poisoned prior image was replayed as `input[220].content[2].image_url`.
- Workbench transcript edits alone are not expected to fix that thread, because the canonical Codex app-server history is the thing replaying the invalid image URL.
- `thread/rollback` appears to remove whole trailing turns, not a single steer item inside a turn. Rolling back far enough to remove the poisoned steer would also discard the large browse-experiment turn, so the practical recovery is to continue from a new thread using transcript notes.

Implemented fix in the current recovery thread:

- `webapp/app/api/browse/route.ts` now keeps the Workbench transcript asset URL for display/response purposes.
- The same screenshot payload is sent to Codex as a `data:image/...;base64,...` URL.
- This matches normal pasted-image behavior: model input is an inline data URL, while transcript storage may externalize images into `/api/transcript-assets/...` for UI display.
- `pnpm typecheck` passed after this fix.

Successful live probe after the fix:

- Session: `lily-sentinel-probe`
- Opened `https://example.com` through `/api/browse` with `open --local --headless`.
- `snapshot` returned the expected Example Domain accessibility tree.
- `screenshot` with `screenshotSteer` returned:

```json
{
  "ok": true,
  "steered": true,
  "assetUrl": "/api/transcript-assets/codex/019f2f9a-b812-7af0-a630-792b13a0555e/a63961d710993dfc47300e0b54173a94ea840a3711a7a37bc0bd56dcdd2db475.png",
  "steerTurnId": "019f2fb2-763c-7f01-8bca-86ae910f8a3f"
}
```

- The browser session was stopped with `stop --force`.
- The current thread did not fail after this steer.
- The persisted transcript item was externalized to the encoded transcript asset URL:

```text
/api/transcript-assets/codex/MDE5ZjJmOWEtYjgxMi03YWYwLWE2MzAtNzkyYjEzYTA1NTVl/a63961d710993dfc47300e0b54173a94ea840a3711a7a37bc0bd56dcdd2db475.png
```

- The raw Codex conversation still contains the sentinel text because the marker is carried as a text input. The Workbench UI renderer is responsible for hiding it.
- A follow-up Browse probe tried to open the local Workbench thread route at:

```text
http://127.0.0.1:3002/workbench/@/thread/019f2f9a-b812-7af0-a630-792b13a0555e
```

- The page opened, but `snapshot` only saw the document shell and scripts.
- `eval` showed empty `document.body.innerText` and a Next dev bailout template:

```text
BAILOUT_TO_CLIENT_SIDE_RENDERING
Bail out to client-side rendering: next/dynamic
```

- Therefore Browse did not visually verify the Workbench thread rendering in that isolated browser session.
- The renderer change is currently verified by code inspection and `pnpm typecheck`, not by a successful UI snapshot.

Planned next improvement:

- Screenshot steers triggered by the agent should render on the agent/left side of the thread, image-only, rather than as right-aligned user messages.
- The likely mechanism is a sentinel text marker in the `turn/steer` input, e.g. a hidden Workbench marker before the screenshot image.
- Rendering should detect that marker, hide the marker text and any screenshot-steer label text, and render only the image on the left.
- The marker should be owned by shared thread/steer helper code, not duplicated ad hoc in the Browse route and renderer.
- Current implementation adds shared marker helpers in `webapp/lib/workbench/thread/thread-steer-markers.ts`, has `/api/browse` prepend `<!-- workbench-agent-screenshot-steer -->`, and has `thread-view-items.tsx` render marked user-message items as left-side image-only screenshot items.

## Typed Browse API layer

- Added durable workflow notes in `context/browse-agent-api-workflow.md`; future agents should read that file after compaction before continuing Browse API work.
- `/api/browse` now accepts a typed `action` request shape for normal agents; raw `{ "args": [...] }` support is diagnostics/backcompat noise and should not be taught as the default path.
- Typed Browse action-to-CLI mapping lives in `webapp/lib/workbench/browse/browse-agent-requests.ts`.
- Workbench-owned Browse sessions are tracked by `webapp/lib/workbench/browse/WorkbenchBrowseSessionRegistry.ts` in `.workbench/runtime/browse-sessions.json`.
- Typed browser actions intentionally require named local sessions; this avoids default-session collisions and keeps remote Browserbase behavior out of the normal Workbench agent path.
- Typed actions currently include `doctor`, `status`, `open`, `snapshot`, `click`, `fill`, `type`, `key`, `select`, `wait`, `get`, `is`, `eval`, `highlight`, `back`, `forward`, `reload`, `screenshot`, `refs`, `viewport`, `stop`, and `cleanup`.
- `cleanup` without an explicit `sessions` list stops sessions owned by the supplied `threadId`; `cleanup` with `sessions` stops that explicit list.
- Live typed API probe succeeded:
  - `open` loaded `https://example.com` in `lily-agent-api-probe`.
  - `snapshot` returned the Example Domain accessibility tree.
  - `status` reported `browserConnected: true` and `initialized: true`.
  - Legacy behavior: `screenshot` with `screenshotSteer` inserted a screenshot into the active turn without killing the turn. New typed screenshots should steer automatically from the top-level `threadId`.
  - `cleanup` with `force: true` stopped `lily-agent-api-probe`.
- A second lifecycle probe opened `lily-registry-cleanup-probe`, called `cleanup` with no explicit session list, and then verified `status` reported `browserConnected: false` and `initialized: false`; `.workbench/runtime/browse-sessions.json` ended with an empty `sessions` list.
- Final session hygiene check reported `browserConnected: false` and `initialized: false` for `default`, `lily-agent-api-probe`, `lily-registry-cleanup-probe`, and `lily-sentinel-probe`.
- Added `webapp/lib/workbench/thread/command-matchers/browse-web-requests.ts` and wired it into `thread-command-matchers.ts` before the generic web-request matcher so `/api/browse` calls can display as Browse actions instead of opaque POSTs.
- Updated Browse prompt guidance so generated builtin `/browse` owns the workflow, while `WorkbenchPromptFiles.ts` supplies only endpoint/thread-id mechanics.
- Validation after the typed API and matcher work: `pnpm typecheck` passed.

## Builtin Browse skill and thread-owned cleanup plan update

The Browse guidance ownership changed again after user review:

- Stable Browse workflow guidance should live in a generated builtin `/browse` skill, not the non-editable tools injection.
- Workbench generates the fallback skill at `~/.workbench/skills/builtin/browse/SKILL.md`.
- A project `.agents/skills/browse/SKILL.md` or user `~/.workbench/skills/browse/SKILL.md` shadows the builtin skill.
- Generated `AGENTS.md` owns only the high-level premise that browser testing should use `/browse`.
- Dynamic `## Workbench Browse API` instructions own only endpoint mechanics and the current `threadId`.
- Normal agent guidance should not teach raw Browse args.
- Typed `/api/browse` requests now require a top-level `threadId` so sessions can be associated with the agent thread that used them.
- Typed screenshots should always be steered into the active thread turn. Agents should not configure screenshot steer text or harness fields.
- Browse cleanup is thread-owned: cleanup without explicit sessions applies to the supplied `threadId`, and automatic cleanup should only stop sessions owned by threads that have been inactive for 30+ minutes. Waiting on questionnaire/user input or approval is still active.

## JavaScript-heavy typed Browse gauntlet

Session:

```text
lily-js-gauntlet
```

Test page:

- A `data:text/html` page with JavaScript-controlled input, textarea, checkbox, select, synchronous button update, delayed button update, and visible status/count output.

Actions validated through typed `/api/browse` requests:

- `viewport` set the browser viewport.
- `open` loaded the JavaScript test page in a named local headless session.
- `snapshot` returned the expected accessibility tree.
- `fill` set `#name` to `Lily`.
- `click` focused `#notes`.
- `type` entered `sparkles`.
- `key` sent `End`.
- `select` chose `Glitter`.
- `click` toggled `#agree`.
- `is checked #agree` returned:

```json
{ "checked": true }
```

- `click #go` ran synchronous page JavaScript.
- `get text #status` returned:

```json
{ "text": "spell:Lily:sparkles:true:Glitter:1" }
```

- `get value #name` returned:

```json
{ "value": "Lily" }
```

- `eval document.querySelector("#count").textContent` returned:

```json
{ "result": "1" }
```

- `highlight #status` succeeded.
- `click #delayed` plus `wait timeout 300` observed the delayed async state:

```json
{ "text": "delayed-ready" }
```

- `screenshot` returned a base64 screenshot.
- `cleanup` stopped the session.

Interpretation:

- The typed Browse API can drive a dynamic JavaScript page end-to-end without direct `browse` CLI access.
- Remaining proof gaps before calling the whole goal complete: headed/headless switch behavior and final guidance/typecheck consistency.

## Navigation, refs, failures, and real JS site probes

Navigation/ref/failure probe:

- Session: `lily-nav-clean-probe`.
- `refs` returned an empty map before a snapshot in an earlier attempt, but returned `count: 12` after `snapshot`; therefore future agents should treat `snapshot` as the ref-population step.
- Explicit `open` A -> `open` B -> `back` -> `forward` -> `reload` worked.
- `get title` observed `Nav A`, then `Nav B`, then `Nav A` after back, then `Nav B` after forward.
- `click #b` changed page text to `Nav B clicked`; `reload` reset the text back to `Nav B`.
- Missing session on a browser action returned:

```text
Typed Browse browser actions require a named session.
```

- Invalid cleanup session name returned:

```text
Browse cleanup sessions must be valid named Browse sessions.
```

Real JS website interaction probe:

- Session: `lily-real-js-interact-probe`.
- Opened `https://npmx.dev` in local headless mode.
- Snapshot and targeted reads succeeded.
- `eval` inspected interactive controls.
- `fill` entered `react` into the search input.
- `key Enter` navigated to:

```text
https://npmx.dev/package/react
```

- `eval` then read hydrated page content including:

```text
react - npmx
React is a JavaScript library for building user interfaces.
```

Interpretation:

- The typed Browse API works end-to-end on a real JavaScript site, including interaction and reading changed app state.

## Command matcher runtime validation

Validation method:

- Used the actual `getThreadCommandDisplay` export through a local Node/TypeScript transpile harness.
- This exercised the real command matcher registry, including the Browse matcher wiring in `thread-command-matchers.ts`.

Bug found and fixed:

- PowerShell hashtable commands like `$body = @{ action = 'open'; ... }` initially rendered as:

```text
Browse: request
```

- Cause: the matcher parser recognized fields after `;` but not the first field immediately after `@{`.
- Fix: allow `{` as a field boundary for scalar and array hashtable fields.

Suite result:

- All representative typed actions plus raw `press` were claimed by `browse.web-request`, counted as one web request, and rendered non-opaque summaries.
- Covered actions: `doctor`, `status`, `open`, `snapshot`, `click`, `fill`, `type`, `key`, `select`, `wait`, `get`, `is`, `eval`, `highlight`, `back`, `forward`, `reload`, `screenshot`, `refs`, `viewport`, `stop`, `cleanup`, and raw `press`.
- Example rendered summaries:

```text
Browse: open https://example.com in session research
Browse: read #status in session research
Browse: wait #done in session research
Browse: clean up sessions research
```

## Reload and post-reload smoke validation

- Ran `pnpm typecheck` after the latest Browse guidance and matcher parser edits.
- Result: passed.
- Reloaded the orchestrator `next-dev` scope through `/api/orchestrator/reload`.
- Reload result: `state: "succeeded"`.
- Post-reload Browse API smoke:
  - Session: `lily-post-reload-smoke`.
  - `open https://example.com` succeeded.
  - `get title` returned:

```json
{ "title": "Example Domain" }
```

  - `cleanup` stopped the session.
- Session registry check after cleanup:

```json
{ "sessions": [] }
```

Remaining explicit proof gap:

- Headed/headless switching still needs deliberate validation. This may visibly open a browser window, so ask the user before running it.

## Headed/headless switching probe and typed mode fix

Initial headed probe:

- Session: `lily-headed-switch-probe`.
- `open` with `mode: "headed"` succeeded and visibly opened Example Domain.
- `doctor` showed the session connected with target details indicating `headless: false`.
- Follow-up `get title` failed.
- Attempting to reopen the same live session as `mode: "headless"` without stopping also failed, as expected for mode compatibility.

Bug found:

- The typed Browse mapper defaulted every browser action to `--headless` when `mode` was omitted.
- That is correct for `open`, where Workbench wants default-headless sessions.
- It is wrong for follow-up actions on an already-headed session, because `get`, `snapshot`, `click`, etc. then accidentally request headless mode and conflict with the live headed session.

Fix:

- `open` still defaults to `--headless`.
- Follow-up browser actions still pass `--local` and `--session`, but only pass `--headed`/`--headless` when the caller explicitly supplies `mode`.
- Guidance now tells agents to provide `mode` on `open` only under normal use.

Successful retest after the fix:

- Session: `lily-headed-switch-probe-2`.
- `open` headed succeeded.
- `get title` while headed returned:

```json
{ "title": "Example Domain" }
```

- Attempting `open` headless against the already-headed session without stopping returned the expected Browse compatibility failure:

```text
Session "lily-headed-switch-probe-2" is already running in managed-local mode. Run browse stop --session lily-headed-switch-probe-2 before changing modes.
```

- `stop` succeeded.
- `open` headless after stop succeeded.
- `get title` while headless returned:

```json
{ "title": "Example Domain" }
```

- `cleanup` stopped the session.

Visible headed-window fix:

- User reported that manual `browse --headed` showed a browser, but Workbench `/api/browse` headed mode did not.
- Cause: the Workbench wrapper applied `windowsHide: true` broadly enough that the headed browser executable was hidden along with console/helper processes.
- Fix: `run-browse-cli.mjs` now detects headed Browse intent from either `--headed` or daemon `--target` JSON with `headless: false`.
- When headed intent is active, the wrapper does not apply `windowsHide` to likely browser executables such as `chrome.exe`, `chromium.exe`, `msedge.exe`, Brave, Vivaldi, or Opera.
- Helper processes, daemon processes, taskkill, shell, and non-browser child processes still get `windowsHide: true`.

User-observed validation:

- Session: `lily-visible-headed-check-2`.
- A visible headed Example Domain browser window appeared.
- The user did not notice a console popup.
- `get title` against the visible headed session returned:

```json
{ "title": "Example Domain" }
```

- `cleanup` stopped the session.

## Browse command prompt popup investigation

- The user observed visible command prompt windows flashing when Browse requests run.
- `/api/browse` already used `windowsHide: true` for the direct Browse child process, but Browse and dependencies spawn grandchildren.
- Added `webapp/lib/workbench/browse/run-browse-cli.mjs`, a Workbench-owned wrapper that patches Node child-process helpers to default `windowsHide: true`, then runs Browse's oclif entrypoint.
- `/api/browse` now runs that wrapper instead of `node_modules/browse/bin/run.js`.
- Initial wrapper only patched `spawn`; popup count dropped from about four to one, indicating several child-process paths were fixed but at least one remains.
- Expanded wrapper patch to include `spawnSync`, `exec`, `execFile`, `execFileSync`, and `execSync`.
- Reloaded `next-dev` through `/api/orchestrator/reload` so fresh route code would definitely be active.
- Post-reload probe (`open` -> `snapshot` -> `cleanup` -> `status`) succeeded functionally but the user still saw one popup.
- Step-by-step popup isolation found:
  - `doctor`: no popup.
  - `open`: no popup.
  - `snapshot`: no popup.
  - `cleanup`: popup.
- Root cause of the remaining cleanup popup was likely a child-process overload path: `chrome-launcher` calls `spawnSync("taskkill ...", { shell: true, ... })`, where the options object is the second argument. The wrapper initially only added `windowsHide` to third-argument options, so this call path was not cloaked.
- Updated `run-browse-cli.mjs` to handle overloaded `spawn`, `spawnSync`, `execFile`, and `execFileSync` signatures where the options object may be passed as the second argument.
- Follow-up cleanup-overload probe opened and cleaned up `lily-cleanup-overload-probe`; the user reported no popup.
- Known suspicious dependency paths:
  - Browse daemon client spawns a detached daemon with no `windowsHide` in `node_modules/browse/dist/lib/driver/daemon/client.js`.
  - Stagehand shutdown supervisor spawns a detached Node supervisor with no `windowsHide` in `@browserbasehq/stagehand/dist/cjs/lib/v3/shutdown/supervisorClient.js`.
  - `chrome-launcher` uses child process helpers for Chrome startup and `taskkill` cleanup.
- Next step: isolate whether the remaining popup happens on `open`, `snapshot`, `cleanup`, or `status`, then target that owner.

## User intent

- The user added `browse` as a dependency and wants Workbench agents to use it for local browsing.
- Workbench browsing is expected to be local by default and headless by default.
- Agents should know how to reopen a session as headed.
- The user initially expected Workbench to wrap `browse` commands in API requests rather than asking agents to run the CLI directly.
- After sandbox testing failed, the user steered the first implementation toward:
  - a Workbench API endpoint that gives full `browse` command access outside the sandbox;
  - a Settings toggle to turn that capability on/off;
  - default OFF;
  - later evolution toward a more curated typed wrapper after learning the CLI better.

## Upstream browse skill source

User-provided source:

```text
https://cdn.jsdelivr.net/npm/browse@0.9.3/skills/browse/SKILL.md
```

The built-in web fetch failed silently/empty, so the file was fetched with `Invoke-WebRequest` using escalated network permission. Key upstream guidance from the skill:

- `browse` is a unified Browserbase CLI for:
  - local or remote browser sessions;
  - accessibility snapshots;
  - screenshots;
  - DOM/text/markdown reads;
  - interaction by refs, selectors, XPath, keyboard, mouse;
  - tabs;
  - network capture;
  - Browserbase cloud APIs/functions/templates/skills.
- Browser driver commands auto-start a daemon.
- Use local mode for localhost/development/trusted sites.
- Use named sessions for non-trivial work:
  - every browser command accepts `--session <name>` / `-s <name>`;
  - `BROWSE_SESSION` sets the default;
  - commands without a session share `default`, so parallel agents can collide.
- Headed/headless and local/remote mode are selected when starting a session.
- A running session keeps its mode.
- Passing a conflicting mode, e.g. `--headed` to an already-running headless session, fails until `browse stop --session <name>` or a different session is used.
- Workflow:
  - `open`;
  - `snapshot`;
  - interact using refs;
  - snapshot again after DOM changes because refs are refreshed on each snapshot.
- Prefer `snapshot` over screenshots for most agent work.
- Use screenshots only when visual layout or pixels matter.
- Use `doctor --json` for structured diagnostics.
- Do not retry identical failures repeatedly; run diagnostics and change approach.
- `BROWSE_DISABLE_UPDATE_CHECK=1` or `BB_DISABLE_UPDATE_CHECK=1` disables update checks.
- `BROWSERBASE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK`, `CI`, or test env disables telemetry.

## Installed dependency state

After the user corrected the install:

- `webapp/package.json` contains:

```json
"browse": "^0.9.1"
```

- `webapp/pnpm-lock.yaml` resolves it to:

```text
browse@0.9.1(bufferutil@4.1.0)
```

- The local binary exists:

```text
webapp/node_modules/.bin/browse
webapp/node_modules/.bin/browse.CMD
webapp/node_modules/.bin/browse.ps1
```

- Installed package path:

```text
webapp/node_modules/.pnpm/browse@0.9.1_bufferutil@4.1.0/node_modules/browse
```

- The upstream skill URL was for `0.9.3`, but the installed CLI is `0.9.1`.
- The CLI prints an update notice `0.9.1 -> 0.9.3` unless update checking is disabled.

## CLI command surface observed from `pnpm exec browse --help`

Version:

```text
browse/0.9.1 win32-x64 node-v22.22.1
```

Topics:

- `cloud`
- `functions`
- `mouse`
- `network`
- `skills`
- `tab`
- `templates`

Commands:

- `back`
- `cdp`
- `click`
- `cursor`
- `doctor`
- `eval`
- `fill`
- `forward`
- `get`
- `highlight`
- `is`
- `key`
- `open`
- `press`
- `refs`
- `reload`
- `screenshot`
- `select`
- `snapshot`
- `status`
- `stop`
- `type`
- `upload`
- `viewport`
- `wait`

## `browse open --help` facts

`browse open URL` supports:

- `--auto-connect`
- `--cdp <url|port>`
- `--chrome-arg <flag>...`
- `--headed`
- `--headless`
- `--ignore-default-chrome-arg <flag>...`
- `--local`
- `--no-default-chrome-args`
- `--remote`
- `-s, --session <name>`
- `--target-id <target-id>`
- `--timeout <ms>` default `30000`
- `--wait <state>` default `load`

Examples include:

```text
browse open https://example.com
browse open https://example.com --local --headed
browse open https://example.com --remote
browse open https://example.com --auto-connect
browse open https://example.com --cdp 9222
browse open https://example.com --session research
browse open https://example.com --wait networkidle --timeout 45000
```

## Local testing target

The user requested testing with:

```text
https://npmx.dev
```

Reason from user: it has a nice UI.

## Sandbox / harness failures observed

### Initial CLI availability

Before the user fixed installation:

```text
pnpm exec browse --help
```

from `webapp` failed with:

```text
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "browse" not found
'browse' is not recognized as an internal or external command
```

After install, the same command succeeded.

### Repeated `Get-CimInstance` access denied

Most `browse` invocations emitted Windows PowerShell stderr similar to:

```text
Get-CimInstance : Access denied
At line:1 char:2
+ (Get-CimInstance Win32_Process -Filter 'ProcessID = <pid>').Name
...
HRESULT 0x80041003
```

This happened when running through:

- `pnpm exec browse ...`
- direct `node .../browse/bin/run.js ...`
- with telemetry/update disabled.

The error did not necessarily cause the command to fail. Example: `browse --help` and `browse doctor --json` returned useful output but still emitted the WMI error.

Current theory:

- The WMI error is likely caused by the surrounding Workbench/shell harness trying to inspect spawned Node processes for command-action classification or sandbox metadata.
- It does not appear to come from `browse` itself.
- `rg` found no literal `Get-CimInstance` or `Win32_Process` in the installed `browse` package.
- `@vercel/detect-agent` was suspected because `browse` depends on it, but its installed code only checks env vars and `/opt/.devin`; it does not run WMI.

### Telemetry and update checks

`browse` hooks:

- `dist/hooks/init.js` calls:
  - `startTelemetryInvocation()`
  - `maybeAutoUpdateCli(...)`
- `dist/hooks/prerun.js` captures command invoked telemetry.
- `dist/hooks/finally.js` captures command completed telemetry.

Useful env toggles:

```text
BROWSERBASE_TELEMETRY_DISABLED=1
BROWSE_DISABLE_UPDATE_CHECK=1
```

With those set:

- update notice disappeared;
- WMI `Get-CimInstance` stderr remained.

### `doctor --json` worked

Command:

```powershell
$env:BROWSERBASE_TELEMETRY_DISABLED='1'
$env:BROWSE_DISABLE_UPDATE_CHECK='1'
node webapp/node_modules/.pnpm/browse@0.9.1_bufferutil@4.1.0/node_modules/browse/bin/run.js doctor --json --session quiet-probe
```

Returned structured JSON:

```json
{
  "checks": [
    {
      "details": {
        "node": "v22.22.1",
        "version": "0.9.1"
      },
      "message": "browse 0.9.1, node v22.22.1",
      "name": "runtime",
      "status": "ok"
    },
    {
      "message": "quiet-probe",
      "name": "session",
      "status": "ok"
    },
    {
      "message": "no active daemon",
      "name": "daemon",
      "status": "ok"
    },
    {
      "details": {
        "target": {
          "kind": "managed-local",
          "headless": true
        }
      },
      "message": "managed-local, headless",
      "name": "target",
      "status": "ok"
    },
    {
      "message": "managed local browser, headless",
      "name": "browser",
      "status": "ok"
    }
  ],
  "next": "browse open https://example.com --local --session quiet-probe",
  "paths": {
    "lock": "C:\\Users\\Chiri\\AppData\\Local\\Temp\\browse-driver\\quiet-probe.lock",
    "pid": "C:\\Users\\Chiri\\AppData\\Local\\Temp\\browse-driver\\quiet-probe.pid",
    "runtimeDir": "C:\\Users\\Chiri\\AppData\\Local\\Temp\\browse-driver",
    "socket": "\\\\.\\pipe\\browse-driver-quiet-probe"
  },
  "session": "quiet-probe",
  "target": {
    "kind": "managed-local",
    "headless": true
  },
  "verdict": "ok"
}
```

Even with this OK report, `open` could still fail.

### `open https://npmx.dev` failed under shell harness

Command variants tried:

```powershell
pnpm exec browse open https://npmx.dev --session workbench-npmx-probe --local --headless --timeout 45000
```

Failed with:

```text
Error: Driver daemon socket was not ready after 30000ms.
```

Direct Node with quiet env:

```powershell
$env:BROWSERBASE_TELEMETRY_DISABLED='1'
$env:BROWSE_DISABLE_UPDATE_CHECK='1'
node .../browse/bin/run.js open https://npmx.dev --session quiet-npmx-probe --local --headless --timeout 45000
```

Failed with:

```text
Connection timeout: Timed out waiting for /json/version on port 63121 (last error: fetch failed)
```

With `CHROME_PATH` set:

```powershell
$env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node .../browse/bin/run.js open https://npmx.dev --session chrome-path-npmx-probe --local --headless --timeout 45000
```

Failed with:

```text
Timed out waiting for driver daemon session "chrome-path-npmx-probe".
```

Interpretation:

- Chrome exists and Stagehand can create temp profiles.
- The issue was not simply "Chrome missing."
- Failures were around daemon readiness, local CDP `/json/version`, or command response timeout.
- This strengthens the need for a Workbench wrapper that can run outside the shell sandbox and capture structured stdout/stderr/duration/status.

### `status` after failed open

Command:

```powershell
node .../browse/bin/run.js status --session quiet-npmx-probe
```

Returned:

```json
{
  "browserConnected": false,
  "initialized": false,
  "session": "quiet-npmx-probe"
}
```

`doctor --json` after failed open reported `no active daemon`.

Interpretation:

- Failed open attempts do not leave a healthy initialized session.
- `doctor` and `status` are important recovery tools.

## Local Chrome / Stagehand observations

Chrome was found at:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

Edge was found at:

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Stagehand created temp profiles under:

```text
C:\Users\Chiri\AppData\Local\Temp\stagehand-v3
```

Observed profile directories included:

```text
profile-1xLFsF
profile-3UYmbu
profile-z8NvOo
```

These profiles contained Chrome data, `chrome.pid`, empty `chrome-err.log`, empty `chrome-out.log`, and normal browser profile artifacts.

Interpretation:

- Chrome launch at least partially succeeds.
- Failures are likely readiness/CDP/daemon/sandbox interaction, not absence of browser binary.

## Internal browse architecture learned from installed package

### Entrypoint

`browse/bin/run.js`:

```js
#!/usr/bin/env node
import "dotenv/config";

globalThis.oclif = {
  ...globalThis.oclif,
  enableAutoTranspile: false,
};

const { execute } = await import("@oclif/core");
await execute({ dir: import.meta.url });
```

### Daemon model

Driver commands call into:

```text
dist/lib/driver/runtime.js
dist/lib/driver/daemon/client.js
dist/lib/driver/daemon/server.js
dist/lib/driver/session-manager.js
```

`daemon/client.js`:

- ensures runtime dir;
- checks existing daemon status;
- acquires a session lock;
- spawns a detached daemon process:

```js
spawn(process.execPath, [
  entrypoint,
  "daemon",
  "--session",
  session,
  "--target",
  JSON.stringify(target),
], {
  detached: true,
  env: process.env,
  stdio: "ignore",
});
```

- waits for named pipe readiness for 30 seconds;
- sends JSON-line requests over the named pipe.

On Windows, socket path shape:

```text
\\.\pipe\browse-driver-<session>
```

Runtime dir:

```text
C:\Users\Chiri\AppData\Local\Temp\browse-driver
```

### Session mode

`dist/lib/driver/mode.js`:

- default managed local target is headless unless `--headed` is passed;
- `--headed` and `--headless` conflict;
- `--local` and `--remote` conflict;
- if no explicit remote and no `BROWSERBASE_API_KEY`, default is managed-local;
- target compatibility checks include:
  - same target kind;
  - same headless/headed value;
  - same chrome args;
  - same ignored default args.

### Stagehand options

`session-manager.js`:

- managed local target options:

```js
{
  disablePino: true,
  env: "LOCAL",
  localBrowserLaunchOptions: {
    args,
    ignoreDefaultArgs,
    headless
  },
  verbose: 0
}
```

- CDP target uses:

```js
localBrowserLaunchOptions: {
  cdpUrl: target.endpoint
}
```

## Original wrapper plan, then revised plan

### Original plan

Lily initially proposed:

- typed Workbench wrapper with curated actions:
  - `doctor`
  - `status`
  - `open`
  - `snapshot`
  - `get`
  - `click`
  - `fill`
  - `type`
  - `press`
  - `wait`
  - `viewport`
  - `screenshot`
  - `tab`
  - `stop`
- local/headless default;
- no remote/cloud/templates/functions/skills in v1;
- structured failure classification.

User rejected that as premature because actual CLI behavior had not been testable enough in the sandbox.

### Revised approved plan

User approved:

- server-backed Settings toggle, default OFF;
- API endpoint that exposes full `browse` CLI argument access outside the sandbox;
- browse-only boundary, no arbitrary shell/executable;
- guidance/instructions for agents to call the endpoint when enabled;
- later evolution toward curated typed wrapper after learning more.

## Current implementation state

At the time this note was written, implementation was in progress and `pnpm typecheck` had passed once.

### Files modified/added

Modified:

- `webapp/lib/types.ts`
- `webapp/components/workbench.tsx`
- `webapp/lib/workbench/instructions/WorkbenchPromptFiles.ts`
- `webapp/lib/workbench/instructions/instruction-injections.ts`
- `webapp/package.json` and `webapp/pnpm-lock.yaml` were modified by the user when adding `browse`.

Added:

- `webapp/lib/workbench/settings/WorkbenchServerSettings.ts`
- `webapp/app/api/workbench-settings/route.ts`
- `webapp/app/api/browse/route.ts`
- this note: `context/browse-workbench-learnings.md`

### Shared types added in `webapp/lib/types.ts`

Added:

- `WorkbenchLocalCapabilitySettings`
- `WorkbenchLocalCapabilitySettingsResponse`
- `WorkbenchLocalCapabilitySettingsUpdateRequest`
- `WorkbenchBrowseCommandRequest`
- `WorkbenchBrowseCommandResponse`

Request/response shape:

```ts
export interface WorkbenchLocalCapabilitySettings {
  browseRawCommandsEnabled: boolean;
}

export interface WorkbenchBrowseCommandRequest {
  args: string[];
  cwd?: string | null;
  projectId?: string | null;
  stdin?: string | null;
  timeoutMs?: number | null;
}

export interface WorkbenchBrowseCommandResponse {
  disabled?: boolean;
  durationMs: number;
  error?: string;
  exitCode: number | null;
  ok: boolean;
  stderr: string;
  stdout: string;
  timedOut?: boolean;
}
```

### Server settings controller added

File:

```text
webapp/lib/workbench/settings/WorkbenchServerSettings.ts
```

Purpose:

- default export controller for server-readable Workbench local capability settings;
- default `browseRawCommandsEnabled: false`;
- persist to:

```text
<projectRoot>/.workbench/settings/local-capabilities.json
```

- normalize stale/unknown JSON safely;
- queue writes in-process.

Important design decision:

- This is separate from `webapp/lib/workbench/state/workbench-settings.ts`, which is browser `localStorage`.
- LocalStorage cannot secure a server endpoint called by agents from shell.
- Therefore the raw command gate must be server-readable and server-owned.

### Settings API route added

File:

```text
webapp/app/api/workbench-settings/route.ts
```

Route behavior:

- `runtime = "nodejs"`
- `dynamic = "force-dynamic"`
- `GET` returns:

```json
{
  "localCapabilities": {
    "browseRawCommandsEnabled": false
  }
}
```

- `PUT` accepts:

```json
{
  "localCapabilities": {
    "browseRawCommandsEnabled": true
  }
}
```

It updates only recognized boolean fields.

### Browse API route added

File:

```text
webapp/app/api/browse/route.ts
```

Route behavior:

- `runtime = "nodejs"`
- `dynamic = "force-dynamic"`
- `POST` only.
- Reads `WorkbenchServerSettings`.
- If `browseRawCommandsEnabled` is false:
  - returns HTTP 403;
  - returns structured JSON with `disabled: true`.
- Accepts:
  - `args: string[]`
  - optional `cwd`
  - optional `projectId`
  - optional `stdin`
  - optional `timeoutMs`
- Validates:
  - args must be array;
  - max args: `128`;
  - max arg length: `16384`;
  - no NUL in args;
  - stdin max: `2 MiB`;
  - timeout default: `120000ms`;
  - timeout max: `600000ms`;
  - cwd must be inside selected Workbench project roots.
- Resolves the project-local `browse` package using `createRequire(import.meta.url).resolve("browse/package.json")`.
- Runs:

```text
node <resolved browse>/bin/run.js ...args
```

- Uses:
  - `shell: false`;
  - `windowsHide: true`;
  - `stdio: ["pipe", "pipe", "pipe"]`;
  - env:

```text
BROWSERBASE_TELEMETRY_DISABLED=1
BROWSE_DISABLE_UPDATE_CHECK=1
```

- Does not allow arbitrary shell command strings.
- Does not allow arbitrary executables.
- Does not restrict browse subcommands yet, intentionally, because discovery is the goal.

### Settings UI changes

File:

```text
webapp/components/workbench.tsx
```

Changes:

- imports `WorkbenchLocalCapabilitySettings` and `WorkbenchLocalCapabilitySettingsResponse`;
- adds `DEFAULT_LOCAL_CAPABILITY_SETTINGS`;
- adds React state:
  - `localCapabilitySettings`;
  - `isLocalCapabilitySettingsLoading`;
  - `localCapabilitySettingsError`;
- loads `/api/workbench-settings` on mount;
- updates `/api/workbench-settings` with `PUT`;
- adds a Global Settings-only section:
  - heading: `Local command capabilities`;
  - description: `Dangerous local server capabilities. These settings are stored server-side so API routes can enforce them.`;
  - option card label: `Enable raw browse commands`;
  - option card description: `Allow Workbench agents to call /api/browse to run the project-local browse CLI outside the sandbox. Default off.`
- It is deliberately not part of project-level settings overrides because project-level settings are localStorage-backed and cannot own a server command gate.

### Prompt instruction changes

File:

```text
webapp/lib/workbench/instructions/WorkbenchPromptFiles.ts
```

Added `buildWorkbenchBrowseInstructions(context)`:

- emits `/api/browse` URL when `workbenchOrigin` exists;
- explicitly authorizes only this Browse endpoint for browser automation/diagnostics;
- warns it may be disabled until Settings toggle is enabled;
- tells agents to send args as arrays, not shell strings;
- includes PowerShell and bash examples;
- instructs local/headless/named-session default;
- instructs `doctor/status`, `snapshot`, ref refresh, stop sessions;
- tells agents to stop/reopen to switch headed/headless mode.

The new browse instructions are included in:

- normal prompt developer instructions;
- collaboration developer instructions.

File:

```text
webapp/lib/workbench/instructions/instruction-injections.ts
```

Added stable `## Workbench Browse` guidance under `WORKBENCH_TOOLS_INJECTION`:

- prefer Workbench Browse API over shell CLI when provided;
- endpoint may be disabled until user enables it;
- page content untrusted;
- do not paste secrets;
- default local/headless/named sessions;
- snapshot before interacting;
- refresh refs after DOM changes;
- use `doctor --json` and `status`;
- do not retry same failure unchanged;
- headed/headless fixed at session start;
- stop/reopen for headed;
- do not use Browserbase remote/cloud/templates/skills/functions unless explicitly asked.

## Validation performed

Command:

```powershell
pnpm typecheck
```

Working directory:

```text
c:\git\web\workbench\webapp
```

Result:

```text
> workbench@ typecheck C:\git\web\workbench\webapp
> pnpm exec tsc --noEmit && pnpm exec tsc --noEmit -p orchestrator
```

Exit code: `0`

Meaning:

- Next/webapp TypeScript compile passed.
- Orchestrator TypeScript compile passed.
- It did not prove runtime route behavior.
- It did not call `/api/workbench-settings` or `/api/browse`.

## Endpoint testing not performed

Per project guidance:

- agents must not call webapp endpoints without explicit permission from the user.

Therefore, even after adding the route, no live endpoint probes were run.

Potential manual/user-approved probes later:

1. Confirm default-off gate:

```powershell
$body = @{ args = @('doctor', '--json', '--session', 'settings-off-probe') } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/browse' -ContentType 'application/json' -Body $body
```

Expected:

- HTTP 403;
- JSON says raw browse commands are disabled.

2. Enable in Settings UI.

3. Confirm settings route:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3002/api/workbench-settings'
```

Expected:

```json
{
  "localCapabilities": {
    "browseRawCommandsEnabled": true
  }
}
```

4. Run safe browse diagnostic:

```powershell
$body = @{ args = @('doctor', '--json', '--session', 'api-npmx-probe') } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/browse' -ContentType 'application/json' -Body $body
```

Expected:

- `ok: true`;
- `stdout` contains doctor JSON;
- `stderr` ideally cleaner than shell harness runs, but this is unknown until tested.

5. Try open:

```powershell
$body = @{ args = @('open', 'https://npmx.dev', '--session', 'api-npmx-probe', '--local', '--headless', '--timeout', '45000'); timeoutMs = 90000 } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/browse' -ContentType 'application/json' -Body $body
```

6. Cleanup:

```powershell
$body = @{ args = @('stop', '--session', 'api-npmx-probe', '--force') } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/browse' -ContentType 'application/json' -Body $body
```

## Known risks / follow-up concerns

### Security and scope

The new endpoint intentionally exposes full `browse` CLI args when enabled.

Mitigations currently implemented:

- default OFF;
- server-readable setting;
- browse-only package entrypoint;
- no shell strings;
- no arbitrary executable;
- cwd constrained to Workbench project roots;
- `shell: false`;
- bounded args/stdin/timeout.

Still risky:

- `browse` itself can open browser sessions and may support file upload/download/cloud commands.
- The route does not yet block `browse cloud`, `browse functions`, `browse templates`, or `browse skills`.
- This is intentional for discovery but should be revisited.

### Settings persistence

The server setting writes:

```text
.workbench/settings/local-capabilities.json
```

This may appear as an untracked/modified workspace file once toggled. That is expected user-owned local state.

### Atomicity

`WorkbenchServerSettings.ts` writes via temp file + rename and in-process queue.

It does not currently include the Windows rename retry helper used by orchestrator `AtomicJsonStore`.

If this setting becomes heavily written, consider moving the atomic JSON helper to shared lib or adding Windows retry.

### UI lifecycle

`updateBrowseRawCommandsEnabled` captures `previousSettings` from React state. Rapid repeated toggles while loading are mostly blocked because the option card is disabled during update, but this should be checked visually.

### API error shape

`/api/browse` returns structured JSON even for disabled/bad request/runtime failure. It uses HTTP 403 for disabled and HTTP 400 for invalid/caught errors.

It returns HTTP 200 for completed browse command even if `exitCode !== 0`, with `ok: false`. This is intentional so agents can inspect stdout/stderr without fetch throwing based on status.

### Browse route cwd behavior

If no `projectId` is supplied, `resolveProjectRoot` defaults to the current default project. Agents should generally omit `cwd` unless needed or pass a project-root cwd.

### Prompt source/generated boundary

Only source files under `webapp/lib/workbench/instructions/` were edited.

Generated Workbench library files were not edited directly.

## Relevant checkpoints in this thread

There were approval/implementation checkpoints earlier, but the user explicitly requested this note with "no approval checkpoint", so no new checkpoint was created for this note.

Important commits from earlier workflow:

- Revised-plan approval checkpoint:

```text
14adc39dbe76d7175d1841df203d305100a605de
```

- Initial implementation checkpoint:

```text
0f630554b5f701ab6a3e4eca361944c7018c5a5f
```

Before Review mode, diff against the initial implementation checkpoint, not the latest checkpoint.

## Suggested next steps after compaction

1. Re-read this note.
2. Check `git status --short`.
3. Inspect the current diffs for approved files plus this note.
4. Run `pnpm typecheck` again if any edits happened after this note.
5. If user permits endpoint testing, test:
   - default-off `/api/browse` returns 403;
   - Settings UI toggles server setting;
   - `/api/browse` can run `doctor --json`;
   - optionally `open https://npmx.dev`;
   - cleanup with `stop --force`.
6. Enter Review mode after final validation and diff against initial implementation checkpoint `0f630554b5f701ab6a3e4eca361944c7018c5a5f`.
