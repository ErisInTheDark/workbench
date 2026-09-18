/* No production exports. Protect actual-socket admission at the loopback boundary. */
import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";
import { isLoopbackConnection } from "./loopback-connection.ts";

function connection(remoteAddress?: string) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
  return socket;
}

test("underlying listeners admit live loopback peers and reject raw tailnet, LAN and public peers", () => {
  for (const address of ["127.0.0.1", "127.3.2.1", "::1", "::ffff:127.0.0.1"]) {
    const socket = connection(address);
    assert.equal(isLoopbackConnection(socket), true, address);
    socket.destroy();
    assert.equal(isLoopbackConnection(socket), false, "a destroyed loopback socket must not be admitted");
  }
  for (const address of [undefined, "", "localhost", "100.80.0.2", "fd7a:115c:a1e0::2",
    "::ffff:100.80.0.2", "192.168.1.20", "10.0.0.2", "8.8.8.8", "2001:db8::1", "::ffff:192.168.1.20"]) {
    assert.equal(isLoopbackConnection(connection(address)), false, address);
  }
});
