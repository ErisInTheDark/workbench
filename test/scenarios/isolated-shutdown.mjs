/*
 * No exports. Translate fixture-owned IPC into the entrypoint's real shutdown intent. The fixture's close message is consumed
 * here, so real entrypoints never see a message that is not part of their own IPC protocol.
 */
const CLOSE = "workbench-scenario-close";
let requested = false;
let delivered = false;
function deliver() {
  if (!requested || delivered || process.listenerCount("SIGTERM") === 0) return;
  delivered = true;
  process.emit("SIGTERM");
}
function requestClose() {
  requested = true;
  deliver();
}
const emit = process.emit;
process.emit = function (event, ...args) {
  if (event === "message" && args[0]?.type === CLOSE) {
    requestClose();
    return true;
  }
  return emit.call(this, event, ...args);
};
// Listening keeps the channel reading even before the entrypoint attaches its own listener.
process.on("message", () => undefined);
process.on("disconnect", requestClose);
process.on("newListener", event => {
  if (event === "SIGTERM" && requested && !delivered) queueMicrotask(deliver);
});
// IPC carries intent, but must not keep a fully closed or failed installation alive.
process.channel?.unref();
