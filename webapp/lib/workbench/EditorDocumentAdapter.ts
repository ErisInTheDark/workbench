/*
 * Exports:
 * - EditorDocumentRenderOptions: optional rendered-state override for restoring exact draft markup. Keywords: workbench, editor, document, render, draft.
 * - EditorDocumentAdapter: narrow imperative bridge for file lifecycle document rendering, selection, editability, and chrome refresh work. Keywords: workbench, editor, document, adapter, selection.
 */

import type { EditHistorySelection } from "./edit-history";
import type { EditorMode, SaveGuardIssue } from "./workbench-editor-client";

export interface EditorDocumentRenderOptions {
  renderedState?: string | null;
}

export interface EditorDocumentAdapter {
  captureSelection: () => EditHistorySelection | null;
  inspectDraft: () => { content: string; issue: SaveGuardIssue | null };
  inspectRichDocument: () => { markdown: string; issue: SaveGuardIssue | null };
  readRenderedState: (mode: EditorMode) => string;
  refreshStatusMessage: (message?: string) => void;
  renderDocument: (content: string, mode: EditorMode, options?: EditorDocumentRenderOptions) => void;
  restoreSelection: (selection: EditHistorySelection | null) => void;
  scheduleDiffGutterRefresh: () => void;
  setEditable: (editable: boolean) => void;
}