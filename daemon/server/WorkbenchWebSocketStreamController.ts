/*
 * Exports:
 * - WorkbenchWebSocketStreamControllerState: reload handoff state for private delivery receipts, lag incidents, and warning cadence.
 * - WorkbenchWebSocketRuntimeMemorySample: one bounded process-memory sample carried through stream reload.
 * - WorkbenchWebSocketRuntimePressureState: reload handoff state for warning lateness and process-memory evidence.
 * - WorkbenchWebSocketPreparedStreamEvent: provider-event delivery metadata committed only after serialization succeeds.
 * - WorkbenchWebSocketStreamControllerOptions: injected clock, scheduler, and log ports.
 * - default WorkbenchWebSocketStreamController: own provider-event sequencing, receipts, stream health, lag reports, reload handoff, and cleanup.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD,
  type WorkbenchEventStreamHealth,
} from "workbench-shared/workbench/websocket-stream";
import type { BridgeClient } from "./bridge-types";
import { dimWebSocketDetail } from "./websocket-log-format";

const WORKBENCH_HARNESS_FIELD = "workbenchHarness";
const BEHIND_THRESHOLD_MS = 2_000;
const BEHIND_WARNING_INTERVAL_MS = 2_000;
const MEMORY_BASELINE_SAMPLE_INTERVAL_MS = 2_000;
const INCIDENT_REPORT_INTERVAL_MS = 30_000;
const MAX_INCIDENT_RANKING_ENTRIES = 3;
const ANSI_BOLD = "\u001b[1m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";

type Timer = ReturnType<typeof setTimeout>;
type BufferedBridgeClient = BridgeClient & { readonly bufferedAmount?: number };
type StreamIncidentEndCause = "acknowledged" | "delivery failed" | "disconnected";

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

interface StreamIncidentLabelStats {
  acknowledgedBytes: number;
  acknowledgedEvents: number;
  currentBytes: number;
  currentEvents: number;
  disconnectedBytes: number;
  disconnectedEvents: number;
  failedBytes: number;
  failedEvents: number;
  longestUnacknowledgedMs: number;
  observedBytes: number;
  observedEvents: number;
  peakBytes: number;
  peakEvents: number;
}

interface StreamIncidentState {
  affectedClients: BridgeClient[];
  affectedConsumers: number;
  byLabel: Array<[string, StreamIncidentLabelStats]>;
}

interface StreamIncident {
  affectedClients: Set<BridgeClient>;
  affectedConsumers: number;
  byLabel: Map<string, StreamIncidentLabelStats>;
}

export interface WorkbenchWebSocketRuntimeMemorySample {
  heapTotalBytes: number;
  heapUsedBytes: number;
  rssBytes: number;
}

export interface WorkbenchWebSocketRuntimePressureState {
  baselineMemory: WorkbenchWebSocketRuntimeMemorySample;
  currentMemory: WorkbenchWebSocketRuntimeMemorySample;
  latestWarningLatenessMs: number;
  peakHeapUsedBytes: number;
  peakRssBytes: number;
  peakWarningLatenessMs: number;
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
  incident?: StreamIncidentState | null;
  nextIncidentReportAt?: number | null;
  nextWarningAt: number | null;
  peakSocketBufferedBytes: number;
  peakUnacknowledgedBytes: number;
  peakUnacknowledgedEvents: number;
  runtimePressure?: WorkbenchWebSocketRuntimePressureState | null;
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
  readMemoryUsage?: () => Pick<NodeJS.MemoryUsage, "heapTotal" | "heapUsed" | "rss">;
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

function formatSignedBytes(value: number) {
  return `${value >= 0 ? "+" : "-"}${formatBytes(Math.abs(value))}`;
}

function formatEventVolume(events: number, bytes: number) {
  const eventCount = Math.max(0, events);
  return `${eventCount} ${eventCount === 1 ? "event" : "events"} / ${formatBytes(bytes)}`;
}

function sanitizeDiagnosticLabel(value: string) {
  return value.replace(/[^A-Za-z0-9:./_-]/gu, "?").slice(0, 120) || "unknown";
}

function streamToken(status: "behind" | "ended" | "recovered") {
  return `${status === "recovered" ? ANSI_GREEN : ANSI_YELLOW}${status}${ANSI_RESET}`;
}

function sectionHeading(value: string) {
  return `${ANSI_BOLD}${value}${ANSI_RESET}`;
}

function createIncidentLabelStats(): StreamIncidentLabelStats {
  return {
    acknowledgedBytes: 0,
    acknowledgedEvents: 0,
    currentBytes: 0,
    currentEvents: 0,
    disconnectedBytes: 0,
    disconnectedEvents: 0,
    failedBytes: 0,
    failedEvents: 0,
    longestUnacknowledgedMs: 0,
    observedBytes: 0,
    observedEvents: 0,
    peakBytes: 0,
    peakEvents: 0,
  };
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
  private state: "active" | "suspended" | "disposed" = "active";
  private incident: StreamIncident | null = null;
  private lastMemorySample: WorkbenchWebSocketRuntimeMemorySample | null = null;
  private lastMemorySampleAt: number | null = null;
  private readonly now: NonNullable<WorkbenchWebSocketStreamControllerOptions["now"]>;
  private nextIncidentReportAt: number | null = null;
  private nextWarningAt: number | null = null;
  private peakSocketBufferedBytes = 0;
  private peakUnacknowledgedBytes = 0;
  private peakUnacknowledgedEvents = 0;
  private readonly readMemoryUsage: NonNullable<WorkbenchWebSocketStreamControllerOptions["readMemoryUsage"]>;
  private runtimePressure: WorkbenchWebSocketRuntimePressureState | null = null;
  private readonly schedule: NonNullable<WorkbenchWebSocketStreamControllerOptions["setTimeout"]>;
  private warningTimer: Timer | null = null;
  private readonly writeLine: NonNullable<WorkbenchWebSocketStreamControllerOptions["writeLine"]>;

  constructor({
    clearTimeout: cancel = clearTimeout,
    initialState,
    now = Date.now,
    readMemoryUsage = process.memoryUsage,
    setTimeout: schedule = setTimeout,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketStreamControllerOptions = {}) {
    this.cancel = cancel;
    this.now = now;
    this.readMemoryUsage = readMemoryUsage;
    this.schedule = schedule;
    this.writeLine = writeLine;
    if (initialState) {
      this.activityBytes = initialState.activityBytes ?? 0;
      this.activityEvents = initialState.activityEvents ?? 0;
      for (const [label, total] of initialState.activityByLabel ?? []) this.activityByLabel.set(label, { ...total });
      this.behindStartedAt = initialState.behindStartedAt;
      this.nextIncidentReportAt = initialState.nextIncidentReportAt
        ?? this.nextIncidentReportBoundary(this.now());
      this.nextWarningAt = initialState.nextWarningAt;
      this.peakSocketBufferedBytes = initialState.peakSocketBufferedBytes;
      this.peakUnacknowledgedBytes = initialState.peakUnacknowledgedBytes;
      this.peakUnacknowledgedEvents = initialState.peakUnacknowledgedEvents;
      this.runtimePressure = initialState.runtimePressure
        ? {
          ...initialState.runtimePressure,
          baselineMemory: { ...initialState.runtimePressure.baselineMemory },
          currentMemory: { ...initialState.runtimePressure.currentMemory },
        }
        : null;
      for (const state of initialState.connections) {
        this.connections.set(state.client, {
          ...state,
          unacknowledged: state.unacknowledged.map((event) => ({ ...event })),
        });
      }
      if (!this.runtimePressure && this.hasUnacknowledgedEvents()) this.startRuntimePressure();
      if (initialState.incident) {
        this.incident = {
          affectedClients: new Set(initialState.incident.affectedClients.filter((client) => this.connections.has(client))),
          affectedConsumers: initialState.incident.affectedConsumers,
          byLabel: new Map(initialState.incident.byLabel.map(([label, stats]) => [label, { ...stats }])),
        };
      } else if (this.behindStartedAt !== null) {
        this.captureBehindConsumers();
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
      label: sanitizeDiagnosticLabel(`${identity.harness}:${identity.method}`),
      message: { ...identity.record, [WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD]: sequence },
      sequence,
    };
  }

  commitDelivery(event: WorkbenchWebSocketPreparedStreamEvent, bytes: number) {
    this.assertActive();
    if (!this.hasUnacknowledgedEvents() && this.behindStartedAt === null) {
      this.resetActivity();
      this.startRuntimePressure();
    }
    const connection = this.connection(event.client);
    const eventBytes = Math.max(0, bytes);
    connection.unacknowledged.push({
      bytes: eventBytes,
      label: event.label,
      sentAt: this.now(),
      sequence: event.sequence,
    });
    if (this.incident?.affectedClients.has(event.client)) {
      this.trackIncidentDelivery(connection.unacknowledged.at(-1)!);
    }
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
    const failed = connection.unacknowledged.filter((candidate) => candidate.sequence === event.sequence);
    connection.unacknowledged = connection.unacknowledged.filter((candidate) => candidate.sequence !== event.sequence);
    this.resolveIncidentDeliveries(event.client, failed, "delivery failed");
    this.updateHealthTransition(false, "delivery failed");
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
    const acknowledged = connection.unacknowledged.filter((event) => event.sequence <= sequence);
    connection.unacknowledged = connection.unacknowledged.filter((event) => event.sequence > sequence);
    this.resolveIncidentDeliveries(client, acknowledged, "acknowledged");
    this.updateHealthTransition(false, "acknowledged");
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
    const connection = this.connections.get(client);
    if (connection) this.resolveIncidentDeliveries(client, connection.unacknowledged, "disconnected");
    this.connections.delete(client);
    this.incident?.affectedClients.delete(client);
    this.updateHealthTransition(false, "disconnected");
  }

  detachForReload(): WorkbenchWebSocketStreamControllerState {
    if (this.state === "disposed") throw new Error("Workbench WebSocket stream controller is disposed.");
    this.suspend();
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
      incident: this.incident
        ? {
          affectedClients: [...this.incident.affectedClients],
          affectedConsumers: this.incident.affectedConsumers,
          byLabel: [...this.incident.byLabel.entries()].map(([label, stats]) => [label, { ...stats }]),
        }
        : null,
      nextIncidentReportAt: this.nextIncidentReportAt,
      nextWarningAt: this.nextWarningAt,
      peakSocketBufferedBytes: this.peakSocketBufferedBytes,
      peakUnacknowledgedBytes: this.peakUnacknowledgedBytes,
      peakUnacknowledgedEvents: this.peakUnacknowledgedEvents,
      runtimePressure: this.runtimePressure
        ? {
          ...this.runtimePressure,
          baselineMemory: { ...this.runtimePressure.baselineMemory },
          currentMemory: { ...this.runtimePressure.currentMemory },
        }
        : null,
    };
  }

  dispose() {
    if (this.state === "disposed") return;
    this.state = "disposed";
    if (this.warningTimer !== null) this.cancel(this.warningTimer);
    this.warningTimer = null;
    this.connections.clear();
  }

  suspend() {
    if (this.state === "disposed") throw new Error("WebSocket stream controller is disposed.");
    this.state = "suspended";
    if (this.warningTimer !== null) this.cancel(this.warningTimer);
    this.warningTimer = null;
  }

  resumeAfterFailedReload() {
    if (this.state === "disposed") throw new Error("WebSocket stream controller is disposed.");
    this.state = "active";
    this.scheduleWarning();
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
    if (this.state !== "active") return;
    const nextWarningAt = this.nextScheduledWarningAt();
    if (nextWarningAt === null) {
      if (this.warningTimer !== null) this.cancel(this.warningTimer);
      this.warningTimer = null;
      this.nextWarningAt = null;
      return;
    }
    if (
      this.warningTimer !== null
      && this.nextWarningAt !== null
      && this.nextWarningAt <= nextWarningAt
    ) return;
    if (this.warningTimer !== null) this.cancel(this.warningTimer);
    this.nextWarningAt = nextWarningAt;
    const timer = this.schedule(() => {
      if (this.warningTimer !== timer || this.state !== "active") return;
      const callbackAt = this.now();
      this.warningTimer = null;
      this.nextWarningAt = null;
      this.sampleRuntimePressure(callbackAt, nextWarningAt);
      this.updateHealthTransition(true);
    }, Math.max(0, nextWarningAt - this.now()));
    this.warningTimer = timer;
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

  private updateHealthTransition(writeBehind = false, endCause: StreamIncidentEndCause = "acknowledged") {
    const health = this.readEventStreamHealth();
    if (!health.behind) {
      if (this.behindStartedAt !== null) this.writeIncidentConclusion(health, endCause);
      else if (health.unacknowledgedEvents === 0) this.resetActivity();
      this.scheduleWarning();
      return;
    }

    if (this.behindStartedAt === null) {
      this.behindStartedAt = this.now() - health.oldestUnacknowledgedMs;
      this.nextIncidentReportAt = this.behindStartedAt + INCIDENT_REPORT_INTERVAL_MS;
    }
    this.captureBehindConsumers();
    this.updatePeakHealth(health);
    if (writeBehind) {
      if (this.nextIncidentReportAt !== null && this.now() >= this.nextIncidentReportAt) {
        this.writeIncidentReport(health, "behind");
        do this.nextIncidentReportAt += INCIDENT_REPORT_INTERVAL_MS;
        while (this.nextIncidentReportAt <= this.now());
      } else {
        this.writeBehind(health);
      }
    }
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
    const runtime = this.runtimePressure;
    const runtimeSuffix = runtime
      ? `, warning callback: ${formatDuration(runtime.latestWarningLatenessMs)} late, rss: ${formatBytes(runtime.currentMemory.rssBytes)}, heap: ${formatBytes(runtime.currentMemory.heapUsedBytes)}/${formatBytes(runtime.currentMemory.heapTotalBytes)}`
      : "";
    const detail = dimWebSocketDetail(`(consumers: ${health.behindConsumers}/${health.connectedConsumers} behind, unacked: ${health.unacknowledgedEvents}/${formatBytes(health.unacknowledgedBytes)}, socket: ${formatBytes(health.socketBufferedBytes)}, oldest: ${formatDuration(health.oldestUnacknowledgedMs)}, received: ${this.activityEvents}/${formatBytes(this.activityBytes)}, top received: ${top}${runtimeSuffix})`);
    this.writeLine(` WS stream ${streamToken("behind")} for ${formatDuration(this.now() - (this.behindStartedAt ?? this.now()))} ${detail}`);
  }

  private writeIncidentConclusion(health: WorkbenchEventStreamHealth, cause: StreamIncidentEndCause) {
    this.sampleRuntimePressure(this.now());
    this.writeIncidentReport(health, cause === "acknowledged" ? "recovered" : "ended", cause);
    this.behindStartedAt = null;
    this.incident = null;
    this.nextIncidentReportAt = null;
    this.nextWarningAt = null;
    this.peakSocketBufferedBytes = 0;
    this.peakUnacknowledgedBytes = 0;
    this.peakUnacknowledgedEvents = 0;
    this.resetActivity();
  }

  private writeIncidentReport(
    health: WorkbenchEventStreamHealth,
    status: "behind" | "ended" | "recovered",
    cause?: StreamIncidentEndCause,
  ) {
    this.updatePeakHealth(health);
    this.refreshIncidentLongestAges();
    const incident = this.incident ?? {
      affectedClients: new Set<BridgeClient>(),
      affectedConsumers: 0,
      byLabel: new Map<string, StreamIncidentLabelStats>(),
    };
    const labels = [...incident.byLabel.entries()];
    const totals = labels.reduce((total, [, stats]) => ({
      acknowledgedBytes: total.acknowledgedBytes + stats.acknowledgedBytes,
      acknowledgedEvents: total.acknowledgedEvents + stats.acknowledgedEvents,
      currentBytes: total.currentBytes + stats.currentBytes,
      currentEvents: total.currentEvents + stats.currentEvents,
      disconnectedBytes: total.disconnectedBytes + stats.disconnectedBytes,
      disconnectedEvents: total.disconnectedEvents + stats.disconnectedEvents,
      failedBytes: total.failedBytes + stats.failedBytes,
      failedEvents: total.failedEvents + stats.failedEvents,
    }), {
      acknowledgedBytes: 0,
      acknowledgedEvents: 0,
      currentBytes: 0,
      currentEvents: 0,
      disconnectedBytes: 0,
      disconnectedEvents: 0,
      failedBytes: 0,
      failedEvents: 0,
    });
    const byCount = this.rankIncidentLabels(labels, (stats) => stats.observedEvents);
    const bySize = this.rankIncidentLabels(labels, (stats) => stats.observedBytes);
    const byDuration = this.rankIncidentLabels(labels, (stats) => stats.longestUnacknowledgedMs);
    const causeSuffix = cause ? ` ${dimWebSocketDetail(`(cause: ${cause})`)}` : "";
    const runtimePressure = this.formatRuntimePressure();
    const report = [
      ` WS stream ${streamToken(status)} after ${formatDuration(this.now() - (this.behindStartedAt ?? this.now()))}${causeSuffix}`,
      dimWebSocketDetail(`   consumers: ${incident.affectedConsumers} affected / ${health.connectedConsumers} connected`),
      dimWebSocketDetail(`   stream pressure: peak ${formatEventVolume(this.peakUnacknowledgedEvents, this.peakUnacknowledgedBytes)} unacknowledged | peak socket ${formatBytes(this.peakSocketBufferedBytes)}`),
      ...runtimePressure.map(dimWebSocketDetail),
      dimWebSocketDetail(`   outcomes: ${formatEventVolume(totals.acknowledgedEvents, totals.acknowledgedBytes)} acknowledged | ${formatEventVolume(totals.failedEvents, totals.failedBytes)} delivery failed | ${formatEventVolume(totals.disconnectedEvents, totals.disconnectedBytes)} disconnected | ${formatEventVolume(totals.currentEvents, totals.currentBytes)} still pending`),
      ...this.formatIncidentRanking(
        "unacked by count:",
        byCount,
        (stats) => `${stats.observedEvents} ${stats.observedEvents === 1 ? "event" : "events"} (${formatBytes(stats.observedBytes)}, longest unacked ${formatDuration(stats.longestUnacknowledgedMs)})`,
      ),
      ...this.formatIncidentRanking(
        "unacked by size:",
        bySize,
        (stats) => `${formatBytes(stats.observedBytes)} (${stats.observedEvents} ${stats.observedEvents === 1 ? "event" : "events"}, longest unacked ${formatDuration(stats.longestUnacknowledgedMs)})`,
      ),
      ...this.formatIncidentRanking(
        "longest unacked:",
        byDuration,
        (stats) => `${formatDuration(stats.longestUnacknowledgedMs)} (${formatEventVolume(stats.observedEvents, stats.observedBytes)})`,
      ),
    ];
    this.writeLine(report.join("\n"));
  }

  private rankIncidentLabels(
    labels: Array<[string, StreamIncidentLabelStats]>,
    metric: (stats: StreamIncidentLabelStats) => number,
  ) {
    return [...labels]
      .sort((left, right) => metric(right[1]) - metric(left[1]) || left[0].localeCompare(right[0]))
      .slice(0, MAX_INCIDENT_RANKING_ENTRIES);
  }

  private formatIncidentRanking(
    heading: string,
    labels: Array<[string, StreamIncidentLabelStats]>,
    formatMetric: (stats: StreamIncidentLabelStats) => string,
  ) {
    return [
      `   ${sectionHeading(heading)}`,
      ...(labels.length
        ? labels.map(([label, stats], index) => `     ${index + 1}. ${label} | ${formatMetric(stats)}`)
        : ["     none"]),
    ].map(dimWebSocketDetail);
  }

  private formatRuntimePressure() {
    const runtime = this.runtimePressure;
    if (!runtime) return [];
    const rssGrowth = runtime.currentMemory.rssBytes - runtime.baselineMemory.rssBytes;
    const heapGrowth = runtime.currentMemory.heapUsedBytes - runtime.baselineMemory.heapUsedBytes;
    return [
      `   ${sectionHeading("runtime pressure:")}`,
      `     warning callback: ${formatDuration(runtime.latestWarningLatenessMs)} late | peak ${formatDuration(runtime.peakWarningLatenessMs)} late`,
      `     daemon rss: ${formatBytes(runtime.currentMemory.rssBytes)} current | ${formatBytes(runtime.peakRssBytes)} peak | ${formatSignedBytes(rssGrowth)} from first unacked`,
      `     daemon heap: ${formatBytes(runtime.currentMemory.heapUsedBytes)} / ${formatBytes(runtime.currentMemory.heapTotalBytes)} current | ${formatBytes(runtime.peakHeapUsedBytes)} peak | ${formatSignedBytes(heapGrowth)} from first unacked`,
    ];
  }

  private readFreshMemorySample(observedAt: number): WorkbenchWebSocketRuntimeMemorySample {
    const memory = this.readMemoryUsage();
    const sample = {
      heapTotalBytes: Math.max(0, Number.isFinite(memory.heapTotal) ? memory.heapTotal : 0),
      heapUsedBytes: Math.max(0, Number.isFinite(memory.heapUsed) ? memory.heapUsed : 0),
      rssBytes: Math.max(0, Number.isFinite(memory.rss) ? memory.rss : 0),
    };
    this.lastMemorySample = sample;
    this.lastMemorySampleAt = observedAt;
    return sample;
  }

  private sampleRuntimePressure(observedAt: number, warningDeadline?: number) {
    if (!this.runtimePressure) this.startRuntimePressure();
    const runtime = this.runtimePressure!;
    const memory = this.readFreshMemorySample(observedAt);
    const warningLatenessMs = warningDeadline === undefined
      ? runtime.latestWarningLatenessMs
      : Math.max(0, observedAt - warningDeadline);
    runtime.currentMemory = memory;
    runtime.latestWarningLatenessMs = warningLatenessMs;
    runtime.peakHeapUsedBytes = Math.max(runtime.peakHeapUsedBytes, memory.heapUsedBytes);
    runtime.peakRssBytes = Math.max(runtime.peakRssBytes, memory.rssBytes);
    runtime.peakWarningLatenessMs = Math.max(runtime.peakWarningLatenessMs, warningLatenessMs);
  }

  private startRuntimePressure() {
    const observedAt = this.now();
    const memory = this.lastMemorySample && this.lastMemorySampleAt !== null
      && observedAt - this.lastMemorySampleAt < MEMORY_BASELINE_SAMPLE_INTERVAL_MS
      ? this.lastMemorySample
      : this.readFreshMemorySample(observedAt);
    this.runtimePressure = {
      baselineMemory: memory,
      currentMemory: memory,
      latestWarningLatenessMs: 0,
      peakHeapUsedBytes: memory.heapUsedBytes,
      peakRssBytes: memory.rssBytes,
      peakWarningLatenessMs: 0,
    };
  }

  private nextIncidentReportBoundary(now: number) {
    if (this.behindStartedAt === null) return null;
    const elapsed = Math.max(0, now - this.behindStartedAt);
    const boundary = Math.max(1, Math.ceil(elapsed / INCIDENT_REPORT_INTERVAL_MS));
    return this.behindStartedAt + boundary * INCIDENT_REPORT_INTERVAL_MS;
  }

  private captureBehindConsumers() {
    const now = this.now();
    if (!this.incident) {
      this.incident = {
        affectedClients: new Set(),
        affectedConsumers: 0,
        byLabel: new Map(),
      };
    }
    for (const connection of this.connections.values()) {
      const oldest = connection.unacknowledged[0];
      if (!oldest || now - oldest.sentAt < BEHIND_THRESHOLD_MS || this.incident.affectedClients.has(connection.client)) continue;
      this.incident.affectedClients.add(connection.client);
      this.incident.affectedConsumers += 1;
      for (const event of connection.unacknowledged) this.trackIncidentDelivery(event, now);
    }
  }

  private incidentStats(label: string) {
    if (!this.incident) throw new Error("Workbench WebSocket stream incident is unavailable.");
    const existing = this.incident.byLabel.get(label);
    if (existing) return existing;
    const created = createIncidentLabelStats();
    this.incident.byLabel.set(label, created);
    return created;
  }

  private trackIncidentDelivery(event: UnacknowledgedEvent, observedAt = event.sentAt) {
    const stats = this.incidentStats(event.label);
    stats.currentBytes += event.bytes;
    stats.currentEvents += 1;
    stats.longestUnacknowledgedMs = Math.max(stats.longestUnacknowledgedMs, observedAt - event.sentAt);
    stats.observedBytes += event.bytes;
    stats.observedEvents += 1;
    stats.peakBytes = Math.max(stats.peakBytes, stats.currentBytes);
    stats.peakEvents = Math.max(stats.peakEvents, stats.currentEvents);
  }

  private resolveIncidentDeliveries(client: BridgeClient, events: UnacknowledgedEvent[], cause: StreamIncidentEndCause) {
    if (!this.incident?.affectedClients.has(client)) return;
    const resolvedAt = this.now();
    for (const event of events) {
      const stats = this.incidentStats(event.label);
      stats.currentBytes -= event.bytes;
      stats.currentEvents -= 1;
      if (stats.currentBytes < 0 || stats.currentEvents < 0) {
        throw new Error(`Workbench WebSocket stream incident counters drifted for ${event.label}.`);
      }
      stats.longestUnacknowledgedMs = Math.max(stats.longestUnacknowledgedMs, resolvedAt - event.sentAt);
      if (cause === "acknowledged") {
        stats.acknowledgedBytes += event.bytes;
        stats.acknowledgedEvents += 1;
      } else if (cause === "delivery failed") {
        stats.failedBytes += event.bytes;
        stats.failedEvents += 1;
      } else {
        stats.disconnectedBytes += event.bytes;
        stats.disconnectedEvents += 1;
      }
    }
  }

  private refreshIncidentLongestAges() {
    if (!this.incident) return;
    const now = this.now();
    for (const client of this.incident.affectedClients) {
      const connection = this.connections.get(client);
      if (!connection) continue;
      for (const event of connection.unacknowledged) {
        const stats = this.incident.byLabel.get(event.label);
        if (stats) stats.longestUnacknowledgedMs = Math.max(stats.longestUnacknowledgedMs, now - event.sentAt);
      }
    }
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
    this.runtimePressure = null;
  }

  private assertActive() {
    if (this.state !== "active") throw new Error("Workbench WebSocket stream controller is detached.");
  }
}
