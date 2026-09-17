/* No production exports. Protect native request routing and canonical response identity. */
/*
 * No exports. Tests protect canonical references, durable alias convergence, projection timing and body-free live projection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { admitProviderThreadItems } from "./CodexProviderIdentity";
import { mapNativeProviderResponse, mapWorkbenchProviderRequest } from "./CodexPublicIdentity";
import { NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "remote-child": fixtureIdentitySchemas.NativeThreadIdSchema.parse("remote-child"),
    "session": fixtureIdentitySchemas.NativeThreadIdSchema.parse("session"),
  },
  NativeTurnId: {
    "unobserved-turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("unobserved-turn"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("local:///project"),
  },
};

async function setup(platform: NodeJS.Platform = process.platform) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchThreadIdentityRepository(database, platform);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async (inputs) => repository.observeMany(inputs),
    resolveThreadIdentity: async (input) => repository.resolve(input),
    resolveNativeThreadIdentity: async (input) => repository.resolveNative(input),
    observeTurnIdentities: async (inputs) => repository.observeTurns(inputs),
    resolveTurnIdentity: async (input) => repository.resolveTurn(input),
  }, platform);
  let admissions = 0;
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async (input) => {
      admissions += 1;
      return itemRepository.admitMany(input);
    },
    resolveTranscriptItemIdentity: async () => { throw new Error("Unexpected projection database read"); },
  });
  const native = { harness: "codex", nativeLocation: "C:/repo", nativeThreadId: NativeThreadIdSchema.parse("native-parent"), nativeTurnId: NativeTurnIdSchema.parse("native-turn") };
  const parent = await threads.observe({
    native, projectId: fixtureIdentityValues.ProjectId.project, projectRoot: "C:/repo", title: "Parent",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const child = await threads.observe({
    native: { ...native, nativeThreadId: NativeThreadIdSchema.parse("native-child") },
    projectId: fixtureIdentityValues.ProjectId.project, projectRoot: "C:/repo", title: "Child",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const turn = await threads.observeTurn({
    kind: "turn", threadId: parent.threadId, turnId: native.nativeTurnId, harnessId: native.harness,
    nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId, nativeTurnId: native.nativeTurnId,
    state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  });
  return { database, owners: { threads, items }, native, parent, child, turn, admissions: () => admissions };
}

test("SQL context responses remain canonical across the provider response boundary", async () => {
  const { database, owners, native, parent, turn } = await setup();
  try {
    for (const method of ["thread/context/read", "workbench/thread/page/read"]) {
      const response = { id: 1, result: {
        thread: { id: parent.threadId, turns: [{ id: turn.turnId, items: [] }] },
        questionnaireEntries: [], steerEntries: [], browseResultEntries: [],
        entryScope: { mode: "turns", turnIds: [turn.turnId] },
      } };
      assert.deepEqual(await mapNativeProviderResponse(owners, "codex", {
        method, params: { threadId: native.nativeThreadId },
      }, response), response);
    }
  } finally {
    owners.items.dispose();
    owners.threads.dispose();
    database.close();
  }
});

test("managed message routing preserves the steer template and rejects explicit cross-thread targets", async () => {
  const { database, owners, native, parent, child } = await setup();
  try {
    for (const threadId of [parent.threadId, native.nativeThreadId]) {
      const steerRequest = { method: "turn/steer", params: {}, workbenchPromptContext: { source: "template" } };
      const request = {
        method: "workbench/codex/message/admit",
        params: {
          threadId,
          resumeRequest: { method: "thread/resume", params: { threadId } },
          startRequest: { method: "turn/start", params: { threadId, input: [] } },
          steerRequest,
        },
      };
      const mapped = await mapWorkbenchProviderRequest(owners.threads, "codex", request);
      const params = mapped.request.params as typeof request.params;
      assert.equal(params.threadId, native.nativeThreadId);
      assert.equal(params.startRequest.params.threadId, native.nativeThreadId);
      assert.equal(params.resumeRequest.params.threadId, native.nativeThreadId);
      assert.deepEqual(params.steerRequest, steerRequest, "The admission owner supplies the active destination later");
      await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
        ...request, params: { ...request.params, steerRequest: {
          ...steerRequest, params: { threadId: child.threadId },
        } },
      }), /same thread/);
    }
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

test("pending questionnaire lists use the same public identity as the durable sidebar", async () => {
  const { database, owners, native, parent, turn } = await setup();
  try {
    const [item] = await admitProviderThreadItems(owners, native, [{
      type: "dynamicToolCall", id: "native-question", namespace: null, tool: "request_user_input",
      arguments: {}, status: "inProgress", contentItems: null, success: null, durationMs: null,
    }]);
    const pending = {
      threadId: native.nativeThreadId, turnId: native.nativeTurnId, itemId: "native-question",
      requestKey: "opaque-request-key",
      request: { id: "request", title: "Choose", summary: "", submitLabel: "", questions: [] },
    };
    const response = await mapNativeProviderResponse(owners, "codex", { method: "questionnaire/list" }, {
      id: 1, result: { data: [pending, { ...pending, turnId: null, itemId: null }] },
    });
    const result = response.result as { data: Array<Omit<typeof pending, "turnId" | "itemId"> & { turnId: string | null; itemId: string | null }> };
    assert.deepEqual(result.data, [
      { ...pending, threadId: parent.threadId, turnId: turn.turnId, itemId: item!.id },
      { ...pending, threadId: parent.threadId, turnId: null, itemId: null },
    ]);
  } finally { owners.items.dispose(); owners.threads.dispose(); database.close(); }
});

test("public request routing resolves thread and turn aliases without touching input or prefix context", async () => {
  const fixture = await setup();
  try {
    const { owners, native, parent, turn, child } = fixture;
    const input = [{ type: "text", text: parent.threadId, text_elements: [] }];
    const request = {
      id: "caller-correlation", method: "turn/steer",
      params: { threadId: parent.threadId, expectedTurnId: turn.turnId, input },
      workbenchPromptContext: { threadId: parent.threadId, prefix: "leave these instructions alone" },
    };
    const routed = await mapWorkbenchProviderRequest(owners.threads, "codex", request);
    assert.deepEqual(routed, { harness: "codex", request: {
      ...request, params: { ...request.params, threadId: native.nativeThreadId, expectedTurnId: native.nativeTurnId },
    } });
    assert.equal(routed.request.params && (routed.request.params as { input: typeof input }).input, input);
    assert.equal(request.params.threadId, parent.threadId);
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...request, params: { ...request.params, threadId: native.nativeThreadId, expectedTurnId: native.nativeTurnId },
    }), routed);
    await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...request, params: { ...request.params, threadId: child.threadId },
    }), /turn.*thread/iu);
    await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...request, params: { ...request.params, threadId: "unobserved" },
    }), /thread.*not.*observed/iu);
    const initialise = { id: 1, method: "initialize", params: { clientInfo: { name: "test" } } };
    assert.equal((await mapWorkbenchProviderRequest(owners.threads, "codex", initialise)).request, initialise);
    const admission = {
      id: 2, method: "workbench/codex/message/admit",
      params: { threadId: parent.threadId,
        resumeRequest: { method: "thread/resume", params: { threadId: parent.threadId, baseInstructions: "keep the prefix" } },
        startRequest: { method: "turn/start", params: { threadId: parent.threadId, input } },
        steerRequest: request,
      },
    };
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", admission), {
      harness: "codex", request: { ...admission, params: {
        threadId: native.nativeThreadId,
        resumeRequest: { method: "thread/resume", params: { threadId: native.nativeThreadId, baseInstructions: "keep the prefix" } },
        startRequest: { method: "turn/start", params: { threadId: native.nativeThreadId, input } },
        steerRequest: routed.request,
      } },
    });
    await assert.rejects(mapWorkbenchProviderRequest(owners.threads, "codex", {
      ...admission, params: { ...admission.params, startRequest: {
        ...admission.params.startRequest, params: { threadId: child.threadId, input },
      } },
    }), /admission.*thread/iu);
    const page = { id: 3, method: "workbench/thread/page/read", params: { threadId: parent.threadId, cursor: turn.turnId } };
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", page), {
      harness: "codex", request: { ...page, params: { threadId: native.nativeThreadId, cursor: native.nativeTurnId } },
    });
    const nativePage = { ...page, method: "thread/turns/list", params: { ...page.params, cursor: "opaque-provider-cursor" } };
    assert.deepEqual(await mapWorkbenchProviderRequest(owners.threads, "codex", nativePage), {
      harness: "codex", request: { ...nativePage, params: { threadId: native.nativeThreadId, cursor: "opaque-provider-cursor" } },
    });
  } finally {
    fixture.owners.items.dispose();
    fixture.owners.threads.dispose();
    fixture.database.close();
  }
});
