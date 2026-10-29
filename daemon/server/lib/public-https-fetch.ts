/*
 * Exports:
 * - PublicHttpsFetchPorts: injectable fetch and DNS lookup.
 * - fetchPublicHttps: GET an https link, following redirects itself so every hop's host must resolve to public addresses only.
 * - readBoundedBody: read a response body, failing once it exceeds a byte cap.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface PublicHttpsFetchPorts {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Every address a host resolves to. */
  lookup?: (host: string) => Promise<string[]>;
}

const MAX_REDIRECTS = 5;

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv6");
}

function isPrivate(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

async function assertPublic(hostname: string, lookup: PublicHttpsFetchPorts["lookup"]) {
  const host = hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(host) ? [host] : await (lookup ?? (async name => (await dnsLookup(name, { all: true })).map(entry => entry.address)))(host);
  if (!addresses.length || addresses.some(isPrivate)) throw new Error(`${hostname} resolves to a local or private address.`);
}

export async function fetchPublicHttps(link: string | URL, signal: AbortSignal, ports: PublicHttpsFetchPorts = {}) {
  let url = new URL(link);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== "https:") throw new Error("Only https links can be fetched.");
    await assertPublic(url.hostname, ports.lookup);
    const response = await (ports.fetch ?? fetch)(url.href, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The link answered HTTP ${response.status}.`);
    }
    return { response, url };
  }
  throw new Error(`The link redirected more than ${MAX_REDIRECTS} times.`);
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`The body is larger than ${maxBytes} bytes.`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error(`The body is larger than ${maxBytes} bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
