/*
 * Exports:
 * - default WorkbenchDaemonSources: reconcile verified daemon publications into independent retained connections.
 */
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController";
import WorkbenchDaemonSource, { type WorkbenchDaemonSourceDescriptor } from "./WorkbenchDaemonSource";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkspaceDaemonFact } from "workbench-shared/workbench/workspace/workspace-observation";

type Network = Pick<WorkbenchNetworkController, "daemonSources" | "canAccessPeer" | "subscribe">;
interface Entry {
  source: WorkbenchDaemonSource;
  descriptor: WorkbenchDaemonSourceDescriptor;
  peers: Set<string>;
  unsubscribe: () => void;
}

function socketEndpoint(origin: string, daemonId: DaemonId) {
  const url = new URL(origin);
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("Verified daemon publication has an invalid origin.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wb-daemon", daemonId);
  return url.href;
}

export default class WorkbenchDaemonSources {
  private readonly entries = new Map<DaemonId, Entry>();
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private attachedId: DaemonId | null = null;
  private reconciling = false;
  private published: { attachedId: DaemonId | null; sources: WorkspaceDaemonFact[] } | null = null;

  constructor(private readonly options: {
    network: Network;
    warn(message: string): void;
    createSource?: (descriptor: WorkbenchDaemonSourceDescriptor) => WorkbenchDaemonSource;
  }) {}

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.network.subscribe(() => this.reconcile());
    this.reconcile();
  }

  get attached() { return this.attachedId ? this.entries.get(this.attachedId)?.source ?? null : null; }
  get(id: DaemonId) { return this.entries.get(id)?.source ?? null; }
  all() { return [...this.entries.values()].map(entry => entry.source); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.source.dispose();
    }
    this.entries.clear();
    this.listeners.clear();
    this.attachedId = null;
    this.published = null;
  }

  private reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const facts = this.options.network.daemonSources();
      const incoming = new Map<DaemonId, {
        descriptor: WorkbenchDaemonSourceDescriptor;
        peers: Set<string>;
        endpoints: Set<string>;
      }>();
      if (facts.attached) {
        this.attachedId = DaemonIdSchema.parse(facts.attached.daemonId);
        const endpoint = facts.localOrigin ? socketEndpoint(facts.localOrigin, this.attachedId) : null;
        incoming.set(this.attachedId, {
          descriptor: {
            daemonId: this.attachedId, hostname: facts.attached.hostname,
            state: facts.attached.state, endpoint, access: true, failure: null,
          },
          peers: new Set(), endpoints: new Set(endpoint ? [endpoint] : []),
        });
      }
      for (const peer of facts.discovery.peers) {
        if (peer.phase !== "verified") continue;
        const id = DaemonIdSchema.parse(peer.identity.daemonId);
        const allowed = this.options.network.canAccessPeer(peer.peerId);
        if (allowed !== true) continue;
        // Both origins come from verified publication, never from a browser command.
        const origin = peer.endpoints?.httpOrigin ?? peer.endpoints?.secureOrigin;
        const endpoint = origin ? socketEndpoint(origin, id) : null;
        const prior = incoming.get(id);
        if (prior) {
          prior.peers.add(peer.peerId);
          if (endpoint) prior.endpoints.add(endpoint);
          continue;
        }
        incoming.set(id, {
          descriptor: {
            daemonId: id, hostname: peer.identity.hostname, state: peer.identity.state,
            endpoint, access: true, failure: null,
          },
          peers: new Set([peer.peerId]), endpoints: new Set(endpoint ? [endpoint] : []),
        });
      }
      for (const [id, next] of incoming) {
        if (next.endpoints.size > 1 || next.peers.size > 1 || id === this.attachedId && next.peers.size > 0) {
          next.descriptor = { ...next.descriptor, state: "failed", endpoint: null,
            failure: "Conflicting verified endpoints for this daemon." };
        }
        const entry = this.entries.get(id);
        if (next.descriptor.failure && entry?.descriptor.failure !== next.descriptor.failure) {
          this.options.warn(next.descriptor.failure);
        }
        if (entry) {
          entry.descriptor = next.descriptor;
          entry.peers = next.peers;
          entry.source.update(next.descriptor);
        } else {
          const source = this.options.createSource?.(next.descriptor)
            ?? new WorkbenchDaemonSource(next.descriptor, { warn: this.options.warn });
          this.entries.set(id, { source, descriptor: next.descriptor, peers: next.peers,
            unsubscribe: source.subscribe(() => { if (!this.reconciling) this.publish(); }) });
        }
      }
      for (const [id, entry] of this.entries) {
        if (incoming.has(id)) continue;
        const revoked = entry.peers.size > 0
          && [...entry.peers].every(peer => this.options.network.canAccessPeer(peer) === false);
        // Discovery loss withdraws reconnect permission, not already received facts.
        // An existing healthy socket can continue until actual access is revoked.
        entry.descriptor = {
          ...entry.descriptor, endpoint: null,
          access: revoked ? false : entry.descriptor.access,
          failure: revoked ? "This app no longer has access to the daemon." : entry.descriptor.failure,
        };
        entry.source.update(entry.descriptor);
      }
    } catch (error) {
      this.options.warn(`Daemon source discovery failed: ${error instanceof Error ? error.message.slice(0, 512) : "Invalid publication."}`);
    } finally { this.reconciling = false; }
    this.publish();
  }

  private publish() {
    const next = { attachedId: this.attachedId, sources: this.all().map(source => source.getSnapshot()) };
    if (areDeeplyEqual(this.published, next)) return;
    this.published = next;
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch (error) {
        this.options.warn(`Daemon source subscriber failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      }
    }
  }
}
