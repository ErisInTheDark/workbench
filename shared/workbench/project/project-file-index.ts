/*
 * Exports:
 * - WorkbenchProjectFileIndexRequest/Schema: one validated project-qualified file-index read.
 * - WorkbenchProjectFileIndexResponse/Schema: flattened candidates from the daemon's cached tree.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity";

export const WorkbenchProjectFileIndexRequestSchema = z.object({
  projectId: ProjectIdSchema,
}).strict();
export type WorkbenchProjectFileIndexRequest = z.infer<typeof WorkbenchProjectFileIndexRequestSchema>;

export const WorkbenchProjectFileIndexResponseSchema = z.object({
  projectId: ProjectIdSchema,
  key: z.string(),
  candidates: z.array(z.object({
    path: z.string(),
    isIgnored: z.boolean(),
  }).strict()),
}).strict();
export type WorkbenchProjectFileIndexResponse = z.infer<typeof WorkbenchProjectFileIndexResponseSchema>;
