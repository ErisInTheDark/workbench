/*
 * Exports:
 * - default WorkbenchDaemonSessions: own verified peer session selection and disposal.
 */
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchDaemonSession from "./WorkbenchDaemonSession";

interface SessionTarget {
  daemonId: DaemonId;
  hostname: string;
  secureOrigin: string;
}

interface SessionEntry {
  origin: string;
  session: WorkbenchDaemonSession;
  unsubscribe: () => void;
}

export default class WorkbenchDaemonSessions {
  private readonly entries = new Map<DaemonId, SessionEntry>();
  private readonly targets = new Map<DaemonId, SessionTarget>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeNetwork: (() => void) | null = null;
  private closed = false;

  constructor(private readonly options: {
    network: {
      snapshot(): Pick<WorkbenchNetworkSnapshot, "daemon" | "discovery"> | null;
      subscribe(listener: () => void): () => void;
    };
    createSession(options: {
      daemonId: DaemonId;
      hostname: string;
      resolveUrl: () => Promise<string>;
    }): WorkbenchDaemonSession;
    onError?: (message: string) => void;
  }) {}

  get = (daemonId: DaemonId) => this.entries.get(daemonId)?.session ?? null;
  httpOrigin = (daemonId: DaemonId) => this.entries.get(daemonId)?.origin ?? null;
  list = () => [...this.entries.values()].map(entry => entry.session);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start() {
    if (this.closed) throw new Error("Daemon sessions have closed.");
    if (this.unsubscribeNetwork) return;
    this.unsubscribeNetwork = this.options.network.subscribe(() => this.reconcile());
    this.reconcile();
  }

  private reconcile() {
    if (this.closed) return;
    const snapshot = this.options.network.snapshot();
    const discovered = snapshot?.discovery?.peers ?? [];
    const attachedId = snapshot?.daemon?.daemonId;
    const groups = new Map<DaemonId, SessionTarget[]>();
    for (const peer of discovered) {
      if (peer.phase !== "verified" || !peer.endpoints?.secureOrigin) continue;
      const daemonId = DaemonIdSchema.parse(peer.identity.daemonId);
      if (daemonId === attachedId) continue;
      const group = groups.get(daemonId) ?? [];
      group.push({ daemonId, hostname: peer.identity.hostname, secureOrigin: peer.endpoints.secureOrigin });
      groups.set(daemonId, group);
    }
    const next = new Map<DaemonId, SessionTarget>();
    for (const [daemonId, candidates] of groups) {
      if (candidates.length !== 1) {
        this.options.onError?.(`Conflicting verified endpoints for daemon ${daemonId}.`);
        continue;
      }
      next.set(daemonId, candidates[0]!);
    }
    this.targets.clear();
    for (const [id, target] of next) this.targets.set(id, target);
    for (const [id, entry] of this.entries) {
      const target = next.get(id);
      if (target && target.secureOrigin === entry.origin) continue;
      entry.unsubscribe();
      entry.session.dispose();
      this.entries.delete(id);
    }
    for (const [daemonId, target] of next) {
      if (this.entries.has(daemonId)) continue;
      const session = this.options.createSession({
        daemonId,
        hostname: target.hostname,
        resolveUrl: async () => {
          const current = this.targets.get(daemonId);
          if (!current || current.secureOrigin !== target.secureOrigin) {
            throw new Error("The verified daemon endpoint is no longer available.");
          }
          const address = new URL(current.secureOrigin);
          address.protocol = "wss:";
          return address.href;
        },
      });
      const unsubscribe = session.subscribe(() => this.publish());
      this.entries.set(daemonId, { origin: target.secureOrigin, session, unsubscribe });
      void session.start().catch(error => {
        if (!this.closed) this.options.onError?.(error instanceof Error
          ? error.message.slice(0, 512) : "A daemon session could not start.");
      });
    }
    this.publish();
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.session.dispose();
    }
    this.entries.clear();
    this.targets.clear();
    this.listeners.clear();
  }
}
