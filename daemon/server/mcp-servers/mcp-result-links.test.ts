/*
 * No production exports. Protects which links count as sent by an MCP server, so agents can only show the user links that server returned.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { matchesMcpResultLink, mcpResultLinks } from "./mcp-result-links";

const AUTH = "https://accounts.example.test/auth?client=1&state=abc";

test("links inside JSON text, plain text, structured content and resource links are all collected", () => {
  const links = mcpResultLinks({
    content: [
      { type: "text", text: JSON.stringify({ authorization_url: AUTH, message: "Sign in." }) },
      { type: "text", text: "Or read https://docs.example.test/help." },
      { type: "resource_link", uri: "https://files.example.test/a", name: "a" },
    ],
    structuredContent: { nested: { url: "https://structured.example.test/x" } },
  });
  for (const link of [AUTH, "https://docs.example.test/help", "https://files.example.test/a", "https://structured.example.test/x"]) {
    assert.ok(links.includes(new URL(link).href), link);
  }
});

test("only https links count", () => {
  assert.deepEqual(mcpResultLinks({ content: [{ type: "text", text: "http://plain.example.test javascript:alert(1)" }] }), []);
});

test("a candidate matches only a link the server sent, including its JSON-escaped form", () => {
  const links = mcpResultLinks({ content: [{ type: "text", text: JSON.stringify({ authorization_url: AUTH }) }] });
  assert.equal(matchesMcpResultLink(AUTH, links), new URL(AUTH).href);
  assert.equal(matchesMcpResultLink(AUTH.replace("&", "\\u0026"), links), new URL(AUTH).href);
  assert.equal(matchesMcpResultLink("https://accounts.example.test/auth?client=2&state=abc", links), null);
  assert.equal(matchesMcpResultLink("not a url", links), null);
});
