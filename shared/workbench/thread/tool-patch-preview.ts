/*
 * Exports:
 * - ToolPatchPreviewFileSchema/ToolPatchPreviewFile: generated file intent, never proof of an applied change.
 */
import { z } from "zod";

export const ToolPatchPreviewFileSchema = z.object({
  path: z.string().min(1),
  kind: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add") }),
    z.object({ type: z.literal("delete") }),
    z.object({ type: z.literal("update"), move_path: z.string().nullable() }),
  ]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type ToolPatchPreviewFile = z.infer<typeof ToolPatchPreviewFileSchema>;
