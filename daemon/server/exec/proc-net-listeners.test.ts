/* No production exports. Tests protect which host listeners the sandbox relay mirrors into command namespaces. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseListeningLoopbackPorts } from "./proc-net-listeners";

test("only listeners reachable through loopback are reported, across IPv4, IPv6 and mapped addresses", () => {
  const ipv4 = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 101 1",
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 102 1",
    "   2: 0501A8C0:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 103 1",
    "   3: 0100007F:1388 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 104 1",
  ].join("\n");
  const ipv6 = [
    "  sl  local_address                         remote_address                        st tx_queue",
    "   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000",
    "   1: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000",
    "   2: 0000000000000000FFFF00000100007F:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000",
    "   3: 000080FE000000000000000001000000:15B3 00000000000000000000000000000000:0000 0A 00000000:00000000",
  ].join("\n");

  assert.deepEqual([...parseListeningLoopbackPorts(ipv4)].sort((a, b) => a - b), [22, 8080]);
  assert.deepEqual([...parseListeningLoopbackPorts(ipv6)].sort((a, b) => a - b), [443, 3000, 4000]);
});
