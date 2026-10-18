/*
 * Exports:
 * - EditorDocumentRenderOptions: optional rendered-state override for restoring exact draft markup. Keywords: workbench, editor, document, render, draft.
 * - default EditorDocumentAdapter: narrow imperative bridge for file lifecycle document rendering in rich or source mode, minimal patching, selection and caret anchors across modes, save-guard inspection and logging, editability, and chrome refresh work. Keywords: workbench, editor, document, adapter, selection, save guard, patch, default export.
 */

import type { CaretAnchor } from "../dom/selection/mode-caret-anchor";
import type { EditorMode, SaveGuardIssue } from "../WorkbenchEditorClient";
import type { EditHistorySelection } from "./edit-history";

export interface EditorDocumentRenderOptions {
  renderedState?: string | null;
}

export default interface EditorDocumentAdapter {
  appendMarkdownFragment: (markdown: string) => void;
  /** The words before the caret, to find it again after the document is shown in the other mode. */
  captureCaretAnchor: () => CaretAnchor | null;
  captureSelection: () => EditHistorySelection | null;
  inspectDraft: () => { content: string; issue: SaveGuardIssue | null };
  inspectRichDocument: () => { markdown: string; issue: SaveGuardIssue | null };
  isFocused: () => boolean;
  logBlockedSaveIssue: (issue: SaveGuardIssue) => void;
  readRenderedState: (mode: EditorMode) => string;
  refreshStatusMessage: (message?: string) => void;
  renderDocument: (content: string, mode: EditorMode, options?: EditorDocumentRenderOptions) => void;
  restoreCaretAnchor: (anchor: CaretAnchor | null) => void;
  restoreSelection: (selection: EditHistorySelection | null) => void;
  scheduleDiffGutterRefresh: () => void;
  setEditable: (editable: boolean) => void;
}
