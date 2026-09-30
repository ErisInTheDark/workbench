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
  assert.equal(controller.getSnapshot().modelsErrorByHarness.codex, undefined);
  await controller.loadModels("codex", async () => { throw new Error("Current target unavailable"); });
  assert.equal(controller.getSnapshot().modelsErrorByHarness.codex, "Current target unavailable");
  assert.equal(controller.getSnapshot().modelsLoadingByHarness.codex, false);
});

test("model results retain their provider identity across a later selection", async () => {
  const controller = new ThreadProfileEditorController();
  const codex = Promise.withResolvers<[]>();
  const stale = controller.loadModels("codex", () => codex.promise);
  assert.equal(controller.getSnapshot().modelsLoadingByHarness.codex, true);
  const loading = controller.loadModels("opencode", async () => []);
  assert.equal(controller.getSnapshot().modelsLoadingByHarness.opencode, true);
  await loading;
  codex.resolve([]);
  await stale;
  assert.deepEqual(controller.getSnapshot().modelsByHarness, { codex: [], opencode: [] });
  controller.resetModels();
  assert.deepEqual(controller.getSnapshot().modelsByHarness, {});
});

test("model catalogues remain available after another provider finishes loading", async () => {
  const controller = new ThreadProfileEditorController();
  const codexModel = { id: "codex-model" };
  const openCodeModel = { id: "opencode-go/model" };
  await controller.loadModels("codex", async () => [codexModel] as never);
  await controller.loadModels("opencode", async () => [openCodeModel] as never);
  assert.deepEqual(controller.getSnapshot().modelsByHarness?.codex, [codexModel]);
  assert.deepEqual(controller.getSnapshot().modelsByHarness?.opencode, [openCodeModel]);
});

test("a late refresh cannot replace a newer catalogue for the same provider", async () => {
  const controller = new ThreadProfileEditorController();
  const older = Promise.withResolvers<[]>();
  const pending = controller.loadModels("codex", () => older.promise);
  await controller.loadModels("codex", async () => [{ id: "new" }] as never);
  older.resolve([]);
  await pending;
  assert.deepEqual(controller.getSnapshot().modelsByHarness.codex, [{ id: "new" }]);
});
