/*
 * Exports:
 * - PresentationImportSourceSchema/PresentationImportSource: durable draft or layout receipt identity.
 */
import { z } from "zod";

export const PresentationImportSourceSchema = z.object({
  kind: z.enum(["draft", "layout"]),
  sourceId: z.string().min(1).max(512),
}).strict();
export type PresentationImportSource = z.infer<typeof PresentationImportSourceSchema>;
