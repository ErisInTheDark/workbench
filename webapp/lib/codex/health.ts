import { getCodexAppServerUrl } from "./config";
import {
  createInitializeRequest,
  isCodexJsonRpcFailure,
  isCodexJsonRpcSuccess,
} from "./protocol";

export interface CodexHealthStatus {
  detail: string;
  ok: boolean;
  phase: "connect" | "initialize" | "ready";
  status: number | null;
  statusText: string;
  url: string;
}

export async function probeCodexAppServerReady(): Promise<CodexHealthStatus> {
  const url = getCodexAppServerUrl();
  const timeoutMs = 3000;

  return new Promise<CodexHealthStatus>((resolve) => {
    let settled = false;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      settle({
        detail: `Timed out after ${timeoutMs}ms waiting for the app-server handshake.`,
        ok: false,
        phase: "connect",
        status: null,
        statusText: "Timeout",
        url,
      });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
    }

    function settle(status: CodexHealthStatus) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(status);
    }

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify(createInitializeRequest(0)));
      } catch (error) {
        settle({
          detail: error instanceof Error ? error.message : "Failed to send initialize request.",
          ok: false,
          phase: "initialize",
          status: null,
          statusText: "Initialize send failed",
          url,
        });
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));

        if (typeof message !== "object" || message === null || !("id" in message) || message.id !== 0) {
          return;
        }

        if (isCodexJsonRpcFailure(message)) {
          settle({
            detail: message.error.data
              ? `${message.error.message} (${JSON.stringify(message.error.data)})`
              : message.error.message,
            ok: false,
            phase: "initialize",
            status: message.error.code,
            statusText: "Initialize rejected",
            url,
          });
          return;
        }

        if (isCodexJsonRpcSuccess(message)) {
          settle({
            detail: "Connected and received initialize response from the app-server.",
            ok: true,
            phase: "ready",
            status: 200,
            statusText: "Ready",
            url,
          });
        }
      } catch (error) {
        settle({
          detail: error instanceof Error ? error.message : "Received a malformed app-server response.",
          ok: false,
          phase: "initialize",
          status: null,
          statusText: "Invalid response",
          url,
        });
      }
    };

    socket.onerror = () => {
      settle({
        detail: "The WebSocket connection failed before the app-server completed its handshake.",
        ok: false,
        phase: "connect",
        status: null,
        statusText: "WebSocket error",
        url,
      });
    };

    socket.onclose = (event) => {
      settle({
        detail: event.reason
          ? `Closed during ${event.wasClean ? "a clean" : "an unclean"} shutdown: ${event.reason}`
          : `Closed during ${event.wasClean ? "a clean" : "an unclean"} shutdown.`,
        ok: false,
        phase: settled ? "ready" : "connect",
        status: event.code,
        statusText: "Connection closed",
        url,
      });
    };
  });
}
