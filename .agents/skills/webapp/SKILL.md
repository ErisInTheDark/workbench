---

name: webapp
description: "When the author asks for webapp work, including Next.js page work, UI polish, workbench or editor changes, API route changes, Codex app-server integration, or any other task that primarily changes code under `webapp/`, follow this workflow."

---

## Orientation

- `webapp/` is a Next.js App Router app using React 19, Tailwind 4, and a custom markdown workbench and editor.
- `webapp/components/workbench.tsx` owns the React shell, responsive explorer and editor layout, and UI chrome; `webapp/lib/WorkbenchClient.ts` owns imperative editor behavior, persistence, polling, and most client-side file and thread interactions.
- `webapp/lib/workbench/` uses layered ownership: public client surfaces stay at the folder root, editor-private controllers live under `editor/`, reusable DOM helpers live under `dom/`, state owners live under `state/`, markdown helpers live under `markdown/`, project helpers live under `project/`, and thread helpers live under `thread/`.
- `webapp/app/api/` contains server routes for tree, file, and Codex operations; keep their contracts aligned with `webapp/lib/types.ts`.
- `webapp/orchestrator/` coordinates local Next.js development together with the Codex and Copilot bridge paths.

# Constraints

## DO

- PREFER REUSABLE COMPONENTS. Reusable components should be the default export of their file, which should have a matching PascalCase filename such as `ThreadView.tsx`.
- PREFER PROMINENT CONTROLLERS. State owners/controllers — whether a function, or a class — should be the default export of their file, which should have a matching PascalCase filename such as `WorkbenchClient.ts`.
- MISC FILES LOOK MISC. Files containing miscellaneous functions or types or registries should be kebab-case, such as `command-matchers.ts`.
- RELATED FUNCTIONALITY BELONGS IN REGISTRIES. For example, handling transformation of raw strings into specific actions or displays should not be hardcoded, but should instead be individual items within a transformation registry. Large registries should be broken into a core registry file that imports all of its contents from smaller files of individual registry items or groups.
- DOCUMENT FILES. Add & keep updated a start-of-file manifest comment for files containing multiple components, functions, types, etc. Include high-signal keywords. List every export and its one-line purpose. Manifest comments that do not follow this exact format should be proactively updated.
- KEEP FILES SMALL AND REUSABLE. PROACTIVELY PLAN REFACTORS. The codebase MUST stay in coherent, maintainable pieces instead of growing monolithic files.
- FLUSH/ZEN VISUAL LANGUAGE. Minimal borders, backgrounds only when necessary. Gradient masks can help differentiate parts of the app. Buttons should only get a background on hover.
- ENSURE COLOUR SCHEME SUPPORT. Both dark & light mode should be supported by every change.
- ENSURE MOBILE SUPPORT. Make desktop and mobile behavior DELIBERATE, especially for split explorer and editor layout, sticky controls, and save or reset affordances.
- KEEP SHARED CODE IN SYNC. Never write shared code, such as client/server code, with `any`/`unknown` types, always use shared types and keep the two sides synchronised.
- UPDATE GUIDANCE. Keep`AGENTS.md` or nearby project guidance up-to-date when the webapp's structure or operating workflow changes materially. Confirm the changes with the user.
- OPENCODE DIAGNOSTICS ARE ALLOWED. When diagnosing OpenCode integration under `webapp/orchestrator/`, it is safe to run local OpenCode SDK probes with small prompts because OpenCode usage here is unlimited. This does not override the rule against calling webapp endpoints without explicit permission. Prefer bounded probes that subscribe to events, send a tiny prompt, print event types, and abort promptly. Minimal pattern:

```powershell
$script = @'
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
const baseUrl = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const directory = process.cwd().replace(/\\/g, "/").replace(/\/webapp$/i, "");
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

## DO NOT

- DO NOT add file-specific duplicate components, utilities, or types when a shared home already exists.
- DO NOT leave a single-component file in `webapp/components/` on a mismatched filename or named export.
- DO NOT leave API contracts or state flow half-migrated.
- DO NOT run any `pnpm` script except `typecheck`.
- DO NOT call the webapp endpoints yourself without EXPLICIT permission from the user.
- DO NOT run `tsx` to test your code.
