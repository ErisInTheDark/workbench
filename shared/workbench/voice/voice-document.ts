/*
 * Exports:
 * - VoiceSelection: UTF-16 positions in unmarked editor text.
 * - encodeVoiceDocument/decodeVoiceDocument: reversible text and one editing marker.
 */
export interface VoiceSelection { start: number; end: number }

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function unescape(text: string) {
  if (/[<>]|&(?!amp;|lt;|gt;)/u.test(text)) throw new Error("Voice document contains unescaped text or invalid editing markers.");
  return text.replace(/&(amp|lt|gt);/gu, (_, name: string) => name === "amp" ? "&" : name === "lt" ? "<" : ">");
}
export function encodeVoiceDocument(text: string, selection: VoiceSelection = { start: text.length, end: text.length }) {
  const { start, end } = selection;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > text.length) {
    throw new Error("Voice selection is outside the editor text.");
  }
  return escape(text.slice(0, start))
    + (start === end ? "<caret />" : `<selection>${escape(text.slice(start, end))}</selection>`)
    + escape(text.slice(end));
}
export function decodeVoiceDocument(document: string): { text: string; selection: VoiceSelection } {
  const caret = document.indexOf("<caret />");
  const start = document.indexOf("<selection>");
  if (caret >= 0 && start < 0) {
    const before = unescape(document.slice(0, caret));
    const after = unescape(document.slice(caret + "<caret />".length));
    return { text: before + after, selection: { start: before.length, end: before.length } };
  }
  const end = document.indexOf("</selection>");
  if (caret < 0 && start >= 0 && end >= start + "<selection>".length) {
    const before = unescape(document.slice(0, start));
    const selected = unescape(document.slice(start + "<selection>".length, end));
    const after = unescape(document.slice(end + "</selection>".length));
    return { text: before + selected + after, selection: { start: before.length, end: before.length + selected.length } };
  }
  throw new Error("Voice document must contain one caret or one selection.");
}
