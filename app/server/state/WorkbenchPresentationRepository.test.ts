/*
 * No production exports. Protect cross-daemon grouping, app-owned draft revisions and retained imports.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DATABASE_LOG_PREFIX } from "workbench-shared/database/database-log-format";
import { applyWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import { presentationSchema } from "workbench-shared/state/workbench-presentation-schema";
import { captureTestOutput } from "../../../test/capture-test-output.mts";
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
    const revision = repository.read().revision;
    assert.equal(repository.mutate({ kind: "putDraft", draft, expectedRevision: null }).revision, revision);
    assert.equal(repository.mutate({
      kind: "putDraft", draft: { ...draft, updatedAt: 2 }, expectedRevision: saved.revision - 1,
    }).revision, revision);
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

test("only the exact revision from deleting an unlaunched draft can reopen it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-reopen-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  try {
    await repository.start();
    repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/desktop/repo") });
    const logicalProjectId = repository.read().projects[0]!.id;
    const draft = { id: draftId, logicalProjectId,
      target: { daemonId: first, projectId }, prompt: "first words", selection, updatedAt: 1 };
    const saved = repository.mutate({ kind: "putDraft", draft, expectedRevision: null }).drafts[0]!;
    const deleted = repository.mutate({ kind: "deleteDraft", draftId, expectedRevision: saved.revision });
    assert.equal(deleted.drafts.length, 0);
    assert.throws(() => repository.mutate({ kind: "putDraft", draft: { ...draft, prompt: "new words" },
      expectedRevision: null }), /another browser/u);
    assert.throws(() => repository.mutate({ kind: "putDraft", draft: { ...draft, prompt: "new words" },
      expectedRevision: saved.revision }), /another browser/u);
    const reopened = repository.mutate({ kind: "putDraft", draft,
      expectedRevision: deleted.revision }).drafts[0]!;
    assert.equal(reopened.prompt, "first words");
    assert.equal(reopened.phase, "unsent");
    const same = repository.mutate({ kind: "putDraft", draft,
      expectedRevision: reopened.revision }).drafts[0]!;
    assert.equal(same.revision, reopened.revision);
    const deletedAgain = repository.mutate({ kind: "deleteDraft", draftId,
      expectedRevision: same.revision });
    const edited = repository.mutate({ kind: "putDraft", draft: { ...draft, prompt: "new words" },
      expectedRevision: deletedAgain.revision }).drafts[0]!;
    assert.equal(edited.prompt, "new words");
    const reserved = repository.mutate({
      kind: "reserveLaunch", draftId, expectedRevision: edited.revision, launchId: crypto.randomUUID(),
    }).drafts[0]!;
    repository.mutate({ kind: "deleteDraft", draftId, expectedRevision: reserved.revision });
    assert.throws(() => repository.mutate({ kind: "putDraft", draft: { ...draft, prompt: "too late" },
      expectedRevision: repository.read().revision }), /submitting or closed/u);
  } finally {
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("new-folder draft placement is atomic and autosaves cannot restore an obsolete folder choice", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-draft-folder-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  context.after(async () => {
    await repository.close(); await fs.rm(root, { recursive: true, force: true });
  });
  await repository.start();
  repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/repo") });
  const logicalProjectId = repository.read().projects[0]!.id;
  const folderId = crypto.randomUUID();
  const movedFolderId = crypto.randomUUID();
  const folders = [folderId, movedFolderId].map((id, position) => ({
    id, scope: "project" as const, logicalProjectId, title: id, position,
  }));
  repository.mutate({ kind: "saveLayout", scope: "project", logicalProjectId,
    expectedRevision: repository.read().revision, folders, members: [] });
  for (const priority of ["pinned", "snoozed"] as const) {
    const draft = { id: crypto.randomUUID(), logicalProjectId, target: { daemonId: first, projectId },
      prompt: priority, selection, updatedAt: 1 };
    const before = repository.read();
    assert.throws(() => repository.mutate({ kind: "putDraft", expectedRevision: null,
      draft, placement: { folderId: crypto.randomUUID(), priority } }), /folder/);
    assert.deepEqual(repository.read(), before);
    let result = repository.mutate({ kind: "putDraft", expectedRevision: null, draft,
      placement: { folderId, priority } });
    const saved = result.drafts.find(item => item.id === draft.id)!;
    assert.equal(saved.pinned, priority === "pinned");
    assert.equal(saved.snoozed, priority === "snoozed");
    assert.equal(result.members.find(item => item.draftId === draft.id)?.folderId, folderId);
    const createdRevision = result.revision;
    result = repository.mutate({ kind: "putDraft", expectedRevision: null, draft,
      placement: { folderId, priority } });
    assert.equal(result.revision, createdRevision);
    result = repository.mutate({ kind: "saveLayout", scope: "project", logicalProjectId,
      expectedRevision: result.revision, folders, members: result.members.map(member =>
        member.draftId === draft.id ? { ...member, folderId: movedFolderId } : member) });
    result = repository.mutate({ kind: "putDraft", expectedRevision: saved.revision,
      draft: { ...draft, prompt: "newer content" }, placement: { folderId, priority } });
    assert.equal(result.members.find(item => item.draftId === draft.id)?.folderId, movedFolderId);
  }
  const before = repository.read();
  await repository.close(); await repository.start();
  assert.deepEqual(repository.read(), before);
});

test("draft settings and destination defaults commit together without rewriting other drafts", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-draft-defaults-"));
  const databasePath = path.join(root, "presentation.sqlite3");
  const repository = new WorkbenchPresentationRepository({ databasePath });
  context.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  await repository.start();
  repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop", catalog: catalog("/repo") });
  const logicalProjectId = repository.read().projects[0]!.id;
  const draft = { id: draftId, logicalProjectId, target: { daemonId: first, projectId },
    prompt: "first", selection, updatedAt: 1 };
  const saved = repository.mutate({ kind: "putDraft", expectedRevision: null, draft }).drafts[0]!;
  const secondId = crypto.randomUUID();
  const secondSelection = { ...selection, settings: { ...selection.settings, model: "second" } };
  let result = repository.mutate({ kind: "putDraft", expectedRevision: null,
    draft: { ...draft, id: secondId, selection: secondSelection } });
  assert.equal(result.drafts.find(item => item.id === draftId)?.selection.settings.model, "test");
  assert.equal(result.defaults[0]?.selection.settings.model, "second");
  const newer = { ...draft, selection: { ...selection, settings: { ...selection.settings, model: "newer" } } };
  result = repository.mutate({ kind: "putDraft", expectedRevision: saved.revision, draft: newer });
  assert.equal(result.defaults[0]?.selection.settings.model, "newer");
  assert.equal(result.drafts.find(item => item.id === secondId)?.selection.settings.model, "second");
  assert.throws(() => repository.mutate({ kind: "putDraft", expectedRevision: saved.revision, draft }), /another browser/);
  const before = repository.read();
  const fault = new Database(databasePath);
  try {
    fault.exec(`CREATE TRIGGER reject_default_write BEFORE UPDATE ON presentation_new_thread_defaults
      BEGIN SELECT RAISE(ABORT, 'default write failed'); END`);
    assert.throws(() => repository.mutate({ kind: "putDraft",
      expectedRevision: before.drafts.find(item => item.id === draftId)!.revision,
      draft: { ...draft, prompt: "uncommitted", selection: secondSelection } }), /default write failed/);
    assert.deepEqual(repository.read(), before);
  } finally { fault.close(); }
  await repository.close(); await repository.start();
  assert.deepEqual(repository.read(), before);
});

test("equal path identities share one project without losing concrete daemon targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-path-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  const identityKey = ProjectIdentityKeySchema.parse("local://C:/repo/.git");
  try {
    await repository.start();
    repository.mutate({ kind: "registerLocations", daemonId: first, hostname: "desktop",
      catalog: catalog("C:/repo", identityKey) });
    repository.mutate({ kind: "registerLocations", daemonId: second, hostname: "laptop",
      catalog: catalog("C:/repo", identityKey) });
    const snapshot = repository.read();
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0]?.matchKey, identityKey);
    assert.deepEqual(snapshot.locations.map(location => location.target.daemonId), [first, second]);
  } finally {
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v1 path duplicates converge transactionally without losing saved owners or layout order", async context => {
  captureTestOutput(context, process.stdout, text => text.startsWith(DATABASE_LOG_PREFIX));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-v1-"));
  const databasePath = path.join(root, "presentation.sqlite3");
  const oldIds = [
    "112f7e1e-81b6-4c30-bdc0-f83475981001",
    "a12f7e1e-81b6-4c30-bdc0-f83475981002",
  ] as const;
  const orphanId = "b12f7e1e-81b6-4c30-bdc0-f83475981003";
  const folderIds = [
    "112f7e1e-81b6-4c30-bdc0-f83475982001",
    "a12f7e1e-81b6-4c30-bdc0-f83475982002",
  ] as const;
  const memberIds = [
    "112f7e1e-81b6-4c30-bdc0-f83475983001",
    "a12f7e1e-81b6-4c30-bdc0-f83475983002",
  ] as const;
  const savedDraftIds = [
    "112f7e1e-81b6-4c30-bdc0-f83475984001",
    "a12f7e1e-81b6-4c30-bdc0-f83475984002",
  ] as const;
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    applyWorkbenchDatabaseSchema(database, presentationSchema, { targetVersion: 1 });
    const identity = "local://C:/repo/.git";
    const daemons = [first, second] as const;
    for (const [index, daemonId] of daemons.entries()) {
      const logicalId = oldIds[index]!;
      database.prepare("INSERT INTO presentation_daemons VALUES (?, ?, ?)").run(daemonId, `host-${index}`, 1);
      database.prepare("INSERT INTO presentation_projects VALUES (?, ?, ?)").run(
        logicalId, `${daemonId}:${identity}`, "C:/repo");
      database.prepare("INSERT INTO presentation_locations VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        daemonId, projectId, logicalId, identity, "repo", "C:/repo", 1);
      database.prepare("INSERT INTO presentation_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        savedDraftIds[index], logicalId, daemonId, projectId, "saved", JSON.stringify(selection),
        index === 0 ? "unsent" : "accepted", null, index === 0 ? null : "thread-second", 1, 1);
      database.prepare("INSERT INTO presentation_folders VALUES (?, ?, ?, ?, ?, ?)").run(
        folderIds[index], "project", logicalId, `folder-${index}`, index === 0 ? 1 : 0, 1);
      database.prepare("INSERT INTO presentation_layout_members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        memberIds[index], "project", logicalId, folderIds[index], "thread", null,
        daemonId, projectId, `thread-${index}`, index === 0 ? 1 : 0, 1);
      database.prepare("INSERT INTO presentation_import_receipts VALUES (?, ?, ?, ?, ?)").run(
        daemonId, "layout", `source-${index}`, logicalId, 1);
    }
    database.prepare("INSERT INTO presentation_projects VALUES (?, ?, ?)").run(
      orphanId, `612902c0-9512-40be-bb06-c65d86ef2029:${identity}`, "orphan");
  } finally {
    database.close();
  }
  const repository = new WorkbenchPresentationRepository({ databasePath });
  try {
    await repository.start();
    const backupDirectory = path.join(root, "backups", "presentation.sqlite3");
    const backups = await fs.readdir(backupDirectory);
    assert.equal(backups.length, 1);
    const backup = new Database(path.join(backupDirectory, backups[0]!), { readonly: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), 1);
      assert.equal((backup.prepare("SELECT count(*) FROM presentation_projects").pluck().get() as number), 3);
    } finally {
      backup.close();
    }
    const snapshot = repository.read();
    assert.deepEqual(snapshot.projects.map(project => [project.id, project.matchKey]), [[oldIds[0], "local://C:/repo/.git"]]);
    assert.deepEqual(snapshot.locations.map(location => location.logicalProjectId), [oldIds[0], oldIds[0]]);
    const upgraded = new Database(databasePath, { readonly: true });
    try {
      for (const table of ["presentation_drafts", "presentation_folders", "presentation_layout_members"]) {
        assert.deepEqual((upgraded.prepare(`SELECT DISTINCT logical_project_id FROM ${table}`).all() as
          Array<{ logical_project_id: string }>).map(row => row.logical_project_id), [oldIds[0]]);
      }
      assert.deepEqual((upgraded.prepare("SELECT target_id FROM presentation_import_receipts ORDER BY daemon_id")
        .all() as Array<{ target_id: string }>).map(row => row.target_id), [oldIds[0], oldIds[0]]);
      assert.deepEqual(snapshot.folders.map(folder => folder.id), folderIds);
      assert.deepEqual(snapshot.members.map(member => member.id), memberIds);
      assert.deepEqual(snapshot.members.map(member => member.position), [0, 1]);
    } finally {
      upgraded.close();
    }
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
      sourceRevision: 3, draft, pinned: false, snoozed: false,
      attachments: [{ id: "old-image", mediaType: "image/png", contentHash }] };
    repository.mutate(staged);
    assert.equal(repository.read().drafts.length, 0);
    assert.deepEqual(repository.readImportReceipts(first, [
      { kind: "draft", sourceId: "old-draft" },
    ]), [], "a staged draft is not an accepted import");
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
    assert.deepEqual(repository.readImportReceipts(first, [
      { kind: "draft", sourceId: "old-draft" },
      { kind: "layout", sourceId: "project-layout" },
      { kind: "layout", sourceId: "home" },
    ]), [
      { kind: "draft", sourceId: "old-draft" },
      { kind: "layout", sourceId: "project-layout" },
    ]);
    const homeLayout = { ...layout, sourceId: "home", scope: "home" as const,
      logicalProjectId: null, folders: [], members: [] };
    assert.throws(() => repository.mutateImportBatch([
      homeLayout,
      { ...homeLayout, sourceId: "invalid", scope: "project" as const },
    ]), /belongs to another scope/u);
    assert.deepEqual(repository.readImportReceipts(first, [{ kind: "layout", sourceId: "home" }]), [],
      "a later invalid item rolls back the whole import batch");
    assert.deepEqual(repository.mutateImportBatch([homeLayout]), { accepted: true });
    assert.deepEqual(repository.readImportReceipts(first, [{ kind: "layout", sourceId: "home" }]),
      [{ kind: "layout", sourceId: "home" }]);
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
        pinned: false, snoozed: false,
        attachments: [],
      });
      if (item.daemonId === first) {
        assert.throws(() => repository.mutate({
          kind: "importDraft", daemonId: item.daemonId, sourceId: "same-draft", sourceRevision: 2,
          draft: { id: item.draftId, logicalProjectId,
            target: { daemonId: item.daemonId, projectId }, prompt: "retained", selection, updatedAt: 1 },
          pinned: false, snoozed: false,
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
