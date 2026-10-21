/*
 * Exports:
 * - ReadingAnchorOptions: anchor picking, content-relative measurement, and correction boundary.
 * - default ThreadReadingAnchorController: keep what the reader sees still across any layout change above them.
 * - pickThreadReadingAnchor: the visible leaf at a scroller's reading line, the element whose content position the reader holds.
 * - pickThreadActivationAnchor: the element a reader holds after activating a control, never content a nested scroller moves.
 * - getThreadContentOffset: an anchor's layout position in the content, untouched by transforms and animations.
 */

export interface ReadingAnchorOptions<Anchor> {
  /** The element the reader is looking at, at the scroller's top edge; null when there is none. */
  readonly pick: () => Anchor | null;
  /** Anchor top relative to the scrolled content (independent of scroll position), or null once it left the content. */
  readonly offset: (anchor: Anchor) => number | null;
  /** Move the reader by `delta` so the anchor keeps its on-screen position; returns how much actually moved. */
  readonly shift: (delta: number) => number;
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

  /**
   * The reader activated `anchor`: what it reveals or removes lands below it instead of shoving it off screen, which a
   * reading-line anchor below it would do. Held until the reader next moves.
   */
  hold(anchor: Anchor) {
    this.#correct();
    this.#anchor = anchor;
    this.#offset = this.#options.offset(anchor);
  }

  /** Layout changed: put back whatever the anchor drifted by. */
  reconcile() {
    if (!this.#correct()) this.#pick();
  }

  #correct() {
    const offset = this.#anchor === null ? null : this.#options.offset(this.#anchor);
    if (offset === null || this.#offset === null) return false;
    const drift = offset - this.#offset;
    // A scroller at its edge cannot take all of a correction (nothing above scrollTop 0); what it could not take
    // stays owed, so the next change (the replacement for an unmounted chunk landing) puts the reader back exactly.
    if (Math.abs(drift) >= 0.5) this.#offset += this.#options.shift(drift);
    return true;
  }

  #pick() {
    this.#anchor = this.#options.pick();
    this.#offset = this.#anchor === null ? null : this.#options.offset(this.#anchor);
  }
}

/**
 * Only boxes the reader reads may hold their place: hidden ones (visibility, closed disclosures, skipped content)
 * keep geometry the reader never sees move, and `aria-hidden` boxes are chrome (spacers, reserves, markers) that move
 * on their own schedule, not with the text around them. SVG and other non-HTML boxes have no layout offsets to hold.
 */
function flowChildren(parent: Element): HTMLElement[] {
  const children: HTMLElement[] = [];
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement) || child.ariaHidden === "true") continue;
    const style = getComputedStyle(child);
    if (style.display === "contents") children.push(...flowChildren(child));
    else if (style.display !== "none" && !/^(?:sticky|fixed|absolute)$/.test(style.position)
      && child.checkVisibility?.({ visibilityProperty: true, contentVisibilityAuto: true }) !== false) children.push(child);
  }
  return children;
}

/** Only flow boxes are ordered: boxless wrappers and positioned siblings invalidate a raw DOM bisection. */
function firstChildReaching(parent: Element, line: number) {
  const children = flowChildren(parent);
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (children[middle].getBoundingClientRect().bottom > line) high = middle;
    else low = middle + 1;
  }
  // Zero-height boxes (turn markers, paging sentinels) sit at insertion points, so content prepended there would land
  // below them and never move the anchor.
  for (let index = low; index < children.length; index += 1) {
    const child = children[index];
    if (child.getBoundingClientRect().height <= 1) continue;
    return child;
  }
  return null;
}

/**
 * Content inside a nested scroller moves with that scroller's own scroll position, which the outer reader never
 * caused, so the scroller box is what they hold. Auto/scroll boxes count before they overflow: streaming output
 * starts short and scrolls later.
 */
function isNestedScroller(element: Element) {
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll"
    || (overflowY === "hidden" && element.scrollHeight > element.clientHeight);
}

/**
 * The leaf crossing the viewport's middle, the line the reader is reading. Prepends land near the top edge (reveals
 * start a screen ahead), so an edge anchor at the loaded top sits above them and corrects nothing.
 * Descends from the content root instead of hit-testing, so overlays never become the anchor.
 */
export function pickThreadReadingAnchor(viewport: HTMLElement, content: Element) {
  const line = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
  let anchor: HTMLElement | null = null;
  let next = firstChildReaching(content, line);
  while (next) {
    anchor = next;
    // A placeholder's skipped children have no reliable geometry; the placeholder itself holds the measured space.
    if (anchor.dataset.threadMeasuredContent === "placeholder" || isNestedScroller(anchor)) break;
    next = firstChildReaching(anchor, line);
  }
  return anchor;
}

/** What the reader holds after activating `control`: the control itself, or the outermost nested scroller carrying it. */
export function pickThreadActivationAnchor(control: HTMLElement, content: Element) {
  let anchor = control;
  for (let element = control.parentElement; element && element !== content; element = element.parentElement) {
    if (isNestedScroller(element)) anchor = element;
  }
  return anchor;
}

function layoutTop(element: HTMLElement) {
  let top = 0;
  for (let node: Element | null = element; node instanceof HTMLElement; node = node.offsetParent) {
    top += node.offsetTop + (node === element ? 0 : node.clientTop);
  }
  return top;
}

/**
 * Where an anchor sits in the content's layout. Transforms are left out: entry motion and slides move pixels for a
 * moment, never the reader's place, so measuring them would read an animation ending as drift and shove the reader.
 */
export function getThreadContentOffset(anchor: HTMLElement, content: HTMLElement) {
  return layoutTop(anchor) - layoutTop(content);
}
