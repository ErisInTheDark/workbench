/* Exports: none. Registers the private voice PCM worklet. */
import VoicePcmResampler from "./voice-pcm-resampler";

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof VoiceCaptureProcessor): void;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler: VoicePcmResampler;
  private ended = false;
  constructor() {
    super();
    this.resampler = new VoicePcmResampler(sampleRate, frame => {
      this.port.postMessage({ type: "pcm", frame: frame.buffer }, [frame.buffer]);
    });
    this.port.onmessage = event => {
      if (event.data?.type !== "finish" || this.ended) return;
      this.resampler.finish();
      this.ended = true;
      this.port.postMessage({ type: "flushed" });
    };
  }
  process(inputs: Float32Array[][]) {
    if (!this.ended && inputs[0]?.length) this.resampler.push(inputs[0]);
    return !this.ended;
  }
}
registerProcessor("workbench-voice-capture", VoiceCaptureProcessor);
