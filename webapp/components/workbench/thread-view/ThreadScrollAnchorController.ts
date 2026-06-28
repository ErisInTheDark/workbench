/*
 * Exports:
 * - ThreadScrollMetrics: measured scroll dimensions for either the window or a contained thread scroll target. Keywords: thread, scroll, metrics, anchor.
 * - ThreadScrollSnapshot: captured scroll position used to preserve viewport position when older turns are prepended. Keywords: thread, scroll, snapshot, prepend.
 * - ThreadScrollTarget: scrollable owner for the thread view, either a DOM element or the window. Keywords: thread, scroll, target, window.
 * - ThreadScrollAnchorController: public controller surface for thread bottom stickiness, scroll metrics, and prepend restoration. Keywords: thread, scroll, bottom, sticky, controller.
 * - default ThreadScrollAnchorController: create the thread scroll anchoring controller that owns live-output follow intent. Keywords: thread, scroll, anchoring, lifecycle, default export.
 */

const THREAD_BOTTOM_ANCHOR_TOLERANCE_PX = 96;
const THREAD_HISTORY_LOAD_TOLERANCE_PX = 160;
const THREAD_SCROLL_DIRECTION_EPSILON_PX = 1;
const THREAD_SCROLL_TARGET_ATTRIBUTE = "data-thread-scroll-target";

export interface ThreadScrollMetrics {
  clientHeight: number;
  maxScrollTop: number;
  scrollHeight: number;
  scrollTop: number;
}

export type ThreadScrollTarget = HTMLElement | Window;

export interface ThreadScrollSnapshot {
  scrollHeight: number;
  scrollTop: number;
  target: ThreadScrollTarget;
}

export interface ThreadScrollAnchorController {
  captureSnapshot: (root: HTMLElement | null) => ThreadScrollSnapshot | null;
  findScrollTarget: (root: HTMLElement | null) => ThreadScrollTarget | null;
  getMetrics: (target: ThreadScrollTarget) => ThreadScrollMetrics;
  isNearBottom: (target: ThreadScrollTarget, tolerancePx?: number) => boolean;
  isNearTop: (target: ThreadScrollTarget, tolerancePx?: number) => boolean;
  restoreSnapshotAfterPrepend: (snapshot: ThreadScrollSnapshot) => void;
  resetForThreadSwitch: () => void;
  scrollRootToBottom: (root: HTMLElement | null) => boolean;
  setStickToBottom: (nextStickToBottom: boolean) => void;
  shouldStickToBottom: () => boolean;
  syncObservedScrollTop: (target: ThreadScrollTarget) => void;
  updateFromScroll: (target: ThreadScrollTarget) => ThreadScrollMetrics;
}

function isScrollableOverflowValue (value: string) {
  return value === "auto" || value === "scroll" || value === "overlay";
}

function getDocumentScrollingElement () {
  return document.scrollingElement ?? document.documentElement;
}

function isWindowScrollTarget (target: ThreadScrollTarget): target is Window {
  return target === window;
}

function setThreadScrollTop (target: ThreadScrollTarget, scrollTop: number) {
  const nextScrollTop = Math.max(0, scrollTop);
  if (isWindowScrollTarget(target)) {
    window.scrollTo({
      behavior: "auto",
      left: window.scrollX,
      top: nextScrollTop,
    });
    return;
  }

  target.scrollTop = nextScrollTop;
}

function ThreadScrollAnchorController (): ThreadScrollAnchorController {
  let lastObservedScrollTop: number | null = null;
  let stickToBottom = true;

  const findScrollTarget = (root: HTMLElement | null): ThreadScrollTarget | null => {
    if (!root || typeof window === "undefined") {
      return null;
    }

    for (let element = root.parentElement; element; element = element.parentElement) {
      if (element === document.body || element === document.documentElement) {
        break;
      }

      if (element.getAttribute(THREAD_SCROLL_TARGET_ATTRIBUTE) === "true") {
        return element;
      }

      if (isScrollableOverflowValue(window.getComputedStyle(element).overflowY)) {
        return element;
      }
    }

    return window;
  };

  const getMetrics = (target: ThreadScrollTarget): ThreadScrollMetrics => {
    if (isWindowScrollTarget(target)) {
      const scrollingElement = getDocumentScrollingElement();
      const scrollHeight = Math.max(
        scrollingElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      );
      const clientHeight = window.innerHeight || scrollingElement.clientHeight;
      const scrollTop = Math.max(window.scrollY, scrollingElement.scrollTop, document.body?.scrollTop ?? 0);
      return {
        clientHeight,
        maxScrollTop: Math.max(0, scrollHeight - clientHeight),
        scrollHeight,
        scrollTop,
      };
    }

    return {
      clientHeight: target.clientHeight,
      maxScrollTop: Math.max(0, target.scrollHeight - target.clientHeight),
      scrollHeight: target.scrollHeight,
      scrollTop: target.scrollTop,
    };
  };

  const isNearBottom = (
    target: ThreadScrollTarget,
    tolerancePx = THREAD_BOTTOM_ANCHOR_TOLERANCE_PX,
  ) => {
    const metrics = getMetrics(target);
    return metrics.maxScrollTop - metrics.scrollTop <= tolerancePx;
  };

  const isNearTop = (
    target: ThreadScrollTarget,
    tolerancePx = THREAD_HISTORY_LOAD_TOLERANCE_PX,
  ) => getMetrics(target).scrollTop <= tolerancePx;

  const syncObservedScrollTop = (target: ThreadScrollTarget) => {
    lastObservedScrollTop = getMetrics(target).scrollTop;
  };

  return {
    captureSnapshot: (root) => {
      const target = findScrollTarget(root);
      if (!target) {
        return null;
      }

      const metrics = getMetrics(target);
      return {
        scrollHeight: metrics.scrollHeight,
        scrollTop: metrics.scrollTop,
        target,
      };
    },
    findScrollTarget,
    getMetrics,
    isNearBottom,
    isNearTop,
    restoreSnapshotAfterPrepend: (snapshot) => {
      const nextMetrics = getMetrics(snapshot.target);
      setThreadScrollTop(snapshot.target, snapshot.scrollTop + (nextMetrics.scrollHeight - snapshot.scrollHeight));
      syncObservedScrollTop(snapshot.target);
      stickToBottom = false;
    },
    resetForThreadSwitch: () => {
      lastObservedScrollTop = null;
      stickToBottom = true;
    },
    scrollRootToBottom: (root) => {
      const target = findScrollTarget(root);
      if (!target) {
        return false;
      }

      setThreadScrollTop(target, getMetrics(target).maxScrollTop);
      syncObservedScrollTop(target);
      stickToBottom = true;
      return true;
    },
    setStickToBottom: (nextStickToBottom) => {
      stickToBottom = nextStickToBottom;
    },
    shouldStickToBottom: () => stickToBottom,
    syncObservedScrollTop,
    updateFromScroll: (target) => {
      const metrics = getMetrics(target);
      const isScrollingUp = lastObservedScrollTop !== null
        && metrics.scrollTop < lastObservedScrollTop - THREAD_SCROLL_DIRECTION_EPSILON_PX;
      if (isScrollingUp) {
        stickToBottom = false;
      } else if (isNearBottom(target)) {
        stickToBottom = true;
      }
      lastObservedScrollTop = metrics.scrollTop;
      return metrics;
    },
  };
}

export default ThreadScrollAnchorController;
