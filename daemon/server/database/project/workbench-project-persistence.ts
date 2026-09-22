/*
 * Exports:
 * - WorkbenchProjectAlias: a retained address pointing to canonical project identity.
 * - WorkbenchProjectDiscovery: structural discovery and its validated identity evidence.
 * - WorkbenchProjectCandidate: derived identity evidence awaiting durable project admission.
 * - WorkbenchProjectCacheRecord: catalogue metadata with durable icon freshness.
 * - WorkbenchProjectIconSettlement: source-fenced positive or negative icon result.
 * - WorkbenchProjectPreparation: current structural evidence for startup.
 * - WorkbenchProjectStartup: reconciled startup catalogue and retained identity evidence.
 * - WorkbenchProjectPersistence: typed project operations across the database worker.
 */
import type { WorkbenchProjectAlias, WorkbenchProjectIcon, WorkbenchProjectOption } from "workbench-shared/types";
export type { WorkbenchProjectAlias } from "workbench-shared/types";
import type { ProjectId, ProjectIdentityKey } from "workbench-shared/workbench/identity";

export interface WorkbenchProjectCandidate extends Omit<WorkbenchProjectOption, "id" | "roots"> {
  identityKey: ProjectIdentityKey;
  roots: Array<WorkbenchProjectOption["roots"][number] & { identityKey: ProjectIdentityKey }>;
}

export interface WorkbenchProjectDiscovery {
  data: WorkbenchProjectCandidate[];
  aliases: Array<{ alias: string; identityKey: ProjectIdentityKey }>;
  observedKeys: ProjectIdentityKey[];
  complete: boolean;
  excludedRootPaths: string[];
  rootPath: string;
  discoveryRoots?: string[];
}

export interface WorkbenchProjectPreparation {
  discovery: WorkbenchProjectDiscovery;
}

export interface WorkbenchProjectStartup {
  catalog: WorkbenchProjectCacheRecord[];
  aliases: WorkbenchProjectAlias[];
  excludedRootPaths: string[];
  rootPath: string;
  discoveryRoots?: string[];
}

export interface WorkbenchProjectCacheRecord {
  project: WorkbenchProjectOption;
  sourceKey: string;
  checkedAt: number | null;
}

export interface WorkbenchProjectIconSettlement {
  projectId: ProjectId;
  sourceKey: string;
  checkedAt: number;
  icon: WorkbenchProjectIcon | null;
}

export interface WorkbenchProjectPersistence {
  reconcileProjectCatalog(discovery: WorkbenchProjectDiscovery): Promise<WorkbenchProjectStartup>;
  readProjectAliases(): Promise<WorkbenchProjectAlias[]>;
  resolveProjectIdentity(projectId: string): Promise<ProjectId>;
  settleProjectIcon(settlement: WorkbenchProjectIconSettlement): Promise<boolean>;
}
