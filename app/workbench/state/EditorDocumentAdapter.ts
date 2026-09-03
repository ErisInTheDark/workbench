/*
 * Exports:
 * - EditorDocumentRenderOptions: optional rendered-state override for restoring exact draft markup. Keywords: workbench, editor, document, render, draft.
 * - default EditorDocumentAdapter: narrow imperative bridge for file lifecycle document rendering, minimal patching, selection, save-guard inspection and logging, editability, and chrome refresh work. Keywords: workbench, editor, document, adapter, selection, save guard, patch, default export.
 */

import type { EditorMode, SaveGuardIssue } from "../WorkbenchEditorClient";
import type { EditHistorySelection } from "./edit-history";

export interface EditorDocumentRenderOptions {
  renderedState?: string | null;
}

export default interface EditorDocumentAdapter {
  appendMarkdownFragment: (markdown: string) => void;
  captureSelection: () => EditHistorySelection | null;
  inspectDraft: () => { content: string; issue: SaveGuardIssue | null };
  inspectRichDocument: () => { markdown: string; issue: SaveGuardIssue | null };
  isFocused: () => boolean;
  logBlockedSaveIssue: (issue: SaveGuardIssue) => void;
  readRenderedState: (mode: EditorMode) => string;
  refreshStatusMessage: (message?: string) => void;
  renderDocument: (content: string, mode: EditorMode, options?: EditorDocumentRenderOptions) => void;
  restoreSelection: (selection: EditHistorySelection | null) => void;
  scheduleDiffGutterRefresh: () => void;
  setEditable: (editable: boolean) => void;
}
