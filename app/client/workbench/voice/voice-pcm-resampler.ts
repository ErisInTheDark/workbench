/*
 * Exports:
 * - default VoicePcmResampler: stateful mono area resampling and bounded PCM16 framing.
 */
export default class VoicePcmResampler {
  private area = 0;
  private weight = 0;
  private frame = new Int16Array(1600);
  private length = 0;
  private ended = false;
  constructor(private readonly rate: number, private readonly emit: (frame: Int16Array) => void) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 384000) throw new Error("Unsupported microphone sample rate.");
  }
  push(channels: readonly Float32Array[]) {
    if (this.ended || !channels.length) return;
    const length = Math.min(...channels.map(channel => channel.length));
    for (let index = 0; index < length; index++) {
      let sample = 0;
      for (const channel of channels) sample += Number.isFinite(channel[index]) ? channel[index]! : 0;
      sample /= channels.length;
      // Integer tick weights make output independent of worklet chunk boundaries.
      let remaining = 16000;
      while (remaining > 0) {
        const contribution = Math.min(remaining, this.rate - this.weight);
        this.area += sample * contribution;
        this.weight += contribution;
        remaining -= contribution;
        if (this.weight === this.rate) this.output();
      }
    }
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.weight) this.output();
    if (this.length) {
      this.emit(this.frame.slice(0, this.length));
      this.length = 0;
    }
  }
  private output() {
    const sample = Math.max(-1, Math.min(1, this.area / this.weight));
    this.frame[this.length++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
    this.area = 0;
    this.weight = 0;
    if (this.length === this.frame.length) {
      this.emit(this.frame);
      this.frame = new Int16Array(1600);
      this.length = 0;
    }
  }
}
