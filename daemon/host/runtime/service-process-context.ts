/*
 * Exports:
 * - ServiceProcessContext: stable listener, session and daemon-supervision capabilities.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type WorkbenchServiceSessions from "../WorkbenchServiceSessions.ts";
import type { WorkbenchDaemonIdentity } from "../../../shared/http/workbench-daemon-discovery.ts";
import type { WorkbenchReloadScope } from "../../../shared/reload/workbench-reload.ts";

export interface ServiceProcessContext {
  root: string;
  dataRoot: string;
  sessions: WorkbenchServiceSessions;
  ingressToken: string;
  brokerOrigin(): string;
  daemonAvailable(): boolean;
  identity(): WorkbenchDaemonIdentity;
  daemonTarget(signal: AbortSignal, remote: boolean): Promise<string>;
  publish(): void;
  warn(message: string): void;
  reload(scopes: readonly WorkbenchReloadScope[]): Promise<void>;
  restart(): void;
  control(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}
