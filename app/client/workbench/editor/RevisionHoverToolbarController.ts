/*
 * Exports:
 * - RevisionHoverKind: inline revisions the floating toolbar resolves: insertions and deletions.
 * - RevisionToolbarKind: toolbar display kinds including mixed revision selections.
 * - RevisionToolbarContext: resolved revision target nodes and anchor rect for toolbar positioning.
 * - RevisionHoverToolbarControllerOptions: DOM dependencies and callbacks required to coordinate revision hover behaviour.
 * - default RevisionHoverToolbarController: the floating accept/reject toolbar shown above inline revisions under the
 *   caret or pointer. Block suggestions resolve from their own row instead.
 */

import type { VisualViewportMetrics } from "../dom/layout/viewport-metrics";
import { restoreCaretToMarker } from "./inline-leaves";

export type RevisionHoverKind = "del" | "ins";
export type RevisionToolbarKind = RevisionHoverKind | "mixed";

export interface RevisionToolbarContext {
  kind: RevisionToolbarKind;
  nodes: HTMLElement[];
  rect: DOMRect;
}

export interface RevisionHoverToolbarControllerOptions {
  canShowToolbar: () => boolean;
  editor: HTMLElement;
  getExpandedRangeRect: (range: Range) => DOMRect;
  getMinimumToolbarTop: (viewport: VisualViewportMetrics) => number;
  getMode: () => "rich" | "plain";
  getVisualViewportMetrics: () => VisualViewportMetrics;
  onSyncEditorAfterStructuralChange: (
    mutate: () => void,
    options?: { afterDomMutation?: () => void; afterSelectionRestore?: () => void },
  ) => void;
  revisionHoverAcceptButton: HTMLButtonElement;
  revisionHoverRejectButton: HTMLButtonElement;
  revisionHoverToolbar: HTMLElement;
}

interface RevisionHoverToolbarController {
  applyHoveredRevisionAction: (action: "accept" | "reject") => void;
  getSelectedRevisionToolbarContext: () => RevisionToolbarContext | null;
  isPointerNearRevisionHoverUi: (clientX: number, clientY: number) => boolean;
  setHoveredRevisionNode: (node: HTMLElement | null) => void;
  updateRevisionHoverToolbar: () => void;
}

const REVISION_HOVER_PROXIMITY_PX = 18;
const INLINE_REVISION_SELECTOR = "del, ins";

const TOOLBAR_APPEARANCE: Record<RevisionToolbarKind, { accept: string; background: string; reject: string }> = {
  del: { accept: "Accept deletion", background: "color-mix(in srgb, var(--danger) 20%, var(--bg) 80%)", reject: "Reject deletion" },
  ins: { accept: "Accept insertion", background: "color-mix(in srgb, var(--success) 20%, var(--bg) 80%)", reject: "Reject insertion" },
  mixed: { accept: "Accept selected revisions", background: "color-mix(in srgb, #d0ad12 22%, var(--bg) 78%)", reject: "Reject selected revisions" },
};

function RevisionHoverToolbarController(
  options: RevisionHoverToolbarControllerOptions,
): RevisionHoverToolbarController {
  const {
    canShowToolbar,
    editor,
    getExpandedRangeRect,
    getMinimumToolbarTop,
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
    hoveredRevisionNode = node;
    updateRevisionHoverToolbar();
  }

  function getRevisionKind(element: HTMLElement | null): RevisionHoverKind | null {
    const tag = element?.tagName.toLowerCase();
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

  function getMixedKind(nodes: HTMLElement[]): RevisionToolbarKind | null {
    const kinds = new Set(nodes.map(getRevisionKind));
    if (kinds.has("ins") && kinds.has("del")) return "mixed";
    if (kinds.has("ins")) return "ins";
    if (kinds.has("del")) return "del";
    return null;
  }

  function closestRevision(node: Node | null) {
    const element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    const match = element?.closest<HTMLElement>(INLINE_REVISION_SELECTOR) ?? null;
    return match && editor.contains(match) ? match : null;
  }

  function getSelectedRevisionToolbarContext(): RevisionToolbarContext | null {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount
      || getMode() !== "rich"
      || !editor.contains(selection.anchorNode)
      || !editor.contains(selection.focusNode)
    ) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (selection.isCollapsed) {
      const inline = closestRevision(range.startContainer);
      const kind = getRevisionKind(inline);
      const rect = inline?.getBoundingClientRect();
      return inline && kind && rect && (rect.width || rect.height) ? { kind, nodes: [inline], rect } : null;
    }

    const nodes = Array.from(editor.querySelectorAll<HTMLElement>(INLINE_REVISION_SELECTOR))
      .filter((element) => range.intersectsNode(element));
    const kind = nodes.length ? getMixedKind(nodes) : null;
    const rect = getExpandedRangeRect(range);
    return kind && (rect.width || rect.height) ? { kind, nodes, rect } : null;
  }

  function getHoveredRevisionToolbarContext(): RevisionToolbarContext | null {
    const kind = getRevisionKind(hoveredRevisionNode);
    if (!kind || getMode() !== "rich" || !hoveredRevisionNode?.isConnected || !editor.contains(hoveredRevisionNode)) {
      return null;
    }

    const rect = hoveredRevisionNode.getBoundingClientRect();
    return rect.width || rect.height ? { kind, nodes: [hoveredRevisionNode], rect } : null;
  }

  function isPointWithinExpandedRect(rect: DOMRect, clientX: number, clientY: number, padding: number) {
    return clientX >= rect.left - padding
      && clientX <= rect.right + padding
      && clientY >= rect.top - padding
      && clientY <= rect.bottom + padding;
  }

  function isPointerNearRevisionHoverUi(clientX: number, clientY: number) {
    const context = getHoveredRevisionToolbarContext();
    if (context && isPointWithinExpandedRect(context.rect, clientX, clientY, REVISION_HOVER_PROXIMITY_PX)) {
      return true;
    }

    return !revisionHoverToolbar.hidden
      && isPointWithinExpandedRect(revisionHoverToolbar.getBoundingClientRect(), clientX, clientY, REVISION_HOVER_PROXIMITY_PX);
  }

  function hideToolbar() {
    setActiveRevisionNodes([]);
    revisionHoverToolbar.hidden = true;
    delete revisionHoverToolbar.dataset.revisionKind;
    revisionHoverToolbar.style.background = "";
  }

  function updateRevisionHoverToolbar() {
    const context = canShowToolbar() ? getSelectedRevisionToolbarContext() ?? getHoveredRevisionToolbarContext() : null;
    if (!context) {
      hideToolbar();
      return;
    }

    setActiveRevisionNodes(context.nodes);
    const appearance = TOOLBAR_APPEARANCE[context.kind];
    revisionHoverToolbar.dataset.revisionKind = context.kind;
    revisionHoverToolbar.style.background = appearance.background;
    revisionHoverAcceptButton.setAttribute("aria-label", appearance.accept);
    revisionHoverAcceptButton.title = appearance.accept;
    revisionHoverRejectButton.setAttribute("aria-label", appearance.reject);
    revisionHoverRejectButton.title = appearance.reject;
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
    const minimumTop = getMinimumToolbarTop(viewport);
    const y = preferredTop >= minimumTop
      ? preferredTop
      : Math.min(maxTop, Math.max(minimumTop, fallbackTop));

    revisionHoverToolbar.style.left = `${x}px`;
    revisionHoverToolbar.style.top = `${Math.max(minimumTop, y)}px`;
  }

  function applyHoveredRevisionAction(action: "accept" | "reject") {
    const context = getSelectedRevisionToolbarContext() ?? getHoveredRevisionToolbarContext();
    const targets = context?.nodes.filter((node) => node.parentNode && editor.contains(node)) ?? [];
    setHoveredRevisionNode(null);
    setActiveRevisionNodes([]);
    if (!targets.length) {
      return;
    }

    const caretMarker = document.createElement("span");
    caretMarker.hidden = true;
    targets[0]!.parentNode!.insertBefore(caretMarker, targets[0]!);

    onSyncEditorAfterStructuralChange(() => {
      for (const target of targets) {
        const revisionKind = getRevisionKind(target);
        const parent = target.parentNode;
        if (!revisionKind || !parent) {
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
    }, {
      afterDomMutation: () => {
        restoreCaretToMarker(caretMarker);
      },
    });
  }

  return {
    applyHoveredRevisionAction,
    getSelectedRevisionToolbarContext,
    isPointerNearRevisionHoverUi,
    setHoveredRevisionNode,
    updateRevisionHoverToolbar,
  };
}

export default RevisionHoverToolbarController;
