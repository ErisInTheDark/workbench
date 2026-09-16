/*
 * Exports:
 * - default WorkbenchThreadStateIntegrity: verify canonical relational readback and subagent allocation.
 */
import type Database from "better-sqlite3";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchThreadStateRelationalRepository from "./WorkbenchThreadStateRelationalRepository.ts";
import WorkbenchSubagentRelationshipRepository from "./WorkbenchSubagentRelationshipRepository.ts";

export default class WorkbenchThreadStateIntegrity {
  constructor(private readonly database: Database.Database) {}

  verify() {
    this.database.transaction(() => {
      const failures = this.database.pragma("foreign_key_check") as object[];
      if (failures.length) throw new Error("Current database has broken foreign-key references.");
      const repository = new WorkbenchThreadStateRelationalRepository(this.database, new WorkbenchThreadIdentityRepository(this.database));
      const threads = this.database.prepare("SELECT thread_id FROM workbench_thread_states").all() as { thread_id: WorkbenchThreadId }[];
      const records = repository.readRecords({ selection: "threads", threadIds: threads.map(row => row.thread_id) });
      if (records.length !== threads.length) throw new Error("Current thread-state data has incomplete records.");
      const projects = this.database.prepare(`
        SELECT project_id FROM workbench_thread_drafts
        UNION SELECT project_id FROM workbench_project_thread_profiles
        UNION SELECT project_id FROM workbench_sidebar_project_layouts
      `).all() as { project_id: ProjectId }[];
      for (const { project_id: projectId } of projects) {
        repository.readDrafts(projectId);
        repository.readProjectProfile(projectId);
        repository.readLayout({ kind: "project", projectId });
      }
      repository.readLayout({ kind: "pinned" });
      repository.readLayout({ kind: "home" });
      repository.readPinnedImports();
      const relationships = new WorkbenchSubagentRelationshipRepository(this.database);
      const parents = this.database.prepare("SELECT parent_thread_id FROM workbench_subagent_parents").all() as { parent_thread_id: WorkbenchThreadId }[];
      for (const { parent_thread_id: parentThreadId } of parents) {
        const parent = relationships.readParent(parentThreadId)!;
        if (parent.relationships.some(record => record.directSubagentIndex >= parent.nextDirectSubagentIndex)) {
          throw new Error("Current subagent allocation is behind its stored relationships.");
        }
      }
    })();
  }
}
