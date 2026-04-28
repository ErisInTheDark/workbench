# Workbench Architecture Review Tracker

This file is a live snapshot of pending work only.
When the user confirms an item is complete, remove the completed checklist entry and remove the resolved section entirely.
Keep this file focused on unresolved architecture work for the workbench so future context windows only load active decisions.

### Implementation Master Order

- [ ] 1. Implement `Monolithic Coordinator with Leaky State Ownership` first to establish `EditHistoryManager`, `SessionState`, `FileSessionState`, and the slimmer coordinator boundary.
- [ ] 2. Implement `Subclient Contracts Are Incompletely Defined` next so the file and editor contracts align with the canonical state model and `EditorDocumentAdapter`.
- [ ] 3. Implement `No Clear Data vs. UI State Separation` after the state and contract work so the coordinator can stop owning the master mutable state bag.
- [ ] 4. Implement `Bidirectional Callback Chains Between Subclients` only after steps 1-3, because it depends on one-way state ownership already existing.
- [ ] 5. Implement `Unsafe Event Handler Chains with Hidden Dependencies` after `EditHistoryManager` exists so `EditorMutationRunner` can delegate history work instead of duplicating it.
- [ ] 6. Implement `Unclean Disposal and Lifecycle` before the polling item so `LifecycleScope` becomes the shared ownership boundary for timers and subscriptions.
- [ ] 7. Implement `Polling Loops Have No Centralized Coordination` after lifecycle scopes exist so recurring refresh and debounce work use the same ownership model.
- [ ] 8. Implement `Too Many DOM Refs Passed Deep into the System` after the client boundaries are stable enough to narrow DOM surfaces with confidence.
- [ ] 9. Implement `Utility File Proliferation Without Coherent Layering` last, after the earlier ownership and contract work has finalized which files belong to which layer.


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
- `SessionState` and `FileSessionState` are introduced by `SEVERITY 1: Monolithic Coordinator with Leaky State Ownership` and then consumed or refined by later sections. Later sections should not reintroduce them.
- `LifecycleScope` is the canonical cleanup primitive. Timer scheduling for polling and debounce work uses the owning client's `LifecycleScope` rather than a separate timer manager abstraction.
- The coarse event layer is a single workbench-scoped event bus created by the coordinator. It carries only non-authoritative notifications such as file opened, thread opened, save completed, save conflict surfaced, and save guard issue surfaced. Authoritative state stays in `SessionState`, `FileSessionState`, project snapshots, thread snapshots, and `EditorUIState`.

## Architecture Critique: Workbench Client System
The sections below stay in critique order rather than implementation order. Follow `Implementation Master Order` when sequencing work.
Severity labels describe architectural impact and risk, not the order in which the work should be implemented.

### SEVERITY 1: Monolithic Coordinator with Leaky State Ownership

Problem: `workbench-client.ts` at ~1400 lines is a god coordinator that violates single responsibility at every level:

- Owns `WorkbenchState` (main state object) with 8 properties spanning files, threads, editor, and history
- Runs ~15 callback handlers (`handleEditorInput`, `handleEditorKeyDown`, `handleEditorClick`, etc.) that directly manipulate state
- Owns all the glue logic between 4 subclients (editor, file, project, thread) with no abstraction
- Contains business logic: undo/redo, history merging, save guard inspection, draft buffering, polling loops, UI toolbar positioning
- Owns imperative DOM operations mixed with state coordination (e.g., `updateFloatingToolbar()` at line 1378 calculates viewport metrics and directly manipulates DOM)

The `fileLifecycleState` anti-pattern: the proxy object tunnels state through three owners instead of one clear boundary:
- Reads file and history data from coordinator-owned fields such as `state.currentContent`, `state.baselineContent`, and `state.history`
- Reads UI snapshot fields from `state.editor.*`
- Writes back through `editorClient` setters such as `setCurrentFilePath`, `setDirty`, `setMode`, `setPendingWriteConflict`, and `setSaveIssue`
- This breaks encapsulation in both directions: the file client already behaves like the owner of file persistence state, but it can only reach that state through a proxy that couples it to the editor client and the main coordinator

Feasibility verdict:
- The diagnosis is valid: `workbench-client.ts` is carrying too much state and too many responsibilities, and the proxy seam is a real ownership leak rather than just awkward wiring
- The original split needs refinement: the current code shows that `dirty`, save-guard issues, write conflicts, content baselines, and mtime tracking behave as file persistence state, not as generic editor session state
- The first implementation pass should therefore separate selection state, file persistence state, and edit history before attempting broader DOM or event-bus refactors

Concrete reshaping:
1. `SessionState`: use the canonical target state model above and let it own selection plus snapshot and subscription APIs.
2. `FileSessionState`: use the canonical target state model above and let it replace the proxy-tunneled file persistence fields.
3. `EditHistoryManager`: owns `updateHistorySelection`, `recordEditHistory`, `applyHistoryState`, `undoEditHistory`, and `redoEditHistory` instead of leaving them inside the top-level coordinator. The later handler-pipeline work consumes this manager rather than replacing it.
4. `WorkbenchCoordinator`: owns client construction, subscriptions, explorer and thread emissions, high-level open/save orchestration, polling, and the DOM refresh coordination that still spans multiple clients.

Implementation staging for the later checklist item:
1. Extract `EditHistoryManager` first so undo/redo state stops living directly inside `workbench-client.ts`.
2. Introduce `SessionState` with snapshot and subscribe semantics, then remove `currentPath` and `currentThreadId` tunneling through `fileLifecycleState`.
3. Introduce `FileSessionState` and make the file client mutate that state directly instead of mutating editor snapshot fields through proxy setters.
4. Reduce `WorkbenchCoordinator` to wiring, emissions, and orchestration, leaving DOM-toolbar extraction, contract cleanup, and event-bus work to their later checklist items.

`EditHistoryManager` here is the foundational extraction. The later mutation-runner work consumes it rather than redefining history ownership.

Non-goals for this item:
- Do not introduce an event bus in this pass; defer coarse event-layer work to `SEVERITY 2: Bidirectional Callback Chains Between Subclients`
- Do not fold DOM utility consolidation into this change
- Do not pull polling scheduler work into this pass

### SEVERITY 1: Subclient Contracts Are Incompletely Defined

Problem: the four subclients have incoherent ownership patterns:

- `workbench-editor-client.ts`: injected with 20+ handlers and a massive `WorkbenchEditorClientOptions` interface. It owns UI state (dirty, mode, statusMessage, fontSize, dialogs) but doesn't own file or thread state.
- `workbench-file-client.ts`: injected with a proxy object (`fileLifecycleState`) instead of clear, discrete methods. It mutates state through the proxy and through side effects on passed-in callback methods.
- `workbench-project-client.ts`: self-contained. Clean creation and subscription pattern.
- `workbench-thread-client.ts`: self-contained. Clean creation and subscription pattern.

The inconsistency means:
- File client does not have a real authoritative state contract; it depends on a proxy that mixes coordinator data, editor snapshot state, and file persistence concerns.
- Editor client is a UI shell, but it is also being used as a write target for authoritative file state such as `dirty`, `saveIssue`, and `pendingWriteConflict`.
- Project and thread clients already demonstrate the target shape: narrow construction, internal owned state, and snapshot-plus-subscribe APIs.

Feasibility verdict:
- The critique is valid, but the current rewrite proposal is incomplete because it names selection and persistence ownership without naming the document-facing adapter the file client still needs.
- The main contract bug is not just "large option interfaces"; it is the split between authoritative write-side ownership and UI read-side rendering, with the coordinator and editor both standing in for missing state abstractions.
- The later implementation should move editor and file contracts toward the project/thread snapshot pattern without forcing those already-clean clients to change shape.

Concrete reshaping: redefine contracts around explicit state and document boundaries:
1. `SessionState`: use the canonical target state model above and keep it as the single selection authority.
2. `FileSessionState`: use the canonical target state model above and keep it as the authoritative file-editing state.
3. `EditorDocumentAdapter`: exposes the narrow document hooks the file lifecycle actually needs: `renderDocument`, `captureSelection`, `restoreSelection`, `setEditable`, `scheduleDiffGutterRefresh`, and `refreshStatusMessage`. The coordinator creates one adapter for the active editor shell, passes it to the file client, and the adapter delegates to the editor client's existing render and scheduling hooks instead of owning separate scheduling state.
4. `EditorClient`: owns shell and rendering concerns only: font size, dialogs, toolbar and diff-gutter scheduling, status line rendering, DOM event wiring, and visible file or thread labels. It consumes `SessionState` and `FileSessionState` or a derived view model instead of owning authoritative file state itself.
5. `ProjectClient` and `ThreadClient`: remain the reference contract shape and should stay narrow while the other clients are moved toward the same snapshot-plus-subscribe model.

`EditorDocumentAdapter` does not replace `FileSessionState`. The file client mutates `FileSessionState` first, then uses `EditorDocumentAdapter` only for imperative document and terminal refresh work.

Implementation staging for the later checklist item:
1. Introduce `SessionState` and stop treating the editor snapshot as the authoritative owner of `currentPath` and `currentThreadId`.
2. Introduce `FileSessionState` and replace `fileLifecycleState` with that explicit state object.
3. Replace the file client's dependency on editor setters with `EditorDocumentAdapter`, keeping only the document and rendering hooks the file lifecycle truly needs.
4. Slim `WorkbenchEditorClientOptions` by moving file-lifecycle operations out of the editor shell and leaving only UI event handlers plus rendering queries.
5. Align the coordinator around subscriptions from `SessionState`, `FileSessionState`, `ProjectClient`, `ThreadClient`, and `EditorClient` instead of manual cross-mutation.

Non-goals for this item:
- Do not broaden `ProjectClient` or `ThreadClient` just for symmetry
- Do not introduce an event bus here; that belongs to the later callback-chain item
- Do not fold history-manager extraction into this item beyond the contract boundaries already defined above

### SEVERITY 2: Unsafe Event Handler Chains with Hidden Dependencies

Problem: the event handlers are a maze of interdependent operations with no clear sequencing or rollback. Example at lines 310-325 (`handleEditorInput`):

```ts
const previousContent = state.currentContent;
const { transformedListItem, commentCaretMarker: richInputCommentCaretMarker } = editorClient.handleRichInput(event);
const commentCaretMarker = richInputCommentCaretMarker ?? maybeActivateInlineCommentShortcut(event);
syncStructuredBlockStyles();
if (transformedListItem) {
	restoreListItemSelection([transformedListItem], { collapsed: true, getListItemTextContainer });
}
if (commentCaretMarker) {
	restoreCaretToMarker(commentCaretMarker);
}
inspectCurrentDraft();
recordEditHistory(previousContent, state.currentContent, captureEditorSelection(editor));
syncCurrentDraftBuffer();
editorClient.scheduleDiffGutterRefresh();
editorClient.refreshStatusMessage();
refreshInlineToolbars();
```

- No error handling if any step fails
- Order matters but isn't documented
- `inspectCurrentDraft()` mutates `state.currentContent`, which is then used in `recordEditHistory()` - hidden dependency
- 11 operations with no atomicity guarantee

The same mixed pipeline also appears in `applyHistoryState()` and `syncEditorAfterStructuralChange()`, which means the problem is not a single long handler but a repeated mutation lifecycle with hidden state transitions.

Feasibility verdict:
- The critique is valid and should stay at severity 2.
- The current proposal is pointed in the right direction, but the exact `EditTransaction` sketch is not the best target because it implies rollback and commit semantics the workbench does not actually have.
- The better target is a shared operation runner with an explicit operation context and a fixed edit lifecycle that all three flows use.

Concrete reshaping: introduce a shared mutation pipeline:
1. `EditOperationContext`: owns per-operation data such as `previousContent`, `previousSelection`, `nextContent`, `nextSelection`, mutation artifacts like transformed list items or caret markers, and flags for `recordHistory`, `syncDraftBuffer`, and `refreshUi`.
2. `EditorMutationRunner`: enforces one ordered execution model: capture baseline, run DOM mutation callback, normalize and inspect draft state, restore selection or markers, delegate history recording or replay to `EditHistoryManager`, sync draft buffer, and run terminal UI refresh.
3. Operation-specific entry points: `runInputMutation`, `runStructuralMutation`, and `runHistoryReplay` stay behavior-specific but all delegate to the same runner.
4. Error handling model: do not promise rollback. Centralize logging and failure boundaries at the runner level so partial failures are debuggable instead of silently hidden inside ad-hoc handler chains.

`EditOperationContext` is a data-only object for one logical mutation lifecycle. It does not own timers, subscriptions, or any client-lifetime resources.

Implementation staging for the later checklist item:
1. Define `EditOperationContext` and `EditorMutationRunner` next to the coordinator code and migrate `handleEditorInput()` first.
2. Migrate `syncEditorAfterStructuralChange()` onto the same runner so structural edits use the same mutation lifecycle.
3. Migrate `applyHistoryState()` as a replay-mode operation that skips history recording but keeps the same baseline capture, draft inspection, selection restoration, and terminal refresh lifecycle.
4. Remove the duplicated tail sequences for draft sync, diff refresh, status refresh, and toolbar or caret updates once all three paths use the runner.

Non-goals for this item:
- Do not introduce rollback or transactional commit semantics
- Do not hide errors behind success or error return objects that callers will ignore
- Do not fold DOM utility extraction or history ownership changes into this item; those belong to later checklist items

Concrete reshaping: replace the current transaction sketch with a shared runner shaped more like:

```ts
class EditorMutationRunner {
	run(context: EditOperationContext, mutate: () => void): void;
}
```

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
- Implement the `SEVERITY 1` coordinator and contract work first so editor and coordinator boundaries are final before files move layers. This item is scheduled last despite its severity because it depends on those boundaries being stable.

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

### SEVERITY 2: Bidirectional Callback Chains Between Subclients

Problem: `workbench-editor-client` is given callbacks to refresh the file client, and the file client gets callbacks back into the editor. This creates hidden coupling:

- `workbench-editor-client` implicitly depends on a `fileClient` existing and having state ready
- `workbench-file-client` directly modifies editor state via callbacks
- If you want to use either client elsewhere, you need all the callbacks

Feasibility verdict:
- The critique is valid, but the current event-bus proposal is too broad.
- The real problem is not just "callbacks in both directions"; it is that the file client mutates both authoritative file state and editor-rendering state in the same hot path.
- The better target is one-way state ownership with a small event layer reserved for coarse cross-client notifications.

Concrete reshaping:
1. One-way authoritative state: the file client owns `FileSessionState` and mutates that directly. The editor client renders from `SessionState` and `FileSessionState` snapshots instead of receiving imperative setter chains for `dirty`, `pendingWriteConflict`, `saveIssue`, and `mode`.
2. `EditorDocumentAdapter` remains the only direct editor-facing bridge for the file client so document rendering, selection capture or restore, and diff or status refresh stay narrow and explicit.
3. Narrow command surface downward: the coordinator issues commands into clients (`openFile`, `saveCurrentFile`, `openThread`, `clearSelection`) but subclients do not directly mutate each other's state through setter APIs.
4. Small event layer for coarse notifications only: if an event layer exists, it should be used for events like `fileOpened`, `threadOpened`, `saveCompleted`, `saveConflictSurfaced`, and `saveGuardIssueSurfaced`, not for every state update.
5. Snapshot subscriptions as the default read path: project, thread, session, and file state layers expose snapshot-plus-subscribe semantics so clients react to owned state instead of tunneling mutations into one another.

This is the item that introduces the coarse event layer deferred by `SEVERITY 1: Monolithic Coordinator with Leaky State Ownership`.

Implementation staging for the later checklist item:
1. Prerequisite: complete the `SEVERITY 1` introduction of `SessionState` and `FileSessionState` first so this item builds on one-way state ownership instead of redefining it.
2. Remove the file client's dependency on editor setters for `dirty`, conflict, save issue, mode, and current selection display state.
3. Keep the file client's document interactions behind `EditorDocumentAdapter` instead of a wide editor client dependency.
4. Make the editor shell subscribe to `FileSessionState` and `SessionState` and derive its rendered status from those snapshots.
5. Add a small coarse-grained event layer only for cross-client notifications that are not naturally represented as owned state.
6. Remove direct subclient-to-subclient mutation paths and leave the coordinator as the only place where commands are routed across client boundaries.

This item finishes the setter-removal work that `SEVERITY 1: Subclient Contracts Are Incompletely Defined` starts. That earlier item establishes `EditorDocumentAdapter`; this item removes the remaining cross-client mutation chains once one-way state ownership already exists.

Non-goals for this item:
- Do not use a generic event bus as the transport for authoritative file or editor state
- Do not emit events for every `dirty`, `mode`, `saveIssue`, or `pendingWriteConflict` change
- Do not preserve direct file-client-to-editor-client setter chains as an acceptable steady-state contract

Concrete reshaping: use a hybrid state-plus-event model instead of a bus-first design:

```ts
const fileSession = createFileSessionState();
const sessionState = createSessionState();
const eventBus = createWorkbenchEventBus();
const editorDocument = createEditorDocumentAdapter();

const editorClient = createWorkbenchEditorClient(elements, {
	fileSession,
	sessionState,
	eventBus,
});

const fileClient = createWorkbenchFileClient({
	fileSession,
	sessionState,
	editorDocument,
	eventBus,
});
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

Concrete reshaping: use the lifecycle-backed timer helpers defined in `SEVERITY 3: Unclean Disposal and Lifecycle` with local ownership instead:

```ts
const coordinatorLifecycle = new LifecycleScope();
coordinatorLifecycle.scheduleRepeat("auto-refresh", 1500, refreshTree);

const threadLifecycle = new LifecycleScope();
threadLifecycle.scheduleOnce("thread-refresh", 350, () => {
	void refreshThreads();
});
```

### SEVERITY 3: No Clear Data vs. UI State Separation

Problem: `WorkbenchState` mixes data state with UI state:

```ts
interface WorkbenchState {
	baselineContent: string;
	currentContent: string;
	draftBuffers: Map<...>;
	editor: WorkbenchEditorSnapshot;
	expectedMtimeMs: number | null;
	headContent: string | null;
	history: EditHistoryState | null;
	lastLoggedSaveIssue: ... | null;
	project: WorkbenchProjectSnapshot;
	thread: WorkbenchThreadSnapshot;
}
```

This means:
- Changes to `dirty` flag (UI) trigger the same subscribers as changes to `baselineContent` (data)
- Can't easily snapshot or restore just the editor state
- Hard to test state transitions independently

Feasibility verdict:
- The critique is valid, but the current two-bucket split is not precise enough.
- The better target is not `WorkbenchDataState` plus `WorkbenchUIState` as two large buckets. It is a small set of owned state layers with clear authority.
- `dirty`, `mode`, `saveIssue`, and `pendingWriteConflict` are not UI-only fields. They belong with authoritative file session state.

Concrete reshaping:

1. `SessionState`: use the canonical target state model above and keep it as the single selection authority.

2. `FileSessionState`: use the canonical target state model above and keep it as the authoritative file editing and persistence state.

3. `EditorUIState`: use the canonical target state model above and keep it limited to UI-only concerns.

4. Project and thread stay in their own owned snapshots instead of being folded into a new generic data bag.

5. The coordinator becomes a composer of snapshots from `SessionState`, `FileSessionState`, project, thread, and editor UI state instead of the authoritative owner of one master mutable state object.

Implementation staging for the later checklist item:
1. Use the `SessionState` and `FileSessionState` established by `SEVERITY 1: Monolithic Coordinator with Leaky State Ownership` instead of reintroducing them here.
2. Migrate file lifecycle code to mutate `FileSessionState` directly and stop routing that state through the editor snapshot.
3. Reduce editor-owned state to UI-only concerns and make rendered status derive from `FileSessionState` plus `SessionState`.
4. Shrink or delete the top-level `WorkbenchState` bag so the coordinator becomes a composer of owned snapshots rather than the owner of everything.

Non-goals for this item:
- Do not put `dirty`, `mode`, `saveIssue`, or `pendingWriteConflict` into `WorkbenchUIState`
- Do not create a new generic `WorkbenchDataState` bag that reabsorbs project and thread state
- Do not solve event-bus or handler-pipeline problems inside this item; this item is about state authority

Canonical state shape:
- Use the `Canonical Target State Model` in `Shared Foundations` above.

### SEVERITY 3: Unclean Disposal and Lifecycle

Problem: `initWorkbench()` returns a cleanup function, but:

- subclients don't have a consistent disposal pattern (some have `dispose()`, some return unsubscribe functions)
- timeout IDs are tracked manually instead of using `AbortSignal`
- there's no way to test cleanup without running the full initialization
- controllers (inline-format, etc.) don't expose dispose methods

Feasibility verdict:
- The critique is valid, but the current `WorkbenchLifecycle` proposal is too coordinator-centric.
- The better target is one lifecycle scope per client plus shallow coordinator cleanup.
- Resource ownership and lifecycle ownership should line up: the code that creates timers, listeners, subscriptions, or abortable work should also own their cleanup.

Concrete reshaping:
1. `LifecycleScope`: introduce a small reusable helper that owns `AbortController` access, timeout and animation-frame cancellation, timer scheduling helpers, unsubscribe callbacks, and an optional disposed guard.
2. Client-owned cleanup: editor, file, thread, and project clients each create or receive their own lifecycle scope and register their resources locally.
3. Shallow coordinator teardown: the coordinator disposes subclients, clears only coordinator-owned resources such as the auto-refresh loop, and aborts only coordinator-owned listeners.
4. Optional test injection: client creation may accept an optional lifecycle scope or timer helper so disposal behavior can be tested in isolation.

Implementation staging for the later checklist item:
1. Add a reusable `LifecycleScope` helper under the workbench layer.
2. Migrate the editor client first so its DOM listeners and animation frames are all owned by that scope.
3. Migrate file and thread clients so their timers, subscriptions, and disposal guards all live inside their own scope.
4. Simplify coordinator teardown so it only disposes clients and clears coordinator-owned resources.
5. Add targeted disposal tests around at least the editor and thread clients once lifecycle ownership is explicit.

Non-goals for this item:
- Do not make the coordinator the central owner of every disposable resource
- Do not keep cross-client timer cleanup in the coordinator once client lifecycle scopes exist
- Do not mix timer policy changes into this item; timer policy belongs to the polling and refresh item

Concrete reshaping: use client-local lifecycle scopes instead of one global manager:

```ts
class LifecycleScope {
	getSignal(): AbortSignal;
	scheduleOnce(id: string, delay: number, fn: () => void): void;
	scheduleRepeat(id: string, delay: number, fn: () => Promise<void>): void;
	addAnimationFrame(id: number): void;
	addUnsubscribe(fn: () => void): void;
	cancel(id: string): void;
	dispose(): void;
}

const editorLifecycle = new LifecycleScope();
const editorClient = createWorkbenchEditorClient(elements, options, editorLifecycle);

const threadLifecycle = new LifecycleScope();
const threadClient = createWorkbenchThreadClient(options, threadLifecycle);
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

