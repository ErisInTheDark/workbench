/*
 * Exports:
 * - SkillMcpMemoryCall: one loaded call in transcript order, with the item that identifies it.
 * - default SkillMcpMemoryMatchers: a thread's matchers with memory: folds what each skill's matchers `remember` over the
 *   loaded calls in transcript order, so each call reads what earlier calls remembered; a refold reruns a later call only
 *   when the memory its skill gave it changed, and stops cascading once a rerun remembers the same again.
 */
import {
  SKILL_MCP_MATCHER_LIMITS, type SkillMcpCall, type SkillMcpMemory,
} from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import type { SkillMcpMatch, SkillMcpMatchers, SkillMcpMatchOptions } from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";

export interface SkillMcpMemoryCall {
  identity: object;
  call: SkillMcpCall;
}

type Memory = ReadonlyMap<string, SkillMcpMemory>;

interface Folded {
  /** What each skill remembered before this call. */
  before: Memory;
  after: Memory;
  match: SkillMcpMatch | null;
}

const NO_MEMORY: Memory = new Map();

/** Last write wins and moves its key to the end, so the cap drops the facts written longest ago. */
function remembered(previous: SkillMcpMemory | undefined, writes: Readonly<Record<string, JsonValue>>): SkillMcpMemory {
  const next: Record<string, JsonValue> = { ...previous };
  for (const [key, value] of Object.entries(writes)) {
    delete next[key];
    next[key] = value;
  }
  let size = JSON.stringify(next).length;
  for (const key of Object.keys(next)) {
    if (size <= SKILL_MCP_MATCHER_LIMITS.memoryChars) break;
    size -= JSON.stringify(key).length + JSON.stringify(next[key]).length + 2;
    delete next[key];
  }
  return next;
}

function hashString(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return (hash >>> 0).toString(36);
}

export default class SkillMcpMemoryMatchers implements SkillMcpMatchers {
  readonly key: string;
  readonly #base: SkillMcpMatchers;
  readonly #byIdentity = new WeakMap<object, Folded>();
  readonly #memory: Memory;

  /** `previous` lends its answers for calls whose skill memory is unchanged; it must fold over the same base. */
  constructor(base: SkillMcpMatchers, calls: readonly SkillMcpMemoryCall[], previous: SkillMcpMemoryMatchers | null = null) {
    this.#base = base;
    const prior = previous && previous.#base === base ? previous.#byIdentity : null;
    let memory = NO_MEMORY;
    for (const { identity, call } of calls) {
      const old = prior?.get(identity);
      const unchanged = old && (old.match
        ? old.before.get(old.match.skillPath) === memory.get(old.match.skillPath)
        : [...new Set([...old.before.keys(), ...memory.keys()])].every(skill => old.before.get(skill) === memory.get(skill)));
      const match = unchanged ? old.match : base.match(call, { memory });
      const before = memory;
      const writes = match?.presentation.remember;
      if (match && writes && Object.keys(writes).length) {
        let skillMemory = remembered(memory.get(match.skillPath), writes);
        // Remembering the same as last time keeps the old object, so calls after it need not rerun.
        const oldMemory = old?.after.get(match.skillPath);
        if (oldMemory && JSON.stringify(oldMemory) === JSON.stringify(skillMemory)) skillMemory = oldMemory;
        if (skillMemory !== memory.get(match.skillPath)) memory = new Map(memory).set(match.skillPath, skillMemory);
      }
      this.#byIdentity.set(identity, { before, after: memory, match });
    }
    this.#memory = memory;
    this.key = `${base.key}#memory:${memory.size ? hashString(JSON.stringify([...memory])) : "none"}`;
  }

  /** Loaded calls answer from the fold; anything else (a call known only by its command text) reads the latest memory. */
  match(call: SkillMcpCall, { identity }: SkillMcpMatchOptions = {}): SkillMcpMatch | null {
    const folded = identity ? this.#byIdentity.get(identity) : undefined;
    if (folded) return folded.match;
    return this.#base.match(call, { memory: this.#memory, identity });
  }
}
