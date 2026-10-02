/*
 * Exports:
 * - VirtualRepoRefKindSchema/VirtualRepoRefKind: branch-or-tag tie breaker for warm requests.
 * - VirtualRepoUrlSchema: credential-free git remote accepted by warm requests.
 * - VirtualRepoWarmRequestSchema/VirtualRepoWarmRequest: daemon command body for warming one remote ref.
 * - VirtualRepoAvailabilitySchema/VirtualRepoAvailability: selected-daemon runtime prerequisite snapshot.
 * - VirtualRepoProbeSchema: sidecar probe output before platform enrichment.
 * - VirtualRepoWarmResultSchema/VirtualRepoWarmResult: sidecar warm result pinned to one commit.
 * - VirtualRepoPipeResponseSchema: sidecar JSON-line response frame.
 * - REPO_RUNTIME_READ_METHOD: browser request for the selected daemon's availability.
 */
import { z } from "zod";

export const REPO_RUNTIME_READ_METHOD = "repo/runtime/read";

export const VirtualRepoRefKindSchema = z.enum(["branch", "tag"]);
export type VirtualRepoRefKind = z.infer<typeof VirtualRepoRefKindSchema>;

const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/iu;
const passwordUserinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/@:]*:[^/@]*@/iu;

/**
 * HTTP(S) userinfo is always a credential; ssh users (git@) are identities, but an ssh password is not.
 * The sidecar re-validates, so this edge check only keeps credentials out of daemon requests and logs.
 */
export const VirtualRepoUrlSchema = z.string().trim().min(1).max(2048)
  .refine(value => !/[\s\0]/u.test(value), "Repository URLs cannot contain whitespace.")
  .refine(value => !value.startsWith("-"), "Repository URLs cannot start with -.")
  .refine(value => !(/^https?:/iu.test(value) && userinfo.test(value)) && !passwordUserinfo.test(value),
    "Repository URLs cannot contain credentials; use a git credential helper.")
  .describe("Git remote, such as https://github.com/team/project.git or git@github.com:team/project.git.");

export const VirtualRepoWarmRequestSchema = z.object({
  url: VirtualRepoUrlSchema,
  ref: z.string().trim().min(1).max(255).optional()
    .describe("Exact branch or tag name. Omit for the remote's default branch."),
  kind: VirtualRepoRefKindSchema.optional().describe("Choose when a branch and tag share the ref name."),
}).strict();
export type VirtualRepoWarmRequest = z.infer<typeof VirtualRepoWarmRequestSchema>;

export const VirtualRepoProbeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }).strict(),
  z.object({ status: z.literal("missing"), requirement: z.enum(["winfsp", "fuse", "git"]) }).strict(),
  z.object({ status: z.literal("checkFailed") }).strict(),
]);

const platform = z.enum(["windows", "linux", "other"]);
export const VirtualRepoAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ platform, status: z.literal("available") }).strict(),
  z.object({ platform, status: z.literal("missing"), requirement: z.enum(["winfsp", "fuse", "git"]) }).strict(),
  z.object({ platform, status: z.literal("nativeMissing") }).strict(),
  z.object({ platform, status: z.literal("checkFailed") }).strict(),
  z.object({ platform, status: z.literal("unsupported") }).strict(),
]);
export type VirtualRepoAvailability = z.infer<typeof VirtualRepoAvailabilitySchema>;

const objectId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/u);

export const VirtualRepoWarmResultSchema = z.object({
  key: z.string().min(1).max(4096),
  commit: objectId,
  path: z.string().min(1).max(32_768),
}).strict();
export type VirtualRepoWarmResult = z.infer<typeof VirtualRepoWarmResultSchema>;

export const VirtualRepoPipeResponseSchema = z.union([
  z.object({ id: z.string().min(1), result: z.json() }).strict(),
  z.object({ id: z.string().min(1), error: z.string().max(4096) }).strict(),
]);
