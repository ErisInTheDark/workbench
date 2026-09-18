/* No production exports. Protect overlapping clipboard work and control disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import { createCopyFeedbackController } from "./clipboard-copy-feedback";

test("late clipboard results cannot overwrite a newer result or a remounted control", async () => {
  const writes: ((copied: boolean) => void)[] = [];
  const scheduled = new Map<ReturnType<typeof setTimeout>, () => void>();
  let nextHandle = 0;
  const attributes = new Map<string, string>();
  const button = { title: "", setAttribute: (name: string, value: string) => { attributes.set(name, value); } };
  const controller = createCopyFeedbackController({
    writeText: () => new Promise<boolean>(resolve => writes.push(resolve)),
    schedule: callback => {
      const handle = ++nextHandle as unknown as ReturnType<typeof setTimeout>;
      scheduled.set(handle, callback);
      return handle;
    },
    clearScheduled: handle => { scheduled.delete(handle); },
  });
  const release = controller.register(button);
  const first = controller.copy(button, "first");
  const second = controller.copy(button, "second");
  writes[1]!(false);
  assert.equal(await second, false);
  assert.equal(attributes.get("data-copy-state"), "failed");
  writes[0]!(true);
  assert.equal(await first, false);
  assert.equal(attributes.get("data-copy-state"), "failed");
  const pending = controller.copy(button, "third");
  release();
  assert.equal(scheduled.size, 0);
  const releaseAgain = controller.register(button);
  writes[2]!(true);
  assert.equal(await pending, false);
  assert.equal(attributes.get("data-copy-state"), "idle");
  assert.equal(scheduled.size, 0);
  releaseAgain();
});
