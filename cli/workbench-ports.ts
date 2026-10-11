/*
 * Exports:
 * - WorkbenchPort: one active local listener labelled by Workbench domain and protocol.
 * - workbenchPorts: derive sorted listener rows from active service origins.
 * - renderWorkbenchPorts: render listener rows as a human-readable table.
 * - readWorkbenchPorts: read active listeners without waking Workbench services.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkbenchServiceSnapshot } from "../shared/http/workbench-service.ts";
import WorkbenchServiceClient from "../shared/process/WorkbenchServiceClient.ts";
import { readServiceEndpoint } from "../shared/process/workbench-service-endpoint.ts";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root.ts";

export interface WorkbenchPort {
  port: number;
  domain: "host" | "daemon" | "app";
  protocol: "http/ws" | "https/wss";
}

function port(origin: string, domain: WorkbenchPort["domain"]): WorkbenchPort {
  const url = new URL(origin);
  return {
    port: Number(url.port),
    domain,
    protocol: url.protocol === "https:" ? "https/wss" : "http/ws",
  };
}

export function workbenchPorts(origins: {
  hostOrigin: string;
  daemonOrigin: string | null;
  appOrigin: string | null;
}): WorkbenchPort[] {
  return [
    port(origins.hostOrigin, "host"),
    ...(origins.daemonOrigin ? [port(origins.daemonOrigin, "daemon")] : []),
    ...(origins.appOrigin ? [port(origins.appOrigin, "app")] : []),
  ].sort((left, right) => left.port - right.port || left.domain.localeCompare(right.domain));
}

export function renderWorkbenchPorts(rows: readonly WorkbenchPort[]) {
  const values = [
    ["port", "domain", "protocol"],
    ...rows.map(row => [String(row.port), row.domain, row.protocol]),
  ];
  const widths = values[0]!.map((_, column) => Math.max(...values.map(row => row[column]!.length)));
  return values.map(row => row.map((value, column) => (
    column === row.length - 1 ? value : value.padEnd(widths[column]!)
  )).join("  ")).join("\n");
}

export async function readWorkbenchPorts(
  dataRoot = resolveWorkbenchDataRoot(),
  warn: (message: string) => void = () => {},
) {
  const endpointPath = path.join(dataRoot, "service", "runtime.json");
  const endpoint = await readServiceEndpoint(endpointPath);
  if (!endpoint) return [];
  const client = new WorkbenchServiceClient({
    endpointPath,
    read: async () => endpoint,
    observe: () => () => {},
    warn,
  });
  try {
    await client.start();
    const snapshot: WorkbenchServiceSnapshot | null = client.getSnapshot().snapshot;
    if (!snapshot) throw new Error("Workbench host did not publish its service snapshot.");
    return workbenchPorts({
      hostOrigin: endpoint.origin,
      daemonOrigin: snapshot.daemonOrigin,
      appOrigin: snapshot.network?.localUrl ? new URL(snapshot.network.localUrl).origin : null,
    });
  } finally {
    await client.close();
  }
}

async function main() {
  const rows = await readWorkbenchPorts();
  process.stdout.write(rows.length ? `${renderWorkbenchPorts(rows)}\n` : "No active Workbench ports.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
