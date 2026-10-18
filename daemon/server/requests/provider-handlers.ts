/*
 * Exports:
 * - providerRequestHandlers: daemon handlers for provider models, context capabilities, account limits, sandbox networking, provider runtime
 *   installs and installation updates.
 */
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { ProviderRuntimeInstallRequestSchema } from "workbench-shared/workbench/provider/provider-runtime";
import { WorkbenchSandboxNetworkUpdateSchema } from "workbench-shared/workbench/provider/provider-settings";
import { defineDaemonRequestHandlers, InvalidParamsError, requiredString, type DaemonRequestContext } from "./daemon-request-handler";

function provider(params: Record<string, unknown>, { owners }: DaemonRequestContext) {
  const key = installedProviderKeys.find(candidate => candidate === params.provider);
  if (!key || !owners.providers) throw new InvalidParamsError("The requested provider is unavailable.");
  return { key, provider: owners.providers.get(key) };
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
  "installation/update/pull": async (_params, context) => await installationUpdate(context).pull(),
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
