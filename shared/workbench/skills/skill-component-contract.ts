/*
 * Exports:
 * - SKILL_COMPONENT_LIMITS: per-render deadline, runtime memory and nesting bounds for sandboxed skill components.
 * - SkillComponentBundleSchema/SkillComponentBundle: one active skill's compiled components as one sandbox-ready script.
 * - SkillComponentBuildSchema: one skill's component files to compile into a bundle.
 * - SkillComponentPropsSchema: props a component receives straight from a call or its line, bounded.
 * - SkillComponentRequestSchema/SkillComponentRequest: one render: an invocation in markdown, or a component from props.
 * - SkillComponentRenderInputSchema: bundles plus one request, for rendering outside the browser (previews).
 * - SkillComponentTargetSchema/SkillComponentTarget: the transcript item a component's kept snapshot belongs to.
 * - SkillExtensionFailure/SkillExtensionsSchema/SkillExtensions: a thread's active skills' matchers, components and
 *   styles, and why any failed to build.
 */
import { z } from "zod";
import type { JsonValue } from "../thread/workbench-thread-items";
import { ThreadComponentStyleSchema } from "../thread/thread-component-tree";
import { SkillMcpMatcherBundleSchema } from "./skill-mcp-matcher-contract";

export const SKILL_COMPONENT_LIMITS = {
  /** One render, including its nested invocations; generous because components parse big results. */
  renderDeadlineMs: 5_000,
  /** First evaluation of a bundle, which defines its components. */
  loadDeadlineMs: 1_000,
  /** Evaluating one invocation's attribute expressions. */
  propsDeadlineMs: 250,
  memoryBytes: 64 * 1024 * 1024,
  /** Below the host's own stack, so deep recursion stops inside the sandbox instead of corrupting it. */
  stackBytes: 256 * 1024,
  /** A component body can name further invocations; this bounds that recursion. */
  nestedDepth: 8,
  bundleChars: 6 * 1024 * 1024,
  propsChars: 4 * 1024 * 1024,
  markupChars: 16_000,
} as const;

const componentName = z.string().regex(/^[A-Z][A-Za-z0-9_]*$/u);
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));

export const SkillComponentBundleSchema = z.object({
  skillPath: z.string().min(1),
  skillName: z.string().min(1),
  /** Changes exactly when the compiled code does. */
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  components: z.array(componentName).min(1).max(256),
  code: z.string().min(1).max(SKILL_COMPONENT_LIMITS.bundleChars),
}).strict();
export type SkillComponentBundle = z.infer<typeof SkillComponentBundleSchema>;

export const SkillComponentBuildSchema = z.object({
  components: z.array(z.object({ name: componentName, file: z.string().min(1) }).strict()).min(1).max(256),
  root: z.string().min(1),
}).strict();

export const SkillComponentPropsSchema = z.record(z.string(), jsonValue)
  .refine(props => JSON.stringify(props).length <= SKILL_COMPONENT_LIMITS.propsChars, "Component props are too large.");

/** `results` holds the kept MCP results an invocation names as `"@result:<name>"`. */
export const SkillComponentRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("markup"), markup: z.string().min(1).max(SKILL_COMPONENT_LIMITS.markupChars),
    results: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({ kind: z.literal("props"), skillPath: z.string().min(1), component: componentName, props: SkillComponentPropsSchema }).strict(),
]);
export type SkillComponentRequest = z.infer<typeof SkillComponentRequestSchema>;

export const SkillComponentRenderInputSchema = z.object({
  bundles: z.array(SkillComponentBundleSchema),
  request: SkillComponentRequestSchema,
}).strict();

/** A message's invocation, or a call's own component; only components whose inputs expire keep a snapshot. */
export const SkillComponentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), itemId: z.string().min(1), markup: z.string().min(1).max(SKILL_COMPONENT_LIMITS.markupChars) }).strict(),
  z.object({ kind: z.literal("call"), itemId: z.string().min(1), skillPath: z.string().min(1), component: componentName }).strict(),
]);
export type SkillComponentTarget = z.infer<typeof SkillComponentTargetSchema>;

const failure = z.object({
  skillName: z.string(), skillPath: z.string(), kind: z.enum(["matchers", "components", "styles"]), message: z.string().max(4_000),
}).strict();
export type SkillExtensionFailure = z.infer<typeof failure>;

/** Every active skill's extensions in catalogue order; a part that failed to build reports why instead. */
export const SkillExtensionsSchema = z.object({
  matchers: z.array(SkillMcpMatcherBundleSchema),
  components: z.array(SkillComponentBundleSchema),
  styles: z.array(ThreadComponentStyleSchema),
  failures: z.array(failure),
}).strict();
export type SkillExtensions = z.infer<typeof SkillExtensionsSchema>;
