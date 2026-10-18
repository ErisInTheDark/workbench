/*
 * Exports:
 * - WorkbenchBlockStructureControllerOptions: the editor root and its structural mutation pipeline.
 * - WorkbenchBlockStructureController: keys and toolbar actions that edit code blocks, and create code blocks and tables.
 * - default WorkbenchBlockStructureController: keep code blocks plain multi-line text while typing, pasting and
 *   deleting, step out of them below, and create code blocks and tables from the toolbar or a typed fence or pipe row.
 *   Editing inside tables belongs to WorkbenchTableController.
 */

import {
    closestCodeBlock,
    getCodeBlockCaretOffset,
    readCodeBlockText,
    writeCodeBlockText,
} from "../dom/mutation/code-block-dom";
import {
    createTable,
    placeCaretInCell,
    rowCells,
    tableRows,
} from "../dom/mutation/table-dom";
import { inheritSuggestionMembership } from "../markdown/review-markup";

export interface WorkbenchBlockStructureControllerOptions {
  editor: HTMLElement;
  runStructuralMutation: (mutate: () => void) => void;
}

interface WorkbenchBlockStructureController {
  /** Handle an edit inside a code block, or a typed shortcut that creates a code block or table; true when handled. */
  handleBeforeInput: (event: InputEvent) => boolean;
  /** Tab indents code; true when handled. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
  insertTable: () => void;
  toggleCodeBlock: () => void;
}

const TEXT_BLOCK = /^(P|DIV|H[1-6]|BLOCKQUOTE)$/u;
const CODE_INDENT = "  ";
const TYPED_FENCE = /^```([^`\s]*)\s*$/u;
const TYPED_TABLE_ROW = /^\|(.*)\|\s*$/u;

function currentRange(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return editor.contains(range.startContainer) && editor.contains(range.endContainer) ? range : null;
}

function placeCaret(node: Node, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function emptyParagraph() {
  const paragraph = document.createElement("p");
  paragraph.append(document.createElement("br"));
  return paragraph;
}

function textAfter(container: HTMLElement, range: Range) {
  const after = document.createRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);
  return after.toString();
}

function pastedText(event: InputEvent) {
  return event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
}

function WorkbenchBlockStructureController(
  options: WorkbenchBlockStructureControllerOptions,
): WorkbenchBlockStructureController {
  const { editor, runStructuralMutation } = options;

  function topLevelBlock(node: Node) {
    let current: Node | null = node;
    while (current && current.parentNode !== editor) current = current.parentNode;
    return current instanceof HTMLElement ? current : null;
  }

  /** The paragraph after a block, created when the block ends its container, with the caret in it. */
  function stepOutBelow(block: HTMLElement) {
    const next = block.nextElementSibling;
    const target = next instanceof HTMLParagraphElement && !(next.textContent ?? "").trim() ? next : emptyParagraph();
    if (target !== next) {
      block.after(target);
      inheritSuggestionMembership(block, target);
    }
    placeCaret(target, 0);
  }

  function editCode(pre: HTMLPreElement, range: Range, insert: string, { exitOnEmptyLine = false } = {}) {
    const text = readCodeBlockText(pre);
    const start = getCodeBlockCaretOffset(pre, range.startContainer, range.startOffset);
    const end = getCodeBlockCaretOffset(pre, range.endContainer, range.endOffset);
    runStructuralMutation(() => {
      // Enter on an empty last line leaves the block, taking that line with it.
      if (exitOnEmptyLine && start === end && start === text.length && (text === "" || text.endsWith("\n"))) {
        writeCodeBlockText(pre, text.replace(/\n$/u, ""), null);
        stepOutBelow(pre);
        return;
      }
      writeCodeBlockText(pre, `${text.slice(0, start)}${insert}${text.slice(end)}`, start + insert.length);
    });
  }

  function codeLineIndent(pre: HTMLPreElement, range: Range) {
    const text = readCodeBlockText(pre);
    const start = getCodeBlockCaretOffset(pre, range.startContainer, range.startOffset);
    return text.slice(text.lastIndexOf("\n", start - 1) + 1, start).match(/^[ \t]*/u)![0];
  }

  /** Indent or outdent every line the selection touches, keeping the selection on the same text. */
  function indentCode(pre: HTMLPreElement, range: Range, outdent: boolean) {
    const text = readCodeBlockText(pre);
    const start = getCodeBlockCaretOffset(pre, range.startContainer, range.startOffset);
    const end = getCodeBlockCaretOffset(pre, range.endContainer, range.endOffset);
    if (!outdent && start === end) {
      editCode(pre, range, CODE_INDENT);
      return;
    }

    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lines = text.slice(lineStart, end).split("\n");
    let removedBeforeStart = 0;
    let removed = 0;
    const nextLines = lines.map((line, index) => {
      if (!outdent) return `${CODE_INDENT}${line}`;
      const strip = line.match(/^ {1,2}|^\t/u)?.[0].length ?? 0;
      if (index === 0) removedBeforeStart = Math.min(strip, start - lineStart);
      removed += strip;
      return line.slice(strip);
    });
    const next = `${text.slice(0, lineStart)}${nextLines.join("\n")}${text.slice(end)}`;
    runStructuralMutation(() => {
      writeCodeBlockText(pre, next, null);
      const node = pre.querySelector("code")!.firstChild!;
      const selection = window.getSelection()!;
      const nextRange = document.createRange();
      nextRange.setStart(node, outdent ? start - removedBeforeStart : start + CODE_INDENT.length);
      nextRange.setEnd(node, outdent ? end - removed : end + CODE_INDENT.length * lines.length);
      selection.removeAllRanges();
      selection.addRange(nextRange);
    });
  }

  function handleCodeBeforeInput(pre: HTMLPreElement, range: Range, event: InputEvent) {
    switch (event.inputType) {
      case "insertParagraph":
      case "insertLineBreak":
        event.preventDefault();
        editCode(pre, range, `\n${codeLineIndent(pre, range)}`, { exitOnEmptyLine: event.inputType === "insertParagraph" });
        return true;
      case "insertFromPaste":
      case "insertFromDrop":
      case "insertReplacementText":
        event.preventDefault();
        editCode(pre, range, pastedText(event).replace(/\r\n?/gu, "\n"));
        return true;
      case "deleteContentBackward":
        if (!range.collapsed || getCodeBlockCaretOffset(pre, range.startContainer, range.startOffset) > 0) return false;
        event.preventDefault();
        // Backspace at the start of an empty block turns it back into a paragraph; otherwise blocks never merge.
        if (!readCodeBlockText(pre)) {
          runStructuralMutation(() => {
            const paragraph = emptyParagraph();
            inheritSuggestionMembership(pre, paragraph);
            pre.replaceWith(paragraph);
            placeCaret(paragraph, 0);
          });
        }
        return true;
      case "deleteContentForward":
        if (!range.collapsed || getCodeBlockCaretOffset(pre, range.startContainer, range.startOffset) < readCodeBlockText(pre).length) {
          return false;
        }
        event.preventDefault();
        return true;
      default:
        return false;
    }
  }

  function moveToCell(cell: HTMLTableCellElement | undefined, atEnd = false) {
    if (cell) placeCaretInCell(cell, atEnd);
  }

  function readParagraphText(paragraph: HTMLElement) {
    return (paragraph.textContent ?? "").replaceAll(" ", " ");
  }

  /** Enter after a fence line or a pipe row, at the end of its own paragraph, turns it into a code block or table. */
  function handleTypedShortcut(range: Range, event: InputEvent) {
    if (event.inputType !== "insertParagraph" || !range.collapsed) return false;
    const block = topLevelBlock(range.startContainer);
    if (!(block instanceof HTMLParagraphElement) || textAfter(block, range).trim()) return false;
    const text = readParagraphText(block).trim();

    const fence = text.match(TYPED_FENCE);
    if (fence) {
      event.preventDefault();
      runStructuralMutation(() => {
        const pre = document.createElement("pre");
        inheritSuggestionMembership(block, pre);
        if (fence[1]) pre.dataset.language = fence[1];
        block.replaceWith(pre);
        writeCodeBlockText(pre, "", 0);
      });
      return true;
    }

    const row = text.match(TYPED_TABLE_ROW);
    if (row) {
      event.preventDefault();
      const headers = row[1]!.split("|").map((cell) => cell.trim());
      runStructuralMutation(() => {
        const table = createTable(document, headers.length, 1);
        inheritSuggestionMembership(block, table);
        rowCells(tableRows(table)[0]!).forEach((cell, index) => {
          if (headers[index]) cell.replaceChildren(headers[index]!);
        });
        block.replaceWith(table);
        moveToCell(rowCells(tableRows(table)[1]!)[0]);
      });
      return true;
    }

    return false;
  }

  function handleBeforeInput(event: InputEvent) {
    const range = currentRange(editor);
    if (!range) return false;
    const pre = closestCodeBlock(editor, range.startContainer);
    if (pre) return handleCodeBeforeInput(pre, range, event);
    return handleTypedShortcut(range, event);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return false;
    const range = currentRange(editor);
    if (!range) return false;
    const pre = closestCodeBlock(editor, range.startContainer);
    if (pre && pre.contains(range.endContainer)) {
      event.preventDefault();
      indentCode(pre, range, event.shiftKey);
      return true;
    }
    return false;
  }

  function touchedTopLevelBlocks(range: Range) {
    return Array.from(editor.children).filter((child): child is HTMLElement => {
      return child instanceof HTMLElement && (child.contains(range.startContainer) || range.intersectsNode(child));
    });
  }

  /** Text blocks become one code block of their lines; code blocks become one paragraph per non-empty line. */
  function toggleCodeBlock() {
    const range = currentRange(editor);
    if (!range) return;
    const touched = touchedTopLevelBlocks(range);
    const codeBlocks = touched.filter((block): block is HTMLPreElement => block instanceof HTMLPreElement);
    runStructuralMutation(() => {
      if (codeBlocks.length && codeBlocks.length === touched.length) {
        let first: HTMLElement | null = null;
        for (const pre of codeBlocks) {
          const paragraphs = readCodeBlockText(pre).split("\n").filter((line) => line.trim()).map((line) => {
            const paragraph = document.createElement("p");
            paragraph.textContent = line;
            inheritSuggestionMembership(pre, paragraph);
            return paragraph;
          });
          if (!paragraphs.length) paragraphs.push(emptyParagraph());
          pre.replaceWith(...paragraphs);
          first ??= paragraphs[0]!;
        }
        if (first) placeCaret(first, 0);
        return;
      }

      const textBlocks = touched.filter((block) => TEXT_BLOCK.test(block.tagName));
      const pre = document.createElement("pre");
      if (!textBlocks.length) {
        const anchor = touched.at(-1);
        if (anchor) anchor.after(pre);
        else editor.append(pre);
        if (anchor) inheritSuggestionMembership(anchor, pre);
        writeCodeBlockText(pre, "", 0);
        return;
      }
      const code = textBlocks.map(readParagraphText).join("\n").replace(/^\n+|\n+$/gu, "");
      inheritSuggestionMembership(textBlocks[0]!, pre);
      textBlocks[0]!.replaceWith(pre);
      for (const block of textBlocks.slice(1)) block.remove();
      writeCodeBlockText(pre, code, code.length);
    });
  }

  /** A two-column table below the caret's block, or in place of an empty paragraph, with the caret in its first header. */
  function insertTable() {
    const range = currentRange(editor);
    const anchor = range ? topLevelBlock(range.startContainer) : null;
    runStructuralMutation(() => {
      const table = createTable(document, 2, 1);
      if (anchor instanceof HTMLParagraphElement && !readParagraphText(anchor).trim() && !anchor.querySelector("[data-comment-thread]")) {
        inheritSuggestionMembership(anchor, table);
        anchor.replaceWith(table);
      } else if (anchor) {
        inheritSuggestionMembership(anchor, table);
        anchor.after(table);
      } else {
        editor.append(table);
      }
      moveToCell(rowCells(tableRows(table)[0]!)[0]);
    });
  }

  return {
    handleBeforeInput,
    handleKeyDown,
    insertTable,
    toggleCodeBlock,
  };
}

export default WorkbenchBlockStructureController;
