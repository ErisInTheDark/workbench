/*
 * Exports:
 * - ThreadSkillExtensionsPorts: the daemon, worker and matcher-runtime ports one thread's owner uses.
 * - ThreadSkillExtensionsState: the thread's matcher runtime, skill css and the key its component renders belong to.
 * - ThreadSkillComponentRequest: one component to draw: a message invocation, a call's own component, or one in a line.
 * - ThreadSkillComponentState: a component's render: pending, its tree, or why it could not draw.
 * - default ThreadSkillExtensionsController: one thread's active skill extensions, reloaded when its skills change:
 *   matchers (kept while unchanged), styles, and components rendered in the worker with their kept results and public
 *   images; components whose inputs expire keep a snapshot while they live and draw it once they are gone.
 */
import SkillComponentRuntime from "workbench-shared/workbench/skills/SkillComponentRuntime";
import SkillMcpMatcherRuntime from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import type { SkillMcpMatcherBundle } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import type { SkillComponentTarget, SkillExtensions } from "workbench-shared/workbench/skills/skill-component-contract";
import { listThreadComponentResultNames } from "workbench-shared/workbench/thread/thread-component-markup";
import { inlineThreadComponentImages, readThreadComponentTree, type ThreadComponentNode } from "workbench-shared/workbench/thread/thread-component-tree";
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { SkillComponentEvaluator, SkillComponentRender } from "./SkillComponentWorkerClient";

export interface ThreadSkillExtensionsPorts {
  extensions(signal: AbortSignal): Promise<SkillExtensions>;
  results(names: readonly string[]): Promise<Record<string, unknown>>;
  images(urls: readonly string[]): Promise<Record<string, string | null>>;
  keep(target: SkillComponentTarget, tree: ThreadComponentNode): Promise<void>;
  kept(target: SkillComponentTarget): Promise<unknown>;
  evaluator(): SkillComponentEvaluator;
  matchers(bundles: readonly SkillMcpMatcherBundle[]): Promise<SkillMcpMatcherRuntime>;
  warn(message: string): void;
}

export interface ThreadSkillExtensionsState {
  /** Names the loaded components; renders under another key are stale. Null until the first load settles. */
  key: string | null;
  matchers: SkillMcpMatcherRuntime | null;
  css: string;
  error: string | null;
}

export type ThreadSkillComponentRequest =
  | { kind: "message"; itemId: string; markup: string }
  | {
    kind: "call"; itemId: string; skillPath: string; component: string; props: Record<string, JsonValue>;
    /** The call kept its result under this name, which its component gets instead of the inline stub. */
    keep: string | null;
    /** The call's result body expired, so a kept snapshot draws in place of a stub render. */
    expired: boolean;
  }
  | { kind: "inline"; skillPath: string; component: string; props: Record<string, JsonValue> };

export type ThreadSkillComponentState =
  | { status: "pending" }
  | { status: "ready"; tree: ThreadComponentNode }
  | { status: "failed"; error: string };

const PENDING: ThreadSkillComponentState = { status: "pending" };
const EMPTY: ThreadSkillExtensionsState = { key: null, matchers: null, css: "", error: null };
/** Renders nothing on screen still holds, beyond which the oldest leave. */
const MAX_UNHELD_RENDERS = 200;
const IMAGE_BATCH = 32;
const MISSING = Symbol("missing");

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

type Entry = { state: ThreadSkillComponentState; holds: number };

export default class ThreadSkillExtensionsController {
  #state = EMPTY;
  #listeners = new Set<() => void>();
  #skillsKey: string | null = null;
  #enabled = false;
  #generation = 0;
  #flight: AbortController | null = null;
  #disposed = false;
  readonly #evaluator: SkillComponentEvaluator;
  readonly #renders = new Map<string, Entry>();
  readonly #results = new Map<string, Promise<unknown>>();
  readonly #images = new Map<string, Promise<string | null>>();
  readonly #keeping = new Set<string>();

  constructor(private readonly ports: ThreadSkillExtensionsPorts) {
    this.#evaluator = ports.evaluator();
  }

  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  snapshot = () => this.#state;

  /** Reloads extensions when the thread's active skills change; no skills means none, at once. */
  setSkills(key: string, enabled: boolean) {
    if (this.#disposed || (key === this.#skillsKey && enabled === this.#enabled)) return;
    this.#skillsKey = key;
    this.#enabled = enabled;
    const generation = this.#generation += 1;
    this.#flight?.abort();
    this.#flight = null;
    if (!enabled) {
      this.#apply({ matchers: [], components: [], styles: [], failures: [] }, generation);
      return;
    }
    const flight = this.#flight = new AbortController();
    void this.ports.extensions(flight.signal).then(
      extensions => this.#apply(extensions, generation),
      (error: unknown) => {
        if (generation !== this.#generation || flight.signal.aborted) return;
        this.ports.warn(`Skill extensions failed to load: ${describe(error).slice(0, 500)}`);
        this.#publish({ ...this.#state, key: this.#state.key ?? "", error: describe(error) });
      },
    ).finally(() => { if (this.#flight === flight) this.#flight = null; });
  }

  /** A held render's current state; holding it (see `hold`) is what starts it. */
  peek(key: string): ThreadSkillComponentState {
    return this.#state.key === null ? PENDING : this.#renders.get(this.#renderKey(key))?.state ?? PENDING;
  }

  /** Starts a render unless one exists for the loaded components, and keeps it while held; returns the release. */
  hold(key: string, request: ThreadSkillComponentRequest): () => void {
    if (this.#state.key === null || this.#disposed) return () => {};
    const renderKey = this.#renderKey(key);
    let entry = this.#renders.get(renderKey);
    if (!entry) {
      entry = { state: PENDING, holds: 0 };
      this.#renders.set(renderKey, entry);
      const started = entry;
      void this.#render(request).then(
        state => this.#settle(renderKey, started, state),
        (error: unknown) => this.#settle(renderKey, started, { status: "failed", error: describe(error) }),
      );
    } else {
      this.#renders.delete(renderKey);
      this.#renders.set(renderKey, entry);
    }
    entry.holds += 1;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holds -= 1;
      this.#evict();
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#flight?.abort();
    this.#evaluator.close();
    this.#listeners.clear();
  }

  #renderKey(key: string) {
    return `${this.#state.key}\0${key}`;
  }

  async #apply(extensions: SkillExtensions, generation: number) {
    for (const failure of extensions.failures) {
      this.ports.warn(`Skill ${failure.skillName} ${failure.kind} failed to build: ${failure.message.slice(0, 500)}`);
    }
    const matchersKey = SkillMcpMatcherRuntime.keyOf(extensions.matchers);
    // Unchanged matchers keep their runtime, so presentation caches survive unrelated skill changes.
    let matchers = this.#state.matchers;
    if (!extensions.matchers.length) matchers = null;
    else if (!matchers || matchers.key !== matchersKey) {
      try { matchers = await this.ports.matchers(extensions.matchers); }
      catch (error) {
        this.ports.warn(`Skill MCP matchers failed to load: ${describe(error).slice(0, 500)}`);
        matchers = null;
      }
    }
    if (generation !== this.#generation) {
      if (matchers && matchers !== this.#state.matchers) matchers.dispose();
      return;
    }
    const key = SkillComponentRuntime.keyOf(extensions.components);
    if (key !== this.#state.key) this.#evaluator.load(extensions.components);
    this.#publish({
      key, matchers, error: null,
      css: [...new Set(extensions.styles.map(style => style.css))].filter(Boolean).join("\n"),
    });
  }

  #publish(state: ThreadSkillExtensionsState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #settle(renderKey: string, entry: Entry, state: ThreadSkillComponentState) {
    if (this.#disposed || this.#renders.get(renderKey) !== entry) return;
    entry.state = state;
    for (const listener of this.#listeners) listener();
  }

  #evict() {
    let unheld = [...this.#renders.values()].filter(entry => entry.holds <= 0).length;
    for (const [key, entry] of this.#renders) {
      if (unheld <= MAX_UNHELD_RENDERS) return;
      if (entry.holds > 0) continue;
      this.#renders.delete(key);
      unheld -= 1;
    }
  }

  async #render(request: ThreadSkillComponentRequest): Promise<ThreadSkillComponentState> {
    if (request.kind === "inline") {
      return this.#ready(await this.#evaluator.render({ kind: "props", skillPath: request.skillPath, component: request.component, props: request.props }));
    }
    if (request.kind === "call") {
      const target: SkillComponentTarget = { kind: "call", itemId: request.itemId, skillPath: request.skillPath, component: request.component };
      if (request.expired) {
        const kept = await this.#kept(target);
        if (kept) return kept;
      }
      const props = await this.#withKeptResult(request);
      const tree = await this.#ready(await this.#evaluator.render({ kind: "props", skillPath: request.skillPath, component: request.component, props }));
      if (!request.expired && tree.status === "ready") this.#keep(target, tree.tree);
      return tree;
    }
    const target: SkillComponentTarget = { kind: "message", itemId: request.itemId, markup: request.markup };
    const names = listThreadComponentResultNames(request.markup);
    if (!names.length) return await this.#ready(await this.#evaluator.render({ kind: "markup", markup: request.markup, results: {} }));
    const values = await Promise.all(names.map(name => this.#result(name)));
    const missing = names.filter((_name, index) => values[index] === MISSING);
    if (missing.length) {
      // Kept results go when their thread settles; the snapshot taken while they lived draws instead.
      const kept = await this.#kept(target);
      return kept ?? { status: "failed", error: `No kept MCP result named ${missing[0]} in this thread.` };
    }
    const results = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    const tree = await this.#ready(await this.#evaluator.render({ kind: "markup", markup: request.markup, results }));
    if (tree.status === "ready") this.#keep(target, tree.tree);
    return tree;
  }

  /** A live render with its public images resolved through the daemon, so the page never loads them itself. */
  async #ready({ tree, imageUrls }: SkillComponentRender): Promise<ThreadSkillComponentState> {
    if (!imageUrls.length) return { status: "ready", tree };
    const uncached = imageUrls.filter(url => !this.#images.has(url));
    for (let start = 0; start < uncached.length; start += IMAGE_BATCH) {
      const batch = uncached.slice(start, start + IMAGE_BATCH);
      const fetched = this.ports.images(batch).catch(() => ({} as Record<string, string | null>));
      for (const url of batch) this.#images.set(url, fetched.then(images => images[url] ?? null));
    }
    const images = new Map(await Promise.all(imageUrls.map(async url => [url, await this.#images.get(url)!] as const)));
    return { status: "ready", tree: inlineThreadComponentImages(tree, images) };
  }

  async #withKeptResult(request: Extract<ThreadSkillComponentRequest, { kind: "call" }>): Promise<Record<string, JsonValue>> {
    if (!request.keep) return request.props;
    const kept = await this.#result(request.keep);
    const call = request.props.call;
    if (kept === MISSING || !call || typeof call !== "object" || Array.isArray(call)) return request.props;
    // Kept results are the JSON an MCP call returned.
    return { ...request.props, call: { ...call, result: kept as JsonValue } };
  }

  /** One fetch per kept result name; a failed fetch is retried by the next render that needs it. */
  #result(name: string): Promise<unknown> {
    let pending = this.#results.get(name);
    if (!pending) {
      pending = this.ports.results([name]).then(results => Object.hasOwn(results, name) ? results[name] : MISSING);
      pending.catch(() => { if (this.#results.get(name) === pending) this.#results.delete(name); });
      this.#results.set(name, pending);
    }
    return pending;
  }

  async #kept(target: SkillComponentTarget): Promise<ThreadSkillComponentState | null> {
    try {
      const tree = await this.ports.kept(target);
      return tree ? { status: "ready", tree: readThreadComponentTree(tree) } : null;
    } catch (error) {
      this.ports.warn(`Kept component could not be read: ${describe(error).slice(0, 500)}`);
      return null;
    }
  }

  /** The first tree a target draws while its inputs live; the daemon keeps only the first. */
  #keep(target: SkillComponentTarget, tree: ThreadComponentNode) {
    const key = JSON.stringify(target);
    if (this.#keeping.has(key)) return;
    this.#keeping.add(key);
    void this.ports.keep(target, tree).catch((error: unknown) => {
      this.#keeping.delete(key);
      this.ports.warn(`Component snapshot could not be kept: ${describe(error).slice(0, 500)}`);
    });
  }
}
