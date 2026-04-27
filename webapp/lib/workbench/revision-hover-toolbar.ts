/*
 * Exports:
 * - RevisionHoverKind: supported revision node kinds for comments, insertions, and deletions. Keywords: revision, hover, comment, insertion, deletion.
 * - RevisionToolbarKind: toolbar display kinds including mixed revision selections. Keywords: revision, toolbar, selection, mixed.
 * - RevisionToolbarContext: resolved revision target nodes and anchor rect for toolbar positioning. Keywords: revision, toolbar, context, rect.
 * - RevisionHoverToolbarControllerOptions: DOM dependencies and callbacks required to coordinate revision hover behavior. Keywords: revision, hover, controller, options, DOM.
 * - RevisionHoverToolbarController: public revision hover controller surface used by the workbench client. Keywords: revision, hover, controller, toolbar.
 * - createRevisionHoverToolbarController: create the revision hover and selection toolbar controller for the rich-text workbench editor. Keywords: revision, hover, selection, toolbar, controller.
 */

import { restoreCaretToMarker } from "./inline-format";

export type RevisionHoverKind = "comment" | "del" | "ins";
export type RevisionToolbarKind = RevisionHoverKind | "mixed";

export interface RevisionToolbarContext {
  kind: RevisionToolbarKind;
  nodes: HTMLElement[];
  rect: DOMRect;
}

interface VisualViewportMetrics {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface RevisionHoverToolbarControllerOptions {
  editor: HTMLElement;
  getExpandedRangeRect: (range: Range) => DOMRect;
  getMode: () => "rich" | "plain";
  getVisualViewportMetrics: () => VisualViewportMetrics;
  onSyncEditorAfterStructuralChange: () => void;
  revisionHoverAcceptButton: HTMLButtonElement;
  revisionHoverRejectButton: HTMLButtonElement;
  revisionHoverToolbar: HTMLElement;
}

export interface RevisionHoverToolbarController {
  applyHoveredRevisionAction: (action: "accept" | "reject") => void;
  getSelectedRevisionToolbarContext: () => RevisionToolbarContext | null;
  isPointerNearRevisionHoverUi: (clientX: number, clientY: number) => boolean;
  setHoveredRevisionNode: (node: HTMLElement | null) => void;
  updateRevisionHoverToolbar: () => void;
}

const REVISION_HOVER_PROXIMITY_PX = 18;

export function createRevisionHoverToolbarController(
  options: RevisionHoverToolbarControllerOptions,
): RevisionHoverToolbarController {
  const {
    editor,
    getExpandedRangeRect,
    getMode,
    getVisualViewportMetrics,
    onSyncEditorAfterStructuralChange,
    revisionHoverAcceptButton,
    revisionHoverRejectButton,
    revisionHoverToolbar,
  } = options;
  let hoveredRevisionNode: HTMLElement | null = null;
  let activeRevisionNodes = new Set<HTMLElement>();

  function setHoveredRevisionNode(node: HTMLElement | null) {
    if (hoveredRevisionNode === node) {
      updateRevisionHoverToolbar();
      return;
    }

    hoveredRevisionNode = node;
    updateRevisionHoverToolbar();
  }

  function getHoveredRevisionKind(element: HTMLElement | null): RevisionHoverKind | null {
    if (!element) {
      return null;
    }

    if (element.dataset.inlineComment === "true" || element.dataset.blockComment === "true") {
      return "comment";
    }

    const tag = element.tagName.toLowerCase();
    return tag === "del" || tag === "ins" ? tag : null;
  }

  function setActiveRevisionNodes(nodes: HTMLElement[]) {
    for (const element of activeRevisionNodes) {
      element.removeAttribute("data-revision-hover-active");
    }

    activeRevisionNodes = new Set(nodes);
    for (const element of activeRevisionNodes) {
      element.setAttribute("data-revision-hover-active", "true");
    }
  }

  function getRevisionToolbarKind(nodes: HTMLElement[]): RevisionToolbarKind | null {
    let hasComments = false;
    let hasInsertions = false;
    let hasDeletions = false;

    for (const node of nodes) {
      const kind = getHoveredRevisionKind(node);
      if (kind === "comment") {
        hasComments = true;
      } else if (kind === "ins") {
        hasInsertions = true;
      } else if (kind === "del") {
        hasDeletions = true;
      }
    }

    if (hasComments && (hasInsertions || hasDeletions)) {
      return null;
    }

    if (hasComments) {
      return "comment";
    }

    if (hasInsertions && hasDeletions) {
      return "mixed";
    }

    if (hasInsertions) {
      return "ins";
    }

    if (hasDeletions) {
      return "del";
    }

    return null;
  }

  function getSelectedRevisionToolbarContext(): RevisionToolbarContext | null {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount
      || selection.isCollapsed
      || getMode() !== "rich"
      || !editor.contains(selection.anchorNode)
      || !editor.contains(selection.focusNode)
    ) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const nodes = Array.from(editor.querySelectorAll<HTMLElement>('del, ins, [data-inline-comment="true"], [data-block-comment="true"]'))
      .filter((element) => range.intersectsNode(element));
    if (!nodes.length) {
      return null;
    }

    const kind = getRevisionToolbarKind(nodes);
    if (!kind) {
      return null;
    }

    const rect = getExpandedRangeRect(range);
    if (!rect.width && !rect.height) {
      return null;
    }

    return { kind, nodes, rect };
  }

  function getHoveredRevisionToolbarContext(): RevisionToolbarContext | null {
    const kind = getHoveredRevisionKind(hoveredRevisionNode);
    if (
      !kind
      || getMode() !== "rich"
      || !hoveredRevisionNode?.isConnected
      || !editor.contains(hoveredRevisionNode)
    ) {
      return null;
    }

    const rect = hoveredRevisionNode.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return null;
    }

    return {
      kind,
      nodes: [hoveredRevisionNode],
      rect,
    };
  }

  function isPointWithinExpandedRect(rect: DOMRect, clientX: number, clientY: number, padding: number) {
    return clientX >= rect.left - padding
      && clientX <= rect.right + padding
      && clientY >= rect.top - padding
      && clientY <= rect.bottom + padding;
  }

  function isPointerNearRevisionHoverUi(clientX: number, clientY: number) {
    const revisionKind = getHoveredRevisionKind(hoveredRevisionNode);
    if (!revisionKind || !hoveredRevisionNode?.isConnected || !editor.contains(hoveredRevisionNode)) {
      return false;
    }

    const targetRect = hoveredRevisionNode.getBoundingClientRect();
    if (targetRect.width || targetRect.height) {
      if (isPointWithinExpandedRect(targetRect, clientX, clientY, REVISION_HOVER_PROXIMITY_PX)) {
        return true;
      }
    }

    if (revisionHoverToolbar.hidden) {
      return false;
    }

    const toolbarRect = revisionHoverToolbar.getBoundingClientRect();
    return isPointWithinExpandedRect(toolbarRect, clientX, clientY, REVISION_HOVER_PROXIMITY_PX);
  }

  function updateRevisionHoverToolbar() {
    const context = getSelectedRevisionToolbarContext() ?? getHoveredRevisionToolbarContext();
    if (!context) {
      setActiveRevisionNodes([]);
      revisionHoverToolbar.hidden = true;
      delete revisionHoverToolbar.dataset.revisionKind;
      revisionHoverToolbar.style.background = "";
      revisionHoverAcceptButton.hidden = false;
      revisionHoverAcceptButton.textContent = "accept";
      revisionHoverAcceptButton.setAttribute("aria-label", "Accept revision");
      revisionHoverAcceptButton.title = "Accept revision";
      revisionHoverRejectButton.hidden = false;
      revisionHoverRejectButton.textContent = "reject";
      revisionHoverRejectButton.setAttribute("aria-label", "Reject revision");
      revisionHoverRejectButton.title = "Reject revision";
      return;
    }

    setActiveRevisionNodes(context.nodes);
    const isBulkSelection = context.nodes.length > 1;
    const acceptLabel = context.kind === "comment"
      ? isBulkSelection ? "Resolve selected comments" : "Resolve comment"
      : context.kind === "del"
      ? isBulkSelection ? "Accept selected deletions" : "Accept deletion"
      : context.kind === "ins"
        ? isBulkSelection ? "Accept selected insertions" : "Accept insertion"
        : "Accept selected revisions";
    const rejectLabel = context.kind === "del"
      ? isBulkSelection ? "Reject selected deletions" : "Reject deletion"
      : context.kind === "ins"
        ? isBulkSelection ? "Reject selected insertions" : "Reject insertion"
        : "Reject selected revisions";
    revisionHoverToolbar.dataset.revisionKind = context.kind;
    revisionHoverToolbar.style.background = context.kind === "comment"
      ? "color-mix(in srgb, var(--text) 10%, var(--bg) 90%)"
      : context.kind === "del"
      ? "color-mix(in srgb, var(--danger) 20%, var(--bg) 80%)"
      : context.kind === "ins"
        ? "color-mix(in srgb, var(--success) 20%, var(--bg) 80%)"
        : "color-mix(in srgb, #d0ad12 22%, var(--bg) 78%)";
    revisionHoverAcceptButton.hidden = false;
    revisionHoverAcceptButton.textContent = context.kind === "comment" ? "resolve" : "accept";
    revisionHoverAcceptButton.setAttribute("aria-label", acceptLabel);
    revisionHoverAcceptButton.title = acceptLabel;
    revisionHoverRejectButton.hidden = context.kind === "comment";
    revisionHoverRejectButton.textContent = "reject";
    revisionHoverRejectButton.setAttribute("aria-label", rejectLabel);
    revisionHoverRejectButton.title = rejectLabel;
    revisionHoverToolbar.hidden = false;

    const viewport = getVisualViewportMetrics();
    const contextTop = viewport.top + context.rect.top;
    const contextBottom = viewport.top + context.rect.bottom;
    if (contextBottom < viewport.top + 8 || contextTop > viewport.top + viewport.height - 8) {
      revisionHoverToolbar.hidden = true;
      return;
    }

    const leftEdge = viewport.left + 12;
    const rightEdge = viewport.left + viewport.width - revisionHoverToolbar.offsetWidth - 12;
    const x = Math.min(
      rightEdge,
      Math.max(leftEdge, viewport.left + context.rect.left + context.rect.width / 2 - revisionHoverToolbar.offsetWidth / 2),
    );
    const preferredTop = viewport.top + context.rect.top - revisionHoverToolbar.offsetHeight - 10;
    const fallbackTop = viewport.top + context.rect.bottom + 10;
    const maxTop = viewport.top + viewport.height - revisionHoverToolbar.offsetHeight - 12;
    const y = preferredTop >= viewport.top + 12
      ? preferredTop
      : Math.min(maxTop, fallbackTop);

    revisionHoverToolbar.style.left = `${x}px`;
    revisionHoverToolbar.style.top = `${Math.max(viewport.top + 12, y)}px`;
  }

  function applyHoveredRevisionAction(action: "accept" | "reject") {
    const context = getSelectedRevisionToolbarContext() ?? getHoveredRevisionToolbarContext();
    const targets = context?.nodes.filter((node) => node.parentNode && editor.contains(node)) ?? [];
    if (!targets.length) {
      setHoveredRevisionNode(null);
      return;
    }

    const firstTarget = targets[0];
    if (!firstTarget?.parentNode) {
      setHoveredRevisionNode(null);
      return;
    }

    const caretMarker = document.createElement("span");
    caretMarker.hidden = true;
    firstTarget.parentNode.insertBefore(caretMarker, firstTarget);
    setHoveredRevisionNode(null);
    setActiveRevisionNodes([]);

    for (const target of targets) {
      const revisionKind = getHoveredRevisionKind(target);
      const parent = target.parentNode;
      if (!revisionKind || !parent) {
        continue;
      }

      if (revisionKind === "comment") {
        target.remove();
        continue;
      }

      if ((revisionKind === "del" && action === "accept") || (revisionKind === "ins" && action === "reject")) {
        target.remove();
        continue;
      }

      while (target.firstChild) {
        parent.insertBefore(target.firstChild, target);
      }
      target.remove();
    }

    restoreCaretToMarker(caretMarker);
    onSyncEditorAfterStructuralChange();
  }

  return {
    applyHoveredRevisionAction,
    getSelectedRevisionToolbarContext,
    isPointerNearRevisionHoverUi,
    setHoveredRevisionNode,
    updateRevisionHoverToolbar,
  };
}