/*
 * Exports:
 * - parseListeningLoopbackPorts: read one /proc/net/tcp or tcp6 table into its loopback-reachable listening ports.
 * - readListeningLoopbackPorts: read this process's network namespace TCP tables into one port set.
 */
import { readFile } from "node:fs/promises";

const TCP_LISTEN_STATE = "0A";

/** The kernel prints each address as host-order 32-bit words; returns network-order bytes. */
function decodeAddress(hex: string): Uint8Array | null {
  if ((hex.length !== 8 && hex.length !== 32) || !/^[0-9a-f]+$/iu.test(hex)) return null;
  const raw = Buffer.from(hex, "hex");
  const bytes = new Uint8Array(raw.length);
  for (let word = 0; word < raw.length; word += 4) {
    for (let offset = 0; offset < 4; offset++) bytes[word + offset] = raw[word + 3 - offset]!;
  }
  return bytes;
}

/** Loopback or wildcard, including IPv4-mapped IPv6 forms. */
function reachableFromLoopback(bytes: Uint8Array) {
  const mapped = bytes.length === 16 && bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const ipv4 = bytes.length === 4 ? bytes : mapped ? bytes.subarray(12) : null;
  if (ipv4) return ipv4[0] === 127 || ipv4.every(byte => byte === 0);
  return bytes.subarray(0, 15).every(byte => byte === 0) && (bytes[15] === 0 || bytes[15] === 1);
}

export function parseListeningLoopbackPorts(table: string): Set<number> {
  const ports = new Set<number>();
  for (const line of table.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 4 || fields[3] !== TCP_LISTEN_STATE) continue;
    const [address, portHex] = fields[1]!.split(":");
    const bytes = address ? decodeAddress(address) : null;
    const port = portHex ? Number.parseInt(portHex, 16) : Number.NaN;
    if (bytes && port > 0 && port <= 65535 && reachableFromLoopback(bytes)) ports.add(port);
  }
  return ports;
}

export async function readListeningLoopbackPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  for (const [table, optional] of [["/proc/self/net/tcp", false], ["/proc/self/net/tcp6", true]] as const) {
    let text: string;
    try {
      text = await readFile(table, "utf8");
    } catch (error) {
      // Hosts without IPv6 have no tcp6 table.
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const port of parseListeningLoopbackPorts(text)) ports.add(port);
  }
  return ports;
}
