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
  private gesture: { range: PressDragSliderRange; startY: number; height: number; preview: number } | null = null;
  private hold: { x: number; y: number; latestY: number; cancel: () => void } | null = null;

  constructor(private readonly schedule: (activate: () => void, delay: number) => () => void = (activate, delay) => {
    const timer = setTimeout(activate, delay);
    return () => clearTimeout(timer);
  }) {}

  get isActive() { return this.gesture !== null; }

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

  begin(range: PressDragSliderRange, startY: number, height: number) {
    this.cancel();
    this.gesture = { range: { ...range }, startY, height: Math.max(1, height), preview: constrain(range, range.value) };
  }

  move(y: number) {
    const gesture = this.gesture;
    if (!gesture) return null;
    gesture.preview = constrain(gesture.range, gesture.range.value + (gesture.startY - y) / gesture.height * (gesture.range.max - gesture.range.min));
    return gesture.preview;
  }

  setPreview(value: number) {
    if (!this.gesture) return null;
    this.gesture.preview = constrain(this.gesture.range, value);
    return this.gesture.preview;
  }

  commit() {
    const value = this.gesture?.preview ?? null;
    this.cancel();
    return value;
  }

  cancel() {
    this.hold?.cancel();
    this.hold = null;
    this.gesture = null;
  }

  keyboard(range: PressDragSliderRange, key: string) {
    const offsets: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    if (key === "Home") return range.min;
    if (key === "End") return range.max;
    return Object.hasOwn(offsets, key) ? constrain(range, range.value + offsets[key] * range.step) : null;
  }
}
