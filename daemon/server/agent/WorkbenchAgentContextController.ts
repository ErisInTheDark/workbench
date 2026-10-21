/*
 * Exports:
 * - WorkbenchAgentContextTarget: canonical thread and its delivery provider.
 * - WorkbenchAgentContextContribution: producer text and admission acknowledgement.
 * - WorkbenchAgentContextSource: input-time context producer.
 * - WorkbenchAgentContextOptions: source registry, passive transport and warning boundary.
 * - default WorkbenchAgentContextController: publish events and collect context without starting work.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchContextAdmission, WorkbenchContextTrigger } from "workbench-shared/workbench/provider/provider-context";

export interface WorkbenchAgentContextTarget {
  harness: WorkbenchProviderKey;
  threadId: WorkbenchThreadId;
}

export interface WorkbenchAgentContextContribution {
  text: string;
  admitted?(): Promise<void> | void;
}

export interface WorkbenchAgentContextSource {
  id: string;
  /** Read producer-owned facts only; the input owner performs admission without re-entering provider queues. */
  collect(target: WorkbenchAgentContextTarget, trigger: WorkbenchContextTrigger, signal: AbortSignal): Promise<readonly WorkbenchAgentContextContribution[]>;
}

export interface WorkbenchAgentContextOptions {
  sources: readonly WorkbenchAgentContextSource[];
  inject(target: WorkbenchAgentContextTarget, text: string, signal: AbortSignal): Promise<WorkbenchContextAdmission>;
  warn(message: string): void;
}

export default class WorkbenchAgentContextController {
  constructor(private readonly options: WorkbenchAgentContextOptions) {}

  async publish(target: WorkbenchAgentContextTarget, text: string, signal = new AbortController().signal): Promise<WorkbenchContextAdmission | "failed"> {
    return this.deliver(target, text, signal, this.options.inject);
  }

  async collect(
    target: WorkbenchAgentContextTarget,
    trigger: WorkbenchContextTrigger,
    signal: AbortSignal,
    inject = this.options.inject,
  ): Promise<void> {
    signal.throwIfAborted();
    for (const source of this.options.sources) {
      const label = source.id.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 80);
      let contributions: readonly WorkbenchAgentContextContribution[];
      try {
        contributions = await source.collect(target, trigger, signal);
      } catch {
        signal.throwIfAborted();
        this.options.warn(`Agent context collection failed (${label}); this source was not acknowledged.`);
        continue;
      }
      signal.throwIfAborted();
      for (const contribution of contributions) {
        if (!contribution.text.trim()) continue;
        const admission = await this.deliver(target, contribution.text, signal, inject);
        if (admission !== "admitted") continue;
        try {
          await contribution.admitted?.();
        } catch {
          // Admission already succeeded. Never resend an event because its producer failed to acknowledge it.
          this.options.warn(`Agent context was admitted, but its producer acknowledgement failed (${label}).`);
        }
        signal.throwIfAborted();
      }
    }
  }

  private async deliver(
    target: WorkbenchAgentContextTarget,
    text: string,
    signal: AbortSignal,
    inject: WorkbenchAgentContextOptions["inject"],
  ): Promise<WorkbenchContextAdmission | "failed"> {
    signal.throwIfAborted();
    if (!text.trim()) return "unsupported";
    try {
      return await inject(target, text, signal);
    } catch {
      signal.throwIfAborted();
      this.options.warn("Agent context admission failed; input acceptance was not undone.");
      return "failed";
    }
  }
}
