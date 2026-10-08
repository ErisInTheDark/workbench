/*
 * Exports:
 * - projectLogicalProjects: build display identities from app-owned projects and daemon-qualified catalogs; this app's
 *   hidden folders move to `hiddenLocations`, so every downstream projection sees only visible folders.
 * - isDaemonOwnedProject: whether a logical project's folders are each daemon's own and can't be hidden.
 * - preferredLogicalLaunchLocation: choose a project's last used launch target without changing its combined view.
 * - preferredSelectedLaunchTarget: choose the newest accepted thread's available selected project and folder.
 * - projectLogicalSummaries/LogicalProjectSummary: combine source-qualified thread summaries without rewriting ids.
 * - projectLogicalGroups: combine daemon placement and app drafts into ordered cross-daemon project groups.
 * - projectLogicalThreadRows/projectLogicalThreadDisplayOrder/projectLogicalHomeDisplayOrder/projectLogicalPinnedDisplayOrder: retain sources and app-owned layouts.
 * - projectPresentationDraftRow: one unsent presentation draft as a sidebar row.
 * - WorkbenchProjectedThreadRow/projectWorkspaceThreadMember/materializeWorkspaceThreadRow: rows as sidebar members and back.
 * - projectWorkbenchThreadMembership: members, combined home placement keys and saved folders for listed projects.
 */
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import type { DaemonId, LogicalProjectId, ProjectId } from "workbench-shared/workbench/identity";
import type { WorkspaceProjectGroups } from "workbench-shared/workbench/workspace/workspace-observation";
import type { ProjectLocationReference, WorkbenchProjectLocationsPayload } from "workbench-shared/workbench/project/project-location";
import type {
  WorkbenchProjectThreadSummaries, WorkbenchProjectThreadSummaryCounts,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRowSnapshot } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { createDraftTitle, WorkbenchThreadDraftSchema, type DraftReferenceKind } from "workbench-shared/workbench/thread/thread-state";
import { getThreadSidebarGroup } from "workbench-shared/workbench/thread/thread-state";
import {
  compareThreadSidebarEntries, getWorkbenchThreadDisplayKey, getWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayOrder,
} from "workbench-shared/workbench/thread/thread-display-order";
import { getWorkbenchThreadFolderKey } from "workbench-shared/workbench/thread/thread-display-order";
import { DraftIdSchema, FolderIdSchema } from "workbench-shared/workbench/identity";
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchHomeThreadKey, projectWorkbenchHomeThreadList,
  type WorkbenchHomeThreadDisplayItem, type WorkbenchHomeThreadDisplayOrder,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import { sidebarRowKey, type WorkbenchThreadSidebarRow } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type {
  WorkspaceThreadMember, WorkspaceThreadPlacementItem, WorkspaceThreadRows,
} from "workbench-shared/workbench/workspace/workspace-observation";

/** Each reference kind once, in first-seen order. */
function draftReferenceKinds(references: readonly { kind: DraftReferenceKind }[]) {
  return [...new Set(references.map(({ kind }) => kind))];
}

function projectDisplayLocations(project: WorkbenchLogicalProject) {
  return [
    ...project.locations.map(location => ({
      target: location.target, hostname: location.hostname, rootPath: location.rootPath,
      observedOnly: false,
    })),
    ...(project.observedLocations ?? []).map(location => ({
      target: { daemonId: location.daemonId, projectId: location.projectId },
      hostname: location.hostname, rootPath: location.rootPath, observedOnly: true,
    })),
  ];
}

export function projectLogicalHomeDisplayOrder(
  rows: readonly WorkbenchLogicalThreadRow[],
  presentation: PresentationSnapshot,
): WorkbenchHomeThreadDisplayOrder {
  const byThread = new Map<string, WorkbenchLogicalThreadRow>(rows.flatMap(row => row.entry.entryKind === "draft" ? [] : [[
    `${row.location.daemonId}/${row.location.projectId}/${row.entry.identity.threadId}`, row,
  ] as const]));
  const byDraft = new Map<string, WorkbenchLogicalThreadRow>(rows.flatMap(row => row.entry.entryKind === "draft"
    ? [[row.entry.draft.draftId, row] as const] : []));
  const members = presentation.members.filter(member => member.scope === "home")
    .sort((left, right) => left.position - right.position)
    .flatMap(member => {
      const row = member.kind === "draft" ? byDraft.get(member.draftId ?? "")
        : member.thread ? byThread.get(
          `${member.thread.location.daemonId}/${member.thread.location.projectId}/${member.thread.threadId}`,
        ) : null;
      const section = row && getWorkbenchThreadDisplaySection(row.entry);
      return row && section ? [{ key: getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry), section }] : [];
    });
  const order: WorkbenchHomeThreadDisplayOrder = {};
  for (const section of ["pinned", "snoozed", "settled"] as const) {
    const keys = members.filter(member => member.section === section).map(member => member.key);
    if (keys.length) order[section] = Object.fromEntries(keys.map((key, index) => [
      key, { above: keys.slice(0, index), below: keys.slice(index + 1) },
    ]));
  }
  return order;
}

export function projectLogicalPinnedDisplayOrder(
  rows: readonly WorkbenchLogicalThreadRow[],
  presentation: PresentationSnapshot,
): WorkbenchThreadDisplayOrder {
  const byThread = new Map<string, WorkbenchLogicalThreadRow>(rows.flatMap(row => row.entry.entryKind === "draft" ? [] : [[
    `${row.location.daemonId}/${row.location.projectId}/${row.entry.identity.threadId}`, row,
  ] as const]));
  const byDraft = new Map<string, WorkbenchLogicalThreadRow>(rows.flatMap(row => row.entry.entryKind === "draft"
    ? [[row.entry.draft.draftId, row] as const] : []));
  const members = presentation.members.filter(member => member.scope === "pinned")
    .sort((left, right) => left.position - right.position)
    .flatMap(member => {
      const row = member.kind === "draft" ? byDraft.get(member.draftId ?? "")
        : member.thread ? byThread.get(
          `${member.thread.location.daemonId}/${member.thread.location.projectId}/${member.thread.threadId}`,
        ) : null;
      return row && getThreadSidebarGroup(row.entry) === "pinned" ? [{
        folderId: member.folderId,
        key: getProjectQualifiedThreadDisplayKey(row.logicalProjectId, getWorkbenchThreadDisplayKey(row.entry)),
      }] : [];
    });
  const folders = presentation.folders.filter(folder => folder.scope === "pinned").flatMap(folder => {
    const threadKeys = members.filter(member => member.folderId === folder.id).map(member => member.key);
    return threadKeys.length ? [{
      folderId: FolderIdSchema.parse(folder.id), section: "pinned" as const,
      title: folder.title, threadKeys,
    }] : [];
  });
  const keys = members.map(member => {
    const folder = folders.find(candidate => candidate.threadKeys.includes(member.key));
    return folder ? getWorkbenchThreadFolderKey(folder.folderId) : member.key;
  }).filter((key, index, all) => all.indexOf(key) === index);
  return {
    ...(folders.length ? { folders } : {}),
    ...(keys.length ? { pinned: Object.fromEntries(keys.map((key, index) => [
      key, { above: keys.slice(0, index), below: keys.slice(index + 1) },
    ])) } : {}),
  };
}

export function projectLogicalThreadDisplayOrder(
  logicalProjectId: LogicalProjectId,
  rows: readonly WorkbenchLogicalThreadRow[],
  presentation: PresentationSnapshot,
): WorkbenchThreadDisplayOrder {
  const candidates = rows.filter(row => row.logicalProjectId === logicalProjectId);
  const byThread = new Map<string, WorkbenchLogicalThreadRow>(candidates.flatMap(row => row.entry.entryKind === "draft" ? [] : [[
    `${row.location.daemonId}/${row.location.projectId}/${row.entry.identity.threadId}`, row,
  ] as const]));
  const byDraft = new Map<string, WorkbenchLogicalThreadRow>(candidates.flatMap(row => row.entry.entryKind === "draft"
    ? [[row.entry.draft.draftId, row] as const] : []));
  const members = presentation.members
    .filter(member => member.scope === "project" && member.logicalProjectId === logicalProjectId)
    .sort((left, right) => left.position - right.position)
    .flatMap(member => {
      const row = member.kind === "draft" ? byDraft.get(member.draftId ?? "")
        : member.thread ? byThread.get(
          `${member.thread.location.daemonId}/${member.thread.location.projectId}/${member.thread.threadId}`,
        ) : null;
      const section = row && getWorkbenchThreadDisplaySection(row.entry);
      return row && section ? [{
        folderId: member.folderId, key: getWorkbenchThreadDisplayKey(row.entry), section,
      }] : [];
    });
  const folders: NonNullable<WorkbenchThreadDisplayOrder["folders"]> = [];
  for (const folder of presentation.folders.filter(folder =>
    folder.scope === "project" && folder.logicalProjectId === logicalProjectId)) {
    const owned = members.filter(member => member.folderId === folder.id);
    const section = owned[0]?.section;
    const threadKeys = owned.filter(member => member.section === section).map(member => member.key);
    if (section && threadKeys.length) folders.push({
      folderId: FolderIdSchema.parse(folder.id), section, title: folder.title, threadKeys,
    });
  }
  const order: WorkbenchThreadDisplayOrder = folders.length ? { folders } : {};
  for (const section of ["pinned", "snoozed", "settled"] as const) {
    const keys = members.filter(member => member.section === section).flatMap(member => {
      const folder = folders.find(folder => folder.threadKeys.includes(member.key));
      return [folder ? getWorkbenchThreadFolderKey(folder.folderId) : member.key];
    }).filter((key, index, all) => all.indexOf(key) === index);
    if (keys.length) order[section] = Object.fromEntries(keys.map((key, index) => [
      key, { above: keys.slice(0, index), below: keys.slice(index + 1) },
    ]));
  }
  return order;
}

export function projectLogicalThreadRows(
  projects: readonly WorkbenchLogicalProject[],
  sources: ReadonlyMap<DaemonId, { projects: readonly Pick<WorkbenchThreadSidebarRowSnapshot, "projectId" | "entries">[] }>,
  presentation: PresentationSnapshot,
): WorkbenchLogicalThreadRow[] {
  const materialized = projects.flatMap(project => projectDisplayLocations(project).flatMap(location =>
    (sources.get(location.target.daemonId)?.projects.find(sidebar =>
      sidebar.projectId === location.target.projectId)?.entries ?? [])
      .filter(entry => entry.entryKind !== "draft")
      .map(entry => ({
        logicalProjectId: project.id, location: location.target,
        hostname: location.hostname, rootPath: location.rootPath, entry,
        ...(location.observedOnly ? { observedOnly: true } : {}),
      })),
  ));
  const drafts = presentation.drafts.filter(draft => draft.phase === "unsent")
    .map(draft => projectPresentationDraftRow(draft, projects));
  return [...materialized, ...drafts].sort((left, right) => compareThreadSidebarEntries(left.entry, right.entry)
    || left.location.daemonId.localeCompare(right.location.daemonId)
    || left.location.projectId.localeCompare(right.location.projectId));
}

/** One unsent presentation draft as a sidebar row in its logical project. */
export function projectPresentationDraftRow(
  draft: PresentationSnapshot["drafts"][number],
  projects: readonly Pick<WorkbenchLogicalProject, "id" | "locations">[],
): WorkbenchLogicalThreadRow {
  const location = projects.find(project => project.id === draft.logicalProjectId)?.locations.find(item =>
    item.target.daemonId === draft.target.daemonId && item.target.projectId === draft.target.projectId);
  const legacy = WorkbenchThreadDraftSchema.parse({
    attachments: draft.attachments.map(item => ({
      id: item.id,
      url: `/api/workbench-presentation/drafts/${encodeURIComponent(draft.id)}/attachments/${encodeURIComponent(item.id)}`,
    })),
    clientUpdatedAt: draft.updatedAt, composerSettings: draft.selection.settings, createdAt: draft.updatedAt,
    draftId: draft.id, profileId: draft.selection.kind === "profile" ? draft.selection.profileId : null,
    projectId: draft.target.projectId, prompt: draft.prompt, updatedAt: draft.updatedAt,
    ...(draft.references?.length ? { referenceKinds: draftReferenceKinds(draft.references) } : {}),
  });
  return {
    logicalProjectId: draft.logicalProjectId, location: draft.target,
    hostname: location?.hostname ?? draft.target.daemonId,
    rootPath: location?.rootPath ?? draft.target.projectId,
    entry: {
      activityAt: draft.updatedAt, title: createDraftTitle(draft.prompt),
      draft: legacy, entryKind: "draft", metadata: {
        archived: false, pinned: draft.pinned, snoozed: draft.snoozed,
      },
    },
  };
}

/** A projected row, including observed-only rows outside any logical project. */
export type WorkbenchProjectedThreadRow = Omit<WorkbenchLogicalThreadRow, "logicalProjectId"> & {
  logicalProjectId: LogicalProjectId | null;
};

/** A row's listing: location plus the basics shown before its summary lands. */
export function projectWorkspaceThreadMember(row: WorkbenchProjectedThreadRow): WorkspaceThreadMember {
  const { entry } = row;
  return {
    key: `${row.logicalProjectId ?? "observed"}/${row.location.daemonId}/${row.location.projectId}/${sidebarRowKey(entry)}`,
    homeKey: row.logicalProjectId ? getWorkbenchHomeThreadKey(row.logicalProjectId, entry) : null,
    logicalProjectId: row.logicalProjectId, location: row.location, hostname: row.hostname, rootPath: row.rootPath,
    ...(row.observedOnly ? { observedOnly: true } : {}),
    title: entry.title, activityAt: entry.activityAt,
    ref: entry.entryKind === "draft" ? { kind: "draft", draftId: entry.draft.draftId }
      : { kind: "thread", identity: { harness: entry.identity.harness, threadId: entry.identity.threadId } },
  };
}

/**
 * The sidebar for every listed logical project: members, the combined home list as placement keys, and the saved
 * folders context menus offer. Runs the same projections the browser used to run over full rows; orders stay here.
 */
export function projectWorkbenchThreadMembership(
  rows: readonly WorkbenchProjectedThreadRow[],
  presentation: PresentationSnapshot,
): Pick<WorkspaceThreadRows, "members" | "placement" | "folders"> {
  const logical = rows.filter((row): row is WorkbenchLogicalThreadRow => row.logicalProjectId !== null);
  const byProject = new Map<LogicalProjectId, WorkbenchLogicalThreadRow[]>();
  for (const row of logical) {
    const projectRows = byProject.get(row.logicalProjectId);
    if (projectRows) projectRows.push(row);
    else byProject.set(row.logicalProjectId, [row]);
  }
  const projectOrders = new Map([...byProject].map(([projectId, projectRows]) =>
    [projectId, projectLogicalThreadDisplayOrder(projectId, projectRows, presentation)] as const));
  const list = projectWorkbenchHomeThreadList({
    projects: [...byProject].map(([projectId, projectRows]) => ({
      projectId, entries: projectRows.map(row => row.entry), displayOrder: projectOrders.get(projectId),
    })),
  }, projectLogicalHomeDisplayOrder(logical, presentation));
  const item = (value: WorkbenchHomeThreadDisplayItem): WorkspaceThreadPlacementItem => value.itemKind === "folder"
    ? { kind: "folder", projectId: value.projectId, folder: value.folder, keys: value.threadKeys }
    : { kind: "thread", key: value.entry.threadKey };
  return {
    members: rows.map(projectWorkspaceThreadMember),
    placement: {
      main: list.mainEntries.map(entry => entry.threadKey),
      archived: list.archivedEntries.map(entry => entry.threadKey),
      pinned: list.pinnedItems.map(item),
      snoozed: list.snoozedItems.map(item),
      settled: list.settledItems.map(item),
    },
    folders: {
      pinned: projectLogicalPinnedDisplayOrder(logical, presentation).folders ?? [],
      projects: Object.fromEntries([...projectOrders].map(([projectId, order]) => [projectId, order.folders ?? []])),
    },
  };
}

/** A member as a sidebar row once its detail is known: the thread's summary row, or the draft's presentation row. */
export function materializeWorkspaceThreadRow(
  member: WorkspaceThreadMember,
  entry: WorkbenchThreadSidebarRow,
): WorkbenchProjectedThreadRow {
  return {
    logicalProjectId: member.logicalProjectId, location: member.location,
    hostname: member.hostname, rootPath: member.rootPath, entry,
    ...(member.observedOnly ? { observedOnly: true } : {}),
  };
}

export type LogicalProjectSummary = WorkbenchLogicalProjectSummary;

export function preferredLogicalLaunchLocation(
  project: WorkbenchLogicalProject,
  presentation: PresentationSnapshot,
): ProjectLocationReference | null {
  const registered = (target: ProjectLocationReference) => project.locations.some(location =>
    location.target.daemonId === target.daemonId && location.target.projectId === target.projectId);
  const latest = [
    ...presentation.defaults.filter(item => registered(item.target)),
    ...presentation.drafts.filter(item => item.logicalProjectId === project.id
      && item.phase !== "deleted" && item.phase !== "importing"
      && registered(item.target)),
  ]
    .sort((left, right) => right.revision - left.revision
      || left.target.daemonId.localeCompare(right.target.daemonId)
      || left.target.projectId.localeCompare(right.target.projectId))[0];
  return latest?.target ?? project.locations.find(location => location.project)?.target
    ?? project.locations[0]?.target ?? null;
}

export function preferredSelectedLaunchTarget(
  projects: readonly WorkbenchLogicalProject[],
  selectedProjectIds: readonly string[],
  presentation: PresentationSnapshot,
) {
  const selectedProjects = selectedProjectIds.flatMap(id => {
    const project = projects.find(candidate => candidate.id === id);
    return project ? [project] : [];
  });
  const selectedProjectsById = new Map(selectedProjects.map(project => [project.id, project]));
  const accepted = presentation.drafts
    .filter(draft => draft.phase === "accepted")
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id));
  for (const draft of accepted) {
    const project = selectedProjectsById.get(draft.logicalProjectId);
    const location = project?.locations.find(item =>
      item.target.daemonId === draft.target.daemonId && item.target.projectId === draft.target.projectId);
    if (project && location) return { project, location: location.target };
  }
  for (const project of selectedProjects) {
    const location = project.locations.find(item => item.project)?.target;
    if (location) return { project, location };
  }
  return null;
}

export function projectLogicalSummaries(
  projects: readonly WorkbenchLogicalProject[],
  sources: ReadonlyMap<DaemonId, WorkbenchProjectThreadSummaries>,
  presentation: Pick<PresentationSnapshot, "drafts">,
): Map<LogicalProjectId, LogicalProjectSummary> {
  const result = new Map<LogicalProjectId, LogicalProjectSummary>();
  for (const project of projects) {
    const counts: WorkbenchProjectThreadSummaryCounts = {
      completed: 0, needsAttention: 0, needsAttentionActive: 0,
      proposedCommit: 0, stopped: 0, waiting: 0, working: 0,
    };
    const pinnedThreads: LogicalProjectSummary["pinnedThreads"] = [];
    const unsettledThreads: LogicalProjectSummary["unsettledThreads"] = [];
    let lastThreadUpdateAt: number | null = null;
    for (const location of projectDisplayLocations(project)) {
      const summary = sources.get(location.target.daemonId)?.projects.find(
        item => item.projectId === location.target.projectId,
      );
      if (!summary) continue;
      counts.completed += summary.counts.completed;
      counts.needsAttention += summary.counts.needsAttention;
      counts.needsAttentionActive += summary.counts.needsAttentionActive;
      counts.proposedCommit += summary.counts.proposedCommit;
      counts.stopped += summary.counts.stopped;
      counts.waiting = (counts.waiting ?? 0) + (summary.counts.waiting ?? 0);
      counts.working += summary.counts.working;
      if (summary.lastThreadUpdateAt !== null) {
        lastThreadUpdateAt = Math.max(lastThreadUpdateAt ?? 0, summary.lastThreadUpdateAt);
      }
      pinnedThreads.push(...summary.pinnedThreads.filter(entry => entry.entryKind !== "draft")
        .map(entry => ({ location: location.target, entry })));
      unsettledThreads.push(...summary.unsettledThreads.map(entry => ({ location: location.target, entry })));
    }
    for (const draft of presentation.drafts) {
      if (draft.logicalProjectId !== project.id || draft.phase !== "unsent" || !draft.pinned || draft.snoozed
        || !project.locations.some(location => location.target.daemonId === draft.target.daemonId
          && location.target.projectId === draft.target.projectId)) continue;
      pinnedThreads.push({ location: draft.target, entry: {
        entryKind: "draft", draftId: DraftIdSchema.parse(draft.id), activityAt: draft.updatedAt,
        hasAttachments: draft.attachments.length > 0, title: createDraftTitle(draft.prompt),
        ...(draft.references?.length ? { referenceKinds: draftReferenceKinds(draft.references) } : {}),
        metadata: { archived: false, pinned: true, snoozed: false }, status: "draft",
      } });
    }
    pinnedThreads.sort((left, right) => right.entry.activityAt - left.entry.activityAt
      || left.location.daemonId.localeCompare(right.location.daemonId));
    unsettledThreads.sort((left, right) => right.entry.activityAt - left.entry.activityAt
      || left.location.daemonId.localeCompare(right.location.daemonId));
    result.set(project.id, { counts, lastThreadUpdateAt, pinnedThreads, unsettledThreads });
  }
  return result;
}

export function projectLogicalGroups(
  projects: readonly WorkbenchLogicalProject[],
  summaries: Readonly<Record<string, WorkbenchLogicalProjectSummary>>,
  placement: ReadonlyMap<DaemonId, ReadonlySet<ProjectId>>,
  presentation: Pick<PresentationSnapshot, "drafts">,
): WorkspaceProjectGroups {
  const orderedProjectIds = projects.map(project => project.id);
  const unsettledProjectIds = projects.flatMap(project =>
    summaries[project.id]?.unsettledThreads.length ? [project.id] : []);
  const unsettled = new Set(unsettledProjectIds);
  const unarchivedProjectIds = projects.flatMap(project => {
    // Each daemon's own project is a standing entry point, visible before it has any threads.
    if (project.matchKey.startsWith("daemon://")) return [project.id];
    const hasDaemonWork = projectDisplayLocations(project).some(location =>
      placement.get(location.target.daemonId)?.has(location.target.projectId));
    const hasAppDraft = presentation.drafts.some(draft =>
      draft.logicalProjectId === project.id && draft.phase === "unsent");
    return hasDaemonWork || hasAppDraft || unsettled.has(project.id) ? [project.id] : [];
  });
  return { orderedProjectIds, unsettledProjectIds, unarchivedProjectIds };
}

/** Workbench Library and daemon projects hold each daemon's own Workbench folder; apps never hide them. */
export function isDaemonOwnedProject(matchKey: string) {
  return matchKey === "workbench-library" || matchKey.startsWith("daemon://");
}

export function projectLogicalProjects(
  presentation: PresentationSnapshot,
  catalogs: ReadonlyMap<DaemonId, readonly WorkbenchProjectOption[]>,
  observations: ReadonlyMap<DaemonId, {
    hostname: string;
    data: WorkbenchProjectLocationsPayload["data"];
  }> = new Map(),
): WorkbenchLogicalProject[] {
  const remotes = new Map<string, { path: string; parts: string[]; host: string }>();
  const suffixCounts = new Map<string, number>();
  for (const project of presentation.projects) {
    if (!project.matchKey.startsWith("remote://") || project.matchKey.startsWith("remote://file:")) continue;
    const address = project.matchKey.slice("remote://".length);
    const urlText = address.includes("://") ? address : `https://${address}`;
    if (!URL.canParse(urlText)) continue;
    const url = new URL(urlText);
    const remotePath = url.pathname.replace(/^\/+/u, "");
    if (!url.host || !remotePath) continue;
    const parts = remotePath.split("/").filter(Boolean);
    remotes.set(project.id, { path: remotePath, parts, host: url.host });
    for (let count = 1; count <= parts.length; count += 1) {
      const suffix = parts.slice(-count).join("/");
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
  }
  const otherLabels = new Set(presentation.projects
    .filter(project => !remotes.has(project.id)).map(project => project.label));
  const localLabelCounts = new Map<string, number>();
  for (const project of presentation.projects.filter(item => !remotes.has(item.id))) {
    localLabelCounts.set(project.label, (localLabelCounts.get(project.label) ?? 0) + 1);
  }
  const hostLabels = new Map<string, number>();
  for (const remote of remotes.values()) {
    const label = `${remote.host}/${remote.path}`;
    hostLabels.set(label, (hostLabels.get(label) ?? 0) + 1);
  }
  const hostnames = new Map(presentation.daemons.map(daemon => [daemon.id, daemon.hostname]));
  const pathSuffixCounts = new Map<string, number>();
  const pathParts = (path: string) => {
    const parts = path.replace(/\\/gu, "/").split("/").filter(Boolean);
    const worktreeIndex = parts.findIndex((part, index) =>
      part === ".workbench" && parts[index + 1] === "worktrees" && index + 3 === parts.length);
    if (worktreeIndex >= 0) parts[parts.length - 1] = `+${parts[parts.length - 1]}`;
    return parts;
  };
  const displayLocationPath = (hostname: string, rootPath: string) => {
    const parts = pathParts(rootPath);
    const suffix = parts.map((_, index) => parts.slice(-(index + 1)).join("/"))
      .find(value => pathSuffixCounts.get(`${hostname.toLowerCase()}:/${value.toLowerCase()}`) === 1);
    return suffix ? `/${suffix}` : rootPath;
  };
  for (const location of presentation.locations) {
    const hostname = hostnames.get(location.target.daemonId) ?? location.target.daemonId;
    const parts = pathParts(location.rootPath);
    for (let count = 1; count <= parts.length; count += 1) {
      const key = `${hostname.toLowerCase()}:/${parts.slice(-count).join("/").toLowerCase()}`;
      pathSuffixCounts.set(key, (pathSuffixCounts.get(key) ?? 0) + 1);
    }
  }
  const hiddenKeys = new Set((presentation.hiddenLocations ?? []).map(item =>
    `${item.logicalProjectId}/${item.target.daemonId}/${item.target.projectId}`));
  const hiddenByProject = new Map<string, NonNullable<WorkbenchLogicalProject["hiddenLocations"]>>();
  const hide = (logicalProjectId: string, location: NonNullable<WorkbenchLogicalProject["hiddenLocations"]>[number]) => {
    if (!hiddenKeys.has(`${logicalProjectId}/${location.daemonId}/${location.projectId}`)) return false;
    const entries = hiddenByProject.get(logicalProjectId) ?? [];
    entries.push(location);
    hiddenByProject.set(logicalProjectId, entries);
    return true;
  };
  const locations = new Map(presentation.projects.map(project => [project.id, [] as WorkbenchLogicalProject["locations"]]));
  for (const location of presentation.locations) {
    const owner = locations.get(location.logicalProjectId);
    if (!owner) continue;
    if (hide(location.logicalProjectId, {
      daemonId: location.target.daemonId, projectId: location.target.projectId,
      hostname: hostnames.get(location.target.daemonId) ?? location.target.daemonId, rootPath: location.rootPath,
    })) continue;
    const project = catalogs.get(location.target.daemonId)?.find(candidate => candidate.id === location.target.projectId) ?? null;
    const hostname = hostnames.get(location.target.daemonId) ?? location.target.daemonId;
    owner.push({
      target: location.target,
      daemonId: location.target.daemonId,
      hostname,
      name: location.name,
      rootPath: location.rootPath,
      displayPath: displayLocationPath(hostname, location.rootPath),
      project,
    });
  }
  const observedByKey = new Map<string, NonNullable<WorkbenchLogicalProject["observedLocations"]>>();
  const registeredTargets = new Set(presentation.locations.map(location =>
    `${location.target.daemonId}/${location.target.projectId}`));
  for (const [daemonId, source] of observations) {
    for (const item of source.data) {
      if (registeredTargets.has(`${daemonId}/${item.project.id}`)) continue;
      const entries = observedByKey.get(item.identityKey) ?? [];
      entries.push({
        daemonId, projectId: item.project.id, hostname: source.hostname,
        rootPath: item.project.rootPath, project: item.project,
      });
      observedByKey.set(item.identityKey, entries);
    }
  }
  for (const entries of observedByKey.values()) {
    entries.sort((left, right) => left.hostname.localeCompare(right.hostname)
      || left.rootPath.localeCompare(right.rootPath)
      || left.daemonId.localeCompare(right.daemonId));
  }
  return presentation.projects.map(project => {
    const remote = remotes.get(project.id);
    const withHost = remote ? `${remote.host}/${remote.path}` : "";
    const label = remote
      ? remote.parts.map((_, index) => remote.parts.slice(-(index + 1)).join("/"))
        .find(suffix => suffixCounts.get(suffix) === 1 && !otherLabels.has(suffix))
        ?? (hostLabels.get(withHost) === 1 && !otherLabels.has(withHost)
          ? withHost : project.matchKey.slice("remote://".length))
      : suffixCounts.has(project.label) || hostLabels.has(project.label)
        || (localLabelCounts.get(project.label) ?? 0) > 1
        ? project.matchKey : project.label;
    const projectLocations = (locations.get(project.id) ?? []).sort((left, right) =>
      left.hostname.localeCompare(right.hostname)
      || left.rootPath.localeCompare(right.rootPath)
      || left.daemonId.localeCompare(right.daemonId));
    const showDaemon = new Set(projectLocations.map(location => location.daemonId)).size > 1;
    // A daemon project's root is a hidden scratch folder; its host is its whole location.
    const daemonProject = project.matchKey.startsWith("daemon://");
    for (const location of projectLocations) {
      if (daemonProject) location.displayPath = location.hostname;
      else if (showDaemon) location.displayPath = `${location.hostname}:${location.displayPath}`;
      else if (location.displayPath?.startsWith("/")) location.displayPath = location.displayPath.slice(1);
    }
    const preferred = projectLocations.find(location => location.project) ?? projectLocations[0];
    const displayPath = daemonProject ? null : preferred?.displayPath ?? null;
    const observed = (observedByKey.get(project.matchKey) ?? []).filter(location => !hide(project.id, {
      daemonId: location.daemonId, projectId: location.projectId, hostname: location.hostname, rootPath: location.rootPath,
    }));
    const hidden = hiddenByProject.get(project.id);
    return {
      id: project.id,
      matchKey: project.matchKey,
      label,
      storedLabel: project.label,
      displayName: daemonProject ? project.label : remote?.parts.at(-1) ?? preferred?.name ?? project.label,
      displayPath,
      locations: projectLocations,
      ...(observed.length ? { observedLocations: observed } : {}),
      ...(hidden?.length ? { hiddenLocations: hidden } : {}),
    };
  });
}
