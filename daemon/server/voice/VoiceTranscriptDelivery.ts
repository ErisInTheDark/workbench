/*
 * Exports:
 * - default VoiceTranscriptDelivery: ordered, coalesced transcript admission and final-input drain.
 */
import type { TranscriptDelta } from "workbench-shared/workbench/voice/voice-contract";
import type { SingleFileInput } from "workbench-shared/workbench/provider/provider-single-file";

export default class VoiceTranscriptDelivery {
  private revision = 0;
  private transcript = "";
  private pending: SingleFileInput | null = null;
  private running: Promise<void> | null = null;
  private failure: Error | null = null;
  private closed = false;
  constructor(
    private readonly send: (input: SingleFileInput) => Promise<void>,
    private readonly onError: (error: Error) => void = error => console.warn("[voice-delivery]", error.message.slice(0, 500)),
  ) {}
  accept(delta: TranscriptDelta) {
    if (this.closed || this.failure || delta.revision <= this.revision) return;
    this.revision = delta.revision;
    this.transcript = delta.inlineText;
    this.pending = { transcript: this.transcript, final: false };
    this.pump();
  }
  async finish() {
    if (!this.closed) {
      this.closed = true;
      this.pending = { transcript: this.transcript, final: true };
      this.pump();
    }
    while (this.running) await this.running;
    if (this.failure) throw this.failure;
  }
  cancel() {
    this.closed = true;
    this.pending = null;
  }
  private pump() {
    if (this.running || this.failure || !this.pending) return;
    const next = this.pending;
    this.pending = null;
    const running = this.send(next).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error("Transcript admission failed.");
      this.pending = null;
      this.onError(this.failure);
    }).finally(() => {
      this.running = null;
      this.pump();
    });
    this.running = running;
  }
}
