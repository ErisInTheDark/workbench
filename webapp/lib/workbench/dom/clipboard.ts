/*
 * Exports:
 * - writeTextToClipboard: safely write text to the browser clipboard. Keywords: clipboard, browser, copy, DOM.
 */

export async function writeTextToClipboard(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
