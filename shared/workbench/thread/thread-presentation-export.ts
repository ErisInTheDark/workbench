/*
 * Exports:
 * - WorkbenchPresentationExportRequestSchema/WorkbenchPresentationExportPageSchema: paged legacy draft source.
 * - WorkbenchPresentationLayoutChunkRequestSchema/WorkbenchPresentationLayoutChunkSchema: revision-fenced layout transfer.
 * - WorkbenchPresentationAttachmentChunkRequestSchema/WorkbenchPresentationAttachmentChunkSchema: bounded inline attachment transfer.
 * - WorkbenchPresentationManifestRequestSchema/WorkbenchPresentationManifestPageSchema: bounded legacy source inventory.
 */
import { z } from "zod";
import { DraftIdSchema, ProjectIdSchema } from "../identity.ts";
import { WorkbenchComposerSettingsSchema } from "./thread-state.ts";

const attachment = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inline"), id: z.string().min(1), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    byteLength: z.number().int().nonnegative(), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  z.object({ kind: z.literal("url"), id: z.string().min(1), url: z.string().url() }).strict(),
]);
const draft = z.object({
  draftId: z.uuid(),
  prompt: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  clientUpdatedAt: z.number().int().nonnegative(),
  profileId: z.string().nullable(),
  composerSettings: WorkbenchComposerSettingsSchema,
  pinned: z.boolean(),
  snoozed: z.boolean(),
  attachments: z.array(attachment),
}).strict();
export const WorkbenchPresentationExportRequestSchema = z.object({
  projectId: ProjectIdSchema,
  cursor: z.string().nullable().optional(),
  draftIds: z.array(DraftIdSchema).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
export type WorkbenchPresentationExportRequest = z.input<typeof WorkbenchPresentationExportRequestSchema>;
export const WorkbenchPresentationExportPageSchema = z.object({
  projectId: ProjectIdSchema,
  sourceRevision: z.number().int().nonnegative(),
  drafts: z.array(draft).max(20),
  nextCursor: z.string().nullable(),
}).strict();
export type WorkbenchPresentationExportPage = z.infer<typeof WorkbenchPresentationExportPageSchema>;
export const WorkbenchPresentationManifestRequestSchema = z.object({
  cursor: z.string().min(1).max(256).nullable().optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();
export type WorkbenchPresentationManifestRequest = z.input<typeof WorkbenchPresentationManifestRequestSchema>;
export const WorkbenchPresentationManifestPageSchema = z.object({
  sources: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("draft"), projectId: ProjectIdSchema, sourceId: DraftIdSchema }).strict(),
    z.object({ kind: z.literal("projectLayout"), projectId: ProjectIdSchema, sourceId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("homeLayout"), sourceId: z.literal("home") }).strict(),
    z.object({ kind: z.literal("pinnedLayout"), sourceId: z.literal("pinned") }).strict(),
  ])).max(200),
  nextCursor: z.string().nullable(),
}).strict();
export type WorkbenchPresentationManifestPage = z.infer<typeof WorkbenchPresentationManifestPageSchema>;
const layoutCursor = {
  sourceRevision: z.number().int().nonnegative().nullable(),
  offset: z.number().int().nonnegative(),
};
export const WorkbenchPresentationLayoutChunkRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("project"), projectId: ProjectIdSchema, ...layoutCursor }).strict(),
  z.object({ scope: z.literal("home"), ...layoutCursor }).strict(),
  z.object({ scope: z.literal("pinned"), ...layoutCursor }).strict(),
]);
export type WorkbenchPresentationLayoutChunkRequest = z.infer<typeof WorkbenchPresentationLayoutChunkRequestSchema>;
export const WorkbenchPresentationLayoutChunkSchema = z.object({
  sourceRevision: z.number().int().nonnegative(),
  bytes: z.string().max(87_384),
  totalBytes: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type WorkbenchPresentationLayoutChunk = z.infer<typeof WorkbenchPresentationLayoutChunkSchema>;
export const WorkbenchPresentationAttachmentChunkRequestSchema = z.object({
  projectId: ProjectIdSchema,
  draftId: z.uuid(),
  attachmentId: z.string().min(1),
  offset: z.number().int().nonnegative(),
}).strict();
export type WorkbenchPresentationAttachmentChunkRequest = z.infer<typeof WorkbenchPresentationAttachmentChunkRequestSchema>;
export const WorkbenchPresentationAttachmentChunkSchema = z.object({
  bytes: z.string().max(87_384),
  nextOffset: z.number().int().nonnegative().nullable(),
  byteLength: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
}).strict();
export type WorkbenchPresentationAttachmentChunk = z.infer<typeof WorkbenchPresentationAttachmentChunkSchema>;
