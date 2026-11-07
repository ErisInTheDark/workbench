/* No production exports. Protect that every vis world payload passes the real observation conformance untouched, and that peer rows follow the declared sync. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkingTreeReadSchema } from "workbench-shared/workbench/git/working-tree-contracts";
import { ProjectFolderListSchema } from "workbench-shared/workbench/project/project-creation";
import { VoiceConfigurationSchema } from "workbench-shared/workbench/voice/voice-session-contract";
import { conformWorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation-conformance";
import type { WorkspaceQuery } from "workbench-shared/workbench/workspace/workspace-observation";
import VisWorld from "./vis-world";

const world = new VisWorld({
  daemons: [{ id: "desk" }, { id: "laptop" }, { id: "pi", asleep: true }],
  projects: [
    { name: "wb", origin: "https://github.com/eris/wb.git", folders: [
      { daemon: "desk", path: "/git/wb", branches: ["voice"], upstream: { name: "origin/main", ahead: 1, behind: 0 },
        commits: [{ subject: "newest", unpushed: true }, { subject: "older" }], stashes: ["wip"], unclaimed: 2 },
      { daemon: "laptop", path: "/git/wb" },
      { daemon: "laptop", path: "/scratch/wb-old", branch: "voice" },
      { daemon: "pi", path: "/srv/wb" },
    ] },
    { name: "notes", folders: [{ daemon: "desk", path: "/notes", branch: null }] },
  ],
  sync: [{ from: "desk:/git/wb", to: "laptop:/git/wb", ahead: 2, behind: 1 }],
});

const desk = world.location("desk:/git/wb");
const queries: WorkspaceQuery[] = [
  { kind: "presentation" }, { kind: "appState", browserStateId: null }, { kind: "projects" }, { kind: "projectGroups" },
  { kind: "projectSelection", projects: [] }, { kind: "projectThreads", projects: null }, { kind: "archivedThreads", projects: null, limit: 10 },
  { kind: "threadSummaries", threadIds: [] }, { kind: "runtime" }, { kind: "reloadOperation" }, { kind: "daemonRuntime" },
  { kind: "daemonUpdate" }, { kind: "network" }, { kind: "accountLimits", provider: "codex", daemonId: null },
  ...world.folders.flatMap(folder => {
    const location = { daemonId: folder.daemon.id, projectId: folder.projectId };
    return [
      { kind: "projectTree", location }, { kind: "workingTreeSummary", location }, { kind: "gitPeers", location },
      { kind: "gitBranches", location }, { kind: "gitHistory", location, limit: 50, peers: [] }, { kind: "gitStashes", location },
    ] satisfies WorkspaceQuery[];
  }),
];

test("every modelled payload passes observation conformance without repairs", () => {
  for (const query of queries) {
    const payload = world.observe(query);
    assert.ok(payload, `${query.kind} is modelled`);
    const conformed = conformWorkspaceObservation({
      ...payload, subscriptionId: "10000000-0000-4000-8000-000000000001", generation: 0, revision: 1,
    });
    assert.ok(conformed.success, `${query.kind} conforms`);
    assert.deepEqual(conformed.repairedPaths, [], `${query.kind} needed no repairs`);
  }
});

test("modelled commands return their daemon results' shapes", () => {
  const deskId = world.daemonId("desk");
  assert.ok(WorkingTreeReadSchema.safeParse(world.command("git/working-tree/read", {}, desk, null)).success);
  assert.ok(VoiceConfigurationSchema.safeParse(world.command("voice/configuration/read", {}, null, deskId)).success);
  assert.equal(world.command("git/working-tree/read", {}, null, deskId), null);
  const listing = ProjectFolderListSchema.parse(world.command("project/folders/list", { path: "/git" }, null, deskId));
  assert.deepEqual(listing.entries.map(entry => [entry.name, entry.isGitRepository]), [["wb", true]]);
  assert.equal(listing.parentPath, "/");
});

test("peer rows mirror declared sync, asleep devices and other branches from both sides", () => {
  const peers = (key: string) => {
    const payload = world.observe({ kind: "gitPeers", location: world.location(key) });
    assert.equal(payload?.kind, "gitPeers");
    return payload.kind === "gitPeers" ? payload.data?.peers ?? [] : [];
  };
  const byPath = (key: string) => Object.fromEntries(peers(key).map(peer => [`${peer.hostname}:${peer.rootPath}`, peer]));
  const fromDesk = byPath("desk:/git/wb");
  assert.deepEqual([fromDesk["laptop:/git/wb"]?.state, fromDesk["laptop:/git/wb"]?.ahead, fromDesk["laptop:/git/wb"]?.behind], ["current", 2, 1]);
  assert.equal(fromDesk["laptop:/scratch/wb-old"]?.state, "otherBranch");
  assert.equal(fromDesk["pi:/srv/wb"]?.state, "offline");
  const fromLaptop = byPath("laptop:/git/wb");
  assert.deepEqual([fromLaptop["desk:/git/wb"]?.ahead, fromLaptop["desk:/git/wb"]?.behind], [1, 2]);
  assert.equal(peers("desk:/notes").length, 0);
});
