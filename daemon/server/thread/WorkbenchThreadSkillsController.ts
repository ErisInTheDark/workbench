/*
 * Exports:
 * - WorkbenchThreadSkillsOptions: persistence, skill resolution, agent-context delivery and publication ports.
 * - default WorkbenchThreadSkillsController: own thread active skills and the delivery of their bodies (first send of user activations,
 *   compaction re-send) and deactivation notices at the agent's input boundaries.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchContextAdmission } from "workbench-shared/workbench/provider/provider-context";
import {
  createWorkbenchActivatedSkillsInput,
  createWorkbenchPreviouslyActivatedSkillsText,
  createWorkbenchSkillDeactivatedText,
} from "workbench-shared/workbench/thread/thread-activated-skills";
import type { WorkbenchThreadSkill, WorkbenchThreadSkillSource } from "workbench-shared/workbench/thread/thread-skill-state";
import type {
  WorkbenchAgentContextContribution,
  WorkbenchAgentContextSource,
  WorkbenchAgentContextTarget,
} from "../agent/WorkbenchAgentContextController";
import type { ThreadSkillCommand, ThreadSkillNotice, ThreadSkillState } from "../database/skills/WorkbenchThreadSkillStore";

export interface WorkbenchThreadSkillsOptions {
  store(command: ThreadSkillCommand): Promise<ThreadSkillState>;
  /** The thread's delivery provider; null when the thread has no installed provider. */
  target(threadId: string): Promise<WorkbenchAgentContextTarget | null>;
  /** Canonical path and name of each active skill the paths select in the thread's project. */
  resolve(target: WorkbenchAgentContextTarget, paths: readonly string[]): Promise<readonly { path: string; name: string }[]>;
  /** Filtered skill bodies for the thread's harness and model; null when none still exist. */
  buildCatalog(target: WorkbenchAgentContextTarget, paths: readonly string[]): Promise<string | null>;
  publish(target: WorkbenchAgentContextTarget, text: string): Promise<WorkbenchContextAdmission | "failed">;
  broadcast(target: WorkbenchAgentContextTarget, skills: readonly WorkbenchThreadSkill[]): void;
  warn(message: string): void;
  now?(): number;
}

export default class WorkbenchThreadSkillsController {
  /** Serialises immediate delivery per thread so one pending notice is never published twice. */
  readonly #flushes = new Map<WorkbenchThreadId, Promise<void>>();

  /** Undelivered notices join the agent's next input when immediate delivery was unsupported. */
  readonly contextSource: WorkbenchAgentContextSource = {
    id: "thread-skills",
    collect: async target => this.#contributions(target),
  };

  constructor(private readonly options: WorkbenchThreadSkillsOptions) {}

  async read(threadId: string) {
    const target = await this.#requireTarget(threadId);
    return (await this.options.store({ kind: "read", threadId: target.threadId })).skills;
  }

  async recordActivations(threadId: string, paths: readonly string[], source: WorkbenchThreadSkillSource) {
    if (!paths.length) return;
    const target = await this.options.target(threadId);
    if (!target) return;
    const skills = await this.options.resolve(target, paths);
    if (!skills.length) return;
    // An agent's own activation returned the body as its tool result; a user's is owed at the agent's next input.
    const state = await this.options.store({
      kind: "activate", threadId: target.threadId, at: this.options.now?.() ?? Date.now(),
      skills: skills.map(skill => ({ ...skill, source })), deliver: source === "user",
    });
    this.options.broadcast(target, state.skills);
  }

  async deactivate(threadId: string, path: string) {
    const target = await this.#requireTarget(threadId);
    const state = await this.options.store({ kind: "deactivate", threadId: target.threadId, path });
    this.options.broadcast(target, state.skills);
    await this.#flush(target);
    return state.skills;
  }

  async observeCompaction(threadId: string) {
    const target = await this.options.target(threadId);
    if (!target) return;
    const state = await this.options.store({ kind: "markCompacted", threadId: target.threadId });
    if (state.pending.redeliver.length) await this.#flush(target);
  }

  async #requireTarget(threadId: string) {
    const target = await this.options.target(threadId);
    if (!target) throw new Error("This thread has no installed provider for skills.");
    return target;
  }

  /** The recorded transition already succeeded; a delivery failure only leaves its notice pending. */
  #flush(target: WorkbenchAgentContextTarget) {
    const previous = this.#flushes.get(target.threadId) ?? Promise.resolve();
    const flushed: Promise<void> = previous.then(async () => {
      for (const contribution of await this.#contributions(target)) {
        // Unsupported or failed admission leaves the notice pending for the agent's next input.
        if (await this.options.publish(target, contribution.text) === "admitted") await contribution.admitted?.();
      }
    }).catch((error: unknown) => {
      this.options.warn(`Skill notice delivery failed; it stays pending: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
    }).finally(() => {
      if (this.#flushes.get(target.threadId) === flushed) this.#flushes.delete(target.threadId);
    });
    this.#flushes.set(target.threadId, flushed);
    return flushed;
  }

  async #contributions(target: WorkbenchAgentContextTarget): Promise<WorkbenchAgentContextContribution[]> {
    const { pending } = await this.options.store({ kind: "read", threadId: target.threadId });
    const acknowledge = (notice: ThreadSkillNotice, paths: readonly string[]) => async () => {
      await this.options.store({ kind: "acknowledge", threadId: target.threadId, notice, paths });
    };
    const contributions: WorkbenchAgentContextContribution[] = pending.deactivated.map(skill => ({
      text: createWorkbenchSkillDeactivatedText(skill.name),
      admitted: acknowledge("deactivated", [skill.path]),
    }));
    const bodies = async (notice: "deliver" | "redeliver", skills: readonly WorkbenchThreadSkill[], wrap: (catalog: string) => string) => {
      if (!skills.length) return;
      const paths = skills.map(skill => skill.path);
      const catalog = await this.options.buildCatalog(target, paths);
      // Skills deleted from disk since activation leave nothing to send.
      if (catalog) contributions.push({ text: wrap(catalog), admitted: acknowledge(notice, paths) });
      else await acknowledge(notice, paths)();
    };
    await bodies("deliver", pending.deliver, catalog => createWorkbenchActivatedSkillsInput(catalog).text);
    await bodies("redeliver", pending.redeliver, createWorkbenchPreviouslyActivatedSkillsText);
    return contributions;
  }
}
