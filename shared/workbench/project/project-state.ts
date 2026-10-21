/*
 * Exports:
 * - WorkbenchProjectsPayloadSchema: project catalog wire contract with optional icons.
 * - WorkbenchProjectOptionSchema/WorkbenchProjectIconSchema: shared catalogue and icon boundary validation.
 * - WorkbenchProjectAliasSchema: retained project-address mapping.
 * - WorkbenchProjectTreeNodeSchema/WorkbenchProjectTreeNodeFieldsSchema: one tree node, and either variant's fields for per-node deltas.
 * - WorkbenchProjectSnapshotSchema: project tree and change-summary wire contract.
 * - WorkbenchProjectStateUpdateSchema/WorkbenchProjectStateUpdate: pushed project snapshot update.
 * - WorkbenchProjectStateRequestSchema/WorkbenchProjectStateRequest: refresh and delete requests.
 * - WorkbenchDeleteFileResultSchema: deletion metadata without a duplicate snapshot.
 * - REMOVED_PROJECTS_ID: the ownerless historical project that keeps retired projects' archived threads and their stats.
 */
import { z } from "zod";

import type { TreeNode, WorkbenchProjectOption, WorkbenchProjectsPayload } from "../../types.ts";

/** Never catalogued; retired projects move their archived threads, usage and feedback here so stats totals stay exact. */
export const REMOVED_PROJECTS_ID = "00000000-0000-4000-8000-0000ffffffff";

const ChangeSummarySchema = z.object({ additions: z.number(), deletions: z.number() }).strict();
const WorkbenchProjectRootSchema = z.object({
  id: z.string(),
  isPrimary: z.boolean(),
  name: z.string(),
  relativePath: z.string(),
  rootPath: z.string(),
}).strict();

export const WorkbenchProjectIconSchema = z.object({
  path: z.string().min(1),
  rootId: z.string().min(1),
}).strict();

export const WorkbenchProjectOptionSchema = z.object({
  id: z.string().min(1).brand<"ProjectId">(),
  icon: WorkbenchProjectIconSchema.optional(),
  kind: z.enum(["git", "workspace", "workbench-library", "daemon"]),
  lastCommitTimeMs: z.number().nullable().nonoptional(),
  name: z.string(),
  relativePath: z.string(),
  rootPath: z.string(),
  roots: z.array(WorkbenchProjectRootSchema),
  workspacePath: z.string().optional(),
}).strict().transform((project): WorkbenchProjectOption => ({
  ...project,
  lastCommitTimeMs: project.lastCommitTimeMs ?? null,
}));

export const WorkbenchProjectAliasSchema = z.object({
  alias: z.string().min(1).max(4096),
  projectId: z.string().min(1).max(4096).brand<"ProjectId">(),
}).strict();

export const WorkbenchProjectsPayloadSchema = z.object({
  data: z.array(WorkbenchProjectOptionSchema),
  aliases: z.array(WorkbenchProjectAliasSchema).default([]),
  rootPath: z.string(),
}).strict().transform((payload): WorkbenchProjectsPayload => payload);

export const WorkbenchProjectTreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({
    isIgnored: z.boolean().optional(), isUntracked: z.boolean().optional(), name: z.string(), path: z.string(), type: z.literal("file"),
  }).strict(),
  z.object({ children: z.array(WorkbenchProjectTreeNodeSchema), name: z.string(), path: z.string(), type: z.literal("directory") }).strict(),
]));
/** Either node variant's fields, for validating fields a delta patches onto one node. */
export const WorkbenchProjectTreeNodeFieldsSchema = z.object({
  children: z.array(WorkbenchProjectTreeNodeSchema).optional(),
  isIgnored: z.boolean().optional(),
  isUntracked: z.boolean().optional(),
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
}).strict();

export const WorkbenchProjectSnapshotSchema = z.object({
  changes: z.record(z.string(), ChangeSummarySchema),
  projectId: z.string().min(1).brand<"ProjectId">(),
  root: z.string(),
  rootPath: z.string(),
  roots: z.array(WorkbenchProjectRootSchema),
  tree: z.array(WorkbenchProjectTreeNodeSchema),
  workbenchStorageRootPath: z.string(),
}).strict();

export const WorkbenchProjectStateUpdateSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  snapshot: WorkbenchProjectSnapshotSchema,
  updateKind: z.literal("project"),
}).strict();
export type WorkbenchProjectStateUpdate = z.infer<typeof WorkbenchProjectStateUpdateSchema>;

const ProjectRequestBase = z.object({ projectId: z.string().trim().min(1) }).strict();
export const WorkbenchProjectStateRequestSchema = z.discriminatedUnion("method", [
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/project/refresh") }),
  ProjectRequestBase.extend({
    confirmUntracked: z.boolean().optional(),
    method: z.literal("workbench/thread-state/project/file/delete"),
    path: z.string().min(1),
  }),
]);
export type WorkbenchProjectStateRequest = z.infer<typeof WorkbenchProjectStateRequestSchema>;

const DeleteConfirmationSchema = z.object({
  confirmationRequired: z.literal(true),
  path: z.string().min(1),
  projectId: z.string().min(1),
  tracked: z.literal(false),
}).strict();
const DeleteCompletedSchema = z.object({
  confirmationRequired: z.literal(false).optional(),
  path: z.string().min(1),
  tracked: z.boolean(),
}).strict();
export const WorkbenchDeleteFileResultSchema = z.union([DeleteConfirmationSchema, DeleteCompletedSchema]);
