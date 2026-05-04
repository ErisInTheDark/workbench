/*
 * Exports:
 * - DEFAULT_CODEX_APP_SERVER_BRIDGE_PORT: fallback websocket bridge port for browser clients when no public override is configured. Keywords: codex, websocket, port, fallback.
 * - DEFAULT_CODEX_APP_SERVER_URL: fallback local websocket URL for non-browser contexts. Keywords: codex, websocket, localhost, fallback.
 * - CODEX_CLIENT_INFO: stable workbench client identity for the app-server handshake. Keywords: codex, client info, initialize.
 * - getCodexAppServerPort: resolve the public browser websocket port from explicit config or defaults. Keywords: codex, websocket, port, env.
 * - getCodexAppServerUrl: resolve the browser websocket URL, preferring explicit public config and otherwise reusing the current page host with the bridge port. Keywords: codex, websocket, browser host, mobile.
 * - getCodexAppServerHttpOrigin: derive the HTTP health-check origin from the resolved websocket URL. Keywords: codex, readyz, healthz, origin.
 * - getCodexAppServerReadyUrl: resolve the bridge readiness endpoint. Keywords: codex, readyz.
 * - getCodexAppServerHealthUrl: resolve the bridge health endpoint. Keywords: codex, healthz.
 */
export const DEFAULT_CODEX_APP_SERVER_BRIDGE_PORT = "4500";
export const DEFAULT_CODEX_APP_SERVER_URL = `ws://127.0.0.1:${DEFAULT_CODEX_APP_SERVER_BRIDGE_PORT}`;

export const CODEX_CLIENT_INFO = {
  name: "workbench",
  title: "Workbench",
  version: "0.1.0",
} as const;

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

function buildCodexAppServerUrlFromCurrentLocation(locationHref: string, port: string) {
  const browserUrl = new URL(locationHref);
  browserUrl.protocol = browserUrl.protocol === "https:" ? "wss:" : "ws:";
  browserUrl.port = port;
  browserUrl.pathname = "";
  browserUrl.search = "";
  browserUrl.hash = "";
  return browserUrl.toString().replace(/\/$/, "");
}

export function getCodexAppServerPort() {
  return readNonEmptyEnv(process.env.NEXT_PUBLIC_CODEX_APP_SERVER_PORT)
    ?? parseConfiguredWebSocketPort(readNonEmptyEnv(process.env.NEXT_PUBLIC_CODEX_APP_SERVER_URL))
    ?? DEFAULT_CODEX_APP_SERVER_BRIDGE_PORT;
}

export function getCodexAppServerUrl() {
  const explicitPublicUrl = readNonEmptyEnv(process.env.NEXT_PUBLIC_CODEX_APP_SERVER_URL);
  if (explicitPublicUrl) {
    return explicitPublicUrl;
  }

  const browserLocationHref = readBrowserLocationHref();
  if (browserLocationHref) {
    return buildCodexAppServerUrlFromCurrentLocation(browserLocationHref, getCodexAppServerPort());
  }

  return readNonEmptyEnv(process.env.CODEX_APP_SERVER_URL)
    ?? DEFAULT_CODEX_APP_SERVER_URL;
}

export function getCodexAppServerHttpOrigin() {
  const websocketUrl = new URL(getCodexAppServerUrl());
  websocketUrl.protocol = websocketUrl.protocol === "wss:" ? "https:" : "http:";
  websocketUrl.pathname = "";
  websocketUrl.search = "";
  websocketUrl.hash = "";
  return websocketUrl.toString().replace(/\/$/, "");
}

export function getCodexAppServerReadyUrl() {
  return `${getCodexAppServerHttpOrigin()}/readyz`;
}

export function getCodexAppServerHealthUrl() {
  return `${getCodexAppServerHttpOrigin()}/healthz`;
}
