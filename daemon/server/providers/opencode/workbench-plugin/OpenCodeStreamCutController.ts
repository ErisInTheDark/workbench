/*
 * Exports:
 * - default OpenCodeStreamCutController: end managed model responses early, at open reasoning for a pending steer, or before bare text so the agent retries through the commentary tool.
 */
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";
import OpenCodeSseTap, { type OpenCodeSseTapDecision } from "./OpenCodeSseTap";
import { openCodeStreamCutTracker, type OpenCodeStreamCutTracker } from "./open-code-stream-cut";

/** Consecutive bare-text cuts without a tool call before bare text is kept, so a model that ignores hints still ends. */
const BARE_TEXT_CUT_LIMIT = 3;

interface LiveResponse {
  sessionID: string;
  tap: OpenCodeSseTap | null;
  /** Undefined until the first JSON frame; null when the wire is unsupported and must never be cut. */
  tracker: OpenCodeStreamCutTracker | null | undefined;
  /** Bare text arrived; it and every later event wait for the hint and cut. */
  bareText: boolean;
  cutting: boolean;
}

/**
 * OpenCode delivers steers only between model steps. A clean synthetic finish ends the step early, so OpenCode's own
 * loop promotes the pending steer, or the admitted commentary hint, on the next step.
 */
export default class OpenCodeStreamCutController {
  /** Undelivered steer inbox IDs per session that have not yet caused a cut. */
  private readonly pending = new Map<string, Set<string>>();
  /** Steers that already cut once; a missed delivery event must not chop every later response. */
  private readonly served = new Map<string, Set<string>>();
  /** Bare-text cuts per session since its last tool call. */
  private readonly strikes = new Map<string, number>();
  private readonly live = new Map<string, Set<LiveResponse>>();
  private disposed = false;

  constructor(private readonly options: {
    isManagedSession(sessionID: string): Promise<boolean>;
    /** Admit the hidden steer that tells the agent its bare text was discarded. */
    hint(sessionID: string): Promise<void>;
    warn(message: string): void;
  }) {}

  async httpResponse(input: SessionHttpResponse) {
    if (this.disposed || input.kind !== "primary" || !input.response.ok || !input.response.body
      || !input.response.headers.get("content-type")?.includes("text/event-stream")) return;
    try {
      if (!await this.options.isManagedSession(input.sessionID) || this.disposed) return;
    } catch {
      this.options.warn("OpenCode stream cut session lookup failed; this response cannot be cut.");
      return;
    }
    const response: LiveResponse = { sessionID: input.sessionID, tap: null, tracker: undefined, bareText: false, cutting: false };
    response.tap = OpenCodeSseTap.wrap(input, {
      event: data => this.observe(response, data),
      settle: () => this.evaluate(response),
      failed: async () => {
        response.tracker = null;
        this.options.warn("OpenCode stream cut observation failed; this response cannot be cut.");
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

  /** The agent called a tool, so it is using tools again and later bare text is cut again. */
  toolCalled(sessionID: string) {
    this.strikes.delete(sessionID);
  }

  /** The session's execution ended; nothing it admitted can still be pending. */
  settleSession(sessionID: string) {
    this.pending.delete(sessionID);
    this.served.delete(sessionID);
    this.strikes.delete(sessionID);
  }

  /** Stop cutting. Live responses keep forwarding their native bytes untouched. */
  dispose() {
    this.disposed = true;
    this.pending.clear();
    this.served.clear();
    this.strikes.clear();
  }

  private observe(response: LiveResponse, data: string): OpenCodeSseTapDecision {
    if (response.bareText) return "hold";
    if (response.tracker === null || data === "[DONE]") return "forward";
    const value: unknown = JSON.parse(data);
    const frame = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
    if (!frame) return "forward";
    response.tracker ??= openCodeStreamCutTracker(frame);
    if (!response.tracker) return "forward";
    const text = response.tracker.text(frame);
    const guarded = text !== null && this.cutsBareText(response.sessionID);
    if (guarded && text.trim()) {
      response.bareText = true;
      return "hold";
    }
    response.tracker.observe(frame);
    return guarded ? "hold" : "forward";
  }

  private cutsBareText(sessionID: string) {
    return !this.disposed && (this.strikes.get(sessionID) ?? 0) < BARE_TEXT_CUT_LIMIT;
  }

  private async evaluate(response: LiveResponse) {
    const tracker = response.tracker;
    if (this.disposed || response.cutting || !response.tap || !tracker) return;
    if (response.bareText) {
      await this.cutBareText(response, response.tap, tracker);
      return;
    }
    const steers = this.pending.get(response.sessionID);
    if (!steers?.size || !tracker.reasoningOpen) return;
    await this.cut(response, response.tap, tracker);
  }

  private async cutBareText(response: LiveResponse, tap: OpenCodeSseTap, tracker: OpenCodeStreamCutTracker) {
    response.cutting = true;
    const strikes = (this.strikes.get(response.sessionID) ?? 0) + 1;
    this.strikes.set(response.sessionID, strikes);
    try {
      await this.options.hint(response.sessionID);
    } catch {
      this.strikes.set(response.sessionID, BARE_TEXT_CUT_LIMIT);
      this.options.warn("OpenCode commentary hint could not be admitted; bare text is kept until the next tool call.");
      response.bareText = false;
      response.cutting = false;
      return;
    }
    if (strikes >= BARE_TEXT_CUT_LIMIT) {
      this.options.warn(`OpenCode agent answered in bare text ${strikes} times in a row; bare text is kept until its next tool call.`);
    }
    await this.cut(response, tap, tracker);
  }

  /** A cut also delivers every pending steer, so each counts as served. */
  private async cut(response: LiveResponse, tap: OpenCodeSseTap, tracker: OpenCodeStreamCutTracker) {
    response.cutting = true;
    const steers = this.pending.get(response.sessionID);
    if (steers?.size) {
      let served = this.served.get(response.sessionID);
      if (!served) this.served.set(response.sessionID, served = new Set());
      for (const inboxID of steers) served.add(inboxID);
      steers.clear();
    }
    try {
      await tap.cut(tracker.terminator());
    } catch {
      this.options.warn(`OpenCode stream cut ended the ${tracker.wire} response but could not cancel the provider body.`);
    }
  }

  private forget(response: LiveResponse) {
    const responses = this.live.get(response.sessionID);
    responses?.delete(response);
    if (responses?.size === 0) this.live.delete(response.sessionID);
  }
}
