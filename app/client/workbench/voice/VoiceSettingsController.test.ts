/* Exports: none. Protect acknowledged settings, stale async results and failure recovery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchModelOption } from "workbench-shared/types";
import { createVoiceConfiguration, type VoiceConfiguration } from "workbench-shared/workbench/voice/voice-session-contract";
import VoiceSettingsController from "./VoiceSettingsController";
import WorkbenchClientStateController from "../state/WorkbenchClientStateController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const model: WorkbenchModelOption = {
  id: "chosen", displayName: "Chosen", description: "", hidden: false, isDefault: true,
  supportsPersonality: false, supportsReasoningEffort: false, supportedReasoningEfforts: [],
  defaultReasoningEffort: null, supportsVision: false, supportsFastMode: false, inputModalities: ["text"],
  maxContextWindowTokens: null, additionalSpeedTiers: [], policyState: null, billingMultiplier: null,
  contextWindow: { defaultTokens: 200000, maximumTokens: 200000 },
};
function fixture() {
  const preferences = new WorkbenchClientStateController();
  const snapshot = preferences.getSnapshot;
  preferences.getSnapshot = () => ({ ...snapshot(), schemaVersion: 13 });
  let saved = createVoiceConfiguration(null);
  const port: ConstructorParameters<typeof VoiceSettingsController>[0] = {
    voice: {
      configuration: {
        read: async () => saved,
        write: async value => { saved = value; return { ok: true }; },
      },
      prepare: async () => ({ ok: true }),
    },
    models: { list: async () => ({ data: [model] }) },
  };
  return { port, preferences, saved: () => saved };
}

test("voice enables only after a complete selection is saved and prepared", async context => {
  const h = fixture();
  const preparation = deferred<{ ok: true }>();
  h.port.voice.prepare = () => preparation.promise;
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  assert.equal(controller.enabled, false);
  await controller.loadModels();
  const selecting = controller.selectModel(model.id);
  assert.equal(controller.enabled, false);
  preparation.resolve({ ok: true });
  await selecting;
  assert.equal(controller.enabled, true);
  await controller.disable();
  assert.equal(controller.enabled, false);
  assert.equal(h.saved().selection?.settings.model, model.id);
  await controller.setEnabled(true);
  await controller.refresh();
  assert.equal(controller.enabled, true);
});

test("audio retention is browser-memory opt-in, independent of shared settings", async context => {
  const h = fixture();
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  assert.equal(controller.getSnapshot().recordAudio, false);
  controller.setRecordAudio(true);
  await controller.disable();
  await controller.refresh();
  assert.equal(controller.getSnapshot().recordAudio, true);
  assert.equal(h.saved().selection, null);
  const reopened = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => reopened.dispose());
  await reopened.ready;
  assert.equal(reopened.getSnapshot().recordAudio, false);
});

test("old app schemas keep voice usable but reject unsupported preference writes", async context => {
  context.mock.method(console, "warn", () => {});
  const h = fixture();
  h.preferences.getSnapshot = () => ({ daemonRegistrationId: "memory", error: "", records: [], revision: 0, schemaVersion: 12 });
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  assert.equal(controller.getSnapshot().canToggle, false);
  await controller.setEnabled(false);
  assert.equal(controller.getSnapshot().inputEnabled, true);
  assert.match(controller.getSnapshot().error, /Reload/);
});

test("a late initial read cannot undo a newer disable", async context => {
  const h = fixture();
  const reading = deferred<VoiceConfiguration>();
  const entered = deferred<void>();
  h.port.voice.configuration.read = () => { entered.resolve(); return reading.promise; };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await entered.promise;
  await controller.disable();
  reading.resolve(createVoiceConfiguration({ harness: "codex", model: "stale" }));
  await controller.ready;
  assert.equal(controller.getSnapshot().selection?.model, "stale");
  assert.equal(controller.enabled, false);
});

test("disable queues after an in-flight save without briefly re-enabling voice", async context => {
  const h = fixture();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const writes: VoiceConfiguration[] = [];
  h.port.voice.configuration.write = async value => {
    writes.push(value);
    if (writes.length === 1) { entered.resolve(); await gate.promise; }
    return { ok: true };
  };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  await controller.loadModels();
  const selecting = controller.selectModel(model.id);
  await entered.promise;
  const disabling = controller.disable();
  const enabled: boolean[] = [];
  controller.subscribe(() => enabled.push(controller.enabled));
  gate.resolve();
  await Promise.all([selecting, disabling]);
  assert.equal(writes.length, 1);
  assert.equal(enabled.some(Boolean), false);
  assert.equal(controller.getSnapshot().selection?.model, model.id);
});

test("changing harness clears the model and fences the previous harness catalogue", async context => {
  const h = fixture();
  h.port.voice.configuration.read = async () => createVoiceConfiguration({ harness: "copilot", model: "old" });
  const first = deferred<{ data: WorkbenchModelOption[] }>();
  let calls = 0;
  h.port.models.list = async () => ++calls === 1 ? first.promise : { data: [model] };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  const old = controller.loadModels();
  await controller.selectHarness("codex");
  assert.equal(controller.getSnapshot().selection, null);
  assert.equal(controller.enabled, false);
  assert.equal(controller.getSnapshot().harness, "codex");
  await controller.loadModels();
  first.resolve({ data: [{ ...model, id: "old" }] });
  await old;
  assert.deepEqual(controller.getSnapshot().models.map(option => option.id), [model.id]);
});

test("read and catalogue failures stay visible until an explicit retry succeeds", async context => {
  context.mock.method(console, "warn", () => {});
  const h = fixture();
  const read = h.port.voice.configuration.read;
  const list = h.port.models.list;
  h.port.voice.configuration.read = async () => { throw new Error("read failed"); };
  h.port.models.list = async () => { throw new Error("catalogue failed"); };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  assert.equal(controller.enabled, false);
  assert.match(controller.getSnapshot().error, /read failed/);
  await controller.loadModels();
  assert.equal(controller.getSnapshot().catalogue, "failed");
  assert.match(controller.getSnapshot().catalogueError, /catalogue failed/);
  h.port.voice.configuration.read = read;
  h.port.models.list = list;
  await controller.refresh();
  await controller.loadModels();
  assert.equal(controller.getSnapshot().status, "disabled");
  assert.equal(controller.getSnapshot().catalogue, "ready");
  assert.equal(controller.getSnapshot().error, "");
  assert.equal(controller.getSnapshot().catalogueError, "");
});

test("failed persistence and preparation remain visible and can recover", async context => {
  const warnings = context.mock.method(console, "warn", () => {});
  const h = fixture();
  const write = h.port.voice.configuration.write;
  h.port.voice.configuration.write = async () => { throw new Error("write refused"); };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  await controller.loadModels();
  await controller.selectModel(model.id);
  assert.equal(controller.enabled, false);
  assert.match(controller.getSnapshot().error, /write refused/);
  h.port.voice.configuration.write = write;
  h.port.voice.prepare = async () => { throw new Error("native unavailable"); };
  await controller.selectModel(model.id);
  assert.equal(controller.enabled, false);
  assert.match(controller.getSnapshot().error, /native unavailable/);
  h.port.voice.prepare = async () => ({ ok: true });
  await controller.refresh();
  assert.equal(controller.enabled, true);
  assert.equal(warnings.mock.callCount(), 2);
});

test("disconnect and disposal fence late preparation and catalogue results", async context => {
  const h = fixture();
  const preparation = deferred<{ ok: true }>();
  const entered = deferred<void>();
  h.port.voice.prepare = () => { entered.resolve(); return preparation.promise; };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  await controller.loadModels();
  const selecting = controller.selectModel(model.id);
  await entered.promise;
  controller.disconnect();
  preparation.resolve({ ok: true });
  await selecting;
  assert.equal(controller.enabled, false);
  const catalogue = deferred<{ data: WorkbenchModelOption[] }>();
  h.port.models.list = () => catalogue.promise;
  const loading = controller.loadModels();
  controller.dispose();
  const snapshot = controller.getSnapshot();
  catalogue.resolve({ data: [model] });
  await loading;
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(controller.enabled, false);
});
