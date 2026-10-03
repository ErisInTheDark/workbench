/*
 * Exports:
 * - default WebSocketTrafficBuffer: bounded in-memory record of recent WebSocket frames for `wb socket spy`.
 * - WebSocketTrafficQuerySchema/WebSocketTrafficQuery: search or read one recorded frame.
 * - WebSocketTrafficResultSchema/WebSocketTrafficResult: matching frame summaries or one full payload.
 * - WEBSOCKET_SPY_QUERY_METHOD/WEBSOCKET_SPY_RESULT_METHOD: daemon-to-app spy exchange over the shared socket.
 * - WebSocketSpyQueryNotificationSchema/WebSocketSpyResultNotificationSchema: validate that exchange.
 */
import { z } from "zod";

export const WEBSOCKET_SPY_QUERY_METHOD = "workbench/socket-spy/query";
export const WEBSOCKET_SPY_RESULT_METHOD = "workbench/socket-spy/result";

const direction = z.enum(["in", "out"]);
export const WebSocketTrafficQuerySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    /** Case-insensitive substring over label and payload. */
    grep: z.string().min(1).max(500).optional(),
    /** Case-insensitive label prefix, e.g. `wb:workspace/delta` or `app:workspace thread`. */
    label: z.string().min(1).max(200).optional(),
    direction: direction.optional(),
    /** Only frames older than this sequence number, for paging backwards. */
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).default(40),
  }).strict(),
  z.object({ action: z.literal("read"), seq: z.number().int().positive() }).strict(),
]);
export type WebSocketTrafficQuery = z.infer<typeof WebSocketTrafficQuerySchema>;

const summary = z.object({
  seq: z.number().int().positive(),
  at: z.number(),
  direction,
  connection: z.string(),
  label: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();
export const WebSocketTrafficResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    entries: z.array(summary.extend({ preview: z.string() }).strict()),
    retained: z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
      oldestSeq: z.number().int().nonnegative(), newestSeq: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({ action: z.literal("read"), entry: summary.extend({ payload: z.string() }).strict().nullable() }).strict(),
]);
export type WebSocketTrafficResult = z.infer<typeof WebSocketTrafficResultSchema>;

export const WebSocketSpyQueryNotificationSchema = z.object({
  method: z.literal(WEBSOCKET_SPY_QUERY_METHOD),
  params: z.object({ requestId: z.string().min(1).max(100), query: WebSocketTrafficQuerySchema }).strict(),
}).passthrough();
export const WebSocketSpyResultNotificationSchema = z.object({
  method: z.literal(WEBSOCKET_SPY_RESULT_METHOD),
  params: z.object({ requestId: z.string().min(1).max(100), result: WebSocketTrafficResultSchema }).strict(),
}).strict();

interface Entry {
  seq: number;
  at: number;
  direction: "in" | "out";
  connection: string;
  label: string;
  bytes: number;
  payload: string;
  truncated: boolean;
}

const PREVIEW_CHARS = 240;

/**
 * Frames are already serialized for the socket, so recording keeps a reference instead of re-encoding.
 * Memory only: spying must not churn disk. Oldest frames leave first once count or byte budgets fill.
 */
export default class WebSocketTrafficBuffer {
  readonly #entries: Entry[] = [];
  #nextSeq = 1;
  #bytes = 0;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #maxPayloadChars: number;
  readonly #now: () => number;

  constructor({ maxEntries = 5_000, maxBytes = 16 * 1024 * 1024, maxPayloadChars = 1024 * 1024, now = Date.now } = {}) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
    this.#maxPayloadChars = maxPayloadChars;
    this.#now = now;
  }

  record(frame: { direction: "in" | "out"; connection: string; label: string; payload: string; bytes?: number }) {
    const truncated = frame.payload.length > this.#maxPayloadChars;
    const payload = truncated ? frame.payload.slice(0, this.#maxPayloadChars) : frame.payload;
    this.#entries.push({
      seq: this.#nextSeq++, at: this.#now(), direction: frame.direction, connection: frame.connection,
      label: frame.label, bytes: frame.bytes ?? Buffer.byteLength(frame.payload), payload, truncated,
    });
    this.#bytes += payload.length;
    while (this.#entries.length > this.#maxEntries || (this.#bytes > this.#maxBytes && this.#entries.length > 1)) {
      this.#bytes -= this.#entries.shift()!.payload.length;
    }
  }

  query(query: WebSocketTrafficQuery): WebSocketTrafficResult {
    if (query.action === "read") {
      const entry = this.#entries.find(item => item.seq === query.seq);
      return { action: "read", entry: entry ? { ...entry } : null };
    }
    const grep = query.grep?.toLowerCase();
    const label = query.label?.toLowerCase();
    const entries: Extract<WebSocketTrafficResult, { action: "search" }>["entries"] = [];
    for (let index = this.#entries.length - 1; index >= 0 && entries.length < query.limit; index--) {
      const entry = this.#entries[index]!;
      if (query.before !== undefined && entry.seq >= query.before) continue;
      if (query.direction && entry.direction !== query.direction) continue;
      if (label && !entry.label.toLowerCase().startsWith(label)) continue;
      if (grep && !entry.label.toLowerCase().includes(grep) && !entry.payload.toLowerCase().includes(grep)) continue;
      const { payload, ...rest } = entry;
      entries.push({ ...rest, preview: payload.slice(0, PREVIEW_CHARS) });
    }
    return {
      action: "search", entries,
      retained: { count: this.#entries.length, bytes: this.#bytes,
        oldestSeq: this.#entries[0]?.seq ?? 0, newestSeq: this.#entries.at(-1)?.seq ?? 0 },
    };
  }
}
