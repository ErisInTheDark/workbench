/* Exports: none. Protect acknowledged settings, stale async results and failure recovery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchModelOption } from "workbench-shared/types";
import { createVoiceConfiguration, type VoiceConfiguration } from "workbench-shared/workbench/voice/voice-session-contract";
import VoiceSettingsController from "./VoiceSettingsController";
import WorkbenchClientStateController from "../state/WorkbenchClientStateController";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";

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
        // Like the daemon store: a write that omits audio retention keeps the saved value.
        write: async value => { saved = { ...value, recordAudio: value.recordAudio ?? saved.recordAudio }; return { ok: true }; },
      },
      prepare: async () => ({ ok: true }),
    },
    models: { list: async () => ({ data: [model] }) },
  };
  return { port, preferences, saved: () => saved };
}

test("retired voice reads ignore owned interruption without hiding unexpected failures", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  for (const interruption of [true, false]) {
    const h = fixture();
    const entered = Promise.withResolvers<void>();
    const read = Promise.withResolvers<VoiceConfiguration>();
    h.port.voice.configuration.read = () => { entered.resolve(); return read.promise; };
    const controller = new VoiceSettingsController(h.port, h.preferences);
    await entered.promise;
    controller.dispose();
    read.reject(interruption ? new WorkbenchRpcRequestInterruptedError("disposed", true)
      : new Error("unexpected storage failure"));
    await controller.ready;
    assert.equal(warnings.length, interruption ? 0 : 1);
  }
});

test("voice enables only after a complete selection is saved and prepared", async context => {
  const h = fixture();
  const preparation = deferred<{ ok: true }>();
  h.port.voice.prepare = () => preparation.promise;
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  assert.equal(controller.enabled, false);
  await controller.loadModels();
  const selecting = controller.selectModel("codex", model.id);
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

test("audio retention is saved on the daemon and a later model change cannot drop it", async context => {
  const h = fixture();
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  await controller.loadModels();
  await controller.selectModel("codex", model.id);
  assert.equal(controller.getSnapshot().recordAudio, false);
  const saving = controller.setRecordAudio(true);
  assert.equal(controller.getSnapshot().recordAudio, true);
  await saving;
  await controller.selectModel("claude", model.id);
  const reopened = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => reopened.dispose());
  await reopened.ready;
  assert.equal(reopened.getSnapshot().recordAudio, true);
  assert.equal(reopened.getSnapshot().selection?.harness, "claude");
});

test("a failed audio retention save reverts and stays visible", async context => {
  context.mock.method(console, "warn", () => {});
  const h = fixture();
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  await controller.loadModels();
  await controller.selectModel("codex", model.id);
  h.port.voice.configuration.write = async () => { throw new Error("disk full"); };
  await controller.setRecordAudio(true);
  assert.equal(controller.getSnapshot().recordAudio, false);
  assert.match(controller.getSnapshot().error, /disk full/);
});

test("old app schemas keep voice usable but reject unsupported preference writes", async context => {
  context.mock.method(console, "warn", () => {});
  const h = fixture();
  h.preferences.getSnapshot = () => ({ attachmentsAsUrls: false, daemonRegistrationId: "memory", error: "", records: [], registrations: [], revision: 0, schemaVersion: 12 });
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
  const selecting = controller.selectModel("codex", model.id);
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

test("one harness catalogue failing leaves the other harness models selectable", async context => {
  context.mock.method(console, "warn", () => {});
  const h = fixture();
  h.port.models.list = async harness => {
    if (harness === "claude") throw new Error("claude offline");
    return { data: [{ ...model, id: `${harness}-model` }, { ...model, id: `${harness}-hidden`, hidden: true }] };
  };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  await controller.loadModels();
  const { catalogues, cataloguesLoading, error } = controller.getSnapshot();
  assert.equal(cataloguesLoading, false);
  assert.equal(catalogues.claude, undefined);
  assert.deepEqual(catalogues.codex?.map(option => option.id), ["codex-model"]);
  assert.equal(error, "");
  await controller.selectModel("opencode", "opencode-model");
  assert.equal(h.saved().selection?.settings.model, "opencode-model");
  await controller.selectModel("codex", "codex-hidden");
  assert.match(controller.getSnapshot().error, /no longer available/);
});

test("a newer catalogue load fences an older late response", async context => {
  const h = fixture();
  const first = deferred<{ data: WorkbenchModelOption[] }>();
  let calls = 0;
  h.port.models.list = async harness => harness === "codex" && ++calls === 1 ? first.promise : { data: [model] };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  const old = controller.loadModels();
  await controller.loadModels();
  first.resolve({ data: [{ ...model, id: "stale" }] });
  await old;
  assert.deepEqual(controller.getSnapshot().catalogues.codex?.map(option => option.id), [model.id]);
});

test("read failures stay visible until a later refresh succeeds", async context => {
  context.mock.method(console, "warn", () => {});
  const h = fixture();
  const read = h.port.voice.configuration.read;
  h.port.voice.configuration.read = async () => { throw new Error("read failed"); };
  const controller = new VoiceSettingsController(h.port, h.preferences);
  context.after(() => controller.dispose());
  await controller.ready;
  assert.equal(controller.enabled, false);
  assert.match(controller.getSnapshot().error, /read failed/);
  h.port.voice.configuration.read = read;
  await controller.refresh();
  assert.equal(controller.getSnapshot().status, "disabled");
  assert.equal(controller.getSnapshot().error, "");
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
  await controller.selectModel("codex", model.id);
  assert.equal(controller.enabled, false);
  assert.match(controller.getSnapshot().error, /write refused/);
  h.port.voice.configuration.write = write;
  h.port.voice.prepare = async () => { throw new Error("native unavailable"); };
  await controller.selectModel("codex", model.id);
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
  const selecting = controller.selectModel("codex", model.id);
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
