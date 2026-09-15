/*
 * Exports:
 * - WorkbenchProjectAlias: a retained address pointing to canonical project identity.
 * - WorkbenchProjectDiscovery: structural discovery and its validated identity evidence.
 * - WorkbenchProjectCacheRecord: catalogue metadata with durable icon freshness.
 * - WorkbenchProjectIconSettlement: source-fenced positive or negative icon result.
 * - WorkbenchProjectPreparation: structural evidence and explicitly supplied relocations for startup.
 * - WorkbenchProjectStartup: reconciled startup catalogue and retained identity evidence.
 * - WorkbenchProjectPersistence: typed project operations across the database worker.
 * - WorkbenchProjectRelocationsSchema: validate explicit historical-address relocation input.
 */
import path from "node:path";
import { z } from "zod";
import type { WorkbenchProjectAlias, WorkbenchProjectIcon, WorkbenchProjectOption } from "workbench-shared/types";
export type { WorkbenchProjectAlias } from "workbench-shared/types";
import type { ProjectId } from "workbench-shared/workbench/identity";

export const WorkbenchProjectRelocationsSchema = z.record(
  z.string().min(1).max(4096),
  z.string().min(1).max(4096).refine(value => path.isAbsolute(value), "Project relocation requires an absolute destination."),
);

export interface WorkbenchProjectDiscovery {
  data: WorkbenchProjectOption[];
  aliases: WorkbenchProjectAlias[];
  excludedRootPaths: string[];
  rootPath: string;
}

export interface WorkbenchProjectPreparation {
  discovery: WorkbenchProjectDiscovery;
  relocations: Readonly<Record<string, string>>;
}

export interface WorkbenchProjectStartup {
  catalog: WorkbenchProjectCacheRecord[];
  aliases: WorkbenchProjectAlias[];
  excludedRootPaths: string[];
  rootPath: string;
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
  reconcileProjectCatalog(projects: readonly WorkbenchProjectOption[]): Promise<WorkbenchProjectCacheRecord[]>;
  readProjectAliases(): Promise<WorkbenchProjectAlias[]>;
  resolveProjectIdentity(projectId: string): Promise<ProjectId>;
  settleProjectIcon(settlement: WorkbenchProjectIconSettlement): Promise<boolean>;
}
