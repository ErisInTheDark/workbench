/*
 * Exports:
 * - REVEAL_WINDOW_MS: how long newly visible streamed text stays animating; covers every style's text motion.
 * - MarkdownRevealPiece: one run of rendered text and when its fade started, or null once settled.
 * - MarkdownRevealCursor: walks one render's visible text in document order and marks what is still fading in.
 * - default MarkdownRevealTimeline: remembers when each run of visible characters appeared, so fades survive re-renders and remounts.
 */

export const REVEAL_WINDOW_MS = 800;

interface RevealSegment {
  start: number;
  startedAt: number;
}

export interface MarkdownRevealPiece {
  /** Stable per fade so a run keeps its element while it grows. */
  key: string;
  startedAt: number | null;
  text: string;
}

export class MarkdownRevealCursor {
  readonly animates: boolean;
  readonly renderedAt: number;
  readonly #segments: readonly RevealSegment[];
  #offset = 0;

  constructor(segments: readonly RevealSegment[], renderedAt: number, animates: boolean) {
    this.#segments = segments;
    this.renderedAt = renderedAt;
    this.animates = animates;
  }

  /** Visible characters walked so far in this render. */
  get length() {
    return this.#offset;
  }

  #segmentIndexAt(offset: number) {
    let found = -1;
    for (let index = 0; index < this.#segments.length && this.#segments[index]!.start <= offset; index += 1) found = index;
    return found;
  }

  text(text: string): MarkdownRevealPiece[] {
    const start = this.#offset;
    const end = start + text.length;
    this.#offset = end;
    const pieces: MarkdownRevealPiece[] = [];
    for (let cursor = start; cursor < end;) {
      const segmentIndex = this.#segmentIndexAt(cursor);
      const segment = this.#segments[segmentIndex];
      const pieceEnd = Math.min(end, this.#segments[segmentIndex + 1]?.start ?? end);
      pieces.push({
        key: segment ? `reveal-${segment.start}` : "settled",
        startedAt: segment?.startedAt ?? null,
        text: text.slice(cursor - start, pieceEnd - start),
      });
      cursor = pieceEnd;
    }
    return pieces;
  }

  /** When the next visible character first appeared, or null once settled; a framed block starting here entered with it. */
  blockEntry() {
    return this.#segments[this.#segmentIndexAt(this.#offset)]?.startedAt ?? null;
  }

  /** An indivisible rendered token (icon, chip, mention) fades as a whole; returns its fade start, or null once settled. */
  atom(length = 1) {
    const start = this.#offset;
    this.#offset += Math.max(1, length);
    return this.#segments[this.#segmentIndexAt(start)]?.startedAt ?? null;
  }
}

export default class MarkdownRevealTimeline {
  #length: number | null;
  #segments: RevealSegment[] = [];

  /** `initialLength` null shows the first render settled; 0 fades everything first rendered in. */
  constructor(initialLength: number | null) {
    this.#length = initialLength;
  }

  cursor(now: number) {
    this.#segments = this.#segments.filter((segment) => now - segment.startedAt < REVEAL_WINDOW_MS);
    const open = this.#length === null ? [] : [{ start: this.#length, startedAt: now }];
    return new MarkdownRevealCursor([...this.#segments, ...open], now, this.#length !== null);
  }

  commit(cursor: MarkdownRevealCursor) {
    const length = cursor.length;
    if (this.#length === null || length < this.#length) {
      this.#segments = [];
    } else if (length > this.#length) {
      this.#segments.push({ start: this.#length, startedAt: cursor.renderedAt });
    }
    this.#length = length;
  }
}
