/*
 * Exports:
 * - mcpServers: daemon-configured external MCP servers and their standing allow-all flag.
 * - mcpServerTools: individually allowed tools per server.
 * - mcpServerAuth: optional per-server credential header, sealed per device and user.
 * - mcpServerSchemaHistory: MCP server settings schema.
 */
import { blob, booleanInteger, defineTable, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const servers = defineTable("mcp_servers", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  url: text().notNull(),
  allow_all: booleanInteger().notNull(),
  created_at: integer().notNull().nonNegative(),
});

const tools = defineTable("mcp_server_tools", {
  server_id: text().notNull().references(servers.name, "id", { onDelete: "CASCADE" }),
  tool_name: text().notNull(),
}, table => ({ constraints: [primaryKey([table.server_id, table.tool_name])] }));

const auth = defineTable("mcp_server_auth", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  header_name: text().notNull(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull().nonNegative(),
});

const serverHistory = defineTableHistory({
  current: servers,
  versions: [tableVersion({ schemaVersion: releases.mcpServers.version, table: servers, migration: createTable(servers) })],
});
const toolHistory = defineTableHistory({
  current: tools,
  versions: [tableVersion({ schemaVersion: releases.mcpServers.version, table: tools, migration: createTable(tools) })],
});
const authHistory = defineTableHistory({
  current: auth,
  versions: [tableVersion({ schemaVersion: releases.mcpServers.version, table: auth, migration: createTable(auth) })],
});

export const mcpServers = serverHistory.current;
export const mcpServerTools = toolHistory.current;
export const mcpServerAuth = authHistory.current;
export const mcpServerSchemaHistory = defineSubsystemHistory([serverHistory, toolHistory, authHistory]);
