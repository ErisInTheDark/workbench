/*
 * Exports:
 * - renderThreadInlineMarkdown: render simplified inline markdown for thread display content. Keywords: thread, markdown, inline, render.
 * - renderThreadListBlock: render parsed thread list blocks into HTML. Keywords: thread, markdown, list, render.
 * - renderThreadListItem: render parsed thread list items into HTML. Keywords: thread, markdown, list item, render.
 */

import type {
    ParsedBlock,
    ParsedListItem,
} from "./markdown-render";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findClosingToken(source: string, token: string, fromIndex: number) {
  for (let index = fromIndex; index < source.length; index += 1) {
    if (source[index - 1] === "\\") {
      continue;
    }

    if (source.startsWith(token, index)) {
      return index;
    }
  }

  return -1;
}

export function renderThreadInlineMarkdown(markdown: string) {
  let html = "";
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] === "\\") {
      html += escapeHtml(markdown.slice(index + 1, index + 2));
      index += 2;
      continue;
    }

    if (markdown.startsWith("<del>", index)) {
      const closeIndex = markdown.indexOf("</del>", index + 5);
      if (closeIndex !== -1) {
        html += `<del>${renderThreadInlineMarkdown(markdown.slice(index + 5, closeIndex))}</del>`;
        index = closeIndex + 6;
        continue;
      }
    }

    if (markdown.startsWith("<ins>", index)) {
      const closeIndex = markdown.indexOf("</ins>", index + 5);
      if (closeIndex !== -1) {
        html += `<ins>${renderThreadInlineMarkdown(markdown.slice(index + 5, closeIndex))}</ins>`;
        index = closeIndex + 6;
        continue;
      }
    }

    if (markdown.startsWith("<!--", index)) {
      const closeIndex = markdown.indexOf("-->", index + 4);
      if (closeIndex !== -1) {
        const commentBody = markdown.slice(index + 4, closeIndex).trim();
        html += `<span data-inline-comment="true">${renderThreadInlineMarkdown(commentBody)}</span>`;
        index = closeIndex + 3;
        continue;
      }
    }

    if (markdown.startsWith("**", index) || markdown.startsWith("__", index)) {
      const marker = markdown.slice(index, index + 2);
      const closeIndex = findClosingToken(markdown, marker, index + 2);
      if (closeIndex !== -1) {
        html += `<strong>${renderThreadInlineMarkdown(markdown.slice(index + 2, closeIndex))}</strong>`;
        index = closeIndex + 2;
        continue;
      }
    }

    if (markdown.startsWith("~~", index)) {
      const closeIndex = findClosingToken(markdown, "~~", index + 2);
      if (closeIndex !== -1) {
        html += `<del>${renderThreadInlineMarkdown(markdown.slice(index + 2, closeIndex))}</del>`;
        index = closeIndex + 2;
        continue;
      }
    }

    if (markdown[index] === "*" || markdown[index] === "_") {
      const marker = markdown[index];
      const closeIndex = findClosingToken(markdown, marker, index + 1);
      if (closeIndex !== -1) {
        html += `<em>${renderThreadInlineMarkdown(markdown.slice(index + 1, closeIndex))}</em>`;
        index = closeIndex + 1;
        continue;
      }
    }

    if (markdown[index] === "`") {
      const closeIndex = findClosingToken(markdown, "`", index + 1);
      if (closeIndex !== -1) {
        html += `<code>${escapeHtml(markdown.slice(index + 1, closeIndex))}</code>`;
        index = closeIndex + 1;
        continue;
      }
    }

    if (markdown[index] === "[") {
      const labelEnd = findClosingToken(markdown, "]", index + 1);
      if (labelEnd !== -1 && markdown[labelEnd + 1] === "(") {
        const urlEnd = findClosingToken(markdown, ")", labelEnd + 2);
        if (urlEnd !== -1) {
          const label = markdown.slice(index + 1, labelEnd);
          const url = markdown.slice(labelEnd + 2, urlEnd);
          html += `<a href="${escapeHtml(url)}">${renderThreadInlineMarkdown(label)}</a>`;
          index = urlEnd + 1;
          continue;
        }
      }
    }

    if (markdown[index] === "\n") {
      html += "<br>";
      index += 1;
      continue;
    }

    html += escapeHtml(markdown[index]);
    index += 1;
  }

  return html;
}

export function renderThreadListBlock(block: Extract<ParsedBlock, { type: "ul" | "ol" }>) {
  return `<${block.type}>${block.items.map((item) => renderThreadListItem(item)).join("")}</${block.type}>`;
}

export function renderThreadListItem(item: ParsedListItem) {
  const content = renderThreadInlineMarkdown(item.text) || "<br>";
  if (!item.children.length) {
    return `<li>${content}</li>`;
  }

  const childContent = item.children
    .map((child) => child.type === "ul" || child.type === "ol" ? renderThreadListBlock(child) : "")
    .join("");

  return `<li><details open><summary>${content}</summary>${childContent}</details></li>`;
}