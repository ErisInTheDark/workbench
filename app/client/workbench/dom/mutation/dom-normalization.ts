/*
 * Exports:
 * - replaceTag: rewrite matching descendant elements to a canonical tag while preserving attributes and children. Keywords: workbench, dom, normalization, tag, canonicalization.
 * - unwrapTransparentSpans: remove style-only span wrappers while preserving summary and comment thread spans. Keywords: workbench, dom, normalization, span, cleanup.
 * - removeEmptyInlineFormatElements: prune empty inline formatting nodes unless the caller marks them as protected. Keywords: workbench, dom, normalization, inline format, cleanup.
 * - migrateLegacyCommentMarkup: turn comment text spans and blocks from saved drafts of the old editor into thread atoms.
 */

import { parseComment } from "../../markdown/comment-markdown";
import { createCommentThreadElement, isCommentThreadElement } from "../../markdown/review-markup";

export function migrateLegacyCommentMarkup(root: ParentNode) {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-block-comment="true"], [data-inline-comment="true"]'))) {
    const isBlock = element.dataset.blockComment === "true";
    const thread = createCommentThreadElement(element.ownerDocument, isBlock ? "block" : "inline", [
      parseComment((element.textContent ?? "").replaceAll(" ", " ")),
    ]);
    element.replaceWith(thread);
  }
}

export function replaceTag(root: ParentNode, sourceTag: string, targetTag: string) {
  for (const node of root.querySelectorAll(sourceTag)) {
    const replacement = document.createElement(targetTag);
    for (const attribute of node.getAttributeNames()) {
      replacement.setAttribute(attribute, node.getAttribute(attribute) ?? "");
    }
    replacement.innerHTML = node.innerHTML;
    node.replaceWith(replacement);
  }
}

export function unwrapTransparentSpans(root: ParentNode) {
  for (const span of Array.from(root.querySelectorAll("span"))) {
    if (!(span instanceof HTMLElement)) {
      continue;
    }

    if (span.dataset.summaryText === "true") {
      continue;
    }

    if (isCommentThreadElement(span)) {
      continue;
    }

    span.removeAttribute("style");

    if (span.getAttributeNames().length > 0) {
      continue;
    }

    while (span.firstChild) {
      span.parentNode?.insertBefore(span.firstChild, span);
    }
    span.remove();
  }
}

export function removeEmptyInlineFormatElements(
  tagNames: readonly string[],
  root: ParentNode,
  protectedElements: ReadonlySet<HTMLElement>,
) {
  if (!("querySelectorAll" in root) || !tagNames.length) {
    return;
  }

  const selector = tagNames.map((tagName) => tagName.toLowerCase()).join(", ");
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (protectedElements.has(element)) {
      continue;
    }

    if ((element.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
      continue;
    }

    element.remove();
  }
}