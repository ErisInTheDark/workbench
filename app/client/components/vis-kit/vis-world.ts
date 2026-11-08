/*
 * Exports:
 * - VisWorldInput: a declarative fake workspace for vis mockups: devices, projects with folders per device, git facts and
 *   sidebar threads.
 * - VisWorldPayload: one observation payload as the app server would publish it, minus its subscription envelope.
 * - default VisWorld: resolve an input into stable ids, answer workspace queries and daemon commands with schema-shaped
 *   payloads, and name folders and daemons for the vis file. Wrap real components in VisProviders to feed them.
 */
import { createEmptyWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { GitPeerStatus } from "workbench-shared/workbench/git/git-peer-contracts";
import {
  DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, WorkbenchThreadIdSchema,
  type DaemonId, type LogicalProjectId, type ProjectId,
} from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkspaceObservation, WorkspaceProjects, WorkspaceQuery } from "workbench-shared/workbench/workspace/workspace-observation";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayThreadKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { WorkbenchThreadSidebarThreadRowSchema, type WorkbenchThreadSidebarThreadRow } from "workbench-shared/workbench/thread/thread-sidebar-row";

export interface VisWorldInput {
  /** `roots` are its project discovery folders; `dirs` are extra plain folders the folder picker lists. */
  daemons: Array<{ id: string; hostname?: string; asleep?: boolean; roots?: string[]; dirs?: string[] }>;
  projects: Array<{
    name: string;
    /** Network origin; omitted projects key by their first folder's path, like origin-less repositories. */
    origin?: string;
    folders: Array<{
      daemon: string;
      path: string;
      /** Null while HEAD is detached. */
      branch?: string | null;
      branches?: string[];
      upstream?: { name: string; ahead: number; behind: number } | null;
      /** Newest first. */
      commits?: Array<{ subject: string; author?: string; hoursAgo?: number; unpushed?: boolean; unsent?: boolean }>;
      stashes?: string[];
      unclaimed?: number;
    }>;
  }>;
  /** Commits each folder has that another same-project folder lacks, by `daemon:path` keys. */
  sync?: Array<{ from: string; to: string; ahead: number; behind?: number }>;
  /** Top-level sidebar threads, in the folder named by its `daemon:path` key; `id` is a UUID. */
  threads?: Array<{
    folder: string;
    id: string;
    title: string;
    status?: "working" | "needsAttention" | "completed";
    minutesAgo?: number;
    pinned?: boolean;
    claimedPaths?: string[];
  }>;
}

type VisThread = { folder: Folder; row: WorkbenchThreadSidebarThreadRow; key: string };

export type VisWorldPayload = {
  [Kind in WorkspaceObservation["kind"]]: Omit<Extract<WorkspaceObservation, { kind: Kind }>, "subscriptionId" | "generation" | "revision">;
}[WorkspaceObservation["kind"]];

interface Folder {
  key: string;
  daemon: { id: DaemonId; name: string; hostname: string; asleep: boolean };
  projectId: ProjectId;
  logicalProjectId: LogicalProjectId;
  identityKey: string;
  option: WorkbenchProjectOption;
  input: VisWorldInput["projects"][number]["folders"][number];
}

const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;

function uuid(namespace: number, index: number) {
  return `00000000-0000-4000-8${namespace.toString(16).padStart(3, "0")}-${index.toString(16).padStart(12, "0")}`;
}

/** A stable fake object id, so the same world always shows the same shas. */
function sha(seed: string) {
  let hash = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 40; round++) {
    for (const char of `${seed}#${round}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

const slug = (value: string) => value.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").toLowerCase() || "folder";
const leaf = (path: string) => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;

const LIFECYCLES = {
  working: { kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working" } },
  needsAttention: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  completed: { kind: "completed", reason: "userCompleted", settled: false },
} as const;

export default class VisWorld {
  readonly folders: readonly Folder[];
  private readonly daemons: Folder["daemon"][];
  private readonly threads: readonly VisThread[];

  constructor(readonly input: VisWorldInput) {
    this.daemons = input.daemons.map((daemon, index) => ({
      id: DaemonIdSchema.parse(uuid(1, index + 1)), name: daemon.id, hostname: daemon.hostname ?? daemon.id,
      asleep: Boolean(daemon.asleep),
    }));
    this.folders = input.projects.flatMap((project, projectIndex) => {
      const logicalProjectId = LogicalProjectIdSchema.parse(uuid(2, projectIndex + 1));
      const identityKey = ProjectIdentityKeySchema.parse(project.origin
        ? `remote://${project.origin.replace(/^[a-z]+:\/\//u, "").replace(/\.git$/u, "")}`
        : `local://${project.folders[0]?.path ?? project.name}`);
      return project.folders.map(folder => {
        const daemon = this.daemons.find(item => item.name === folder.daemon);
        if (!daemon) throw new Error(`Vis world folder ${folder.path} names unknown daemon ${folder.daemon}.`);
        const projectId = ProjectIdSchema.parse(`vis-${daemon.name}-${slug(folder.path)}`);
        const name = leaf(folder.path);
        return {
          key: `${folder.daemon}:${folder.path}`, daemon, projectId, logicalProjectId, identityKey, input: folder,
          option: {
            id: projectId, kind: "git", name, rootPath: folder.path, relativePath: name, lastCommitTimeMs: NOW - HOUR,
            roots: [{ id: "root", isPrimary: true, name, rootPath: folder.path, relativePath: "" }],
          } satisfies WorkbenchProjectOption,
        };
      });
    });
    // Sidebar times read relative to the viewer's clock, so threads are placed against it, to the whole second rows carry.
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    this.threads = (input.threads ?? []).map(thread => {
      const folder = this.folder(thread.folder);
      const threadId = WorkbenchThreadIdSchema.parse(thread.id);
      const row = WorkbenchThreadSidebarThreadRowSchema.parse({
        activityAt: now - (thread.minutesAgo ?? 1) * 60_000, entryKind: "thread", title: thread.title,
        identity: { harness: "codex", threadId }, lifecycle: LIFECYCLES[thread.status ?? "completed"],
        metadata: { archived: false, pinned: Boolean(thread.pinned), snoozed: false },
        ...(thread.claimedPaths?.length ? { gitArc: {
          phase: "active", checkpointCommit: sha(`${thread.id}/checkpoint`), claimedPaths: thread.claimedPaths, proposals: [],
        } } : {}),
      });
      return { folder, row, key: getProjectQualifiedThreadDisplayKey(folder.logicalProjectId, getThreadDisplayThreadKey("codex", threadId)) };
    });
  }

  /** The folder named `daemon:path`. */
  folder(key: string) {
    const folder = this.folders.find(item => item.key === key);
    if (!folder) throw new Error(`Vis world has no folder ${key}.`);
    return folder;
  }

  location(key: string): ProjectLocationReference {
    const folder = this.folder(key);
    return { daemonId: folder.daemon.id, projectId: folder.projectId };
  }

  daemonId(name: string) {
    const daemon = this.daemons.find(item => item.name === name);
    if (!daemon) throw new Error(`Vis world has no daemon ${name}.`);
    return daemon.id;
  }

  /** The payload for a query, or null when the world does not model it. */
  observe(query: WorkspaceQuery): VisWorldPayload | null {
    const current = { phase: "current" as const, failure: null };
    switch (query.kind) {
      case "presentation": return { ...current, kind: "presentation", data: this.presentation() };
      case "appState": return { ...current, kind: "appState", data: this.appState(1) };
      case "projects": return { ...current, kind: "projects", data: this.projects() };
      case "projectGroups": {
        const ids = [...new Set(this.folders.map(folder => folder.logicalProjectId))];
        return { ...current, kind: "projectGroups", data: { orderedProjectIds: ids, unsettledProjectIds: [], unarchivedProjectIds: [] } };
      }
      case "projectSelection": return { ...current, kind: "projectSelection" };
      case "projectThreads": {
        const listed = this.threads.filter(thread => !query.projects
          || query.projects.some(project => project.kind === "logical" ? project.projectId === thread.folder.logicalProjectId
            : project.location.daemonId === thread.folder.daemon.id && project.location.projectId === thread.folder.projectId));
        const keys = (pinned: boolean) => listed.filter(thread => thread.row.entryKind === "thread" && thread.row.metadata.pinned === pinned)
          .map(thread => thread.key);
        return { ...current, kind: "projectThreads", data: {
          members: listed.map(({ folder, row, key }) => ({
            key, homeKey: key, logicalProjectId: folder.logicalProjectId, location: { daemonId: folder.daemon.id, projectId: folder.projectId },
            hostname: folder.daemon.hostname, rootPath: folder.input.path, title: row.title, activityAt: row.activityAt,
            ref: { kind: "thread" as const, identity: row.identity },
          })),
          folders: { pinned: [], projects: {} },
          placement: {
            main: keys(false), archived: [], pinned: keys(true).map(key => ({ kind: "thread" as const, key })), snoozed: [], settled: [],
            settledCount: 0,
          },
          projects: this.folders.map(folder => ({ location: { daemonId: folder.daemon.id, projectId: folder.projectId }, ...current, archivedCount: 0 })),
        } };
      }
      case "archivedThreads": return { ...current, kind: "archivedThreads", data: { members: [], projects: [] } };
      case "threadSummaries": return { ...current, kind: "threadSummaries", data: Object.fromEntries(query.threadIds.map(threadId => {
        const thread = this.thread(threadId);
        return [threadId, thread ? {
          location: { daemonId: thread.folder.daemon.id, projectId: thread.folder.projectId }, logicalProjectId: thread.folder.logicalProjectId,
          summary: { facts: {}, row: thread.row },
        } : null];
      })) };
      case "thread": {
        const thread = this.thread(query.threadId);
        return { ...current, kind: "thread", data: null, runtime: {}, owner: thread ? {
          phase: "current", logicalProjectId: thread.folder.logicalProjectId,
          location: { daemonId: thread.folder.daemon.id, projectId: thread.folder.projectId },
          identity: { harness: thread.row.identity.harness, projectId: thread.folder.projectId, threadId: thread.row.identity.threadId },
        } : { phase: "unavailable", failure: "This vis world has no such thread." } };
      }
      case "runtime": return { ...current, kind: "runtime", data: null };
      case "reloadOperation": return { ...current, kind: "reloadOperation",
        data: { action: null, phase: "idle", error: null, startedAt: null, daemonId: null } };
      case "daemonRuntime": return { ...current, kind: "daemonRuntime", daemonId: query.daemonId ?? null, data: null };
      case "daemonUpdate": return { ...current, kind: "daemonUpdate", daemonId: query.daemonId ?? null, data: null };
      case "network": return { ...current, kind: "network", data: null };
      case "accountLimits": return { ...current, kind: "accountLimits", data: null };
      case "projectTree": return { ...current, kind: "projectTree", sourceGeneration: 0, data: null };
      case "workingTreeSummary": {
        const folder = this.at(query.location);
        return folder ? { ...current, kind: "workingTreeSummary", data: {
          repositories: [{ rootId: "root", label: folder.option.name, dirty: Boolean(folder.input.unclaimed), unclaimed: folder.input.unclaimed ?? 0 }],
          errors: [],
        } } : null;
      }
      case "gitPeers": {
        const folder = this.at(query.location);
        return folder ? { ...current, kind: "gitPeers", data: {
          branch: this.branch(folder), upstream: folder.input.upstream ?? null, peers: this.peers(folder),
        } } : null;
      }
      case "gitBranches": {
        const folder = this.at(query.location);
        if (!folder) return null;
        const checkedOut = this.branch(folder);
        const names = [...new Set([...checkedOut ? [checkedOut] : [], ...folder.input.branches ?? []])];
        return { ...current, kind: "gitBranches", data: {
          current: checkedOut, head: this.head(folder),
          branches: names.map(name => ({
            name, head: name === checkedOut ? this.head(folder) : sha(`${folder.key}/${name}`), committedAt: NOW - HOUR,
            upstream: name === checkedOut ? folder.input.upstream ?? null : null, worktree: null,
          })),
        } };
      }
      case "gitHistory": {
        const folder = this.at(query.location);
        if (!folder) return null;
        const commits = (folder.input.commits ?? []).slice(0, query.limit).map((commit, index) => ({
          commit: sha(`${folder.identityKey}/${commit.subject}`), subject: commit.subject, author: commit.author ?? "eris",
          authoredAt: NOW - (commit.hoursAgo ?? index + 1) * HOUR, unpushed: Boolean(commit.unpushed), unsent: Boolean(commit.unsent),
        }));
        return { ...current, kind: "gitHistory", data: {
          branch: this.branch(folder), head: this.head(folder), commits, complete: commits.length === (folder.input.commits ?? []).length,
        } };
      }
      case "gitStashes": {
        const folder = this.at(query.location);
        return folder ? { ...current, kind: "gitStashes", data: { stashes: (folder.input.stashes ?? []).map((message, index) => ({
          sha: sha(`${folder.key}/stash/${index}`), index, message, createdAt: NOW - (index + 1) * HOUR,
        })) } } : null;
      }
      default: return null;
    }
  }

  /**
   * A daemon command's result, or null when the world does not model it. `location` is the folder a folder command
   * targets; `daemonId` the installation an installation command targets.
   */
  command(method: string, params: Record<string, unknown>, location: ProjectLocationReference | null, daemonId: string | null): object | null {
    const daemon = this.daemons.find(item => item.id === (location?.daemonId ?? daemonId));
    switch (method) {
      case "voice/configuration/read": return { selection: null };
      case "project/discovery-settings/read": return daemon ? { paths: this.roots(daemon) } : null;
      case "project/folders/list": {
        if (!daemon || typeof params.path !== "string") return null;
        const parent = params.path.replace(/\/+$/u, "") || "/";
        const prefix = parent === "/" ? "/" : `${parent}/`;
        const repositories = new Set(this.folders.filter(folder => folder.daemon.id === daemon.id).map(folder => folder.input.path));
        const known = [...repositories, ...this.input.daemons.find(item => item.id === daemon.name)?.dirs ?? []];
        const names = [...new Set(known.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split("/")[0]!))]
          .filter(Boolean).sort();
        return {
          path: parent, parentPath: parent === "/" ? null : parent.slice(0, parent.lastIndexOf("/")) || "/", truncated: false,
          entries: names.map(name => ({ name, path: `${prefix}${name}`, isGitRepository: repositories.has(`${prefix}${name}`) })),
        };
      }
      case "git/working-tree/read": {
        const folder = location ? this.at(location) : null;
        return folder ? { errors: [], repositories: [{
          rootId: "root", label: folder.option.name, cwd: folder.input.path, head: this.head(folder), tree: sha(`${folder.key}/tree`),
          branch: this.branch(folder), message: "", amendReason: null, blockedReason: null, files: [], owners: [],
        }] } : null;
      }
      default: return null;
    }
  }

  /** The app state the page starts with, and every acknowledgement after; writes are not kept. */
  appState(revision: number) {
    return {
      kind: revision === 1 ? "snapshot" as const : "delta" as const, daemonRegistrationId: "vis", oldestAvailableRevision: 0, revision,
      schemaVersion: Math.max(...Object.values(appStateReleases).map(release => release.version)),
      rows: createEmptyWorkbenchClientStateRows(),
    };
  }

  private thread(threadId: string) {
    return this.threads.find(thread => thread.row.identity.threadId === threadId) ?? null;
  }

  private roots(daemon: Folder["daemon"]) {
    return this.input.daemons.find(item => item.id === daemon.name)?.roots ?? ["/git"];
  }

  private at(location: ProjectLocationReference) {
    return this.folders.find(folder => folder.daemon.id === location.daemonId && folder.projectId === location.projectId) ?? null;
  }

  private branch(folder: Folder) {
    return folder.input.branch === undefined ? "main" : folder.input.branch;
  }

  private head(folder: Folder) {
    const newest = folder.input.commits?.[0];
    return newest ? sha(`${folder.identityKey}/${newest.subject}`) : sha(`${folder.key}/head`);
  }

  private relation(from: Folder, to: Folder) {
    const forward = this.input.sync?.find(item => item.from === from.key && item.to === to.key);
    if (forward) return { ahead: forward.ahead, behind: forward.behind ?? 0 };
    const backward = this.input.sync?.find(item => item.from === to.key && item.to === from.key);
    return backward ? { ahead: backward.behind ?? 0, behind: backward.ahead } : { ahead: 0, behind: 0 };
  }

  /** Same-project folders on other daemons, as the app's peer sync reports them. */
  private peers(folder: Folder): GitPeerStatus[] {
    return this.folders.filter(other => other.logicalProjectId === folder.logicalProjectId && other.daemon.id !== folder.daemon.id)
      .map(other => {
        const base = { daemonId: other.daemon.id, projectId: other.projectId, hostname: other.daemon.hostname,
          rootPath: other.input.path, failure: null };
        if (other.daemon.asleep) return { ...base, state: "offline", ahead: 0, behind: 0 };
        if (this.branch(other) !== this.branch(folder)) return { ...base, state: "otherBranch", ahead: 0, behind: 0 };
        return { ...base, state: "current", ...this.relation(folder, other) };
      });
  }

  private presentation(): PresentationSnapshot {
    const projects = new Map(this.folders.map(folder => [folder.logicalProjectId, folder]));
    return {
      revision: 1,
      daemons: this.daemons.map(daemon => ({ id: daemon.id, hostname: daemon.hostname })),
      projects: [...projects.values()].map(folder => ({ id: folder.logicalProjectId, matchKey: folder.identityKey, label: folder.option.name })),
      locations: this.folders.map(folder => ({
        target: { daemonId: folder.daemon.id, projectId: folder.projectId }, logicalProjectId: folder.logicalProjectId,
        identityKey: folder.identityKey, name: folder.option.name, rootPath: folder.input.path,
      })),
      defaults: [], recentLaunches: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [], hiddenLocations: [],
    };
  }

  private projects(): WorkspaceProjects {
    const ids = [...new Set(this.folders.map(folder => folder.logicalProjectId))];
    return {
      projects: ids.map(id => {
        const members = this.folders.filter(folder => folder.logicalProjectId === id);
        return {
          id, matchKey: members[0]!.identityKey, label: members[0]!.option.name,
          locations: members.map(folder => ({
            target: { daemonId: folder.daemon.id, projectId: folder.projectId }, daemonId: folder.daemon.id,
            hostname: folder.daemon.hostname, name: folder.option.name, rootPath: folder.input.path,
            project: folder.daemon.asleep ? null : folder.option,
          })),
        };
      }),
      observedProjects: [],
      summaries: {},
      sources: this.daemons.map(daemon => ({
        daemonId: daemon.id, hostname: daemon.hostname, connection: daemon.asleep ? "sleeping" : "current", generation: 1, failure: null,
      })),
      catalogues: this.daemons.map(daemon => ({ daemonId: daemon.id, phase: daemon.asleep ? "unavailable" : "current", failure: null })),
      navigation: [],
    };
  }
}
