/*
 * No production exports. Protects that `mcp_call` text keeps every structured result field an agent needs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatMcpToolResult } from "./mcp-tool-search";

const authorization = { authorization_url: "https://example.test/authorize" };

test("structured fields beside a text sentence reach the agent", () => {
  const text = formatMcpToolResult({
    content: [{ type: "text", text: "The end user must click the link to authorize." }],
    structuredContent: authorization,
    isError: true,
  });
  assert.match(text, /click the link/);
  assert.match(text, /https:\/\/example\.test\/authorize/);
});

test("structured content mirrored as text prints once", () => {
  const text = formatMcpToolResult({
    content: [{ type: "text", text: JSON.stringify(authorization) }],
    structuredContent: authorization,
  });
  assert.equal(text.split("https://example.test/authorize").length - 1, 1);
});

test("structured-only results still print", () => {
  assert.match(formatMcpToolResult({ content: [], structuredContent: authorization }), /example\.test\/authorize/);
});
