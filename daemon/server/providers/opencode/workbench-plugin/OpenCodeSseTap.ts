/*
 * Exports:
 * - OpenCodeSseTapObserver: callbacks that observe complete SSE events before their bytes reach OpenCode.
 * - default OpenCodeSseTap: forward a model SSE body at event boundaries and allow a clean synthetic ending.
 */
import { createParser } from "eventsource-parser";
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";

export type OpenCodeSseTapClose = "end" | "error" | "cancel" | "cut";

export interface OpenCodeSseTapObserver {
  /** Observe one complete SSE event's data. Throwing stops observation; bytes keep flowing. */
  event?(data: string): void;
  /** Runs after a segment of complete events is observed and before its bytes are forwarded. */
  settle?(): Promise<void>;
  /** Observation failed once; the tap forwards the remaining body unobserved. */
  failed?(error: unknown): Promise<void>;
  /** The body ended, failed upstream, was cancelled by OpenCode, or was cut. */
  closed?(reason: OpenCodeSseTapClose): Promise<void>;
}

const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
const LF = 10;
const CR = 13;

/** End offset of the last blank-line SSE event terminator, or 0 when no complete event is buffered. */
function lastEventBoundary(bytes: Uint8Array) {
  let boundary = 0;
  let terminators = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte === LF && index > 0 && bytes[index - 1] === CR) {
      if (terminators >= 2) boundary = index + 1;
      continue;
    }
    if (byte === LF || byte === CR) {
      terminators++;
      if (terminators >= 2) boundary = index + 1;
      continue;
    }
    terminators = 0;
  }
  return boundary;
}

function concat(left: Uint8Array, right: Uint8Array) {
  if (!left.length) return right;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

export default class OpenCodeSseTap {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private held: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private unforwarded: Uint8Array | null = null;
  private observing = true;
  private finished = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly parser = createParser({
    maxBufferSize: MAX_SSE_EVENT_BYTES,
    onEvent: event => this.observer.event?.(event.data),
    onError: error => {
      if (error.type === "max-buffer-size-exceeded") throw new Error("Observed SSE event exceeded its byte budget.");
    },
  });

  private constructor(body: ReadableStream<Uint8Array>, private readonly observer: OpenCodeSseTapObserver) {
    this.reader = body.getReader();
  }

  /** Replace `input.response` with a tapped body; callers must have checked it is an SSE body. */
  static wrap(input: SessionHttpResponse, observer: OpenCodeSseTapObserver) {
    const body = input.response.body;
    if (!body) throw new Error("OpenCode SSE tap requires a response body.");
    const tap = new OpenCodeSseTap(body, observer);
    input.response = new Response(new ReadableStream<Uint8Array>({
      start: controller => { tap.controller = controller; },
      pull: () => tap.pull(),
      cancel: reason => tap.cancel(reason),
    }, { highWaterMark: 0 }), {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: input.response.headers,
    });
    return tap;
  }

  /**
   * End OpenCode's view of the body with `terminator` after every already-observed complete event,
   * then cancel the provider body. Resolves false when the body already finished; rejects only when
   * the provider body could not be cancelled after OpenCode's view was already closed.
   */
  async cut(terminator: string) {
    const controller = this.controller;
    if (this.finished || !controller) return false;
    this.finished = true;
    if (this.unforwarded) controller.enqueue(this.unforwarded);
    this.unforwarded = null;
    this.held = new Uint8Array(0);
    controller.enqueue(new TextEncoder().encode(terminator));
    controller.close();
    try {
      await this.reader.cancel("Workbench steer cut the provider stream.");
    } finally {
      this.reader.releaseLock();
      await this.notifyClosed("cut");
    }
    return true;
  }

  private async pull() {
    const controller = this.controller!;
    while (!this.finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.reader.read();
      } catch (error) {
        if (this.finished) return;
        this.finished = true;
        this.reader.releaseLock();
        await this.notifyClosed("error");
        controller.error(error);
        return;
      }
      if (this.finished) return;
      if (chunk.done) {
        this.finished = true;
        this.reader.releaseLock();
        if (this.held.length) controller.enqueue(this.held);
        this.held = new Uint8Array(0);
        await this.notifyClosed("end");
        controller.close();
        return;
      }
      const buffered = concat(this.held, chunk.value);
      const boundary = lastEventBoundary(buffered);
      this.held = buffered.subarray(boundary);
      if (!boundary) continue;
      const complete = boundary === buffered.length ? buffered : buffered.subarray(0, boundary);
      this.unforwarded = complete;
      await this.observe(complete);
      if (this.finished) return;
      this.unforwarded = null;
      controller.enqueue(complete);
      return;
    }
  }

  private async observe(complete: Uint8Array) {
    if (!this.observing) return;
    try {
      this.parser.feed(this.decoder.decode(complete, { stream: true }));
      await this.observer.settle?.();
    } catch (error) {
      this.observing = false;
      await this.observer.failed?.(error);
    }
  }

  private async cancel(reason: unknown) {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.reader.cancel(reason);
    } finally {
      this.reader.releaseLock();
      await this.notifyClosed("cancel");
    }
  }

  private async notifyClosed(reason: OpenCodeSseTapClose) {
    await this.observer.closed?.(reason);
  }
}
