/*
 * Exports:
 * - McpServerNameSchema: agent-facing server name used by `mcp_tools` and `mcp_call`.
 * - WORKBENCH_MCP_SERVER_NAME: reserved server name under which `mcp_tools`/`mcp_call` reach Workbench's own deferred tools.
 * - McpServerUrlSchema: http(s) endpoint of one streamable-HTTP MCP server.
 * - McpServerAuthHeaderSchema: custom request header name carrying a server's sealed credential.
 * - McpServerToolNameSchema: one tool name a server offers.
 * - McpServerSettingsSnapshotSchema/McpServerSettingsSnapshot/McpServerSnapshot: configured servers, allow rules and live catalogues; credential values are never included.
 * - McpServerSettingsUpdateSchema/McpServerSettingsUpdate: one server add, removal, credential, allow-rule, refresh or sign-out change.
 * - McpServerSignInStart{Params,Result}Schema: begin an OAuth sign-in and receive the provider's authorization URL.
 * - McpServerSignInFinish{Params,Result}Schema: hand the provider's callback (code or error) to the daemon and report the outcome.
 */
import { z } from "zod";

export const McpServerNameSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u,
  "Use 1-64 lowercase letters, digits, ., - or _, starting with a letter or digit.");

/** User-added servers never take this name; Workbench serves its deferred tools there. */
export const WORKBENCH_MCP_SERVER_NAME = "wb";

export const McpServerUrlSchema = z.string().trim().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "Use an http:// or https:// URL.");

// The MCP transport owns these headers; a credential must never replace them.
const RESERVED_HEADERS = new Set(["accept", "content-length", "content-type", "host", "mcp-protocol-version", "mcp-session-id"]);

export const McpServerAuthHeaderSchema = z.string().trim().max(64)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u, "Use a valid HTTP header name.")
  .refine(value => !RESERVED_HEADERS.has(value.toLowerCase()), "That header is reserved by the MCP transport.");

export const McpServerToolNameSchema = z.string().min(1).max(256);

const credential = z.object({
  header: McpServerAuthHeaderSchema,
  value: z.string().trim().min(1).max(8192),
}).strict();

const catalog = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    tools: z.array(z.object({
      name: McpServerToolNameSchema,
      /** Human-readable title the server gives the tool, when it gives one. */
      title: z.string().max(256).nullable().default(null),
      description: z.string(),
    }).strict()),
  }).strict(),
  z.object({ status: z.literal("signInRequired") }).strict(),
  z.object({ status: z.literal("error"), detail: z.string().max(300) }).strict(),
]);

const server = z.object({
  id: z.uuid(),
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  /** Standing allow: every current and future tool the server offers. */
  allowAll: z.boolean(),
  /** Individually allowed tools; kept while `allowAll` is on so turning it off restores them. */
  allowedTools: z.array(McpServerToolNameSchema),
  /** A sealed credential header, an OAuth sign-in, or neither. */
  auth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("header"), header: McpServerAuthHeaderSchema }).strict(),
    z.object({ kind: z.literal("oauth") }).strict(),
  ]).nullable(),
  catalog,
}).strict();
export type McpServerSnapshot = z.infer<typeof server>;

export const McpServerSettingsSnapshotSchema = z.object({ servers: z.array(server) }).strict();
export type McpServerSettingsSnapshot = z.infer<typeof McpServerSettingsSnapshotSchema>;

const id = z.uuid();
export const McpServerSettingsUpdateSchema = z.discriminatedUnion("action", [
  /** The daemon names the server from its own `serverInfo.name`, falling back to the URL's hostname. */
  z.object({ action: z.literal("add"), url: McpServerUrlSchema }).strict(),
  z.object({ action: z.literal("remove"), id }).strict(),
  z.object({ action: z.literal("setAuth"), id, auth: credential.nullable() }).strict(),
  z.object({ action: z.literal("setAllowAll"), id, allowAll: z.boolean() }).strict(),
  z.object({ action: z.literal("setTools"), id, tools: z.array(McpServerToolNameSchema).max(1000) }).strict(),
  z.object({ action: z.literal("refresh"), id }).strict(),
  z.object({ action: z.literal("signOut"), id }).strict(),
]);
export type McpServerSettingsUpdate = z.input<typeof McpServerSettingsUpdateSchema>;

export const McpServerSignInStartParamsSchema = z.object({
  id,
  /** Where the provider returns the browser: the app's loopback sign-in callback for this daemon. */
  redirectUri: z.url({ protocol: /^https?$/u }).max(2048),
}).strict();
export type McpServerSignInStartParams = z.infer<typeof McpServerSignInStartParamsSchema>;
export const McpServerSignInStartResultSchema = z.object({ authorizationUrl: z.url({ protocol: /^https?$/u }) }).strict();
export type McpServerSignInStartResult = z.infer<typeof McpServerSignInStartResultSchema>;

const signInState = z.string().min(16).max(256);
export const McpServerSignInFinishParamsSchema = z.union([
  z.object({ state: signInState, code: z.string().min(1).max(4096) }).strict(),
  z.object({ state: signInState, error: z.string().min(1).max(500) }).strict(),
]);
export type McpServerSignInFinishParams = z.infer<typeof McpServerSignInFinishParamsSchema>;
export const McpServerSignInFinishResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("signedIn"), server: McpServerNameSchema }).strict(),
  z.object({ outcome: z.literal("failed"), server: McpServerNameSchema, detail: z.string().max(500) }).strict(),
]);
export type McpServerSignInFinishResult = z.infer<typeof McpServerSignInFinishResultSchema>;
