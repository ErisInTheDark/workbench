/*
 * Exports:
 * - WorkbenchDaemonSessionSnapshot: one concrete daemon's availability and catalog state.
 * - default WorkbenchDaemonSession: own one daemon socket, project client, registration, and catalog refresh.
 */
import type { WorkbenchProjectsPayload } from "workbench-shared/types";
import { DaemonIdSchema, type DaemonId, type ProjectId } from "workbench-shared/workbench/identity";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import {
  WorkbenchCreateEntryResultSchema, WorkbenchDeleteFileResultSchema,
} from "workbench-shared/workbench/project/project-state";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchClientStateController from "./state/WorkbenchClientStateController";
import type WorkbenchPresentationClient from "./state/WorkbenchPresentationClient";
import ThreadSidebarClient, {
  openWorkbenchGlobalThreadStateObservation, openWorkbenchThreadStateObservation,
} from "./thread/ThreadSidebarClient";
import WorkbenchProjectClient from "./WorkbenchProjectClient";
import WorkbenchThreadClient from "./WorkbenchThreadClient";

export interface WorkbenchDaemonSessionSnapshot {
  daemonId: DaemonId;
  hostname: string;
  phase: "connecting" | "ready" | "unavailable";
  error: string | null;
  catalog: WorkbenchProjectsPayload | null;
  registrationId: string | null;
}

export default class WorkbenchDaemonSession {
  readonly daemon;
  readonly threads;
  private projectsClient: ReturnType<typeof WorkbenchProjectClient> | null;
  private sidebarClient: ThreadSidebarClient | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly importedLayouts = new Set<string>();
  private readonly unsubscribeOpen: () => void;
  private readonly unsubscribeClose: () => void;
  private readonly unsubscribeNotifications: () => void;
  private disposed = false;
  private started = false;
  private opening: Promise<void> | null = null;
  private observedProjectId: ProjectId | null = null;
  private observing: Promise<void> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private importAbort: AbortController | null = null;
  private importTask: Promise<void> | null = null;
  private layoutImport: Promise<void> | null = null;
  private state: WorkbenchDaemonSessionSnapshot;

  constructor(private readonly options: {
    daemonId: DaemonId;
    hostname: string;
    resolveUrl?: () => Promise<string>;
    attached?: {
      threads: ReturnType<typeof WorkbenchThreadClient>;
      daemon: WorkbenchDaemonClient;
      projects: ReturnType<typeof WorkbenchProjectClient>;
      sidebar: ThreadSidebarClient;
    };
    appState: WorkbenchClientStateController;
    presentation: WorkbenchPresentationClient;
    onError?: (message: string) => void;
  }) {
    this.sidebarClient = options.attached?.sidebar ?? null;
    this.state = {
      daemonId: DaemonIdSchema.parse(options.daemonId), hostname: options.hostname,
      phase: "connecting", error: null, catalog: null, registrationId: null,
    };
    this.threads = options.attached?.threads ?? WorkbenchThreadClient({
      resolveDaemonUrl: options.resolveUrl,
      getProjectById: projectId => this.projectsClient?.getSnapshot().projects.find(project => project.id === projectId),
      onStatusMessage: message => options.onError?.(message),
    });
    this.daemon = options.attached?.daemon ?? new WorkbenchDaemonClient({
      request: async (method, params) => await this.threads.requestWorkbench(method, params),
      onNotification: listener => this.threads.onWorkbenchNotification(listener),
      onReconnect: listener => this.threads.onReconnect(listener),
      onDisconnect: listener => this.threads.onDisconnect(listener),
    });
    this.projectsClient = options.attached?.projects ?? null;
    this.unsubscribeOpen = this.threads.onConnectionOpen(() => {
      void this.refresh();
    });
    this.unsubscribeClose = this.threads.onDisconnect(() => {
      if (!this.disposed) this.publish({ ...this.state, phase: "unavailable", error: "Daemon connection closed." });
    });
    this.unsubscribeNotifications = this.threads.onWorkbenchNotification(notification => {
      if (this.disposed || this.options.attached) return;
      if (notification.method === "workbench/thread-state/updated") {
        this.sidebarClient?.acceptDaemonUpdate(notification.params, update => this.projectsClient?.accept(update));
      } else if (notification.method === "workbench/thread-state/reset") {
        void this.refresh();
      }
    });
  }

  getSnapshot = () => this.state;
  get projects() { return this.projectsClient; }
  get sidebar() { return this.sidebarClient; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async observeProject(projectId: ProjectId | null) {
    if (this.disposed) throw new Error("Daemon session has closed.");
    this.observedProjectId = projectId;
    if (this.refreshing) await this.refreshing;
    if (!this.sidebarClient) return;
    if (this.observing) await this.observing;
    if (this.observedProjectId !== projectId || this.disposed) return;
    if (projectId === null && this.sidebarClient.isObservingGlobal()) return;
    const operation = this.sidebarClient.refreshFor(projectId);
    this.observing = operation;
    try {
      await operation;
    } finally {
      if (this.observing === operation) this.observing = null;
    }
  }

  async importAvailableLayouts() {
    if (this.disposed) throw new Error("Daemon session has closed.");
    if (this.layoutImport) return await this.layoutImport;
    const operation = (async () => {
      if (this.refreshing) await this.refreshing;
      if (this.importTask) await this.importTask;
      if (this.disposed) throw new Error("Daemon session has closed.");
      await this.importObservedLayouts(this.importAbort?.signal);
    })().finally(() => {
      if (this.layoutImport === operation) this.layoutImport = null;
    });
    this.layoutImport = operation;
    return await operation;
  }

  private async importObservedLayouts(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const presentation = this.options.presentation.snapshot().data;
    if (!presentation || !this.sidebarClient) return;
    for (const location of presentation.locations.filter(item => item.target.daemonId === this.options.daemonId)) {
      signal?.throwIfAborted();
      const projectId = location.target.projectId;
      const sourceKey = `project:${projectId}`;
      if (this.importedLayouts.has(sourceKey)) continue;
      const sidebar = this.sidebarClient.getProjectSnapshot(projectId);
      if (!sidebar) continue;
      try {
        await this.options.presentation.importProjectLayout(
          this.options.daemonId, projectId, location.logicalProjectId, this.daemon, sidebar, signal,
        );
        signal?.throwIfAborted();
        this.importedLayouts.add(sourceKey);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.reportImportFailure(error instanceof Error ? error.message
          : "Legacy project layout import failed.");
      }
    }
    if (!this.sidebarClient.isObservingGlobal()) return;
    const sidebars = this.sidebarClient.getProjectThreadSidebars();
    for (const scope of ["home", "pinned"] as const) {
      signal?.throwIfAborted();
      if (this.importedLayouts.has(scope)) continue;
      try {
        if (scope === "home" && this.sidebarClient.getHomeThreadDisplayOrderSupported()) {
          await this.options.presentation.importHomeLayout(this.options.daemonId, this.daemon, sidebars, signal);
        } else if (scope === "pinned") {
          await this.options.presentation.importPinnedLayout(this.options.daemonId, this.daemon, sidebars, signal);
        }
        signal?.throwIfAborted();
        this.importedLayouts.add(scope);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.reportImportFailure(error instanceof Error ? error.message
          : "Legacy global layout import failed.");
      }
    }
  }

  async start() {
    if (this.disposed) throw new Error("Daemon session has closed.");
    if (this.opening) return await this.opening;
    if (this.started) return;
    this.started = true;
    this.opening = this.connectAndRead().finally(() => { this.opening = null; });
    return await this.opening;
  }

  private async connectAndRead() {
    try {
      await this.threads.connect();
      if (this.refreshing) await this.refreshing;
      else if (this.state.phase !== "ready") await this.refresh();
    } catch (error) {
      this.fail(error);
    }
  }

  async refresh(): Promise<boolean> {
    if (this.disposed) throw new Error("Daemon session has closed.");
    if (this.refreshing) return await this.refreshing;
    const operation = this.read().then(() => true, error => {
      this.fail(error);
      return false;
    }).finally(() => {
      if (this.refreshing === operation) this.refreshing = null;
    });
    this.refreshing = operation;
    return await operation;
  }

  private async read() {
    this.importAbort?.abort();
    const registrationId = await this.options.appState.ensureDaemonRegistration(
      this.options.daemonId, Boolean(this.options.attached),
    );
    const [catalog, locations] = await Promise.all([
      this.daemon.projects.catalog(),
      this.daemon.projects.locations(),
    ]);
    if (this.disposed) throw new Error("Daemon session closed during catalog refresh.");
    const registered = await this.options.presentation.mutate({
      kind: "registerLocations",
      daemonId: this.options.daemonId,
      hostname: this.options.hostname,
      catalog: locations,
    });
    if (this.disposed) throw new Error("Daemon session closed during catalog refresh.");
    const projects = this.projectsClient ?? WorkbenchProjectClient({
      clientStateController: this.options.appState,
      daemonRegistrationId: registrationId,
      onError: message => this.options.onError?.(message),
      transport: {
        readCatalog: async () => await this.daemon.projects.catalog(),
        createEntry: async (projectId, parentPath, name, type) => {
          const result = WorkbenchCreateEntryResultSchema.safeParse(await this.threads.requestWorkbench(
            "workbench/thread-state/project/entry/create", { name, parentPath, projectId, type },
          ));
          if (!result.success) {
            reportClientSchemaError("Rejected Workbench project entry creation", result.error);
            throw new Error("Project entry creation returned invalid data.");
          }
          return result.data;
        },
        deleteFile: async (projectId, filePath, options) => {
          const result = WorkbenchDeleteFileResultSchema.safeParse(await this.threads.requestWorkbench(
            "workbench/thread-state/project/file/delete",
            { confirmUntracked: options.confirmUntracked, path: filePath, projectId },
          ));
          if (!result.success) {
            reportClientSchemaError("Rejected Workbench project file deletion", result.error);
            throw new Error("Project file deletion returned invalid data.");
          }
          return result.data;
        },
        refresh: async projectId => {
          await this.threads.requestWorkbench("workbench/thread-state/project/refresh", { projectId });
        },
      },
    });
    this.projectsClient = projects;
    await projects.installCatalog(catalog);
    let sidebarError: string | null = null;
    if (!this.options.attached) {
      const sidebar = this.sidebarClient ?? new ThreadSidebarClient({
        onChange: () => this.publish(this.state),
        transport: {
          close: async projectId => {
            await this.threads.requestWorkbench("workbench/thread-state/close", { projectId });
          },
          closeGlobal: async () => {
            await this.threads.requestWorkbench("workbench/thread-state/global/close", {});
          },
          open: async projectId => await openWorkbenchThreadStateObservation({
            acceptProject: projects.accept,
            installCatalog: projects.installCatalog,
            projectId,
            request: async params => await this.threads.requestWorkbench("workbench/thread-state/open", params),
          }),
          openGlobal: async () => await openWorkbenchGlobalThreadStateObservation({
            installCatalog: projects.installCatalog,
            request: async version => await this.threads.requestWorkbench("workbench/thread-state/global/open", { version }),
          }),
          deleteDraft: async () => { throw new Error("Draft edits require app presentation state."); },
          moveDraft: async () => { throw new Error("Draft edits require app presentation state."); },
          upsertDraft: async () => { throw new Error("Draft edits require app presentation state."); },
        },
      });
      this.sidebarClient = sidebar;
      try {
        await sidebar.refreshFor(this.observedProjectId);
      } catch (error) {
        sidebarError = error instanceof Error ? error.message.slice(0, 512) : "Thread list is unavailable.";
        this.options.onError?.(sidebarError);
      }
    }
    if (!this.disposed) this.publish({
      ...this.state, phase: "ready", error: sidebarError, catalog, registrationId,
    });
    if (!this.disposed) this.startImport(registered, locations.data.map(item => item.project.id));
  }

  private startImport(registered: Awaited<ReturnType<WorkbenchPresentationClient["mutate"]>>,
    projectIds: readonly ProjectId[]) {
    const controller = new AbortController();
    this.importAbort = controller;
    this.importedLayouts.clear();
    const operation = (async () => {
      for (const projectId of projectIds) {
        controller.signal.throwIfAborted();
        const location = registered.locations.find(item => item.target.daemonId === this.options.daemonId
          && item.target.projectId === projectId);
        if (!location) continue;
        try {
          await this.options.presentation.importProject(this.options.daemonId,
            location.target.projectId, location.logicalProjectId, this.daemon, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : "Legacy draft import failed.";
          this.reportImportFailure(`Legacy drafts remain on ${this.options.hostname}: ${message}`);
        }
      }
      await this.importObservedLayouts(controller.signal);
    })().catch(error => {
      if (controller.signal.aborted || this.disposed) return;
      this.reportImportFailure(error instanceof Error ? error.message : "Legacy presentation import failed.");
    }).finally(() => {
      if (this.importTask === operation) this.importTask = null;
    });
    this.importTask = operation;
  }

  private reportImportFailure(message: string) {
    if (this.disposed) return;
    const bounded = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512);
    console.warn(`Workbench presentation import failed: ${bounded}`);
    this.options.onError?.(bounded);
    this.publish({ ...this.state, error: this.state.error ?? bounded });
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message.slice(0, 512) : "Daemon session is unavailable.";
    this.publish({ ...this.state, phase: "unavailable", error: message });
    this.options.onError?.(message);
  }

  private publish(state: WorkbenchDaemonSessionSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.importAbort?.abort();
    this.unsubscribeOpen();
    this.unsubscribeClose();
    this.unsubscribeNotifications();
    if (!this.options.attached) {
      this.sidebarClient?.dispose();
      this.threads.dispose();
      this.projectsClient?.dispose();
    }
    this.listeners.clear();
  }
}
