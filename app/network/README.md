# optional networking

Local app/daemon listeners accept loopback only. Localhost mode is the default and needs neither Tailscale nor the bundled helper.

The daemon binds an OS-assigned local port and publishes its process identity/address after readiness. The app observes and verifies that publication; browser reconnects resolve it again. Missing/stale publication means unavailable, never a guessed port. The host watchdog probes and retires its owned child, not a fixed port.

## setup

Global settings > Networking:

- Localhost: Port edits the local app port. The daemon's local port always remains random.
- Tailnet IP: Port edits the app's host Tailscale Serve port, independently of its local port. One foreground session also publishes daemon port `52739`; conflicts are reported independently without stealing existing mappings. "Discoverable" means that mapping is ready, not that every ACL permits it. No scanner is included.
- Tailnet service: retains both Serve mappings and adds private HTTPS. Port is disabled; Machine name changes `<machine>.wb.inthedark.boo`. Its initial default comes from the host Tailscale name, but edits never rename the host.
- Private setup: authorise the separate `wb-<initial-label>` node. First installation creates the setup using a DNS-write-scoped Tailscale OAuth credential. Later installations join with a single-use pairing code and explicit node/key approval.
- Trust the setup root once per viewing device/browser. Windows host installation is explicit and affects the Workbench host's current user, not a remote viewing device. Download contains only the public root.
- Verify HTTPS from the viewing browser. Verification checks private DNS, trusted TLS and expected node identity. Setup and recovery controls are contextual.

Each private node owns virtual HTTPS/DNS listeners, not host/LAN/tailnet-machine ports 443/53. Tailscale transport still uses host network sockets. Exact-name split DNS leaves the public apex and other names unchanged. Tailnet clients must accept Tailscale DNS.

Only the setup installation holds the CA key and DNS credential. Members retain their own leaf key and persistent tsnet identity. Keep setup online for issuance/renewal; valid existing certificates continue working while it is offline. Root lifetime is ten years, leaves one year, renewal starts in the final 30 days.

URL renames reserve the new name, prepare a certificate covering both addresses, activate the new address, then retire the old registration. App-local SQLite journals the operation and acknowledges native membership updates only after persistence. Service mode resumes interrupted phases once the app listener is available; localhost retains the journal without starting private networking. Explicit retry can resume setup. Node identity, leaf key, trusted root and authority control name stay stable.

## recovery and removal

Export a password-encrypted backup from the setup installation. Protect the password and backup separately. Restore retains the CA, DNS credential and membership, never silently replaces existing trust. If issuer identity/address changes, generate new pairing codes and explicitly reconnect members.

Leaving service mode closes private listeners but retains identity, keys and DNS registration for reuse. Leaving tailnet modes removes only the owned Serve session. Remove registration deletes only this machine's owned DNS entry and returns to tailnet IP mode; it does not delete the Tailscale node, revoke certificates or remove device trust. Finish pending renames before removal or setup replacement. To register again, retry with the setup installation online. Manage node removal and device trust explicitly.

App-local SQLite owns configuration/membership. Protected files beside the app database under `network/` own keys, credentials and tsnet state. Never commit these files. Back up the setup before deleting its state.

## maintenance

Maintainers need Go 1.26.6+. Users run committed platform binaries, not Go.

From repository root:

````text
node scripts/test-network.mjs --go "C:\Program Files\Go\bin\go.exe"
node scripts/build-network.mjs --go "C:\Program Files\Go\bin\go.exe"
wb test -- app/server/network/WorkbenchNetworkProcess.test.ts shared/http/loopback-connection.test.ts app/server/network/WorkbenchLocalDaemon.test.ts app/server/network/WorkbenchNetworkController.test.ts app/server/network/WorkbenchNetworkRepository.test.ts app/server/network/WorkbenchNetworkRoutes.test.ts app/client/workbench/app/WorkbenchNetworkClient.test.ts shared/workbench/WorkbenchDaemonConnection.test.ts shared/workbench/WorkbenchSocketClient.test.ts
pnpm typecheck
pnpm test:lifecycle
````

Build publishes only the current Windows x64 or Linux x64 artifact. Build Linux on Linux.
Caches stay in `.workbench/tmp/network-build`. Dependency/toolchain changes may need downloads; ordinary users need no Go installation. `pnpm build:network` and `pnpm test:network` use `GO_BINARY` or Go on PATH.

Commit the current-platform binary and manifest together. Startup verifies executable SHA-256, protocol and production-source fingerprint. Production Go changes require a rebuild; test-only changes do not.

This transition requires user-owned full daemon-host and app restarts plus a browser refresh. Subsequent reloadable networking changes use app `client:network`; sidecar handoff releases the old process before replacement. Build Linux artifacts on Linux. Do not change live tailnet/DNS/trust during source validation. Linux/mobile runtime validation remains separate.
