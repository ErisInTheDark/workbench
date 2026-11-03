/*
 * Exports:
 * - WorkbenchInstructionPin: what one instruction build delivered: base layers with the prefix fingerprint, or activated skills' layers.
 * - WorkbenchThreadInstructionPinsPorts: storage, the live tool catalogue revision, and a rebuild of a stored prefix.
 * - PinnedInstructions: one thread's validated pins; skills keyed by comparable path.
 * - comparableSkillPath: the key a skill's pinned layer is stored and found under.
 * - default WorkbenchThreadInstructionPins: own what instructions each thread was last given, and whether its next prefix would differ.
 */
import path from "node:path";
import { z } from "zod";
import type {
  StoredThreadInstructionOverlays, ThreadInstructionOverlayCommand,
} from "../database/thread-state/WorkbenchThreadInstructionOverlayStore";
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
  /** Changes whenever the shared tool catalogue does; tools are part of every provider's prefix. */
  readToolRevision(): string;
  /** The hash a build from this input would deliver now. */
  rebuildPrefixHash(context: WorkbenchInstructionPrefixContext): Promise<string>;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface PinnedInstructions {
  base: WorkbenchInstructionOverlays[] | null;
  skills: ReadonlyMap<string, WorkbenchInstructionOverlays>;
}

const StoredPrefixSchema = z.object({
  hash: z.string().min(1),
  toolRevision: z.string(),
  context: WorkbenchInstructionPrefixContextSchema,
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
          prefix: pin.prefix ? { ...pin.prefix, toolRevision: this.ports.readToolRevision() } : null,
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

  /** Remembered from the last exact check of the current pin; never rebuilds. */
  knownPrefixStale(threadId: string) {
    return this.#stale.has(threadId);
  }

  /**
   * Exact: the tool catalogue moved, or rebuilding from the stored input now hashes differently. Threads never pinned, and
   * failed rebuilds, count as fresh, so nothing compacts on a guess.
   */
  async prefixStale(threadId: string) {
    if (this.#stale.has(threadId)) return true;
    const stored = StoredPrefixSchema.safeParse((await this.ports.execute({ kind: "read", threadId }))?.prefix);
    if (!stored.success) return false;
    let stale = stored.data.toolRevision !== this.ports.readToolRevision();
    if (!stale) {
      try {
        stale = await this.ports.rebuildPrefixHash(stored.data.context) !== stored.data.hash;
      } catch (error) {
        this.#warn(`Prefix rebuild failed for ${threadId}`, error);
        return false;
      }
    }
    if (stale) this.#stale.add(threadId);
    return stale;
  }

  #warn(what: string, error: unknown) {
    const message = `[thread-instructions] ${what}: ${error instanceof Error ? error.message : String(error)}`;
    (this.ports.warn ?? console.warn)(message.slice(0, 500));
  }
}
