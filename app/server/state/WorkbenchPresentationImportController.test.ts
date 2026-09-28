/* No production exports. Protect app-owned import coalescing and independent legacy source failures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type { WorkbenchDaemonTransport } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { PresentationMutation, PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type WorkbenchDaemonSource from "../workspace/WorkbenchDaemonSource";
import type WorkbenchPresentationController from "./WorkbenchPresentationController";
import WorkbenchPresentationImportController from "./WorkbenchPresentationImportController";

function importSource(
  identity: () => { daemonId: string; generation: number; ready: boolean },
  request: WorkbenchDaemonTransport["request"],
) {
  const listeners = new Set<() => void>();
  let retained = 0;
  let released = 0;
  const source = {
    get available() { return identity().ready; },
    getSnapshot: () => ({ ...identity(), hostname: "local", connection: identity().ready ? "current" : "unavailable" }),
    retain: () => { retained++; return () => { released++; }; },
    request,
    observe: (_query: object, changed: () => void) => {
      let active = true;
      let fact: object = { phase: "pending", value: null, failure: null };
      void request<{ data: [] }>("project/locations/read", {}).then(
        locations => {
          if (!active) return;
          fact = { phase: "current", value: { kind: "catalogue", locations }, failure: null };
          changed();
        },
        error => {
          if (!active) return;
          fact = { phase: "failed", value: null, failure: error instanceof Error ? error.message : "Read failed." };
          changed();
        },
      );
      return { getSnapshot: () => fact, release: () => { active = false; } };
    },
  } as unknown as WorkbenchDaemonSource;
  const sources = {
    attached: source,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as WorkbenchDaemonSources;
  return { sources, notify: () => { for (const listener of listeners) listener(); },
    get retained() { return retained; }, get released() { return released; } };
}

test("one app import survives tab-like refresh signals and an unreadable image cannot hide the next draft", async () => {
  const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const logicalProjectId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const broken = DraftIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const good = DraftIdSchema.parse("00000000-0000-4000-8000-000000000003");
  const imageDraft = DraftIdSchema.parse("00000000-0000-4000-8000-000000000004");
  const image = Buffer.from("image-bytes");
  const imageHash = createHash("sha256").update(image).digest("hex");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const mutations: PresentationMutation[][] = [];
  const staged: PresentationMutation[] = [];
  const chunks: Buffer[] = [];
  let completedImages = 0;
  let manifestReads = 0;
  let ready = true;
  const snapshot: PresentationSnapshot = {
    daemons: [], defaults: [], divergences: [], drafts: [], folders: [],
    locations: [{
      target: { daemonId, projectId }, logicalProjectId, identityKey: "path:test",
      name: "test", rootPath: "C:/test",
    }],
    members: [], projects: [], revision: 1, sourceMappings: [],
  };
  const presentation = {
    mutate: (mutation: PresentationMutation) => { staged.push(mutation); return snapshot; },
    read: () => snapshot,
    readImportReceipts: () => ({ present: [] }),
    mutateImportBatch: (batch: PresentationMutation[]) => {
      mutations.push([...batch]);
      return { accepted: true };
    },
    putAttachmentChunk: (_draftId: string, _id: string, _index: number, bytes: Buffer) => { chunks.push(bytes); },
    completeAttachment: () => { completedImages++; return snapshot; },
  } as unknown as WorkbenchPresentationController;
  const source = importSource(() => ({ daemonId, generation: 1, ready }), async <TResponse>(method: string) => {
    if (method === "project/locations/read") {
      entered.resolve();
      await release.promise;
      return { data: [] } as TResponse;
    }
    if (method === "thread/presentation/manifest/read") {
      manifestReads++;
      return { sources: [
        { kind: "draft", projectId, sourceId: broken },
        { kind: "draft", projectId, sourceId: good },
        { kind: "draft", projectId, sourceId: imageDraft },
      ], nextCursor: null } as TResponse;
    }
    if (method === "thread/presentation/export") {
      const settings = {
        agentPath: null, agentSource: null, harness: "codex", model: "model",
        reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
      };
      return { projectId, sourceRevision: 1, nextCursor: null, drafts: [
        {
          draftId: broken, prompt: "has external image", createdAt: 1, updatedAt: 2,
          clientUpdatedAt: 2, profileId: null, pinned: false, snoozed: false,
          composerSettings: settings, attachments: [{ kind: "url", id: "image", url: "https://example.invalid/private" }],
        },
        {
          draftId: good, prompt: "independent", createdAt: 1, updatedAt: 2,
          clientUpdatedAt: 2, profileId: null, pinned: false, snoozed: false,
          composerSettings: settings, attachments: [],
        },
        {
          draftId: imageDraft, prompt: "inline image", createdAt: 1, updatedAt: 2,
          clientUpdatedAt: 2, profileId: null, pinned: false, snoozed: false,
          composerSettings: settings, attachments: [{
            kind: "inline", id: "shot", mediaType: "image/png", byteLength: image.length,
            contentHash: imageHash,
          }],
        },
      ] } as TResponse;
    }
    if (method === "thread/presentation/attachment/read") {
      return { bytes: image.toString("base64"), nextOffset: null, byteLength: image.length,
        contentHash: imageHash, mediaType: "image/png" } as TResponse;
    }
    throw new Error(`Unexpected source request: ${method}`);
  });
  const logger = new WorkbenchProcessLogger({
    color: false,
    writeOutput: () => {},
    writeError: () => {},
  });
  const owner = new WorkbenchPresentationImportController({
    sources: source.sources, presentation, logger,
  });
  owner.subscribe(status => {
    if (status.phase === "partial" || status.phase === "complete") settled.resolve();
  });
  try {
    const initial = owner.start();
    assert.ok(initial instanceof Promise, "startup exposes its owned reconciliation");
    await entered.promise;
    source.notify();
    source.notify();
    release.resolve();
    await settled.promise;
    await initial;
    assert.equal(source.retained, 1);
    assert.equal(manifestReads, 1);
    assert.deepEqual(mutations.flat().map(mutation => mutation.kind), ["importDraft", "finishImportDraft"]);
    assert.deepEqual(staged.filter(mutation => mutation.kind !== "registerLocations").map(mutation => mutation.kind),
      ["importDraft", "finishImportDraft"]);
    assert.deepEqual(Buffer.concat(chunks), image);
    assert.equal(completedImages, 1);
    ready = false;
    source.notify();
    ready = true;
    source.notify();
    assert.equal(source.retained, 1, "a completed partial import is not replayed for the same connection generation");
  } finally {
    release.resolve();
    await owner.close();
  }
});

test("a changed attached daemon retires the old import source before it can write", async () => {
  const firstId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const secondId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
  let currentId = firstId;
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ data: [] }>();
  const source = importSource(() => ({ daemonId: currentId, generation: 1, ready: true }), async <TResponse>() => {
    entered.resolve();
    return await pending.promise as TResponse;
  });
  const owner = new WorkbenchPresentationImportController({
    sources: source.sources,
    presentation: {} as WorkbenchPresentationController,
    logger: new WorkbenchProcessLogger({ color: false, writeOutput: () => {}, writeError: () => {} }),
  });
  try {
    owner.start();
    await entered.promise;
    currentId = secondId;
    source.notify();
    assert.equal(source.released, 1);
  } finally {
    await owner.close();
    pending.resolve({ data: [] });
  }
});

test("failed import waits for a new connection generation instead of replaying on unrelated source facts", async () => {
  const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  let ready = true;
  let generation = 1;
  let attempts = 0;
  const snapshot = {
    daemons: [], defaults: [], divergences: [], drafts: [], folders: [], locations: [],
    members: [], projects: [], revision: 1, sourceMappings: [],
  } as PresentationSnapshot;
  const source = importSource(() => ({ daemonId, generation, ready }), async <TResponse>(method: string) => {
    if (method === "project/locations/read") {
      if (++attempts === 1) throw new Error("Discovery was unavailable.");
      return { data: [] } as TResponse;
    }
    if (method === "thread/presentation/manifest/read") {
      return { sources: [], nextCursor: null } as TResponse;
    }
    throw new Error(`Unexpected source request: ${method}`);
  });
  const owner = new WorkbenchPresentationImportController({
    sources: source.sources,
    presentation: {
      mutate: () => snapshot, read: () => snapshot,
      readImportReceipts: () => ({ present: [] }),
    } as unknown as WorkbenchPresentationController,
    logger: new WorkbenchProcessLogger({ color: false, writeOutput: () => {}, writeError: () => {} }),
  });
  try {
    await owner.start();
    assert.equal(owner.snapshot().phase, "failed");
    source.notify();
    source.notify();
    assert.equal(attempts, 1);
    const complete = Promise.withResolvers<void>();
    owner.subscribe(status => { if (status.phase === "complete") complete.resolve(); });
    ready = false;
    source.notify();
    ready = true;
    generation++;
    source.notify();
    await complete.promise;
    assert.equal(attempts, 2);
  } finally {
    await owner.close();
  }
});
