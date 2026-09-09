/*
 * Keywords: diagnostic, IPC, cross-platform shutdown.
 * No exports. Translate fixture-owned IPC into the entrypoint's real shutdown intent.
 */
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
process.on("message", message => {
  if (message?.type === "workbench-diagnostic-close") requestClose();
});
process.on("disconnect", requestClose);
process.on("newListener", event => {
  if (event === "SIGTERM" && requested && !delivered) queueMicrotask(deliver);
});
// IPC carries intent, but must not keep a fully closed or failed installation alive.
process.channel?.unref();
