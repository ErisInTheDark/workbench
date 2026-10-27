/*
 * Exports:
 * - mcpServers: daemon-configured external MCP servers, their transport and standing allow-all flag.
 * - mcpServerHttp: the URL of each streamable-HTTP server.
 * - mcpServerPackages: the Workbench-installed npm package and pinned version of each npm server.
 * - mcpServerCommands: the program each cli server runs.
 * - mcpServerLaunchArgs/mcpServerLaunchEnv: ordered arguments and sealed environment variables of each stdio (npm or cli) server.
 * - mcpServerProjects: the daemon project a project-scoped server belongs to.
 * - mcpThreadServers: server URLs agents connected for their current turn, with the user's approval.
 * - mcpServerTools: individually allowed tools per server.
 * - mcpServerAuth: optional per-server credential header, sealed per device and user.
 * - mcpServerOAuthClients/mcpServerOAuthTokens/mcpServerOAuthPending: OAuth sign-in registration, sealed tokens and started sign-ins awaiting their callback.
 * - mcpDownloads: files agents downloaded from server links, owned by the downloading thread until it settles.
 * - mcpServerSchemaHistory: MCP server settings and download schema.
 */
import {
  blob, booleanInteger, defineTable, enumText, evolveTable, integer, primaryKey, text, type SelectRow, type SqlFragment, type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, retireTableHistory, sqlData, tableVersion,
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

const serversV3 = evolveTable(serversV2, { drop: ["transport"], add: { transport: enumText("http", "npm", "cli").notNull() } });

/** The program a cli server runs; its arguments and environment live in the shared launch tables. */
const commands = defineTable("mcp_server_commands", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  command: text().notNull(),
});

/** Ordered arguments of a stdio (npm or cli) server's process. */
const launchArgs = defineTable("mcp_server_launch_args", {
  server_id: text().notNull().references(servers.name, "id", { onDelete: "CASCADE" }),
  position: integer().notNull().nonNegative(),
  value: text().notNull(),
}, table => ({ constraints: [primaryKey([table.server_id, table.position])] }));

/** One sealed environment variable of a stdio (npm or cli) server's process. */
const launchEnv = defineTable("mcp_server_launch_env", {
  server_id: text().notNull().references(servers.name, "id", { onDelete: "CASCADE" }),
  name: text().notNull(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.server_id, table.name])] }));

/** The one daemon project whose threads see a project-scoped server; servers without a row serve every project. */
const projects = defineTable("mcp_server_projects", {
  server_id: text().primaryKey().references(servers.name, "id", { onDelete: "CASCADE" }),
  project_id: text().notNull(),
});

/** An MCP server URL a thread's agent connected with the user's approval; removed when that thread's turn ends. */
const threadServers = defineTable("mcp_thread_servers", {
  thread_id: text().notNull(),
  name: text().notNull(),
  url: text().notNull(),
  created_at: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.thread_id, table.name])] }));

const serverHistory = defineTableHistory({
  current: serversV3,
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
    tableVersion({ schemaVersion: releases.mcpProjectServers.version, table: serversV3, migration: rebuildTable({ from: serversV2, to: serversV3 }) }),
  ],
});
const httpHistory = defineTableHistory({
  current: http,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackages.version, table: http, migration: createTable(http) })],
});
const packageHistory = defineTableHistory({
  current: packages,
  versions: [
    tableVersion({ schemaVersion: releases.mcpServerPackages.version, table: packages, migration: createTable(packages) }),
    // npm arguments and environment move to the launch tables cli servers share, before the package tables retire.
    tableVersion({
      schemaVersion: releases.mcpProjectServers.version, table: packages,
      migration: sqlData([
        "INSERT INTO mcp_server_launch_args (server_id, position, value) SELECT server_id, position, value FROM mcp_server_package_args",
        "INSERT INTO mcp_server_launch_env (server_id, name, nonce, ciphertext, updated_at) SELECT server_id, name, nonce, ciphertext, updated_at FROM mcp_server_package_env",
      ]),
    }),
  ],
});
const packageArgsHistory = retireTableHistory(defineTableHistory({
  current: packageArgs,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackages.version, table: packageArgs, migration: createTable(packageArgs) })],
}), releases.mcpProjectServers.version);
const packageEnvHistory = retireTableHistory(defineTableHistory({
  current: packageEnv,
  versions: [tableVersion({ schemaVersion: releases.mcpServerPackageEnv.version, table: packageEnv, migration: createTable(packageEnv) })],
}), releases.mcpProjectServers.version);
const created = <Table extends TableDefinition>(table: Table) => defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.mcpProjectServers.version, table, migration: createTable(table) })],
});
const commandHistory = created(commands);
const launchArgsHistory = created(launchArgs);
const launchEnvHistory = created(launchEnv);
const projectHistory = created(projects);
const threadServerHistory = created(threadServers);
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
export const mcpServerCommands = commandHistory.current;
export const mcpServerLaunchArgs = launchArgsHistory.current;
export const mcpServerLaunchEnv = launchEnvHistory.current;
export const mcpServerProjects = projectHistory.current;
export const mcpThreadServers = threadServerHistory.current;
export const mcpServerTools = toolHistory.current;
export const mcpServerAuth = authHistory.current;
export const mcpServerOAuthClients = oauthClientHistory.current;
export const mcpServerOAuthTokens = oauthTokenHistory.current;
export const mcpServerOAuthPending = oauthPendingHistory.current;
export const mcpDownloads = downloadHistory.current;
// Within one release, operations run in this order: transport tables exist before the server rebuild copies into them (102), and the
// launch tables exist before the package table's copy into them, which runs before the retired package tables drop (104).
export const mcpServerSchemaHistory = defineSubsystemHistory([
  httpHistory, commandHistory, launchArgsHistory, launchEnvHistory, projectHistory, packageHistory, packageArgsHistory, packageEnvHistory,
  serverHistory, toolHistory, authHistory, oauthClientHistory, oauthTokenHistory, oauthPendingHistory, downloadHistory, threadServerHistory,
]);
