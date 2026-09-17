/*
 * Exports:
 * - VoiceRecognizerProcessOptions: native process creation and retirement ports.
 * - default VoiceRecognizerProcess: private warm native recogniser and bounded JSON-line transport.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { VoiceEventSchema, VoiceRequestSchema, type VoiceEvent, type VoiceRequest } from "workbench-shared/workbench/voice/voice-contract";
import { killProcessTreeAsync } from "../process-helpers";

const descriptorSchema = z.object({
  version: z.literal(1), platform: z.string(), arch: z.string(),
  executable: z.string(), modelDirectory: z.string(),
}).strict();

export interface VoiceRecognizerProcessOptions {
  createChild?: (executable: string, modelDirectory: string) => ChildProcess;
  terminateChild?: (child: ChildProcess) => Promise<void>;
}

export default class VoiceRecognizerProcess {
  private child: ChildProcess | null = null;
  private readiness: Promise<void> | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private closed = false;
  private failed: Error | null = null;
  constructor(
    private readonly descriptorPath: string,
    private readonly onEvent: (event: VoiceEvent) => void,
    private readonly onError: (error: Error) => void,
    private readonly options: VoiceRecognizerProcessOptions = {},
  ) {}
  prepare() {
    if (this.closed) return Promise.reject(new Error("Voice recogniser is disposed."));
    if (this.failed) return Promise.reject(this.failed);
    return this.readiness ??= this.launch();
  }
  async send(request: VoiceRequest) {
    await this.prepare();
    const line = `${JSON.stringify(VoiceRequestSchema.parse(request))}\n`;
    if (Buffer.byteLength(line) > 65536) throw new Error("Voice frame exceeds native protocol limit.");
    const input = this.child?.stdin;
    if (!input?.writable || this.closed || this.failed) throw this.failed ?? new Error("Voice recogniser is unavailable.");
    await new Promise<void>((resolve, reject) => input.write(line, error => error ? reject(error) : resolve()));
  }
  async dispose() {
    this.closed = true;
    this.rejectReady?.(new Error("Voice recogniser disposed."));
    this.rejectReady = null;
    const child = this.child;
    this.child = null;
    if (child) {
      if (this.options.terminateChild) await this.options.terminateChild(child);
      else await killProcessTreeAsync(child.pid);
    }
  }
  private async launch() {
    let descriptor: z.infer<typeof descriptorSchema>;
    try {
      descriptor = descriptorSchema.parse(JSON.parse(await fs.readFile(this.descriptorPath, "utf8")));
      if (descriptor.platform !== process.platform || descriptor.arch !== process.arch
        || !path.isAbsolute(descriptor.executable) || !path.isAbsolute(descriptor.modelDirectory)) {
        throw new Error("Voice runtime does not match this machine.");
      }
      await Promise.all([fs.access(descriptor.executable), fs.access(descriptor.modelDirectory)]);
    } catch (cause) {
      throw new Error("Build voice support with node scripts/build-voice.mjs --build on the daemon machine.", { cause });
    }
    if (this.closed) throw new Error("Voice recogniser disposed.");
    return await new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      const child = this.options.createChild?.(descriptor.executable, descriptor.modelDirectory) ?? spawn(descriptor.executable, [], {
        cwd: path.dirname(descriptor.executable), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, WORKBENCH_VOICE_MODEL_DIR: descriptor.modelDirectory },
      });
      this.child = child;
      const decoder = new StringDecoder("utf8");
      let buffered = "";
      let reportedDiagnostics = false;
      child.stdout?.on("data", (bytes: Buffer) => {
        if (this.child !== child || this.failed) return;
        buffered += decoder.write(bytes);
        if (Buffer.byteLength(buffered) > 2_000_000) { this.fail(new Error("Native voice output exceeded its bound.")); return; }
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          try {
            const event = VoiceEventSchema.parse(JSON.parse(line));
            if (event.type === "ready") {
              this.rejectReady = null;
              resolve();
            } else if (event.type === "error" && !event.sessionId) this.fail(new Error(event.message));
            else this.onEvent(event);
          } catch { this.fail(new Error("Invalid native voice response.")); return; }
        }
      });
      child.stderr?.on("data", () => {
        // Native diagnostics may contain recognitions; never forward raw output.
        if (reportedDiagnostics || this.child !== child) return;
        reportedDiagnostics = true;
        console.warn("[voice-native] recogniser emitted diagnostics");
      });
      child.once("error", () => this.fail(new Error("Unable to launch native voice recogniser.")));
      child.once("exit", () => { if (!this.closed) this.fail(new Error("Native voice recogniser exited.")); });
    });
  }
  private fail(error: Error) {
    if (this.closed || this.failed) return;
    this.failed = error;
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.onError(error);
  }
}
