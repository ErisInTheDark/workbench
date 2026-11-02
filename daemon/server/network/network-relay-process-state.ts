/*
 * Exports:
 * - RelayPending: one dispatched relay request awaiting its app's outcome.
 * - RelayState: the process-wide relay's app connections, pending requests, transport and presence listeners.
 * - readProcessRelayState: the one relay state this process keeps across reloads.
 * - default ProcessNetworkRelay: the relay's process-lifetime operations: transport attachment, presence listeners, standby
 *   checks and disconnect settlement. Kernel-safe: it imports no product code at runtime.
 */
import type { RelayOutcome, RelayPresence } from "workbench-shared/workbench/network/network-relay-contracts";

type Client = object;
type Send = (client: Client, message: object) => void;

export interface RelayPending {
  client: Client;
  accepted: boolean;
  settle(outcome: RelayOutcome | { kind: "disconnected" }): void;
}

export interface RelayState {
  presence: Map<Client, RelayPresence>;
  pending: Map<string, RelayPending>;
  send: Send | null;
  /** Told whenever any connection's presence changes, such as daemon sleep re-checking attendance. */
  listeners: Set<() => void>;
}

const PROCESS_STATE_KEY = Symbol.for("workbench.networkRelay.v1");

export function readProcessRelayState(): RelayState {
  let state = Reflect.get(globalThis, PROCESS_STATE_KEY) as RelayState | undefined;
  if (!state) {
    state = { presence: new Map(), pending: new Map(), send: null, listeners: new Set() };
    Reflect.set(globalThis, PROCESS_STATE_KEY, state);
  }
  return state;
}

export default class ProcessNetworkRelay {
  constructor(private readonly state: RelayState = readProcessRelayState()) {}

  /** The process sends through whichever socket routing generation is current. */
  attachTransport(send: Send) { this.state.send = send; }

  subscribe(listener: () => void) {
    this.state.listeners.add(listener);
    return () => { this.state.listeners.delete(listener); };
  }

  presenceChanged() {
    for (const listener of [...this.state.listeners]) listener();
  }

  disconnect(client: Client) {
    const present = this.state.presence.delete(client);
    for (const pending of [...this.state.pending.values()]) if (pending.client === client) pending.settle({ kind: "disconnected" });
    if (present) this.presenceChanged();
  }

  /** True when the app holds this connection only to relay, so it must not keep the daemon awake. */
  standbyOnly(client: Client) { return this.state.presence.get(client)?.standby === true; }
}
