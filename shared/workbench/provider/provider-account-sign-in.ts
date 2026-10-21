/*
 * Exports:
 * - ProviderSignInMethodSchema/ProviderSignInMethod: one way to connect an integration; browser flows or a pasted key.
 * - ProviderAccountIntegrationSchema/ProviderAccountIntegration: one account a provider can sign in to, and who is signed in.
 * - ProviderSignInAttemptStateSchema/ProviderSignInAttemptState: lifecycle of one browser sign-in attempt.
 * - ProviderSignInAttemptSchema/ProviderSignInAttempt: the link, optional code and state of one browser sign-in attempt.
 * - ProviderAccountSnapshotSchema/ProviderAccountSnapshot: one provider's integrations and its current or last attempt.
 * - ProviderAccountRequestSchema/ProviderSignInStartRequestSchema/ProviderSignInAttemptRequestSchema/ProviderSignInCodeRequestSchema/
 *   ProviderSignOutRequestSchema and their types: browser request params for account reads, sign-in steps and sign-out.
 */
import { z } from "zod";

export const ProviderSignInMethodSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  kind: z.enum(["browser", "key"]),
}).strict();
export type ProviderSignInMethod = z.infer<typeof ProviderSignInMethodSchema>;

export const ProviderAccountIntegrationSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  /** The integration a provider row's main Sign in button connects. */
  primary: z.boolean(),
  signedIn: z.boolean(),
  /** Account email or connection label; null when signed out or unnamed. */
  accountLabel: z.string().nullable(),
  methods: z.array(ProviderSignInMethodSchema),
}).strict();
export type ProviderAccountIntegration = z.infer<typeof ProviderAccountIntegrationSchema>;

export const ProviderSignInAttemptStateSchema = z.enum(["pending", "succeeded", "failed", "cancelled"]);
export type ProviderSignInAttemptState = z.infer<typeof ProviderSignInAttemptStateSchema>;

export const ProviderSignInAttemptSchema = z.object({
  id: z.string().min(1),
  integrationId: z.string(),
  /** Page that finishes sign-in from any device. */
  url: z.string(),
  /** One-time code the user enters on that page; null when the page needs none. */
  userCode: z.string().nullable(),
  /** Whether the provider accepts a code pasted back from that page. */
  acceptsCode: z.boolean(),
  state: ProviderSignInAttemptStateSchema,
  error: z.string().max(2000).nullable(),
  /** Epoch milliseconds when the attempt expires. */
  expiresAt: z.number(),
}).strict();
export type ProviderSignInAttempt = z.infer<typeof ProviderSignInAttemptSchema>;

export const ProviderAccountSnapshotSchema = z.object({
  provider: z.string(),
  integrations: z.array(ProviderAccountIntegrationSchema),
  attempt: ProviderSignInAttemptSchema.nullable(),
}).strict();
export type ProviderAccountSnapshot = z.infer<typeof ProviderAccountSnapshotSchema>;

export const ProviderAccountRequestSchema = z.object({ provider: z.string().min(1) }).strict();
export type ProviderAccountRequest = z.infer<typeof ProviderAccountRequestSchema>;

export const ProviderSignInStartRequestSchema = ProviderAccountRequestSchema.extend({
  integrationId: z.string().min(1),
  methodId: z.string().min(1),
  /** Required by key methods only. */
  key: z.string().min(1).max(4000).optional(),
}).strict();
export type ProviderSignInStartRequest = z.infer<typeof ProviderSignInStartRequestSchema>;

export const ProviderSignInAttemptRequestSchema = ProviderAccountRequestSchema.extend({ attemptId: z.string().min(1) }).strict();
export type ProviderSignInAttemptRequest = z.infer<typeof ProviderSignInAttemptRequestSchema>;

export const ProviderSignInCodeRequestSchema = ProviderSignInAttemptRequestSchema.extend({ code: z.string().min(1).max(4000) }).strict();
export type ProviderSignInCodeRequest = z.infer<typeof ProviderSignInCodeRequestSchema>;

export const ProviderSignOutRequestSchema = ProviderAccountRequestSchema.extend({ integrationId: z.string().min(1) }).strict();
export type ProviderSignOutRequest = z.infer<typeof ProviderSignOutRequestSchema>;
