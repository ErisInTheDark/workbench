/*
 * Exports:
 * - ReviewMode: "edit" changes text directly; "suggest" turns every change into a suggestion.
 * - SuggestionLayout: where original versions show: beside the text when the pane has room, else below it.
 * - WorkbenchSuggestionControllerOptions: editor surfaces and mutation hooks the controller drives.
 * - default WorkbenchSuggestionController: own suggestion groups: tag blocks as the user starts changing them, show each
 *   group's original in the layer, highlight the word diff, and resolve groups to one side.
 */

import { getSuggestionId, getSuggestionOld, nextSuggestionId, REVIEW_ATTRIBUTES } from "../markdown/review-markup";
import type { EditorHighlightScope } from "./editor-highlights";
import { diffWords, type TextSpan } from "./text-diff";

export type ReviewMode = "edit" | "suggest";

export interface SuggestionLayout {
  mode: "beside" | "below";
  /** Width of an original shown beside the text, in px. */
  width: number;
}

export interface WorkbenchSuggestionControllerOptions {
  editor: HTMLDivElement;
  getReviewMode: () => ReviewMode;
  highlights: EditorHighlightScope;
  isRichMode: () => boolean;
  layer: HTMLElement;
  renderMarkdown: (markdown: string) => HTMLElement;
  runStructuralMutation: (mutate: () => void, hooks?: { afterDomMutation?: () => void }) => void;
  scheduleFrame: (callback: () => void) => void;
  serializeBlocks: (blocks: readonly Element[]) => string;
}

interface WorkbenchSuggestionController {
  findMemberForPanel: (node: Node | null) => HTMLElement | null;
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

const PANEL_GAP_PX = 16;
const PANEL_ATTRIBUTE = "data-suggestion-panel";

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
  let layout: SuggestionLayout = { mode: "below", width: 0 };
  let editedGroupId: string | null = null;
  const paddedElements = new Set<HTMLElement>();
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

  function getPanel(id: string) {
    const existing = layer.querySelector<HTMLElement>(`[${PANEL_ATTRIBUTE}="${id}"]`);
    if (existing) return existing;

    const panel = document.createElement("div");
    panel.setAttribute(PANEL_ATTRIBUTE, id);
    const label = document.createElement("p");
    label.setAttribute(`${PANEL_ATTRIBUTE}-label`, "");
    label.textContent = "Original";
    const body = document.createElement("div");
    body.setAttribute(`${PANEL_ATTRIBUTE}-body`, "");
    panel.append(label, body);
    layer.append(panel);
    return panel;
  }

  function renderPanelBody(panel: HTMLElement, old: string) {
    const body = panel.querySelector<HTMLElement>(`[${PANEL_ATTRIBUTE}-body]`)!;
    if (renderedOld.get(body) === old) return body;
    renderedOld.set(body, old);
    body.replaceChildren();
    if (!old) {
      const empty = document.createElement("p");
      empty.setAttribute(`${PANEL_ATTRIBUTE}-empty`, "");
      empty.textContent = "Nothing here before";
      body.append(empty);
      return body;
    }
    body.append(...Array.from(options.renderMarkdown(old).childNodes));
    for (const element of Array.from(body.querySelectorAll("[contenteditable]"))) element.removeAttribute("contenteditable");
    return body;
  }

  function clearPadding() {
    for (const element of paddedElements) element.style.removeProperty("padding-bottom");
    paddedElements.clear();
  }

  function memberElements(group: SuggestionGroup) {
    return group.nodes.filter((node): node is HTMLElement => node instanceof HTMLElement && !(node instanceof HTMLBRElement));
  }

  function layoutGroup(group: SuggestionGroup) {
    const members = memberElements(group);
    const first = members[0];
    const last = members.at(-1);
    if (!first || !last) return null;

    for (const member of members) {
      member.toggleAttribute(REVIEW_ATTRIBUTES.suggestionEmpty, isEmptyMember(member));
    }

    const panel = getPanel(group.id);
    const body = renderPanelBody(panel, group.old);
    const top = first.offsetTop;
    const groupHeight = last.offsetTop + last.offsetHeight - top;
    panel.dataset.layout = layout.mode;
    if (layout.mode === "beside") {
      // The original's first line sits level with the suggestion's first line, its label above.
      panel.style.top = `${top - body.offsetTop}px`;
      panel.style.left = `${editor.offsetLeft - layout.width - PANEL_GAP_PX}px`;
      panel.style.width = `${layout.width}px`;
    } else {
      panel.style.top = `${top + groupHeight + PANEL_GAP_PX / 2}px`;
      panel.style.left = `${editor.offsetLeft}px`;
      panel.style.width = `${editor.offsetWidth}px`;
    }

    const extra = layout.mode === "beside" ? panel.offsetHeight - body.offsetTop - groupHeight : panel.offsetHeight + PANEL_GAP_PX;
    if (extra > 0) {
      last.style.paddingBottom = `${extra}px`;
      paddedElements.add(last);
    }
    return { body, members };
  }

  function refresh() {
    if (!options.isRichMode()) {
      layer.replaceChildren();
      options.highlights.set("suggest-del", []);
      options.highlights.set("suggest-ins", []);
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

    clearPadding();
    const liveIds = new Set(live.map((group) => group.id));
    for (const panel of Array.from(layer.querySelectorAll<HTMLElement>(`[${PANEL_ATTRIBUTE}]`))) {
      if (!liveIds.has(panel.getAttribute(PANEL_ATTRIBUTE)!)) panel.remove();
    }

    const deleted: Range[] = [];
    const inserted: Range[] = [];
    for (const group of live) {
      const placed = layoutGroup(group);
      if (!placed) continue;
      const before = readTextMap(group.old ? Array.from(placed.body.children) : []);
      const after = readTextMap(placed.members);
      const diff = diffWords(before.text, after.text);
      deleted.push(...spansToRanges(before, diff.deleted));
      inserted.push(...spansToRanges(after, diff.inserted));
    }
    options.highlights.set("suggest-del", deleted);
    options.highlights.set("suggest-ins", inserted);
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

  function findMemberForPanel(node: Node | null) {
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    const id = element?.closest(`[${PANEL_ATTRIBUTE}]`)?.getAttribute(PANEL_ATTRIBUTE);
    return id ? collectGroups().find((group) => group.id === id)?.nodes.find((member): member is HTMLElement => member instanceof HTMLElement) ?? null : null;
  }

  return {
    findMemberForPanel,
    prepareForEdit,
    refresh,
    resolve,
    scheduleRefresh,
    setLayout: (next) => {
      if (next.mode === layout.mode && next.width === layout.width) return;
      layout = next;
      scheduleRefresh();
    },
  };
}

export default WorkbenchSuggestionController;
