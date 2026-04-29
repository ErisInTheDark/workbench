# Workbench Architecture Review Tracker

This file is a live snapshot of pending work only.
When the user confirms an item is complete, remove the completed checklist entry and remove the resolved section entirely.
Keep this file focused on unresolved architecture work for the workbench so future context windows only load active decisions.

### Implementation Master Order

- [ ] Implement `Utility File Proliferation Without Coherent Layering` last, after the earlier ownership and state work has finalized which files belong to which layer.


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
