/* No production exports. Protect owner-bound preference reads, writes, inheritance and unavailable-owner fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { createLogicalFileRoute } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import ProjectFactsStore from "../../workbench/project/ProjectFactsStore";
import WorkbenchProjectNavigation from "../../workbench/navigation/workbench-project-navigation";
import type { WorkspaceQuerySnapshot } from "../../workbench/app/WorkbenchWorkspaceClient";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import { WorkbenchClientStateContext } from "./workbench-client-state-context";
import type { WorkbenchClientController } from "./workbench-client-context";
import { useSettings } from "./use-settings";

function fixture() {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const readSnapshot = state.getSnapshot;
  state.getSnapshot = () => ({ ...readSnapshot(),
    schemaVersion: Math.max(...Object.values(appStateReleases).map(release => release.version)) });
  const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const locations = ["alpha", "beta"].map(name => ({ daemonId, projectId: ProjectIdSchema.parse(name) }));
  const projects: WorkbenchLogicalProject[] = locations.map((location, index) => ({
    id: LogicalProjectIdSchema.parse(`00000000-0000-4000-8000-00000000000${index + 2}`),
    label: location.projectId, matchKey: `remote://github.com/team/${location.projectId}`,
    locations: [{ target: location, daemonId, hostname: "local", name: location.projectId,
      rootPath: `/${location.projectId}`, project: null }],
  }));
  const projectHandle = {
    getSnapshot: (): WorkspaceQuerySnapshot<"projects"> => ({ phase: "current", failure: null, value: {
      subscriptionId: "settings-projects", generation: 1, revision: 1, phase: "current", failure: null,
      kind: "projects", data: {
        projects, summaries: {}, observedProjects: [], sources: [], catalogues: [], navigation: [],
      },
    } }),
    release: () => {},
  };
  const groupHandle = { getSnapshot: (): WorkspaceQuerySnapshot<"projectGroups"> => ({
    phase: "pending", failure: null, value: null,
  }), release: () => {} };
  function observe(query: { kind: "projects" }): typeof projectHandle;
  function observe(query: { kind: "projectGroups" }): typeof groupHandle;
  function observe(query: { kind: "projects" | "projectGroups" }) {
    return query.kind === "projects" ? projectHandle : groupHandle;
  }
  const projectFacts = new ProjectFactsStore({ observe }, () => {});
  let owner: ProjectLocationReference | null = locations[0]!;
  const mounted: Pick<NonNullable<WorkbenchClientController["mounted"]>,
    "projectFacts" | "threadOwnerFor" | "draftLocationFor" | "subscribeChanges"> = {
    projectFacts,
    threadOwnerFor: () => owner ? { ...owner, hostname: "local", rootPath: "/alpha", displayPath: "/alpha" } : null,
    draftLocationFor: () => owner,
    subscribeChanges: () => () => {},
  };
  const client: WorkbenchClientController = { controls: null,
    mounted: mounted as NonNullable<WorkbenchClientController["mounted"]> };
  function read<Value>(hook: () => Value): Value {
    let result!: Value;
    function Probe() { result = hook(); return null; }
    renderToStaticMarkup(<WorkbenchClientStateContext.Provider value={state}>
      <WorkbenchClientProvider client={client}><Probe /></WorkbenchClientProvider>
    </WorkbenchClientStateContext.Provider>);
    return result;
  }
  return { state, projects, locations, client, read, projectFacts, setOwner: (next: ProjectLocationReference | null) => { owner = next; } };
}

test("settings get/set/reset share the logical owner and preserve global inheritance", async () => {
  const f = fixture();
  const global = () => f.read(() => useSettings());
  const alpha = () => f.read(() => useSettings.project(f.projects[0]!.id));
  const beta = () => f.read(() => useSettings.project(f.projects[1]!.id));
  await global().set("editorFontFamily", "mono");
  assert.equal(alpha().get("editorFontFamily"), "mono");
  await alpha().set("editorFontFamily", "serif");
  assert.equal(alpha().get("editorFontFamily"), "serif");
  assert.equal(beta().get("editorFontFamily"), "mono");
  assert.equal(global().get("editorFontFamily"), "mono");
  assert.equal(alpha().overridden("editorFontFamily"), true);
  await alpha().reset("editorFontFamily");
  assert.equal(alpha().get("editorFontFamily"), "mono");
  assert.equal(alpha().overridden("editorFontFamily"), false);
  await global().set("editorFontFamily", "sans");
  assert.equal(alpha().get("editorFontFamily"), "sans");
  f.projectFacts.dispose();
});

test("file tabs keep their settings under unrelated, multiple and empty project selections", async () => {
  const f = fixture();
  await f.read(() => useSettings()).set("editorSpellCheck", true);
  await f.read(() => useSettings.project(f.projects[0]!.id)).set("editorFontFamily", "serif");
  await f.read(() => useSettings.project(f.projects[1]!.id)).set("editorFontFamily", "mono");
  const navigation = new WorkbenchProjectNavigation([], [], f.projects);
  const file = createLogicalFileRoute(f.projects[0]!.id, f.locations[0]!, "notes.md");
  for (const selection of ["/beta/@/", "/alpha/+/beta/@/", "/@/"]) {
    const href = navigation.href(file, navigation.readRoute(selection), "inherit");
    assert.ok(href);
    const reopened = navigation.readRoute(href);
    const settings = f.read(() => useSettings.forLocation(navigation.fileLocationFor(reopened)));
    assert.equal(settings.projectId, f.projects[0]!.id);
    assert.equal(settings.get("editorFontFamily"), "serif");
    await settings.set("editorSpellCheck", false);
  }
  assert.equal(f.read(() => useSettings.project(f.projects[1]!.id)).get("editorSpellCheck"), true);
  f.projectFacts.dispose();
});

test("thread and draft settings follow their owner rather than launch fallback or another selection", async () => {
  const f = fixture();
  await f.read(() => useSettings()).set("composerSpellCheck", true);
  await f.read(() => useSettings.project(f.projects[0]!.id)).set("composerSpellCheck", false);
  const threadId = ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000004");
  const childId = ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000006");
  const draftId = DraftIdSchema.parse("00000000-0000-4000-8000-000000000005");
  const readOwner = f.client.mounted!.threadOwnerFor;
  f.client.mounted!.threadOwnerFor = id => id === threadId ? readOwner(id) : null;
  const targets = [
    { kind: "provider" as const, threadId },
    { kind: "subagent" as const, parentThreadId: threadId, threadId: childId },
    { kind: "draft" as const, draftId },
  ];
  for (const target of targets) {
    const settings = f.read(() => useSettings.forThread(target, f.locations[1]!));
    assert.equal(settings.projectId, f.projects[0]!.id);
    assert.equal(settings.get("composerSpellCheck"), false);
    await settings.set("threadCodeBlockWrap", false);
  }
  assert.equal(f.read(() => useSettings.project(f.projects[0]!.id)).overridden("threadCodeBlockWrap"), true);
  assert.equal(f.read(() => useSettings.project(f.projects[1]!.id)).overridden("threadCodeBlockWrap"), false);
  f.setOwner(f.locations[1]!);
  assert.equal(f.read(() => useSettings.forThread(targets[0]!)).get("composerSpellCheck"), true);
  assert.equal(f.read(() => useSettings.forThread({ kind: "new" }, f.locations[0]!)).projectId, f.projects[0]!.id);
  f.projectFacts.dispose();
});

test("unresolved owners cannot turn a project write into a global write", async () => {
  const f = fixture();
  f.setOwner(null);
  const unknown = { ...f.locations[0]!, projectId: ProjectIdSchema.parse("unknown") };
  const settings = [
    f.read(() => useSettings.project(null)),
    f.read(() => useSettings.forLocation(unknown)),
    f.read(() => useSettings.forThread({ kind: "provider",
      threadId: ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000004") }, f.locations[0]!)),
  ];
  for (const scope of settings) {
    assert.equal(scope.unavailable("editorFontFamily"), true);
    await assert.rejects(scope.set("editorFontFamily", "serif"));
    await assert.rejects(scope.reset("editorFontFamily"));
  }
  assert.equal(f.state.getSnapshot().records.length, 0);
  f.projectFacts.dispose();
});

test("file policy callbacks read current preferences and never borrow a different project's overrides", async () => {
  const f = fixture();
  const project = () => f.read(() => useSettings.project(f.projects[0]!.id));
  const policy = f.read(() => useSettings.fileOpenPolicy());
  await project().set("openMarkdownFilesWith", "vscode");
  assert.equal(policy(f.locations[0]!).openMarkdownFilesWith, "vscode");
  assert.equal(policy(f.locations[1]!).openMarkdownFilesWith, "workbench");
  await project().set("openMarkdownFilesWith", "workbench");
  assert.equal(policy(f.locations[0]!).openMarkdownFilesWith, "workbench");
  assert.equal(policy(null).openMarkdownFilesWith, "workbench");
  f.projectFacts.dispose();
});

test("failed persistence rejects the setting action without changing the displayed preference", async () => {
  const f = fixture();
  const settings = f.read(() => useSettings.project(f.projects[0]!.id));
  const before = settings.get("editorFontFamily");
  f.state.put = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(settings.set("editorFontFamily", "serif"), /storage unavailable/);
  assert.equal(f.read(() => useSettings.project(f.projects[0]!.id)).get("editorFontFamily"), before);
  f.projectFacts.dispose();
});
