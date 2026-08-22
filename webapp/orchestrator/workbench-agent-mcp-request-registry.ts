/*
 * Exports:
 * - WorkbenchAgentMcpRequestRegistry: own MCP request cancellation handles with duplicate-ID and disposal guards. Keywords: workbench, MCP, cancellation, registry.
 * - getProcessWorkbenchAgentMcpRequestRegistry: wrap reload-stable process state without retaining stale module methods. Keywords: workbench, MCP, reload, process.
 */

type WorkbenchAgentMcpRequestId = number | string;

interface WorkbenchAgentMcpRequestRegistryState {
  disposed: boolean;
  exitHookInstalled: boolean;
  requests: Map<WorkbenchAgentMcpRequestId, AbortController>;
}

const PROCESS_REGISTRY_KEY = Symbol.for("workbench.agentMcpRequestRegistry.v1");

function createState(): WorkbenchAgentMcpRequestRegistryState {
  return {
    disposed: false,
    exitHookInstalled: false,
    requests: new Map(),
  };
}

function disposeState(state: WorkbenchAgentMcpRequestRegistryState, reason: string) {
  if (state.disposed) return;
  state.disposed = true;
  for (const controller of state.requests.values()) {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  }
  state.requests.clear();
}

function getProcessState() {
  let state = Reflect.get(globalThis, PROCESS_REGISTRY_KEY) as WorkbenchAgentMcpRequestRegistryState | undefined;
  if (!state) {
    state = createState();
    Reflect.set(globalThis, PROCESS_REGISTRY_KEY, state);
  }
  if (!state.exitHookInstalled) {
    state.exitHookInstalled = true;
    process.once("exit", () => disposeState(state, "Workbench orchestrator is shutting down."));
  }
  return state;
}

export class WorkbenchAgentMcpRequestRegistry {
  constructor(private readonly state = createState()) {}

  register(requestId: WorkbenchAgentMcpRequestId) {
    if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
    if (this.state.requests.has(requestId)) throw new Error(`Workbench MCP request ID is already active: ${requestId}`);
    const controller = new AbortController();
    this.state.requests.set(requestId, controller);
    return {
      signal: controller.signal,
      unregister: () => {
        if (this.state.requests.get(requestId) === controller) this.state.requests.delete(requestId);
      },
    };
  }

  cancel(requestId: WorkbenchAgentMcpRequestId, reason?: string) {
    const controller = this.state.requests.get(requestId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error(reason?.trim() || "Workbench MCP tool call was cancelled."));
    return true;
  }

  dispose(reason = "Workbench orchestrator is shutting down.") {
    disposeState(this.state, reason);
  }
}

export function getProcessWorkbenchAgentMcpRequestRegistry() {
  return new WorkbenchAgentMcpRequestRegistry(getProcessState());
}
