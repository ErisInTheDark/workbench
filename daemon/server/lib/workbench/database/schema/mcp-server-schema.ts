/*
 * Exports:
 * - mcpServers: daemon-configured external MCP servers, their transport and standing allow-all flag.
 * - mcpServerHttp: the URL of each streamable-HTTP server.
 * - mcpServerPackages/mcpServerPackageArgs/mcpServerPackageEnv: the Workbench-installed npm package, pinned version, ordered arguments and
 *   sealed environment variables of each stdio server.
 * - mcpServerTools: individually allowed tools per server.
 * - mcpServerAuth: optional per-server credential header, sealed per device and user.
 * - mcpServerOAuthClients/mcpServerOAuthTokens/mcpServerOAuthPending: OAuth sign-in registration, sealed tokens and started sign-ins awaiting their callback.
 * - mcpDownloads: files agents downloaded from server links, owned by the downloading thread until it settles.
 * - mcpServerSchemaHistory: MCP server settings and download schema.
 */
import {
  blob, booleanInteger, defineTable, enumText, evolveTable, integer, primaryKey, text, type SelectRow, type SqlFragment,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, sqlData, tableVersion,
} from "workbench-shared/database/schema/schema-history";
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

const serversV2 = evolveTable(servers, { drop: ["url"], add: { transport: enumText("http", "npm").notNull() } });

const http = defineTable("mcp_server_http", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  url: text().notNull(),
});

/** A stdio server Workbench installs from npm under its data root; `version` is the requested one until the first install pins it. */
const packages = defineTable("mcp_server_packages", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  package: text().notNull(),
  version: text().notNull(),
});

const packageArgs = defineTable("mcp_server_package_args", {
  server_id: text().notNull().references(packages.name, "server_id", { onDelete: "CASCADE" }),
  position: integer().notNull().nonNegative(),
  value: text().notNull(),
}, table => ({ constraints: [primaryKey([table.server_id, table.position])] }));

/** One environment variable of a stdio server's process, sealed like the header credential. */
const packageEnv = defineTable("mcp_server_package_env", {
  server_id: text().notNull().references(packages.name, "server_id", { onDelete: "CASCADE" }),
  name: text().notNull(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.server_id, table.name])] }));

const serverHistory = defineTableHistory({
  current: serversV2,
  versions: [
    tableVersion({ schemaVersion: releases.mcpServers.version, table: servers, migration: createTable(servers) }),
    tableVersion({
      schemaVersion: releases.mcpServerPackages.version,
      table: serversV2,
      migration: [
        sqlData(["INSERT INTO mcp_server_http (server_id, url) SELECT id, url FROM mcp_servers"]),
        rebuildTable({
          from: servers, to: serversV2,
          map: ({ expression }) => ({ transport: expression.text`'http'` as SqlFragment<SelectRow<typeof serversV2>["transport"]> }),
        }),
      ],
    }),
  ],
});
const httpHistory = defineTableHistory({
  current: http,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackages.version, table: http, migration: createTable(http) })],
});
const packageHistory = defineTableHistory({
  current: packages,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackages.version, table: packages, migration: createTable(packages) })],
});
const packageArgsHistory = defineTableHistory({
  current: packageArgs,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackages.version, table: packageArgs, migration: createTable(packageArgs) })],
});
const packageEnvHistory = defineTableHistory({
  current: packageEnv,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackageEnv.version, table: packageEnv, migration: createTable(packageEnv) })],
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
export const mcpServerHttp = httpHistory.current;
export const mcpServerPackages = packageHistory.current;
export const mcpServerPackageArgs = packageArgsHistory.current;
export const mcpServerPackageEnv = packageEnvHistory.current;
export const mcpServerTools = toolHistory.current;
export const mcpServerAuth = authHistory.current;
export const mcpServerOAuthClients = oauthClientHistory.current;
export const mcpServerOAuthTokens = oauthTokenHistory.current;
export const mcpServerOAuthPending = oauthPendingHistory.current;
export const mcpDownloads = downloadHistory.current;
// Transport tables come first: within one release, the server rebuild copies each URL into an already-created table.
export const mcpServerSchemaHistory = defineSubsystemHistory([
  httpHistory, packageHistory, packageArgsHistory, packageEnvHistory, serverHistory, toolHistory, authHistory, oauthClientHistory, oauthTokenHistory, oauthPendingHistory, downloadHistory,
]);
