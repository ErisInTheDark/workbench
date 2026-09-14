/*
 * Exports:
 * - HarnessKind: Workbench harness selector alias shared across daemon modules.
 * - JsonRpcRequest/JsonRpcResponse/JsonRpcNotification: shared transport shapes for the local WebSocket bridge.
 * - BridgeClient: minimal websocket client contract used by the daemon modules.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

export type HarnessKind = WorkbenchHarness;

export type JsonRpcRequest = Record<string, unknown> & {
  id?: number | string | null;
  method?: string;
};

export type JsonRpcResponse = {
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    data?: unknown;
    message: string;
  };
};

export type JsonRpcNotification = {
  method: string;
  params: unknown;
};

export type BridgeClient = {
  OPEN: number;
  close: (code?: number, reason?: string) => void;
  on: (event: "message", listener: (data: Buffer) => void) => void;
  once: (event: "close" | "error", listener: (arg?: unknown) => void) => void;
  readyState: number;
  send: (data: string, callback?: (error?: Error) => void) => void;
};
