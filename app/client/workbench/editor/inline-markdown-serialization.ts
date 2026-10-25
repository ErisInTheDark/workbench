/*
 * Exports:
 * - serializeInlineNodes: write inline DOM as markdown in a file's style, nesting marks the way they run instead of
 *   re-wrapping every leaf.
 */

import { formatCommentThread } from "../markdown/comment-markdown";
import { escapeMarkdownText } from "../markdown/markdown-escape";
import { DEFAULT_MARKDOWN_STYLE, type MarkdownStyle } from "../markdown/markdown-style";
import { escapeAttribute, readThreadComments, REVIEW_ATTRIBUTES } from "../markdown/review-markup";
import {
    areInlineMarkListsEqual,
    areInlineMarksEqual,
    flattenInlineContent,
    normalizeInlineLeavesForSerialization,
    normalizeInlineMarks,
    type InlineLeaf,
    type InlineMark,
} from "./inline-leaves";

type WrittenLeaf = Exclude<InlineLeaf, { type: "marker" }>;

interface OpenMark {
  close: string;
  delimiter: string;
  /** Index of the first leaf after the mark's run. */
  end: number;
  mark: InlineMark;
}

/** Marks whose markdown may run across the whitespace and threads between two equally marked words. */
const GAP_SPANNING_MARKS = new Set<InlineMark["tag"]>(["a", "strong", "em", "mark", "u"]);
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function hasMark(marks: readonly InlineMark[], mark: InlineMark) {
  return marks.some((candidate) => areInlineMarksEqual(candidate, mark));
}

function isCodeTextLeaf(leaf: WrittenLeaf) {
  return leaf.type === "text" && leaf.marks.some((mark) => mark.tag === "code");
}

function getNeighbourCharacter(leaves: readonly WrittenLeaf[], fromIndex: number, direction: 1 | -1) {
  for (let index = fromIndex + direction; index >= 0 && index < leaves.length; index += direction) {
    const leaf = leaves[index]!;
    if (leaf.type === "break") {
      return null;
    }
    if (leaf.type === "text" && leaf.text) {
      return direction === 1 ? leaf.text[0]! : leaf.text.at(-1)!;
    }
  }

  return null;
}

/**
 * Browsers type nbsp at the end of a text run, where a plain space might collapse. A lone nbsp on a run edge between
 * visible characters renders like a space, so it is written as one; nbsp inside a run is kept and serializes as `&nbsp;`.
 */
function resolveNonBreakingSpaces(leaves: WrittenLeaf[]) {
  return leaves.map((leaf, leafIndex): WrittenLeaf => {
    if (leaf.type !== "text" || isCodeTextLeaf(leaf) || !leaf.text.includes(" ")) {
      return leaf;
    }

    const characters = [...leaf.text];
    const text = characters.map((character, index) => {
      const onRunEdge = index === 0 || index === characters.length - 1;
      if (character !== " " || !onRunEdge) {
        return character;
      }

      const previous = index > 0 ? characters[index - 1] : getNeighbourCharacter(leaves, leafIndex, -1);
      const next = index < characters.length - 1 ? characters[index + 1] : getNeighbourCharacter(leaves, leafIndex, 1);
      return previous && next && !/\s/u.test(previous) && !/\s/u.test(next) ? " " : character;
    }).join("");
    return { ...leaf, text };
  });
}

/**
 * Whitespace and threads between two words sharing a mark stay inside it, so `**a *b* c**` keeps one strong run.
 * Whitespace only joins neighbours with different marks: between equally marked words it would merge two runs into one.
 */
function spanMarksAcrossGaps(leaves: WrittenLeaf[]) {
  return leaves.map((leaf, index): WrittenLeaf => {
    const previous = leaves[index - 1];
    const next = leaves[index + 1];
    if (previous?.type !== "text" || next?.type !== "text") {
      return leaf;
    }

    const isWhitespaceGap = leaf.type === "text" && !isCodeTextLeaf(leaf) && /^[ \t ]+$/u.test(leaf.text);
    const isGap = leaf.type === "atom" || (isWhitespaceGap && !areInlineMarkListsEqual(previous.marks, next.marks));
    if (!isGap) {
      return leaf;
    }

    const shared = previous.marks.filter((mark) => GAP_SPANNING_MARKS.has(mark.tag) && hasMark(next.marks, mark));
    const added = shared.filter((mark) => !hasMark(leaf.marks, mark));
    return added.length ? { ...leaf, marks: normalizeInlineMarks([...leaf.marks, ...added]) } : leaf;
  });
}

function formatInlineCodeSpanMarkdown(content: string) {
  if (!content) {
    return "``  ``";
  }

  const fenceLength = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length)) + 1;
  const fence = "`".repeat(fenceLength);
  return /^[ `]|[ `]$/.test(content) ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

function writeLeafContent(leaf: WrittenLeaf) {
  if (leaf.type === "break") {
    return "\n";
  }

  if (leaf.type === "atom") {
    return formatCommentThread(readThreadComments(leaf.element));
  }

  if (isCodeTextLeaf(leaf)) {
    return formatInlineCodeSpanMarkdown(leaf.text);
  }

  return escapeMarkdownText(leaf.text).replaceAll(" ", "&nbsp;");
}

function otherEmphasisCharacter(character: string) {
  return character === "*" ? "_" : "*";
}

/**
 * `_` delimiters cannot open or close against word characters, so they fall back to `*` there; a mark opening or
 * closing together with an outer one touches that outer delimiter instead. Nested strong and emphasis use different
 * characters, which keeps `***` runs from becoming ambiguous.
 */
function chooseDelimiter(
  mark: InlineMark,
  leaves: readonly WrittenLeaf[],
  start: number,
  end: number,
  open: readonly OpenMark[],
  opensWithOuter: boolean,
  style: MarkdownStyle,
): Omit<OpenMark, "end" | "mark"> {
  switch (mark.tag) {
    case "mark":
    case "del":
    case "ins":
      return { close: `</${mark.tag}>`, delimiter: `<${mark.tag}>` };
    case "a":
      return { close: `](${mark.href})`, delimiter: "[" };
    case "u":
      return { close: "</u>", delimiter: `<u ${REVIEW_ATTRIBUTES.markTag}="${escapeAttribute(mark.name)}">` };
    case "code":
      return { close: "", delimiter: "" };
    case "strong":
    case "em": {
      const closesWithOuter = open.some((entry) => entry.end === end);
      const before = opensWithOuter ? null : getNeighbourCharacter(leaves, start, -1);
      const after = closesWithOuter ? null : getNeighbourCharacter(leaves, end - 1, 1);
      const touchesWord = WORD_CHARACTER.test(before ?? "") || WORD_CHARACTER.test(after ?? "");
      const partner = mark.tag === "strong" ? "em" : "strong";
      const enclosing = [...open].reverse().find((entry) => entry.mark.tag === partner);
      const preferred = (mark.tag === "strong" ? style.strong : style.emphasis)[0]!;
      const holdsPartner = leaves.slice(start, end).some((leaf) => leaf.marks.some((candidate) => candidate.tag === partner));
      const partnerCharacter = enclosing?.delimiter[0]
        ?? (holdsPartner ? (mark.tag === "strong" ? style.emphasis : style.strong)[0] : undefined);
      let character = partnerCharacter === preferred ? otherEmphasisCharacter(preferred) : preferred;
      if (touchesWord) {
        character = "*";
      }
      const delimiter = mark.tag === "strong" ? character.repeat(2) : character;
      return { close: delimiter, delimiter };
    }
  }
}

function runEnd(leaves: readonly WrittenLeaf[], start: number, mark: InlineMark) {
  let end = start;
  while (end < leaves.length && hasMark(leaves[end]!.marks, mark)) end += 1;
  return end;
}

function writeLeaves(leaves: readonly WrittenLeaf[], style: MarkdownStyle) {
  let markdown = "";
  const open: OpenMark[] = [];
  const closeFrom = (depth: number) => {
    while (open.length > depth) markdown += open.pop()!.close;
  };

  leaves.forEach((leaf, index) => {
    const marks = leaf.marks.filter((mark) => mark.tag !== "code");
    let kept = 0;
    while (kept < open.length && hasMark(marks, open[kept]!.mark)) kept += 1;
    closeFrom(kept);

    const opening = marks
      .filter((mark) => !open.some((entry) => areInlineMarksEqual(entry.mark, mark)))
      .map((mark, order) => ({ end: runEnd(leaves, index, mark), mark, order }))
      .sort((left, right) => right.end - left.end || left.order - right.order);
    opening.forEach(({ end, mark }, position) => {
      const delimiter = chooseDelimiter(mark, leaves, index, end, open, position > 0, style);
      markdown += delimiter.delimiter;
      open.push({ ...delimiter, end, mark });
    });

    markdown += writeLeafContent(leaf);
  });

  closeFrom(0);
  return markdown;
}

export function serializeInlineNodes(nodes: ArrayLike<Node>, style: MarkdownStyle = DEFAULT_MARKDOWN_STYLE) {
  const leaves = normalizeInlineLeavesForSerialization(flattenInlineContent(Array.from(nodes)))
    .filter((leaf): leaf is WrittenLeaf => leaf.type !== "marker");
  return writeLeaves(spanMarksAcrossGaps(resolveNonBreakingSpaces(leaves)), style);
}
