export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";

export const CODEX_CLIENT_INFO = {
  name: "workbench",
  title: "Workbench",
  version: "0.1.0",
} as const;

export function getCodexAppServerUrl() {
  return process.env.NEXT_PUBLIC_CODEX_APP_SERVER_URL
    ?? process.env.CODEX_APP_SERVER_URL
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
