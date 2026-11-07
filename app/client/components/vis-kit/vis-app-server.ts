/*
 * Exports:
 * - default VisAppServer: answer one fake app socket's requests from a VisWorld like the app server would, and record
 *   every request the world does not model so a mockup can show its gaps.
 */
import type { WorkbenchAppRpcRequest } from "workbench-shared/http/workbench-app-rpc";
import { applyThreadSummariesPatch } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkspaceTestSocket } from "../../workbench/app/workspace-client-fixture";
import type VisWorld from "./vis-world";

type Observe = Extract<WorkbenchAppRpcRequest, { method: "workspace/observe" }>;

const APP_PORT = {
  appOrigin: "http://127.0.0.1:4000", currentPort: 4000, editable: false, source: "random",
  stableOrigin: null, loopbackReachable: false, visOrigin: null,
};
const APP_SETTINGS = { appliedReactDevelopmentMode: false, requestedReactDevelopmentMode: false };

export default class VisAppServer {
  private readonly observed = new Map<string, { request: Observe; revision: number }>();
  private readonly listeners = new Set<() => void>();
  private unhandled: readonly string[] = [];
  private appStateRevision = 1;
  private readonly stop: () => void;

  constructor(private readonly socket: WorkspaceTestSocket, private readonly world: VisWorld) {
    this.stop = socket.onRequest(request => { void this.answer(request); });
    // The socket may open before the server attaches; answer what it already sent.
    for (const request of socket.sent) void this.answer(request);
  }

  /** Requests the world could not answer, as `method` or `workspace/observe kind`, each listed once. */
  getUnhandled = () => this.unhandled;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  dispose() { this.stop(); }

  private async answer(request: WorkbenchAppRpcRequest) {
    switch (request.method) {
      case "app/port/read": return this.socket.reply(request, APP_PORT);
      case "app/settings/read": return this.socket.reply(request, APP_SETTINGS);
      case "workspace/release": {
        this.observed.delete(request.params.subscriptionId);
        return this.socket.reply(request, {});
      }
      case "workspace/observe": {
        const payload = this.world.observe(request.params.query);
        if (!payload) return this.miss(request, `workspace/observe ${request.params.query.kind}`);
        this.observed.set(request.params.subscriptionId, { request, revision: 1 });
        return await this.socket.observation(request, payload);
      }
      case "workspace/retarget": {
        const held = this.observed.get(request.params.subscriptionId);
        if (!held) return this.miss(request, "workspace/retarget");
        const prior = held.request.params.query;
        const query = "query" in request.params ? request.params.query
          : prior.kind === "threadSummaries" ? { ...prior, threadIds: applyThreadSummariesPatch(prior.threadIds, request.params.patch) } : prior;
        const payload = this.world.observe(query);
        if (!payload) return this.miss(request, `workspace/retarget ${query.kind}`);
        held.revision++;
        held.request = { ...held.request, params: { ...held.request.params, query } };
        this.socket.reply(request, { revision: held.revision });
        return await this.socket.observation(held.request, payload, held.revision);
      }
      case "workspace/command": {
        const scope = request.params.scope;
        const result = this.world.command(request.params.method, request.params.params,
          scope?.kind === "folder" ? scope.location : null, scope?.kind === "installation" ? scope.daemonId ?? null : null);
        return result ? this.socket.reply(request, result) : this.miss(request, `workspace/command ${request.params.method}`);
      }
      case "app/state/mutate": return this.socket.reply(request, this.world.appState(++this.appStateRevision));
      default: return this.miss(request, request.method);
    }
  }

  private miss(request: WorkbenchAppRpcRequest, label: string) {
    this.socket.fail(request, `The vis world does not model ${label}.`);
    if (this.unhandled.includes(label)) return;
    this.unhandled = [...this.unhandled, label];
    for (const listener of [...this.listeners]) listener();
  }
}
