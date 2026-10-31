/*
 * Exports:
 * - VisVariantSchema/VisVariant: which document a vis URL serves: the live render, or the start or end snapshot.
 * - visFramePath: the path a frame loads on the vis origin; the document sits at the session's build root.
 * - parseVisFramePath: the daemon and daemon-relative path a vis origin request forwards to, or null.
 * - daemonVisPath: the same document's path on a daemon, for its own loopback vis listener.
 * - parseDaemonVisPath: the session, variant and build-root file a daemon vis request names, or null.
 * - VIS_AUDIENCE_PARAM/VIS_THEME_PARAM/VIS_REVISION_PARAM: query parameters a frame URL carries.
 * - readVisFrameQuery: the audience and theme a served document's bridge starts with.
 */
import { z } from "zod";
import { DaemonIdSchema, type DaemonId } from "../identity";
import type { WorkbenchTheme } from "../settings/workbench-setting-definitions";
import type { VisAudience } from "./vis-frame";

export const VisVariantSchema = z.enum(["live", "start", "end"]);
export type VisVariant = z.infer<typeof VisVariantSchema>;

export const VIS_AUDIENCE_PARAM = "wb-audience";
export const VIS_THEME_PARAM = "wb-theme";
/** Changes with every render, so a frame reloads onto it. */
export const VIS_REVISION_PARAM = "wb-r";

const DAEMON_PREFIX = "/daemon/vis/";
const sessionIdSchema = z.uuid();
const THEMES: Record<WorkbenchTheme, true> = { default: true, "magical-girl": true, winter: true };

export function readVisFrameQuery(search: URLSearchParams): { audience: VisAudience; theme: WorkbenchTheme | null } {
  const theme = search.get(VIS_THEME_PARAM);
  return {
    audience: search.get(VIS_AUDIENCE_PARAM) === "agent" ? "agent" : "user",
    theme: theme !== null && Object.hasOwn(THEMES, theme) ? theme as WorkbenchTheme : null,
  };
}

export function visFramePath(daemonId: DaemonId, sessionId: string, variant: VisVariant) {
  return `/${daemonId}/${sessionId}/${variant}/`;
}

export function daemonVisPath(sessionId: string, variant: VisVariant) {
  return `${DAEMON_PREFIX}${sessionId}/${variant}/`;
}

/** The vis origin forwards everything after the daemon id untouched; the daemon owns decoding it. */
export function parseVisFramePath(pathname: string): { daemonId: DaemonId; daemonPath: string } | null {
  const match = /^\/([^/]+)(\/[^/]+\/[^/]+\/.*)$/u.exec(pathname);
  const daemonId = DaemonIdSchema.safeParse(match?.[1]);
  if (!match || !daemonId.success) return null;
  return { daemonId: daemonId.data, daemonPath: `${DAEMON_PREFIX}${match[2]!.slice(1)}` };
}

/**
 * `file` is "" for the document itself. Segments decode one at a time, and any that could step outside the build
 * root or smuggle a separator reject the whole path.
 */
export function parseDaemonVisPath(pathname: string): { sessionId: string; variant: VisVariant; file: string } | null {
  if (!pathname.startsWith(DAEMON_PREFIX)) return null;
  const [sessionId, variant, ...rest] = pathname.slice(DAEMON_PREFIX.length).split("/");
  const session = sessionIdSchema.safeParse(sessionId);
  const kind = VisVariantSchema.safeParse(variant);
  if (!session.success || !kind.success || !rest.length) return null;
  const segments: string[] = [];
  for (const [index, raw] of rest.entries()) {
    if (raw === "" && index === rest.length - 1) break;
    let segment: string;
    try { segment = decodeURIComponent(raw); }
    catch { return null; }
    if (!segment || segment === "." || segment === ".." || /[/\\\0]/u.test(segment)) return null;
    segments.push(segment);
  }
  return { sessionId: session.data, variant: kind.data, file: segments.join("/") };
}
