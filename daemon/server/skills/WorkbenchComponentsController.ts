/*
 * Exports:
 * - WorkbenchComponentRenderInput: bundles and one request, rendered outside the browser for previews.
 * - WorkbenchMatcherTest: an MCP matcher test's report and component preview.
 * - WorkbenchComponentsOptions: skill, compilation, kept-result, image, kept-snapshot and preview ports.
 * - default WorkbenchComponentsController: compile active skills' extensions (matchers, one component bundle per skill,
 *   styles), each reused until an input it read changes; serve kept results and public images to components drawn in
 *   the browser; keep a component's snapshot while its inputs live; preview markup and test matchers against a call.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkbenchSkillDefinition } from "workbench-shared/types";
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";
import { listThreadComponentResultNames } from "workbench-shared/workbench/thread/thread-component-markup";
import { readThreadComponentStyle, readThreadComponentTree } from "workbench-shared/workbench/thread/thread-component-tree";
import type {
  ThreadCompiledComponent, ThreadCompiledStyle, ThreadComponentNode, ThreadComponentPreview, ThreadComponentStyle,
} from "workbench-shared/workbench/thread/thread-component-tree";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import {
  SkillComponentBundleSchema, type SkillComponentBundle, type SkillComponentRequest, type SkillComponentTarget,
  type SkillExtensionFailure, type SkillExtensions,
} from "workbench-shared/workbench/skills/skill-component-contract";
import {
  SkillMcpMatcherBundleSchema, type SkillMcpCall, type SkillMcpIcon, type SkillMcpMatcherBundle, type SkillMcpPart,
} from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import SkillMcpMatcherRuntime, { type SkillMcpMatch } from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import { readSkillComponentPaths, resolveSkillComponents, type SkillComponent } from "../lib/workbench/skills/skill-components";
import { resolveSkillMcpMatchers } from "../lib/workbench/skills/skill-mcp-matchers";
import { fetchComponentImages, inlineComponentImages, type ComponentImageFetch } from "./component-images";

const MAX_COMPILED_CACHE_BYTES = 16 * 1024 * 1024;

function formatPart(part: SkillMcpPart) {
  if (typeof part === "string") return part;
  if ("code" in part) return `\`${part.code}\``;
  if ("primary" in part) return part.primary;
  if ("path" in part) return part.path;
  if ("component" in part) return `<${part.component}> (${part.text})`;
  return `thread ${part.thread}`;
}

function formatIcon(icon: SkillMcpIcon) {
  if (typeof icon === "string") return `${icon} icon`;
  const { mode = "stroke", paths, viewBox = "0 0 24 24" } = icon.svg;
  return `svg icon (${paths.length} path${paths.length === 1 ? "" : "s"}, viewBox ${viewBox}, ${mode})`;
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
    ...presentation.icon ? [`  icon:    ${formatIcon(presentation.icon)}`] : [],
    ...presentation.chip ? [`  chip:    ${presentation.chip.verb} (${formatIcon(presentation.chip.icon)})`] : [],
    ...presentation.component ? [`  component: ${presentation.component}${presentation.props ? ` with props ${JSON.stringify(presentation.props)}` : ""}`] : [],
  ].join("\n");
}

const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

export interface WorkbenchComponentRenderInput {
  bundles: readonly SkillComponentBundle[];
  request: SkillComponentRequest;
}

/** What `wb vis match` reports: every skill's say about the call, and its component rendered for a screenshot. */
export interface WorkbenchMatcherTest {
  report: string;
  preview: string | null;
}

export interface WorkbenchComponentsOptions {
  skills(threadId: string): Promise<readonly WorkbenchSkillDefinition[]>;
  /** One skill's components as one bundle script, compiled in one run. */
  compileComponents(components: readonly { name: string; file: string }[], root: string, threadId: string): Promise<ThreadCompiledComponent>;
  compileStyles(files: string[], threadId: string, skillRoot: string): Promise<ThreadCompiledStyle>;
  compileMatchers(files: readonly string[], root: string, threadId: string): Promise<ThreadCompiledComponent>;
  /** Renders one request from bundles, as the browser would, for previews. */
  render?(input: WorkbenchComponentRenderInput, threadId: string, signal?: AbortSignal): Promise<ThreadComponentNode>;
  /** The thread's kept MCP result for each name it has; missing names are absent. */
  results?(threadId: string, names: readonly string[]): Promise<Record<string, unknown>>;
  fetchImage?: ComponentImageFetch;
  preview?(result: ThreadComponentPreview, threadId: string, signal?: AbortSignal): Promise<string>;
  quickjs?(): Promise<QuickJSWASMModule>;
  readKept(threadId: string, target: SkillComponentTarget): Promise<ThreadComponentNode | null>;
  writeKept(threadId: string, target: SkillComponentTarget, tree: ThreadComponentNode): Promise<ThreadComponentNode>;
}

export default class WorkbenchComponentsController {
  readonly #compiled = new Map<string, { compiled: ThreadCompiledComponent; fingerprint: string }>();
  readonly #styles = new Map<string, { files: string; inputs: string[]; fingerprint: string; style: ThreadComponentStyle }>();
  readonly #styleFlights = new Map<string, Promise<ThreadComponentStyle | null>>();

  constructor(private readonly options: WorkbenchComponentsOptions) {}

  /** Every active skill's matchers, components and styles; one skill's failing part never hides the rest. */
  async extensions(threadId: string): Promise<SkillExtensions> {
    const skills = await this.options.skills(threadId);
    const failures: SkillExtensionFailure[] = [];
    const attempt = async <Value>(skill: WorkbenchSkillDefinition, kind: SkillExtensionFailure["kind"], build: () => Promise<Value | null>) => {
      try { return await build(); }
      catch (error) {
        failures.push({ skillName: skill.name, skillPath: skill.path, kind, message: failureMessage(error) });
        return null;
      }
    };
    const outcomes = await Promise.all(skills.map(async skill => await Promise.all([
      attempt(skill, "matchers", () => this.#matcherBundle(skill, threadId)),
      attempt(skill, "components", () => this.#componentBundle(skill, threadId)),
      attempt(skill, "styles", () => this.#style(skill, threadId)),
    ] as const)));
    return {
      matchers: outcomes.flatMap(([matcher]) => matcher ? [matcher] : []),
      components: outcomes.flatMap(([, bundle]) => bundle ? [bundle] : []),
      styles: outcomes.flatMap(([, , style]) => style ? [style] : []),
      failures,
    };
  }

  async results(threadId: string, names: readonly string[]): Promise<Record<string, unknown>> {
    if (!this.options.results) throw new Error("Kept MCP results are unavailable.");
    return await this.options.results(threadId, names);
  }

  async images(urls: readonly string[], signal?: AbortSignal): Promise<Record<string, string | null>> {
    return Object.fromEntries(await fetchComponentImages(urls, this.#fetchImage(), signal));
  }

  /** Keeps the first tree a target shows, its images inlined, so it still draws once its inputs expire. */
  async keep(threadId: string, target: SkillComponentTarget, tree: unknown): Promise<void> {
    const inlined = await this.#inline(readThreadComponentTree(tree, { remoteImages: true }));
    await this.options.writeKept(threadId, target, inlined);
  }

  async kept(threadId: string, target: SkillComponentTarget): Promise<ThreadComponentNode | null> {
    return await this.options.readKept(threadId, target);
  }

  async previewMarkup(threadId: string, markup: string, signal?: AbortSignal): Promise<string> {
    const names = listThreadComponentResultNames(markup);
    const results = names.length ? await this.results(threadId, names) : {};
    return await this.#preview(threadId, { kind: "markup", markup, results }, signal);
  }

  /** Run active skills' matchers on one call as the client would, then render the named component for a screenshot. */
  async testMatcher(threadId: string, call: SkillMcpCall, signal?: AbortSignal): Promise<WorkbenchMatcherTest> {
    const skills = await this.options.skills(threadId);
    const outcomes = await Promise.all(skills.map(async skill => {
      try { return { skill, bundle: await this.#matcherBundle(skill, threadId) }; }
      catch (error) { return { skill, error: failureMessage(error) }; }
    }));
    signal?.throwIfAborted();
    const bundles = outcomes.flatMap(outcome => "bundle" in outcome && outcome.bundle ? [outcome.bundle] : []);
    const lines = outcomes.flatMap(outcome => "error" in outcome ? [`Skill ${outcome.skill.name} matchers failed to compile:\n${outcome.error}`] : []);
    if (!bundles.length) {
      lines.push(lines.length ? "No other active skill has MCP matchers." : "No active skill has MCP matchers.");
      return { report: `${lines.join("\n\n")}\n`, preview: null };
    }
    if (!this.options.quickjs) throw new Error("Matcher tests are unavailable.");
    const runtime = new SkillMcpMatcherRuntime(await this.options.quickjs(), bundles);
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
    const props = await this.#withKeptResult(threadId, { ...match.presentation.props, call });
    const preview = await this.#preview(threadId, { kind: "props", skillPath: match.skillPath, component, props }, signal);
    return { report: `${lines.join("\n\n")}\n`, preview };
  }

  async #preview(threadId: string, request: SkillComponentRequest, signal?: AbortSignal) {
    if (!this.options.preview || !this.options.render) throw new Error("Component preview is unavailable.");
    const skills = await this.options.skills(threadId);
    const [bundles, styles] = await Promise.all([
      Promise.all(skills.map(skill => this.#componentBundle(skill, threadId))),
      Promise.all(skills.map(skill => this.#style(skill, threadId))),
    ]);
    signal?.throwIfAborted();
    const tree = await this.options.render({ bundles: bundles.filter(bundle => bundle !== null), request }, threadId, signal);
    const css = [...new Set(styles.map(style => style?.css ?? ""))].filter(Boolean).join("\n");
    return await this.options.preview({ tree: await this.#inline(tree, signal), css }, threadId, signal);
  }

  /** A call that kept its result under a name previews with that kept result, not the stub its inline answer carried. */
  async #withKeptResult(threadId: string, props: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const call = props.call;
    const keep = call && typeof call === "object" && !Array.isArray(call) && typeof call.keep === "string" ? call.keep : null;
    if (!call || typeof call !== "object" || Array.isArray(call) || !keep || !this.options.results) return props;
    const kept = await this.options.results(threadId, [keep]);
    // Kept results are the JSON an MCP call returned.
    return Object.hasOwn(kept, keep) ? { ...props, call: { ...call, result: kept[keep] as JsonValue } } : props;
  }

  #fetchImage(): ComponentImageFetch {
    return this.options.fetchImage ?? (async () => { throw new Error("Component images are unavailable."); });
  }

  async #inline(tree: ThreadComponentNode, signal?: AbortSignal) {
    return await inlineComponentImages(tree, this.#fetchImage(), signal);
  }

  /** A skill's declared components that exist; a missing file leaves out only itself. */
  async #declaredComponents(skill: WorkbenchSkillDefinition): Promise<SkillComponent[]> {
    const components: SkillComponent[] = [];
    for (const declared of readSkillComponentPaths(skill.content)) {
      const normalized = declared.replaceAll("\\", "/");
      const name = path.posix.basename(normalized, path.posix.extname(normalized));
      try {
        components.push(...await resolveSkillComponents(skill.path, skill.content, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return components;
  }

  async #componentBundle(skill: WorkbenchSkillDefinition, threadId: string): Promise<SkillComponentBundle | null> {
    const components = await this.#declaredComponents(skill);
    if (!components.length) return null;
    const files = components.map(component => component.path);
    const compiled = await this.#cached(`components\0${skill.path}\0${files.join("\0")}`, files, () => this.options.compileComponents(
      components.map(({ name, path: file }) => ({ name, file })), components[0]!.root, threadId,
    ));
    return SkillComponentBundleSchema.parse({
      skillName: skill.name, skillPath: skill.path, components: components.map(component => component.name),
      code: compiled.code, revision: createHash("sha256").update(compiled.code).digest("hex"),
    });
  }

  async #matcherBundle(skill: WorkbenchSkillDefinition, threadId: string): Promise<SkillMcpMatcherBundle | null> {
    const resolved = await resolveSkillMcpMatchers(skill.path, skill.content);
    if (!resolved) return null;
    const compiled = await this.#cached(`matchers\0${skill.path}\0${resolved.files.join("\0")}`, resolved.files,
      () => this.options.compileMatchers(resolved.files, resolved.root, threadId));
    return SkillMcpMatcherBundleSchema.parse({
      skillName: skill.name, skillPath: skill.path, code: compiled.code, revision: createHash("sha256").update(compiled.code).digest("hex"),
    });
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
    const components = await this.#declaredComponents(skill);
    const files = components.map(component => component.path);
    const root = components.at(-1)?.root ?? path.dirname(skill.path);
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
  async #cached(key: string, sources: readonly string[], compile: () => Promise<ThreadCompiledComponent>) {
    let cached = this.#compiled.get(key);
    if (cached) {
      try {
        if (await this.#fingerprint(cached.compiled.inputs) !== cached.fingerprint) cached = undefined;
      } catch {
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

  async #fingerprint(inputs: readonly string[]): Promise<string> {
    const hash = createHash("sha256");
    for (const file of [...inputs].sort()) {
      hash.update(file);
      hash.update(await readFile(file));
    }
    return hash.digest("hex");
  }
}
