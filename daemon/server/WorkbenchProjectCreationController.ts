/*
 * Exports:
 * - WorkbenchProjectCreationControllerOptions: injected catalogue, repository initialisation, and platform.
 * - default WorkbenchProjectCreationController: list folders for the new-project picker and create template-seeded Git projects inside discovery roots.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  PROJECT_FOLDER_LIST_LIMIT,
  validateProjectFolderName,
  type ProjectCreateRequest,
  type ProjectCreateResult,
  type ProjectFolderList,
  type ProjectTemplate,
} from "workbench-shared/workbench/project/project-creation";
import type { ProjectId } from "workbench-shared/workbench/identity";
import { initGitRepository, resolveGitDirectory } from "./lib/git";
import { isPathWithinRoot } from "./lib/project";

export interface WorkbenchProjectCreationControllerOptions {
  catalog: {
    readDiscoverySettings(): Promise<{ paths: string[] }>;
    discoverCreatedProject(canonicalRootPath: string): Promise<ProjectId | null>;
  };
  initRepository?: (rootDir: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function npmPackageName(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9._~-]+/gu, "-").replace(/^[._-]+|-+$/gu, "") || "project";
}

const PROJECT_TEMPLATES: Record<ProjectTemplate, (rootDir: string, projectName: string) => Promise<void>> = {
  none: async () => {},
  node: async (rootDir, projectName) => {
    const manifest = { name: npmPackageName(projectName), version: "0.0.0", private: true };
    await fs.writeFile(path.join(rootDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  },
};

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function isDirectory(folderPath: string) {
  try {
    return (await fs.stat(folderPath)).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string) {
  return isPathWithinRoot(left, right) && isPathWithinRoot(right, left);
}

export default class WorkbenchProjectCreationController {
  private readonly catalog: WorkbenchProjectCreationControllerOptions["catalog"];
  private readonly initRepository: (rootDir: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;

  constructor({ catalog, initRepository = initGitRepository, platform = process.platform }: WorkbenchProjectCreationControllerOptions) {
    this.catalog = catalog;
    this.initRepository = initRepository;
    this.platform = platform;
  }

  async listFolders(folderPath: string | null): Promise<ProjectFolderList> {
    if (folderPath === null) return await this.listFilesystemRoots();
    if (!path.isAbsolute(folderPath)) throw new Error("Folder paths must be absolute.");
    const resolved = path.resolve(folderPath);
    let entries;
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      throw new Error(`That folder cannot be read (${String(errorCode(error) ?? "unavailable").slice(0, 40)}).`);
    }
    const candidates = entries
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    const folders: ProjectFolderList["entries"] = [];
    for (const entry of candidates) {
      if (folders.length >= PROJECT_FOLDER_LIST_LIMIT) break;
      const childPath = path.join(resolved, entry.name);
      if (entry.isSymbolicLink() && !await isDirectory(childPath)) continue;
      folders.push({ name: entry.name, path: childPath, isGitRepository: false });
    }
    await Promise.all(folders.map(async folder => {
      folder.isGitRepository = await resolveGitDirectory(folder.path) !== null;
    }));
    const parentPath = path.dirname(resolved);
    return {
      path: resolved,
      parentPath: parentPath === resolved ? null : parentPath,
      entries: folders,
      truncated: candidates.length > folders.length,
    };
  }

  async create({ parentPath, name, template }: ProjectCreateRequest): Promise<ProjectCreateResult> {
    if (validateProjectFolderName(name)) return { accepted: false, reason: "invalid-name" };
    if (!path.isAbsolute(parentPath)) return { accepted: false, reason: "parent-missing" };
    let parent: string;
    try {
      parent = await fs.realpath(parentPath);
    } catch {
      return { accepted: false, reason: "parent-missing" };
    }
    if (!await isDirectory(parent)) return { accepted: false, reason: "parent-missing" };

    // Discovery walks each root and stops at the first repository, so the
    // deepest containing root bounds the folders that must stay repository-free.
    const { paths: roots } = await this.catalog.readDiscoverySettings();
    const root = roots.filter(candidate => isPathWithinRoot(parent, candidate))
      .sort((left, right) => right.length - left.length)[0];
    if (!root) return { accepted: false, reason: "outside-roots" };
    for (let current = parent; ; current = path.dirname(current)) {
      if (await resolveGitDirectory(current) !== null) return { accepted: false, reason: "inside-project" };
      if (samePath(current, root) || path.dirname(current) === current) break;
    }

    const projectPath = path.join(parent, name);
    try {
      await fs.mkdir(projectPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return { accepted: false, reason: "exists" };
      throw error;
    }
    try {
      await PROJECT_TEMPLATES[template](projectPath, name);
      await this.initRepository(projectPath);
    } catch (error) {
      try {
        await fs.rm(projectPath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Project creation failed and its folder could not be removed.");
      }
      throw error;
    }
    return { accepted: true, path: projectPath, projectId: await this.catalog.discoverCreatedProject(projectPath) };
  }

  private async listFilesystemRoots(): Promise<ProjectFolderList> {
    const candidates = this.platform === "win32" ? DRIVE_LETTERS.map(letter => `${letter}:\\`) : ["/"];
    const present = await Promise.all(candidates.map(async candidate => await isDirectory(candidate) ? candidate : null));
    const entries = present.flatMap(candidate => candidate ? [{
      name: this.platform === "win32" ? candidate.slice(0, 2) : candidate,
      path: candidate,
      isGitRepository: false,
    }] : []);
    return { path: null, parentPath: null, entries, truncated: false };
  }
}
