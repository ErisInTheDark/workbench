/*
 * Exports:
 * - WorkbenchDialogElements: dialog shell and action elements for imperative flows.
 * - SaveConflictDialogDomSurface: required overwrite and reload dialog elements.
 * - ResetDraftDialogDomSurface: required draft-reset dialog elements.
 * - DialogDomSurface: grouped runtime dialog capabilities.
 * - ToolbarDomSurface: floating formatting toolbar elements.
 * - EditorDomSurface: React-owned editor elements.
 * - StatusDisplaySurface: file path and status labels.
 * - ControlButtonsDomSurface: save, reset and zoom-trigger elements.
 * - WorkbenchDomSurfaces: React-owned DOM capabilities required by the runtime.
 * - WorkbenchEditorDomSurfaces: DOM capabilities consumed by the editor client.
 * - hasRequiredEditorDomSurface: validate editor elements before boot.
 * - hasRequiredStatusDisplaySurface: validate status elements before boot.
 * - hasRequiredControlButtonsDomSurface: validate control elements before boot.
 * - hasRequiredDialogDomSurface: validate dialog elements before boot.
 * - hasRequiredToolbarDomSurface: validate toolbar elements before boot.
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
  zoomButton: HTMLButtonElement;
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
      && surface?.zoomButton,
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
