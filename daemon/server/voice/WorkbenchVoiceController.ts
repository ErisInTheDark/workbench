/*
 * Exports:
 * - WorkbenchVoiceOptions: owned recognition, configuration and provider boundaries.
 * - default WorkbenchVoiceController: connection-bound audio, transformer and final drain.
 */
import type { VoiceModelSelection } from "workbench-shared/workbench/voice/voice-session-contract";
import type { VoiceEvent, VoiceRequest } from "workbench-shared/workbench/voice/voice-contract";
import type { VoiceAudio, VoiceSessionEvent, VoiceStart } from "workbench-shared/workbench/voice/voice-session-contract";
import type { SingleFileEvent, WorkbenchProviderSingleFile } from "workbench-shared/workbench/provider/provider-single-file";
import { decodeVoiceDocument } from "workbench-shared/workbench/voice/voice-document";
import VoiceTranscriptDelivery from "./VoiceTranscriptDelivery";
import VoiceAudioRecording from "./VoiceAudioRecording";

export interface WorkbenchVoiceOptions {
  recognizer: { prepare(): Promise<void>; send(request: VoiceRequest): Promise<void>; dispose(): Promise<void> };
  resolveSettings(): Promise<VoiceModelSelection>;
  provider(settings: VoiceModelSelection): WorkbenchProviderSingleFile;
  instructions(settings: VoiceModelSelection): Promise<string>;
  recording?(directory: string): Pick<VoiceAudioRecording, "prepare" | "append" | "close">;
}
interface Session {
  id: string;
  connection: string;
  emit: (event: VoiceSessionEvent) => void;
  state: "preparing" | "listening" | "finishing" | "cancelled";
  sequence: number;
  provider: WorkbenchProviderSingleFile | null;
  delivery: VoiceTranscriptDelivery | null;
  recording: Pick<VoiceAudioRecording, "prepare" | "append" | "close"> | null;
  start: Promise<void>;
  nativeDone: Promise<void>;
  completeNative: () => void;
}
export default class WorkbenchVoiceController {
  private session: Session | null = null;
  private disposed = false;
  constructor(private readonly options: WorkbenchVoiceOptions) {}
  async prepare() {
    const settings = await this.options.resolveSettings();
    await Promise.all([this.options.recognizer.prepare(), this.options.provider(settings).prepare()]);
  }
  async start(connection: string, input: VoiceStart, emit: Session["emit"]) {
    if (this.disposed) throw new Error("Voice is reloading.");
    if (this.session) throw new Error("Voice is already in use.");
    let completeNative!: () => void;
    const nativeDone = new Promise<void>(resolve => { completeNative = resolve; });
    const session: Session = {
      id: input.sessionId, connection, emit, state: "preparing", sequence: 0,
      provider: null, delivery: null, recording: null, start: Promise.resolve(), nativeDone, completeNative,
    };
    this.session = session;
    emit({ type: "status", sessionId: session.id, state: "preparing" });
    session.start = (async () => {
      try {
        const settings = await this.options.resolveSettings();
        const provider = this.options.provider(settings);
        session.provider = provider;
        const [instructions] = await Promise.all([this.options.instructions(settings), this.options.recognizer.prepare()]);
        if (!this.isActive(session)) return;
        const files = await provider.start({
          sessionId: session.id, text: input.text, settings, instructions,
          validateDocument: decodeVoiceDocument, onEvent: event => this.transformer(session, event),
        });
        if (!this.isActive(session)) { await provider.cancel(session.id); return; }
        if (input.recordAudio) {
          session.recording = this.options.recording?.(files.directory) ?? new VoiceAudioRecording(files.directory);
          await session.recording.prepare();
          if (!this.isActive(session)) return;
        }
        session.delivery = new VoiceTranscriptDelivery(packet => provider.input(session.id, packet), error => {
          if (this.isActive(session)) this.fail(error);
        });
        await this.options.recognizer.send({ type: "start", sessionId: session.id });
        if (!this.isActive(session)) return;
        session.state = "listening";
        emit({ type: "status", sessionId: session.id, state: "listening" });
      } catch (error) {
        if (this.isActive(session)) this.fail(error instanceof Error ? error : new Error("Voice startup failed."));
        throw error;
      }
    })();
    await session.start;
  }
  async audio(connection: string, input: VoiceAudio) {
    const session = this.owned(connection, input.sessionId);
    if (session.state !== "listening" || input.sequence !== session.sequence) throw new Error("Voice audio is out of order or capture has ended.");
    session.sequence++;
    try {
      await session.recording?.append(Buffer.from(input.pcm, "base64"));
      if (!this.isActive(session)) return;
      await this.options.recognizer.send({ type: "audio", sessionId: input.sessionId, pcm: input.pcm });
    } catch (error) {
      if (this.isActive(session)) this.fail(error instanceof Error ? error : new Error("Voice audio admission failed."));
      throw error;
    }
  }
  async finish(connection: string, sessionId: string) {
    const session = this.owned(connection, sessionId);
    await session.start;
    if (!this.isActive(session)) return;
    session.state = "finishing";
    session.emit({ type: "status", sessionId, state: "finishing" });
    try {
      await this.options.recognizer.send({ type: "finish", sessionId });
      await session.nativeDone;
      if (!this.isActive(session)) return;
      await session.delivery!.finish();
      await session.recording?.close();
      if (!this.isActive(session)) return;
      await session.provider!.finish(sessionId);
      if (!this.isActive(session)) return;
      this.session = null;
      session.emit({ type: "finished", sessionId });
    } catch (error) {
      if (this.isActive(session)) this.fail(error instanceof Error ? error : new Error("Voice final drain failed."));
      throw error;
    }
  }
  async cancel(connection: string, sessionId: string) {
    const session = this.owned(connection, sessionId);
    await this.cancelSession(session);
  }
  async disconnect(connection: string) {
    if (this.session?.connection === connection) await this.cancelSession(this.session);
  }
  async clear() { if (this.session) await this.cancelSession(this.session); }
  native(event: VoiceEvent) {
    const session = this.session;
    if (!session || session.state === "cancelled") return;
    if (event.type === "transcript" && event.delta.sessionId === session.id) {
      session.delivery?.accept(event.delta);
      session.emit({ type: "transcript", sessionId: session.id, delta: event.delta });
    } else if (event.type === "finished" && event.sessionId === session.id) session.completeNative();
    else if (event.type === "error" && (!event.sessionId || event.sessionId === session.id)) this.fail(new Error(event.message));
  }
  fail(error: Error) {
    const session = this.session;
    if (!session || session.state === "cancelled") return;
    console.warn("[voice]", error.message.replace(/\s+/g, " ").slice(0, 300));
    session.emit({ type: "error", sessionId: session.id, message: error.message.slice(0, 512) });
    void this.cancelSession(session).catch(() => console.warn("[voice] failed to dispose session after failure"));
  }
  async dispose() {
    this.disposed = true;
    try { await this.options.recognizer.dispose(); }
    finally { await this.clear(); }
  }
  private owned(connection: string, id: string) {
    const session = this.session;
    if (!session || session.id !== id || session.connection !== connection) throw new Error("Voice session belongs to another connection or has ended.");
    return session;
  }
  private isActive(session: Session) { return this.session === session && session.state !== "cancelled"; }
  private transformer(session: Session, event: SingleFileEvent) {
    if (this.session !== session || session.state === "cancelled") return;
    if (event.type === "document") session.emit(event);
    else if (event.type === "error") this.fail(new Error(event.message));
  }
  private async cancelSession(session: Session) {
    if (session.state === "cancelled") return;
    session.state = "cancelled";
    session.delivery?.cancel();
    session.completeNative();
    const results = await Promise.allSettled([
      (async () => {
        try { await session.recording?.close(); }
        finally { await session.provider?.cancel(session.id); }
      })(),
      this.disposed ? Promise.resolve() : this.options.recognizer.send({ type: "cancel", sessionId: session.id }),
    ]);
    if (this.session === session) this.session = null;
    session.emit({ type: "cancelled", sessionId: session.id });
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Voice session cleanup failed.");
  }
}
