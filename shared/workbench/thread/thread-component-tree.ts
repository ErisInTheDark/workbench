/*
 * Exports:
 * - ThreadComponentValue: serializable component property or child data.
 * - ThreadComponentNode: one native or kit element emitted by a component template.
 * - ThreadCompiledComponentSchema/ThreadCompiledComponent: compiled template code and input files.
 * - ThreadComponentStyleSchema/ThreadComponentStyle: one active skill's compiled styles.
 * - ThreadComponentStyleBuildSchema/ThreadCompiledStyleSchema/ThreadCompiledStyle: stylesheet build input and output.
 * - ThreadComponentPreviewSchema/ThreadComponentPreview: rendered tree and styles for a standalone preview.
 * - readThreadComponentStyle/readThreadComponentPreview: validate component data.
 * - ThreadComponentTreeOptions/readThreadComponentTree: validate a rendered node tree; template output may name public images.
 * - listThreadComponentImageUrls/inlineThreadComponentImages: find a tree's public images, then replace them with data URLs.
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
export const ThreadComponentStyleSchema = z.object({
  path: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/u), css: z.string().max(6 * 1024 * 1024),
}).strict();
export type ThreadComponentStyle = z.infer<typeof ThreadComponentStyleSchema>;

const valueSchema: z.ZodType<ThreadComponentValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(valueSchema), z.record(z.string(), valueSchema),
]));
const nodeSchema = z.object({ $workbench: z.literal("element"), type: z.string().min(1), props: z.record(z.string(), valueSchema) }).strict();
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

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/iu;
/** Component links only ever leave Workbench; relative and fragment links would navigate its own tab. */
const EXTERNAL_LINK = /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/iu;
const REMOTE_IMAGE_URL =/^https:\/\/[^\s"'()\\]+$/u;
const CSS_URL = /url\s*\(\s*([^)]*)\)/giu;
const STYLE_KEYS = ["color", "fill", "stroke", "filter", "mask", "clipPath", "cursor"];
const isStyleKey = (key: string) => /style$/iu.test(key) || STYLE_KEYS.includes(key);
const unquote = (raw: string) => raw.trim().replace(/^(['"])([\s\S]*)\1$/u, "$2").trim();

/** Template output may name public https images; they only ever load through the daemon, proxied live or inlined when kept. */
export interface ThreadComponentTreeOptions {
  remoteImages?: boolean;
}

function validateCss(value: string, options: ThreadComponentTreeOptions = {}): void {
  const css = normalizedCss(value);
  if (/@import\b|(?:-webkit-)?image-set\s*\(/iu.test(css)) throw new Error("Component styles cannot fetch remote resources.");
  const urls = [...css.matchAll(CSS_URL)];
  if ((css.match(/url\s*\(/giu)?.length ?? 0) !== urls.length) throw new Error("Invalid component style URL.");
  for (const match of urls) {
    const url = unquote(match[1]!);
    if (!/^#[A-Za-z0-9_.:-]+$/u.test(url) && !IMAGE_DATA_URL.test(url) && !(options.remoteImages && REMOTE_IMAGE_URL.test(url))) {
      throw new Error("Component styles cannot fetch remote resources.");
    }
  }
}

function validateValue(value: ThreadComponentValue, options: ThreadComponentTreeOptions, style = false): void {
  if (typeof value === "string") {
    if (style) validateCss(value, options);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, options, style);
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
      if (lower === "src" && typeof item === "string" && !IMAGE_DATA_URL.test(item)
        && !(options.remoteImages && value.type === "img" && REMOTE_IMAGE_URL.test(item))) {
        throw new Error("Component images cannot fetch remote resources.");
      }
      if (lower === "href" || lower === "xlinkhref") {
        if (value.type !== "a" || typeof item !== "string" || !EXTERNAL_LINK.test(item)) {
          throw new Error("Component links must be absolute https, http or mailto URLs on <a>.");
        }
      }
      if (value.type === "a" && ["target", "rel", "download"].includes(lower)) {
        throw new Error(`Unsupported component property: ${key}`);
      }
      validateValue(item, options, style || isStyleKey(key));
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    validateValue(item, options, style || isStyleKey(key));
  }
}

function replaceImages(value: ThreadComponentValue, resolve: (url: string) => string | null, style: boolean): ThreadComponentValue {
  if (typeof value === "string") {
    if (!style || !/url\s*\(/iu.test(value)) return value;
    return normalizedCss(value).replace(CSS_URL, (match, raw: string) => {
      const url = unquote(raw);
      if (!REMOTE_IMAGE_URL.test(url)) return match;
      const inlined = resolve(url);
      return inlined ? `url("${inlined}")` : "none";
    });
  }
  if (Array.isArray(value)) return value.map(item => replaceImages(item, resolve, style));
  if (!value || typeof value !== "object") return value;
  const image = value.$workbench === "element" && value.type === "img";
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (key === "props" && image && item && typeof item === "object" && !Array.isArray(item)
      && typeof item.src === "string" && REMOTE_IMAGE_URL.test(item.src)) {
      const inlined = resolve(item.src);
      const { src: _src, ...rest } = item;
      return [[key, replaceImages(inlined ? { ...rest, src: inlined } : rest, resolve, style)]];
    }
    return [[key, replaceImages(item, resolve, style || isStyleKey(key))]];
  }));
}

/** Every public https image a tree names, in `img src` or style `url()`, for the daemon to fetch. */
export function listThreadComponentImageUrls(tree: ThreadComponentNode): string[] {
  const urls = new Set<string>();
  replaceImages({ ...tree }, url => { urls.add(url); return url; }, false);
  return [...urls];
}

/** Swap each public https image for its inlined data URL, dropping images that could not be fetched; the result is strict. */
export function inlineThreadComponentImages(tree: ThreadComponentNode, images: ReadonlyMap<string, string | null>): ThreadComponentNode {
  return readThreadComponentTree(replaceImages({ ...tree }, url => images.get(url) ?? null, false));
}

export function readThreadComponentTree(value: unknown, options: ThreadComponentTreeOptions = {}): ThreadComponentNode {
  const result = conformToZodSchema(nodeSchema, value);
  if (!result.success || result.discardedPaths.length || result.repairedPaths.length) {
    throw new Error("Component output must be a serializable element tree.");
  }
  validateValue(result.data, options);
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
