/*
 * Exports:
 * - CODEX_CLIENT_INFO: native Codex handshake identity.
 * - DEFAULT_CODEX_APP_SERVER_BRIDGE_PORT/DEFAULT_CODEX_APP_SERVER_URL: compatible daemon defaults.
 * - getCodexAppServerPort/getCodexAppServerUrl/getCodexAppServerHttpOrigin: compatible daemon addresses.
 * - getCodexAppServerReadyUrl/getCodexAppServerHealthUrl: compatible health addresses.
 * - getCodexTranscriptAssetUrl/getWorkbenchProjectIconUrl: compatible asset addresses.
 */
export {
  DEFAULT_WORKBENCH_DAEMON_PORT as DEFAULT_CODEX_APP_SERVER_BRIDGE_PORT,
  DEFAULT_WORKBENCH_DAEMON_URL as DEFAULT_CODEX_APP_SERVER_URL,
  getWorkbenchDaemonPort as getCodexAppServerPort,
  getWorkbenchDaemonUrl as getCodexAppServerUrl,
  getWorkbenchDaemonHttpOrigin as getCodexAppServerHttpOrigin,
  getWorkbenchDaemonReadyUrl as getCodexAppServerReadyUrl,
  getWorkbenchDaemonHealthUrl as getCodexAppServerHealthUrl,
  getWorkbenchTranscriptAssetUrl as getCodexTranscriptAssetUrl,
  getWorkbenchProjectIconUrl,
} from "../workbench/workbench-connection.ts";

export const CODEX_CLIENT_INFO = {
  name: "workbench", title: "Workbench", version: "0.1.0",
} as const;
