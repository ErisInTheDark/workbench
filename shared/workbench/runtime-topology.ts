/*
 * Exports:
 * - WorkbenchRuntimeTopology: shared daemon server and host listener configuration.
 * - parseWorkbenchEnvironmentText: parse the bounded .env.local value shape used by Workbench.
 * - deriveWorkbenchRuntimeTopology/loadWorkbenchRuntimeTopology: validate and own every configured Workbench listener.
 * - formatWorkbenchRuntimeTopology/workbenchRuntimeForbiddenPorts: derive user-facing display and isolated-probe exclusion.
 */
import { readFile } from "node:fs/promises";

const URL_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
type WorkbenchRuntimeEnvironment = Record<string, string | undefined>;
type WorkbenchRuntimeListener = {
  key: "bridge";
  label: string;
  port: number;
};

function requiredValue(environment: WorkbenchRuntimeEnvironment, field: string, fallback: string) {
  const value = environment[field] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Workbench runtime topology requires ${field}.`);
  return value.trim();
}

function urlPort(environment: WorkbenchRuntimeEnvironment, field: string, fallback: string) {
  const value = requiredValue(environment, field, fallback);
  let parsed: URL;
  try { parsed = new URL(value); } catch (error) { throw new Error(`Workbench runtime topology ${field} must be a valid IPv4 or bracketed IPv6 URL.`, { cause: error }); }
  if (!URL_PROTOCOLS.has(parsed.protocol) || parsed.hostname.length === 0) throw new Error(`Workbench runtime topology ${field} must use HTTP(S) or WS(S) with a host.`);
  const effective = parsed.port || (parsed.protocol === "https:" || parsed.protocol === "wss:" ? "443" : "80");
  const port = Number(effective);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`Workbench runtime topology ${field} port is outside 1..65535.`);
  return port;
}

export function parseWorkbenchEnvironmentText(source: string) {
  const environment: Record<string, string> = {};
  for (const rawLine of String(source).split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) throw new Error(`Workbench runtime topology cannot parse environment line: ${rawLine}`);
    let value = match[2].trim();
    const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/u.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/u, "").trim();
    environment[match[1]!] = value;
  }
  return environment;
}

export function deriveWorkbenchRuntimeTopology(environment: WorkbenchRuntimeEnvironment) {
  const bridgeUrl = requiredValue(environment, "CODEX_APP_SERVER_URL", "ws://0.0.0.0:4500");
  const listeners: WorkbenchRuntimeListener[] = [
    { key: "bridge", label: "Workbench bridge", port: urlPort({ CODEX_APP_SERVER_URL: bridgeUrl }, "CODEX_APP_SERVER_URL", bridgeUrl) },
  ];
  for (const listener of listeners) Object.freeze(listener);
  return Object.freeze({
    endpoints: Object.freeze({ bridge: bridgeUrl }),
    listeners: Object.freeze(listeners),
  });
}

export type WorkbenchRuntimeTopology = ReturnType<typeof deriveWorkbenchRuntimeTopology>;

export async function loadWorkbenchRuntimeTopology(
  envFilePath: string,
  {
    environment = {},
    readText = readFile,
  }: {
    environment?: WorkbenchRuntimeEnvironment;
    readText?: (path: string, encoding: BufferEncoding) => Promise<string>;
  } = {},
) {
  let source: string;
  try {
    source = await readText(envFilePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error(`Workbench runtime topology could not read ${envFilePath}.`, { cause: error });
    }
    source = "";
  }
  const configured = parseWorkbenchEnvironmentText(source);
  for (const [field, value] of Object.entries(environment)) if (typeof value === "string") configured[field] = value;
  return deriveWorkbenchRuntimeTopology(configured);
}

export function formatWorkbenchRuntimeTopology(topology: WorkbenchRuntimeTopology) {
  return topology.listeners.map(({ label, port }) => `${label}=${port}`).join(", ");
}

export function workbenchRuntimeForbiddenPorts(topology: WorkbenchRuntimeTopology) {
  return new Set(topology.listeners.map(({ port }) => port));
}
