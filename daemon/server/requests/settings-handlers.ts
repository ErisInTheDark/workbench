/*
 * Exports:
 * - settingsRequestHandlers: daemon handlers for command approvals, auto-approve review, MCP servers, local capabilities, auto-compaction
 *   and composer profiles, including context-window validation and thread profile target resolution.
 */
import type { WorkbenchComposerProfileSlot, WorkbenchComposerSettings } from "workbench-shared/types";
import { ApprovalReviewSettingsUpdateSchema } from "workbench-shared/workbench/approval-review/approval-review-settings";
import {
  McpServerSettingsReadParamsSchema, McpServerSettingsUpdateSchema, McpServerSignInFinishParamsSchema, McpServerSignInStartParamsSchema,
} from "workbench-shared/workbench/mcp/mcp-server-settings";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { CommandApprovalPatchSchema, CommandApprovalRemoveSchema } from "workbench-shared/workbench/settings/command-approvals";
import { ThreadAutoCompactSettingsPatchSchema } from "workbench-shared/workbench/settings/thread-auto-compact";
import { isSelectableContextWindow } from "workbench-shared/workbench/thread/thread-profile";
import { WorkbenchComposerProfileSelectionSchema, WorkbenchComposerProfileSlotInputSchema } from "workbench-shared/workbench/thread/thread-state";
import {
  defineDaemonRequestHandlers, InvalidParamsError, record, requiredString, type DaemonRequestContext,
} from "./daemon-request-handler";

async function commandApprovals(method: "read" | "remove" | "patch", params: Record<string, unknown>, { owners }: DaemonRequestContext) {
  const { id: projectId } = await owners.projects.resolveProjectById(requiredString(params, "projectId"));
  if (!owners.commandApprovals) throw new Error("Command approvals are unavailable.");
  if (method === "remove") {
    const parsed = CommandApprovalRemoveSchema.safeParse({ ...params, projectId });
    if (!parsed.success) throw new InvalidParamsError("Invalid command approval removal.");
    await owners.commandApprovals.remove(projectId, parsed.data.id);
  }
  if (method === "patch") {
    const parsed = CommandApprovalPatchSchema.safeParse({ ...params, projectId });
    if (!parsed.success) throw new InvalidParamsError("Invalid command approval patch.");
    return { rules: await owners.commandApprovals.patch(projectId, parsed.data.workdir, parsed.data.add, parsed.data.removeIds) };
  }
  return { rules: await owners.commandApprovals.list(projectId) };
}

function approvalReview({ owners }: DaemonRequestContext) {
  if (!owners.approvalReview) throw new Error("Auto-approve settings are unavailable.");
  return owners.approvalReview;
}

function mcpServers({ owners }: DaemonRequestContext) {
  if (!owners.mcpServers) throw new Error("MCP server settings are unavailable.");
  return owners.mcpServers;
}

async function resolveProfileSlot(
  { owners }: DaemonRequestContext, slot: ReturnType<typeof WorkbenchComposerProfileSlotInputSchema.parse>,
): Promise<WorkbenchComposerProfileSlot> {
  if (slot.kind !== "thread") return slot;
  const thread = await owners.threadIdentity.resolve({ threadId: slot.threadId, projectId: slot.projectId, harness: slot.harness });
  if (!thread) throw new InvalidParamsError("Composer thread identity is unavailable.");
  return { ...slot, projectId: thread.projectId, threadId: thread.threadId };
}

async function validateContextWindow(
  { owners }: DaemonRequestContext, settings: WorkbenchComposerSettings, previous: WorkbenchComposerSettings | null,
) {
  const cap = settings.contextWindowTokens;
  if (cap == null || (previous?.harness === settings.harness && previous.model === settings.model && previous.contextWindowTokens === cap)) return;
  const key = installedProviderKeys.find(candidate => candidate === settings.harness);
  if (!key) throw new InvalidParamsError("The requested provider is unavailable.");
  if (!owners.providers) throw new Error("Model context capabilities are unavailable.");
  const capability = (await owners.providers.get(key).configuration.modelContext.read()).find((entry) => entry.model === settings.model);
  if (!capability) throw new InvalidParamsError("This model has no configurable context capability.");
  if (!isSelectableContextWindow(capability, cap)) {
    throw new InvalidParamsError("Context window must be within the model bounds in 1K steps.");
  }
}

export const settingsRequestHandlers = defineDaemonRequestHandlers({
  "command-approvals/read": (params, context) => commandApprovals("read", params, context),
  "command-approvals/remove": (params, context) => commandApprovals("remove", params, context),
  "command-approvals/patch": (params, context) => commandApprovals("patch", params, context),
  "approval-review/read": async (_params, context) => await approvalReview(context).read(),
  "approval-review/update": async (params, context) => {
    const owner = approvalReview(context);
    const parsed = ApprovalReviewSettingsUpdateSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid auto-approve settings update.");
    return await owner.update(parsed.data);
  },
  "mcp-servers/read": async (params, context) => {
    const parsed = McpServerSettingsReadParamsSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid MCP server settings read.");
    return await mcpServers(context).read(parsed.data);
  },
  "mcp-servers/update": async (params, context) => {
    const owner = mcpServers(context);
    const parsed = McpServerSettingsUpdateSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError(parsed.error.issues[0]?.message ?? "Invalid MCP server settings update.");
    return await owner.update(parsed.data);
  },
  "mcp-servers/sign-in/start": async (params, context) => {
    const owner = mcpServers(context);
    const parsed = McpServerSignInStartParamsSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid MCP sign-in request.");
    return await owner.startSignIn(parsed.data);
  },
  "mcp-servers/sign-in/finish": async (params, context) => {
    const owner = mcpServers(context);
    const parsed = McpServerSignInFinishParamsSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid MCP sign-in callback.");
    return await owner.finishSignIn(parsed.data);
  },
  "local-capabilities/read": async (_params, { owners }) => ({ localCapabilities: await owners.settings.readLocalCapabilities() }),
  "local-capabilities/update": async (params, { owners }) => {
    const local = record(params.localCapabilities);
    return { localCapabilities: await owners.settings.updateLocalCapabilities((current) => ({
      ...current,
      ...(typeof local.browseRawCommandsEnabled === "boolean" ? { browseRawCommandsEnabled: local.browseRawCommandsEnabled } : {}),
    })) };
  },
  "thread-auto-compact/read": async (_params, { owners }) => ({ settings: await owners.settings.readThreadAutoCompact() }),
  "thread-auto-compact/update": async (params, { owners }) => {
    const edit = ThreadAutoCompactSettingsPatchSchema.safeParse(params.settings);
    if (!edit.success) throw new InvalidParamsError("Invalid auto-compact settings.");
    const settings = await owners.settings.updateThreadAutoCompact(edit.data);
    await owners.autoCompact?.refreshObserved();
    return { settings };
  },
  "profiles/read": async (_params, { owners }) => await owners.profiles.read(),
  "profiles/target/read": async (params, context) => {
    const slot = WorkbenchComposerProfileSlotInputSchema.safeParse(params.slot);
    if (!slot.success) throw new InvalidParamsError("slot must identify a composer profile target.");
    return { selection: await context.owners.profileTargets.readComposerProfileTarget(await resolveProfileSlot(context, slot.data)) };
  },
  "profiles/target/set": async (params, context) => {
    const slot = WorkbenchComposerProfileSlotInputSchema.safeParse(params.slot);
    const selection = WorkbenchComposerProfileSelectionSchema.safeParse(params.selection);
    if (!slot.success) throw new InvalidParamsError("slot must identify a composer profile target.");
    if (!selection.success) throw new InvalidParamsError("selection must contain exact composer settings.");
    const target = await resolveProfileSlot(context, slot.data);
    const previous = selection.data.settings.contextWindowTokens == null ? null : await context.owners.profileTargets.readComposerProfileTarget(target);
    await validateContextWindow(context, selection.data.settings, previous?.settings ?? null);
    const ok = await context.owners.profileTargets.setComposerProfileTarget(target, selection.data);
    if (!ok) throw new InvalidParamsError("The composer profile target does not exist or rejects these settings.");
    return { ok: true };
  },
  "profiles/delete": async (params, { owners }) => await owners.profiles.mutate({ kind: "delete", profileId: requiredString(params, "profileId") }),
  "profiles/upsert": async (params, context) => await context.owners.profiles.mutate({
    kind: "upsert",
    profile: record(params.profile),
    ...(params.changes !== undefined ? { changes: record(params.changes) } : {}),
  }, (profile, previous) => validateContextWindow(context, profile, previous)),
});
