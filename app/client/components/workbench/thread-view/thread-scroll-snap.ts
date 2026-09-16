/*
 * Exports:
 * - getInitialThreadScrollTop: defer initial bottom placement until committed thread content has an end target.
 * - ThreadScrollDirection: latest meaningful thread scroll movement.
 * - ThreadScrollMetrics: viewport geometry used for end and layout-preservation decisions.
 * - ThreadScrollProximity: whether the viewport is inside its stronger bottom snap zone.
 * - resolveThreadScrollDirection: change direction only for user-owned scroll movement.
 * - resolveThreadTouchScrollDirection: translate finger travel into viewport direction.
 * - resolveThreadScrollProximity: classify remaining distance from the normal-flow bottom.
 * - isThreadScrollAtEnd: identify the normal-flow bottom boundary.
 * - didThreadScrollReattach: distinguish a bottom return from remaining attached.
 * - getPreservedThreadScrollTop: preserve reading position without competing with end re-snapping.
 */

export type ThreadScrollDirection = "down" | "up";
export type ThreadScrollProximity = "far" | "near";

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

export function didThreadScrollReattach(wasAtEnd: boolean, metrics: ThreadScrollMetrics) {
  return !wasAtEnd && isThreadScrollAtEnd(metrics);
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
