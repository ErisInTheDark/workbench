# Workbench Architecture Review Tracker

This file is a live snapshot of pending work only.
When the user confirms an item is complete, remove the completed checklist entry and remove the resolved section entirely.
Keep this file focused on unresolved architecture work for the workbench so future context windows only load active decisions.

### Implementation Master Order

- [ ] 1. Implement `Polling Loops Have No Centralized Coordination` now that lifecycle scopes exist so recurring refresh and debounce work use the same ownership model.
- [ ] 2. Implement `Too Many DOM Refs Passed Deep into the System` after the client boundaries are stable enough to narrow DOM surfaces with confidence.
- [ ] 3. Implement `Utility File Proliferation Without Coherent Layering` last, after the earlier ownership and state work has finalized which files belong to which layer.


## Shared Foundations

### Canonical Target State Model

Use one canonical state model across the implementation items instead of redefining these interfaces in multiple sections.

`SessionState` means selection state for the current open target. It does not own file content, persistence state, or editor UI state.

```ts
interface SessionState {
	currentPath: string;
	currentThreadId: string;
	currentThread: ThreadPayload | null;
}

interface FileSessionState {
	baselineContent: string;
	currentContent: string;
	draftBuffers: Map<...>;
	expectedMtimeMs: number | null;
	headContent: string | null;
	history: EditHistoryState | null;
	dirty: boolean;
	mode: EditorMode;
	pendingWriteConflict: SaveConflictPayload | null;
	saveIssue: SaveGuardIssue | null;
}

interface EditorUIState {
	statusMessage: string;
	fontSize: number;
}
```

### Cross-Item Relationships

- `EditHistoryManager` is a new manager module or class built on top of the existing `edit-history.ts` utilities. It replaces the coordinator-local history functions while continuing to use the pure patch and normalization helpers already in that file.
- `EditorMutationRunner` owns per-operation sequencing only. `EditOperationContext` is a data-only operation object created for one logical mutation lifecycle, and the runner delegates history work to `EditHistoryManager` instead of replacing it.
- `LifecycleScope` is a client-lifetime resource owner. It does not overlap with `EditOperationContext`, which is a short-lived per-mutation data object.
- `EditorDocumentAdapter` is created once per workbench runtime by the coordinator and passed to the file client. It wraps the editor client's render and scheduling hooks, while authoritative file state still lives in `FileSessionState`.
- `FileSessionState` and `EditorDocumentAdapter` solve different problems and are both required: `FileSessionState` is the source of truth for file-editing state, while `EditorDocumentAdapter` is the imperative bridge for document rendering, editability, selection capture or restore, and terminal status or diff refresh requests.
- `SessionState` and `FileSessionState` are now established foundations and later sections should consume or refine them rather than reintroducing them.
- `LifecycleScope` is the canonical cleanup primitive. Timer scheduling for polling and debounce work uses the owning client's `LifecycleScope` rather than a separate timer manager abstraction.
- The coarse event layer is a single workbench-scoped event bus created by the coordinator. It carries only non-authoritative notifications such as file opened, thread opened, save completed, save conflict surfaced, and save guard issue surfaced. Authoritative state stays in `SessionState`, `FileSessionState`, project snapshots, thread snapshots, and `EditorUIState`.

## Architecture Critique: Workbench Client System
The sections below stay in critique order rather than implementation order. Follow `Implementation Master Order` when sequencing work.
Severity labels describe architectural impact and risk, not the order in which the work should be implemented.

### SEVERITY 2: Utility File Proliferation Without Coherent Layering

Problem: the 30+ files under `webapp/lib/workbench/` have no clear ownership model.

Controller files (should be part of the editor client):
- `inline-format.ts`: owns pending inline format state and DOM manipulation. Used by `workbench-editor-client` but created and managed by the coordinator.
- `code-format.ts`: similar - controller logic for code blocks.
- `revision-hover-toolbar.ts`: owns hover state and toolbar positioning.
- `workbench-format-command-controller.ts`: format command dispatch.
- `workbench-list-structure-controller.ts`: list indent/outdent logic.
- `workbench-rich-input-controller.ts`: rich text input handling.

All of these are implementation details of the editor, not shared utilities. They should be internal to `workbench-editor-client.ts` or split into a `WorkbenchEditorShell` class.

Pure utility files (should be in a separate layer):
- `edit-history.ts`: edit history state machine. Good reusable utility.
- `dom-normalization.ts`: DOM cleanup helpers. Good reusable utility.
- `markdown-render.ts`: Markdown parsing. Good reusable utility.
- `selection-dom.ts`: selection capture and restore. Reusable utility.
- `browser-state.ts`: localStorage and URL state. Reusable utility.

DOM manipulation files with muddled responsibility:
- `list-dom.ts`: query list elements
- `text-position-dom.ts`: query text positions
- `selection-dom.ts`: capture and restore selection
- `structured-block-dom.ts`: block styling
- `rich-input-dom.ts`: rich text input prep
- `direct-editor-paragraph.ts`: paragraph handling
- `viewport-metrics.ts`: viewport calculations

These should be reorganized into clearer DOM sublayers instead of staying as a flat pile of helpers with mixed abstraction levels.

Feasibility verdict:
- The critique is valid and should stay.
- The current folder proposal is directionally right, but it over-collapses the codebase into too few new files.
- The better target is layered re-homing with explicit private editor internals, not a smaller number of larger monoliths.

Prerequisite for this item:
- The contract work is now in place. Finish the state-separation item first so editor and coordinator boundaries are stable before files move layers.

Concrete reshaping:

1. Keep the client entry points at the root of `webapp/lib/workbench/`: `workbench-editor-client.ts`, `workbench-file-client.ts`, `workbench-project-client.ts`, and `workbench-thread-client.ts` remain the public subclient surfaces.

2. Move editor-only controllers into an internal editor layer rather than treating them as shared utilities:
- `inline-format.ts`
- `code-format.ts`
- `revision-hover-toolbar.ts`
- `workbench-format-command-controller.ts`
- `workbench-list-structure-controller.ts`
- `workbench-rich-input-controller.ts`

3. Split DOM helpers into sublayers instead of a single catch-all API:
- `dom/query/`
- `dom/mutation/`
- `dom/selection/`
- `dom/layout/`

4. Keep truly reusable state and markdown helpers as their own layers:
- `state/`
- `markdown/`

5. Re-home domain-specific files by actual ownership:
- thread-specific helpers move under `thread/`
- project-facing helpers move under a small `project/` or shared support layer
- `save-guard-inspector.ts` moves with editor or markdown integrity logic instead of a generic utility bucket

Implementation staging for the later checklist item:
1. Define the target folder boundaries and update manifest comments so each file declares whether it is a public client surface, editor internal, DOM helper, state helper, markdown helper, thread helper, or project support helper.
2. Move the clearly classified files first with no behavior changes: `state/`, `markdown/`, and thread-oriented helpers.
3. Move editor controllers into an internal editor layer and update imports so the coordinator and editor client stop treating them as shared utilities.
4. Reorganize DOM helpers into smaller sublayers without forcing them into one or two giant files.
5. Only after the folders are stable, consolidate duplicate APIs inside the DOM layer where that actually reduces overlap.

Non-goals for this item:
- Do not merge controllers into a single `editor-shell.ts` file
- Do not collapse DOM helpers into a single `dom/query.ts` file as the main target
- Do not introduce a generic `utils/` bucket as the destination for ambiguous ownership

Concrete reshaping: the long-term structure should look more like:

```text
webapp/lib/workbench/
	workbench-editor-client.ts
	workbench-file-client.ts
	workbench-project-client.ts
	workbench-thread-client.ts
	editor/
		internal/
			inline-format.ts
			code-format.ts
			revision-hover-toolbar.ts
			workbench-format-command-controller.ts
			workbench-list-structure-controller.ts
			workbench-rich-input-controller.ts
	state/
		edit-history.ts
		browser-state.ts
	dom/
		query/
		mutation/
		selection/
		layout/
	markdown/
		markdown-render.ts
		markdown-serialization.ts
		markdown-links.ts
		comment-markdown.ts
	thread/
		thread-render.ts
		thread-file-diff.ts
		thread-command-matchers.ts
```

### SEVERITY 3: Polling Loops Have No Centralized Coordination

Problem: multiple polling patterns are scattered through the code:

- `AUTO_REFRESH_INTERVAL_MS` hardcoded at 1500ms for general refresh
- `CODEX_NOTIFICATION_THREAD_REFRESH_DELAY_MS` at 350ms for thread refresh
- `CODEX_NOTIFICATION_THREAD_LIST_REFRESH_DELAY_MS` at 750ms for thread list

These are not all the same kind of timing behavior:
- `AUTO_REFRESH_INTERVAL_MS` is a true recurring refresh loop
- the Codex notification delays are debounced refreshes
- the file selection persistence delay is a local debounce
- `HISTORY_KEYFRAME_INTERVAL` is not polling and should not be part of this critique

These are created with `setTimeout` and `setInterval`, but there's no:
- centralized cleanup coordination
- priority or debouncing
- test harness access

Feasibility verdict:
- The underlying concern is valid, but the current proposal is too centralized.
- The better target is explicit timer ownership by the client that creates the timer, using scheduling helpers provided by that client's `LifecycleScope`.
- The workbench does not need one global scheduler that owns every timer in the system.

Concrete reshaping:
1. Timer ownership follows client ownership: the coordinator owns only the auto-refresh loop it creates, the thread client owns notification-triggered refresh debounces, and the file client owns selection-persistence debounce.
2. Shared timer mechanics, not a second manager: expose `scheduleOnce`, `scheduleRepeat`, `cancel`, and `dispose` through the owning client's `LifecycleScope` instead of introducing a competing timer abstraction.
3. Separate refresh policy from timer mechanics: auto-refresh intervals and notification delays remain policy values at the call site, while the timer helper standardizes lifecycle and cancellation behavior.
4. Restrict central coordination to recurring refresh policy: if anything is centralized, it should be the workbench coordinator's recurring refresh behavior, not every timer across every client.

Implementation staging for the later checklist item:
1. Move timer cleanup fully into the client that owns each timer and remove cross-client timeout clearing.
2. Migrate auto-refresh, thread notification delays, and selection-persistence debounce onto `LifecycleScope` scheduling helpers.
3. Keep auto-refresh policy in the coordinator, but make it use the shared lifecycle-backed timer helpers instead of raw timeout bookkeeping.
4. Document which timers are recurring refresh policy versus local debounce behavior so later lifecycle work has explicit ownership boundaries.

Non-goals for this item:
- Do not include `HISTORY_KEYFRAME_INTERVAL` in the polling design work
- Do not introduce a single global `PollingScheduler` as the main target
- Do not try to centralize every timer when local ownership is the more coherent architecture

Concrete reshaping: use the established `LifecycleScope` timer helpers with local ownership instead:

```ts
const coordinatorLifecycle = new LifecycleScope();
coordinatorLifecycle.scheduleRepeat("auto-refresh", 1500, refreshTree);

const threadLifecycle = new LifecycleScope();
threadLifecycle.scheduleOnce("thread-refresh", 350, () => {
	void refreshThreads();
});
```

### SEVERITY 3: Too Many DOM Refs Passed Deep into the System

Problem: the `Workbench` component creates 40+ refs that are bundled into `WorkbenchDomElements` and passed through the runtime. This makes it hard to know which refs are needed for which functionality, hard to refactor the UI structure, hard to mock for testing, and hard to lazy-load functionality.

Feasibility verdict:
- The critique is valid, but the right target is not just "fewer refs." The right target is a capability-based DOM boundary between the React shell and the imperative workbench runtime.
- The current proposal is directionally right, but one flat `WorkbenchDomRequirements` object would still leave several unrelated concerns bundled together.
- The better target is smaller DOM surfaces grouped by consumer and validated independently.

Concrete reshaping:
1. Capability-based DOM surfaces: replace one monolithic `WorkbenchDomElements` bundle with narrower surfaces such as `EditorDomSurface`, `ToolbarDomSurface`, `DialogDomSurface`, `ViewportControlSurface`, and `StatusDisplaySurface`.
2. Per-surface validation: keep guard functions, but validate each surface separately so missing dependencies are local and testable. Each surface gets its own guard helper defined next to the interface.
3. Pass narrow surfaces to narrow consumers: the editor client gets only the editor-related surface, toolbar logic gets only toolbar surfaces, and file lifecycle code does not receive unrelated controls.
4. Keep React-side ref ownership but group refs by capability: the `Workbench` component still owns refs, but it assembles them into grouped capability surfaces instead of one large all-purpose object.

Implementation staging for the later checklist item:
1. Define the new DOM surface interfaces and validation helpers alongside the existing workbench DOM types.
2. Migrate `workbench-editor-client.ts` to consume an `EditorDomSurface` plus any narrowly required status or dialog surfaces.
3. Migrate toolbar-related controllers to consume `ToolbarDomSurface` directly.
4. Update the `Workbench` component to build grouped surfaces instead of one monolithic ref bundle.
5. Delete the old `WorkbenchDomElements` type once all consumers have been narrowed.

Non-goals for this item:
- Do not treat this as a pure ref-count reduction exercise inside React
- Do not keep zoom controls, status display, dialogs, and editor internals in one dependency group
- Do not pass a slightly renamed monolithic DOM bundle through the runtime and call that solved

Concrete reshaping: use capability-based DOM surfaces instead of one large requirements object:

```ts
interface EditorDomSurface {
	editor: HTMLDivElement;
	customCaret: HTMLDivElement;
	diffGutter: HTMLDivElement;
}

interface StatusDisplaySurface {
	filePathLabel: HTMLElement;
	statusLine: HTMLElement;
}

interface ToolbarDomSurface {
	floating: HTMLDivElement;
	revisionHover: HTMLDivElement;
	revisionAccept: HTMLButtonElement;
	revisionReject: HTMLButtonElement;
}

interface DialogDomSurface {
	saveConflict: Required<WorkbenchDialogElements>;
	resetDraft: Required<WorkbenchDialogElements>;
}

function hasRequiredEditorDomSurface(surface: Partial<EditorDomSurface> | null | undefined): surface is EditorDomSurface {
	return Boolean(surface?.editor && surface?.customCaret && surface?.diffGutter);
}

const editorClient = createWorkbenchEditorClient(
	{ editor, statusDisplay, dialogs, toolbars },
	options,
);
```

