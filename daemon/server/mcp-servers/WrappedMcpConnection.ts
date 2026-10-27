/*
 * Exports:
 * - default WrappedMcpConnection: presents a connection's own tools, or, when its tool list belongs to a known meta-tool
 *   wrapper, hides the meta tools and serves the inner tools through that wrapper's session.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConnectionPort, McpServerTool } from "./McpServerConnection";
import { detectMcpWrapper, MCP_WRAPPERS, type McpWrapper, type McpWrapperSession } from "./wrappers/mcp-wrapper";

export default class WrappedMcpConnection implements McpServerConnectionPort {
  /** Kept per wrapper, so a session (and its server-side session id) survives catalogue re-reads. */
  #session: { wrapper: McpWrapper; session: McpWrapperSession } | null = null;

  constructor(private readonly inner: McpServerConnectionPort, private readonly wrappers: readonly McpWrapper[] = MCP_WRAPPERS) {}

  async listTools(signal?: AbortSignal): Promise<McpServerTool[]> {
    const tools = await this.inner.listTools(signal);
    return this.#detect(tools) ? [] : tools;
  }

  async wrapped(signal?: AbortSignal) {
    return this.#detect(await this.inner.listTools(signal))?.session ?? null;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, meta?: Record<string, unknown>): Promise<CallToolResult> {
    const session = await this.wrapped(signal);
    return session ? await session.call(name, args, signal) : await this.inner.callTool(name, args, signal, meta);
  }

  serverName() {
    return this.inner.serverName();
  }

  close() {
    this.#session = null;
    return this.inner.close();
  }

  #detect(tools: readonly McpServerTool[]) {
    const wrapper = detectMcpWrapper(tools, this.wrappers);
    if (!wrapper) return this.#session = null;
    if (this.#session?.wrapper !== wrapper) {
      this.#session = { wrapper, session: wrapper.open((name, args, signal) => this.inner.callTool(name, args, signal)) };
    }
    return this.#session;
  }
}
