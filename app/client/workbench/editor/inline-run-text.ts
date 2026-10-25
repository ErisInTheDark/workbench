/*
 * Exports:
 * - RunPoint: a text offset inside one inline run container; it survives rebuilds that keep the run's text.
 * - RunSpan: the inline runs a range touches, their leaves split at its edges and flagged, and its edge points.
 * - TextLeaf: the text variant of an inline leaf.
 * - readRunText: a run's text and each text node's offset in it.
 * - runOffsetOf: the text offset of a DOM point in a run.
 * - runRange: a DOM range over a text span of one run.
 * - selectRunPoints: select between two run points.
 * - splitRunLeaves: a run's leaves with those inside a text span split off and flagged.
 * - spanOfRange: the runs a DOM range touches, split at its edges.
 * - spanWords: a span's flagged text leaves holding visible text.
 * - rebuildRunSpan: rewrite a span's flagged text leaves and write its runs back as canonical DOM.
 * - wordAt: the word around a text offset, if the offset touches one.
 */

import {
    flattenInlineContent,
    normalizeInlineLeaves,
    rebuildInlineRunContainer,
    type InlineLeaf,
} from "./inline-leaves";
import { getInlineRunContainersInRange } from "./inline-run-containers";

export interface RunPoint {
  container: HTMLElement;
  offset: number;
}

export type TextLeaf = Extract<InlineLeaf, { type: "text" }>;

export interface RunSpan {
  end: RunPoint;
  runs: Array<{ container: HTMLElement; leaves: Array<{ leaf: InlineLeaf; selected: boolean }> }>;
  start: RunPoint;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_'’-]/u;

export function readRunText(container: HTMLElement) {
  const nodes: Array<{ node: Text; start: number }> = [];
  let length = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push({ node, start: length });
    length += node.data.length;
  }
  return { nodes, text: nodes.map(({ node }) => node.data).join("") };
}

export function runOffsetOf(container: HTMLElement, node: Node, offset: number) {
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** At a node boundary, `preferEnd` picks the end of the node before over the start of the node after. */
function pointAt(nodes: ReturnType<typeof readRunText>["nodes"], offset: number, preferEnd: boolean) {
  const entry = preferEnd
    ? nodes.find(({ node, start }) => offset > start && offset <= start + node.data.length)
    : nodes.find(({ node, start }) => offset >= start && offset < start + node.data.length);
  const fallback = entry ?? nodes.at(-1);
  return fallback ? { node: fallback.node, offset: Math.min(offset - fallback.start, fallback.node.data.length) } : null;
}

export function runRange(container: HTMLElement, start: number, end: number) {
  const { nodes } = readRunText(container);
  const from = pointAt(nodes, start, false);
  const to = pointAt(nodes, end, true);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** A collapsed selection lands on the text before the point, so typing there joins that text. */
export function selectRunPoints(from: RunPoint, to: RunPoint = from) {
  const collapsed = from.container === to.container && from.offset === to.offset;
  const start = pointAt(readRunText(from.container).nodes, from.offset, collapsed);
  const end = collapsed ? start : pointAt(readRunText(to.container).nodes, to.offset, true);
  const selection = window.getSelection();
  if (!start || !end || !selection) return;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function splitRunLeaves(container: HTMLElement, start: number, end: number) {
  const leaves: Array<{ leaf: InlineLeaf; selected: boolean }> = [];
  let position = 0;
  for (const leaf of flattenInlineContent(container.childNodes)) {
    if (leaf.type !== "text") {
      leaves.push({ leaf, selected: false });
      continue;
    }
    const from = Math.max(start, position) - position;
    const to = Math.min(end, position + leaf.text.length) - position;
    position += leaf.text.length;
    if (to <= from) {
      leaves.push({ leaf, selected: false });
      continue;
    }
    const piece = (text: string, selected: boolean) => text ? [{ leaf: { ...leaf, text }, selected }] : [];
    leaves.push(...piece(leaf.text.slice(0, from), false), ...piece(leaf.text.slice(from, to), true),
      ...piece(leaf.text.slice(to), false));
  }
  return leaves;
}

export function spanOfRange(editor: HTMLElement, range: Range): RunSpan | null {
  const containers = getInlineRunContainersInRange(editor, range);
  const first = containers.find((container) => container.contains(range.startContainer)) ?? containers[0];
  const last = containers.findLast((container) => container.contains(range.endContainer)) ?? containers.at(-1);
  if (!first || !last) return null;
  const start = {
    container: first,
    offset: first.contains(range.startContainer) ? runOffsetOf(first, range.startContainer, range.startOffset) : 0,
  };
  const end = {
    container: last,
    offset: last.contains(range.endContainer) ? runOffsetOf(last, range.endContainer, range.endOffset) : readRunText(last).text.length,
  };
  return {
    end,
    runs: containers.map((container) => ({
      container,
      leaves: splitRunLeaves(container, container === first ? start.offset : 0, container === last ? end.offset : Infinity),
    })),
    start,
  };
}

/** Flagged text leaves with visible text: what an annotation over the span would cover. */
export function spanWords(span: RunSpan) {
  return span.runs.flatMap(({ leaves }) => leaves)
    .flatMap(({ leaf, selected }) => selected && leaf.type === "text" && /\S/u.test(leaf.text) ? [leaf] : []);
}

export function rebuildRunSpan(span: RunSpan, rewrite: (leaf: TextLeaf) => TextLeaf) {
  for (const { container, leaves } of span.runs) {
    rebuildInlineRunContainer(container, normalizeInlineLeaves(leaves.map(({ leaf, selected }) =>
      selected && leaf.type === "text" ? rewrite(leaf) : leaf)));
  }
}

export function wordAt(text: string, offset: number) {
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHARACTER.test(text[start - 1]!)) start -= 1;
  while (end < text.length && WORD_CHARACTER.test(text[end]!)) end += 1;
  return start === end ? null : { end, start };
}
