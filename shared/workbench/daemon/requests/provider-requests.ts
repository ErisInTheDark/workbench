/*
 * Exports:
 * - providerDaemonRequests: daemon requests for provider models, context capabilities, account limits, account sign-in, sandbox
 *   networking, provider runtime installs, installation updates and the virtual repository runtime.
 */
import { z } from "zod";
import type { WorkbenchModelContextCapability } from "../../../types.ts";
import { InstallationPullResultSchema, type InstallationPullResult } from "../../installation-update.ts";
import type { InstallationPullOptions } from "../../installation-update-prediction.ts";
import { WorkbenchAccountLimitsSchema, type WorkbenchAccountLimits } from "../../provider/provider-account.ts";
import {
  ProviderAccountSnapshotSchema, type ProviderAccountRequest, type ProviderAccountSnapshot, type ProviderSignInAttemptRequest,
  type ProviderSignInCodeRequest, type ProviderSignInStartRequest, type ProviderSignOutRequest,
} from "../../provider/provider-account-sign-in.ts";
import { WorkbenchModelOptionSchema, type WorkbenchModelOption } from "../../provider/provider-model.ts";
import {
  ProviderRuntimesSnapshotSchema, type ProviderRuntimeInstallRequest, type ProviderRuntimesSnapshot,
} from "../../provider/provider-runtime.ts";
import {
  WorkbenchSandboxNetworkSettingsResponseSchema,
  type WorkbenchSandboxNetworkSettingsResponse, type WorkbenchSandboxNetworkUpdate,
} from "../../provider/provider-settings.ts";
import { VirtualRepoAvailabilitySchema, type VirtualRepoAvailability } from "../../repo/virtual-repo-contract.ts";
import { WorkbenchModelContextCapabilitySchema } from "../../thread/thread-profile.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";

const ok = z.object({ ok: z.literal(true) }).strict();

export const providerDaemonRequests = {
  "models/list": defineDaemonRequest<{ provider: string }, { data: WorkbenchModelOption[] }>()({
    route: "installation", result: z.object({ data: z.array(WorkbenchModelOptionSchema) }), parsed: true,
  }),
  "models/context/read": defineDaemonRequest<{ provider: string }, { data: WorkbenchModelContextCapability[] }>()({
    route: "installation", result: z.object({ data: z.array(WorkbenchModelContextCapabilitySchema) }).strict(),
  }),
  "account/limits/read": defineDaemonRequest<{ provider: string }, WorkbenchAccountLimits>()({ route: "installation", result: WorkbenchAccountLimitsSchema }),
  "sandbox-network/read": defineDaemonRequest<{ projectId?: string }, WorkbenchSandboxNetworkSettingsResponse>()({
    route: "installation", result: WorkbenchSandboxNetworkSettingsResponseSchema,
  }),
  "sandbox-network/update": defineDaemonRequest<WorkbenchSandboxNetworkUpdate, WorkbenchSandboxNetworkSettingsResponse>()({
    route: "installation", result: WorkbenchSandboxNetworkSettingsResponseSchema,
  }),
  "provider/account/read": defineDaemonRequest<ProviderAccountRequest, ProviderAccountSnapshot>()({
    route: "installation", result: ProviderAccountSnapshotSchema,
  }),
  "provider/account/sign-in/start": defineDaemonRequest<ProviderSignInStartRequest, ProviderAccountSnapshot>()({
    route: "installation", result: ProviderAccountSnapshotSchema,
  }),
  "provider/account/sign-in/code": defineDaemonRequest<ProviderSignInCodeRequest, ProviderAccountSnapshot>()({
    route: "installation", result: ProviderAccountSnapshotSchema,
  }),
  "provider/account/sign-in/wait": defineDaemonRequest<ProviderSignInAttemptRequest, ProviderAccountSnapshot>()({
    route: "installation", result: ProviderAccountSnapshotSchema,
  }),
  "provider/account/sign-in/cancel": defineDaemonRequest<ProviderSignInAttemptRequest, ProviderAccountSnapshot>()({
    route: "installation", result: ProviderAccountSnapshotSchema,
  }),
  "provider/account/sign-out": defineDaemonRequest<ProviderSignOutRequest, ProviderAccountSnapshot>()({
    route: "installation", result: ProviderAccountSnapshotSchema,
  }),
  "provider/runtime/read": defineDaemonRequest<object, ProviderRuntimesSnapshot>()({ route: "installation", result: ProviderRuntimesSnapshotSchema }),
  "provider/runtime/install": defineDaemonRequest<ProviderRuntimeInstallRequest, ProviderRuntimesSnapshot>()({
    route: "installation", result: ProviderRuntimesSnapshotSchema,
  }),
  "installation/update/pull": defineDaemonRequest<InstallationPullOptions, InstallationPullResult>()({ route: "installation", result: InstallationPullResultSchema }),
  "installation/update/failure/dismiss": defineDaemonRequest<object, { ok: true }>()({ route: "installation", result: ok }),
  "repo/runtime/read": defineDaemonRequest<object, VirtualRepoAvailability>()({ route: "installation", result: VirtualRepoAvailabilitySchema }),
};
