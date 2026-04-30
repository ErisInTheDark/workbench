# WorkbenchEditorClient Ownership Plan

## Goal

Move all editor-related ownership out of `lib/WorkbenchClient.ts` and behind `lib/workbench/WorkbenchEditorClient.ts`, while keeping `WorkbenchClient` as the higher-level workbench orchestrator.

This plan describes the remaining migration work from the current codebase.

The intended end state is:

- `WorkbenchClient` owns app-level composition, file/thread selection policy, explorer updates, URL sync, polling, and public controls.
- `WorkbenchEditorClient` owns editor runtime, editor chrome, editor DOM event handling, and the editor-facing document surface consumed by the file client.
- `WorkbenchFileClient` continues to own file lifecycle and persistence, but it talks to an editor-owned document interface rather than a document adapter assembled in `WorkbenchClient`.

The current codebase already has the mutation runtime behind `WorkbenchEditorClient`, but the document surface, draft inspection, rich-document inspection, and save-guard ownership are still split across the boundary. The remaining work is about finishing that editor boundary, then trimming `WorkbenchClient` down to orchestration-only responsibilities.

## Why This Needs Stages

The remaining migration surface is not one isolated block. It still crosses several concerns:

- DOM mutation and selection restoration
- edit history capture and replay
- save-guard inspection and logging
- file draft synchronization and persistence hooks

Trying to move all of that in one pass would create a high risk of subtle regressions in selection timing, draft buffering, and save-guard behavior.

The migration should therefore move ownership in layers, keeping each pass behavior-preserving.

## Target Boundary

`WorkbenchClient` should eventually know only:

- the workbench DOM surfaces
- the project, thread, file, and editor collaborators
- high-level file-vs-thread selection behavior
- explorer snapshot emission
- startup, teardown, and polling lifecycle
- the public `WorkbenchControls` surface

`WorkbenchEditorClient` should eventually know:

- editor DOM event handling
- inline format behavior
- code format behavior
- list/rich input behavior
- revision hover behavior
- custom caret and floating toolbar behavior
- structural mutation orchestration
- save-guard inspection for editor content
- the editor-owned document surface used by the file client

## Current Constraints

These constraints should shape the migration:

1. The mutation runtime now lives in `WorkbenchEditorClient`, but it still depends on coordinator-owned callbacks for draft inspection, history recording, selection restoration, and draft-buffer sync. That coupling is still real and should be reduced carefully.
2. The current `EditorDocumentAdapter` is not just render and selection plumbing. It also exposes draft inspection and rich-document inspection used by `WorkbenchFileClient`.
3. Inline formatting behavior relies on same-turn browser input timing and pending-format marker restoration.
4. Floating toolbar visibility depends on revision-selection state, so chrome and runtime have an explicit dependency.
5. Save-guard inspection depends on editor-specific markup normalization and inline-run classification.

## Plan

### Stage 1: Move Save-Guard Inspection and Document Surface Behind WorkbenchEditorClient

Purpose:

- Finish the editor boundary by making the editor own its document inspection and render surface.

Scope:

- Move the current document adapter assembly behind `WorkbenchEditorClient`.
- Move rich-document inspection and draft inspection there.
- Move markup normalization and save-guard logging ownership there.
- Rewire `WorkbenchFileClient` to consume the editor-owned surface.

Design note:

- This is now the most coupled remaining pass.
- If needed, split internal responsibilities inside the editor boundary so `WorkbenchEditorClient` remains the public facade while private runtime and inspection helpers stay modular.

Exit criteria:

- `WorkbenchClient` no longer assembles the document adapter.
- `WorkbenchFileClient` talks only to an editor-owned document surface.
- Save-guard behavior, logging, and persistence interactions remain unchanged.

### Stage 2: Thin WorkbenchClient to Orchestrator-Only Responsibilities

Purpose:

- Remove leftover editor-specific helpers and confirm the final boundary is clean.

Scope:

- Delete editor-domain helpers that no longer belong in `WorkbenchClient`.
- Confirm `WorkbenchClient` owns only cross-client orchestration.
- Update nearby architecture notes if the ownership model has materially changed.

Exit criteria:

- `WorkbenchClient` reads like an assembly root and workbench coordinator.
- `WorkbenchEditorClient` reads like the editor boundary.

## Recommended Public Shape for WorkbenchEditorClient

The exact API can evolve, but the end-state direction should look like this:

- A single public editor client created from editor DOM surfaces and a small set of coordinator callbacks.
- A cohesive editor behavior surface rather than controller-by-controller callbacks.
- An editor-owned document surface that can be handed to `WorkbenchFileClient`.
- Internal editor submodules kept private behind the editor client facade.

In other words, the boundary should move even if the implementation remains internally modular.

## Validation Strategy Per Remaining Pass

Every remaining pass should validate the narrowest behavior it changes.

Minimum validation checklist:

- selection restore after structural edits
- toolbar format commands
- inline pending-format behavior at a collapsed caret
- undo and redo
- revision accept and reject
- save-guard mismatch handling
- file open, save, reset, and refresh interactions after editor changes
- `pnpm run typecheck`

## Suggested Next Implementation Pass

Start with moving save-guard inspection and document-surface ownership behind `WorkbenchEditorClient`.

That is the next highest-value shift because mutation sequencing is already behind the editor boundary, but `WorkbenchClient` still assembles the document adapter and still owns editor-specific inspection and normalization responsibilities.

If that lands cleanly, the follow-up is to remove the leftover editor-domain helpers from `WorkbenchClient` and confirm the coordinator reads as orchestration-only code.