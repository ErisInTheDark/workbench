/*
 * Exports:
 * - settingsDaemonRequests: daemon requests for command approvals, auto-approve review, MCP servers, local capabilities, auto-compaction
 *   and composer profiles.
 */
import { z } from "zod";
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileChanges,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerProfileStorePayload,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchLocalCapabilitySettingsResponse,
  WorkbenchLocalCapabilitySettingsUpdateRequest,
} from "../../../types.ts";
import {
  ApprovalReviewSettingsSnapshotSchema,
  type ApprovalReviewSettingsSnapshot, type ApprovalReviewSettingsUpdate,
} from "../../approval-review/approval-review-settings.ts";
import {
  McpServerSettingsSnapshotSchema, McpServerSignInFinishResultSchema, McpServerSignInStartResultSchema,
  type McpServerSettingsReadParams, type McpServerSettingsSnapshot, type McpServerSettingsUpdate, type McpServerSignInFinishParams, type McpServerSignInFinishResult,
  type McpServerSignInStartParams, type McpServerSignInStartResult,
} from "../../mcp/mcp-server-settings.ts";
import {
  CommandApprovalSnapshotSchema,
  type CommandApprovalPatch, type CommandApprovalRead, type CommandApprovalRemove, type CommandApprovalSnapshot,
} from "../../settings/command-approvals.ts";
import { ThreadAutoCompactSettingsSchema, type ThreadAutoCompactSettings } from "../../settings/thread-auto-compact.ts";
import { WorkbenchComposerProfileSelectionSchema } from "../../thread/thread-state.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";

const localCapabilities = z.object({ localCapabilities: z.object({ browseRawCommandsEnabled: z.boolean() }).strict() }).strict();
const autoCompact = z.object({ settings: ThreadAutoCompactSettingsSchema }).strict();
const profiles = z.object({ profiles: z.array(z.object({
  lastUsedAt: z.number().int().nonnegative().nullable().default(null),
}).passthrough()) }).passthrough();

export const settingsDaemonRequests = {
  "command-approvals/read": defineDaemonRequest<CommandApprovalRead, CommandApprovalSnapshot>()({
    route: "installation", result: CommandApprovalSnapshotSchema,
  }),
  "command-approvals/remove": defineDaemonRequest<CommandApprovalRemove, CommandApprovalSnapshot>()({
    route: "installation", result: CommandApprovalSnapshotSchema,
  }),
  "command-approvals/patch": defineDaemonRequest<CommandApprovalPatch, CommandApprovalSnapshot>()({
    route: "installation", result: CommandApprovalSnapshotSchema,
  }),
  "approval-review/read": defineDaemonRequest<object, ApprovalReviewSettingsSnapshot>()({
    route: "installation", result: ApprovalReviewSettingsSnapshotSchema,
  }),
  "approval-review/update": defineDaemonRequest<ApprovalReviewSettingsUpdate, ApprovalReviewSettingsSnapshot>()({
    route: "installation", result: ApprovalReviewSettingsSnapshotSchema,
  }),
  "mcp-servers/read": defineDaemonRequest<McpServerSettingsReadParams, McpServerSettingsSnapshot>()({
    route: "installation", result: McpServerSettingsSnapshotSchema,
  }),
  "mcp-servers/update": defineDaemonRequest<McpServerSettingsUpdate, McpServerSettingsSnapshot>()({
    route: "installation", result: McpServerSettingsSnapshotSchema,
  }),
  "mcp-servers/sign-in/start": defineDaemonRequest<McpServerSignInStartParams, McpServerSignInStartResult>()({
    route: "installation", result: McpServerSignInStartResultSchema,
  }),
  "mcp-servers/sign-in/finish": defineDaemonRequest<McpServerSignInFinishParams, McpServerSignInFinishResult>()({
    // The app server's sign-in callback route relays the provider's answer itself.
    route: "app", result: McpServerSignInFinishResultSchema,
  }),
  "local-capabilities/read": defineDaemonRequest<object, WorkbenchLocalCapabilitySettingsResponse>()({ route: "installation", result: localCapabilities }),
  "local-capabilities/update": defineDaemonRequest<WorkbenchLocalCapabilitySettingsUpdateRequest, WorkbenchLocalCapabilitySettingsResponse>()({
    route: "installation", result: localCapabilities,
  }),
  "thread-auto-compact/read": defineDaemonRequest<object, { settings: ThreadAutoCompactSettings }>()({ route: "installation", result: autoCompact }),
  "thread-auto-compact/update": defineDaemonRequest<{ settings: Partial<ThreadAutoCompactSettings> }, { settings: ThreadAutoCompactSettings }>()({
    route: "installation", result: autoCompact,
  }),
  "profiles/read": defineDaemonRequest<object, WorkbenchComposerProfileStorePayload>()({ route: "installation", result: profiles, parsed: true }),
  "profiles/upsert": defineDaemonRequest<
    { profile: WorkbenchComposerProfile; changes?: WorkbenchComposerProfileChanges }, WorkbenchComposerProfileStorePayload
  >()({ route: "installation", result: profiles, parsed: true }),
  "profiles/delete": defineDaemonRequest<{ profileId: string }, WorkbenchComposerProfileStorePayload>()({
    route: "installation", result: profiles, parsed: true,
  }),
  "profiles/target/read": defineDaemonRequest<
    { slot: WorkbenchComposerProfileSlot }, { selection: WorkbenchComposerProfileTargetSelection | null }
  >()({ route: "installation", result: z.object({ selection: WorkbenchComposerProfileSelectionSchema.nullable() }).strict() }),
  "profiles/target/set": defineDaemonRequest<
    { selection: WorkbenchComposerProfileTargetSelection; slot: WorkbenchComposerProfileSlot }, { ok: true }
  >()({ route: "installation", result: z.object({ ok: z.literal(true) }).strict() }),
};
