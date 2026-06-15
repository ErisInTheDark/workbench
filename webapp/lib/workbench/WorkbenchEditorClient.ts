/*
 * Exports:
 * - createInitialEditorUIStateSnapshot: create the default editor UI snapshot used before the editor client is constructed. Keywords: workbench, editor, UI, snapshot, initial state.
 * - EditorMode: current editor rendering mode. Keywords: workbench, editor, mode.
 * - SaveGuardIssue: persisted editor save-guard mismatch details. Keywords: workbench, editor, save guard, mismatch.
 * - EditorUIState: owned editor shell state for UI-only concerns such as font size, transient status, and thread labels. Keywords: workbench, editor, state, UI.
 * - EditorUIStateSnapshot: readonly projection of editor-owned UI state. Keywords: workbench, editor, snapshot, UI.
 * - EditorUIStateListener: subscriber signature for editor shell changes. Keywords: workbench, editor, subscribe.
 * - EditOperationHooks: optional post-mutation hooks used by the editor mutation runtime to restore selection-sensitive DOM state. Keywords: workbench, editor, mutation, hooks, selection.
 * - WorkbenchEditorControllerOptions: grouped controller dependencies injected from the coordinator so the editor client can own controller composition without owning higher-level orchestration. Keywords: workbench, editor, controller, composition, callbacks.
 * - WorkbenchEditorMutationRuntimeOptions: coordinator-owned callbacks the editor runtime still needs for history, draft inspection, and replay while Stage 1 ownership moves behind the editor boundary. Keywords: workbench, editor, mutation, history, draft, replay.
 * - WorkbenchEditorClientOptions: callbacks, mutation-runtime dependencies, structural-edit dependencies, controller inputs, and state readers delegated from the coordinator for editor behavior and deterministic rendering. Keywords: workbench, editor, callbacks, mutation, controller, structure, status, state.
 * - WorkbenchEditorClient: public surface for the editor shell client, including diff gutter refresh scheduling, editor-controller composition, revision toolbar state access, editor-owned mutation sequencing, and structural input handling. Keywords: workbench, editor, client, diff gutter, format, revision, list structure, rich input, mutation, dispose.
 * - default WorkbenchEditorClient: create the editor shell client that owns DOM refs, dialogs, diff gutter rendering, editor controller composition, mutation sequencing, event listener cleanup, and deterministic status messages. Keywords: workbench, editor, DOM, status, controller, format, revision, rich input, mutation, diff gutter, listeners, default export.
 */

import type { ChangeSummary, SaveConflictPayload } from "../types";
import {
    getEditorLineHeight,
    getExpandedRangeRect,
    getVisualViewportMetrics,
} from "./dom/layout/viewport-metrics";
import {
    replaceTag,
    unwrapTransparentSpans,
} from "./dom/mutation/dom-normalization";
import {
    syncStructuredBlockStyles as syncStructuredBlockDomStyles,
} from "./dom/mutation/structured-block-dom";
import {
    getNestedBlockElementsForItem,
    isIntentionalListBreakParagraph,
    isListElement,
    isSingleBreakParagraph,
} from "./dom/query/list-dom";
import {
    captureEditorSelection,
    restoreEditorSelection,
} from "./dom/selection/selection-dom";
import {
    isInlineRunContainer,
} from "./editor/inline-run-containers";
import RevisionHoverToolbarController, {
    type RevisionToolbarContext
} from "./editor/RevisionHoverToolbarController";
import WorkbenchCodeFormatController from "./editor/WorkbenchCodeFormatController";
import WorkbenchFormatCommandController from "./editor/WorkbenchFormatCommandController";
import WorkbenchInlineFormatController, {
    type CaretRenderContext,
    type WorkbenchInlineFormatControllerOptions,
} from "./editor/WorkbenchInlineFormatController";
import WorkbenchListStructureController, { type WorkbenchListStructureControllerOptions } from "./editor/WorkbenchListStructureController";
import WorkbenchRichInputController, { type WorkbenchRichInputResult } from "./editor/WorkbenchRichInputController";
import {
    markdownToHtml as renderMarkdownToHtml,
} from "./markdown/markdown-html-render";
import {
    parseBlocks as parseMarkdownBlocks,
    type ParsedBlock,
} from "./markdown/markdown-parse";
import {
    inspectDraftContent,
    inspectSaveGuardMarkup,
    isSameSaveGuardIssue,
    logSaveGuardIssue,
} from "./markdown/save-guard-inspection";
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, persistFontSize, readStoredFontSize } from "./state/browser-state";
import type { EditHistorySelection } from "./state/edit-history";
import type { EditHistoryReplayRequest } from "./state/EditHistoryManager";
import type EditorDocumentAdapter from "./state/EditorDocumentAdapter";
import type FileSessionState from "./state/FileSessionState";
import LifecycleScope from "./state/LifecycleScope";
import type SessionState from "./state/SessionState";
import type { WorkbenchEditorDomSurfaces } from "./workbench-dom";

const DEFAULT_STATUS_MESSAGE = "Markdown files open as rich text. Save with Ctrl/Cmd+S.";
const DIRTY_STATUS_MESSAGE = "Unsaved changes.";
const PLAIN_TEXT_STATUS_MESSAGE = "Plain text file.";
const RICH_TEXT_SAVED_STATUS_MESSAGE = "Saved.";
const SAVE_GUARD_STATUS_MESSAGE = "Save blocked: markup mismatch. Check the console log.";
const THREAD_STATUS_MESSAGE = "Codex thread. Continue below.";
const WRITE_CONFLICT_STATUS_MESSAGE = "File changed on disk. Reload or overwrite to save.";
const TOOLBAR_TOUCH_MOUSE_COMPAT_WINDOW_MS = 750;
const TOOLBAR_INTERACTION_GRACE_MS = 220;

export type EditorMode = "rich" | "plain";

export interface SaveGuardIssue {
  markdown: string;
  currentMarkup: string;
  roundTripMarkup: string;
}

type DiffMarkerSymbol = "+" | "-" | "*";

interface DiffRow {
  path: string;
  signature: string;
}

interface DiffRowAnchor {
  path: string;
  element: HTMLElement;
}

interface DeletedMarkerPlacement {
  afterPath: string | null;
  beforePath: string | null;
}

interface DiffAnchorMetrics {
  bottom: number;
  center: number;
  top: number;
}

export interface EditorUIState {
  fontSize: number;
  statusMessage: string;
  threadLabel: string;
}

export interface EditorUIStateSnapshot {
  fontSize: number;
  statusMessage: string;
}

export type EditorUIStateListener = (snapshot: EditorUIStateSnapshot) => void;

export interface WorkbenchEditorControllerOptions {
  inlineFormat: Omit<WorkbenchInlineFormatControllerOptions, "captureEditorSelection" | "editor" | "getInlineExpansionContainer" | "refreshStatusMessage" | "syncEditorAfterStructuralChange" | "updateCustomCaret" | "updateInlineToolbars">;
}

type EditOperationKind = "input" | "structural" | "replay";
type EditOperationRefreshMode = "deferred" | "immediate";

interface EditOperationContext {
  kind: EditOperationKind;
  nextContent: string | null;
  nextSelection: EditHistorySelection | null;
  previousContent: string;
  previousSelection: EditHistorySelection | null;
  recordHistory: boolean;
  refreshMode: EditOperationRefreshMode;
  syncStructuredStyles: boolean;
  updateHistorySelection: boolean;
}

export interface EditOperationHooks {
  afterDomMutation?: () => void;
  afterSelectionRestore?: () => void;
}

export interface WorkbenchEditorMutationRuntimeOptions {
  inspectCurrentDraft: () => void;
  recordEditHistory: (previousContent: string, nextContent: string, selection: EditHistorySelection | null) => void;
  syncCurrentDraftBuffer: () => void;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
}

export interface WorkbenchEditorClientOptions {
  closeActiveDialog: () => boolean;
  controllerOptions: WorkbenchEditorControllerOptions;
  fileSessionState: FileSessionState;
  getEditorHasFocus: () => boolean;
  getProjectChangeSummary: (path: string) => ChangeSummary | null | undefined;
  handleCompositionEnd: () => void;
  handleCompositionStart: () => void;
  handleEditorBeforeInput: (event: InputEvent) => void;
  handleEditorBlur: () => void;
  handleEditorClick: (event: MouseEvent) => void;
  handleEditorFocus: () => void;
  handleEditorInput: (event: Event) => void;
  handleEditorKeyDown: (event: KeyboardEvent) => void;
  handleEditorPointerDown: () => void;
  handleEditorToggle: (event: Event) => void;
  handleOverwriteConflict: () => Promise<void>;
  handlePointerMove: (event: PointerEvent) => void;
  handleReloadConflict: () => Promise<void>;
  handleResetCurrentDraftToSaved: () => Promise<void>;
  handleResetCurrentFileToHead: () => Promise<void>;
  handleSaveCurrentFile: () => Promise<void>;
  handleSelectionChange: () => void;
  handleViewportChanged: () => void;
  isSaveButtonInvalid?: () => boolean;
  listStructure: Omit<WorkbenchListStructureControllerOptions, "editor" | "syncEditorAfterStructuralChange" | "updateFloatingToolbar">;
  mutationRuntime: WorkbenchEditorMutationRuntimeOptions;
  sessionState: SessionState;
  shouldBlockBeforeUnload: () => boolean;
}

interface WorkbenchEditorClient {
  applyHoveredRevisionAction: (action: "accept" | "reject") => void;
  applyToolbarCommand: (command: string) => void;
  canonicalizeAllInlineRunContainers: (root: ParentNode) => void;
  changeFontSize: (delta: number) => void;
  clearSelectionView: () => void;
  clearPendingInlineFormats: () => void;
  dispose: () => void;
  getDocumentAdapter: () => EditorDocumentAdapter;
  getCaretInlineContext: (range: Range) => CaretRenderContext | null;
  getSelectedRevisionToolbarContext: () => RevisionToolbarContext | null;
  getSnapshot: () => EditorUIStateSnapshot;
  handleFormatKeyDown: (event: KeyboardEvent) => boolean;
  handlePendingInlineBeforeInput: (event: InputEvent) => boolean;
  handlePendingInlineSelectionChange: () => void;
  handleRichInput: (event: Event) => WorkbenchRichInputResult;
  handleListStructureKeyDown: (event: KeyboardEvent) => boolean;
  hideResetDraftDialog: () => void;
  hideSaveConflictDialog: () => void;
  isPointerNearRevisionHoverUi: (clientX: number, clientY: number) => boolean;
  maybeActivateInlineCommentShortcut: (event: Event) => null;
  maybeClearPendingInlineFormatsForKey: (event: KeyboardEvent) => void;
  refreshEditorChrome: () => void;
  refreshStatusMessage: (message?: string) => void;
  runHistoryReplay: (request: EditHistoryReplayRequest) => void;
  runInputMutation: (mutate: () => void, hooks?: EditOperationHooks) => void;
  runStructuralMutation: (mutate: () => void, hooks?: EditOperationHooks) => void;
  scheduleEditorChromeRefresh: () => void;
  scheduleDiffGutterRefresh: () => void;
  setHoveredRevisionNode: (node: HTMLElement | null) => void;
  setFontSize: (fontSize: number, options?: { persist?: boolean }) => void;
  setSaveButtonState: () => void;
  setStatusMessage: (message: string) => void;
  showResetDraftDialog: () => void;
  showSaveConflict: (conflict: SaveConflictPayload) => void;
  showThreadPlaceholder: (label: string) => void;
  subscribe: (listener: EditorUIStateListener) => () => void;
  syncStructuredBlockStyles: (root?: ParentNode) => void;
  updateCustomCaret: () => void;
  updateRevisionHoverToolbar: () => void;
}

export function createInitialEditorUIStateSnapshot(): EditorUIStateSnapshot {
  return {
    fontSize: readStoredFontSize(),
    statusMessage: DEFAULT_STATUS_MESSAGE,
  };
}

function createInitialEditorState(): EditorUIState {
  return {
    fontSize: readStoredFontSize(),
    statusMessage: DEFAULT_STATUS_MESSAGE,
    threadLabel: "",
  };
}

function appendParsedListDiffRows(
  block: Extract<ParsedBlock, { type: "ul" | "ol" }>,
  blockPath: string,
  depth: number,
  rows: DiffRow[],
) {
  block.items.forEach((item, index) => {
    const itemPath = `${blockPath}/item:${index}`;
    rows.push({
      path: itemPath,
      signature: `li|${block.type}|${depth}|${item.text}`,
    });

    let childRowIndex = 0;
    item.children.forEach((child) => {
      if (child.type === "break" || child.type === "list-break") {
        return;
      }

      appendParsedBlockDiffRows(child, `${itemPath}/child:${childRowIndex}`, depth + 1, rows);
      childRowIndex += 1;
    });
  });
}

function appendParsedBlockDiffRows(
  block: ParsedBlock,
  blockPath: string,
  depth: number,
  rows: DiffRow[],
) {
  switch (block.type) {
    case "break":
    case "list-break":
      return;
    case "ul":
    case "ol":
      appendParsedListDiffRows(block, blockPath, depth, rows);
      return;
    case "heading":
      rows.push({
        path: blockPath,
        signature: `heading|${block.level}|${block.text}`,
      });
      return;
    case "blockquote":
      rows.push({
        path: blockPath,
        signature: `blockquote|${block.text}`,
      });
      return;
    case "comment":
      rows.push({
        path: blockPath,
        signature: `comment|${block.text}`,
      });
      return;
    case "hr":
      rows.push({
        path: blockPath,
        signature: "hr|",
      });
      return;
    case "code":
      rows.push({
        path: blockPath,
        signature: `code|${block.language}|${block.text}`,
      });
      return;
    case "plan":
      rows.push({
        path: blockPath,
        signature: `plan|${block.text}`,
      });
      return;
    case "paragraph":
      rows.push({
        path: blockPath,
        signature: `paragraph|${block.text}`,
      });
      return;
  }
}

function flattenMarkdownDiffRows(markdown: string | null) {
  const rows: DiffRow[] = [];
  let blockIndex = 0;

  for (const block of parseMarkdownBlocks(markdown ?? "")) {
    if (block.type === "break" || block.type === "list-break") {
      continue;
    }

    appendParsedBlockDiffRows(block, `b${blockIndex}`, 0, rows);
    blockIndex += 1;
  }

  return rows;
}

function isDiffTrackableBlockElement(element: Element) {
  return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|pre|hr)$/i.test(element.tagName);
}

function appendLiveListDiffAnchors(
  listElement: HTMLUListElement | HTMLOListElement,
  blockPath: string,
  anchors: DiffRowAnchor[],
) {
  Array.from(listElement.children)
    .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement)
    .forEach((item, index) => {
      const itemPath = `${blockPath}/item:${index}`;
      anchors.push({
        path: itemPath,
        element: item,
      });

      let childAnchorIndex = 0;
      getNestedBlockElementsForItem(item).forEach((childBlock) => {
        if (
          childBlock instanceof HTMLBRElement
          || isIntentionalListBreakParagraph(childBlock)
          || isSingleBreakParagraph(childBlock)
        ) {
          return;
        }

        const childPath = `${itemPath}/child:${childAnchorIndex}`;
        childAnchorIndex += 1;

        if (isListElement(childBlock)) {
          appendLiveListDiffAnchors(childBlock, childPath, anchors);
          return;
        }

        if (isDiffTrackableBlockElement(childBlock)) {
          anchors.push({
            path: childPath,
            element: childBlock,
          });
        }
      });
    });
}

function flattenLiveDiffAnchors(root: ParentNode) {
  const anchors: DiffRowAnchor[] = [];
  const childElements = root instanceof Element || root instanceof DocumentFragment
    ? Array.from(root.children)
    : [];
  let blockIndex = 0;

  for (const childElement of childElements) {
    if (
      childElement instanceof HTMLBRElement
      || isIntentionalListBreakParagraph(childElement)
      || (childElement instanceof HTMLElement && isSingleBreakParagraph(childElement))
    ) {
      continue;
    }

    if (childElement instanceof HTMLUListElement || childElement instanceof HTMLOListElement) {
      appendLiveListDiffAnchors(childElement, `b${blockIndex}`, anchors);
      blockIndex += 1;
      continue;
    }

    if (!isDiffTrackableBlockElement(childElement)) {
      continue;
    }

    anchors.push({
      path: `b${blockIndex}`,
      element: childElement as HTMLElement,
    });
    blockIndex += 1;
  }

  return anchors;
}

function diffRowsAgainstHead(headRows: DiffRow[], currentRows: DiffRow[]) {
  const rowCount = headRows.length;
  const columnCount = currentRows.length;
  const dp = Array.from(
    { length: rowCount + 1 },
    () => new Uint32Array(columnCount + 1),
  );

  for (let rowIndex = rowCount - 1; rowIndex >= 0; rowIndex -= 1) {
    for (let columnIndex = columnCount - 1; columnIndex >= 0; columnIndex -= 1) {
      if (headRows[rowIndex].signature === currentRows[columnIndex].signature) {
        dp[rowIndex][columnIndex] = dp[rowIndex + 1][columnIndex + 1] + 1;
      } else {
        dp[rowIndex][columnIndex] = Math.max(
          dp[rowIndex + 1][columnIndex],
          dp[rowIndex][columnIndex + 1],
        );
      }
    }
  }

  const operations: Array<
    | { type: "equal"; row: DiffRow }
    | { type: "insert"; row: DiffRow }
    | { type: "delete"; row: DiffRow }
  > = [];
  let rowIndex = 0;
  let columnIndex = 0;

  while (rowIndex < rowCount || columnIndex < columnCount) {
    if (
      rowIndex < rowCount
      && columnIndex < columnCount
      && headRows[rowIndex].signature === currentRows[columnIndex].signature
    ) {
      operations.push({ type: "equal", row: currentRows[columnIndex] });
      rowIndex += 1;
      columnIndex += 1;
      continue;
    }

    const canInsert = columnIndex < columnCount;
    const canDelete = rowIndex < rowCount;

    if (
      canInsert
      && (!canDelete || dp[rowIndex][columnIndex + 1] >= dp[rowIndex + 1][columnIndex])
    ) {
      operations.push({ type: "insert", row: currentRows[columnIndex] });
      columnIndex += 1;
      continue;
    }

    if (canDelete) {
      operations.push({ type: "delete", row: headRows[rowIndex] });
      rowIndex += 1;
    }
  }

  const currentMarkers = new Map<string, DiffMarkerSymbol>();
  const deletedPlacements: DeletedMarkerPlacement[] = [];
  let previousEqualPath: string | null = null;

  for (let operationIndex = 0; operationIndex < operations.length;) {
    const operation = operations[operationIndex];
    if (operation.type === "equal") {
      previousEqualPath = operation.row.path;
      operationIndex += 1;
      continue;
    }

    const insertedPaths: string[] = [];
    let deletedCount = 0;

    while (operationIndex < operations.length && operations[operationIndex].type !== "equal") {
      const currentOperation = operations[operationIndex];
      if (currentOperation.type === "insert") {
        insertedPaths.push(currentOperation.row.path);
      } else {
        deletedCount += 1;
      }
      operationIndex += 1;
    }

    const nextEqualPath = operationIndex < operations.length
      ? operations[operationIndex].row.path
      : null;

    if (insertedPaths.length && deletedCount) {
      insertedPaths.forEach((path) => {
        currentMarkers.set(path, "*");
      });
      continue;
    }

    if (insertedPaths.length) {
      insertedPaths.forEach((path) => {
        currentMarkers.set(path, "+");
      });
      continue;
    }

    if (deletedCount) {
      deletedPlacements.push({
        afterPath: previousEqualPath,
        beforePath: nextEqualPath,
      });
    }
  }

  return { currentMarkers, deletedPlacements };
}

function getAnchorMetrics(element: HTMLElement, editorShell: HTMLElement) {
  const rect = element.getClientRects()[0];
  if (!rect || rect.height === 0) {
    return null;
  }

  const shellRect = editorShell.getBoundingClientRect();
  const top = rect.top - shellRect.top;
  const bottom = rect.bottom - shellRect.top;

  return {
    top,
    center: top + (bottom - top) / 2,
    bottom,
  } satisfies DiffAnchorMetrics;
}

function resolveDeletedMarkerTop(
  placement: DeletedMarkerPlacement,
  anchorMetrics: Map<string, DiffAnchorMetrics>,
  lineHeight: number,
) {
  const previousMetrics = placement.afterPath
    ? anchorMetrics.get(placement.afterPath) ?? null
    : null;
  const nextMetrics = placement.beforePath
    ? anchorMetrics.get(placement.beforePath) ?? null
    : null;

  if (previousMetrics !== null && nextMetrics !== null) {
    const gapStart = previousMetrics.bottom;
    const gapEnd = nextMetrics.top;

    if (gapEnd > gapStart) {
      return gapStart + (gapEnd - gapStart) / 2;
    }

    return previousMetrics.bottom + (nextMetrics.top - previousMetrics.bottom) / 2;
  }

  if (nextMetrics !== null) {
    return Math.max(0, nextMetrics.top - lineHeight * 0.5);
  }

  if (previousMetrics !== null) {
    return previousMetrics.bottom + lineHeight * 0.5;
  }

  return Math.max(0, lineHeight * 0.5);
}

function createDiffMarker(symbol: DiffMarkerSymbol, top: number) {
  const marker = document.createElement("span");
  marker.className = "editor-diff-marker";
  marker.dataset.markerType = symbol === "+" ? "insert" : symbol === "-" ? "delete" : "modify";
  marker.style.top = `${Math.max(0, top)}px`;
  marker.append(createDiffMarkerIcon(symbol));
  return marker;
}

function createDiffMarkerIcon(symbol: DiffMarkerSymbol) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("editor-diff-marker-icon");

  if (symbol === "*") {
    const asterisk = document.createElementNS("http://www.w3.org/2000/svg", "path");
    asterisk.setAttribute("d", "M10 4.35v11.3M5.15 7.15l9.7 5.7M14.85 7.15l-9.7 5.7");
    asterisk.setAttribute("stroke", "currentColor");
    asterisk.setAttribute("stroke-width", "2.25");
    asterisk.setAttribute("stroke-linecap", "round");
    asterisk.setAttribute("stroke-linejoin", "round");
    svg.append(asterisk);
    return svg;
  }

  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2.45");
  line.setAttribute("stroke-linecap", "round");

  if (symbol === "+") {
    line.setAttribute("d", "M10 5.2v9.6M5.2 10h9.6");
  } else {
    line.setAttribute("d", "M5.2 10h9.6");
  }

  svg.append(line);
  return svg;
}

function WorkbenchEditorClient(
  surfaces: WorkbenchEditorDomSurfaces,
  options: WorkbenchEditorClientOptions,
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchEditorClient {
  const listeners = new Set<EditorUIStateListener>();
  const state = createInitialEditorState();
  const signal = lifecycle.getSignal();
  const editor = surfaces.editor.editor;
  const customCaret = surfaces.editor.customCaret;
  const diffGutter = surfaces.editor.diffGutter;
  const editorShell = diffGutter.parentElement;
  const floatingToolbar = surfaces.toolbars.floating;
  const statusDisplay = surfaces.statusDisplay;
  const controls = surfaces.controls;
  const dialogSurface = surfaces.dialogs;
  const toolbars = surfaces.toolbars;
  const dialogs = [dialogSurface.saveConflict.dialog, dialogSurface.resetDraft.dialog] as const;
  let lastLoggedSaveIssue: SaveGuardIssue | null = null;
  let preservedToolbarSelection: EditHistorySelection | null = null;
  let lastNonMouseToolbarInteractionAt = 0;
  let toolbarInteractionActive = false;

  function captureCurrentSelection() {
    return captureEditorSelection(editor);
  }

  function restoreSelection(selection: EditHistorySelection | null) {
    restoreEditorSelection(editor, selection);
  }

  function getInlineExpansionContainer(node: Node | null) {
    const listItem = options.listStructure.getClosestListItem(node);
    if (listItem) {
      return options.listStructure.getListItemTextContainer(listItem);
    }

    let current: Node | null = node;
    while (current && current !== editor) {
      if (current instanceof HTMLElement && current.parentNode === editor) {
        return current;
      }

      current = current.parentNode;
    }

    return null;
  }

  function syncEditorAfterStructuralChange(mutate: () => void, hooks: EditOperationHooks = {}) {
    runStructuralMutation(mutate, hooks);
  }

  const listStructureController = WorkbenchListStructureController({
    editor,
    ...options.listStructure,
    syncEditorAfterStructuralChange,
    updateFloatingToolbar,
  });
  const richInputController = WorkbenchRichInputController({
    editor,
    getMode: () => options.fileSessionState.mode,
  });
  let previousSessionSnapshot = options.sessionState.getSnapshot();
  let previousFileSnapshot = options.fileSessionState.getSnapshot();

  function getSnapshot(): EditorUIStateSnapshot {
    return {
      fontSize: state.fontSize,
      statusMessage: state.statusMessage,
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function subscribe(listener: EditorUIStateListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function applyEditorFontSize() {
    editor.style.fontSize = `${state.fontSize}rem`;
  }

  function getMinimumToolbarTop(viewport = getVisualViewportMetrics()) {
    let minimumTop = viewport.top + 12;
    const headerChromeElements: HTMLElement[] = [
      statusDisplay.filePathLabel,
      statusDisplay.statusLine,
      controls.zoomOutButton,
      controls.zoomInButton,
      controls.saveFileButton,
      controls.resetDraftButton,
    ];

    for (const element of headerChromeElements) {
      if (!element.isConnected) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        continue;
      }

      minimumTop = Math.max(minimumTop, viewport.top + rect.bottom + 10);
    }

    return minimumTop;
  }

  function setSaveButtonState() {
    const isInvalid = options.isSaveButtonInvalid?.() ?? Boolean(options.fileSessionState.saveIssue);
    controls.saveFileButton.dataset.invalid = isInvalid ? "true" : "false";
    controls.saveFileButton.disabled = !options.sessionState.currentPath;
    controls.resetDraftButton.disabled = !options.sessionState.currentPath;
  }

  function formatChangeSummary(change: ChangeSummary | null | undefined) {
    if (!change) {
      return "";
    }

    const parts = [];
    if (change.additions) {
      parts.push(`+${change.additions}`);
    }
    if (change.deletions) {
      parts.push(`-${change.deletions}`);
    }
    return parts.join(" ");
  }

  function getDeterministicStatusMessage() {
    if (!options.sessionState.currentPath) {
      return options.sessionState.currentThreadId ? THREAD_STATUS_MESSAGE : DEFAULT_STATUS_MESSAGE;
    }

    if (options.fileSessionState.saveIssue) {
      return SAVE_GUARD_STATUS_MESSAGE;
    }

    if (options.fileSessionState.pendingWriteConflict) {
      return WRITE_CONFLICT_STATUS_MESSAGE;
    }

    if (options.fileSessionState.dirty) {
      return DIRTY_STATUS_MESSAGE;
    }

    const changeSummary = formatChangeSummary(options.getProjectChangeSummary(options.sessionState.currentPath));
    if (changeSummary) {
      return `Pending changes ${changeSummary}`;
    }

    return options.fileSessionState.mode === "rich" ? RICH_TEXT_SAVED_STATUS_MESSAGE : PLAIN_TEXT_STATUS_MESSAGE;
  }

  function syncEditorLabel() {
    if (options.sessionState.currentPath) {
      statusDisplay.filePathLabel.textContent = options.sessionState.currentPath;
      return;
    }

    if (options.sessionState.currentThreadId) {
      statusDisplay.filePathLabel.textContent = state.threadLabel || "Create new thread";
      return;
    }

    statusDisplay.filePathLabel.textContent = "Select a file";
  }

  function syncEditorModePresentation() {
    editor.dataset.placeholder = options.fileSessionState.mode === "rich"
      ? "Select a markdown file to start editing."
      : "Plain text mode";
  }

  function setStatusMessage(message: string) {
    state.statusMessage = message;
    statusDisplay.statusLine.textContent = message;
    emit();
  }

  function refreshStatusMessage(message = "") {
    if (message) {
      setStatusMessage(message);
      return;
    }

    setStatusMessage(getDeterministicStatusMessage());
  }

  function clearToolbarInteraction() {
    lifecycle.cancel("editor-toolbar-interaction");
    toolbarInteractionActive = false;
  }

  function scheduleToolbarInteractionReset() {
    toolbarInteractionActive = true;
    lifecycle.scheduleOnce("editor-toolbar-interaction", TOOLBAR_INTERACTION_GRACE_MS, () => {
      toolbarInteractionActive = false;
      refreshEditorChrome();
    });
  }

  function canShowToolbarOverlays() {
    return options.getEditorHasFocus() || toolbarInteractionActive;
  }

  const revisionHoverController = RevisionHoverToolbarController({
    canShowToolbar: canShowToolbarOverlays,
    editor,
    getExpandedRangeRect,
    getMinimumToolbarTop,
    getMode: () => options.fileSessionState.mode,
    getVisualViewportMetrics,
    onSyncEditorAfterStructuralChange: syncEditorAfterStructuralChange,
    revisionHoverAcceptButton: toolbars.revisionAccept,
    revisionHoverRejectButton: toolbars.revisionReject,
    revisionHoverToolbar: toolbars.revisionHover,
  });
  const inlineFormatController = WorkbenchInlineFormatController({
    captureEditorSelection: captureCurrentSelection,
    editor,
    getInlineExpansionContainer,
    refreshStatusMessage: () => {
      refreshStatusMessage();
    },
    syncEditorAfterStructuralChange,
    updateCustomCaret,
    updateInlineToolbars: refreshInlineToolbars,
    ...options.controllerOptions.inlineFormat,
  });
  const codeFormatController = WorkbenchCodeFormatController({
    editor,
    getProtectedEmptyInlineFormatElements: inlineFormatController.getProtectedEmptyInlineFormatElements,
    syncEditorAfterStructuralChange,
  });
  const formatCommandController = WorkbenchFormatCommandController({
    clearPendingInlineFormats: () => {
      inlineFormatController.clearPendingInlineFormats();
    },
    editor,
    getMode: () => options.fileSessionState.mode,
    syncEditorAfterStructuralChange,
    toggleCodeSelection: (selection, range) => {
      codeFormatController.toggleCodeSelection(selection, range);
    },
    toggleInlineFormatSelection: (selection, range, formatKey) => {
      inlineFormatController.toggleInlineFormatSelection(selection, range, formatKey);
    },
    togglePendingInlineFormat: (format) => {
      return inlineFormatController.togglePendingInlineFormat(format);
    },
  });

  function hideCustomCaret() {
    editor.removeAttribute("data-custom-caret-visible");
    customCaret.hidden = true;
    delete customCaret.dataset.caretKind;
    delete customCaret.dataset.caretBold;
    delete customCaret.dataset.caretItalic;
  }

  function updateCustomCaret() {
    if (!editorShell) {
      hideCustomCaret();
      return;
    }

    const selection = window.getSelection();
    if (
      !selection?.rangeCount
      || selection.isCollapsed === false
      || !editor.contains(selection.anchorNode)
      || !editor.contains(selection.focusNode)
    ) {
      hideCustomCaret();
      return;
    }

    const context = inlineFormatController.getCaretInlineContext(selection.getRangeAt(0));
    if (!context) {
      hideCustomCaret();
      return;
    }

    const shellRect = editorShell.getBoundingClientRect();
    const caretLeft = context.rect.left - shellRect.left;
    const caretTop = context.rect.top - shellRect.top;
    const caretHeight = Math.max(14, context.rect.height || getEditorLineHeight(editor));

    editor.dataset.customCaretVisible = "true";
    customCaret.hidden = false;
    customCaret.dataset.caretKind = context.kind;
    customCaret.dataset.caretBold = context.bold ? "true" : "false";
    customCaret.dataset.caretItalic = context.italic ? "true" : "false";
    customCaret.style.left = `${caretLeft}px`;
    customCaret.style.top = `${caretTop}px`;
    customCaret.style.height = `${caretHeight}px`;
  }

  function updateFloatingToolbar() {
    if (!canShowToolbarOverlays()) {
      floatingToolbar.hidden = true;
      return;
    }

    const selection = window.getSelection();
    if (
      !selection?.rangeCount
      || selection.isCollapsed
      || options.fileSessionState.mode !== "rich"
      || revisionHoverController.getSelectedRevisionToolbarContext() !== null
      || !editor.contains(selection.anchorNode)
      || !editor.contains(selection.focusNode)
    ) {
      floatingToolbar.hidden = true;
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = getExpandedRangeRect(range);
    if (!rect.width && !rect.height) {
      floatingToolbar.hidden = true;
      return;
    }

    const viewport = getVisualViewportMetrics();
    const selectionTop = viewport.top + rect.top;
    const selectionBottom = viewport.top + rect.bottom;
    if (selectionBottom < viewport.top + 8 || selectionTop > viewport.top + viewport.height - 8) {
      floatingToolbar.hidden = true;
      return;
    }

    floatingToolbar.hidden = false;
    const leftEdge = viewport.left + 12;
    const rightEdge = viewport.left + viewport.width - floatingToolbar.offsetWidth - 12;
    const x = Math.min(
      rightEdge,
      Math.max(leftEdge, viewport.left + rect.left + rect.width / 2 - floatingToolbar.offsetWidth / 2),
    );
    const preferredTop = viewport.top + rect.top - floatingToolbar.offsetHeight - 10;
    const fallbackTop = viewport.top + rect.bottom + 10;
    const maxTop = viewport.top + viewport.height - floatingToolbar.offsetHeight - 12;
    const minimumTop = getMinimumToolbarTop(viewport);
    const y = preferredTop >= minimumTop
      ? preferredTop
      : Math.min(maxTop, Math.max(minimumTop, fallbackTop));

    floatingToolbar.style.left = `${x}px`;
    floatingToolbar.style.top = `${Math.max(minimumTop, y)}px`;
  }

  function refreshInlineToolbars() {
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
  }

  function refreshEditorChrome() {
    refreshInlineToolbars();
    updateCustomCaret();
  }

  function renderDiffGutter() {
    diffGutter.replaceChildren();

    if (!options.sessionState.currentPath || options.fileSessionState.mode !== "rich") {
      return;
    }

    const editorShell = diffGutter.parentElement;
    if (!editorShell) {
      return;
    }

    const currentRows = flattenMarkdownDiffRows(options.fileSessionState.currentContent);
    const headRows = flattenMarkdownDiffRows(options.fileSessionState.headContent);
    const { currentMarkers, deletedPlacements } = diffRowsAgainstHead(headRows, currentRows);

    if (!currentMarkers.size && !deletedPlacements.length) {
      return;
    }

    const anchorMetrics = new Map<string, DiffAnchorMetrics>();
    for (const anchor of flattenLiveDiffAnchors(editor)) {
      const metrics = getAnchorMetrics(anchor.element, editorShell);
      if (metrics === null) {
        continue;
      }

      anchorMetrics.set(anchor.path, metrics);
    }

    const markers: Array<{ symbol: DiffMarkerSymbol; top: number }> = [];

    for (const [path, symbol] of currentMarkers) {
      const metrics = anchorMetrics.get(path);
      if (!metrics) {
        continue;
      }

      markers.push({ symbol, top: metrics.center });
    }

    const lineHeight = getEditorLineHeight(editor);
    for (const placement of deletedPlacements) {
      markers.push({
        symbol: "-",
        top: resolveDeletedMarkerTop(placement, anchorMetrics, lineHeight),
      });
    }

    markers
      .sort((left, right) => left.top - right.top)
      .forEach(({ symbol, top }) => {
        diffGutter.append(createDiffMarker(symbol, top));
      });
  }

  function scheduleDiffGutterRefresh() {
    lifecycle.scheduleAnimationFrame("editor-diff-gutter-refresh", () => {
      renderDiffGutter();
    });
  }

  function normalizeEditorMarkup(root: ParentNode = editor) {
    replaceTag(root, "b", "strong");
    replaceTag(root, "i", "em");
    replaceTag(root, "strike", "del");
    replaceTag(root, "s", "del");
    unwrapTransparentSpans(root);
    syncStructuredBlockStyles(root);
    (root as Node).normalize();
  }

  function inspectRichDocument() {
    return inspectSaveGuardMarkup({
      canonicalizeMarkup: syncStructuredBlockStyles,
      editorRoot: editor,
      isInlineRunContainer: (element) => isInlineRunContainer(editor, element),
      normalizeMarkup: normalizeEditorMarkup,
    });
  }

  function syncSaveIssueLogging(issue: SaveGuardIssue | null, trigger: string, force = false) {
    if (!issue) {
      lastLoggedSaveIssue = null;
      return;
    }

    if (!force && isSameSaveGuardIssue(lastLoggedSaveIssue, issue)) {
      return;
    }

    logSaveGuardIssue(issue, options.sessionState.currentPath, trigger);
    lastLoggedSaveIssue = { ...issue };
  }

  function inspectDraft() {
    if (!options.sessionState.currentPath) {
      lastLoggedSaveIssue = null;
      return { content: "", issue: null };
    }

    if (options.fileSessionState.mode !== "rich") {
      lastLoggedSaveIssue = null;
      return inspectDraftContent({
        mode: options.fileSessionState.mode,
        plainTextContent: editor.textContent ?? "",
      });
    }

    const richInspection = inspectRichDocument();
    syncSaveIssueLogging(richInspection.issue, "markup mismatch detected while editing");
    return inspectDraftContent({
      mode: options.fileSessionState.mode,
      plainTextContent: editor.textContent ?? "",
      richInspection,
    });
  }

  function syncStructuredBlockStyles(root: ParentNode = editor) {
    syncStructuredBlockDomStyles(root, {
      canonicalizeInlineRunContainers: canonicalizeAllInlineRunContainers,
      removeEmptyInlineFormattingArtifacts: inlineFormatController.removeEmptyInlineFormattingArtifacts,
    });
  }

  const documentAdapter: EditorDocumentAdapter = {
    captureSelection: captureCurrentSelection,
    inspectDraft,
    inspectRichDocument,
    logBlockedSaveIssue: (issue) => {
      syncSaveIssueLogging(issue, "save attempt blocked by markup mismatch", true);
    },
    readRenderedState: (mode) => mode === "rich"
      ? editor.innerHTML
      : editor.textContent ?? "",
    refreshStatusMessage,
    renderDocument: (content, mode, renderOptions = {}) => {
      lastLoggedSaveIssue = null;
      if (mode === "rich") {
        editor.innerHTML = renderOptions.renderedState ?? renderMarkdownToHtml(content);
      } else {
        editor.textContent = renderOptions.renderedState ?? content;
      }

      syncStructuredBlockStyles();
      editor.scrollTop = 0;
    },
    restoreSelection,
    scheduleDiffGutterRefresh,
    setEditable: (editable) => {
      editor.setAttribute("contenteditable", editable ? "true" : "false");
    },
  };

  function scheduleEditorChromeRefresh() {
    lifecycle.scheduleAnimationFrame("editor-chrome-refresh", () => {
      refreshEditorChrome();
    });
  }

  function scheduleCustomCaretRefresh() {
    lifecycle.scheduleAnimationFrame("editor-custom-caret-refresh", () => {
      refreshEditorChrome();
    });
  }

  function handleListStructureKeyDown(event: KeyboardEvent) {
    if (!options.sessionState.currentPath || options.fileSessionState.mode !== "rich") {
      return false;
    }

    return listStructureController.handleListStructureKeyDown(event);
  }

  function handleRichInput(event: Event) {
    if (!options.sessionState.currentPath) {
      return {
        commentCaretMarker: null,
        transformedBlock: null,
        transformedListItem: null,
      };
    }

    return richInputController.handleRichInput(event);
  }

  function handleFormatKeyDown(event: KeyboardEvent) {
    return formatCommandController.handleFormatKeyDown(event);
  }

  function applyToolbarCommand(command: string) {
    formatCommandController.applyToolbarCommand(command);
  }

  function clearPendingInlineFormats() {
    inlineFormatController.clearPendingInlineFormats();
  }

  function captureToolbarSelection() {
    preservedToolbarSelection = captureCurrentSelection();
  }

  function prepareEditorForToolbarAction() {
    if (preservedToolbarSelection) {
      restoreSelection(preservedToolbarSelection);
      preservedToolbarSelection = null;
      return;
    }

    editor.focus();
  }

  let mutationIsRunning = false;

  function createEditOperationContext(
    kind: EditOperationKind,
    overrides: Partial<Omit<EditOperationContext, "kind">> = {},
  ): EditOperationContext {
    return {
      kind,
      nextContent: null,
      nextSelection: null,
      previousContent: options.fileSessionState.currentContent,
      previousSelection: captureCurrentSelection(),
      recordHistory: kind !== "replay",
      refreshMode: kind === "input" ? "deferred" : "immediate",
      syncStructuredStyles: kind !== "replay",
      updateHistorySelection: kind === "replay",
      ...overrides,
    };
  }

  function runEditorMutation(
    context: EditOperationContext,
    mutate: () => void,
    hooks: EditOperationHooks = {},
  ) {
    if (mutationIsRunning) {
      throw new Error("Nested editor mutations are not supported.");
    }

    mutationIsRunning = true;
    try {
      mutate();

      if (context.syncStructuredStyles) {
        syncStructuredBlockStyles();
      }

      hooks.afterDomMutation?.();

      options.mutationRuntime.inspectCurrentDraft();
      context.nextContent = options.fileSessionState.currentContent;

      if (context.nextSelection !== null || context.kind === "replay") {
        restoreSelection(context.nextSelection);
      }

      hooks.afterSelectionRestore?.();

      const currentSelection = captureCurrentSelection();
      if (context.recordHistory) {
        options.mutationRuntime.recordEditHistory(context.previousContent, context.nextContent, currentSelection);
      }

      if (context.updateHistorySelection) {
        options.mutationRuntime.updateHistorySelection(currentSelection);
      }

      options.mutationRuntime.syncCurrentDraftBuffer();
      scheduleDiffGutterRefresh();
      refreshStatusMessage();

      if (context.refreshMode === "deferred") {
        scheduleEditorChromeRefresh();
        return;
      }

      refreshEditorChrome();
    } catch (error) {
      console.error(`Workbench ${context.kind} mutation failed.`, {
        nextContent: context.nextContent,
        nextSelection: context.nextSelection,
        previousContent: context.previousContent,
        previousSelection: context.previousSelection,
      }, error);
      throw error;
    } finally {
      mutationIsRunning = false;
    }
  }

  function runInputMutation(mutate: () => void, hooks: EditOperationHooks = {}) {
    runEditorMutation(createEditOperationContext("input"), mutate, hooks);
  }

  function runStructuralMutation(mutate: () => void, hooks: EditOperationHooks = {}) {
    runEditorMutation(createEditOperationContext("structural"), mutate, hooks);
  }

  function runHistoryReplay(request: EditHistoryReplayRequest) {
    runEditorMutation(createEditOperationContext("replay", {
      nextSelection: request.selection,
      syncStructuredStyles: true,
    }), () => {
      clearPendingInlineFormats();
      if (options.fileSessionState.mode === "rich") {
        editor.innerHTML = renderMarkdownToHtml(request.content);
      } else {
        editor.textContent = request.content;
      }

      editor.scrollTop = 0;
    });
  }

  function handlePendingInlineBeforeInput(event: InputEvent) {
    return inlineFormatController.handlePendingInlineBeforeInput(event);
  }

  function handlePendingInlineSelectionChange() {
    inlineFormatController.handleSelectionChange();
  }

  function maybeActivateInlineCommentShortcut(event: Event) {
    return inlineFormatController.maybeActivateInlineCommentShortcut(event);
  }

  function maybeClearPendingInlineFormatsForKey(event: KeyboardEvent) {
    inlineFormatController.maybeClearPendingInlineFormatsForKey(event);
  }

  function canonicalizeAllInlineRunContainers(root: ParentNode) {
    inlineFormatController.canonicalizeAllInlineRunContainers(root);
  }

  function getCaretInlineContext(range: Range) {
    return inlineFormatController.getCaretInlineContext(range);
  }

  function getSelectedRevisionToolbarContext() {
    return revisionHoverController.getSelectedRevisionToolbarContext();
  }

  function isPointerNearRevisionHoverUi(clientX: number, clientY: number) {
    return revisionHoverController.isPointerNearRevisionHoverUi(clientX, clientY);
  }

  function setHoveredRevisionNode(node: HTMLElement | null) {
    revisionHoverController.setHoveredRevisionNode(node);
  }

  function updateRevisionHoverToolbar() {
    revisionHoverController.updateRevisionHoverToolbar();
  }

  function applyHoveredRevisionAction(action: "accept" | "reject") {
    revisionHoverController.applyHoveredRevisionAction(action);
  }

  function hideDialog(dialog: HTMLDivElement) {
    dialog.hidden = true;
  }

  function showDialog(dialog: HTMLDivElement, focusTarget?: HTMLElement | null) {
    dialogs.forEach((currentDialog) => {
      if (currentDialog !== dialog) {
        hideDialog(currentDialog);
      }
    });

    dialog.hidden = false;
    if (focusTarget) {
      lifecycle.scheduleAnimationFrame("editor-dialog-focus", () => {
        focusTarget.focus();
      });
    }
  }

  function hideSaveConflictDialog() {
    hideDialog(dialogSurface.saveConflict.dialog);
  }

  function hideResetDraftDialog() {
    hideDialog(dialogSurface.resetDraft.dialog);
  }

  function showSaveConflict(conflict: SaveConflictPayload) {
    dialogSurface.saveConflict.summary.textContent = "Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.";
    dialogSurface.saveConflict.expected.textContent = `Expected ${conflict.expectedUpdatedAt}`;
    dialogSurface.saveConflict.actual.textContent = `Disk now has ${conflict.actualUpdatedAt}`;
    showDialog(dialogSurface.saveConflict.dialog, dialogSurface.saveConflict.keepEditing);
    setSaveButtonState();
    emit();
  }

  function showResetDraftDialog() {
    if (!options.sessionState.currentPath) {
      return;
    }

    showDialog(dialogSurface.resetDraft.dialog, dialogSurface.resetDraft.cancel);
  }

  function clearSelectionView() {
    state.threadLabel = "";
    editor.textContent = "";
    editor.scrollTop = 0;
    editor.dataset.placeholder = "Select a markdown file to start editing.";
    editor.setAttribute("contenteditable", "false");
    syncEditorLabel();
    setSaveButtonState();
    refreshStatusMessage();
  }

  function showThreadPlaceholder(label: string) {
    state.threadLabel = label;
    editor.dataset.placeholder = "Select a markdown file to start editing.";
    editor.setAttribute("contenteditable", "false");
    editor.textContent = "";
    editor.scrollTop = 0;
    syncEditorLabel();
    setSaveButtonState();
    refreshStatusMessage();
  }

  function changeFontSize(delta: number) {
    const nextFontSize = Math.min(
      MAX_EDITOR_FONT_SIZE,
      Math.max(MIN_EDITOR_FONT_SIZE, Number((state.fontSize + delta).toFixed(2))),
    );
    setFontSize(nextFontSize);
  }

  function setFontSize(fontSize: number, setOptions: { persist?: boolean } = {}) {
    const nextFontSize = Math.min(
      MAX_EDITOR_FONT_SIZE,
      Math.max(MIN_EDITOR_FONT_SIZE, Number(fontSize.toFixed(2))),
    );
    if (nextFontSize === state.fontSize) {
      return;
    }

    state.fontSize = nextFontSize;
    if (setOptions.persist !== false) {
      persistFontSize(state.fontSize);
    }
    applyEditorFontSize();
    emit();
  }

  const preserveToolbarSelection = (event: Event) => {
    scheduleToolbarInteractionReset();
    captureToolbarSelection();

    if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent) {
      if (event.pointerType !== "mouse") {
        lastNonMouseToolbarInteractionAt = Date.now();
        return;
      }

      event.preventDefault();
      return;
    }

    if (event.type === "touchstart") {
      lastNonMouseToolbarInteractionAt = Date.now();
      return;
    }

    if (
      event instanceof MouseEvent
      && Date.now() - lastNonMouseToolbarInteractionAt < TOOLBAR_TOUCH_MOUSE_COMPAT_WINDOW_MS
    ) {
      return;
    }

    if (event instanceof MouseEvent) {
      event.preventDefault();
    }
  };

  function getEventTargetElement(target: EventTarget | null) {
    if (target instanceof Element) {
      return target;
    }

    return target instanceof Node ? target.parentElement : null;
  }

  function isSelectionInsideEditor() {
    const selection = window.getSelection();
    return Boolean(
      selection?.rangeCount
        && selection.anchorNode
        && selection.focusNode
        && editor.contains(selection.anchorNode)
        && editor.contains(selection.focusNode),
    );
  }

  function isEventInsideEditorSurface(event: Event) {
    const target = getEventTargetElement(event.target);
    return Boolean(target && (
      editor.contains(target)
        || floatingToolbar.contains(target)
        || toolbars.revisionHover.contains(target)
    ));
  }

  controls.saveFileButton.addEventListener("click", () => {
    void options.handleSaveCurrentFile();
  }, { signal });

  controls.resetDraftButton.addEventListener("click", () => {
    showResetDraftDialog();
  }, { signal });

  controls.zoomOutButton.addEventListener("click", () => {
    changeFontSize(-0.08);
  }, { signal });

  controls.zoomInButton.addEventListener("click", () => {
    changeFontSize(0.08);
  }, { signal });

  dialogSurface.saveConflict.keepEditing.addEventListener("click", () => {
    hideSaveConflictDialog();
    editor.focus();
  }, { signal });

  dialogSurface.saveConflict.reload.addEventListener("click", () => {
    hideSaveConflictDialog();
    void options.handleReloadConflict();
  }, { signal });

  dialogSurface.saveConflict.overwrite.addEventListener("click", () => {
    hideSaveConflictDialog();
    void options.handleOverwriteConflict();
  }, { signal });

  dialogSurface.resetDraft.cancel.addEventListener("click", () => {
    hideResetDraftDialog();
    editor.focus();
  }, { signal });

  dialogSurface.resetDraft.resetToSaved.addEventListener("click", () => {
    void options.handleResetCurrentDraftToSaved();
  }, { signal });

  dialogSurface.resetDraft.resetToHead.addEventListener("click", () => {
    void options.handleResetCurrentFileToHead();
  }, { signal });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && options.closeActiveDialog()) {
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier || event.key.toLowerCase() !== "s") {
      return;
    }

    if (!options.getEditorHasFocus()) {
      return;
    }

    event.preventDefault();
    void options.handleSaveCurrentFile();
  }, { signal });

  editor.addEventListener("input", (event) => {
    options.handleEditorInput(event);
  }, { signal });

  editor.addEventListener("beforeinput", (event) => {
    if (event instanceof InputEvent) {
      options.handleEditorBeforeInput(event);
    }
  }, { signal });

  editor.addEventListener("keydown", (event) => {
    options.handleEditorKeyDown(event);
  }, { signal });

  document.addEventListener("selectionchange", () => {
    if (!isSelectionInsideEditor()) {
      scheduleEditorChromeRefresh();
      return;
    }

    options.handleSelectionChange();
  }, { signal });

  document.addEventListener("touchend", () => {
    scheduleEditorChromeRefresh();
  }, { signal, passive: true });

  document.addEventListener("pointerup", () => {
    scheduleEditorChromeRefresh();
  }, { signal });

  editor.addEventListener("focus", () => {
    options.handleEditorFocus();
  }, { signal });

  editor.addEventListener("blur", () => {
    options.handleEditorBlur();
  }, { signal });

  editor.addEventListener("compositionstart", () => {
    options.handleCompositionStart();
  }, { signal });

  editor.addEventListener("compositionend", () => {
    options.handleCompositionEnd();
    scheduleCustomCaretRefresh();
  }, { signal });

  for (const dialog of dialogs) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        hideDialog(dialog);
      }
    }, { signal });
  }

  toolbars.floating.addEventListener("mousedown", preserveToolbarSelection, { signal });
  toolbars.floating.addEventListener("pointerdown", preserveToolbarSelection, { signal });
  toolbars.floating.addEventListener("touchstart", preserveToolbarSelection, { signal, passive: false });

  toolbars.revisionHover.addEventListener("mousedown", preserveToolbarSelection, { signal });
  toolbars.revisionHover.addEventListener("pointerdown", preserveToolbarSelection, { signal });
  toolbars.revisionHover.addEventListener("touchstart", preserveToolbarSelection, { signal, passive: false });

  toolbars.floating.addEventListener("click", (event) => {
    const button = getEventTargetElement(event.target)?.closest<HTMLButtonElement>("button[data-command]") ?? null;
    if (!button) {
      preservedToolbarSelection = null;
      clearToolbarInteraction();
      scheduleEditorChromeRefresh();
      return;
    }

    prepareEditorForToolbarAction();
    if (button.dataset.command) {
      applyToolbarCommand(button.dataset.command);
    }
    clearToolbarInteraction();
  }, { signal });

  toolbars.revisionAccept.addEventListener("click", () => {
    prepareEditorForToolbarAction();
    applyHoveredRevisionAction("accept");
    clearToolbarInteraction();
  }, { signal });

  toolbars.revisionReject.addEventListener("click", () => {
    prepareEditorForToolbarAction();
    applyHoveredRevisionAction("reject");
    clearToolbarInteraction();
  }, { signal });

  editor.addEventListener("click", (event) => {
    options.handleEditorClick(event);
  }, { signal });

  editor.addEventListener("pointerdown", () => {
    preservedToolbarSelection = null;
    options.handleEditorPointerDown();
  }, { signal });

  document.addEventListener("pointermove", (event) => {
    if (!isEventInsideEditorSurface(event)) {
      return;
    }

    options.handlePointerMove(event);
  }, { signal });

  editor.addEventListener("toggle", (event) => {
    options.handleEditorToggle(event);
  }, { capture: true, signal });

  window.addEventListener("resize", () => {
    options.handleViewportChanged();
  }, { signal });

  window.addEventListener("scroll", () => {
    options.handleViewportChanged();
  }, { signal });

  window.visualViewport?.addEventListener("resize", () => {
    options.handleViewportChanged();
  }, { signal });

  window.visualViewport?.addEventListener("scroll", () => {
    options.handleViewportChanged();
  }, { signal });

  window.addEventListener("beforeunload", (event) => {
    if (!options.shouldBlockBeforeUnload()) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  }, { signal });

  const unsubscribeSessionState = options.sessionState.subscribe((snapshot) => {
    const previousSnapshot = previousSessionSnapshot;
    previousSessionSnapshot = snapshot;

    if (
      previousSnapshot.currentPath === snapshot.currentPath
      && previousSnapshot.currentThreadId === snapshot.currentThreadId
    ) {
      return;
    }

    syncEditorLabel();
    setSaveButtonState();
    refreshStatusMessage();
    scheduleDiffGutterRefresh();
  });
  lifecycle.addUnsubscribe(unsubscribeSessionState);

  const unsubscribeFileSessionState = options.fileSessionState.subscribe((snapshot) => {
    const previousSnapshot = previousFileSnapshot;
    previousFileSnapshot = snapshot;

    if (previousSnapshot.mode !== snapshot.mode) {
      syncEditorModePresentation();
    }

    if (
      previousSnapshot.mode !== snapshot.mode
      || previousSnapshot.currentContent !== snapshot.currentContent
      || previousSnapshot.headContent !== snapshot.headContent
    ) {
      scheduleDiffGutterRefresh();
    }

    if (
      previousSnapshot.dirty !== snapshot.dirty
      || previousSnapshot.mode !== snapshot.mode
      || previousSnapshot.pendingWriteConflict !== snapshot.pendingWriteConflict
      || previousSnapshot.saveIssue !== snapshot.saveIssue
    ) {
      setSaveButtonState();
      refreshStatusMessage();
    }
  });
  lifecycle.addUnsubscribe(unsubscribeFileSessionState);

  applyEditorFontSize();
  syncEditorModePresentation();
  syncEditorLabel();
  setSaveButtonState();
  statusDisplay.statusLine.textContent = state.statusMessage;

  return {
    applyHoveredRevisionAction,
    applyToolbarCommand,
    canonicalizeAllInlineRunContainers,
    changeFontSize,
    clearSelectionView,
    clearPendingInlineFormats,
    dispose: () => {
      listeners.clear();
      lifecycle.dispose();
    },
    getDocumentAdapter: () => documentAdapter,
    getCaretInlineContext,
    getSelectedRevisionToolbarContext,
    getSnapshot,
    handleFormatKeyDown,
    handlePendingInlineBeforeInput,
    handlePendingInlineSelectionChange,
    handleRichInput,
    handleListStructureKeyDown,
    hideResetDraftDialog,
    hideSaveConflictDialog,
    isPointerNearRevisionHoverUi,
    maybeActivateInlineCommentShortcut,
    maybeClearPendingInlineFormatsForKey,
    refreshEditorChrome,
    refreshStatusMessage,
    runHistoryReplay,
    runInputMutation,
    runStructuralMutation,
    scheduleEditorChromeRefresh,
    scheduleDiffGutterRefresh,
    setHoveredRevisionNode,
    setFontSize,
    setSaveButtonState,
    setStatusMessage,
    showResetDraftDialog,
    showSaveConflict,
    showThreadPlaceholder,
    subscribe,
    syncStructuredBlockStyles,
    updateCustomCaret,
    updateRevisionHoverToolbar,
  };
}

export default WorkbenchEditorClient;
