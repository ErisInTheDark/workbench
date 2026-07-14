/*
 * Exports:
 * - No production exports; Node tests cover fresh request routing and retiring waiter cancellation across bridge reloads. Keywords: subagent, controller, reload, cancellation, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import ReloadableWorkbenchSubagentController, {
  type WorkbenchSubagentControllerDelegate,
} from "./ReloadableWorkbenchSubagentController";

class FakeController implements WorkbenchSubagentControllerDelegate {
  readonly calls: string[] = [];
  disposeCalls = 0;
  private activeWaiter: boolean;
  private readonly ownsCancellation: boolean;
  private readonly owner: string;

  constructor(owner: string, { activeWaiter = false, ownsCancellation = false } = {}) {
    this.activeWaiter = activeWaiter;
    this.owner = owner;
    this.ownsCancellation = ownsCancellation;
  }

  dispose() {
    this.disposeCalls += 1;
    this.activeWaiter = false;
  }

  async handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.calls.push(message.method ?? "");
    if (message.method === "workbench/subagent/waitCancel") {
      if (this.ownsCancellation) this.activeWaiter = false;
      return { id: message.id ?? null, result: { cancelled: this.ownsCancellation } };
    }
    return { id: message.id ?? null, result: { owner: this.owner } };
  }

  hasActiveWaiters() {
    return this.activeWaiter;
  }
}

test("reload sends new requests to fresh code while a previous controller drains", async () => {
  const previous = new FakeController("previous", { activeWaiter: true, ownsCancellation: true });
  const first = new ReloadableWorkbenchSubagentController({ createController: () => previous });
  const state = first.detachForReload();
  const fresh = new FakeController("fresh");
  const second = new ReloadableWorkbenchSubagentController({ createController: () => fresh, initialState: state });

  assert.deepEqual(await second.handleRequest({ id: 1, method: "workbench/subagent/wait" }), {
    id: 1,
    result: { owner: "fresh" },
  });
  assert.deepEqual(previous.calls, []);

  assert.deepEqual(await second.handleRequest({ id: 2, method: "workbench/subagent/waitCancel" }), {
    id: 2,
    result: { cancelled: true },
  });
  assert.deepEqual(previous.calls, ["workbench/subagent/waitCancel"]);
  assert.equal(previous.disposeCalls, 1);
});

test("legacy bridge state is retiring-only during the first upgraded reload", async () => {
  const legacy = new FakeController("legacy", { activeWaiter: true });
  const fresh = new FakeController("fresh");
  const boundary = new ReloadableWorkbenchSubagentController({
    createController: () => fresh,
    legacyController: legacy,
  });

  const response = await boundary.handleRequest({ id: 3, method: "workbench/subagent/wait" });
  assert.deepEqual(response, { id: 3, result: { owner: "fresh" } });
  assert.deepEqual(legacy.calls, []);
});

test("reload disposes an inactive controller instead of transferring it", () => {
  const inactive = new FakeController("inactive");
  const boundary = new ReloadableWorkbenchSubagentController({ createController: () => inactive });

  const state = boundary.detachForReload();
  assert.equal(inactive.disposeCalls, 1);
  assert.equal(state.retiringControllers.size, 0);
});
