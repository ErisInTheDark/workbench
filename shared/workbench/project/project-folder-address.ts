/*
 * Exports:
 * - ProjectFolderOption: one selectable daemon folder (location facts plus owning project identity).
 * - ProjectFolderAddress: per-daemon shortest folder suffixes, url-address derivation and resolution over a folder universe.
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
type FolderAddressIndex = {
  entries: readonly Readonly<FolderAddressEntry>[];
  byKey: ReadonlyMap<string, Readonly<FolderAddressEntry>>;
};

/**
 * Every route read and link resolves folders against the same universe, and each derivation compares every folder's
 * suffixes with every other's; the universe is replaced, never edited, so its addresses are derived once.
 */
const addressIndexes = new WeakMap<readonly ProjectFolderOption[], FolderAddressIndex>();

function addressIndex(folders: readonly ProjectFolderOption[]): FolderAddressIndex {
  const cached = addressIndexes.get(folders);
  if (cached) return cached;
  const bare = ProjectFolderAddress.suffixes(folders);
  const bareCounts = new Map<string, number>();
  for (const suffix of bare) {
    const key = suffix.join("/").toLowerCase();
    bareCounts.set(key, (bareCounts.get(key) ?? 0) + 1);
  }
  const entries = folders.map((folder, index) => {
    const suffix = bare[index]!;
    return {
      folder,
      address: (bareCounts.get(suffix.join("/").toLowerCase()) ?? 0) > 1 ? [folder.target.daemonId, ...suffix] : suffix,
    };
  });
  const byKey = new Map<string, FolderAddressEntry>();
  for (const entry of entries) if (!byKey.has(folderKey(entry.folder.target))) byKey.set(folderKey(entry.folder.target), entry);
  const index = { entries, byKey };
  addressIndexes.set(folders, index);
  return index;
}

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
  /** Each folder's shortest path suffix unique among the given folders on its daemon; worktrees marked `+name`. Input order. */
  export function suffixes(folders: readonly { target: ProjectLocationReference; rootPath: string }[]): string[][] {
    const suffixCounts = new Map<string, number>();
    const parts = folders.map(folder => folderPathParts(folder.rootPath));
    folders.forEach((folder, index) => {
      for (let count = 1; count <= parts[index]!.length; count += 1) {
        const key = `${folder.target.daemonId.toLowerCase()}:${parts[index]!.slice(-count).join("/").toLowerCase()}`;
        suffixCounts.set(key, (suffixCounts.get(key) ?? 0) + 1);
      }
    });
    return folders.map((folder, index) => {
      const own = parts[index]!;
      return own.map((_, count) => own.slice(-(count + 1)))
        .find(candidate => suffixCounts.get(`${folder.target.daemonId.toLowerCase()}:${candidate.join("/").toLowerCase()}`) === 1)
        ?? own;
    });
  }

  /** Derive every folder's url address at once: shortest daemon-unique path suffix, daemon id prefix only on cross-daemon collisions. */
  export function forAll(folders: readonly ProjectFolderOption[]): FolderAddressEntry[] {
    return addressIndex(folders).entries.map(entry => ({ folder: entry.folder, address: [...entry.address] }));
  }

  export function forFolder(folders: readonly ProjectFolderOption[], target: ProjectLocationReference): string[] {
    return [...addressIndex(folders).byKey.get(folderKey(target))?.address ?? []];
  }

  /** Resolve a url folder address to one folder. Ambiguous or unknown addresses select nothing, never the wrong folder. */
  export function resolve(folders: readonly ProjectFolderOption[], address: readonly string[]): ProjectFolderOption | null {
    if (!address.length) return null;
    const { entries } = addressIndex(folders);
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
