/*
 * No production exports. Tests protect operation-owned response conformance and notification admission. Keywords: transcript, browser, protocol.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchTranscriptClient, {
  type WorkbenchTranscriptConformanceReport,
} from "./WorkbenchTranscriptClient";
import {
  workbenchTranscriptNotifications,
  workbenchTranscriptOperations,
} from "./workbench-transcript-contract";

const emptySnapshot = {
  thread: {
    id: "thread",
    project_id: "project",
    project_root: "C:/project",
    title: "Thread",
    archived: 0,
    pinned: 0,
    snoozed: 0,
    transcript_content_version: 1,
    next_turn_index: 0,
    created_at: 1,
    updated_at: 1,
    activity_at: 1,
  },
  turns: [],
  loadedTurnIds: [],
  hasPreviousTurns: false,
  rows: {},
};

test("transcript client uses operation identities but never trusts their matching response", async () => {
  const reports: WorkbenchTranscriptConformanceReport[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let receiveNotification: ((notification: { method: string; params: unknown }) => void) | undefined;
  const client = new WorkbenchTranscriptClient({
    reportConformance: (report) => reports.push(report),
    transport: {
      onNotification: (listener) => {
        receiveNotification = listener;
        return () => undefined;
      },
      request: async (method, params) => {
        requests.push({ method, params });
        return { snapshot: { matchingMethodIsNotProof: true } };
      },
    },
  });
  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: 1 },
  });

  await assert.rejects(
    client.read({ threadId: "thread", turnLimit: 20 }),
    /Incompatible workbench\/transcript\/read response/u,
  );
  assert.deepEqual(requests, [{
    method: workbenchTranscriptOperations.read.method,
    params: { threadId: "thread", turnLimit: 20 },
  }]);
  assert.equal(reports.length, 1);
  assert.ok(reports[0].issues.length > 0);
  client.dispose();
});

test("parity reporting uses its registered operation and conforms the acknowledgement", async () => {
  const reports: WorkbenchTranscriptConformanceReport[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let receiveNotification: ((notification: { method: string; params: unknown }) => void) | undefined;
  const diagnostic = {
    threadId: "thread",
    scope: "item" as const,
    mismatch: "payload" as const,
    jsonContext: [],
    sqliteContext: [],
  };
  const client = new WorkbenchTranscriptClient({
    reportConformance: (report) => reports.push(report),
    transport: {
      onNotification: (listener) => {
        receiveNotification = listener;
        return () => undefined;
      },
      request: async (method, params) => {
        requests.push({ method, params });
        return { reported: true, futureField: true };
      },
    },
  });
  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: 1 },
  });

  await client.reportParity(diagnostic);
  assert.deepEqual(requests, [{
    method: workbenchTranscriptOperations.reportParity.method,
    params: diagnostic,
  }]);
  assert.deepEqual(reports, [{
    issues: [],
    method: workbenchTranscriptOperations.reportParity.method,
    repairedPaths: [["futureField"]],
  }]);
  client.dispose();
});

test("transcript client ignores a method-matched malformed notification after bounded reporting", async () => {
  let receiveNotification: ((notification: { method: string; params: unknown }) => void) | undefined;
  const reports: WorkbenchTranscriptConformanceReport[] = [];
  let publications = 0;
  const client = new WorkbenchTranscriptClient({
    reportConformance: (report) => reports.push(report),
    transport: {
      onNotification: (listener) => {
        receiveNotification = listener;
        return () => undefined;
      },
      request: async () => ({ subscribed: true }),
    },
  });
  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: 1 },
  });

  await client.subscribe({ subscriptionId: "sub", threadId: "thread", turnLimit: 20 }, () => publications += 1);
  for (let index = 0; index < 100; index += 1) {
    receiveNotification?.({
      method: workbenchTranscriptNotifications.updated.method,
      params: { stream: "workbench:transcript", subscriptionId: "sub", snapshot: "fake" },
    });
  }

  assert.equal(publications, 0);
  assert.equal(reports.length, 1);
  assert.ok(reports[0].issues.length > 0);
  client.dispose();
});

test("transcript subscription owns its listener before the server publishes initial data or absence", async () => {
  let receiveNotification: ((notification: { method: string; params: unknown }) => void) | undefined;
  const publications: Array<typeof emptySnapshot | null> = [];
  const client = new WorkbenchTranscriptClient({
    transport: {
      onNotification: (listener) => {
        receiveNotification = listener;
        return () => undefined;
      },
      request: async (method) => {
        if (method === workbenchTranscriptOperations.subscribe.method) {
          receiveNotification?.({
            method: workbenchTranscriptNotifications.updated.method,
            params: {
              stream: "workbench:transcript",
              subscriptionId: "sub",
              snapshot: null,
            },
          });
          return { subscribed: true };
        }
        return { unsubscribed: true };
      },
    },
  });
  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: 1 },
  });

  await client.subscribe(
    { subscriptionId: "sub", threadId: "thread", turnLimit: 20 },
    (snapshot) => publications.push(snapshot),
  );
  assert.deepEqual(publications, [null]);
  client.dispose();
});

test("transcript capability gates requests and reset or connection loss revokes connection-owned state", async () => {
  let receiveNotification: ((notification: { method: string; params: unknown }) => void) | undefined;
  let disconnect: (() => void) | undefined;
  const availability: boolean[] = [];
  const reports: WorkbenchTranscriptConformanceReport[] = [];
  const requests: string[] = [];
  let publications = 0;
  const client = new WorkbenchTranscriptClient({
    reportConformance: (report) => reports.push(report),
    transport: {
      onDisconnect: (listener) => {
        disconnect = listener;
        return () => undefined;
      },
      onNotification: (listener) => {
        receiveNotification = listener;
        return () => undefined;
      },
      request: async (method) => {
        requests.push(method);
        if (method === workbenchTranscriptOperations.subscribe.method) return { subscribed: true };
        return { snapshot: emptySnapshot };
      },
    },
  });
  client.onAvailabilityChange((available) => availability.push(available));

  await assert.rejects(
    client.read({ threadId: "thread", turnLimit: 20 }),
    /transcript protocol is unavailable/u,
  );
  assert.deepEqual(requests, []);

  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: "1" },
  });
  assert.deepEqual(availability, [false]);
  assert.equal(reports.length, 1);

  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: 1, futureField: true },
  });
  await client.subscribe(
    { subscriptionId: "sub", threadId: "thread", turnLimit: 20 },
    () => publications += 1,
  );
  receiveNotification?.({
    method: "workbench/thread-state/reset",
    params: {},
  });
  receiveNotification?.({
    method: workbenchTranscriptNotifications.updated.method,
    params: {
      stream: "workbench:transcript",
      subscriptionId: "sub",
      snapshot: emptySnapshot,
    },
  });
  await assert.rejects(
    client.read({ threadId: "thread", turnLimit: 20 }),
    /transcript protocol is unavailable/u,
  );
  assert.equal(publications, 0);

  receiveNotification?.({
    method: workbenchTranscriptNotifications.capabilities.method,
    params: { protocolVersion: 1 },
  });
  disconnect?.();
  assert.deepEqual(availability, [false, true, false, true, false]);
  assert.deepEqual(requests, [workbenchTranscriptOperations.subscribe.method]);
  assert.deepEqual(reports[1]?.repairedPaths, [["futureField"]]);
  client.dispose();
});
