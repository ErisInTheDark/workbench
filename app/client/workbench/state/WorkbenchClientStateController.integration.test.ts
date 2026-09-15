/*
 * No production exports. Tests protect app-state conformance and browser revision application.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchAppStateRepository from "../../../server/state/WorkbenchAppStateRepository";
import WorkbenchBrowserStateRegistry from "../../../server/state/WorkbenchBrowserStateRegistry";
import WorkbenchAppStateRoutes from "../../../server/state/workbench-app-state-routes";

import type {
  WorkbenchClientStateResponse,
  WorkbenchClientStateRows,
} from "workbench-shared/state/workbench-client-state";
import { WORKBENCH_BROWSER_STATE_HEADER } from "workbench-shared/state/workbench-client-state";

import { conformWorkbenchClientStateResponse } from "./workbench-client-state-conformance";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

test("real app-state remapping orders pending and later saves without losing edits across a failed retry", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-remap-"));
  const repository = new WorkbenchAppStateRepository({ databasePath: path.join(directory, "state.sqlite3") });
  await repository.start();
  const registry = new WorkbenchBrowserStateRegistry(repository);
  registry.start();
  const routes = new WorkbenchAppStateRoutes(registry);
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, "http://localhost"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const started = deferred<void>();
  const release = deferred<void>();
  let firstWrite = true;
  let rejectRemap = true;
  const controller = new WorkbenchClientStateController({
    mode: "http", schedule: () => 1, cancelSchedule: () => {},
    fetcher: async (input, init) => {
      if (init?.method === "PUT" && firstWrite) {
        firstWrite = false;
        started.resolve();
        await release.promise;
      }
      if (init?.method === "POST" && rejectRemap) {
        rejectRemap = false;
        return new Response("injected remap failure", { status: 500 });
      }
      return fetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init);
    },
  });
  try {
    await controller.bootstrap();
    const identity = { kind: "composerDraft" as const, daemonRegistrationId: controller.daemonRegistrationId, projectId: "old", threadId: "thread" };
    const value = { text: "first", attachments: [{ id: "a", url: "attachment" }], updatedAt: 1 };
    const first = controller.put({ ...identity, value });
    await started.promise;
    const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
    const aliases = [{ alias: "old", projectId }];
    const failed = assert.rejects(controller.adoptProjectAliases(aliases), /injected remap failure/);
    const later = controller.put({ ...identity, value: { ...value, text: "later", updatedAt: 2 } });
    release.resolve();
    await Promise.all([first, failed, later]);
    assert.equal(controller.records("composerDraft")[0]!.value.text, "later");
    assert.equal(controller.resolveProjectId("old"), "old");
    controller.rememberThreadIdentityAlias("old", "thread", "canonical-thread");
    const observedDrafts: Array<{ projectId: string; threadId: string }> = [];
    const unsubscribe = controller.subscribe(() => {
      observedDrafts.push(...controller.records("composerDraft").map(({ projectId, threadId }) => ({ projectId, threadId })));
    });
    const adopted = controller.adoptProjectAliases(aliases);
    const latest = controller.put({ ...identity, value: { ...value, text: "latest", updatedAt: 3 } });
    await Promise.all([adopted, latest]);
    unsubscribe();
    assert.ok(observedDrafts.every(draft => draft.threadId === "canonical-thread"));
    assert.deepEqual(controller.records("composerDraft"), [{ ...identity, projectId, threadId: "canonical-thread", value: { ...value, text: "latest", updatedAt: 3 } }]);
    await controller.bootstrap();
    assert.equal(controller.records("composerDraft").length, 1);
    assert.equal(controller.records("composerDraft")[0]!.value.text, "latest");
  } finally {
    release.resolve();
    controller.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await registry.close();
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("font size survives a later state snapshot and retains legacy whole-rem values", async () => {
  for (const [stored, expected] of [[116, 1.16], [1, 1]]) {
    const rows = emptyRows();
    rows.globalPreferences.push({
      key: "editorFontSize", integer_value: stored, boolean_value: null, text_value: null, deleted: 0, revision: 1,
    });
    const controller = new WorkbenchClientStateController({
      mode: "http",
      fetcher: async () => Response.json(response("snapshot", 1, rows)),
      schedule: () => 1,
      cancelSchedule: () => {},
    });
    try {
      await controller.bootstrap();
      assert.equal(controller.records("globalPreference")[0]?.preference.value, expected);
      await controller.bootstrap();
      assert.equal(controller.records("globalPreference")[0]?.preference.value, expected);
    } finally { controller.dispose(); }
  }
});

function emptyRows(): WorkbenchClientStateRows {
  return {
    composerDraftAttachments: [],
    composerDrafts: [],
    fileDrafts: [],
    globalPreferences: [],
    modelPreferences: [],
    lastLaunchTarget: [],
    projectExpandedDirectories: [],
    projectPreferences: [],
    projectSidebarFolders: [],
    projectSidebarPreferences: [],
    questionnaireDraftAnswers: [],
    questionnaireDraftAttachments: [],
    questionnaireDraftSelections: [],
    questionnaireDrafts: [],
  };
}

function response(
  kind: "delta" | "snapshot",
  revision: number,
  rows: WorkbenchClientStateRows,
): WorkbenchClientStateResponse {
  return {
    daemonRegistrationId: "registration",
    kind,
    oldestAvailableRevision: 0,
    revision,
    rows,
    schemaVersion: 0,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("model favourite changes remain independent and roll back failed saves", async () => {
  const saved = deferred<Response>();
  const controller = new WorkbenchClientStateController({
    mode: "http",
    fetcher: async (_input, init) => init?.method === "GET"
      ? Response.json(response("snapshot", 0, emptyRows()))
      : (await saved.promise).clone(),
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  await controller.bootstrap();
  try {
    const codex = { kind: "modelPreference" as const, harness: "codex" as const, modelId: "same-model", favourite: false };
    const copilot = { ...codex, harness: "copilot" as const };
    const first = controller.put(codex);
    const second = controller.put(copilot);
    assert.deepEqual(controller.records("modelPreference"), [codex, copilot]);
    const rejected = Promise.all([assert.rejects(first, /save failed/), assert.rejects(second, /save failed/)]);
    saved.resolve(new Response("save failed", { status: 500 }));
    await rejected;
    assert.deepEqual(controller.records("modelPreference"), []);
  } finally {
    controller.dispose();
  }
});

test("app-state conformance repairs compatible browser/server table skew", () => {
  const rows: Record<string, object[]> = {
    ...emptyRows(),
    futureTable: [{ secret: "not logged" }],
    globalPreferences: [{
      boolean_value: 1,
      future_column: "newer server",
      key: "composerSpellCheck",
      revision: 1,
    }, {
      boolean_value: 1,
      integer_value: null,
      key: "futurePreference",
      revision: 1,
      text_value: null,
    }],
  };
  delete rows.projectPreferences;
  delete rows.modelPreferences;
  const legacyResponse = response("snapshot", 1, emptyRows());
  delete legacyResponse.schemaVersion;
  const result = conformWorkbenchClientStateResponse({
    ...legacyResponse,
    futureRoot: true,
    rows,
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.rows.globalPreferences, [{
    boolean_value: 1,
    deleted: 0,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 1,
    text_value: null,
  }]);
  assert.deepEqual(result.data.rows.projectPreferences, []);
  assert.deepEqual(result.data.rows.modelPreferences, []);
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "futureRoot"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.futureTable"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.globalPreferences.0.future_column"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.globalPreferences.1"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.projectPreferences"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "schemaVersion"));
  assert.equal(result.data.schemaVersion, 0);
});

test("app-state conformance rejects a missing required current-table column", () => {
  const result = conformWorkbenchClientStateResponse({
    ...response("snapshot", 1, emptyRows()),
    rows: {
      ...emptyRows(),
      globalPreferences: [{
        boolean_value: 1,
        deleted: 0,
        integer_value: null,
        key: "composerSpellCheck",
        text_value: null,
      }],
    },
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.issues, [{
      code: "missingRequired",
      path: ["rows", "globalPreferences", 0, "revision"],
    }]);
  }
});

test("HTTP state requests carry browser identity and use the browser global receiver", async () => {
  const browserStateId = "10000000-0000-4000-8000-000000000001";
  const methods: string[] = [];
  const fetcher: typeof fetch = function (this: typeof globalThis, _input, init) {
    assert.equal(this, globalThis);
    assert.equal(new Headers(init?.headers).get(WORKBENCH_BROWSER_STATE_HEADER), browserStateId);
    methods.push(init?.method ?? "GET");
    return Promise.resolve(Response.json({
      ...response("snapshot", methods.length - 1, emptyRows()),
      schemaVersion: 4,
    }));
  };
  const controller = new WorkbenchClientStateController({
    browserStateId,
    cancelSchedule: () => undefined,
    fetcher,
    mode: "http",
    schedule: () => 1,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });

  await controller.bootstrap();
  await controller.put({
    kind: "globalPreference",
    preference: { key: "composerSpellCheck", value: true },
  });
  await controller.delete({ key: "composerSpellCheck", kind: "globalPreference" });
  assert.equal(controller.getSnapshot().daemonRegistrationId, "registration");
  assert.equal(controller.getSnapshot().schemaVersion, 4);
  assert.deepEqual(methods, ["GET", "PUT", "DELETE"]);
  controller.dispose();
});

test("same-identity mutations stay ordered and old responses remain behind the newest optimistic draft", async () => {
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  let requestCount = 0;
  const draftResponse = (revision: number, text: string) => {
    const rows = emptyRows();
    rows.composerDrafts.push({
      daemon_registration_id: "registration",
      deleted: 0,
      project_id: "project",
      revision,
      text,
      thread_id: "thread",
      updated_at: revision,
    });
    return response("delta", revision, rows);
  };
  const controller = new WorkbenchClientStateController({
    cancelSchedule: () => undefined,
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json(response("snapshot", 0, emptyRows()));
      if (requestCount === 2) return await firstResponse.promise;
      return await secondResponse.promise;
    },
    mode: "http",
    schedule: () => 1,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });
  await controller.bootstrap();
  const base = {
    daemonRegistrationId: "registration",
    kind: "composerDraft" as const,
    projectId: "project",
    threadId: "thread",
  };
  const firstMutation = controller.put({
    ...base,
    value: { attachments: [], text: "first", updatedAt: 1 },
  });
  const secondMutation = controller.put({
    ...base,
    value: { attachments: [], text: "second", updatedAt: 2 },
  });
  await Promise.resolve();
  assert.equal(controller.records("composerDraft")[0]?.value.text, "second");
  assert.equal(requestCount, 2);

  firstResponse.resolve(Response.json(draftResponse(1, "first")));
  await firstMutation;
  await Promise.resolve();
  assert.equal(controller.records("composerDraft")[0]?.value.text, "second");
  assert.equal(requestCount, 3);

  secondResponse.resolve(Response.json(draftResponse(2, "second")));
  await secondMutation;
  assert.equal(controller.records("composerDraft")[0]?.value.text, "second");
  controller.dispose();
});

test("a failed latest mutation removes only its optimistic value", async () => {
  const rows = emptyRows();
  rows.globalPreferences.push({
    boolean_value: 1,
    deleted: 0,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 1,
    text_value: null,
  });
  let requestCount = 0;
  const controller = new WorkbenchClientStateController({
    cancelSchedule: () => undefined,
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json(response("snapshot", 1, rows));
      throw new Error("write failed");
    },
    mode: "http",
    schedule: () => 1,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });
  await controller.bootstrap();
  const mutation = controller.put({
    kind: "globalPreference",
    preference: { key: "composerSpellCheck", value: false },
  });
  assert.equal(controller.records("globalPreference")[0]?.preference.value, false);
  await assert.rejects(mutation, /write failed/u);
  assert.equal(controller.records("globalPreference")[0]?.preference.value, true);
  controller.dispose();
});

test("crossed responses for unrelated identities retain both confirmed mutations", async () => {
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  let requestCount = 0;
  const mutationResponse = (
    revision: number,
    key: "composerSpellCheck" | "editorSpellCheck",
    value: 0 | 1,
  ) => {
    const rows = emptyRows();
    rows.globalPreferences.push({
      boolean_value: value,
      deleted: 0,
      integer_value: null,
      key,
      revision,
      text_value: null,
    });
    return response("delta", revision, rows);
  };
  const controller = new WorkbenchClientStateController({
    cancelSchedule: () => undefined,
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json(response("snapshot", 0, emptyRows()));
      if (requestCount === 2) return await firstResponse.promise;
      return await secondResponse.promise;
    },
    mode: "http",
    schedule: () => 1,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });
  await controller.bootstrap();
  const firstMutation = controller.put({
    kind: "globalPreference",
    preference: { key: "composerSpellCheck", value: true },
  });
  const secondMutation = controller.put({
    kind: "globalPreference",
    preference: { key: "editorSpellCheck", value: true },
  });
  await Promise.resolve();
  assert.equal(requestCount, 3);

  secondResponse.resolve(Response.json(mutationResponse(2, "editorSpellCheck", 1)));
  await secondMutation;
  firstResponse.resolve(Response.json(mutationResponse(1, "composerSpellCheck", 1)));
  await firstMutation;
  assert.deepEqual(
    controller.records("globalPreference").map((record) => record.preference.key).sort(),
    ["composerSpellCheck", "editorSpellCheck"],
  );
  controller.dispose();
});

test("browser state applies a conformed snapshot and a later tombstone delta", async () => {
  const snapshotRows = emptyRows();
  snapshotRows.globalPreferences.push({
    boolean_value: 1,
    deleted: 0,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 1,
    text_value: null,
  });
  const deltaRows = emptyRows();
  deltaRows.globalPreferences.push({
    boolean_value: null,
    deleted: 1,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 2,
    text_value: null,
  });
  const responses = [
    response("snapshot", 1, snapshotRows),
    response("delta", 2, deltaRows),
  ];
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json(responses.shift());
  };
  const controller = new WorkbenchClientStateController({
    cancelSchedule: () => undefined,
    fetcher,
    mode: "http",
    schedule: () => 1,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });

  await controller.bootstrap();
  assert.equal(controller.records("globalPreference")[0]?.preference.value, true);
  await controller.delete({ key: "composerSpellCheck", kind: "globalPreference" });
  assert.deepEqual(controller.records("globalPreference"), []);
  assert.deepEqual(methods, ["GET", "DELETE"]);
  controller.dispose();
});

test("polling pauses while hidden, resumes immediately, and remains serial", async () => {
  const pollResponse = deferred<Response>();
  const nextSchedule = deferred<void>();
  const scheduled = new Map<number, () => void>();
  let nextScheduleId = 0;
  let hidden = false;
  let visibilityListener = () => {};
  let requestCount = 0;
  const controller = new WorkbenchClientStateController({
    cancelSchedule: (id) => {
      scheduled.delete(id);
    },
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json(response("snapshot", 0, emptyRows()));
      return await pollResponse.promise;
    },
    mode: "http",
    schedule: (callback) => {
      const id = ++nextScheduleId;
      scheduled.set(id, callback);
      if (id > 1) nextSchedule.resolve();
      return id;
    },
    visibility: {
      hidden: () => hidden,
      subscribe: (listener) => {
        visibilityListener = listener;
        return () => {
          visibilityListener = () => {};
        };
      },
    },
  });

  await controller.bootstrap();
  assert.equal(scheduled.size, 1);
  hidden = true;
  visibilityListener();
  assert.equal(scheduled.size, 0);

  hidden = false;
  visibilityListener();
  visibilityListener();
  assert.equal(requestCount, 2);
  pollResponse.resolve(Response.json(response("delta", 0, emptyRows())));
  await nextSchedule.promise;
  assert.equal(scheduled.size, 1);
  controller.dispose();
});

test("stale polls cannot overwrite mutations and poll failures stay visible", async () => {
  const snapshotRows = emptyRows();
  snapshotRows.globalPreferences.push({
    boolean_value: 1,
    deleted: 0,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 1,
    text_value: null,
  });
  const mutationRows = emptyRows();
  mutationRows.globalPreferences.push({
    boolean_value: 0,
    deleted: 0,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 3,
    text_value: null,
  });
  const staleRows = emptyRows();
  staleRows.globalPreferences.push({
    boolean_value: 1,
    deleted: 0,
    integer_value: null,
    key: "composerSpellCheck",
    revision: 2,
    text_value: null,
  });
  const scheduled: Array<() => void> = [];
  const scheduleSignals = [deferred<void>(), deferred<void>(), deferred<void>()];
  let requestCount = 0;
  let scheduleCount = 0;
  const controller = new WorkbenchClientStateController({
    cancelSchedule: () => undefined,
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json(response("snapshot", 1, snapshotRows));
      if (requestCount === 2) return Response.json(response("delta", 3, mutationRows));
      if (requestCount === 3) return Response.json(response("delta", 2, staleRows));
      throw new Error("poll unavailable");
    },
    mode: "http",
    schedule: (callback) => {
      scheduleCount += 1;
      scheduled.push(callback);
      scheduleSignals[Math.min(scheduleCount - 1, scheduleSignals.length - 1)].resolve();
      return scheduleCount;
    },
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });

  await controller.bootstrap();
  await controller.put({ kind: "globalPreference", preference: { key: "composerSpellCheck", value: false } });
  scheduled.shift()?.();
  await scheduleSignals[1].promise;
  assert.equal(controller.getSnapshot().revision, 3);
  assert.equal(controller.records("globalPreference")[0]?.preference.value, false);

  scheduled.shift()?.();
  await scheduleSignals[2].promise;
  assert.match(controller.getSnapshot().error, /poll unavailable/u);
  controller.dispose();
});
