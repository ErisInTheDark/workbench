/*
 * Exports:
 * - WorkbenchThreadIdSchema/WorkbenchThreadId, WorkbenchTurnIdSchema/WorkbenchTurnId, WorkbenchItemIdSchema/WorkbenchItemId: admitted Workbench identities.
 * - NativeThreadIdSchema/NativeThreadId, NativeTurnIdSchema/NativeTurnId, NativeItemIdSchema/NativeItemId: provider-owned identities.
 * - PendingTurnIdSchema/PendingTurnId: temporary turn identity before provider admission.
 * - ThreadReferenceSchema/ThreadReference, TurnReferenceSchema/TurnReference, ItemReferenceSchema/ItemReference: unresolved boundary references.
 * - ProjectIdSchema/ProjectId, DraftIdSchema/DraftId, FolderIdSchema/FolderId: distinct Workbench entity identities.
 * - ThreadDisplayKeySchema/ThreadDisplayKey, ProjectThreadDisplayKeySchema/ProjectThreadDisplayKey, ThreadDocumentKeySchema/ThreadDocumentKey: distinct encoded key spaces.
 * - NativeThreadKeySchema/NativeThreadKey, NativeTurnKeySchema/NativeTurnKey, NativeThreadReferenceKeySchema/NativeThreadReferenceKey: provider execution lookup keys.
 * - TranscriptIdentityKeySchema/TranscriptIdentityKey: canonical-item and source-alias lookup keys.
 */
import { z } from "zod";

// Tags record provenance, not UUID syntax. Only an owning admission boundary
// can establish that an incoming reference denotes a Workbench identity.
export const WorkbenchThreadIdSchema = z.string().trim().min(1).brand<"WorkbenchThreadId">();
export type WorkbenchThreadId = z.infer<typeof WorkbenchThreadIdSchema>;
export const WorkbenchTurnIdSchema = z.string().min(1).brand<"WorkbenchTurnId">();
export type WorkbenchTurnId = z.infer<typeof WorkbenchTurnIdSchema>;
export const WorkbenchItemIdSchema = z.string().min(1).brand<"WorkbenchItemId">();
export type WorkbenchItemId = z.infer<typeof WorkbenchItemIdSchema>;

export const NativeThreadIdSchema = z.string().min(1).brand<"NativeThreadId">();
export type NativeThreadId = z.infer<typeof NativeThreadIdSchema>;
export const NativeTurnIdSchema = z.string().min(1).brand<"NativeTurnId">();
export type NativeTurnId = z.infer<typeof NativeTurnIdSchema>;
export const NativeItemIdSchema = z.string().min(1).brand<"NativeItemId">();
export type NativeItemId = z.infer<typeof NativeItemIdSchema>;
export const PendingTurnIdSchema = z.string().min(1).brand<"PendingTurnId">();
export type PendingTurnId = z.infer<typeof PendingTurnIdSchema>;

export const ThreadReferenceSchema = z.string().trim().min(1).brand<"ThreadReference">();
export type ThreadReference = z.infer<typeof ThreadReferenceSchema>;
export const TurnReferenceSchema = z.string().min(1).brand<"TurnReference">();
export type TurnReference = z.infer<typeof TurnReferenceSchema>;
export const ItemReferenceSchema = z.string().min(1).brand<"ItemReference">();
export type ItemReference = z.infer<typeof ItemReferenceSchema>;

export const ProjectIdSchema = z.string().trim().min(1).brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const DraftIdSchema = z.string().min(1).brand<"DraftId">();
export type DraftId = z.infer<typeof DraftIdSchema>;
export const FolderIdSchema = z.string().min(1).brand<"FolderId">();
export type FolderId = z.infer<typeof FolderIdSchema>;

export const ThreadDisplayKeySchema = z.string().min(1).brand<"ThreadDisplayKey">();
export type ThreadDisplayKey = z.infer<typeof ThreadDisplayKeySchema>;
export const ProjectThreadDisplayKeySchema = z.string().min(1).brand<"ProjectThreadDisplayKey">();
export type ProjectThreadDisplayKey = z.infer<typeof ProjectThreadDisplayKeySchema>;
export const ThreadDocumentKeySchema = z.string().min(1).brand<"ThreadDocumentKey">();
export type ThreadDocumentKey = z.infer<typeof ThreadDocumentKeySchema>;
export const NativeThreadKeySchema = z.string().min(1).brand<"NativeThreadKey">();
export type NativeThreadKey = z.infer<typeof NativeThreadKeySchema>;
export const NativeTurnKeySchema = z.string().min(1).brand<"NativeTurnKey">();
export type NativeTurnKey = z.infer<typeof NativeTurnKeySchema>;
export const NativeThreadReferenceKeySchema = z.string().min(1).brand<"NativeThreadReferenceKey">();
export type NativeThreadReferenceKey = z.infer<typeof NativeThreadReferenceKeySchema>;
export const TranscriptIdentityKeySchema = z.string().min(1).brand<"TranscriptIdentityKey">();
export type TranscriptIdentityKey = z.infer<typeof TranscriptIdentityKeySchema>;
