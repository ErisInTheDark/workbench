/*
 * No production exports. Protect home thread visibility when no create target exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { ExplorerSnapshot, WorkbenchLogicalProject, WorkbenchLogicalThreadRow } from "workbench-shared/types";
import WorkbenchAllProjectsThreadSidebar from "./WorkbenchAllProjectsThreadSidebar";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import WorkbenchContextMenuContext from "./WorkbenchContextMenuContext";
import WorkbenchDragProvider from "./drag/WorkbenchDragProvider";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import WorkbenchSidebarPreferencesProvider from "./WorkbenchSidebarPreferencesProvider";
import type { WorkbenchClientController } from "./workbench-client-context";

test("home shows threads from every logical project without a default create target", () => {
  const daemonId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const projectIds = [
    LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001"),
    LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002"),
  ];
  const localIds = [ProjectIdSchema.parse("first"), ProjectIdSchema.parse("second")];
  const logicalProjects: WorkbenchLogicalProject[] = projectIds.map((id, index) => ({
    id, matchKey: `remote://example.test/team/${index}`, label: `project-${index}`,
    locations: [{
      daemonId, hostname: "desktop", name: `project-${index}`, rootPath: `C:/project-${index}`,
      target: { daemonId, projectId: localIds[index]! }, project: null,
    }],
  }));
  const logicalThreads: WorkbenchLogicalThreadRow[] = projectIds.map((id, index) => ({
    logicalProjectId: id, location: { daemonId, projectId: localIds[index]! },
    hostname: "desktop", rootPath: `C:/project-${index}`,
    entry: {
      entryKind: "thread", title: `visible-thread-${index}`, activityAt: 1,
      identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(`thread-${index}`) },
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    },
  }));
  const presentation: PresentationSnapshot = {
    revision: 1, daemons: [{ id: daemonId, hostname: "desktop" }],
    projects: logicalProjects.map(project => ({ id: project.id, matchKey: project.matchKey, label: project.label })),
    locations: logicalProjects.flatMap(project => project.locations.map(location => ({
      target: location.target, logicalProjectId: project.id, identityKey: project.matchKey,
      name: location.name, rootPath: location.rootPath,
    }))),
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const explorer: ExplorerSnapshot = {
    browseLocation: null, changes: {}, configuredDiscoveryRootPath: null, currentPath: "",
    currentProjectId: "", currentThreadId: "", expandedDirectories: [], fontSize: 16,
    isProjectLoading: false, isThreadsLoading: false, locallyModifiedPaths: [],
    logicalProjects, logicalThreads, projectFileCandidates: [], projectFileIndexId: "",
    projectFileIndexKey: "", projectFilePaths: [], projects: [], root: "Home",
    rootPath: "", roots: [], subagents: [], threads: [], threadsError: "", tree: [],
    workbenchStorageRootPath: "",
  };
  const client: WorkbenchClientController = { controls: null, mounted: null, explorer };
  const html = renderToStaticMarkup(createElement(WorkbenchClientProvider, {
    client,
    children: createElement(WorkbenchSidebarPreferencesProvider, {
      projectId: "",
      children: () => createElement(WorkbenchContextMenuContext.Provider, {
        value: { closeContextMenu: () => undefined, openContextMenu: () => undefined, refreshContextMenu: () => undefined },
        children: createElement(WorkbenchDragProvider, {
          children: createElement(WorkbenchThreadSidebarActionsProvider, {
            projectId: "", onOpenThread: () => undefined, onThreadSettled: () => undefined,
            children: createElement(WorkbenchAllProjectsThreadSidebar, {
              activeDragPayload: null, attentionLabelsByThreadId: {}, createProjectId: "",
              currentTarget: null, onCreateThread: () => undefined, onOpenThread: () => undefined,
              projects: [], selectedOwnerProjectId: "", selectedProjectIds: logicalProjects.map(project => project.id),
              logicalProjects, logicalThreads, presentation,
            }),
          }),
        }),
      }),
    }),
  }));
  assert.match(html, /visible-thread-0/u);
  assert.match(html, /visible-thread-1/u);
  assert.doesNotMatch(html, /Create new thread/u);
});
