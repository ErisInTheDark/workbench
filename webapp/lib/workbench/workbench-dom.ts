/*
 * Exports:
 * - WorkbenchDialogElements: grouped dialog shell and action button elements for imperative workbench flows. Keywords: workbench, dialog, DOM, refs.
 * - WorkbenchToolbarElements: grouped floating toolbar elements for editor formatting actions. Keywords: workbench, toolbar, DOM, refs.
 * - WorkbenchDomElements: typed React-owned DOM surface required by the workbench clients. Keywords: workbench, DOM, refs, editor.
 * - hasRequiredWorkbenchDomElements: validate that the required imperative workbench elements are present before boot. Keywords: workbench, DOM, guard.
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

export interface WorkbenchToolbarElements {
  floating: HTMLDivElement;
  revisionHover: HTMLDivElement;
  revisionAccept: HTMLButtonElement;
  revisionReject: HTMLButtonElement;
}

export interface WorkbenchDomElements {
  editor: HTMLDivElement;
  customCaret: HTMLDivElement;
  diffGutter: HTMLDivElement;
  filePathLabel: HTMLElement;
  resetDraftButton: HTMLButtonElement;
  saveFileButton: HTMLButtonElement;
  statusLine: HTMLElement;
  zoomInButton: HTMLButtonElement;
  zoomOutButton: HTMLButtonElement;
  saveConflictDialog: WorkbenchDialogElements;
  resetDraftDialog: WorkbenchDialogElements;
  toolbars: WorkbenchToolbarElements;
}

export function hasRequiredWorkbenchDomElements(elements: Partial<WorkbenchDomElements> | null | undefined): elements is WorkbenchDomElements {
  if (!elements) {
    return false;
  }

  return Boolean(
    elements.editor
      && elements.customCaret
      && elements.diffGutter
      && elements.filePathLabel
      && elements.resetDraftButton
      && elements.saveFileButton
      && elements.statusLine
      && elements.zoomInButton
      && elements.zoomOutButton
      && elements.saveConflictDialog?.dialog
      && elements.saveConflictDialog?.summary
      && elements.saveConflictDialog?.expected
      && elements.saveConflictDialog?.actual
      && elements.saveConflictDialog?.keepEditing
      && elements.saveConflictDialog?.reload
      && elements.saveConflictDialog?.overwrite
      && elements.resetDraftDialog?.dialog
      && elements.resetDraftDialog?.cancel
      && elements.resetDraftDialog?.resetToHead
      && elements.resetDraftDialog?.resetToSaved
      && elements.toolbars?.floating
      && elements.toolbars?.revisionHover
      && elements.toolbars?.revisionAccept
      && elements.toolbars?.revisionReject,
  );
}