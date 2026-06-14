/*
 * Exports:
 * - MAX_THREAD_COMMAND_OUTPUT_CHARS: upper bound for command output kept in memory and transcript files. Keywords: codex, thread, command output.
 * - compactCommandOutput: keep recent command output with an omission marker when output gets too large. Keywords: codex, thread, command output.
 * - appendCommandOutputDelta: append live command output while preserving the compacted-output marker. Keywords: codex, thread, command output.
 * - compactCommandExecutionItemOutput: compact a command execution thread item without changing other item types. Keywords: codex, thread, command output.
 * - compactCommandOutputPayload: compact command output recursively inside raw transcript payloads. Keywords: codex, transcript, command output.
 */
import type { ThreadItem } from "./generated/app-server/v2/ThreadItem";

export const MAX_THREAD_COMMAND_OUTPUT_CHARS = 96_000;

const COMMAND_OUTPUT_OMITTED_MARKER = "[Workbench omitted earlier command output to keep the thread responsive.]\n";
const MAX_THREAD_COMMAND_OUTPUT_BODY_CHARS = MAX_THREAD_COMMAND_OUTPUT_CHARS - COMMAND_OUTPUT_OMITTED_MARKER.length;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripCommandOutputOmittedMarker(value: string) {
  return value.startsWith(COMMAND_OUTPUT_OMITTED_MARKER)
    ? value.slice(COMMAND_OUTPUT_OMITTED_MARKER.length)
    : value;
}

function compactCommandOutputBody(value: string) {
  return value.length > MAX_THREAD_COMMAND_OUTPUT_BODY_CHARS
    ? value.slice(-MAX_THREAD_COMMAND_OUTPUT_BODY_CHARS)
    : value;
}

export function compactCommandOutput(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const hadOmittedMarker = value.startsWith(COMMAND_OUTPUT_OMITTED_MARKER);
  const body = stripCommandOutputOmittedMarker(value);
  if (!hadOmittedMarker && body.length <= MAX_THREAD_COMMAND_OUTPUT_CHARS) {
    return value;
  }

  return `${COMMAND_OUTPUT_OMITTED_MARKER}${compactCommandOutputBody(body)}`;
}

export function appendCommandOutputDelta(current: string | null | undefined, delta: string) {
  const hadOmittedMarker = current?.startsWith(COMMAND_OUTPUT_OMITTED_MARKER) ?? false;
  const nextBody = `${current ? stripCommandOutputOmittedMarker(current) : ""}${delta}`;
  if (!hadOmittedMarker && nextBody.length <= MAX_THREAD_COMMAND_OUTPUT_CHARS) {
    return nextBody;
  }

  return `${COMMAND_OUTPUT_OMITTED_MARKER}${compactCommandOutputBody(nextBody)}`;
}

export function compactCommandExecutionItemOutput(item: ThreadItem): ThreadItem {
  if (item.type !== "commandExecution") {
    return item;
  }

  const aggregatedOutput = compactCommandOutput(item.aggregatedOutput);
  return aggregatedOutput === item.aggregatedOutput
    ? item
    : { ...item, aggregatedOutput };
}

function compactCommandOutputRecord(record: Record<string, unknown>) {
  let changed = false;
  const nextRecord: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === "aggregatedOutput" && record.type === "commandExecution") {
      const compactedOutput = typeof nestedValue === "string"
        ? compactCommandOutput(nestedValue)
        : nestedValue;
      nextRecord[key] = compactedOutput;
      changed ||= compactedOutput !== nestedValue;
      continue;
    }

    if (key === "params" && isRecord(nestedValue) && record.method === "item/commandExecution/outputDelta") {
      const compactedDelta = typeof nestedValue.delta === "string"
        ? compactCommandOutput(nestedValue.delta)
        : nestedValue.delta;
      const nextParams = compactedDelta === nestedValue.delta
        ? compactCommandOutputPayload(nestedValue)
        : compactCommandOutputPayload({ ...nestedValue, delta: compactedDelta });
      nextRecord[key] = nextParams;
      changed ||= nextParams !== nestedValue;
      continue;
    }

    if (key === "delta" && typeof nestedValue === "string" && record.method === "item/commandExecution/outputDelta") {
      const compactedDelta = compactCommandOutput(nestedValue);
      nextRecord[key] = compactedDelta;
      changed ||= compactedDelta !== nestedValue;
      continue;
    }

    const result = compactCommandOutputPayload(nestedValue);
    nextRecord[key] = result;
    changed ||= result !== nestedValue;
  }

  return changed ? nextRecord : record;
}

export function compactCommandOutputPayload<TValue>(value: TValue): TValue {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const nextItems = value.map((item) => {
      const result = compactCommandOutputPayload(item);
      changed ||= result !== item;
      return result;
    });
    return (changed ? nextItems : value) as TValue;
  }

  if (!isRecord(value)) {
    return value;
  }

  return compactCommandOutputRecord(value) as TValue;
}
