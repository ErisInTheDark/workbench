/*
 * Exports:
 * - InaccessibleProjectsSchema/InaccessibleProjects: projects gone from disk that still own threads, plus the catalogued merge targets.
 * - ProjectMergeRequestSchema/ProjectMergeRequest: fold one inaccessible project into one catalogued project.
 * - ProjectMergeResultSchema/ProjectMergeResult: how many threads the merge moved.
 */
import { z } from "zod";

const id = z.string().min(1).max(200);
const path = z.string().max(4096);

export const InaccessibleProjectsSchema = z.object({
  data: z.array(z.object({
    id, name: z.string(), rootPaths: z.array(path),
    threadCount: z.number().int().positive(),
    /** The one catalogued project sharing this project's kind and identity, when exactly one does. */
    suggestedTargetId: id.nullable(),
  }).strict()),
  targets: z.array(z.object({ id, name: z.string(), rootPath: path }).strict()),
}).strict();
export type InaccessibleProjects = z.infer<typeof InaccessibleProjectsSchema>;

export const ProjectMergeRequestSchema = z.object({ sourceId: id, targetId: id }).strict();
export type ProjectMergeRequest = z.infer<typeof ProjectMergeRequestSchema>;

export const ProjectMergeResultSchema = z.object({ threadCount: z.number().int().nonnegative() }).strict();
export type ProjectMergeResult = z.infer<typeof ProjectMergeResultSchema>;
