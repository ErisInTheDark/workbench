/*
 * Exports:
 * - default ProviderCompactionCompletionController: await native compaction success and execution settlement.
 */
import type { WorkbenchProviderCompactionScope } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";

type ProviderCompactionExecution = WorkbenchProviderCompactionScope & { threadId: WorkbenchThreadId };

export default class ProviderCompactionCompletionController {
  private readonly pending = new Map<string, {
    reference: string | null;
    scope: ProviderCompactionExecution;
    completed: boolean;
    completion: ReturnType<typeof Promise.withResolvers<void>>;
  }>();
  hasPendingWork() { return this.pending.size > 0; }

  currentScope(key: string) {
    return this.pending.get(key)?.scope ?? null;
  }

  async run(
    key: string,
    scope: ProviderCompactionExecution,
    signal: AbortSignal,
    request: () => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.pending.has(key)) throw new Error("This thread already has a compaction completion wait.");
    const entry = {
      reference: null as string | null,
      scope,
      completed: false,
      completion: Promise.withResolvers<void>(),
    };
    this.pending.set(key, entry);
    const abort = () => entry.completion.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.all([entry.completion.promise, request()]);
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.pending.get(key) === entry) this.pending.delete(key);
    }
  }

  started(key: string, reference: string) {
    const entry = this.pending.get(key);
    if (entry && entry.reference === null) entry.reference = reference;
    return entry?.reference === reference ? entry.scope : null;
  }

  scope(key: string, reference: string) {
    return this.match(key, reference)?.scope ?? null;
  }

  completed(key: string, reference?: string) {
    const entry = this.match(key, reference);
    if (entry) entry.completed = true;
  }

  settled(key: string, reference?: string) {
    const entry = this.match(key, reference);
    if (!entry) return;
    if (entry.completed) entry.completion.resolve();
    else entry.completion.reject(new Error("Native execution ended without successful compaction."));
  }

  failed(key: string, error: Error, reference?: string) {
    const entry = reference === undefined ? this.pending.get(key) : this.match(key, reference);
    entry?.completion.reject(error);
  }

  private match(key: string, reference?: string) {
    const entry = this.pending.get(key);
    return entry && entry.reference !== null && (reference === undefined || entry.reference === reference) ? entry : null;
  }
}
