/* Exports: none. Tests protect semantic dispatch, parameter errors, and replaceable Browse ownership. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController.ts";
import { applyComposerProfileMutation, normalizeComposerProfileMutation } from "workbench-shared/workbench/state/composer-profile-state";
import type { WorkbenchComposerProfile, WorkbenchModelOption } from "workbench-shared/types";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema.ts";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository.ts";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { WorkbenchAccountLimitsSchema } from "workbench-shared/workbench/provider/provider-account";
import { NativeThreadIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController.ts";
import WorkbenchThreadStateStore from "./WorkbenchThreadStateStore.ts";
import WorkbenchThreadStateRelationalRepository from "./database/thread-state/WorkbenchThreadStateRelationalRepository.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

test("installation request registrations survive rollback and never revive retired generations", async () => {
  const { controller } = createController();
  const calls: string[] = [];
  const port = (generation: string) => ({
    pull: async () => { calls.push(generation); return { fromSha: "a".repeat(40), toSha: "b".repeat(40), lockfileChanged: false }; },
    dismissFailure: async () => { calls.push(generation); return { ok: true as const }; },
  });
  const pull = () => controller.handle({ id: 1, method: "installation/update/pull", params: {} });
  const unregisterOld = controller.registerInstallationUpdate(port("old"));
  const unregisterFailed = controller.registerInstallationUpdate(port("failed"));
  assert.ok((await pull()).result);
  unregisterFailed();
  assert.ok((await pull()).result, "rollback restores the old live request owner");
  const unregisterNew = controller.registerInstallationUpdate(port("new"));
  unregisterOld();
  assert.ok((await controller.handle({ id: 2, method: "installation/update/failure/dismiss", params: {} })).result);
  unregisterNew();
  assert.ok((await pull()).error, "retired owners must not revive when the replacement retires");
  assert.deepEqual(calls, ["failed", "old", "new"]);
});

test("discovery settings RPC admits bounded lists and rejects malformed replacements", async () => {
  const { controller } = createController();
  assert.deepEqual((await controller.handle({
    id: 1, method: "project/discovery-settings/read", params: {},
  })).result, { paths: [] });
  assert.deepEqual((await controller.handle({
    id: 2, method: "project/discovery-settings/update", params: { paths: ["C:/one", "D:/two"] },
  })).result, { accepted: true, paths: ["C:/one", "D:/two"] });
  assert.ok((await controller.handle({
    id: 3, method: "project/discovery-settings/update", params: { paths: [42] },
  })).error);
});

test("modern locations read does not change the legacy project catalogue response", async () => {
  const { controller } = createController();
  assert.deepEqual((await controller.handle({
    id: 1, method: "project/catalog/read", params: {},
  })).result, { data: [], rootPath: "" });
  assert.deepEqual((await controller.handle({
    id: 2, method: "project/locations/read", params: {},
  })).result, { data: [] });
});

test("command approval settings resolve canonical project ownership before listing or removal", async () => {
  const calls: Array<{ projectId: string; id?: string; workdir?: string; add?: readonly string[] }> = [];
  const canonicalProjectId = "a6652caf-f7c1-4a2a-ab55-6b387a19ab05";
  const id = "6ec53578-a9ef-44df-8f4b-bb62f2d8ae4a";
  const { controller } = createController({
    canonicalProjectId, rejectProjectId: "missing",
    commandApprovals: {
      list: async projectId => { calls.push({ projectId }); return []; },
      remove: async (projectId, id) => { calls.push({ projectId, id }); },
      patch: async (projectId, workdir, add) => {
        calls.push({ projectId, workdir, add });
        return [];
      },
    },
  });
  assert.deepEqual((await controller.handle({ id: 1, method: "command-approvals/read", params: { projectId: "alias" } })).result, { rules: [] });
  assert.deepEqual((await controller.handle({ id: 2, method: "command-approvals/remove", params: { projectId: "alias", id } })).result, { rules: [] });
  assert.deepEqual(calls, [{ projectId: canonicalProjectId }, { projectId: canonicalProjectId, id }, { projectId: canonicalProjectId }]);
  assert.ok((await controller.handle({ id: 3, method: "command-approvals/remove", params: { projectId: "alias", id: "invalid" } })).error);
  assert.ok((await controller.handle({ id: 4, method: "command-approvals/remove", params: { projectId: "missing", id } })).error);
  assert.equal(calls.length, 3);
  assert.deepEqual((await controller.handle({ id: 5, method: "command-approvals/patch", params: {
    projectId: "alias", workdir: "C:/repo", add: ["git status"], removeIds: [],
  } })).result, { rules: [] });
  assert.deepEqual(calls.slice(3), [
    { projectId: canonicalProjectId, workdir: "C:/repo", add: ["git status"] },
  ]);
  assert.ok((await controller.handle({ id: 6, method: "command-approvals/patch", params: {
    projectId: "alias", workdir: "C:/repo", add: ["git status"], removeIds: ["not-a-rule"],
  } })).error);
});

test("context capability bounds reject invalid target mutations without writing", async () => {
  const unused = async (): Promise<never> => { throw new Error("Profile validation must only read model context."); };
  const { controller, targetWrites } = createController({
    providers: { get: () => ({
      threads: { reconcile: unused, readLatest: unused, messageAgent: unused, history: { materialize: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused },
      configuration: { models: { read: unused }, guidance: { contains: unused }, modelContext: {
      read: async () => [{ model: "model", defaultTokens: 128000, maximumTokens: 1000000 }],
    } } }) },
  });
  const settings = { agentPath: null, agentSource: null, harness: "codex", model: "model", reasoningEffort: null, serviceTier: null };
  for (const contextWindowTokens of [127000, 1001000, 128500]) {
    const response = await controller.handle({ id: 1, method: "profiles/target/set", params: {
      slot: { kind: "new-thread", projectId: "project" }, selection: { kind: "custom", settings: { ...settings, contextWindowTokens } },
    } });
    assert.equal(response.error?.code, -32602);
  }
  assert.equal(targetWrites.length, 0);
  const response = await controller.handle({ id: 2, method: "profiles/target/set", params: {
    slot: { kind: "new-thread", projectId: "project" }, selection: { kind: "custom", settings: { ...settings, contextWindowTokens: 600000 } },
  } });
  assert.equal(response.error, undefined);
  assert.equal(targetWrites.length, 1);
  assert.deepEqual((await controller.handle({ id: 3, method: "models/context/read", params: { provider: "codex" } })).result, {
    data: [{ model: "model", defaultTokens: 128000, maximumTokens: 1000000 }],
  });
});

function createController(options: {
  autoCompact?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["autoCompact"];
  workingTree?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["workingTree"];
  gitArcResponse?: Response;
  rejectProjectId?: string;
  canonicalProjectId?: string;
  profiles?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["profiles"];
  providers?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["providers"];
  threadIdentity?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["threadIdentity"];
  profileTargets?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["profileTargets"];
  questionnaireResponses?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["questionnaireResponses"];
  commandApprovals?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["commandApprovals"];
  projectSnapshot?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["projectSnapshot"];
  modelUsage?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["modelUsage"];
  models?: WorkbenchModelOption[];
} = {}) {
  let globalNetworkEnabled = false;
  const projectNetworkOverrides = new Map<string, boolean>();
  const networkWrites: object[] = [];
  const fileWrites: object[] = [];
  const gitArcRequests: object[] = [];
  const targetReads: object[] = [];
  const targetWrites: object[] = [];
  const searchRequests: object[] = [];
  const observedLimits: Array<{ harness: string; limitId: string | null }> = [];
  let statsRefreshes = 0;
  let autoCompactRefreshes = 0;
  const unused = async (): Promise<never> => { throw new Error("Unexpected provider operation."); };
  const readNetwork = async (projectId: string | null) => {
    const projectOverride = projectId ? projectNetworkOverrides.get(projectId) ?? null : null;
    return {
      label: "Sandbox network access", effectiveEnabled: projectOverride ?? globalNetworkEnabled,
      globalEnabled: globalNetworkEnabled, projectId, projectOverride,
    };
  };
  const controller = new WorkbenchDaemonRequestController({
    autoCompact: options.autoCompact ?? {
      refreshObserved: async () => { autoCompactRefreshes += 1; },
    },
    workingTree: options.workingTree,
    commandApprovals: options.commandApprovals,
    modelUsage: options.modelUsage ?? { read: async () => [] },
    providers: options.providers ?? { get: () => ({
      threads: { reconcile: unused, readLatest: unused, messageAgent: unused, history: { materialize: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused },
      configuration: {
        modelContext: { read: unused }, models: { read: async () => options.models ?? [] }, guidance: { contains: unused },
        sandboxNetwork: {
          read: readNetwork,
          update: async ({ enabled, projectId, scope }) => {
            if (scope === "global") {
              assert.notEqual(enabled, null);
              networkWrites.push({ enabled, scope });
              globalNetworkEnabled = enabled!;
            } else {
              networkWrites.push({ enabled, projectId, scope });
              if (enabled === null) projectNetworkOverrides.delete(projectId);
              else projectNetworkOverrides.set(projectId, enabled);
            }
            return readNetwork(projectId ?? null);
          },
        },
      },
    }) },
    threadIdentity: options.threadIdentity ?? { resolve: async () => null },
    agents: {
      listAgents: async () => ({ data: [] }),
      readAgent: async () => ({ providerGlobalDuplicate: false, data: { description: "", name: "", path: "", prompt: "" } }),
      readSkills: async () => ({ data: [], instructionPacks: [], instructions: "" }),
    },
    files: {
      read: async ({ path, projectId }) => ({ content: "", headContent: null, mtimeMs: 1, path, projectId: projectId == null ? undefined : ProjectIdSchema.parse(projectId), updatedAt: "" }),
      write: async (request) => {
        fileWrites.push(request);
        return { changes: {}, mtimeMs: 2, path: request.path, projectId: request.projectId == null ? undefined : ProjectIdSchema.parse(request.projectId), updatedAt: "" };
      },
    },
    gitArc: {
      executeRequest: async (request) => {
        gitArcRequests.push(request);
        return options.gitArcResponse ?? Response.json({ ok: true });
      },
    },
    nativeFiles: {
      linkRoots: async () => ({ roots: [] }),
      open: async (request) => ({ ok: true, path: request.path, projectId: request.projectId == null ? null : ProjectIdSchema.parse(request.projectId), target: request.path }),
      reveal: async (request) => ({ ok: true, path: request.path, projectId: request.projectId == null ? undefined : ProjectIdSchema.parse(request.projectId) }),
    },
    profiles: options.profiles ?? {
      mutate: async () => ({ profiles: [] }),
      read: async () => ({ profiles: [] }),
    },
    questionnaireResponses: options.questionnaireResponses ?? {
      respond: async () => ({ ok: true, route: "provider" }),
    },
    profileTargets: options.profileTargets ?? {
      readComposerProfileTarget: async (slot) => {
        targetReads.push(slot);
        return null;
      },
      setComposerProfileTarget: async (slot, selection) => {
        targetWrites.push({ selection, slot });
        return true;
      },
    },
    projects: {
      readCatalog: async () => ({ data: [], rootPath: "" }),
      readLocations: async () => ({ data: [] }),
      readDiscoverySettings: async () => ({ paths: [] }),
      updateDiscoverySettings: async paths => ({ accepted: true, paths: [...paths] }),
      resolveProjectById: async (projectId) => {
        if (projectId === options.rejectProjectId) throw new Error("Unknown project.");
        return { id: projectId == null ? undefined : ProjectIdSchema.parse(options.canonicalProjectId ?? projectId), kind: "git", root: "", rootPath: "", roots: [] };
      },
    },
    projectSnapshot: options.projectSnapshot ?? {
      handleRequest: async () => ({ accepted: true }),
      readProjectSnapshot: async projectId => ({
        projectId: ProjectIdSchema.parse(projectId),
        root: "project", rootPath: "C:/project", roots: [],
        tree: [], changes: {}, workbenchStorageRootPath: "C:/project/.workbench",
      }),
    },
    search: {
      search: async (request) => {
        searchRequests.push(request);
        return { results: [] };
      },
    },
    stats: {
      deleteFeedback: async (ids) => ids.length,
      observeAccountLimits: (harness, limits) => { observedLimits.push({ harness, limitId: limits.rateLimits.limitId }); },
      refreshRateLimits: async () => { statsRefreshes += 1; },
      startImport: async () => ({
        claims: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
        percent: 100, recentFailures: [], revision: 0, state: "complete" as const,
        unsupportedClaimCheckpoints: 0,
        usage: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
        version: 2 as const,
      }),
    },
    settings: {
      readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
      updateLocalCapabilities: async (update) => update({ browseRawCommandsEnabled: false }),
      readThreadAutoCompact: async () => ({ enabled: true, tokenThreshold: 200_000, idleMinutes: 30 }),
      updateThreadAutoCompact: async edit => ({ enabled: true, tokenThreshold: 200_000, idleMinutes: 30, ...edit }),
    },
  });
  return {
    controller,
    fileWrites,
    gitArcRequests,
    networkWrites,
    searchRequests,
    observedLimits,
    statsRefreshes: () => statsRefreshes,
    autoCompactRefreshes: () => autoCompactRefreshes,
    targetReads,
    targetWrites,
  };
}

test("model catalogue includes durable accepted use without a second request", async () => {
  const now: number[] = [];
  const { controller } = createController({
    models: [{ id: "opencode-go/model" }, { id: "opencode-go/unused" }] as WorkbenchModelOption[],
    modelUsage: { read: async at => {
      now.push(at);
      return [{ harness: "opencode", modelId: "opencode-go/model", lastUsedAt: at }];
    } },
  });
  const response = await controller.handle({ id: 1, method: "models/list", params: { provider: "opencode" } });
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, { data: [
    { id: "opencode-go/model", lastUsedAt: now[0] },
    { id: "opencode-go/unused", lastUsedAt: null },
  ] });
});

test("model catalogue credits provider-reported alias use to its canonical model", async () => {
  const { controller } = createController({
    models: [
      { id: "claude-sonnet-4-6", aliases: ["sonnet"] },
      { id: "claude-opus-4-6", aliases: [] },
    ] as WorkbenchModelOption[],
    modelUsage: { read: async () => [
      { harness: "claude", modelId: "sonnet", lastUsedAt: 10 },
      { harness: "claude", modelId: "unreported", lastUsedAt: 20 },
    ] },
  });
  const response = await controller.handle({ id: 1, method: "models/list", params: { provider: "claude" } });
  assert.deepEqual(response.result, { data: [
    { id: "claude-sonnet-4-6", aliases: ["sonnet"], lastUsedAt: 10 },
    { id: "claude-opus-4-6", aliases: [], lastUsedAt: null },
  ] });
});

test("model catalogue remains usable if accepted-use storage fails", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const { controller } = createController({
    models: [{ id: "model" }] as WorkbenchModelOption[],
    modelUsage: { read: async () => { throw new Error("private-storage-marker"); } },
  });
  const response = await controller.handle({ id: 1, method: "models/list", params: { provider: "codex" } });
  assert.deepEqual(response.result, { data: [{ id: "model", lastUsedAt: null }] });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0]!.includes("private-storage-marker"));
});

test("questionnaire response dispatch validates and delegates one semantic daemon intent", async () => {
  const submissions: object[] = [];
  const { controller } = createController({
    questionnaireResponses: {
      respond: async input => {
        submissions.push(input);
        return { ok: true, route: "admitted" };
      },
    },
  });
  const response = await controller.handle({
    id: 10,
    method: "questionnaire/respond",
    params: {
      activatedSkillPaths: ["C:/skills/review/SKILL.md"],
      harness: "codex",
      projectId: "project",
      requestKey: "workbench-mcp:question",
      response: { answers: { route: { answers: ["approve"] } } },
      supplementalInput: [{ text: "extra", text_elements: [], type: "text" }],
      threadId: "thread",
      turnId: "turn",
    },
  });
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, { ok: true, route: "admitted" });
  assert.equal(submissions.length, 1);

  const invalid = await controller.handle({
    id: 11,
    method: "questionnaire/respond",
    params: {
      harness: "codex",
      projectId: "project",
      requestKey: "request",
      response: { answers: { route: { answers: [1] } } },
      threadId: "thread",
    },
  });
  assert.equal(invalid.error?.code, -32602);
  assert.equal(submissions.length, 1);
});

test("thread lookup resolves native and WB inputs without publishing native bindings or requiring bodies", async () => {
  const projectId = testProjectIds.project;
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const identities = new WorkbenchThreadIdentityRepository(database);
    const identity = identities.observe({
      native: { harness: "codex", nativeLocation: "private-home", nativeThreadId: NativeThreadIdSchema.parse("native-thread") },
      projectId, projectRoot: "C:/project", title: "Thread",
      createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const { controller, targetReads } = createController({
      threadIdentity: { resolve: async (input) => identities.resolve(input) },
    });
    for (const threadId of ["native-thread", identity.threadId]) {
      assert.deepEqual(await controller.handle({
        id: 1, method: "thread/identity/resolve", params: { threadId, projectId },
      }), {
        id: 1, result: { data: { threadId: identity.threadId, projectId, harness: "codex" } },
      });
      await controller.handle({ id: 4, method: "profiles/target/read", params: {
        slot: { kind: "thread", threadId, projectId, harness: "codex" },
      } });
    }
    assert.deepEqual(targetReads, [0, 1].map(() => ({
      kind: "thread", threadId: identity.threadId, projectId, harness: "codex",
    })));
    const wrongProject = await controller.handle({
      id: 2, method: "thread/identity/resolve", params: { threadId: identity.threadId, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("elsewhere") },
    });
    assert.ok(wrongProject.error);
    assert.deepEqual(await controller.handle({
      id: 3, method: "thread/identity/resolve", params: { threadId: "missing" },
    }), { id: 3, result: { data: null } });
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
  } finally {
    database.close();
  }
});

test("thread lookup forwards whether provider identity admission is allowed", async () => {
  const policies: boolean[] = [];
  const { controller } = createController({
    threadIdentity: {
      resolve: async (_input, options?: { allowProviderAdmission?: boolean }) => {
        policies.push(options?.allowProviderAdmission ?? true);
        return null;
      },
    },
  });

  assert.deepEqual(await controller.handle({
    id: 1,
    method: "thread/identity/resolve",
    params: { threadId: "default-provider-admission" },
  }), { id: 1, result: { data: null } });
  assert.deepEqual(await controller.handle({
    id: 2,
    method: "thread/identity/resolve",
    params: { allowProviderAdmission: false, threadId: "durable-only" },
  }), { id: 2, result: { data: null } });
  assert.deepEqual(policies, [true, false]);
});

test("dispatch validates semantic parameters without corrupting valid empty file content", async () => {
  const { controller, fileWrites } = createController();
  const invalid = await controller.handle({
    id: 1,
    method: "project/file/save",
    params: { content: "", path: "note.md", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
  });
  assert.equal(invalid.error?.code, -32602);
  assert.equal(fileWrites.length, 0);

  const valid = await controller.handle({
    id: 2,
    method: "project/file/save",
    params: { content: "", expectedMtimeMs: 1, path: "note.md", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
  });
  assert.equal(valid.error, undefined);
  assert.deepEqual(fileWrites, [{
    content: "",
    expectedMtimeMs: 1,
    force: false,
    path: "note.md",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    resetToHead: false,
  }]);
});

test("Browse registration swaps atomically and stale disposal cannot remove its replacement", async () => {
  const { controller } = createController();
  assert.match(
    (await controller.handle({ id: 1, method: "browse/sessions/read", params: {} })).error?.message ?? "",
    /reloading/u,
  );

  const removeFirst = controller.registerBrowse({
    controlSession: async () => ({ owner: "first" }),
    listSessions: async () => ({ owner: "first" }),
  });
  const removeSecond = controller.registerBrowse({
    controlSession: async () => ({ owner: "second" }),
    listSessions: async () => ({ owner: "second" }),
  });
  removeFirst();
  assert.deepEqual(
    (await controller.handle({ id: 2, method: "browse/sessions/read", params: {} })).result,
    { owner: "second" },
  );
  removeSecond();
  assert.match(
    (await controller.handle({ id: 3, method: "browse/sessions/read", params: {} })).error?.message ?? "",
    /reloading/u,
  );
});

test("profile RPC preserves field intent and rejects malformed changes instead of erasing them", async () => {
  const original: WorkbenchComposerProfile = {
    id: "saved", name: "Saved", harness: "codex", model: "old",
    agentPath: null, agentSource: null, reasoningEffort: "high", serviceTier: null,
    createdAt: 1, updatedAt: 1, scope: { kind: "global" },
  };
  let profiles = [original];
  const { controller } = createController({
    profiles: {
      read: async () => ({ profiles }),
      mutate: async (value) => {
        const mutation = normalizeComposerProfileMutation(value);
        if (!mutation) throw new Error("Invalid profile mutation");
        profiles = applyComposerProfileMutation(profiles, mutation);
        return { profiles };
      },
    },
  });
  await controller.handle({ id: 1, method: "profiles/upsert", params: { profile: original, changes: { model: "latest" } } });
  await controller.handle({ id: 2, method: "profiles/upsert", params: { profile: original, changes: { reasoningEffort: null } } });
  await controller.handle({ id: 3, method: "profiles/upsert", params: { profile: original, changes: { harness: "opencode" } } });
  assert.equal(profiles[0]?.model, "latest");
  assert.equal(profiles[0]?.reasoningEffort, null);
  assert.equal(profiles[0]?.harness, "opencode");
  for (const changes of [[], null, "invalid", { harness: "" }, { model: "" }]) {
    const response = await controller.handle({ id: 4, method: "profiles/upsert", params: { profile: original, changes } });
    assert.ok(response.error, "Malformed changes must fail, never turn into a full upsert or empty patch.");
  }
  assert.equal(profiles[0]?.model, "latest");
  assert.equal(profiles[0]?.reasoningEffort, null);
});

test("search query dispatch preserves empty text and validates project ids", async () => {
  const { controller, searchRequests } = createController({ rejectProjectId: "missing" });
  assert.deepEqual(
    (await controller.handle({ id: 1, method: "search/query", params: { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "" } })).result,
    { results: [] },
  );
  assert.deepEqual(searchRequests, [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "" }]);

  const invalid = await controller.handle({
    id: 2,
    method: "search/query",
    params: { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("missing"), query: "nope" },
  });
  assert.equal(invalid.error?.code, -32602);
  assert.equal(searchRequests.length, 1);
});

test("stats commands refresh limits while reads arrive only through observations", async () => {
  const { controller, statsRefreshes } = createController();
  assert.deepEqual((await controller.handle({ id: 3, method: "stats/rate-limits/refresh", params: {} })).result, { ok: true });
  assert.equal(statsRefreshes(), 1);
  assert.deepEqual((await controller.handle({ id: 4, method: "stats/feedback/delete", params: { ids: [1, 2] } })).result, { deleted: 2 });
  for (const legacy of ["stats/read", "stats/read/scoped", "stats/read/detailed", "stats/read/efficiency", "stats/read/efficiency/v2"]) {
    assert.equal(controller.accepts(legacy), false);
  }
});

test("account limit reads also record rate-limit history for statistics", async () => {
  const limits = WorkbenchAccountLimitsSchema.parse({
    rateLimits: {
      limitId: "claude", limitName: null, credits: null, planType: null,
      primary: { resetsAt: 1_800_000_000, usedPercent: 25, windowDurationMins: 300 }, secondary: null,
    },
    rateLimitsByLimitId: null,
  });
  const unused = async (): Promise<never> => { throw new Error("Unexpected provider operation"); };
  const { controller, observedLimits } = createController({
    providers: { get: () => ({
      threads: { reconcile: unused, readLatest: unused, messageAgent: unused, history: { materialize: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused },
      configuration: { modelContext: { read: unused }, models: { read: unused }, guidance: { contains: unused } },
      account: { limits: { read: async () => limits } },
    }) },
  });
  const response = await controller.handle({ id: 1, method: "account/limits/read", params: { provider: "claude" } });
  assert.deepEqual(response.result, limits);
  assert.deepEqual(observedLimits, [{ harness: "claude", limitId: "claude" }]);
});

test("sandbox network requests validate project ownership and preserve explicit override intent", async () => {
  const { controller, networkWrites } = createController({ rejectProjectId: "missing" });
  const rejected = await controller.handle({
    id: 1,
    method: "sandbox-network/update",
    params: { provider: "codex", enabled: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("missing"), scope: "project" },
  });
  assert.match(rejected.error?.message ?? "", /Unknown project/u);
  assert.deepEqual(networkWrites, []);

  const withoutProject = await controller.handle({
    id: 5, method: "sandbox-network/update",
    params: { provider: "codex", enabled: true, scope: "global" },
  });
  assert.equal(withoutProject.error, undefined);
  assert.deepEqual(withoutProject.result, { data: [{
    provider: "codex", label: "Sandbox network access",
    effectiveEnabled: true, globalEnabled: true, projectId: null, projectOverride: null,
  }] });
  const globalRead = await controller.handle({
    id: 6, method: "sandbox-network/read", params: {},
  });
  assert.equal(globalRead.error, undefined);
  assert.ok((globalRead.result as { data: { provider: string; projectId: string | null; globalEnabled: boolean }[] })
    .data.some((entry) => entry.provider === "codex" && entry.projectId === null && entry.globalEnabled));

  const global = await controller.handle({
    id: 2,
    method: "sandbox-network/update",
    params: { provider: "codex", enabled: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "global" },
  });
  assert.deepEqual(global.result, {
    data: [{
      provider: "codex", label: "Sandbox network access",
      effectiveEnabled: true,
      globalEnabled: true,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      projectOverride: null,
    }],
  });

  const disabled = await controller.handle({
    id: 3,
    method: "sandbox-network/update",
    params: { provider: "codex", enabled: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
  });
  assert.equal((disabled.result as { data: { effectiveEnabled: boolean }[] }).data[0].effectiveEnabled, false);

  const inherited = await controller.handle({
    id: 4,
    method: "sandbox-network/update",
    params: { provider: "codex", enabled: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
  });
  assert.equal((inherited.result as { data: { effectiveEnabled: boolean }[] }).data[0].effectiveEnabled, true);
  assert.deepEqual(networkWrites, [
    { enabled: true, scope: "global" },
    { enabled: true, scope: "global" },
    { enabled: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
    { enabled: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
  ]);
});

test("project-scoped network and search requests use the resolved owner rather than the supplied alias", async () => {
  const canonicalProjectId = testProjectIds.project;
  const { controller, networkWrites, searchRequests } = createController({ canonicalProjectId });
  const projectId = "old-request";
  const network = await controller.handle({
    id: 1, method: "sandbox-network/update", params: { provider: "codex", projectId, enabled: true, scope: "project" },
  });
  assert.equal(network.error, undefined);
  assert.deepEqual(networkWrites, [{ projectId: canonicalProjectId, enabled: true, scope: "project" }]);
  await controller.handle({ id: 2, method: "search/query", params: { projectId, query: "" } });
  assert.deepEqual(searchRequests, [{ projectId: canonicalProjectId, query: "" }]);
});

test("file-index reads stay qualified to the requested project without changing observation", async () => {
  const reads: string[] = [];
  const { controller } = createController({
    projectSnapshot: {
      handleRequest: async () => ({ accepted: true }),
      readProjectSnapshot: async projectId => {
        reads.push(projectId);
        return {
          projectId: ProjectIdSchema.parse(projectId),
          root: projectId, rootPath: `C:/${projectId}`, roots: [],
          tree: [{ type: "file", name: `${projectId}.ts`, path: `src/${projectId}.ts` }],
          changes: {}, workbenchStorageRootPath: `C:/${projectId}/.workbench`,
        };
      },
    },
  });
  const first = await controller.handle({
    id: 1, method: "project/file-index/read", params: { projectId: "first" },
  });
  const second = await controller.handle({
    id: 2, method: "project/file-index/read", params: { projectId: "second" },
  });
  assert.deepEqual(reads, ["first", "second"]);
  assert.deepEqual((first.result as { candidates: { path: string }[] }).candidates.map(item => item.path), ["src/first.ts"]);
  assert.deepEqual((second.result as { candidates: { path: string }[] }).candidates.map(item => item.path), ["src/second.ts"]);
  assert.equal((await controller.handle({
    id: 3, method: "project/file-index/read", params: {},
  })).error?.code, -32602);
});

for (const harness of ["codex", "copilot", "opencode"] as const) {
  test(`${harness} thread profile dispatch persists and reopens the canonical owner`, async () => {
    const sqlite = new Database(":memory:");
    installWorkbenchDatabaseSchema(sqlite);
    const identities = new WorkbenchThreadIdentityRepository(sqlite);
    const projectId = testProjectIds.otherProject;
    const nativeThreadId = NativeThreadIdSchema.parse("a116df94-9125-43c6-ae1f-898fbd140cd0");
    const admitted = identities.observe({
      native: { harness, nativeLocation: "C:/profile-project", nativeThreadId },
      projectId, projectRoot: "C:/profile-project", title: "Profile owner",
      createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    assert.notEqual(String(admitted.threadId), String(nativeThreadId));
    const repository = new WorkbenchThreadStateRelationalRepository(sqlite, identities);
    const persistence = new WorkbenchThreadStateStore({
      commitThreadState: async changes => { repository.commit(changes); },
      readThreadStateProject: async id => repository.readProject(id),
      readThreadStateNavigationSummary: async id => repository.readNavigationSummary(id),
      readThreadStateTitleHistories: async id => repository.readTitleHistories(id),
      writeThreadStateProject: async (id, document, histories) => { repository.writeProject(id, document, histories); },
      readThreadStateGlobal: async id => repository.readGlobal(id),
      writeThreadStateGlobal: async document => { repository.writeGlobal(document); },
      readThreadStateArchiveDeadline: async () => repository.readNextArchiveEligibility(),
      readThreadStateArchiveEligible: async before => repository.readArchiveEligible(before),
    });
    const settings = {
      harness, model: "selected-model", agentPath: null, agentSource: null,
      reasoningEffort: null, serviceTier: null,
    };
    const selection = { kind: "profile", profileId: "selected-profile", settings } as const;
    const states: WorkbenchThreadStateController[] = [];
    const createState = () => {
      const state = new WorkbenchThreadStateController({
        resolveProjectId: id => id,
        threadStateStore: persistence,
        getProjectCatalog: () => ({ data: [], rootPath: "C:/" }),
        readComposerProfiles: async () => ({ profiles: [{
          ...settings, id: selection.profileId, name: "Selected profile",
          scope: { kind: "global" }, createdAt: 1, updatedAt: 1,
        }] }),
        hasGitArcBlockingSettlement: async () => false,
        reconcileProject: async () => [],
        resolveGitArc: async () => null,
        resolveGitArcPlan: async () => null,
        runGitArcReadTransition: async (_id, operation) => operation(),
      });
      states.push(state);
      return state;
    };
    try {
      const state = createState();
      await state.ensureProviderEntry(projectId, {
        entryKind: "thread", identity: { harness, threadId: admitted.threadId },
        activityAt: 1, orderAt: 1, title: "Profile owner",
        lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
        metadata: { archived: false, pinned: false, snoozed: false },
      });
      const slot = { kind: "thread", harness, projectId, threadId: admitted.threadId } as const;
      const { controller } = createController({
        threadIdentity: { resolve: async input => identities.resolve(input) },
        profileTargets: state,
      });
      const written = await controller.handle({
        id: 1, method: "profiles/target/set", params: { slot, selection },
      });
      assert.equal(written.error, undefined, written.error?.message);
      assert.deepEqual(written.result, { ok: true });
      assert.deepEqual((await controller.handle({
        id: 2, method: "profiles/target/read", params: { slot },
      })).result, { selection });
      const rejected = await controller.handle({
        id: 3, method: "profiles/target/set",
        params: { slot: { ...slot, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("different-project") }, selection },
      });
      assert.ok(rejected.error);
      await state.dispose();
      const reopened = createState();
      assert.deepEqual(await reopened.readComposerProfileTarget(slot), selection);
      assert.equal(repository.readProject(projectId).records[0]?.identity.threadId, admitted.threadId);
      assert.equal(identities.list().length, 1);
    } finally {
      await Promise.all(states.map(state => state.dispose()));
      sqlite.close();
    }
  });
}

test("auto-compact settings dispatch accepts daemon-wide field edits and rejects invalid increments", async () => {
  const { controller, autoCompactRefreshes } = createController();
  assert.deepEqual((await controller.handle({ id: 1, method: "thread-auto-compact/read", params: {} })).result,
    { settings: { enabled: true, tokenThreshold: 200_000, idleMinutes: 30 } });
  assert.deepEqual((await controller.handle({ id: 2, method: "thread-auto-compact/update", params: {
    settings: { enabled: false, idleMinutes: 40 },
  } })).result, { settings: { enabled: false, tokenThreshold: 200_000, idleMinutes: 40 } });
  assert.equal(autoCompactRefreshes(), 1);
  const rejected = await controller.handle({ id: 3, method: "thread-auto-compact/update", params: {
    settings: { tokenThreshold: 200_001 },
  } });
  assert.equal(rejected.error?.code, -32602);
  assert.equal(autoCompactRefreshes(), 1);
});

test("profile target dispatch preserves exact slot and settings contracts", async () => {
  const { controller, targetReads, targetWrites } = createController();
  const slot = { draftId: fixtureIdentitySchemas.DraftIdSchema.parse("draft"), harness: "codex", kind: "draft", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
  const selection = {
    kind: "profile",
    profileId: "profile",
    settings: {
      agentPath: "library:agents/lily.md",
      agentSource: "library",
      harness: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "fast",
    },
  };

  assert.deepEqual(
    (await controller.handle({ id: 1, method: "profiles/target/read", params: { slot } })).result,
    { selection: null },
  );
  assert.deepEqual(
    (await controller.handle({ id: 2, method: "profiles/target/set", params: { selection, slot } })).result,
    { ok: true },
  );
  assert.deepEqual(targetReads, [slot]);
  assert.deepEqual(targetWrites, [{ selection, slot }]);
  assert.equal(
    (await controller.handle({
      id: 3,
      method: "profiles/target/set",
      params: { selection: { kind: "custom", settings: {} }, slot },
    })).error?.code,
    -32602,
  );
});

test("Browse control action comes from the semantic method", async () => {
  const { controller } = createController();
  const controls: object[] = [];
  controller.registerBrowse({
    controlSession: async (params) => {
      controls.push(params);
      return { ok: true };
    },
    listSessions: async () => ({ sessions: [] }),
  });

  await controller.handle({ id: 1, method: "browse/sessions/stop", params: { session: "one" } });
  await controller.handle({ id: 2, method: "browse/sessions/forget", params: { session: "two" } });
  assert.deepEqual(controls, [
    { action: "stop", session: "one" },
    { action: "forget", session: "two" },
  ]);
});

test("Git arc dispatch returns domain data and preserves structured failure data", async () => {
  const comparison = {
    changes: [],
    checkpointCommit: "a".repeat(40),
    checkpointRef: "refs/workbench/arc",
    intentName: "typed Git request",
    repoRoot: "C:/git/web/workbench",
    scopePaths: ["webapp"],
  };
  const success = createController({ gitArcResponse: Response.json(comparison) }).controller;
  assert.deepEqual(
    (await success.handle({ id: 1, method: "git/arc/compare", params: {} })).result,
    comparison,
  );

  const gitArcFailure = {
    action: "compare",
    code: "operationRejected",
    message: "Comparison was rejected.",
    version: 1,
  };
  const rejected = createController({
    gitArcResponse: Response.json(
      { error: "Comparison was rejected.", gitArcFailure },
      { status: 409 },
    ),
  }).controller;
  assert.deepEqual(
    (await rejected.handle({ id: 2, method: "git/arc/compare", params: {} })).error?.data,
    { gitArcFailure },
  );

  const release = createController();
  assert.deepEqual(
    (await release.controller.handle({
      id: 3,
      method: "git/arc/release",
      params: { cwd: "C:/git/web/workbench", disown: true, harness: "codex", threadId: "thread" },
    })).result,
    { ok: true },
  );
  assert.deepEqual(release.gitArcRequests, [{
    action: "arcRelease",
    cwd: "C:/git/web/workbench",
    disown: true,
    harness: "codex",
    threadId: "thread",
  }]);

  const unstashResult = { conflictedPaths: ["src/conflict.ts"], phase: "active", stashedPaths: [] };
  const unstash = createController({ gitArcResponse: Response.json({
    ...unstashResult,
    checkpointCommit: "a".repeat(40),
    scopePaths: ["src/conflict.ts"],
  }) });
  assert.deepEqual((await unstash.controller.handle({
    id: 4,
    method: "git/arc/unstash",
    params: { cwd: "C:/git/web/workbench", harness: "codex", threadId: "thread" },
  })).result, unstashResult);
  assert.deepEqual(unstash.gitArcRequests, [{
    action: "arcUnstash",
    cwd: "C:/git/web/workbench",
    harness: "codex",
    threadId: "thread",
  }]);

  const discard = createController();
  assert.deepEqual((await discard.controller.handle({
    id: 5,
    method: "git/arc/stash/discard",
    params: { cwd: "C:/git/web/workbench", harness: "codex", threadId: "thread" },
  })).result, { ok: true });
  assert.deepEqual(discard.gitArcRequests, [{
    action: "arcDiscardStash",
    cwd: "C:/git/web/workbench",
    harness: "codex",
    threadId: "thread",
  }]);
});
