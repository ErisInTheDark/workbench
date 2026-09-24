/*
 * Exports:
 * - PresentationDraftInputSchema/PresentationDraftInput: app-owned unsent content and one concrete target.
 * - PresentationMutationSchema/PresentationMutation: revision-checked presentation intents.
 * - PresentationSnapshotSchema/PresentationSnapshot: combined app state, never a daemon execution response.
 */
import { z } from "zod";
import { DaemonIdSchema, LogicalProjectIdSchema } from "../workbench/identity.ts";
import { ProjectLocationReferenceSchema, WorkbenchProjectLocationsPayloadSchema } from "../workbench/project/project-location.ts";
import { WorkbenchComposerProfileSelectionSchema } from "../workbench/thread/thread-state.ts";

const revision = z.number().int().nonnegative();
const uuid = z.uuid();
const layoutScope = z.enum(["project", "home", "pinned"]);
const member = z.object({
  id: uuid,
  scope: layoutScope,
  logicalProjectId: LogicalProjectIdSchema.nullable(),
  folderId: uuid.nullable(),
  kind: z.enum(["draft", "thread"]),
  draftId: uuid.nullable(),
  thread: z.object({
    location: ProjectLocationReferenceSchema,
    threadId: z.string().min(1),
  }).strict().nullable(),
  position: revision,
}).strict();
const folder = z.object({
  id: uuid, scope: layoutScope, logicalProjectId: LogicalProjectIdSchema.nullable(),
  title: z.string(), position: revision,
}).strict();
const layoutInput = z.object({
  scope: layoutScope,
  logicalProjectId: LogicalProjectIdSchema.nullable(),
  folders: z.array(folder),
  members: z.array(member),
}).strict();
export const PresentationDraftInputSchema = z.object({
  id: uuid,
  logicalProjectId: LogicalProjectIdSchema,
  target: ProjectLocationReferenceSchema,
  prompt: z.string(),
  selection: WorkbenchComposerProfileSelectionSchema,
  updatedAt: revision,
}).strict();
export type PresentationDraftInput = z.infer<typeof PresentationDraftInputSchema>;
const draft = PresentationDraftInputSchema.extend({
  revision,
  phase: z.enum(["importing", "unsent", "submitting", "accepted", "deleted"]),
  pinned: z.boolean().default(false),
  snoozed: z.boolean().default(false),
  launchId: uuid.nullable(),
  acceptedThreadId: z.string().nullable(),
  attachments: z.array(z.object({
    id: z.string().min(1), mediaType: z.string().min(1), contentHash: z.string().min(1),
  }).strict()),
});
export const PresentationSnapshotSchema = z.object({
  revision,
  daemons: z.array(z.object({ id: DaemonIdSchema, hostname: z.string() }).strict()),
  projects: z.array(z.object({ id: LogicalProjectIdSchema, matchKey: z.string(), label: z.string() }).strict()),
  locations: z.array(z.object({
    target: ProjectLocationReferenceSchema, logicalProjectId: LogicalProjectIdSchema,
    identityKey: z.string(), name: z.string(), rootPath: z.string(),
  }).strict()),
  defaults: z.array(z.object({
    target: ProjectLocationReferenceSchema,
    selection: WorkbenchComposerProfileSelectionSchema,
    revision,
  }).strict()),
  drafts: z.array(draft),
  folders: z.array(folder),
  members: z.array(member),
  divergences: z.array(z.object({
    daemonId: DaemonIdSchema, sourceKind: z.enum(["draft", "layout"]),
    sourceId: z.string(), importedRevision: revision, latestRevision: revision,
  }).strict()),
  sourceMappings: z.array(z.object({
    daemonId: DaemonIdSchema, sourceKind: z.enum(["draft", "folder", "member"]),
    sourceId: z.string().min(1), targetId: uuid, sourceRevision: revision.nullable(),
  }).strict()),
}).strict();
export type PresentationSnapshot = z.infer<typeof PresentationSnapshotSchema>;
export const PresentationMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("registerLocations"), daemonId: DaemonIdSchema, hostname: z.string(),
    catalog: WorkbenchProjectLocationsPayloadSchema,
  }).strict(),
  z.object({
    kind: z.literal("putDraft"), expectedRevision: revision.nullable(), draft: PresentationDraftInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("deleteDraft"), draftId: uuid, expectedRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("setDraftPriority"), draftId: uuid, expectedRevision: revision,
    pinned: z.boolean(), snoozed: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("deleteAttachment"), draftId: uuid,
    attachmentId: z.string().min(1), expectedRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("reserveLaunch"), draftId: uuid, expectedRevision: revision, launchId: uuid,
  }).strict(),
  z.object({
    kind: z.literal("completeLaunch"), draftId: uuid, launchId: uuid, threadId: z.string().min(1),
  }).strict(),
  layoutInput.extend({ kind: z.literal("saveLayout"), expectedRevision: revision }).strict(),
  z.object({
    kind: z.literal("saveLayouts"), expectedRevision: revision,
    layouts: z.array(layoutInput).min(1).max(2),
  }).strict(),
  z.object({
    kind: z.literal("importDraft"), daemonId: DaemonIdSchema, sourceId: z.string().min(1),
    sourceRevision: revision, draft: PresentationDraftInputSchema,
    pinned: z.boolean().default(false), snoozed: z.boolean().default(false),
    attachments: z.array(z.object({
      id: z.string().min(1), mediaType: z.string().min(1), contentHash: z.string().min(1),
    }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("finishImportDraft"), daemonId: DaemonIdSchema, sourceId: z.string().min(1),
    draftId: uuid, sourceRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("importLayout"), daemonId: DaemonIdSchema, sourceId: z.string().min(1),
    sourceRevision: revision, scope: layoutScope,
    logicalProjectId: LogicalProjectIdSchema.nullable(),
    folders: z.array(folder.extend({ sourceId: z.string().min(1) })),
    members: z.array(member.extend({
      sourceId: z.string().min(1), folderId: z.string().min(1).nullable(),
      draftId: z.string().min(1).nullable(),
    })),
  }).strict(),
]);
export type PresentationMutation = z.infer<typeof PresentationMutationSchema>;
