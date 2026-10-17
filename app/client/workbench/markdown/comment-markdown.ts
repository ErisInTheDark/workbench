/*
 * Exports:
 * - MarkdownComment: one note of a comment thread; `raw` keeps the exact `<!-- -->` source it was read from.
 * - COMMENT_AUTHOR_MAX_LENGTH: longest author name a comment stores.
 * - normalizeCommentAuthor: the author name a comment can store, or null when nothing is left.
 * - parseComment: read the inside of one `<!-- -->` into an author and body; also reads the older `@author:` form.
 * - formatComment: write one note as `<!-- [author]: body -->`, reusing its raw source while it is unedited.
 * - formatCommentThread: write a thread's notes back to back, which is what makes them one thread.
 * - readCommentRun: read the comments glued together at a source index, as one thread.
 * - parseCommentLine: read a line made only of comments, or null.
 * - isBlockCommentLine: whether a line is made only of comments.
 * - sameComments: compare threads by author and body.
 */

export interface MarkdownComment {
  author: string | null;
  body: string;
  raw?: string;
}

export const COMMENT_AUTHOR_MAX_LENGTH = 40;

const AUTHOR_PATTERN = /^\[([^\]\r\n]{1,40})\]:[ \t]*/u;
const LEGACY_AUTHOR_PATTERN = /^@([^\s:@][^\s:]{0,39}):[ \t]*/u;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

export function normalizeCommentAuthor(name: string | null | undefined) {
  const author = (name ?? "").replace(/[\]\r\n]+/gu, " ").trim().slice(0, COMMENT_AUTHOR_MAX_LENGTH).trim();
  return author || null;
}

export function parseComment(inner: string, raw?: string): MarkdownComment {
  const trimmed = inner.trim();
  const author = trimmed.match(AUTHOR_PATTERN) ?? trimmed.match(LEGACY_AUTHOR_PATTERN);
  const name = author ? normalizeCommentAuthor(author[1]) : null;
  return {
    author: name,
    body: name ? trimmed.slice(author![0].length) : trimmed,
    ...(raw === undefined ? {} : { raw }),
  };
}

/** A body can never close its own comment early. */
function sanitizeBody(body: string) {
  return body.replaceAll("-->", "-- >").replaceAll("--!>", "-- !>").trim();
}

export function formatComment(comment: MarkdownComment) {
  if (comment.raw !== undefined) {
    const original = parseComment(comment.raw.slice(COMMENT_OPEN.length, -COMMENT_CLOSE.length));
    if (original.author === comment.author && original.body === comment.body) {
      return comment.raw;
    }
  }

  const body = sanitizeBody(comment.body);
  const author = normalizeCommentAuthor(comment.author);
  const prefix = author ? `[${author}]: ` : "";
  return `${COMMENT_OPEN} ${prefix}${body}${body || prefix ? " " : ""}${COMMENT_CLOSE}`;
}

export function formatCommentThread(comments: readonly MarkdownComment[]) {
  return comments.map(formatComment).join("");
}

export function readCommentRun(source: string, index: number) {
  const comments: MarkdownComment[] = [];
  let cursor = index;
  while (source.startsWith(COMMENT_OPEN, cursor)) {
    const close = source.indexOf(COMMENT_CLOSE, cursor + COMMENT_OPEN.length);
    if (close < 0) {
      break;
    }

    const end = close + COMMENT_CLOSE.length;
    comments.push(parseComment(source.slice(cursor + COMMENT_OPEN.length, close), source.slice(cursor, end)));
    cursor = end;
  }

  return comments.length ? { comments, end: cursor } : null;
}

export function parseCommentLine(line: string) {
  const comments: MarkdownComment[] = [];
  let cursor = line.search(/\S/u);
  if (cursor < 0) {
    return null;
  }

  while (cursor < line.length) {
    const run = readCommentRun(line, cursor);
    if (!run) {
      return null;
    }

    comments.push(...run.comments);
    cursor = run.end;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  }

  return comments;
}

export function isBlockCommentLine(line: string) {
  return parseCommentLine(line) !== null;
}

export function sameComments(left: readonly MarkdownComment[], right: readonly MarkdownComment[]) {
  return left.length === right.length
    && left.every((comment, index) => comment.author === right[index]!.author && comment.body === right[index]!.body);
}
