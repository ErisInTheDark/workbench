/*
 * Exports:
 * - visWantsCss: whether a vis source asks for the project's CSS command through `<link rel="workbench-css">`.
 * - renderVisDocument: turn a vis source into a standalone document, swapping the CSS marker for a leading `<style>`.
 */

// Matches the marker in any attribute order, with or without a self-closing slash.
const CSS_MARKER = /<link\b[^>]*\brel\s*=\s*["']?workbench-css["']?[^>]*>/giu;

export function visWantsCss(source: string) {
  CSS_MARKER.lastIndex = 0;
  return CSS_MARKER.test(source);
}

/** A literal `</style` would end the element early; CSS never needs the sequence, so it is escaped. */
function styleElement(css: string) {
  return `<style>${css.replace(/<\/style/giu, "<\\/style")}</style>`;
}

/**
 * HTML keeps its own structure; SVG is wrapped in a minimal page so it scales to the frame. The CSS marker is always
 * removed, and compiled CSS goes first in `<head>` so the document's own styles still win.
 */
export function renderVisDocument(source: string, kind: "html" | "svg", css: string | null) {
  const style = css === null ? "" : styleElement(css);
  if (kind === "svg") {
    return `<!doctype html><html><head>${style}<style>html,body{margin:0;height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style></head><body>${source.replace(CSS_MARKER, "")}</body></html>`;
  }
  const html = source.replace(CSS_MARKER, "");
  if (!style) return html;
  const head = /<head\b[^>]*>/iu.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${style}${html.slice(head.index + head[0].length)}`;
  const root = /<html\b[^>]*>/iu.exec(html);
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${style}</head>${html.slice(root.index + root[0].length)}`;
  return `<head>${style}</head>${html}`;
}
