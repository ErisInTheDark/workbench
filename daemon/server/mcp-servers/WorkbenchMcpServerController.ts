/*
 * Exports:
 * - WorkbenchMcpServerOptions: database, device identity, connection factory and download ports.
 * - McpServerCallOutcome: agent-facing text of one forwarded call and whether it failed.
 * - default WorkbenchMcpServerController: single owner of user-added MCP servers, their allow rules, sealed header credentials, OAuth sign-ins, live (meta-tool unwrapped) connections and their recent raw traffic; answers settings reads/updates, sign-in steps and agent tool listing, enable requests, calls, requests to open or download links a server sent, and `wb debug mcp`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  McpServerSettingsUpdateSchema, McpServerSignInFinishParamsSchema, McpServerSignInStartParamsSchema,
  type McpServerSettingsSnapshot, type McpServerSettingsUpdate, type McpServerSignInFinishParams,
  type McpServerSignInFinishResult, type McpServerSignInStartParams, type McpServerSignInStartResult, type McpServerSnapshot,
  WORKBENCH_MCP_SERVER_NAME,
} from "workbench-shared/workbench/mcp/mcp-server-settings";
import {
  deleteRows, insertRow, selectRows, updateRows, upsertRow,
  type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import {
  mcpServerAuth, mcpServerOAuthClients, mcpServerOAuthPending, mcpServerOAuthTokens, mcpServers, mcpServerTools,
} from "../lib/workbench/database/schema/mcp-server-schema";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "../store/project-store-crypto";
import WebSocketTrafficBuffer, { type WebSocketTrafficQuery } from "workbench-shared/process/WebSocketTrafficBuffer";
import McpServerConnection, {
  type McpServerConnectionPort, type McpServerEndpoint, type McpServerTool, type McpServerTrafficFrame,
} from "./McpServerConnection";
import McpServerOAuthProvider, { McpServerSignInRequiredError, type McpServerOAuthStore } from "./McpServerOAuthProvider";
import { formatMcpToolListing, formatMcpToolResult, type McpToolListing } from "./mcp-tool-search";
import { matchesMcpResultLink, mcpResultLinks } from "./mcp-result-links";
import type McpDownloadStore from "./McpDownloadStore";
import WrappedMcpConnection from "./WrappedMcpConnection";

export interface WorkbenchMcpServerOptions {
  database: {
    executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
    query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
  };
  readDeviceIdentity(): Promise<string>;
  connect?: (endpoint: McpServerEndpoint) => McpServerConnectionPort;
  /** Fetches links servers sent; absent where downloads are not offered. */
  downloads?: Pick<McpDownloadStore, "download">;
  user?: () => string;
  now?: () => number;
}

export interface McpServerCallOutcome {
  text: string;
  isError: boolean;
}

interface StoredServer {
  id: string;
  name: string;
  url: string;
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

// Secrets are sealed with the project-store cipher, bound to this device, OS user, this scope and each secret's own key.
const SECRET_SCOPE = "mcp-servers";
const UNREADABLE_CREDENTIAL = "The saved credential can't be read on this device or OS user. Set it again.";
const SIGN_IN_TTL_MS = 10 * 60_000;
const SENT_LINK_LIMIT = 20;
const LINK_HINT = "To open a link above for the user use wb/mcp_authorize; to fetch a file link use wb/mcp_download (both via mcp_call on server wb).\n";
const SIGN_IN_EXPIRED = "This sign-in has expired or was already used. Start sign-in again from Workbench settings.";

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);
}

const NAME_LIMIT = 64;

/** A reported server name squashed to the agent-facing name characters, or null when nothing usable remains. */
function serverNameFrom(reported: string | null) {
  const name = (reported ?? "").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+|[-._]+$/gu, "").slice(0, NAME_LIMIT);
  return name || null;
}

function hostnameOf(url: string) {
  return serverNameFrom(new URL(url).hostname) ?? "mcp";
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

export default class WorkbenchMcpServerController {
  #secret: Promise<Buffer> | null = null;
  readonly #connections = new Map<string, McpServerConnectionPort>();
  readonly #traffic = new WebSocketTrafficBuffer({ maxEntries: 500, maxBytes: 4 * 1024 * 1024 });
  /** Newest-first links each server sent in call replies; memory only, so a reload means calling again. */
  readonly #sentLinks = new Map<string, string[]>();

  constructor(private readonly options: WorkbenchMcpServerOptions) {}

  /** Recent raw JSON-RPC traffic with every server, labelled `<server> <method|result|error>`, for `wb debug mcp`. */
  traffic(query: WebSocketTrafficQuery) {
    return this.#traffic.query(query);
  }

  async read(): Promise<McpServerSettingsSnapshot> {
    const servers = await this.#servers();
    const catalogs = await Promise.all(servers.map(server => this.#catalog(server)));
    const names = await this.#adoptServerNames(servers, catalogs);
    return { servers: servers.map((server, index): McpServerSnapshot => {
      const catalog = catalogs[index]!;
      return {
        id: server.id, name: names.get(server.id) ?? server.name, url: server.url, allowAll: server.allowAll, allowedTools: server.allowedTools,
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
   * A server still named after its hostname (it could not report a name when added, e.g. before sign-in) takes its
   * reported name on its first successful connection. Names taken from the server never change again.
   */
  async #adoptServerNames(servers: readonly StoredServer[], catalogs: readonly Catalog[]) {
    const names = new Map<string, string>();
    const taken = servers.map(server => server.name);
    for (const [index, server] of servers.entries()) {
      if (catalogs[index]?.status !== "ready" || server.name !== hostnameOf(server.url)) continue;
      const reported = serverNameFrom(await this.#connection(server).serverName().catch(() => null));
      if (!reported || reported === server.name) continue;
      const name = uniqueName(reported, taken);
      await this.options.database.executeTransaction([updateRows(mcpServers, { name }, { id: server.id })]);
      taken[index] = name;
      names.set(server.id, name);
    }
    return names;
  }

  async update(input: McpServerSettingsUpdate): Promise<McpServerSettingsSnapshot> {
    const update = McpServerSettingsUpdateSchema.parse(input);
    const servers = await this.#servers();
    if (update.action === "add") {
      const id = randomUUID();
      const probe = this.#connection({
        id, name: "", url: update.url, allowAll: false, allowedTools: [], header: null, oauth: { redirectUri: null, signedIn: false },
      });
      const reported = await probe.serverName().catch(() => null);
      const name = uniqueName(serverNameFrom(reported) ?? hostnameOf(update.url), servers.map(server => server.name));
      try {
        await this.options.database.executeTransaction([
          insertRow(mcpServers, { id, name, url: update.url, allow_all: 0, created_at: this.#now() }),
        ]);
      } catch (error) {
        await this.#disconnect(id);
        throw error;
      }
      return await this.read();
    }
    const server = servers.find(candidate => candidate.id === update.id);
    if (!server) throw new Error("That MCP server no longer exists.");
    switch (update.action) {
      case "remove":
        await this.options.database.executeTransaction([deleteRows(mcpServers, { id: server.id })]);
        await this.#disconnect(server.id);
        break;
      case "setAuth":
        // A header credential and an OAuth sign-in are alternatives; setting one drops the other.
        await this.options.database.executeTransaction(update.auth
          ? [await this.#sealHeader(server.id, update.auth), ...this.#clearOAuth(server.id)]
          : [deleteRows(mcpServerAuth, { server_id: server.id })]);
        await this.#disconnect(server.id);
        break;
      case "signOut":
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
        break;
      case "rename":
        if (update.name === server.name) break;
        if (servers.some(candidate => candidate.id !== server.id && candidate.name === update.name)) {
          throw new Error(`Another MCP server is already named ${update.name}.`);
        }
        // Allow rules, credentials and remembered links are keyed by id, so only the row's name changes.
        await this.options.database.executeTransaction([updateRows(mcpServers, { name: update.name }, { id: server.id })]);
        break;
    }
    return await this.read();
  }

  /** Register (if needed) and prepare a PKCE authorization; the provider's callback finishes it. */
  async startSignIn(input: McpServerSignInStartParams): Promise<McpServerSignInStartResult> {
    const { id, redirectUri } = McpServerSignInStartParamsSchema.parse(input);
    const server = (await this.#servers()).find(candidate => candidate.id === id);
    if (!server) throw new Error("That MCP server no longer exists.");
    const state = randomBytes(32).toString("base64url");
    const provider = new McpServerOAuthProvider(this.#oauthStore(server.id), { kind: "start", redirectUri, state });
    try {
      await auth(provider, { serverUrl: server.url });
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
    if (!server || this.#now() - pending.created_at > SIGN_IN_TTL_MS) throw new Error(SIGN_IN_EXPIRED);
    if ("error" in params) return { outcome: "failed", server: server.name, detail: params.error };
    const verifier = openProjectStoreValue(await this.#key(), SECRET_SCOPE, `${params.state}\0verifier`, {
      nonce: pending.verifier_nonce, ciphertext: pending.verifier_ciphertext,
    });
    if (verifier === null) return { outcome: "failed", server: server.name, detail: "The sign-in started on another device or OS user." };
    const provider = new McpServerOAuthProvider(this.#oauthStore(server.id), {
      kind: "finish", redirectUri: pending.redirect_uri, verifier,
    });
    try {
      await auth(provider, { serverUrl: server.url, authorizationCode: params.code });
    } catch (error) {
      return { outcome: "failed", server: server.name, detail: sanitize(error) || "The provider refused the sign-in." };
    }
    await this.options.database.executeTransaction([deleteRows(mcpServerAuth, { server_id: server.id })]);
    await this.#disconnect(server.id);
    return { outcome: "signedIn", server: server.name };
  }

  /** Tools across servers, or one server's: enabled ones, plus disabled ones when asked; unreachable servers are reported alongside. */
  async listTools(input: { server?: string; query?: string; includeDisabled?: boolean }, signal: AbortSignal) {
    const servers = (await this.#servers()).filter(server => !input.server || server.name === input.server);
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
    ask: (mcpTool: { server: string; tool: string; title: string | null; description: string }) => Promise<boolean>,
    signal: AbortSignal,
  ) {
    const server = (await this.#servers()).find(candidate => candidate.name === input.server);
    if (!server) throw new Error(`No MCP server is named ${input.server}.`);
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

  /** Forward one call only when the tool is both allowed and currently offered. */
  async call(input: { server: string; tool: string; arguments: Record<string, unknown> }, signal: AbortSignal): Promise<McpServerCallOutcome> {
    const server = (await this.#servers()).find(candidate => candidate.name === input.server);
    if (!server) throw new Error(`No MCP server is named ${input.server}.`);
    if (!this.#allows(server, input.tool)) throw new Error(`${input.server}/${input.tool} is not enabled. Ask the user to enable it with mcp_request.`);
    if (server.header && server.header.value === null) throw new Error(UNREADABLE_CREDENTIAL);
    if (!await this.#offered(server, input.tool, signal)) throw new Error(`${input.server} does not offer a tool named ${input.tool}.`);
    const result = await this.#connection(server).callTool(input.tool, input.arguments, signal);
    const links = mcpResultLinks(result);
    if (links.length) this.#sentLinks.set(server.id, [...links, ...this.#sentLinks.get(server.id) ?? []].slice(0, SENT_LINK_LIMIT));
    return { text: `${formatMcpToolResult(result)}${links.length ? LINK_HINT : ""}`, isError: result.isError === true };
  }

  /** Download, without asking, a link the server itself sent in a recent call reply; the file lives until the thread settles. */
  async downloadLink(input: { threadId: string; server: string; url: string; name?: string | undefined }, signal: AbortSignal) {
    const downloads = this.options.downloads;
    if (!downloads) throw new Error("Downloads are not available here.");
    const link = await this.#sentLink(input.server, input.url);
    const saved = await downloads.download(input.threadId, link.url, input.name, signal);
    return `Saved ${saved.name} (${saved.contentType}, ${saved.bytes} bytes) to ${saved.path}\n`;
  }

  async #sentLink(serverName: string, url: string) {
    const server = (await this.#servers()).find(candidate => candidate.name === serverName);
    if (!server) throw new Error(`No MCP server is named ${serverName}.`);
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
    ask: (mcpAuthorization: { server: string; url: string; host: string }) => Promise<boolean>,
  ) {
    const { server, url: link } = await this.#sentLink(input.server, input.url);
    const done = await ask({ server: server.name, url: link, host: new URL(link).host });
    return done
      ? `The user says they finished signing in to ${server.name}. Retry the call.\n`
      : `The user did not sign in to ${server.name}.\n`;
  }

  async dispose() {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    const closed = await Promise.allSettled(connections.map(connection => connection.close()));
    const failures = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "MCP server connections failed to close.");
  }

  #now() { return (this.options.now ?? Date.now)(); }

  #allows(server: StoredServer, tool: string) {
    return server.allowAll || server.allowedTools.includes(tool);
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
    let connection = this.#connections.get(server.id);
    if (!connection) {
      const label = server.name || hostnameOf(server.url);
      const record = (frame: McpServerTrafficFrame) => this.#traffic.record({ ...frame, connection: label, label: `${label} ${frame.label}` });
      const endpoint: McpServerEndpoint = server.header
        ? { url: server.url, headers: server.header.value ? { [server.header.name]: server.header.value } : {}, record }
        : {
          url: server.url, headers: {}, record,
          authProvider: new McpServerOAuthProvider(this.#oauthStore(server.id), {
            kind: "background", redirectUri: server.oauth.redirectUri ?? undefined,
          }),
        };
      connection = new WrappedMcpConnection((this.options.connect ?? (value => new McpServerConnection(value)))(endpoint));
      this.#connections.set(server.id, connection);
    }
    return connection;
  }

  async #disconnect(serverId: string) {
    const connection = this.#connections.get(serverId);
    this.#connections.delete(serverId);
    this.#sentLinks.delete(serverId);
    await connection?.close();
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
    const [servers, tools, headers, clients, tokens] = await Promise.all([
      this.options.database.query(selectRows(mcpServers, { orderBy: [{ column: "created_at" }] })),
      this.options.database.query(selectRows(mcpServerTools, { orderBy: [{ column: "tool_name" }] })),
      this.options.database.query(selectRows(mcpServerAuth)),
      this.options.database.query(selectRows(mcpServerOAuthClients)),
      this.options.database.query(selectRows(mcpServerOAuthTokens)),
    ]);
    const key = headers.length ? await this.#key() : null;
    return servers.map(server => {
      const header = headers.find(row => row.server_id === server.id);
      return {
        id: server.id, name: server.name, url: server.url, allowAll: server.allow_all === 1,
        allowedTools: tools.filter(row => row.server_id === server.id).map(row => row.tool_name),
        header: header && key ? {
          name: header.header_name,
          value: openProjectStoreValue(key, SECRET_SCOPE, credentialKey(server.id, header.header_name), header),
        } : null,
        oauth: {
          redirectUri: clients.find(row => row.server_id === server.id)?.redirect_uri ?? null,
          signedIn: tokens.some(row => row.server_id === server.id),
        },
      };
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
