/*
 * Exports:
 * - visibleWords: whitespace-separated words a reader sees in a DOM subtree, treating blocks, line breaks and inline comments as separators.
 * - renderedWords: visibleWords of HTML parsed into a detached container, before any editor normalization runs.
 */

const SEPARATING_TAGS = /^(P|DIV|H[1-6]|BLOCKQUOTE|LI|UL|OL|PRE|HR|BR|SUMMARY|DETAILS|TABLE|TR|TD|TH)$/u;
/** Block syntax typed as text (fences, heading/list/quote markers, rules) legitimately becomes structure, so it is not a word. */
const MARKDOWN_SYNTAX_TOKEN = /^(?:(?:`{3,}|~{3,})[\w-]*|#{1,6}|[-*+>]|\d+[.)]|-{3,})$/u;

/** Inline comments always sit apart from neighbouring words in markdown, so they separate words too. */
export function visibleWords(root: Node) {
  let text = "";
  const visit = (node: Node) => {
    if (node instanceof Text) {
      text += node.data;
      return;
    }
    if (!(node instanceof HTMLElement) || node.hidden) return;
    const separates = SEPARATING_TAGS.test(node.tagName) || node.dataset.inlineComment === "true";
    if (separates) text += " ";
    node.childNodes.forEach(visit);
    if (separates) text += " ";
  };
  root.childNodes.forEach(visit);
  return text.split(/[\s ]+/u).filter(word => word && !MARKDOWN_SYNTAX_TOKEN.test(word));
}

export function renderedWords(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  return visibleWords(container);
}
