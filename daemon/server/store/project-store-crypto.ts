/*
 * Exports:
 * - ProjectStoreKeyIdentity: device, user and project location inputs for one deterministic key.
 * - deriveProjectStoreKey: derive the AES-256 key for one project on this device and user.
 * - sealProjectStoreValue: encrypt one value bound to its project and key name.
 * - openProjectStoreValue: decrypt one value, or null when the key, binding or ciphertext does not match.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface ProjectStoreKeyIdentity {
  deviceId: string;
  user: string;
  projectLocation: string;
}

const SALT = "workbench-project-store-v1";
const TAG_BYTES = 16;

export function deriveProjectStoreKey({ deviceId, user, projectLocation }: ProjectStoreKeyIdentity) {
  if (!deviceId || !user || !projectLocation) throw new Error("Project store key identity is incomplete.");
  return Buffer.from(hkdfSync("sha256", deviceId, SALT, `${user}\0${projectLocation}`, 32));
}

function binding(projectId: string, key: string) {
  return Buffer.from(`${projectId}\0${key}`, "utf8");
}

export function sealProjectStoreValue(secret: Buffer, projectId: string, key: string, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce).setAAD(binding(projectId, key));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce, ciphertext };
}

export function openProjectStoreValue(secret: Buffer, projectId: string, key: string, sealed: { nonce: Uint8Array; ciphertext: Uint8Array }) {
  const ciphertext = Buffer.from(sealed.ciphertext);
  if (ciphertext.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(sealed.nonce)).setAAD(binding(projectId, key));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    // Authentication failure is the expected outcome for another device, user, location or tampered row.
    return null;
  }
}
