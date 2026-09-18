/*
 * Exports:
 * - VoiceCaptureSounds: decoded local recording cues.
 * - VoiceCaptureOptions: browser media ports and PCM callbacks.
 * - default VoiceCaptureController: HTTPS availability, microphone permission, audio graph, flush and cancellation.
 */
export interface VoiceCaptureSounds { on: AudioBuffer; off: AudioBuffer }
export interface VoiceCaptureOptions {
  workletUrl: string;
  onFrame: (frame: Int16Array) => void;
  onError: (error: Error) => void;
  getUserMedia?: () => Promise<MediaStream>;
  createContext?: () => AudioContext;
  createNode?: (context: AudioContext) => AudioWorkletNode;
  loadSounds?: (context: AudioContext, signal: AbortSignal) => Promise<VoiceCaptureSounds>;
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
  private stopping: Promise<void> | null = null;
  private release: { timer: ReturnType<typeof setTimeout>; resolve(): void } | null = null;
  private readonly loading = new AbortController();
  private sounds: VoiceCaptureSounds | null = null;
  private cue: (() => void) | null = null;
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
      try {
        this.sounds = await (this.options.loadSounds ?? (async (audio, signal) => {
          const load = async (name: string) => {
            const response = await fetch(`/audio/${name}.mp3`, { signal });
            if (!response.ok) throw new Error("Recording cue download failed.");
            return audio.decodeAudioData(await response.arrayBuffer());
          };
          const [on, off] = await Promise.all([load("on"), load("off")]);
          return { on, off };
        }))(context, this.loading.signal);
      } catch {
        if (!this.loading.signal.aborted) console.warn("[voice] recording sounds unavailable");
      }
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
      if (this.sounds) void this.playCue(context, this.sounds.on);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      await this.cancel();
      throw error;
    }
  }
  finish() {
    return this.finished ??= (async () => {
      const generation = this.generation;
      if (this.node) {
        await new Promise<void>(resolve => {
          this.release = { timer: setTimeout(() => { this.release = null; resolve(); }, 500), resolve };
        });
      }
      if (generation !== this.generation) { await this.stopping; return; }
      if (this.node) {
        await new Promise<void>(resolve => {
          this.flushed = resolve;
          this.node!.port.postMessage({ type: "finish" });
        });
      }
      await this.cancel();
    })();
  }
  cancel() {
    return this.stopping ??= this.stop();
  }
  private async stop() {
    this.generation++;
    this.loading.abort();
    if (this.release) {
      clearTimeout(this.release.timer);
      this.release.resolve();
      this.release = null;
    }
    this.flushed?.();
    this.flushed = null;
    const wasRecording = this.node !== null;
    this.node?.disconnect();
    this.node?.port.close();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const context = this.context;
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.cue?.();
    try {
      if (context && wasRecording && this.sounds) await this.playCue(context, this.sounds.off);
    } finally {
      this.sounds = null;
      if (context && context.state !== "closed") await context.close();
    }
  }
  private playCue(context: AudioContext, buffer: AudioBuffer): Promise<void> {
    this.cue?.();
    if (context.state !== "running") {
      console.warn("[voice] recording sound skipped because audio output is suspended");
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let source: AudioBufferSourceNode | null = null;
      let started = false;
      const done = () => {
        if (this.cue !== done) return;
        this.cue = null;
        context.removeEventListener("statechange", stateChanged);
        if (source) {
          source.onended = null;
          if (started) source.stop();
          source.disconnect();
        }
        resolve();
      };
      const stateChanged = () => { if (context.state !== "running") done(); };
      this.cue = done;
      try {
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = done;
        context.addEventListener("statechange", stateChanged);
        source.start();
        started = true;
      } catch {
        console.warn("[voice] recording sound could not play");
        done();
      }
    });
  }
}
