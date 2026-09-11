# workbench diagnostics

## non-paid retained-data replay

Run only by exact filename:

````powershell
$env:WORKBENCH_REPLAY_DATABASE = '<absolute preserved database path under .workbench/recovery>'
pnpm test -- diagnostics/thread-state-replay.test.ts
````

Skips without the database input. Uses no providers, authentication, sandbox setup or running services. Upgrades a private SQLite backup, verifies identities across reopen and projects materialised content. Legacy JSON history import is no longer supported.

Outputs remain under `.workbench/diagnostics/`, outside runner cleanup. Inputs are never opened writable. Metadata-only threads are counted separately, not treated as verified transcript bodies. This does not prove real provider connectivity, browser rendering or live turn admission.

## paid codex diagnostic

Run only by exact filename:

````sh
pnpm test:codex -- diagnostics/workbench-codex.test.ts
````

Uses real Codex usage with the stored `luna.low` profile. Requires installed dependencies, Codex authentication and Git. Not part of ordinary `pnpm test`.

Boots current source in a private fixture with separate WB storage, Codex home, library, CLI shims and loopback listener. Copies authentication without logging it. Never restarts the user's app or daemon.

Windows reuses the main Codex sandbox identity through a `.sandbox-secrets` directory symlink and a `.sandbox/setup_marker.json` hardlink, matching convex-lab. Requires an already-configured main sandbox, same-volume storage and symlink support. Never initializes another sandbox identity. Cleanup unlinks only fixture entries, not their shared targets. This test uses the real app WebSocket client and page contract, but does not exercise React rendering.

Checks startup, profile/instruction admission and managed CLI/MCP identity. Protocol-3 events pass through the real socket client and projection controller; snapshot delivery fails. A fixture-owned command gate holds the live turn while deselection/reselection verifies complete earlier commentary. Completed live items must match durable SQLite identities, order and content before historical reads. Live recording and cold reopening must create no legacy transcript JSON/journals and leave retained legacy evidence unchanged. Reopening after owned process-tree retirement must preserve visible items. This does not prove React painting, questionnaire or Browse recording.

Cleanup releases the command gate and deletes only the provider thread returned by this run, after verifying its isolated cwd and recorded identity. Cleanup failures fail the test. Fixture diagnostics remain for inspection, without copied authentication or sandbox identity links.

## lifecycle diagnostic

````sh
pnpm test:lifecycle
````

One explicitly selected test, outside ordinary discovery. Starts copied app/orchestrator entrypoints with private storage and loopback ports. Uses real SQLite, compiler, HTTP and WebSocket ingress. No model turns, copied authentication or Windows sandbox identity. Installed provider binaries may initialise in private homes; this is not an offline-provider test.

Checks startup and served assets, database reload, reload-all, process-dirt stability, the real old-work grace, failed candidate activation, migrated-schema rollback, same-process retry and cold reopening. Seeds a SQL transcript and image without the JSON recorder. Verifies SQL reads, incremental baseline delivery through the real shared socket, HTTP image bytes and durable provider cursors before and after reload, rollback and reopen. Retained legacy evidence stays unchanged; no transcript JSON/journals may be created. Fault instrumentation and a synthetic schema release exist only in the copied fixture. Production lifecycle and migration code remain intact. Does not prove React rendering, provider conversations or live text generation.

The scenario has a ten-minute failure budget, each reload a 90-second observation budget, and cleanup independent 45-second budgets per owned app/orchestrator. Fixture-only IPC invokes their real shutdown handlers on Windows and Linux. Each subsystem closes its own resources; the fixture never scans or kills process trees and has no elevated cleanup fallback. Windows provider retirement uses the existing PowerShell 7 runtime; Linux uses owned process groups. Failed startup must also clean up and exit. Logs and copied fixture remain under `.workbench/diagnostics`. Never operates on the user's running app or daemon. Run again after fixes; ordinary regression execution uses `pnpm test`, static validation uses `pnpm typecheck`.
