/*
 * Exports:
 * - inspectSaveGuardMarkup: clone, serialize, round-trip, and compare rich editor markup for save-guard checks. Keywords: workbench, save guard, rich editor, markdown, markup.
 * - inspectDraftContent: compute current draft content and save issue for rich vs plain editor modes. Keywords: workbench, draft, content, save guard, mode.
 * - isSameSaveGuardIssue: compare save-guard issues for logging deduplication. Keywords: workbench, save guard, dedupe, logging.
 * - describeFirstDifference: find the first differing character and excerpts between markup strings. Keywords: workbench, save guard, diff, excerpt.
 * - createConsolePreview: shorten large console strings while preserving both edges. Keywords: workbench, console, preview, logging.
 * - logSaveGuardIssue: emit the standard save-guard warning report for a file and trigger. Keywords: workbench, save guard, logging, console.
 */

import type { EditorMode, SaveGuardIssue } from "../WorkbenchEditorClient";
import {
    markdownToHtml as renderMarkdownToHtml,
} from "./markdown-html-render";
import {
    createWorkbenchMarkupSignature,
    serializeWorkbenchDomToMarkdown,
} from "./markdown-serialization";

interface SaveGuardMarkupInspection {
  markdown: string;
  issue: SaveGuardIssue | null;
}

interface InspectSaveGuardMarkupOptions {
  editorRoot: HTMLDivElement;
  isInlineRunContainer: (element: HTMLElement) => boolean;
  normalizeMarkup: (root: ParentNode) => void;
}

interface InspectDraftContentOptions {
  mode: EditorMode;
  plainTextContent: string;
  richInspection?: SaveGuardMarkupInspection | null;
}

export function inspectSaveGuardMarkup(options: InspectSaveGuardMarkupOptions): SaveGuardMarkupInspection {
  const { editorRoot, isInlineRunContainer, normalizeMarkup } = options;
  const editorSnapshot = editorRoot.cloneNode(true) as HTMLDivElement;
  const markdown = serializeWorkbenchDomToMarkdown(editorSnapshot, {
    isInlineRunContainer,
    normalizeMarkup,
  });
  const currentMarkup = createWorkbenchMarkupSignature(editorSnapshot, { isInlineRunContainer });
  const roundTripRoot = editorRoot.ownerDocument.createElement("div");
  roundTripRoot.innerHTML = renderMarkdownToHtml(markdown);
  normalizeMarkup(roundTripRoot);

  const roundTripMarkup = createWorkbenchMarkupSignature(roundTripRoot, { isInlineRunContainer });
  const issue = currentMarkup === roundTripMarkup
    ? null
    : { markdown, currentMarkup, roundTripMarkup } satisfies SaveGuardIssue;

  return { markdown, issue };
}

export function inspectDraftContent(options: InspectDraftContentOptions) {
  const { mode, plainTextContent, richInspection } = options;
  if (mode !== "rich" || !richInspection) {
    return {
      content: plainTextContent,
      issue: null,
    };
  }

  return {
    content: richInspection.markdown,
    issue: richInspection.issue,
  };
}

export function isSameSaveGuardIssue(left: SaveGuardIssue | null, right: SaveGuardIssue | null) {
  if (!left || !right) {
    return left === right;
  }

  return left.markdown === right.markdown
    && left.currentMarkup === right.currentMarkup
    && left.roundTripMarkup === right.roundTripMarkup;
}

export function describeFirstDifference(currentMarkup: string, roundTripMarkup: string) {
  const limit = Math.min(currentMarkup.length, roundTripMarkup.length);
  let index = 0;

  while (index < limit && currentMarkup[index] === roundTripMarkup[index]) {
    index += 1;
  }

  if (index === limit && currentMarkup.length === roundTripMarkup.length) {
    index = -1;
  }

  const excerptStart = Math.max(0, (index === -1 ? limit : index) - 80);
  const excerptEnd = Math.min(
    Math.max(currentMarkup.length, roundTripMarkup.length),
    (index === -1 ? limit : index) + 120,
  );

  return {
    index,
    currentExcerpt: currentMarkup.slice(excerptStart, excerptEnd),
    roundTripExcerpt: roundTripMarkup.slice(excerptStart, excerptEnd),
  };
}

export function createConsolePreview(value: string, maxLength = 320) {
  if (value.length <= maxLength) {
    return value || "(empty)";
  }

  const edgeLength = Math.max(40, Math.floor((maxLength - 5) / 2));
  return `${value.slice(0, edgeLength)}\n...\n${value.slice(-edgeLength)}`;
}

export function logSaveGuardIssue(issue: SaveGuardIssue, filePath: string, trigger: string) {
  const difference = describeFirstDifference(issue.currentMarkup, issue.roundTripMarkup);
  const report = [
    "[workbench] UNSAFE MARKDOWN SAVE BLOCKED",
    `file: ${filePath}`,
    `trigger: ${trigger}`,
    "reason: serializing the current WYSIWYG editor content to markdown and rendering it again would change the editor markup.",
    `first differing character: ${difference.index}`,
    "",
    "current editor markup around the mismatch:",
    difference.currentExcerpt || "(empty)",
    "",
    "round-tripped markup around the mismatch:",
    difference.roundTripExcerpt || "(empty)",
  ].join("\n");

  console.warn(report);
  console.warn("[workbench] Save blocked metadata", {
    filePath,
    trigger,
    firstDifferenceIndex: difference.index,
    currentMarkupLength: issue.currentMarkup.length,
    currentMarkupExcerpt: difference.currentExcerpt || "(empty)",
    roundTripMarkupLength: issue.roundTripMarkup.length,
    roundTripMarkupExcerpt: difference.roundTripExcerpt || "(empty)",
    markdownLength: issue.markdown.length,
    markdown: issue.markdown,
  });
}
