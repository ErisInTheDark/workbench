# paid workbench diagnostic

Run only by exact filename:

````sh
pnpm test:live -- diagnostics/workbench-live.test.ts
````

Uses real Codex usage with the stored `luna.low` profile. Requires installed dependencies, Codex authentication and Git. Not part of ordinary `pnpm test`.

Boots current source in a private fixture with separate WB storage, Codex home, library, CLI shims and loopback listener. Copies authentication without logging it. Never restarts the user's app or daemon.

Windows reuses the main Codex sandbox identity through a `.sandbox-secrets` directory symlink and a `.sandbox/setup_marker.json` hardlink, matching convex-lab. Requires an already-configured main sandbox, same-volume storage and symlink support. Never initializes another sandbox identity. Cleanup unlinks only fixture entries, not their shared targets. This test uses the real app WebSocket client and page contract, but does not exercise React rendering.

Checks startup, profile/instruction admission, streaming, managed CLI/MCP identity and the real SQLite projector before historical reads. Reopening after owned process-tree retirement must preserve visible items. Cleanup deletes only the provider thread returned by this run, after verifying its isolated cwd and recorded identity. Cleanup failures fail the test. Fixture diagnostics remain for inspection, without copied authentication or sandbox identity links.
