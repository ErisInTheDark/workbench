/*
 * Exports:
 * - default PressDragSliderController: own touch hold activation and one cancellable numeric preview gesture.
 * - PressDragSliderRange: committed value and discrete numeric bounds.
 */
export interface PressDragSliderRange {
  value: number;
  min: number;
  max: number;
  step: number;
}

function constrain(range: PressDragSliderRange, value: number) {
  return Math.max(range.min, Math.min(range.max, range.min + Math.round((value - range.min) / range.step) * range.step));
}

export default class PressDragSliderController {
  private gesture: { range: PressDragSliderRange; startY: number; height: number; trackTop?: number; moved: boolean; preview: number } | null = null;
  private hold: { x: number; y: number; latestY: number; cancel: () => void } | null = null;
  private readonly previewListeners = new Set<(value: number | null) => void>();

  constructor(private readonly schedule: (activate: () => void, delay: number) => () => void = (activate, delay) => {
    const timer = setTimeout(activate, delay);
    return () => clearTimeout(timer);
  }) {}

  get isActive() { return this.gesture !== null; }

  getPreview = () => this.gesture?.preview ?? null;

  subscribePreview = (listener: (value: number | null) => void) => {
    this.previewListeners.add(listener);
    return () => { this.previewListeners.delete(listener); };
  };

  private publishPreview(previous: number | null) {
    const value = this.getPreview();
    if (value !== previous) for (const listener of this.previewListeners) listener(value);
  }

  holdTouch(x: number, y: number, activate: (y: number) => void) {
    this.cancel();
    const hold = { x, y, latestY: y, cancel: () => {} };
    this.hold = hold;
    hold.cancel = this.schedule(() => {
      if (this.hold !== hold) return;
      this.hold = null;
      activate(hold.latestY);
    }, 500);
  }

  cancelTouchHoldAfterMovement(distance: number) {
    if (this.hold && distance > 8) this.cancel();
  }

  moveTouch(x: number, y: number) {
    if (this.hold) {
      this.hold.latestY = y;
      this.cancelTouchHoldAfterMovement(Math.hypot(x - this.hold.x, y - this.hold.y));
      return null;
    }
    return this.move(y);
  }

  begin(range: PressDragSliderRange, startY: number, height: number, trackTop?: number) {
    this.cancel();
    this.gesture = { range: { ...range }, startY, height: Math.max(1, height), trackTop, moved: false, preview: constrain(range, range.value) };
    this.publishPreview(null);
  }

  move(y: number) {
    const gesture = this.gesture;
    if (!gesture) return null;
    if (gesture.trackTop !== undefined && !gesture.moved && y === gesture.startY) return gesture.preview;
    gesture.moved = true;
    const value = gesture.trackTop === undefined
      ? gesture.range.value + (gesture.startY - y) / gesture.height * (gesture.range.max - gesture.range.min)
      : gesture.range.max - (y - gesture.trackTop) / gesture.height * (gesture.range.max - gesture.range.min);
    return this.setPreview(value);
  }

  setPreview(value: number) {
    if (!this.gesture) return null;
    const previous = this.gesture.preview;
    this.gesture.preview = constrain(this.gesture.range, value);
    this.publishPreview(previous);
    return this.gesture.preview;
  }

  commit() {
    const value = this.gesture?.preview ?? null;
    this.cancel();
    return value;
  }

  cancel() {
    const previous = this.getPreview();
    this.hold?.cancel();
    this.hold = null;
    this.gesture = null;
    this.publishPreview(previous);
  }

  keyboard(range: PressDragSliderRange, key: string) {
    const offsets: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    if (key === "Home") return range.min;
    if (key === "End") return range.max;
    return Object.hasOwn(offsets, key) ? constrain(range, range.value + offsets[key] * range.step) : null;
  }
}
