/* No production exports. Protect saved-draft ownership, launch fencing, profile resolution and uncertain outcomes. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadLaunchRequestSchema, type WorkbenchThreadLaunchState } from "workbench-shared/workbench/thread/thread-launch";
import type { WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection, WorkbenchComposerSettings, WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import WorkbenchPresentationRepository from "../state/WorkbenchPresentationRepository";
import WorkbenchWorkspaceDrafts from "./WorkbenchWorkspaceDrafts";

const daemonId = DaemonIdSchema.parse("10000000-0000-4000-8000-000000000001");
const projectId = ProjectIdSchema.parse("local-project");
const target = { daemonId, projectId };
const identityKey = ProjectIdentityKeySchema.parse("local://C:/local-project");
const model: WorkbenchModelOption = {
  id: "model", displayName: "model", description: "", hidden: false, isDefault: true,
  supportsPersonality: false, supportsReasoningEffort: false, supportedReasoningEfforts: [],
  defaultReasoningEffort: null, supportsVision: true, supportsFastMode: false,
  inputModalities: ["text", "image"], maxContextWindowTokens: null, additionalSpeedTiers: [],
  policyState: null, billingMultiplier: null,
};

function settings(model: string, harness: WorkbenchHarness = "codex"): WorkbenchComposerSettings {
  return { agentPath: null, agentSource: null, harness, model, reasoningEffort: null, serviceTier: null };
}

function definition(profileId: string, configured: WorkbenchComposerSettings): WorkbenchComposerProfile {
  return { ...configured, id: profileId, name: profileId, scope: { kind: "global" }, createdAt: 1, updatedAt: 2 };
}

async function fixture(
  context: TestContext,
  selection: WorkbenchComposerProfileTargetSelection = { kind: "custom", settings: settings(model.id) },
) {
  const temporary = await WorkbenchTemporaryDirectory.create("app-draft-owner-");
  const directory = temporary.path;
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(directory, "presentation.sqlite3") });
  await repository.start();
  const presentation = new WorkbenchPresentationController(repository);
  presentation.mutate({ kind: "registerLocations", daemonId, hostname: "original", catalog: {
    data: [{ identityKey, rootIdentityKeys: [identityKey], project: {
      id: projectId, kind: "git", name: "local-project", rootPath: "C:/local-project",
      relativePath: "local-project", lastCommitTimeMs: null,
      roots: [{ id: "root", isPrimary: true, name: "root", rootPath: "C:/local-project", relativePath: "" }],
    } }],
  } });
  const logicalProjectId = presentation.read().locations[0]!.logicalProjectId;
  const draftId = randomUUID();
  presentation.mutate({ kind: "putDraft", expectedRevision: null, draft: {
    id: draftId, logicalProjectId, target, prompt: "first message", updatedAt: 1, selection,
  } });
  const requests: Array<{ method: string; params: object }> = [];
  const warnings: string[] = [];
  let available = true;
  let retained = 0;
  let handle: (method: string, params: object) => Promise<object> = async method => {
    if (method === "models/list") return { data: [model] };
    throw new Error(`Unexpected operation ${method}`);
  };
  const daemon = new WorkbenchDaemonClient({
    request: async <Result>(method: string, params: object): Promise<Result> => {
      requests.push({ method, params });
      return await handle(method, params) as Result;
    },
  });
  const source = { daemon, get available() { return available; },
    retain: () => { retained++; return () => { retained--; }; } };
  const owners: WorkbenchWorkspaceDrafts[] = [];
  const createOwner = () => {
    const owner = new WorkbenchWorkspaceDrafts({
      presentation, sources: { get: id => { assert.equal(id, daemonId); return source; } },
      origin: () => "https://app.example", warn: message => warnings.push(message),
    });
    owners.push(owner);
    return owner;
  };
  context.after(async () => {
    await Promise.all(owners.map(owner => owner.dispose()));
    presentation.close(); await repository.close();
    await temporary.dispose();
  });
  return {
    owner: createOwner(), createOwner, presentation, requests, warnings, draftId,
    draft: () => presentation.read().drafts.find(draft => draft.id === draftId)!,
    available: (value: boolean) => { available = value; },
    handle: (value: typeof handle) => { handle = value; },
    retained: () => retained,
  };
}

test("an offline original destination does not reserve or prevent saving the draft", async context => {
  const f = await fixture(context);
  f.available(false);
  await assert.rejects(f.owner.launch(f.draftId, f.draft().revision), /not sent/);
  assert.equal(f.draft().phase, "unsent");
  assert.equal(f.requests.length, 0);
  const draft = f.draft();
  f.presentation.mutate({ kind: "putDraft", expectedRevision: draft.revision, draft: {
    id: draft.id, logicalProjectId: draft.logicalProjectId, target: draft.target,
    prompt: "new offline text", selection: draft.selection, updatedAt: 2,
  } });
  assert.equal(f.draft().prompt, "new offline text");
});

test("a newer save during destination validation fences launch before dispatch", async context => {
  const f = await fixture(context);
  const entered = Promise.withResolvers<void>();
  const models = Promise.withResolvers<object>();
  f.handle(async method => {
    assert.equal(method, "models/list"); entered.resolve(); return models.promise;
  });
  const launching = f.owner.launch(f.draftId, f.draft().revision);
  await entered.promise;
  const draft = f.draft();
  f.presentation.mutate({ kind: "putDraft", expectedRevision: draft.revision, draft: {
    id: draft.id, logicalProjectId: draft.logicalProjectId, target: draft.target,
    prompt: "newer text", selection: draft.selection, updatedAt: 2,
  } });
  models.resolve({ data: [model] });
  await assert.rejects(launching);
  assert.equal(f.requests.some(request => request.method === "thread/launch"), false);
  assert.equal(f.draft().phase, "unsent");
  assert.equal(f.draft().prompt, "newer text");
  assert.equal(f.retained(), 0);
});

test("uncertain dispatch reconciles the original launch and coalesces callers", async context => {
  const f = await fixture(context);
  let recorded: WorkbenchThreadLaunchState | null = null;
  const threadId = randomUUID();
  const entered = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<object>();
  f.handle(async (method, params) => {
    if (method === "models/list") return { data: [model] };
    if (method === "thread/launch") {
      const request = WorkbenchThreadLaunchRequestSchema.parse(params);
      recorded = { phase: "accepted", launchId: request.launchId, threadId, turnId: randomUUID() };
      entered.resolve();
      return outcome.promise;
    }
    assert.equal(method, "thread/launch/read");
    return { state: recorded };
  });
  const first = f.owner.launch(f.draftId, f.draft().revision);
  const second = f.owner.launch(f.draftId, f.draft().revision);
  assert.equal(first, second);
  await entered.promise;
  outcome.reject(new Error("connection lost after dispatch"));
  assert.equal((await first).threadId, threadId);
  assert.deepEqual(f.presentation.readAcceptedLaunch(f.draftId), { threadId, harness: "codex" });
  assert.equal(f.draft(), undefined);
  f.available(false);
  assert.equal((await f.createOwner().launch(f.draftId, 0)).threadId, threadId);
  assert.equal(f.requests.filter(request => request.method === "thread/launch").length, 1);
  assert.equal(f.retained(), 0);
});

test("a replacement owner reads an uncertain launch without resending the first message", async context => {
  const f = await fixture(context);
  let recorded: WorkbenchThreadLaunchState | null = null;
  f.handle(async (method, params) => {
    if (method === "models/list") return { data: [model] };
    if (method === "thread/launch") {
      const request = WorkbenchThreadLaunchRequestSchema.parse(params);
      recorded = { phase: "unknown", launchId: request.launchId, threadId: null, reason: "dispatch uncertain" };
      throw new Error("connection interrupted");
    }
    assert.equal(method, "thread/launch/read");
    assert.equal(z.object({ launchId: z.uuid() }).parse(params).launchId, recorded?.launchId);
    return { state: recorded };
  });
  await assert.rejects(f.owner.launch(f.draftId, f.draft().revision), error =>
    error instanceof WorkbenchRpcRequestInterruptedError && error.dispatched);
  const launchId = f.draft().launchId;
  await f.owner.dispose();
  await assert.rejects(f.createOwner().launch(f.draftId, f.draft().revision), /not confirmed/);
  assert.equal(f.draft().launchId, launchId);
  assert.equal(f.draft().phase, "submitting");
  assert.equal(f.requests.filter(request => request.method === "thread/launch").length, 1);
});

test("launch reads stored image bytes and disposal drains the accepted operation", async context => {
  const f = await fixture(context);
  const content = Buffer.from("owned image bytes");
  f.presentation.putAttachmentChunk(f.draftId, "image", 0, content);
  f.presentation.completeAttachment(f.draftId, "image", 1, "image/png", createHash("sha256").update(content).digest("hex"));
  const entered = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<object>();
  let launchId = "";
  f.handle(async (method, params) => {
    if (method === "models/list") return { data: [model] };
    assert.equal(method, "thread/launch");
    const request = WorkbenchThreadLaunchRequestSchema.parse(params);
    launchId = request.launchId;
    const image = request.firstInput.find(input => input.type === "image");
    assert.equal(image?.type === "image" ? image.url : null, `data:image/png;base64,${content.toString("base64")}`);
    assert.equal(request.projectId, projectId);
    entered.resolve();
    return accepted.promise;
  });
  const launching = f.owner.launch(f.draftId, f.draft().revision);
  await entered.promise;
  const closing = f.owner.dispose();
  await assert.rejects(f.owner.launch(f.draftId, f.draft().revision), /closing/);
  assert.equal(f.retained(), 1);
  const threadId = randomUUID();
  accepted.resolve({ phase: "accepted", launchId, threadId, turnId: randomUUID() });
  assert.equal((await launching).threadId, threadId);
  await closing;
  assert.equal(f.retained(), 0);
  assert.deepEqual(f.presentation.readAcceptedLaunch(f.draftId), { threadId, harness: "codex" });
  assert.equal(f.draft(), undefined);
});

test("a linked draft launches with its stored profile's current definition", async context => {
  const f = await fixture(context, { kind: "profile", profileId: "profile-1", settings: settings("stale model") });
  const threadId = randomUUID();
  f.handle(async (method, params) => {
    if (method === "profiles/read") return { profiles: [definition("profile-1", settings(model.id, "opencode"))] };
    if (method === "models/list") return { data: [model] };
    assert.equal(method, "thread/launch");
    const request = WorkbenchThreadLaunchRequestSchema.parse(params);
    assert.deepEqual(request.profile, { kind: "profile", profileId: "profile-1", settings: settings(model.id, "opencode") });
    return { phase: "accepted", launchId: request.launchId, threadId, turnId: randomUUID() };
  });
  assert.deepEqual(await f.owner.launch(f.draftId, f.draft().revision), { threadId, harness: "opencode" });
  assert.deepEqual(f.presentation.readAcceptedLaunch(f.draftId), { threadId, harness: "opencode" });
});

test("a draft whose linked profile is gone launches with its saved settings as Custom", async context => {
  const f = await fixture(context, { kind: "profile", profileId: "gone", settings: settings(model.id) });
  const threadId = randomUUID();
  f.handle(async (method, params) => {
    if (method === "profiles/read") return { profiles: [] };
    if (method === "models/list") return { data: [model] };
    assert.equal(method, "thread/launch");
    const request = WorkbenchThreadLaunchRequestSchema.parse(params);
    assert.deepEqual(request.profile, { kind: "custom", settings: settings(model.id) });
    return { phase: "accepted", launchId: request.launchId, threadId, turnId: randomUUID() };
  });
  assert.deepEqual(await f.owner.launch(f.draftId, f.draft().revision), { threadId, harness: "codex" });
});

test("launch validation follows the resolved definition's model", async context => {
  const f = await fixture(context, { kind: "profile", profileId: "profile-1", settings: settings(model.id) });
  f.handle(async method => {
    if (method === "profiles/read") return { profiles: [definition("profile-1", settings("missing model"))] };
    assert.equal(method, "models/list");
    return { data: [model] };
  });
  await assert.rejects(f.owner.launch(f.draftId, f.draft().revision), /does not support this draft's model/u);
  assert.equal(f.requests.some(request => request.method === "thread/launch"), false);
});

test("a submitting retry replays the recorded applied selection", async context => {
  const f = await fixture(context, { kind: "profile", profileId: "profile-1", settings: settings("stale model") });
  const threadId = randomUUID();
  let firstProfile: unknown = null;
  f.handle(async (method, params) => {
    if (method === "profiles/read") return { profiles: [definition("profile-1", settings(model.id))] };
    if (method === "models/list") return { data: [model] };
    if (method === "thread/launch/read") return { state: null };
    assert.equal(method, "thread/launch");
    firstProfile = WorkbenchThreadLaunchRequestSchema.parse(params).profile;
    throw new Error("connection interrupted");
  });
  await assert.rejects(f.owner.launch(f.draftId, f.draft().revision), error =>
    error instanceof WorkbenchRpcRequestInterruptedError && error.dispatched);
  assert.equal(f.draft().phase, "submitting");
  assert.deepEqual(firstProfile, { kind: "profile", profileId: "profile-1", settings: settings(model.id) });
  f.handle(async (method, params) => {
    if (method === "thread/launch/read") return { state: null };
    assert.equal(method, "thread/launch");
    const request = WorkbenchThreadLaunchRequestSchema.parse(params);
    assert.deepEqual(request.profile, firstProfile);
    return { phase: "accepted", launchId: request.launchId, threadId, turnId: randomUUID() };
  });
  assert.deepEqual(await f.owner.launch(f.draftId, f.draft().revision), { threadId, harness: "codex" });
  assert.deepEqual(f.presentation.readAcceptedLaunch(f.draftId), { threadId, harness: "codex" });
});
