/*
 * Exports:
 * - McpServerSignInRequiredError: the server needs an interactive OAuth sign-in from settings.
 * - McpServerOAuthStore: one server's persisted client registration and tokens.
 * - McpServerOAuthMode: background use, starting a sign-in, or finishing one from its callback.
 * - default McpServerOAuthProvider: the MCP SDK OAuth client provider for one server; only a started sign-in may produce an authorization URL.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export class McpServerSignInRequiredError extends Error {
  constructor() {
    super("This MCP server needs sign-in. Sign in from Settings > Agents > MCP servers.");
    this.name = "McpServerSignInRequiredError";
  }
}

export interface McpServerOAuthStore {
  readClient(): Promise<{ redirectUri: string; client: OAuthClientInformationMixed } | null>;
  saveClient(redirectUri: string, client: OAuthClientInformationMixed): Promise<void>;
  readTokens(): Promise<OAuthTokens | null>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  clearTokens(): Promise<void>;
  clearClient(): Promise<void>;
}

export type McpServerOAuthMode =
  /** Agent calls and catalogue reads: refresh silently, never start a browser sign-in. */
  | { kind: "background"; redirectUri: string | undefined }
  | { kind: "start"; redirectUri: string; state: string }
  | { kind: "finish"; redirectUri: string; verifier: string };

export default class McpServerOAuthProvider implements OAuthClientProvider {
  #authorizationUrl: URL | null = null;
  #verifier: string | null = null;
  #tokens: Promise<OAuthTokens | null> | null = null;

  constructor(private readonly store: McpServerOAuthStore, private readonly mode: McpServerOAuthMode) {}

  get redirectUrl() { return this.mode.redirectUri; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Workbench",
      redirect_uris: this.mode.redirectUri ? [this.mode.redirectUri] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The URL and PKCE verifier a started sign-in produced, once the SDK has "redirected". */
  authorization() {
    return this.#authorizationUrl && this.#verifier ? { url: this.#authorizationUrl, verifier: this.#verifier } : null;
  }

  state() {
    if (this.mode.kind !== "start") throw new McpServerSignInRequiredError();
    return this.mode.state;
  }

  async clientInformation() {
    const stored = await this.store.readClient();
    if (this.mode.kind === "background") {
      // Registering a client belongs to an interactive sign-in only.
      if (!stored) throw new McpServerSignInRequiredError();
      return stored.client;
    }
    return stored?.redirectUri === this.mode.redirectUri ? stored.client : undefined;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    if (this.mode.kind === "background") throw new McpServerSignInRequiredError();
    await this.store.saveClient(this.mode.redirectUri, client);
  }

  tokens() {
    // A started sign-in always reaches the provider's login rather than silently refreshing old tokens.
    if (this.mode.kind === "start") return Promise.resolve(undefined);
    const tokens = this.#tokens ??= this.store.readTokens();
    tokens.catch(() => { if (this.#tokens === tokens) this.#tokens = null; });
    return tokens.then(value => value ?? undefined);
  }

  async saveTokens(tokens: OAuthTokens) {
    // Providers may omit an unchanged refresh token from a refresh response.
    const previous = await this.tokens();
    const next = { ...tokens, refresh_token: tokens.refresh_token ?? previous?.refresh_token };
    await this.store.saveTokens(next);
    this.#tokens = Promise.resolve(next);
  }

  redirectToAuthorization(url: URL) {
    if (this.mode.kind !== "start") throw new McpServerSignInRequiredError();
    this.#authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    if (this.mode.kind === "start") this.#verifier = verifier;
  }

  codeVerifier() {
    if (this.mode.kind === "finish") return this.mode.verifier;
    if (this.mode.kind === "start" && this.#verifier) return this.#verifier;
    throw new McpServerSignInRequiredError();
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") {
      this.#tokens = Promise.resolve(null);
      await this.store.clearTokens();
    }
    if (scope === "all" || scope === "client") await this.store.clearClient();
  }
}
