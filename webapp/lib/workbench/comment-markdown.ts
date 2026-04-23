/**
 * Exports:
 * - isBlockCommentLine: detect whether a trimmed line is a full HTML comment block. Keywords: markdown, comment, block comment, parser.
 * - parseBlockCommentBody: extract the inner text from a full HTML comment block line. Keywords: markdown, comment, block comment, parse.
 * - formatBlockCommentLine: normalize comment body whitespace and format it as a single-line HTML comment. Keywords: markdown, comment, block comment, serialize.
 * - escapeMarkdownText: escape markdown control characters in plain text content. Keywords: markdown, escape, inline text, serialization.
 * - formatInlineCommentMarkdown: normalize inline comment content and format it as an HTML comment. Keywords: markdown, inline comment, serialize, formatting.
 */

export function isBlockCommentLine(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith("<!--") && trimmed.endsWith("-->");
}

export function parseBlockCommentBody(text: string) {
  if (!isBlockCommentLine(text)) {
    return null;
  }

  return text.trim().slice(4, -3).trim();
}

export function formatBlockCommentLine(body: string) {
  const normalizedBody = body.replace(/\s*\n+\s*/g, " ").trim();
  return normalizedBody ? `<!-- ${normalizedBody} -->` : "<!-- -->";
}

export function escapeMarkdownText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function formatInlineCommentMarkdown(content: string) {
  const commentBody = content.replace(/[ \t\u00a0]+$/g, "").trim();
  return commentBody ? `<!-- ${commentBody} -->` : "<!-- -->";
}
