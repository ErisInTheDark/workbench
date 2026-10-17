/*
 * Exports:
 * - CommentThreadView / CommentDraftView / CommentMarginSnapshot: what the comment margin shows, positioned in shell px.
 * - WorkbenchCommentControllerOptions: editor surfaces and mutation hooks the controller drives.
 * - WorkbenchCommentController: margin-facing comment API.
 * - default WorkbenchCommentController: own comment threads: find atoms and their anchors, track the active thread,
 *   and create, reply to, edit and resolve threads as editor mutations.
 */

import type { MarkdownComment } from "../markdown/comment-markdown";
import {
    createCommentThreadElement,
    getCommentThreadKind,
    isCommentThreadElement,
    readThreadComments,
    writeThreadComments,
    type CommentThreadKind,
} from "../markdown/review-markup";
import type { EditorHighlightScope } from "./editor-highlights";
import {
    createInlineSelectionMarker,
    flattenInlineContent,
    normalizeInlineLeaves,
    rebuildInlineRunContainer,
    type InlineLeaf,
} from "./inline-leaves";

export interface CommentThreadView {
  anchored: boolean;
  comments: MarkdownComment[];
  id: string;
  kind: CommentThreadKind;
  quote: string;
  top: number;
}

export interface CommentDraftView {
  quote: string;
  top: number;
}

export interface CommentMarginSnapshot {
  activeId: string | null;
  draft: CommentDraftView | null;
  threads: CommentThreadView[];
}

export interface WorkbenchCommentControllerOptions {
  container: HTMLElement;
  editor: HTMLDivElement;
  getInlineRunContainer: (node: Node | null) => HTMLElement | null;
  highlights: EditorHighlightScope;
  isRichMode: () => boolean;
  runStructuralMutation: (mutate: () => void) => void;
  scheduleFrame: (callback: () => void) => void;
}

export interface WorkbenchCommentController {
  cancelDraft: () => void;
  deleteComment: (id: string, index: number) => void;
  editComment: (id: string, index: number, body: string) => void;
  getSnapshot: () => CommentMarginSnapshot;
  refresh: () => void;
  reply: (id: string, body: string) => void;
  resolve: (id: string) => void;
  scheduleRefresh: () => void;
  setActive: (id: string | null) => void;
  startDraft: () => boolean;
  submitDraft: (body: string) => void;
  subscribe: (listener: () => void) => () => void;
  syncActiveFromSelection: () => void;
}

const EMPTY_SNAPSHOT: CommentMarginSnapshot = { activeId: null, draft: null, threads: [] };
const ANCHORED_ATTRIBUTE = "data-comment-anchored";
const QUOTE_LIMIT = 120;

function isMarkedText(node: Node, container: HTMLElement) {
  for (let current = node.parentNode; current && current !== container; current = current.parentNode) {
    if (current instanceof HTMLElement && current.tagName === "MARK") return true;
  }
  return false;
}

/** The marked text right before an inline thread: the words it highlights. */
function findAnchorRange(atom: HTMLElement, container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  walker.currentNode = atom;
  let first: Text | null = null;
  let last: Text | null = null;
  for (let node = walker.previousNode(); node && node !== container; node = walker.previousNode()) {
    if (isCommentThreadElement(node)) break;
    if (!(node instanceof Text) || !node.data) continue;
    if (!isMarkedText(node, container)) break;
    first = node;
    last ??= node;
  }
  if (!first || !last) return null;

  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  return range;
}

function quoteOf(text: string) {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > QUOTE_LIMIT ? `${compact.slice(0, QUOTE_LIMIT - 1)}…` : compact;
}

/** Ranges without layout (detached documents) have no client rects. */
function firstRectOf(range: Range | null) {
  return range && typeof range.getClientRects === "function" ? range.getClientRects()[0] ?? null : null;
}

function isRootBreak(node: Node | null) {
  return node instanceof HTMLBRElement;
}

function WorkbenchCommentController(options: WorkbenchCommentControllerOptions): WorkbenchCommentController {
  const { container, editor } = options;
  const listeners = new Set<() => void>();
  const ids = new WeakMap<HTMLElement, string>();
  let idCounter = 0;
  let snapshot = EMPTY_SNAPSHOT;
  let snapshotKey = "";
  let activeId: string | null = null;
  let draftRange: Range | null = null;

  function idOf(atom: HTMLElement) {
    let id = ids.get(atom);
    if (!id) {
      idCounter += 1;
      id = `c${idCounter}`;
      ids.set(atom, id);
    }
    return id;
  }

  function atoms() {
    return Array.from(editor.querySelectorAll<HTMLElement>("[data-comment-thread]"));
  }

  function findAtom(id: string) {
    return atoms().find((atom) => ids.get(atom) === id) ?? null;
  }

  function blockAnchorOf(atom: HTMLElement) {
    for (let node = atom.previousElementSibling; node; node = node.previousElementSibling) {
      if (!isRootBreak(node) && !isCommentThreadElement(node)) return node as HTMLElement;
    }
    return atom.nextElementSibling instanceof HTMLElement ? atom.nextElementSibling : null;
  }

  function anchorRangeOf(atom: HTMLElement) {
    if (getCommentThreadKind(atom) === "block") return null;
    const runContainer = options.getInlineRunContainer(atom);
    return runContainer ? findAnchorRange(atom, runContainer) : null;
  }

  function topOf(rect: DOMRect | null | undefined) {
    return rect ? rect.top - container.getBoundingClientRect().top : 0;
  }

  function describe(atom: HTMLElement): CommentThreadView {
    const kind = getCommentThreadKind(atom);
    const anchor = anchorRangeOf(atom);
    atom.toggleAttribute(ANCHORED_ATTRIBUTE, Boolean(anchor));
    const block = kind === "block" ? blockAnchorOf(atom) : null;
    const rect = firstRectOf(anchor)
      ?? (kind === "block" ? block?.getBoundingClientRect() : atom.getBoundingClientRect());
    return {
      anchored: Boolean(anchor),
      comments: readThreadComments(atom),
      id: idOf(atom),
      kind,
      quote: quoteOf(anchor?.toString() ?? (kind === "block" ? block?.textContent ?? "" : "")),
      top: topOf(rect),
    };
  }

  function emit() {
    for (const listener of listeners) listener();
  }

  function paintActive(threads: readonly CommentThreadView[]) {
    const atom = activeId ? findAtom(activeId) : null;
    const anchor = atom ? anchorRangeOf(atom) : null;
    options.highlights.set("comment-active", anchor ? [anchor] : []);
    options.highlights.set("comment-draft", draftRange && !draftRange.collapsed ? [draftRange] : []);
    if (activeId && !threads.some((thread) => thread.id === activeId)) activeId = null;
  }

  function refresh() {
    const threads = options.isRichMode() ? atoms().map(describe) : [];
    paintActive(threads);
    const draft = draftRange
      ? { quote: quoteOf(draftRange.toString()), top: topOf(firstRectOf(draftRange) ?? draftBlockRect()) }
      : null;
    const next: CommentMarginSnapshot = { activeId, draft, threads };
    const key = JSON.stringify(next);
    if (key === snapshotKey) return;
    snapshotKey = key;
    snapshot = next;
    emit();
  }

  function draftBlockRect() {
    const block = draftRange ? topLevelBlockOf(draftRange.startContainer) : null;
    return block instanceof HTMLElement ? block.getBoundingClientRect() : editor.getBoundingClientRect();
  }

  function scheduleRefresh() {
    options.scheduleFrame(refresh);
  }

  function topLevelBlockOf(node: Node | null) {
    let current = node;
    while (current && current.parentNode !== editor) current = current.parentNode;
    return current;
  }

  function startDraft() {
    const selection = window.getSelection();
    if (!options.isRichMode() || !selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
      return false;
    }

    draftRange = selection.getRangeAt(0).cloneRange();
    activeId = null;
    refresh();
    return true;
  }

  function cancelDraft() {
    draftRange = null;
    refresh();
  }

  /** Mark the range's text and place the new thread right after it, inside one inline run. */
  function anchorInRun(runContainer: HTMLElement, range: Range, atom: HTMLElement) {
    const endMarker = createInlineSelectionMarker("selection-end");
    const startMarker = createInlineSelectionMarker("selection-start");
    const endRange = range.cloneRange();
    endRange.collapse(false);
    endRange.insertNode(endMarker);
    const startRange = range.cloneRange();
    startRange.collapse(true);
    startRange.insertNode(startMarker);

    let phase: "before" | "selected" | "after" = "before";
    const leaves = flattenInlineContent(runContainer.childNodes).flatMap((leaf): InlineLeaf[] => {
      if (leaf.type === "marker") {
        if (leaf.role === "selection-start") phase = "selected";
        if (leaf.role === "selection-end") {
          phase = "after";
          return [{ type: "atom", element: atom, marks: [] }];
        }
        return [];
      }
      return phase === "selected" && leaf.type === "text" ? [{ ...leaf, marks: [...leaf.marks, { tag: "mark" }] }] : [leaf];
    });
    rebuildInlineRunContainer(runContainer, normalizeInlineLeaves(leaves));
  }

  /** Comment lines sit right below their block; a blank line after them keeps the next block apart. */
  function insertBlockThreadAfter(node: Node | null, atom: HTMLElement) {
    const block = topLevelBlockOf(node);
    if (!block || block === editor) {
      editor.append(atom);
      return;
    }

    const next = block.nextSibling;
    block.parentNode!.insertBefore(atom, next);
    if (next && !isRootBreak(next) && !isCommentThreadElement(next)) {
      atom.after(document.createElement("br"));
    }
  }

  function submitDraft(body: string) {
    const range = draftRange;
    const text = body.trim();
    draftRange = null;
    if (!range || !text) {
      refresh();
      return;
    }

    const runContainer = options.getInlineRunContainer(range.startContainer);
    const anchored = !range.collapsed && runContainer && runContainer.contains(range.endContainer) && range.toString().trim();
    const atom = createCommentThreadElement(document, anchored ? "inline" : "block", [{ author: null, body: text }]);
    options.runStructuralMutation(() => {
      if (anchored) anchorInRun(runContainer, range, atom);
      else insertBlockThreadAfter(range.collapsed ? range.startContainer : range.endContainer, atom);
    });
    activeId = idOf(atom);
    refresh();
  }

  function updateComments(id: string, change: (comments: MarkdownComment[]) => MarkdownComment[]) {
    const atom = findAtom(id);
    if (!atom) return;
    const next = change(readThreadComments(atom));
    if (!next.length) {
      resolve(id);
      return;
    }
    options.runStructuralMutation(() => {
      writeThreadComments(atom, next);
    });
    refresh();
  }

  function reply(id: string, body: string) {
    const text = body.trim();
    if (text) updateComments(id, (comments) => [...comments, { author: null, body: text }]);
  }

  function editComment(id: string, index: number, body: string) {
    const text = body.trim();
    updateComments(id, (comments) => text
      ? comments.map((comment, position) => position === index ? { author: comment.author, body: text } : comment)
      : comments.filter((_, position) => position !== index));
  }

  function deleteComment(id: string, index: number) {
    updateComments(id, (comments) => comments.filter((_, position) => position !== index));
  }

  /** Blank lines around a thread's comment lines collapse to what its neighbours would have had alone. */
  function removeBlockThread(atom: HTMLElement) {
    const before: Node[] = [];
    const after: Node[] = [];
    for (let node = atom.previousSibling; isRootBreak(node); node = node!.previousSibling) before.push(node!);
    for (let node = atom.nextSibling; isRootBreak(node); node = node!.nextSibling) after.push(node!);
    const kept = Math.max(0, Math.max(before.length, after.length) - 1);
    for (const node of [...before, ...after]) node.parentNode?.removeChild(node);
    for (let count = 0; count < kept; count += 1) atom.before(document.createElement("br"));
    atom.remove();
  }

  function removeInlineThread(atom: HTMLElement) {
    const runContainer = options.getInlineRunContainer(atom);
    const anchor = runContainer ? findAnchorRange(atom, runContainer) : null;
    if (!runContainer || !anchor) {
      atom.remove();
      return;
    }

    const startMarker = createInlineSelectionMarker("selection-start");
    anchor.insertNode(startMarker);
    let phase: "before" | "anchor" = "before";
    const leaves = flattenInlineContent(runContainer.childNodes).flatMap((leaf): InlineLeaf[] => {
      if (leaf.type === "marker" && leaf.role === "selection-start") {
        phase = "anchor";
        return [];
      }
      if (leaf.type === "atom" && leaf.element === atom) {
        phase = "before";
        return [];
      }
      return phase === "anchor" && leaf.type === "text" ? [{ ...leaf, marks: leaf.marks.filter((mark) => mark.tag !== "mark") }] : [leaf];
    });
    rebuildInlineRunContainer(runContainer, normalizeInlineLeaves(leaves));
  }

  function resolve(id: string) {
    const atom = findAtom(id);
    if (!atom) return;
    options.runStructuralMutation(() => {
      if (getCommentThreadKind(atom) === "block") removeBlockThread(atom);
      else removeInlineThread(atom);
    });
    if (activeId === id) activeId = null;
    refresh();
  }

  function setActive(id: string | null) {
    if (activeId === id) return;
    activeId = id;
    refresh();
  }

  /** The caret inside highlighted words, or right beside a thread, activates that thread. */
  function syncActiveFromSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    const match = atoms().find((atom) => {
      const anchor = anchorRangeOf(atom);
      if (anchor) return anchor.comparePoint(range.startContainer, range.startOffset) === 0;
      return getCommentThreadKind(atom) === "inline" && range.collapsed && (
        (range.startContainer === atom.parentNode && atom.parentNode.childNodes[range.startOffset - 1] === atom)
        || (range.startContainer === atom.nextSibling && range.startOffset === 0)
      );
    });
    setActive(match ? idOf(match) : null);
  }

  return {
    cancelDraft,
    deleteComment,
    editComment,
    getSnapshot: () => snapshot,
    refresh,
    reply,
    resolve,
    scheduleRefresh,
    setActive,
    startDraft,
    submitDraft,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncActiveFromSelection,
  };
}

export default WorkbenchCommentController;
