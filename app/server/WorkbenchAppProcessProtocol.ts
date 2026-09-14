/*
 * Exports:
 * - WorkbenchAppProcessProtocolOptions: desktop stdio protocol ports. Keywords: app, desktop, process, protocol.
 * - default WorkbenchAppProcessProtocol: announce app state, request native restart, and route one desktop Quit command. Keywords: app, lifecycle, stdio.
 */
import type { Readable, Writable } from "node:stream";

export interface WorkbenchAppProcessProtocolOptions {
  input?: Readable;
  onDiagnostic?: (message: string) => void;
  onQuit: () => Promise<void>;
  output?: Writable;
}

const RECORD_PREFIX = "\u001eWORKBENCH_DESKTOP_V1 ";

function isQuitRecord(value: unknown): value is { type: "quit"; version: 1 } {
  return Boolean(
    value
    && typeof value === "object"
    && "type" in value
    && value.type === "quit"
    && "version" in value
    && value.version === 1,
  );
}

export default class WorkbenchAppProcessProtocol {
  private bufferedInput = "";
  private readonly input: Readable;
  private readonly onDiagnostic: (message: string) => void;
  private readonly onQuit: () => Promise<void>;
  private readonly output: Writable;
  private quitStarted = false;
  private started = false;

  constructor(options: WorkbenchAppProcessProtocolOptions) {
    this.input = options.input ?? process.stdin;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.onQuit = options.onQuit;
    this.output = options.output ?? process.stdout;
  }

  announceAlreadyRunning() {
    this.writeRecord({
      type: "alreadyRunning",
      version: 1,
    });
  }

  announceReady(appOrigin: string, openBrowser: boolean) {
    const origin = new URL(appOrigin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) {
      throw new Error("Desktop app readiness requires a loopback HTTP origin with a bound port.");
    }
    this.writeRecord({
      appOrigin: origin.origin,
      openBrowser,
      type: "ready",
      version: 1,
    });
  }

  requestRestart() {
    this.writeRecord({
      type: "restart",
      version: 1,
    });
  }

  start() {
    if (this.started) throw new Error("Workbench desktop process protocol has already started.");
    this.started = true;
    this.input.setEncoding("utf8");
    this.input.on("data", this.handleData);
    this.input.on("end", this.handleEnd);
  }

  dispose() {
    if (!this.started) return;
    this.started = false;
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleEnd);
    this.input.pause();
  }

  private readonly handleData = (chunk: string) => {
    const lines = `${this.bufferedInput}${chunk}`.split(/\r\n|\n|\r/u);
    this.bufferedInput = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  };

  private readonly handleEnd = () => {
    if (this.bufferedInput) this.handleLine(this.bufferedInput);
    this.bufferedInput = "";
  };

  private handleLine(line: string) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.onDiagnostic("Desktop process protocol rejected malformed JSON.");
      return;
    }
    if (!isQuitRecord(record)) {
      this.onDiagnostic("Desktop process protocol rejected an unsupported command.");
      return;
    }
    if (this.quitStarted) return;
    this.quitStarted = true;
    void this.onQuit().catch((error) => {
      this.onDiagnostic(`Desktop Quit failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private writeRecord(record:
    | { type: "alreadyRunning" | "restart"; version: 1 }
    | { appOrigin: string; openBrowser: boolean; type: "ready"; version: 1 }) {
    this.output.write(`${RECORD_PREFIX}${JSON.stringify(record)}\n`);
  }
}
