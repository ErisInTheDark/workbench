/*
 * Exports:
 * - FileDocumentSnapshot: observed disk state, separate from a view's editable draft.
 * - WorkbenchFileDocument: immutable file identity, leased facts and scoped commands.
 * - default WorkbenchFileStore: own file demand and location-scoped draft persistence.
 */
import type { DaemonId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { ProjectFileSnapshot } from "workbench-shared/workbench/project/project-file";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import type { FilePayload, SaveConflictPayload, SaveFilePayload } from "workbench-shared/types";
import type WorkbenchWorkspaceClient from "../app/WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle } from "../app/WorkbenchWorkspaceClient";
import createFileDraftStore, { type FileDraftStore } from "../state/FileDraftStore";
import type WorkbenchClientStateController from "../state/WorkbenchClientStateController";

export interface FileDocumentSnapshot {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  data: ProjectFileSnapshot | null;
}

export interface WorkbenchFileDocument {
  readonly location: ProjectLocationReference;
  readonly path: string;
  readonly drafts: FileDraftStore;
  getSnapshot(): FileDocumentSnapshot;
  subscribe(listener: () => void): () => void;
  read(): Promise<FilePayload>;
  save(content: string, expectedMtimeMs: number, force?: boolean): Promise<SaveFilePayload | SaveConflictPayload>;
  reset(expectedMtimeMs: number): Promise<SaveFilePayload | SaveConflictPayload>;
}

const EMPTY: FileDocumentSnapshot = { phase: "pending", failure: null, data: null };

export default class WorkbenchFileStore {
  private readonly drafts = new Map<string, FileDraftStore>();
  private readonly documents = new Map<string, { document: WorkbenchFileDocument; stop(): void }>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly workspace: WorkbenchWorkspaceClient,
    private readonly state: WorkbenchClientStateController | undefined,
    private readonly registrationFor: (daemonId: DaemonId) => string,
    private readonly warn: (message: string) => void,
  ) {}

  subscribeDrafts = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  draftsFor(location: ProjectLocationReference) {
    const key = JSON.stringify([location.daemonId, location.projectId]);
    let drafts = this.drafts.get(key);
    if (!drafts) {
      const registration = this.registrationFor(location.daemonId);
      drafts = createFileDraftStore(() => location.projectId,
        () => { for (const listener of this.listeners) listener(); }, this.state, this.warn,
        () => this.registrationFor(location.daemonId) || registration);
      this.drafts.set(key, drafts);
      void drafts.hydratePersistedDrafts().catch(error =>
        this.warn(error instanceof Error ? error.message : "File drafts could not load."));
    }
    return drafts;
  }

  document(location: ProjectLocationReference, path: string): WorkbenchFileDocument {
    const key = JSON.stringify([location.daemonId, location.projectId, path]);
    const existing = this.documents.get(key);
    if (existing) return existing.document;
    const identity = { ...location };
    const files = this.workspace.daemon({ kind: "folder", location: identity }).projects.files;
    const listeners = new Set<() => void>();
    let handle: WorkspaceQueryHandle<"projectFile"> | null = null;
    let snapshot = EMPTY;
    let stopped = false;
    const changed = () => {
      if (!handle || stopped) return;
      const next = handle.getSnapshot();
      snapshot = { phase: next.phase, failure: next.failure, data: next.value?.data ?? snapshot.data };
      for (const listener of listeners) listener();
    };
    const document: WorkbenchFileDocument = {
      location: identity, path, drafts: this.draftsFor(identity),
      getSnapshot: () => snapshot,
      subscribe: listener => {
        if (stopped || this.disposed) return () => {};
        const notify = () => listener();
        listeners.add(notify);
        if (!handle) {
          handle = this.workspace.observe({ kind: "projectFile", location: identity, path }, changed);
          changed();
        }
        return () => {
          if (!listeners.delete(notify)) return;
          if (listeners.size) return;
          handle?.release();
          handle = null;
          snapshot = { ...snapshot, phase: "pending" };
          queueMicrotask(() => {
            if (listeners.size || handle) return;
            snapshot = EMPTY;
            if (this.documents.get(key)?.document === document) this.documents.delete(key);
          });
        };
      },
      read: () => files.read({ projectId: identity.projectId, path }),
      save: (content, expectedMtimeMs, force) =>
        files.save({ projectId: identity.projectId, path, content, expectedMtimeMs, force }),
      reset: expectedMtimeMs => files.reset({ projectId: identity.projectId, path, expectedMtimeMs }),
    };
    this.documents.set(key, { document, stop: () => {
      stopped = true;
      handle?.release();
      handle = null;
      listeners.clear();
    } });
    return document;
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.documents.values()) entry.stop();
    this.documents.clear();
    this.drafts.clear();
    this.listeners.clear();
  }
}
