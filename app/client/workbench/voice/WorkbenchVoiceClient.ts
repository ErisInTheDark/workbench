/*
 * Exports:
 * - VoiceField/VoiceClientSnapshot: controlled field binding and visible voice state.
 * - default WorkbenchVoiceClient: one field, bounded capture transport and parent-value fencing.
 */
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { VoiceSessionEvent } from "workbench-shared/workbench/voice/voice-session-contract";
import VoiceCaptureController from "./VoiceCaptureController";
import VoiceSettingsController from "./VoiceSettingsController";
import type WorkbenchClientStateController from "../state/WorkbenchClientStateController";
import { decodeVoiceDocument, encodeVoiceDocument, type VoiceSelection } from "workbench-shared/workbench/voice/voice-document";

export interface VoiceField { id: string; text: string; getSelection?(): VoiceSelection; change(text: string, selection: VoiceSelection): void }
export interface VoiceClientSnapshot {
  fieldId: string | null;
  state: "idle" | "preparing" | "listening" | "finishing" | "failed";
  error: string;
}
interface Session {
  id: string;
  field: VoiceField;
  text: string;
  revision: number;
  sequence: number;
  capture: VoiceCaptureController;
  frames: Int16Array[];
  queuedSamples: number;
  sending: Promise<void> | null;
  started: Promise<void>;
  releasing: boolean;
}
export default class WorkbenchVoiceClient {
  readonly settings: VoiceSettingsController;
  private active: Session | null = null;
  private snapshot: VoiceClientSnapshot = { fieldId: null, state: "idle", error: "" };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];
  constructor(
    private readonly daemon: WorkbenchDaemonClient,
    private readonly workletUrl: string,
    preferences: WorkbenchClientStateController | undefined,
    private readonly createCapture = (options: ConstructorParameters<typeof VoiceCaptureController>[0]) => new VoiceCaptureController(options),
  ) {
    this.settings = new VoiceSettingsController(daemon, preferences);
    this.unsubscribe = [
      daemon.onVoiceEvent(event => this.event(event)),
      daemon.onDisconnect(() => {
        if (this.active) this.fail(new Error("Voice connection closed."));
        this.settings.disconnect();
      }),
      daemon.onReconnect(() => { void this.settings.refresh(); }),
      this.settings.subscribe(() => { if (!this.settings.enabled && this.active) void this.cancel(); }),
    ];
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  async begin(field: VoiceField) {
    if (!this.settings.enabled) throw new Error("Select a voice harness and model in global settings.");
    if (this.active) throw new Error("Another field is using voice.");
    let document: string;
    try { document = encodeVoiceDocument(field.text, field.getSelection?.()); }
    catch (error) {
      this.publish({ fieldId: field.id, state: "failed", error: error instanceof Error ? error.message : "Unable to capture the editor selection." });
      return;
    }
    const id = crypto.randomUUID();
    const capture = this.createCapture({
      workletUrl: this.workletUrl,
      onFrame: frame => {
        if (this.active?.id !== id) return;
        this.active.frames.push(frame);
        this.active.queuedSamples += frame.length;
        if (this.active.queuedSamples > 16000) { this.fail(new Error("Audio transport cannot keep up with realtime speech.")); return; }
        this.sendFrames(this.active);
      },
      onError: error => { if (this.active?.id === id) this.fail(error); },
    });
    const session: Session = { id, field, text: field.text, revision: 0, sequence: 0, capture,
      frames: [], queuedSamples: 0, sending: null, started: Promise.resolve(), releasing: false };
    this.active = session;
    this.publish({ fieldId: field.id, state: "preparing", error: "" });
    session.started = this.daemon.voice.start({ sessionId: id, text: document }).then(() => undefined);
    // Permission may remain pending after the server rejects admission.
    void session.started.catch(error => {
      if (this.active === session) this.fail(error instanceof Error ? error : new Error("Unable to start voice."));
    });
    try {
      const capturing = await capture.start(session.started);
      if (this.active === session && capturing && !session.releasing) this.publish({ ...this.snapshot, state: "listening" });
    } catch (error) { if (this.active === session) this.fail(error instanceof Error ? error : new Error("Unable to start voice.")); }
  }
  async finish(fieldId: string) {
    const session = this.active;
    if (!session || session.field.id !== fieldId || session.releasing) return;
    session.releasing = true;
    this.publish({ ...this.snapshot, state: "finishing" });
    try {
      await session.capture.finish();
      await session.started;
      while (session.sending) await session.sending;
      if (this.active === session) await this.daemon.voice.finish(session.id);
    } catch (error) { if (this.active === session) this.fail(error instanceof Error ? error : new Error("Unable to finish voice.")); }
  }
  async cancel(fieldId?: string) {
    const session = this.active;
    if (!session || (fieldId && session.field.id !== fieldId)) return;
    this.active = null;
    this.publish({ fieldId: null, state: "idle", error: "" });
    const results = await Promise.allSettled([session.capture.cancel(), this.daemon.voice.cancel(session.id)]);
    for (const result of results) if (result.status === "rejected") console.warn("[voice] session cancellation could not complete");
  }
  reconcile(fieldId: string, text: string) {
    const session = this.active;
    if (session?.field.id === fieldId && text !== session.text) void this.cancel(fieldId);
  }
  dispose() {
    this.settings.dispose();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    void this.cancel();
    this.listeners.clear();
  }
  private sendFrames(session: Session) {
    if (session.sending || this.active !== session) return;
    const sending = (async () => {
      await session.started;
      while (session.frames.length && this.active === session) {
        const frame = session.frames.shift()!;
        const bytes = new Uint8Array(frame.length * 2);
        const view = new DataView(bytes.buffer);
        frame.forEach((sample, index) => view.setInt16(index * 2, sample, true));
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await this.daemon.voice.audio({ sessionId: session.id, sequence: session.sequence++, pcm: btoa(binary) });
        session.queuedSamples -= frame.length;
      }
    })().catch(error => {
      if (this.active === session) this.fail(error instanceof Error ? error : new Error("Voice transport failed."));
    }).finally(() => {
      session.sending = null;
      if (session.frames.length && this.active === session) this.sendFrames(session);
    });
    session.sending = sending;
  }
  private event(event: VoiceSessionEvent) {
    const session = this.active;
    if (!session || event.sessionId !== session.id) return;
    if (event.type === "document" && event.revision > session.revision) {
      let document: ReturnType<typeof decodeVoiceDocument>;
      try { document = decodeVoiceDocument(event.text); }
      catch (error) { this.fail(error instanceof Error ? error : new Error("Invalid voice document.")); return; }
      session.revision = event.revision;
      session.text = document.text;
      session.field.change(document.text, document.selection);
    } else if (event.type === "finished" || event.type === "cancelled") {
      this.active = null;
      void session.capture.cancel().catch(() => console.warn("[voice] microphone cleanup failed"));
      this.publish({ fieldId: null, state: "idle", error: "" });
    } else if (event.type === "error") this.fail(new Error(event.message));
  }
  private fail(error: Error) {
    const fieldId = this.active?.field.id ?? this.snapshot.fieldId;
    void this.cancel();
    this.publish({ fieldId, state: "failed", error: error.message.slice(0, 512) });
  }
  private publish(snapshot: VoiceClientSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
