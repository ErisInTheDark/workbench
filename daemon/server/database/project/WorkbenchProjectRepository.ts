/*
 * Exports:
 * - default WorkbenchProjectRepository: own project parents, historical location admission, aliases, catalogue reconciliation
 *   (marking projects a complete discovery misses, so retained startup catalogues skip them, and for ones gone from disk
 *   across two scans, merging into their one present same-identity successor or else retiring them with no unarchived
 *   threads), inaccessible-project reads and merges, and icon settlement.
 * - FIXED_PROJECT_IDS: kinds catalogued under a fixed id equal to the kind, exempt from uuid conversion.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ProjectIdSchema, ProjectIdentityKeySchema, type ProjectId } from "workbench-shared/workbench/identity";
import { REMOVED_PROJECTS_ID, WorkbenchProjectIconSchema, WorkbenchProjectOptionSchema } from "workbench-shared/workbench/project/project-state";
import type { ProjectSchemaRows } from "workbench-shared/workbench/database/schema/project-schema";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import { projectLocationKey } from "../../lib/workbench/project/project-location-discovery.ts";
import type {
  WorkbenchInaccessibleProject, WorkbenchProjectAlias, WorkbenchProjectCandidate, WorkbenchProjectDiscovery, WorkbenchProjectIconSettlement,
  WorkbenchProjectMerge, WorkbenchProjectReconciliation, WorkbenchProjectStartup,
} from "./workbench-project-persistence.ts";
import { PROJECT_REFERENCES } from "./project-references.ts";
import NativeLocationRelocations from "../thread-identity/native-location-relocations.ts";

const uuid = z.string().uuid();
type ProjectRow = ProjectSchemaRows["projects"];
type RootRow = ProjectSchemaRows["roots"];
type MergeableKind = "git" | "workspace";
const isMergeable = (row: ProjectRow): row is ProjectRow & { kind: MergeableKind } => row.kind === "git" || row.kind === "workspace";
/** Kinds catalogued once per daemon under a fixed id equal to the kind, outside every discovery folder. */
export const FIXED_PROJECT_IDS: ReadonlySet<string> = new Set(["workbench-library", "daemon"]);

export default class WorkbenchProjectRepository {
  constructor(
    private readonly database: Database.Database,
    /** Whether a retained root folder is still on disk; only a project with none left can retire. */
    private readonly folderExists: (rootPath: string) => boolean = fs.existsSync,
  ) {}

  resolve(id: string): ProjectId {
    const alias = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").get(id) as { project_id: string } | undefined;
    if (alias) return ProjectIdSchema.parse(alias.project_id);
    if (!this.database.prepare("SELECT 1 FROM workbench_projects WHERE id = ?").get(id)) {
      throw new Error("Project identity has not been admitted and has no retained alias.");
    }
    return ProjectIdSchema.parse(id);
  }

  admit(id: string): ProjectId {
    return this.admitStoredReference(id);
  }

  resolveStoredReference(id: string): ProjectId {
    if (!this.hasProjectStorage()) return ProjectIdSchema.parse(id);
    const alias = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?")
      .get(id) as { project_id: string } | undefined;
    return ProjectIdSchema.parse(alias?.project_id ?? id);
  }

  requireStoredReference(id: string): ProjectId {
    const projectId = this.resolveStoredReference(id);
    // Schema-31 conversion predates project storage. Serving starts only after
    // the project ownership release, where every reference must have a parent.
    if (this.hasProjectStorage() && !this.database.prepare("SELECT 1 FROM workbench_projects WHERE id = ?").get(projectId)) {
      throw new Error("Project ownership has not been admitted.");
    }
    return projectId;
  }

  admitStoredReference(id: string): ProjectId {
    const projectId = this.resolveStoredReference(id);
    // The schema-31 importer must finish before project storage is installed.
    // Once installed, the project table owns reference validity and admission.
    if (!this.hasProjectStorage()) return projectId;
    const columns = this.database.pragma("table_info(workbench_projects)") as Array<{ name: string }>;
    if (!columns.some(column => column.name === "identity_key")) {
      this.database.prepare("INSERT INTO workbench_projects(id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(projectId);
      return projectId;
    }
    if (this.database.prepare("SELECT 1 FROM workbench_projects WHERE id = ?").get(projectId)) return projectId;
    if (FIXED_PROJECT_IDS.has(projectId) || uuid.safeParse(projectId).success) {
      this.database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(projectId);
      return projectId;
    }
    const key = ProjectIdentityKeySchema.parse(id);
    return this.database.transaction(() => {
      const matches = this.database.prepare("SELECT id FROM workbench_projects WHERE identity_key = ? LIMIT 2")
        .all(key) as Array<{ id: string }>;
      if (matches.length > 1) throw new Error("Unaliased project identity is ambiguous across locations.");
      const existing = matches[0]?.id;
      const admitted = ProjectIdSchema.parse(existing ?? randomUUID());
      if (!existing) this.database.prepare("INSERT INTO workbench_projects(id, identity_key) VALUES (?, ?)").run(admitted, key);
      this.retainAlias(key, admitted);
      return admitted;
    })();
  }

  private hasProjectStorage() {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workbench_projects'").get());
  }

  readAliases(): WorkbenchProjectAlias[] {
    const rows = this.database.prepare("SELECT alias, project_id FROM workbench_project_aliases ORDER BY alias").all() as ProjectSchemaRows["aliases"][];
    return rows.map(row => ({ alias: row.alias, projectId: ProjectIdSchema.parse(row.project_id) }));
  }

  historicalOwnersAt(rootPath: string, projects: readonly ProjectSchemaRows["projects"][]) {
    const location = nativeLocationKey(rootPath);
    return projects.filter(project => project.kind === "historical"
      && project.identity_key?.startsWith("local://")
      && nativeLocationKey(project.identity_key.slice("local://".length)) === location);
  }

  historicalLocationAgrees(projectId: string, rootPath: string) {
    const location = nativeLocationKey(rootPath);
    const roots = this.database.prepare("SELECT root_path FROM workbench_project_roots WHERE project_id = ?")
      .all(projectId) as Array<{ root_path: string }>;
    const threads = this.database.prepare("SELECT DISTINCT project_root FROM workbench_threads WHERE project_id = ?")
      .all(projectId) as Array<{ project_root: string }>;
    return roots.every(root => nativeLocationKey(root.root_path) === location)
      && threads.every(thread => nativeLocationKey(thread.project_root) === location);
  }

  private retainAlias(alias: string, projectId: ProjectId) {
    if (alias === projectId) return;
    const previous = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get(alias);
    if (previous && previous !== projectId) throw new Error("Project alias conflicts with retained ownership.");
    this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?) ON CONFLICT(alias) DO NOTHING").run(alias, projectId);
  }

  private retainAvailableAlias(alias: string, projectId: ProjectId) {
    const previous = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get(alias);
    if (!previous || previous === projectId) this.retainAlias(alias, projectId);
  }

  /**
   * Deletes a vanished project unless an unarchived thread still belongs to it. Its archived threads, their usage and tool
   * facts, and its feedback move to REMOVED_PROJECTS_ID so stats totals stay exact; everything else it owned is deleted.
   * Returns whether it was retired; a failure rolls the whole project back and leaves it marked missing.
   */
  private retireVanished(projectId: string) {
    if (this.database.prepare(`
      SELECT 1 FROM workbench_threads thread
      JOIN workbench_top_level_thread_states placement ON placement.thread_id = thread.id
      WHERE thread.project_id = ? AND placement.archived = 0 LIMIT 1
    `).get(projectId)) return false;
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT OR IGNORE INTO workbench_projects(id, kind) VALUES (?, 'historical')").run(REMOVED_PROJECTS_ID);
        this.dissolve(projectId, REMOVED_PROJECTS_ID, "retire");
      })();
      return true;
    } catch (error) {
      console.warn(`[projects] vanished project ${projectId} stays hidden; retiring it failed: ${
        (error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      return false;
    }
  }

  /**
   * Folds an inaccessible project (missed by a complete scan, every root gone from disk) into a present Git or workspace
   * project: its threads move onto the matching target roots, references follow PROJECT_REFERENCES, and its id and addresses
   * become aliases of the target. A root still on disk could hold checkout-bound state, so such a source is rejected.
   */
  merge(sourceId: string, targetId: string): WorkbenchProjectMerge {
    return this.fold(sourceId, targetId, false);
  }

  /** A target this reconciliation just discovered is present even before its retained `missing_since` clears. */
  private fold(sourceId: string, targetId: string, targetDiscovered: boolean): WorkbenchProjectMerge {
    return this.database.transaction(() => {
      const read = (id: string) => this.database.prepare("SELECT * FROM workbench_projects WHERE id = ?").get(id) as ProjectRow | undefined;
      const source = read(sourceId);
      const target = read(targetId);
      if (!source || !target || source.id === target.id) throw new Error("Merging needs two different retained projects.");
      if (!isMergeable(source) || !isMergeable(target)) throw new Error("Only Git and workspace projects can merge.");
      const sourceRoots = this.rootsOf(source.id);
      const targetRoots = this.rootsOf(target.id);
      if (source.missing_since === null || sourceRoots.some(root => this.folderExists(root.root_path))) {
        throw new Error("Only a project whose folders are all gone can merge into another.");
      }
      if ((!targetDiscovered && target.missing_since !== null) || !targetRoots.length) throw new Error("The merge target is not available.");
      const targetRootFor = (root: RootRow | undefined) => targetRoots.find(next => next.root_id === root?.root_id)
        ?? targetRoots.find(next => next.root_index === root?.root_index) ?? targetRoots[0]!;
      const moves = sourceRoots.map(root => ({ from: root.root_path, to: targetRootFor(root).root_path }));
      const relocations = new NativeLocationRelocations(moves);
      const threads = this.database.prepare("SELECT id, project_root FROM workbench_threads WHERE project_id = ? ORDER BY id")
        .all(source.id) as Array<{ id: string; project_root: string }>;
      const moveRoot = this.database.prepare("UPDATE workbench_threads SET project_root = ? WHERE id = ?");
      for (const thread of threads) {
        const relocated = relocations.relocate(thread.project_root);
        moveRoot.run(relocated === thread.project_root ? targetRoots[0]!.root_path : relocated, thread.id);
      }
      // Provider sessions keep their old location until they move; identity treats both as one.
      const relocatedAt = Date.now();
      for (const move of moves) NativeLocationRelocations.record(this.database, move, relocatedAt);
      this.dissolve(source.id, target.id, "merge", {
        roots: new Map(sourceRoots.map(root => [root.root_id, targetRootFor(root).root_id])),
        fallback: targetRoots[0]!.root_id,
      });
      this.retainAlias(source.id, ProjectIdSchema.parse(target.id));
      if (source.identity_key) this.retainAvailableAlias(source.identity_key, ProjectIdSchema.parse(target.id));
      return {
        sourceId: ProjectIdSchema.parse(source.id), targetId: ProjectIdSchema.parse(target.id),
        threadIds: threads.map(thread => thread.id),
      };
    })();
  }

  /** Git and workspace projects gone from disk since a complete scan that still own threads. */
  readInaccessible(): WorkbenchInaccessibleProject[] {
    const rows = this.database.prepare(
      "SELECT * FROM workbench_projects WHERE kind IN ('git', 'workspace') AND missing_since IS NOT NULL ORDER BY name, id",
    ).all() as ProjectRow[];
    const countThreads = this.database.prepare("SELECT count(*) FROM workbench_threads WHERE project_id = ?").pluck();
    return rows.flatMap(row => {
      const roots = this.rootsOf(row.id);
      if (!isMergeable(row) || roots.some(root => this.folderExists(root.root_path))) return [];
      const threadCount = countThreads.get(row.id) as number;
      return threadCount ? [{
        id: ProjectIdSchema.parse(row.id), kind: row.kind, name: row.name ?? roots[0]?.name ?? row.id,
        identityKey: row.identity_key ? ProjectIdentityKeySchema.parse(row.identity_key) : null,
        rootPaths: roots.map(root => root.root_path), threadCount,
      }] : [];
    });
  }

  private rootsOf(projectId: string) {
    return this.database.prepare("SELECT * FROM workbench_project_roots WHERE project_id = ? ORDER BY root_index").all(projectId) as RootRow[];
  }

  /** Applies one PROJECT_REFERENCES phase moving `projectId`'s rows to `destination`, then deletes the project row. */
  private dissolve(projectId: string, destination: string, phase: "retire" | "merge",
    rootRemap?: { roots: ReadonlyMap<string, string>; fallback: string }) {
    const ids: Record<string, string> = { project: projectId, destination };
    this.database.prepare("UPDATE workbench_projects SET icon_root_id = NULL, icon_path = NULL, icon_checked_at = NULL WHERE id = @project").run(ids);
    for (const reference of PROJECT_REFERENCES) {
      const { table, column, rootColumn } = reference;
      const run = (statement: string, values: Record<string, string> = ids) => this.database.prepare(statement).run(values);
      const disposition = reference[phase];
      switch (disposition) {
        case "move":
        case "merge": {
          const values: Record<string, string> = { ...ids };
          let assignments = `${column} = @destination`;
          if (rootColumn && rootRemap) {
            values.fallbackRoot = rootRemap.fallback;
            const cases = [...rootRemap.roots].map(([from, to], index) => {
              values[`from${index}`] = from;
              values[`to${index}`] = to;
              return `WHEN @from${index} THEN @to${index}`;
            }).join(" ");
            assignments += `, ${rootColumn} = CASE ${rootColumn} ${cases} ELSE @fallbackRoot END`;
          }
          run(`UPDATE${disposition === "merge" ? " OR IGNORE" : ""} ${table} SET ${assignments} WHERE ${column} = @project`, values);
          if (disposition === "merge") run(`DELETE FROM ${table} WHERE ${column} = @project`);
          break;
        }
        case "delete":
          run(`DELETE FROM ${table} WHERE ${column} = @project`);
          break;
        case "deleteLayout":
          run(`DELETE FROM workbench_sidebar_layouts WHERE id IN (SELECT layout_id FROM ${table} WHERE ${column} = @project)`);
          break;
        case "keep":
          break;
      }
    }
    this.database.prepare("DELETE FROM workbench_projects WHERE id = @project").run(ids);
  }

  /** The one present project of the same kind sharing a vanished project's identity, if exactly one exists. */
  private vanishedSuccessor(vanished: ProjectRow, candidates: readonly ProjectRow[], isPresent: (row: ProjectRow) => boolean) {
    if (!vanished.identity_key) return null;
    const matches = candidates.filter(row => row.id !== vanished.id && row.kind === vanished.kind
      && row.identity_key === vanished.identity_key && isPresent(row));
    return matches.length === 1 ? matches[0]! : null;
  }

  private mergeVanished(source: ProjectRow, target: ProjectRow): WorkbenchProjectMerge | null {
    try {
      return this.fold(source.id, target.id, true);
    } catch (error) {
      console.warn(`[projects] vanished project ${source.id} could not merge into ${target.id}: ${
        (error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      return null;
    }
  }

  readRetained(discoveryRoots: readonly string[]): WorkbenchProjectStartup {
    const projects = this.database.prepare(
      // A project the last complete discovery did not find would only be served until the next scan drops it again.
      "SELECT * FROM workbench_projects WHERE kind <> 'historical' AND missing_since IS NULL ORDER BY relative_path, id",
    ).all() as ProjectSchemaRows["projects"][];
    const rootsByProject = new Map<string, ProjectSchemaRows["roots"][]>();
    for (const root of this.database.prepare(
      "SELECT * FROM workbench_project_roots ORDER BY project_id, root_index",
    ).all() as ProjectSchemaRows["roots"][]) {
      const roots = rootsByProject.get(root.project_id) ?? [];
      roots.push(root);
      rootsByProject.set(root.project_id, roots);
    }
    const withinDiscovery = (location: string) => discoveryRoots.some(root => {
      const relative = path.relative(root, location);
      return relative === "" || relative !== ".."
        && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    const catalog: WorkbenchProjectStartup["catalog"] = [];
    for (const row of projects) {
      const roots = rootsByProject.get(row.id) ?? [];
      if (!roots.length) continue;
      if (!FIXED_PROJECT_IDS.has(row.kind)
        && !withinDiscovery(row.workspace_path ?? roots[0]!.root_path)) continue;
      if (!row.identity_key || roots.some(root => !root.identity_key) || !row.icon_source_key) {
        console.warn("[projects] retained catalogue entry needs identity rediscovery");
        continue;
      }
      const project = WorkbenchProjectOptionSchema.parse({
        id: row.id,
        kind: row.kind,
        name: row.name,
        relativePath: row.relative_path,
        rootPath: roots[0]!.root_path,
        lastCommitTimeMs: row.last_commit_time_ms,
        ...(row.workspace_path === null ? {} : { workspacePath: row.workspace_path }),
        roots: roots.map((root, index) => ({
          id: root.root_id, isPrimary: index === 0, name: root.name,
          relativePath: root.relative_path, rootPath: root.root_path,
        })),
        ...(row.icon_root_id !== null && row.icon_path !== null
          ? { icon: { rootId: row.icon_root_id, path: row.icon_path } } : {}),
      });
      catalog.push({
        project,
        identityKey: ProjectIdentityKeySchema.parse(row.identity_key),
        rootIdentityKeys: roots.map(root => ProjectIdentityKeySchema.parse(root.identity_key)),
        sourceKey: row.icon_source_key,
        checkedAt: row.icon_checked_at,
      });
    }
    return {
      catalog, aliases: this.readAliases(), excludedRootPaths: [],
      rootPath: discoveryRoots[0] ?? "", discoveryRoots: [...discoveryRoots],
    };
  }

  reconcile(discovery: WorkbenchProjectDiscovery): WorkbenchProjectReconciliation {
    const parsed = discovery.data.map(candidate => ({
      ...candidate,
      identityKey: ProjectIdentityKeySchema.parse(candidate.identityKey),
      roots: candidate.roots.map(root => ({ ...root, identityKey: ProjectIdentityKeySchema.parse(root.identityKey) })),
    }));
    return this.database.transaction(() => {
      const excludedRootPaths = new Set(discovery.excludedRootPaths);
      const retainedProjects = this.database.prepare("SELECT * FROM workbench_projects").all() as ProjectSchemaRows["projects"][];
      const retainedRoots = new Map(retainedProjects.map(project => [
        project.id,
        this.database.prepare("SELECT * FROM workbench_project_roots WHERE project_id = ? ORDER BY root_index").all(project.id) as ProjectSchemaRows["roots"][],
      ]));
      const candidates = new Map<string, WorkbenchProjectCandidate[]>();
      for (const project of parsed) {
        const key = projectLocationKey(project);
        const group = candidates.get(key) ?? [];
        group.push(project);
        candidates.set(key, group);
      }
      const selected = [...candidates.values()].map(group => {
        if (group.length === 1) return group[0]!;
        if (group.some(project => project.kind !== "workspace" || !project.workspacePath)) return group[0]!;
        const previous = retainedProjects.find(row => row.kind === "workspace"
          && projectLocationKey({ kind: row.kind, rootPath: group[0]!.rootPath,
            roots: retainedRoots.get(row.id)?.map(root => ({ rootPath: root.root_path })) ?? [] })
            === projectLocationKey(group[0]!));
        const retained = previous?.workspace_path
          ? group.find(project => nativeLocationKey(project.workspacePath!) === nativeLocationKey(previous.workspace_path!))
          : undefined;
        return retained ?? group.sort((left, right) => {
          const a = nativeLocationKey(left.workspacePath!);
          const b = nativeLocationKey(right.workspacePath!);
          return a < b ? -1 : a > b ? 1 : 0;
        })[0]!;
      });
      const merges: WorkbenchProjectMerge[] = [];
      if (discovery.complete) {
        const present = new Set(selected.map(projectLocationKey));
        const isPresent = (row: ProjectRow) => {
          const roots = retainedRoots.get(row.id) ?? [];
          return present.has(projectLocationKey({
            kind: row.kind,
            rootPath: roots[0]?.root_path ?? "",
            roots: roots.map(root => ({ rootPath: root.root_path })),
          }));
        };
        for (const previous of retainedProjects) {
          if (previous.kind !== "git" && previous.kind !== "workspace") continue;
          if (isPresent(previous)) continue;
          const roots = retainedRoots.get(previous.id) ?? [];
          // Missed by an earlier complete scan too, with every folder gone from disk: one hiccup cannot get here.
          if (previous.missing_since !== null && !roots.some(root => this.folderExists(root.root_path))) {
            const successor = this.vanishedSuccessor(previous, retainedProjects, isPresent);
            const merged = successor ? this.mergeVanished(previous, successor) : null;
            if (merged) {
              merges.push(merged);
              continue;
            }
            if (this.retireVanished(previous.id)) continue;
          }
          this.database.prepare("UPDATE workbench_projects SET icon_source_key = ?, missing_since = COALESCE(missing_since, ?) WHERE id = ?")
            .run(randomUUID(), Date.now(), previous.id);
        }
      }
      const catalog: WorkbenchProjectStartup["catalog"] = [];
      for (const project of selected) {
      if (!project.roots.length || !project.roots[0]!.isPrimary || project.roots.slice(1).some(root => root.isPrimary)
        || new Set(project.roots.map(root => root.id)).size !== project.roots.length
        || project.roots.some(root => !root.id || !path.isAbsolute(root.rootPath))
        || nativeLocationKey(project.rootPath) !== nativeLocationKey(project.roots[0]!.rootPath)) {
        throw new Error("Project catalogue has invalid ordered roots.");
      }
      const rootsFor = (id: string) => retainedRoots.get(id) ?? [];
      const sameLocation = (row: ProjectSchemaRows["projects"]) => {
        if (row.kind !== project.kind) return false;
        const roots = rootsFor(row.id);
        return roots.length === project.roots.length && roots.every(root =>
          project.roots.some(next => nativeLocationKey(next.rootPath) === nativeLocationKey(root.root_path)));
      };
      const atLocation = retainedProjects.filter(row => (row.kind === "git" || row.kind === "workspace") && sameLocation(row));
      const historicalLocations = project.kind === "git"
        ? this.historicalOwnersAt(project.rootPath, retainedProjects) : [];
      const historical = historicalLocations.length ? historicalLocations
        : retainedProjects.filter(row => row.kind === "historical" && row.identity_key === project.identityKey);
      // The library and the daemon project each own one fixed id named after their kind.
      const fixedId = FIXED_PROJECT_IDS.has(project.kind) ? project.kind : null;
      let owner = atLocation[0] ?? (fixedId
        ? retainedProjects.find(row => row.id === fixedId) : historical.length === 1 ? historical[0] : undefined);
      let conflict = "";
      if (atLocation.length > 1) conflict = "multiple retained owners at the checkout";
      if (historical.length > 1 && !atLocation.length) conflict = "ambiguous historical project identity";
      if (!atLocation.length && historicalLocations.some(row => !this.historicalLocationAgrees(row.id, project.rootPath))) {
        conflict = "historical project location contradicts retained threads";
      }
      const id = ProjectIdSchema.parse(owner?.id ?? fixedId ?? randomUUID());
      const addresses: string[] = [];
      for (const { alias: address } of discovery.aliases.filter(alias =>
        alias.locationKey === projectLocationKey(project)
        || !alias.locationKey && alias.identityKey === project.identityKey
          && selected.filter(candidate => candidate.identityKey === project.identityKey).length === 1)) {
        const retained = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get(address);
        if (retained && retained !== id) {
          // A short discovery address may be reused under a different scan root.
          // Retain its historical owner, but never hide the new concrete location.
          continue;
        }
        addresses.push(address);
      }
      if (conflict) {
        for (const root of project.roots) excludedRootPaths.add(root.rootPath);
        console.warn(`[projects] identity conflict (${conflict}); retained data was not changed`);
        continue;
      }
      const { identityKey: _identityKey, roots: candidateRoots, ...candidateMetadata } = project;
      const metadata = WorkbenchProjectOptionSchema.parse({
        ...candidateMetadata, id,
        roots: candidateRoots.map(({ identityKey: _rootKey, ...root }) => root),
      });
      if (!owner) this.database.prepare("INSERT INTO workbench_projects(id, identity_key) VALUES (?, ?)").run(id, project.identityKey);
      else if (owner.identity_key !== project.identityKey) {
        if (owner.identity_key) this.retainAvailableAlias(owner.identity_key, id);
        this.database.prepare("UPDATE workbench_projects SET identity_key = ? WHERE id = ?").run(project.identityKey, id);
      }
      this.retainAvailableAlias(project.identityKey, id);
      for (const address of addresses) this.retainAlias(address, id);
      const previous = this.database.prepare("SELECT * FROM workbench_projects WHERE id = ?").get(id) as ProjectSchemaRows["projects"];
      const previousRoots = this.database.prepare("SELECT * FROM workbench_project_roots WHERE project_id = ? ORDER BY root_index")
        .all(id) as ProjectSchemaRows["roots"][];
      const sourceChanged = previous.icon_source_key === null || previousRoots.length !== project.roots.length
        || project.roots.some((root, index) => {
          const previousRoot = previousRoots[index]!;
          return !previousRoot || previousRoot.root_id !== root.id
            || previousRoot.root_index !== index
            || nativeLocationKey(previousRoot.root_path) !== nativeLocationKey(root.rootPath);
        });
      // A fresh generation also fences A -> B -> A, where a path hash would repeat.
      const sourceKey = sourceChanged ? randomUUID() : previous.icon_source_key!;
      const iconRootId = sourceChanged ? null : previous.icon_root_id;
      const iconPath = sourceChanged ? null : previous.icon_path;
      const checkedAt = sourceChanged ? null : previous.icon_checked_at;
      this.database.prepare(`
        UPDATE workbench_projects SET kind = ?, name = ?, relative_path = ?, workspace_path = ?,
          last_commit_time_ms = ?, icon_source_key = ?, icon_root_id = ?, icon_path = ?, icon_checked_at = ?, missing_since = NULL
        WHERE id = ?
      `).run(project.kind, project.name, project.relativePath, project.workspacePath ?? null,
        project.lastCommitTimeMs === null ? null : Math.trunc(project.lastCommitTimeMs), sourceKey, iconRootId, iconPath, checkedAt, id);
      if (sourceChanged) this.database.prepare("DELETE FROM workbench_project_roots WHERE project_id = ?").run(id);
      const writeRoot = this.database.prepare(`
        INSERT INTO workbench_project_roots(project_id, root_id, root_index, name, relative_path, root_path, identity_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, root_id) DO UPDATE SET
          root_index = excluded.root_index, name = excluded.name,
          relative_path = excluded.relative_path, root_path = excluded.root_path, identity_key = excluded.identity_key
      `);
      project.roots.forEach((root, index) => writeRoot.run(id, root.id, index, root.name, root.relativePath, root.rootPath, root.identityKey));
      const { icon: _discoveredIcon, ...withoutIcon } = metadata;
      catalog.push({
        project: { ...withoutIcon, ...(iconRootId !== null && iconPath !== null ? { icon: { rootId: iconRootId, path: iconPath } } : {}) },
        identityKey: project.identityKey,
        rootIdentityKeys: project.roots.map(root => root.identityKey),
        sourceKey,
        checkedAt,
      });
      }
      return {
        catalog, aliases: this.readAliases(), rootPath: discovery.rootPath, discoveryRoots: discovery.discoveryRoots,
        excludedRootPaths: [...excludedRootPaths], ...(merges.length ? { merges } : {}),
      };
    })();
  }

  settleIcon(settlement: WorkbenchProjectIconSettlement): boolean {
    if (!Number.isSafeInteger(settlement.checkedAt) || settlement.checkedAt < 0) {
      throw new Error("Project icon settlement has an invalid success time.");
    }
    const icon = settlement.icon === null ? null : WorkbenchProjectIconSchema.parse(settlement.icon);
    if (icon && (path.posix.isAbsolute(icon.path) || icon.path.includes("\\") || icon.path.split("/").includes(".."))) {
      throw new Error("Project icon path must remain inside its root.");
    }
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT icon_source_key, icon_checked_at FROM workbench_projects WHERE id = ?")
        .get(settlement.projectId) as Pick<ProjectSchemaRows["projects"], "icon_source_key" | "icon_checked_at"> | undefined;
      if (!row || row.icon_source_key !== settlement.sourceKey
        || (row.icon_checked_at !== null && row.icon_checked_at >= settlement.checkedAt)) return false;
      if (icon && !this.database.prepare("SELECT 1 FROM workbench_project_roots WHERE project_id = ? AND root_id = ?")
        .get(settlement.projectId, icon.rootId)) {
        throw new Error("Project icon settlement references a foreign root.");
      }
      const result = this.database.prepare(`
        UPDATE workbench_projects SET icon_root_id = ?, icon_path = ?, icon_checked_at = ?
        WHERE id = ? AND icon_source_key = ? AND (icon_checked_at IS NULL OR icon_checked_at < ?)
      `).run(icon?.rootId ?? null, icon?.path ?? null, settlement.checkedAt,
        settlement.projectId, settlement.sourceKey, settlement.checkedAt);
      return result.changes === 1;
    })();
  }
}
