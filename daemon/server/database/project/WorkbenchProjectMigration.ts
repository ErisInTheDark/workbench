/*
 * Exports:
 * - default WorkbenchProjectMigration: convert retained project references using validated discovery and relocation evidence.
 */
import type Database from "better-sqlite3";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyWorkbenchDatabaseSchema, type WorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import type { ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchProjectDiscovery } from "./workbench-project-persistence.ts";
import WorkbenchProjectRepository from "./WorkbenchProjectRepository.ts";
import WorkbenchSearchRepository from "../search/WorkbenchSearchRepository.ts";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import { localProjectId } from "../../lib/workbench/project/project-identity.ts";

export default class WorkbenchProjectMigration {
  constructor(private readonly database: Database.Database) {}

  run(schema: WorkbenchDatabaseSchema, discovery: WorkbenchProjectDiscovery, relocations: Readonly<Record<string, string>> = {}) {
    if (this.database.inTransaction) throw new Error("Project conversion owns its outer transaction.");
    const foreignKeys = this.database.pragma("foreign_keys", { simple: true }) === 1;
    this.database.pragma("foreign_keys = OFF");
    try {
      let repairCounts = { aliases: 0, layouts: 0, receipts: 0 };
      const result = this.database.transaction(() => {
        const installed = this.database.pragma("user_version", { simple: true }) as number;
        if (installed < databaseReleases.projectIdentity.version) {
          applyWorkbenchDatabaseSchema(this.database, schema, { targetVersion: databaseReleases.projectIdentity.version });
        }
        const repository = new WorkbenchProjectRepository(this.database);
        if (installed >= databaseReleases.projectOwnership.version) {
          return { catalog: repository.reconcile(discovery.data), aliases: repository.readAliases() };
        }
        const aliases = new Map<string, ProjectId>();
        const remember = (alias: string, id: ProjectId) => {
          if (!alias || alias === id) return;
          const previous = aliases.get(alias);
          if (previous && previous !== id) throw new Error("Project identity evidence assigns one address to different owners.");
          aliases.set(alias, id);
        };
        for (const alias of repository.readAliases()) remember(alias.alias, alias.projectId);
        for (const alias of discovery.aliases) remember(alias.alias, alias.projectId);
        for (const [alias, destination] of Object.entries(relocations)) {
          if (!path.isAbsolute(destination)) throw new Error("Project relocation requires an absolute destination.");
          const matches = discovery.data.filter(project =>
            nativeLocationKey(project.workspacePath ?? project.rootPath) === nativeLocationKey(destination));
          const identities = new Set(matches.map(project => project.id));
          const excludedIdentity = localProjectId(destination);
          if (discovery.excludedRootPaths.some(root => nativeLocationKey(root) === nativeLocationKey(destination))
            && discovery.aliases.some(alias => alias.projectId === excludedIdentity)) {
            identities.add(excludedIdentity);
          }
          if (identities.size !== 1) throw new Error("Project relocation destination is not an unambiguous discovered project.");
          remember(alias, [...identities][0]!);
        }
        const parents = this.database.prepare("SELECT id FROM workbench_projects").all() as { id: string }[];
        const malformed = new Set<string>();
        for (const parent of parents) {
          if (aliases.has(parent.id) || !/^(?:remote|local|workspace):\/(?!\/)/u.test(parent.id)) continue;
          // Reproduce the broken URL encoder from discovered identities. Never
          // guess how many slashes to insert into an untrusted retained address.
          const matches = new Set(discovery.data.filter(project =>
            project.id.split("/").filter(Boolean).join("/") === parent.id).map(project => project.id));
          if (matches.size > 1) throw new Error("Malformed project address has ambiguous identity evidence.");
          if (matches.size === 1) {
            remember(parent.id, [...matches][0]!);
            malformed.add(parent.id);
          }
        }
        for (const parent of parents) {
          if (!aliases.has(parent.id)) {
            try { repository.resolve(parent.id); }
            catch { throw new Error(`Missing project identity evidence for retained address ${parent.id}.`); }
          }
        }
        repairCounts = this.reconcileMalformedLayouts(malformed, aliases);
        const before = this.database.prepare("SELECT * FROM workbench_threads ORDER BY id").all() as Record<string, string | number | null>[];
        for (const id of aliases.values()) repository.admit(id);
        const search = new WorkbenchSearchRepository(this.database);
        // Column names come only from Workbench's typed schema, never discovery input.
        const references = schema.currentTables.flatMap(table => ["project_id", "scope_project_id"]
          .filter(column => column in table.columns)
          .filter(() => table.name !== "workbench_project_aliases" && table.name !== "workbench_project_roots")
          .map(column => ({ table: table.name, column })));
        for (const [alias, id] of aliases) {
          search.rekeyProject(alias, id);
          for (const { table, column } of references) {
            if (table === "workbench_search_documents") continue;
            this.database.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(id, alias);
          }
          this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?) ON CONFLICT(alias) DO NOTHING")
            .run(alias, id);
          this.database.prepare("DELETE FROM workbench_projects WHERE id = ?").run(alias);
        }
        const catalog = repository.reconcile(discovery.data);
        applyWorkbenchDatabaseSchema(this.database, schema);
        const after = this.database.prepare("SELECT * FROM workbench_threads ORDER BY id").all();
        if (!isDeepStrictEqual(after, before.map(row => ({
          ...row, project_id: aliases.get(String(row.project_id)) ?? row.project_id,
        })))) throw new Error("Project conversion changed retained thread facts.");
        const violations = this.database.pragma("foreign_key_check") as { table: string; rowid: number | null; parent: string; fkid: number }[];
        if (violations.length) throw new Error("Project conversion left invalid foreign keys.");
        return { catalog, aliases: repository.readAliases() };
      })();
      if (repairCounts.aliases) {
        console.warn(`[database] repaired malformed project references: ${repairCounts.aliases} aliases, ${repairCounts.layouts} empty layouts, ${repairCounts.receipts} duplicate import receipts`);
      }
      return result;
    } finally {
      this.database.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
  }

  private reconcileMalformedLayouts(malformed: ReadonlySet<string>, aliases: ReadonlyMap<string, ProjectId>) {
    const counts = { aliases: malformed.size, layouts: 0, receipts: 0 };
    const canonical = (id: string) => aliases.get(id) ?? id;
    for (const address of malformed) {
      const layouts = this.database.prepare(`
        SELECT owner.project_id, owner.layout_id, layout.revision
        FROM workbench_sidebar_project_layouts owner
        JOIN workbench_sidebar_layouts layout ON layout.id = owner.layout_id
      `).all() as { project_id: string; layout_id: string; revision: number }[];
      const source = layouts.find(layout => layout.project_id === address);
      if (source && layouts.some(layout => layout.project_id !== address && canonical(layout.project_id) === canonical(address))) {
        const items = this.database.prepare("SELECT 1 FROM workbench_sidebar_layout_items WHERE layout_id = ? LIMIT 1").get(source.layout_id);
        const folders = this.database.prepare("SELECT 1 FROM workbench_sidebar_folders WHERE layout_id = ? LIMIT 1").get(source.layout_id);
        if (source.revision !== 0 || items || folders) throw new Error("Malformed project address owns a conflicting populated layout.");
        // Foreign keys are suspended for conversion, so delete the exact empty
        // owner and shell explicitly. Remaining dependencies fail the final FK check.
        this.database.prepare("DELETE FROM workbench_sidebar_project_layouts WHERE layout_id = ?").run(source.layout_id);
        this.database.prepare("DELETE FROM workbench_sidebar_layouts WHERE id = ?").run(source.layout_id);
        counts.layouts++;
      }
      const receipts = this.database.prepare("SELECT project_id, layout_id, owner_kind FROM workbench_sidebar_pinned_imports").all() as {
        project_id: string; layout_id: string; owner_kind: string;
      }[];
      const receipt = receipts.find(row => row.project_id === address);
      const others = receipts.filter(row => row.project_id !== address && canonical(row.project_id) === canonical(address));
      if (receipt && others.length) {
        if (others.some(row => row.layout_id !== receipt.layout_id || row.owner_kind !== receipt.owner_kind)) {
          throw new Error("Malformed project address has conflicting pinned import receipts.");
        }
        this.database.prepare("DELETE FROM workbench_sidebar_pinned_imports WHERE project_id = ?").run(address);
        counts.receipts++;
      }
    }
    return counts;
  }
}
