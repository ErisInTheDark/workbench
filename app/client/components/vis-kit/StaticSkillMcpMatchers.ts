/*
 * Exports:
 * - SkillMcpMatcherFunction: a skill matcher file's default export, as `defineMcpMatcher` returns it.
 * - default StaticSkillMcpMatchers: run matcher functions directly inside a sandboxed vis page, held to the same
 *   presentation contract as the QuickJS runtime; failures are kept for the page to show. Never used in the app realm.
 */
import type { SkillMcpCall } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import {
  readSkillMcpPresentation, serializeSkillMcpCall, type SkillMcpMatch, type SkillMcpMatchers, type SkillMcpMatchOptions,
} from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";

export type SkillMcpMatcherFunction = (call: SkillMcpCall) => unknown;

const PREVIEW_SKILL = { skillName: "preview", skillPath: "vis-preview" };
let instances = 0;

export default class StaticSkillMcpMatchers implements SkillMcpMatchers {
  readonly key = `vis-preview:${++instances}`;
  readonly #matchers: readonly SkillMcpMatcherFunction[];
  #failures: readonly string[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(matchers: readonly SkillMcpMatcherFunction[]) {
    this.#matchers = matchers;
  }

  /** The first matcher presenting the call, as the runtime answers: calls arrive as plain JSON with their memory, answers must serialize. */
  match(call: SkillMcpCall, { memory }: SkillMcpMatchOptions = {}): SkillMcpMatch | null {
    const input = serializeSkillMcpCall(call)(memory?.get(PREVIEW_SKILL.skillPath));
    for (const [index, matcher] of this.#matchers.entries()) {
      let serialized: string | undefined;
      try { serialized = JSON.stringify(matcher(JSON.parse(input) as SkillMcpCall)) ?? undefined; }
      catch (error) {
        this.#fail(`Matcher ${index + 1} threw: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (serialized === undefined || serialized === "null") continue;
      const outcome = readSkillMcpPresentation(serialized);
      if (outcome.kind === "failed") { this.#fail(`Matcher ${index + 1}: ${outcome.message}`); continue; }
      return { ...PREVIEW_SKILL, presentation: outcome.presentation };
    }
    return null;
  }

  get failures() { return this.#failures; }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  /** Matching runs while the transcript renders, so listeners hear about new failures after it. */
  #fail(message: string) {
    if (this.#failures.includes(message)) return;
    this.#failures = [...this.#failures, message];
    queueMicrotask(() => { for (const listener of this.#listeners) listener(); });
  }
}
