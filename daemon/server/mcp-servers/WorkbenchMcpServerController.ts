/*
 * Exports:
 * - WorkbenchMcpServerOptions: database, device identity, connection factory, project folder lookup, download and npm package install ports.
 * - McpServerCaller: the managed thread an agent operation comes from: its id, working directory and daemon project.
 * - McpServerCallOutcome: agent-facing text of one forwarded call and whether it failed.
 * - MCP_CALLER_META_KEY: the `_meta` key carrying the calling thread to project-scoped servers.
 * - default WorkbenchMcpServerController: single owner of MCP servers agents reach: user-configured ones (remote URLs, Workbench-installed
 *   npm packages or local cli commands; global or scoped to one project) with their allow rules, sealed header credentials and stdio
 *   environment variables, OAuth sign-ins, and per-turn thread servers agents connected with the user's approval; owns their live
 *   (meta-tool unwrapped) connections, recent raw traffic and connection lifetimes (project release, turn end, reload); answers
 *   settings reads/updates, stdio environment reads/updates, sign-in steps and agent tool listing, enable/connect requests, calls,
 *   requests to open or download links a server sent, and `wb debug mcp`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  McpServerEnvReadParamsSchema, McpServerEnvUpdateSchema, McpServerNameSchema, McpServerSettingsUpdateSchema, McpServerSignInFinishParamsSchema,
  McpServerSignInStartParamsSchema, McpServerUrlSchema, type McpServerEnvReadParams, type McpServerEnvSnapshot, type McpServerEnvUpdate,
  type McpServerSettingsReadParams, type McpServerSettingsSnapshot, type McpServerSettingsUpdate, type McpServerSignInFinishParams,
  type McpServerSignInFinishResult, type McpServerSignInStartParams, type McpServerSignInStartResult, type McpServerSnapshot,
  type McpServerSource, WORKBENCH_MCP_SERVER_NAME,
} from "workbench-shared/workbench/mcp/mcp-server-settings";
import {
  deleteRows, insertRow, selectRows, updateRows, upsertRow,
  type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import {
  mcpServerAuth, mcpServerCommands, mcpServerHttp, mcpServerLaunchArgs, mcpServerLaunchEnv, mcpServerOAuthClients, mcpServerOAuthPending,
  mcpServerOAuthTokens, mcpServerPackages, mcpServerProjects, mcpServers, mcpServerTools, mcpThreadServers,
} from "../lib/workbench/database/schema/mcp-server-schema";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "../store/project-store-crypto";
import WebSocketTrafficBuffer, { type WebSocketTrafficQuery } from "workbench-shared/process/WebSocketTrafficBuffer";
import McpServerConnection, {
  type McpServerConnectionPort, type McpServerEndpoint, type McpServerLaunch, type McpServerTool, type McpServerTrafficFrame,
} from "./McpServerConnection";
import McpServerOAuthProvider, { McpServerSignInRequiredError, type McpServerOAuthStore } from "./McpServerOAuthProvider";
import { formatMcpToolListing, formatMcpToolResult, type McpToolListing } from "./mcp-tool-search";
import { matchesMcpResultLink, mcpResultLinks } from "./mcp-result-links";
import type McpDownloadStore from "./McpDownloadStore";
import type McpPackageInstaller from "./McpPackageInstaller";
import WrappedMcpConnection from "./WrappedMcpConnection";

export interface WorkbenchMcpServerOptions {
  database: {
    executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
    query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  };
  readDeviceIdentity(): Promise<string>;
  connect?: (endpoint: McpServerEndpoint) => McpServerConnectionPort;
  /**
   * A daemon project's canonical id, its folder on this machine (where cli servers start for its threads) and its identity: folders
   * sharing an identity, such as clones of one repository, are one project to its servers. Absent where project servers are not offered.
   */
  resolveProject?: (projectId: string) => Promise<{ id: string; rootPath: string; identityKey: string | null }>;
  /** Fetches links servers sent; absent where downloads are not offered. */
  downloads?: Pick<McpDownloadStore, "download">;
  /** Installs and launches npm-packaged stdio servers; absent where they are not offered. */
  packages?: Pick<McpPackageInstaller, "state" | "install" | "launch" | "remove">;
  user?: () => string;
  homeDirectory?: () => string;
  now?: () => number;
}

export interface McpServerCaller {
  threadId: string;
  cwd: string;
  /** The daemon project the thread works in; null outside any project. */
  projectId: string | null;
}

export interface McpServerCallOutcome {
  text: string;
  isError: boolean;
}

export const MCP_CALLER_META_KEY = "workbench/caller";

type Scope = { kind: "global" } | { kind: "project"; projectId: string } | { kind: "thread"; threadId: string };

interface StoredServer {
  id: string;
  name: string;
  source: McpServerSource;
  scope: Scope;
  /** The folder (daemon project) a project-scoped cli server runs from for this use: the caller's, else the stored project's. */
  folderProjectId?: string;
  allowAll: boolean;
  allowedTools: string[];
  /** `value` is null when the credential was sealed on another device or OS user. */
  header: { name: string; value: string | null } | null;
  /** Redirect URI of the registered OAuth client, and whether tokens are stored. */
  oauth: { redirectUri: string | null; signedIn: boolean };
}

/** `search` marks a wrapped server: its tools are found by query, so `tools` holds only the enabled ones and `matches`. */
type Catalog =
  | { status: "ready"; tools: McpServerTool[]; search?: { matches: McpServerTool[] } }
  | { status: "signInRequired" }
  | { status: "error"; detail: string };

type SettingsCatalog = Catalog | { status: "pending" } | { status: "installing" };

type NpmSource = Extract<McpServerSource, { kind: "npm" }>;
type StdioSource = Extract<McpServerSource, { kind: "npm" | "cli" }>;

// Secrets are sealed with the project-store cipher, bound to this device, OS user, this scope and each secret's own key.
const SECRET_SCOPE = "mcp-servers";
const UNREADABLE_CREDENTIAL = "The saved credential can't be read on this device or OS user. Set it again.";
const unreadableEnv = (name: string) => `The saved ${name} can't be read on this device or OS user. Set it again in Launch settings.`;
const SIGN_IN_TTL_MS = 10 * 60_000;
const SENT_LINK_LIMIT = 20;
const LINK_HINT = "To open a link above for the user use wb/mcp_authorize; to fetch a file link use wb/mcp_download (both via mcp_call on server wb).\n";
const SIGN_IN_EXPIRED = "This sign-in has expired or was already used. Start sign-in again from Workbench settings.";
/** An agent-supplied server may send at most this much in one response. */
const THREAD_SERVER_MAX_RESPONSE_BYTES = 16 * 1_048_576;

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);
}

const NAME_LIMIT = 64;

/** A reported server name squashed to the agent-facing name characters, or null when nothing usable remains. */
function serverNameFrom(reported: string | null) {
  const name = (reported ?? "").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+|[-._]+$/gu, "").slice(0, NAME_LIMIT);
  return name || null;
}

/** The name a server keeps until it reports its own: its URL's hostname, package name, or program name. */
function fallbackName(source: McpServerSource) {
  const reported = source.kind === "http" ? new URL(source.url).hostname
    : source.kind === "npm" ? source.package
      : path.basename(source.command.replaceAll("\\", "/"), path.extname(source.command));
  return serverNameFrom(reported) ?? "mcp";
}

function httpUrl(server: StoredServer) {
  if (server.source.kind !== "http") throw new Error(`${server.name} runs locally; it takes no sign-in or API key.`);
  return server.source.url;
}

function stdioSource(server: StoredServer): StdioSource {
  if (server.source.kind === "http") throw new Error(`${server.name} is a remote server; it has no arguments or environment.`);
  return server.source;
}

function envKey(serverId: string, name: string) {
  return `${serverId}\0env\0${name}`;
}

function uniqueName(base: string, existing: readonly string[]) {
  const taken = [...existing, WORKBENCH_MCP_SERVER_NAME];
  if (!taken.includes(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function credentialKey(serverId: string, header: string) {
  return `${serverId}\0${header.toLowerCase()}`;
}

function threadServerId(threadId: string, name: string) {
  return `thread\0${threadId}\0${name}`;
}

/** The folder a project-scoped cli server runs from; each folder runs its own process, since each checkout holds its own code. */
function launchFolder(server: StoredServer) {
  return server.source.kind === "cli" && server.scope.kind === "project" ? server.folderProjectId ?? server.scope.projectId : null;
}

interface LiveConnection {
  serverId: string;
  connection: McpServerConnectionPort;
  scope: Scope;
  /** The folder a cli project server's process runs from; null for every other connection. */
  folderProjectId: string | null;
}

export default class WorkbenchMcpServerController {
  #secret: Promise<Buffer> | null = null;
  #nameAdoptions: Promise<void> = Promise.resolve();
  /** Keyed by server id, plus the folder for cli project servers. */
  readonly #connections = new Map<string, LiveConnection>();
  readonly #traffic = new WebSocketTrafficBuffer({ maxEntries: 500, maxBytes: 4 * 1024 * 1024 });
  /** Newest-first links each server sent in call replies; memory only, so a reload means calling again. */
  readonly #sentLinks = new Map<string, string[]>();

  constructor(private readonly options: WorkbenchMcpServerOptions) {}

  /** Recent raw JSON-RPC traffic with every server, labelled `<server> <method|result|error>`, for `wb debug mcp`. */
  traffic(query: WebSocketTrafficQuery) {
    return this.#traffic.query(query);
  }

  async read(params: McpServerSettingsReadParams = {}): Promise<McpServerSettingsSnapshot> {
    const servers = (await this.#servers()).filter(server => !params.id || server.id === params.id);
    if (params.id && !servers.length) throw new Error("That MCP server no longer exists.");
    const catalogs = await Promise.all(servers.map(server => this.#settingsCatalog(server, params)));
    const names = params.configuredOnly ? new Map<string, string>() : await this.#adoptServerNames(servers, catalogs);
    // A first launch pins the npm version it installed; show the pinned one.
    const sources = params.configuredOnly || !servers.some(server => server.source.kind === "npm")
      ? new Map<string, McpServerSource>()
      : new Map((await this.#servers()).map(server => [server.id, server.source]));
    return { servers: servers.map((server, index): McpServerSnapshot => {
      const catalog = catalogs[index]!;
      return {
        id: server.id, name: names.get(server.id) ?? server.name, source: sources.get(server.id) ?? server.source,
        projectId: server.scope.kind === "project" ? server.scope.projectId : null,
        allowAll: server.allowAll, allowedTools: server.allowedTools,
        auth: server.header ? { kind: "header", header: server.header.name } : server.oauth.signedIn ? { kind: "oauth" } : null,
        catalog: catalog.status === "ready"
          ? {
            status: "ready", tools: catalog.tools.map(tool => ({ name: tool.name, title: tool.title ?? null, description: tool.description })),
            ...catalog.search ? { search: true } : {},
          }
          : catalog,
      };
    }) };
  }

  /**
   * A settings read never waits on an npm install: an untargeted read reports it as installing (starting a missing one), and only a
   * targeted read of that server waits for it, the way an agent's use does.
   */
  async #settingsCatalog(server: StoredServer, params: McpServerSettingsReadParams): Promise<SettingsCatalog> {
    const install = server.source.kind === "npm" && !params.id ? this.#packages().state(server.id) : null;
    if (install?.state === "failed") return { status: "error", detail: install.detail.slice(0, 300) };
    if (install && install.state !== "installed") {
      if (install.state === "missing" && !params.configuredOnly) this.#packages().install(server.id, server.source as NpmSource);
      return { status: "installing" };
    }
    return params.configuredOnly ? { status: "pending" } : await this.#catalog(server);
  }

  /**
   * A server still named after its hostname, package or program (it could not report a name when added, e.g. before sign-in) takes
   * its reported name on its first successful connection. Names taken from the server never change again.
   */
  async #adoptServerNames(servers: readonly StoredServer[], catalogs: readonly SettingsCatalog[]) {
    const reported = await Promise.all(servers.map(async (server, index) =>
      catalogs[index]?.status === "ready" && server.name === fallbackName(server.source)
        ? serverNameFrom(await this.#connection(server).serverName().catch(() => null)) : null));
    if (!reported.some(Boolean)) return new Map<string, string>();
    const adoption = this.#nameAdoptions.then(async () => {
      const names = new Map<string, string>();
      const current = await this.#servers();
      const taken = current.map(server => server.name);
      for (const [index, server] of servers.entries()) {
        const storedIndex = current.findIndex(candidate => candidate.id === server.id);
        const stored = current[storedIndex];
        if (!stored) continue;
        names.set(server.id, stored.name);
        const candidate = reported[index];
        if (!candidate || candidate === stored.name || stored.name !== fallbackName(stored.source)) continue;
        const name = uniqueName(candidate, taken);
        await this.options.database.executeTransaction([updateRows(mcpServers, { name }, { id: server.id })]);
        taken[storedIndex] = name;
        names.set(server.id, name);
      }
      return names;
    });
    // Failed callers still receive their error; the name-allocation queue remains usable.
    this.#nameAdoptions = adoption.then(() => undefined, () => undefined);
    return adoption;
  }

  async update(input: McpServerSettingsUpdate): Promise<McpServerSettingsSnapshot> {
    const update = McpServerSettingsUpdateSchema.parse(input);
    const servers = await this.#servers();
    if (update.action === "add" || update.action === "addPackage" || update.action === "addCommand") {
      // Stored by canonical id, the one threads of that project resolve to.
      const scope: Scope = update.projectId
        ? { kind: "project", projectId: (await this.#projects()(update.projectId)).id } : { kind: "global" };
      if (update.action === "add") {
        await this.#addHttp(update.url, scope);
        return await this.read({ configuredOnly: true });
      }
      if (update.action === "addPackage") this.#packages(); // Refused where npm servers are not offered.
      const source: StdioSource = update.action === "addPackage"
        ? { kind: "npm", package: update.package, version: update.version ?? "latest", args: update.args }
        : { kind: "cli", command: update.command, args: update.args };
      // Saved before installing, so an npm install shows on the server's own card; the card's own check starts it.
      await this.#insert(randomUUID(), uniqueName(fallbackName(source), servers.map(server => server.name)), source, scope);
      return await this.read({ configuredOnly: true });
    }
    const server = servers.find(candidate => candidate.id === update.id);
    if (!server) throw new Error("That MCP server no longer exists.");
    switch (update.action) {
      case "remove":
        await this.options.database.executeTransaction([deleteRows(mcpServers, { id: server.id })]);
        await this.#disconnect(server.id);
        if (server.source.kind === "npm") await this.#packages().remove(server.id);
        break;
      case "setAuth":
        httpUrl(server);
        // A header credential and an OAuth sign-in are alternatives; setting one drops the other.
        await this.options.database.executeTransaction(update.auth
          ? [await this.#sealHeader(server.id, update.auth), ...this.#clearOAuth(server.id)]
          : [deleteRows(mcpServerAuth, { server_id: server.id })]);
        await this.#disconnect(server.id);
        break;
      case "signOut":
        httpUrl(server);
        await this.options.database.executeTransaction(this.#clearOAuth(server.id));
        await this.#disconnect(server.id);
        break;
      case "setAllowAll":
        await this.options.database.executeTransaction([updateRows(mcpServers, { allow_all: update.allowAll ? 1 : 0 }, { id: server.id })]);
        break;
      case "setTools":
        await this.options.database.executeTransaction([
          deleteRows(mcpServerTools, { server_id: server.id }),
          ...[...new Set(update.tools)].map(tool => insertRow(mcpServerTools, { server_id: server.id, tool_name: tool })),
        ]);
        break;
      case "refresh":
        await this.#disconnect(server.id);
        // Retries a failed install; one already running is joined.
        if (server.source.kind === "npm" && this.#packages().state(server.id).state !== "installed") {
          this.#packages().install(server.id, server.source);
        }
        break;
      case "setArgs": {
        stdioSource(server);
        await this.options.database.executeTransaction([
          deleteRows(mcpServerLaunchArgs, { server_id: server.id }),
          ...update.args.map((value, position) => insertRow(mcpServerLaunchArgs, { server_id: server.id, position, value })),
        ]);
        await this.#disconnect(server.id);
        break;
      }
      case "rename":
        if (update.name === server.name) break;
        if (servers.some(candidate => candidate.id !== server.id && candidate.name === update.name)) {
          throw new Error(`Another MCP server is already named ${update.name}.`);
        }
        // Allow rules, credentials and remembered links are keyed by id, so only the row's name changes.
        await this.options.database.executeTransaction([updateRows(mcpServers, { name: update.name }, { id: server.id })]);
        break;
    }
    // Contacts no server, so a change answers at once; the settings view checks the servers it needs to.
    return await this.read({ configuredOnly: true });
  }

  /** Probe the new server for its reported name, then store it; a failed store closes the probe's connection. */
  async #addHttp(url: string, scope: Scope) {
    const id = randomUUID();
    const source: McpServerSource = { kind: "http", url };
    const probe = this.#connection({
      id, name: "", source, scope, allowAll: false, allowedTools: [], header: null, oauth: { redirectUri: null, signedIn: false },
    });
    const reported = await probe.serverName().catch(() => null);
    // Read after the probe: another add may have claimed a name meanwhile.
    const name = uniqueName(serverNameFrom(reported) ?? fallbackName(source), (await this.#servers()).map(server => server.name));
    try {
      await this.#insert(id, name, source, scope);
    } catch (error) {
      await this.#disconnect(id);
      throw error;
    }
  }

  async #insert(id: string, name: string, source: McpServerSource, scope: Scope) {
    const args = source.kind === "http" ? [] : source.args;
    await this.options.database.executeTransaction([
      insertRow(mcpServers, { id, name, transport: source.kind, allow_all: 0, created_at: this.#now() }),
      ...source.kind === "http" ? [insertRow(mcpServerHttp, { server_id: id, url: source.url })]
        : source.kind === "npm" ? [insertRow(mcpServerPackages, { server_id: id, package: source.package, version: source.version })]
          : [insertRow(mcpServerCommands, { server_id: id, command: source.command })],
      ...args.map((value, position) => insertRow(mcpServerLaunchArgs, { server_id: id, position, value })),
      ...scope.kind === "project" ? [insertRow(mcpServerProjects, { server_id: id, project_id: scope.projectId })] : [],
    ]);
  }

  /** A stdio server's environment variables, values included, for its launch settings. */
  async readEnv(input: McpServerEnvReadParams): Promise<McpServerEnvSnapshot> {
    const { id } = McpServerEnvReadParamsSchema.parse(input);
    const server = await this.#stdioServer(id);
    return { entries: (await this.#env(server.id)).map(entry => entry.value === null
      ? { key: entry.name, unreadable: true as const } : { key: entry.name, value: entry.value }) };
  }

  /** Seal and store environment changes in one transaction; the server's process restarts with them on its next use. */
  async updateEnv(input: McpServerEnvUpdate) {
    const { id, upserts, removals } = McpServerEnvUpdateSchema.parse(input);
    const server = await this.#stdioServer(id);
    const key = await this.#key();
    await this.options.database.executeTransaction([
      ...removals.map(name => deleteRows(mcpServerLaunchEnv, { server_id: server.id, name })),
      ...upserts.map(({ key: name, value }) => {
        const sealed = sealProjectStoreValue(key, SECRET_SCOPE, envKey(server.id, name), value);
        return upsertRow(mcpServerLaunchEnv, {
          server_id: server.id, name, nonce: sealed.nonce, ciphertext: sealed.ciphertext, updated_at: this.#now(),
        }, { conflictColumns: ["server_id", "name"], updateColumns: ["nonce", "ciphertext", "updated_at"] });
      }),
    ]);
    await this.#disconnect(server.id);
    return { ok: true as const };
  }

  async #stdioServer(id: string) {
    const server = (await this.#servers()).find(candidate => candidate.id === id);
    if (!server) throw new Error("That MCP server no longer exists.");
    stdioSource(server);
    return server;
  }

  /** `value` is null when the variable was sealed on another device or OS user. */
  async #env(serverId: string) {
    const rows = await this.options.database.query(selectRows(mcpServerLaunchEnv, { where: { server_id: serverId }, orderBy: [{ column: "name" }] }));
    if (!rows.length) return [];
    const key = await this.#key();
    return rows.map(row => ({ name: row.name, value: openProjectStoreValue(key, SECRET_SCOPE, envKey(serverId, row.name), row) }));
  }

  /**
   * Start the stored stdio server as it is now: an npm server pins the exact version its first install resolved; a cli server
   * runs from `folderProjectId`'s folder when project-scoped, or home when global.
   */
  async #launch(serverId: string, folderProjectId: string | null): Promise<McpServerLaunch> {
    const server = await this.#stdioServer(serverId);
    const source = stdioSource(server);
    const env: Record<string, string> = {};
    for (const entry of await this.#env(serverId)) {
      if (entry.value === null) throw new Error(unreadableEnv(entry.name));
      env[entry.name] = entry.value;
    }
    if (source.kind === "cli") {
      const cwd = folderProjectId
        ? (await this.#projects()(folderProjectId)).rootPath
        : (this.options.homeDirectory ?? os.homedir)();
      return { command: source.command, args: [...source.args], cwd, env };
    }
    const { launch, version } = await this.#packages().launch(serverId, source);
    if (version !== source.version) {
      await this.options.database.executeTransaction([updateRows(mcpServerPackages, { version }, { server_id: serverId })]);
    }
    return { ...launch, env };
  }

  #packages() {
    const packages = this.options.packages;
    if (!packages) throw new Error("npm MCP servers are not available here.");
    return packages;
  }

  #projects() {
    const resolve = this.options.resolveProject;
    if (!resolve) throw new Error("Project MCP servers are not available here.");
    return resolve;
  }

  /** Register (if needed) and prepare a PKCE authorization; the provider's callback finishes it. */
  async startSignIn(input: McpServerSignInStartParams): Promise<McpServerSignInStartResult> {
    const { id, redirectUri } = McpServerSignInStartParamsSchema.parse(input);
    const server = (await this.#servers()).find(candidate => candidate.id === id);
    if (!server) throw new Error("That MCP server no longer exists.");
    const serverUrl = httpUrl(server);
    const state = randomBytes(32).toString("base64url");
    const provider = new McpServerOAuthProvider(this.#oauthStore(server.id), { kind: "start", redirectUri, state });
    try {
      await auth(provider, { serverUrl });
    } catch (error) {
      throw new Error(`Sign-in to ${server.name} couldn't start: ${sanitize(error)}`, { cause: error });
    }
    const authorization = provider.authorization();
    if (!authorization) throw new Error(`${server.name} did not offer an OAuth sign-in.`);
    const sealed = sealProjectStoreValue(await this.#key(), SECRET_SCOPE, `${state}\0verifier`, authorization.verifier);
    // One sign-in per server at a time; a new start replaces an abandoned one.
    await this.options.database.executeTransaction([
      deleteRows(mcpServerOAuthPending, { server_id: server.id }),
      insertRow(mcpServerOAuthPending, {
        state, server_id: server.id, redirect_uri: redirectUri,
        verifier_nonce: sealed.nonce, verifier_ciphertext: sealed.ciphertext, created_at: this.#now(),
      }),
    ]);
    return { authorizationUrl: authorization.url.href };
  }

  /** Consume one started sign-in by its state, exactly once, and exchange the provider's code for tokens. */
  async finishSignIn(input: McpServerSignInFinishParams): Promise<McpServerSignInFinishResult> {
    const params = McpServerSignInFinishParamsSchema.parse(input);
    const [pending] = await this.options.database.query(selectRows(mcpServerOAuthPending, { where: { state: params.state } }));
    if (!pending) throw new Error(SIGN_IN_EXPIRED);
    await this.options.database.executeTransaction([deleteRows(mcpServerOAuthPending, { state: params.state })]);
    const server = (await this.#servers()).find(candidate => candidate.id === pending.server_id);
    if (!server || server.source.kind !== "http" || this.#now() - pending.created_at > SIGN_IN_TTL_MS) throw new Error(SIGN_IN_EXPIRED);
    const serverUrl = server.source.url;
    if ("error" in params) return { outcome: "failed", server: server.name, detail: params.error };
    const verifier = openProjectStoreValue(await this.#key(), SECRET_SCOPE, `${params.state}\0verifier`, {
      nonce: pending.verifier_nonce, ciphertext: pending.verifier_ciphertext,
    });
    if (verifier === null) return { outcome: "failed", server: server.name, detail: "The sign-in started on another device or OS user." };
    const provider = new McpServerOAuthProvider(this.#oauthStore(server.id), {
      kind: "finish", redirectUri: pending.redirect_uri, verifier,
    });
    try {
      await auth(provider, { serverUrl, authorizationCode: params.code });
    } catch (error) {
      return { outcome: "failed", server: server.name, detail: sanitize(error) || "The provider refused the sign-in." };
    }
    await this.options.database.executeTransaction([deleteRows(mcpServerAuth, { server_id: server.id })]);
    await this.#disconnect(server.id);
    return { outcome: "signedIn", server: server.name };
  }

  /**
   * Tools across the servers the caller sees, or one server's: enabled ones, plus disabled ones when asked; unreachable servers are
   * reported alongside. A caller sees global servers, its project's, and its own thread servers; no caller sees only global ones.
   */
  async listTools(input: { server?: string; query?: string; includeDisabled?: boolean }, caller: McpServerCaller | null, signal: AbortSignal) {
    const servers = (await this.#visible(caller)).filter(server => !input.server || server.name === input.server);
    if (input.server && !servers.length) throw new Error(`No MCP server is named ${input.server}.`);
    const listings = await Promise.all(servers.map(async (server): Promise<McpToolListing> => {
      const catalog = await this.#catalog(server, signal, input.query);
      if (catalog.status === "ready") {
        const entry = (tool: McpServerTool, ranked: boolean) => ({ tool, allowed: this.#allows(server, tool.name), ranked });
        const matches = catalog.search?.matches ?? [];
        return {
          server: server.name, status: "ready", search: Boolean(catalog.search),
          tools: [
            ...matches.map(tool => entry(tool, true)),
            ...catalog.tools.filter(tool => !matches.some(match => match.name === tool.name)).map(tool => entry(tool, false)),
          ],
        };
      }
      return catalog.status === "signInRequired"
        ? { server: server.name, status: "signInRequired" }
        : { server: server.name, status: "error", detail: catalog.detail };
    }));
    signal.throwIfAborted();
    return formatMcpToolListing(listings, input.query, input.includeDisabled === true);
  }

  /**
   * Ask the user, through `ask`, to enable one offered tool; Enable adds it to the server's allowed tools.
   * An already-enabled tool returns at once; an unoffered one is rejected without asking.
   */
  async requestTool(
    input: { server: string; tool: string; reason: string },
    caller: McpServerCaller | null,
    ask: (mcpTool: { server: string; tool: string; title: string | null; description: string }) => Promise<boolean>,
    signal: AbortSignal,
  ) {
    const server = await this.#named(input.server, caller);
    if (this.#allows(server, input.tool)) return `${input.server}/${input.tool} is already enabled. Call it with mcp_call.\n`;
    const catalog = await this.#catalog(server, signal);
    if (catalog.status === "signInRequired") throw new Error(`${input.server} needs authentication first; ask the user to authenticate it in Settings > Agents > MCP servers.`);
    if (catalog.status === "error") throw new Error(`${input.server} is unavailable: ${catalog.detail}`);
    const tool = await this.#offered(server, input.tool, signal);
    if (!tool) throw new Error(`${input.server} does not offer a tool named ${input.tool}.`);
    const enabled = await ask({ server: server.name, tool: tool.name, title: tool.title ?? null, description: tool.description });
    if (!enabled) return `The user did not enable ${input.server}/${input.tool}.\n`;
    // Re-read so picks made while the user decided are kept.
    const current = (await this.#servers()).find(candidate => candidate.id === server.id);
    if (!current) throw new Error(`${input.server} was removed while waiting for the user.`);
    if (!this.#allows(current, tool.name)) {
      await this.options.database.executeTransaction([insertRow(mcpServerTools, { server_id: current.id, tool_name: tool.name })]);
    }
    return `Enabled ${input.server}/${input.tool}. Call it with mcp_call.\n`;
  }

  /** Forward one call only when the tool is both allowed and currently offered; project-scoped servers learn the calling thread. */
  async call(
    input: { server: string; tool: string; arguments: Record<string, unknown> }, caller: McpServerCaller | null, signal: AbortSignal,
  ): Promise<McpServerCallOutcome> {
    const server = await this.#named(input.server, caller);
    if (!this.#allows(server, input.tool)) throw new Error(`${input.server}/${input.tool} is not enabled. Ask the user to enable it with mcp_request.`);
    if (server.header && server.header.value === null) throw new Error(UNREADABLE_CREDENTIAL);
    if (!await this.#offered(server, input.tool, signal)) throw new Error(`${input.server} does not offer a tool named ${input.tool}.`);
    const meta = server.scope.kind === "project" && caller
      ? { [MCP_CALLER_META_KEY]: { threadId: caller.threadId, cwd: caller.cwd } } : undefined;
    const result = await this.#connection(server).callTool(input.tool, input.arguments, signal, meta);
    const links = mcpResultLinks(result);
    if (links.length) this.#sentLinks.set(server.id, [...links, ...this.#sentLinks.get(server.id) ?? []].slice(0, SENT_LINK_LIMIT));
    return { text: `${formatMcpToolResult(result)}${links.length ? LINK_HINT : ""}`, isError: result.isError === true };
  }

  /**
   * Ask the user, through `ask`, to let the caller's thread use an MCP server URL until its turn ends. Nothing connects before the user
   * approves, since the URL may name any service; approved servers allow all their tools.
   */
  async connectThreadServer(
    input: { name: string; url: string },
    caller: McpServerCaller,
    ask: (mcpConnection: { server: string; url: string }) => Promise<boolean>,
    signal: AbortSignal,
  ) {
    const name = McpServerNameSchema.parse(input.name);
    const url = McpServerUrlSchema.parse(input.url);
    if (name === WORKBENCH_MCP_SERVER_NAME) throw new Error(`"${WORKBENCH_MCP_SERVER_NAME}" is reserved for Workbench's own tools.`);
    if ((await this.#visible(caller)).some(server => server.name === name)) {
      throw new Error(`An MCP server named ${name} is already available to this thread. Pick another name.`);
    }
    if (!await ask({ server: name, url })) return `The user did not connect ${name}.\n`;
    await this.options.database.executeTransaction([
      insertRow(mcpThreadServers, { thread_id: caller.threadId, name, url, created_at: this.#now() }),
    ]);
    const server = this.#threadServer({ thread_id: caller.threadId, name, url });
    const catalog = await this.#catalog(server, signal);
    const status = catalog.status === "ready" ? `It offers ${catalog.tools.length} tool${catalog.tools.length === 1 ? "" : "s"}.`
      : catalog.status === "error" ? `It is not answering yet: ${catalog.detail}` : "It asks for a sign-in, which thread servers do not support.";
    return `Connected ${name} for this turn. ${status} List its tools with mcp_tools and call them with mcp_call.\n`;
  }

  /** Drop a server's connection so its next use relaunches its process or reconnects; only servers the caller sees. */
  async reload(input: { server: string }, caller: McpServerCaller | null) {
    const server = await this.#named(input.server, caller);
    await this.#disconnect(server.id);
    return server.source.kind === "http"
      ? `Disconnected ${server.name}; its next use reconnects.\n`
      : `Stopped ${server.name}; its next use starts it again.\n`;
  }

  /** A turn ended: its thread servers are forgotten and their connections close without waiting on them. */
  async endTurn(threadId: string) {
    await this.options.database.executeTransaction([deleteRows(mcpThreadServers, { thread_id: threadId })]);
    for (const [key, entry] of this.#connections) {
      if (entry.scope.kind === "thread" && entry.scope.threadId === threadId) this.#closeQuietly(key);
    }
  }

  /** Forget thread servers of every thread not working now, such as ones whose turn ended while the daemon was down. */
  async sweepThreadServers(workingThreadIds: ReadonlySet<string>) {
    const stale = [...new Set((await this.options.database.query(selectRows(mcpThreadServers)))
      .map(row => row.thread_id).filter(threadId => !workingThreadIds.has(threadId)))];
    for (const threadId of stale) await this.endTurn(threadId);
  }

  /**
   * No thread of this folder (daemon project) is working any more: its cli processes stop, and the project's shared connections close;
   * the next use reopens either.
   */
  async releaseProject(projectId: string) {
    const identity = await this.#identity(projectId);
    for (const [key, entry] of this.#connections) {
      if (entry.scope.kind !== "project") continue;
      const released = entry.folderProjectId !== null
        ? entry.folderProjectId === projectId
        : entry.scope.projectId === projectId || (identity !== null && await this.#identity(entry.scope.projectId) === identity);
      if (released) this.#closeQuietly(key);
    }
  }

  /** The identity a folder shares with clones of the same repository; null when unknown, so it matches only itself. */
  async #identity(projectId: string) {
    return await this.#projects()(projectId).then(project => project.identityKey, () => null);
  }

  /** Download, without asking, a link the server itself sent in a recent call reply; the file lives until the thread settles. */
  async downloadLink(input: { threadId: string; server: string; url: string; name?: string | undefined }, caller: McpServerCaller | null, signal: AbortSignal) {
    const downloads = this.options.downloads;
    if (!downloads) throw new Error("Downloads are not available here.");
    const link = await this.#sentLink(input.server, input.url, caller);
    const saved = await downloads.download(input.threadId, link.url, input.name, signal);
    return `Saved ${saved.name} (${saved.contentType}, ${saved.bytes} bytes) to ${saved.path}\n`;
  }

  async #sentLink(serverName: string, url: string, caller: McpServerCaller | null) {
    const server = await this.#named(serverName, caller);
    const link = matchesMcpResultLink(url, this.#sentLinks.get(server.id) ?? []);
    if (!link) throw new Error(`${serverName} did not send that link in a recent mcp_call reply. Pass a link exactly as the server returned it.`);
    return { server, url: link };
  }

  /**
   * Ask the user, through `ask`, to open a link the server itself sent in a recent call reply, such as its sign-in page.
   * Links the server never sent are rejected without asking, so an agent cannot dress up an arbitrary page as this server's.
   */
  async authorizeLink(
    input: { server: string; url: string; reason: string },
    caller: McpServerCaller | null,
    ask: (mcpAuthorization: { server: string; url: string; host: string }) => Promise<boolean>,
  ) {
    const { server, url: link } = await this.#sentLink(input.server, input.url, caller);
    const done = await ask({ server: server.name, url: link, host: new URL(link).host });
    return done
      ? `The user says they finished signing in to ${server.name}. Retry the call.\n`
      : `The user did not sign in to ${server.name}.\n`;
  }

  async dispose() {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    const closed = await Promise.allSettled(connections.map(entry => entry.connection.close()));
    const failures = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "MCP server connections failed to close.");
  }

  #now() { return (this.options.now ?? Date.now)(); }

  #allows(server: StoredServer, tool: string) {
    return server.allowAll || server.allowedTools.includes(tool);
  }

  /**
   * A project server serves every folder sharing its project's identity, and runs cli processes from the caller's own folder.
   * Configured servers come first, so a server configured after a thread connected its own same-named one wins.
   */
  async #visible(caller: McpServerCaller | null): Promise<StoredServer[]> {
    const servers = await this.#servers();
    const callerProjectId = caller?.projectId ?? null;
    const callerIdentity = callerProjectId && servers.some(server => server.scope.kind === "project")
      ? await this.#identity(callerProjectId) : null;
    const configured: StoredServer[] = [];
    for (const server of servers) {
      if (server.scope.kind === "global") configured.push(server);
      else if (server.scope.kind === "project" && callerProjectId && (server.scope.projectId === callerProjectId
        || (callerIdentity !== null && await this.#identity(server.scope.projectId) === callerIdentity))) {
        configured.push({ ...server, folderProjectId: callerProjectId });
      }
    }
    if (!caller) return configured;
    const rows = await this.options.database.query(selectRows(mcpThreadServers, { where: { thread_id: caller.threadId }, orderBy: [{ column: "created_at" }] }));
    return [...configured, ...rows.map(row => this.#threadServer(row))];
  }

  async #named(name: string, caller: McpServerCaller | null) {
    const server = (await this.#visible(caller)).find(candidate => candidate.name === name);
    if (!server) throw new Error(`No MCP server is named ${name}.`);
    return server;
  }

  #threadServer(row: { thread_id: string; name: string; url: string }): StoredServer {
    return {
      id: threadServerId(row.thread_id, row.name), name: row.name, source: { kind: "http", url: row.url },
      scope: { kind: "thread", threadId: row.thread_id }, allowAll: true, allowedTools: [], header: null,
      oauth: { redirectUri: null, signedIn: false },
    };
  }

  /** A wrapped server answers with its enabled tools described, plus `query` matches when a query is given. */
  async #catalog(server: StoredServer, signal?: AbortSignal, query?: string): Promise<Catalog> {
    if (server.header && server.header.value === null) return { status: "error", detail: UNREADABLE_CREDENTIAL };
    try {
      const connection = this.#connection(server);
      const wrapped = await connection.wrapped?.(signal) ?? null;
      if (!wrapped) return { status: "ready", tools: await connection.listTools(signal) };
      const abort = signal ?? new AbortController().signal;
      const [tools, matches] = await Promise.all([
        wrapped.describe(server.allowedTools, abort),
        query?.trim() ? wrapped.search(query.trim(), abort) : [],
      ]);
      return { status: "ready", tools, search: { matches } };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof McpServerSignInRequiredError) return { status: "signInRequired" };
      return { status: "error", detail: sanitize(error) || "The server could not be reached." };
    }
  }

  /** The named tool when the server offers it now; wrapped servers are asked about that tool alone. */
  async #offered(server: StoredServer, name: string, signal: AbortSignal) {
    const connection = this.#connection(server);
    const wrapped = await connection.wrapped?.(signal) ?? null;
    const tools = wrapped ? await wrapped.describe([name], signal) : await connection.listTools(signal);
    return tools.find(tool => tool.name === name) ?? null;
  }

  #connection(server: StoredServer) {
    const folderProjectId = launchFolder(server);
    const key = folderProjectId ? `${server.id}\0${folderProjectId}` : server.id;
    const existing = this.#connections.get(key);
    if (existing) return existing.connection;
    const label = server.name || fallbackName(server.source);
    const record = (frame: McpServerTrafficFrame) => this.#traffic.record({ ...frame, connection: label, label: `${label} ${frame.label}` });
    const source = server.source;
    const endpoint: McpServerEndpoint = source.kind !== "http"
      ? { transport: "stdio", record, launch: () => this.#launch(server.id, folderProjectId) }
      // An agent-supplied URL gets no sign-in and a bounded response size.
      : server.scope.kind === "thread"
      ? { transport: "http", url: source.url, headers: {}, record, maxResponseBytes: THREAD_SERVER_MAX_RESPONSE_BYTES }
      : server.header
      ? { transport: "http", url: source.url, headers: server.header.value ? { [server.header.name]: server.header.value } : {}, record }
      : {
        transport: "http", url: source.url, headers: {}, record,
        authProvider: new McpServerOAuthProvider(this.#oauthStore(server.id), {
          kind: "background", redirectUri: server.oauth.redirectUri ?? undefined,
        }),
      };
    const connection = new WrappedMcpConnection((this.options.connect ?? (value => new McpServerConnection(value)))(endpoint));
    this.#connections.set(key, { serverId: server.id, connection, scope: server.scope, folderProjectId });
    return connection;
  }

  /** Close every connection of a server, in every folder it runs in. */
  async #disconnect(serverId: string) {
    this.#sentLinks.delete(serverId);
    const keys = [...this.#connections].flatMap(([key, entry]) => entry.serverId === serverId ? [key] : []);
    await Promise.all(keys.map(key => this.#closeConnection(key)));
  }

  async #closeConnection(key: string) {
    const entry = this.#connections.get(key);
    this.#connections.delete(key);
    await entry?.connection.close();
  }

  /** Lifetime ends never wait on a stuck server; a close failure only means the process or socket was already gone. */
  #closeQuietly(key: string) {
    void this.#closeConnection(key).catch(() => undefined);
  }

  #clearOAuth(serverId: string) {
    return [mcpServerOAuthTokens, mcpServerOAuthClients, mcpServerOAuthPending].map(table => deleteRows(table, { server_id: serverId }));
  }

  async #sealHeader(serverId: string, header: { header: string; value: string }) {
    const sealed = sealProjectStoreValue(await this.#key(), SECRET_SCOPE, credentialKey(serverId, header.header), header.value);
    return upsertRow(mcpServerAuth, {
      server_id: serverId, header_name: header.header, nonce: sealed.nonce, ciphertext: sealed.ciphertext, updated_at: this.#now(),
    }, { conflictColumns: ["server_id"], updateColumns: ["header_name", "nonce", "ciphertext", "updated_at"] });
  }

  /** Sealed persistence of one server's OAuth client registration and tokens; unreadable secrets read as absent. */
  #oauthStore(serverId: string): McpServerOAuthStore {
    const database = this.options.database;
    const seal = async (name: string, value: string) => sealProjectStoreValue(await this.#key(), SECRET_SCOPE, `${serverId}\0${name}`, value);
    const open = async (name: string, nonce: Uint8Array | null, ciphertext: Uint8Array | null) => nonce && ciphertext
      ? openProjectStoreValue(await this.#key(), SECRET_SCOPE, `${serverId}\0${name}`, { nonce, ciphertext })
      : null;
    return {
      readClient: async () => {
        const [row] = await database.query(selectRows(mcpServerOAuthClients, { where: { server_id: serverId } }));
        if (!row) return null;
        const secret = await open("oauth-client-secret", row.secret_nonce, row.secret_ciphertext);
        const client: OAuthClientInformationMixed = { client_id: row.client_id, ...secret ? { client_secret: secret } : {} };
        return { redirectUri: row.redirect_uri, client };
      },
      saveClient: async (redirectUri, client) => {
        const secret = client.client_secret ? await seal("oauth-client-secret", client.client_secret) : null;
        await database.executeTransaction([upsertRow(mcpServerOAuthClients, {
          server_id: serverId, redirect_uri: redirectUri, client_id: client.client_id,
          secret_nonce: secret?.nonce ?? null, secret_ciphertext: secret?.ciphertext ?? null,
        }, { conflictColumns: ["server_id"], updateColumns: ["redirect_uri", "client_id", "secret_nonce", "secret_ciphertext"] })]);
      },
      readTokens: async () => {
        const [row] = await database.query(selectRows(mcpServerOAuthTokens, { where: { server_id: serverId } }));
        if (!row) return null;
        const access = await open("oauth-access", row.access_nonce, row.access_ciphertext);
        if (access === null) return null;
        const refresh = await open("oauth-refresh", row.refresh_nonce, row.refresh_ciphertext);
        const tokens: OAuthTokens = {
          access_token: access, token_type: row.token_type,
          ...refresh ? { refresh_token: refresh } : {},
          ...row.scope ? { scope: row.scope } : {},
          ...row.expires_at !== null ? { expires_in: Math.max(0, Math.floor((row.expires_at - this.#now()) / 1000)) } : {},
        };
        return tokens;
      },
      saveTokens: async tokens => {
        const access = await seal("oauth-access", tokens.access_token);
        const refresh = tokens.refresh_token ? await seal("oauth-refresh", tokens.refresh_token) : null;
        await database.executeTransaction([upsertRow(mcpServerOAuthTokens, {
          server_id: serverId, token_type: tokens.token_type,
          access_nonce: access.nonce, access_ciphertext: access.ciphertext,
          refresh_nonce: refresh?.nonce ?? null, refresh_ciphertext: refresh?.ciphertext ?? null,
          expires_at: tokens.expires_in === undefined ? null : this.#now() + tokens.expires_in * 1000,
          scope: tokens.scope ?? null, updated_at: this.#now(),
        }, {
          conflictColumns: ["server_id"],
          updateColumns: ["token_type", "access_nonce", "access_ciphertext", "refresh_nonce", "refresh_ciphertext", "expires_at", "scope", "updated_at"],
        })]);
      },
      clearTokens: async () => { await database.executeTransaction([deleteRows(mcpServerOAuthTokens, { server_id: serverId })]); },
      clearClient: async () => { await database.executeTransaction([deleteRows(mcpServerOAuthClients, { server_id: serverId })]); },
    };
  }

  async #servers(): Promise<StoredServer[]> {
    const database = this.options.database;
    const [servers, urls, packages, commands, args, projects, tools, headers, clients, tokens] = await Promise.all([
      database.query(selectRows(mcpServers, { orderBy: [{ column: "created_at" }] })),
      database.query(selectRows(mcpServerHttp)),
      database.query(selectRows(mcpServerPackages)),
      database.query(selectRows(mcpServerCommands)),
      database.query(selectRows(mcpServerLaunchArgs, { orderBy: [{ column: "position" }] })),
      database.query(selectRows(mcpServerProjects)),
      database.query(selectRows(mcpServerTools, { orderBy: [{ column: "tool_name" }] })),
      database.query(selectRows(mcpServerAuth)),
      database.query(selectRows(mcpServerOAuthClients)),
      database.query(selectRows(mcpServerOAuthTokens)),
    ]);
    const key = headers.length ? await this.#key() : null;
    return servers.flatMap((server): StoredServer[] => {
      const header = headers.find(row => row.server_id === server.id);
      const launchArgs = args.filter(row => row.server_id === server.id).map(row => row.value);
      const url = urls.find(row => row.server_id === server.id)?.url;
      const installed = packages.find(row => row.server_id === server.id);
      const command = commands.find(row => row.server_id === server.id)?.command;
      const source: McpServerSource | null = server.transport === "http" ? url ? { kind: "http", url } : null
        : server.transport === "npm" ? installed ? { kind: "npm", package: installed.package, version: installed.version, args: launchArgs } : null
          : command ? { kind: "cli", command, args: launchArgs } : null;
      // Servers and their transport rows are written and removed together; one read between these queries is already gone.
      if (!source) return [];
      const projectId = projects.find(row => row.server_id === server.id)?.project_id;
      return [{
        id: server.id, name: server.name, source, scope: projectId ? { kind: "project", projectId } : { kind: "global" },
        allowAll: server.allow_all === 1,
        allowedTools: tools.filter(row => row.server_id === server.id).map(row => row.tool_name),
        header: header && key ? {
          name: header.header_name,
          value: openProjectStoreValue(key, SECRET_SCOPE, credentialKey(server.id, header.header_name), header),
        } : null,
        oauth: {
          redirectUri: clients.find(row => row.server_id === server.id)?.redirect_uri ?? null,
          signedIn: tokens.some(row => row.server_id === server.id),
        },
      }];
    });
  }

  #key() {
    this.#secret ??= this.options.readDeviceIdentity().then(deviceId => deriveProjectStoreKey({
      deviceId, user: (this.options.user ?? (() => os.userInfo().username))(), projectLocation: SECRET_SCOPE,
    })).catch(error => {
      this.#secret = null;
      throw error;
    });
    return this.#secret;
  }
}
