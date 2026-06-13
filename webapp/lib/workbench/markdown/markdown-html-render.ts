/*
 * Exports:
 * - markdownToHtml: render parsed workbench markdown into sanitized HTML for the rich editor and save guard. Keywords: markdown, html, editor, renderer.
 */

import {
    getProjectFilePathDisplay,
    projectFilePathInteractiveClassName,
    projectFilePathLabelClassName,
    projectFilePathLocationClassName,
    projectFilePathPillClassName,
} from "../project/project-file-path";
import {
    parseBlockCommentBody,
} from "./comment-markdown";
import {
    formatThreadStateChangeMode,
    parseBlocks,
    parseInlineMarkdown,
    parseThreadStateChangeMode,
    stripInlineCodeSpans,
    type MarkdownParseOptions,
    type ParsedBlock,
    type ParsedInlineNode,
    type ParsedListItem,
} from "./markdown-parse";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderProjectFileLink(url: string, relativePath: string, {
  columnNumber = null,
  label = null,
  lineNumber = null,
}: {
  columnNumber?: number | null;
  label?: string | null;
  lineNumber?: number | null;
} = {}) {
  const display = getProjectFilePathDisplay(relativePath, { columnNumber, label, lineNumber });
  const className = `${projectFilePathPillClassName} ${projectFilePathInteractiveClassName}`;

  return `<a href="${escapeHtml(url)}" class="${escapeHtml(className)}" data-project-file-path="true" data-project-file-relative-path="${escapeHtml(relativePath)}" title="${escapeHtml(display.title)}">`
    + (display.rootPrefix
      ? `<span class="${escapeHtml(projectFilePathLocationClassName)}">${escapeHtml(display.rootPrefix)}</span>`
      : "")
    + `<span class="${escapeHtml(projectFilePathLabelClassName)}">${escapeHtml(display.label)}</span>`
    + (display.locationSuffix
      ? `<span class="${escapeHtml(projectFilePathLocationClassName)}">${escapeHtml(display.locationSuffix)}</span>`
      : "")
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
      case "inlineComment":
        html += `<span data-inline-comment="true">${renderInlineHtml(node.children)}</span>`;
        break;
      case "knownSkillMention":
        html += `<span data-known-skill-mention="true" title="${escapeHtml(node.title)}">${escapeHtml(node.text)}</span>`;
        break;
      case "projectFileLink":
        html += renderProjectFileLink(node.href, node.relativePath, {
          columnNumber: node.columnNumber,
          label: node.label,
          lineNumber: node.lineNumber,
        });
        break;
    }
  }

  return html;
}

function renderInline(markdown: string, options: MarkdownParseOptions = {}) {
  return renderInlineHtml(parseInlineMarkdown(markdown, options));
}

function renderListBlock(block: Extract<ParsedBlock, { type: "ul" | "ol" }>, options: MarkdownParseOptions = {}) {
  return `<${block.type}>${block.items.map((item) => renderListItem(item, options)).join("")}</${block.type}>`;
}

function renderChildBlocks(blocks: ParsedBlock[], options: MarkdownParseOptions = {}) {
  return blocks.map((block) => renderBlockHtml(block, options)).join("");
}

function isThreadSingleItemOrderedStep(block: Extract<ParsedBlock, { type: "ol" }>, options: MarkdownParseOptions = {}) {
  return (options.profile ?? "editor") === "thread"
    && block.items.length === 1
    && /^\d+[.)]$/.test(block.items[0].marker);
}

function renderThreadSingleItemOrderedStep(block: Extract<ParsedBlock, { type: "ol" }>, options: MarkdownParseOptions = {}) {
  const item = block.items[0];
  const content = renderInline(item.text, options);
  const childContent = renderChildBlocks(item.children, options);

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
    ? ` style="text-align:${alignment}"`
    : "";
}

function renderTableBlock(block: Extract<ParsedBlock, { type: "table" }>, options: MarkdownParseOptions = {}) {
  const header = block.header
    .map((cell, index) => `<th${getTableCellAlignAttribute(block.alignments[index] ?? null)}>${renderInline(cell.text, options)}</th>`)
    .join("");
  const rows = block.rows
    .map((row) => {
      const cells = block.header
        .map((_, index) => {
          const cell = row[index] ?? { text: "" };
          return `<td${getTableCellAlignAttribute(block.alignments[index] ?? null)}>${renderInline(cell.text, options)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderListItem(item: ParsedListItem, options: MarkdownParseOptions = {}) {
  const content = renderInline(item.text, options) || "<br>";
  if (!item.children.length) {
    return `<li>${content}</li>`;
  }

  const childContent = item.children
    ? renderChildBlocks(item.children, options)
    : "";

  return `<li><details open><summary>${content}</summary>${childContent}</details></li>`;
}

function renderBlockHtml(block: ParsedBlock, options: MarkdownParseOptions = {}) {
  switch (block.type) {
    case "list-break":
      return Array.from(
        { length: Math.max(1, block.count) },
        () => '<p data-list-break="true"><br></p>',
      ).join("");
    case "break":
      return "<br>".repeat(block.count);
    case "heading":
      return `<h${block.level}>${renderInline(block.text, options)}</h${block.level}>`;
    case "blockquote":
      return `<blockquote>${renderInline(block.text, options)}</blockquote>`;
    case "comment":
      return `<p data-block-comment="true">${escapeHtml(parseBlockCommentBody(block.text) ?? block.text)}</p>`;
    case "ul":
    case "ol":
      if (block.type === "ol" && isThreadSingleItemOrderedStep(block, options)) {
        return renderThreadSingleItemOrderedStep(block, options);
      }

      return renderListBlock(block, options);
    case "hr":
      return "<hr>";
    case "code":
      return `<pre data-language="${escapeHtml(block.language)}"><code>${escapeHtml(block.text)}</code></pre>`;
    case "plan":
      return renderChildBlocks(parseBlocks(block.text, options), options);
    case "table":
      return renderTableBlock(block, options);
    case "paragraph":
    default: {
      const stateChangeMode = parseThreadStateChangeMode(block.text, options);
      if (stateChangeMode) {
        return renderThreadStateChange(stateChangeMode);
      }

      return `<p>${renderInline(block.text, options)}</p>`;
    }
  }
}

export function markdownToHtml(markdown: string, options: MarkdownParseOptions = {}) {
  const blocks = parseBlocks(markdown, options);
  const html = blocks
    .map((block) => renderBlockHtml(block, options))
    .join("");

  return html || "<p><br></p>";
}
