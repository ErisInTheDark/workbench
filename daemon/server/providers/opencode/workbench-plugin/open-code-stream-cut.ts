/*
 * Exports:
 * - OpenCodeStreamCutTracker: per-response block tracking that decides when reasoning is the open block.
 * - openCodeStreamCutTracker: recognise a supported model wire from its first frame and track it.
 */

/**
 * One model response's block state. `cuttable` means the open block is reasoning and every earlier
 * block is complete, so ending the response with `terminator()` loses only unfinished reasoning.
 */
export interface OpenCodeStreamCutTracker {
  readonly wire: "openai-chat" | "anthropic-messages" | "gemini";
  observe(frame: Record<string, unknown>): void;
  readonly cuttable: boolean;
  /** Synthetic SSE frames that make OpenCode's parser finish this response with a known reason. */
  terminator(): string;
}

type Block = "reasoning" | "content";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function filled(value: unknown) {
  return (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);
}

function sse(value: object, event?: string) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
}

/** OpenAI chat-completions chunks, including OpenAI-compatible and OpenRouter routes. */
class OpenAIChatTracker implements OpenCodeStreamCutTracker {
  readonly wire = "openai-chat";
  private current: Block | null = null;
  private toolSeen = false;
  private finished = false;
  private identity: Record<string, unknown> = {};

  static sniff(frame: Record<string, unknown>) {
    return Array.isArray(frame.choices) && record(record(frame.choices[0])?.delta) !== null;
  }

  get cuttable() { return !this.finished && this.current === "reasoning"; }

  observe(frame: Record<string, unknown>) {
    for (const key of ["id", "object", "created", "model"] as const) {
      if (frame[key] !== undefined) this.identity[key] = frame[key];
    }
    if (!Array.isArray(frame.choices)) return;
    for (const value of frame.choices) {
      const choice = record(value);
      if (!choice) continue;
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) this.finished = true;
      const delta = record(choice.delta);
      if (!delta) continue;
      if (filled(delta.tool_calls)) this.toolSeen = true;
      if (filled(delta.content) || filled(delta.tool_calls)) this.current = "content";
      else if (filled(delta.reasoning_content) || filled(delta.reasoning) || filled(delta.reasoning_text)
        || filled(delta.reasoning_details)) this.current = "reasoning";
    }
  }

  terminator() {
    return sse({
      ...this.identity,
      choices: [{ index: 0, delta: {}, finish_reason: this.toolSeen ? "tool_calls" : "stop" }],
    }) + "data: [DONE]\n\n";
  }
}

/** Anthropic Messages events, including Anthropic-compatible routes. */
class AnthropicMessagesTracker implements OpenCodeStreamCutTracker {
  readonly wire = "anthropic-messages";
  private readonly open = new Map<number, Block>();
  private latest: number | null = null;
  private toolSeen = false;
  private finished = false;

  static sniff(frame: Record<string, unknown>) {
    return frame.type === "message_start" && record(frame.message) !== null;
  }

  get cuttable() {
    return !this.finished && this.latest !== null && this.open.size === 1 && this.open.get(this.latest) === "reasoning";
  }

  observe(frame: Record<string, unknown>) {
    const index = typeof frame.index === "number" ? frame.index : null;
    if (frame.type === "content_block_start" && index !== null) {
      const type = record(frame.content_block)?.type;
      if (type === "tool_use" || type === "server_tool_use") this.toolSeen = true;
      this.open.set(index, type === "thinking" || type === "redacted_thinking" ? "reasoning" : "content");
      this.latest = index;
    } else if (frame.type === "content_block_stop" && index !== null) {
      this.open.delete(index);
    } else if (frame.type === "message_stop" || (frame.type === "message_delta" && record(frame.delta)?.stop_reason)) {
      this.finished = true;
    }
  }

  terminator() {
    return sse({
      type: "message_delta",
      delta: { stop_reason: this.toolSeen ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }, "message_delta") + sse({ type: "message_stop" }, "message_stop");
  }
}

/** Gemini streamGenerateContent SSE chunks. Parts arrive whole, so the latest part is the open block. */
class GeminiTracker implements OpenCodeStreamCutTracker {
  readonly wire = "gemini";
  private current: Block | null = null;
  private finished = false;

  static sniff(frame: Record<string, unknown>) {
    return Array.isArray(frame.candidates) && record(frame.candidates[0]) !== null;
  }

  get cuttable() { return !this.finished && this.current === "reasoning"; }

  observe(frame: Record<string, unknown>) {
    if (!Array.isArray(frame.candidates)) return;
    const candidate = record(frame.candidates[0]);
    if (!candidate) return;
    if (candidate.finishReason !== null && candidate.finishReason !== undefined) this.finished = true;
    const parts = record(candidate.content)?.parts;
    if (!Array.isArray(parts)) return;
    for (const value of parts) {
      const part = record(value);
      if (!part) continue;
      if (part.thought === true && filled(part.text)) this.current = "reasoning";
      else if (filled(part.text) || part.functionCall !== undefined || part.inlineData !== undefined) this.current = "content";
    }
  }

  terminator() {
    // OpenCode's Gemini parser finishes on stream end once a finish reason is known; STOP maps to tool calls itself.
    return sse({ candidates: [{ finishReason: "STOP" }] });
  }
}

const wires = [OpenAIChatTracker, AnthropicMessagesTracker, GeminiTracker];

/** Track a response whose first JSON frame positively identifies a supported wire; otherwise never cut it. */
export function openCodeStreamCutTracker(firstFrame: Record<string, unknown>): OpenCodeStreamCutTracker | null {
  const Wire = wires.find(candidate => candidate.sniff(firstFrame));
  if (!Wire) return null;
  const tracker = new Wire();
  tracker.observe(firstFrame);
  return tracker;
}
