/*
 * Exports:
 * - markdownToHtml: render parsed workbench markdown into sanitized HTML for the rich editor and save guard. Editor
 *   blocks carry their source lines, comment threads become atoms, suggestions become tagged block groups, table
 *   cells carry their column's alignment and code ends in its line sentinel.
 * - renderEditorMarkdownUnits: the editor rendering split into its top-level units, for per-block save-guard caching.
 */

import {
    getProjectFilePathDisplay,
    projectFilePathInteractiveClassName,
    projectFilePathLabelClassName,
    projectFilePathLocationClassName,
    projectFilePathMissingClassName,
    projectFilePathPillClassName,
    projectFilePathStaticClassName,
} from "../project/project-file-path";
import {
    parseCommentLine,
    type MarkdownComment,
} from "./comment-markdown";
import {
    formatThreadStateChangeMode,
    parseBlocks,
    parseInlineMarkdown,
    parseSourcedBlocks,
    parseThreadStateChangeMode,
    stripInlineCodeSpans,
    type MarkdownParseOptions,
    type ParsedBlock,
    type ParsedInlineNode,
    type ParsedListItem,
    type SourcedBlock,
} from "./markdown-parse";
import {
    REVIEW_ATTRIBUTES,
    commentThreadHtml,
    escapeAttribute,
    nextSuggestionId,
} from "./review-markup";
import { CODE_LINE_SENTINEL } from "../dom/mutation/code-block-dom";import { TABLE_ALIGN_ATTRIBUTE } from "../dom/mutation/table-dom";

const escapeHtml = escapeAttribute;

function renderProjectFileLink(url: string, relativePath: string, {
  absolutePath = null,
  columnNumber = null,
  exists = true,
  label = null,
  lineNumber = null,
  openPath = relativePath,
  targetType = "file",
}: {
  absolutePath?: string | null;
  columnNumber?: number | null;
  exists?: boolean;
  label?: string | null;
  lineNumber?: number | null;
  openPath?: string;
  targetType?: "directory" | "file";
} = {}) {
  const display = getProjectFilePathDisplay(relativePath, { absolutePath, columnNumber, label, lineNumber, targetType });
  const className = [
    projectFilePathPillClassName,
    exists && targetType === "file" ? projectFilePathInteractiveClassName : "",
    exists && targetType === "directory" ? projectFilePathStaticClassName : "",
    exists ? "" : projectFilePathMissingClassName,
  ].join(" ");
  const content = (display.rootPrefix
    ? `<span class="${escapeHtml(projectFilePathLocationClassName)}">${escapeHtml(display.rootPrefix)}</span>`
    : "")
    + `<span class="${escapeHtml(projectFilePathLabelClassName)}">${escapeHtml(display.label)}</span>`
    + (display.locationSuffix
      ? `<span class="${escapeHtml(projectFilePathLocationClassName)}">${escapeHtml(display.locationSuffix)}</span>`
      : "");

  if (!exists) {
    return `<span class="${escapeHtml(className)}" data-project-file-missing-path="true" title="${escapeHtml(display.title)}">${content}</span>`;
  }

  if (targetType === "directory") {
    return `<span class="${escapeHtml(className)}" data-project-folder-path="true" title="${escapeHtml(display.title)}">${content}</span>`;
  }

  return `<a href="${escapeHtml(url)}" class="${escapeHtml(className)}" data-project-file-path="true" data-project-file-relative-path="${escapeHtml(openPath)}"${absolutePath ? ` data-project-file-absolute-path="${escapeHtml(absolutePath)}"` : ""} title="${escapeHtml(display.title)}">`
    + content
    + "</a>";
}

function renderInlineHtml(nodes: ParsedInlineNode[]) {
  let html = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        html += escapeHtml(node.text);
        break;
      case "strong":
        html += `<strong>${renderInlineHtml(node.children)}</strong>`;
        break;
      case "em":
        html += `<em>${renderInlineHtml(node.children)}</em>`;
        break;
      case "delete":
        html += `<del>${renderInlineHtml(node.children)}</del>`;
        break;
      case "insert":
        html += `<ins>${renderInlineHtml(node.children)}</ins>`;
        break;
      case "mark":
        html += `<mark>${renderInlineHtml(node.children)}</mark>`;
        break;
      case "underline":
        html += `<u>${renderInlineHtml(node.children)}</u>`;
        break;
      case "subscript":
        html += `<sub>${renderInlineHtml(node.children)}</sub>`;
        break;
      case "superscript":
        html += `<sup>${renderInlineHtml(node.children)}</sup>`;
        break;
      case "markTag":
        html += `<u ${REVIEW_ATTRIBUTES.markTag}="${escapeHtml(node.name)}" title="${escapeHtml(node.name)}">${renderInlineHtml(node.children)}</u>`;
        break;
      case "code":
        html += `<code>${escapeHtml(node.text)}</code>`;
        break;
      case "break":
        html += "<br>";
        break;
      case "link": {
        html += `<a href="${escapeHtml(node.href)}" target="_blank" rel="noreferrer">${renderInlineHtml(node.children)}</a>`;
        break;
      }
      case "commentThread":
        html += commentThreadHtml("inline", node.comments);
        break;
      case "inlineComment":
        html += `<span data-inline-comment="true">${renderInlineHtml(node.children)}</span>`;
        break;
      case "attachmentMention":
        html += escapeHtml(node.text);
        break;
      case "knownSkillMention":
        html += `<span data-known-skill-mention="true" title="${escapeHtml(node.title)}">${escapeHtml(node.text)}</span>`;
        break;
      case "projectFileLink":
        html += renderProjectFileLink(node.href, node.relativePath, {
          absolutePath: node.absolutePath,
          columnNumber: node.columnNumber,
          exists: node.exists,
          label: node.label,
          lineNumber: node.lineNumber,
          openPath: node.openPath,
          targetType: node.targetType,
        });
        break;
    }
  }

  return html;
}

function renderInline(markdown: string, options: MarkdownParseOptions = {}) {
  return renderInlineHtml(parseInlineMarkdown(markdown, options));
}

function renderListBlock(block: Extract<ParsedBlock, { type: "ul" | "ol" }>, options: MarkdownParseOptions, attributes: string) {
  return `<${block.type}${attributes}>${block.items.map((item) => renderListItem(item, options)).join("")}</${block.type}>`;
}

function renderChildBlocks(blocks: ParsedBlock[], options: MarkdownParseOptions = {}): string {
  return blocks.map((block) => renderBlockHtml(block, options)).join("");
}

function isThreadSingleItemOrderedStep(block: Extract<ParsedBlock, { type: "ol" }>, options: MarkdownParseOptions = {}) {
  return (options.profile ?? "editor") === "thread"
    && block.items.length === 1
    && /^\d+[.)]$/.test(block.items[0].marker);
}

function renderThreadSingleItemOrderedStep(block: Extract<ParsedBlock, { type: "ol" }>, options: MarkdownParseOptions = {}): string {
  const item = block.items[0];
  const content = renderInline(item.text, options);
  const childContent: string = renderChildBlocks(item.children, options);

  if (stripInlineCodeSpans(item.text).includes(".")) {
    return `<p>${escapeHtml(item.marker)}${content ? ` ${content}` : ""}</p>${childContent}`;
  }

  const marker = `<span data-thread-step-marker="true">${escapeHtml(item.marker)}</span>`;

  return `<p data-thread-step-line="true">${marker}${content ? ` ${content}` : ""}</p>${childContent}`;
}

function renderThreadStateChange(mode: string) {
  const label = formatThreadStateChangeMode(mode);
  const escapedMode = escapeHtml(mode);
  const escapedLabel = escapeHtml(label);

  return `<div data-thread-state-change="true" data-thread-state-mode="${escapedMode}">`
    + '<span data-thread-state-change-kicker="true">Mode</span>'
    + `<span data-thread-state-change-label="true">${escapedLabel}</span>`
    + "</div>";
}

function getTableCellAlignAttribute(alignment: Extract<ParsedBlock, { type: "table" }>["alignments"][number]) {
  return alignment
    ? ` ${TABLE_ALIGN_ATTRIBUTE}="${alignment}"`
    : "";
}

function renderTableBlock(block: Extract<ParsedBlock, { type: "table" }>, options: MarkdownParseOptions, attributes: string) {
  // An empty cell keeps a line box, as an empty paragraph does, so it stays as tall as its row and can hold the caret.
  const renderCell = (text: string) => renderInline(text, options) || "<br>";
  const header = block.header
    .map((cell, index) => `<th${getTableCellAlignAttribute(block.alignments[index] ?? null)}>${renderCell(cell.text)}</th>`)
    .join("");
  const rows = block.rows
    .map((row) => {
      const cells = block.header
        .map((_, index) => {
          const cell = row[index] ?? { text: "" };
          return `<td${getTableCellAlignAttribute(block.alignments[index] ?? null)}>${renderCell(cell.text)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table${attributes}><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderListItem(item: ParsedListItem, options: MarkdownParseOptions = {}) {
  const content = renderInline(item.text, options) || "<br>";
  const valueAttribute = item.ordinal === null ? "" : ` value="${item.ordinal}"`;
  if (!item.children.length) {
    return `<li${valueAttribute}>${content}</li>`;
  }

  const childContent = item.children
    ? renderChildBlocks(item.children, options)
    : "";

  return `<li${valueAttribute}><details open><summary>${content}</summary>${childContent}</details></li>`;
}

function renderCommentLines(texts: readonly string[], attributes = "") {
  const comments = texts.flatMap((text): MarkdownComment[] => parseCommentLine(text) ?? []);
  return commentThreadHtml("block", comments, attributes);
}

/** `attributes` decorate a top-level block's own element; nested blocks never carry them. */
function renderBlockHtml(block: ParsedBlock, options: MarkdownParseOptions = {}, attributes = ""): string {
  switch (block.type) {
    case "list-break":
      return Array.from(
        { length: Math.max(1, block.count) },
        () => '<p data-list-break="true"><br></p>',
      ).join("");
    case "break":
      return "<br>".repeat(block.count);
    case "heading":
      return `<h${block.level}${attributes}>${renderInline(block.text, options)}</h${block.level}>`;
    case "blockquote":
      return `<blockquote${attributes}>${renderInline(block.text, options)}</blockquote>`;
    case "comment":
      return renderCommentLines([block.text], attributes);
    case "ul":
    case "ol":
      if (block.type === "ol" && isThreadSingleItemOrderedStep(block, options)) {
        return renderThreadSingleItemOrderedStep(block, options);
      }

      return renderListBlock(block, options, attributes);
    case "hr":
      return `<hr${attributes}>`;
    case "code":
      return `<pre${attributes} data-language="${escapeHtml(block.language)}"><code>${escapeHtml(block.text)}${CODE_LINE_SENTINEL}</code></pre>`;
    case "plan":
      return renderChildBlocks(parseBlocks(block.text, options), options);
    case "notice":
      return `<p>${escapeHtml(block.source).replaceAll("\n", "<br>")}</p>`;
    case "details":
      return `<p>${escapeHtml(block.source).replaceAll("\n", "<br>")}</p>`;
    case "table":
      return renderTableBlock(block, options, attributes);
    case "suggestion":
      return renderSuggestion(block, options);
    case "paragraph":
    default: {
      const stateChangeMode = parseThreadStateChangeMode(block.text, options);
      if (stateChangeMode) {
        return renderThreadStateChange(stateChangeMode);
      }

      return `<p${attributes}>${renderInline(block.text, options)}</p>`;
    }
  }
}

function sourceAttributes(entry: SourcedBlock) {
  if (entry.source === null) {
    return "";
  }

  return ` ${REVIEW_ATTRIBUTES.source}="${escapeHtml(entry.source)}"` + (entry.tight ? ` ${REVIEW_ATTRIBUTES.sourceTight}="true"` : "");
}

/** Consecutive comment lines are one thread. `groupAttributes` tag every top-level element, as suggestion members. */
function renderEditorBlocks(entries: readonly SourcedBlock[], options: MarkdownParseOptions, groupAttributes = "") {
  return renderEditorUnits(entries, options, groupAttributes).join("");
}

/** One html string per top-level unit: a block, a run of breaks, or a group of comment lines. */
function renderEditorUnits(entries: readonly SourcedBlock[], options: MarkdownParseOptions, groupAttributes = "") {
  const units: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const { block } = entry;
    if (block.type === "break" || block.type === "list-break") {
      units.push(renderBlockHtml(block, options));
      continue;
    }

    if (block.type === "comment") {
      const lines: string[] = [];
      const sources: string[] = [];
      while (entries[index]?.block.type === "comment") {
        const commentEntry = entries[index]!;
        lines.push((commentEntry.block as Extract<ParsedBlock, { type: "comment" }>).text);
        sources.push(commentEntry.source ?? "");
        index += 1;
      }
      index -= 1;
      units.push(renderCommentLines(lines, sourceAttributes({ ...entry, source: sources.join("\n") }) + groupAttributes));
      continue;
    }

    if (block.type === "suggestion" && groupAttributes) {
      // A suggestion nested in a suggestion's new side reads as its own new side.
      units.push(renderEditorBlocks(parseSourcedBlocks(block.new, options), options, groupAttributes));
      continue;
    }

    units.push(renderBlockHtml(block, options, sourceAttributes(entry) + groupAttributes));
  }

  return units;
}

/** The editor rendering of `markdown` split into its top-level units; joined, they are `markdownToHtml`'s output. */
export function renderEditorMarkdownUnits(markdown: string, options: MarkdownParseOptions = {}) {
  return renderEditorUnits(parseSourcedBlocks(markdown, options), options);
}

function renderSuggestion(block: Extract<ParsedBlock, { type: "suggestion" }>, options: MarkdownParseOptions) {
  const groupAttributes = ` ${REVIEW_ATTRIBUTES.suggestion}="${nextSuggestionId()}" ${REVIEW_ATTRIBUTES.suggestionOld}="${escapeHtml(block.old)}"`;
  const newSide = block.new ? renderEditorBlocks(parseSourcedBlocks(block.new, options), options, groupAttributes) : "";
  return newSide || `<p${groupAttributes}><br></p>`;
}

export function markdownToHtml(markdown: string, options: MarkdownParseOptions = {}) {
  const html = (options.profile ?? "editor") === "editor"
    ? renderEditorBlocks(parseSourcedBlocks(markdown, options), options)
    : parseBlocks(markdown, options).map((block) => renderBlockHtml(block, options)).join("");

  return html || "<p><br></p>";
}
