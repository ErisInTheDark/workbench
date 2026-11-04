/*
 * Exports:
 * - WorkbenchAgentContextTarget: canonical thread and its delivery provider.
 * - WorkbenchAgentContextContribution: producer text and admission acknowledgement.
 * - WorkbenchAgentContextSource: input-time context producer.
 * - WorkbenchAgentContextHeld: publishes held for threads whose provider could not place them yet.
 * - WorkbenchAgentContextOptions: source registry, passive transport, warning boundary and handed-over held publishes.
 * - default WorkbenchAgentContextController: publish events, hold undeliverable ones for the next input boundary, and collect context without starting work.
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

/** Published texts no provider could place yet, per thread, in publish order. */
export type WorkbenchAgentContextHeld = ReadonlyMap<WorkbenchThreadId, readonly string[]>;

export interface WorkbenchAgentContextOptions {
  sources: readonly WorkbenchAgentContextSource[];
  /** Conversation-level admission; "unsupported" means the provider cannot place it before the thread's next input. */
  inject(target: WorkbenchAgentContextTarget, text: string, signal: AbortSignal): Promise<WorkbenchContextAdmission>;
  warn(message: string): void;
  held?: WorkbenchAgentContextHeld;
}

export default class WorkbenchAgentContextController {
  readonly #held: Map<WorkbenchThreadId, string[]>;

  constructor(private readonly options: WorkbenchAgentContextOptions) {
    this.#held = new Map([...options.held ?? []].map(([threadId, texts]) => [threadId, [...texts]]));
  }

  /** A publish the provider cannot place now is held for the thread's next input boundary, ahead of source context. */
  async publish(target: WorkbenchAgentContextTarget, text: string, signal = new AbortController().signal): Promise<WorkbenchContextAdmission | "failed"> {
    const admission = await this.deliver(target, text, signal, this.options.inject);
    if (admission === "unsupported" && text.trim()) this.#held.set(target.threadId, [...this.#held.get(target.threadId) ?? [], text]);
    return admission;
  }

  captureHeld(): WorkbenchAgentContextHeld {
    return new Map([...this.#held].map(([threadId, texts]) => [threadId, [...texts]]));
  }

  async collect(
    target: WorkbenchAgentContextTarget,
    trigger: WorkbenchContextTrigger,
    signal: AbortSignal,
    inject = this.options.inject,
  ): Promise<void> {
    signal.throwIfAborted();
    const held = this.#held.get(target.threadId) ?? [];
    while (held.length) {
      if (await this.deliver(target, held[0]!, signal, inject) !== "admitted") break;
      held.shift();
    }
    if (!held.length) this.#held.delete(target.threadId);
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
