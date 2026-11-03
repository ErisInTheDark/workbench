/*
 * Exports:
 * - SkillComponentRuntimeOptions: what a platform tells the runtime: which invocations a component body draws as blocks.
 * - default SkillComponentRuntime: render active skills' compiled components synchronously inside QuickJS, each skill in
 *   its own context with a memory cap and a per-render deadline; invocation attributes evaluate in a separate context,
 *   kept results replace their `"@result:<name>"` references, and nested invocations in bodies resolve into the tree.
 *   A runaway render resets only its skill's context; the QuickJS module is injected by its platform loader.
 */
import { shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { readThreadComponentAttributes, readThreadComponentMarkup } from "../thread/thread-component-markup";
import { readThreadComponentTree, type ThreadComponentNode, type ThreadComponentValue } from "../thread/thread-component-tree";
import { describeQuickJSError, guardQuickJSHost, isQuickJSRunaway } from "./quickjs-sandbox";
import { SKILL_COMPONENT_LIMITS, type SkillComponentBundle, type SkillComponentRequest } from "./skill-component-contract";

export interface SkillComponentRuntimeOptions {
  /** The complete invocations a component body's markdown draws as blocks. */
  nestedInvocations(markdown: string): readonly string[];
}

/** Bundles assign each component's default export to `__wbSkillComponents[name]`; this exposes one render entry. */
const PRELUDE = `
;(() => {
  const components = globalThis.__wbSkillComponents;
  if (!components || typeof components !== "object") throw new Error("Component bundle defines no components.");
  const serializable = (_key, value) => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error("Component output contains a non-serializable function or value.");
    }
    return value;
  };
  globalThis.__wbRender = (name, input) => {
    const component = components[name];
    if (typeof component !== "function") throw new Error("Component must have a default function export: " + name);
    return JSON.stringify(component(JSON.parse(input)), serializable);
  };
})();`;

const SERIALIZABLE = `(_key, value) => {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("Component attributes must be JSON values.");
  }
  return value;
}`;

type SkillState =
  | { kind: "unloaded" }
  | { kind: "ready"; runtime: QuickJSRuntime; context: QuickJSContext; render: QuickJSHandle }
  | { kind: "broken"; message: string };

type Props = Record<string, ThreadComponentValue>;

function release(state: Extract<SkillState, { kind: "ready" }>) {
  state.render.dispose(); state.context.dispose(); state.runtime.dispose();
}

function resolveResults(value: ThreadComponentValue, results: Readonly<Record<string, unknown>>): ThreadComponentValue {
  if (typeof value === "string") {
    const reference = /^@result:([A-Za-z0-9_-]{1,64})$/u.exec(value);
    if (!reference) return value;
    if (!Object.hasOwn(results, reference[1]!)) throw new Error(`No kept MCP result named ${reference[1]} in this thread.`);
    return results[reference[1]!] as ThreadComponentValue;
  }
  if (Array.isArray(value)) return value.map(item => resolveResults(item, results));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveResults(item, results)]));
  }
  return value;
}

export default class SkillComponentRuntime {
  readonly key: string;
  readonly #module: QuickJSWASMModule;
  readonly #bundles: readonly SkillComponentBundle[];
  readonly #states: SkillState[];
  readonly #options: SkillComponentRuntimeOptions;
  #props: { runtime: QuickJSRuntime; context: QuickJSContext } | null = null;
  #disposed = false;

  constructor(module: QuickJSWASMModule, bundles: readonly SkillComponentBundle[], options: SkillComponentRuntimeOptions) {
    this.#module = module;
    this.#bundles = bundles;
    this.#states = bundles.map(() => ({ kind: "unloaded" }));
    this.#options = options;
    this.key = SkillComponentRuntime.keyOf(bundles);
  }

  /** The key a runtime over these bundles would have, so callers can keep an equivalent runtime or its renders. */
  static keyOf(bundles: readonly SkillComponentBundle[]) {
    return bundles.map(bundle => `${bundle.skillPath}@${bundle.revision}`).join("|");
  }

  /** One validated tree; throws why it could not render. Public https images stay for the caller to load or inline. */
  render(request: SkillComponentRequest): ThreadComponentNode {
    if (this.#disposed) throw new Error("Skill components were replaced.");
    const deadline = Date.now() + SKILL_COMPONENT_LIMITS.renderDeadlineMs;
    if (request.kind === "props") {
      const index = this.#bundles.findIndex(bundle => bundle.skillPath === request.skillPath);
      const bundle = this.#bundles[index];
      if (!bundle) throw new Error(`The skill presenting this call is not active in this thread: ${request.skillPath}`);
      if (!bundle.components.includes(request.component)) throw new Error(`Skill ${bundle.skillName} exposes no component ${request.component}.`);
      return this.#resolveNested(this.#run(index, request.component, request.props as Props, deadline), {}, deadline, 0);
    }
    return this.#renderMarkup(request.markup, request.results, deadline, 0);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const state of this.#states) if (state.kind === "ready") release(state);
    this.#releaseProps();
  }

  #renderMarkup(markup: string, results: Readonly<Record<string, unknown>>, deadline: number, depth: number): ThreadComponentNode {
    const source = markup.trim();
    const invocation = readThreadComponentMarkup(source);
    if (!invocation || invocation.end !== source.length) throw new Error("Expected one complete component invocation.");
    const owners = this.#bundles.flatMap((bundle, index) => bundle.components.includes(invocation.name) ? [index] : []);
    if (!owners.length) throw new Error(`No active skill exposes component ${invocation.name}.`);
    if (owners.length > 1) throw new Error(`More than one active skill exposes component ${invocation.name}.`);
    const props = resolveResults(this.#attributes(invocation.opening), results) as Props;
    if (invocation.body !== null) props.children = this.#markdown(invocation.body.trim());
    return this.#resolveNested(this.#run(owners[0]!, invocation.name, props, deadline), results, deadline, depth);
  }

  /** A body's markdown node lists the invocations it draws; each resolves to its own tree before the tree is shown. */
  #markdown(source: string): ThreadComponentValue {
    const components = Object.fromEntries(this.#options.nestedInvocations(source).map(markup => [markup, null]));
    return { $workbench: "element", type: "workbench:markdown", props: { source, components } };
  }

  /** Validates the whole tree once its nested invocations are in place; `tree` is the component's unchecked output. */
  #resolveNested(tree: ThreadComponentValue, results: Readonly<Record<string, unknown>>, deadline: number, depth: number): ThreadComponentNode {
    const resolve = (value: ThreadComponentValue): ThreadComponentValue => {
      if (Array.isArray(value)) return value.map(resolve);
      if (!value || typeof value !== "object") return value;
      const { props } = value;
      const components = value.$workbench === "element" && value.type === "workbench:markdown"
        && props && typeof props === "object" && !Array.isArray(props) ? props.components : null;
      if (!components || typeof components !== "object" || Array.isArray(components)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
      }
      if (depth >= SKILL_COMPONENT_LIMITS.nestedDepth) throw new Error(`Components nest deeper than ${SKILL_COMPONENT_LIMITS.nestedDepth} levels.`);
      const nested = Object.fromEntries(Object.keys(components).map(markup =>
        [markup, { ...this.#renderMarkup(markup, results, deadline, depth + 1) }]));
      return { ...value, props: { ...props as Props, components: nested } };
    };
    return readThreadComponentTree(resolve(tree), { remoteImages: true });
  }

  /** Attribute expressions run apart from component code, so an invocation cannot reach into a skill's context. */
  #attributes(opening: string): Props {
    const attributes = readThreadComponentAttributes(opening);
    const props: Props = {};
    const expressions = attributes.flatMap(attribute => {
      if (attribute.kind === "text") props[attribute.name] = attribute.value;
      else if (attribute.kind === "flag") props[attribute.name] = true;
      else return [attribute];
      return [];
    });
    if (!expressions.length) return props;
    this.#props ??= (() => {
      const runtime = this.#module.newRuntime();
      runtime.setMemoryLimit(SKILL_COMPONENT_LIMITS.memoryBytes / 4);
      runtime.setMaxStackSize(SKILL_COMPONENT_LIMITS.stackBytes);
      return { runtime, context: runtime.newContext() };
    })();
    const { runtime, context } = this.#props;
    const deadline = Date.now() + SKILL_COMPONENT_LIMITS.propsDeadlineMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const object = expressions.map(({ name, source }) => `${JSON.stringify(name)}: (${source}\n)`).join(", ");
    const guarded = guardQuickJSHost(() => context.evalCode(`JSON.stringify({ ${object} }, ${SERIALIZABLE})`, "component-attributes.js"));
    if ("crashed" in guarded) {
      this.#props = null;
      throw new Error(`Component attributes crashed: ${guarded.crashed}`);
    }
    const evaluated = guarded.value;
    if (evaluated.error) {
      const message = describeQuickJSError(context, evaluated.error);
      evaluated.error.dispose();
      if (isQuickJSRunaway(message, deadline)) this.#releaseProps();
      throw new Error(`Component attributes failed: ${message}`);
    }
    const serialized: unknown = context.dump(evaluated.value);
    evaluated.value.dispose();
    if (typeof serialized !== "string") throw new Error("Component attributes must be JSON values.");
    return { ...props, ...JSON.parse(serialized) as Props };
  }

  #releaseProps() {
    if (!this.#props) return;
    this.#props.context.dispose();
    this.#props.runtime.dispose();
    this.#props = null;
  }

  /** Its runtime is dropped undisposed: see guardQuickJSHost. */
  #crash(index: number, reason: string) {
    const broken = { kind: "broken" as const, message: `Skill ${this.#bundles[index]!.skillName} components crashed: ${reason}` };
    this.#states[index] = broken;
    return broken;
  }

  #load(index: number): Extract<SkillState, { kind: "ready" | "broken" }> {
    const state = this.#states[index]!;
    if (state.kind !== "unloaded") return state;
    const bundle = this.#bundles[index]!;
    const runtime = this.#module.newRuntime();
    runtime.setMemoryLimit(SKILL_COMPONENT_LIMITS.memoryBytes);
    runtime.setMaxStackSize(SKILL_COMPONENT_LIMITS.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + SKILL_COMPONENT_LIMITS.loadDeadlineMs));
    const context = runtime.newContext();
    const guarded = guardQuickJSHost(() => context.evalCode(`${bundle.code}\n${PRELUDE}`, "skill-components.js"));
    if ("crashed" in guarded) return this.#crash(index, guarded.crashed);
    const evaluated = guarded.value;
    let next: Extract<SkillState, { kind: "ready" | "broken" }>;
    if (evaluated.error) {
      next = { kind: "broken", message: `Skill ${bundle.skillName} components failed to load: ${describeQuickJSError(context, evaluated.error)}` };
      evaluated.error.dispose();
      context.dispose();
      runtime.dispose();
    } else {
      evaluated.value.dispose();
      next = { kind: "ready", runtime, context, render: context.getProp(context.global, "__wbRender") };
    }
    this.#states[index] = next;
    return next;
  }

  #run(index: number, name: string, props: Props, deadline: number): ThreadComponentValue {
    const state = this.#load(index);
    if (state.kind === "broken") throw new Error(state.message);
    const { context, runtime } = state;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const nameHandle = context.newString(name);
    const input = context.newString(JSON.stringify(props));
    const guarded = guardQuickJSHost(() => context.callFunction(state.render, context.undefined, nameHandle, input));
    if ("crashed" in guarded) {
      this.#crash(index, guarded.crashed);
      throw new Error(`${name} crashed: ${guarded.crashed}`);
    }
    const called = guarded.value;
    nameHandle.dispose();
    input.dispose();
    if (called.error) {
      const message = describeQuickJSError(context, called.error);
      called.error.dispose();
      if (isQuickJSRunaway(message, deadline)) {
        // A fresh context for the next render: one huge input must not break the skill's other components.
        release(state);
        this.#states[index] = { kind: "unloaded" };
        throw new Error(`${name} stopped: ${Date.now() >= deadline ? `took longer than ${SKILL_COMPONENT_LIMITS.renderDeadlineMs}ms` : message}`);
      }
      throw new Error(`${name} threw: ${message}`);
    }
    const serialized: unknown = context.dump(called.value);
    called.value.dispose();
    if (typeof serialized !== "string") throw new Error(`${name} must return an element.`);
    return JSON.parse(serialized) as ThreadComponentValue;
  }
}
