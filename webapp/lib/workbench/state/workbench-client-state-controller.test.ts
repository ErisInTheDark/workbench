/*
 * No production exports. Tests protect schema-derived app-state conformance and browser revision application. Keywords: app, state, browser, conformance, polling.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchClientStateResponse,
  WorkbenchClientStateRows,
} from "workbench-shared/state/workbench-client-state";

import { conformWorkbenchClientStateResponse } from "./workbench-client-state-conformance";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

function emptyRows(): WorkbenchClientStateRows {
  return {
    composerDraftAttachments: [],
    composerDrafts: [],
    composerSettings: [],
    draftProfilePreferences: [],
    fileDrafts: [],
    globalPreferences: [],
    harnessModelEfforts: [],
    harnessPreferences: [],
    lastLaunchTarget: [],
    newThreadProfilePreferences: [],
    projectExpandedDirectories: [],
    projectPreferences: [],
    projectSidebarFolders: [],
    projectSidebarPreferences: [],
    questionnaireDraftAnswers: [],
    questionnaireDraftAttachments: [],
    questionnaireDraftSelections: [],
    questionnaireDrafts: [],
    threadProfilePreferences: [],
    threadServiceTiers: [],
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

test("app-state conformance repairs compatible browser/server table skew", () => {
  const rows: Record<string, object[]> = {
    ...emptyRows(),
    futureTable: [{ secret: "not logged" }],
    globalPreferences: [{
      boolean_value: 1,
      future_column: "newer server",
      key: "composerSpellCheck",
      revision: 1,
    }],
  };
  delete rows.projectPreferences;
  const result = conformWorkbenchClientStateResponse({
    ...response("snapshot", 1, emptyRows()),
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
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "futureRoot"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.futureTable"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.globalPreferences.0.future_column"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.projectPreferences"));
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
