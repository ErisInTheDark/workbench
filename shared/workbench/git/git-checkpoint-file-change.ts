/*
 * Exports:
 * - GitCheckpointFileChangeSchema/GitCheckpointFileChange: one validated per-file Git inspection change.
 */
import { z } from "zod";

export const GitCheckpointFileChangeSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: z.string(),
  kind: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add") }),
    z.object({ type: z.literal("delete") }),
    z.object({ move_path: z.string().nullable(), type: z.literal("update") }),
  ]),
  path: z.string().trim().min(1),
});

export type GitCheckpointFileChange = z.infer<typeof GitCheckpointFileChangeSchema>;
