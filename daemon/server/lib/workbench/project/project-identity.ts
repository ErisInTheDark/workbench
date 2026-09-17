/*
 * Exports:
 * - remoteProjectKey: derive repository identity from a supported origin URL.
 * - localProjectKey: derive local identity from an absolute canonical path.
 * - workspaceProjectKey: derive workspace identity from its distinct member identities.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { ProjectIdentityKeySchema, type ProjectIdentityKey } from "workbench-shared/workbench/identity";
import { nativeLocationKey } from "../../../database/thread-identity/native-location-key.ts";

export function remoteProjectKey(origin: string): ProjectIdentityKey {
  const value = origin.trim();
  const scp = !value.includes("://") && /^(?:[^/@:\s]+@)?([^/:\s]+):([^:].*)$/u.exec(value);
  let url: URL;
  try {
    url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value);
  } catch {
    throw new Error("Repository origin is not a supported URL.");
  }
  if (!["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("Repository origin uses an unsupported URL shape.");
  }
  if (url.protocol === "file:") {
    if (!url.pathname || url.username || url.password) throw new Error("Repository file origin is invalid.");
    return ProjectIdentityKeySchema.parse(`remote://${url.href}`);
  }
  const repository = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (!url.hostname || !repository) throw new Error("Repository origin has no repository path.");
  const defaultPort = ({ "ssh:": "22", "git:": "9418", "https:": "443", "http:": "80" } as const)[url.protocol as "ssh:" | "git:" | "https:" | "http:"];
  // Non-default ports may name different servers, even when host and repository match.
  const authority = url.port && url.port !== defaultPort
    ? `${url.protocol}//${url.hostname}:${url.port}`
    : url.hostname;
  return ProjectIdentityKeySchema.parse(`remote://${authority}/${repository}`);
}

export function localProjectKey(canonicalPath: string, platform: NodeJS.Platform = process.platform): ProjectIdentityKey {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(canonicalPath)) throw new Error("Local project identity requires an absolute canonical path.");
  return ProjectIdentityKeySchema.parse(`local://${nativeLocationKey(canonicalPath, platform).replaceAll("\\", "/")}`);
}

export function workspaceProjectKey(members: readonly ProjectIdentityKey[]): ProjectIdentityKey {
  if (!members.length) throw new Error("Workspace identity requires at least one member.");
  const memberSet = [...new Set(members)].sort();
  const digest = createHash("sha256").update(JSON.stringify(memberSet)).digest("hex");
  return ProjectIdentityKeySchema.parse(`workspace://${digest}`);
}
