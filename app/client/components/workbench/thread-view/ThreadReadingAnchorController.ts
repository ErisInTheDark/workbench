/*
 * Exports:
 * - ReadingAnchorOptions: anchor picking, content-relative measurement, and correction boundary.
 * - default ThreadReadingAnchorController: keep what the reader sees still across any layout change above them.
 * - pickThreadReadingAnchor: the leaf at a scroller's reading line, the element whose content position the reader holds.
 */

export interface ReadingAnchorOptions<Anchor> {
  /** The element the reader is looking at, at the scroller's top edge; null when there is none. */
  readonly pick: () => Anchor | null;
  /** Anchor top relative to the scrolled content (independent of scroll position), or null once it left the content. */
  readonly offset: (anchor: Anchor) => number | null;
  /** Move the reader by `delta` so the anchor keeps its on-screen position. */
  readonly shift: (delta: number) => void;
}

/**
 * Content keeps settling for several frames after it mounts (async data, nested measurement, windowed remounts),
 * so one-off compensation at each mutation misses the later ticks. Reconciling on every layout change before paint
 * corrects every frame, whatever moved, without the content having to be final.
 */
export default class ThreadReadingAnchorController<Anchor> {
  readonly #options: ReadingAnchorOptions<Anchor>;
  #anchor: Anchor | null = null;
  #offset: number | null = null;

  constructor(options: ReadingAnchorOptions<Anchor>) {
    this.#options = options;
  }

  /**
   * The reader moved: anchor to what is at their top edge now. Scroll events dispatch before the frame's resize
   * observers, so layout that changed since the last correction is put back first instead of being adopted.
   */
  record() {
    this.#correct();
    this.#pick();
  }

  /** Layout changed: put back whatever the anchor drifted by. */
  reconcile() {
    if (!this.#correct()) this.#pick();
  }

  #correct() {
    const offset = this.#anchor === null ? null : this.#options.offset(this.#anchor);
    if (offset === null || this.#offset === null) return false;
    const drift = offset - this.#offset;
    this.#offset = offset;
    if (Math.abs(drift) >= 0.5) this.#options.shift(drift);
    return true;
  }

  #pick() {
    this.#anchor = this.#options.pick();
    this.#offset = this.#anchor === null ? null : this.#options.offset(this.#anchor);
  }
}

/** Children of an in-flow block are ordered by position, so the first one reaching `line` is found by bisection. */
function firstChildReaching(parent: Element, line: number) {
  const children = parent.children;
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (children[middle].getBoundingClientRect().bottom > line) high = middle;
    else low = middle + 1;
  }
  // Sticky, fixed and absolute boxes sit where scrolling puts them, not in content order: anchor to flow content.
  // Zero-height boxes (turn markers, paging sentinels) sit at insertion points, so content prepended there would land
  // below them and never move the anchor.
  for (let index = low; index < children.length; index += 1) {
    const child = children[index];
    if (child.getBoundingClientRect().height <= 1) continue;
    if (!/^(?:sticky|fixed|absolute)$/.test(getComputedStyle(child).position)) return child;
  }
  return null;
}

/**
 * The leaf crossing the viewport's middle, the line the reader is reading. Prepends land near the top edge (reveals
 * start a screen ahead), so an edge anchor at the loaded top sits above them and corrects nothing.
 * Descends from the content root instead of hit-testing, so overlays never become the anchor.
 */
export function pickThreadReadingAnchor(viewport: HTMLElement, content: Element) {
  const line = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
  let anchor: Element | null = null;
  let next = firstChildReaching(content, line);
  while (next) {
    anchor = next;
    // A placeholder's skipped children have no reliable geometry; the placeholder itself holds the measured space.
    if (anchor instanceof HTMLElement && anchor.dataset.threadMeasuredContent === "placeholder") break;
    next = firstChildReaching(anchor, line);
  }
  return anchor;
}
