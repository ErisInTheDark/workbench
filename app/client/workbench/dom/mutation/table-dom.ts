/*
 * Exports:
 * - TABLE_ALIGN_ATTRIBUTE: the cell attribute naming its column's alignment.
 * - TableAlignment: a column's alignment, null for the default.
 * - closestTableCell: the table cell holding a node inside the editor.
 * - readTableAlignments: each column's alignment, read from the header row.
 * - tableRows: the header row followed by the body rows of a table.
 * - rowCells: the cells of one row.
 * - isTableCellEmpty / isTableRowEmpty: whether a cell, or every cell of a row, holds no text or atom.
 * - columnCells / tableCellAt / tableCellPosition: read a table as a grid of rows and columns.
 * - insertTableRow / insertTableColumn / deleteTableColumn: grow or shrink the grid, keeping the header row first.
 * - createTableRow: an empty row of a table's width whose cells keep their column's alignment.
 * - createTable: an empty table with a header row and body rows.
 * - placeCaretInCell: put a collapsed caret at the start or end of a cell.
 * - normalizeTables: rebuild tables as one header row and padded body rows of inline-only cells, as pipe tables say.
 */

export const TABLE_ALIGN_ATTRIBUTE = "data-align";

export type TableAlignment = "left" | "center" | "right" | null;

const CELL_BLOCK_SELECTOR = "p, div, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, li, pre, details, summary, table, thead, tbody, tfoot, tr, td, th, hr";

function isCell(node: Element | null): node is HTMLTableCellElement {
  return node instanceof HTMLTableCellElement;
}

export function closestTableCell(editor: HTMLElement, node: Node | null) {
  for (let current: Node | null = node; current && current !== editor; current = current.parentNode) {
    if (current instanceof HTMLTableCellElement) return current;
  }
  return null;
}

export function tableRows(table: HTMLTableElement) {
  return Array.from(table.querySelectorAll("tr")).filter((row) => row.closest("table") === table);
}

export function rowCells(row: HTMLTableRowElement) {
  return Array.from(row.children).filter(isCell);
}

function readAlignment(cell: Element | undefined): TableAlignment {
  const value = cell?.getAttribute(TABLE_ALIGN_ATTRIBUTE);
  return value === "left" || value === "center" || value === "right" ? value : null;
}

export function readTableAlignments(table: HTMLTableElement): TableAlignment[] {
  const header = tableRows(table)[0];
  return header ? rowCells(header).map(readAlignment) : [];
}

export function isTableCellEmpty(cell: HTMLTableCellElement) {
  return !(cell.textContent ?? "").replaceAll(" ", "").trim() && !cell.querySelector("[data-comment-thread]");
}

export function isTableRowEmpty(row: HTMLTableRowElement) {
  return rowCells(row).every(isTableCellEmpty);
}

export function columnCells(table: HTMLTableElement, column: number) {
  return tableRows(table).map((row) => rowCells(row)[column]).filter((cell): cell is HTMLTableCellElement => Boolean(cell));
}

export function tableCellAt(table: HTMLTableElement, row: number, column: number) {
  const tableRow = tableRows(table)[row];
  return tableRow ? rowCells(tableRow)[column] ?? null : null;
}

/** The row and column of a cell in its table. */
export function tableCellPosition(cell: HTMLTableCellElement) {
  const row = cell.parentElement as HTMLTableRowElement;
  return { column: rowCells(row).indexOf(cell), row: tableRows(cell.closest("table")!).indexOf(row) };
}

/** An empty body row at a row index; the header stays first, so index 0 inserts below it too. */
export function insertTableRow(table: HTMLTableElement, index: number) {
  const row = createTableRow(table);
  const body = table.tBodies[0] ?? table.appendChild(table.ownerDocument.createElement("tbody"));
  const before = tableRows(table)[Math.max(1, index)];
  if (before && before.parentElement === body) body.insertBefore(row, before);
  else body.append(row);
  return row;
}

/** An empty unaligned column at a column index; returns its cells from the header down. */
export function insertTableColumn(table: HTMLTableElement, index: number) {
  return tableRows(table).map((row, rowIndex) => {
    const cell = createCell(table.ownerDocument, rowIndex === 0 ? "th" : "td", null);
    const before = rowCells(row)[index];
    if (before) row.insertBefore(cell, before);
    else row.append(cell);
    return cell;
  });
}

export function deleteTableColumn(table: HTMLTableElement, index: number) {
  for (const cell of columnCells(table, index)) cell.remove();
}

function createCell(document: Document, tag: "td" | "th", alignment: TableAlignment) {
  const cell = document.createElement(tag);
  if (alignment) cell.setAttribute(TABLE_ALIGN_ATTRIBUTE, alignment);
  cell.append(document.createElement("br"));
  return cell;
}

export function createTableRow(table: HTMLTableElement) {
  const row = table.ownerDocument.createElement("tr");
  for (const alignment of readTableAlignments(table)) row.append(createCell(table.ownerDocument, "td", alignment));
  return row;
}

export function createTable(document: Document, columns: number, bodyRows: number) {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (let column = 0; column < columns; column += 1) headerRow.append(createCell(document, "th", null));
  head.append(headerRow);
  const body = document.createElement("tbody");
  table.append(head, body);
  for (let row = 0; row < bodyRows; row += 1) body.append(createTableRow(table));
  return table;
}

export function placeCaretInCell(cell: HTMLTableCellElement, atEnd = false) {
  const selection = cell.ownerDocument.getSelection();
  if (!selection) return;
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  range.collapse(!atEnd);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Markdown cells hold one line of inline text: nested blocks dissolve into it and inner line breaks become spaces. */
function flattenCellContent(cell: HTMLTableCellElement) {
  for (const block of Array.from(cell.querySelectorAll(CELL_BLOCK_SELECTOR)).reverse()) {
    block.replaceWith(...(block.previousSibling ? [" "] : []), ...Array.from(block.childNodes));
  }

  const breaks = Array.from(cell.querySelectorAll("br"));
  for (const lineBreak of breaks) lineBreak.replaceWith(" ");
  cell.normalize();
  const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.includes("\n")) text.data = text.data.replace(/[ \t]*\n[ \t]*/gu, " ");
  }

  const first = cell.firstChild;
  if (first instanceof Text) first.data = first.data.replace(/^[ \t\n]+/u, "");
  const last = cell.lastChild;
  if (last instanceof Text) last.data = last.data.replace(/[ \t\n]+$/u, "");
  if (!(cell.textContent ?? "") && !cell.querySelector("[data-comment-thread]")) {
    cell.replaceChildren(cell.ownerDocument.createElement("br"));
  }
}

function retagRow(row: HTMLTableRowElement, tag: "td" | "th", alignments: readonly TableAlignment[]) {
  const cells = rowCells(row).map((cell, column) => {
    let next = cell;
    if (cell.tagName.toLowerCase() !== tag) {
      next = row.ownerDocument.createElement(tag);
      next.append(...Array.from(cell.childNodes));
    }
    const alignment = alignments[column] ?? null;
    if (alignment) next.setAttribute(TABLE_ALIGN_ATTRIBUTE, alignment);
    else next.removeAttribute(TABLE_ALIGN_ATTRIBUTE);
    return next;
  });
  while (cells.length < alignments.length) {
    cells.push(row.ownerDocument.createElement(tag));
    const alignment = alignments[cells.length - 1] ?? null;
    if (alignment) cells.at(-1)!.setAttribute(TABLE_ALIGN_ATTRIBUTE, alignment);
  }
  row.replaceChildren(...cells);
  return row;
}

export function normalizeTables(root: ParentNode) {
  for (const table of Array.from(root.querySelectorAll("table")).reverse()) {
    const rows = tableRows(table);
    if (!rows.length) {
      table.remove();
      continue;
    }

    const columns = Math.max(1, ...rows.map((row) => rowCells(row).length));
    const headerAlignments = rowCells(rows[0]!).map(readAlignment);
    const alignments = Array.from({ length: columns }, (_, column) => headerAlignments[column] ?? null);
    const head = table.ownerDocument.createElement("thead");
    const body = table.ownerDocument.createElement("tbody");
    head.append(retagRow(rows[0]!, "th", alignments));
    for (const row of rows.slice(1)) body.append(retagRow(row, "td", alignments));
    table.replaceChildren(head, body);
    for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>("td, th"))) flattenCellContent(cell);
  }
}
