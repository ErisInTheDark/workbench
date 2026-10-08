/*
 * Exports:
 * - HostCertificatePlatformOptions: inject host identity and trust-tool probes.
 * - default detectHostCertificatePlatform: refine Linux into one safe certificate trust mechanism.
 */
import { existsSync, readFileSync } from "node:fs";

const UPDATE_CA_CERTIFICATES = [
  "/usr/local/sbin/update-ca-certificates",
  "/usr/sbin/update-ca-certificates",
  "/usr/bin/update-ca-certificates",
  "/sbin/update-ca-certificates",
  "/bin/update-ca-certificates",
] as const;
const P11_KIT_TRUST = [
  "/usr/local/bin/trust",
  "/usr/bin/trust",
  "/usr/sbin/trust",
  "/bin/trust",
  "/sbin/trust",
] as const;

export interface HostCertificatePlatformOptions {
  pathExists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  readOsRelease?: () => string;
  warn?: (message: string) => void;
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : null;
}

function osReleaseIds(source: string) {
  const values: string[] = [];
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(?:ID|ID_LIKE)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    const encoded = match[1]!.trim();
    const value = encoded.length > 1 && encoded[0] === encoded.at(-1) && (encoded[0] === "'" || encoded[0] === "\"")
      ? encoded.slice(1, -1)
      : encoded;
    values.push(...value.toLowerCase().split(/\s+/u).filter(Boolean));
  }
  return new Set(values);
}

export default function detectHostCertificatePlatform(options: HostCertificatePlatformOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return platform;
  const pathExists = options.pathExists ?? existsSync;
  let ids = new Set<string>();
  try {
    ids = osReleaseIds((options.readOsRelease ?? (() => readFileSync("/etc/os-release", "utf8")))());
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      options.warn?.("Linux certificate trust detection failed; using manual installation guidance.");
      return "linux";
    }
  }
  if (ids.has("nixos")) return "linux:nixos";
  if (UPDATE_CA_CERTIFICATES.some(pathExists)) return "linux:update-ca-certificates";
  if (P11_KIT_TRUST.some(pathExists)) return "linux:p11-kit";
  return "linux";
}
