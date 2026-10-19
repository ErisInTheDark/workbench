/*
 * Exports:
 * - OpenCodeSseTapClose: why a tapped body stopped.
 * - OpenCodeSseTapDecision: whether one observed event reaches OpenCode now or waits.
 * - OpenCodeSseTapObserver: callbacks that observe complete SSE events before their bytes reach OpenCode.
 * - default OpenCodeSseTap: forward a model SSE body at event boundaries, hold events on request, and allow a clean synthetic ending.
 */
import { createParser } from "eventsource-parser";
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";

export type OpenCodeSseTapClose = "end" | "error" | "cancel" | "cut";

/** Held events reach OpenCode, in order, ahead of the next forwarded event or the body end; a cut drops them. */
export type OpenCodeSseTapDecision = "forward" | "hold";

export interface OpenCodeSseTapObserver {
  /** Observe one complete SSE event's data. Throwing stops observation; bytes keep flowing. */
  event?(data: string): OpenCodeSseTapDecision | void;
  /** Runs after a segment of complete events is observed and before its forwarded bytes reach OpenCode. */
  settle?(): Promise<void>;
  /** Observation failed once; the tap forwards the remaining body unobserved. */
  failed?(error: unknown): Promise<void>;
  /** The body ended, failed upstream, was cancelled by OpenCode, or was cut. */
  closed?(reason: OpenCodeSseTapClose): Promise<void>;
}

const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
const LF = 10;
const CR = 13;
const EMPTY = new Uint8Array(0);

/** End offsets of each blank-line SSE event terminator; a run of line endings ends one event. */
function eventBoundaries(bytes: Uint8Array) {
  const boundaries: number[] = [];
  let run: number | null = null;
  let terminators = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte === LF && index > 0 && bytes[index - 1] === CR) {
      if (terminators >= 2) run = index + 1;
      continue;
    }
    if (byte === LF || byte === CR) {
      terminators++;
      if (terminators >= 2) run = index + 1;
      continue;
    }
    terminators = 0;
    if (run !== null) boundaries.push(run);
    run = null;
  }
  if (run !== null) boundaries.push(run);
  return boundaries;
}

function concat(parts: readonly Uint8Array[]) {
  const nonEmpty = parts.filter(part => part.length);
  if (nonEmpty.length <= 1) return nonEmpty[0] ?? EMPTY;
  const joined = new Uint8Array(nonEmpty.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of nonEmpty) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export default class OpenCodeSseTap {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Bytes after the last complete event. */
  private partial: Uint8Array<ArrayBufferLike> = EMPTY;
  /** Complete events the observer asked to hold. */
  private held: Uint8Array[] = [];
  /** Observed bytes whose segment has not settled yet. */
  private unforwarded: Uint8Array | null = null;
  private decision: OpenCodeSseTapDecision = "forward";
  private observing = true;
  private finished = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly parser = createParser({
    maxBufferSize: MAX_SSE_EVENT_BYTES,
    onEvent: event => { this.decision = this.observer.event?.(event.data) === "hold" ? "hold" : "forward"; },
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
   * End OpenCode's view of the body with `terminator` after every already-forwarded event, dropping held events,
   * then cancel the provider body. Resolves false when the body already finished; rejects only when the provider
   * body could not be cancelled after OpenCode's view was already closed.
   */
  async cut(terminator: string) {
    const controller = this.controller;
    if (this.finished || !controller) return false;
    this.finished = true;
    if (this.unforwarded) controller.enqueue(this.unforwarded);
    this.unforwarded = null;
    this.held = [];
    this.partial = EMPTY;
    controller.enqueue(new TextEncoder().encode(terminator));
    controller.close();
    try {
      await this.reader.cancel("Workbench cut the provider stream.");
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
        const rest = concat([...this.held, this.partial]);
        if (rest.length) controller.enqueue(rest);
        this.held = [];
        this.partial = EMPTY;
        await this.notifyClosed("end");
        controller.close();
        return;
      }
      const buffered = concat([this.partial, chunk.value]);
      const boundaries = eventBoundaries(buffered);
      const end = boundaries.at(-1) ?? 0;
      this.partial = buffered.subarray(end);
      if (!end) continue;
      const ready: Uint8Array[] = [];
      let start = 0;
      for (const boundary of boundaries) {
        const event = buffered.subarray(start, boundary);
        start = boundary;
        if (await this.observe(event) === "hold") {
          this.held.push(event);
        } else {
          ready.push(...this.held, event);
          this.held = [];
        }
      }
      this.unforwarded = ready.length ? concat(ready) : null;
      await this.settle();
      if (this.finished) return;
      const forwarded = this.unforwarded;
      this.unforwarded = null;
      if (!forwarded) continue;
      controller.enqueue(forwarded);
      return;
    }
  }

  private async observe(event: Uint8Array): Promise<OpenCodeSseTapDecision> {
    if (!this.observing) return "forward";
    this.decision = "forward";
    try {
      this.parser.feed(this.decoder.decode(event, { stream: true }));
      return this.decision;
    } catch (error) {
      await this.stopObserving(error);
      return "forward";
    }
  }

  private async settle() {
    if (!this.observing) return;
    try {
      await this.observer.settle?.();
    } catch (error) {
      await this.stopObserving(error);
    }
  }

  private async stopObserving(error: unknown) {
    this.observing = false;
    await this.observer.failed?.(error);
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
