/*
 * Exports:
 * - OpenCodeWireToolInput: exact native tool identity and streamed argument evidence.
 * - default OpenCodeToolStream: decode file-tool evidence from supported model wire protocols.
 */
export type OpenCodeWireToolInput =
  | { kind: "start"; id: string; tool: string }
  | { kind: "delta" | "replace"; id: string; text: string };

interface PendingTool { id: string; tool: string; started: boolean; text: string }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
const fileTools = new Set(["patch", "edit", "write"]);

export default class OpenCodeToolStream {
  private readonly calls = new Map<string, PendingTool>();
  private readonly decoders: Record<string, (event: Record<string, unknown>) => void> = {
    content_block_start: event => {
      const block = record(event.content_block);
      if (block?.type !== "tool_use") return;
      this.start(`anthropic:${event.index}`, block.id, block.name);
    },
    content_block_delta: event => {
      const delta = record(event.delta);
      if (delta?.type === "input_json_delta") this.input(`anthropic:${event.index}`, delta.partial_json);
    },
    "response.output_item.added": event => {
      const item = record(event.item);
      if (item?.type !== "function_call" || typeof item.id !== "string") return;
      this.start(item.id, item.call_id, item.name);
      if (item.arguments) this.input(item.id, item.arguments);
    },
    "response.function_call_arguments.delta": event => {
      if (typeof event.item_id === "string") this.input(event.item_id, event.delta);
    },
    "response.function_call_arguments.done": event => {
      if (typeof event.item_id === "string") this.input(event.item_id, event.arguments, true);
    },
    "response.output_item.done": event => {
      const item = record(event.item);
      if (item?.type !== "function_call" || typeof item.id !== "string") return;
      this.start(item.id, item.call_id, item.name);
      this.input(item.id, item.arguments, true);
    },
  };

  constructor(private readonly emit: (input: OpenCodeWireToolInput) => void) {}

  accept(value: unknown) {
    const event = record(value);
    if (!event) return;
    if (typeof event.type === "string") {
      this.decoders[event.type]?.(event);
      return;
    }
    if (!Array.isArray(event.choices)) return;
    for (const choiceValue of event.choices) {
      const choice = record(choiceValue);
      const delta = record(choice?.delta);
      if (!Array.isArray(delta?.tool_calls)) continue;
      for (const toolValue of delta.tool_calls) {
        const call = record(toolValue);
        const fn = record(call?.function);
        if (!call || typeof call.index !== "number") continue;
        const key = `chat:${choice?.index ?? 0}:${call.index}`;
        this.start(key, call.id, fn?.name);
        this.input(key, fn?.arguments);
      }
    }
  }

  private start(key: string, id: unknown, name: unknown) {
    const call = this.calls.get(key) ?? { id: "", tool: "", started: false, text: "" };
    if (typeof id === "string") call.id = id;
    if (typeof name === "string") call.tool = name;
    this.calls.set(key, call);
    if (!call.started && call.id && fileTools.has(call.tool)) {
      call.started = true;
      this.emit({ kind: "start", id: call.id, tool: call.tool });
      if (call.text) this.emit({ kind: "delta", id: call.id, text: call.text });
    }
  }

  private input(key: string, text: unknown, replace = false) {
    if (typeof text !== "string" || (!text && !replace)) return;
    const call = this.calls.get(key);
    if (!call) return;
    if (call.tool && !fileTools.has(call.tool)) return;
    if (replace && text === call.text) return;
    call.text = replace ? text : call.text + text;
    if (call.text.length > 8 * 1024 * 1024) throw new Error("Tool preview exceeds observation capacity.");
    if (call.started) this.emit({ kind: replace ? "replace" : "delta", id: call.id, text });
  }
}
