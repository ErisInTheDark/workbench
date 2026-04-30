# WorkbenchEditorClient Stage 2 Plan

## Goal

Finish the ownership cleanup now that the editor document surface already lives behind `lib/workbench/WorkbenchEditorClient.ts`.

The remaining objective is:

- `WorkbenchClient` reads as the workbench assembly root and cross-client coordinator.
- `WorkbenchEditorClient` reads as the editor boundary, including editor-local wiring that still leaks through the coordinator.
- `WorkbenchFileClient` continues to own file lifecycle and persistence through the editor-owned document adapter.

## Current Codebase State

The current codebase already has these responsibilities in the editor boundary:

- the editor-owned `EditorDocumentAdapter`
- rich-document inspection and draft inspection
- save-guard normalization, deduplication, and logging
- editor render/read state, editability, status refresh, and diff refresh

`WorkbenchFileClient` already consumes that editor-owned adapter for file open, save, reset, refresh, and draft-buffer flows.

What still remains in `WorkbenchClient` is mostly editor-local wiring and callback assembly, including:

- `controllerOptions` assembly for editor controllers
- `mutationRuntime` callback assembly for selection capture/restore, replay rendering, and draft synchronization hooks
- editor-local helper wrappers such as `getInlineExpansionContainer()` and `syncEditorAfterStructuralChange()`
- editor-event-side DOM plumbing that still depends directly on coordinator-owned helper closures

That is the remaining stage-2 surface.

## Target Boundary

`WorkbenchClient` should know only:

- workbench DOM surfaces
- project, thread, file, and editor collaborators
- file-vs-thread selection policy
- explorer snapshot emission
- URL sync, startup, teardown, and polling
- public `WorkbenchControls`

`WorkbenchEditorClient` should know:

- editor DOM event handling
- inline format, code format, list structure, and rich-input behavior
- revision hover behavior
- custom caret, floating toolbar, and diff gutter behavior
- structural mutation sequencing
- the editor-owned document surface used by `WorkbenchFileClient`
- editor-local helper wiring that does not need coordinator policy knowledge

## Current Constraints

1. Selection-sensitive editor behavior still depends on same-turn browser timing, especially for pending inline formats, selection restoration, and revision UI.
2. `mutationRuntime` still carries callbacks for history capture, replay rendering, selection restore, and draft-buffer sync. Those responsibilities need to be reduced without breaking current sequencing.
3. Some editor behavior still depends on coordinator-owned DOM helper composition around list editing and selection utilities.
4. Stage 2 should be behavior-preserving. It should not reopen the already-landed document-surface or save-guard ownership move.

## Stage 2 Scope

Purpose:

- Remove the remaining editor-domain helpers and callback assembly from `WorkbenchClient`.

Scope:

- Internalize editor-local helper wiring that still sits in `WorkbenchClient` but only exists to serve `WorkbenchEditorClient`.
- Reduce `controllerOptions` and `mutationRuntime` to the smallest set of callbacks that genuinely require coordinator ownership.
- Delete pass-through wrappers in `WorkbenchClient` once the editor client can own them directly.
- Recheck the public shape of `WorkbenchEditorClient` so it reads as one cohesive editor facade rather than a mostly-internal controller assembler.
- Update nearby architecture notes if the final ownership line changes materially.

## Exit Criteria

- `WorkbenchClient` reads like orchestration and assembly, not editor-domain implementation.
- `WorkbenchEditorClient` owns the remaining editor-local wiring now injected by the coordinator.
- `WorkbenchFileClient` continues to talk to the editor-owned document adapter with no contract regression.
- File open, save, reset, refresh, undo or redo, and revision flows remain behaviorally unchanged.

## Validation Checklist

- selection restore after structural edits
- toolbar format commands
- inline pending-format behavior at a collapsed caret
- undo and redo
- revision accept and reject
- save-guard mismatch handling
- file open, save, reset, and refresh interactions after editor changes
- typecheck

## Suggested Next Pass

Start by auditing the remaining `controllerOptions` and `mutationRuntime` assembly in `WorkbenchClient`.

That is now the highest-value cut, because the document surface already moved behind `WorkbenchEditorClient`, and the remaining ownership debt is the coordinator still stitching together editor-local behavior that no longer needs to live there.