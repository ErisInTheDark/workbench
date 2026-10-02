/*
 * Exports:
 * - CLAUDE_COMMENTARY_SERVER_NAME: in-process MCP server name that hosts the commentary tool.
 * - CLAUDE_COMMENTARY_TOOL_NAME: model-visible tool name whose `text` input becomes exact user-visible commentary.
 * - createClaudeCommentaryServer: build the stateless in-process MCP server for one Claude launch.
 * - readStreamedCommentaryText: decode the complete prefix of the top-level `text` string from partial tool-input JSON.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Claude replaces prose between tool calls with server summaries; tool input reaches us verbatim.
export const CLAUDE_COMMENTARY_SERVER_NAME = "user";
const TOOL = "message";
export const CLAUDE_COMMENTARY_TOOL_NAME = `mcp__${CLAUDE_COMMENTARY_SERVER_NAME}__${TOOL}`;

/** The transcript adapter owns the visible item from the streamed tool_use; the handler only acknowledges. */
export function createClaudeCommentaryServer() {
  return createSdkMcpServer({
    name: CLAUDE_COMMENTARY_SERVER_NAME,
    alwaysLoad: true,
    tools: [tool(
      TOOL,
      "Send the user a message they read exactly as written, streamed live. Use it for every ack, progress update, plan, brief, and review; text outside this tool is summarized away.",
      { text: z.string().describe("Markdown message, including any Workbench markup.") },
      async () => ({ content: [{ type: "text", text: "Message delivered to user." }] }),
      { annotations: { readOnlyHint: true } },
    )],
  });
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Decode the JSON string opening at `start`; `end` is null when the input stops first or turns invalid. */
function decodeString(source: string, start: number): { value: string; end: number | null } {
  let value = "";
  let index = start + 1;
  const hex = (at: number) => /^[0-9a-fA-F]{4}$/.test(source.slice(at, at + 4)) ? Number.parseInt(source.slice(at, at + 4), 16) : null;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"') return { value, end: index + 1 };
    if (char !== "\\") {
      // Hold back a trailing high surrogate until its pair arrives.
      if (isHighSurrogate(char.charCodeAt(0)) && index + 1 >= source.length) break;
      value += char;
      index += 1;
      continue;
    }
    const escape = source[index + 1];
    if (escape === undefined) break;
    if (escape !== "u") {
      const decoded = ESCAPES[escape];
      if (decoded === undefined) break;
      value += decoded;
      index += 2;
      continue;
    }
    const code = hex(index + 2);
    if (code === null) break;
    if (!isHighSurrogate(code)) {
      value += String.fromCharCode(code);
      index += 6;
      continue;
    }
    if (source.slice(index + 6, index + 8) !== "\\u") {
      if (index + 8 > source.length) break;
      value += String.fromCharCode(code);
      index += 6;
      continue;
    }
    const low = hex(index + 8);
    if (low === null) break;
    value += isLowSurrogate(low) ? String.fromCharCode(code, low) : String.fromCharCode(code);
    index += isLowSurrogate(low) ? 12 : 6;
  }
  return { value, end: null };
}

/** Skip one non-text JSON value; null when the input stops or turns invalid first. */
function skipValue(source: string, start: number): number | null {
  const first = source[start];
  if (first === '"') return decodeString(source, start).end;
  let index = start;
  if (first === "{" || first === "[") {
    let depth = 0;
    while (index < source.length) {
      const char = source[index]!;
      if (char === '"') {
        const { end } = decodeString(source, index);
        if (end === null) return null;
        index = end;
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return null;
  }
  // Numbers and literals end at the next delimiter, which must already have arrived.
  while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index += 1;
  return index < source.length ? index : null;
}

/**
 * Complete decoded prefix of the top-level `text` string in a partial JSON object. Fragments may split anywhere;
 * the result only ever grows as input arrives, so callers may append its new suffix.
 */
export function readStreamedCommentaryText(partialJson: string): string {
  const skipSpace = (at: number) => {
    while (at < partialJson.length && /\s/.test(partialJson[at]!)) at += 1;
    return at;
  };
  let index = skipSpace(0);
  if (partialJson[index] !== "{") return "";
  index += 1;
  for (;;) {
    index = skipSpace(index);
    if (partialJson[index] !== '"') return "";
    const key = decodeString(partialJson, index);
    if (key.end === null) return "";
    index = skipSpace(key.end);
    if (partialJson[index] !== ":") return "";
    index = skipSpace(index + 1);
    if (index >= partialJson.length) return "";
    if (key.value === "text") return partialJson[index] === '"' ? decodeString(partialJson, index).value : "";
    const end = skipValue(partialJson, index);
    if (end === null) return "";
    index = skipSpace(end);
    if (partialJson[index] !== ",") return "";
    index += 1;
  }
}
