/*
 * Exports:
 * - default WorkbenchCoreThreadLookup: resolve a thread reference to its canonical identity, saved entry, installed harness and provider for core owners.
 */
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { DaemonRuntimeObjects } from "../daemon-runtime-objects";
import type WorkbenchProviderDispatcher from "../WorkbenchProviderDispatcher";
import type WorkbenchThreadStateFeature from "../WorkbenchThreadStateFeature";

export default class WorkbenchCoreThreadLookup {
  constructor(private readonly ports: {
    identities: DaemonRuntimeObjects["threadIdentity"];
    /** Both are built after the owners that use this lookup, so they are read at call time. */
    providers: () => WorkbenchProviderDispatcher;
    threadState: () => WorkbenchThreadStateFeature | null;
  }) {}

  identity(threadId: string) {
    return this.ports.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
  }

  /** The thread's saved entry; null when the thread is unknown or thread state is not built yet. */
  async entry(threadId: string) {
    const identity = await this.identity(threadId);
    const state = this.ports.threadState();
    const entry = identity && state ? await state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId) : null;
    return entry && entry.entryKind !== "draft" ? entry : null;
  }

  /** The thread's first binding, when its provider is installed here. */
  async harness(threadId: string) {
    const harness = (await this.identity(threadId))?.bindings[0]?.harness;
    return installedProviderKeys.find(key => key === harness) ?? null;
  }

  provider(harness: string) {
    const key = installedProviderKeys.find(candidate => candidate === harness);
    if (!key) throw new Error(`Provider ${harness} is unavailable.`);
    return this.ports.providers().get(key);
  }

  requireThreadState() {
    const state = this.ports.threadState();
    if (!state) throw new Error("Thread state is not ready for subagent lifecycle projection.");
    return state;
  }
}
