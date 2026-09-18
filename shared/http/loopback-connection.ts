/*
 * Exports:
 * - isLoopbackConnection: admit only live sockets whose actual peer is loopback.
 */
import { BlockList, isIP, type Socket } from "node:net";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
export function isLoopbackConnection(socket: Socket): boolean {
  if (socket.destroyed || !socket.remoteAddress) return false;
  const family = isIP(socket.remoteAddress);
  return !!family && loopback.check(socket.remoteAddress, family === 4 ? "ipv4" : "ipv6");
}
