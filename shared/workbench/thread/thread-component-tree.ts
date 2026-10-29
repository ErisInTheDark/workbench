/*
 * Exports:
 * - ThreadComponentValue: serializable component property or child data.
 * - ThreadComponentNode: one native or kit element emitted by a component template.
 * - ThreadCompiledComponentSchema/ThreadCompiledComponent: compiled template code and input files.
 * - ThreadComponentStyleSchema/ThreadComponentStyle: one active skill's compiled styles.
 * - ThreadComponentStyleRevisionSchema/ThreadComponentStyleRevision: identify current skill styles.
 * - ThreadComponentStyleBuildSchema/ThreadCompiledStyleSchema/ThreadCompiledStyle: stylesheet build input and output.
 * - ThreadComponentRenderSchema/ThreadComponentRender: a rendered tree and current skill style revisions.
 * - ThreadComponentPreviewSchema/ThreadComponentPreview: rendered tree and styles for a standalone preview.
 * - readThreadComponentRender/readThreadComponentStyle/readThreadComponentPreview: validate component data.
 * - readThreadComponentTree: validate a component template's rendered node tree.
 */
import { z } from "zod";
import { conformToZodSchema } from "../zod-schema-conformer";

export type ThreadComponentValue = null | boolean | number | string | ThreadComponentValue[] | { [key: string]: ThreadComponentValue };
export interface ThreadComponentNode {
  $workbench: "element";
  type: string;
  props: Record<string, ThreadComponentValue>;
}

export const ThreadCompiledComponentSchema = z.object({
  code: z.string().min(1).max(6 * 1024 * 1024),
  inputs: z.array(z.string().min(1).max(4_000)).max(5_000),
}).strict();
export const ThreadComponentStyleBuildSchema = z.object({
  files: z.array(z.string().min(1)).min(1), root: z.string().min(1),
}).strict();
export const ThreadCompiledStyleSchema = z.object({
  css: z.string().max(6 * 1024 * 1024), inputs: z.array(z.string().min(1)).max(5_000),
}).strict();
export type ThreadCompiledComponent = z.infer<typeof ThreadCompiledComponentSchema>;
export type ThreadCompiledStyle = z.infer<typeof ThreadCompiledStyleSchema>;
export const ThreadComponentStyleRevisionSchema = z.object({
  path: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const ThreadComponentStyleSchema = ThreadComponentStyleRevisionSchema.extend({
  css: z.string().max(6 * 1024 * 1024),
}).strict();
export type ThreadComponentStyle = z.infer<typeof ThreadComponentStyleSchema>;
export type ThreadComponentStyleRevision = z.infer<typeof ThreadComponentStyleRevisionSchema>;

const valueSchema: z.ZodType<ThreadComponentValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(valueSchema), z.record(z.string(), valueSchema),
]));
const nodeSchema = z.object({ $workbench: z.literal("element"), type: z.string().min(1), props: z.record(z.string(), valueSchema) }).strict();
export const ThreadComponentRenderSchema = z.object({
  tree: nodeSchema,
  styleRevisions: z.array(ThreadComponentStyleRevisionSchema),
}).strict();
export type ThreadComponentRender = z.infer<typeof ThreadComponentRenderSchema>;
export const ThreadComponentPreviewSchema = z.object({
  tree: nodeSchema,
  css: z.string().max(6 * 1024 * 1024),
}).strict();
export type ThreadComponentPreview = z.infer<typeof ThreadComponentPreviewSchema>;
const nativeTags = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "button", "caption", "code", "dd", "del", "details", "div",
  "dl", "dt", "em", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i",
  "img", "input", "label", "legend", "li", "main", "mark", "meter", "nav", "ol", "optgroup", "option", "output", "p",
  "pre", "progress", "s", "section", "select", "small", "span", "strong", "sub", "summary", "textarea",
  "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul", "svg", "path", "circle", "rect", "line", "polyline",
  "polygon", "g", "defs", "linearGradient", "radialGradient", "stop", "title", "fragment",
]);

function normalizedCss(value: string) {
  return value.replace(/\\([a-f0-9]{1,6})(?:\r\n|[\t\n\f\r ])?/giu, (_, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\ufffd";
  }).replace(/\\\r?\n/gu, "").replace(/\\(.)/gu, "$1").replace(/\/\*[\s\S]*?\*\//gu, "");
}

function validateCss(value: string): void {
  const css = normalizedCss(value);
  if (/@import\b|(?:-webkit-)?image-set\s*\(/iu.test(css)) throw new Error("Component styles cannot fetch remote resources.");
  const urls = [...css.matchAll(/url\s*\(\s*([^)]*)\)/giu)];
  if ((css.match(/url\s*\(/giu)?.length ?? 0) !== urls.length) throw new Error("Invalid component style URL.");
  for (const match of urls) {
    const url = match[1]!.trim().replace(/^(['"])([\s\S]*)\1$/u, "$2").trim();
    if (!/^#[A-Za-z0-9_.:-]+$/u.test(url)
      && !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/iu.test(url)) {
      throw new Error("Component styles cannot fetch remote resources.");
    }
  }
}

function validateValue(value: ThreadComponentValue, style = false): void {
  if (typeof value === "string") {
    if (style) validateCss(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, style);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.$workbench === "element") {
    if (typeof value.type !== "string" || !value.props || typeof value.props !== "object" || Array.isArray(value.props)) {
      throw new Error("Invalid component element.");
    }
    if (!nativeTags.has(value.type) && value.type !== "workbench:markdown" && !/^kit:[A-Z][A-Za-z0-9_]*$/u.test(value.type)) {
      throw new Error(`Unsupported component element: ${value.type}`);
    }
    if (value.type === "workbench:markdown"
      && (typeof value.props.source !== "string" || !value.props.components
        || typeof value.props.components !== "object" || Array.isArray(value.props.components))) {
      throw new Error("Invalid component markdown.");
    }
    for (const [key, item] of Object.entries(value.props)) {
      if (/^on[a-z]/iu.test(key) || key === "dangerouslySetInnerHTML" || key === "srcDoc") {
        throw new Error(`Unsupported component property: ${key}`);
      }
      const lower = key.toLowerCase();
      if (["srcset", "poster", "background", "action", "formaction", "ping"].includes(lower)) {
        throw new Error(`Unsupported component property: ${key}`);
      }
      if (lower === "src" && typeof item === "string"
        && !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/iu.test(item)) {
        throw new Error("Component images cannot fetch remote resources.");
      }
      if ((lower === "href" || lower === "xlinkhref") && typeof item === "string") {
        if (/^\s*(?:javascript|vbscript|data):/iu.test(item.replace(/[\u0000-\u001f]/gu, ""))
          || (value.type !== "a" && !value.type.startsWith("kit:") && !item.startsWith("#"))) {
          throw new Error(`Unsafe component ${key}.`);
        }
      }
      const styleProperty = /style$/iu.test(key) || ["color", "fill", "stroke", "filter", "mask", "clipPath", "cursor"].includes(key);
      validateValue(item, style || styleProperty);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    validateValue(item, style || /style$/iu.test(key) || ["color", "fill", "stroke", "filter", "mask", "clipPath", "cursor"].includes(key));
  }
}

export function readThreadComponentTree(value: unknown): ThreadComponentNode {
  const result = conformToZodSchema(nodeSchema, value);
  if (!result.success || result.discardedPaths.length || result.repairedPaths.length) {
    throw new Error("Component output must be a serializable element tree.");
  }
  validateValue(result.data);
  return result.data;
}

export function readThreadComponentRender(value: unknown): ThreadComponentRender {
  const result = conformToZodSchema(ThreadComponentRenderSchema, value);
  if (!result.success || result.discardedPaths.length || result.repairedPaths.length) {
    throw new Error("Invalid rendered component.");
  }
  readThreadComponentTree(result.data.tree);
  return result.data;
}

export function readThreadComponentStyle(value: unknown): ThreadComponentStyle {
  const result = conformToZodSchema(ThreadComponentStyleSchema, value);
  if (!result.success || result.discardedPaths.length || result.repairedPaths.length) {
    throw new Error("Invalid component stylesheet.");
  }
  validateCss(result.data.css);
  return result.data;
}

export function readThreadComponentPreview(value: unknown): ThreadComponentPreview {
  const result = conformToZodSchema(ThreadComponentPreviewSchema, value);
  if (!result.success || result.discardedPaths.length || result.repairedPaths.length) {
    throw new Error("Invalid component preview.");
  }
  readThreadComponentTree(result.data.tree);
  validateCss(result.data.css);
  return result.data;
}
