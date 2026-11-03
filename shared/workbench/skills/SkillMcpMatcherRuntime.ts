/*
 * Exports:
 * - SkillMcpMatch: the first skill presentation for one call.
 * - SkillMcpMatchFailure: why one skill's matcher could not answer.
 * - SkillMcpMatchReport: every skill's outcome for one call, for authoring tools.
 * - SkillMcpMatchOptions: each skill's memory and the call's item for one match.
 * - SkillMcpMatchers: what presenting calls needs from a thread's matchers, however they run.
 * - serializeSkillMcpCall: a call serialised once, then given each skill's own memory.
 * - readSkillMcpPresentation: hold a matcher's serialized answer to the presentation contract.
 * - default SkillMcpMatcherRuntime: run active skills' compiled MCP matchers synchronously inside QuickJS, each skill in
 *   its own runtime with a memory cap and a deadline on matcher code, apart from loading the call; the QuickJS module
 *   is injected by its platform loader.
 */
import { shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { z } from "zod";
import { describeQuickJSError, isQuickJSRunaway } from "./quickjs-error";
import {
  SKILL_MCP_MATCHER_LIMITS, SkillMcpPresentationSchema,
  type SkillMcpCall, type SkillMcpMatcherBundle, type SkillMcpMemory, type SkillMcpPresentation,
} from "./skill-mcp-matcher-contract";

export interface SkillMcpMatch {
  skillName: string;
  skillPath: string;
  presentation: SkillMcpPresentation;
}

export interface SkillMcpMatchFailure {
  skillName: string;
  skillPath: string;
  message: string;
}

export interface SkillMcpMatchReport {
  match: SkillMcpMatch | null;
  failures: SkillMcpMatchFailure[];
}

export interface SkillMcpMatchOptions {
  /** Each skill's memory by skill path; a skill without one reads an empty memory. */
  memory?: ReadonlyMap<string, SkillMcpMemory>;
  /** The call's item, for matchers that know calls by where they sit in a transcript. */
  identity?: object;
}

/** What presenting MCP calls needs from a thread's matchers: an identity for caching, and the first match for a call. */
export interface SkillMcpMatchers {
  /** Changes exactly when the matchers (or what they remember) do. */
  readonly key: string;
  match(call: SkillMcpCall, options?: SkillMcpMatchOptions): SkillMcpMatch | null;
}

const EMPTY_MEMORY: SkillMcpMemory = {};

/** The call as one skill's matchers read it, with that skill's memory; serialised once and extended per skill. */
export function serializeSkillMcpCall(call: SkillMcpCall) {
  const json = JSON.stringify(call);
  return (memory: SkillMcpMemory | undefined) => `${json.slice(0, -1)},"memory":${JSON.stringify(memory ?? EMPTY_MEMORY)}}`;
}

/**
 * Bundles assign their matchers here. The prelude splits a run in two, so loading the call (our parse of a possibly
 * large result) is timed apart from the matcher code the call deadline is for.
 */
const PRELUDE = `
;(() => {
  const exported = typeof __wbSkillMcpMatchers === "object" && __wbSkillMcpMatchers ? __wbSkillMcpMatchers.default : undefined;
  const matchers = Array.isArray(exported) ? exported : [exported];
  if (!matchers.length || matchers.some(matcher => typeof matcher !== "function")) {
    throw new Error("Each matcher file must default-export defineMcpMatcher(call => ...).");
  }
  let loaded;
  globalThis.__wbLoad = input => { loaded = JSON.parse(input); };
  globalThis.__wbMatch = () => {
    const call = loaded;
    loaded = undefined;
    for (const matcher of matchers) {
      const presentation = matcher(call);
      if (presentation !== null && presentation !== undefined) return JSON.stringify(presentation);
    }
    return null;
  };
})();`;

/** Runaway matchers (deadline, memory) stop answering for the runtime's life; ordinary throws fail only their call. */
type BundleState =
  | { kind: "unloaded" }
  | { kind: "ready"; runtime: QuickJSRuntime; context: QuickJSContext; load: QuickJSHandle; match: QuickJSHandle }
  | { kind: "broken"; message: string };

export default class SkillMcpMatcherRuntime implements SkillMcpMatchers {
  readonly key: string;
  readonly #module: QuickJSWASMModule;
  readonly #bundles: readonly SkillMcpMatcherBundle[];
  readonly #states: BundleState[];
  readonly #onFailure: ((failure: SkillMcpMatchFailure) => void) | undefined;
  readonly #reported = new Set<string>();
  #disposed = false;

  constructor(module: QuickJSWASMModule, bundles: readonly SkillMcpMatcherBundle[], options: {
    /** Called once per skill and message, so a broken matcher does not flood its reporter. */
    onFailure?(failure: SkillMcpMatchFailure): void;
  } = {}) {
    this.#module = module;
    this.#bundles = bundles;
    this.#states = bundles.map(() => ({ kind: "unloaded" }));
    this.#onFailure = options.onFailure;
    this.key = SkillMcpMatcherRuntime.keyOf(bundles);
  }

  /** The key a runtime over these bundles would have, so callers can keep an equivalent runtime. */
  static keyOf(bundles: readonly SkillMcpMatcherBundle[]) {
    return bundles.map(bundle => `${bundle.skillPath}@${bundle.revision}`).join("|");
  }

  get size() { return this.#bundles.length; }

  /** The first active skill presenting this call, or null when none does or every matcher failed. */
  match(call: SkillMcpCall, options: SkillMcpMatchOptions = {}): SkillMcpMatch | null {
    return this.report(call, options).match;
  }

  /** Every skill's outcome up to the first match; a disposed runtime (replaced while a render still held it) presents nothing. */
  report(call: SkillMcpCall, { memory }: SkillMcpMatchOptions = {}): SkillMcpMatchReport {
    if (this.#disposed) return { failures: [], match: null };
    const input = serializeSkillMcpCall(call);
    const failures: SkillMcpMatchFailure[] = [];
    for (const [index, bundle] of this.#bundles.entries()) {
      const outcome = this.#run(index, input(memory?.get(bundle.skillPath)));
      if (outcome.kind === "none") continue;
      if (outcome.kind === "failed") {
        const failure = { skillName: bundle.skillName, skillPath: bundle.skillPath, message: outcome.message };
        failures.push(failure);
        this.#report(failure);
        continue;
      }
      return { failures, match: { skillName: bundle.skillName, skillPath: bundle.skillPath, presentation: outcome.presentation } };
    }
    return { failures, match: null };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const state of this.#states) {
      if (state.kind !== "ready") continue;
      SkillMcpMatcherRuntime.#release(state);
    }
  }

  static #release(state: Extract<BundleState, { kind: "ready" }>) {
    state.load.dispose(); state.match.dispose(); state.context.dispose(); state.runtime.dispose();
  }

  #report(failure: SkillMcpMatchFailure) {
    const key = `${failure.skillPath}\0${failure.message}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#onFailure?.(failure);
  }

  #load(index: number): Extract<BundleState, { kind: "ready" | "broken" }> {
    const state = this.#states[index]!;
    if (state.kind !== "unloaded") return state;
    const runtime = this.#module.newRuntime();
    runtime.setMemoryLimit(SKILL_MCP_MATCHER_LIMITS.memoryBytes);
    runtime.setMaxStackSize(SKILL_MCP_MATCHER_LIMITS.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + SKILL_MCP_MATCHER_LIMITS.loadDeadlineMs));
    const context = runtime.newContext();
    const evaluated = context.evalCode(`${this.#bundles[index]!.code}\n${PRELUDE}`, "skill-mcp-matchers.js");
    let next: Extract<BundleState, { kind: "ready" | "broken" }>;
    if (evaluated.error) {
      next = { kind: "broken", message: `Matcher failed to load: ${describeQuickJSError(context, evaluated.error)}` };
      evaluated.error.dispose();
    } else {
      evaluated.value.dispose();
      next = {
        kind: "ready", runtime, context,
        load: context.getProp(context.global, "__wbLoad"),
        match: context.getProp(context.global, "__wbMatch"),
      };
    }
    if (next.kind === "broken") { context.dispose(); runtime.dispose(); }
    this.#states[index] = next;
    return next;
  }

  #run(index: number, input: string):
    | { kind: "none" } | { kind: "failed"; message: string } | { kind: "matched"; presentation: SkillMcpPresentation } {
    const state = this.#load(index);
    if (state.kind === "broken") return { kind: "failed", message: state.message };
    const { context, runtime } = state;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + SKILL_MCP_MATCHER_LIMITS.callInputDeadlineMs));
    const argument = context.newString(input);
    const loaded = context.callFunction(state.load, context.undefined, argument);
    argument.dispose();
    if (loaded.error) {
      const message = describeQuickJSError(context, loaded.error);
      loaded.error.dispose();
      return { kind: "failed", message: `Call could not be loaded for this matcher: ${message}` };
    }
    loaded.value.dispose();
    const deadline = Date.now() + SKILL_MCP_MATCHER_LIMITS.callDeadlineMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const called = context.callFunction(state.match, context.undefined);
    if (called.error) {
      const message = describeQuickJSError(context, called.error);
      called.error.dispose();
      if (isQuickJSRunaway(message, deadline)) {
        const reason = Date.now() >= deadline ? `took longer than ${SKILL_MCP_MATCHER_LIMITS.callDeadlineMs}ms` : message;
        const broken = { kind: "broken" as const, message: `Matcher stopped: ${reason}` };
        SkillMcpMatcherRuntime.#release(state);
        this.#states[index] = broken;
        return { kind: "failed", message: broken.message };
      }
      return { kind: "failed", message: `Matcher threw: ${message}` };
    }
    const value: unknown = context.dump(called.value);
    called.value.dispose();
    if (value === null || value === undefined) return { kind: "none" };
    if (typeof value !== "string") return { kind: "failed", message: "Matcher output must be JSON-serializable." };
    return readSkillMcpPresentation(value);
  }
}

/** A matcher's serialized answer held to the presentation contract, however the matcher ran. */
export function readSkillMcpPresentation(serialized: string):
  | { kind: "failed"; message: string } | { kind: "matched"; presentation: SkillMcpPresentation } {
  if (serialized.length > SKILL_MCP_MATCHER_LIMITS.outputChars) {
    return { kind: "failed", message: `Matcher output is over ${SKILL_MCP_MATCHER_LIMITS.outputChars} characters.` };
  }
  const parsed = SkillMcpPresentationSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) return { kind: "failed", message: `Matcher output is invalid:\n${z.prettifyError(parsed.error)}` };
  return { kind: "matched", presentation: parsed.data };
}
