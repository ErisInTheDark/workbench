/*
 * Exports:
 * - ThreadReasoningStepReference: identify one visible reasoning section without hiding its sibling steps. Keywords: reasoning, section, identity.
 * - ThreadReasoningStep: renderer-ready reasoning title, description, Markdown, and source identity. Keywords: reasoning, display, title, description.
 * - getThreadReasoningSteps: project reasoning items into ordered visible steps. Keywords: reasoning, projection, order.
 * - projectThreadReasoningMarkdown: derive one reasoning title and body from presented Markdown. Keywords: reasoning, presentation, title.
 * - getLatestReasoningSentence: the first sentence of live reasoning's newest prose paragraph, skipping fenced code. Keywords: reasoning, live, sentence.
 * - omitThreadReasoningStep: remove one exact live step while preserving earlier disclosure content. Keywords: reasoning, disclosure, filter.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

export interface ThreadReasoningStepReference {
  itemId: string;
  sectionIndex: number;
  source: "content" | "summary";
}

export interface ThreadReasoningStep extends ThreadReasoningStepReference {
  body: string | null;
  markdown: string;
  title: string;
}

function cleanReasoningTitleLine(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^\[(.+)\]$/u, "$1")
    .replace(/:$/u, "")
    .trim() || null;
}

function reasoningSectionBody(value: string) {
  const lines = value.split(/\r?\n/u);
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex >= 0) lines.splice(titleIndex, 1);
  return lines.join("\n").trim() || null;
}

export function projectThreadReasoningMarkdown(markdown: string) {
  const value = markdown.trim();
  return {
    body: reasoningSectionBody(value),
    title: cleanReasoningTitleLine(value) ?? "Step",
  };
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const TITLE_LINE = /^\s{0,3}(?:#{1,6}\s|\*\*[^*]+\*\*:?\s*$)/u;
const BLOCK_MARKER = /^\s{0,3}(?:>\s?|[-*+]\s+|\d+[.)]\s+)+/u;

/**
 * Prose paragraphs in order. Fenced code (an unclosed fence runs to the end, as it does mid-stream) and title lines
 * separate paragraphs and never join one, so blank lines inside code cannot split prose around it.
 */
function proseParagraphs(markdown: string) {
  const paragraphs: string[][] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;
  const close = () => {
    if (paragraph.length) paragraphs.push(paragraph);
    paragraph = [];
  };
  for (const line of markdown.split(/\r?\n/u)) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
    } else if (marker) {
      close();
      fence = marker;
    } else if (!line.trim() || TITLE_LINE.test(line)) {
      close();
    } else {
      paragraph.push(line.replace(BLOCK_MARKER, "").trim());
    }
  }
  close();
  return paragraphs;
}

/** Text up to the first `.`, `!` or `?` that ends a sentence, skipping any inside inline code; null without one. */
function firstSentenceEnd(text: string) {
  let inCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "`") inCode = !inCode;
    else if (!inCode && /[.!?]/u.test(char) && (index + 1 === text.length || /\s/u.test(text[index + 1]))) return index + 1;
  }
  return null;
}

/** Emphasis markers outside inline code; the code spans stay as Markdown for the renderer. */
function stripEmphasis(text: string) {
  return text.split(/(`[^`]*`)/u).map(part => part.startsWith("`") ? part : part.replace(/\*\*|__/gu, "")).join("");
}

/**
 * What live reasoning is on right now: the first sentence of its newest prose paragraph, or that paragraph's first
 * line until a sentence ends. Code the agent writes belongs to the prose before it, which stays the sentence.
 */
export function getLatestReasoningSentence(markdown: string): string | null {
  const lines = proseParagraphs(markdown).at(-1);
  if (!lines) return null;
  const text = lines.join(" ");
  const end = firstSentenceEnd(text);
  const sentence = stripEmphasis(end === null ? lines[0] : text.slice(0, end)).replace(/\s+/gu, " ").trim();
  return sentence || null;
}

function visibleReasoningSections(item: ReasoningItem) {
  return item.summary.length
    ? { sections: item.summary, source: "summary" as const }
    : { sections: item.content, source: "content" as const };
}

export function getThreadReasoningSteps(items: readonly ReasoningItem[]): ThreadReasoningStep[] {
  return items.flatMap((item) => {
    const { sections, source } = visibleReasoningSections(item);
    return sections.flatMap((section, sectionIndex) => {
      const markdown = section.trim();
      if (!markdown) return [];
      const display = projectThreadReasoningMarkdown(markdown);
      return [{
        body: display.body,
        itemId: item.id,
        markdown,
        sectionIndex,
        source,
        title: display.title,
      }];
    });
  });
}

export function omitThreadReasoningStep(
  item: ReasoningItem,
  hiddenStep: ThreadReasoningStepReference | null | undefined,
): ReasoningItem | null {
  if (!hiddenStep || hiddenStep.itemId !== item.id) return item;
  const { sections, source } = visibleReasoningSections(item);
  if (hiddenStep.source !== source || hiddenStep.sectionIndex < 0 || hiddenStep.sectionIndex >= sections.length) {
    return item;
  }
  const visibleSections = sections.filter((_section, index) => index !== hiddenStep.sectionIndex);
  if (!visibleSections.some((section) => section.trim())) return null;
  return source === "summary"
    ? { ...item, summary: visibleSections }
    : { ...item, content: visibleSections };
}
