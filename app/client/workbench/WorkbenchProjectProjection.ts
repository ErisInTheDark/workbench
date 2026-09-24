/*
 * Exports:
 * - projectLogicalProjects: build display identities from app-owned projects and daemon-qualified catalogs.
 * - projectLogicalSummaries/LogicalProjectSummary: combine source-qualified thread summaries without rewriting ids.
 * - projectLogicalThreadRows/projectLogicalThreadDisplayOrder/projectLogicalHomeDisplayOrder/projectLogicalPinnedDisplayOrder: retain sources and app-owned layouts.
 */
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import type { DaemonId, LogicalProjectId } from "workbench-shared/workbench/identity";
import type {
  WorkbenchProjectThreadSidebars, WorkbenchProjectThreadSummaries, WorkbenchProjectThreadSummaryCounts,
} from "workbench-shared/workbench/thread/thread-state";
import { createDraftTitle, WorkbenchThreadDraftSchema } from "workbench-shared/workbench/thread/thread-state";
import { getThreadSidebarGroup } from "workbench-shared/workbench/thread/thread-state";
import {
  getWorkbenchThreadDisplayKey, getWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayOrder,
} from "workbench-shared/workbench/thread/thread-display-order";
import { getWorkbenchThreadFolderKey } from "workbench-shared/workbench/thread/thread-display-order";
import { FolderIdSchema } from "workbench-shared/workbench/identity";
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchHomeThreadKey, type WorkbenchHomeThreadDisplayOrder,
} from "workbench-shared/workbench/thread/home-thread-display-order";

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
  sources: ReadonlyMap<DaemonId, WorkbenchProjectThreadSidebars>,
  presentation: PresentationSnapshot,
): WorkbenchLogicalThreadRow[] {
  const materialized = projects.flatMap(project => project.locations.flatMap(location =>
    (sources.get(location.daemonId)?.projects.find(sidebar =>
      sidebar.projectId === location.target.projectId)?.entries ?? [])
      .filter(entry => entry.entryKind !== "draft")
      .map(entry => ({
        logicalProjectId: project.id, location: location.target,
        hostname: location.hostname, rootPath: location.rootPath, entry,
      })),
  ));
  const drafts: WorkbenchLogicalThreadRow[] = presentation.drafts
    .filter(draft => draft.phase === "unsent")
    .map(draft => {
      const location = projects.find(project => project.id === draft.logicalProjectId)?.locations.find(item =>
        item.target.daemonId === draft.target.daemonId && item.target.projectId === draft.target.projectId);
      const settings = draft.selection.settings;
      const legacy = WorkbenchThreadDraftSchema.parse({
        attachments: draft.attachments.map(item => ({
          id: item.id,
          url: `/api/workbench-presentation/drafts/${encodeURIComponent(draft.id)}/attachments/${encodeURIComponent(item.id)}`,
        })),
        clientUpdatedAt: draft.updatedAt, composerSettings: settings, createdAt: draft.updatedAt,
        draftId: draft.id, profileId: draft.selection.kind === "profile" ? draft.selection.profileId : null,
        projectId: draft.target.projectId, prompt: draft.prompt, updatedAt: draft.updatedAt,
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
    });
  return [...materialized, ...drafts].sort((left, right) => right.entry.activityAt - left.entry.activityAt
    || left.location.daemonId.localeCompare(right.location.daemonId)
    || left.location.projectId.localeCompare(right.location.projectId));
}

export type LogicalProjectSummary = WorkbenchLogicalProjectSummary;

export function projectLogicalSummaries(
  projects: readonly WorkbenchLogicalProject[],
  sources: ReadonlyMap<DaemonId, WorkbenchProjectThreadSummaries>,
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
    for (const location of project.locations) {
      const summary = sources.get(location.daemonId)?.projects.find(
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
      pinnedThreads.push(...summary.pinnedThreads.map(entry => ({ location: location.target, entry })));
      unsettledThreads.push(...summary.unsettledThreads.map(entry => ({ location: location.target, entry })));
    }
    pinnedThreads.sort((left, right) => right.entry.activityAt - left.entry.activityAt
      || left.location.daemonId.localeCompare(right.location.daemonId));
    unsettledThreads.sort((left, right) => right.entry.activityAt - left.entry.activityAt
      || left.location.daemonId.localeCompare(right.location.daemonId));
    result.set(project.id, { counts, lastThreadUpdateAt, pinnedThreads, unsettledThreads });
  }
  return result;
}

export function projectLogicalProjects(
  presentation: PresentationSnapshot,
  catalogs: ReadonlyMap<DaemonId, readonly WorkbenchProjectOption[]>,
): WorkbenchLogicalProject[] {
  const remotes = new Map<string, { path: string; host: string }>();
  const counts = new Map<string, number>();
  for (const project of presentation.projects) {
    if (!project.matchKey.startsWith("remote://") || project.matchKey.startsWith("remote://file:")) continue;
    const address = project.matchKey.slice("remote://".length);
    const urlText = address.includes("://") ? address : `https://${address}`;
    if (!URL.canParse(urlText)) continue;
    const url = new URL(urlText);
    const remotePath = url.pathname.replace(/^\/+/u, "");
    if (!url.host || !remotePath) continue;
    remotes.set(project.id, { path: remotePath, host: url.host });
    counts.set(remotePath, (counts.get(remotePath) ?? 0) + 1);
  }
  const hostLabels = new Map<string, number>();
  for (const remote of remotes.values()) {
    const label = `${remote.host}/${remote.path}`;
    hostLabels.set(label, (hostLabels.get(label) ?? 0) + 1);
  }
  const hostnames = new Map(presentation.daemons.map(daemon => [daemon.id, daemon.hostname]));
  const locations = new Map(presentation.projects.map(project => [project.id, [] as WorkbenchLogicalProject["locations"]]));
  for (const location of presentation.locations) {
    const owner = locations.get(location.logicalProjectId);
    if (!owner) continue;
    const project = catalogs.get(location.target.daemonId)?.find(candidate => candidate.id === location.target.projectId) ?? null;
    owner.push({
      target: location.target,
      daemonId: location.target.daemonId,
      hostname: hostnames.get(location.target.daemonId) ?? location.target.daemonId,
      name: location.name,
      rootPath: location.rootPath,
      project,
    });
  }
  return presentation.projects.map(project => {
    const remote = remotes.get(project.id);
    const withHost = remote ? `${remote.host}/${remote.path}` : "";
    const label = remote
      ? counts.get(remote.path) === 1 ? remote.path
        : hostLabels.get(withHost) === 1 ? withHost : project.matchKey.slice("remote://".length)
      : project.label;
    return {
      id: project.id,
      matchKey: project.matchKey,
      label,
      locations: (locations.get(project.id) ?? []).sort((left, right) =>
        left.hostname.localeCompare(right.hostname)
        || left.rootPath.localeCompare(right.rootPath)
        || left.daemonId.localeCompare(right.daemonId)),
    };
  });
}
