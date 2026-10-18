/*
 * Exports:
 * - McpSignInEvent: one finished MCP server sign-in callback, published to app sockets.
 * - default WorkbenchMcpSignInRoutes: own the MCP OAuth callback; relay the provider's answer to its daemon, answer the popup and announce the outcome.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { McpServerSignInFinishParams, McpServerSignInFinishResult } from "workbench-shared/workbench/mcp/mcp-server-settings";

export const MCP_SIGN_IN_PATH_PREFIX = "/api/mcp-sign-in/";

export interface McpSignInEvent {
  daemonId: DaemonId;
  outcome: "signedIn" | "failed";
}

interface McpSignInSource {
  readonly available: boolean;
  readonly daemon: { mcpServers: { finishSignIn(params: McpServerSignInFinishParams): Promise<McpServerSignInFinishResult> } };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
}

/** A self-contained popup page; the only script is a fixed close after success. */
function page(response: ServerResponse, status: number, heading: string, detail: string, close: boolean) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
  });
  response.end([
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Workbench sign-in</title>",
    "<style>body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#111;color:#eee}",
    "main{max-width:28rem;padding:2rem;text-align:center}p{color:#aaa}</style></head><body><main>",
    `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>`,
    "</main>",
    close ? "<script>setTimeout(() => window.close(), 800);</script>" : "",
    "</body></html>",
  ].join(""));
}

export default class WorkbenchMcpSignInRoutes {
  readonly #listeners = new Set<(event: McpSignInEvent) => void>();

  constructor(private readonly options: {
    sources: { get(id: DaemonId): McpSignInSource | null };
    warn(message: string): void;
  }) {}

  subscribe(listener: (event: McpSignInEvent) => void) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!url.pathname.startsWith(MCP_SIGN_IN_PATH_PREFIX)) return false;
    const daemonId = DaemonIdSchema.safeParse(decodeURIComponent(url.pathname.slice(MCP_SIGN_IN_PATH_PREFIX.length)));
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (request.method !== "GET" || !daemonId.success || !state || (!code && !error)) {
      page(response, 400, "Sign-in failed", "This sign-in link is incomplete. Start sign-in again from Workbench settings.", false);
      return true;
    }
    const source = this.options.sources.get(daemonId.data);
    if (!source?.available) {
      page(response, 503, "Sign-in failed", "That Workbench daemon is offline. Start sign-in again once it is back.", false);
      return true;
    }
    let result: McpServerSignInFinishResult;
    try {
      result = await source.daemon.mcpServers.finishSignIn(code ? { state, code } : { state, error: error!.slice(0, 500) });
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message.slice(0, 300) : "The daemon could not finish sign-in.";
      this.options.warn(`MCP sign-in callback failed: ${detail}`);
      this.#publish({ daemonId: daemonId.data, outcome: "failed" });
      page(response, 502, "Sign-in failed", detail, false);
      return true;
    }
    this.#publish({ daemonId: daemonId.data, outcome: result.outcome });
    if (result.outcome === "signedIn") page(response, 200, `Signed in to ${result.server}`, "You can close this window.", true);
    else page(response, 400, `Sign-in to ${result.server} failed`, result.detail, false);
    return true;
  }

  #publish(event: McpSignInEvent) {
    for (const listener of this.#listeners) listener(event);
  }
}
