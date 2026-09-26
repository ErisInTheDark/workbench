/*
 * Exports:
 * - WorkbenchDaemonSessionSnapshot: one concrete daemon's availability and catalog state.
 * - default WorkbenchDaemonSession: own one daemon socket, project client, registration, and catalog refresh.
 */
import type { WorkbenchProjectsPayload } from "workbench-shared/types";
import { DaemonIdSchema, type DaemonId, type ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchProjectLocationsPayload } from "workbench-shared/workbench/project/project-location";
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
  locations: WorkbenchProjectLocationsPayload | null;
  registrationId: string | null;
}

export default class WorkbenchDaemonSession {
  readonly daemon;
  readonly threads;
  private projectsClient: ReturnType<typeof WorkbenchProjectClient> | null;
  private sidebarClient: ThreadSidebarClient | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeOpen: () => void;
  private readonly unsubscribeClose: () => void;
  private readonly unsubscribeNotifications: () => void;
  private disposed = false;
  private started = false;
  private opening: Promise<void> | null = null;
  private observedProjectId: ProjectId | null = null;
  private observing: Promise<void> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private refreshAbort: AbortController | null = null;
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
      phase: "connecting", error: null, catalog: null, locations: null, registrationId: null,
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
    this.refreshAbort?.abort();
    const controller = new AbortController();
    this.refreshAbort = controller;
    const catalog = await this.daemon.projects.catalog();
    if (this.disposed) throw new Error("Daemon session closed during catalog refresh.");
    const knownRegistrationId = this.options.appState.getSnapshot().registrations
      .find(item => item.daemonId === this.options.daemonId)?.id ?? null;
    const projects = this.projectsClient ?? WorkbenchProjectClient({
      clientStateController: this.options.appState,
      daemonRegistrationId: knownRegistrationId ?? "",
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
    if (!this.options.attached) {
      const sidebar = this.sidebarClient ?? new ThreadSidebarClient({
        onChange: () => {
          this.publish(this.state);
        },
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
    }
    if (!this.disposed) this.publish({
      ...this.state, phase: "ready", error: null, catalog, locations: null, registrationId: knownRegistrationId,
    });
    if (this.disposed) return;
    void this.options.appState.ensureDaemonRegistration(
      this.options.daemonId, Boolean(this.options.attached),
    ).then(async registrationId => {
      if (this.disposed || controller.signal.aborted) return;
      projects.bindDaemonRegistration(registrationId);
      await projects.installCatalog(catalog);
      if (!this.disposed && !controller.signal.aborted) {
        this.publish({ ...this.state, registrationId });
      }
    }).catch(error => {
      if (this.disposed || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Daemon registration failed.";
      this.reportPresentationFailure(`Daemon registration failed: ${message}`);
    });
    void this.observeProject(this.observedProjectId).catch(error => {
      if (this.disposed || controller.signal.aborted) return;
      const message = error instanceof Error
        ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512)
        : "Thread list is unavailable.";
      console.warn("Daemon thread list could not open:", message);
      this.options.onError?.(message);
      this.publish({ ...this.state, error: message });
    });
    void this.daemon.projects.locations().then(async locations => {
      if (this.disposed || controller.signal.aborted) return;
      this.publish({ ...this.state, locations });
      if (this.options.attached) return;
      await this.options.presentation.mutate({
        kind: "registerLocations",
        daemonId: this.options.daemonId,
        hostname: this.options.hostname,
        catalog: locations,
      }, controller.signal);
    }).catch(error => {
      if (this.disposed || controller.signal.aborted) return;
      this.reportPresentationFailure(error instanceof Error
        ? `Project locations could not reconcile: ${error.message}`
        : "Project locations could not reconcile.");
    });
  }

  private reportPresentationFailure(message: string) {
    if (this.disposed) return;
    const bounded = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512);
    console.warn(`Workbench presentation reconciliation failed: ${bounded}`);
    this.options.onError?.(bounded);
    this.publish({ ...this.state, error: this.state.error ?? bounded });
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    const message = error instanceof Error
      ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512)
      : "Daemon session is unavailable.";
    console.warn("Daemon session could not refresh:", message);
    this.publish({ ...this.state, phase: this.state.phase === "ready" ? "ready" : "unavailable", error: message });
    this.options.onError?.(message);
  }

  private publish(state: WorkbenchDaemonSessionSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshAbort?.abort();
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
