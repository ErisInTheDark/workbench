/*
 * Test-only exports:
 * - WorkspaceTestSocket: controllable transport edge with real app protocol decoding.
 * - createWorkspaceClientFixture: production app/workspace clients with explicit socket readiness.
 */
import { WorkbenchAppRpcRequestSchema, type WorkbenchAppRpcRequest } from "workbench-shared/http/workbench-app-rpc";
import type { WorkbenchAppNetworkEvent } from "workbench-shared/http/workbench-app-events";
import type { WorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
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
  /** Protocol answered to `workspace/hello`, as a current app server does; 1 imitates a server without deltas. */
  helloProtocol = 2;
  send(value: string) {
    const request = WorkbenchAppRpcRequestSchema.parse(JSON.parse(value));
    this.sent.push(request);
    if (request.method === "workspace/hello") queueMicrotask(() => this.reply(request, { protocol: this.helloProtocol }));
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
  observation(request: Extract<WorkbenchAppRpcRequest, { method: "workspace/observe" }>,
    payload: ObservationPayload, revision = 1, response = false) {
    const observation: WorkspaceObservation = { ...payload,
      subscriptionId: request.params.subscriptionId, generation: request.params.generation, revision };
    if (response) this.reply(request, observation);
    else this.event({ kind: "workspace", observation });
  }
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
