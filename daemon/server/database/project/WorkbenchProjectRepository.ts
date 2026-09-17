/*
 * Exports:
 * - default WorkbenchProjectRepository: own project parents, aliases, catalogue reconciliation, and icon settlement.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ProjectIdSchema, ProjectIdentityKeySchema, type ProjectId } from "workbench-shared/workbench/identity";
import { WorkbenchProjectIconSchema, WorkbenchProjectOptionSchema } from "workbench-shared/workbench/project/project-state";
import type { ProjectSchemaRows } from "workbench-shared/workbench/database/schema/project-schema";
import { nativeLocationKey } from "../thread-identity/native-location-key.ts";
import type { WorkbenchProjectAlias, WorkbenchProjectCandidate, WorkbenchProjectDiscovery, WorkbenchProjectStartup, WorkbenchProjectIconSettlement } from "./workbench-project-persistence.ts";

const uuid = z.string().uuid();

export default class WorkbenchProjectRepository {
  constructor(private readonly database: Database.Database) {}

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
    if (projectId === "workbench-library" || uuid.safeParse(projectId).success) {
      this.database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(projectId);
      return projectId;
    }
    const key = ProjectIdentityKeySchema.parse(id);
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT id FROM workbench_projects WHERE identity_key = ?").pluck().get(key) as string | undefined;
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

  private retainAlias(alias: string, projectId: ProjectId) {
    if (alias === projectId) return;
    const previous = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get(alias);
    if (previous && previous !== projectId) throw new Error("Project alias conflicts with retained ownership.");
    this.database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES (?, ?) ON CONFLICT(alias) DO NOTHING").run(alias, projectId);
  }

  reconcile(discovery: WorkbenchProjectDiscovery): WorkbenchProjectStartup {
    const parsed = discovery.data.map(candidate => ({
      ...candidate,
      identityKey: ProjectIdentityKeySchema.parse(candidate.identityKey),
      roots: candidate.roots.map(root => ({ ...root, identityKey: ProjectIdentityKeySchema.parse(root.identityKey) })),
    }));
    return this.database.transaction(() => {
      const observed = new Set(discovery.observedKeys);
      const excludedRootPaths = new Set(discovery.excludedRootPaths);
      const retainedProjects = this.database.prepare("SELECT * FROM workbench_projects").all() as ProjectSchemaRows["projects"][];
      const retainedRoots = new Map(retainedProjects.map(project => [
        project.id,
        this.database.prepare("SELECT * FROM workbench_project_roots WHERE project_id = ? ORDER BY root_index").all(project.id) as ProjectSchemaRows["roots"][],
      ]));
      const candidates = new Map<string, WorkbenchProjectCandidate[]>();
      for (const project of parsed) {
        const group = candidates.get(project.identityKey) ?? [];
        group.push(project);
        candidates.set(project.identityKey, group);
      }
      const selected = [...candidates.values()].map(group => {
        if (group.length === 1) return group[0]!;
        if (group.some(project => project.kind !== "workspace" || !project.workspacePath)) {
          throw new Error("Project catalogue contains duplicate identities.");
        }
        const previous = this.database.prepare("SELECT workspace_path FROM workbench_projects WHERE identity_key = ?")
          .get(group[0]!.identityKey) as Pick<ProjectSchemaRows["projects"], "workspace_path"> | undefined;
        const retained = previous?.workspace_path
          ? group.find(project => nativeLocationKey(project.workspacePath!) === nativeLocationKey(previous.workspace_path!))
          : undefined;
        return retained ?? group.sort((left, right) => {
          const a = nativeLocationKey(left.workspacePath!);
          const b = nativeLocationKey(right.workspacePath!);
          return a < b ? -1 : a > b ? 1 : 0;
        })[0]!;
      });
      const catalog: WorkbenchProjectStartup["catalog"] = [];
      for (const project of selected) {
      if (!project.roots.length || !project.roots[0]!.isPrimary || project.roots.slice(1).some(root => root.isPrimary)
        || new Set(project.roots.map(root => root.id)).size !== project.roots.length
        || project.roots.some(root => !root.id || !path.isAbsolute(root.rootPath))
        || nativeLocationKey(project.rootPath) !== nativeLocationKey(project.roots[0]!.rootPath)) {
        throw new Error("Project catalogue has invalid ordered roots.");
      }
      const stored = this.database.prepare("SELECT * FROM workbench_projects WHERE identity_key = ?").get(project.identityKey) as ProjectSchemaRows["projects"] | undefined;
      const rootsFor = (id: string) => retainedRoots.get(id) ?? [];
      const sameLocation = (row: ProjectSchemaRows["projects"]) => {
        if (row.kind !== project.kind) return false;
        if (row.kind === "workspace" && (!row.workspace_path || !project.workspacePath
          || nativeLocationKey(row.workspace_path) !== nativeLocationKey(project.workspacePath))) return false;
        const roots = rootsFor(row.id);
        return roots.length === project.roots.length && roots.every(root =>
          project.roots.some(next => nativeLocationKey(next.rootPath) === nativeLocationKey(root.root_path)));
      };
      const atLocation = retainedProjects.filter(row => (row.kind === "git" || row.kind === "workspace") && sameLocation(row));
      const aliasOwner = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get(project.identityKey) as string | undefined;
      let owner = stored;
      let conflict = "";
      if (owner && atLocation.some(previous => previous.id !== owner.id)) {
        conflict = "current identity and checkout have different retained owners";
      } else if (!owner && atLocation.length) {
        const previous = atLocation[0]!;
        if (atLocation.length !== 1) conflict = "multiple retained owners at the checkout";
        else if (!discovery.complete) conflict = "incomplete discovery cannot prove a remote change";
        else if (!previous.identity_key || observed.has(ProjectIdentityKeySchema.parse(previous.identity_key))) conflict = "previous identity is still observed";
        else if (aliasOwner && aliasOwner !== previous.id) conflict = "new identity has another retained owner";
        else if (project.kind === "workspace" && rootsFor(previous.id).some(root => {
          const next = project.roots.find(item => nativeLocationKey(item.rootPath) === nativeLocationKey(root.root_path))!;
          return !root.identity_key || (root.identity_key !== next.identityKey && observed.has(ProjectIdentityKeySchema.parse(root.identity_key)));
        })) conflict = "workspace member identity is missing or still observed";
        else owner = previous;
      } else if (!owner && aliasOwner) {
        conflict = "retained identity requires same-location evidence";
      } else if (owner && owner.kind !== "historical" && !sameLocation(owner) && !discovery.complete) {
        conflict = "incomplete discovery cannot prove a checkout move";
      }
      const id = ProjectIdSchema.parse(owner?.id ?? (project.kind === "workbench-library" ? "workbench-library" : randomUUID()));
      const addresses: string[] = [];
      for (const { alias: address } of discovery.aliases.filter(alias => alias.identityKey === project.identityKey)) {
        const retained = this.database.prepare("SELECT project_id FROM workbench_project_aliases WHERE alias = ?").pluck().get(address);
        if (retained && retained !== id) {
          const previous = retainedProjects.find(row => row.id === retained);
          // Changing workspace membership creates a new owner, not a reassignment
          // of its historical file address. Publish only its new identity key.
          if ((!owner || sameLocation(owner)) && discovery.complete && project.kind === "workspace" && previous?.kind === "workspace"
            && previous.workspace_path && project.workspacePath
            && nativeLocationKey(previous.workspace_path) === nativeLocationKey(project.workspacePath)
            && !sameLocation(previous)) continue;
          conflict = "checkout address has another retained owner";
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
        if (owner.identity_key) this.retainAlias(owner.identity_key, id);
        this.database.prepare("UPDATE workbench_projects SET identity_key = ? WHERE id = ?").run(project.identityKey, id);
      }
      this.retainAlias(project.identityKey, id);
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
          last_commit_time_ms = ?, icon_source_key = ?, icon_root_id = ?, icon_path = ?, icon_checked_at = ?
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
        sourceKey,
        checkedAt,
      });
      }
      return { catalog, aliases: this.readAliases(), rootPath: discovery.rootPath, excludedRootPaths: [...excludedRootPaths] };
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
