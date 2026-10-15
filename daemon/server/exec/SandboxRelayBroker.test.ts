/* No production exports. Tests protect relay admission, host port pushes and host-to-sandbox connections through the broker. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { test } from "node:test";
import SandboxRelayBroker, { type SandboxRelayAdmission } from "./SandboxRelayBroker";
import { RELAY_ENV_KEY } from "./sandbox-relay-protocol";

function harness(resolveRelay: () => Promise<string> = async () => "/opt/workbench-relay") {
  let hostPorts = new Set([5000, 6000]);
  let tick: (() => void) | null = null;
  const errors: string[] = [];
  const broker = new SandboxRelayBroker({
    root: "unused", resolveRelay,
    readHostPorts: async () => hostPorts,
    schedulePoll: next => {
      tick = next;
      return () => { tick = null; };
    },
    reportError: message => errors.push(message),
  });
  return {
    broker, errors,
    setHostPorts: (ports: number[]) => { hostPorts = new Set(ports); },
    tick: () => tick?.(),
    polling: () => tick !== null,
  };
}

/** Reads newline-delimited JSON from a socket, one awaited message at a time. */
function lines(socket: Socket) {
  const queued: unknown[] = [];
  const waiting: ((message: unknown) => void)[] = [];
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const message: unknown = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise<unknown>(resolve => waiting.push(resolve));
}

async function connectRelay(admission: SandboxRelayAdmission, token?: string) {
  const config = JSON.parse(admission.env[RELAY_ENV_KEY]!) as { broker: string; token: string };
  const port = Number(config.broker.split(":")[1]);
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`${JSON.stringify({ type: "hello", token: token ?? config.token })}\n`);
  return { socket, port, token: config.token, next: lines(socket) };
}

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

async function isBound(port: number) {
  const probe = createServer();
  try {
    probe.listen(port, "127.0.0.1");
    await once(probe, "listening");
    probe.close();
    await once(probe, "close");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
    throw error;
  }
}

/** Waits for the broker to bind or release a host port; probing by binding avoids slow refused connects. */
async function waitForBinding(port: number, bound: boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await isBound(port) === bound) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Port ${port} never became ${bound ? "bound" : "free"}.`);
}

test("admitted commands run inside the relay, receive host ports, and hear about changes only while connected", async t => {
  const h = harness();
  t.after(() => h.broker.dispose());
  const admission = await h.broker.admit(["bash", "-lc", "psql"]);
  assert.ok(admission);
  assert.deepEqual(admission.argv, ["/opt/workbench-relay", "--", "bash", "-lc", "psql"]);

  const relay = await connectRelay(admission);
  assert.deepEqual(await relay.next(), { type: "hostPorts", ports: [5000, 6000] });
  assert.equal(h.polling(), true);
  h.setHostPorts([5000, 7000]);
  h.tick();
  assert.deepEqual(await relay.next(), { type: "hostPorts", ports: [5000, 7000] });

  const closed = once(relay.socket, "close");
  admission.release();
  await closed;
  assert.equal(h.polling(), false);
});

test("a relay presenting an unknown token is disconnected", async t => {
  const h = harness();
  t.after(() => h.broker.dispose());
  const admission = await h.broker.admit(["true"]);
  assert.ok(admission);
  const relay = await connectRelay(admission, "forged");
  await once(relay.socket, "close");
  assert.equal(h.polling(), false);
});

test("a command's sandbox listeners become host ports that carry connections into it until release", async t => {
  const h = harness();
  t.after(() => h.broker.dispose());
  const admission = await h.broker.admit(["pnpm", "dev"]);
  assert.ok(admission);
  const relay = await connectRelay(admission);
  await relay.next();
  const sandboxPort = await freePort();
  relay.socket.write(`${JSON.stringify({ type: "sandboxPorts", ports: [sandboxPort] })}\n`);

  await waitForBinding(sandboxPort, true);
  const host = connect(sandboxPort, "127.0.0.1");
  t.after(() => host.destroy());
  const open = await relay.next() as { type: string; id: string; port: number };
  assert.equal(open.type, "open");
  assert.equal(open.port, sandboxPort);

  const data = connect(relay.port, "127.0.0.1");
  await once(data, "connect");
  t.after(() => data.destroy());
  // The relay's first bytes may share a packet with its accept line.
  data.write(`${JSON.stringify({ type: "accept", token: relay.token, id: open.id })}\npong`);
  host.setEncoding("utf8");
  assert.equal((await once(host, "data"))[0], "pong");
  host.write("ping");
  data.setEncoding("utf8");
  assert.equal((await once(data, "data"))[0], "ping");

  admission.release();
  await waitForBinding(sandboxPort, false);
});

test("an unavailable relay sidecar leaves commands unwrapped and is reported once", async t => {
  const h = harness(async () => { throw new Error("relay sources changed; rebuild the bundled executable."); });
  t.after(() => h.broker.dispose());
  assert.equal(await h.broker.admit(["true"]), null);
  assert.equal(await h.broker.admit(["true"]), null);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!, /rebuild the bundled executable/u);
});
