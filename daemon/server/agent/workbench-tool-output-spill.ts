/*
 * Exports:
 * - TOOL_OUTPUT_SPILL_TOKENS/TOOL_OUTPUT_PREVIEW_TOKENS: when a tool result spills, and how much of each end stays.
 * - spillToolResult: leave the model head, tail and a file path for a result over the limit, returning any other result unchanged.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { joinKeptEdges } from "../database/transcript/transcript-item-bounds.ts";
import BoundedShellOutput from "../exec/BoundedShellOutput.ts";
import { measureGpt5Tokens } from "../lib/workbench/commands/gpt-5-token-measure.ts";

export const TOOL_OUTPUT_SPILL_TOKENS = 8_000;
export const TOOL_OUTPUT_PREVIEW_TOKENS = 2_000;
/** Repeated characters reach eight per token, the most seen in any measured text, so anything longer is over without counting. */
const MAX_CHARS_PER_TOKEN = 8;
const FALLBACK_CHARS_PER_TOKEN = 3;

interface SpillOptions {
  save(text: string): Promise<{ path: string }>;
  signal?: AbortSignal | undefined;
}

async function oversized(text: string, signal: AbortSignal | undefined) {
  if (Buffer.byteLength(text, "utf8") <= TOOL_OUTPUT_SPILL_TOKENS) return false;
  if (text.length > TOOL_OUTPUT_SPILL_TOKENS * MAX_CHARS_PER_TOKEN) return true;
  try {
    return (await measureGpt5Tokens([text], { signal }))[0]!.tokens > TOOL_OUTPUT_SPILL_TOKENS;
  } catch (error) {
    signal?.throwIfAborted();
    return true;
  }
}

/** A cut inside a surrogate pair would leave half a character. */
function safeHeadEnd(text: string, end: number) {
  const unit = text.charCodeAt(end - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? end - 1 : end;
}

async function previewChars(sample: string, signal: AbortSignal | undefined) {
  try {
    const { tokens } = (await measureGpt5Tokens([sample], { signal }))[0]!;
    return tokens <= TOOL_OUTPUT_PREVIEW_TOKENS ? sample.length : Math.floor(sample.length * TOOL_OUTPUT_PREVIEW_TOKENS / tokens);
  } catch (error) {
    signal?.throwIfAborted();
    return Math.min(sample.length, TOOL_OUTPUT_PREVIEW_TOKENS * FALLBACK_CHARS_PER_TOKEN);
  }
}

/** Each end scales to its token budget from a sample, so previews are approximate and need no count of the whole text. */
async function keepEdges(text: string, detail: string, signal: AbortSignal | undefined) {
  const sampleChars = TOOL_OUTPUT_PREVIEW_TOKENS * MAX_CHARS_PER_TOKEN;
  const headEnd = safeHeadEnd(text, await previewChars(text.slice(0, sampleChars), signal));
  const tailChars = await previewChars(text.slice(-sampleChars), signal);
  let tailStart = Math.max(headEnd, text.length - tailChars);
  const unit = text.charCodeAt(tailStart);
  if (unit >= 0xdc00 && unit <= 0xdfff) tailStart += 1;
  if (tailStart <= headEnd) return text;
  return joinKeptEdges(text.slice(0, headEnd), text.slice(tailStart), tailStart - headEnd, detail);
}

function shellStreams(structured: CallToolResult["structuredContent"]) {
  return typeof structured?.stdout === "string" && typeof structured.stderr === "string"
    ? { stderr: structured.stderr, stdout: structured.stdout } : null;
}

/**
 * Only shell results declare an output schema, and code-mode providers read its fields instead of the text, so its streams are bounded in
 * place; any other tool's structured copy would carry the whole output past the preview, and goes. A failed save still answers the call.
 */
export async function spillToolResult(result: CallToolResult, { save, signal }: SpillOptions): Promise<CallToolResult> {
  const parts = result.content.flatMap(part => part.type === "text" ? [part.text] : []);
  const text = parts.join("\n");
  if (!await oversized(text, signal)) return result;
  const detail = await save(text).then(
    saved => BoundedShellOutput.hasGap(text)
      ? `. Saved output: ${saved.path}, with a gap of its own where the command printed too much to keep; read only the parts you need`
      : `. Full output: ${saved.path}; read only the parts you need`,
    (error: unknown) => {
      signal?.throwIfAborted();
      return `. The full output could not be saved: ${error instanceof Error ? error.message.slice(0, 200) : "unknown failure"}`;
    },
  );
  const preview = await keepEdges(text, detail, signal);
  const { structuredContent, ...rest } = result;
  const content = [...result.content.filter(part => part.type !== "text"), { type: "text" as const, text: preview }];
  const streams = shellStreams(structuredContent);
  if (!streams) return { ...rest, content };
  return {
    ...rest,
    content,
    structuredContent: {
      ...structuredContent,
      stderr: await keepEdges(streams.stderr, detail, signal),
      stdout: await keepEdges(streams.stdout, detail, signal),
    },
  };
}
