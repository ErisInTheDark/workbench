/*
 * Exports:
 * - ThreadScrollMode: name the viewport's bottom-following and reading layouts.
 * - ThreadScrollMetrics: capture the dimensions and offset needed to classify or convert scroll state.
 * - default ThreadScrollMode: classify reader movement, convert coordinates, and identify the bottom boundary.
 */

export type ThreadScrollMode = "bottom-following" | "reading";

export interface ThreadScrollMetrics {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

const THREAD_SCROLL_BOTTOM_TOLERANCE_PX = 1;

function getMaximumScrollTop(metrics: ThreadScrollMetrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

const ThreadScrollMode = {
  didMoveAwayFromBottom(
    mode: ThreadScrollMode,
    previousMetrics: ThreadScrollMetrics,
    currentMetrics: ThreadScrollMetrics,
  ) {
    if (
      previousMetrics.clientHeight !== currentMetrics.clientHeight
      || previousMetrics.scrollHeight !== currentMetrics.scrollHeight
    ) {
      return false;
    }
    return ThreadScrollMode.toTopOriginOffset(mode, currentMetrics)
      < ThreadScrollMode.toTopOriginOffset(mode, previousMetrics);
  },
  isAtBottom(mode: ThreadScrollMode, metrics: ThreadScrollMetrics, tolerancePx = THREAD_SCROLL_BOTTOM_TOLERANCE_PX) {
    const maximumScrollTop = getMaximumScrollTop(metrics);
    return maximumScrollTop - ThreadScrollMode.toTopOriginOffset(mode, metrics) <= tolerancePx;
  },
  scrollTopForTopOriginOffset(mode: ThreadScrollMode, topOriginOffset: number, metrics: ThreadScrollMetrics) {
    const maximumScrollTop = getMaximumScrollTop(metrics);
    const clampedOffset = clamp(topOriginOffset, 0, maximumScrollTop);
    return mode === "bottom-following"
      ? clampedOffset - maximumScrollTop
      : clampedOffset;
  },
  toTopOriginOffset(mode: ThreadScrollMode, metrics: ThreadScrollMetrics) {
    const maximumScrollTop = getMaximumScrollTop(metrics);
    const offset = mode === "bottom-following"
      ? maximumScrollTop + metrics.scrollTop
      : metrics.scrollTop;
    return clamp(offset, 0, maximumScrollTop);
  },
};

export default ThreadScrollMode;
