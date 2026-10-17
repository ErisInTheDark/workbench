/*
 * Exports:
 * - WorkbenchDialogElements: dialog shell and action elements for imperative flows.
 * - SaveConflictDialogDomSurface: required overwrite and reload dialog elements.
 * - ResetDraftDialogDomSurface: required draft-reset dialog elements.
 * - DialogDomSurface: grouped runtime dialog capabilities.
 * - ToolbarDomSurface: the floating accept/reject toolbar shown over revisions.
 * - EditorDomSurface: React-owned editor elements; the review layer holds suggestion originals beside the text.
 * - StatusDisplaySurface: file path and status labels.
 * - ControlButtonsDomSurface: save and reset elements.
 * - WORKBENCH_STICKY_CHROME_ATTRIBUTE: marks sticky chrome the floating editor toolbars must stay below.
 * - WorkbenchEditorDomSurfaces: DOM capabilities consumed by the editor client.
 */

export const WORKBENCH_STICKY_CHROME_ATTRIBUTE = "data-workbench-sticky-chrome";

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
  revisionHover: HTMLDivElement;
  revisionAccept: HTMLButtonElement;
  revisionReject: HTMLButtonElement;
}

export interface EditorDomSurface {
  editor: HTMLDivElement;
  customCaret: HTMLDivElement;
  diffGutter: HTMLDivElement;
  reviewLayer: HTMLDivElement;
}

export interface StatusDisplaySurface {
  filePathLabel: HTMLElement;
  statusLine: HTMLElement;
}

export interface ControlButtonsDomSurface {
  resetDraftButton: HTMLButtonElement;
  saveFileButton: HTMLButtonElement;
}

export interface WorkbenchEditorDomSurfaces {
  controls: ControlButtonsDomSurface;
  dialogs: DialogDomSurface;
  editor: EditorDomSurface;
  statusDisplay: StatusDisplaySurface;
  toolbars: ToolbarDomSurface;
}
