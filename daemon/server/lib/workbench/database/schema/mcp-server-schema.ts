/*
 * Exports:
 * - mcpServers: daemon-configured external MCP servers and their standing allow-all flag.
 * - mcpServerTools: individually allowed tools per server.
 * - mcpServerAuth: optional per-server credential header, sealed per device and user.
 * - mcpServerOAuthClients/mcpServerOAuthTokens/mcpServerOAuthPending: OAuth sign-in registration, sealed tokens and started sign-ins awaiting their callback.
 * - mcpDownloads: files agents downloaded from server links, owned by the downloading thread until it settles.
 * - mcpServerSchemaHistory: MCP server settings and download schema.
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

/** The dynamically registered client for the redirect URI of its latest sign-in. */
const oauthClients = defineTable("mcp_server_oauth_clients", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  redirect_uri: text().notNull(),
  client_id: text().notNull(),
  secret_nonce: blob(),
  secret_ciphertext: blob(),
});

const oauthTokens = defineTable("mcp_server_oauth_tokens", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  token_type: text().notNull(),
  access_nonce: blob().notNull(),
  access_ciphertext: blob().notNull(),
  refresh_nonce: blob(),
  refresh_ciphertext: blob(),
  expires_at: integer().nonNegative(),
  scope: text(),
  updated_at: integer().notNull().nonNegative(),
});

/** One started sign-in awaiting its provider callback, keyed by its OAuth state. */
const oauthPending = defineTable("mcp_server_oauth_pending", {
  state: text().primaryKey(),
  server_id: text().notNull().references(servers.name, "id", { onDelete: "CASCADE" }),
  redirect_uri: text().notNull(),
  verifier_nonce: blob().notNull(),
  verifier_ciphertext: blob().notNull(),
  created_at: integer().notNull().nonNegative(),
});

const oauthClientHistory = defineTableHistory({
  current: oauthClients,
  versions: [tableVersion({ schemaVersion: releases.mcpServerOAuth.version, table: oauthClients, migration: createTable(oauthClients) })],
});
const oauthTokenHistory = defineTableHistory({
  current: oauthTokens,
  versions: [tableVersion({ schemaVersion: releases.mcpServerOAuth.version, table: oauthTokens, migration: createTable(oauthTokens) })],
});
const oauthPendingHistory = defineTableHistory({
  current: oauthPending,
  versions: [tableVersion({ schemaVersion: releases.mcpServerOAuth.version, table: oauthPending, migration: createTable(oauthPending) })],
});

/** One file an agent downloaded from a link an MCP server sent; it lives until its thread settles. */
const downloads = defineTable("mcp_downloads", {
  id: text().primaryKey(),
  thread_id: text().notNull(),
  directory: text().notNull(),
  created_at: integer().notNull().nonNegative(),
});
const downloadHistory = defineTableHistory({
  current: downloads,
  versions: [tableVersion({ schemaVersion: releases.mcpDownloads.version, table: downloads, migration: createTable(downloads) })],
});

export const mcpServers = serverHistory.current;
export const mcpServerTools = toolHistory.current;
export const mcpServerAuth = authHistory.current;
export const mcpServerOAuthClients = oauthClientHistory.current;
export const mcpServerOAuthTokens = oauthTokenHistory.current;
export const mcpServerOAuthPending = oauthPendingHistory.current;
export const mcpDownloads = downloadHistory.current;
export const mcpServerSchemaHistory = defineSubsystemHistory([
  serverHistory, toolHistory, authHistory, oauthClientHistory, oauthTokenHistory, oauthPendingHistory, downloadHistory,
]);
