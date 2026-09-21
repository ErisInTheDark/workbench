# installation and service

`npx @inthedark/wb` installs an editable repository and launches the detached tray/app. `npx @inthedark/wb connect` installs without launching the app, then enables remote wake and startup. Publication of the npm package is separate from source implementation.

Installed commands:

- `wb`: launch the app; request the local daemon without requiring remote-wake opt-in.
- `wb connect`: enable cold remote wake and OS startup.
- `wb disconnect`: disable future cold remote wake and startup, preserving active consumers and network grants.
- `wb shortcut`: install a desktop/menu shortcut without launching or connecting.
- `pnpm dev`: run host and daemon in the foreground with live output and terminal-owned shutdown. Refuse an existing host; use `wb view daemon` instead.
- `wb view daemon`: attach to host/daemon logs without launching. Ctrl+C stops daemon and harnesses; another Ctrl+C stops the host.
- `wb view app`: attach to tray/app logs. Ctrl+C invokes tray Quit without directly stopping the daemon.
- `wb view`: attach to combined app/tray and host/daemon logs through the running app. Ctrl+C invokes app/tray Quit; it never directly stops the daemon.

In every view, `q` or closing the terminal detaches without stopping anything. Non-interactive views only stream logs. Intentional daemon stop clears crash-restart intent and blocks incidental forwarding from waking it; launching the app or requesting explicit daemon wake starts it again. Process replacement is reported; reattach before controlling a replacement.

App Quit disconnects that app's browser tabs from the daemon. Tabs reconnect when their app returns. Older browser tabs need a refresh to adopt this behaviour.

Background-managed daemons sleep after the last connected app leaves and admitted work, harness execution, active goals and background imports finish. The reload graph derives idleness from existing operation and work owners. A daemon-owned one-second memory check runs only while unattended; it performs no filesystem, database or network polling. The host gates wake requests during retirement, remains available and starts a fresh daemon for subsequent authorised use. Foreground `pnpm dev`, standalone daemons and explicit viewer stop retain their existing ownership. Log viewers never keep a daemon awake.

Installation prompts for consent and location. The dim `/wb` suffix is not editable; an existing final `wb` or `workbench` directory suppresses it. Defaults are `%LOCALAPPDATA%\Programs\inthedark\wb` and `~/.local/lib/inthedark/wb`. Runtime data stays separate. `~/.workbench/installation.json` records installation progress and the selected repository.

Setup runs dependency installation, frontend compilation and global CLI installation. It never updates existing source, resets edits or builds native binaries. Missing native artifacts report the root developer build command; repository installation remains complete.

# process ownership

The host owns networking and the heavy daemon. The tray owns the app server, outside the host's crash unit. App exit leaves the host and daemon available. Windows uses a current-user scheduled task plus the committed native supervisor. Linux uses a user systemd service; unattended startup requires linger.

Foreground development uses the same supervisor on Windows and a transient user systemd service on Linux. It does not register persistent startup. Its owner pipe ties shutdown to the launching terminal; detachable viewers never own that pipe.

Service state lives in `service/service.sqlite3` beneath the existing Workbench data root. Initial network import uses a SQLite backup of app state, preserving the original app database and native key directory. Durable daemon UUIDs are not process-instance UUIDs.

Tailnet daemon ingress uses port 52739; loopback listeners use available ports. Both published daemon transports enforce the network owner's grants. Discovery verifies known Tailscale peers without starting their heavy daemons. Browser results are filtered by the viewing device's grants.

Fresh supervision sessions remain cold. Requests coalesce startup; cancellation does not cancel another caller's startup or replay a mutation. Failed startup remains visible until explicit retry. Crash recovery may resume requested daemon work only within the same supervision session.

# reload and diagnostics

Host scopes are `host:database`, `host:network`, `host:http` and `host:process`. Their dirt reaches the sidebar through the existing app runtime channel. Process replacement subsumes only that process's scopes.

Initial activation of these process-boundary changes needs full app and daemon/host replacement, performed by the user. Do not launch a second network identity alongside an older app-owned network process.

Host/daemon and tray/app logs remain under `.workbench/logs/`, with bounded rotation, using `workbench-host` and `workbench-app` files. Views read bounded recent output and follow rotation. Linux bootstrap failures are also visible through `systemctl --user status workbench-host` and `journalctl --user -u workbench-host`.

# developer validation

From the repository root:

- `wb test`: claimed behavioural tests.
- `pnpm typecheck`: TypeScript projects.
- `pnpm test:network`, `pnpm build:network`: native networking.
- `pnpm test:native`, `pnpm build:host`, `pnpm build:tray`: native owners and committed Windows artifacts.
- `pnpm test:lifecycle`: isolated persistence/lifecycle scenario; allow completion without a command timeout.

Installer paths do not run native builds. Linux artifacts are built and committed on Linux; Windows validation does not certify Linux or NixOS launch behaviour. Do not register real startup services, change live Tailscale state or perform global installation during isolated validation.
