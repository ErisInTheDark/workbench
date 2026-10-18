/*
 * Exports:
 * - TableCellFormats / readCellFormats: the inline formats all of a cell's text shares, for inheriting into new cells.
 * - parseCellGrid: read pasted TSV or multi-line text as rows of cells.
 * - TableChrome / TableChromeSnapshot: where each table sits over the editor shell, and which one shows its controls.
 * - TableContextMenuRequest: a right-click on a cell, with what the menu may offer.
 * - TableStructureCommand: insert and delete commands for rows and columns.
 * - WorkbenchTableControllerOptions: the editor, its shell, inline formatting and the mutation pipeline.
 * - WorkbenchTableController: every table behaviour of the rich editor.
 * - default WorkbenchTableController: keep tables a grid of one-line cells: cell keys, 2d cell boxes by mouse and
 *   keyboard, box formatting, copy and paste, row and column inserts and deletes, inherited formats for new cells, and
 *   pruning empty rows and columns the selection has left.
 */

import {
    closestTableCell,
    columnCells,
    deleteTableColumn,
    insertTableColumn,
    insertTableRow,
    isTableCellEmpty,
    isTableRowEmpty,
    placeCaretInCell,
    rowCells,
    tableCellAt,
    tableCellPosition,
    tableRows,
} from "../dom/mutation/table-dom";
import { markdownToHtml } from "../markdown/markdown-html-render";
import { inheritSuggestionMembership } from "../markdown/review-markup";
import { flattenInlineContent } from "./inline-leaves";
import { serializeInlineNodes } from "./inline-markdown-serialization";
import type { InlineFormatState, PendingInlineFormatKey } from "./WorkbenchInlineFormatController";

export type TableCellFormats = readonly PendingInlineFormatKey[];

export interface TableChrome {
  id: string;
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface TableChromeSnapshot {
  activeId: string | null;
  tables: readonly TableChrome[];
}

export interface TableContextMenuRequest {
  canDeleteRow: boolean;
  x: number;
  y: number;
}

export type TableStructureCommand = "row-above" | "row-below" | "column-left" | "column-right" | "delete-row" | "delete-column";

export interface WorkbenchTableControllerOptions {
  container: HTMLElement;
  editor: HTMLElement;
  inline: {
    clearFormattingInContainers: (containers: readonly HTMLElement[]) => void;
    setPendingFormats: (formats: InlineFormatState) => void;
    toggleFormatInContainers: (containers: readonly HTMLElement[], format: PendingInlineFormatKey) => void;
  };
  isRichMode: () => boolean;
  runStructuralMutation: (mutate: () => void) => void;
  scheduleFrame: (callback: () => void) => void;
}

export interface WorkbenchTableController {
  afterSelectionChange: () => void;
  appendColumn: (id: string) => void;
  appendRow: (id: string) => void;
  /** Prune what the selection has left, before history records where the selection went. */
  beforeSelectionChange: () => void;
  /** Apply an inline format, or clear formatting, to every boxed cell; false without a box. */
  formatBox: (format: PendingInlineFormatKey | "clear") => boolean;
  getSnapshot: () => TableChromeSnapshot;
  handleBeforeInput: (event: InputEvent) => boolean;
  handleClipboard: (event: ClipboardEvent) => boolean;
  handleContextMenu: (event: MouseEvent) => boolean;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  handlePointerDown: (event: PointerEvent) => void;
  handlePointerMove: (event: PointerEvent) => void;
  handlePointerUp: () => void;
  hasBox: () => boolean;
  /** Whether the caret or box sits in a table, so row and column commands apply. */
  inTable: () => boolean;
  refresh: () => void;
  /** Forget boxes and the selection's last table after the document is rendered again. */
  reset: () => void;
  runCommand: (command: TableStructureCommand) => void;
  scheduleRefresh: () => void;
  setContextMenuHandler: (handler: ((request: TableContextMenuRequest) => void) | null) => void;
  subscribe: (listener: () => void) => () => void;
}

interface GridPoint {
  column: number;
  row: number;
}

interface CellBox {
  anchor: GridPoint;
  focus: GridPoint;
  table: HTMLTableElement;
}

const CELL_FORMAT_ATTRIBUTE = "data-cell-format";
const CELL_SELECTED_ATTRIBUTE = "data-cell-selected";
const TABLE_BOX_ATTRIBUTE = "data-cell-box";
const CELL_GRID_TYPE = "application/x-workbench-cells";
const MARK_FORMATS: Partial<Record<string, PendingInlineFormatKey>> = { code: "code", del: "del", em: "italic", ins: "ins", strong: "bold" };
const ARROWS: Record<string, GridPoint> = {
  ArrowDown: { column: 0, row: 1 }, ArrowLeft: { column: -1, row: 0 }, ArrowRight: { column: 1, row: 0 }, ArrowUp: { column: 0, row: -1 },
};

/** The formats every non-blank text leaf of a cell carries, sorted; null when they differ, empty without text. */
export function readCellFormats(cell: HTMLElement): TableCellFormats | null {
  let shared: string | null = null;
  for (const leaf of flattenInlineContent(cell.childNodes)) {
    if (leaf.type !== "text" || !/[^\s ]/u.test(leaf.text)) continue;
    const key = [...new Set(leaf.marks.map((mark) => MARK_FORMATS[mark.tag]).filter(Boolean))].sort().join(",");
    if (shared === null) shared = key;
    else if (shared !== key) return null;
  }
  return shared ? shared.split(",") as PendingInlineFormatKey[] : [];
}

/** The format set all cells share, when there are 2+ of them and it is not empty. */
function sharedFormats(cells: readonly HTMLElement[]) {
  if (cells.length < 2) return null;
  const sets = cells.map(readCellFormats);
  const first = sets[0];
  if (!first?.length) return null;
  return sets.every((set) => set?.join(",") === first.join(",")) ? first : null;
}

/** Pasted text as a grid when it holds tabs or several lines; null for a single plain line. */
export function parseCellGrid(text: string) {
  const lines = text.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
  if (lines.length < 2 && !lines[0]!.includes("\t")) return null;
  return lines.map((line) => line.split("\t"));
}

function placeCaret(node: Node, offset: number) {
  const selection = node.ownerDocument!.getSelection();
  if (!selection) return;
  const range = node.ownerDocument!.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function emptyParagraph(document: Document) {
  const paragraph = document.createElement("p");
  paragraph.append(document.createElement("br"));
  return paragraph;
}

function textBefore(container: HTMLElement, range: Range) {
  const before = container.ownerDocument.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString();
}

function textAfter(container: HTMLElement, range: Range) {
  const after = container.ownerDocument.createRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);
  return after.toString();
}

function emptyCell(cell: HTMLTableCellElement) {
  cell.replaceChildren(cell.ownerDocument.createElement("br"));
}

function cellInlineHtml(markdown: string) {
  const root = document.createElement("div");
  root.innerHTML = markdownToHtml(markdown);
  const first = root.firstElementChild;
  return first instanceof HTMLParagraphElement ? first.innerHTML : "";
}

function WorkbenchTableController(options: WorkbenchTableControllerOptions): WorkbenchTableController {
  const { container, editor } = options;
  const ids = new WeakMap<HTMLTableElement, string>();
  const listeners = new Set<() => void>();
  let nextId = 0;
  let snapshot: TableChromeSnapshot = { activeId: null, tables: [] };
  let snapshotKey = "";
  let box: CellBox | null = null;
  let drag: { cell: HTMLTableCellElement; boxed: boolean } | null = null;
  let lastTable: HTMLTableElement | null = null;
  let inheritedCell: HTMLTableCellElement | null = null;
  let hoveredTable: HTMLTableElement | null = null;
  let menuCell: HTMLTableCellElement | null = null;
  let contextMenuHandler: ((request: TableContextMenuRequest) => void) | null = null;

  function idOf(table: HTMLTableElement) {
    let id = ids.get(table);
    if (!id) {
      nextId += 1;
      id = `table-${nextId}`;
      ids.set(table, id);
    }
    return id;
  }

  function findTable(id: string) {
    return Array.from(editor.querySelectorAll("table")).find((table) => ids.get(table) === id) ?? null;
  }

  function selectionRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.startContainer) ? range : null;
  }

  function selectionCell() {
    const range = selectionRange();
    return range ? closestTableCell(editor, range.startContainer) : null;
  }

  function currentCell() {
    if (box) return tableCellAt(box.table, box.focus.row, box.focus.column);
    if (menuCell && editor.contains(menuCell)) return menuCell;
    return selectionCell();
  }

  function gridSize(table: HTMLTableElement) {
    const rows = tableRows(table);
    return { columns: Math.max(0, ...rows.map((row) => rowCells(row).length)), rows: rows.length };
  }

  function boxCells(current: CellBox | null = box) {
    if (!current || !editor.contains(current.table)) return [];
    const top = Math.min(current.anchor.row, current.focus.row);
    const bottom = Math.max(current.anchor.row, current.focus.row);
    const left = Math.min(current.anchor.column, current.focus.column);
    const right = Math.max(current.anchor.column, current.focus.column);
    const cells: HTMLTableCellElement[] = [];
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const cell = tableCellAt(current.table, row, column);
        if (cell) cells.push(cell);
      }
    }
    return cells;
  }

  function clearBoxMarks() {
    for (const cell of Array.from(editor.querySelectorAll(`[${CELL_SELECTED_ATTRIBUTE}]`))) cell.removeAttribute(CELL_SELECTED_ATTRIBUTE);
    for (const table of Array.from(editor.querySelectorAll(`[${TABLE_BOX_ATTRIBUTE}]`))) table.removeAttribute(TABLE_BOX_ATTRIBUTE);
  }

  function setBox(next: CellBox | null) {
    box = next;
    clearBoxMarks();
    if (!box) return;
    box.table.setAttribute(TABLE_BOX_ATTRIBUTE, "");
    for (const cell of boxCells()) cell.setAttribute(CELL_SELECTED_ATTRIBUTE, "");
  }

  /** A box keeps the caret collapsed in its focus cell, so keys and typing reach the editor there. */
  function collapseIntoFocus() {
    const cell = currentCell();
    if (cell) placeCaretInCell(cell, true);
  }

  function dropBox() {
    if (!box) return;
    const cell = currentCell();
    setBox(null);
    if (cell) placeCaretInCell(cell, true);
  }

  function boxWholeTable(table: HTMLTableElement) {
    const size = gridSize(table);
    setBox({ anchor: { column: 0, row: 0 }, focus: { column: size.columns - 1, row: size.rows - 1 }, table });
    collapseIntoFocus();
  }

  function boxCoversTable() {
    if (!box) return false;
    const size = gridSize(box.table);
    return Math.min(box.anchor.row, box.focus.row) === 0 && Math.min(box.anchor.column, box.focus.column) === 0
      && Math.max(box.anchor.row, box.focus.row) === size.rows - 1 && Math.max(box.anchor.column, box.focus.column) === size.columns - 1;
  }

  /** Cells the selection or box holds; pruning never removes their rows or columns. */
  function heldCells() {
    const held = new Set<HTMLTableCellElement>(boxCells());
    const range = selectionRange();
    if (range) {
      for (const cell of Array.from(editor.querySelectorAll<HTMLTableCellElement>("td, th"))) {
        if (cell.contains(range.startContainer) || range.intersectsNode(cell)) held.add(cell);
      }
    }
    return held;
  }

  /** Empty body rows and empty columns the selection is not in go; a table left without columns goes too. */
  function prune(table: HTMLTableElement) {
    const held = heldCells();
    const rows = tableRows(table).slice(1).filter((row) => isTableRowEmpty(row) && !rowCells(row).some((cell) => held.has(cell)));
    const { columns } = gridSize(table);
    const emptyColumns = Array.from({ length: columns }, (_, column) => column).filter((column) => {
      const cells = columnCells(table, column);
      return cells.every(isTableCellEmpty) && !cells.some((cell) => held.has(cell));
    });
    if (!rows.length && !emptyColumns.length) return;

    options.runStructuralMutation(() => {
      for (const row of rows) row.remove();
      if (emptyColumns.length === columns) {
        if (box?.table === table) setBox(null);
        const only = editor.childElementCount === 1;
        if (only) table.replaceWith(emptyParagraph(editor.ownerDocument));
        else table.remove();
        return;
      }
      for (const column of [...emptyColumns].reverse()) deleteTableColumn(table, column);
      if (box?.table === table) setBox(null);
    });
  }

  function tableOfSelection() {
    if (box && editor.contains(box.table)) return box.table;
    return selectionCell()?.closest("table") ?? null;
  }

  function beforeSelectionChange() {
    if (!options.isRichMode()) {
      lastTable = null;
      return;
    }
    const previous = lastTable;
    lastTable = tableOfSelection();
    if (previous && editor.contains(previous)) prune(previous);
  }

  /** An empty cell carrying an inherited format makes it the pending format once, as the caret arrives. */
  function afterSelectionChange() {
    const range = selectionRange();
    const cell = range?.collapsed && !box ? closestTableCell(editor, range.startContainer) : null;
    if (cell !== inheritedCell) inheritedCell = null;
    const formats = cell?.getAttribute(CELL_FORMAT_ATTRIBUTE);
    if (!cell || !formats || cell === inheritedCell || !isTableCellEmpty(cell)) return;
    inheritedCell = cell;
    const pending: InlineFormatState = { bold: false, code: false, del: false, ins: false, italic: false };
    for (const format of formats.split(",")) {
      if (format in pending) pending[format as PendingInlineFormatKey] = true;
    }
    options.inline.setPendingFormats(pending);
  }

  function setInherited(cell: HTMLTableCellElement | undefined, formats: TableCellFormats | null) {
    if (cell && formats?.length) cell.setAttribute(CELL_FORMAT_ATTRIBUTE, formats.join(","));
  }

  /** A new row at a row index; each cell inherits its column's shared body format. */
  function addRow(table: HTMLTableElement, index: number) {
    const { columns } = gridSize(table);
    const inherited = Array.from({ length: columns }, (_, column) => sharedFormats(columnCells(table, column).slice(1)));
    const row = insertTableRow(table, index);
    rowCells(row).forEach((cell, column) => setInherited(cell, inherited[column] ?? null));
    return row;
  }

  /** A new column at a column index; each cell inherits its row's shared format. */
  function addColumn(table: HTMLTableElement, index: number) {
    const inherited = tableRows(table).map((row) => sharedFormats(rowCells(row)));
    const cells = insertTableColumn(table, index);
    cells.forEach((cell, row) => setInherited(cell, inherited[row] ?? null));
    return cells;
  }

  function moveToCell(cell: HTMLTableCellElement | null | undefined, atEnd = false) {
    if (cell) placeCaretInCell(cell, atEnd);
  }

  function runCommand(command: TableStructureCommand) {
    const cell = currentCell();
    if (!cell) return;
    const table = cell.closest("table")!;
    const { column, row } = tableCellPosition(cell);
    menuCell = null;
    if (command === "delete-row" && row === 0) return;
    options.runStructuralMutation(() => {
      setBox(null);
      switch (command) {
        case "row-above":
        case "row-below":
          moveToCell(rowCells(addRow(table, command === "row-above" ? row : row + 1))[column]);
          return;
        case "column-left":
        case "column-right":
          moveToCell(addColumn(table, command === "column-left" ? column : column + 1)[row]);
          return;
        case "delete-row": {
          tableRows(table)[row]!.remove();
          const rows = tableRows(table);
          moveToCell(rowCells(rows[Math.min(row, rows.length - 1)]!)[column], true);
          return;
        }
        case "delete-column": {
          if (gridSize(table).columns <= 1) {
            const paragraph = emptyParagraph(editor.ownerDocument);
            inheritSuggestionMembership(table, paragraph);
            table.replaceWith(paragraph);
            placeCaret(paragraph, 0);
            return;
          }
          deleteTableColumn(table, column);
          moveToCell(tableCellAt(table, row, Math.min(column, gridSize(table).columns - 1)), true);
        }
      }
    });
  }

  function appendRow(id: string) {
    const table = findTable(id);
    if (!table) return;
    options.runStructuralMutation(() => {
      setBox(null);
      moveToCell(rowCells(addRow(table, tableRows(table).length))[0]);
    });
  }

  function appendColumn(id: string) {
    const table = findTable(id);
    if (!table) return;
    options.runStructuralMutation(() => {
      setBox(null);
      moveToCell(addColumn(table, gridSize(table).columns)[0]);
    });
  }

  /** Step out below a table, into the paragraph after it or a new one. */
  function stepOutBelow(table: HTMLTableElement) {
    const next = table.nextElementSibling;
    const target = next instanceof HTMLParagraphElement && !(next.textContent ?? "").trim() ? next : emptyParagraph(editor.ownerDocument);
    if (target !== next) {
      table.after(target);
      inheritSuggestionMembership(table, target);
    }
    placeCaret(target, 0);
  }

  /** Enter moves down a column, adding a row below the last; on an empty last row it leaves the table instead. */
  function enterInCell(cell: HTMLTableCellElement) {
    const table = cell.closest("table")!;
    const { column, row } = tableCellPosition(cell);
    const rows = tableRows(table);
    const below = rows[row + 1];
    if (below) {
      moveToCell(rowCells(below)[column]);
      return;
    }
    if (row > 0 && isTableRowEmpty(rows[row]!)) {
      options.runStructuralMutation(() => {
        rows[row]!.remove();
        stepOutBelow(table);
      });
      return;
    }
    options.runStructuralMutation(() => moveToCell(rowCells(addRow(table, rows.length))[column]));
  }

  function tabInCell(cell: HTMLTableCellElement, backwards: boolean) {
    const table = cell.closest("table")!;
    const cells = tableRows(table).flatMap(rowCells);
    const index = cells.indexOf(cell);
    if (backwards) {
      moveToCell(cells[index - 1], true);
      return;
    }
    if (cells[index + 1]) moveToCell(cells[index + 1], true);
    else options.runStructuralMutation(() => moveToCell(rowCells(addRow(table, tableRows(table).length))[0]));
  }

  /** Backspace at a cell's start never pulls cells together; on an empty body row it removes the row. */
  function backspaceInCell(cell: HTMLTableCellElement) {
    const table = cell.closest("table")!;
    const { row } = tableCellPosition(cell);
    const rows = tableRows(table);
    if (row <= 0 || !isTableRowEmpty(rows[row]!)) return;
    options.runStructuralMutation(() => {
      rows[row]!.remove();
      moveToCell(rowCells(rows[row - 1]!).at(-1), true);
    });
  }

  function insertIntoCell(range: Range, text: string) {
    options.runStructuralMutation(() => {
      range.deleteContents();
      const node = editor.ownerDocument.createTextNode(text);
      range.insertNode(node);
      placeCaret(node, node.length);
    });
  }

  function clearBoxedCells() {
    const cells = boxCells();
    options.runStructuralMutation(() => {
      for (const cell of cells) emptyCell(cell);
      collapseIntoFocus();
    });
  }

  function pastedText(event: InputEvent) {
    return event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
  }

  function handleBoxInput(event: InputEvent) {
    event.preventDefault();
    if (event.inputType.startsWith("delete")) {
      clearBoxedCells();
      return true;
    }
    const cell = currentCell();
    const text = event.inputType.startsWith("insert") && !/^insert(Paragraph|LineBreak|FromPaste|FromDrop)$/u.test(event.inputType)
      ? event.data ?? ""
      : "";
    setBox(null);
    if (!cell) return true;
    if (!text) {
      placeCaretInCell(cell, true);
      return true;
    }
    // Typing over a box replaces the focus cell, as a spreadsheet does.
    options.runStructuralMutation(() => {
      const node = editor.ownerDocument.createTextNode(text);
      cell.replaceChildren(node);
      placeCaret(node, node.length);
    });
    return true;
  }

  function handleBeforeInput(event: InputEvent) {
    if (box) return handleBoxInput(event);
    const range = selectionRange();
    if (!range) return false;
    const cell = closestTableCell(editor, range.startContainer);
    if (!cell) return false;
    const inCell = cell.contains(range.endContainer);
    switch (event.inputType) {
      case "insertParagraph":
        event.preventDefault();
        enterInCell(cell);
        return true;
      case "insertLineBreak":
        event.preventDefault();
        return true;
      case "insertFromPaste":
      case "insertFromDrop":
        if (!inCell) return false;
        event.preventDefault();
        insertIntoCell(range, pastedText(event).replace(/\s*[\r\n]+\s*/gu, " "));
        return true;
      case "deleteContentBackward":
        if (!range.collapsed || textBefore(cell, range)) return false;
        event.preventDefault();
        backspaceInCell(cell);
        return true;
      case "deleteContentForward":
        if (!range.collapsed || textAfter(cell, range)) return false;
        event.preventDefault();
        return true;
      default:
        return false;
    }
  }

  function clampedPoint(table: HTMLTableElement, point: GridPoint) {
    const size = gridSize(table);
    return {
      column: Math.max(0, Math.min(size.columns - 1, point.column)),
      row: Math.max(0, Math.min(size.rows - 1, point.row)),
    };
  }

  /** Shift+Arrow leaving a fully selected (or empty) cell boxes that cell. */
  function startKeyboardBox(event: KeyboardEvent, delta: GridPoint) {
    const selection = window.getSelection();
    const range = selectionRange();
    const cell = range ? closestTableCell(editor, range.startContainer) : null;
    if (!selection || !range || !cell || !cell.contains(range.endContainer)) return false;
    if (textBefore(cell, range) || textAfter(cell, range)) return false;
    const forward = selection.focusNode === range.endContainer && selection.focusOffset === range.endOffset;
    const outward = range.collapsed || (forward ? delta.column > 0 || delta.row > 0 : delta.column < 0 || delta.row < 0);
    if (!outward) return false;
    event.preventDefault();
    const point = tableCellPosition(cell);
    setBox({ anchor: point, focus: point, table: cell.closest("table")! });
    collapseIntoFocus();
    return true;
  }

  function moveBox(delta: GridPoint, extend: boolean) {
    if (!box) return;
    if (extend) {
      setBox({ ...box, focus: clampedPoint(box.table, { column: box.focus.column + delta.column, row: box.focus.row + delta.row }) });
    } else {
      const size = gridSize(box.table);
      const edges = [box.anchor, box.focus];
      const fits = (axis: "column" | "row", limit: number) => edges.every((point) => point[axis] + delta[axis] >= 0 && point[axis] + delta[axis] < limit);
      const step = { column: fits("column", size.columns) ? delta.column : 0, row: fits("row", size.rows) ? delta.row : 0 };
      const shift = (point: GridPoint) => ({ column: point.column + step.column, row: point.row + step.row });
      setBox({ ...box, anchor: shift(box.anchor), focus: shift(box.focus) });
    }
    collapseIntoFocus();
  }

  function handleKeyDown(event: KeyboardEvent) {
    menuCell = null;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
      if (boxCoversTable()) {
        event.preventDefault();
        setBox(null);
        const selection = window.getSelection()!;
        const range = editor.ownerDocument.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      const table = tableOfSelection();
      if (!table) return false;
      event.preventDefault();
      boxWholeTable(table);
      return true;
    }
    if (mod || event.altKey) return false;

    const delta = ARROWS[event.key];
    if (box) {
      if (delta) {
        event.preventDefault();
        moveBox(delta, event.shiftKey);
        return true;
      }
      if (event.key === "Escape" || event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        dropBox();
        return true;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        clearBoxedCells();
        return true;
      }
      return false;
    }

    if (delta && event.shiftKey) return startKeyboardBox(event, delta);
    if (event.key !== "Tab") return false;
    const cell = selectionCell();
    if (!cell) return false;
    event.preventDefault();
    tabInCell(cell, event.shiftKey);
    return true;
  }

  function formatBox(format: PendingInlineFormatKey | "clear") {
    const cells = boxCells();
    if (!cells.length) return false;
    if (format === "clear") options.inline.clearFormattingInContainers(cells);
    else options.inline.toggleFormatInContainers(cells, format);
    return true;
  }

  function copyBox(event: ClipboardEvent, cut: boolean) {
    if (!box || !event.clipboardData) return false;
    event.preventDefault();
    const top = Math.min(box.anchor.row, box.focus.row);
    const bottom = Math.max(box.anchor.row, box.focus.row);
    const left = Math.min(box.anchor.column, box.focus.column);
    const right = Math.max(box.anchor.column, box.focus.column);
    const grid: Array<Array<{ markdown: string; text: string }>> = [];
    for (let row = top; row <= bottom; row += 1) {
      const cells: Array<{ markdown: string; text: string }> = [];
      for (let column = left; column <= right; column += 1) {
        const cell = tableCellAt(box.table, row, column);
        cells.push({
          markdown: cell ? serializeInlineNodes(cell.childNodes).trim().replace(/\s*\n\s*/gu, " ") : "",
          text: (cell?.textContent ?? "").replaceAll(" ", " ").replace(/[\t\n]+/gu, " ").trim(),
        });
      }
      grid.push(cells);
    }
    event.clipboardData.setData("text/plain", grid.map((row) => row.map((cell) => cell.text).join("\t")).join("\n"));
    event.clipboardData.setData(CELL_GRID_TYPE, JSON.stringify(grid.map((row) => row.map((cell) => cell.markdown))));
    if (cut) clearBoxedCells();
    return true;
  }

  function readPastedGrid(data: DataTransfer) {
    const cells = data.getData(CELL_GRID_TYPE);
    if (cells) {
      try {
        const parsed: unknown = JSON.parse(cells);
        if (Array.isArray(parsed) && parsed.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
          return { grid: parsed as string[][], markdown: true };
        }
      } catch {
        // A foreign clipboard entry under the same type falls back to its plain text.
      }
    }
    const grid = parseCellGrid(data.getData("text/plain"));
    return grid ? { grid, markdown: false } : null;
  }

  /** Paste fills a block of cells from one selected cell, growing the table to fit; bigger boxes take no paste. */
  function pasteGrid(event: ClipboardEvent) {
    if (!event.clipboardData) return false;
    if (box && boxCells().length > 1) {
      event.preventDefault();
      return true;
    }
    const cell = currentCell();
    if (!cell) return false;
    const pasted = readPastedGrid(event.clipboardData);
    if (!pasted) {
      if (!box) return false;
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain").replace(/\s*[\r\n]+\s*/gu, " ");
      options.runStructuralMutation(() => {
        cell.replaceChildren(editor.ownerDocument.createTextNode(text));
        setBox(null);
        placeCaretInCell(cell, true);
      });
      return true;
    }

    event.preventDefault();
    const table = cell.closest("table")!;
    const origin = tableCellPosition(cell);
    const width = Math.max(...pasted.grid.map((row) => row.length));
    options.runStructuralMutation(() => {
      while (gridSize(table).rows < origin.row + pasted.grid.length) insertTableRow(table, gridSize(table).rows);
      while (gridSize(table).columns < origin.column + width) insertTableColumn(table, gridSize(table).columns);
      pasted.grid.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
        const target = tableCellAt(table, origin.row + rowOffset, origin.column + columnOffset);
        if (!target) return;
        if (pasted.markdown) target.innerHTML = cellInlineHtml(value) || "<br>";
        else target.replaceChildren(value ? editor.ownerDocument.createTextNode(value) : editor.ownerDocument.createElement("br"));
      }));
      setBox({
        anchor: origin,
        focus: { column: origin.column + width - 1, row: origin.row + pasted.grid.length - 1 },
        table,
      });
      collapseIntoFocus();
    });
    return true;
  }

  function handleClipboard(event: ClipboardEvent) {
    if (!options.isRichMode()) return false;
    if (event.type === "paste") return pasteGrid(event);
    return copyBox(event, event.type === "cut");
  }

  function handleContextMenu(event: MouseEvent) {
    const cell = event.target instanceof Node ? closestTableCell(editor, event.target) : null;
    if (!cell || !contextMenuHandler || !options.isRichMode()) return false;
    event.preventDefault();
    menuCell = cell;
    if (!box && selectionCell() !== cell) placeCaretInCell(cell, true);
    contextMenuHandler({ canDeleteRow: tableCellPosition(cell).row > 0, x: event.clientX, y: event.clientY });
    return true;
  }

  function handlePointerDown(event: PointerEvent) {
    menuCell = null;
    if (event.button !== 0) return;
    if (box) setBox(null);
    const cell = event.target instanceof Node ? closestTableCell(editor, event.target) : null;
    drag = cell ? { boxed: false, cell } : null;
  }

  function handlePointerMove(event: PointerEvent) {
    const target = event.target instanceof Node ? event.target : null;
    const table = target instanceof Element ? target.closest("table") : target?.parentElement?.closest("table") ?? null;
    const hovered = table && editor.contains(table) ? table : null;
    if (hovered !== hoveredTable && (hovered || target && editor.contains(target))) {
      hoveredTable = hovered;
      refresh();
    }

    if (!drag || !(event.buttons & 1)) return;
    const cell = target ? closestTableCell(editor, target) : null;
    if (!cell || cell.closest("table") !== drag.cell.closest("table")) return;
    if (cell === drag.cell) {
      if (drag.boxed) {
        drag.boxed = false;
        setBox(null);
      }
      return;
    }
    drag.boxed = true;
    setBox({ anchor: tableCellPosition(drag.cell), focus: tableCellPosition(cell), table: cell.closest("table")! });
  }

  function handlePointerUp() {
    if (drag?.boxed) collapseIntoFocus();
    drag = null;
  }

  function publish(next: TableChromeSnapshot) {
    const key = JSON.stringify(next);
    if (key === snapshotKey) return;
    snapshotKey = key;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function refresh() {
    if (!options.isRichMode()) {
      publish({ activeId: null, tables: [] });
      return;
    }
    const origin = container.getBoundingClientRect();
    const tables = Array.from(editor.querySelectorAll("table")).flatMap((table): TableChrome[] => {
      const rect = table.getBoundingClientRect();
      if (!rect.width && !rect.height) return [];
      return [{
        height: Math.round(rect.height),
        id: idOf(table),
        left: Math.round(rect.left - origin.left),
        top: Math.round(rect.top - origin.top),
        width: Math.round(rect.width),
      }];
    });
    const active = (hoveredTable && editor.contains(hoveredTable) ? hoveredTable : null) ?? tableOfSelection();
    publish({ activeId: active ? idOf(active) : null, tables });
  }

  return {
    afterSelectionChange,
    appendColumn,
    appendRow,
    beforeSelectionChange,
    formatBox,
    getSnapshot: () => snapshot,
    handleBeforeInput,
    handleClipboard,
    handleContextMenu,
    handleKeyDown,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    hasBox: () => Boolean(box && editor.contains(box.table)),
    inTable: () => Boolean(currentCell()),
    refresh,
    reset: () => {
      box = null;
      drag = null;
      lastTable = null;
      inheritedCell = null;
      menuCell = null;
      clearBoxMarks();
    },
    runCommand,
    scheduleRefresh: () => options.scheduleFrame(refresh),
    setContextMenuHandler: (handler) => {
      contextMenuHandler = handler;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export default WorkbenchTableController;
