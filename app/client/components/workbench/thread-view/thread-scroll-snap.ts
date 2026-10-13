/*
 * Exports:
 * - getInitialThreadScrollTop: defer initial bottom placement until committed thread content has an end target.
 * - ThreadScrollDirection: latest meaningful thread scroll movement.
 * - ThreadScrollMetrics: viewport geometry used for end decisions.
 * - ThreadScrollProximity: whether the viewport is inside its stronger bottom snap zone.
 * - resolveThreadScrollDirection: change direction only for user-owned scroll movement.
 * - resolveThreadTouchScrollDirection: translate finger travel into viewport direction.
 * - resolveThreadScrollProximity: classify remaining distance from the registered end.
 * - isThreadScrollAtEnd: identify the end boundary including optional sticky clearance.
 * - didThreadScrollReattach: distinguish a bottom return from remaining attached.
 */

export type ThreadScrollDirection = "down" | "up";
export type ThreadScrollProximity = "far" | "near";

export interface ThreadScrollMetrics {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly endOffsetPx?: number;
}

export function getInitialThreadScrollTop(hasEndTarget: boolean, scrollHeight: number) {
  return hasEndTarget ? scrollHeight : null;
}

const THREAD_SCROLL_END_TOLERANCE_PX = 1;

function getEndScrollTop(metrics: ThreadScrollMetrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - (metrics.endOffsetPx ?? 0));
}

export function resolveThreadScrollDirection(
  currentDirection: ThreadScrollDirection,
  previousScrollTop: number,
  currentScrollTop: number,
  userOwnsMovement: boolean,
): ThreadScrollDirection {
  if (!userOwnsMovement) return currentDirection;
  if (currentScrollTop > previousScrollTop) return "down";
  if (currentScrollTop < previousScrollTop) return "up";
  return currentDirection;
}

export function resolveThreadTouchScrollDirection(
  currentDirection: ThreadScrollDirection,
  previousClientY: number,
  currentClientY: number,
): ThreadScrollDirection {
  if (currentClientY > previousClientY) return "up";
  if (currentClientY < previousClientY) return "down";
  return currentDirection;
}

export function resolveThreadScrollProximity(
  metrics: ThreadScrollMetrics,
): ThreadScrollProximity {
  return isThreadScrollAtEnd(metrics) ? "near" : "far";
}

export function isThreadScrollAtEnd(
  metrics: ThreadScrollMetrics,
  tolerancePx = THREAD_SCROLL_END_TOLERANCE_PX,
) {
  return getEndScrollTop(metrics) - metrics.scrollTop <= tolerancePx;
}

export function didThreadScrollReattach(wasAtEnd: boolean, metrics: ThreadScrollMetrics) {
  return !wasAtEnd && isThreadScrollAtEnd(metrics);
}
