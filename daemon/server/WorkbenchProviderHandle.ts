/*
 * Exports:
 * - default WorkbenchProviderHandle: forward each operation through the current definition lease.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import providerRegistrations, { type WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";

export default class WorkbenchProviderHandle implements WorkbenchProvider {
  constructor(
    private readonly key: WorkbenchProviderKey,
    private readonly run: WorkbenchProviderOperation,
  ) {}

  readonly configuration: WorkbenchProvider["configuration"] & {
    sandboxNetwork: NonNullable<WorkbenchProvider["configuration"]["sandboxNetwork"]>;
  } = {
    sandboxNetwork: {
      read: projectId => this.run(providerRegistrations[this.key], provider => (
        provider.configuration.sandboxNetwork?.read(projectId) ?? null
      ), `${this.key}: configuration.sandboxNetwork.read`),
      update: input => this.run(providerRegistrations[this.key], provider => {
        if (!provider.configuration.sandboxNetwork) throw new Error(`Provider ${this.key} does not support sandbox network settings.`);
        return provider.configuration.sandboxNetwork.update(input);
      }, `${this.key}: configuration.sandboxNetwork.update`),
    },
    modelContext: {
      read: () => this.run(
        providerRegistrations[this.key],
        (provider) => provider.configuration.modelContext.read(),
        `${this.key}: configuration.modelContext.read`,
      ),
    },
    models: {
      read: () => this.run(providerRegistrations[this.key], provider => provider.configuration.models.read(), `${this.key}: configuration.models.read`),
    },
    guidance: {
      contains: sections => this.run(providerRegistrations[this.key], provider => provider.configuration.guidance.contains(sections), `${this.key}: configuration.guidance.contains`),
    },
  };

  readonly threads: WorkbenchProvider["threads"] = {
    history: {
      materialize: (threadId, turnId, signal) => this.run(providerRegistrations[this.key], provider => provider.threads.history.materialize(threadId, turnId, signal), `${this.key}: threads.history.materialize`),
      questionnaires: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.history.questionnaires(threadId), `${this.key}: threads.history.questionnaires`),
      steers: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.history.steers(threadId), `${this.key}: threads.history.steers`),
      browse: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.history.browse(threadId), `${this.key}: threads.history.browse`),
    },
    create: input => this.run(providerRegistrations[this.key], provider => provider.threads.create(input), `${this.key}: threads.create`),
    list: input => this.run(providerRegistrations[this.key], provider => provider.threads.list(input), `${this.key}: threads.list`),
    read: (threadId, options) => this.run(providerRegistrations[this.key], provider => provider.threads.read(threadId, options), `${this.key}: threads.read`),
    readLatest: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.readLatest(threadId), `${this.key}: threads.readLatest`),
    latestTurn: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.latestTurn(threadId), `${this.key}: threads.latestTurn`),
    admitTurn: (threadId, turnReference) => this.run(providerRegistrations[this.key], provider => provider.threads.admitTurn(threadId, turnReference), `${this.key}: threads.admitTurn`),
    page: input => this.run(providerRegistrations[this.key], provider => provider.threads.page(input), `${this.key}: threads.page`),
    submit: input => this.run(providerRegistrations[this.key], provider => provider.threads.submit(input), `${this.key}: threads.submit`),
    messageAgent: input => this.run(providerRegistrations[this.key], provider => provider.threads.messageAgent(input), `${this.key}: threads.messageAgent`),
    rename: (threadId, title) => this.run(providerRegistrations[this.key], provider => provider.threads.rename(threadId, title), `${this.key}: threads.rename`),
    compact: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.compact(threadId), `${this.key}: threads.compact`),
    interrupt: (threadId, turnId, options) => this.run(providerRegistrations[this.key], provider => provider.threads.interrupt(threadId, turnId, options), `${this.key}: threads.interrupt`),
    materialize: (threadId, turnIds, signal) => this.run(providerRegistrations[this.key], provider => provider.threads.materialize(threadId, turnIds, signal), `${this.key}: threads.materialize`),
  };

  readonly goals: NonNullable<WorkbenchProvider["goals"]> = {
    read: threadId => this.run(providerRegistrations[this.key], provider => {
      if (!provider.goals) return null;
      return provider.goals.read(threadId);
    }, `${this.key}: goals.read`),
    update: input => this.run(providerRegistrations[this.key], provider => {
      if (!provider.goals) throw new Error(`Provider ${this.key} does not support goals.`);
      return provider.goals.update(input);
    }, `${this.key}: goals.update`),
    clear: threadId => this.run(providerRegistrations[this.key], provider => provider.goals?.clear(threadId), `${this.key}: goals.clear`),
  };

  readonly recovery: NonNullable<WorkbenchProvider["recovery"]> = {
    refresh: threadId => this.run(providerRegistrations[this.key], provider => {
      if (!provider.recovery) throw new Error(`Provider ${this.key} does not support managed refresh.`);
      return provider.recovery.refresh(threadId);
    }, `${this.key}: recovery.refresh`),
  };

  private interaction<T>(operation: (interactions: NonNullable<WorkbenchProvider["interactions"]>) => Promise<T>, label: string) {
    return this.run(providerRegistrations[this.key], provider => {
      if (!provider.interactions) throw new Error(`Provider ${this.key} does not support interactive requests.`);
      return operation(provider.interactions);
    }, `${this.key}: interactions.${label}`);
  }

  readonly interactions: NonNullable<WorkbenchProvider["interactions"]> = {
    interruptRetaining: (input, isCurrent) => this.interaction(owner => owner.interruptRetaining(input, isCurrent), "interruptRetaining"),
    pending: options => this.run(providerRegistrations[this.key], provider => provider.interactions?.pending(options) ?? Promise.resolve([]), `${this.key}: interactions.pending`),
    canDeliver: (threadId, requestKey) => this.interaction(owner => owner.canDeliver(threadId, requestKey), "canDeliver"),
    deliver: input => this.interaction(owner => owner.deliver(input), "deliver"),
    respond: input => this.interaction(owner => owner.respond(input), "respond"),
    supplement: input => this.interaction(owner => owner.supplement(input), "supplement"),
    record: entry => this.interaction(owner => owner.record(entry), "record"),
  };

  readonly account: NonNullable<WorkbenchProvider["account"]> = {
    limits: {
      read: () => this.run(providerRegistrations[this.key], provider => {
        if (!provider.account) throw new Error(`Provider ${this.key} does not report account limits.`);
        return provider.account.limits.read();
      }, `${this.key}: account.limits.read`),
    },
  };

  private tool<T>(operation: (tools: NonNullable<WorkbenchProvider["tools"]>) => Promise<T>, label: string) {
    return this.run(providerRegistrations[this.key], provider => {
      if (!provider.tools) throw new Error(`Provider ${this.key} does not support managed tools.`);
      return operation(provider.tools);
    }, `${this.key}: tools.${label}`);
  }

  readonly tools: NonNullable<WorkbenchProvider["tools"]> = {
    patchClaims: (input, check, signal) => this.tool(tools => tools.patchClaims(input, check, signal), "patchClaims"),
    executeReadOnly: (request, signal) => this.tool(tools => tools.executeReadOnly(request, signal), "executeReadOnly"),
    describe: () => this.tool(tools => tools.describe(), "describe"),
    caller: (metadata, signal) => this.tool(tools => tools.caller(metadata, signal), "caller"),
    shell: (input, metadata, signal) => this.tool(tools => tools.shell(input, metadata, signal), "shell"),
  };

  readonly browse: NonNullable<WorkbenchProvider["browse"]> = {
    record: entry => this.run(providerRegistrations[this.key], provider => {
      if (!provider.browse) throw new Error(`Provider ${this.key} does not support Browse results.`);
      return provider.browse.record(entry);
    }, `${this.key}: browse.record`),
    screenshot: input => this.run(providerRegistrations[this.key], provider => {
      if (!provider.browse) throw new Error(`Provider ${this.key} does not support screenshot delivery.`);
      return provider.browse.screenshot(input);
    }, `${this.key}: browse.screenshot`),
  };
}
