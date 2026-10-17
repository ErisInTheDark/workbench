/**
 * Exports:
 * - isBlockCommentLine: detect whether a trimmed line is a full HTML comment block. Keywords: markdown, comment, block comment, parser.
 * - parseBlockCommentBody: extract the inner text from a full HTML comment block line. Keywords: markdown, comment, block comment, parse.
 * - formatBlockCommentLine: normalize comment body whitespace and format it as a single-line HTML comment. Keywords: markdown, comment, block comment, serialize.
 * - escapeMarkdownText: escape markdown control characters, revision/comment tag openers, strike runs and literal &nbsp; in plain text. Keywords: markdown, escape, inline text, serialization.
 * - isIntrawordUnderscore: detect underscore runs between word characters, which are literal rather than emphasis. Keywords: markdown, underscore, emphasis.
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
    .replace(/_/g, (underscore, index: number, text: string) => isIntrawordUnderscore(text, index) ? underscore : "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/<(?=\/?(?:del|ins)>|!--)/g, "\\<")
    .replace(/~(?=~)|(?<=~)~/g, "\\~")
    .replace(/&(?=nbsp;)/g, "\\&");
}

/** An underscore run between word characters never opens emphasis (CommonMark), so it is literal text. */
export function isIntrawordUnderscore(text: string, index: number) {
  if (text[index] !== "_") {
    return false;
  }

  let start = index;
  let end = index + 1;
  while (text[start - 1] === "_") start -= 1;
  while (text[end] === "_") end += 1;
  return /[A-Za-z0-9]/.test(text[start - 1] ?? "") && /[A-Za-z0-9]/.test(text[end] ?? "");
}

export function formatInlineCommentMarkdown(content: string) {
  const commentBody = content.replace(/[ \t\u00a0]+$/g, "").trim();
  return commentBody ? `<!-- ${commentBody} -->` : "<!-- -->";
}
