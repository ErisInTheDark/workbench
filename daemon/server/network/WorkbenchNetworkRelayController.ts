/*
 * Exports:
 * - RelayUnavailableError: no connected app could take a relay request; nothing was dispatched.
 * - RelayOutcomeUnknownError: an app took a request and then disconnected or fell silent; it may have run.
 * - getProcessNetworkRelay: the process-wide relay to apps, kept across reloads of the module and socket routing.
 * - default WorkbenchNetworkRelayController: own each app connection's relay presence and every relay request's single dispatch.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { DaemonId } from "workbench-shared/workbench/identity";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  RELAY_REQUEST_METHOD, RelayOutcomeSchema, RelayPresenceSchema, RelayRequestSchema, relayResultSchemas,
  type RelayOutcome, type RelayPresence, type RelayRequest,
} from "workbench-shared/workbench/network/network-relay-contracts";

/** How long an app may take to accept a request before it counts as unable. */
const RELAY_ACK_DEADLINE_MS = 5_000;
const PROCESS_STATE_KEY = Symbol.for("workbench.networkRelay.v1");

export class RelayUnavailableError extends Error {}
export class RelayOutcomeUnknownError extends Error {}

type Client = object;
type Send = (client: Client, message: object) => void;
interface Pending {
  client: Client;
  accepted: boolean;
  settle(outcome: RelayOutcome | { kind: "disconnected" }): void;
}
interface RelayState {
  presence: Map<Client, RelayPresence>;
  pending: Map<string, Pending>;
  send: Send | null;
  /** Told whenever any connection's presence changes, such as daemon sleep re-checking attendance. */
  listeners: Set<() => void>;
}

function processState(): RelayState {
  let state = Reflect.get(globalThis, PROCESS_STATE_KEY) as RelayState | undefined;
  if (!state) {
    state = { presence: new Map(), pending: new Map(), send: null, listeners: new Set() };
    Reflect.set(globalThis, PROCESS_STATE_KEY, state);
  }
  return state;
}

type ResultOf<Kind extends RelayRequest["kind"]> = z.infer<(typeof relayResultSchemas)[Kind]>;

/**
 * Reads can try the next app after an unacknowledged deadline; anything else must not, since a late-accepting app
 * may already have dispatched it.
 */
const RETRYABLE_AFTER_SILENCE = new Set<RelayRequest["kind"]>(["resolve", "summary", "gitPeerFetch"]);

interface Lookup<Result> {
  merge(found: Result, next: Result): Result;
  complete(found: Result): boolean;
}

/** Side-effect-free lookups whose answer depends on which daemons the answering app reaches. */
const LOOKUPS: { [Kind in "resolve" | "summary"]: Lookup<ResultOf<Kind>> } = {
  resolve: {
    merge: (found, next) => ({ targets: found.targets.map((target, index) => target.kind === "resolved" ? target : next.targets[index] ?? target) }),
    complete: found => found.targets.every(target => target.kind === "resolved"),
  },
  summary: {
    merge: (found, next) => ({ summaries: Object.fromEntries(Object.entries(found.summaries).map(([id, summary]) => [id, summary ?? next.summaries[id] ?? null])) }),
    complete: found => Object.values(found.summaries).every(summary => summary !== null),
  },
};

export default class WorkbenchNetworkRelayController {
  constructor(private readonly state: RelayState, private readonly timers: {
    schedule(run: () => void, ms: number): unknown;
    cancel(timer: unknown): void;
  } = { schedule: (run, ms) => setTimeout(run, ms), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }) {}

  /** The process sends through whichever socket routing generation is current. */
  attachTransport(send: Send) { this.state.send = send; }

  subscribe(listener: () => void) {
    this.state.listeners.add(listener);
    return () => { this.state.listeners.delete(listener); };
  }

  acceptPresence(client: Client, params: unknown) {
    const presence = conformToZodSchema(RelayPresenceSchema.nullable(), params, null).data;
    if (!presence) return;
    this.state.presence.set(client, presence);
    this.changed();
  }

  private changed() {
    for (const listener of [...this.state.listeners]) listener();
  }

  acceptResult(client: Client, params: unknown) {
    const parsed = conformToZodSchema(RelayOutcomeSchema.nullable(), (params as { outcome?: unknown } | null)?.outcome, null).data;
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    const pending = typeof requestId === "string" ? this.state.pending.get(requestId) : undefined;
    if (!parsed || !pending || pending.client !== client) return;
    pending.settle(parsed);
  }

  disconnect(client: Client) {
    const present = this.state.presence.delete(client);
    for (const pending of [...this.state.pending.values()]) if (pending.client === client) pending.settle({ kind: "disconnected" });
    if (present) this.changed();
  }

  /** True when the app holds this connection only to relay, so it must not keep the daemon awake. */
  standbyOnly(client: Client) { return this.state.presence.get(client)?.standby === true; }

  /** This daemon's identity as connected apps name it; null until one has said. */
  self(): RelayPresence["self"] | null {
    return this.state.presence.values().next().value?.self ?? null;
  }

  /** Hostnames of every daemon some connected app reaches, for error messages and resolution hints. */
  reachable() {
    const daemons = new Map<DaemonId, string>();
    for (const presence of this.state.presence.values()) for (const daemon of presence.daemons) daemons.set(daemon.daemonId, daemon.hostname);
    return daemons;
  }

  /**
   * Asks one app at a time; an app is asked only after every earlier one said it could not, or never answered a read.
   * Apps reach different daemons, so a lookup one app could not complete continues with the next, keeping what each found.
   */
  async request<Request extends RelayRequest>(request: Request, signal: AbortSignal): Promise<ResultOf<Request["kind"]>> {
    signal.throwIfAborted();
    // Apps refuse requests outside the contract without answering, which would read as a silent app; fail here instead.
    RelayRequestSchema.parse(request);
    const target = request.kind === "execute" ? request.targetDaemonId : null;
    const candidates = [...this.state.presence].filter(([, presence]) =>
      !target || presence.daemons.some(daemon => daemon.daemonId === target)).map(([client]) => client);
    if (!candidates.length) {
      throw new RelayUnavailableError(this.state.presence.size
        ? "No connected Workbench app reaches that daemon. Open Workbench on a machine that reaches it, then retry."
        : "No Workbench app is connected to this daemon. Open Workbench in a tab or run `wb view`, then retry.");
    }
    const lookup = LOOKUPS[request.kind as keyof typeof LOOKUPS] as Lookup<ResultOf<Request["kind"]>> | undefined;
    let found: ResultOf<Request["kind"]> | null = null;
    const failures: string[] = [];
    for (const client of candidates) {
      const outcome = await this.dispatch(client, request, signal);
      if (outcome.kind === "answered") {
        const schema = relayResultSchemas[request.kind] as unknown as z.ZodType<ResultOf<Request["kind"]>>;
        const result = conformToZodSchema(schema.nullable(), outcome.result, null).data;
        if (result === null) throw new Error("A Workbench app answered a relay request with invalid data.");
        if (!lookup) return result;
        found = found === null ? result : lookup.merge(found, result);
        if (lookup.complete(found)) return found;
        continue;
      }
      if (lookup) {
        failures.push(outcome.kind === "unknown" ? outcome.reason : outcome.failure);
        continue;
      }
      if (outcome.kind === "failed") throw new Error(outcome.failure);
      if (outcome.kind === "unknown") {
        throw new RelayOutcomeUnknownError(`${outcome.reason} The request may already have run; check before retrying.`);
      }
      failures.push(outcome.failure);
      if (outcome.kind === "silent" && !RETRYABLE_AFTER_SILENCE.has(request.kind)) {
        throw new RelayOutcomeUnknownError("A Workbench app took too long to accept the request. It may still run; check before retrying.");
      }
    }
    if (found !== null) return found;
    throw new RelayUnavailableError(failures.join("\n") || "No connected Workbench app could relay the request.");
  }

  private dispatch(client: Client, request: RelayRequest, signal: AbortSignal) {
    type Dispatched =
      | Extract<RelayOutcome, { kind: "answered" | "failed" | "unreachable" }>
      | { kind: "silent"; failure: string }
      | { kind: "unknown"; reason: string };
    return new Promise<Dispatched>((resolve, reject) => {
      const requestId = randomUUID();
      let timer: unknown = null;
      const finish = (result: Dispatched | Error) => {
        if (!this.state.pending.delete(requestId)) return;
        if (timer !== null) this.timers.cancel(timer);
        signal.removeEventListener("abort", abort);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const pending: Pending = {
        client, accepted: false,
        settle: outcome => {
          if (outcome.kind === "accepted") {
            pending.accepted = true;
            if (timer !== null) this.timers.cancel(timer);
            timer = null;
            return;
          }
          if (outcome.kind === "disconnected") {
            finish(pending.accepted ? { kind: "unknown", reason: "The relaying Workbench app disconnected." }
              : { kind: "unreachable", failure: "The Workbench app disconnected before accepting the request." });
            return;
          }
          finish(outcome);
        },
      };
      const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("The relay request was cancelled."));
      this.state.pending.set(requestId, pending);
      signal.addEventListener("abort", abort, { once: true });
      timer = this.timers.schedule(() => finish({ kind: "silent", failure: "A Workbench app did not accept the request in time." }),
        RELAY_ACK_DEADLINE_MS);
      const send = this.state.send;
      if (!send) {
        finish({ kind: "unreachable", failure: "Relay transport is not attached." });
        return;
      }
      try { send(client, { method: RELAY_REQUEST_METHOD, params: { requestId, request } }); }
      catch (error) { finish({ kind: "unreachable", failure: `Send failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` }); }
    });
  }
}

export function getProcessNetworkRelay() {
  return new WorkbenchNetworkRelayController(processState());
}

export type { RelayState };
