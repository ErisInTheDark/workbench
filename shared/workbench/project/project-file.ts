/*
 * Exports:
 * - FilePayloadSchema: validated file contents and disk identity.
 * - ProjectFileSnapshotSchema/ProjectFileSnapshot: observed file and its checkout change summary.
 */
import { z } from "zod";

export const FilePayloadSchema = z.object({
  content: z.string(),
  headContent: z.string().nullable(),
  mtimeMs: z.number(),
  path: z.string(),
  projectId: z.string(),
  updatedAt: z.string(),
}).strict();

export const ProjectFileSnapshotSchema = FilePayloadSchema.extend({
  changeSummary: z.object({ additions: z.number(), deletions: z.number() }).strict().nullable(),
}).strict();

export type ProjectFileSnapshot = z.infer<typeof ProjectFileSnapshotSchema>;
