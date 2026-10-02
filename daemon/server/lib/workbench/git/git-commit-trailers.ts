/*
 * Exports:
 * - replaceCoAuthorTrailers: replace every Co-authored-by trailer in a commit message's final trailer block.
 */

const TRAILER_LINE = /^[A-Za-z0-9-]+:\s/u;
const CO_AUTHOR_LINE = /^co-authored-by:/iu;

/** Rewrites only the final paragraph when every line there is a trailer; other trailers keep their order. */
export function replaceCoAuthorTrailers(message: string, coAuthors: readonly string[]) {
  const trimmed = message.replace(/\s+$/u, "");
  const separator = trimmed.lastIndexOf("\n\n");
  const lastLines = separator < 0 ? [] : trimmed.slice(separator + 2).split("\n");
  const hasTrailerBlock = lastLines.length > 0 && lastLines.every((line) => TRAILER_LINE.test(line));
  const body = hasTrailerBlock ? trimmed.slice(0, separator).replace(/\s+$/u, "") : trimmed;
  const trailers = [
    ...(hasTrailerBlock ? lastLines.filter((line) => !CO_AUTHOR_LINE.test(line)) : []),
    ...coAuthors.map((coAuthor) => `Co-authored-by: ${coAuthor}`),
  ];
  return trailers.length ? `${body}\n\n${trailers.join("\n")}\n` : `${body}\n`;
}
