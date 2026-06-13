/*
 * Exports:
 * - isSingleBreakParagraph: detect a paragraph that represents one preserved visual line break. Keywords: workbench, list, paragraph, break.
 * - isIntentionalListBreakParagraph: detect preserved list-spacing paragraphs inserted between sibling lists. Keywords: workbench, list, break, paragraph.
 * - isListElement: narrow a DOM element to an ordered or unordered list. Keywords: workbench, list, dom, type guard.
 * - getDirectChildListElements: collect direct child lists without descending into nested structures. Keywords: workbench, list, children, dom.
 * - getDirectChildDetailsElement: find the direct details child used by structured list items. Keywords: workbench, list, details, dom.
 * - getDirectChildSummaryElement: find the direct summary child inside a details wrapper. Keywords: workbench, list, summary, dom.
 * - getNestedListElementsForItem: collect nested child lists for a list item, including details-wrapped children. Keywords: workbench, list, nesting, dom.
 * - getNestedBlockElementsForItem: collect nested child block elements for a list item, including details-wrapped children. Keywords: workbench, list, blocks, nesting, dom.
 */

export function isSingleBreakParagraph(element: HTMLElement) {
  if (element.tagName !== "P") {
    return false;
  }

  let breakCount = 0;

  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim()) {
        return false;
      }
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const childElement = node as Element;
    if (childElement.tagName !== "BR") {
      return false;
    }

    breakCount += 1;
  }

  return breakCount === 1;
}

export function isIntentionalListBreakParagraph(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement
    && element.dataset.listBreak === "true"
    && isSingleBreakParagraph(element);
}

export function isListElement(element: Element): element is HTMLUListElement | HTMLOListElement {
  return element.tagName === "UL" || element.tagName === "OL";
}

export function getDirectChildListElements(element: Element) {
  return Array.from(element.children).filter((child): child is HTMLUListElement | HTMLOListElement => isListElement(child));
}

export function getDirectChildDetailsElement(element: Element) {
  return Array.from(element.children).find((child): child is HTMLDetailsElement => child.tagName === "DETAILS") ?? null;
}

export function getDirectChildSummaryElement(element: Element) {
  return Array.from(element.children).find((child): child is HTMLElement => child.tagName === "SUMMARY") ?? null;
}

export function getNestedListElementsForItem(item: Element) {
  const details = getDirectChildDetailsElement(item);
  return details
    ? getDirectChildListElements(details)
    : getDirectChildListElements(item);
}

export function getNestedBlockElementsForItem(item: Element) {
  const details = getDirectChildDetailsElement(item);
  const container = details ?? item;
  const summary = details ? getDirectChildSummaryElement(details) : null;

  return Array.from(container.children).filter((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement) || child === summary) {
      return false;
    }

    return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|pre|hr|ul|ol)$/i.test(child.tagName);
  });
}
