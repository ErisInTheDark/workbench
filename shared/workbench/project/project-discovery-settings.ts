/*
 * Exports:
 * - ProjectDiscoverySettingsReadSchema: daemon-owned ordered roots.
 * - ProjectDiscoverySettingsUpdateSchema: bounded whole-list replacement intent.
 * - ProjectDiscoverySettingsResultSchema: accepted roots or bounded row issues.
 * - ProjectDiscoverySettingsUpdate: typed whole-list replacement request.
 * - ProjectDiscoverySettingsResult: typed validation and persistence outcome.
 */
import { z } from "zod";

const roots = z.array(z.string().max(4096)).max(64);
export const ProjectDiscoverySettingsReadSchema = z.object({ paths: roots }).strict();
export const ProjectDiscoverySettingsUpdateSchema = z.object({ paths: roots }).strict();
const issue = z.object({
  index: z.number().int().nonnegative(),
  reason: z.enum(["relative", "missing", "not-directory", "duplicate"]),
}).strict();
export const ProjectDiscoverySettingsResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), paths: roots }).strict(),
  z.object({ accepted: z.literal(false), issues: z.array(issue).max(64) }).strict(),
]);
export type ProjectDiscoverySettingsUpdate = z.infer<typeof ProjectDiscoverySettingsUpdateSchema>;
export type ProjectDiscoverySettingsResult = z.infer<typeof ProjectDiscoverySettingsResultSchema>;
