/*
 * Exports:
 * - WorkbenchProjectSnapshotSchema: strict project tree and change-summary wire contract. Keywords: project, tree, snapshot, schema.
 * - WorkbenchProjectStateUpdateSchema/WorkbenchProjectStateUpdate: successful pushed project snapshot update. Keywords: project, websocket, revision.
 * - WorkbenchProjectStateRequestSchema/WorkbenchProjectStateRequest: refresh, create, and delete requests carried by the existing project observation. Keywords: project, mutation, websocket.
 * - WorkbenchCreateEntryResultSchema/WorkbenchDeleteFileResultSchema: mutation metadata returned without duplicate tree snapshots. Keywords: project, mutation, result, schema.
 */
import { z } from "zod";

import type { TreeNode } from "../../types";

const ChangeSummarySchema = z.object({ additions: z.number(), deletions: z.number() }).strict();
const WorkbenchProjectRootSchema = z.object({
  id: z.string(),
  isPrimary: z.boolean(),
  name: z.string(),
  relativePath: z.string(),
  rootPath: z.string(),
}).strict();

const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ isIgnored: z.boolean().optional(), name: z.string(), path: z.string(), type: z.literal("file") }).strict(),
  z.object({ children: z.array(TreeNodeSchema), name: z.string(), path: z.string(), type: z.literal("directory") }).strict(),
]));

export const WorkbenchProjectSnapshotSchema = z.object({
  changes: z.record(z.string(), ChangeSummarySchema),
  projectId: z.string().min(1),
  root: z.string(),
  rootPath: z.string(),
  roots: z.array(WorkbenchProjectRootSchema),
  tree: z.array(TreeNodeSchema),
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
    method: z.literal("workbench/thread-state/project/entry/create"),
    name: z.string(),
    parentPath: z.string(),
    type: z.enum(["directory", "file"]),
  }),
  ProjectRequestBase.extend({
    confirmUntracked: z.boolean().optional(),
    method: z.literal("workbench/thread-state/project/file/delete"),
    path: z.string().min(1),
  }),
]);
export type WorkbenchProjectStateRequest = z.infer<typeof WorkbenchProjectStateRequestSchema>;

export const WorkbenchCreateEntryResultSchema = z.object({
  path: z.string().min(1),
  type: z.enum(["directory", "file"]),
}).strict();

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
