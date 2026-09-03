/*
 * WorkbenchTranscriptShadowLogRecord: bounded structured diagnostic written by transcript shadow owners. Keywords: transcript, shadow, log, diagnostic.
 * default WorkbenchTranscriptShadowLog: own serialized append, failure bounding, and disposal flush for the temporary shadow log. Keywords: transcript, shadow, log, lifecycle.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkbenchTranscriptShadowLogRecord {
  event: string;
  fields?: Record<string, WorkbenchTranscriptShadowLogValue>;
  level: "error" | "info" | "warning";
  source: string;
  threadId?: string;
}

export type WorkbenchTranscriptShadowLogValue =
  | boolean
  | number
  | string
  | null
  | readonly WorkbenchTranscriptShadowLogValue[]
  | { readonly [key: string]: WorkbenchTranscriptShadowLogValue };

export default class WorkbenchTranscriptShadowLog {
  readonly #filePath: string;
  #failureReported = false;
  readonly #onFailure: (error: Error) => void;
  #queue = Promise.resolve();

  constructor(filePath: string, onFailure: (error: Error) => void) {
    this.#filePath = filePath;
    this.#onFailure = onFailure;
  }

  async start() {
    await mkdir(dirname(this.#filePath), { recursive: true });
  }

  write(record: WorkbenchTranscriptShadowLogRecord) {
    const line = `${JSON.stringify({ at: Date.now(), ...record })}\n`;
    this.#queue = this.#queue
      .then(async () => await appendFile(this.#filePath, line, "utf8"))
      .catch((error) => {
        if (this.#failureReported) return;
        this.#failureReported = true;
        this.#onFailure(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async flush() {
    await this.#queue;
  }
}
