/*
 * Exports:
 * - createInitialEditorUIStateSnapshot: create the default editor UI snapshot used before the editor client is constructed. Keywords: workbench, editor, UI, snapshot, initial state.
 * - WorkbenchEditorFormatCommandOptions: delayed formatting-command delegates injected after inline and code controllers exist. Keywords: workbench, editor, format, command, delegates.
 * - EditorMode: current editor rendering mode. Keywords: workbench, editor, mode.
 * - SaveGuardIssue: persisted editor save-guard mismatch details. Keywords: workbench, editor, save guard, mismatch.
 * - EditorUIState: owned editor shell state for UI-only concerns such as font size, transient status, and thread labels. Keywords: workbench, editor, state, UI.
 * - EditorUIStateSnapshot: readonly projection of editor-owned UI state. Keywords: workbench, editor, snapshot, UI.
 * - EditorUIStateListener: subscriber signature for editor shell changes. Keywords: workbench, editor, subscribe.
 * - WorkbenchEditorClientOptions: callbacks, structural-edit dependencies, and state readers delegated from the coordinator for editor behavior and deterministic rendering. Keywords: workbench, editor, callbacks, structure, status, state.
 * - WorkbenchEditorClient: public surface for the editor shell client, including diff gutter refresh scheduling, delayed format-command configuration, and editor-owned structural input handling. Keywords: workbench, editor, client, diff gutter, format, list structure, rich input, dispose.
 * - default WorkbenchEditorClient: create the editor shell client that owns DOM refs, dialogs, diff gutter rendering, structural input wiring, delayed format-command setup, event listener cleanup, and deterministic status messages. Keywords: workbench, editor, DOM, status, structure, format, rich input, diff gutter, listeners, default export.
 */

import type { ChangeSummary, SaveConflictPayload } from "../types";
import { getEditorLineHeight } from "./dom/layout/viewport-metrics";
import {
    getNestedListElementsForItem,
    isIntentionalListBreakParagraph,
    isSingleBreakParagraph,
} from "./dom/query/list-dom";
import WorkbenchFormatCommandController from "./editor/WorkbenchFormatCommandController";
import WorkbenchListStructureController, { type WorkbenchListStructureControllerOptions } from "./editor/WorkbenchListStructureController";
import WorkbenchRichInputController from "./editor/WorkbenchRichInputController";
import { parseBlocks as parseMarkdownBlocks, type ParsedBlock } from "./markdown/markdown-render";
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, persistFontSize, readStoredFontSize } from "./state/browser-state";
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

export interface WorkbenchEditorFormatCommandOptions {
  clearPendingInlineFormats: () => void;
  syncEditorAfterStructuralChange: (
    mutate: () => void,
    options?: { afterDomMutation?: () => void; afterSelectionRestore?: () => void },
  ) => void;
  toggleCodeSelection: (selection: Selection, range: Range) => void;
  toggleInlineFormatSelection: (
    selection: Selection,
    range: Range,
    formatKey: "bold" | "italic" | "comment" | "del" | "ins",
  ) => void;
  togglePendingInlineFormat: (format: "bold" | "italic" | "code" | "comment" | "del" | "ins") => boolean;
}

export interface WorkbenchEditorClientOptions {
  closeActiveDialog: () => boolean;
  fileSessionState: FileSessionState;
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
  handleRefreshInlineToolbars: () => void;
  handleReloadConflict: () => Promise<void>;
  handleResetCurrentDraftToSaved: () => Promise<void>;
  handleResetCurrentFileToHead: () => Promise<void>;
  handleRevisionAction: (action: "accept" | "reject") => void;
  handleSaveCurrentFile: () => Promise<void>;
  handleSelectionChange: () => void;
  handleToolbarCommand: (command: string | undefined) => void;
  handleViewportChanged: () => void;
  isSaveButtonInvalid?: () => boolean;
  listStructure: Omit<WorkbenchListStructureControllerOptions, "editor">;
  sessionState: SessionState;
  shouldBlockBeforeUnload: () => boolean;
}

interface WorkbenchEditorClient {
  applyToolbarCommand: (command: string) => void;
  changeFontSize: (delta: number) => void;
  clearSelectionView: () => void;
  configureFormatCommands: (options: WorkbenchEditorFormatCommandOptions) => void;
  dispose: () => void;
  getSnapshot: () => EditorUIStateSnapshot;
  handleFormatKeyDown: (event: KeyboardEvent) => boolean;
  handleRichInput: (event: Event) => { transformedListItem: HTMLLIElement | null; commentCaretMarker: HTMLElement | null };
  handleListStructureKeyDown: (event: KeyboardEvent) => boolean;
  hideResetDraftDialog: () => void;
  hideSaveConflictDialog: () => void;
  refreshStatusMessage: (message?: string) => void;
  scheduleEditorChromeRefresh: () => void;
  scheduleDiffGutterRefresh: () => void;
  setSaveButtonState: () => void;
  setStatusMessage: (message: string) => void;
  showResetDraftDialog: () => void;
  showSaveConflict: (conflict: SaveConflictPayload) => void;
  showThreadPlaceholder: (label: string) => void;
  subscribe: (listener: EditorUIStateListener) => () => void;
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

    item.children.forEach((child, childIndex) => {
      if (child.type !== "ul" && child.type !== "ol") {
        return;
      }

      appendParsedListDiffRows(child, `${itemPath}/child:${childIndex}`, depth + 1, rows);
    });
  });
}

function flattenMarkdownDiffRows(markdown: string | null) {
  const rows: DiffRow[] = [];
  let blockIndex = 0;

  for (const block of parseMarkdownBlocks(markdown ?? "")) {
    switch (block.type) {
      case "break":
      case "list-break":
        continue;
      case "ul":
      case "ol":
        appendParsedListDiffRows(block, `b${blockIndex}`, 0, rows);
        blockIndex += 1;
        continue;
      case "heading":
        rows.push({
          path: `b${blockIndex}`,
          signature: `heading|${block.level}|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "blockquote":
        rows.push({
          path: `b${blockIndex}`,
          signature: `blockquote|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "comment":
        rows.push({
          path: `b${blockIndex}`,
          signature: `comment|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "hr":
        rows.push({
          path: `b${blockIndex}`,
          signature: "hr|",
        });
        blockIndex += 1;
        continue;
      case "code":
        rows.push({
          path: `b${blockIndex}`,
          signature: `code|${block.language}|${block.text}`,
        });
        blockIndex += 1;
        continue;
      case "paragraph":
        rows.push({
          path: `b${blockIndex}`,
          signature: `paragraph|${block.text}`,
        });
        blockIndex += 1;
        continue;
      default:
        continue;
    }
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

      getNestedListElementsForItem(item).forEach((childList, childIndex) => {
        appendLiveListDiffAnchors(childList, `${itemPath}/child:${childIndex}`, anchors);
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
  const diffGutter = surfaces.editor.diffGutter;
  const statusDisplay = surfaces.statusDisplay;
  const controls = surfaces.controls;
  const dialogSurface = surfaces.dialogs;
  const toolbars = surfaces.toolbars;
  const dialogs = [dialogSurface.saveConflict.dialog, dialogSurface.resetDraft.dialog] as const;
  const listStructureController = WorkbenchListStructureController({
    editor,
    ...options.listStructure,
  });
  const richInputController = WorkbenchRichInputController({
    editor,
    getMode: () => options.fileSessionState.mode,
  });
  let formatCommandController: WorkbenchFormatCommandController | null = null;
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

  function scheduleEditorChromeRefresh() {
    lifecycle.scheduleAnimationFrame("editor-chrome-refresh", () => {
      options.handleRefreshInlineToolbars();
    });
  }

  function scheduleCustomCaretRefresh() {
    lifecycle.scheduleAnimationFrame("editor-custom-caret-refresh", () => {
      options.handleRefreshInlineToolbars();
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
        transformedListItem: null,
        commentCaretMarker: null,
      };
    }

    return richInputController.handleRichInput(event);
  }

  function configureFormatCommands(formatCommandOptions: WorkbenchEditorFormatCommandOptions) {
    formatCommandController = WorkbenchFormatCommandController({
      editor,
      getMode: () => options.fileSessionState.mode,
      ...formatCommandOptions,
    });
  }

  function handleFormatKeyDown(event: KeyboardEvent) {
    return formatCommandController?.handleFormatKeyDown(event) ?? false;
  }

  function applyToolbarCommand(command: string) {
    formatCommandController?.applyToolbarCommand(command);
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
    if (nextFontSize === state.fontSize) {
      return;
    }

    state.fontSize = nextFontSize;
    persistFontSize(state.fontSize);
    applyEditorFontSize();
    emit();
  }

  const preserveToolbarSelection = (event: Event) => {
    event.preventDefault();
  };

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
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-command]")
      : null;
    if (!button) {
      return;
    }

    editor.focus();
    options.handleToolbarCommand(button.dataset.command);
  }, { signal });

  toolbars.revisionAccept.addEventListener("click", () => {
    options.handleRevisionAction("accept");
  }, { signal });

  toolbars.revisionReject.addEventListener("click", () => {
    options.handleRevisionAction("reject");
  }, { signal });

  editor.addEventListener("click", (event) => {
    options.handleEditorClick(event);
  }, { signal });

  editor.addEventListener("pointerdown", () => {
    options.handleEditorPointerDown();
  }, { signal });

  document.addEventListener("pointermove", (event) => {
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
    scheduleEditorChromeRefresh();
  }, { signal });

  window.visualViewport?.addEventListener("scroll", () => {
    scheduleEditorChromeRefresh();
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
    applyToolbarCommand,
    changeFontSize,
    clearSelectionView,
    configureFormatCommands,
    dispose: () => {
      listeners.clear();
      lifecycle.dispose();
    },
    getSnapshot,
    handleFormatKeyDown,
    handleRichInput,
    handleListStructureKeyDown,
    hideResetDraftDialog,
    hideSaveConflictDialog,
    refreshStatusMessage,
    scheduleEditorChromeRefresh,
    scheduleDiffGutterRefresh,
    setSaveButtonState,
    setStatusMessage,
    showResetDraftDialog,
    showSaveConflict,
    showThreadPlaceholder,
    subscribe,
  };
}

export default WorkbenchEditorClient;