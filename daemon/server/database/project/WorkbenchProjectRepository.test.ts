/* No production exports. Tests protect stable project ownership, discovery evidence and source-fenced icon settlement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { ProjectIdentityKeySchema } from "workbench-shared/workbench/identity";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchProjectRepository from "./WorkbenchProjectRepository";
import type { WorkbenchProjectCandidate, WorkbenchProjectDiscovery } from "./workbench-project-persistence";

function project(rootPath = "/repo", key = "remote://example.test/owner/repo"): WorkbenchProjectCandidate {
  const identityKey = ProjectIdentityKeySchema.parse(key);
  return {
    identityKey, kind: "git", name: "repo", rootPath, relativePath: "repo", lastCommitTimeMs: 1_750_000_000_000.625,
    roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath, identityKey }],
  };
}

function discovery(data: WorkbenchProjectCandidate[], overrides: Partial<WorkbenchProjectDiscovery> = {}): WorkbenchProjectDiscovery {
  return { data, aliases: [], rootPath: "/", excludedRootPaths: [], complete: true,
    observedKeys: data.flatMap(item => [item.identityKey, ...item.roots.map(root => root.identityKey)]), ...overrides };
}

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return { database, repository: new WorkbenchProjectRepository(database) };
}

test("a changed remote at the same checkout retains its durable owner across reopening and reversal", () => {
  const { database, repository } = setup();
  try {
    const original = project();
    const changed = project("/repo", "remote://example.test/new-owner/repo");
    const owner = repository.reconcile(discovery([original])).catalog[0]!.project.id;
    assert.notEqual(owner, original.identityKey);
    assert.equal(repository.reconcile(discovery([changed])).catalog[0]!.project.id, owner);
    const reopened = new WorkbenchProjectRepository(database);
    assert.equal(reopened.reconcile(discovery([changed])).catalog[0]!.project.id, owner);
    assert.equal(reopened.reconcile(discovery([original])).catalog[0]!.project.id, owner);
    assert.equal(reopened.requireStoredReference(changed.identityKey), owner);
    assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 1);
  } finally { database.close(); }
});

test("two concrete checkouts sharing one remote retain separate project owners", () => {
  const { database, repository } = setup();
  try {
    const first = project("/first");
    const second = project("/second");
    const catalog = repository.reconcile(discovery([first, second])).catalog;
    assert.equal(catalog.length, 2);
    assert.notEqual(catalog[0]!.project.id, catalog[1]!.project.id);
    const reopened = new WorkbenchProjectRepository(database).reconcile(discovery([second, first])).catalog;
    assert.equal(reopened.find(item => item.project.rootPath === "/first")?.project.id,
      catalog.find(item => item.project.rootPath === "/first")?.project.id);
  } finally { database.close(); }
});

test("a reused discovery address cannot hide a new checkout or steal its retained alias", () => {
  const { database, repository } = setup();
  try {
    const legacy = project("/legacy");
    const newcomer = project("/isolated");
    const oldOwner = repository.reconcile(discovery([legacy], {
      aliases: [{ alias: "fixture", identityKey: legacy.identityKey }],
    })).catalog[0]!.project.id;
    const result = repository.reconcile(discovery([newcomer], {
      aliases: [{ alias: "fixture", identityKey: newcomer.identityKey }],
    }));
    assert.equal(result.catalog.length, 1);
    assert.notEqual(result.catalog[0]?.project.id, oldOwner);
    assert.equal(repository.requireStoredReference("fixture"), oldOwner);
    assert.deepEqual(result.excludedRootPaths, []);
  } finally { database.close(); }
});

test("an unaliased remote cannot choose an arbitrary owner when several locations match", () => {
  const { database, repository } = setup();
  try {
    const identity = "remote://example.test/owner/repo";
    database.prepare("INSERT INTO workbench_projects(id, identity_key) VALUES (?, ?)")
      .run("00000000-0000-4000-8000-000000000001", identity);
    database.prepare("INSERT INTO workbench_projects(id, identity_key) VALUES (?, ?)")
      .run("00000000-0000-4000-8000-000000000002", identity);
    assert.throws(() => repository.admitStoredReference(identity), /ambiguous/u);
  } finally { database.close(); }
});

test("remote changes at one checkout retain its owner despite incomplete scans or other locations", () => {
  for (const evidence of ["incomplete", "old-present", "reserved"] as const) {
    const { database, repository } = setup();
    try {
      const original = project();
      const changed = project("/repo", "remote://example.test/new/repo");
      const owner = repository.reconcile(discovery([original])).catalog[0]!.project.id;
      if (evidence === "reserved") {
        repository.reconcile(discovery([original, project("/independent", changed.identityKey)]));
        repository.reconcile(discovery([original, project("/independent", "remote://example.test/renamed/independent")]));
      }
      const snapshot = discovery([changed], {
        complete: evidence !== "incomplete",
        observedKeys: evidence === "old-present" ? [original.identityKey, changed.identityKey] : [changed.identityKey],
      });
      const result = repository.reconcile(snapshot);
      assert.equal(result.catalog.find(item => item.project.rootPath === original.rootPath)?.project.id, owner);
      assert.ok(!result.excludedRootPaths.includes(original.rootPath));
      assert.equal(repository.requireStoredReference(original.identityKey), owner);
    } finally { database.close(); }
  }
});

test("changing a checkout to another location's remote cannot transfer its owner", () => {
  const { database, repository } = setup();
  try {
    const original = project();
    const other = project("/independent", "remote://example.test/independent/repo");
    const initial = repository.reconcile(discovery([original, other])).catalog;
    const firstId = initial.find(item => item.project.rootPath === "/repo")!.project.id;
    const otherId = initial.find(item => item.project.rootPath === "/independent")!.project.id;
    const result = repository.reconcile(discovery([project("/repo", other.identityKey)]));
    assert.equal(result.catalog[0]?.project.id, firstId);
    assert.notEqual(result.catalog[0]?.project.id, otherId);
    assert.equal(repository.requireStoredReference(otherId), otherId);
  } finally { database.close(); }
});

test("discovery order cannot move an owner to another checkout sharing its old remote", () => {
  for (const reverse of [false, true]) {
    const { database, repository } = setup();
    try {
      const original = project();
      const owner = repository.reconcile(discovery([original])).catalog[0]!.project.id;
      const candidates = [project("/elsewhere"), project("/repo", "remote://example.test/new/repo")];
      const result = repository.reconcile(discovery(reverse ? candidates.reverse() : candidates));
      assert.equal(result.catalog.length, 2);
      assert.equal(result.catalog.find(item => item.project.rootPath === "/repo")?.project.id, owner);
      assert.notEqual(result.catalog.find(item => item.project.rootPath === "/elsewhere")?.project.id, owner);
    } finally { database.close(); }
  }
});

test("serving reference resolution cannot admit unknown project ownership", () => {
  const { database, repository } = setup();
  try {
    for (const id of ["remote:/example.test/owner/repo", "remote://example.test/owner/missing"]) {
      assert.throws(() => repository.requireStoredReference(id), /project/i);
      assert.throws(() => repository.resolve(id), /project/i);
    }
    assert.equal(database.prepare("SELECT count(*) FROM workbench_projects").pluck().get(), 0);
    const item = project();
    const owner = repository.reconcile(discovery([item], { aliases: [{ alias: "old/repo", identityKey: item.identityKey }] })).catalog[0]!.project.id;
    assert.equal(repository.requireStoredReference("old/repo"), owner);
    repository.reconcile(discovery([]));
    assert.equal(repository.requireStoredReference(owner), owner);
  } finally { database.close(); }
});

test("positive and negative icon results survive repeated catalogue reads and repository replacement", () => {
  const { database, repository } = setup();
  try {
    const item = project();
    const initial = repository.reconcile(discovery([item])).catalog[0]!;
    const projectId = initial.project.id;
    assert.equal(initial.checkedAt, null);
    const icon = { rootId: "repo", path: "public/favicon.png" };
    assert.equal(repository.settleIcon({ projectId, sourceKey: initial.sourceKey, checkedAt: 100, icon }), true);
    const replacement = new WorkbenchProjectRepository(database);
    const cached = replacement.reconcile(discovery([{ ...item, name: "renamed label" }])).catalog[0]!;
    assert.equal(cached.checkedAt, 100);
    assert.deepEqual(cached.project.icon, icon);
    assert.equal(replacement.settleIcon({ projectId, sourceKey: cached.sourceKey, checkedAt: 200, icon: null }), true);
    const absent = new WorkbenchProjectRepository(database).reconcile(discovery([item])).catalog[0]!;
    assert.equal(absent.checkedAt, 200);
    assert.equal(absent.project.icon, undefined);
  } finally { database.close(); }
});

test("a new checkout has a new owner and cannot receive an old checkout's icon result", () => {
  const { database, repository } = setup();
  try {
    const before = repository.reconcile(discovery([project()])).catalog[0]!;
    const projectId = before.project.id;
    const moved = repository.reconcile(discovery([project("/new-location")])).catalog[0]!;
    const icon = { rootId: "repo", path: "favicon.png" };
    assert.notEqual(moved.project.id, before.project.id);
    assert.equal(repository.settleIcon({ projectId, sourceKey: before.sourceKey, checkedAt: 300, icon }), false);
    assert.equal(repository.settleIcon({ projectId: moved.project.id, sourceKey: moved.sourceKey, checkedAt: 200, icon }), true);
    assert.equal(repository.settleIcon({ projectId: moved.project.id, sourceKey: moved.sourceKey, checkedAt: 100, icon: null }), false);
    assert.equal(repository.reconcile(discovery([project("/new-location")])).catalog[0]?.checkedAt, 200);
    assert.throws(() => repository.settleIcon({
      projectId: moved.project.id, sourceKey: moved.sourceKey, checkedAt: 400, icon: { rootId: "foreign", path: "favicon.png" },
    }), /root|FOREIGN KEY/i);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("missing projects retain their cache without remaining in the current catalogue", () => {
  const { database, repository } = setup();
  try {
    const item = project();
    const initial = repository.reconcile(discovery([item])).catalog[0]!;
    repository.settleIcon({ projectId: initial.project.id, sourceKey: initial.sourceKey, checkedAt: 100, icon: null });
    assert.deepEqual(repository.reconcile(discovery([])).catalog, []);
    assert.equal(new WorkbenchProjectRepository(database).reconcile(discovery([item])).catalog[0]?.checkedAt, 100);
  } finally { database.close(); }
});

test("returning to earlier roots does not admit an earlier generation's late icon result", () => {
  const { database, repository } = setup();
  try {
    const original = repository.reconcile(discovery([project("/a")])).catalog[0]!;
    repository.reconcile(discovery([project("/b")]));
    const returned = repository.reconcile(discovery([project("/a")])).catalog[0]!;
    assert.notEqual(returned.sourceKey, original.sourceKey);
    assert.equal(repository.settleIcon({
      projectId: original.project.id, sourceKey: original.sourceKey, checkedAt: 500, icon: { rootId: "repo", path: "old/favicon.png" },
    }), false);
    assert.equal(returned.checkedAt, null);
  } finally { database.close(); }
});

test("equivalent workspace descriptions preserve the current binding or choose a stable replacement", () => {
  const { database, repository } = setup();
  try {
    const workspace = (workspacePath: string): WorkbenchProjectCandidate => ({
      ...project(), identityKey: ProjectIdentityKeySchema.parse("workspace://members"), kind: "workspace",
      workspacePath, relativePath: workspacePath,
    });
    const a = workspace("/a.code-workspace");
    const b = workspace("/b.code-workspace");
    const initial = repository.reconcile(discovery([b])).catalog[0]!;
    repository.settleIcon({ projectId: initial.project.id, sourceKey: initial.sourceKey, checkedAt: 100, icon: null });
    const retained = repository.reconcile(discovery([a, b])).catalog;
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.project.workspacePath, b.workspacePath);
    assert.equal(retained[0]!.checkedAt, 100);
    assert.equal(repository.reconcile(discovery([b, a])).catalog[0]!.project.workspacePath, b.workspacePath);
    assert.equal(repository.reconcile(discovery([a])).catalog[0]!.project.workspacePath, a.workspacePath);
    const fresh = setup();
    try { assert.equal(fresh.repository.reconcile(discovery([b, a])).catalog[0]!.project.workspacePath, a.workspacePath); }
    finally { fresh.database.close(); }
    const clones = repository.reconcile(discovery([project("/a"), project("/b")])).catalog;
    assert.equal(clones.length, 2);
    assert.notEqual(clones[0]!.project.id, clones[1]!.project.id);
  } finally { database.close(); }
});

test("workspace member remote changes retain ownership but member-set changes do not", () => {
  const { database, repository } = setup();
  try {
    const workspace = (key: string, roots: WorkbenchProjectCandidate["roots"]): WorkbenchProjectCandidate => ({
      ...project(), identityKey: ProjectIdentityKeySchema.parse(key), kind: "workspace", workspacePath: "/workspace.code-workspace", roots,
    });
    const original = workspace("workspace://before", project().roots);
    const snapshot = (candidate: WorkbenchProjectCandidate) => discovery([candidate], {
      aliases: [{ alias: "workspace.code-workspace", identityKey: candidate.identityKey }],
    });
    const owner = repository.reconcile(snapshot(original)).catalog[0]!.project.id;
    const changed = workspace("workspace://after", project("/repo", "remote://example.test/new/repo").roots);
    assert.equal(repository.reconcile(snapshot(changed)).catalog[0]!.project.id, owner);
    const different = workspace("workspace://different", [...changed.roots, { ...project("/second", "remote://example.test/second").roots[0]!, id: "second", isPrimary: false }]);
    assert.notEqual(repository.reconcile(snapshot(different)).catalog[0]!.project.id, owner);
    const repeated = repository.reconcile(snapshot(different)).catalog[0]!.project.id;
    assert.notEqual(repeated, owner);
    assert.equal(repository.resolve("workspace.code-workspace"), owner);
  } finally { database.close(); }
});
