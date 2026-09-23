/*
 * No production exports. Protect cross-daemon grouping, app-owned draft revisions and retained imports.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema } from "workbench-shared/workbench/identity";
import WorkbenchPresentationRepository from "./WorkbenchPresentationRepository";

const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
const remote = ProjectIdentityKeySchema.parse("remote://example.test/owner/repo");
const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
const draftId = "2d64382a-c7e5-456a-9ee5-6e16de89453d";
const selection = {
  kind: "custom" as const,
  settings: {
    agentPath: null, agentSource: null, harness: "codex" as const, model: "test",
    reasoningEffort: null, serviceTier: null,
  },
};

function catalog(rootPath: string, identityKey = remote) {
  return { data: [{
    identityKey, rootIdentityKeys: [identityKey],
    project: {
      id: projectId, kind: "git" as const, name: "repo", relativePath: "repo",
      rootPath, lastCommitTimeMs: null,
      roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath }],
    },
  }] };
}

test("one remote groups locations but drafts retain a concrete daemon target across reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-"));
  const databasePath = path.join(root, "presentation.sqlite3");
  const repository = new WorkbenchPresentationRepository({ databasePath });
  try {
    await repository.start();
    repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/desktop/repo") });
    repository.mutate({ kind: "registerLocations", daemonId: second, hostname: "laptop", catalog: catalog("/laptop/repo") });
    const initial = repository.read();
    assert.equal(initial.projects.length, 1);
    assert.equal(initial.locations.length, 2);
    const logicalProjectId = initial.projects[0]!.id;
    const draft = { id: draftId, logicalProjectId,
      target: { daemonId: second, projectId }, prompt: "hello", selection, updatedAt: 1 };
    const saved = repository.mutate({ kind: "putDraft", draft, expectedRevision: null }).drafts[0]!;
    assert.deepEqual(saved.target, { daemonId: second, projectId });
    assert.throws(() => repository.mutate({ kind: "putDraft", draft: { ...draft, prompt: "stale" },
      expectedRevision: saved.revision - 1 }), /another browser/u);
    await repository.close();
    await repository.start();
    assert.deepEqual(repository.read().drafts[0]?.target, { daemonId: second, projectId });
    assert.equal(repository.read().projects.length, 1);
  } finally {
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("incomplete imported attachments stay hidden and receipt blocks resurrection after deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-import-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  try {
    await repository.start();
    repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/desktop/repo") });
    const logicalProjectId = repository.read().projects[0]!.id;
    const content = Buffer.from("image-bytes");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const draft = { id: draftId, logicalProjectId,
      target: { daemonId: first, projectId }, prompt: "attached", selection, updatedAt: 1 };
    const staged = { kind: "importDraft" as const, daemonId: first, sourceId: "old-draft",
      sourceRevision: 3, draft, attachments: [{ id: "old-image", mediaType: "image/png", contentHash }] };
    repository.mutate(staged);
    assert.equal(repository.read().drafts.length, 0);
    assert.deepEqual(repository.read().sourceMappings, [{
      daemonId: first, sourceKind: "draft", sourceId: "old-draft", targetId: draftId, sourceRevision: 3,
    }]);
    assert.throws(() => repository.mutate({ kind: "finishImportDraft", daemonId: first,
      sourceId: "old-draft", sourceRevision: 3, draftId }), /incomplete/u);
    repository.putAttachmentChunk(draftId, "old-image", 0, content);
    repository.completeAttachment(draftId, "old-image", 1, "image/png", contentHash);
    repository.mutate({ kind: "finishImportDraft", daemonId: first,
      sourceId: "old-draft", sourceRevision: 3, draftId });
    const imported = repository.read().drafts[0]!;
    assert.equal(imported.attachments[0]?.contentHash, contentHash);
    const folderId = "e43d2705-6e45-4566-82f1-e08ca4b4e8bc";
    const layout = {
      kind: "importLayout" as const, daemonId: first, sourceId: "project-layout",
      sourceRevision: 4, scope: "project" as const, logicalProjectId,
      folders: [{ id: folderId, scope: "project" as const, logicalProjectId,
        sourceId: "legacy-folder", title: "saved folder", position: 0 }],
      members: [{ id: "7c836900-c401-450f-a35d-c450c2a765d9",
        sourceId: "legacy-member", scope: "project" as const, logicalProjectId,
        folderId: "legacy-folder", kind: "draft" as const,
        draftId: "old-draft", thread: null, position: 0 }],
    };
    repository.mutate(layout);
    repository.mutate(layout);
    assert.equal(repository.read().folders.length, 1);
    assert.equal(repository.read().members[0]?.draftId, draftId);
    repository.mutate({ kind: "deleteDraft", draftId, expectedRevision: imported.revision });
    repository.mutate(staged);
    assert.equal(repository.read().drafts.length, 0);
    assert.equal(repository.read().members.length, 0);
    repository.mutate({ ...staged, sourceRevision: 5 });
    assert.deepEqual(repository.read().divergences.map(item => ({
      sourceId: item.sourceId, importedRevision: item.importedRevision, latestRevision: item.latestRevision,
    })), [{ sourceId: "old-draft", importedRevision: 3, latestRevision: 5 }]);
  } finally {
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("equal legacy draft and folder ids from two daemons map to independent app owners", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-sources-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  try {
    await repository.start();
    repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/desktop/repo") });
    repository.mutate({ kind: "registerLocations", daemonId: second, hostname: "laptop", catalog: catalog("/laptop/repo") });
    const logicalProjectId = repository.read().projects[0]!.id;
    const targets = [
      { daemonId: first, draftId, folderId: "f238fe8a-3659-4dc7-8a5f-b3457d0297df",
        memberId: "92972fbc-e5b3-4723-868d-591c3a45a1b4" },
      { daemonId: second, draftId: "13505db0-03ed-4961-9c8c-a8b7e12a9748",
        folderId: "7f59527e-719a-44a0-b0bb-1c900609834a",
        memberId: "9e00a7ad-bd0f-4635-a3d4-64eed8545a32" },
    ] as const;
    for (const item of targets) {
      repository.mutate({
        kind: "importDraft", daemonId: item.daemonId, sourceId: "same-draft", sourceRevision: 1,
        draft: { id: item.draftId, logicalProjectId,
          target: { daemonId: item.daemonId, projectId }, prompt: "retained", selection, updatedAt: 1 },
        attachments: [],
      });
      if (item.daemonId === first) {
        assert.throws(() => repository.mutate({
          kind: "importDraft", daemonId: item.daemonId, sourceId: "same-draft", sourceRevision: 2,
          draft: { id: item.draftId, logicalProjectId,
            target: { daemonId: item.daemonId, projectId }, prompt: "retained", selection, updatedAt: 1 },
          attachments: [],
        }), /revision/u);
      }
      repository.mutate({ kind: "finishImportDraft", daemonId: item.daemonId,
        sourceId: "same-draft", sourceRevision: 1, draftId: item.draftId });
      repository.mutate({
        kind: "importLayout", daemonId: item.daemonId, sourceId: "same-layout",
        sourceRevision: 1, scope: "project", logicalProjectId,
        folders: [{ id: item.folderId, sourceId: "same-folder", scope: "project",
          logicalProjectId, title: "same name", position: 0 }],
        members: [{ id: item.memberId, sourceId: "same-member", scope: "project",
          logicalProjectId, folderId: "same-folder", kind: "draft",
          draftId: "same-draft", thread: null, position: 0 }],
      });
    }
    assert.equal(repository.read().folders.length, 2);
    assert.deepEqual(repository.read().members.map(member => [member.draftId, member.folderId]),
      targets.map(item => [item.draftId, item.folderId]));
    assert.equal(repository.read().sourceMappings.length, 6);
    await repository.close();
    await repository.start();
    assert.equal(repository.read().sourceMappings.length, 6);
  } finally {
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a project layout cannot borrow another project's draft or thread target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-layout-owner-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  try {
    await repository.start();
    repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/first") });
    repository.mutate({ kind: "registerLocations", daemonId: second, hostname: "laptop",
      catalog: catalog("/second", ProjectIdentityKeySchema.parse("remote://example.test/other/repo")) });
    const locations = repository.read().locations;
    const firstProject = locations.find(location => location.target.daemonId === first)!.logicalProjectId;
    const secondProject = locations.find(location => location.target.daemonId === second)!.logicalProjectId;
    repository.mutate({ kind: "putDraft", expectedRevision: null,
      draft: { id: draftId, logicalProjectId: firstProject,
        target: { daemonId: first, projectId }, prompt: "first", selection, updatedAt: 1 } });
    const base = { kind: "saveLayout" as const, scope: "project" as const,
      logicalProjectId: secondProject, folders: [] };
    const member = { id: "8308b08c-01a7-42f5-a878-329552a16773",
      scope: "project" as const, logicalProjectId: secondProject, folderId: null, position: 0 };
    assert.throws(() => repository.mutate({ ...base, expectedRevision: repository.read().revision,
      members: [{ ...member, kind: "draft", draftId, thread: null }] }), /another project/u);
    assert.throws(() => repository.mutate({ ...base, expectedRevision: repository.read().revision,
      members: [{ ...member, kind: "thread", draftId: null,
        thread: { location: { daemonId: first, projectId }, threadId: "thread" } }] }), /another project/u);
    assert.equal(repository.read().members.length, 0);
  } finally {
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
