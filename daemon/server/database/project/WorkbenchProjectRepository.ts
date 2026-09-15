/*
 * Exports:
 * - default WorkbenchProjectRepository: own project parents, aliases, catalogue reconciliation, and icon settlement.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { ProjectIdSchema, type ProjectId } from "workbench-shared/workbench/identity";
import { WorkbenchProjectIconSchema, WorkbenchProjectOptionSchema } from "workbench-shared/workbench/project/project-state";
import type { ProjectSchemaRows } from "workbench-shared/workbench/database/schema/project-schema";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import type { WorkbenchProjectAlias, WorkbenchProjectCacheRecord, WorkbenchProjectIconSettlement } from "./workbench-project-persistence.ts";

function isCanonicalId(id: string) {
  return id === "workbench-library" || /^(?:remote|local|workspace):\/\/.+$/u.test(id);
}

export default class WorkbenchProjectRepository {
  constructor(private readonly database: Database.Database) {}

  resolve(id: string): ProjectId {
    const alias = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").get(id) as { project_id: string } | undefined;
    if (alias) return ProjectIdSchema.parse(alias.project_id);
    if (!isCanonicalId(id)) throw new Error("Project identity is not canonical and has no retained alias.");
    return ProjectIdSchema.parse(id);
  }

  admit(id: string): ProjectId {
    const projectId = this.resolve(id);
    this.database.prepare("INSERT INTO workbench_projects(id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(projectId);
    return projectId;
  }

  resolveStoredReference(id: string): ProjectId {
    if (!this.hasProjectStorage()) return ProjectIdSchema.parse(id);
    const alias = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?")
      .get(id) as { project_id: string } | undefined;
    return ProjectIdSchema.parse(alias?.project_id ?? id);
  }

  admitStoredReference(id: string): ProjectId {
    const projectId = this.resolveStoredReference(id);
    // The schema-31 importer must finish before project storage is installed.
    // Once installed, the project table owns reference validity and admission.
    if (this.hasProjectStorage()) {
      this.database.prepare("INSERT INTO workbench_projects(id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(projectId);
    }
    return projectId;
  }

  private hasProjectStorage() {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workbench_projects'").get());
  }

  readAliases(): WorkbenchProjectAlias[] {
    const rows = this.database.prepare("SELECT alias, project_id FROM workbench_project_aliases ORDER BY alias").all() as ProjectSchemaRows["aliases"][];
    return rows.map(row => ({ alias: row.alias, projectId: ProjectIdSchema.parse(row.project_id) }));
  }

  reconcile(projects: readonly WorkbenchProjectOption[]): WorkbenchProjectCacheRecord[] {
    const parsed = projects.map(project => WorkbenchProjectOptionSchema.parse(project));
    return this.database.transaction(() => {
      const candidates = new Map<ProjectId, WorkbenchProjectOption[]>();
      for (const project of parsed) {
        const group = candidates.get(project.id) ?? [];
        group.push(project);
        candidates.set(project.id, group);
      }
      const selected = [...candidates.values()].map(group => {
        if (group.length === 1) return group[0]!;
        if (group.some(project => project.kind !== "workspace" || !project.workspacePath)) {
          throw new Error("Project catalogue contains duplicate identities.");
        }
        const previous = this.database.prepare("SELECT workspace_path FROM workbench_projects WHERE id = ?")
          .get(group[0]!.id) as Pick<ProjectSchemaRows["projects"], "workspace_path"> | undefined;
        const retained = previous?.workspace_path
          ? group.find(project => nativeLocationKey(project.workspacePath!) === nativeLocationKey(previous.workspace_path!))
          : undefined;
        return retained ?? group.sort((left, right) => {
          const a = nativeLocationKey(left.workspacePath!);
          const b = nativeLocationKey(right.workspacePath!);
          return a < b ? -1 : a > b ? 1 : 0;
        })[0]!;
      });
      return selected.map(project => {
      if (!project.roots.length || !project.roots[0]!.isPrimary || project.roots.slice(1).some(root => root.isPrimary)
        || new Set(project.roots.map(root => root.id)).size !== project.roots.length
        || project.roots.some(root => !root.id || !path.isAbsolute(root.rootPath))
        || nativeLocationKey(project.rootPath) !== nativeLocationKey(project.roots[0]!.rootPath)) {
        throw new Error("Project catalogue has invalid ordered roots.");
      }
      const id = this.admit(project.id);
      if (id !== project.id) throw new Error("Project discovery returned a legacy identity.");
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
          last_commit_time_ms = ?, icon_source_key = ?, icon_root_id = ?, icon_path = ?, icon_checked_at = ?
        WHERE id = ?
      `).run(project.kind, project.name, project.relativePath, project.workspacePath ?? null,
        project.lastCommitTimeMs === null ? null : Math.trunc(project.lastCommitTimeMs), sourceKey, iconRootId, iconPath, checkedAt, id);
      if (sourceChanged) this.database.prepare("DELETE FROM workbench_project_roots WHERE project_id = ?").run(id);
      const writeRoot = this.database.prepare(`
        INSERT INTO workbench_project_roots(project_id, root_id, root_index, name, relative_path, root_path)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, root_id) DO UPDATE SET
          root_index = excluded.root_index, name = excluded.name,
          relative_path = excluded.relative_path, root_path = excluded.root_path
      `);
      project.roots.forEach((root, index) => writeRoot.run(id, root.id, index, root.name, root.relativePath, root.rootPath));
      const { icon: _discoveredIcon, ...metadata } = project;
      return {
        project: { ...metadata, ...(iconRootId !== null && iconPath !== null ? { icon: { rootId: iconRootId, path: iconPath } } : {}) },
        sourceKey,
        checkedAt,
      };
      });
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
