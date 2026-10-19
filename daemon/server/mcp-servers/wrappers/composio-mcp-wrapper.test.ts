/*
 * No production exports. Real (trimmed) Composio replies protect how its meta tools unwrap into inner tools: search
 * mapping with schema references, direct results and failures, sessions, and sign-in links for missing connections.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import composioMcpWrapper from "./composio-mcp-wrapper";

const reply = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
const signal = () => new AbortController().signal;
const DOWNLOAD_SCHEMA = { type: "object", required: ["fileId"], properties: { fileId: { type: "string" }, mime_type: { type: "string" } } };
const REVISIONS_SCHEMA = { type: "object", required: ["fileId"], properties: { fileId: { type: "string" } } };

function fake(replies: Record<string, (args: Record<string, unknown>) => CallToolResult>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const session = composioMcpWrapper.open(async (name, args) => {
    calls.push({ name, args });
    const answer = replies[name];
    if (!answer) throw new Error(`unexpected ${name}`);
    return answer(args);
  });
  return { session, calls };
}

test("Composio is recognised by its search, schema and execute meta tools", () => {
  const tools = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL"]
    .map(name => ({ name, description: "", inputSchema: {} }));
  assert.equal(composioMcpWrapper.detect(tools), true);
  assert.equal(composioMcpWrapper.detect(tools.slice(1)), false);
});

test("search returns inner tools in Composio's order, resolving schema references, and keeps the session", async () => {
  const { session, calls } = fake({
    COMPOSIO_SEARCH_TOOLS: () => reply({ successful: true, data: {
      results: [{ primary_tool_slugs: ["GOOGLEDRIVE_DOWNLOAD_FILE"], related_tool_slugs: ["GOOGLEDRIVE_LIST_REVISIONS"] }],
      tool_schemas: {
        GOOGLEDRIVE_DOWNLOAD_FILE: { tool_slug: "GOOGLEDRIVE_DOWNLOAD_FILE", description: "Downloads a Drive file's content.", input_schema: DOWNLOAD_SCHEMA, hasFullSchema: true },
        GOOGLEDRIVE_LIST_REVISIONS: { tool_slug: "GOOGLEDRIVE_LIST_REVISIONS", description: "Tool to list...", hasFullSchema: false,
          schemaRef: { tool: "COMPOSIO_GET_TOOL_SCHEMAS", args: { tool_slugs: ["GOOGLEDRIVE_LIST_REVISIONS"] } } },
      },
      session: { id: "work" },
    } }),
    COMPOSIO_GET_TOOL_SCHEMAS: () => reply({ successful: false, data: {
      tool_schemas: { GOOGLEDRIVE_LIST_REVISIONS: { tool_slug: "GOOGLEDRIVE_LIST_REVISIONS", description: "Tool to list a file's revision metadata.", input_schema: REVISIONS_SCHEMA } },
      not_found: [],
    } }, true),
  });
  const tools = await session.search("export a google doc", signal());
  assert.deepEqual(tools, [
    { name: "GOOGLEDRIVE_DOWNLOAD_FILE", title: null, description: "Downloads a Drive file's content.", inputSchema: DOWNLOAD_SCHEMA },
    { name: "GOOGLEDRIVE_LIST_REVISIONS", title: null, description: "Tool to list a file's revision metadata.", inputSchema: REVISIONS_SCHEMA },
  ]);
  assert.deepEqual(calls[0]?.args.session, { generate_id: true });
  assert.deepEqual(calls[1]?.args, { tool_slugs: ["GOOGLEDRIVE_LIST_REVISIONS"], session_id: "work" });
});

test("describe drops slugs Composio does not know, even when it reports the lookup as failed", async () => {
  const { session } = fake({
    COMPOSIO_GET_TOOL_SCHEMAS: () => reply({ successful: false, data: {
      tool_schemas: { GOOGLEDRIVE_LIST_REVISIONS: { tool_slug: "GOOGLEDRIVE_LIST_REVISIONS", description: "d", input_schema: REVISIONS_SCHEMA } },
      not_found: ["NOPE"],
    }, error: "Some tools were not found" }, true),
  });
  assert.deepEqual((await session.describe(["GOOGLEDRIVE_LIST_REVISIONS", "NOPE"], signal())).map(tool => tool.name), ["GOOGLEDRIVE_LIST_REVISIONS"]);
});

test("Composio's own meta tools are never described, even when enabled earlier", async () => {
  const { session, calls } = fake({
    COMPOSIO_GET_TOOL_SCHEMAS: () => reply({ data: { tool_schemas: {
      COMPOSIO_SEARCH_TOOLS: { tool_slug: "COMPOSIO_SEARCH_TOOLS", description: "meta", input_schema: REVISIONS_SCHEMA },
      GOOGLEDRIVE_LIST_REVISIONS: { tool_slug: "GOOGLEDRIVE_LIST_REVISIONS", description: "d", input_schema: REVISIONS_SCHEMA },
    } } }),
  });
  assert.deepEqual(await session.describe(["COMPOSIO_MULTI_EXECUTE_TOOL"], signal()), []);
  assert.equal(calls.length, 0, "a meta-only lookup never reaches Composio");
  assert.deepEqual((await session.describe(["COMPOSIO_SEARCH_TOOLS", "GOOGLEDRIVE_LIST_REVISIONS"], signal())).map(tool => tool.name), ["GOOGLEDRIVE_LIST_REVISIONS"]);
  assert.deepEqual(calls[0]?.args.tool_slugs, ["GOOGLEDRIVE_LIST_REVISIONS"]);
});

test("a call returns the inner tool's own response, failing when it reports failure", async () => {
  const { session, calls } = fake({
    COMPOSIO_MULTI_EXECUTE_TOOL: args => {
      const slug = (args.tools as { tool_slug: string }[])[0]!.tool_slug;
      return reply({ successful: true, data: {
        results: [{ response: slug === "OK" ? { successful: true, data: { s3url: "https://files.example.test/x" } } : { successful: false, error: "bad id" }, tool_slug: slug, index: 0 }],
      } });
    },
  });
  const ok = await session.call("OK", { fileId: "1" }, signal());
  assert.equal(ok.isError, false);
  assert.deepEqual(JSON.parse((ok.content[0] as { text: string }).text), { successful: true, data: { s3url: "https://files.example.test/x" } });
  assert.deepEqual(calls[0]?.args, { tools: [{ tool_slug: "OK", arguments: { fileId: "1" } }], sync_response_to_workbench: false });
  assert.equal((await session.call("BAD", {}, signal())).isError, true);
});

test("a call without an active connection starts it and returns the sign-in link", async () => {
  const { session, calls } = fake({
    COMPOSIO_MULTI_EXECUTE_TOOL: () => reply({ successful: false, data: {
      results: [{ error: "No active connection found for toolkit(s) 'gmail' in this session. To fix this, call COMPOSIO_MANAGE_CONNECTIONS with toolkits=['gmail'] to establish a connection, then retry this tool call.", tool_slug: "GMAIL_FETCH_EMAILS", index: 0 }],
    }, error: "1 out of 1 tools failed" }, true),
    COMPOSIO_MANAGE_CONNECTIONS: () => reply({ successful: true, data: {
      results: { gmail: { toolkit: "gmail", status: "initiated", redirect_url: "https://connect.composio.dev/link/lk_test" } },
    } }),
  });
  const result = await session.call("GMAIL_FETCH_EMAILS", {}, signal());
  assert.equal(result.isError, true);
  const message = (result.content[0] as { text: string }).text;
  assert.match(message, /gmail: https:\/\/connect\.composio\.dev\/link\/lk_test/u);
  assert.doesNotMatch(message, /COMPOSIO_MANAGE_CONNECTIONS/u, "agents are not pointed at hidden meta tools");
  assert.deepEqual(calls[1]?.args.toolkits, [{ name: "gmail", action: "add" }]);
});
