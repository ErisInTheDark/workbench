/*
 * Exports:
 * - default WorkbenchProjectIdentityMigration: convert project owners and transactionally recover historical checkout owners before serving.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { formatDatabaseLog } from "workbench-shared/database/database-log-format";
import type Database from "better-sqlite3";
import { z } from "zod";
import { preserveWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import type { ProjectSchemaRows } from "workbench-shared/workbench/database/schema/project-schema";
import type { UsageSchemaRows } from "workbench-shared/workbench/database/schema/usage-schema";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import WorkbenchSearchRepository from "../search/WorkbenchSearchRepository.ts";
import type { WorkbenchProjectDiscovery } from "./workbench-project-persistence.ts";
import WorkbenchProjectRepository, { FIXED_PROJECT_IDS } from "./WorkbenchProjectRepository.ts";

const uuid = z.string().uuid();
const isLegacy = (project: ProjectSchemaRows["projects"]) => !FIXED_PROJECT_IDS.has(project.id) && !uuid.safeParse(project.id).success;
const shadowTables = new Set([
  "workbench_project_roots", "workbench_project_aliases", "git_claim_thread_file_days",
  "git_claim_imports", "workbench_sidebar_project_layouts", "workbench_search_documents",
]);

export default class WorkbenchProjectIdentityMigration {
  constructor(private readonly database: Database.Database) {}

  repairHistoricalOwners() {
    const projects = this.database.prepare("SELECT * FROM workbench_projects").all() as ProjectSchemaRows["projects"][];
    if (!projects.some(project => project.kind === "historical" && project.identity_key?.startsWith("local://"))) return 0;
    const roots = this.database.prepare("SELECT * FROM workbench_project_roots ORDER BY project_id, root_index")
      .all() as ProjectSchemaRows["roots"][];
    const rootsByProject = Map.groupBy(roots, root => root.project_id);
    const owners = new WorkbenchProjectRepository(this.database);
    const candidates = projects.filter(project => project.kind === "git"
      && rootsByProject.get(project.id)?.length === 1);
    const byLocation = Map.groupBy(candidates, project => nativeLocationKey(rootsByProject.get(project.id)![0]!.root_path));
    const possible = [...byLocation.values()].flatMap(group => {
      if (group.length !== 1) return [];
      const current = group[0]!;
      const root = rootsByProject.get(current.id)![0]!;
      const historical = owners.historicalOwnersAt(root.root_path, projects);
      return historical.length === 1 ? [{ current, root, historical: historical[0]! }] : [];
    });
    if (!possible.length) return 0;
    const references = this.projectReferences();
    return this.database.transaction(() => {
      let repaired = 0;
      for (const { current, root, historical } of possible) {
        if (rootsByProject.has(historical.id)
          || this.hasIndependentState(current.id, references)
          || !owners.historicalLocationAgrees(historical.id, root.root_path)
          || this.receiptsConflict(current.id, historical.id)) continue;
        const foreignRoot = ["git_claim_thread_file_days", "git_claim_imports"].some(table =>
          this.database.prepare(`SELECT 1 FROM "${table}" WHERE project_id IN (?, ?) AND root_id <> ? LIMIT 1`)
            .get(historical.id, current.id, root.root_id));
        if (foreignRoot) continue;
        if (this.database.prepare("SELECT 1 FROM workbench_project_aliases WHERE alias IN (?, ?) LIMIT 1")
          .get(current.id, historical.id)) continue;
        const legacyAlias = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?")
          .pluck().get(historical.identity_key);
        if (legacyAlias && legacyAlias !== historical.id) continue;
        this.database.prepare(`INSERT INTO workbench_project_roots
          (project_id, root_id, root_index, name, relative_path, root_path, identity_key)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(historical.id, root.root_id, root.root_index, root.name,
            root.relative_path, root.root_path, root.identity_key ?? current.identity_key);
        this.database.prepare(`UPDATE workbench_projects SET
          kind = ?, name = ?, relative_path = ?, workspace_path = ?, last_commit_time_ms = ?,
          icon_source_key = ?, icon_root_id = ?, icon_path = ?, icon_checked_at = ?, identity_key = ?
          WHERE id = ?`).run(current.kind, current.name, current.relative_path, current.workspace_path,
            current.last_commit_time_ms, current.icon_source_key, current.icon_root_id, current.icon_path,
            current.icon_checked_at, current.identity_key, historical.id);
        this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?) ON CONFLICT(alias) DO NOTHING")
          .run(historical.identity_key, historical.id);
        this.mergeShadow(current.id, historical.id);
        repaired++;
      }
      return repaired;
    }).immediate();
  }

  private projectReferences() {
    // Conversion runs before the final schema upgrade. Its references must
    // describe the installed database, not tables introduced by later releases.
    const references = this.database.prepare(`
      SELECT schema.name AS table_name, fk."from" AS column_name,
        fk."to" AS target_column, fk.seq
      FROM sqlite_schema AS schema JOIN pragma_foreign_key_list(schema.name) AS fk
      WHERE schema.type = 'table' AND fk."table" = 'workbench_projects'
    `).all() as Array<{ table_name: string; column_name: string; target_column: string; seq: number }>;
    return references.map(reference => {
      if (reference.seq !== 0 || reference.target_column !== "id") throw new Error("Project conversion requires a single owning foreign key.");
      if (![reference.table_name, reference.column_name].every(name => /^[A-Za-z_][A-Za-z_0-9]*$/u.test(name))) {
        throw new Error("Project conversion encountered an unsupported schema identifier.");
      }
      return { table: reference.table_name, column: reference.column_name };
    });
  }

  async run(discovery?: WorkbenchProjectDiscovery, beforeConversion?: (backupPath: string) => Promise<void> | void) {
    const projects = this.database.prepare("SELECT * FROM workbench_projects").all() as ProjectSchemaRows["projects"][];
    const needsConversion = projects.some(isLegacy) || this.findFixedRepairs(projects).length > 0;
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
      const legacy = current.filter(isLegacy);
      const merges = discovery?.complete ? this.findEmptySplits(current, discovery) : [];
      const repairs = this.findFixedRepairs(current);
      for (const merge of merges) this.mergeShadow(merge.source, merge.destination);
      for (const merge of merges) this.database.prepare("UPDATE workbench_projects SET identity_key = ? WHERE id = ?").run(merge.identityKey, merge.destination);
      const search = new WorkbenchSearchRepository(this.database);
      for (const repair of repairs) {
        // The converted row owns the real state; a recreated fixed row is an empty catalogue shell.
        if (repair.fixedExists) this.mergeShadow(repair.fixedId, repair.source);
        this.database.prepare("DELETE FROM workbench_project_aliases WHERE alias = ?").run(repair.fixedId);
        this.rekey(search, repair.source, repair.fixedId);
        this.database.prepare(`INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?)
          ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id`).run(repair.source, repair.fixedId);
      }
      for (const project of legacy) {
        if (!this.database.prepare("SELECT 1 FROM workbench_projects WHERE id = ?").get(project.id)) continue;
        const id = randomUUID();
        this.rekey(search, project.id, id);
        this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?)").run(project.id, id);
      }
      // Git owners supply reliable pre-refresh root evidence. Workspace evidence is
      // installed only when discovery confirms its complete member-derived key.
      this.database.prepare(`UPDATE workbench_project_roots SET identity_key = (
        SELECT identity_key FROM workbench_projects WHERE id = project_id AND kind = 'git'
      ) WHERE identity_key IS NULL AND project_id IN (SELECT id FROM workbench_projects WHERE kind = 'git')`).run();
      if ((this.database.pragma("foreign_key_check") as object[]).length) throw new Error("Project conversion left invalid ownership.");
      return {
        converted: legacy.length - merges.filter(merge => legacy.some(project => project.id === merge.source)).length,
        consolidated: merges.length, repaired: repairs.length,
      };
    }).immediate();
    if (!this.database.memory) console.info(formatDatabaseLog("project conversion", "ok",
      `${label}, ${counts.converted} converted, ${counts.consolidated} consolidated, ${counts.repaired} repaired`, performance.now() - startedAt));
  }

  /** Moves every owning reference, search document and the project row itself to a new id. */
  private rekey(search: WorkbenchSearchRepository, from: string, to: string) {
    search.rekeyProject(from, to);
    for (const reference of this.projectReferences()) {
      if (reference.table === "workbench_search_documents") continue;
      this.database.prepare(`UPDATE "${reference.table}" SET "${reference.column}" = ? WHERE "${reference.column}" = ?`).run(to, from);
    }
    this.database.prepare("UPDATE workbench_projects SET id = ? WHERE id = ?").run(to, from);
  }

  /** Earlier conversions renamed fixed-id projects to uuids; find each one that can return to its fixed id. */
  private findFixedRepairs(projects: ProjectSchemaRows["projects"][]) {
    const repairs: Array<{ source: string; fixedId: string; fixedExists: boolean }> = [];
    for (const fixedId of FIXED_PROJECT_IDS) {
      const converted = projects.filter(project => project.kind === fixedId && project.id !== fixedId);
      if (!converted.length) continue;
      const fixedExists = projects.some(project => project.id === fixedId);
      if (converted.length > 1 || (fixedExists && this.hasIndependentState(fixedId))) {
        console.warn("[projects] fixed project repair found independent owners; retained both projects");
        continue;
      }
      repairs.push({ source: converted[0]!.id, fixedId, fixedExists });
    }
    return repairs;
  }

  private roots(id: string) {
    return this.database.prepare("SELECT * FROM workbench_project_roots WHERE project_id = ? ORDER BY root_index").all(id) as ProjectSchemaRows["roots"][];
  }

  private hasIndependentState(id: string, references = this.projectReferences()) {
    if (this.database.prepare("SELECT 1 FROM workbench_threads WHERE project_id = ? LIMIT 1").get(id)) return true;
    for (const { table, column } of references) {
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
    this.database.prepare("DELETE FROM workbench_search_documents WHERE project_id = ?").run(source);
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
    const layout = this.database.prepare("SELECT layout_id FROM workbench_sidebar_project_layouts WHERE project_id = ?").pluck().get(source) as string | undefined;
    this.database.prepare("DELETE FROM workbench_sidebar_project_layouts WHERE project_id = ?").run(source);
    if (layout) this.database.prepare("DELETE FROM workbench_sidebar_layouts WHERE id = ?").run(layout);
    this.database.prepare("UPDATE workbench_project_aliases SET project_id = ? WHERE project_id = ?").run(destination, source);
    this.database.prepare("UPDATE workbench_projects SET icon_root_id = NULL, icon_path = NULL WHERE id = ?").run(source);
    for (const table of ["git_claim_thread_file_days", "git_claim_imports", "workbench_project_roots"]) {
      this.database.prepare(`DELETE FROM "${table}" WHERE project_id = ?`).run(source);
    }
    this.database.prepare("DELETE FROM workbench_projects WHERE id = ?").run(source);
    this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET project_id = excluded.project_id").run(source, destination);
  }
}
