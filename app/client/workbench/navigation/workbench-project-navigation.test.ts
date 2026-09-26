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
  createWorkbenchHref, parseWorkbenchRouteFromLocation,
} from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const identities = ["remote://github.com/team/repo", "local:///C:/git/repo", "workspace://members"];

test("longer remote addresses resolve to one project and canonicalise to its shortest slug", () => {
  const id = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const navigation = new WorkbenchProjectNavigation([], [], [{
    id, matchKey: "remote://github.com/team/repo", label: "repo", locations: [],
  }]);
  assert.equal(navigation.href(createLogicalProjectRoute(id)), "/repo");
  for (const address of ["/repo", "/team/repo", "/github.com/team/repo"]) {
    const resolved = navigation.readRoute(address);
    assert.equal(resolved.logical?.projectId, id);
    assert.equal(navigation.href(resolved), "/repo");
  }
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
  assert.equal(navigation.href(createLogicalProjectRoute(id)), "/repo");
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
  assert.equal(navigation.href(navigation.readRoute("/github.com/team/repo")), "/team/repo");
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
  assert.equal(navigation.readRoute(localHref!).logical?.projectId, localId);
  assert.equal(navigation.href(createLogicalProjectRoute(remoteId)), "/team/repo");
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
      createSettingsRoute(address, "project"), createStatsRoute(address),
    ];
    for (const publicRoute of routes.map(route => parseWorkbenchRouteFromLocation(createWorkbenchHref(route)))) {
      const internal = navigation.resolveRoute(publicRoute);
      assert.equal(internal.projectId === address || internal.threadOwnerProjectId === address, false);
      const href = navigation.href(internal);
      assert.equal(href, createWorkbenchHref(publicRoute));
      assert.deepEqual(navigation.resolveRoute(parseWorkbenchRouteFromLocation(href!)), internal);
    }
    assert.equal(navigation.href(createProjectRoute(identity)), "/web/repo");
    assert.equal(navigation.href(navigation.readRoute("/launch", identity)), "/web/repo");
  });
}

test("current retained addresses survive navigation, with deterministic historical links", () => {
  const projectId = ProjectIdSchema.parse(identities[0]);
  const aliases = [{ alias: "old/repo", projectId }, { alias: "older/repo", projectId }];
  const navigation = new WorkbenchProjectNavigation([], aliases);
  assert.equal(navigation.href(createThreadRoute(projectId, "thread"), createProjectRoute("older/repo")), "/older/repo/@/thread/thread");
  assert.equal(navigation.href(createProjectRoute(projectId)), "/old/repo");
  assert.equal(new WorkbenchProjectNavigation([], [...aliases].reverse()).href(createProjectRoute(projectId)), "/old/repo");
  assert.equal(new WorkbenchProjectNavigation([], []).href(createProjectRoute(projectId)), undefined);
  assert.equal(navigation.href(createProjectRoute("legacy/project")), "/legacy/project");
  assert.equal(navigation.readRoute("/unrelated", projectId).projectId, "unrelated");
  assert.equal(navigation.readRoute("/launch").view, "home");
});
