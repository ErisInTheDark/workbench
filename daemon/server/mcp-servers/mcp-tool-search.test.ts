/*
 * No production exports. Protects that `mcp_call` text keeps every structured result field an agent needs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatMcpToolListing, formatMcpToolResult } from "./mcp-tool-search";

test("a wrapped server's own search matches are listed first, in its order, even without local term hits", () => {
  const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object" } });
  const text = formatMcpToolListing([
    { server: "composio", status: "ready", search: true, tools: [
      { tool: tool("GOOGLEDRIVE_DOWNLOAD_FILE", "Downloads a Drive file's content."), allowed: false, ranked: true },
      { tool: tool("GOOGLEDRIVE_FIND_FILE", "Search Drive."), allowed: false, ranked: true },
    ] },
    { server: "docs", status: "ready", tools: [{ tool: tool("EXPORT_DOC", "Export a doc as markdown."), allowed: false }] },
  ], "export doc markdown", true);
  const order = [...text.matchAll(/^(\w+)\/(\w+)$/gmu)].map(match => match[2]);
  assert.deepEqual(order, ["GOOGLEDRIVE_DOWNLOAD_FILE", "GOOGLEDRIVE_FIND_FILE", "EXPORT_DOC"]);
});

test("a query-less listing says which servers are search-based", () => {
  const text = formatMcpToolListing([{ server: "composio", status: "ready", search: true, tools: [] }], undefined);
  assert.match(text, /composio is search-based/u);
});

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

test("structured content wrapping a mirrored array in its only field prints once", () => {
  const matches = [{ tool: "export", url: "https://example.test/one" }];
  const text = formatMcpToolResult({ content: [{ type: "text", text: JSON.stringify(matches) }], structuredContent: { matches } });
  assert.equal(text.split("https://example.test/one").length - 1, 1);
});

test("structured-only results still print", () => {
  assert.match(formatMcpToolResult({ content: [], structuredContent: authorization }), /example\.test\/authorize/);
});
