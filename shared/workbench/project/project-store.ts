/*
 * Exports:
 * - ProjectStoreKeySchema: one single-line store key.
 * - ProjectStoreEntrySchema/ProjectStoreEntry: one readable value, or a key whose value cannot be decrypted here.
 * - ProjectStoreSnapshotSchema/ProjectStoreSnapshot: every entry for one project.
 * - ProjectStoreReadRequestSchema/ProjectStoreReadRequest: project-qualified store read.
 * - ProjectStoreUpdateRequestSchema/ProjectStoreUpdateRequest: transactional upserts and removals for one project.
 * - ProjectStoreUpdateResultSchema/ProjectStoreUpdateResult: acknowledged update.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity";

export const ProjectStoreKeySchema = z.string().min(1).max(512)
  .refine(key => !/[\r\n\0]/u.test(key), "Store keys must be a single line.");

export const ProjectStoreEntrySchema = z.union([
  z.object({ key: ProjectStoreKeySchema, value: z.string() }).strict(),
  z.object({ key: ProjectStoreKeySchema, unreadable: z.literal(true) }).strict(),
]);
export type ProjectStoreEntry = z.infer<typeof ProjectStoreEntrySchema>;

export const ProjectStoreSnapshotSchema = z.object({ entries: z.array(ProjectStoreEntrySchema) }).strict();
export type ProjectStoreSnapshot = z.infer<typeof ProjectStoreSnapshotSchema>;

export const ProjectStoreReadRequestSchema = z.object({ projectId: ProjectIdSchema }).strict();
export type ProjectStoreReadRequest = z.infer<typeof ProjectStoreReadRequestSchema>;

export const ProjectStoreUpdateRequestSchema = z.object({
  projectId: ProjectIdSchema,
  upserts: z.array(z.object({ key: ProjectStoreKeySchema, value: z.string().max(1024 * 1024) }).strict()),
  removals: z.array(ProjectStoreKeySchema),
}).strict().refine(({ upserts, removals }) => {
  const keys = upserts.map(entry => entry.key);
  return new Set(keys).size === keys.length && !keys.some(key => removals.includes(key));
}, "Each store key may change at most once per update.");
export type ProjectStoreUpdateRequest = z.infer<typeof ProjectStoreUpdateRequestSchema>;

export const ProjectStoreUpdateResultSchema = z.object({ ok: z.literal(true) }).strict();
export type ProjectStoreUpdateResult = z.infer<typeof ProjectStoreUpdateResultSchema>;
