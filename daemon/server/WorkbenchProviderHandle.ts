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

  readonly configuration: WorkbenchProvider["configuration"] = {
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
      questionnaires: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.history.questionnaires(threadId), `${this.key}: threads.history.questionnaires`),
      steers: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.history.steers(threadId), `${this.key}: threads.history.steers`),
      browse: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.history.browse(threadId), `${this.key}: threads.history.browse`),
    },
    create: input => this.run(providerRegistrations[this.key], provider => provider.threads.create(input), `${this.key}: threads.create`),
    list: input => this.run(providerRegistrations[this.key], provider => provider.threads.list(input), `${this.key}: threads.list`),
    read: (threadId, options) => this.run(providerRegistrations[this.key], provider => provider.threads.read(threadId, options), `${this.key}: threads.read`),
    latestTurn: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.latestTurn(threadId), `${this.key}: threads.latestTurn`),
    admitTurn: (threadId, turnReference) => this.run(providerRegistrations[this.key], provider => provider.threads.admitTurn(threadId, turnReference), `${this.key}: threads.admitTurn`),
    page: input => this.run(providerRegistrations[this.key], provider => provider.threads.page(input), `${this.key}: threads.page`),
    submit: input => this.run(providerRegistrations[this.key], provider => provider.threads.submit(input), `${this.key}: threads.submit`),
    rename: (threadId, title) => this.run(providerRegistrations[this.key], provider => provider.threads.rename(threadId, title), `${this.key}: threads.rename`),
    compact: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.compact(threadId), `${this.key}: threads.compact`),
    interrupt: (threadId, turnId) => this.run(providerRegistrations[this.key], provider => provider.threads.interrupt(threadId, turnId), `${this.key}: threads.interrupt`),
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

  private interaction<T>(operation: (interactions: NonNullable<WorkbenchProvider["interactions"]>) => Promise<T>, label: string) {
    return this.run(providerRegistrations[this.key], provider => {
      if (!provider.interactions) throw new Error(`Provider ${this.key} does not support interactive requests.`);
      return operation(provider.interactions);
    }, `${this.key}: interactions.${label}`);
  }

  readonly interactions: NonNullable<WorkbenchProvider["interactions"]> = {
    interruptRetaining: (input, isCurrent) => this.interaction(owner => owner.interruptRetaining(input, isCurrent), "interruptRetaining"),
    pending: () => this.run(providerRegistrations[this.key], provider => provider.interactions?.pending() ?? Promise.resolve([]), `${this.key}: interactions.pending`),
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
}
