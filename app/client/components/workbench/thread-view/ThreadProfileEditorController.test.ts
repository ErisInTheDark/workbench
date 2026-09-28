/* No production exports. Tests protect editor disclosure and provider-scoped catalogue reads. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadProfileEditorController from "./ThreadProfileEditorController";

test("a repeated trigger closes its active section while other triggers switch sections", () => {
  const controller = new ThreadProfileEditorController();
  controller.toggle("model");
  controller.toggle("model");
  assert.equal(controller.getSnapshot().open, false);
  controller.toggle("model");
  controller.toggle("agent");
  assert.equal(controller.getSnapshot().open, true);
  assert.equal(controller.getSnapshot().activeSection, "agent");
  controller.disclose("profile", true);
  controller.toggle("profile");
  assert.equal(controller.getSnapshot().open, false);
  controller.toggle("model");
  controller.disclose("model", false);
  controller.toggle("model");
  assert.equal(controller.getSnapshot().open, true);
  assert.equal(controller.getSnapshot().activeSection, "model");
});

test("opening a section closes its predecessor and closing a stale section preserves the active one", () => {
  const controller = new ThreadProfileEditorController();
  controller.open("model");
  controller.disclose("agent", true);
  assert.equal(controller.getSnapshot().activeSection, "agent");
  controller.disclose("model", false);
  assert.equal(controller.getSnapshot().activeSection, "agent");
  controller.close();
  controller.open("profile");
  assert.equal(controller.getSnapshot().activeSection, "profile");
});

test("target reset fences old failures and current failures remain visible", async () => {
  const controller = new ThreadProfileEditorController();
  let reject!: (error: Error) => void;
  const pending = controller.loadModels("codex", () => new Promise((_resolve, fail) => { reject = fail; }));
  controller.reset();
  reject(new Error("Previous target unavailable"));
  await pending;
  assert.equal(controller.getSnapshot().modelsError, "");
  await controller.loadModels("codex", async () => { throw new Error("Current target unavailable"); });
  assert.equal(controller.getSnapshot().modelsError, "Current target unavailable");
  assert.equal(controller.getSnapshot().modelsLoading, false);
});

test("model results retain their provider identity across a later selection", async () => {
  const controller = new ThreadProfileEditorController();
  const codex = Promise.withResolvers<[]>();
  const stale = controller.loadModels("codex", () => codex.promise);
  assert.equal(controller.getSnapshot().modelsHarness, "codex");
  const loading = controller.loadModels("opencode", async () => []);
  assert.equal(controller.getSnapshot().modelsHarness, "opencode");
  await loading;
  codex.resolve([]);
  await stale;
  assert.equal(controller.getSnapshot().modelsHarness, "opencode");
  controller.resetModels();
  assert.equal(controller.getSnapshot().modelsHarness, null);
});
