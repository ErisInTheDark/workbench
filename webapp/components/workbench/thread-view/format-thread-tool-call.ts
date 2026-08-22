/*
 * Exports:
 * - formatMcpToolInvocation: format a recorded MCP call as the TypeScript invocation used by the tool harness. Keywords: MCP, tool call, TypeScript, arguments.
 * - formatDynamicToolInvocation: format a recorded dynamic-tool call as a qualified TypeScript invocation. Keywords: dynamic tool, TypeScript, arguments.
 * - formatToolCallOutput: prefer captured text while preserving structured tool output as readable JSON. Keywords: tool call, output, text, JSON.
 */
import type { JsonValue } from "../../../lib/codex/generated/app-server/serde_json/JsonValue";
import type { DynamicToolCallOutputContentItem } from "../../../lib/codex/generated/app-server/v2/DynamicToolCallOutputContentItem";

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function propertyAccess(base: string, property: string) {
  return IDENTIFIER_PATTERN.test(property)
    ? `${base}.${property}`
    : `${base}[${JSON.stringify(property)}]`;
}

function indentLines(value: string) {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function formatObjectKey(key: string) {
  return IDENTIFIER_PATTERN.test(key) ? key : JSON.stringify(key);
}

function formatTypescriptValue(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((entry) => `${indentLines(formatTypescriptValue(entry))},`).join("\n")}\n]`;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([key, entry]) => `${formatObjectKey(key)}: ${formatTypescriptValue(entry)}`)
    .map((line) => `${indentLines(line)},`)
    .join("\n")}\n}`;
}

function formatInvocation(callable: string, argumentsValue: JsonValue) {
  return `await ${callable}(${formatTypescriptValue(argumentsValue)})`;
}

export function formatMcpToolInvocation({
  argumentsValue,
  server,
  tool,
}: {
  argumentsValue: JsonValue;
  server: string;
  tool: string;
}) {
  return formatInvocation(propertyAccess("tools", `mcp__${server}__${tool}`), argumentsValue);
}

export function formatDynamicToolInvocation({
  argumentsValue,
  namespace,
  tool,
}: {
  argumentsValue: JsonValue;
  namespace: string | null;
  tool: string;
}) {
  const namespaceValue = namespace
    ? IDENTIFIER_PATTERN.test(namespace) ? namespace : propertyAccess("tools", namespace)
    : null;
  const callable = namespaceValue
    ? propertyAccess(namespaceValue, tool)
    : IDENTIFIER_PATTERN.test(tool) ? tool : propertyAccess("tools", tool);
  return formatInvocation(callable, argumentsValue);
}

function readMcpTextContent(value: JsonValue) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && value.type === "text"
    && typeof value.text === "string"
    ? value.text
    : null;
}

function formatStructuredOutput(value: JsonValue | readonly JsonValue[] | null | undefined) {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2) ?? "";
}

export function formatToolCallOutput({
  content,
  fallback,
}: {
  content?: readonly DynamicToolCallOutputContentItem[] | readonly JsonValue[] | null;
  fallback?: JsonValue | null;
}) {
  if (content?.length) {
    const dynamicText = content.map((entry) => (
      typeof entry === "object" && entry !== null && "type" in entry && entry.type === "inputText"
        ? entry.text
        : null
    ));
    const mcpText = content.map((entry) => readMcpTextContent(entry as JsonValue));
    const text = dynamicText.every((entry): entry is string => entry !== null)
      ? dynamicText.join("\n\n")
      : mcpText.every((entry): entry is string => entry !== null)
        ? mcpText.join("\n\n")
        : "";
    if (text.trim()) return text;
    return formatStructuredOutput(content as readonly JsonValue[]);
  }
  return formatStructuredOutput(fallback);
}
