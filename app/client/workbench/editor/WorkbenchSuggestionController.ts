/*
 * Exports:
 * - ReviewMode: "edit" changes text directly; "suggest" turns every change into a suggestion.
 * - SuggestionLayout: where suggestion rows place their original and suggested columns, outside the text column.
 * - SuggestionRowBounds: vertical extent of a suggestion row, which comment cards keep clear of.
 * - WorkbenchSuggestionControllerOptions: editor surfaces and mutation hooks the controller drives.
 * - default WorkbenchSuggestionController: own suggestion groups: tag blocks as the user starts changing them, lay each
 *   group out as a row with its editable original and keep-side actions, highlight the word diff, and resolve groups to
 *   one side.
 */

import { getSuggestionId, getSuggestionOld, nextSuggestionId, REVIEW_ATTRIBUTES } from "../markdown/review-markup";
import type { EditorHighlightScope } from "./editor-highlights";
import { diffWords, type TextSpan } from "./text-diff";

export type ReviewMode = "edit" | "suggest";

/**
 * Where a suggestion row's two columns sit, in px from the editor shell's left edge. The row shows through a viewport
 * (the visible part of the pane); a row wider than its viewport scrolls sideways.
 */
export interface SuggestionLayout {
  newLeft: number;
  oldLeft: number;
  viewportLeft: number;
  viewportWidth: number;
  width: number;
}

/** Vertical extent of a suggestion row in editor-shell px, which comment cards must stay clear of. */
export interface SuggestionRowBounds {
  bottom: number;
  top: number;
}

export interface WorkbenchSuggestionControllerOptions {
  editor: HTMLDivElement;
  getReviewMode: () => ReviewMode;
  highlights: EditorHighlightScope;
  isRichMode: () => boolean;
  layer: HTMLElement;
  /** Rows moved, resized or scrolled; things placed around them need placing again. */
  onLayoutChanged: () => void;
  /** Keys pressed while editing an original column, so editor shortcuts such as undo still reach the editor. */
  onOriginalKeyDown: (event: KeyboardEvent) => void;
  renderMarkdown: (markdown: string) => HTMLElement;
  runStructuralMutation: (mutate: () => void, hooks?: { afterDomMutation?: () => void }) => void;
  scheduleFrame: (callback: () => void) => void;
  serializeBlocks: (blocks: readonly Element[]) => string;
}

interface WorkbenchSuggestionController {
  getRows: () => readonly SuggestionRowBounds[];
  prepareForEdit: () => void;
  refresh: () => void;
  resolve: (id: string, action: "accept" | "reject") => void;
  scheduleRefresh: () => void;
  setLayout: (layout: SuggestionLayout) => void;
}

interface SuggestionGroup {
  id: string;
  /** Every top-level node from the first tagged member to the last. */
  nodes: ChildNode[];
  old: string;
}

interface TextMap {
  nodes: Array<{ node: Text; start: number }>;
  text: string;
}

const ROW_ATTRIBUTE = "data-suggestion-row";
/** Room above a row's first block for the row's header of labels and actions. */
const ROW_HEAD_PX = 44;
const ROW_PAD_PX = 12;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** Matches Tailwind's `md` breakpoint, below which the row band is styled solid. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function createCheckIcon() {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  for (const [name, value] of Object.entries({
    "aria-hidden": "true", fill: "none", height: "16", stroke: "currentColor", "stroke-linecap": "round",
    "stroke-linejoin": "round", "stroke-width": "2", viewBox: "0 0 24 24", width: "16",
  })) svg.setAttribute(name, value);
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M20 6 9 17l-5-5");
  svg.append(path);
  return svg;
}

function isBreakNode(node: Node) {
  return node instanceof HTMLBRElement || (node instanceof Text && !(node.textContent ?? "").trim());
}

/** Text of whole blocks, each starting on its own line so words never join across blocks. */
function readTextMap(roots: readonly Node[]): TextMap {
  const map: TextMap = { nodes: [], text: "" };
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (map.text && !started) map.text += "\n";
      started = true;
      map.nodes.push({ node: node as Text, start: map.text.length });
      map.text += (node as Text).data;
    }
  }
  return map;
}

/** A member with no content left is the new side of a deletion. */
function isEmptyMember(node: Node) {
  return node instanceof HTMLParagraphElement && !(node.textContent ?? "").trim() && !node.querySelector("[data-comment-thread]");
}

function locate(map: TextMap, offset: number, preferEnd: boolean) {
  for (let index = map.nodes.length - 1; index >= 0; index -= 1) {
    const entry = map.nodes[index]!;
    if (entry.start < offset || (entry.start === offset && !preferEnd)) {
      return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.length) };
    }
  }
  return null;
}

function spansToRanges(map: TextMap, spans: readonly TextSpan[]) {
  return spans.flatMap((span) => {
    const start = locate(map, span.start, false);
    const end = locate(map, span.end, true);
    if (!start || !end) return [];
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return [range];
  });
}

function WorkbenchSuggestionController(options: WorkbenchSuggestionControllerOptions): WorkbenchSuggestionController {
  const { editor, layer } = options;
  let layout: SuggestionLayout = { newLeft: 0, oldLeft: 0, viewportLeft: 0, viewportWidth: 0, width: 0 };
  let editedGroupId: string | null = null;
  /** How far each scrollable row is scrolled sideways; rows start showing their suggested side. */
  const rowScroll = new Map<string, number>();
  let rows: SuggestionRowBounds[] = [];
  let rowsKey = "";
  const styledMembers = new Set<HTMLElement>();
  const renderedOld = new WeakMap<HTMLElement, string>();

  function topLevelChildren() {
    return Array.from(editor.childNodes);
  }

  function collectGroups(): SuggestionGroup[] {
    const children = topLevelChildren();
    const groups: SuggestionGroup[] = [];
    for (let index = 0; index < children.length; index += 1) {
      const id = getSuggestionId(children[index]);
      if (id === null) continue;
      let end = index;
      for (let candidate = index + 1; candidate < children.length; candidate += 1) {
        if (getSuggestionId(children[candidate]) === id) end = candidate;
      }
      groups.push({ id, nodes: children.slice(index, end + 1), old: getSuggestionOld(children[index] as HTMLElement) });
      index = end;
    }
    return groups;
  }

  function getSelectionRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
      return null;
    }
    return selection.getRangeAt(0);
  }

  function touchedChildren(range: Range) {
    return topLevelChildren().filter((child) => child.contains(range.startContainer) || range.intersectsNode(child));
  }

  function tag(nodes: readonly ChildNode[], id: string, old: string) {
    for (const node of nodes) {
      if (node instanceof HTMLElement && !(node instanceof HTMLBRElement)) {
        node.setAttribute(REVIEW_ATTRIBUTES.suggestion, id);
        node.setAttribute(REVIEW_ATTRIBUTES.suggestionOld, old);
      }
    }
  }

  function untag(nodes: readonly ChildNode[]) {
    for (const node of nodes) {
      if (node instanceof HTMLElement) {
        node.removeAttribute(REVIEW_ATTRIBUTES.suggestion);
        node.removeAttribute(REVIEW_ATTRIBUTES.suggestionOld);
        node.removeAttribute(REVIEW_ATTRIBUTES.suggestionEmpty);
      }
    }
  }

  /** The original markdown of a run of top-level nodes; members of existing suggestions contribute their own original. */
  function readOriginal(nodes: readonly ChildNode[]) {
    const originals: Element[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      const id = getSuggestionId(node);
      if (id === null) {
        if (node instanceof Element) originals.push(node);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      originals.push(...Array.from(options.renderMarkdown(getSuggestionOld(node as HTMLElement)).children));
    }
    return options.serializeBlocks(originals);
  }

  function prepareForEdit() {
    if (options.getReviewMode() !== "suggest" || !options.isRichMode()) {
      return;
    }

    const range = getSelectionRange();
    const touched = range ? touchedChildren(range).filter((node) => !isBreakNode(node)) : [];
    if (!touched.length) {
      return;
    }

    const ids = new Set(touched.map(getSuggestionId));
    const onlyId = ids.size === 1 ? [...ids][0] : undefined;
    if (onlyId) {
      editedGroupId = onlyId;
      rowScroll.delete(onlyId);
      return;
    }

    const children = topLevelChildren();
    let first = children.indexOf(touched[0]!);
    let last = children.indexOf(touched.at(-1)!);
    for (const group of collectGroups()) {
      if (!ids.has(group.id)) continue;
      first = Math.min(first, children.indexOf(group.nodes[0]!));
      last = Math.max(last, children.indexOf(group.nodes.at(-1)!));
    }

    const members = children.slice(first, last + 1);
    const id = nextSuggestionId();
    tag(members, id, readOriginal(members));
    editedGroupId = id;
  }

  /** Blocks a structural edit split off the group being edited, next to it and holding the caret, rejoin it. */
  function healEditedGroup(groups: readonly SuggestionGroup[]) {
    const group = groups.find((candidate) => candidate.id === editedGroupId);
    const range = getSelectionRange();
    if (!group || !range || options.getReviewMode() !== "suggest") return;

    const caretBlock = touchedChildren(range).find((node) => !isBreakNode(node));
    if (!(caretBlock instanceof HTMLElement) || getSuggestionId(caretBlock) !== null) return;

    const neighbours = (node: Node | null, step: "previousSibling" | "nextSibling") => {
      let current = node?.[step] ?? null;
      while (current && isBreakNode(current)) current = current[step];
      return current;
    };
    if (neighbours(caretBlock, "previousSibling") === group.nodes.at(-1) || neighbours(caretBlock, "nextSibling") === group.nodes[0]) {
      tag([caretBlock], group.id, group.old);
    }
  }

  function createElement(attribute: string, tag: keyof HTMLElementTagNameMap = "div", text = "") {
    const element = document.createElement(tag);
    element.setAttribute(attribute, "");
    if (text) element.textContent = text;
    return element;
  }

  function createAction(id: string, action: "accept" | "reject", label: string) {
    const button = createElement(`${ROW_ATTRIBUTE}-action`, "button") as HTMLButtonElement;
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.dataset.suggestionAction = action;
    button.append(createCheckIcon());
    // A press keeps focus and selection in the editor; resolving places the caret itself.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => resolve(id, action));
    return button;
  }

  /**
   * One row per suggestion in the layer: a band, a sideways scroller (used when the row is wider than its viewport),
   * the editable original, and a header over each column. Headers paint above the scroller so their buttons stay live.
   */
  function getRow(id: string) {
    const existing = Array.from(layer.children).find((child) => child.getAttribute(ROW_ATTRIBUTE) === id);
    if (existing instanceof HTMLElement) return existing;

    const row = createElement(ROW_ATTRIBUTE);
    row.setAttribute(ROW_ATTRIBUTE, id);
    const scroller = createElement(`${ROW_ATTRIBUTE}-scroller`);
    scroller.append(createElement(`${ROW_ATTRIBUTE}-scroll-width`));
    scroller.addEventListener("scroll", () => {
      rowScroll.set(id, scroller.scrollLeft);
      applyRowScroll(id);
      options.onLayoutChanged();
    }, { passive: true });
    const oldHead = createElement(`${ROW_ATTRIBUTE}-head`);
    oldHead.dataset.side = "old";
    oldHead.append(createElement(`${ROW_ATTRIBUTE}-label`, "span", "Original"), createAction(id, "reject", "Keep original"));
    const newHead = createElement(`${ROW_ATTRIBUTE}-head`);
    newHead.dataset.side = "new";
    newHead.append(createElement(`${ROW_ATTRIBUTE}-label`, "span", "Suggested"), createAction(id, "accept", "Keep suggestion"));
    const oldBody = createElement(`${ROW_ATTRIBUTE}-old`) as HTMLDivElement;
    oldBody.contentEditable = "true";
    oldBody.setAttribute("aria-label", "Original");
    oldBody.addEventListener("input", () => commitOriginal(id, oldBody));
    oldBody.addEventListener("keydown", (event) => options.onOriginalKeyDown(event));
    row.append(createElement(`${ROW_ATTRIBUTE}-band`), scroller, oldBody, oldHead, newHead);
    layer.append(row);
    return row;
  }

  function part(row: HTMLElement, name: "band" | "old" | "head" | "scroller" | "scroll-width", side?: "new" | "old") {
    return row.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}-${name}]${side ? `[data-side="${side}"]` : ""}`)!;
  }

  /** Elements that move together when a row scrolls sideways, their unscrolled left edge, and how far it can scroll. */
  const scrollTargets = new Map<string, { elements: Array<{ element: HTMLElement; left: number }>; max: number }>();

  /** Scrolled columns move sideways and are cut off at the viewport's edges. */
  function applyRowScroll(id: string) {
    const targets = scrollTargets.get(id);
    if (!targets) return;
    const offset = -Math.min(targets.max, rowScroll.get(id) ?? targets.max);
    const viewportRight = layout.viewportLeft + layout.viewportWidth;
    for (const { element, left } of targets.elements) {
      if (!targets.max) {
        element.style.removeProperty("transform");
        element.style.removeProperty("clip-path");
        continue;
      }
      const shownLeft = left + offset;
      const clipLeft = Math.max(0, layout.viewportLeft - shownLeft);
      const clipRight = Math.max(0, shownLeft + layout.width - viewportRight);
      element.style.transform = `translateX(${offset}px)`;
      element.style.clipPath = `inset(-1em ${clipRight}px -1em ${clipLeft}px)`;
    }
  }

  /** The original column is editable document too: what is typed there becomes the suggestion's original markdown. */
  function renderOld(body: HTMLElement, old: string) {
    body.toggleAttribute(`${ROW_ATTRIBUTE}-empty`, !old);
    // The column already shows what it was edited into; rendering it again would lose the caret.
    if (renderedOld.get(body) === old) return;
    renderedOld.set(body, old);
    body.replaceChildren();
    if (!old) {
      const paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      body.append(paragraph);
      return;
    }
    body.append(...Array.from(options.renderMarkdown(old).childNodes));
  }

  function commitOriginal(id: string, body: HTMLElement) {
    const group = collectGroups().find((candidate) => candidate.id === id);
    if (!group) return;
    const old = (body.textContent ?? "").trim() || body.querySelector("[data-comment-thread]")
      ? options.serializeBlocks(Array.from(body.children))
      : "";
    body.toggleAttribute(`${ROW_ATTRIBUTE}-empty`, !old);
    if (old === group.old) return;
    renderedOld.set(body, old);
    options.runStructuralMutation(() => tag(group.nodes, id, old));
  }

  function place(element: HTMLElement, left: number, top: number, width: number) {
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
  }

  function clearMemberStyles() {
    for (const element of styledMembers) {
      element.style.removeProperty("margin-top");
      element.style.removeProperty("padding-bottom");
      element.style.removeProperty("transform");
      element.style.removeProperty("clip-path");
    }
    styledMembers.clear();
  }

  function memberElements(group: SuggestionGroup) {
    return group.nodes.filter((node): node is HTMLElement => node instanceof HTMLElement && !(node instanceof HTMLBRElement));
  }

  /**
   * The suggestion's own blocks stay in the document and hold the caret; CSS moves them into the row's right column.
   * The row header sits in space opened above them, and the shorter side is padded to the taller. A row wider than
   * its viewport scrolls both columns together.
   */
  function layoutGroup(group: SuggestionGroup) {
    const members = memberElements(group);
    const first = members[0];
    const last = members.at(-1);
    if (!first || !last) return null;

    for (const member of members) {
      member.toggleAttribute(REVIEW_ATTRIBUTES.suggestionEmpty, isEmptyMember(member));
      styledMembers.add(member);
    }
    first.style.marginTop = `${ROW_HEAD_PX + ROW_PAD_PX}px`;

    const row = getRow(group.id);
    const oldBody = part(row, "old");
    renderOld(oldBody, group.old);
    const top = first.offsetTop;
    const newBottom = last.offsetTop + last.offsetHeight;
    const { newLeft, oldLeft, viewportLeft, viewportWidth, width } = layout;
    const oldHead = part(row, "head", "old");
    const newHead = part(row, "head", "new");
    place(oldBody, oldLeft, top, width);
    place(newHead, newLeft, top - ROW_HEAD_PX, width);
    place(oldHead, oldLeft, top - ROW_HEAD_PX, width);

    const contentBottom = Math.max(newBottom, top + oldBody.offsetHeight);
    if (contentBottom > newBottom) {
      last.style.paddingBottom = `${contentBottom - newBottom}px`;
    }

    const bounds = { top: top - ROW_HEAD_PX - ROW_PAD_PX / 2, bottom: contentBottom + ROW_PAD_PX };
    // The band spans the editor's pane, fading at its ends; on mobile it runs solid across the whole screen instead.
    const fillsScreen = typeof window.matchMedia === "function" && window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    const paneEdges = ((fillsScreen ? layer.closest("main") : null) ?? layer.parentElement?.parentElement)?.getBoundingClientRect();
    const layerLeft = layer.getBoundingClientRect().left;
    const band = part(row, "band");
    place(
      band,
      paneEdges ? paneEdges.left - layerLeft : viewportLeft,
      bounds.top,
      paneEdges ? paneEdges.width : viewportWidth,
    );
    band.style.height = `${bounds.bottom - bounds.top}px`;

    const rowLeft = Math.min(newLeft, oldLeft);
    const rowSpan = Math.max(newLeft, oldLeft) + width - rowLeft;
    const max = Math.max(0, Math.round(rowSpan - viewportWidth));
    const scroller = part(row, "scroller");
    scroller.hidden = max === 0;
    place(scroller, viewportLeft, top - ROW_HEAD_PX, viewportWidth);
    part(row, "scroll-width").style.width = `${rowSpan}px`;
    scrollTargets.set(group.id, {
      elements: [
        ...members.map((element) => ({ element, left: newLeft })),
        { element: newHead, left: newLeft },
        { element: oldBody, left: oldLeft },
        { element: oldHead, left: oldLeft },
      ],
      max,
    });
    if (max > 0 && scroller.scrollLeft !== Math.min(max, rowScroll.get(group.id) ?? max)) {
      scroller.scrollLeft = Math.min(max, rowScroll.get(group.id) ?? max);
    }
    applyRowScroll(group.id);
    return { body: oldBody, bounds, members };
  }

  function applyLayoutVariables() {
    // Originals render at the editor's (zoomable) text size.
    layer.style.fontSize = editor.style.fontSize;
    // Until the pane is measured, suggestion blocks stay in the text column.
    editor.toggleAttribute("data-suggest-split", layout.width > 0);
    editor.style.setProperty("--suggest-new-offset", `${layout.newLeft - editor.offsetLeft}px`);
    editor.style.setProperty("--suggest-col-width", `${layout.width}px`);
  }

  /** Rows move their members, so anything measured before this pass (gutter markers) is stale whenever rows exist. */
  function publishRows(next: SuggestionRowBounds[]) {
    const key = JSON.stringify(next);
    if (key === rowsKey && !next.length) return;
    rowsKey = key;
    rows = next;
    options.onLayoutChanged();
  }

  function refresh() {
    if (!options.isRichMode()) {
      layer.replaceChildren();
      options.highlights.set("suggest-del", []);
      options.highlights.set("suggest-ins", []);
      publishRows([]);
      return;
    }

    let groups = collectGroups();
    healEditedGroup(groups);
    groups = collectGroups();

    const editingId = editedGroupId;
    const live: SuggestionGroup[] = [];
    for (const group of groups) {
      const next = options.serializeBlocks(memberElements(group));
      if (next === group.old) untag(group.nodes);
      else live.push(group);
    }
    if (editingId && !live.some((group) => group.id === editingId)) editedGroupId = null;

    clearMemberStyles();
    applyLayoutVariables();
    const liveIds = new Set(live.map((group) => group.id));
    for (const row of Array.from(layer.children)) {
      const id = row.getAttribute(ROW_ATTRIBUTE) ?? "";
      if (liveIds.has(id)) continue;
      row.remove();
      scrollTargets.delete(id);
      rowScroll.delete(id);
    }

    const deleted: Range[] = [];
    const inserted: Range[] = [];
    const nextRows: SuggestionRowBounds[] = [];
    for (const group of live) {
      const placed = layoutGroup(group);
      if (!placed) continue;
      nextRows.push(placed.bounds);
      const before = readTextMap(group.old ? Array.from(placed.body.children) : []);
      const after = readTextMap(placed.members);
      const diff = diffWords(before.text, after.text);
      deleted.push(...spansToRanges(before, diff.deleted));
      inserted.push(...spansToRanges(after, diff.inserted));
    }
    options.highlights.set("suggest-del", deleted);
    options.highlights.set("suggest-ins", inserted);
    publishRows(nextRows);
  }

  function scheduleRefresh() {
    options.scheduleFrame(refresh);
  }

  function resolve(id: string, action: "accept" | "reject") {
    const group = collectGroups().find((candidate) => candidate.id === id);
    if (!group) return;

    let caretTarget: Node | null = null;
    options.runStructuralMutation(() => {
      if (action === "accept") {
        untag(group.nodes);
        const kept = group.nodes.filter((node) => !isEmptyMember(node));
        for (const node of group.nodes) if (!kept.includes(node)) node.remove();
        caretTarget = kept.find((node) => node instanceof HTMLElement) ?? kept[0]?.nextSibling ?? null;
      } else {
        const replacement = group.old ? Array.from(options.renderMarkdown(group.old).childNodes) : [];
        group.nodes[0]!.before(...replacement);
        for (const node of group.nodes) node.remove();
        caretTarget = replacement.find((node) => node instanceof HTMLElement) ?? null;
      }

      if (!editor.childNodes.length) {
        const paragraph = document.createElement("p");
        paragraph.append(document.createElement("br"));
        editor.append(paragraph);
        caretTarget = paragraph;
      }
    }, {
      afterDomMutation: () => {
        const selection = window.getSelection();
        if (!selection || !caretTarget || !editor.contains(caretTarget)) return;
        const range = document.createRange();
        range.selectNodeContents(caretTarget);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      },
    });
    if (editedGroupId === id) editedGroupId = null;
    refresh();
  }

  return {
    getRows: () => rows,
    prepareForEdit,
    refresh,
    resolve,
    scheduleRefresh,
    setLayout: (next) => {
      if (JSON.stringify(next) === JSON.stringify(layout)) return;
      layout = next;
      options.scheduleFrame(() => {
        refresh();
        options.onLayoutChanged();
      });
    },
  };
}

export default WorkbenchSuggestionController;
