/*
 * Exports:
 * - getDirectEditorParagraph: resolve a paragraph-like direct child of the editor root while excluding list-item content. Keywords: workbench, editor, paragraph, direct child, structure.
 */

export function getDirectEditorParagraph(editor: HTMLElement, node: Node | null) {
  let current: Node | null = node;

  while (current && current !== editor) {
    if (current instanceof HTMLLIElement) {
      return null;
    }

    if (
      current instanceof HTMLElement
      && current.parentNode === editor
      && /^(p|div)$/i.test(current.tagName)
    ) {
      return current;
    }

    current = current.parentNode;
  }

  return null;
}