/*
 * Exports:
 * - WorkbenchDialogElements: dialog shell and action elements for imperative flows.
 * - SaveConflictDialogDomSurface: required overwrite and reload dialog elements.
 * - DialogDomSurface: grouped runtime dialog capabilities.
 * - ToolbarDomSurface: the floating accept/reject toolbar shown over revisions.
 * - EditorDomSurface: React-owned editor elements; the review layer holds suggestion originals beside the text, and the
 *   source textarea takes the editor's place in source mode.
 * - StatusDisplaySurface: file path and status labels.
 * - WORKBENCH_STICKY_CHROME_ATTRIBUTE: marks sticky chrome the floating editor toolbars must stay below.
 * - WorkbenchEditorDomSurfaces: DOM capabilities consumed by the editor client.
 */

export const WORKBENCH_STICKY_CHROME_ATTRIBUTE = "data-workbench-sticky-chrome";

export interface WorkbenchDialogElements {
  dialog: HTMLDivElement;
  summary?: HTMLElement | null;
  expected?: HTMLElement | null;
  actual?: HTMLElement | null;
  keepEditing?: HTMLButtonElement | null;
  reload?: HTMLButtonElement | null;
  overwrite?: HTMLButtonElement | null;
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

export interface DialogDomSurface {
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
  /** Source mode edits the markdown text here, in the editor's place. */
  source: HTMLTextAreaElement;
}

export interface StatusDisplaySurface {
  filePathLabel: HTMLElement;
  statusLine: HTMLElement;
}

export interface WorkbenchEditorDomSurfaces {
  dialogs: DialogDomSurface;
  editor: EditorDomSurface;
  statusDisplay: StatusDisplaySurface;
  toolbars: ToolbarDomSurface;
}
