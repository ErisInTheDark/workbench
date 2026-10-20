/*
 * Exports:
 * - PresentationImportSourceSchema/PresentationImportSource: durable draft receipt identity.
 */
import { z } from "zod";

export const PresentationImportSourceSchema = z.object({
  kind: z.literal("draft"),
  sourceId: z.string().min(1).max(512),
}).strict();
export type PresentationImportSource = z.infer<typeof PresentationImportSourceSchema>;
