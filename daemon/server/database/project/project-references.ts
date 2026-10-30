/*
 * Exports:
 * - ProjectReferenceDisposition: what happens to rows referencing a project that leaves the catalogue.
 * - ProjectReference: one project-referencing column with its retirement and merge dispositions.
 * - PROJECT_REFERENCES: every column naming a local project, in the order retirement and merging apply them.
 */

/**
 * - move: rows join the destination project (removed projects on retirement); a constraint failure aborts the whole change.
 * - merge: rows join the destination project, except rows colliding with the destination's own, which are dropped.
 * - delete: rows are deleted.
 * - deleteLayout: the referenced sidebar layout is deleted, cascading to its rows.
 * - keep: rows are left alone (they cascade with the project row, or name another daemon's project).
 */
export type ProjectReferenceDisposition = "move" | "merge" | "delete" | "deleteLayout" | "keep";

export interface ProjectReference {
  table: string;
  column: string;
  /** A root id column remapped onto the destination's roots when merging. */
  rootColumn?: string;
  retire: ProjectReferenceDisposition;
  merge: ProjectReferenceDisposition;
}

export const PROJECT_REFERENCES: readonly ProjectReference[] = [
  { table: "workbench_threads", column: "project_id", retire: "move", merge: "move" },
  { table: "thread_tool_daily_aggregates", column: "project_id", retire: "move", merge: "move" },
  { table: "workbench_subagent_relationships", column: "project_id", retire: "move", merge: "move" },
  { table: "workbench_thread_vis_sessions", column: "project_id", retire: "move", merge: "move" },
  { table: "workbench_agent_feedback", column: "project_id", retire: "move", merge: "move" },
  // Import receipts keep their provider thread already counted; a duplicate under the destination is the same receipt.
  { table: "thread_usage_imports", column: "project_id", retire: "merge", merge: "merge" },
  { table: "git_claim_sessions", column: "project_id", rootColumn: "root_id", retire: "delete", merge: "merge" },
  { table: "git_claim_thread_file_days", column: "project_id", rootColumn: "root_id", retire: "delete", merge: "merge" },
  // Checkpoints name commits of a checkout that no longer exists; the destination imports its own history.
  { table: "git_claim_imports", column: "project_id", retire: "delete", merge: "delete" },
  { table: "workbench_thread_drafts", column: "project_id", retire: "delete", merge: "move" },
  { table: "workbench_project_thread_profiles", column: "project_id", retire: "delete", merge: "merge" },
  { table: "workbench_composer_profiles", column: "scope_project_id", retire: "delete", merge: "move" },
  { table: "codex_sandbox_network_project_overrides", column: "project_id", retire: "delete", merge: "merge" },
  { table: "command_approval_rules", column: "project_id", retire: "keep", merge: "move" },
  { table: "workbench_project_store_entries", column: "project_id", retire: "keep", merge: "merge" },
  { table: "mcp_server_projects", column: "project_id", retire: "keep", merge: "move" },
  { table: "workbench_network_inbound_grants", column: "target_project_id", retire: "keep", merge: "move" },
  { table: "workbench_remote_subagent_relationships", column: "child_project_id", retire: "keep", merge: "keep" },
  { table: "workbench_browse_sessions", column: "project_id", retire: "delete", merge: "delete" },
  { table: "workbench_thread_launches", column: "project_id", retire: "delete", merge: "delete" },
  { table: "workbench_search_documents", column: "project_id", retire: "delete", merge: "delete" },
  { table: "workbench_sidebar_project_layouts", column: "project_id", retire: "deleteLayout", merge: "deleteLayout" },
  { table: "workbench_project_aliases", column: "project_id", retire: "delete", merge: "merge" },
  { table: "workbench_project_roots", column: "project_id", retire: "delete", merge: "delete" },
];
