/*
 * Exports:
 * - WorkbenchThreadSkillsOptions: persistence, skill resolution, skill list pins, agent-context delivery and publication ports.
 * - default WorkbenchThreadSkillsController: own thread active skills and what the agent is told about skills at its input boundaries:
 *   active bodies (first send of user activations, compaction re-send), deactivation notices, and changes to the skill list its
 *   prefix froze (refrozen at the next build after compaction).
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchContextAdmission } from "workbench-shared/workbench/provider/provider-context";
import {
  createWorkbenchActivatedSkillsInput,
  createWorkbenchPreviouslyActivatedSkillsText,
  createWorkbenchSkillDeactivatedText,
  createWorkbenchSkillsChangedText,
} from "workbench-shared/workbench/thread/thread-activated-skills";
import { formatWorkbenchSkillCatalogEntry, type WorkbenchSkillCatalogEntry } from "../lib/workbench-library";
import type { PinnedSkills } from "./WorkbenchThreadInstructionPins";
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
  /** Admits now or reports why not; pending notices stay this controller's to resend. */
  publish(target: WorkbenchAgentContextTarget, text: string): Promise<WorkbenchContextAdmission | "failed">;
  broadcast(target: WorkbenchAgentContextTarget, skills: readonly WorkbenchThreadSkill[]): void;
  /** The skill list the thread's prefix froze and what the agent was told since; null before any prefix froze one. */
  readSkillList(target: WorkbenchAgentContextTarget): Promise<PinnedSkills | null>;
  /** The thread's project skill list now. */
  listSkills(target: WorkbenchAgentContextTarget): Promise<readonly WorkbenchSkillCatalogEntry[]>;
  noteSkills(target: WorkbenchAgentContextTarget, skills: readonly WorkbenchSkillCatalogEntry[]): Promise<void>;
  refreezeSkills(target: WorkbenchAgentContextTarget): Promise<void>;
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

  /**
   * Compaction drops earlier skill notices, so the next build lists current skills and active bodies are re-sent. Native compaction can
   * land mid-turn, where no build follows, so a live agent is told at once.
   */
  async observeCompaction(threadId: string) {
    const target = await this.options.target(threadId);
    if (!target) return;
    await this.options.refreezeSkills(target);
    await this.options.store({ kind: "markCompacted", threadId: target.threadId });
    await this.#flush(target);
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
    const state = await this.options.store({ kind: "read", threadId: target.threadId });
    const { pending } = state;
    const acknowledge = (notice: ThreadSkillNotice, paths: readonly string[]) => async () => {
      await this.options.store({ kind: "acknowledge", threadId: target.threadId, notice, paths });
    };
    const listChange = await this.#listChange(target, state);
    const contributions: WorkbenchAgentContextContribution[] = [
      ...listChange ? [listChange] : [],
      ...pending.deactivated.map(skill => ({
        text: createWorkbenchSkillDeactivatedText(skill.name),
        admitted: acknowledge("deactivated", [skill.path]),
      })),
    ];
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

  /**
   * What changed in the skill list since the agent was last told: catalog lines for inactive skills, fresh bodies for active ones.
   * An inactive skill's body is never shown in the list, and a body already owed is on its way, so such changes are noted silently.
   */
  async #listChange(target: WorkbenchAgentContextTarget, state: ThreadSkillState): Promise<WorkbenchAgentContextContribution | null> {
    const told = await this.options.readSkillList(target);
    if (!told) return null;
    const live = await this.options.listSkills(target);
    const known = new Map(told.known.map(entry => [entry.name, entry]));
    const same = (left: WorkbenchSkillCatalogEntry, right?: WorkbenchSkillCatalogEntry) =>
      right !== undefined && left.trigger === right.trigger && left.digest === right.digest;
    if (live.length === known.size && live.every(entry => same(entry, known.get(entry.name)))) return null;
    const note = async () => { await this.options.noteSkills(target, live); };
    const active = new Map(state.skills.map(skill => [skill.name, skill.path]));
    const owed = new Set([...state.pending.deliver, ...state.pending.redeliver].map(skill => skill.name));
    const lines: string[] = [];
    const bodyPaths: string[] = [];
    for (const entry of live) {
      const before = known.get(entry.name);
      if (same(entry, before)) continue;
      const activePath = active.get(entry.name);
      if (activePath !== undefined) {
        if (!owed.has(entry.name)) bodyPaths.push(activePath);
      } else if (before?.trigger !== entry.trigger) {
        lines.push(formatWorkbenchSkillCatalogEntry(entry));
      }
    }
    const liveNames = new Set(live.map(entry => entry.name));
    const removed = told.known.filter(entry => !liveNames.has(entry.name)).map(entry => entry.name);
    const bodies = bodyPaths.length ? await this.options.buildCatalog(target, bodyPaths) : null;
    const changed = [...lines, ...bodies ? [bodies] : []].join("\n");
    if (!changed && !removed.length) {
      await note();
      return null;
    }
    return { text: createWorkbenchSkillsChangedText(changed || null, removed), admitted: note };
  }
}
