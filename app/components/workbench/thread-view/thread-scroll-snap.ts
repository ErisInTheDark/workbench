/*
 * Exports:
 * - getInitialThreadScrollTop: defer initial bottom placement until committed thread content has an end target.
 * - THREAD_COARSE_POINTER_MEDIA_QUERY: identify touch-first viewports needing managed scroll fallbacks.
 * - ThreadScrollDirection: latest meaningful thread scroll movement.
 * - ThreadScrollMetrics: viewport geometry used for end and layout-preservation decisions.
 * - ThreadScrollProximity: whether the viewport is inside its stronger bottom snap zone.
 * - resolveThreadScrollDirection: retain direction across unchanged offsets.
 * - resolveThreadEndFollowing: retain managed following until explicit upward movement.
 * - resolveThreadScrollProximity: classify remaining distance from the normal-flow bottom.
 * - isThreadScrollAtEnd: identify the normal-flow bottom boundary.
 * - getPreservedThreadScrollTop: preserve reading position without competing with end re-snapping.
 */

export type ThreadScrollDirection = "down" | "up";
export type ThreadScrollProximity = "far" | "near";

export const THREAD_COARSE_POINTER_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";

export interface ThreadScrollMetrics {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

export function getInitialThreadScrollTop(hasEndTarget: boolean, scrollHeight: number) {
  return hasEndTarget ? scrollHeight : null;
}

const THREAD_SCROLL_END_TOLERANCE_PX = 1;

function getMaximumScrollTop(metrics: ThreadScrollMetrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveThreadScrollDirection(
  currentDirection: ThreadScrollDirection,
  previousScrollTop: number,
  currentScrollTop: number,
): ThreadScrollDirection {
  if (currentScrollTop > previousScrollTop) return "down";
  if (currentScrollTop < previousScrollTop) return "up";
  return currentDirection;
}

export function resolveThreadEndFollowing(
  currentlyFollowing: boolean,
  direction: ThreadScrollDirection,
  proximity: ThreadScrollProximity,
) {
  if (direction === "up") return false;
  if (proximity === "near") return true;
  return currentlyFollowing;
}

export function resolveThreadScrollProximity(
  metrics: ThreadScrollMetrics,
  nearEndDistancePx: number,
): ThreadScrollProximity {
  return getMaximumScrollTop(metrics) - metrics.scrollTop < nearEndDistancePx
    ? "near"
    : "far";
}

export function isThreadScrollAtEnd(
  metrics: ThreadScrollMetrics,
  tolerancePx = THREAD_SCROLL_END_TOLERANCE_PX,
) {
  return getMaximumScrollTop(metrics) - metrics.scrollTop <= tolerancePx;
}

export function getPreservedThreadScrollTop(
  previousMetrics: ThreadScrollMetrics,
  currentMetrics: ThreadScrollMetrics,
) {
  if (isThreadScrollAtEnd(previousMetrics)) return null;
  return clamp(
    previousMetrics.scrollTop + currentMetrics.scrollHeight - previousMetrics.scrollHeight,
    0,
    getMaximumScrollTop(currentMetrics),
  );
}
