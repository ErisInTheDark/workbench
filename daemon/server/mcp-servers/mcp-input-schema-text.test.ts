/* No production exports. Tests protect that tool input schemas read as TypeScript-like types without losing meaning. */
import assert from "node:assert/strict";
import test from "node:test";
import { formatMcpInputSchema } from "./mcp-input-schema-text";

test("required, optional, nullable, enum and constrained fields keep their meaning", () => {
  const text = formatMcpInputSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      name: { type: "string", description: "Who to greet." },
      phase: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }], default: null },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      mode: { const: "fast" },
    },
    required: ["name", "mode"],
    additionalProperties: false,
  });
  assert.match(text, /^Input: \{$/mu);
  assert.match(text, /^\s+name: string \/\/ Who to greet$/mu);
  assert.match(text, /^\s+phase\?: "a" \| "b" \| null \/\/ default null$/mu);
  assert.match(text, /^\s+limit\?: number \/\/ int, 1-50, default 20$/mu);
  assert.match(text, /^\s+mode: "fast"$/mu);
});

test("arrays, nested objects and records render as their element types", () => {
  const text = formatMcpInputSchema({
    type: "object",
    properties: {
      kinds: { type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 3 },
      inner: { type: "object", properties: { depth: { type: "number" } }, required: ["depth"] },
      labels: { type: "object", additionalProperties: { type: "string" } },
      "odd-key": { type: ["string", "null"] },
    },
  });
  assert.match(text, /^\s+kinds\?: \("x" \| "y"\)\[\] \/\/ max 3 items$/mu);
  assert.match(text, /^\s+inner\?: \{\n\s+depth: number\n\s+\}$/mu);
  assert.match(text, /^\s+labels\?: \{ \[key: string\]: string \}$/mu);
  assert.match(text, /^\s+"odd-key"\?: string \| null$/mu);
});

test("an argument-free tool reads as an empty object", () => {
  assert.equal(formatMcpInputSchema({ type: "object" }), "Input: {}");
});

test("schemas using unsupported keywords keep their exact JSON", () => {
  const schema = { type: "object", properties: { node: { $ref: "#/$defs/node" } }, $defs: { node: { type: "string" } } };
  assert.equal(formatMcpInputSchema(schema), `Input schema: ${JSON.stringify(schema)}`);
});
