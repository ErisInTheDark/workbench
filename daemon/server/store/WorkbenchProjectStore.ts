/*
 * Exports:
 * - WorkbenchProjectStorePorts: database, project resolution and machine identity collaborators.
 * - default WorkbenchProjectStore: own encrypted project store reads and writes for settings and the human CLI.
 */
import os from "node:os";
import type { ProjectStoreSnapshot, ProjectStoreUpdateRequest } from "workbench-shared/workbench/project/project-store";
import type { ProjectStoreCommand, ProjectStoreResult } from "../database/store/WorkbenchProjectStoreRepository";
import type { ResolvedProject } from "../lib/project";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "./project-store-crypto";

export interface WorkbenchProjectStorePorts {
  execute(command: ProjectStoreCommand): Promise<ProjectStoreResult>;
  readDeviceIdentity(): Promise<string>;
  resolveProjectById(projectId: string): Promise<ResolvedProject>;
  resolveProjectFromCwd(cwd: string): Promise<{ project: ResolvedProject }>;
  now?: () => number;
  user?: () => string;
}

export default class WorkbenchProjectStore {
  #deviceIdentity: Promise<string> | null = null;

  constructor(private readonly ports: WorkbenchProjectStorePorts) {}

  async read(projectId: string): Promise<ProjectStoreSnapshot> {
    const project = await this.ports.resolveProjectById(projectId);
    const result = await this.ports.execute({ kind: "list", projectId: project.id });
    if (result.kind !== "entries") throw new Error("Unexpected project store list result.");
    const secret = await this.#secret(project);
    return {
      entries: result.entries.map(entry => {
        const value = openProjectStoreValue(secret, project.id, entry.key, entry);
        return value === null ? { key: entry.key, unreadable: true as const } : { key: entry.key, value };
      }),
    };
  }

  async update({ projectId, removals, upserts }: ProjectStoreUpdateRequest) {
    const project = await this.ports.resolveProjectById(projectId);
    const secret = await this.#secret(project);
    await this.ports.execute({
      kind: "apply", projectId: project.id, removals, now: (this.ports.now ?? Date.now)(),
      upserts: upserts.map(({ key, value }) => ({ key, ...sealProjectStoreValue(secret, project.id, key, value) })),
    });
    return { ok: true as const };
  }

  /** Returns null for a missing key; throws when the stored value cannot be decrypted here. */
  async getFromCwd(cwd: string, key: string) {
    const { project } = await this.ports.resolveProjectFromCwd(cwd);
    const result = await this.ports.execute({ kind: "get", projectId: project.id, key });
    if (result.kind !== "entry") throw new Error("Unexpected project store get result.");
    if (!result.entry) return null;
    const value = openProjectStoreValue(await this.#secret(project), project.id, key, result.entry);
    if (value === null) throw new Error(`Store key ${key} cannot be decrypted for this project, user and device. Set it again.`);
    return value;
  }

  async setFromCwd(cwd: string, key: string, value: string) {
    const { project } = await this.ports.resolveProjectFromCwd(cwd);
    await this.update({ projectId: project.id, upserts: [{ key, value }], removals: [] });
  }

  async #secret(project: ResolvedProject) {
    this.#deviceIdentity ??= this.ports.readDeviceIdentity().catch(error => {
      this.#deviceIdentity = null;
      throw error;
    });
    return deriveProjectStoreKey({
      deviceId: await this.#deviceIdentity,
      projectLocation: `${project.kind}:${project.rootPath}`,
      user: (this.ports.user ?? (() => os.userInfo().username))(),
    });
  }
}
