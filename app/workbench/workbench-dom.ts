/*
 * Exports:
 * - WorkbenchDialogElements: grouped dialog shell and action button elements for imperative workbench flows. Keywords: workbench, dialog, DOM, refs.
 * - SaveConflictDialogDomSurface: required save-conflict dialog surface for overwrite and reload flows. Keywords: workbench, dialog, DOM, save conflict.
 * - ResetDraftDialogDomSurface: required reset-draft dialog surface for reset actions. Keywords: workbench, dialog, DOM, reset draft.
 * - DialogDomSurface: grouped dialog capability surfaces used by the runtime. Keywords: workbench, dialog, DOM, capability.
 * - ToolbarDomSurface: grouped floating toolbar capability surface for editor formatting actions. Keywords: workbench, toolbar, DOM, capability.
 * - EditorDomSurface: grouped editor capability surface owned by the React shell. Keywords: workbench, editor, DOM, capability.
 * - StatusDisplaySurface: grouped status label surface for file path and status messages. Keywords: workbench, status, DOM, capability.
 * - ControlButtonsDomSurface: grouped editor button surface for save, reset, and zoom controls. Keywords: workbench, controls, DOM, capability.
 * - WorkbenchDomSurfaces: typed React-owned grouped DOM surfaces required by the workbench runtime. Keywords: workbench, DOM, refs, capability surfaces.
 * - WorkbenchEditorDomSurfaces: narrowed DOM surfaces consumed by the editor client. Keywords: workbench, editor, DOM, capability surfaces.
 * - hasRequiredEditorDomSurface: validate the required editor DOM surface before boot. Keywords: workbench, DOM, guard, editor.
 * - hasRequiredStatusDisplaySurface: validate the required status DOM surface before boot. Keywords: workbench, DOM, guard, status.
 * - hasRequiredControlButtonsDomSurface: validate the required control button surface before boot. Keywords: workbench, DOM, guard, controls.
 * - hasRequiredDialogDomSurface: validate the required dialog surface before boot. Keywords: workbench, DOM, guard, dialogs.
 * - hasRequiredToolbarDomSurface: validate the required toolbar surface before boot. Keywords: workbench, DOM, guard, toolbar.
 */

export interface WorkbenchDialogElements {
  dialog: HTMLDivElement;
  summary?: HTMLElement | null;
  expected?: HTMLElement | null;
  actual?: HTMLElement | null;
  cancel?: HTMLButtonElement | null;
  keepEditing?: HTMLButtonElement | null;
  reload?: HTMLButtonElement | null;
  overwrite?: HTMLButtonElement | null;
  resetToHead?: HTMLButtonElement | null;
  resetToSaved?: HTMLButtonElement | null;
}

export interface SaveConflictDialogDomSurface extends WorkbenchDialogElements {
  actual: HTMLElement;
  dialog: HTMLDivElement;
  expected: HTMLElement;
  keepEditing: HTMLButtonElement;
  overwrite: HTMLButtonElement;
  reload: HTMLButtonElement;
  summary: HTMLElement;
}

export interface ResetDraftDialogDomSurface extends WorkbenchDialogElements {
  cancel: HTMLButtonElement;
  dialog: HTMLDivElement;
  resetToHead: HTMLButtonElement;
  resetToSaved: HTMLButtonElement;
}

export interface DialogDomSurface {
  resetDraft: ResetDraftDialogDomSurface;
  saveConflict: SaveConflictDialogDomSurface;
}

export interface ToolbarDomSurface {
  floating: HTMLDivElement;
  revisionHover: HTMLDivElement;
  revisionAccept: HTMLButtonElement;
  revisionReject: HTMLButtonElement;
}

export interface EditorDomSurface {
  editor: HTMLDivElement;
  customCaret: HTMLDivElement;
  diffGutter: HTMLDivElement;
}

export interface StatusDisplaySurface {
  filePathLabel: HTMLElement;
  statusLine: HTMLElement;
}

export interface ControlButtonsDomSurface {
  resetDraftButton: HTMLButtonElement;
  saveFileButton: HTMLButtonElement;
  zoomInButton: HTMLButtonElement;
  zoomOutButton: HTMLButtonElement;
}

export interface WorkbenchDomSurfaces {
  controls: ControlButtonsDomSurface;
  dialogs: DialogDomSurface;
  editor: EditorDomSurface;
  statusDisplay: StatusDisplaySurface;
  toolbars: ToolbarDomSurface;
}

export interface WorkbenchEditorDomSurfaces {
  controls: ControlButtonsDomSurface;
  dialogs: DialogDomSurface;
  editor: Pick<EditorDomSurface, "editor" | "customCaret" | "diffGutter">;
  statusDisplay: StatusDisplaySurface;
  toolbars: ToolbarDomSurface;
}

export function hasRequiredEditorDomSurface(surface: Partial<EditorDomSurface> | null | undefined): surface is EditorDomSurface {
  return Boolean(surface?.editor && surface?.customCaret && surface?.diffGutter);
}

export function hasRequiredStatusDisplaySurface(surface: Partial<StatusDisplaySurface> | null | undefined): surface is StatusDisplaySurface {
  return Boolean(surface?.filePathLabel && surface?.statusLine);
}

export function hasRequiredControlButtonsDomSurface(surface: Partial<ControlButtonsDomSurface> | null | undefined): surface is ControlButtonsDomSurface {
  return Boolean(
    surface?.resetDraftButton
      && surface?.saveFileButton
      && surface?.zoomInButton
      && surface?.zoomOutButton,
  );
}

export function hasRequiredDialogDomSurface(surface: Partial<DialogDomSurface> | null | undefined): surface is DialogDomSurface {
  return Boolean(
    surface?.saveConflict?.dialog
      && surface?.saveConflict?.summary
      && surface?.saveConflict?.expected
      && surface?.saveConflict?.actual
      && surface?.saveConflict?.keepEditing
      && surface?.saveConflict?.reload
      && surface?.saveConflict?.overwrite
      && surface?.resetDraft?.dialog
      && surface?.resetDraft?.cancel
      && surface?.resetDraft?.resetToHead
      && surface?.resetDraft?.resetToSaved,
  );
}

export function hasRequiredToolbarDomSurface(surface: Partial<ToolbarDomSurface> | null | undefined): surface is ToolbarDomSurface {
  return Boolean(
    surface?.floating
      && surface?.revisionHover
      && surface?.revisionAccept
      && surface?.revisionReject,
  );
}
