/*
 * Exports:
 * - WorkbenchComponentTarget: message and markup identifying a rendered component.
 * - WorkbenchCallComponentTarget: MCP call item, skill and component identifying a call's rendered component.
 * - WorkbenchMatcherTest: an MCP matcher test's report and component preview.
 * - WorkbenchComponentsOptions: skill, compilation, kept-result, image, transcript asset and MCP call presentation ports.
 * - default WorkbenchComponentsController: resolve active templates, feed them referenced kept MCP results, inline their
 *   images and retain their rendered results; compile active skills' MCP matchers, render and retain MCP call
 *   components, and test matchers against a sample call.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkbenchSkillDefinition } from "workbench-shared/types";
import { readThreadComponentMarkup } from "workbench-shared/workbench/thread/thread-component-markup";
import { readThreadComponentRender, readThreadComponentStyle, readThreadComponentTree } from "workbench-shared/workbench/thread/thread-component-tree";
import type {
  ThreadCompiledComponent, ThreadCompiledStyle, ThreadComponentNode, ThreadComponentPreview, ThreadComponentRender,
  ThreadComponentStyle, ThreadComponentValue,
} from "workbench-shared/workbench/thread/thread-component-tree";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import {
  SkillMcpMatcherBundleSchema, type SkillMcpCall, type SkillMcpMatcherCompilation, type SkillMcpPart,
} from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import SkillMcpMatcherRuntime, { type SkillMcpMatch } from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import { readSkillComponentPaths, resolveSkillComponents } from "../lib/workbench/skills/skill-components";
import { resolveSkillMcpMatchers } from "../lib/workbench/skills/skill-mcp-matchers";
import { inlineComponentImages, type ComponentImageFetch } from "./component-images";

const MAX_COMPILED_CACHE_BYTES = 16 * 1024 * 1024;
/** A template can emit a markdown body naming its own invocation; this bounds that recursion. */
const MAX_NESTED_COMPONENT_DEPTH = 8;

function markdownProps(value: { [key: string]: ThreadComponentValue }): Record<string, ThreadComponentValue> | null {
  const { props } = value;
  return value.$workbench === "element" && value.type === "workbench:markdown"
    && props && typeof props === "object" && !Array.isArray(props) ? props : null;
}

function formatPart(part: SkillMcpPart) {
  if (typeof part === "string") return part;
  if ("code" in part) return `\`${part.code}\``;
  if ("primary" in part) return part.primary;
  if ("path" in part) return part.path;
  return `thread ${part.thread}`;
}

/** A match as the transcript would draw it, line by line. */
function formatSkillMcpMatch({ presentation, skillName }: SkillMcpMatch) {
  const line = (verb: string) => [verb, ...presentation.summary.map(formatPart)].join(" ");
  const display = typeof presentation.display === "string"
    ? presentation.display === "step" ? "step in the activity card" : "hidden"
    : `own card, family "${presentation.display.card}"${presentation.display.open ? ", open" : ""}`;
  return [
    `Presented by skill ${skillName}:`,
    `  running: ${line(presentation.verb[0])}`,
    `  done:    ${line(presentation.verb[1])}`,
    `  display: ${display}`,
    ...presentation.chip ? [`  chip:    ${presentation.chip.verb} (${presentation.chip.icon} icon)`] : [],
    ...presentation.component ? [`  component: ${presentation.component}${presentation.props ? ` with props ${JSON.stringify(presentation.props)}` : ""}`] : [],
  ].join("\n");
}

export interface WorkbenchComponentTarget {
  threadId: string;
  itemId: string;
  markup: string;
}

/** One MCP call's skill component, owned by the call's item. */
export interface WorkbenchCallComponentTarget {
  threadId: string;
  itemId: string;
  skillPath: string;
  component: string;
}

/** What `wb vis match` reports: every skill's say about the call, and its component rendered for a screenshot. */
export interface WorkbenchMatcherTest {
  report: string;
  preview: string | null;
}

export interface WorkbenchComponentsOptions {
  skills(threadId: string): Promise<readonly WorkbenchSkillDefinition[]>;
  /** MCP call presentation; absent where only message components render. */
  calls?: {
    compileMatchers(files: readonly string[], root: string, threadId: string): Promise<ThreadCompiledComponent>;
    renderProps(compiled: ThreadCompiledComponent, props: Record<string, unknown>, threadId: string, signal?: AbortSignal): Promise<ThreadComponentNode>;
    quickjs(): Promise<QuickJSWASMModule>;
    read(target: WorkbenchCallComponentTarget): Promise<ThreadComponentNode | null>;
    write(target: WorkbenchCallComponentTarget, tree: ThreadComponentNode): Promise<ThreadComponentNode>;
  };
  compile(file: string, threadId: string, signal?: AbortSignal, skillRoot?: string): Promise<ThreadCompiledComponent>;
  compileStyles(files: string[], threadId: string, skillRoot: string): Promise<ThreadCompiledStyle>;
  evaluate(
    compiled: ThreadCompiledComponent, name: string, markup: string, results: Record<string, unknown>, threadId: string, signal?: AbortSignal,
  ): Promise<ThreadComponentNode>;
  /** The thread's kept MCP result for each name it has; missing names are absent. */
  results?(threadId: string, names: readonly string[]): Promise<Record<string, unknown>>;
  fetchImage?: ComponentImageFetch;
  preview?(result: ThreadComponentPreview, threadId: string, signal?: AbortSignal): Promise<string>;
  read(target: WorkbenchComponentTarget): Promise<ThreadComponentNode | null>;
  write(target: WorkbenchComponentTarget, tree: ThreadComponentNode): Promise<ThreadComponentNode>;
}

export default class WorkbenchComponentsController {
  readonly #compiled = new Map<string, { compiled: ThreadCompiledComponent; fingerprint: string }>();
  readonly #styles = new Map<string, { files: string; inputs: string[]; fingerprint: string; style: ThreadComponentStyle }>();
  readonly #styleFlights = new Map<string, Promise<ThreadComponentStyle | null>>();

  constructor(private readonly options: WorkbenchComponentsOptions) {}

  async renderMessage(target: WorkbenchComponentTarget): Promise<ThreadComponentRender> {
    const saved = await this.options.read(target);
    if (saved) return { tree: saved, styleRevisions: [] };
    const result = await this.#render(target.threadId, target.markup);
    const tree = await this.options.write(target, await this.#inline(result.tree));
    return readThreadComponentRender({ tree, styleRevisions: result.styles.map(({ path, revision }) => ({ path, revision })) });
  }

  async previewMarkup(threadId: string, markup: string, signal?: AbortSignal): Promise<string> {
    if (!this.options.preview) throw new Error("Component preview is unavailable.");
    const result = await this.#render(threadId, markup, signal);
    const css = [...new Set(result.styles.map(style => style.css))].filter(Boolean).join("\n");
    return await this.options.preview({ tree: await this.#inline(result.tree, signal), css }, threadId, signal);
  }

  async #inline(tree: ThreadComponentNode, signal?: AbortSignal) {
    const fetchImage = this.options.fetchImage ?? (async () => { throw new Error("Component images are unavailable."); });
    return await inlineComponentImages(tree, fetchImage, signal);
  }

  async #results(threadId: string, opening: string): Promise<Record<string, unknown>> {
    const names = [...new Set([...opening.matchAll(/["']@result:([A-Za-z0-9_-]{1,64})["']/gu)].map(match => match[1]!))];
    if (!names.length) return {};
    if (!this.options.results) throw new Error("Kept MCP results are unavailable.");
    const results = await this.options.results(threadId, names);
    const missing = names.find(name => !Object.hasOwn(results, name));
    if (missing) throw new Error(`No kept MCP result named ${missing} in this thread.`);
    return results;
  }

  async styles(threadId: string, signal?: AbortSignal): Promise<ThreadComponentStyle[]> {
    signal?.throwIfAborted();
    const values = await Promise.all((await this.options.skills(threadId)).map(skill => this.#style(skill, threadId)));
    signal?.throwIfAborted();
    return values.filter((value): value is ThreadComponentStyle => value !== null);
  }

  async #style(skill: WorkbenchSkillDefinition, threadId: string): Promise<ThreadComponentStyle | null> {
    const key = `${skill.path}\0${skill.content}`;
    const existing = this.#styleFlights.get(key);
    if (existing) return await existing;
    const flight = this.#buildStyle(skill, threadId);
    this.#styleFlights.set(key, flight);
    try { return await flight; }
    finally { if (this.#styleFlights.get(key) === flight) this.#styleFlights.delete(key); }
  }

  async #buildStyle(skill: WorkbenchSkillDefinition, threadId: string): Promise<ThreadComponentStyle | null> {
    const files: string[] = [];
    let root = path.dirname(skill.path);
    for (const declared of readSkillComponentPaths(skill.content)) {
      const normalized = declared.replaceAll("\\", "/");
      const name = path.posix.basename(normalized, path.posix.extname(normalized));
      try {
        const resolved = await resolveSkillComponents(skill.path, skill.content, name);
        for (const component of resolved) { files.push(component.path); root = component.root; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!files.length) { this.#styles.delete(skill.path); return null; }
    const fileKey = JSON.stringify(files);
    const cached = this.#styles.get(skill.path);
    if (cached?.files === fileKey) {
      try {
        if (await this.#fingerprint(cached.inputs) === cached.fingerprint) {
          this.#styles.delete(skill.path);
          this.#styles.set(skill.path, cached);
          return cached.style;
        }
      } catch { /* Rebuild if an input disappeared. */ }
    }
    const before = await this.#fingerprint(files);
    const built = await this.options.compileStyles(files, threadId, root);
    if (before !== await this.#fingerprint(files)) throw new Error("Skill components changed while styles were compiled.");
    const style = readThreadComponentStyle({
      path: skill.path, revision: createHash("sha256").update(built.css).digest("hex"), css: built.css,
    });
    this.#styles.set(skill.path, { files: fileKey, inputs: built.inputs, fingerprint: await this.#fingerprint(built.inputs), style });
    let bytes = [...this.#styles.values()].reduce((sum, value) => sum + Buffer.byteLength(value.style.css), 0);
    while (bytes > MAX_COMPILED_CACHE_BYTES && this.#styles.size > 1) {
      const oldest = this.#styles.keys().next().value;
      if (!oldest) break;
      bytes -= Buffer.byteLength(this.#styles.get(oldest)!.style.css);
      this.#styles.delete(oldest);
    }
    return style;
  }

  /**
   * One compiled output per key, reused until any input it read changes; `sources` must not change while compiling.
   * Least recently used outputs leave first once the cache passes its byte budget.
   */
  async #cached(key: string, sources: readonly string[], compile: () => Promise<ThreadCompiledComponent>, signal?: AbortSignal) {
    let cached = this.#compiled.get(key);
    if (cached) {
      try {
        if (await this.#fingerprint(cached.compiled.inputs) !== cached.fingerprint) cached = undefined;
      } catch {
        signal?.throwIfAborted();
        cached = undefined;
      }
      if (!cached) this.#compiled.delete(key);
    }
    if (cached) {
      this.#compiled.delete(key);
      this.#compiled.set(key, cached);
      return cached.compiled;
    }
    const before = await this.#fingerprint(sources);
    const compiled = await compile();
    signal?.throwIfAborted();
    if (before !== await this.#fingerprint(sources)) throw new Error("Skill code changed while it was being compiled.");
    this.#compiled.set(key, { compiled, fingerprint: await this.#fingerprint(compiled.inputs) });
    let bytes = [...this.#compiled.values()].reduce((sum, value) => sum + Buffer.byteLength(value.compiled.code), 0);
    while (bytes > MAX_COMPILED_CACHE_BYTES && this.#compiled.size > 1) {
      const oldest = this.#compiled.keys().next().value;
      if (!oldest) break;
      bytes -= Buffer.byteLength(this.#compiled.get(oldest)!.compiled.code);
      this.#compiled.delete(oldest);
    }
    return compiled;
  }

  #calls() {
    if (!this.options.calls) throw new Error("MCP call presentation is unavailable.");
    return this.options.calls;
  }

  /** Every active skill's compiled MCP matchers, in catalogue order; a skill whose matchers fail reports why instead. */
  async matchers(threadId: string): Promise<SkillMcpMatcherCompilation> {
    const calls = this.#calls();
    const outcomes = await Promise.all((await this.options.skills(threadId)).map(async skill => {
      try {
        const resolved = await resolveSkillMcpMatchers(skill.path, skill.content);
        if (!resolved) return null;
        const compiled = await this.#cached(`matchers\0${skill.path}\0${resolved.files.join("\0")}`, resolved.files,
          () => calls.compileMatchers(resolved.files, resolved.root, threadId));
        const bundle = SkillMcpMatcherBundleSchema.parse({
          skillName: skill.name, skillPath: skill.path, code: compiled.code, revision: createHash("sha256").update(compiled.code).digest("hex"),
        });
        return { kind: "bundle" as const, bundle };
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
        return { kind: "failure" as const, failure: { skillName: skill.name, skillPath: skill.path, message } };
      }
    }));
    return {
      bundles: outcomes.flatMap(outcome => outcome?.kind === "bundle" ? [outcome.bundle] : []),
      failures: outcomes.flatMap(outcome => outcome?.kind === "failure" ? [outcome.failure] : []),
    };
  }

  /**
   * A call's skill component, rendered once from the active skill that named it and kept on the call's item. A call that
   * kept its result under a name gets that kept result, not the stub its inline answer carried.
   */
  async renderCall(target: WorkbenchCallComponentTarget & { props: Record<string, unknown> }): Promise<ThreadComponentRender> {
    const calls = this.#calls();
    const stored = await calls.read(target);
    if (stored) return { tree: stored, styleRevisions: [] };
    const result = await this.#renderProps(target.threadId, target.skillPath, target.component, await this.#withKeptResult(target.threadId, target.props));
    const tree = await calls.write(target, await this.#inline(result.tree));
    return readThreadComponentRender({ tree, styleRevisions: result.styles.map(({ path, revision }) => ({ path, revision })) });
  }

  /** Run active skills' matchers on one call as the client would, then render the named component for a screenshot. */
  async testMatcher(threadId: string, call: SkillMcpCall, signal?: AbortSignal): Promise<WorkbenchMatcherTest> {
    const calls = this.#calls();
    const { bundles, failures } = await this.matchers(threadId);
    signal?.throwIfAborted();
    const lines = failures.map(failure => `Skill ${failure.skillName} matchers failed to compile:\n${failure.message}`);
    if (!bundles.length) {
      lines.push(failures.length ? "No other active skill has MCP matchers." : "No active skill has MCP matchers.");
      return { report: `${lines.join("\n\n")}\n`, preview: null };
    }
    const runtime = new SkillMcpMatcherRuntime(await calls.quickjs(), bundles);
    let report: ReturnType<SkillMcpMatcherRuntime["report"]>;
    try { report = runtime.report(call); }
    finally { runtime.dispose(); }
    lines.push(...report.failures.map(failure => `Skill ${failure.skillName}: ${failure.message}`));
    const match = report.match;
    if (!match) {
      lines.push("No active skill matcher presents this call; it shows with the generic MCP summary.");
      return { report: `${lines.join("\n\n")}\n`, preview: null };
    }
    lines.push(formatSkillMcpMatch(match));
    const component = match.presentation.component;
    if (!component || call.status !== "completed") return { report: `${lines.join("\n\n")}\n`, preview: null };
    if (!this.options.preview) throw new Error("Component preview is unavailable.");
    const rendered = await this.#renderProps(threadId, match.skillPath, component, await this.#withKeptResult(threadId, { ...match.presentation.props, call }), signal);
    const css = [...new Set(rendered.styles.map(style => style.css))].filter(Boolean).join("\n");
    const preview = await this.options.preview({ tree: await this.#inline(rendered.tree, signal), css }, threadId, signal);
    return { report: `${lines.join("\n\n")}\n`, preview };
  }

  async #withKeptResult(threadId: string, props: Record<string, unknown>) {
    const call = props.call;
    const keep = call && typeof call === "object" && !Array.isArray(call) && "keep" in call && typeof call.keep === "string" ? call.keep : null;
    if (!keep || !this.options.results) return props;
    const kept = await this.options.results(threadId, [keep]);
    return Object.hasOwn(kept, keep) ? { ...props, call: { ...call as object, result: kept[keep] } } : props;
  }

  async #renderProps(threadId: string, skillPath: string, name: string, props: Record<string, unknown>, signal?: AbortSignal) {
    const calls = this.#calls();
    const skill = (await this.options.skills(threadId)).find(candidate => candidate.path === skillPath);
    if (!skill) throw new Error(`The skill presenting this call is not active in this thread: ${skillPath}`);
    const component = (await resolveSkillComponents(skill.path, skill.content, name)).find(candidate => candidate.name === name);
    if (!component) throw new Error(`Skill ${skill.name} exposes no component ${name}.`);
    const compiled = await this.#cached(component.path, [component.path], () => this.options.compile(component.path, threadId, signal, component.root), signal);
    const tree = readThreadComponentTree(await calls.renderProps(compiled, props, threadId, signal), { remoteImages: true });
    const style = await this.#style(skill, threadId);
    signal?.throwIfAborted();
    return { tree, styles: style ? [style] : [] };
  }

  async #fingerprint(inputs: readonly string[]): Promise<string> {
    const hash = createHash("sha256");
    for (const file of [...inputs].sort()) {
      hash.update(file);
      hash.update(await readFile(file));
    }
    return hash.digest("hex");
  }

  async #render(
    threadId: string, markup: string, signal?: AbortSignal, depth = 0,
  ): Promise<{ tree: ThreadComponentNode; styles: ThreadComponentStyle[] }> {
    signal?.throwIfAborted();
    const source = markup.trim();
    const invocation = readThreadComponentMarkup(source);
    if (!invocation || invocation.end !== source.length) throw new Error("Expected one complete component invocation.");
    const skills = await this.options.skills(threadId);
    const matches = (await Promise.all(skills.map(async skill => {
      const components = await resolveSkillComponents(skill.path, skill.content, invocation.name);
      return components.filter(component => component.name === invocation.name).map(component => ({ component, skill }));
    }))).flat();
    if (!matches.length) throw new Error(`No active skill exposes component ${invocation.name}.`);
    if (matches.length > 1) throw new Error(`More than one active skill exposes component ${invocation.name}.`);
    const { component, skill } = matches[0]!;
    const compiled = await this.#cached(component.path, [component.path], () => this.options.compile(component.path, threadId, signal, component.root), signal);
    const results = await this.#results(threadId, invocation.opening);
    const evaluated = readThreadComponentTree(
      await this.options.evaluate(compiled, invocation.name, source, results, threadId, signal), { remoteImages: true },
    );
    const styles = new Map<string, ThreadComponentStyle>();
    const ownStyle = await this.#style(skill, threadId);
    if (ownStyle) styles.set(ownStyle.path, ownStyle);
    const resolveNested = async (value: ThreadComponentValue): Promise<ThreadComponentValue> => {
      if (Array.isArray(value)) return await Promise.all(value.map(resolveNested));
      if (!value || typeof value !== "object") return value;
      const props = markdownProps(value);
      const components = props?.components;
      if (!props || !components || typeof components !== "object" || Array.isArray(components)) {
        return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await resolveNested(child)])));
      }
      if (depth >= MAX_NESTED_COMPONENT_DEPTH) throw new Error(`Components nest deeper than ${MAX_NESTED_COMPONENT_DEPTH} levels.`);
      const resolved = await Promise.all(Object.keys(components).map(async markup => {
        const nested = await this.#render(threadId, markup, signal, depth + 1);
        for (const style of nested.styles) styles.set(style.path, style);
        return [markup, { ...nested.tree }] as const;
      }));
      return { ...value, props: { ...props, components: Object.fromEntries(resolved) } };
    };
    const tree = readThreadComponentTree(await resolveNested({ ...evaluated }), { remoteImages: true });
    signal?.throwIfAborted();
    return { tree, styles: [...styles.values()] };
  }
}
