/*
 * Exports:
 * - escapeMarkdownText: escape markdown control characters, review and mark tag openers, strike runs and literal &nbsp; in
 *   plain text.
 * - isIntrawordUnderscore: detect underscore runs between word characters, which are literal rather than emphasis.
 */

export function escapeMarkdownText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replace(/_/g, (underscore, index: number, text: string) => isIntrawordUnderscore(text, index) ? underscore : "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/<(?=\/?(?:del|ins|mark)>|!--|u data-mark="|\/u>)/g, "\\<")
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
