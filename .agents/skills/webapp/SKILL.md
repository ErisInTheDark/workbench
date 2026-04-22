---
name: webapp
description: "When the author asks for webapp work, including Next.js page work, UI polish, workbench or editor changes, API route changes, Codex app-server integration, or any other task that primarily changes code under `webapp/`, follow this workflow."
---

1. Read `webapp/package.json` first, then read the specific route, component, stylesheet, API handler, and `lib` files in scope before editing. For workbench or editor tasks, also read `webapp/components/workbench.tsx`, `webapp/lib/workbench-client.ts`, and `webapp/lib/types.ts`. For Codex integration tasks, also read `webapp/orchestrator.js`, `webapp/lib/codex/*`, and the related files under `webapp/app/codex/` and `webapp/app/api/codex/`.
2. Keep changes in the existing architecture: App Router pages and API handlers under `webapp/app/`, reusable UI in `webapp/components/`, shared contracts and helpers in `webapp/lib/`, and local multi-process development flow in `webapp/orchestrator.js`.
3. Prefer smaller components and reusable, testable utilities over growing monolithic files. If a file is absorbing multiple concerns, extract coherent pieces instead of stacking on more local logic.
4. Search for existing or similar components, utilities, and types before creating new ones. Prefer extending or generalizing shared helpers in `webapp/components/` and `webapp/lib/` over adding file-specific functions or duplicate types.
5. Require every shared utility file to begin with a short manifest comment above the imports. In that manifest, list every exported function with a one-line purpose summary and high-signal keywords for discovery.
6. Keep utility manifests current whenever exported functions are added, removed, renamed, split, or meaningfully repurposed.
7. If the implementation surface is large or unclear, spawn the read-only `explorer` subagent with explicit files and questions before editing so you map the relevant slice instead of guessing.
8. Preserve the current visual language unless the author asks for a redesign. When changing UI, make desktop and mobile behavior deliberate, especially the split explorer and editor layout, sticky controls, and save or reset affordances.
9. When changing client/server or cross-file behavior, update the route handler, the caller, and `webapp/lib/types.ts` in the same pass. Do not leave API contracts or state flow half-migrated.
10. Verify with the narrowest meaningful command from `webapp/`. Prefer `pnpm build` for structural changes, and say clearly what you did or did not verify.
11. If the task materially changes how the webapp is structured or operated, update `AGENTS.md` or nearby project guidance in the same pass so future agents inherit the new shape quickly.
