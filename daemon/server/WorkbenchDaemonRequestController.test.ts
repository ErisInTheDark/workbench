/*
 * Exports:
 * - No production exports; tests protect semantic dispatch, parameter errors, and replaceable Browse ownership.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController.ts";
import { applyComposerProfileMutation, normalizeComposerProfileMutation } from "workbench-shared/workbench/state/composer-profile-state";
import type { WorkbenchComposerProfile } from "workbench-shared/types";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema.ts";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository.ts";
import { WorkbenchStatsResponseSchema } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { NativeThreadIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController.ts";
import WorkbenchThreadStateStore from "./WorkbenchThreadStateStore.ts";
import WorkbenchThreadStateRelationalRepository from "./database/thread-state/WorkbenchThreadStateRelationalRepository.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

test("context capability bounds reject invalid target mutations without writing", async () => {
  const unused = async (): Promise<never> => { throw new Error("Profile validation must only read model context."); };
  const { controller, targetWrites } = createController({
    providers: { get: () => ({
      threads: { history: { questionnaires: unused, steers: unused, browse: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, page: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, materialize: unused },
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
  assert.deepEqual((await controller.handle({ id: 3, method: "models/context/read", params: {} })).result, {
    data: [{ model: "model", defaultTokens: 128000, maximumTokens: 1000000 }],
  });
});

function createController(options: {
  gitArcResponse?: Response;
  rejectProjectId?: string;
  canonicalProjectId?: string;
  profiles?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["profiles"];
  providers?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["providers"];
  threadIdentity?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["threadIdentity"];
  profileTargets?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["profileTargets"];
  readDetailed?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["stats"]["readDetailed"];
  questionnaireResponses?: ConstructorParameters<typeof WorkbenchDaemonRequestController>[0]["questionnaireResponses"];
} = {}) {
  let globalNetworkEnabled = false;
  const projectNetworkOverrides = new Map<string, boolean>();
  const networkWrites: object[] = [];
  const fileWrites: object[] = [];
  const gitArcRequests: object[] = [];
  const targetReads: object[] = [];
  const targetWrites: object[] = [];
  const searchRequests: object[] = [];
  const statsRequests: object[] = [];
  let statsRefreshes = 0;
  const controller = new WorkbenchDaemonRequestController({
    providers: options.providers,
    threadIdentity: options.threadIdentity ?? { resolve: async () => null },
    agents: {
      listAgents: async () => ({ data: [] }),
      readAgent: async () => ({ codexGlobalDuplicate: false, data: { description: "", name: "", path: "", prompt: "" } }),
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
    codexSandboxNetwork: {
      read: async (projectId) => {
        const projectOverride = projectNetworkOverrides.get(projectId) ?? null;
        return {
          effectiveEnabled: projectOverride ?? globalNetworkEnabled,
          globalEnabled: globalNetworkEnabled,
          projectId,
          projectOverride,
        };
      },
      setGlobal: async (enabled) => {
        networkWrites.push({ enabled, scope: "global" });
        globalNetworkEnabled = enabled;
      },
      setProjectOverride: async (projectId, enabled) => {
        networkWrites.push({ enabled, projectId, scope: "project" });
        if (enabled === null) projectNetworkOverrides.delete(projectId);
        else projectNetworkOverrides.set(projectId, enabled);
      },
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
      resolveProjectById: async (projectId) => {
        if (projectId === options.rejectProjectId) throw new Error("Unknown project.");
        return { id: projectId == null ? undefined : ProjectIdSchema.parse(options.canonicalProjectId ?? projectId), kind: "git", root: "", rootPath: "", roots: [] };
      },
    },
    search: {
      search: async (request) => {
        searchRequests.push(request);
        return { results: [] };
      },
    },
    stats: {
      readDetailed: async (request) => {
        statsRequests.push(request);
        if (options.readDetailed) return options.readDetailed(request);
        throw new Error("Detailed database read failed");
      },
      read: async (request) => {
        statsRequests.push(request);
        return ({
          bucketUnit: "day",
          claimHotspots: [],
          cost: {
            basis: {
              defaultModelTokens: 0,
              exactModelTokens: 0,
              projectInferredModelTokens: 0,
              threadInferredModelTokens: 0,
            },
            buckets: [],
            totalUsd: 0,
          },
          failures: [],
          generatedAt: 1,
          historyImport: {
            claims: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
            percent: 100, recentFailures: [], revision: 0, state: "idle",
            unsupportedClaimCheckpoints: 0,
            usage: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
            version: 2,
          },
          models: [],
          pricingCatalogDate: "2026-09-05",
          projectId: request.projectId ?? null,
          rateLimits: [],
          range: request.range,
          startedAt: 0,
          summary: { cacheHitPercent: 0, threadCount: 0, turnCount: 0 },
          tokens: {
            buckets: [],
            totals: { all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 },
          },
          topThreads: [],
          usageFilters: { models: [], providers: [] },
          version: 2,
        });
      },
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
    },
  });
  return {
    controller,
    fileWrites,
    gitArcRequests,
    networkWrites,
    searchRequests,
    statsRequests,
    statsRefreshes: () => statsRefreshes,
    targetReads,
    targetWrites,
  };
}

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
  const projectId = ProjectIdSchema.parse("local:///project");
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
  assert.equal(profiles[0]?.model, "latest");
  assert.equal(profiles[0]?.reasoningEffort, null);
  for (const changes of [[], null, "invalid", { harness: "copilot" }, { model: "" }]) {
    const response = await controller.handle({ id: 3, method: "profiles/upsert", params: { profile: original, changes } });
    assert.ok(response.error, "Malformed changes must fail, never turn into a full upsert or empty patch.");
  }
  assert.equal(profiles[0]?.model, "latest");
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

test("stats dispatch validates project scope and keeps rate refresh account-wide", async () => {
  const { controller, statsRefreshes, statsRequests } = createController({ rejectProjectId: "missing" });
  const global = await controller.handle({
    id: 1,
    method: "stats/read",
    params: { projectId: null, range: "7d" },
  });
  assert.equal((global.result as { projectId: string | null }).projectId, null);
  const project = await controller.handle({
    id: 2,
    method: "stats/read",
    params: { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "30d" },
  });
  assert.equal((project.result as { projectId: string | null }).projectId, "project");
  const rejected = await controller.handle({
    id: 3,
    method: "stats/read",
    params: { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("missing"), range: "7d" },
  });
  assert.equal(rejected.error?.code, -32602);
  assert.deepEqual(statsRequests, [
    { model: null, projectId: null, provider: null, range: "7d" },
    { model: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), provider: null, range: "30d" },
  ]);
  assert.deepEqual(
    (await controller.handle({ id: 4, method: "stats/rate-limits/refresh", params: {} })).result,
    { ok: true },
  );
  assert.equal(statsRefreshes(), 1);
});

test("detailed stats validate selection and project before invoking the owner, preserving read failures", async () => {
  for (const method of ["stats/read/detailed", "stats/read/efficiency", "stats/read/efficiency/v2"]) {
    const { controller, statsRequests } = createController({ rejectProjectId: "missing" });
    for (const params of [
      { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("missing"), range: "7d", tokenTypes: ["output"] },
      { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d", tokenTypes: ["all"] },
    ]) {
      const response = await controller.handle({ id: 1, method, params });
      assert.equal(response.error?.code, -32602);
    }
    assert.deepEqual(statsRequests, []);
    const response = await controller.handle({
      id: 2, method,
      params: { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "90d", tokenTypes: [] },
    });
    assert.ok(response.error);
    assert.deepEqual(statsRequests, [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "90d", tokenTypes: [], model: null, provider: null }]);
  }
});

test("cache efficiency uses the detailed owner while older routes keep their exact wire shapes", async () => {
  const legacy = WorkbenchStatsResponseSchema.parse({
    bucketUnit: "day", claimHotspots: [], cost: { buckets: [], pricedTokens: 0, totalUsd: 0, unpricedTokens: 0 },
    failures: [], generatedAt: 1, pricingCatalogDate: "2026-09-05", projectId: null, rateLimits: [],
    range: "7d", recordingStartedAt: null, startedAt: 0,
    tokens: { buckets: [], totals: { all: 0, cachedInput: 0, input: 0, output: 0 } },
  });
  const detailed = { ...legacy, cost: { ...legacy.cost, buckets: [], byTokenType: { input: 0, cache: 0, output: 0 } } };
  const enriched = { ...detailed, cacheEfficiency: {
    totals: { inputTokens: 1_000, cachedInputTokens: 940, cacheHitPercent: 94 }, buckets: [],
    worstThreads: [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId: "thread", title: "Thread",
      inputTokens: 1_000, cachedInputTokens: 940, cacheHitPercent: 94 }],
  } };
  const current = { ...enriched, cacheEfficiency: { ...enriched.cacheEfficiency,
    worstThreads: enriched.cacheEfficiency.worstThreads.map((thread) => ({ ...thread, cacheWriteInputTokens: 10 })),
  } };
  const { controller, statsRequests } = createController({ readDetailed: async () => current });
  const params = { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), provider: "codex", model: "gpt-5.4", range: "7d", tokenTypes: ["output"] };
  assert.equal(controller.accepts("stats/read/efficiency"), true);
  assert.deepEqual((await controller.handle({ id: 1, method: "stats/read/efficiency", params })).result, enriched);
  assert.deepEqual((await controller.handle({ id: 2, method: "stats/read/detailed", params })).result, detailed);
  assert.equal(controller.accepts("stats/read/efficiency/v2"), true);
  assert.deepEqual((await controller.handle({ id: 3, method: "stats/read/efficiency/v2", params })).result, current);
  assert.deepEqual(statsRequests, [params, params, params]);
});

test("Codex sandbox network requests validate project ownership and preserve explicit override intent", async () => {
  const { controller, networkWrites } = createController({ rejectProjectId: "missing" });
  const rejected = await controller.handle({
    id: 1,
    method: "codex-sandbox-network/update",
    params: { enabled: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("missing"), scope: "project" },
  });
  assert.match(rejected.error?.message ?? "", /Unknown project/u);
  assert.deepEqual(networkWrites, []);

  const global = await controller.handle({
    id: 2,
    method: "codex-sandbox-network/update",
    params: { enabled: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "global" },
  });
  assert.deepEqual(global.result, {
    codexSandboxNetwork: {
      effectiveEnabled: true,
      globalEnabled: true,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      projectOverride: null,
    },
  });

  const disabled = await controller.handle({
    id: 3,
    method: "codex-sandbox-network/update",
    params: { enabled: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
  });
  assert.equal((disabled.result as { codexSandboxNetwork: { effectiveEnabled: boolean } }).codexSandboxNetwork.effectiveEnabled, false);

  const inherited = await controller.handle({
    id: 4,
    method: "codex-sandbox-network/update",
    params: { enabled: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
  });
  assert.equal((inherited.result as { codexSandboxNetwork: { effectiveEnabled: boolean } }).codexSandboxNetwork.effectiveEnabled, true);
  assert.deepEqual(networkWrites, [
    { enabled: true, scope: "global" },
    { enabled: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
    { enabled: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), scope: "project" },
  ]);
});

test("project-scoped network, search, and stats requests use the resolved owner rather than the supplied alias", async () => {
  const canonicalProjectId = "remote://example.test/request";
  const { controller, networkWrites, searchRequests, statsRequests } = createController({ canonicalProjectId });
  const projectId = "old-request";
  const network = await controller.handle({
    id: 1, method: "codex-sandbox-network/update", params: { projectId, enabled: true, scope: "project" },
  });
  assert.equal(network.error, undefined);
  assert.deepEqual(networkWrites, [{ projectId: canonicalProjectId, enabled: true, scope: "project" }]);
  await controller.handle({ id: 2, method: "search/query", params: { projectId, query: "" } });
  await controller.handle({ id: 3, method: "stats/read", params: { projectId, range: "7d" } });
  assert.deepEqual(searchRequests, [{ projectId: canonicalProjectId, query: "" }]);
  assert.deepEqual(statsRequests, [{ projectId: canonicalProjectId, range: "7d", model: null, provider: null }]);
});

for (const harness of ["codex", "copilot", "opencode"] as const) {
  test(`${harness} thread profile dispatch persists and reopens the canonical owner`, async () => {
    const sqlite = new Database(":memory:");
    installWorkbenchDatabaseSchema(sqlite);
    const identities = new WorkbenchThreadIdentityRepository(sqlite);
    const projectId = ProjectIdSchema.parse("local:///profile-project");
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
        hasLiveGitArcClaims: async () => false,
        projectState: {
          getCurrentUpdate: () => null,
          handleRequest: async () => { throw new Error("Unexpected project request."); },
          observe: () => () => {},
        },
        publish: () => {},
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
});
