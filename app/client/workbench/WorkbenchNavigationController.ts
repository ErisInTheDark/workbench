/*
 * Exports:
 * - WorkbenchNavigationSnapshot: active route, generation, failure, and pinned draft projection.
 * - WorkbenchNavigationPorts: project, identity, sidebar, file, and thread navigation boundaries.
 * - default WorkbenchNavigationController: own route application, freshness, selection ordering, pinned drafts, and failures.
 */

import type {
  WorkbenchHarness,
  WorkbenchProjectOption,
  WorkbenchRouteLoadResult,
} from "workbench-shared/types";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import {
  getWorkbenchThreadTargetRootId,
  getWorkbenchThreadTargetSelectedId,
  isSameWorkbenchRoute,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type {
  WorkbenchThreadDraft,
  WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";

type ThreadTarget = NonNullable<WorkbenchRoute["threadTarget"]>;

export interface WorkbenchNavigationSnapshot {
  error: string | null;
  generation: number;
  route: WorkbenchRoute;
  selectedPinnedThreadDraft: WorkbenchThreadDraft | null;
}

export interface WorkbenchNavigationPorts {
  activateThreadControllers: () => void;
  applyDraft: (
    entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>,
    project?: WorkbenchProjectOption,
  ) => void;
  clearSelection: () => void;
  createDraft: (project?: WorkbenchProjectOption) => void;
  ensureProject: (route: WorkbenchRoute) => Promise<string>;
  failThread: (projectId: string, target: Exclude<ThreadTarget, { kind: "new" }>, error: string) => void;
  getLocalEntries: () => readonly WorkbenchThreadSidebarEntry[];
  getProject: (projectId: string) => WorkbenchProjectOption | undefined;
  getProjectEntries: (projectId: string) => readonly WorkbenchThreadSidebarEntry[];
  guardNavigation: (apply: () => Promise<void>) => Promise<void>;
  hydrateSidebar: (route: WorkbenchRoute, generation: number) => void;
  openFile: (filePath: string) => Promise<boolean>;
  openLogicalRoute?: (route: WorkbenchRoute, isCurrent: () => boolean) => Promise<WorkbenchRouteLoadResult>;
  openThread: (
    threadId: string,
    options: {
      harness?: WorkbenchHarness;
      isCurrent: () => boolean;
      project?: WorkbenchProjectOption;
    },
  ) => Promise<WorkbenchRouteLoadResult>;
  readPinnedContext: (
    projectId: string,
    target: ThreadTarget,
  ) => Promise<
    | { error: string; ok: false }
    | { context: { entries: readonly WorkbenchThreadSidebarEntry[]; projectId: string; target: ThreadTarget }; ok: true }
  >;
  receiveDraft: (draft: WorkbenchThreadDraft) => void;
  reportStatus: (message: string) => void;
  resolveDraftReferences: (projectId: string) => Promise<boolean>;
  resolveProjectId: (projectId: string) => string;
  resolveRoute: (route: WorkbenchRoute) => Promise<WorkbenchRoute>;
}

function cloneDraft(draft: WorkbenchThreadDraft) {
  return structuredClone(draft);
}

function isPinnedContextTargetMatch(requested: ThreadTarget, admitted: ThreadTarget) {
  return requested.kind === admitted.kind
    && getWorkbenchThreadTargetRootId(requested) === getWorkbenchThreadTargetRootId(admitted)
    && getWorkbenchThreadTargetSelectedId(requested) === getWorkbenchThreadTargetSelectedId(admitted);
}

export default class WorkbenchNavigationController {
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkbenchNavigationSnapshot;

  constructor(initialRoute: WorkbenchRoute, private readonly ports: WorkbenchNavigationPorts) {
    this.snapshot = {
      error: null,
      generation: 0,
      route: initialRoute,
      selectedPinnedThreadDraft: null,
    };
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isCurrent(route: WorkbenchRoute, generation: number) {
    const active = this.snapshot;
    return active.generation === generation
      && active.route.view === route.view
      && active.route.projectId === route.projectId
      && active.route.filePath === route.filePath
      && active.route.settingsScope === route.settingsScope
      && active.route.threadId === route.threadId
      && active.route.threadOwnerProjectId === route.threadOwnerProjectId
      && isSameWorkbenchRoute(active.route, route);
  }

  async applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    let result: WorkbenchRouteLoadResult = { ok: false };
    let generation: number | undefined;
    await this.ports.guardNavigation(async () => {
      generation = this.snapshot.generation + 1;
      result = await this.applyRouteOwned(route);
    });
    if (route.view === "thread" && !route.logical && this.snapshot.generation === generation && !result.ok && result.error) {
      const target = route.threadTarget ?? {
        kind: "provider" as const,
        threadId: ThreadReferenceSchema.parse(route.threadId),
      };
      if (target.kind !== "new") {
        const owner = route.threadOwnerProjectId || route.projectId;
        this.ports.failThread(this.ports.resolveProjectId(owner), target, result.error);
      }
    }
    if (this.snapshot.generation === generation) {
      this.publish({ ...this.snapshot, error: result.ok ? null : result.error ?? null });
    }
    return result;
  }

  clearPinnedDraft(projectId: string, draftId: string) {
    const selected = this.snapshot.selectedPinnedThreadDraft;
    if (selected?.projectId !== projectId || selected.draftId !== draftId) return;
    this.publish({ ...this.snapshot, selectedPinnedThreadDraft: null });
  }

  updatePinnedDraft(draft: WorkbenchThreadDraft) {
    const selected = this.snapshot.selectedPinnedThreadDraft;
    if (selected?.projectId !== draft.projectId || selected.draftId !== draft.draftId) return;
    this.publish({ ...this.snapshot, selectedPinnedThreadDraft: cloneDraft(draft) });
  }

  movePinnedDraft(sourceProjectId: string, destinationProjectId: string, draftId: string) {
    const selected = this.snapshot.selectedPinnedThreadDraft;
    if (selected?.projectId !== sourceProjectId || selected.draftId !== draftId) return;
    this.publish({
      ...this.snapshot,
      selectedPinnedThreadDraft: {
        ...selected,
        projectId: ProjectIdSchema.parse(destinationProjectId),
      },
    });
  }

  readPinnedDraft(read: (projectId: string, draftId: string) => WorkbenchThreadDraft | null) {
    const selected = this.snapshot.selectedPinnedThreadDraft;
    if (!selected) return null;
    const draft = read(selected.projectId, selected.draftId);
    return draft ? cloneDraft(draft) : null;
  }

  dispose() {
    this.listeners.clear();
  }

  private async applyRouteOwned(requestedRoute: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    const generation = this.snapshot.generation + 1;
    let route = requestedRoute;
    this.publish({
      error: null,
      generation,
      route,
      selectedPinnedThreadDraft: null,
    });
    if (route.view === "thread" && route.threadTarget?.kind === "new") this.ports.clearSelection();

    if (route.view === "invalid") {
      this.ports.clearSelection();
      return { error: route.error || "Invalid route.", ok: false };
    }

    if (route.logical) {
      if (!this.ports.openLogicalRoute) return { error: "Logical project navigation is unavailable.", ok: false };
      const result = await this.ports.openLogicalRoute(route, () => this.isCurrent(route, generation));
      return this.isCurrent(route, generation) ? result : { ok: false };
    }

    const projectError = await this.ports.ensureProject(route);
    if (projectError) {
      this.ports.clearSelection();
      return { error: projectError, ok: false };
    }
    if (!this.isCurrent(route, generation)) return { ok: false };

    try {
      const projectRoute = {
        ...route,
        projectId: route.projectId ? this.ports.resolveProjectId(route.projectId) : route.projectId,
        threadOwnerProjectId: route.threadOwnerProjectId
          ? this.ports.resolveProjectId(route.threadOwnerProjectId)
          : route.threadOwnerProjectId,
      } as WorkbenchRoute;
      const canonicalRoute = await this.ports.resolveRoute(projectRoute);
      if (!this.isCurrent(route, generation)) return { ok: false };
      route = projectRoute;
      this.publish({ ...this.snapshot, route });
      if (route.view === "thread") {
        const projectId = route.threadOwnerProjectId || route.projectId;
        if (await this.ports.resolveDraftReferences(projectId)) {
          this.ports.reportStatus("Some saved draft identities could not be resolved. Their stored drafts remain unchanged.");
        }
        if (!this.isCurrent(route, generation)) return { ok: false };
      }
      if (!isSameWorkbenchRoute(route, canonicalRoute)) return { ok: true, canonicalRoute };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Unable to resolve thread identity.",
        ok: false,
      };
    }

    if (route.view === "home" || route.view === "project" || route.view === "settings" || route.view === "mosaic") {
      this.ports.clearSelection();
      this.ports.hydrateSidebar(route, generation);
      if (route.view === "mosaic") this.ports.activateThreadControllers();
      return { ok: true };
    }

    if (route.view === "file") {
      this.ports.clearSelection();
      this.ports.hydrateSidebar(route, generation);
      const didOpen = await this.ports.openFile(route.filePath);
      if (!this.isCurrent(route, generation)) return { ok: false };
      return didOpen ? { ok: true } : { error: `File not found: ${route.filePath}`, ok: false };
    }

    if (route.view === "thread") {
      this.ports.hydrateSidebar(route, generation);
      const target = route.threadTarget ?? {
        kind: "provider" as const,
        threadId: ThreadReferenceSchema.parse(route.threadId),
      };
      const ownerProjectId = route.threadOwnerProjectId || route.projectId;
      const isHomeThread = !route.projectId;
      const isForeignPin = !isHomeThread && ownerProjectId !== route.projectId;
      const ownerProject = isHomeThread || isForeignPin
        ? this.ports.getProject(ownerProjectId)
        : undefined;
      let ownerEntries = isHomeThread ? this.ports.getProjectEntries(ownerProjectId) : [];
      if ((isHomeThread || isForeignPin) && !ownerProject) {
        this.ports.clearSelection();
        return { error: `Thread project not found: ${ownerProjectId}`, ok: false };
      }
      if (isForeignPin) {
        const result = await this.ports.readPinnedContext(ownerProjectId, target);
        if (!result.ok || result.context.projectId !== ownerProjectId || !isPinnedContextTargetMatch(target, result.context.target)) {
          this.ports.clearSelection();
          return { error: result.ok ? "This pinned thread is missing, snoozed, or no longer pinned." : result.error, ok: false };
        }
        ownerEntries = [...result.context.entries];
      }
      if (target.kind === "new") {
        if (isForeignPin) return { error: "Pinned routes cannot open a new thread.", ok: false };
        this.ports.createDraft(ownerProject);
        return { ok: true };
      }
      if (target.kind === "draft") {
        const entries = isHomeThread || isForeignPin ? ownerEntries : this.ports.getLocalEntries();
        const entry = entries.find(candidate => candidate.entryKind === "draft" && candidate.draft.draftId === target.draftId);
        if (!entry || entry.entryKind !== "draft") {
          this.ports.clearSelection();
          return { error: "This draft is missing or belongs to another project.", ok: false };
        }
        this.publish({
          ...this.snapshot,
          selectedPinnedThreadDraft: isHomeThread || isForeignPin ? cloneDraft(entry.draft) : null,
        });
        this.ports.receiveDraft(entry.draft);
        this.ports.applyDraft(entry, ownerProject);
        return { ok: true };
      }
      const rootThreadId = target.kind === "subagent" ? target.parentThreadId : target.threadId;
      const openResult = await this.ports.openThread(rootThreadId, {
        harness: target.harness,
        project: ownerProject,
        isCurrent: () => this.isCurrent(route, generation),
      });
      return this.isCurrent(route, generation) ? openResult : { ok: false };
    }

    return { error: "Unknown route.", ok: false };
  }

  private publish(snapshot: WorkbenchNavigationSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
