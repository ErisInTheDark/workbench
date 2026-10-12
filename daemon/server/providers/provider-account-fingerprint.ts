/*
 * Exports:
 * - default providerAccountFingerprint: one-way fingerprint of the text that identifies a provider account.
 */
import { createHash } from "node:crypto";

/** Hashed so the stored key never reveals the email or credential it came from. */
export default function providerAccountFingerprint(harness: string, identifying: string) {
  return createHash("sha256").update(`${harness}\0${identifying}`).digest("hex").slice(0, 32);
}
