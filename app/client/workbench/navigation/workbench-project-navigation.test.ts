/*
 * Exports: none. Regression tests protect public addresses independently of stored project identities.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import {
  createProjectRoute, createFileRoute, createThreadRoute, createHomeThreadRoute,
  createPinnedThreadRoute, createSettingsRoute, createStatsRoute, createLogicalProjectRoute,
  createLogicalExistingThreadRoute,
  createLogicalThreadRoute, withProjectSelection,
  createToggledProjectSelectionRoute,
  createWorkbenchHref, parseWorkbenchRouteFromLocation,
} from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const identities = ["remote://github.com/team/repo", "local:///C:/git/repo", "workspace://members"];

test("one navigator refreshes project collisions and aliases without freezing thread ownership", () => {
  const firstId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const secondId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const first = { id: firstId, matchKey: "remote://github.com/team/repo", label: "repo", locations: [] };
  const second = { id: secondId, matchKey: "remote://gitlab.com/team/repo", label: "repo", locations: [] };
  const location = {
    daemonId: DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c"),
    projectId: ProjectIdSchema.parse("owner-folder"),
  };
  let owner: typeof location | null = null;
  const navigator = new WorkbenchProjectNavigation([], [], [first], () => owner);
  const projectRoute = createLogicalProjectRoute(firstId);
  const threadRoute = createLogicalExistingThreadRoute(firstId, {
    kind: "provider", threadId: ThreadReferenceSchema.parse("thread-uuid"),
  });
  assert.equal(navigator.href(projectRoute), "/repo/@/");
  assert.equal(navigator.href(threadRoute), undefined);

  navigator.update([], [], [first, { ...second, locations: [{
    target: location, daemonId: location.daemonId, hostname: "desktop",
    name: "repo", rootPath: "C:/repo", project: null,
  }] }]);
  assert.equal(navigator.readRoute("/repo").view, "invalid");
  assert.equal(navigator.href(projectRoute), "/github.com/team/repo/@/");
  owner = location;
  assert.equal(navigator.href(threadRoute), "/github.com/team/repo/@/pin/gitlab.com/team/repo/@/thread/thread-uuid");

  const physicalId = ProjectIdSchema.parse("physical-project");
  navigator.update([], [{ alias: "old-project", projectId: physicalId }], []);
  assert.equal(navigator.readRoute("/old-project").projectId, physicalId);
  navigator.update([], [], []);
  assert.equal(navigator.readRoute("/old-project").projectId, "old-project");
});

test("multi-project addresses keep selection independent of a draft owner", () => {
  const first = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const second = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const navigation = new WorkbenchProjectNavigation([], [], [
    { id: first, matchKey: "remote://github.com/team/one", label: "one", locations: [] },
    { id: second, matchKey: "remote://github.com/team/two", label: "two", locations: [] },
  ]);
  const selected = navigation.readRoute("/one/+/two/@/");
  assert.deepEqual(selected.selectedProjectIds, [first, second]);
  assert.equal(selected.logical?.projectId, null);
  assert.equal(navigation.href(selected), "/one/+/two/@/");
  const draft = withProjectSelection(createLogicalThreadRoute(null, first, null, { kind: "new" }), [first, second]);
  const href = navigation.href(draft);
  assert.equal(href, "/one/+/two/@/thread/one/@/new");
  const restored = navigation.readRoute(href!);
  assert.deepEqual(restored.selectedProjectIds, [first, second]);
  assert.equal(restored.logical?.threadOwnerProjectId, first);
});

test("thread links inherit selection while an explicit project toggle changes it", () => {
  const first = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const second = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const navigation = new WorkbenchProjectNavigation([], [], [
    { id: first, matchKey: "remote://github.com/team/one", label: "one", locations: [] },
    { id: second, matchKey: "remote://github.com/team/two", label: "two", locations: [] },
  ]);
  const current = navigation.readRoute("/one/@/thread/t1");
  const toggled = createToggledProjectSelectionRoute(current, [first], second, [first, second]);
  assert.equal(navigation.href(toggled, current, "inherit"), "/one/@/thread/t1");
  assert.equal(navigation.href(toggled, current, "exact"), "/one/+/two/@/thread/one/@/t1");
});

test("statistics keep a logical multi-project selection and stay on statistics when the selection changes", () => {
  const first = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const second = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const navigation = new WorkbenchProjectNavigation([], [], [
    { id: first, matchKey: "remote://github.com/team/one", label: "one", locations: [] },
    { id: second, matchKey: "remote://github.com/team/two", label: "two", locations: [] },
  ]);
  const stats = navigation.readRoute("/one/+/two/@/stats");
  assert.equal(stats.view, "stats");
  assert.deepEqual(stats.selectedProjectIds, [first, second]);
  assert.equal(navigation.href(stats), "/one/+/two/@/stats");
  const narrowed = createToggledProjectSelectionRoute(stats, [first, second], second, [first, second]);
  assert.equal(navigation.href(narrowed), "/one/@/stats");
  assert.equal(navigation.href(withProjectSelection(createStatsRoute(null), null)), "/@/stats");
});

test("longer remote addresses resolve to one project and canonicalise to its shortest slug", () => {
  const id = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const navigation = new WorkbenchProjectNavigation([], [], [{
    id, matchKey: "remote://github.com/team/repo", label: "repo", locations: [],
  }]);
  assert.equal(navigation.href(createLogicalProjectRoute(id)), "/repo/@/");
  for (const address of ["/repo", "/team/repo", "/github.com/team/repo"]) {
    const resolved = navigation.readRoute(address);
    assert.equal(resolved.logical?.projectId, id);
    assert.equal(navigation.href(resolved), "/repo/@/");
  }
});

test("local discovery paths canonicalise to their shortest unique suffix", () => {
  const firstId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const secondId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const daemonId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const localProject = (id: typeof firstId, projectId: string, relativePath: string, rootPath: string) => ({
    id, matchKey: `local://${rootPath}/.git`, label: rootPath,
    locations: [{
      target: { daemonId, projectId: ProjectIdSchema.parse(projectId) }, daemonId,
      hostname: "desktop", name: "bak", rootPath,
      project: {
        id: ProjectIdSchema.parse(projectId), kind: "git" as const, name: "bak",
        relativePath, rootPath, roots: [], lastCommitTimeMs: null,
      },
    }],
  });
  const bak = localProject(firstId, "app/bak", "app/bak", "C:/git/app/bak");
  const other = localProject(secondId, "other/bak", "other/bak", "C:/git/other/bak");
  const single = new WorkbenchProjectNavigation([], [], [bak]);
  assert.equal(single.href(createLogicalProjectRoute(firstId)), "/bak/@/");
  assert.equal(single.readRoute("/app/bak").logical?.projectId, firstId);
  assert.equal(single.href(single.readRoute("/C%3A/git/app/bak")), "/bak/@/");

  const collision = new WorkbenchProjectNavigation([], [], [bak, other]);
  assert.equal(collision.readRoute("/bak").view, "invalid");
  assert.equal(collision.href(createLogicalProjectRoute(firstId)), "/app/bak/@/");
  assert.equal(collision.href(createLogicalProjectRoute(secondId)), "/other/bak/@/");

  const thirdId = LogicalProjectIdSchema.parse("b12f7e1e-81b6-4c30-bdc0-f83475981003");
  const sameRelativePath = new WorkbenchProjectNavigation([], [], [
    bak, localProject(thirdId, "another/app/bak", "app/bak", "D:/git/app/bak"),
  ]);
  assert.equal(sameRelativePath.readRoute("/app/bak").view, "invalid");
  assert.equal(sameRelativePath.href(createLogicalProjectRoute(firstId)), "/c/git/app/bak/@/");
  assert.equal(sameRelativePath.href(createLogicalProjectRoute(thirdId)), "/d/git/app/bak/@/");
  assert.equal(sameRelativePath.readRoute("/c/git/app/bak").logical?.projectId, firstId);
  assert.equal(sameRelativePath.href(sameRelativePath.readRoute("/C%3A/git/app/bak")), "/c/git/app/bak/@/");
});

test("a local route resolves from presentation before its daemon catalogue attaches", () => {
  const firstId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const secondId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const daemonId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const local = (id: typeof firstId, rootPath: string) => ({
    id, matchKey: `local://${rootPath}/.git`, label: rootPath,
    locations: [{
      target: { daemonId, projectId: ProjectIdSchema.parse(id) },
      daemonId, hostname: "desktop", name: "bak", rootPath, project: null,
    }],
  });
  const bak = local(firstId, "C:/git/app/bak");
  const single = new WorkbenchProjectNavigation([], [], [bak]);
  assert.equal(single.readRoute("/bak/@/thread/example").logical?.projectId, firstId);
  assert.equal(single.href(createLogicalProjectRoute(firstId)), "/bak/@/");

  const collision = new WorkbenchProjectNavigation([], [], [bak, local(secondId, "C:/git/other/bak")]);
  assert.equal(collision.readRoute("/bak").view, "invalid");
  assert.equal(collision.href(createLogicalProjectRoute(firstId)), "/app/bak/@/");
  assert.equal(collision.href(createLogicalProjectRoute(secondId)), "/other/bak/@/");
});

test("a concrete project address keeps its logical selection when opening a thread", () => {
  const logicalId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const location = {
    daemonId: DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c"),
    projectId,
  };
  const project = {
    id: projectId, kind: "git" as const, name: "workbench", relativePath: "workbench",
    rootPath: "C:/workbench", roots: [], lastCommitTimeMs: null,
  };
  const navigation = new WorkbenchProjectNavigation([project], [], [{
    id: logicalId, matchKey: "remote://github.com/team/workbench", label: "workbench",
    locations: [{
      target: location, daemonId: location.daemonId, hostname: "desktop",
      name: "workbench", rootPath: project.rootPath, project,
    }],
  }], () => location);
  const selected = navigation.resolveRoute(createProjectRoute(projectId));
  assert.equal(selected.logical?.projectId, logicalId);
  const target = createLogicalExistingThreadRoute(selected.logical?.projectId ?? null, {
    kind: "provider", threadId: ThreadReferenceSchema.parse("thread-uuid"),
  });
  const href = navigation.href(target);
  assert.ok(href);
  assert.equal(navigation.readRoute(href).logical?.projectId, logicalId);
});

test("a display label cannot become a project address", () => {
  const id = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const navigation = new WorkbenchProjectNavigation([], [], [{
    id, matchKey: "remote://github.com/team/repo", label: "friendly", locations: [],
  }]);
  assert.equal(navigation.readRoute("/friendly").logical, undefined);
  assert.equal(navigation.href(createLogicalProjectRoute(id)), "/repo/@/");
});

test("remote collisions reject a short alias instead of guessing and keep the longer owner", () => {
  const firstId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const secondId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const navigation = new WorkbenchProjectNavigation([], [], [
    { id: firstId, matchKey: "remote://github.com/team/repo", label: "team/repo", locations: [] },
    { id: secondId, matchKey: "remote://github.com/other/repo", label: "other/repo", locations: [] },
  ]);
  assert.equal(navigation.readRoute("/repo").view, "invalid");
  assert.equal(navigation.readRoute("/team/repo").logical?.projectId, firstId);
  assert.equal(navigation.readRoute("/github.com/team/repo").logical?.projectId, firstId);
  assert.equal(navigation.href(navigation.readRoute("/github.com/team/repo")), "/team/repo/@/");
  assert.equal(navigation.readRoute("/team/repo/@/pin/missing/@/thread/id").view, "invalid");
});

test("a local name collision cannot steal a former remote short link", () => {
  const remoteId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const localId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const navigation = new WorkbenchProjectNavigation([], [], [
    { id: remoteId, matchKey: "remote://github.com/team/repo",
      storedLabel: "team/repo", label: "team/repo", locations: [] },
    { id: localId, matchKey: "local://C:/git/repo",
      storedLabel: "repo", label: "local://C:/git/repo", locations: [] },
  ]);
  assert.equal(navigation.readRoute("/repo").view, "invalid");
  const localHref = navigation.href(createLogicalProjectRoute(localId));
  assert.equal(localHref, `/${localId}/@/`);
  assert.equal(navigation.readRoute(localHref!).logical?.projectId, localId);
  assert.equal(navigation.href(createLogicalProjectRoute(remoteId)), "/team/repo/@/");
});

test("a UUID link needs its verified owner and does not borrow the selected project", () => {
  const firstId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const secondId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const ownerLocation = {
    daemonId: DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c"),
    projectId: ProjectIdSchema.parse("owner-folder"),
  };
  const projects = [
    { id: firstId, matchKey: "remote://github.com/team/repo", label: "repo", locations: [] },
    { id: secondId, matchKey: "remote://github.com/team/other", label: "other",
      locations: [{ target: ownerLocation, daemonId: ownerLocation.daemonId, hostname: "desktop",
        name: "other", rootPath: "C:/other", project: null }] },
  ] satisfies ConstructorParameters<typeof WorkbenchProjectNavigation>[2];
  const route = createLogicalExistingThreadRoute(firstId, {
    kind: "provider", threadId: ThreadReferenceSchema.parse("thread-uuid"),
  });
  assert.equal(new WorkbenchProjectNavigation([], [], projects).href(route), undefined);
  const navigation = new WorkbenchProjectNavigation([], [], projects, () => ownerLocation);
  assert.equal(navigation.href(route), "/repo/@/pin/other/@/thread/thread-uuid");
});

test("a verified observed-only thread still has a Home link", () => {
  const id = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const location = {
    daemonId: DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c"),
    projectId: ProjectIdSchema.parse("owner-folder"),
  };
  const threadId = ThreadReferenceSchema.parse("observed-thread");
  const navigation = new WorkbenchProjectNavigation([], [], [{
    id, matchKey: "remote://github.com/team/repo", label: "repo", locations: [],
    observedLocations: [{
      ...location, hostname: "desktop", rootPath: "C:/repo",
      project: {
        id: location.projectId, kind: "git", name: "repo", relativePath: "repo",
        rootPath: "C:/repo", lastCommitTimeMs: null, roots: [],
      },
    }],
  }], () => location);
  assert.equal(navigation.href(createLogicalExistingThreadRoute(null, { kind: "provider", threadId })),
    `/@/thread/repo/@/${threadId}`);
});

function createFolderNavigation() {
  const first = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const second = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const one = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const two = DaemonIdSchema.parse("9b8f5ac2-1c44-4f0e-9d22-77f50b0f4b11");
  const workbenchOnOne = {
    target: { daemonId: one, projectId: ProjectIdSchema.parse("repo-a") },
    daemonId: one, hostname: "alpha", name: "workbench", rootPath: "/home/me/workbench", project: null,
  };
  const workbenchOnTwo = {
    target: { daemonId: two, projectId: ProjectIdSchema.parse("repo-b") },
    daemonId: two, hostname: "beta", name: "workbench", rootPath: "/srv/other/workbench", project: null,
  };
  const worktree = {
    target: { daemonId: one, projectId: ProjectIdSchema.parse("repo-c") },
    daemonId: one, hostname: "alpha", name: "convex-lab",
    rootPath: "/home/me/repo/.workbench/worktrees/convex-lab", project: null,
  };
  const navigation = new WorkbenchProjectNavigation([], [], [{
    id: first, matchKey: "remote://github.com/team/one", label: "one", locations: [workbenchOnOne],
  }, {
    id: second, matchKey: "remote://github.com/team/two", label: "two",
    locations: [workbenchOnTwo, worktree],
  }]);
  return { first, navigation, second, workbenchOnOne, workbenchOnTwo, worktree };
}

test("a folder equal to its project address is omitted from the path as redundant", () => {
  const id = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const daemonId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const folder = {
    target: { daemonId, projectId: ProjectIdSchema.parse("repo") },
    daemonId, hostname: "alpha", name: "workbench", rootPath: "/home/me/workbench", project: null,
  };
  const navigation = new WorkbenchProjectNavigation([], [], [{
    id, matchKey: "remote://github.com/team/workbench", label: "workbench", locations: [folder],
  }]);
  assert.equal(navigation.folderAddressFor(folder.target), null);
  assert.deepEqual(navigation.href(withProjectSelection(createProjectRoute(""), [id])), "/workbench/@/");
  // A folder that still needs its slot keeps it.
  const worktree = {
    target: { daemonId, projectId: ProjectIdSchema.parse("repo-lab") },
    daemonId, hostname: "alpha", name: "convex-lab",
    rootPath: "/home/me/repo/.workbench/worktrees/convex-lab", project: null,
  };
  const multi = new WorkbenchProjectNavigation([], [], [{
    id, matchKey: "remote://github.com/team/workbench", label: "workbench",
    locations: [folder, worktree],
  }]);
  assert.deepEqual(multi.folderAddressFor(worktree.target), ["+convex-lab"]);
});

test("folder addresses disambiguate colliding paths across daemons and never guess", () => {
  const { navigation, workbenchOnOne, workbenchOnTwo, worktree } = createFolderNavigation();
  assert.deepEqual(navigation.folderAddressFor(workbenchOnOne.target), [workbenchOnOne.daemonId, "workbench"]);
  assert.deepEqual(navigation.folderAddressFor(workbenchOnTwo.target), [workbenchOnTwo.daemonId, "workbench"]);
  assert.deepEqual(navigation.folderAddressFor(worktree.target), ["+convex-lab"]);
  assert.deepEqual(navigation.folderForAddress(["+convex-lab"]), worktree.target);
  assert.deepEqual(navigation.folderForAddress([workbenchOnOne.daemonId, "workbench"]), workbenchOnOne.target);
  assert.equal(navigation.folderForAddress(["workbench"]), null);
  assert.equal(navigation.folderForAddress(["missing"]), null);
});

test("folder selection rides hrefs and stays scoped to its owning project", () => {
  const { first, navigation, second, worktree } = createFolderNavigation();
  const current = {
    ...createProjectRoute(""), selectedProjectIds: [first, second], folderAddress: ["+convex-lab"],
  };
  const href = navigation.href(createLogicalThreadRoute(first, first, null, { kind: "new" }), current, "inherit");
  assert.deepEqual(parseWorkbenchRouteFromLocation(href!).folderAddress, ["+convex-lab"]);

  const outOfScope = withProjectSelection(
    { ...createThreadRoute("repo-a", "t1"), folderAddress: ["+convex-lab"] }, [first]);
  assert.equal(navigation.folderForRoute(outOfScope), null);
  const inScope = withProjectSelection(
    { ...createThreadRoute("repo-a", "t1"), folderAddress: ["+convex-lab"] }, [second]);
  assert.deepEqual(navigation.folderForRoute(inScope), worktree.target);
});

test("catalogue addresses replace junction aliases without changing thread identity", () => {
  const projectId = ProjectIdSchema.parse(identities[0]);
  const alias = ".pnpm-store/v11/projects/hash";
  const navigation = new WorkbenchProjectNavigation([{
    id: projectId, relativePath: "web/repo", name: "repo", kind: "git", rootPath: "C:/git/repo",
    roots: [], lastCommitTimeMs: null,
  }], [{ alias, projectId }]);
  const incoming = createThreadRoute(alias, "thread");
  const resolved = navigation.resolveRoute(incoming);
  assert.equal(navigation.href(resolved, incoming), "/web/repo/@/thread/thread");
  assert.deepEqual(navigation.readRoute(navigation.href(resolved, incoming)!), resolved);
});

for (const identity of identities) {
  test(`public routes retain their address for ${identity}`, () => {
    const projectId = ProjectIdSchema.parse(identity);
    const otherId = ProjectIdSchema.parse("remote://github.com/team/other");
    const address = "web/repo";
    const navigation = new WorkbenchProjectNavigation([{
      id: projectId, relativePath: address, name: "repo", kind: "git", rootPath: "C:/git/repo",
      roots: [], lastCommitTimeMs: null,
    }, {
      id: otherId, relativePath: "other/project", name: "other", kind: "git", rootPath: "C:/git/other",
      roots: [], lastCommitTimeMs: null,
    }], [{ alias: address, projectId }, { alias: "other/project", projectId: otherId }]);
    const routes = [
      createProjectRoute(address), createFileRoute(address, "src/a file.ts"),
      createThreadRoute(address, "thread"), createHomeThreadRoute(address, "thread"),
      createPinnedThreadRoute("other/project", address, "thread"),
      createSettingsRoute(address), createStatsRoute(address),
    ];
    for (const publicRoute of routes.map(route => parseWorkbenchRouteFromLocation(createWorkbenchHref(route)))) {
      const internal = navigation.resolveRoute(publicRoute);
      assert.equal(internal.projectId === address || internal.threadOwnerProjectId === address, false);
      const href = navigation.href(internal);
      assert.equal(href, createWorkbenchHref(publicRoute));
      assert.deepEqual(navigation.resolveRoute(parseWorkbenchRouteFromLocation(href!)), internal);
    }
    assert.equal(navigation.href(createProjectRoute(identity)), "/web/repo/@/");
    assert.equal(navigation.href(navigation.readRoute("/launch", identity)), "/web/repo/@/");
  });
}

test("current retained addresses survive navigation, with deterministic historical links", () => {
  const projectId = ProjectIdSchema.parse(identities[0]);
  const aliases = [{ alias: "old/repo", projectId }, { alias: "older/repo", projectId }];
  const navigation = new WorkbenchProjectNavigation([], aliases);
  assert.equal(navigation.href(createThreadRoute(projectId, "thread"), createProjectRoute("older/repo")), "/older/repo/@/thread/thread");
  assert.equal(navigation.href(createProjectRoute(projectId)), "/old/repo/@/");
  assert.equal(new WorkbenchProjectNavigation([], [...aliases].reverse()).href(createProjectRoute(projectId)), "/old/repo/@/");
  assert.equal(new WorkbenchProjectNavigation([], []).href(createProjectRoute(projectId)), undefined);
  assert.equal(navigation.href(createProjectRoute("legacy/project")), "/legacy/project/@/");
  assert.equal(navigation.readRoute("/unrelated", projectId).projectId, "unrelated");
  assert.equal(navigation.readRoute("/launch").view, "home");
});
