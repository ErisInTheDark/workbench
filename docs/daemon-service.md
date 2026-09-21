# installation and service

`npx @inthedark/wb` installs an editable repository and launches the detached tray/app. `npx @inthedark/wb connect` installs without launching the app, then enables remote wake and startup. Publication of the npm package is separate from source implementation.

Installed commands:

- `wb`: launch the app; request the local daemon without requiring remote-wake opt-in.
- `wb connect`: enable cold remote wake and OS startup.
- `wb disconnect`: disable future cold remote wake and startup, preserving active consumers and network grants.
- `wb shortcut`: install a desktop/menu shortcut without launching or connecting.
- `pnpm dev`: ensure the independent host and request the daemon.

Installation prompts for consent and location. The dim `/wb` suffix is not editable; an existing final `wb` or `workbench` directory suppresses it. Defaults are `%LOCALAPPDATA%\Programs\inthedark\wb` and `~/.local/lib/inthedark/wb`. Runtime data stays separate. `~/.workbench/installation.json` records installation progress and the selected repository.

Setup runs dependency installation, frontend compilation and global CLI installation. It never updates existing source, resets edits or builds native binaries. Missing native artifacts report the root developer build command; repository installation remains complete.

# process ownership

The host owns networking and the heavy daemon. The tray owns the app server, outside the host's crash unit. App exit leaves the host and daemon available. Windows uses a current-user scheduled task plus the committed native supervisor. Linux uses a user systemd service; unattended startup requires linger.

Service state lives in `service/service.sqlite3` beneath the existing Workbench data root. Initial network import uses a SQLite backup of app state, preserving the original app database and native key directory. Durable daemon UUIDs are not process-instance UUIDs.

Tailnet daemon ingress uses port 52739; loopback listeners use available ports. Both published daemon transports enforce the network owner's grants. Discovery verifies known Tailscale peers without starting their heavy daemons. Browser results are filtered by the viewing device's grants.

Fresh supervision sessions remain cold. Requests coalesce startup; cancellation does not cancel another caller's startup or replay a mutation. Failed startup remains visible until explicit retry. Crash recovery may resume requested daemon work only within the same supervision session.

# reload and diagnostics

Host scopes are `host:database`, `host:network`, `host:http` and `host:process`. Their dirt reaches the sidebar through the existing app runtime channel. Process replacement subsumes only that process's scopes.

Initial activation of these process-boundary changes needs full app and daemon/host replacement, performed by the user. Do not launch a second network identity alongside an older app-owned network process.

Daemon and app logs remain under `.workbench/logs/`, with existing bounded rotation. Windows host diagnostics use `workbench-host` files there. Linux service startup failures are also visible through `systemctl --user status workbench-host` and `journalctl --user -u workbench-host`.

# developer validation

From the repository root:

- `wb test`: claimed behavioural tests.
- `pnpm typecheck`: TypeScript projects.
- `pnpm test:network`, `pnpm build:network`: native networking.
- `pnpm test:native`, `pnpm build:host`, `pnpm build:tray`: native owners and committed Windows artifacts.
- `pnpm test:lifecycle`: isolated persistence/lifecycle scenario; allow completion without a command timeout.

Installer paths do not run native builds. Linux artifacts are built and committed on Linux; Windows validation does not certify Linux or NixOS launch behaviour. Do not register real startup services, change live Tailscale state or perform global installation during isolated validation.
