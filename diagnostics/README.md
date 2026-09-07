# workbench diagnostics

## non-paid retained-data replay

Run only by exact filename:

````powershell
$env:WORKBENCH_REPLAY_DATABASE = '<absolute preserved database path under .workbench/recovery>'
$env:WORKBENCH_REPLAY_HISTORY = '<absolute preserved history directory under .workbench/recovery>'
pnpm test -- diagnostics/thread-state-replay.test.ts
````

Each input is optional; its check skips when absent. Uses no providers, authentication, sandbox setup or running services. Database replay upgrades a private SQLite backup, verifies identities across reopen and projects materialised content. History replay runs the production JSON reader, identity admission, compatibility import and public/SQLite projection twice.

History input contains `manifest.json` with `threadId`, `turnIds`, `projectId`, `projectRoot`; exact original `thread.json` and selected turn JSON files under `.workbench/transcripts/codex/threads/<base64url-thread-id>/`. Turn filenames use base64url turn IDs. Only those files are copied; no source symlinks may escape the preserved input.

Outputs remain under `.workbench/diagnostics/`, outside runner cleanup. Inputs are never opened writable. Metadata-only threads are counted separately, not treated as verified transcript bodies. This does not prove real provider connectivity, browser rendering or live turn admission.

## paid live diagnostic

Run only by exact filename:

````sh
pnpm test:live -- diagnostics/workbench-live.test.ts
````

Uses real Codex usage with the stored `luna.low` profile. Requires installed dependencies, Codex authentication and Git. Not part of ordinary `pnpm test`.

Boots current source in a private fixture with separate WB storage, Codex home, library, CLI shims and loopback listener. Copies authentication without logging it. Never restarts the user's app or daemon.

Windows reuses the main Codex sandbox identity through a `.sandbox-secrets` directory symlink and a `.sandbox/setup_marker.json` hardlink, matching convex-lab. Requires an already-configured main sandbox, same-volume storage and symlink support. Never initializes another sandbox identity. Cleanup unlinks only fixture entries, not their shared targets. This test uses the real app WebSocket client and page contract, but does not exercise React rendering.

Checks startup, profile/instruction admission, streaming, managed CLI/MCP identity and the real SQLite projector before historical reads. Reopening after owned process-tree retirement must preserve visible items. Cleanup deletes only the provider thread returned by this run, after verifying its isolated cwd and recorded identity. Cleanup failures fail the test. Fixture diagnostics remain for inspection, without copied authentication or sandbox identity links.
