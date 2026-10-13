/*
 * Exports:
 * - default WorkbenchGitPeerRelay: stream one branch's new commits from a sender folder's daemon into a receiver folder's
 *   tracking ref, joining repeat requests, and ask a daemon to integrate a fetched peer branch.
 * - GitPeerUnsupportedError: a daemon predates peer transfers.
 * - GitPeerLocation: one folder on one daemon.
 */
import type { DaemonId, ProjectId } from "workbench-shared/workbench/identity";
import {
  GIT_PEER_NO_BUNDLE_HEADER, GIT_PEER_ROUTES, GIT_PEER_TIP_HEADER, GitPeerHavesResultSchema, GitPeerIntegrationResultSchema,
  GitPeerReceiveResultSchema, type GitPeerIntegrationResult,
} from "workbench-shared/workbench/git/git-peer-contracts";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { z } from "zod";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";

export interface GitPeerLocation { daemonId: DaemonId; projectId: ProjectId }
type Source = Pick<WorkbenchDaemonSource, "id" | "httpOrigin" | "available" | "retain" | "subscribe" | "getSnapshot">;
export class GitPeerUnsupportedError extends Error {}

function bounded(text: string) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 512);
}

export default class WorkbenchGitPeerRelay {
  private readonly fetches = new Map<string, Promise<string>>();
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(private readonly options: {
    sources: { get(id: DaemonId): Source | null };
    fetcher?: typeof fetch;
  }) {}

  /** Brings `sender`'s `branch` into `receiver`'s tracking ref and returns its tip; a repeat request joins the running one. */
  fetch(sender: GitPeerLocation, receiver: GitPeerLocation, branch: string) {
    const key = JSON.stringify([sender.daemonId, sender.projectId, receiver.daemonId, receiver.projectId, branch]);
    const running = this.fetches.get(key);
    if (running) return running;
    const transfer = this.withSources([sender, receiver], async ([senderSource, receiverSource], signal) => {
      const { haves } = await this.post(receiverSource, GIT_PEER_ROUTES.haves, GitPeerHavesResultSchema,
        { projectId: receiver.projectId, peer: sender, branch }, signal);
      const bundle = await this.send(senderSource, GIT_PEER_ROUTES.bundle, {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: sender.projectId, branch, haves }),
      });
      const tip = bundle.headers.get(GIT_PEER_TIP_HEADER);
      if (!tip) throw new Error("The sending daemon did not name its branch tip.");
      const query = new URLSearchParams({
        projectId: receiver.projectId, peerDaemonId: sender.daemonId, peerProjectId: sender.projectId, branch, tip,
      });
      const body = bundle.status === 204 ? null : bundle.body;
      // Streaming request bodies need half-duplex, which the DOM RequestInit declaration omits.
      const received = await this.send(receiverSource, `${GIT_PEER_ROUTES.receive}?${query}`, {
        method: "POST", signal,
        headers: body ? { "Content-Type": "application/x-git-bundle" } : { [GIT_PEER_NO_BUNDLE_HEADER]: "1" },
        ...(body ? { body, duplex: "half" } : {}),
      } as RequestInit);
      return (await this.json(received, GitPeerReceiveResultSchema)).tip;
    });
    this.fetches.set(key, transfer);
    void transfer.then(() => undefined, () => undefined).finally(() => {
      if (this.fetches.get(key) === transfer) this.fetches.delete(key);
    });
    return transfer;
  }

  /** Asks `receiver`'s daemon to integrate its already-fetched copy of `sender`'s branch into the checked-out branch. */
  integrate(receiver: GitPeerLocation, sender: GitPeerLocation, branch: string): Promise<GitPeerIntegrationResult> {
    return this.withSources([receiver], async ([source], signal) => await this.post(source, GIT_PEER_ROUTES.integrate,
      GitPeerIntegrationResultSchema, { projectId: receiver.projectId, peer: sender, branch }, signal));
  }

  dispose() {
    this.closed = true;
    for (const cancellation of this.active) cancellation.abort();
    this.active.clear();
  }

  /** Holds every source awake for one transfer and aborts it when any of them drops. */
  private async withSources<Result>(locations: readonly GitPeerLocation[],
    run: (sources: Source[], signal: AbortSignal) => Promise<Result>) {
    if (this.closed) throw new Error("Peer transfers are reloading.");
    const sources = locations.map(location => {
      const source = this.options.sources.get(location.daemonId);
      if (!source?.httpOrigin) throw new Error(`${source?.getSnapshot().hostname ?? "That daemon"} is offline.`);
      return source;
    });
    const cancellation = new AbortController();
    this.active.add(cancellation);
    const releases = sources.map(source => source.retain());
    const origins = sources.map(source => source.httpOrigin);
    const stops = sources.map((source, index) => source.subscribe(() => {
      if (!source.available || source.httpOrigin !== origins[index]) cancellation.abort(new Error(`${source.getSnapshot().hostname} disconnected.`));
    }));
    try { return await run(sources, cancellation.signal); }
    catch (error) {
      if (cancellation.signal.aborted && cancellation.signal.reason instanceof Error) throw cancellation.signal.reason;
      throw error;
    } finally {
      // Ends any stream still open on a failed leg, such as a sender bundle the receiver rejected.
      cancellation.abort();
      for (const stop of stops) stop();
      for (const release of releases) release();
      this.active.delete(cancellation);
    }
  }

  private async send(source: Source, route: string, init: RequestInit) {
    const origin = source.httpOrigin;
    if (!origin) throw new Error(`${source.getSnapshot().hostname} is offline.`);
    const destination = new URL(route, origin);
    destination.searchParams.set("wb-daemon", source.id);
    const response = await (this.options.fetcher ?? fetch)(destination, { ...init, redirect: "manual" });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new GitPeerUnsupportedError(`Update Workbench on ${source.getSnapshot().hostname} to sync with it.`);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain-text failure body */ }
      throw new Error(bounded(`${source.getSnapshot().hostname}: ${message || `peer request failed with ${response.status}`}`));
    }
    return response;
  }

  private async post<Schema extends z.ZodType>(source: Source, route: string, schema: Schema,
    body: object, signal: AbortSignal): Promise<z.infer<Schema>> {
    const response = await this.send(source, route, {
      method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await this.json(response, schema);
  }

  private async json<Schema extends z.ZodType>(response: Response, schema: Schema): Promise<z.infer<Schema>> {
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      reportClientSchemaError("Rejected daemon peer transfer response", parsed.error);
      throw new Error("The daemon returned an invalid peer transfer response.");
    }
    return parsed.data;
  }
}
