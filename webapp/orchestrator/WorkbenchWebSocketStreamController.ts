/*
 * Exports:
 * - WorkbenchWebSocketStreamControllerState: reload handoff state for private per-connection delivery receipts and aggregate warning state. Keywords: websocket, stream, handoff, acknowledgement.
 * - WorkbenchWebSocketPreparedStreamEvent: provider-event delivery metadata committed only after serialization succeeds. Keywords: websocket, sequence, delivery.
 * - WorkbenchWebSocketStreamControllerOptions: injected clock, scheduler, and log ports. Keywords: websocket, diagnostics, test.
 * - default WorkbenchWebSocketStreamController: own provider-event sequencing, cumulative receipts, aggregate health, warning transitions, and cleanup. Keywords: websocket, backpressure, health, lifecycle.
 */
import type { WorkbenchHarness } from "../lib/types";
import {
  WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD,
  type WorkbenchEventStreamHealth,
} from "../lib/workbench/websocket-stream";
import type { BridgeClient } from "./bridge-types";

const WORKBENCH_HARNESS_FIELD = "workbenchHarness";
const BEHIND_THRESHOLD_MS = 2_000;
const BEHIND_WARNING_INTERVAL_MS = 2_000;
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";

type Timer = ReturnType<typeof setTimeout>;
type BufferedBridgeClient = BridgeClient & { readonly bufferedAmount?: number };

interface UnacknowledgedEvent {
  bytes: number;
  label: string;
  sentAt: number;
  sequence: number;
}

interface ConnectionState {
  client: BridgeClient;
  lastAcknowledgedSequence: number;
  nextSequence: number;
  unacknowledged: UnacknowledgedEvent[];
}

export interface WorkbenchWebSocketStreamControllerState {
  activityBytes: number;
  activityByLabel: Array<[string, { bytes: number; events: number }]>;
  activityEvents: number;
  behindStartedAt: number | null;
  connections: Array<{
    client: BridgeClient;
    lastAcknowledgedSequence: number;
    nextSequence: number;
    unacknowledged: UnacknowledgedEvent[];
  }>;
  nextWarningAt: number | null;
  peakSocketBufferedBytes: number;
  peakUnacknowledgedBytes: number;
  peakUnacknowledgedEvents: number;
}

export interface WorkbenchWebSocketPreparedStreamEvent {
  client: BridgeClient;
  label: string;
  message: Record<string, unknown>;
  sequence: number;
}

export interface WorkbenchWebSocketStreamControllerOptions {
  clearTimeout?: (timer: Timer) => void;
  initialState?: WorkbenchWebSocketStreamControllerState;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  writeLine?: (line: string) => void;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatBytes(value: number) {
  if (value < 1_024) return `${Math.max(0, Math.round(value))}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)}MB`;
}

function formatDuration(value: number) {
  const duration = Math.max(0, value);
  return duration < 1_000 ? `${Math.round(duration)}ms` : `${(duration / 1_000).toFixed(1)}s`;
}

function streamToken(status: "behind" | "recovered") {
  return `${status === "behind" ? ANSI_YELLOW : ANSI_GREEN}${status}${ANSI_RESET}`;
}

function readSocketBufferedBytes(client: BridgeClient) {
  const bufferedAmount = (client as BufferedBridgeClient).bufferedAmount;
  return typeof bufferedAmount === "number" && Number.isFinite(bufferedAmount)
    ? Math.max(0, bufferedAmount)
    : 0;
}

function providerEventIdentity(message: unknown) {
  const record = asRecord(message);
  if (!record || "id" in record || !("params" in record)) return null;
  const method = typeof record.method === "string" && record.method ? record.method : null;
  const harness = record[WORKBENCH_HARNESS_FIELD];
  if (!method || (harness !== "codex" && harness !== "copilot" && harness !== "opencode")) return null;
  return { harness: harness satisfies WorkbenchHarness, method, record };
}

export default class WorkbenchWebSocketStreamController {
  private activityBytes = 0;
  private readonly activityByLabel = new Map<string, { bytes: number; events: number }>();
  private activityEvents = 0;
  private behindStartedAt: number | null = null;
  private readonly cancel: NonNullable<WorkbenchWebSocketStreamControllerOptions["clearTimeout"]>;
  private readonly connections = new Map<BridgeClient, ConnectionState>();
  private detached = false;
  private readonly now: NonNullable<WorkbenchWebSocketStreamControllerOptions["now"]>;
  private nextWarningAt: number | null = null;
  private peakSocketBufferedBytes = 0;
  private peakUnacknowledgedBytes = 0;
  private peakUnacknowledgedEvents = 0;
  private readonly schedule: NonNullable<WorkbenchWebSocketStreamControllerOptions["setTimeout"]>;
  private warningTimer: Timer | null = null;
  private readonly writeLine: NonNullable<WorkbenchWebSocketStreamControllerOptions["writeLine"]>;

  constructor({
    clearTimeout: cancel = clearTimeout,
    initialState,
    now = Date.now,
    setTimeout: schedule = setTimeout,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketStreamControllerOptions = {}) {
    this.cancel = cancel;
    this.now = now;
    this.schedule = schedule;
    this.writeLine = writeLine;
    if (initialState) {
      this.activityBytes = initialState.activityBytes ?? 0;
      this.activityEvents = initialState.activityEvents ?? 0;
      for (const [label, total] of initialState.activityByLabel ?? []) this.activityByLabel.set(label, { ...total });
      this.behindStartedAt = initialState.behindStartedAt;
      this.nextWarningAt = initialState.nextWarningAt;
      this.peakSocketBufferedBytes = initialState.peakSocketBufferedBytes;
      this.peakUnacknowledgedBytes = initialState.peakUnacknowledgedBytes;
      this.peakUnacknowledgedEvents = initialState.peakUnacknowledgedEvents;
      for (const state of initialState.connections) {
        this.connections.set(state.client, {
          ...state,
          unacknowledged: state.unacknowledged.map((event) => ({ ...event })),
        });
      }
      this.scheduleWarning();
    }
  }

  connect(client: BridgeClient) {
    this.assertActive();
    this.connection(client);
  }

  prepareDelivery(client: BridgeClient, message: unknown): WorkbenchWebSocketPreparedStreamEvent | null {
    this.assertActive();
    const identity = providerEventIdentity(message);
    if (!identity) return null;
    const connection = this.connection(client);
    const sequence = connection.nextSequence++;
    return {
      client,
      label: `${identity.harness}:${identity.method}`,
      message: { ...identity.record, [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: sequence },
      sequence,
    };
  }

  commitDelivery(event: WorkbenchWebSocketPreparedStreamEvent, bytes: number) {
    this.assertActive();
    if (!this.hasUnacknowledgedEvents() && this.behindStartedAt === null) this.resetActivity();
    const connection = this.connection(event.client);
    const eventBytes = Math.max(0, bytes);
    connection.unacknowledged.push({
      bytes: eventBytes,
      label: event.label,
      sentAt: this.now(),
      sequence: event.sequence,
    });
    this.activityBytes += eventBytes;
    this.activityEvents += 1;
    const activity = this.activityByLabel.get(event.label) ?? { bytes: 0, events: 0 };
    activity.bytes += eventBytes;
    activity.events += 1;
    this.activityByLabel.set(event.label, activity);
    this.updatePeakHealth();
    this.scheduleWarning();
  }

  abandonDelivery(event: WorkbenchWebSocketPreparedStreamEvent) {
    this.assertActive();
    const connection = this.connections.get(event.client);
    if (!connection || connection.nextSequence !== event.sequence + 1) return;
    if (connection.unacknowledged.some((candidate) => candidate.sequence === event.sequence)) return;
    connection.nextSequence = event.sequence;
  }

  failDelivery(event: WorkbenchWebSocketPreparedStreamEvent) {
    this.assertActive();
    const connection = this.connections.get(event.client);
    if (!connection) return;
    connection.unacknowledged = connection.unacknowledged.filter((candidate) => candidate.sequence !== event.sequence);
    this.updateHealthTransition();
  }

  acknowledge(client: BridgeClient, sequence: number) {
    this.assertActive();
    const connection = this.connection(client);
    if (sequence >= connection.nextSequence) {
      this.writeLine(` WS stream invalid acknowledgement`);
      return false;
    }
    if (sequence <= connection.lastAcknowledgedSequence) return true;
    connection.lastAcknowledgedSequence = sequence;
    connection.unacknowledged = connection.unacknowledged.filter((event) => event.sequence > sequence);
    this.updateHealthTransition();
    return true;
  }

  reportInvalidAcknowledgement() {
    this.assertActive();
    this.writeLine(` WS stream invalid acknowledgement`);
  }

  readEventStreamHealth(): WorkbenchEventStreamHealth {
    this.assertActive();
    const now = this.now();
    let behindConsumers = 0;
    let oldestUnacknowledgedMs = 0;
    let socketBufferedBytes = 0;
    let unacknowledgedBytes = 0;
    let unacknowledgedEvents = 0;
    for (const connection of this.connections.values()) {
      const oldest = connection.unacknowledged[0];
      const age = oldest ? Math.max(0, now - oldest.sentAt) : 0;
      if (age >= BEHIND_THRESHOLD_MS) behindConsumers += 1;
      oldestUnacknowledgedMs = Math.max(oldestUnacknowledgedMs, age);
      socketBufferedBytes += readSocketBufferedBytes(connection.client);
      unacknowledgedEvents += connection.unacknowledged.length;
      for (const event of connection.unacknowledged) unacknowledgedBytes += event.bytes;
    }
    return {
      behind: behindConsumers > 0,
      behindConsumers,
      connectedConsumers: this.connections.size,
      oldestUnacknowledgedMs,
      socketBufferedBytes,
      unacknowledgedBytes,
      unacknowledgedEvents,
    };
  }

  disconnect(client: BridgeClient) {
    this.assertActive();
    this.connections.delete(client);
    this.updateHealthTransition();
  }

  detachForReload(): WorkbenchWebSocketStreamControllerState {
    this.assertActive();
    this.detached = true;
    if (this.warningTimer !== null) this.cancel(this.warningTimer);
    this.warningTimer = null;
    return {
      activityBytes: this.activityBytes,
      activityByLabel: [...this.activityByLabel.entries()].map(([label, total]) => [label, { ...total }]),
      activityEvents: this.activityEvents,
      behindStartedAt: this.behindStartedAt,
      connections: [...this.connections.values()].map((state) => ({
        client: state.client,
        lastAcknowledgedSequence: state.lastAcknowledgedSequence,
        nextSequence: state.nextSequence,
        unacknowledged: state.unacknowledged.map((event) => ({ ...event })),
      })),
      nextWarningAt: this.nextWarningAt,
      peakSocketBufferedBytes: this.peakSocketBufferedBytes,
      peakUnacknowledgedBytes: this.peakUnacknowledgedBytes,
      peakUnacknowledgedEvents: this.peakUnacknowledgedEvents,
    };
  }

  dispose() {
    if (this.detached) return;
    this.detached = true;
    if (this.warningTimer !== null) this.cancel(this.warningTimer);
    this.warningTimer = null;
    this.connections.clear();
  }

  private connection(client: BridgeClient) {
    const existing = this.connections.get(client);
    if (existing) return existing;
    const state: ConnectionState = {
      client,
      lastAcknowledgedSequence: 0,
      nextSequence: 1,
      unacknowledged: [],
    };
    this.connections.set(client, state);
    return state;
  }

  private scheduleWarning() {
    if (this.warningTimer !== null) this.cancel(this.warningTimer);
    this.warningTimer = null;
    const nextWarningAt = this.nextScheduledWarningAt();
    this.nextWarningAt = nextWarningAt;
    if (nextWarningAt === null) return;
    this.warningTimer = this.schedule(() => {
      this.warningTimer = null;
      if (this.detached) return;
      this.updateHealthTransition(true);
    }, Math.max(0, nextWarningAt - this.now()));
  }

  private nextScheduledWarningAt() {
    if (this.behindStartedAt !== null) return this.nextWarningAt ?? this.now() + BEHIND_WARNING_INTERVAL_MS;
    let next: number | null = null;
    for (const connection of this.connections.values()) {
      const oldest = connection.unacknowledged[0];
      if (!oldest) continue;
      const candidate = oldest.sentAt + BEHIND_THRESHOLD_MS;
      next = next === null ? candidate : Math.min(next, candidate);
    }
    return next;
  }

  private updateHealthTransition(writeBehind = false) {
    const health = this.readEventStreamHealth();
    if (!health.behind) {
      if (this.behindStartedAt !== null) this.writeRecovered(health);
      else if (health.unacknowledgedEvents === 0) this.resetActivity();
      this.scheduleWarning();
      return;
    }

    if (this.behindStartedAt === null) this.behindStartedAt = this.now() - health.oldestUnacknowledgedMs;
    this.updatePeakHealth(health);
    if (writeBehind) this.writeBehind(health);
    this.nextWarningAt = this.now() + BEHIND_WARNING_INTERVAL_MS;
    this.scheduleWarning();
  }

  private updatePeakHealth(health = this.readEventStreamHealth()) {
    if (this.behindStartedAt === null && !health.behind) return;
    this.peakSocketBufferedBytes = Math.max(this.peakSocketBufferedBytes, health.socketBufferedBytes);
    this.peakUnacknowledgedBytes = Math.max(this.peakUnacknowledgedBytes, health.unacknowledgedBytes);
    this.peakUnacknowledgedEvents = Math.max(this.peakUnacknowledgedEvents, health.unacknowledgedEvents);
  }

  private writeBehind(health: WorkbenchEventStreamHealth) {
    const top = this.topActivityLabel();
    this.writeLine(` WS stream ${streamToken("behind")} for ${formatDuration(this.now() - (this.behindStartedAt ?? this.now()))} (consumers: ${health.behindConsumers}/${health.connectedConsumers} behind, unacked: ${health.unacknowledgedEvents}/${formatBytes(health.unacknowledgedBytes)}, socket: ${formatBytes(health.socketBufferedBytes)}, oldest: ${formatDuration(health.oldestUnacknowledgedMs)}, received: ${this.activityEvents}/${formatBytes(this.activityBytes)}, top: ${top})`);
  }

  private writeRecovered(health: WorkbenchEventStreamHealth) {
    this.updatePeakHealth(health);
    this.writeLine(` WS stream ${streamToken("recovered")} in ${formatDuration(this.now() - (this.behindStartedAt ?? this.now()))} (consumers: ${health.connectedConsumers}, peak unacked: ${this.peakUnacknowledgedEvents}/${formatBytes(this.peakUnacknowledgedBytes)}, peak socket: ${formatBytes(this.peakSocketBufferedBytes)})`);
    this.behindStartedAt = null;
    this.nextWarningAt = null;
    this.peakSocketBufferedBytes = 0;
    this.peakUnacknowledgedBytes = 0;
    this.peakUnacknowledgedEvents = 0;
    this.resetActivity();
  }

  private topActivityLabel() {
    const top = [...this.activityByLabel.entries()].sort((left, right) => right[1].bytes - left[1].bytes || right[1].events - left[1].events || left[0].localeCompare(right[0]))[0];
    return top ? `${top[0]} ${top[1].events}/${formatBytes(top[1].bytes)}` : "none";
  }

  private hasUnacknowledgedEvents() {
    for (const connection of this.connections.values()) if (connection.unacknowledged.length) return true;
    return false;
  }

  private resetActivity() {
    this.activityBytes = 0;
    this.activityByLabel.clear();
    this.activityEvents = 0;
  }

  private assertActive() {
    if (this.detached) throw new Error("Workbench WebSocket stream controller is detached.");
  }
}
