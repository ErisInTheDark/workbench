/*
 * Exports:
 * - KnownDaemon: a daemon identity this app verified (or recognised) on one network peer, remembered across restarts.
 * - default WorkbenchDaemonSources: reconcile verified daemon publications and remembered daemons into independent retained
 *   connections, holding each on relay standby and routing every daemon's agent relay requests to the app's relay.
 */
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController";
import WorkbenchDaemonSource, { type WorkbenchDaemonSourceDescriptor } from "./WorkbenchDaemonSource";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkspaceDaemonFact } from "workbench-shared/workbench/workspace/workspace-observation";
import type WebSocketTrafficBuffer from "workbench-shared/process/WebSocketTrafficBuffer";
import WorkbenchTranscriptReservoir from "./WorkbenchTranscriptReservoir";
type Network = Pick<WorkbenchNetworkController, "daemonSources" | "canAccessPeer" | "memberPeer" | "subscribe">;

export interface KnownDaemon {
  daemonId: DaemonId;
  peerNodeId: string;
  hostname: string;
}
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
  readonly transcriptReservoir: WorkbenchTranscriptReservoir;
  private readonly entries = new Map<DaemonId, Entry>();
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private attachedId: DaemonId | null = null;
  private reconciling = false;
  private published: { attachedId: DaemonId | null; sources: WorkspaceDaemonFact[] } | null = null;
  private readonly known = new Map<DaemonId, KnownDaemon>();

  constructor(private readonly options: {
    network: Network;
    /** Durable memory of verified daemons, so an offline daemon this app may reach stays in reach after a restart. */
    knownDaemons: { read(): readonly KnownDaemon[]; remember(daemon: KnownDaemon): void };
    warn(message: string): void;
    createSource?: (descriptor: WorkbenchDaemonSourceDescriptor) => WorkbenchDaemonSource;
    /** Browser traffic for `wb socket spy`; only the attached local daemon may read it. */
    traffic?: Pick<WebSocketTrafficBuffer, "query">;
    transcriptReservoir?: WorkbenchTranscriptReservoir;
    /** Answers daemons' agent relay requests; sources then stay on standby so background agents can always relay. */
    relay?: NonNullable<ConstructorParameters<typeof WorkbenchDaemonSource>[1]["relay"]>;
  }) {
    this.transcriptReservoir = options.transcriptReservoir ?? new WorkbenchTranscriptReservoir();
  }

  start() {
    if (this.unsubscribe) return;
    try {
      for (const daemon of this.options.knownDaemons.read()) this.known.set(daemon.daemonId, daemon);
    } catch (error) {
      this.options.warn(`Remembered daemons could not be read: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
    }
    this.unsubscribe = this.options.network.subscribe(() => this.reconcile());
    this.reconcile();
  }

  /**
   * Networked targets no source covers yet (nobody verified them since this app remembers daemons) are matched to the network
   * member carrying their recorded hostname; a later verification replaces the match.
   */
  recognise(targets: readonly { daemonId: DaemonId; hostname: string }[]) {
    let learned = false;
    for (const target of targets) {
      if (this.entries.has(target.daemonId) || this.known.has(target.daemonId)) continue;
      const peerNodeId = this.options.network.memberPeer(target.hostname);
      if (!peerNodeId || this.options.network.canAccessPeer(peerNodeId) !== true) continue;
      learned = this.remember({ daemonId: target.daemonId, peerNodeId, hostname: target.hostname }) || learned;
    }
    if (learned) this.reconcile();
  }

  private remember(daemon: KnownDaemon) {
    const prior = this.known.get(daemon.daemonId);
    if (prior?.peerNodeId === daemon.peerNodeId && prior.hostname === daemon.hostname) return false;
    for (const [id, known] of this.known) if (known.peerNodeId === daemon.peerNodeId) this.known.delete(id);
    this.known.set(daemon.daemonId, daemon);
    try { this.options.knownDaemons.remember(daemon); }
    catch (error) {
      this.options.warn(`Daemon ${daemon.hostname} could not be remembered: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
    }
    return true;
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
    this.transcriptReservoir.dispose();
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
            state: facts.attached.state, endpoint, published: true, access: true, failure: null,
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
        if (id !== this.attachedId) this.remember({ daemonId: id, peerNodeId: peer.peerId, hostname: peer.identity.hostname });
        incoming.set(id, {
          descriptor: {
            daemonId: id, hostname: peer.identity.hostname, state: peer.identity.state,
            endpoint, published: true, access: true, failure: null,
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
        } else this.add(next.descriptor, next.peers);
      }
      // A remembered daemon discovery cannot see starts exactly as one that dropped offline mid-session.
      for (const daemon of this.known.values()) {
        if (incoming.has(daemon.daemonId) || this.entries.has(daemon.daemonId) || daemon.daemonId === this.attachedId) continue;
        if (this.options.network.canAccessPeer(daemon.peerNodeId) !== true) continue;
        const descriptor: WorkbenchDaemonSourceDescriptor = {
          daemonId: daemon.daemonId, hostname: daemon.hostname, state: "ready",
          endpoint: null, published: false, access: true, failure: null,
        };
        this.add(descriptor, new Set([daemon.peerNodeId]));
      }
      for (const [id, entry] of this.entries) {
        if (incoming.has(id)) continue;
        const revoked = entry.peers.size > 0
          && [...entry.peers].every(peer => this.options.network.canAccessPeer(peer) === false);
        // Discovery loss withdraws reconnect permission; a healthy socket continues until it closes or access is
        // revoked, then its facts withdraw. Discovery is authoritative only while the host service is ready.
        entry.descriptor = {
          ...entry.descriptor, endpoint: null,
          published: facts.current ? false : entry.descriptor.published,
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

  private add(descriptor: WorkbenchDaemonSourceDescriptor, peers: Set<string>) {
    const id = descriptor.daemonId;
    const traffic = this.options.traffic;
    const source = this.options.createSource?.(descriptor)
      ?? new WorkbenchDaemonSource(descriptor, {
        warn: this.options.warn,
        transcriptReservoir: this.transcriptReservoir,
        answerSpy: traffic ? query => id === this.attachedId ? traffic.query(query) : null : undefined,
        ...(this.options.relay ? { relay: this.options.relay } : {}),
      });
    const subscription = source.subscribe(() => { if (!this.reconciling) this.publish(); });
    const releaseStandby = this.options.relay ? source.standby() : () => {};
    this.entries.set(id, { source, descriptor, peers, unsubscribe: () => { releaseStandby(); subscription(); } });
  }

  private publish() {
    const next = { attachedId: this.attachedId, sources: this.all().map(source => source.getSnapshot()) };
    if (areDeeplyEqual(this.published, next)) return;
    const reachChanged = !areDeeplyEqual(
      this.published?.sources.map(source => [source.daemonId, source.connection === "revoked"]),
      next.sources.map(source => [source.daemonId, source.connection === "revoked"]),
    );
    this.published = next;
    // Every daemon learns which daemons this app reaches, so its agents' relays pick an app that can answer.
    if (reachChanged && this.options.relay) for (const source of this.all()) source.sendPresence();
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch (error) {
        this.options.warn(`Daemon source subscriber failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      }
    }
  }
}
