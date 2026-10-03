/*
 * Test-only exports:
 * - WorkspaceTestSocket: controllable transport edge with real app protocol decoding.
 * - createWorkspaceClientFixture: production app/workspace clients with explicit socket readiness.
 */
import { WorkbenchAppRpcRequestSchema, type WorkbenchAppRpcRequest } from "workbench-shared/http/workbench-app-rpc";
import type { WorkbenchAppNetworkEvent } from "workbench-shared/http/workbench-app-events";
import { workspaceObservationShape, type WorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
import { diffObservationValue } from "workbench-shared/workbench/workspace/observation-patch";
import WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";
import WorkbenchWorkspaceClient from "./WorkbenchWorkspaceClient";

type ObservationPayload = {
  [Kind in WorkspaceObservation["kind"]]: Omit<Extract<WorkspaceObservation, { kind: Kind }>,
    "subscriptionId" | "generation" | "revision">;
}[WorkspaceObservation["kind"]];

export class WorkspaceTestSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: WorkbenchAppRpcRequest[] = [];
  private readonly waiting = new Set<() => void>();
  constructor(readonly url: string) { super(); }
  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
  send(value: string) {
    this.sent.push(WorkbenchAppRpcRequestSchema.parse(JSON.parse(value)));
    for (const listener of [...this.waiting]) listener();
  }
  request<Method extends WorkbenchAppRpcRequest["method"]>(method: Method, after = 0,
    accept: (request: Extract<WorkbenchAppRpcRequest, { method: Method }>) => boolean = () => true):
    Promise<Extract<WorkbenchAppRpcRequest, { method: Method }>> {
    return new Promise(resolve => {
      const changed = () => {
        const request = this.sent.slice(after).filter(
          (item): item is Extract<WorkbenchAppRpcRequest, { method: Method }> => item.method === method).find(accept);
        if (!request) return;
        this.waiting.delete(changed);
        resolve(request);
      };
      this.waiting.add(changed);
      changed();
    });
  }
  reply(request: WorkbenchAppRpcRequest, result: object) { this.deliver({ id: request.id, result }); }
  fail(request: WorkbenchAppRpcRequest, message: string) {
    this.deliver({ id: request.id, error: { code: -32000, message } });
  }
  event(event: WorkbenchAppNetworkEvent) { this.deliver(event); }
  /**
   * Publishes like the app server: the first value answers the observe request, later values travel as keyed
   * deltas from the last value sent for that subscription generation. `response` forces an observe reply.
   */
  async observation(request: Extract<WorkbenchAppRpcRequest, { method: "workspace/observe" }>,
    payload: ObservationPayload, revision = 1, response = false) {
    // Tests mutate payload objects between publications; keep a private copy as the published baseline.
    const observation: WorkspaceObservation = structuredClone({ ...payload,
      subscriptionId: request.params.subscriptionId, generation: request.params.generation, revision });
    const key = `${observation.subscriptionId}/${observation.generation}`;
    const previous = this.published.get(key);
    if (response || !previous) {
      this.reply(request, observation);
      if (!previous || previous.revision < revision) this.published.set(key, observation);
      // Responses resolve through promise hops; let the client accept the value before the caller asserts.
      for (let hop = 0; hop < 20; hop++) await Promise.resolve();
      return;
    }
    const delta = diffObservationValue(previous, { ...observation, revision: previous.revision }, workspaceObservationShape(observation.kind));
    if (!delta) return;
    this.published.set(key, observation);
    this.event({ kind: "workspaceDelta", delta: {
      subscriptionId: observation.subscriptionId, generation: observation.generation, kind: observation.kind,
      baseRevision: previous.revision, revision, delta,
    } });
  }
  private readonly published = new Map<string, WorkspaceObservation>();
  private deliver(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

export function createWorkspaceClientFixture() {
  const sockets: WorkspaceTestSocket[] = [];
  const created = Promise.withResolvers<WorkspaceTestSocket>();
  const socketListeners = new Set<() => void>();
  const rpc = new WorkbenchAppRpcClient({ origin: "http://workspace.test",
    socket: url => {
      const socket = new WorkspaceTestSocket(url);
      sockets.push(socket);
      created.resolve(socket);
      for (const listener of [...socketListeners]) listener();
      return socket as unknown as WebSocket;
    },
  });
  const workspace = new WorkbenchWorkspaceClient(rpc);
  return {
    rpc, workspace, sockets,
    nextSocket(after: number) {
      return new Promise<WorkspaceTestSocket>(resolve => {
        const changed = () => {
          const socket = sockets[after];
          if (!socket) return;
          socketListeners.delete(changed);
          resolve(socket);
        };
        socketListeners.add(changed);
        changed();
      });
    },
    async open() {
      rpc.start();
      const socket = await created.promise;
      const ready = workspace.connect();
      socket.open();
      await ready;
      return socket;
    },
    dispose() { workspace.dispose(); rpc.dispose(); },
  };
}
