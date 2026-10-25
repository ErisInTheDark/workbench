/*
 * Exports:
 * - LinkCardView / LinkDraftView / LinkChromeSnapshot: the link card and link draft the editor shows, in shell px.
 * - WorkbenchLinkControllerOptions: editor surfaces, timers and mutation hooks the controller drives.
 * - WorkbenchLinkController: link editing, the link card, opening, typed-markdown links and link-edge typing.
 * - default WorkbenchLinkController: own links: a link is the run of text carrying one `a` mark; drafts link the
 *   selection, the caret's link or word, or new text; typing `[text](url)` becomes a link; text typed at a link's edge
 *   stays outside it.
 */

import { closestCodeBlock } from "../dom/mutation/code-block-dom";
import { headingSlug, toLinkDestination } from "../markdown/markdown-link-destination";
import type { EditorHighlightScope } from "./editor-highlights";
import {
    createInlineSelectionMarker,
    flattenInlineContent,
    normalizeInlineLeaves,
    rebuildInlineRunContainer,
    restoreCaretToMarker,
    type InlineLeaf,
    type InlineMark,
} from "./inline-leaves";
import { getInlineRunContainer } from "./inline-run-containers";
import {
    readRunText,
    rebuildRunSpan,
    runOffsetOf,
    runRange,
    selectRunPoints,
    spanOfRange,
    wordAt,
    type RunPoint,
    type TextLeaf,
} from "./inline-run-text";

export interface LinkCardView {
  /** The card's actions may change the document. */
  editable: boolean;
  href: string;
  left: number;
  top: number;
}

export interface LinkDraftView {
  /** The draft edits an existing link, so it can also remove it. */
  editing: boolean;
  href: string;
  left: number;
  /** Nothing is selected to link, so the draft also asks for the text it inserts. */
  needsText: boolean;
  top: number;
}

export interface LinkChromeSnapshot {
  card: LinkCardView | null;
  draft: LinkDraftView | null;
  /** The shell's width, so link chrome can stay inside it. */
  width: number;
}

export interface WorkbenchLinkControllerOptions {
  cancel: (id: string) => void;
  container: HTMLElement;
  editor: HTMLDivElement;
  getEditorHasFocus: () => boolean;
  highlights: EditorHighlightScope;
  isEditable: () => boolean;
  isRichMode: () => boolean;
  /** Suggest mode turns the blocks at the selection into a suggestion before they change. */
  prepareForEdit: () => void;
  runStructuralMutation: (mutate: () => void, hooks?: { afterSelectionRestore?: () => void }) => void;
  schedule: (id: string, delayMs: number, callback: () => void) => void;
  scheduleFrame: (callback: () => void) => void;
}

export interface WorkbenchLinkController {
  cancelDraft: (options?: { refocus?: boolean }) => void;
  /** Edit the link the card shows. */
  editCard: () => void;
  getSnapshot: () => LinkChromeSnapshot;
  /** Turn text typed at a link's edge into text beside it; true when the input was handled. */
  handleBeforeInput: (event: InputEvent) => boolean;
  /** Clicks on links never navigate; Ctrl or Cmd+click opens the link instead. True when it opened one. */
  handleClick: (event: MouseEvent) => boolean;
  /** Turn a just-closed `[text](url)` into a link; runs inside the editor's input mutation. */
  handleInput: (event: Event) => boolean;
  /** The selection is in a link. */
  isActive: () => boolean;
  openCard: () => void;
  refresh: () => void;
  removeCardLink: () => void;
  /** Scroll to the heading an anchor names and put the caret there; false without one. */
  revealHeading: (slug: string) => boolean;
  scheduleRefresh: () => void;
  /** The pointer is over the card, which keeps it open. */
  setCardHeld: (held: boolean) => void;
  setOpenHandler: (handler: ((href: string) => void) | null) => void;
  /** Link the selection, or edit the caret's link, or link its word, or ask for new linked text. */
  startDraft: () => boolean;
  /** Apply the draft; an empty href removes the link. False keeps the draft open for an href that cannot be a link. */
  submitDraft: (href: string, text?: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  syncHoverFromPointer: (target: EventTarget | null, clientY?: number) => void;
}

interface LinkSpan {
  container: HTMLElement;
  end: number;
  href: string;
  start: number;
}

interface DraftTarget {
  /** A collapsed draft inserts text at this caret, kept as a DOM point so soft line breaks keep their side. */
  caret: Range | null;
  end: RunPoint;
  href: string | null;
  start: RunPoint;
}

const EMPTY_SNAPSHOT: LinkChromeSnapshot = { card: null, draft: null, width: 0 };
const HOVER_DELAY_MS = 240;
const LEAVE_GRACE_MS = 320;
const HOVER_TIMER = "editor-link-hover";
const LEAVE_TIMER = "editor-link-leave";
const CARD_GAP_PX = 4;
/** `[text](url)` just closed at the caret; `!` would make it an image and a backslash escapes the bracket. */
const TYPED_LINK = /(^|[^\\!])\[([^[\]\n]+)\]\(([^()\s]+)\)$/u;

function linkOf(marks: readonly InlineMark[]) {
  return marks.find((mark): mark is Extract<InlineMark, { tag: "a" }> => mark.tag === "a")?.href ?? null;
}

function withLink(marks: readonly InlineMark[], href: string | null): InlineMark[] {
  const rest = marks.filter((mark) => mark.tag !== "a");
  return href ? [...rest, { tag: "a", href }] : rest;
}

/**
 * Text leaves of a run with their text offsets and links. Canonical runs keep whitespace out of marks, so whitespace
 * between two pieces of one link belongs to that link, as its markdown does.
 */
function textPieces(container: HTMLElement) {
  const pieces: Array<{ end: number; href: string | null; leaf: TextLeaf; start: number }> = [];
  let position = 0;
  for (const leaf of flattenInlineContent(container.childNodes)) {
    if (leaf.type !== "text" || !leaf.text) continue;
    pieces.push({ end: position + leaf.text.length, href: linkOf(leaf.marks), leaf, start: position });
    position += leaf.text.length;
  }
  const own = pieces.map((piece) => piece.href);
  pieces.forEach((piece, index) => {
    if (piece.href || !/^[ \t ]+$/u.test(piece.leaf.text)) return;
    if (own[index - 1] && own[index - 1] === own[index + 1]) piece.href = own[index - 1]!;
  });
  return pieces;
}

/** The link holding the character after `offset`, else the one before it. */
function linkSpanAt(container: HTMLElement, offset: number): LinkSpan | null {
  const pieces = textPieces(container);
  let at = pieces.findIndex((piece) => piece.start <= offset && offset < piece.end && piece.href !== null);
  if (at < 0) at = pieces.findIndex((piece) => piece.start < offset && offset <= piece.end && piece.href !== null);
  if (at < 0) return null;
  const href = pieces[at]!.href!;
  const same = (index: number) => index >= 0 && index < pieces.length && pieces[index]!.href === href;
  let first = at;
  let last = at;
  while (same(first - 1) && pieces[first - 1]!.end === pieces[first]!.start) first -= 1;
  while (same(last + 1) && pieces[last + 1]!.start === pieces[last]!.end) last += 1;
  return { container, end: pieces[last]!.end, href, start: pieces[first]!.start };
}

/** Ranges without layout (detached documents) have no client rects. */
function rectsOf(range: Range | null) {
  return range && typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
}

function rectNear(rects: readonly DOMRect[], clientY: number | null) {
  return (clientY === null ? null : rects.find((rect) => rect.top <= clientY && clientY <= rect.bottom)) ?? rects.at(-1) ?? null;
}

function WorkbenchLinkController(options: WorkbenchLinkControllerOptions): WorkbenchLinkController {
  const { container: shell, editor } = options;
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;
  let snapshotKey = "";
  let draft: DraftTarget | null = null;
  let cardSpan: LinkSpan | null = null;
  let hoveredAnchor: HTMLElement | null = null;
  let pointerAnchor: HTMLElement | null = null;
  let pointerY: number | null = null;
  let cardHeld = false;
  let openHandler: ((href: string) => void) | null = null;

  function editorRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.startContainer) && editor.contains(range.endContainer) ? range : null;
  }

  function anchorOf(target: EventTarget | null) {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    const anchor = element?.closest<HTMLElement>("a") ?? null;
    return anchor && editor.contains(anchor) ? anchor : null;
  }

  function spanOfAnchor(anchor: HTMLElement) {
    const container = getInlineRunContainer(editor, anchor);
    return container ? linkSpanAt(container, runOffsetOf(container, anchor, 0)) : null;
  }

  /** The link the selection sits in: the caret's, or the one holding both ends of a selection. */
  function selectionLink(range = editorRange()) {
    if (!range) return null;
    const container = getInlineRunContainer(editor, range.startContainer);
    if (!container || !container.contains(range.endContainer)) return null;
    const start = runOffsetOf(container, range.startContainer, range.startOffset);
    const link = linkSpanAt(container, start);
    if (!link || range.collapsed) return link;
    const end = runOffsetOf(container, range.endContainer, range.endOffset);
    return link.start <= start && end <= link.end ? link : null;
  }

  function shellPoint(rect: DOMRect | null) {
    const origin = shell.getBoundingClientRect();
    return rect ? { left: Math.round(rect.left - origin.left), top: Math.round(rect.bottom - origin.top + CARD_GAP_PX) } : { left: 0, top: 0 };
  }

  function draftRange(target: DraftTarget) {
    if (target.caret) return target.caret;
    const from = runRange(target.start.container, target.start.offset, target.start.offset);
    const to = runRange(target.end.container, target.end.offset, target.end.offset);
    if (from && to) from.setEnd(to.endContainer, to.endOffset);
    return from;
  }

  function describeDraft(target: DraftTarget): LinkDraftView {
    // A caret between elements has no rect of its own; its line's block stands in.
    const rect = rectNear(rectsOf(draftRange(target)), null) ?? target.start.container.getBoundingClientRect();
    return { editing: target.href !== null, href: target.href ?? "", needsText: Boolean(target.caret), ...shellPoint(rect) };
  }

  function describeCard(link: LinkSpan, clientY: number | null): LinkCardView {
    return { editable: options.isEditable(), href: link.href, ...shellPoint(rectNear(rectsOf(runRange(link.container, link.start, link.end)), clientY)) };
  }

  function caretY() {
    const range = editorRange();
    const rect = rectsOf(range)[0];
    return rect ? rect.top + rect.height / 2 : null;
  }

  function refresh() {
    if (!options.isRichMode()) {
      draft = null;
      pointerAnchor = null;
    }
    const pointerLink = pointerAnchor?.isConnected ? spanOfAnchor(pointerAnchor) : null;
    const caretLink = !draft && options.getEditorHasFocus() ? selectionLink() : null;
    cardSpan = draft ? null : pointerLink ?? caretLink;
    const draftView = draft ? describeDraft(draft) : null;
    options.highlights.set("link-draft", draft && !draft.caret ? [draftRange(draft)].filter((range): range is Range => Boolean(range)) : []);
    const next: LinkChromeSnapshot = {
      card: cardSpan ? describeCard(cardSpan, pointerLink ? pointerY : caretY()) : null,
      draft: draftView,
      width: Math.round(shell.clientWidth),
    };
    const key = JSON.stringify(next);
    if (key === snapshotKey) return;
    snapshotKey = key;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function scheduleRefresh() {
    options.scheduleFrame(refresh);
  }

  function linkSpanTarget(link: LinkSpan): DraftTarget {
    return {
      caret: null,
      end: { container: link.container, offset: link.end },
      href: link.href,
      start: { container: link.container, offset: link.start },
    };
  }

  function openDraft(target: DraftTarget) {
    draft = target;
    pointerAnchor = null;
    options.cancel(HOVER_TIMER);
    refresh();
    return true;
  }

  function startDraft() {
    const range = editorRange();
    if (!options.isRichMode() || !options.isEditable() || !range || closestCodeBlock(editor, range.commonAncestorContainer)) {
      return false;
    }
    const link = selectionLink(range);
    if (link) return openDraft(linkSpanTarget(link));

    const container = getInlineRunContainer(editor, range.startContainer);
    if (!container) return false;
    if (!range.collapsed) {
      const span = spanOfRange(editor, range);
      return span ? openDraft({ caret: null, end: span.end, href: null, start: span.start }) : false;
    }

    const caret = runOffsetOf(container, range.startContainer, range.startOffset);
    const word = wordAt(readRunText(container).text, caret);
    return openDraft(word
      ? { caret: null, end: { container, offset: word.end }, href: null, start: { container, offset: word.start } }
      : { caret: range.cloneRange(), end: { container, offset: caret }, href: null, start: { container, offset: caret } });
  }

  function editCard() {
    if (cardSpan && options.isEditable()) openDraft(linkSpanTarget(cardSpan));
  }

  function cancelDraft({ refocus = true }: { refocus?: boolean } = {}) {
    const target = draft;
    draft = null;
    if (target && refocus) {
      editor.focus({ preventScroll: true });
      if (target.caret && editor.contains(target.caret.startContainer)) {
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(target.caret);
      } else {
        selectRunPoints(target.start, target.end);
      }
    }
    refresh();
  }

  /** Put new text at a DOM caret, built from the marks at the caret and the text on either side of it. */
  function insertAtCaret(
    caret: Range,
    build: (atCaret: InlineMark[], neighbours: { after: TextLeaf | null; before: TextLeaf | null }) => { marks: InlineMark[]; text: string },
  ) {
    const container = getInlineRunContainer(editor, caret.startContainer);
    if (!container) return;
    const placeholder = createInlineSelectionMarker("caret");
    caret.insertNode(placeholder);
    const leaves = flattenInlineContent(container.childNodes);
    const at = leaves.findIndex((leaf) => leaf.type === "marker" && leaf.role === "caret");
    const neighbour = (step: 1 | -1) => {
      for (let index = at + step; index >= 0 && index < leaves.length; index += step) {
        const leaf = leaves[index]!;
        if (leaf.type === "break") return null;
        if (leaf.type === "text" && leaf.text) return leaf;
      }
      return null;
    };
    const { marks, text } = build(leaves[at]?.marks ?? [], { after: neighbour(1), before: neighbour(-1) });
    const inserted: InlineLeaf[] = [
      { type: "text", marks, text },
      { type: "marker", role: "caret", marks },
    ];
    rebuildInlineRunContainer(container, normalizeInlineLeaves(leaves.flatMap((leaf, index) => index === at ? inserted : [leaf])));
    const marker = container.querySelector<HTMLElement>('[data-inline-selection-marker="caret"]');
    if (marker) restoreCaretToMarker(marker);
  }

  function rewriteLinks(target: DraftTarget, href: string | null) {
    editor.focus({ preventScroll: true });
    selectRunPoints(target.start, target.end);
    options.prepareForEdit();
    const range = editorRange();
    const span = range ? spanOfRange(editor, range) : null;
    if (!span) return;
    options.runStructuralMutation(() => {
      rebuildRunSpan(span, (leaf) => ({ ...leaf, marks: withLink(leaf.marks, href) }));
    }, {
      afterSelectionRestore: () => selectRunPoints(span.end),
    });
  }

  function insertLink(caret: Range, text: string, href: string) {
    editor.focus({ preventScroll: true });
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(caret);
    options.prepareForEdit();
    options.runStructuralMutation(() => {
      insertAtCaret(caret, (atCaret) => ({ marks: withLink(atCaret, href), text }));
    });
  }

  function submitDraft(input: string, text = "") {
    const target = draft;
    if (!target) return false;
    const href = input.trim() ? toLinkDestination(input) : null;
    if (input.trim() && !href) return false;
    draft = null;
    if (target.caret) {
      if (href && editor.contains(target.caret.startContainer)) insertLink(target.caret, text.trim() || input.trim(), href);
      else cancelDraft();
    } else if (href !== target.href) {
      rewriteLinks(target, href);
    } else {
      cancelDraft();
      selectRunPoints(target.end);
    }
    refresh();
    return true;
  }

  function removeCardLink() {
    if (cardSpan && options.isEditable()) rewriteLinks(linkSpanTarget(cardSpan), null);
    refresh();
  }

  function openCard() {
    if (cardSpan) openHandler?.(cardSpan.href);
  }

  function revealHeading(slug: string) {
    const heading = Array.from(editor.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
      .find((candidate) => headingSlug(candidate.textContent ?? "") === slug.toLowerCase());
    if (!heading) return false;
    heading.scrollIntoView?.({ behavior: "smooth", block: "start" });
    editor.focus({ preventScroll: true });
    selectRunPoints({ container: heading, offset: 0 });
    return true;
  }

  /**
   * Text typed where a link starts or ends stays outside it, as browsers and word processors do: it keeps the marks at
   * the caret except a link the characters on both sides do not share.
   */
  function handleBeforeInput(event: InputEvent) {
    if (event.inputType !== "insertText" || !event.data || event.isComposing || !options.isRichMode()) return false;
    const range = editorRange();
    if (!range?.collapsed) return false;
    const container = getInlineRunContainer(editor, range.startContainer);
    if (!container) return false;
    const pieces = textPieces(container);
    const caret = runOffsetOf(container, range.startContainer, range.startOffset);
    const before = pieces.find((piece) => piece.start < caret && caret <= piece.end) ?? null;
    const after = pieces.find((piece) => piece.start <= caret && caret < piece.end) ?? null;
    const beforeLink = before?.href ?? null;
    const afterLink = after?.href ?? null;
    if (!(beforeLink && beforeLink !== afterLink) && !(!before && afterLink)) return false;

    event.preventDefault();
    const data = event.data;
    options.runStructuralMutation(() => {
      insertAtCaret(range, (atCaret, neighbours) => {
        // A space at a text edge would collapse; browsers type a no-break space there, which saves as a space.
        const edge = !neighbours.after || /^\s/u.test(neighbours.after.text) || /\s$/u.test(neighbours.before?.text ?? " ");
        return { marks: withLink(atCaret, null), text: data === " " && edge ? " " : data };
      });
    });
    return true;
  }

  function handleInput(event: Event) {
    if (!(event instanceof InputEvent) || event.inputType !== "insertText" || event.data !== ")" || !options.isRichMode()) return false;
    const range = editorRange();
    if (!range?.collapsed || closestCodeBlock(editor, range.startContainer)) return false;
    const container = getInlineRunContainer(editor, range.startContainer);
    if (!container) return false;
    const caret = runOffsetOf(container, range.startContainer, range.startOffset);
    const match = TYPED_LINK.exec(readRunText(container).text.slice(0, caret));
    const href = match ? toLinkDestination(match[3]!) : null;
    if (!match || !href) return false;

    const open = match.index + match[1]!.length;
    const labelStart = open + 1;
    const labelEnd = labelStart + match[2]!.length;
    const pieces = textPieces(container).filter((piece) => piece.start < caret && open < piece.end);
    if (pieces.some((piece) => piece.leaf.marks.some((mark) => mark.tag === "code"))) return false;

    let position = 0;
    const leaves = flattenInlineContent(container.childNodes).flatMap((leaf): InlineLeaf[] => {
      if (leaf.type !== "text") return [leaf];
      const start = position;
      position += leaf.text.length;
      const piece = (from: number, to: number, marks: InlineMark[]): InlineLeaf[] => {
        const text = leaf.text.slice(Math.max(from, start) - start, Math.min(to, position) - start);
        return text ? [{ ...leaf, marks, text }] : [];
      };
      return [
        ...piece(start, open, leaf.marks),
        ...piece(labelStart, labelEnd, withLink(leaf.marks, href)),
        ...piece(caret, position, leaf.marks),
      ];
    });
    rebuildInlineRunContainer(container, normalizeInlineLeaves(leaves));
    selectRunPoints({ container, offset: labelEnd - 1 });
    return true;
  }

  /** A click on a link edits it: the app's link navigation must not follow it. */
  function handleClick(event: MouseEvent) {
    const anchor = anchorOf(event.target);
    if (!anchor) return false;
    event.preventDefault();
    const href = event.ctrlKey || event.metaKey ? spanOfAnchor(anchor)?.href : null;
    if (!href || !openHandler) return false;
    openHandler(href);
    return true;
  }

  function showPointerCard() {
    options.cancel(LEAVE_TIMER);
    if (pointerAnchor === hoveredAnchor) return;
    pointerAnchor = hoveredAnchor;
    refresh();
  }

  function hidePointerCard() {
    if (cardHeld || !pointerAnchor) return;
    pointerAnchor = null;
    refresh();
  }

  function syncHoverFromPointer(target: EventTarget | null, clientY?: number) {
    const anchor = draft ? null : anchorOf(target);
    if (clientY !== undefined && anchor) pointerY = clientY;
    if (anchor === hoveredAnchor) return;
    hoveredAnchor = anchor;
    options.cancel(HOVER_TIMER);
    if (anchor) {
      options.cancel(LEAVE_TIMER);
      // Moving between links (or pieces of one) while a card is up swaps it at once.
      if (pointerAnchor) showPointerCard();
      else options.schedule(HOVER_TIMER, HOVER_DELAY_MS, showPointerCard);
    } else if (pointerAnchor) {
      options.schedule(LEAVE_TIMER, LEAVE_GRACE_MS, hidePointerCard);
    }
  }

  function setCardHeld(held: boolean) {
    cardHeld = held;
    if (held) options.cancel(LEAVE_TIMER);
    else if (!hoveredAnchor) options.schedule(LEAVE_TIMER, LEAVE_GRACE_MS, hidePointerCard);
  }

  return {
    cancelDraft,
    editCard,
    getSnapshot: () => snapshot,
    handleBeforeInput,
    handleClick,
    handleInput,
    isActive: () => options.isRichMode() && selectionLink() !== null,
    openCard,
    refresh,
    removeCardLink,
    revealHeading,
    scheduleRefresh,
    setCardHeld,
    setOpenHandler: (handler) => {
      openHandler = handler;
    },
    startDraft,
    submitDraft,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncHoverFromPointer,
  };
}

export default WorkbenchLinkController;
