/*
 * Exports:
 * - DEFAULT_WORKBENCH_DAEMON_PORT/DEFAULT_WORKBENCH_DAEMON_URL: fallback daemon address.
 * - getWorkbenchDaemonPort/getWorkbenchDaemonUrl: configured browser or local daemon address.
 * - getWorkbenchDaemonHttpOrigin: HTTP origin corresponding to the daemon socket.
 * - getWorkbenchDaemonReadyUrl/getWorkbenchDaemonHealthUrl: daemon health endpoints.
 * - getWorkbenchTranscriptAssetUrl: canonical transcript asset URL.
 * - getWorkbenchProjectIconUrl: map one project identity to the daemon HTTP icon route.
 */
export const DEFAULT_WORKBENCH_DAEMON_PORT = "4500";
export const DEFAULT_WORKBENCH_DAEMON_URL = `ws://127.0.0.1:${DEFAULT_WORKBENCH_DAEMON_PORT}`;

function readNonEmptyEnv(value: string | undefined) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

function parseConfiguredWebSocketPort(url: string | null) {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      return null;
    }

    return parsedUrl.port || (parsedUrl.protocol === "wss:" ? "443" : "80");
  } catch {
    return null;
  }
}

function readBrowserLocationHref() {
  const browserGlobal = globalThis as typeof globalThis & {
    location?: {
      href?: unknown;
    };
  };
  return typeof browserGlobal.location?.href === "string" ? browserGlobal.location.href : null;
}

function buildDaemonUrlFromCurrentLocation(locationHref: string, port: string) {
  const browserUrl = new URL(locationHref);
  browserUrl.protocol = browserUrl.protocol === "https:" ? "wss:" : "ws:";
  browserUrl.port = port;
  browserUrl.pathname = "";
  browserUrl.search = "";
  browserUrl.hash = "";
  return browserUrl.toString().replace(/\/$/, "");
}

export function getWorkbenchDaemonPort() {
  return readNonEmptyEnv(process.env.WORKBENCH_CODEX_APP_SERVER_PORT)
    ?? parseConfiguredWebSocketPort(readNonEmptyEnv(process.env.WORKBENCH_CODEX_APP_SERVER_URL))
    ?? DEFAULT_WORKBENCH_DAEMON_PORT;
}

export function getWorkbenchDaemonUrl() {
  const explicitPublicUrl = readNonEmptyEnv(process.env.WORKBENCH_CODEX_APP_SERVER_URL);
  if (explicitPublicUrl) {
    return explicitPublicUrl;
  }

  const browserLocationHref = readBrowserLocationHref();
  if (browserLocationHref) {
    return buildDaemonUrlFromCurrentLocation(browserLocationHref, getWorkbenchDaemonPort());
  }

  return readNonEmptyEnv(process.env.CODEX_APP_SERVER_URL)
    ?? DEFAULT_WORKBENCH_DAEMON_URL;
}

export function getWorkbenchDaemonHttpOrigin() {
  const websocketUrl = new URL(getWorkbenchDaemonUrl());
  websocketUrl.protocol = websocketUrl.protocol === "wss:" ? "https:" : "http:";
  websocketUrl.pathname = "";
  websocketUrl.search = "";
  websocketUrl.hash = "";
  return websocketUrl.toString().replace(/\/$/, "");
}

export function getWorkbenchDaemonReadyUrl() {
  return `${getWorkbenchDaemonHttpOrigin()}/readyz`;
}

export function getWorkbenchDaemonHealthUrl() {
  return `${getWorkbenchDaemonHttpOrigin()}/healthz`;
}

export function getWorkbenchTranscriptAssetUrl(value: string) {
  const assetUrl = value.trim();
  return assetUrl.startsWith("/api/transcript-assets/")
    ? `${getWorkbenchDaemonHttpOrigin()}/daemon/transcript-assets/${assetUrl.slice("/api/transcript-assets/".length)}`
    : value;
}

export function getWorkbenchProjectIconUrl(projectId: string, assetKey: string) {
  return `${getWorkbenchDaemonHttpOrigin()}/daemon/project-icons/${encodeURIComponent(projectId)}?asset=${encodeURIComponent(assetKey)}`;
}
