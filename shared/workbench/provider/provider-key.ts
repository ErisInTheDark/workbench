/*
 * Exports:
 * - ProviderKeySchema: validate persisted and external provider identity.
 * - ProviderKey: provider identity independent of installed implementations.
 */
import { z } from "zod";

export const ProviderKeySchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);
export type ProviderKey = z.infer<typeof ProviderKeySchema>;
