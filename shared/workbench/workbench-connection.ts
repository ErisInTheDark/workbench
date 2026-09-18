/*
 * Exports:
 * - workbenchDaemonConnection: browser-lifetime resolved daemon endpoint owner.
 * - getWorkbenchDaemonUrl: current resolved daemon address.
 * - getWorkbenchDaemonHttpOrigin: HTTP origin corresponding to the daemon socket.
 * - getWorkbenchDaemonReadyUrl/getWorkbenchDaemonHealthUrl: daemon health endpoints.
 * - getWorkbenchTranscriptAssetUrl: canonical transcript asset URL.
 * - getWorkbenchProjectIconUrl: map one project identity to the daemon HTTP icon route.
 */
import WorkbenchDaemonConnection from "./WorkbenchDaemonConnection.ts";

function readBrowserLocationHref() {
  const browserGlobal = globalThis as typeof globalThis & {
    location?: {
      href?: unknown;
    };
  };
  return typeof browserGlobal.location?.href === "string" ? browserGlobal.location.href : null;
}

export const workbenchDaemonConnection = new WorkbenchDaemonConnection({
  location: readBrowserLocationHref,
  configuredUrl: () => process.env.WORKBENCH_CODEX_APP_SERVER_URL?.trim() || null,
});

export function getWorkbenchDaemonUrl() {
  return workbenchDaemonConnection.getSnapshot().url;
}

export function getWorkbenchDaemonHttpOrigin() {
  const current = getWorkbenchDaemonUrl();
  if (!current) return null;
  const websocketUrl = new URL(current);
  websocketUrl.protocol = websocketUrl.protocol === "wss:" ? "https:" : "http:";
  websocketUrl.pathname = "";
  websocketUrl.search = "";
  websocketUrl.hash = "";
  return websocketUrl.toString().replace(/\/$/, "");
}

export function getWorkbenchDaemonReadyUrl() {
  const origin = getWorkbenchDaemonHttpOrigin();
  return origin ? `${origin}/readyz` : null;
}

export function getWorkbenchDaemonHealthUrl() {
  const origin = getWorkbenchDaemonHttpOrigin();
  return origin ? `${origin}/healthz` : null;
}

export function getWorkbenchTranscriptAssetUrl(value: string) {
  const assetUrl = value.trim();
  if (!assetUrl.startsWith("/api/transcript-assets/")) return value;
  const origin = getWorkbenchDaemonHttpOrigin();
  return origin ? `${origin}/daemon/transcript-assets/${assetUrl.slice("/api/transcript-assets/".length)}` : null;
}

export function getWorkbenchProjectIconUrl(projectId: string, assetKey: string) {
  const origin = getWorkbenchDaemonHttpOrigin();
  return origin ? `${origin}/daemon/project-icons/${encodeURIComponent(projectId)}?asset=${encodeURIComponent(assetKey)}` : null;
}
