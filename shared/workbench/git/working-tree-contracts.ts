/*
 * Exports:
 * - WorkingTreeFileSchema/WorkingTreeRepositorySchema/WorkingTreeReadSchema: scanned files, owners and repository state.
 * - WorkingTreeReadRequestSchema/WorkingTreeFileRequestSchema/WorkingTreeMutationSchema: validated working-tree intents.
 * - WorkingTreeDiffSchema/WorkingTreePreviewSchema/WorkingTreeResultSchema: bounded content and mutation outcomes.
 * - WorkingTreeFile/WorkingTreeRepository/WorkingTreeRead/WorkingTreeFileRequest/WorkingTreeMutation/WorkingTreeDiff/WorkingTreePreview/WorkingTreeResult/WorkingTreeSelection: domain types.
 */
import { z } from "zod";
import { WorkbenchThreadSidebarEntrySchema } from "../thread/thread-state";

const oid = z.string().regex(/^[a-f0-9]{40,64}$/u);
const filePath = z.string().min(1).refine(value => !value.includes("\0") && !value.startsWith("/") && !value.split("/").includes(".."));
export const WorkingTreeFileSchema = z.object({
  path: filePath, oldPath: filePath.nullable(), status: z.enum(["A", "M", "D", "R", "T"]),
  baseBlob: oid.nullable(), blob: oid.nullable(), baseMode: z.string(), mode: z.string(),
  identity: z.string(), additions: z.number().nullable(), deletions: z.number().nullable(),
  binary: z.boolean(), partial: z.boolean(),
  ownerIds: z.array(z.string()),
});
export const WorkingTreeRepositorySchema = z.object({
  rootId: z.string(), label: z.string(), cwd: z.string(), head: oid.nullable(),
  tree: oid, branch: z.string().nullable(), message: z.string(),
  amendReason: z.string().nullable(), blockedReason: z.string().nullable(),
  files: z.array(WorkingTreeFileSchema),
  owners: z.array(z.object({ id: z.string(), projectId: z.string(), entry: WorkbenchThreadSidebarEntrySchema })),
});
export const WorkingTreeReadSchema = z.object({
  repositories: z.array(WorkingTreeRepositorySchema),
  errors: z.array(z.object({ rootId: z.string(), message: z.string() })),
  cacheHit: z.boolean().optional(),
});
const projectRequest = z.object({ projectId: z.string().min(1) });
export const WorkingTreeReadRequestSchema = projectRequest.extend({ preferCached: z.boolean().default(false) });
export const WorkingTreeFileRequestSchema = projectRequest.extend({
  rootId: z.string(), path: filePath, identity: z.string(),
});
const selectionSchema = z.object({ path: filePath, identity: z.string(), lineIds: z.array(z.string()).nullable() });
export const WorkingTreeMutationSchema = projectRequest.extend({
  rootId: z.string(), expectedHead: oid.nullable(),
  mode: z.enum(["commit", "amend", "stash", "discard"]),
  targetCommit: oid.nullable(), title: z.string().max(10_000), description: z.string().max(100_000),
  selections: z.array(selectionSchema).max(20_000),
});
export const WorkingTreeDiffSchema = z.object({
  identity: z.string(), patch: z.string(), unavailable: z.string().nullable(),
});
export const WorkingTreePreviewSchema = z.object({
  identity: z.string(), before: z.string().nullable(), after: z.string().nullable(),
  encoding: z.enum(["text", "base64"]), mime: z.string(), unavailable: z.string().nullable(),
});
export const WorkingTreeResultSchema = z.object({
  status: z.enum(["complete", "incomplete"]), commit: oid.nullable(), stash: oid.nullable(),
  message: z.string(), warnings: z.array(z.string()),
});
export type WorkingTreeFile = z.infer<typeof WorkingTreeFileSchema>;
export type WorkingTreeRepository = z.infer<typeof WorkingTreeRepositorySchema>;
export type WorkingTreeRead = z.infer<typeof WorkingTreeReadSchema>;
export type WorkingTreeFileRequest = z.infer<typeof WorkingTreeFileRequestSchema>;
export type WorkingTreeMutation = z.infer<typeof WorkingTreeMutationSchema>;
export type WorkingTreeDiff = z.infer<typeof WorkingTreeDiffSchema>;
export type WorkingTreePreview = z.infer<typeof WorkingTreePreviewSchema>;
export type WorkingTreeResult = z.infer<typeof WorkingTreeResultSchema>;
export type WorkingTreeSelection = z.infer<typeof selectionSchema>;
