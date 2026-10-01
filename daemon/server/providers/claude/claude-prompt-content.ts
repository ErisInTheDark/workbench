/*
 * Exports:
 * - ClaudeContentBlock/ClaudePromptContent: SDK user-message content; text-only prompts stay plain strings.
 * - claudePromptContent: translate submitted Workbench input into Claude prompt content, including images.
 * - prefixClaudePrompt: put Workbench context ahead of prompt content without disturbing attached images.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";

export type ClaudePromptContent = SDKUserMessage["message"]["content"];
export type ClaudeContentBlock = Exclude<ClaudePromptContent, string>[number];
type ClaudeImageBlock = Extract<ClaudeContentBlock, { type: "image" }>;
type ClaudeImageMediaType = Extract<ClaudeImageBlock["source"], { type: "base64" }>["media_type"];

const MEDIA_TYPES: Record<string, ClaudeImageMediaType> = {
  "image/png": "image/png", "image/jpeg": "image/jpeg", "image/gif": "image/gif", "image/webp": "image/webp",
};
const EXTENSION_MEDIA_TYPES: Record<string, ClaudeImageMediaType> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

function base64Image(mediaType: ClaudeImageMediaType, data: string): ClaudeImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function unsupportedImage(kind: string) {
  return new Error(`Claude cannot read ${kind} images; supported images are PNG, JPEG, GIF, and WebP.`);
}

function urlImage(url: string): ClaudeImageBlock {
  const data = /^data:([^;,]+);base64,(.*)$/u.exec(url);
  if (data) {
    const mediaType = MEDIA_TYPES[data[1]!.toLowerCase()];
    if (!mediaType) throw unsupportedImage(data[1]!);
    return base64Image(mediaType, data[2]!);
  }
  if (/^https?:\/\//iu.test(url)) return { type: "image", source: { type: "url", url } };
  throw new Error("Claude image input must be a base64 data URL or an http(s) URL.");
}

async function localImage(path: string): Promise<ClaudeImageBlock> {
  const extension = extname(path).toLowerCase();
  const mediaType = EXTENSION_MEDIA_TYPES[extension];
  if (!mediaType) throw unsupportedImage(extension || "extensionless");
  return base64Image(mediaType, (await readFile(path)).toString("base64"));
}

/** Adjacent text parts join with newlines, matching the text-only prompt Claude has always received. */
export async function claudePromptContent(parts: readonly WorkbenchUserInput[]): Promise<ClaudePromptContent> {
  const blocks: ClaudeContentBlock[] = [];
  const text = (value: string) => {
    const last = blocks.at(-1);
    if (last?.type === "text") blocks[blocks.length - 1] = { type: "text", text: `${last.text}\n${value}` };
    else blocks.push({ type: "text", text: value });
  };
  for (const part of parts) {
    if (part.type === "text") text(part.text);
    else if (part.type === "skill") text(`/${part.name}`);
    else if (part.type === "mention") text(`@${part.path}`);
    else if (part.type === "image") blocks.push(urlImage(part.url));
    else if (part.type === "localImage") blocks.push(await localImage(part.path));
    else throw new Error(`Claude provider does not support ${part.type} input.`);
  }
  if (blocks.every(block => block.type === "text")) return blocks.map(block => block.text).join("\n");
  return blocks;
}

export function prefixClaudePrompt(prefix: string, content: ClaudePromptContent): ClaudePromptContent {
  if (typeof content === "string") return `${prefix}\n\n${content}`;
  const [first, ...rest] = content;
  return first?.type === "text"
    ? [{ ...first, text: `${prefix}\n\n${first.text}` }, ...rest]
    : [{ type: "text", text: prefix }, ...content];
}
