---
name: opencode-diagnostics
description: Diagnose Workbench OpenCode integration under `daemon/server/` with bounded local `@opencode-ai/sdk` probes that subscribe to events, send a tiny prompt, report event and session behavior, and abort promptly. Use when investigating OpenCode server connectivity, SDK event streams, session creation, prompt delivery, or bridge behavior; do not use for ordinary daemon endpoint testing.
---

## Safety Boundaries

- Run probes from `daemon/` so the local `@opencode-ai/sdk` dependency resolves and the probe can normalize the directory back to the project root.
- Do not treat this workflow as permission to call Workbench daemon endpoints; those calls still require explicit user approval.

## Minimal Probe

Run this PowerShell probe from `daemon/`:

```powershell
$script = @'
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
const baseUrl = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const directory = process.cwd().replace(/\\/g, "/").replace(/\/daemon$/i, "");
const client = createOpencodeClient({ baseUrl, directory });
const abort = new AbortController();
void (async () => {
  const events = await client.v2.event.subscribe({ signal: abort.signal });
  for await (const event of events.stream) console.log(event.type, event.data?.sessionID ?? "");
})();
const session = (await client.session.create({ directory, title: "OpenCode probe" })).data;
await client.session.promptAsync({ directory, sessionID: session.id, parts: [{ type: "text", text: "who are you, and summarise instructions and tools" }] });
setTimeout(() => abort.abort(), 30000);
'@
node --input-type=module -e $script
```
