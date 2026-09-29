/*
 * Exports:
 * - ProjectFolderOption: one selectable daemon folder (location facts plus owning project identity).
 * - ProjectFolderAddress: folder url-address derivation and resolution over a folder universe.
 * - projectFolderOptions: build the folder universe from logical and plain project facts.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "../../types.ts";
import type { ProjectLocationReference } from "./project-location.ts";

export interface ProjectFolderOption {
  target: ProjectLocationReference;
  daemonId: string;
  hostname: string;
  name: string;
  rootPath: string;
  displayPath?: string;
  project: WorkbenchProjectOption | null;
  ownerProjectId: string;
  ownerLabel?: string;
}

type FolderAddressEntry = { folder: ProjectFolderOption; address: string[] };

function folderKey(target: ProjectLocationReference) {
  return `${target.daemonId}/${target.projectId}`;
}

function folderPathParts(rootPath: string) {
  const parts = rootPath.replace(/\\/gu, "/").split("/").filter(Boolean);
  const worktreeIndex = parts.findIndex((part, index) =>
    part === ".workbench" && parts[index + 1] === "worktrees" && index + 3 === parts.length);
  if (worktreeIndex >= 0) parts[parts.length - 1] = `+${parts[parts.length - 1]!}`;
  return parts;
}

function addressMatches(address: readonly string[], parts: readonly string[]) {
  return address.length === parts.length && address.every((part, index) => part === parts[index]);
}

function isSuffixOf(address: readonly string[], parts: readonly string[]) {
  return address.length > 0 && address.length <= parts.length
    && address.every((part, index) => parts[parts.length - address.length + index] === part);
}

/** Every folder available to the sidebar folder picker: logical locations first, then observed and plain-project folders. */
export function projectFolderOptions(
  logicalProjects: readonly WorkbenchLogicalProject[],
  plainProjects: readonly WorkbenchProjectOption[] = [],
  attached: { daemonId: ProjectLocationReference["daemonId"]; hostname: string } | null = null,
): ProjectFolderOption[] {
  const byKey = new Map<string, ProjectFolderOption>();
  const add = (option: ProjectFolderOption) => {
    const key = folderKey(option.target);
    if (!byKey.has(key)) byKey.set(key, option);
  };
  for (const project of logicalProjects) {
    for (const location of project.locations) {
      add({
        target: location.target,
        daemonId: location.daemonId,
        hostname: location.hostname,
        name: location.name,
        rootPath: location.rootPath,
        displayPath: location.displayPath,
        project: location.project,
        ownerProjectId: project.id,
        ownerLabel: project.label,
      });
    }
    for (const location of project.observedLocations ?? []) {
      add({
        target: { daemonId: location.daemonId, projectId: location.projectId },
        daemonId: location.daemonId,
        hostname: location.hostname,
        name: location.project.name,
        rootPath: location.rootPath,
        project: location.project,
        ownerProjectId: project.id,
        ownerLabel: project.label,
      });
    }
  }
  if (attached) {
    for (const project of plainProjects) {
      add({
        target: { daemonId: attached.daemonId, projectId: project.id },
        daemonId: attached.daemonId,
        hostname: attached.hostname,
        name: project.name,
        rootPath: project.rootPath,
        displayPath: project.relativePath,
        project,
        ownerProjectId: project.id,
        ownerLabel: project.name,
      });
    }
  }
  return [...byKey.values()];
}

export namespace ProjectFolderAddress {
  /** Derive every folder's url address at once: shortest daemon-unique path suffix, daemon id prefix only on cross-daemon collisions. */
  export function forAll(folders: readonly ProjectFolderOption[]): FolderAddressEntry[] {
    const suffixCounts = new Map<string, number>();
    const partsByKey = new Map<string, string[]>();
    for (const folder of folders) {
      const parts = folderPathParts(folder.rootPath);
      partsByKey.set(folderKey(folder.target), parts);
      for (let count = 1; count <= parts.length; count += 1) {
        const key = `${folder.target.daemonId.toLowerCase()}:${parts.slice(-count).join("/").toLowerCase()}`;
        suffixCounts.set(key, (suffixCounts.get(key) ?? 0) + 1);
      }
    }
    const bare = new Map<string, string[]>();
    for (const folder of folders) {
      const parts = partsByKey.get(folderKey(folder.target)) ?? folderPathParts(folder.rootPath);
      const suffix = parts.map((_, index) => parts.slice(-(index + 1)))
        .find(candidate => suffixCounts.get(`${folder.target.daemonId.toLowerCase()}:${candidate.join("/").toLowerCase()}`) === 1)
        ?? parts;
      bare.set(folderKey(folder.target), suffix);
    }
    const bareCounts = new Map<string, number>();
    for (const suffix of bare.values()) {
      const key = suffix.join("/").toLowerCase();
      bareCounts.set(key, (bareCounts.get(key) ?? 0) + 1);
    }
    return folders.map(folder => {
      const suffix = bare.get(folderKey(folder.target)) ?? folderPathParts(folder.rootPath);
      return {
        folder,
        address: (bareCounts.get(suffix.join("/").toLowerCase()) ?? 0) > 1
          ? [folder.target.daemonId, ...suffix]
          : [...suffix],
      };
    });
  }

  export function forFolder(folders: readonly ProjectFolderOption[], target: ProjectLocationReference): string[] {
    return forAll(folders).find(entry => folderKey(entry.folder.target) === folderKey(target))?.address ?? [];
  }

  /** Resolve a url folder address to one folder. Ambiguous or unknown addresses select nothing, never the wrong folder. */
  export function resolve(folders: readonly ProjectFolderOption[], address: readonly string[]): ProjectFolderOption | null {
    if (!address.length) return null;
    const entries = forAll(folders);
    const exact = entries.filter(entry =>
      addressMatches(address, entry.address)
      || (entry.folder.target.daemonId === address[0] && addressMatches(address.slice(1), entry.address.slice(1))));
    if (exact.length === 1) return exact[0]!.folder;
    if (exact.length > 1) return null;
    const fallback = entries.filter(entry => {
      const parts = folderPathParts(entry.folder.rootPath);
      return entry.folder.target.daemonId === address[0]
        ? isSuffixOf(address.slice(1), parts)
        : isSuffixOf(address, parts);
    });
    return fallback.length === 1 ? fallback[0]!.folder : null;
  }
}
