/*
 * Exports:
 * - default WorkbenchProjectIdentityMigration: convert project owners and consolidate proven empty split owners before serving.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { formatDatabaseLog } from "workbench-shared/database/database-log-format";
import type Database from "better-sqlite3";
import { z } from "zod";
import { tableForeignKeys } from "workbench-shared/database/schema/schema-definition";
import { preserveWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import type { ProjectSchemaRows } from "workbench-shared/workbench/database/schema/project-schema";
import type { UsageSchemaRows } from "workbench-shared/workbench/database/schema/usage-schema";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import { workbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchSearchRepository from "../search/WorkbenchSearchRepository.ts";
import type { WorkbenchProjectDiscovery } from "./workbench-project-persistence.ts";

const uuid = z.string().uuid();
const projectReferences = workbenchDatabaseSchema.currentTables.flatMap(table => tableForeignKeys(table)
  .filter(key => key.target.table === "workbench_projects")
  .map(key => {
    if (key.columns.length !== 1 || key.target.columns[0] !== "id") throw new Error("Project conversion requires a single owning foreign key.");
    return { table: table.name, column: key.columns[0]! };
  }));
const shadowTables = new Set([
  "workbench_project_roots", "workbench_project_aliases", "git_claim_thread_file_days",
  "git_claim_imports", "workbench_sidebar_project_layouts", "workbench_sidebar_pinned_imports",
]);

export default class WorkbenchProjectIdentityMigration {
  constructor(private readonly database: Database.Database) {}

  async run(discovery?: WorkbenchProjectDiscovery, beforeConversion?: (backupPath: string) => Promise<void> | void) {
    const projects = this.database.prepare("SELECT * FROM workbench_projects").all() as ProjectSchemaRows["projects"][];
    const needsConversion = projects.some(project => project.id !== "workbench-library" && !uuid.safeParse(project.id).success);
    if (!needsConversion && (!discovery?.complete || !this.findEmptySplits(projects, discovery).length)) return;
    if (!this.database.memory) {
      const backupPath = await preserveWorkbenchDatabaseBackup(this.database, path.join(path.dirname(this.database.name), "backups", path.basename(this.database.name)));
      await beforeConversion?.(backupPath);
    }
    const startedAt = performance.now();
    const label = path.basename(this.database.name);
    if (!this.database.memory) console.info(formatDatabaseLog("project conversion", "pending", label));
    const counts = this.database.transaction(() => {
      this.database.pragma("defer_foreign_keys = ON");
      // Backup/checkpoint admission yields. Re-read ownership under the write
      // transaction so newly populated shadow state cannot be discarded.
      const current = this.database.prepare("SELECT * FROM workbench_projects").all() as ProjectSchemaRows["projects"][];
      const legacy = current.filter(project => project.id !== "workbench-library" && !uuid.safeParse(project.id).success);
      const merges = discovery?.complete ? this.findEmptySplits(current, discovery) : [];
      for (const merge of merges) this.mergeShadow(merge.source, merge.destination);
      for (const merge of merges) this.database.prepare("UPDATE workbench_projects SET identity_key = ? WHERE id = ?").run(merge.identityKey, merge.destination);
      const search = new WorkbenchSearchRepository(this.database);
      for (const project of legacy) {
        if (!this.database.prepare("SELECT 1 FROM workbench_projects WHERE id = ?").get(project.id)) continue;
        const id = randomUUID();
        search.rekeyProject(project.id, id);
        for (const reference of projectReferences) {
          if (reference.table === "workbench_search_documents") continue;
          this.database.prepare(`UPDATE "${reference.table}" SET "${reference.column}" = ? WHERE "${reference.column}" = ?`).run(id, project.id);
        }
        this.database.prepare("UPDATE workbench_projects SET id = ? WHERE id = ?").run(id, project.id);
        this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?)").run(project.id, id);
      }
      // Git owners supply reliable pre-refresh root evidence. Workspace evidence is
      // installed only when discovery confirms its complete member-derived key.
      this.database.prepare(`UPDATE workbench_project_roots SET identity_key = (
        SELECT identity_key FROM workbench_projects WHERE id = project_id AND kind = 'git'
      ) WHERE identity_key IS NULL AND project_id IN (SELECT id FROM workbench_projects WHERE kind = 'git')`).run();
      if ((this.database.pragma("foreign_key_check") as object[]).length) throw new Error("Project conversion left invalid ownership.");
      return { converted: legacy.length - merges.filter(merge => legacy.some(project => project.id === merge.source)).length, consolidated: merges.length };
    }).immediate();
    if (!this.database.memory) console.info(formatDatabaseLog("project conversion", "ok",
      `${label}, ${counts.converted} converted, ${counts.consolidated} consolidated`, performance.now() - startedAt));
  }

  private roots(id: string) {
    return this.database.prepare("SELECT * FROM workbench_project_roots WHERE project_id = ? ORDER BY root_index").all(id) as ProjectSchemaRows["roots"][];
  }

  private hasIndependentState(id: string) {
    for (const { table, column } of projectReferences) {
      if (!shadowTables.has(table) && this.database.prepare(`SELECT 1 FROM "${table}" WHERE "${column}" = ? LIMIT 1`).get(id)) return true;
    }
    return Boolean(this.database.prepare(`SELECT 1 FROM workbench_sidebar_project_layouts p
      WHERE p.project_id = ? AND (
        EXISTS (SELECT 1 FROM workbench_sidebar_layout_items i WHERE i.layout_id = p.layout_id)
        OR EXISTS (SELECT 1 FROM workbench_sidebar_folders f WHERE f.layout_id = p.layout_id)
      )`).get(id));
  }

  private findEmptySplits(projects: ProjectSchemaRows["projects"][], discovery: WorkbenchProjectDiscovery) {
    const groups = new Map<string, ProjectSchemaRows["projects"][]>();
    for (const project of projects) {
      if (project.kind !== "git") continue;
      const roots = this.roots(project.id);
      if (roots.length !== 1) continue;
      const location = nativeLocationKey(roots[0]!.root_path);
      const group = groups.get(location) ?? [];
      group.push(project);
      groups.set(location, group);
    }
    const merges: Array<{ source: string; destination: string; identityKey: string }> = [];
    for (const [location, group] of groups) {
      if (group.length < 2) continue;
      const candidate = discovery.data.find(item => item.kind === "git" && item.roots.length === 1
        && nativeLocationKey(item.rootPath) === location);
      if (!candidate) continue;
      const owners = group.filter(project => this.hasIndependentState(project.id));
      if (owners.length !== 1) {
        console.warn("[projects] split project recovery requires one independent owner; retained both projects");
        continue;
      }
      const destination = owners[0]!;
      if (projects.some(project => project.identity_key === candidate.identityKey && !group.includes(project))
        || group.some(project => project.identity_key !== candidate.identityKey
          && discovery.observedKeys.some(key => key === project.identity_key))) {
        console.warn("[projects] split project identity is still owned or observed elsewhere; retained separate projects");
        continue;
      }
      if (group.some((source, index) => this.roots(source.id)[0]!.root_id !== this.roots(destination.id)[0]!.root_id
        || group.slice(index + 1).some(other => this.receiptsConflict(source.id, other.id)))) {
        console.warn("[projects] split project recovery found conflicting claim ownership; retained separate projects");
        continue;
      }
      for (const source of group) {
        if (source === destination) continue;
        merges.push({ source: source.id, destination: destination.id, identityKey: candidate.identityKey });
      }
    }
    return merges;
  }

  private receiptsConflict(source: string, destination: string) {
    const overlaps = this.database.prepare(`SELECT a.checkpoint_commit a_commit, b.checkpoint_commit b_commit,
      a.harness_id a_harness, b.harness_id b_harness, a.thread_id a_thread, b.thread_id b_thread,
      a.repository_root a_repository, b.repository_root b_repository, a.workspace_root a_workspace, b.workspace_root b_workspace
      FROM git_claim_imports a JOIN git_claim_imports b ON a.root_id = b.root_id AND a.checkpoint_ref = b.checkpoint_ref
      WHERE a.project_id = ? AND b.project_id = ?`).all(source, destination) as Array<Record<string, string>>;
    return overlaps.some(row => row.a_commit !== row.b_commit || row.a_harness !== row.b_harness || row.a_thread !== row.b_thread
      || nativeLocationKey(row.a_repository!) !== nativeLocationKey(row.b_repository!)
      || nativeLocationKey(row.a_workspace!) !== nativeLocationKey(row.b_workspace!));
  }

  private mergeShadow(source: string, destination: string) {
    this.database.prepare(`INSERT OR IGNORE INTO git_claim_thread_file_days
      (project_id, root_id, harness_id, thread_id, claimed_path, claimed_day)
      SELECT ?, root_id, harness_id, thread_id, claimed_path, claimed_day FROM git_claim_thread_file_days WHERE project_id = ?`).run(destination, source);
    const receipts = this.database.prepare("SELECT * FROM git_claim_imports WHERE project_id = ?").all(source) as UsageSchemaRows["gitClaimImports"][];
    for (const receipt of receipts) {
      const current = this.database.prepare("SELECT state, updated_at FROM git_claim_imports WHERE project_id = ? AND root_id = ? AND checkpoint_ref = ?")
        .get(destination, receipt.root_id, receipt.checkpoint_ref) as { state: string; updated_at: number } | undefined;
      if (current?.state === "completed" || (current && receipt.state !== "completed" && current.updated_at >= Number(receipt.updated_at))) continue;
      const columns = Object.keys(receipt) as Array<keyof typeof receipt>;
      this.database.prepare(`INSERT INTO git_claim_imports (${columns.map(column => `"${column}"`).join(",")})
        VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(project_id, root_id, checkpoint_ref) DO UPDATE SET
        ${columns.filter(column => !["project_id", "root_id", "checkpoint_ref"].includes(column)).map(column => `"${column}" = excluded."${column}"`).join(",")}`)
        .run(...columns.map(column => column === "project_id" ? destination : receipt[column]));
    }
    this.database.prepare("UPDATE git_claim_imports SET state = 'pending', run_id = NULL WHERE project_id = ? AND state = 'processing'").run(destination);
    this.database.prepare(`INSERT OR IGNORE INTO workbench_sidebar_pinned_imports
      SELECT ?, layout_id, owner_kind FROM workbench_sidebar_pinned_imports WHERE project_id = ?`).run(destination, source);
    this.database.prepare("DELETE FROM workbench_sidebar_pinned_imports WHERE project_id = ?").run(source);
    const layout = this.database.prepare("SELECT layout_id FROM workbench_sidebar_project_layouts WHERE project_id = ?").pluck().get(source) as string | undefined;
    this.database.prepare("DELETE FROM workbench_sidebar_project_layouts WHERE project_id = ?").run(source);
    if (layout) this.database.prepare("DELETE FROM workbench_sidebar_layouts WHERE id = ?").run(layout);
    this.database.prepare("UPDATE workbench_project_aliases SET project_id = ? WHERE project_id = ?").run(destination, source);
    for (const table of ["git_claim_thread_file_days", "git_claim_imports", "workbench_project_roots"]) {
      this.database.prepare(`DELETE FROM "${table}" WHERE project_id = ?`).run(source);
    }
    this.database.prepare("DELETE FROM workbench_projects WHERE id = ?").run(source);
    this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id").run(source, destination);
  }
}
