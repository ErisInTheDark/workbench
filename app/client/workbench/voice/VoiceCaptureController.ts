/*
 * Exports:
 * - VoiceCaptureOptions: browser media ports and PCM callbacks.
 * - default VoiceCaptureController: HTTPS availability, microphone permission, audio graph, flush and cancellation.
 */
export interface VoiceCaptureOptions {
  workletUrl: string;
  onFrame: (frame: Int16Array) => void;
  onError: (error: Error) => void;
  getUserMedia?: () => Promise<MediaStream>;
  createContext?: () => AudioContext;
  createNode?: (context: AudioContext) => AudioWorkletNode;
}
export default class VoiceCaptureController {
  static isSupported() {
    return globalThis.location?.protocol === "https:"
      && globalThis.isSecureContext === true
      && typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function";
  }

  private generation = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private flushed: (() => void) | null = null;
  private finished: Promise<void> | null = null;
  constructor(private readonly options: VoiceCaptureOptions) {}
  async start(ready: Promise<void> = Promise.resolve()) {
    if (!this.options.getUserMedia && !VoiceCaptureController.isSupported()) {
      throw new Error("Voice input requires secure HTTPS and browser microphone support.");
    }
    const generation = ++this.generation;
    const context = (this.options.createContext ?? (() => new AudioContext()))();
    this.context = context;
    try {
      await context.resume();
      if (generation !== this.generation) return false;
      const stream = await (this.options.getUserMedia ?? (() => navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })))();
      if (generation !== this.generation) { for (const track of stream.getTracks()) track.stop(); return false; }
      this.stream = stream;
      await ready;
      if (generation !== this.generation) return false;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (generation === this.generation) this.options.onError(new Error("Microphone capture ended."));
      }, { once: true });
      await context.audioWorklet.addModule(this.options.workletUrl);
      if (generation !== this.generation) return false;
      const node = (this.options.createNode ?? (context => new AudioWorkletNode(context, "workbench-voice-capture")))(context);
      this.node = node;
      node.onprocessorerror = () => this.options.onError(new Error("Microphone audio processor failed."));
      node.port.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data?.type === "pcm" && event.data.frame instanceof ArrayBuffer) {
          this.options.onFrame(new Int16Array(event.data.frame));
        } else if (event.data?.type === "flushed") {
          this.flushed?.();
          this.flushed = null;
        } else this.options.onError(new Error("Invalid microphone processor response."));
      };
      const source = context.createMediaStreamSource(stream);
      this.source = source;
      source.connect(node);
      // The processor writes only silence to its output, keeping it scheduled without feedback.
      node.connect(context.destination);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      await this.cancel();
      throw error;
    }
  }
  finish() {
    return this.finished ??= (async () => {
      if (this.node) {
        await new Promise<void>(resolve => {
          this.flushed = resolve;
          this.node!.port.postMessage({ type: "finish" });
        });
      }
      await this.cancel();
    })();
  }
  async cancel() {
    this.generation++;
    this.flushed?.();
    this.flushed = null;
    this.node?.disconnect();
    this.node?.port.close();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const context = this.context;
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }
}
