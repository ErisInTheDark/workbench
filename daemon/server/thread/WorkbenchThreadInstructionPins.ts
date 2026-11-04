/*
 * Exports:
 * - WorkbenchInstructionPin: what one instruction build delivered: base layers with the prefix fingerprint, or activated skills' layers.
 * - WorkbenchThreadInstructionPinsPorts: storage, a content fingerprint of the tools a prefix's audience is served, and a rebuild of a stored prefix.
 * - PinnedInstructions: one thread's validated pins; skills keyed by comparable path.
 * - PinnedSkills: a thread's frozen skill list, what the agent was last told, and whether compaction asked for a refreeze.
 * - comparableSkillPath: the key a skill's pinned layer is stored and found under.
 * - default WorkbenchThreadInstructionPins: own what instructions each thread was last given, what it was told about skills since, and
 *   whether its next prefix would differ.
 */
import path from "node:path";
import { z } from "zod";
import type {
  StoredThreadInstructionOverlays, ThreadInstructionOverlayCommand,
} from "../database/thread-state/WorkbenchThreadInstructionOverlayStore";
import type { WorkbenchSkillCatalogEntry } from "../lib/workbench-library";
import {
  WorkbenchInstructionOverlaysSchema, type WorkbenchInstructionOverlays,
} from "../lib/workbench/instructions/instruction-overlay-catalogue";
import {
  WorkbenchInstructionPrefixContextSchema, type WorkbenchInstructionPrefix, type WorkbenchInstructionPrefixContext, type WorkbenchSkillLayer,
} from "../lib/workbench/instructions/WorkbenchPromptFiles";

export type WorkbenchInstructionPin =
  | { base: readonly WorkbenchInstructionOverlays[]; prefix: WorkbenchInstructionPrefix | null }
  | { skills: readonly WorkbenchSkillLayer[] };

export interface WorkbenchThreadInstructionPinsPorts {
  execute(command: ThreadInstructionOverlayCommand): Promise<StoredThreadInstructionOverlays | null>;
  /** Hash of the tool specs this input's audience is served now; tools are part of every provider's prefix. */
  readToolFingerprint(context: WorkbenchInstructionPrefixContext): Promise<string>;
  /** The hash a build from this input would deliver now. */
  rebuildPrefixHash(context: WorkbenchInstructionPrefixContext): Promise<string>;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface PinnedInstructions {
  base: WorkbenchInstructionOverlays[] | null;
  skills: ReadonlyMap<string, WorkbenchInstructionOverlays>;
}

/** A thread's skill list as its prefix froze it, and as the agent was last told it. */
export interface PinnedSkills {
  frozen: readonly WorkbenchSkillCatalogEntry[];
  known: readonly WorkbenchSkillCatalogEntry[];
  /** Compaction asked the next build to freeze the list again. */
  refreeze: boolean;
}

const SkillEntriesSchema = WorkbenchInstructionPrefixContextSchema.shape.skills.unwrap();

/**
 * Absent toolHash: tools were unreadable at pin time, or the pin predates fingerprints; only instructions are compared.
 * Absent knownSkills: the agent knows exactly the frozen list.
 */
const StoredPrefixSchema = z.object({
  hash: z.string().min(1),
  toolHash: z.string().min(1).optional(),
  context: WorkbenchInstructionPrefixContextSchema,
  knownSkills: SkillEntriesSchema.optional(),
  refreezeSkills: z.boolean().optional(),
});
const PinnedBaseSchema = WorkbenchInstructionOverlaysSchema.array();

export function comparableSkillPath(value: string) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

export default class WorkbenchThreadInstructionPins {
  /** Threads whose current pinned prefix was found stale; a new base pin is a new prefix, so it forgets. */
  readonly #stale = new Set<string>();

  constructor(private readonly ports: WorkbenchThreadInstructionPinsPorts) {}

  /** Builders report what they delivered; a failed pin only leaves this thread on current files, so it never fails the build. */
  async pin(threadId: string, pin: WorkbenchInstructionPin) {
    const at = (this.ports.now ?? Date.now)();
    try {
      if ("base" in pin) {
        this.#stale.delete(threadId);
        await this.ports.execute({
          kind: "pinBase", threadId, layers: pin.base, at,
          prefix: pin.prefix ? { ...pin.prefix, toolHash: await this.#readToolHash(threadId, pin.prefix.context) } : null,
        });
      } else {
        await this.ports.execute({
          kind: "pinSkills", threadId, at,
          skills: Object.fromEntries(pin.skills.map(skill => [comparableSkillPath(skill.path), skill.layer])),
        });
      }
    } catch (error) {
      this.#warn(`Instruction pin failed for ${threadId}`, error);
    }
  }

  /** Pieces stored in a shape this daemon no longer reads come back absent, so callers fall back to current files. */
  async read(threadId: string): Promise<PinnedInstructions> {
    const stored = await this.ports.execute({ kind: "read", threadId });
    const base = PinnedBaseSchema.safeParse(stored?.base);
    const skills = new Map<string, WorkbenchInstructionOverlays>();
    for (const [key, value] of Object.entries(stored?.skills ?? {})) {
      const layer = WorkbenchInstructionOverlaysSchema.safeParse(value);
      if (layer.success) skills.set(key, layer.data);
    }
    return { base: base.success ? base.data : null, skills };
  }

  /** Null when the thread has no prefix that froze a skill list, or it cannot be read; such threads list current skills. */
  async readSkills(threadId: string): Promise<PinnedSkills | null> {
    try {
      const stored = StoredPrefixSchema.safeParse((await this.ports.execute({ kind: "read", threadId }))?.prefix);
      const frozen = stored.success ? stored.data.context.skills : undefined;
      if (!stored.success || !frozen) return null;
      return { frozen, known: stored.data.knownSkills ?? frozen, refreeze: stored.data.refreezeSkills ?? false };
    } catch (error) {
      this.#warn(`Pinned skills unreadable for ${threadId}`, error);
      return null;
    }
  }

  async noteSkills(threadId: string, skills: readonly WorkbenchSkillCatalogEntry[]) {
    await this.ports.execute({ kind: "noteSkills", threadId, skills, at: (this.ports.now ?? Date.now)() });
  }

  /** The agent's context no longer holds earlier skill notices, so its next build lists current skills. */
  async refreezeSkills(threadId: string) {
    await this.ports.execute({ kind: "refreezeSkills", threadId, at: (this.ports.now ?? Date.now)() });
  }

  /** Remembered from the last exact check of the current pin; never rebuilds. */
  knownPrefixStale(threadId: string) {
    return this.#stale.has(threadId);
  }

  /**
   * Exact: the stored input's audience is now served different tool specs, or rebuilding it hashes differently. Threads never
   * pinned, and failed reads, count as fresh, so nothing compacts on a guess.
   */
  async prefixStale(threadId: string) {
    if (this.#stale.has(threadId)) return true;
    const stored = StoredPrefixSchema.safeParse((await this.ports.execute({ kind: "read", threadId }))?.prefix);
    if (!stored.success) return false;
    const { context, hash, toolHash } = stored.data;
    let stale: boolean;
    try {
      stale = (toolHash !== undefined && await this.ports.readToolFingerprint(context) !== toolHash)
        || await this.ports.rebuildPrefixHash(context) !== hash;
    } catch (error) {
      this.#warn(`Prefix staleness check failed for ${threadId}`, error);
      return false;
    }
    if (stale) this.#stale.add(threadId);
    return stale;
  }

  async #readToolHash(threadId: string, context: WorkbenchInstructionPrefixContext) {
    try {
      return await this.ports.readToolFingerprint(context);
    } catch (error) {
      this.#warn(`Tool fingerprint failed for ${threadId}`, error);
      return undefined;
    }
  }

  #warn(what: string, error: unknown) {
    const message = `[thread-instructions] ${what}: ${error instanceof Error ? error.message : String(error)}`;
    (this.ports.warn ?? console.warn)(message.slice(0, 500));
  }
}
