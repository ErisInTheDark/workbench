/*
 * Exports:
 * - mcpResultLinks: every https link an MCP tool result carries, in text (including JSON-in-text), structured content and resources.
 * - matchesMcpResultLink: the sent link a candidate names, accepting the JSON-escaped form agents read from raw text.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const URL_PATTERN = /https:\/\/[^\s"'<>`)\]]+/gu;

function normalized(value: string) {
  try {
    const url = new URL(value.replaceAll("\\u0026", "&"));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function collectStrings(value: unknown, into: string[]) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, into);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) collectStrings(entry, into);
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function mcpResultLinks(result: CallToolResult) {
  const texts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text") {
      texts.push(part.text);
      collectStrings(parsedJson(part.text), texts);
    } else if (part.type === "resource_link") texts.push(part.uri);
    else if (part.type === "resource") texts.push(part.resource.uri, ..."text" in part.resource ? [part.resource.text] : []);
  }
  collectStrings(result.structuredContent, texts);
  const links = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(URL_PATTERN)) {
      // Prose ends links with sentence punctuation, and escaped JSON leaves the backslash of a closing `\"`.
      const link = normalized(match[0].replace(/[.,;:!?\\]+$/u, ""));
      if (link) links.add(link);
    }
  }
  return [...links];
}

export function matchesMcpResultLink(candidate: string, links: readonly string[]) {
  const link = normalized(candidate.trim());
  return link && links.includes(link) ? link : null;
}
