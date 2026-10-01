/*
 * Exports:
 * - default OpenCodeSteerCutController: end a managed model response at its open reasoning block when a steer is pending.
 */
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";
import OpenCodeSseTap from "./OpenCodeSseTap";
import { openCodeStreamCutTracker, type OpenCodeStreamCutTracker } from "./open-code-stream-cut";

interface LiveResponse {
  sessionID: string;
  tap: OpenCodeSseTap | null;
  /** Undefined until the first JSON frame; null when the wire is unsupported and must never be cut. */
  tracker: OpenCodeStreamCutTracker | null | undefined;
}

/**
 * OpenCode delivers steers only between model steps. A clean synthetic finish while the model is
 * reasoning ends the step early, so OpenCode's own loop promotes the steer on the next step.
 */
export default class OpenCodeSteerCutController {
  /** Undelivered steer inbox IDs per session that have not yet caused a cut. */
  private readonly pending = new Map<string, Set<string>>();
  /** Steers that already cut once; a missed delivery event must not chop every later response. */
  private readonly served = new Map<string, Set<string>>();
  private readonly live = new Map<string, Set<LiveResponse>>();
  private disposed = false;

  constructor(private readonly options: {
    isManagedSession(sessionID: string): Promise<boolean>;
    warn(message: string): void;
  }) {}

  async httpResponse(input: SessionHttpResponse) {
    if (this.disposed || input.kind !== "primary" || !input.response.ok || !input.response.body
      || !input.response.headers.get("content-type")?.includes("text/event-stream")) return;
    try {
      if (!await this.options.isManagedSession(input.sessionID) || this.disposed) return;
    } catch {
      this.options.warn("OpenCode steer cut session lookup failed; this response cannot be cut.");
      return;
    }
    const response: LiveResponse = { sessionID: input.sessionID, tap: null, tracker: undefined };
    response.tap = OpenCodeSseTap.wrap(input, {
      event: data => this.observe(response, data),
      settle: () => this.evaluate(response),
      failed: async () => {
        response.tracker = null;
        this.options.warn("OpenCode steer cut observation failed; this response cannot be cut.");
      },
      closed: async () => { this.forget(response); },
    });
    let responses = this.live.get(input.sessionID);
    if (!responses) this.live.set(input.sessionID, responses = new Set());
    responses.add(response);
  }

  /** An undelivered user steer exists for the session. */
  async steerPending(sessionID: string, inboxID: string) {
    if (this.disposed || this.served.get(sessionID)?.has(inboxID)) return;
    let steers = this.pending.get(sessionID);
    if (!steers) this.pending.set(sessionID, steers = new Set());
    steers.add(inboxID);
    await Promise.all([...this.live.get(sessionID) ?? []].map(response => this.evaluate(response)));
  }

  /** The steer was delivered, cancelled, or moved back to the queue. */
  steerResolved(sessionID: string, inboxID: string) {
    this.pending.get(sessionID)?.delete(inboxID);
    this.served.get(sessionID)?.delete(inboxID);
  }

  /** The session's execution ended; nothing it admitted can still be pending. */
  settleSession(sessionID: string) {
    this.pending.delete(sessionID);
    this.served.delete(sessionID);
  }

  /** Stop cutting. Live responses keep forwarding their native bytes untouched. */
  dispose() {
    this.disposed = true;
    this.pending.clear();
    this.served.clear();
  }

  private observe(response: LiveResponse, data: string) {
    if (response.tracker === null || data === "[DONE]") return;
    const value: unknown = JSON.parse(data);
    const frame = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
    if (!frame) return;
    if (response.tracker === undefined) response.tracker = openCodeStreamCutTracker(frame);
    else response.tracker.observe(frame);
  }

  private async evaluate(response: LiveResponse) {
    const steers = this.pending.get(response.sessionID);
    if (this.disposed || !steers?.size || !response.tap || !response.tracker?.cuttable) return;
    const tracker = response.tracker;
    let served = this.served.get(response.sessionID);
    if (!served) this.served.set(response.sessionID, served = new Set());
    for (const inboxID of steers) served.add(inboxID);
    steers.clear();
    try {
      await response.tap.cut(tracker.terminator());
    } catch {
      this.options.warn(`OpenCode steer cut ended the ${tracker.wire} response but could not cancel the provider body.`);
    }
  }

  private forget(response: LiveResponse) {
    const responses = this.live.get(response.sessionID);
    responses?.delete(response);
    if (responses?.size === 0) this.live.delete(response.sessionID);
  }
}
