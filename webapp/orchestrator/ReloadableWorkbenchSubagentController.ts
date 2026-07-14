/*
 * Exports:
 * - WorkbenchSubagentControllerDelegate: minimal subagent-controller lifecycle and request contract. Keywords: subagent, controller, reload, delegate.
 * - ReloadableWorkbenchSubagentControllerState: shared retiring-controller state transferred across bridge reloads. Keywords: subagent, reload, wait, state.
 * - default ReloadableWorkbenchSubagentController: route new requests to fresh code while draining pre-reload waits. Keywords: subagent, reload, wait, cancellation.
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

export interface WorkbenchSubagentControllerDelegate {
  dispose: () => void;
  handleRequest: (message: JsonRpcRequest) => Promise<JsonRpcResponse>;
  hasActiveWaiters: () => boolean;
}

export interface ReloadableWorkbenchSubagentControllerState {
  retiringControllers: Set<WorkbenchSubagentControllerDelegate>;
}

interface ReloadableWorkbenchSubagentControllerOptions {
  createController: () => WorkbenchSubagentControllerDelegate;
  initialState?: ReloadableWorkbenchSubagentControllerState;
  legacyController?: WorkbenchSubagentControllerDelegate;
}

function readCancelled(response: JsonRpcResponse) {
  return Boolean(response.result && typeof response.result === "object" && "cancelled" in response.result && response.result.cancelled === true);
}

export default class ReloadableWorkbenchSubagentController {
  private readonly activeController: WorkbenchSubagentControllerDelegate;
  private readonly retiringControllers: Set<WorkbenchSubagentControllerDelegate>;

  constructor({ createController, initialState, legacyController }: ReloadableWorkbenchSubagentControllerOptions) {
    this.activeController = createController();
    this.retiringControllers = initialState?.retiringControllers ?? new Set();
    if (legacyController) this.retiringControllers.add(legacyController);
    this.pruneRetiringControllers();
  }

  async handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.pruneRetiringControllers();
    if (message.method !== "workbench/subagent/waitCancel") {
      try {
        return await this.activeController.handleRequest(message);
      } finally {
        this.pruneRetiringControllers();
      }
    }

    const responses = await Promise.all(
      [this.activeController, ...this.retiringControllers].map((controller) => controller.handleRequest(message)),
    );
    this.pruneRetiringControllers();
    const errorResponse = responses.find((response) => response.error);
    return errorResponse ?? {
      id: message.id ?? null,
      result: { cancelled: responses.some(readCancelled) },
    };
  }

  detachForReload(): ReloadableWorkbenchSubagentControllerState {
    this.pruneRetiringControllers();
    if (this.activeController.hasActiveWaiters()) {
      this.retiringControllers.add(this.activeController);
    } else {
      this.activeController.dispose();
    }
    return { retiringControllers: this.retiringControllers };
  }

  dispose() {
    this.activeController.dispose();
    for (const controller of this.retiringControllers) controller.dispose();
    this.retiringControllers.clear();
  }

  private pruneRetiringControllers() {
    for (const controller of this.retiringControllers) {
      if (controller.hasActiveWaiters()) continue;
      controller.dispose();
      this.retiringControllers.delete(controller);
    }
  }
}
