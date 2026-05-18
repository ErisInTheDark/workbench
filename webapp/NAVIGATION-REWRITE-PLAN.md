# URL Source Of Truth Navigation Rewrite Plan

## Goal

Replace the current mixed navigation architecture with one invariant:

> The URL is the source of truth for the visible project, file view, and thread view. User interactions, and only user interactions, may change the URL. All other code may load data for the current route, but may not choose or rewrite the route.

## Current Failure Mode

The current app has several competing navigation owners:

- Route parsing and URL writing live in `webapp/lib/workbench/state/browser-state.ts`.
- `components/workbench.tsx` keeps `requestedSelection` React state in sync through `popstate` plus a custom `workbench:selection-url-updated` event.
- `WorkbenchClient` reads `window.location` directly and opens files or threads during refresh and mount flows.
- `WorkbenchClient`, `WorkbenchFileClient`, and thread lifecycle paths call URL sync helpers after imperative state changes.
- Mobile pane state is partly route-derived and partly set directly by open/back handlers.
- Explorer active styling is based on imperative loaded state, not the route.

The result is a system where URL state, loaded state, route effects, polling refresh, thread lifecycle, and mobile pane state can all influence what the user sees.

## Target Invariants

1. The current project, selected file, selected thread, and mobile primary pane are derived from a single route object.
2. Only explicit user interaction handlers may call navigation.
3. Data refresh, thread polling, file loading, backend notifications, draft hydration, send/stop results, and mount effects may not mutate the URL.
4. Imperative clients may expose route-loading functions, but may not have `syncUrl` options.
5. Back and forward use real browser history, not custom events after `replaceState`.
6. Legacy `?file=` and `?thread=` URLs may be parsed for compatibility, but canonicalization must happen only at a deliberate navigation boundary.

## Route Model

Create `webapp/lib/workbench/navigation/workbench-route.ts`.

Exports:

- `WorkbenchRouteView = "project" | "file" | "thread"`
- `WorkbenchRoute`
  - `projectId: string`
  - `view: WorkbenchRouteView`
  - `filePath: string`
  - `threadId: string`
- `parseWorkbenchRouteFromLocation(location: Location | string): WorkbenchRoute`
- `parseWorkbenchRouteFromPath(pathname: string, search?: string): WorkbenchRoute`
- `createWorkbenchHref(route: WorkbenchRoute): string`
- `createProjectRoute(projectId: string): WorkbenchRoute`
- `createFileRoute(projectId: string, filePath: string): WorkbenchRoute`
- `createThreadRoute(projectId: string, threadId: string): WorkbenchRoute`
- `createProjectHref(projectId: string): string`
- `createFileHref(projectId: string, filePath: string): string`
- `createThreadHref(projectId: string, threadId: string): string`
- `isSameWorkbenchRoute(left: WorkbenchRoute, right: WorkbenchRoute): boolean`
- `routeHasSelection(route: WorkbenchRoute): boolean`

Canonical route shape:

- `/:projectId`
- `/:projectId/@/file/:filePath`
- `/:projectId/@/thread/:threadId`

Project ids and file paths remain slash-delimited and user-readable. Each path segment is encoded with `encodeURIComponent`.

Legacy route shape:

- `/:projectId?file=:filePath`
- `/:projectId?thread=:threadId`

The query-param legacy shape is read only. The next user navigation writes the canonical path shape.

### Route Grammar Requirements

The `@` marker is the intentional route boundary between the project path and the selected page type.

Implementation requirement:

- Define a strict grammar before migrating callers.
- Treat `@` as the canonical workbench route marker.
- Preserve `file` and `thread` as mode segments only immediately after the `@` marker.
- Decode each segment defensively; malformed percent encodings must produce an invalid route state rather than throwing during render.
- Add parser tests for project ids and file paths containing `@`, `file`, `thread`, spaces, encoded characters, malformed encodings, and slash-delimited project ids.

## Browser Hook

Create `webapp/lib/workbench/navigation/use-workbench-route.ts`.

Responsibilities:

- Initialize the current route from `window.location`.
- Listen to `popstate`.
- Expose `{ route, navigateToRoute }`.
- `navigateToRoute(route)` calls `window.history.pushState` by default.
- `navigateToRoute(route, { replace: true })` calls `replaceState` only for deliberate user-initiated replacement cases.
- No custom URL-updated event.
- No effect-driven URL write.

Allowed callers for `navigateToRoute`:

- React event handlers.
- Explicit callbacks invoked by a user action such as submitting the first thread message or creating a file.

Disallowed callers:

- mount effects
- route effects
- polling refresh
- file loaders
- thread loaders
- backend notification handlers
- project refresh
- persisted draft hydration

## Browser State Cleanup

Refactor `webapp/lib/workbench/state/browser-state.ts`.

Keep:

- expanded directory persistence
- font size persistence
- harness/model/effort/agent persistence
- thread unread persistence
- local workbench origin detection

Move or remove:

- `CURRENT_FILE_SEARCH_PARAM`
- `CURRENT_THREAD_SEARCH_PARAM`
- `WORKBENCH_ROUTE_MARKER`
- `CURRENT_SELECTION_URL_UPDATED_EVENT`
- `readCurrentSelectionFromUrl`
- `getRequestedPathFromUrl`
- `getRequestedProjectIdFromUrl`
- `getRequestedThreadIdFromUrl`
- `syncCurrentSelectionToUrl`

The route marker and parsing constants move to `workbench-route.ts`.

## Mobile Pane Cleanup

Replace `webapp/lib/workbench/state/mobile-pane-url-state.ts` with a pure helper or inline derivation:

```ts
function getPreferredMobilePane(isMobileViewport: boolean, route: WorkbenchRoute): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  return route.view === "project" ? "explorer" : "editor";
}
```

Remove direct `setMobilePane("editor")` from file/thread open handlers. The selected route implies the pane.

The mobile back button should navigate to `createProjectRoute(route.projectId)` instead of clearing URL selection and separately setting pane state.

## React Shell Rewrite

Refactor `webapp/components/workbench.tsx`.

Replace:

- `requestedSelection` state
- `CURRENT_SELECTION_URL_UPDATED_EVENT`
- `readCurrentSelectionFromUrl`
- `syncCurrentSelectionToUrl`
- component-local `createProjectHref`

With:

- `const { route, navigateToRoute } = useWorkbenchRoute()`
- route helper imports from `workbench-route.ts`

Derived view state:

- `showThreadView = route.view === "thread"`
- `showFileView = route.view === "file"`
- `showEmptyState = route.view === "project"`
- `activeThreadId = route.view === "thread" ? route.threadId : ""`
- `activeFilePath = route.view === "file" ? route.filePath : ""`

Readiness checks compare loaded state to route state:

- file view is ready when no thread is loaded and `explorer.currentPath === route.filePath`
- thread view is ready when `currentThread?.id === route.threadId`

Explorer highlighting should use the route, not `ExplorerSnapshot.currentPath/currentThreadId`.

User interactions:

- Project click: `navigateToRoute(createProjectRoute(project.id))`, then close project picker.
- File click: `navigateToRoute(createFileRoute(route.projectId, path))`.
- Thread click: `navigateToRoute(createThreadRoute(route.projectId, threadId))`.
- Project heading click: `navigateToRoute(createProjectRoute(route.projectId))`.
- Mobile back: `navigateToRoute(createProjectRoute(route.projectId))`.
- Quick open: `navigateToRoute(createFileRoute(route.projectId, path))`.
- Thread markdown file link: `navigateToRoute(createFileRoute(route.projectId, path))`.

The same function should not both navigate and load. User handlers navigate. Route effects load.

## Workbench Controls Contract

Update `WorkbenchControls` in `webapp/lib/types.ts`.

Remove or change:

- `openFile(path, { syncUrl })`
- `openThread(threadId, { syncUrl })`
- `selectProject(projectId)` if it performs URL side effects

Add:

- `applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult>`
- `createThreadDraft(harness: WorkbenchHarness): ThreadPayload`

Possible route load result:

```ts
interface WorkbenchRouteLoadResult {
  ok: boolean;
  error?: string;
}
```

Keep action controls that mutate data but not navigation:

- `createEntry`
- `sendThreadMessage`
- `stopThread`
- `readThread`
- `submitPendingUserInputRequest`
- model/agent/reasoning setters
- `toggleDirectory`

## Compatibility Bridge

During migration, avoid broad type removal before all callers are updated.

Required sequence:

1. Add route navigation callbacks and `applyRoute(route)`.
2. Update `workbench.tsx`, `workbench-explorer.tsx`, and thread markdown callers to use the route callbacks.
3. Remove fallback calls from `ExplorerTree` that call `controls.openFile()` or `controls.openThread()` when explicit callbacks are absent.
4. Only then remove `openFile/openThread/selectProject/createThread` from `WorkbenchControls`, or keep load-only replacements with names that cannot be mistaken for navigation.

No compatibility shim may write the URL.

## WorkbenchClient Rewrite

Refactor `webapp/lib/WorkbenchClient.ts`.

Remove direct URL imports:

- `getRequestedPathFromUrl`
- `getRequestedProjectIdFromUrl`
- `getRequestedThreadIdFromUrl`
- `syncCurrentSelectionToUrl`

Add a route loader:

```ts
async function applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult>
```

Responsibilities:

1. Increment a route generation token.
2. Ensure the requested project is selected and hydrated.
3. For `project` view:
   - sync current file draft buffer if needed
   - clear file and thread loaded selection
   - clear editor selection view
4. For `file` view:
   - load the requested project if needed
   - clear thread selection
   - open the file as data loading only
   - reject stale async results using route generation
5. For `thread` view:
   - load or create draft thread by id as data loading only
   - clear file selection
   - reject stale async results using route generation
6. Return explicit errors for invalid project/file/thread cases without rewriting the URL.

Additional client-owned route state:

- Store `activeRoute` and `activeRouteGeneration` inside `WorkbenchClient`.
- `applyRoute(route)` updates both before async work starts.
- Auto-refresh and notification reconciliation compare against `activeRoute`, not `window.location` and not React-only state.
- Subclient callbacks that can update loaded selection must be fenced by the active route before mutating `SessionState`.

Replace `openRequestedSelectionFromUrl()` with route-argument logic.

Replace route-driven race checks that reread `window.location` with generation checks against the route being applied.

Update `refreshTree({ preserveSelection })`:

- It may refresh projects, tree, thread list, pending input requests, and rate limits.
- It may refresh the currently loaded file or thread only when still matching the active route.
- It must not read URL directly.
- It must not choose a fallback view.
- It must not call any navigation function.

Update `startAutoRefresh()`:

- No route reads.
- No URL writes.
- No selection fallback.

Background notification requirement:

- `WorkbenchThreadClient` notification/reconcile paths may update thread list metadata freely.
- They may update the loaded current thread only if `activeRoute.view === "thread"` and `activeRoute.threadId` matches the thread being reconciled.
- If the active route has moved away, delayed notification results must be ignored for current-view selection.

## File Client Rewrite

Refactor `webapp/lib/workbench/WorkbenchFileClient.ts`.

Remove:

- `syncSelectionToUrl` constructor dependency
- `syncUrl` option
- URL updates inside `openFile`

Keep:

- openable-file validation
- draft buffer application
- file payload loading
- editor document updates
- project path expansion
- explorer state emissions

`openFile` becomes a load-only operation.

## Project Client Rewrite

Refactor `webapp/lib/workbench/WorkbenchProjectClient.ts`.

Remove:

- `getRequestedProjectIdFromUrl` import
- route-aware initial project selection

New policy:

- Project client loads projects and project data.
- Coordinator passes the requested project id from `applyRoute(route)`.
- Invalid route project id produces an explicit route load error in the shell instead of silently selecting the first project and rewriting visual reality.

Required API change:

- Replace fallback selection with strict selection for route application.
- `selectProjectStrict(projectId)` must return an explicit success/error result and must not silently fall back to the first project.
- Initial no-project route may choose the first available project only when the URL itself has no project id.
- A route with a non-empty invalid project id must render an invalid-project state while leaving the URL unchanged.

## Thread Client And Thread Lifecycle

Refactor thread selection as loaded data, not navigation.

Remove URL writes from:

- `onThreadStarted` in `WorkbenchClient`
- `sendThreadMessage`
- `openThread`
- `createThread`
- any backend notification path

Recommended thread id transition policy:

1. User clicks create thread.
2. Handler calls `controls.createThreadDraft(harness)` to get a draft thread.
3. Handler navigates to `createThreadRoute(route.projectId, draftThread.id)`.
4. User submits the first message.
5. If the backend returns a real id different from the draft id, the submit handler navigates with `{ replace: true }` to `createThreadRoute(route.projectId, payload.id)`.
6. Non-user thread start or notification updates never navigate.

This treats the send button as the user interaction that authorizes replacing the transient draft URL.

Persisted draft requirements:

- Composer and questionnaire drafts keyed by draft thread id must be deliberately cleaned or migrated after successful first-send id replacement.
- On successful first send:
  - clear persisted draft keys for the draft id after the real payload is accepted;
  - preserve any current unsent composer/questionnaire state under the real id only if there is meaningful state left after send;
  - then replace the URL from draft id to real id.
- On failed first send:
  - keep the draft route unchanged;
  - keep draft composer/questionnaire persistence under the draft id;
  - do not clear the draft thread view.
- Back/Forward after successful replacement should not expose the transient draft route.

## File Creation Policy

Current behavior creates a file and opens it imperatively.

New policy:

1. User submits create-file dialog.
2. `controls.createEntry(parentPath, name, "file")` returns `createdPath`.
3. The submit handler navigates to `createFileRoute(route.projectId, createdPath)`.
4. Route effect loads the file.

Directory creation does not navigate unless a later product decision says it should.

Required client change:

- `createEntry()` must become pure data mutation plus project refresh.
- It must not call `openFile()`.
- File creation navigation happens only in the submit handler after `createdPath` is returned.

## Thread View And Markdown Links

Update file-link callbacks:

- `ThreadMarkdown`
- `ThreadView`
- thread output project-file links

They should call route navigation callbacks from `workbench.tsx`, not `controls.openFile`.

Project-file links should preserve normal link semantics:

- Render canonical `href` values.
- Normal left click may be intercepted for in-app navigation.
- Ctrl/Cmd/Shift/Alt click, middle click, and browser context menu behavior should fall through to the anchor.

Subagent tabs inside a thread currently change local thread-view state without URL. Keep this out of the first rewrite and classify it as internal tab state, not global workbench navigation.

If subthread tabs need deep links later, add a separate route segment in a follow-up.

## Error Handling

The URL should be respected even when invalid.

Recommended shell behavior:

- Invalid project: show an invalid-project state with available projects.
- Invalid file path: show file error while URL remains unchanged.
- Invalid thread id: show thread error while URL remains unchanged.
- Unopenable file: show file error while URL remains unchanged.

Do not silently clear selection or select the first project in response to an invalid URL.

## Loaded State Contract

`ExplorerSnapshot.currentPath` and `ExplorerSnapshot.currentThreadId` may remain, but they mean loaded data state only.

Rules:

- They may be used for readiness checks.
- They may not be used for active navigation styling.
- Active styling and visible view selection must come from `WorkbenchRoute`.
- Future names should prefer `loadedPath` and `loadedThreadId` if the type is touched broadly enough to rename safely.

## Documentation

Update nearby documentation in the same pass because this changes core operator navigation architecture:

- `AGENTS.md`, or
- a webapp-specific note if one exists or is more appropriate.

Document:

- URL is the navigation source of truth.
- Only user event handlers may navigate.
- Data clients must not read or write browser location.
- Auto-refresh must not change route.

## Verification

Run:

```powershell
pnpm run typecheck
```

from `webapp/`.

Manual route matrix:

- `/`
- `/:project`
- `/:project/@/file/:path`
- `/:project/@/thread/:id`
- `/:project?file=:path`
- `/:project?thread=:id`
- project -> file -> thread -> project with browser Back/Forward
- auto-refresh while on a file does not change URL
- auto-refresh while on a thread does not change URL
- create draft thread -> send first message -> replace draft URL with real thread URL
- create file -> navigate to new file by user submit path
- mobile viewport route-to-pane behavior
- mobile back navigates to project route
- direct browser reload on canonical file/thread routes
- direct browser reload on malformed/legacy routes
- project/file links with modifier and middle-click behavior
- stale file/thread load cancellation
- delayed auto-refresh and notification results after route changes
- draft-thread failed send and successful id replacement

Recommended route utility tests:

- project ids with slash-delimited segments
- project ids containing reserved segments
- file paths containing `@`, `file`, and `thread`
- encoded spaces and encoded reserved characters
- malformed percent encodings
- legacy query precedence
- duplicate navigation guard

`navigateToRoute()` must guard with `isSameWorkbenchRoute()` and avoid pushing duplicate history entries for repeated clicks on the current route.

## Implementation Order

1. Add route utility and route hook.
2. Refactor browser-state and mobile-pane helpers to remove selection URL ownership.
3. Update shared types and `WorkbenchControls`.
4. Refactor `WorkbenchClient` around `applyRoute(route)`.
5. Refactor `WorkbenchFileClient` to remove URL sync.
6. Refactor `WorkbenchProjectClient` to remove URL reads.
7. Remove URL writes from thread lifecycle and define draft-to-real id navigation at the user submit boundary.
8. Refactor `workbench.tsx` user handlers to navigate and route effects to load.
9. Update thread markdown/file-link integrations.
10. Update docs.
11. Run typecheck.

## Non-Goals For The First Pass

- Routing every internal thread subtab.
- Routing modal open/close state.
- Redesigning the app shell.
- Changing API routes unrelated to project/file/thread loading.
- Changing editor persistence behavior except where it is required to prevent navigation side effects.
