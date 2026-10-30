/*
 * Exports:
 * - SKILL_MCP_CHIP_ICONS/SkillMcpChipIcon: icons a skill chip may name.
 * - SKILL_MCP_MATCHER_LIMITS: per-call deadline, runtime memory and output bounds for sandboxed matchers.
 * - SkillMcpCallSchema/SkillMcpCall: one MCP call as a matcher sees it.
 * - SkillMcpPartSchema/SkillMcpPart: one summary part a matcher returns.
 * - SkillMcpDisplaySchema/SkillMcpDisplay: where a matched call draws: a run step, hidden, or a stitched card.
 * - SkillMcpPresentationSchema/SkillMcpPresentation: everything one matcher says about one call.
 * - SkillMcpMatcherBundleSchema/SkillMcpMatcherBundle: one active skill's compiled matcher.
 * - SkillMcpMatcherCompilationSchema/SkillMcpMatcherCompilation: a thread's matcher bundles and compile failures.
 * - SkillMcpComponentPropsSchema/SkillMcpComponentRenderInputSchema: props for a call's skill component and its render input.
 */
import { z } from "zod";
import { ThreadCompiledComponentSchema } from "../thread/thread-component-tree";
import type { JsonValue } from "../thread/workbench-thread-items";

export const SKILL_MCP_CHIP_ICONS = [
  "terminal", "file", "search", "book", "folder", "eye", "git", "arc", "skill", "browser", "web", "image",
] as const;
export type SkillMcpChipIcon = typeof SKILL_MCP_CHIP_ICONS[number];

export const SKILL_MCP_MATCHER_LIMITS = {
  /** One match call; a matcher answering slower is treated as stuck. */
  callDeadlineMs: 25,
  /** First evaluation of a bundle, which defines its matcher. */
  loadDeadlineMs: 250,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  outputChars: 16_000,
  bundleChars: 2 * 1024 * 1024,
  componentPropsChars: 4 * 1024 * 1024,
} as const;

const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));

export const SkillMcpCallSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: jsonValue,
  /** The name the call kept its result under (`mcp_call` `keep`); its component then receives that kept result. */
  keep: z.string().nullable(),
  /** Null when only the invocation is known, as for `wb mcp call` commands summarised from their text. */
  status: z.enum(["inProgress", "completed", "failed"]).nullable(),
  error: z.string().nullable(),
  /** Structured content, else the joined text content; null while running, after expiry, or with nothing inline. */
  result: jsonValue.nullable(),
}).strict();
export type SkillMcpCall = z.infer<typeof SkillMcpCallSchema>;

const text = z.string().max(500);
export const SkillMcpPartSchema = z.union([
  text,
  z.object({ code: text }).strict(),
  z.object({ primary: text }).strict(),
  z.object({ path: text }).strict(),
  z.object({ thread: text }).strict(),
]);
export type SkillMcpPart = z.infer<typeof SkillMcpPartSchema>;

const familyId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
export const SkillMcpDisplaySchema = z.union([
  z.enum(["step", "hidden"]),
  z.object({ card: familyId, open: z.boolean().optional() }).strict(),
]);
export type SkillMcpDisplay = z.infer<typeof SkillMcpDisplaySchema>;

export const SkillMcpPresentationSchema = z.object({
  verb: z.tuple([z.string().min(1).max(40), z.string().min(1).max(40)]),
  summary: z.array(SkillMcpPartSchema).max(32).default([]),
  chip: z.object({ id: familyId, verb: z.string().min(1).max(32), icon: z.enum(SKILL_MCP_CHIP_ICONS) }).strict().optional(),
  display: SkillMcpDisplaySchema.default("step"),
  component: z.string().regex(/^[A-Z][A-Za-z0-9_]*$/u).optional(),
  props: z.record(z.string(), jsonValue).optional(),
}).strict();
export type SkillMcpPresentation = z.infer<typeof SkillMcpPresentationSchema>;

export const SkillMcpMatcherBundleSchema = z.object({
  skillPath: z.string().min(1),
  skillName: z.string().min(1),
  /** Changes exactly when the compiled code does. */
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  code: z.string().min(1).max(SKILL_MCP_MATCHER_LIMITS.bundleChars),
}).strict();
export type SkillMcpMatcherBundle = z.infer<typeof SkillMcpMatcherBundleSchema>;

/** Every active skill's matcher outcome: a bundle when it compiled, else why not. */
export const SkillMcpMatcherCompilationSchema = z.object({
  bundles: z.array(SkillMcpMatcherBundleSchema),
  failures: z.array(z.object({ skillName: z.string(), skillPath: z.string(), message: z.string().max(4_000) }).strict()),
}).strict();
export type SkillMcpMatcherCompilation = z.infer<typeof SkillMcpMatcherCompilationSchema>;

/** A call component receives the call as `call`, beside any props its matcher added. */
export const SkillMcpComponentPropsSchema = z.record(z.string(), jsonValue)
  .refine(props => JSON.stringify(props).length <= SKILL_MCP_MATCHER_LIMITS.componentPropsChars, "Component props are too large.");

export const SkillMcpComponentRenderInputSchema = z.object({
  compiled: ThreadCompiledComponentSchema,
  props: SkillMcpComponentPropsSchema,
}).strict();
