# optional networking

Local app/daemon listeners accept loopback only. Localhost mode is the default and needs neither Tailscale nor the bundled helper.

The daemon binds an OS-assigned local port and publishes its process identity/address after readiness. The app observes and verifies that publication; browser reconnects resolve it again. Missing/stale publication means unavailable, never a guessed port. The host watchdog probes and retires its owned child, not a fixed port.

## setup

Global settings > Networking:

- Connection type, Local port, Tailnet port and Machine name are drafts. Apply saves them together; Reset discards edits. Both ports remain visible. Remote browsers can select Tailnet IP or Tailnet service, never localhost-only. The daemon's local port always remains random.
- Tailnet IP: Port edits the app's host Tailscale Serve port, independently of its local port. One foreground session also publishes daemon port `52739`; conflicts are reported independently without stealing existing mappings. "Discoverable" means that mapping is ready, not that every ACL permits it. No scanner is included.
- Tailnet service: retains both Serve mappings and adds private HTTPS. Port remains editable for direct tailnet-IP access; it does not change HTTPS. Machine name changes `<machine>.wb.inthedark.boo`. Its initial default comes from the host Tailscale name, but edits never rename the host.
- Private setup: authorise the separate `wb-<initial-label>` node. Create the first network explicitly; later apps discover and enrol over authenticated Tailscale connections. No DNS API credentials or pairing codes.
- Add the selected DNS app's tsnet IP as a Tailscale nameserver restricted to `wb.inthedark.boo`. Adding apps needs no DNS edits. Switching DNS apps requires updating that one entry; transferring ownership does not.
- Trust the setup root once per viewing device/browser. Windows host installation is explicit and affects the Workbench host's current user, not a remote viewing device. Download contains only the public root.
- Verify HTTPS from the viewing browser. Verification checks private DNS, trusted TLS and expected node identity. The raw-IP link and QR allow another device to reach certificate setup first.

Each private node owns virtual HTTPS/DNS listeners and authenticated control port `52740`, not host/LAN/tailnet-machine ports 443/53. Tailscale transport still uses host sockets. The selected DNS app answers the shared directory; public misses forward directly to `1.1.1.1:53`, never the system resolver. Public apex and unrelated suffixes remain unchanged. Clients must accept Tailscale DNS.

Only the owner holds the CA key. Members retain their own leaf key and persistent tsnet identity. Keep the owner online for enrolment, policy changes and renewal; existing certificates, cached DNS and committed grants remain usable offline. Root lifetime is ten years, leaves one year, renewal starts in the final 30 days.

Owner and DNS app are independent inline selections. Ownership transfer prepares the target, durably relinquishes the source, then activates the target with the same CA. Interrupted transfers resume; there is no timeout election or automatic replacement root. The DNS app must remain running; automatic resolver failover is not included.

Remote app access defaults to all tailnet devices. Selected-device mode grants specific devices access to specific apps; loopback is always allowed. Both private HTTPS and host-tailnet HTTP enforce grants. Host HTTP requires PROXY v2 framing from Tailscale Serve before resolving peer identity. A per-process credential authenticates native-to-app ingress; client-supplied identity headers are discarded. Revocation closes owned app connections. Unreachable apps retain their previous policy and appear as pending, not falsely updated.

Network management requires local access on the owner computer or authenticated access from its host Tailscale identity to the owner app. Ordinary app access is not network-management authority. App grants do not govern daemon execution or protect a computer from an actor already authorised to execute through its daemon.

URL renames reserve the new name, prepare a certificate covering both addresses, activate the new address, then retire the old registration. App-local SQLite journals the operation and acknowledges native membership updates only after persistence. Service mode resumes interrupted phases once the app listener is available; localhost retains the journal without starting private networking. Explicit retry can resume setup. Node identity, leaf key, trusted root and authority control name stay stable.

## removal

Connection changes retain the old entry until the initiating device reaches the replacement and confirms through an authenticated same-origin POST. Tailnet-port changes temporarily retain both app mappings in the existing foreground session. Cancelling returns through the source address before removing temporary forwarding. Reload/disposal retires uncommitted handoffs.

Leaving service mode closes private listeners but retains identity, keys and DNS registration for reuse. Leaving tailnet modes removes only the owned Serve session. Remove registration deletes only this machine's owned DNS entry and returns to tailnet IP mode; it does not delete the Tailscale node, revoke certificates or remove device trust. Finish pending renames before removal or setup replacement. To register again, retry with the setup installation online. Manage node removal and device trust explicitly.

App-local SQLite owns configuration, directory revisions, grants and handover journals. Protected files beside the app database under `network/` own keys and tsnet state. Never commit these files. Losing the network state requires fresh setup, updated Tailscale DNS and trusting the new certificate on each device. There is no certificate backup/import feature.

Upgrading the previous per-app DNS setup preserves its node identity, keys and trusted root. Manually remove its old exact-hostname Tailscale DNS rules after adding the whole-suffix entry; otherwise those more-specific rules keep overriding the selected nameserver. Workbench does not edit live Tailscale DNS configuration.

## maintenance

Maintainers need Go 1.26.6+. Users run committed platform binaries, not Go.

From repository root:

````text
node scripts/test-network.mjs --go "C:\Program Files\Go\bin\go.exe"
node scripts/build-network.mjs --go "C:\Program Files\Go\bin\go.exe"
wb test -- app/server/network/WorkbenchNetworkProcess.test.ts shared/http/loopback-connection.test.ts app/server/network/WorkbenchLocalDaemon.test.ts app/server/network/WorkbenchNetworkController.test.ts app/server/network/WorkbenchNetworkRepository.test.ts app/server/network/WorkbenchNetworkRoutes.test.ts app/server/runtime/WorkbenchAppHttpRouter.test.ts app/client/workbench/app/WorkbenchNetworkClient.test.ts app/client/workbench/app/private-access-step.test.ts shared/workbench/WorkbenchDaemonConnection.test.ts shared/workbench/WorkbenchSocketClient.test.ts
pnpm typecheck
pnpm test:lifecycle
````

Build publishes only the current Windows x64 or Linux x64 artifact. Build Linux on Linux.
Caches stay in `.workbench/tmp/network-build`. Dependency/toolchain changes may need downloads; ordinary users need no Go installation. `pnpm build:network` and `pnpm test:network` use `GO_BINARY` or Go on PATH.

Commit the current-platform binary and manifest together. Startup verifies executable SHA-256, protocol and production-source fingerprint. Production Go changes require a rebuild; test-only changes do not.
Publication renames the previous image before replacing it, leaving a running helper uninterrupted. Windows-locked retired images remain in the build cache with a warning. Failed publication restores the previous artifact where possible and reports incomplete recovery.

This schema transition requires the user-owned app `client:database` scoped reload and browser refresh. Later network-only changes use `client:network`; handoff releases the old process before replacement. No daemon restart is required. Do not change live tailnet/DNS/trust during source validation. Linux/mobile runtime validation remains separate.
