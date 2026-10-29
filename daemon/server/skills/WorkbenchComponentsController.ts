/*
 * Exports:
 * - WorkbenchComponentTarget: message and markup identifying a rendered component.
 * - WorkbenchComponentsOptions: skill, compilation, kept-result, image and transcript asset ports.
 * - default WorkbenchComponentsController: resolve active templates, feed them referenced kept MCP results, inline their
 *   images and retain their rendered results.
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
import { readSkillComponentPaths, resolveSkillComponents } from "../lib/workbench/skills/skill-components";
import { inlineComponentImages, type ComponentImageFetch } from "./component-images";

const MAX_COMPILED_CACHE_BYTES = 16 * 1024 * 1024;
/** A template can emit a markdown body naming its own invocation; this bounds that recursion. */
const MAX_NESTED_COMPONENT_DEPTH = 8;

function markdownProps(value: { [key: string]: ThreadComponentValue }): Record<string, ThreadComponentValue> | null {
  const { props } = value;
  return value.$workbench === "element" && value.type === "workbench:markdown"
    && props && typeof props === "object" && !Array.isArray(props) ? props : null;
}

export interface WorkbenchComponentTarget {
  threadId: string;
  itemId: string;
  markup: string;
}

export interface WorkbenchComponentsOptions {
  skills(threadId: string): Promise<readonly WorkbenchSkillDefinition[]>;
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
    const file = component.path;
    let cached = this.#compiled.get(file);
    if (cached) {
      try {
        if (await this.#fingerprint(cached.compiled.inputs) !== cached.fingerprint) cached = undefined;
      } catch {
        signal?.throwIfAborted();
        cached = undefined;
      }
      if (!cached) this.#compiled.delete(file);
    }
    if (!cached) {
      const before = await this.#fingerprint([file]);
      const compiled = await this.options.compile(file, threadId, signal, component.root);
      signal?.throwIfAborted();
      if (before !== await this.#fingerprint([file])) throw new Error("Component changed while it was being compiled.");
      cached = { compiled, fingerprint: await this.#fingerprint(compiled.inputs) };
      this.#compiled.set(file, cached);
      let bytes = [...this.#compiled.values()].reduce((sum, value) =>
        sum + Buffer.byteLength(value.compiled.code), 0);
      while (bytes > MAX_COMPILED_CACHE_BYTES && this.#compiled.size > 1) {
        const oldest = this.#compiled.keys().next().value;
        if (!oldest) break;
        const removed = this.#compiled.get(oldest)!;
        this.#compiled.delete(oldest);
        bytes -= Buffer.byteLength(removed.compiled.code);
      }
    } else {
      this.#compiled.delete(file);
      this.#compiled.set(file, cached);
    }
    const results = await this.#results(threadId, invocation.opening);
    const evaluated = readThreadComponentTree(
      await this.options.evaluate(cached.compiled, invocation.name, source, results, threadId, signal), { remoteImages: true },
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
