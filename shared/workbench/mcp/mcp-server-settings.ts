/*
 * Exports:
 * - McpServerNameSchema: agent-facing server name used by `mcp_tools` and `mcp_call`.
 * - WORKBENCH_MCP_SERVER_NAME: reserved server name under which `mcp_tools`/`mcp_call` reach Workbench's own deferred tools.
 * - McpServerUrlSchema: http(s) endpoint of one streamable-HTTP MCP server.
 * - McpPackageNameSchema/McpPackageVersionSchema/McpPackageArgsSchema: npm package, version or range, and command-line arguments of a Workbench-installed stdio server.
 * - McpServerCommandSchema: the program a cli server runs.
 * - McpServerProjectIdSchema: the daemon project a project-scoped server belongs to.
 * - McpServerSourceSchema/McpServerSource: where a server runs: a remote URL, a Workbench-installed npm package, or a local command, each stdio one with its arguments.
 * - McpServerEnvNameSchema: one environment variable name of a stdio server's process.
 * - McpServerEnv{ReadParams,Snapshot,Update,UpdateResult}Schema and types: read (values included) and transactional changes of a stdio server's sealed environment.
 * - McpServerAuthHeaderSchema: custom request header name carrying a server's sealed credential.
 * - McpServerToolNameSchema: one tool name a server offers.
 * - McpServerSettingsReadParamsSchema/McpServerSettingsReadParams: saved-only or targeted live settings reads.
 * - McpServerSettingsSnapshotSchema/McpServerSettingsSnapshot/McpServerSnapshot: configured servers, their project scope, allow rules and live catalogues; credential values are never included.
 * - McpServerSettingsUpdateSchema/McpServerSettingsUpdate: one server add (by URL, npm package or command, globally or for one project), removal, rename, stdio arguments, credential, allow-rule, refresh or sign-out change.
 * - McpServerSignInStart{Params,Result}Schema/McpServerSignInStart{Params,Result}: begin OAuth sign-in and receive its authorization URL.
 * - McpServerSignInFinish{Params,Result}Schema/McpServerSignInFinish{Params,Result}: finish the provider's callback and report its outcome.
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

// Registry names only: no paths, URLs or git specs, and never a leading `-` npm could read as a flag.
export const McpPackageNameSchema = z.string().trim().max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u, "Use an npm package name, like @scope/name.");

/** An exact version, range or dist-tag, such as `1.2.3`, `^2` or `latest`. */
export const McpPackageVersionSchema = z.string().trim().max(256)
  .regex(/^[A-Za-z0-9^~<>=*][A-Za-z0-9.^~<>=*+_-]*$/u, "Use an npm version, range or tag, like 1.2.3 or latest.");

export const McpPackageArgsSchema = z.array(z.string().max(4096)).max(64);

/** A program name found on PATH, or a path; a relative path resolves from the project folder (home for global servers). */
export const McpServerCommandSchema = z.string().trim().min(1, "Type a command.").max(4096);

export const McpServerProjectIdSchema = z.string().trim().min(1).max(256);

export const McpServerSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), url: McpServerUrlSchema }).strict(),
  z.object({
    kind: z.literal("npm"), package: McpPackageNameSchema,
    /** The requested version or range until the first install pins the exact version; a missing install is restored at this version. */
    version: McpPackageVersionSchema, args: McpPackageArgsSchema,
  }).strict(),
  z.object({ kind: z.literal("cli"), command: McpServerCommandSchema, args: McpPackageArgsSchema }).strict(),
]);
export type McpServerSource = z.infer<typeof McpServerSourceSchema>;

export const McpServerEnvNameSchema = z.string().trim().max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Use letters, digits and _, not starting with a digit.");

export const McpServerEnvUpdateSchema = z.object({
  id: z.uuid(),
  upserts: z.array(z.object({ key: McpServerEnvNameSchema, value: z.string().max(32 * 1024) }).strict()).max(256),
  removals: z.array(McpServerEnvNameSchema).max(256),
}).strict().refine(({ upserts, removals }) => {
  const keys = upserts.map(entry => entry.key);
  return new Set(keys).size === keys.length && !keys.some(key => removals.includes(key));
}, "Each variable may change at most once per update.");
export type McpServerEnvUpdate = z.infer<typeof McpServerEnvUpdateSchema>;

export const McpServerEnvReadParamsSchema = z.object({ id: z.uuid() }).strict();
export type McpServerEnvReadParams = z.infer<typeof McpServerEnvReadParamsSchema>;

export const McpServerEnvSnapshotSchema = z.object({
  entries: z.array(z.union([
    z.object({ key: McpServerEnvNameSchema, value: z.string() }).strict(),
    z.object({ key: McpServerEnvNameSchema, unreadable: z.literal(true) }).strict(),
  ])),
}).strict();
export type McpServerEnvSnapshot = z.infer<typeof McpServerEnvSnapshotSchema>;

export const McpServerEnvUpdateResultSchema = z.object({ ok: z.literal(true) }).strict();
export type McpServerEnvUpdateResult = z.infer<typeof McpServerEnvUpdateResultSchema>;

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
  z.object({ status: z.literal("pending") }).strict(),
  /** Workbench is installing the server's npm package; a targeted read waits for it. */
  z.object({ status: z.literal("installing") }).strict(),
  z.object({
    status: z.literal("ready"),
    tools: z.array(z.object({
      name: McpServerToolNameSchema,
      /** Human-readable title the server gives the tool, when it gives one. */
      title: z.string().max(256).nullable().default(null),
      description: z.string(),
    }).strict()),
    /** Search-based (wrapped) server: `tools` holds only enabled tools; agents find the rest by searching. */
    search: z.boolean().optional(),
  }).strict(),
  z.object({ status: z.literal("signInRequired") }).strict(),
  z.object({ status: z.literal("error"), detail: z.string().max(300) }).strict(),
]);

const server = z.object({
  id: z.uuid(),
  name: McpServerNameSchema,
  source: McpServerSourceSchema,
  /** The one daemon project whose threads see this server; null for every project. */
  projectId: McpServerProjectIdSchema.nullable(),
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

export const McpServerSettingsReadParamsSchema = z.object({
  configuredOnly: z.boolean().optional(),
  id: z.uuid().optional(),
}).strict();
export type McpServerSettingsReadParams = z.infer<typeof McpServerSettingsReadParamsSchema>;

const id = z.uuid();
/** Scopes an added server to one daemon project; omitted for every project. */
const projectId = McpServerProjectIdSchema.optional();
export const McpServerSettingsUpdateSchema = z.discriminatedUnion("action", [
  /** The daemon names the server from its own `serverInfo.name`, falling back to the URL's hostname. */
  z.object({ action: z.literal("add"), url: McpServerUrlSchema, projectId }).strict(),
  /** Saves the server at once, named after the package, and installs it under the daemon's data root in the background. */
  z.object({
    action: z.literal("addPackage"), package: McpPackageNameSchema,
    /** Version or range to install; the latest release when omitted. */
    version: McpPackageVersionSchema.optional(), args: McpPackageArgsSchema, projectId,
  }).strict(),
  /** Saves a local command, named after the program, run as this computer's user from the project folder (home when global). */
  z.object({ action: z.literal("addCommand"), command: McpServerCommandSchema, args: McpPackageArgsSchema, projectId }).strict(),
  z.object({ action: z.literal("setArgs"), id: z.uuid(), args: McpPackageArgsSchema }).strict(),
  z.object({ action: z.literal("remove"), id }).strict(),
  z.object({ action: z.literal("setAuth"), id, auth: credential.nullable() }).strict(),
  z.object({ action: z.literal("setAllowAll"), id, allowAll: z.boolean() }).strict(),
  z.object({ action: z.literal("setTools"), id, tools: z.array(McpServerToolNameSchema).max(1000) }).strict(),
  z.object({ action: z.literal("refresh"), id }).strict(),
  z.object({ action: z.literal("signOut"), id }).strict(),
  z.object({
    action: z.literal("rename"), id,
    name: McpServerNameSchema.refine(name => name !== WORKBENCH_MCP_SERVER_NAME, `"${WORKBENCH_MCP_SERVER_NAME}" is reserved for Workbench's own tools.`),
  }).strict(),
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
