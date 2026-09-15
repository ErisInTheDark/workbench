/*
 * Exports:
 * - WorkbenchBrowserStateRegistryOptions: browser-state storage and diagnostic seams.
 * - default WorkbenchBrowserStateRegistry: own browser stores, cloning, project adoption, seed refresh, and disposal.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  isWorkbenchBrowserStateId,
  type WorkbenchProjectRemap,
  type WorkbenchClientStateIdentity,
  type WorkbenchClientStateMutation,
  type WorkbenchClientStateRecord,
} from "workbench-shared/state/workbench-client-state";

import WorkbenchAppStateController from "./WorkbenchAppStateController.ts";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";

export interface WorkbenchBrowserStateRegistryOptions {
  browserStateDirectoryPath?: string;
  onDiagnostic?: (message: string) => void;
}

function isPortableSeedMutation(mutation: WorkbenchClientStateMutation) {
  const kind = mutation.action === "put" ? mutation.record.kind : mutation.identity.kind;
  if (kind === "composerDraft" || kind === "fileDraft" || kind === "questionnaireDraft") return false;
  if (kind !== "globalPreference") return true;
  const key = mutation.action === "put" && mutation.record.kind === "globalPreference"
    ? mutation.record.preference.key
    : mutation.action === "delete" && mutation.identity.kind === "globalPreference"
      ? mutation.identity.key
      : null;
  return key !== "appPort" && key !== "reactDevelopmentMode";
}

async function removeFailedClone(filePath: string, cause: unknown) {
  try {
    await fs.unlink(filePath);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") throw cause;
    throw new AggregateError([cause, cleanupError], "Browser state clone and cleanup both failed.");
  }
  throw cause;
}

function withDaemonRegistrationId<
  Value extends WorkbenchClientStateIdentity | WorkbenchClientStateRecord,
>(value: Value, daemonRegistrationId: string): Value {
  return "daemonRegistrationId" in value
    ? { ...value, daemonRegistrationId }
    : value;
}

function sharedSeedMutation(
  mutation: WorkbenchClientStateMutation,
  daemonRegistrationId: string,
): WorkbenchClientStateMutation {
  return mutation.action === "put"
    ? {
      action: "put",
      record: withDaemonRegistrationId(mutation.record, daemonRegistrationId),
    }
    : {
      action: "delete",
      identity: withDaemonRegistrationId(mutation.identity, daemonRegistrationId),
    };
}

export default class WorkbenchBrowserStateRegistry {
  readonly #sharedController: WorkbenchAppStateController;
  #sharedDaemonRegistrationId: string | null = null;
  readonly #sharedRepository: WorkbenchAppStateRepository;
  readonly #browserStateDirectoryPath: string | null;
  readonly #onDiagnostic: (message: string) => void;
  readonly #controllers = new Map<string, WorkbenchAppStateController>();
  readonly #openingControllers = new Map<string, Promise<WorkbenchAppStateController>>();
  #seedQueue = Promise.resolve();
  #disposed = false;

  constructor(
    sharedRepository: WorkbenchAppStateRepository,
    options: WorkbenchBrowserStateRegistryOptions = {},
  ) {
    this.#sharedRepository = sharedRepository;
    this.#sharedController = new WorkbenchAppStateController(sharedRepository);
    this.#browserStateDirectoryPath = options.browserStateDirectoryPath
      ? path.resolve(options.browserStateDirectoryPath)
      : sharedRepository.databasePath
        ? path.join(path.dirname(sharedRepository.databasePath), "browser-state")
        : null;
    this.#onDiagnostic = options.onDiagnostic ?? (() => {});
  }

  start() {
    if (this.#sharedDaemonRegistrationId) throw new Error("Workbench browser state registry has already started.");
    this.#sharedDaemonRegistrationId = this.#sharedRepository.daemonRegistrationId;
  }

  get daemonRegistrationId() {
    return this.#sharedController.daemonRegistrationId;
  }

  read(sinceRevision?: number) {
    return this.#sharedController.read(sinceRevision);
  }

  readGlobalPreference<TKey extends Parameters<WorkbenchAppStateController["readGlobalPreference"]>[0]>(
    key: TKey,
  ) {
    return this.#sharedController.readGlobalPreference(key);
  }

  mutate(mutation: WorkbenchClientStateMutation) {
    return this.#sharedController.mutate(mutation);
  }

  async readBrowser(browserStateId: string | undefined, sinceRevision?: number) {
    const controller = await this.#controllerFor(browserStateId);
    return controller.read(sinceRevision);
  }

  async mutateBrowser(browserStateId: string | undefined, mutation: WorkbenchClientStateMutation) {
    const controller = await this.#controllerFor(browserStateId);
    const response = await controller.mutate(mutation);
    if (browserStateId && isPortableSeedMutation(mutation)) this.#enqueueSeedMutation(mutation);
    return response;
  }

  async remapBrowserProjects(browserStateId: string | undefined, request: WorkbenchProjectRemap) {
    const selected = await this.#controllerFor(browserStateId);
    if (request.daemonRegistrationId !== selected.daemonRegistrationId) throw new Error("Project remap belongs to another daemon registration.");
    const operation = this.#seedQueue.then(async () => {
      if (this.#disposed) throw new Error("Workbench browser state registry is closed.");
      await this.#sharedController.remapProjects({ ...request, daemonRegistrationId: this.daemonRegistrationId });
      const results = await Promise.allSettled([...this.#controllers.values()].map(controller =>
        controller.remapProjects({ ...request, daemonRegistrationId: controller.daemonRegistrationId })));
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Project adoption failed in a browser state store.");
      return selected.read();
    });
    this.#seedQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async close() {
    this.#disposed = true;
    const failures = (await Promise.allSettled(this.#openingControllers.values()))
      .flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    await this.#seedQueue;
    for (const controller of this.#controllers.values()) {
      try {
        await controller.close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#controllers.clear();
    if (failures.length) throw new AggregateError(failures, "Workbench browser state disposal failed.");
  }

  async #controllerFor(browserStateId: string | undefined) {
    if (this.#disposed) throw new Error("Workbench browser state registry is closed.");
    await this.#seedQueue;
    if (!browserStateId) return this.#sharedController;
    if (!isWorkbenchBrowserStateId(browserStateId)) throw new Error("Workbench browser state ID is invalid.");
    if (this.#disposed) throw new Error("Workbench browser state registry is closed.");
    const existing = this.#controllers.get(browserStateId);
    if (existing) return existing;
    const opening = this.#openingControllers.get(browserStateId);
    if (opening) return await opening;
    const operation = this.#openController(browserStateId);
    this.#openingControllers.set(browserStateId, operation);
    try {
      return await operation;
    } finally {
      this.#openingControllers.delete(browserStateId);
    }
  }

  async #openController(browserStateId: string) {
    await this.#seedQueue;
    if (this.#disposed) throw new Error("Workbench browser state registry is closed.");
    const browserStateDirectoryPath = this.#browserStateDirectoryPath;
    if (!browserStateDirectoryPath) throw new Error("Workbench browser state storage is unavailable.");
    await fs.mkdir(browserStateDirectoryPath, { recursive: true });
    const databasePath = path.join(browserStateDirectoryPath, `${browserStateId}.sqlite3`);
    try {
      await fs.access(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporaryPath = path.join(
        browserStateDirectoryPath,
        `.${browserStateId}.${randomUUID()}.sqlite3.tmp`,
      );
      try {
        await this.#sharedRepository.backupTo(temporaryPath);
        await fs.rename(temporaryPath, databasePath);
      } catch (cloneError) {
        try {
          await fs.access(databasePath);
          try {
            await fs.unlink(temporaryPath);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw new AggregateError([cloneError, cleanupError], "Concurrent browser state clone cleanup failed.");
            }
          }
        } catch (targetError) {
          if (targetError instanceof AggregateError) throw targetError;
          await removeFailedClone(temporaryPath, cloneError);
        }
      }
    }
    const repository = new WorkbenchAppStateRepository({ databasePath });
    const controller = new WorkbenchAppStateController(repository);
    await controller.start();
    try {
      await this.#adoptProjectAliases(controller);
    } catch (error) {
      await controller.close();
      throw error;
    }
    this.#controllers.set(browserStateId, controller);
    return controller;
  }

  async #adoptProjectAliases(controller: WorkbenchAppStateController) {
    // An opening store can overlap a remap. Join the current seed boundary before
    // exposing it, then repeat only if that boundary changed while adopting.
    let boundary: Promise<void>;
    do {
      boundary = this.#seedQueue;
      await boundary;
      if (this.#disposed) throw new Error("Workbench browser state registry is closed.");
      await controller.remapProjects({
        daemonRegistrationId: controller.daemonRegistrationId,
        aliases: this.#sharedController.readProjectAliases(),
      });
    } while (boundary !== this.#seedQueue);
    return controller;
  }

  #enqueueSeedMutation(mutation: WorkbenchClientStateMutation) {
    const daemonRegistrationId = this.#sharedDaemonRegistrationId;
    if (!daemonRegistrationId) throw new Error("Workbench browser state registry is not ready.");
    const seedMutation = sharedSeedMutation(mutation, daemonRegistrationId);
    const operation = this.#seedQueue.then(async () => {
      try {
        await this.#sharedController.mutate(seedMutation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#onDiagnostic(`browser state seed refresh failed: ${message.slice(0, 500)}`);
      }
    });
    this.#seedQueue = operation;
  }
}
