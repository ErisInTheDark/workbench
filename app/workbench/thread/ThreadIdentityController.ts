/*
 * Keywords: thread identity, connection, native alias, canonical selection.
 * Exports:
 * - default ThreadIdentityController: own connection-scoped, metadata-only identity resolution.
 */
import type {
  WorkbenchThreadIdentityResolution,
  WorkbenchThreadIdentityResolveRequest,
} from "workbench-shared/workbench/thread/workbench-thread-identity";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { getWorkbenchThreadTargetRootId } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchMosaicNode } from "workbench-shared/workbench/navigation/workbench-mosaic-route";

export default class ThreadIdentityController {
  private requests: Map<string, Promise<WorkbenchThreadIdentityResolution | null>> | null = new Map();

  constructor(private readonly read: (request: WorkbenchThreadIdentityResolveRequest) => Promise<WorkbenchThreadIdentityResolution | null>) {}

  async resolve(request: WorkbenchThreadIdentityResolveRequest) {
    const requests = this.requests;
    if (!requests) throw new Error("Thread identity controller is disposed.");
    const key = this.key(request);
    const existing = requests.get(key);
    if (existing) return existing;
    const pending = this.read(request).then((identity) => {
      if (this.requests !== requests) return identity;
      if (!identity) requests.delete(key);
      else {
        requests.set(this.key({ threadId: identity.threadId, projectId: identity.projectId }), pending);
        requests.set(this.key({ threadId: identity.threadId }), pending);
      }
      return identity;
    }, (error) => {
      requests.delete(key);
      throw error;
    });
    requests.set(key, pending);
    return pending;
  }

  reset() {
    if (this.requests) this.requests = new Map();
  }

  async resolveTarget(projectId: string, target: WorkbenchThreadTarget): Promise<WorkbenchThreadTarget> {
    if (target.kind === "draft" || target.kind === "new") return target;
    const identity = await this.resolve({ projectId, threadId: target.threadId, harness: target.harness });
    if (!identity) throw new Error("Thread identity has not been observed in this project.");
    const harness = target.harness ? { harness: identity.harness } : {};
    if (target.kind === "provider") return { ...target, threadId: identity.threadId, ...harness };
    const parent = await this.resolve({ projectId, threadId: target.parentThreadId, harness: target.harness });
    if (!parent) throw new Error("Parent thread identity has not been observed in this project.");
    return { ...target, threadId: identity.threadId, parentThreadId: parent.threadId, ...harness };
  }

  async resolveRoute(route: WorkbenchRoute): Promise<WorkbenchRoute> {
    if (route.view === "mosaic" && route.mosaicNode) {
      return { ...route, mosaicNode: await this.resolveMosaic(route.projectId, route.mosaicNode) };
    }
    if (route.view !== "thread" || !route.threadTarget) return route;
    const threadTarget = await this.resolveTarget(route.threadOwnerProjectId || route.projectId, route.threadTarget);
    return { ...route, threadTarget, threadId: getWorkbenchThreadTargetRootId(threadTarget) };
  }

  dispose() {
    this.requests = null;
  }

  private async resolveMosaic(projectId: string, node: WorkbenchMosaicNode): Promise<WorkbenchMosaicNode> {
    if (node.type === "split") return { ...node, children: await Promise.all(node.children.map((child) => this.resolveMosaic(projectId, child))) };
    if (node.target.kind !== "thread") return node;
    return { ...node, target: { ...node.target, target: await this.resolveTarget(projectId, node.target.target) } };
  }

  private key(request: WorkbenchThreadIdentityResolveRequest) {
    return JSON.stringify([request.projectId ?? null, request.harness ?? null, request.threadId]);
  }
}
