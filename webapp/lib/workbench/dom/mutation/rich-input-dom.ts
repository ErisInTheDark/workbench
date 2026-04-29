/*
 * Exports:
 * - ensureListItemHasEditableContent: preserve an editable placeholder inside empty list items after structural transforms. Keywords: workbench, rich input, list item, editable, placeholder.
 * - ensureParagraphHasEditableContent: preserve an editable placeholder inside empty paragraphs after structural transforms. Keywords: workbench, rich input, paragraph, editable, placeholder.
 * - insertListItemAtParagraphPosition: replace a paragraph with a list item while merging adjacent unordered lists. Keywords: workbench, rich input, list item, paragraph, merge.
 */

export function ensureListItemHasEditableContent(item: HTMLLIElement) {
  const hasMeaningfulContent = (item.textContent ?? "").replaceAll("\u00a0", "").length > 0
    || item.querySelector("br, details, ul, ol, pre, blockquote, hr") !== null;

  if (hasMeaningfulContent) {
    return;
  }

  item.replaceChildren(document.createElement("br"));
}

export function ensureParagraphHasEditableContent(paragraph: HTMLElement) {
  if ((paragraph.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
    return;
  }

  if (paragraph.querySelector("br, ul, ol, pre, blockquote, hr") !== null) {
    return;
  }

  paragraph.replaceChildren(document.createElement("br"));
}

export function insertListItemAtParagraphPosition(paragraph: HTMLElement, item: HTMLLIElement) {
  const previousList = paragraph.previousElementSibling instanceof HTMLUListElement
    ? paragraph.previousElementSibling
    : null;
  const nextList = paragraph.nextElementSibling instanceof HTMLUListElement
    ? paragraph.nextElementSibling
    : null;

  if (previousList) {
    previousList.append(item);
    paragraph.remove();

    if (nextList) {
      while (nextList.firstChild) {
        previousList.append(nextList.firstChild);
      }
      nextList.remove();
    }
    return;
  }

  if (nextList) {
    nextList.prepend(item);
    paragraph.remove();
    return;
  }

  const list = document.createElement("ul");
  list.append(item);
  paragraph.replaceWith(list);
}