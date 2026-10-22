/*
 * Exports:
 * - providerRequestHandlers: daemon handlers for provider models, context capabilities, account limits, account sign-in, sandbox
 *   networking, provider runtime installs and installation updates.
 */
import type { z } from "zod";
import {
  ProviderAccountRequestSchema, ProviderSignInAttemptRequestSchema, ProviderSignInCodeRequestSchema,
  ProviderSignInStartRequestSchema, ProviderSignOutRequestSchema,
} from "workbench-shared/workbench/provider/provider-account-sign-in";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { ProviderRuntimeInstallRequestSchema } from "workbench-shared/workbench/provider/provider-runtime";
import { WorkbenchSandboxNetworkUpdateSchema } from "workbench-shared/workbench/provider/provider-settings";
import { InstallationPullOptionsSchema } from "workbench-shared/workbench/installation-update-prediction";
import { defineDaemonRequestHandlers, InvalidParamsError, requiredString, type DaemonRequestContext } from "./daemon-request-handler";

function provider(params: Record<string, unknown>, { owners }: DaemonRequestContext) {
  const key = installedProviderKeys.find(candidate => candidate === params.provider);
  if (!key || !owners.providers) throw new InvalidParamsError("The requested provider is unavailable.");
  return { key, provider: owners.providers.get(key) };
}

function signIn(params: Record<string, unknown>, context: DaemonRequestContext) {
  const session = provider(params, context).provider.account?.signIn;
  if (!session) throw new InvalidParamsError("The provider has no account sign-in.");
  return session;
}

function parse<T>(schema: z.ZodType<T>, params: Record<string, unknown>) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new InvalidParamsError("Invalid provider sign-in request.");
  return parsed.data;
}

function installationUpdate(context: DaemonRequestContext) {
  const port = context.installationUpdate();
  if (!port) throw new Error("Installation updates are unavailable.");
  return port;
}

export const providerRequestHandlers = defineDaemonRequestHandlers({
  "models/list": async (params, context) => {
    const { key, provider: selected } = provider(params, context);
    const models = await selected.configuration.models.read();
    let used = new Map<string, number>();
    try {
      used = new Map((await context.owners.modelUsage.read(Date.now()))
        .filter(entry => entry.harness === key)
        .map(entry => [entry.modelId, entry.lastUsedAt]));
    } catch {
      console.warn("Unable to read model usage while listing models.");
    }
    return { data: models.map(model => ({
      ...model,
      lastUsedAt: [model.id, ...(model.aliases ?? [])].reduce<number | null>((latest, id) => {
        const time = used.get(id);
        return time === undefined ? latest : Math.max(latest ?? time, time);
      }, null),
    })) };
  },
  "models/context/read": async (params, context) => ({ data: await provider(params, context).provider.configuration.modelContext.read() }),
  "account/limits/read": async (params, context) => {
    const { key, provider: selected } = provider(params, context);
    if (!selected.account) throw new InvalidParamsError("The provider does not report account limits.");
    const limits = await selected.account.limits.read();
    context.owners.stats.observeAccountLimits(key, limits);
    return limits;
  },
  "sandbox-network/read": async (params, { owners }) => {
    const projectId = params.projectId === undefined ? null
      : (await owners.projects.resolveProjectById(requiredString(params, "projectId"))).id;
    if (!owners.providers) throw new Error("Provider settings are unavailable.");
    const providers = owners.providers;
    const settings = await Promise.all(installedProviderKeys.map(async key => {
      const setting = await providers.get(key).configuration.sandboxNetwork?.read(projectId);
      return setting ? { ...setting, provider: key } : null;
    }));
    return { data: settings.filter(setting => setting !== null) };
  },
  "sandbox-network/update": async (params, { owners }) => {
    const parsed = WorkbenchSandboxNetworkUpdateSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid sandbox network setting update.");
    const { provider: requestedProvider, ...input } = parsed.data;
    const projectId = input.projectId === undefined ? null
      : (await owners.projects.resolveProjectById(input.projectId)).id;
    const key = installedProviderKeys.find(candidate => candidate === requestedProvider);
    if (!key) throw new InvalidParamsError("The requested provider is not installed.");
    const capability = owners.providers?.get(key).configuration.sandboxNetwork;
    if (!capability) throw new InvalidParamsError("The requested provider does not expose sandbox network settings.");
    const updated = input.scope === "global"
      ? await capability.update({ scope: "global", enabled: input.enabled, ...(projectId ? { projectId } : {}) })
      : await capability.update({ scope: "project", enabled: input.enabled, projectId: projectId! });
    return { data: [{ ...updated, provider: key }] };
  },
  "provider/account/read": async (params, context) => {
    parse(ProviderAccountRequestSchema, params);
    return await signIn(params, context).read();
  },
  "provider/account/sign-in/start": async (params, context) => {
    const { integrationId, methodId, key } = parse(ProviderSignInStartRequestSchema, params);
    return await signIn(params, context).start({ integrationId, methodId, key });
  },
  "provider/account/sign-in/code": async (params, context) => {
    const { attemptId, code } = parse(ProviderSignInCodeRequestSchema, params);
    return await signIn(params, context).submitCode(attemptId, code);
  },
  "provider/account/sign-in/wait": async (params, context) => (
    await signIn(params, context).wait(parse(ProviderSignInAttemptRequestSchema, params).attemptId)
  ),
  "provider/account/sign-in/cancel": async (params, context) => (
    await signIn(params, context).cancel(parse(ProviderSignInAttemptRequestSchema, params).attemptId)
  ),
  "provider/account/sign-out": async (params, context) => (
    await signIn(params, context).signOut(parse(ProviderSignOutRequestSchema, params).integrationId)
  ),
  "installation/update/pull": async (params, context) => {
    const request = InstallationPullOptionsSchema.safeParse(params);
    if (!request.success) throw new InvalidParamsError("Invalid installation pull request.");
    return await installationUpdate(context).pull(request.data);
  },
  "installation/update/failure/dismiss": async (_params, context) => await installationUpdate(context).dismissFailure(),
  "provider/runtime/read": async (_params, context) => {
    const runtimes = context.providerRuntimes();
    if (!runtimes) throw new Error("Provider runtimes are unavailable.");
    return await runtimes.read();
  },
  "provider/runtime/install": async (params, context) => {
    const parsed = ProviderRuntimeInstallRequestSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("A known provider is required for runtime installs.");
    const runtimes = context.providerRuntimes();
    if (!runtimes) throw new Error("Provider runtimes are unavailable.");
    return await runtimes.install(parsed.data.provider);
  },
});
