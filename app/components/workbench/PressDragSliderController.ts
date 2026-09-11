/*
 * Exports:
 * - default PressDragSliderController: own one cancellable numeric preview gesture.
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

  begin(range: PressDragSliderRange, startY: number, height: number) {
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
    this.gesture = null;
    return value;
  }

  cancel() { this.gesture = null; }

  keyboard(range: PressDragSliderRange, key: string) {
    const offsets: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    if (key === "Home") return range.min;
    if (key === "End") return range.max;
    return Object.hasOwn(offsets, key) ? constrain(range, range.value + offsets[key] * range.step) : null;
  }
}
